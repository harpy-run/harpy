import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { getAdapter, listAgents } from './agents/adapter.js'
import { config } from './config.js'
import { enhancedEnv } from './util/env.js'
import { cliEnvFor } from './cli-env.js'
import { recordActivity } from './activity.js'

// Per-user preference, two switches sharing one store record:
// - `memory`: the whole .harpy/ persistent-memory integration (scaffold,
//   handoffs, AGENTS.md pointer, launch-prompt hint). Off means Harpy leaves
//   the workspace untouched — nothing is created, nothing is injected.
// - `digest`: whether a finished session may also spend a small background
//   CLI run distilling durable facts into MEMORY.md. On by default — the
//   user whose CLI ran the session pays the tokens, so the choice belongs
//   to that same user.
const DIGEST_TIMEOUT_MS = 120_000
const DIGEST_MAX_BUFFER = 2 * 1024 * 1024
const DIGEST_MAX_CANDIDATES = 3
const DIGEST_MAX_ATTEMPTS = 6

// execFile keeps the child's stdin pipe open, so a CLI that reads prompt
// input from stdin (claude's stream-json mode) waits forever and dies by
// timeout instead of answering fast. spawn + immediate stdin.end() gives
// every headless CLI a clean EOF.
function runCli(cli, args, { cwd, env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cli, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })
    let out = ''
    let settled = false
    const done = (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      error ? reject(error) : resolve({ stdout: out })
    }
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch { void 0 }
      done(new Error(`${cli} timed out`))
    }, DIGEST_TIMEOUT_MS)
    child.stdout.on('data', (chunk) => {
      out += chunk
      if (out.length > DIGEST_MAX_BUFFER) done(new Error(`${cli} output overflow`))
    })
    child.stderr.on('data', () => {})
    child.on('error', done)
    child.on('close', (code) => done(code === 0 ? null : new Error(`${cli} exited ${code}`)))
    child.stdin.end()
  })
}

function storeFile() {
  return path.join(config.dataDir, 'memory.json')
}

function readStore() {
  try {
    return JSON.parse(fs.readFileSync(storeFile(), 'utf8')) || {}
  } catch {
    return {}
  }
}

function writeStore(store) {
  fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 })
  fs.writeFileSync(storeFile(), JSON.stringify(store, null, 2), { mode: 0o600 })
  try { fs.chmodSync(storeFile(), 0o600) } catch { void 0 }
}

export function memoryPrefsFor(sub) {
  const record = readStore()[String(sub)] || {}
  return { memory: record.memory !== false, digest: record.digest !== false }
}

export function memoryEnabledFor(sub) {
  return memoryPrefsFor(sub).memory
}

export function saveMemoryPrefs(sub, { memory, digest } = {}) {
  const store = readStore()
  const record = { ...(store[String(sub)] || {}) }
  if (memory !== undefined) record.memory = !!memory
  if (digest !== undefined) record.digest = !!digest
  if (record.memory === false || record.digest === false) store[String(sub)] = record
  else delete store[String(sub)]
  writeStore(store)
  return memoryPrefsFor(sub)
}

// Headless arg support is what makes an adapter digest-capable: `cli` for
// the binary plus a buildArgs that produces a non-interactive prompt run.
function digestArgsFor(agentId, prompt) {
  try {
    const AdapterClass = getAdapter(agentId)
    if (!AdapterClass?.cli) return null
    const adapter = new AdapterClass()
    const args = adapter.buildArgs({ prompt })
    return args?.length ? { cli: AdapterClass.cli, args, adapter } : null
  } catch {
    return null
  }
}

// Stream-JSON CLIs (claude, codex) emit protocol frames on stdout while
// plain `-p` CLIs just print text — adapter.normalizeLine already knows how
// to turn both into assistant message chunks.
function replyText(adapter, stdout) {
  const parts = []
  for (const line of String(stdout || '').split('\n')) {
    if (!line.trim()) continue
    try {
      for (const event of adapter.normalizeLine(line)) {
        if (event?.type === 'message' && event.text) parts.push(event.text)
        if (event?.type === 'done' && event.result) parts.push(event.result)
      }
    } catch { parts.push(line) }
  }
  return parts.join('\n').trim()
}

// The CLI never writes MEMORY.md — it only proposes lines as reply text and
// Harpy appends them. A scratch cwd outside the workspace protects against
// Devin-style session hijacking but also means a workspace-scoped CLI could
// never write the file anyway; owning the write makes every adapter equal.
const KNOWN_SECTIONS = ['Conventions', 'Decisions', 'Gotchas', 'Environment']

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// Pull `## Heading` + `- line` pairs out of the reply. Bullets seen before
// any heading land under Gotchas — the loosest durable bucket.
function proposedSections(text) {
  const bullets = []
  let heading = 'Gotchas'
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim()
    const h = line.match(/^#{1,4}\s+(.+)$/)
    if (h) { heading = h[1].replace(/\*+/g, '').trim() || heading; continue }
    const b = line.match(/^[-*•]\s+(.+)$/) || line.match(/^\d{1,2}[.)]\s+(.+)$/)
    if (b) bullets.push({ heading, text: b[1].trim().slice(0, 240) })
  }
  const sections = new Map()
  for (const item of bullets.slice(0, 3)) {
    if (!sections.has(item.heading)) sections.set(item.heading, [])
    sections.get(item.heading).push(item.text)
  }
  return sections
}

// Merge proposed bullets into MEMORY.md under their sections (created when
// missing), skipping exact duplicates. Returns the number of lines added.
function appendMemory(file, sections) {
  let content = ''
  try { content = fs.readFileSync(file, 'utf8') } catch { content = '# Project memory\n' }
  const lines = content.split('\n')
  let added = 0
  for (const [heading, items] of sections) {
    const canonical = KNOWN_SECTIONS.find((k) => k.toLowerCase() === heading.toLowerCase()) || heading
    let i = lines.findIndex((line) => new RegExp(`^##\\s+${escapeRegExp(canonical)}\\s*$`, 'i').test(line))
    if (i === -1) {
      if (lines[lines.length - 1] !== '') lines.push('')
      lines.push(`## ${canonical}`, '')
      i = lines.length - 2
    }
    let end = i + 1
    while (end < lines.length && !/^##\s/.test(lines[end])) end += 1
    const existing = new Set(
      lines.slice(i + 1, end).filter((line) => /^[-*]\s/.test(line.trim())).map((line) => line.trim().replace(/^[-*]\s+/, ''))
    )
    const fresh = items.filter((item) => !existing.has(item))
    if (!fresh.length) continue
    // Land bullets inside the section: after its first non-empty lines,
    // before the blank run that separates the next heading.
    let insertAt = end
    while (insertAt > i + 1 && lines[insertAt - 1].trim() === '') insertAt -= 1
    const block = fresh.map((item) => `- ${item}`)
    if (insertAt === i + 1) block.unshift('')
    lines.splice(insertAt, 0, ...block)
    added += fresh.length
  }
  if (added) fs.writeFileSync(file, lines.join('\n'), { mode: 0o644 })
  return added
}

// A stopped session leaves a handoff snapshot behind; the digest gives a
// short headless CLI run to read it and distill durable facts into
// MEMORY.md. This is deliberately best-effort: no retries beyond the
// fallback chain below, a hard timeout, and a dead/killed process is simply
// skipped — memory is a nice-to-have, never a reason to hold a session's
// exit path hostage.
//
// The digest runs from a scratch cwd under dataDir, not the workspace. Some
// CLIs (Devin) key sessions per-directory and route a `-p` run into the
// user's live interactive session when the cwd matches — which is how a
// background digest once hijacked a real TUI chat. Absolute paths keep the
// handoff + MEMORY.md reachable from any cwd.
//
// Fallback matters more than it looks: the session's CLI is tried first
// under the owner's environment, but that env can lack the credentials the
// interactive session had (e.g. a private CLI home that was never logged
// in). Next candidates are the other headless-capable CLIs reported
// available — first under the same owner env, then under the shared daemon
// env, which is the credential pool sessions inherit anyway. The outcome is
// always recorded so a silent chain of failures stays visible.
export async function runMemoryDigest({ agent, workspace, owner, ownerName, handoffName } = {}) {
  const prefs = memoryPrefsFor(owner)
  if (!prefs.memory || !prefs.digest) return
  const handoffPath = path.join(workspace, '.harpy', 'handoffs', handoffName)
  const memoryPath = path.join(workspace, '.harpy', 'MEMORY.md')
  const prompt = `[harpy] An agent session just ended in the workspace at ${workspace}. Its snapshot is at ${handoffPath} — read it (changed files + terminal tail).\n\nIf it reveals anything durable worth remembering across sessions — a coding convention, a decision and its reason, a gotcha that cost time, an environment quirk, a verification that caught a real problem — reply with at most 3 memory lines to record. Format them exactly as:\n\n## Conventions\n- one line\n## Gotchas\n- one line\n\nValid headings: Conventions, Decisions, Gotchas, Environment. Record a decision WITH its reason, not the bare choice. Never record task progress, chat history, or trivia. If nothing qualifies, reply with exactly NONE. Your reply text is consumed directly — do not write or modify any file, and do not add commentary around the lines.`

  const order = [agent]
  try {
    for (const info of await listAgents()) {
      // Built-in adapters (the harpy shell itself) can't answer a digest —
      // `harpy chat <prompt>` would nest a whole REPL just to reach a CLI.
      if (info?.id && info.available && !getAdapter(info.id)?.builtin && !order.includes(info.id)) order.push(info.id)
    }
  } catch { /* availability list is advisory — the session agent still runs */ }

  const candidates = order
    .map((id) => ({ id, run: getAdapter(id)?.builtin ? null : digestArgsFor(id, prompt) }))
    .filter((entry) => entry.run)
    .slice(0, DIGEST_MAX_CANDIDATES)

  const ownerExtra = cliEnvFor(owner)
  const ownerEnv = await enhancedEnv({ ...(ownerExtra || {}) })
  const digestCwd = path.join(config.dataDir, 'memory-runs')
  fs.mkdirSync(digestCwd, { recursive: true, mode: 0o700 })

  // First pass: every candidate under the owner's env — a private CLI home
  // either answers or refuses auth within seconds, so breadth-first across
  // CLIs finds a working one fastest. Second pass: the same candidates
  // under the daemon's shared env — the credential pool a member with no
  // private home would use interactively. Skipped when the owner has no
  // per-user env, because ownerEnv already IS the daemon env.
  const envs = ownerExtra ? [ownerEnv, null] : [ownerEnv]
  const attempts = envs.flatMap((env) => candidates.map((entry) => ({ ...entry, env })))

  let lastError = 'no digest-capable CLI'
  for (const attempt of attempts.slice(0, DIGEST_MAX_ATTEMPTS)) {
    try {
      const env = attempt.env || (await enhancedEnv({}))
      const { stdout } = await runCli(attempt.run.cli, attempt.run.args, { cwd: digestCwd, env })
      const reply = replyText(attempt.run.adapter, stdout)
      if (!reply) throw new Error(`${attempt.id} returned an empty reply`)
      const record = { action: 'memoryDigest', agent: attempt.id, ok: true, user: ownerName || owner }
      if (/^none\b/i.test(reply)) record.changed = 0
      else {
        const added = appendMemory(memoryPath, proposedSections(reply))
        record.changed = added
        if (!added) record.note = 'no structured lines'
      }
      recordActivity(workspace, 'agent', record)
      return
    } catch (error) {
      lastError = error?.message?.split('\n')[0]?.slice(0, 160) || 'digest failed'
    }
  }
  recordActivity(workspace, 'agent', { action: 'memoryDigest', agent, ok: false, reason: lastError, user: ownerName || owner })
}
