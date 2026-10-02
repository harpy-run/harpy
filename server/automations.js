// Automations: event-driven background agent runs that cost nothing while
// idle. Definitions live in $HARPY_HOME/automations/<ws-hash>/<slug>.md —
// YAML-ish frontmatter for the trigger, markdown body for the task prompt.
// They deliberately do NOT live in the workspace: a workspace-resident file
// could be planted by a member (fs.write), an agent session, or a cloned
// repository, and `gate:` executes as the daemon user.
//
// The gate pattern is the point: triggers are cheap (fs events, a minute
// timer, an inbound webhook, session lifecycle), and each automation may
// declare `gate:` — a shell command evaluated locally first. Only a nonzero
// exit spawns the agent, so a quiet workspace burns zero tokens.
//
//   ---
//   name: lint-watch
//   on: fs                      # fs | cron | webhook | session-end
//   paths: ["src/**/*.js"]      # fs only
//   schedule: "*/15 * * * *"    # cron only — 5-field or "every 30m"
//   gate: npx eslint --quiet    # exit 0 skips the run entirely
//   agent: codex
//   isolated: true              # run inside a detached git worktree
//   cooldown: 300               # seconds between runs
//   ---
//   Fix whatever the gate surfaced; report a diff summary.
//
// Runs spawn through startRunner with a synthetic owner ctx, so they appear
// as ordinary sessions in the Agent panel — watchable, stoppable, and they
// produce handoffs + memory digests like any other session.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { config } from './config.js'
import { httpError } from './util/http.js'
import { recordActivity } from './activity.js'
import { notifyWebhook } from './notify.js'
import { listKnownWorkspaces } from './workspace.js'
import { pinFsWatcher, unpinFsWatcher } from './channels/fs.channel.js'
import { startRunner } from './agents/runner.js'
import { preferredAgentId } from './agents/adapter.js'

const execFileAsync = promisify(execFile)

const GATE_TIMEOUT_MS = 60_000
const MAX_CONCURRENT = 3
const RUN_HISTORY = 20
const CRON_TICK_MS = 30_000
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,39}$/

// ─── frontmatter: a deliberately tiny YAML subset ────────────────────────
// Supports `key: scalar`, `key: [a, b]`, and indented `- item` lists.
// Anything richer belongs in a config file, not a markdown header.
function parseFrontmatter(text) {
  const match = String(text).match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/)
  if (!match) return { meta: {}, body: String(text).trim() }
  const meta = {}
  let listKey = null
  for (const raw of match[1].split('\n')) {
    const line = raw.trimEnd()
    if (!line || line.startsWith('#')) continue
    const listItem = line.match(/^\s*-\s+(.+)$/)
    if (listItem && listKey) { meta[listKey].push(unquote(listItem[1].trim())); continue }
    const pair = line.match(/^([a-zA-Z_][\w-]*):\s*(.*)$/)
    if (!pair) continue
    const [, key, value] = pair
    if (value === '') { meta[key] = []; listKey = key; continue }
    listKey = null
    meta[key] = value.startsWith('[')
      ? value.slice(1, value.lastIndexOf(']')).split(',').map((v) => unquote(v.trim())).filter(Boolean)
      : unquote(value)
  }
  return { meta, body: match[2].trim() }
}

function unquote(value) {
  const v = String(value).trim()
  return (v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")) ? v.slice(1, -1) : v
}

function scalar(value, fallback = '') {
  if (value === undefined || value === null) return fallback
  return Array.isArray(value) ? value.join(', ') : String(value)
}

// ─── glob → regex ("**" crosses dirs, "*" within one segment) ────────────
function globToRegex(glob) {
  const out = String(glob)
    .replace(/\*\*\//g, '')           // "**/" = zero or more dirs
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .split('**')
    .map((part) => part.replace(/\*/g, '[^/]*').replace(/\?/g, '.'))
    .join('.*')
    .replace(//g, '(?:.*/)?')
  return new RegExp(`^${out}$`)
}

// ─── cron: 5-field matcher plus "every <N>(m|h)" ─────────────────────────
function cronField(field, min, max) {
  const values = new Set()
  for (const part of String(field).split(',')) {
    const step = part.match(/^(.+)\/(\d+)$/)
    const stride = step ? Number(step[2]) : 1
    const range = (step ? step[1] : part).match(/^(\d+)-(\d+)$/)
    const from = range ? Number(range[1]) : (part === '*' || step?.[1] === '*' ? min : Number(part))
    const to = range ? Number(range[2]) : (part === '*' || step?.[1] === '*' ? max : Number(part))
    if (!Number.isInteger(from) || !Number.isInteger(to)) return null
    for (let v = from; v <= to && v <= max; v += stride) if (v >= min) values.add(v)
  }
  return values
}

function cronMatches(schedule, date) {
  const every = String(schedule).match(/^every\s+(\d+)\s*(m|min|h|hr|hour)s?$/i)
  if (every) return null // handled via lastRun distance, not wall-clock
  const fields = String(schedule).trim().split(/\s+/)
  if (fields.length !== 5) return null
  const [mins, hours, dom, mon, dow] = fields
  const sets = [
    cronField(mins, 0, 59), cronField(hours, 0, 23),
    cronField(dom, 1, 31), cronField(mon, 1, 12), cronField(dow, 0, 6)
  ]
  if (sets.some((s) => !s)) return null
  return sets[0].has(date.getMinutes()) && sets[1].has(date.getHours())
    && sets[2].has(date.getDate()) && sets[3].has(date.getMonth() + 1)
    && sets[4].has(date.getDay())
}

function everyMs(schedule) {
  const m = String(schedule).match(/^every\s+(\d+)\s*(m|min|h|hr|hour)s?$/i)
  if (!m) return null
  return Number(m[1]) * (m[2].startsWith('h') ? 3_600_000 : 60_000)
}

// ─── state ───────────────────────────────────────────────────────────────
function stateFile() {
  return path.join(config.dataDir, 'automations-state.json')
}

function readState() {
  try { return JSON.parse(fs.readFileSync(stateFile(), 'utf8')) || {} } catch { return {} }
}

function writeState(state) {
  fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 })
  fs.writeFileSync(stateFile(), JSON.stringify(state, null, 2), { mode: 0o600 })
}

const live = new Map() // `${ws}::${slug}` -> { running, timer }

// index.js wires this to a hub broadcast so the Settings list updates live.
let changedNotifier = null
export function setAutomationNotifier(fn) { changedNotifier = fn }
function emitChanged() { try { changedNotifier?.() } catch { void 0 } }

function keyFor(ws, slug) { return `${ws}::${slug}` }

function recordRun(state, key, entry) {
  const rec = state[key] || (state[key] = { runs: [] })
  rec.runs.unshift({ ts: Date.now(), ...entry })
  rec.runs = rec.runs.slice(0, RUN_HISTORY)
  writeState(state)
  emitChanged()
}

// ─── definitions ─────────────────────────────────────────────────────────
// The fs watcher keys entries by canonicalized realpath — resolve the same
// way here so UI-driven ops and watcher-driven triggers share one key.
function canonicalWorkspace(workspace) {
  const resolved = path.resolve(String(workspace || ''))
  try { return fs.realpathSync(resolved) } catch { return resolved }
}

export function automationsDir(workspace) {
  const ws = canonicalWorkspace(workspace)
  const key = crypto.createHash('sha1').update(ws).digest('hex').slice(0, 10)
  const dir = path.join(config.dataDir, 'automations', key)
  migrateLegacyDefinitions(ws, dir)
  return dir
}

// Pre-hardening installs kept definitions at <workspace>/.harpy/automations.
// Adopt them once (move, not copy) so the workspace file can no longer be
// rewritten by members, agent sessions, or freshly cloned repositories.
function migrateLegacyDefinitions(ws, target) {
  const legacy = path.join(ws, '.harpy', 'automations')
  let files = []
  try { files = fs.readdirSync(legacy).filter((f) => f.endsWith('.md')) } catch { return }
  for (const file of files) {
    const from = path.join(legacy, file)
    const to = path.join(target, file)
    try {
      fs.mkdirSync(target, { recursive: true, mode: 0o700 })
      fs.renameSync(from, to)
    } catch {
      try { fs.copyFileSync(from, to); fs.rmSync(from, { force: true }) } catch { void 0 }
    }
  }
}

export function listAutomations(workspace) {
  const ws = canonicalWorkspace(workspace)
  const dir = automationsDir(ws)
  let files = []
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.md')) } catch { return [] }
  const state = readState()
  return files.map((file) => {
    const slug = file.slice(0, -3)
    let meta = {}, body = ''
    try { ({ meta, body } = parseFrontmatter(fs.readFileSync(path.join(dir, file), 'utf8'))) } catch { void 0 }
    const st = state[keyFor(ws, slug)] || {}
    const lr = live.get(keyFor(ws, slug))
    return {
      slug,
      workspace: ws,
      name: scalar(meta.name) || slug,
      on: scalar(meta.on, 'fs'),
      paths: Array.isArray(meta.paths) ? meta.paths : [],
      agentFilter: scalar(meta.agentFilter),
      schedule: scalar(meta.schedule),
      gate: scalar(meta.gate),
      // No hardcoded provider: an unset `agent:` resolves to the operator's
      // configured/first-available agent at fire time (preferredAgentId) —
      // baking 'claude' in made every automation fail on machines without it.
      agent: scalar(meta.agent),
      isolated: meta.isolated === true || meta.isolated === 'true',
      cooldown: Math.max(0, Number(meta.cooldown) || 120),
      enabled: meta.enabled !== 'false',
      task: body,
      webhookPath: scalar(meta.on) === 'webhook' ? `/api/hooks/${slug}` : null,
      // Webhook secrets are generated on first list so the UI can display the
      // signing key before the endpoint has received any traffic.
      webhookSecret: scalar(meta.on) === 'webhook' ? webhookSecret(ws, slug) : null,
      running: !!lr?.running,
      lastRun: st.runs?.[0] || null
    }
  })
}

export function saveAutomation(workspace, slug, content) {
  if (!SLUG_RE.test(slug)) throw httpError(400, 'invalid automation name')
  const dir = automationsDir(workspace)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(dir, `${slug}.md`), String(content || ''), { mode: 0o600 })
  syncFsPins()
  emitChanged()
  return listAutomations(workspace).find((a) => a.slug === slug)
}

export function readAutomation(workspace, slug) {
  if (!SLUG_RE.test(slug)) throw httpError(400, 'invalid automation name')
  const file = path.join(automationsDir(workspace), `${slug}.md`)
  if (!fs.existsSync(file)) throw httpError(404, 'automation not found')
  return { slug, content: fs.readFileSync(file, 'utf8') }
}

// Flips the `enabled:` frontmatter key without touching the rest of the file.
export function toggleAutomation(workspace, slug, enabled) {
  const file = path.join(automationsDir(workspace), `${slug}.md`)
  const raw = fs.readFileSync(file, 'utf8')
  const next = /^enabled:\s*\S+/m.test(raw)
    ? raw.replace(/^enabled:\s*\S+/m, `enabled: ${enabled ? 'true' : 'false'}`)
    : raw.replace(/^---\n/, `---\nenabled: ${enabled ? 'true' : 'false'}\n`)
  fs.writeFileSync(file, next, { mode: 0o600 })
  syncFsPins()
  emitChanged()
  return listAutomations(workspace).find((a) => a.slug === slug)
}

export function removeAutomation(workspace, slug) {
  const ws = canonicalWorkspace(workspace)
  try { fs.rmSync(path.join(automationsDir(ws), `${slug}.md`), { force: true }) } catch { void 0 }
  const state = readState()
  delete state[keyFor(ws, slug)]
  writeState(state)
  syncFsPins()
  emitChanged()
  return { removed: true }
}

// ─── firing ──────────────────────────────────────────────────────────────
function automationCtx() {
  // Synthetic owner connection: passes access checks as admin and soaks up
  // session emits (nothing is subscribed server-side).
  return { principal: { sub: 'owner', username: 'automation', role: 'owner' }, emit: () => {}, automation: true }
}

function runningCount() {
  let n = 0
  for (const entry of live.values()) if (entry.running) n += 1
  return n
}

async function prepareWorktree(workspace, slug) {
  // Detached-HEAD worktree outside the workspace: the run edits an isolated
  // checkout that the fs watcher cannot see, and removing it is one command.
  const id = `${slug}-${Date.now().toString(36)}`
  const target = path.join(config.dataDir, 'worktrees', crypto.createHash('sha1').update(workspace).digest('hex').slice(0, 10), id)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  await execFileAsync('git', ['-C', workspace, 'worktree', 'add', '--detach', target, 'HEAD'], { timeout: 30_000 })
  // Marker lets the startup sweep find the owning repo even after a restart.
  try { fs.writeFileSync(path.join(target, '.harpy-origin'), workspace, { mode: 0o600 }) } catch { void 0 }
  return target
}

async function cleanupWorktree(dir) {
  if (!dir || !String(dir).startsWith(path.join(config.dataDir, 'worktrees'))) return
  try {
    const origin = fs.readFileSync(path.join(dir, '.harpy-origin'), 'utf8').trim()
    if (origin) await execFileAsync('git', ['-C', origin, 'worktree', 'remove', dir, '--force'], { timeout: 15_000 })
  } catch { void 0 }
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch { void 0 }
}

// Worktrees orphaned by a daemon restart are removed once at boot; live runs
// are only ever cleaned by their own session-end.
function sweepWorktrees() {
  const root = path.join(config.dataDir, 'worktrees')
  const active = new Set([...live.values()].map((e) => e.worktree).filter(Boolean))
  try {
    for (const hashDir of fs.readdirSync(root)) {
      for (const id of fs.readdirSync(path.join(root, hashDir))) {
        const dir = path.join(root, hashDir, id)
        if (!active.has(dir)) void cleanupWorktree(dir)
      }
    }
  } catch { void 0 }
}

export async function fireAutomation(workspace, slug, { trigger = 'manual', detail = {} } = {}) {
  const ws = canonicalWorkspace(workspace)
  const automation = listAutomations(ws).find((a) => a.slug === slug)
  if (!automation) throw httpError(404, 'automation not found')
  const key = keyFor(ws, slug)
  const entry = live.get(key) || { running: false }
  const st = readState()[key] || {}
  const lastTs = st.runs?.[0]?.ts || 0

  if (!automation.enabled && trigger !== 'manual') return { skipped: 'disabled' }
  if (entry.running) return { skipped: 'already running' }
  if (trigger !== 'manual' && Date.now() - lastTs < automation.cooldown * 1000) return { skipped: 'cooldown' }
  if (runningCount() >= MAX_CONCURRENT) return { skipped: 'concurrency cap' }

  const prompt = automation.task
    .replace(/\{files\}/g, (detail.files || []).join(', ') || '—')
    .replace(/\{trigger\}/g, trigger)
    .replace(/\{detail\}/g, JSON.stringify(detail).slice(0, 2000))
    .trim() || `Automation ${slug} fired (${trigger}).`

  let cwd = ws
  let worktree = null
  if (automation.isolated) {
    try { worktree = await prepareWorktree(ws, slug); cwd = worktree } catch { worktree = null }
  }

  if (automation.gate) {
    try {
      // /bin/sh does not exist on Windows — cmd /c keeps the same
      // exit-code contract (nonzero = the gate says work is needed).
      const gateShell = process.platform === 'win32' ? (process.env.ComSpec || 'cmd.exe') : '/bin/sh'
      const gateArgs = process.platform === 'win32' ? ['/d', '/s', '/c', automation.gate] : ['-c', automation.gate]
      await execFileAsync(gateShell, gateArgs, {
        cwd,
        timeout: GATE_TIMEOUT_MS,
        env: {
          ...process.env,
          HARPY_AUTOMATION: slug,
          HARPY_TRIGGER: trigger,
          HARPY_FILES: (detail.files || []).join(',')
        }
      })
      // exit 0: gate closed — record the cheap skip so the UI shows the
      // trigger fired without spending a token.
      void cleanupWorktree(worktree)
      const state = readState()
      recordRun(state, key, { trigger, status: 'skipped', detail: 'gate clean' })
      return { skipped: 'gate clean' }
    } catch { /* nonzero exit or timeout: the gate says work is needed */ }
  }

  entry.running = true
  entry.worktree = worktree
  entry.trigger = trigger
  live.set(key, entry)
  try {
    const session = await startRunner(automationCtx(), {
      agent: automation.agent || await preferredAgentId(),
      prompt,
      workspace: ws,
      cwd,
      automation: slug
    })
    entry.sessionId = session.sessionId
    const state = readState()
    recordRun(state, key, { trigger, status: 'started', sessionId: session.sessionId })
    recordActivity(ws, 'automation', { action: 'run', automation: slug, trigger, sessionId: session.sessionId })
    return { started: session.sessionId }
  } catch (error) {
    entry.running = false
    const state = readState()
    recordRun(state, key, { trigger, status: 'failed', detail: error.message })
    throw error
  }
}

// Called by the runner when any agent session ends: releases the slot and
// fires session-end automations for the session's workspace.
export function sessionEnded(session) {
  for (const [key, entry] of live) {
    if (entry.sessionId === session.sessionId) {
      entry.running = false
      entry.sessionId = null
      if (entry.worktree) {
        const dir = entry.worktree
        entry.worktree = null
        void cleanupWorktree(dir)
      }
      const state = readState()
      recordRun(state, key, { trigger: entry.trigger || 'unknown', status: 'done', sessionId: session.sessionId })
      notifyWebhook('automation.done', {
        title: `automation ${key.split('::')[1]} finished`,
        body: `session ${session.sessionId}`,
        workspace: session.workspace
      })
    }
  }
  if (session.automation) return // automation runs never trigger other automations
  const workspace = session.workspace
  for (const a of listAutomations(workspace)) {
    if (a.on !== 'session-end') continue
    if (a.agentFilter && a.agentFilter !== session.state?.agent) continue
    void fireAutomation(workspace, a.slug, { trigger: 'session-end', detail: { agent: session.state?.agent, sessionId: session.sessionId } })
  }
}

// ─── triggers ────────────────────────────────────────────────────────────
// fs flush hook — wired from fs.channel via registerFsListener at startup.
export function onFsChanged(workspace, files) {
  for (const a of listAutomations(workspace)) {
    if (a.on !== 'fs' || !a.enabled || !a.paths.length) continue
    const matchers = a.paths.map(globToRegex)
    const matched = files.filter((f) => !f.path.startsWith('.harpy/') && matchers.some((re) => re.test(f.path)))
    if (!matched.length) continue
    void fireAutomation(workspace, a.slug, { trigger: 'fs', detail: { files: matched.map((f) => f.path).slice(0, 20) } })
  }
}

// Workspaces with enabled fs automations keep their watcher pinned even when
// no client has the file tree open — otherwise events only exist while a UI
// is watching. Recomputed on each tick so edits made on disk self-heal.
const pinnedWorkspaces = new Set()
function syncFsPins() {
  const want = new Set()
  for (const ws of listKnownWorkspaces()) {
    if (listAutomations(ws).some((a) => a.on === 'fs' && a.enabled)) want.add(canonicalWorkspace(ws))
  }
  for (const ws of want) if (!pinnedWorkspaces.has(ws)) { pinFsWatcher(ws); pinnedWorkspaces.add(ws) }
  for (const ws of [...pinnedWorkspaces]) if (!want.has(ws)) { unpinFsWatcher(ws); pinnedWorkspaces.delete(ws) }
}

// Minute tick — cron schedules and "every N" periods.
export function startScheduler() {
  sweepWorktrees()
  const tick = () => {
    const now = new Date()
    syncFsPins()
    for (const ws of listKnownWorkspaces()) {
      for (const a of listAutomations(ws)) {
        if (a.on !== 'cron' || !a.enabled || !a.schedule) continue
        const every = everyMs(a.schedule)
        const st = readState()[keyFor(ws, a.slug)]
        const lastTs = st?.runs?.[0]?.ts || 0
        if (every) {
          if (Date.now() - lastTs < every) continue
        } else {
          const match = cronMatches(a.schedule, now)
          if (match === null) continue // unparseable schedule
          const minuteKey = Math.floor(now.getTime() / 60_000)
          if (match === false || st?.cronMinute === minuteKey) continue
          const state = readState()
          const rec = state[keyFor(ws, a.slug)] || (state[keyFor(ws, a.slug)] = { runs: [] })
          rec.cronMinute = minuteKey
          writeState(state)
        }
        void fireAutomation(ws, a.slug, { trigger: 'cron' })
      }
    }
  }
  const timer = setInterval(tick, CRON_TICK_MS)
  timer.unref?.()
}

// ─── inbound webhooks ────────────────────────────────────────────────────
// Public route: /api/hooks/<slug> — HMAC-verified so the share tunnel can
// expose it safely. Secret is generated per automation on first request and
// shown in the UI for pasting into GitHub/Linear/etc.
function webhookSecret(workspace, slug) {
  const key = keyFor(workspace, slug)
  const state = readState()
  const rec = state[key] || (state[key] = { runs: [] })
  if (!rec.webhookSecret) {
    rec.webhookSecret = `whsec_${crypto.randomBytes(24).toString('base64url')}`
    writeState(state)
  }
  return rec.webhookSecret
}

async function readRawBody(req, limit = 1_000_000) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw httpError(413, 'payload too large')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

export function automationRoutes(router) {
  router.post('/api/hooks/:slug', async (req) => {
    const slug = String(req.params.slug || '')
    const raw = await readRawBody(req)
    const signature = req.headers['x-harpy-signature'] || req.headers['x-hub-signature-256'] || ''
    // A slug may exist in several workspaces — a signature that fails for
    // one must not shadow a matching automation in another, so mismatch
    // continues the scan rather than answering 401 outright.
    let matched = false
    for (const ws of listKnownWorkspaces()) {
      const automation = listAutomations(ws).find((a) => a.slug === slug && a.on === 'webhook')
      if (!automation) continue
      matched = true
      const secret = webhookSecret(ws, slug)
      const expected = `sha256=${crypto.createHmac('sha256', secret).update(raw).digest('hex')}`
      const ok = signature.length === expected.length &&
        crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
      if (!ok) continue
      const result = await fireAutomation(ws, slug, { trigger: 'webhook', detail: { body: raw.toString('utf8').slice(0, 4000) } })
      return { ok: true, ...result }
    }
    throw httpError(matched ? 401 : 404, matched ? 'invalid signature' : 'no webhook automation with that slug')
  }, { auth: false })
}

// Channel surface lives in channels/automation.channel.js — the ops there
// resolve the caller's workspace through workspaceRoot() before touching
// .harpy/automations.
