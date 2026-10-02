import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import { spawnPty } from '../util/pty.js'
import { getAdapter } from './adapter.js'
import { config } from '../config.js'
import { httpError } from '../util/http.js'
import { enhancedEnv } from '../util/env.js'
import { cliEnvFor } from '../cli-env.js'
import { accessAlive, accessFor, listUsers, ownerKey } from '../auth.js'
import { projectIdForPath, workspaceCwd, workspaceRoot } from '../workspace.js'
import { recordActivity } from '../activity.js'
import { pinFsWatcher, unpinFsWatcher } from '../channels/fs.channel.js'
import { ensureMemory, tailFromHistory, writeHandoff } from '../handoffs.js'
import { runMemoryDigest } from '../memory.js'
import { notifyWebhook } from '../notify.js'

const execFileAsync = promisify(execFile)

const sessions = new Map()
const CHANGED_FILES_CACHE_MS = 4_000
const changedFilesCache = new Map()

// Presence fan-out is wired by index.js once the WS hub exists; the runner
// announces lifecycle changes and the hub relays them to every client.
let presenceNotifier = null
export function setPresenceNotifier(fn) { presenceNotifier = fn }
function announcePresence() { try { presenceNotifier?.() } catch { void 0 } }

let counter = 0
const MAX_HISTORY_EVENTS = 2_000
const MAX_HISTORY_BYTES = 2 * 1024 * 1024
const WS_HIGH_WATER_BYTES = 2 * 1024 * 1024
const WS_LOW_WATER_BYTES = 512 * 1024
const STOPPED_SESSION_TTL = 6 * 60 * 60 * 1_000
const IDLE_SWEEP_MS = 60_000
const AUTO_RESTART_MIN_UPTIME_MS = 10_000
const RESUME_FAST_EXIT_MS = 4_000
const REGISTRY_FILE = path.join(config.dataDir, 'agent-sessions.json')

// Agent PTYs are children of this process, so a service restart kills them
// all. The registry records which sessions were running so the next boot can
// respawn them and reconnecting clients find their tabs alive again.
const persisted = (() => {
  try {
    const raw = JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf8'))
    counter = Math.max(counter, Number(raw?.counter) || 0)
    return Array.isArray(raw?.sessions) ? raw.sessions : []
  } catch { return [] }
})()

function persistSessions() {
  try {
    fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 })
    fs.writeFileSync(REGISTRY_FILE, JSON.stringify({
      counter,
      sessions: [...sessions.values()].map((session) => ({
        sessionId: session.sessionId,
        agent: session.state.agent,
        workspace: session.workspace,
        cwd: session.state.cwd,
        automation: session.automation || undefined,
        owner: session.owner,
        index: session.index,
        team: session.team || undefined,
        prompt: session.prompt || undefined,
        startedAt: session.startedAt,
        sleepingAt: session.sleepingAt || 0,
        status: session.state.status
      }))
    }), { mode: 0o600 })
  } catch { /* the registry is best-effort; sessions keep working without it */ }
}



// Older builds stored `sub:clientId`; strip the client suffix so sessions
// recorded before per-user ownership still reattach after an upgrade.
function normalizeOwner(owner) {
  return String(owner || 'owner').split(':')[0] || 'owner'
}

function dimensions(cols, rows) {
  return {
    cols: Math.min(Math.max(Number(cols) || 100, 20), 500),
    rows: Math.min(Math.max(Number(rows) || 30, 5), 200)
  }
}

// CLIs spawn helpers that outlive a plain pty kill (devin → `devin acp`,
// codex → the rust binary + code-mode-host). Those survivors keep holding
// the session lock files, so the next resume fails with "session_locked".
// /proc gives the full subtree; the pty child is a session leader, so its
// group (-pid) covers helpers that re-parented.
function processTree(rootPid) {
  const root = Number(rootPid)
  const tree = new Set([root])
  const children = new Map()
  try {
    for (const name of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(name)) continue
      let stat
      try { stat = fs.readFileSync(`/proc/${name}/stat`, 'utf8') } catch { continue }
      const close = stat.lastIndexOf(')')
      if (close === -1) continue
      const ppid = Number(stat.slice(close + 2).split(' ')[1])
      if (!Number.isInteger(ppid) || ppid <= 0) continue
      const list = children.get(ppid)
      if (list) list.push(Number(name))
      else children.set(ppid, [Number(name)])
    }
  } catch { return tree }
  const queue = [root]
  while (queue.length) {
    for (const kid of children.get(queue.shift()) || []) {
      if (!tree.has(kid)) { tree.add(kid); queue.push(kid) }
    }
  }
  return tree
}

function isProcessAlive(pid) {
  try { process.kill(pid, 0); return true } catch (error) { return error?.code === 'EPERM' }
}

// SIGTERM first so a clean exit lets the CLI drop its session lock, then a
// short grace period before SIGKILL sweeps whatever ignored it.
function killProcessTree(rootPid, { graceMs = 800 } = {}) {
  const root = Number(rootPid)
  if (!Number.isInteger(root) || root <= 0) return
  const tree = [...processTree(root)]
  const signal = (pid, sig) => { try { process.kill(pid, sig) } catch { void 0 } }
  try { process.kill(-root, 'SIGTERM') } catch { void 0 }
  for (const pid of tree) signal(pid, 'SIGTERM')
  const sweep = setTimeout(() => {
    try { process.kill(-root, 'SIGKILL') } catch { void 0 }
    for (const pid of processTree(root)) signal(pid, 'SIGKILL')
    for (const pid of tree) signal(pid, 'SIGKILL')
  }, graceMs)
  sweep.unref?.()
}

function terminateSessionProcess(session) {
  const term = session.term
  if (!term) return
  killProcessTree(term.pid)
  try { term.kill('SIGTERM') } catch { void 0 }
}

// CLIs report a lock holder in their resume error (devin prints a JSON blob
// with lockHolderPid). Dig the pid out of the tail of the session's output.
const LOCK_PID_RE = /lockHolderPid["'\s:=]*(\d{2,10})/i
function lockHolderFromHistory(session) {
  for (let i = session.history.length - 1; i >= 0 && i >= session.history.length - 40; i--) {
    const item = session.history[i]
    if (item?.type !== 'data') continue
    const match = LOCK_PID_RE.exec(String(item.data || ''))
    if (match) return Number(match[1])
  }
  return 0
}

// The holder pid a CLI reports may belong to another harpy session that is
// legitimately running — never kill those, the user must close that tab.
function pidOwnedByLiveSession(pid) {
  for (const other of sessions.values()) {
    if (!other.term?.pid) continue
    if (processTree(other.term.pid).has(pid)) return true
  }
  return false
}

function pidMatchesAdapterCli(pid, agent) {
  try {
    const cli = getAdapter(agent)?.cli || agent
    return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes(cli)
  } catch { return false }
}

function updateSessionFlowControl(session) {
  const subscribers = [...session.viewers].filter((subscriber) => subscriber.ws?.readyState === 1)
  if (!session.term) {
    clearInterval(session.flowTimer)
    session.flowTimer = null
    session.flowPaused = false
    return
  }
  if (!subscribers.length) {
    if (session.flowPaused) { session.flowPaused = false; session.term?.resume() }
    clearInterval(session.flowTimer)
    session.flowTimer = null
    return
  }
  const high = subscribers.some((subscriber) => (subscriber.ws?.bufferedAmount || 0) >= WS_HIGH_WATER_BYTES)
  const low = subscribers.every((subscriber) => (subscriber.ws?.bufferedAmount || 0) <= WS_LOW_WATER_BYTES)
  if (high && !session.flowPaused) {
    session.term.pause()
    session.flowPaused = true
    session.flowTimer = setInterval(() => updateSessionFlowControl(session), 100)
    session.flowTimer.unref?.()
  } else if (low && session.flowPaused) {
    session.term.resume()
    session.flowPaused = false
    clearInterval(session.flowTimer)
    session.flowTimer = null
  }
}

// node-pty's onData fires once per read — a full-screen redraw is dozens of
// tiny chunks a second. Forwarding each one floods the socket with small
// frames and trips flow control on high-latency links, so data coalesces
// per ~16ms tick (one frame per screen refresh). emit() flushes pending
// data before any lifecycle event so ordering never inverts.
const DATA_FLUSH_MS = 16

function queueSessionData(session, chunk) {
  session.dataBuf = (session.dataBuf || '') + chunk
  if (session.dataTimer) return
  session.dataTimer = setTimeout(() => {
    session.dataTimer = null
    const data = session.dataBuf
    session.dataBuf = ''
    if (data) emit(session, { type: 'data', data })
  }, DATA_FLUSH_MS)
  session.dataTimer.unref?.()
}

function flushSessionData(session) {
  if (!session.dataTimer) return
  clearTimeout(session.dataTimer)
  session.dataTimer = null
  const data = session.dataBuf || ''
  session.dataBuf = ''
  if (data) emit(session, { type: 'data', data })
}

function emit(session, event) {
  if (session.closed) return
  if (event.type !== 'data') flushSessionData(session)
  if (event.type === 'data') session.lastActivityAt = Date.now()
  const data = { ...event, sessionId: session.sessionId, agent: session.state.agent, workspace: session.workspace, startedAt: session.startedAt, index: session.index, owner: session.owner, seq: ++session.sequence, ts: Date.now() }
  session.history.push(data)
  session.historyBytes += Buffer.byteLength(data.data || '')
  while (session.history.length > MAX_HISTORY_EVENTS || session.historyBytes > MAX_HISTORY_BYTES) {
    const removed = session.history.shift()
    session.historyBytes -= Buffer.byteLength(removed?.data || '')
  }
  for (const subscriber of new Set([...session.subscribers, ...session.viewers])) {
    // A revoked account must go quiet even while its socket is still open —
    // drop subscribers whose access died instead of streaming them output.
    if (!accessAlive(subscriber)) { session.subscribers.delete(subscriber); session.viewers.delete(subscriber); continue }
    if (event.type === 'data' && !session.viewers.has(subscriber)) continue
    try { subscriber.emit('agent', 'session', data) } catch { session.subscribers.delete(subscriber); session.viewers.delete(subscriber) }
  }
  updateSessionFlowControl(session)
}

function nextSessionIndex(ctx, agent, currentWorkspace) {
  const active = [...sessions.values()]
    .filter((item) => item.owner === ownerKey(ctx) && item.workspace === currentWorkspace && item.state.agent === agent && item.state.status !== 'stopped' && !item.closed)
  // Keep labels stable while any live session remains. Closing #1 while #2
  // is open therefore makes the next session #3; once all live sessions are
  // gone, numbering starts over at #1.
  return active.reduce((highest, item) => Math.max(highest, Number(item.index) || 0), 0) + 1
}

async function spawnTerm(session, args) {
  const AdapterClass = getAdapter(session.state.agent)
  const term = await spawnPty(AdapterClass.cli, args, {
    name: 'xterm-256color',
    ...session.size,
    cwd: session.state.cwd,
    // HARPY_HOME points the child at the daemon's real data dir so the
    // bundled shell — and member sessions with a redirected private HOME —
    // can reach cli.key. cli-env may still override it; built-in adapters
    // need the true value, so theirs always wins.
    env: await enhancedEnv({ TERM: 'xterm-256color', COLORTERM: 'truecolor', HARPY_HOME: config.dataDir, ...(session.adapter?.spawnEnv?.() || {}), ...(cliEnvFor(session.owner) || {}), ...(AdapterClass.builtin ? { HARPY_HOME: config.dataDir } : {}) })
  })
  session.term = term
  term.onData((data) => queueSessionData(session, data))
  term.onExit((exit) => handleExit(session, exit))
}

// A running session pins the workspace fs watcher so the activity log keeps
// recording the agent's file changes even while no client has the tree open.
function pinSessionWorkspace(session) {
  if (session.watcherPinned || !session.workspace) return
  try { pinFsWatcher(session.workspace); session.watcherPinned = true } catch { void 0 }
}
function unpinSessionWorkspace(session) {
  if (!session.watcherPinned) return
  session.watcherPinned = false
  try { unpinFsWatcher(session.workspace) } catch { void 0 }
}

// A stopping session archives a Markdown handoff into the workspace so the
// next session — any CLI, any user — can read what changed and continue.
async function archiveHandoff(session) {
  try {
    const files = await changedFilesFor(session)
    let branch = ''
    try {
      const { stdout } = await execFileAsync('git', ['-C', sessionCwd(session), 'rev-parse', '--abbrev-ref', 'HEAD'], { timeout: 5000 })
      branch = stdout.trim()
    } catch { branch = '' }
    const name = writeHandoff(session, { files, branch, tail: tailFromHistory(session.history) })
    if (name) {
      recordActivity(session.workspace, 'agent', { action: 'handoff', agent: session.state.agent, index: session.index, files: [`.harpy/handoffs/${name}`], user: session.ownerName })
      notifyWebhook('agent.handoff', {
        title: `${session.state.agent} #${session.index || 1} wrote a handoff`,
        body: `${files.length} changed file${files.length === 1 ? '' : 's'}${session.ownerName ? ` · ${session.ownerName}` : ''}`,
        workspace: session.workspace
      })
      // One short headless run turns the handoff snapshot into durable
      // MEMORY.md entries — the session's CLI first, then whatever other
      // digest-capable CLI answers. Gated per-user, never blocking.
      void runMemoryDigest({
        agent: session.state.agent,
        workspace: session.workspace,
        owner: session.owner,
        ownerName: session.ownerName,
        handoffName: name
      })
    }
  } catch { /* handoffs are best-effort */ }
}

// Automations register a session-end hook at startup — kept as a callback
// (not an import) so runner.js never cycles into automations.js.
let sessionEndHook = null
export function setSessionEndHook(fn) { sessionEndHook = fn }

function markSessionStopped(session) {
  session.state.status = 'stopped'
  session.closedAt = Date.now()
  unpinSessionWorkspace(session)
  void archiveHandoff(session)
  try { sessionEndHook?.(session) } catch { void 0 }
  persistSessions()
}

function handleExit(session, { exitCode, signal }) {
  flushSessionData(session)
  clearInterval(session.flowTimer)
  session.flowTimer = null
  session.flowPaused = false
  session.term = null
  // A suspension kills the PTY but must not run the stopped-session path:
  // no handoff, no session-end hooks, no reaper — it stays resumable.
  if (session.state.status === 'sleeping') {
    persistSessions()
    announcePresence()
    return
  }
  // A resume attempt that dies instantly probably used a flag this CLI does
  // not understand — retry once with plain arguments instead of leaving a
  // dead tab behind.
  const resumeFailed = !session.closed && session.resumedAt && Date.now() - session.resumedAt < RESUME_FAST_EXIT_MS && exitCode !== 0
  // A resume that fails with the CLI reporting a held session lock means a
  // stray helper survived the previous kill. Reap it once and retry the
  // resume so the conversation continues instead of resetting to a fresh
  // one. A holder that still belongs to a live harpy session is never
  // killed — the fallback below just spawns a fresh CLI as before.
  if (resumeFailed && !session.lockKilled) {
    const holder = lockHolderFromHistory(session)
    if (holder && !pidOwnedByLiveSession(holder)) {
      const alive = isProcessAlive(holder)
      if (!alive || pidMatchesAdapterCli(holder, session.state.agent)) {
        session.lockKilled = true
        if (alive) { try { process.kill(holder, 'SIGKILL') } catch { void 0 } }
        emit(session, { type: 'data', data: `\r\n\x1b[2m[harpy] a leftover ${session.state.agent} process (pid ${holder}) still held this session — killed it, retrying resume\x1b[0m\r\n` })
        respawnSession(session, { resume: true }).catch(() => markSessionStopped(session))
        return
      }
    }
  }
  // A long-running process that dies on a non-zero exit was crashed or killed
  // by an error, not deliberately quit. Give it one automatic restart.
  const crashed = !session.closed && !session.autoRestarted && session.state.status === 'running'
    && !signal && exitCode != null && exitCode !== 0
    && Date.now() - session.startedAt > AUTO_RESTART_MIN_UPTIME_MS
  if (resumeFailed || crashed) {
    if (crashed) session.autoRestarted = true
    session.resumedAt = 0
    respawnSession(session, { resume: false }).catch(() => markSessionStopped(session))
    return
  }
  // A deliberately closed tab should not be resurrected in connected
  // clients by the asynchronous PTY exit event.
  if (!session.closed) emit(session, { type: 'done', role: 'system', exitCode, signal })
  session.state.status = 'stopped'
  session.closedAt = Date.now()
  unpinSessionWorkspace(session)
  void archiveHandoff(session)
  try { sessionEndHook?.(session) } catch { void 0 }
  recordActivity(session.workspace, 'agent', { action: 'exit', agent: session.state.agent, index: session.index, exitCode, user: session.ownerName })
  notifyWebhook('agent.exit', {
    title: `${session.state.agent} #${session.index || 1} finished`,
    body: `session ended (code ${exitCode ?? '?'})${session.ownerName ? ` · ${session.ownerName}` : ''}`,
    workspace: session.workspace
  })
  persistSessions()
  announcePresence()
  setTimeout(() => {
    const current = sessions.get(session.sessionId)
    if (current && current.state.status !== 'running' && current.state.status !== 'sleeping') {
      sessions.delete(session.sessionId)
      changedFilesCache.delete(session.sessionId)
    }
  }, STOPPED_SESSION_TTL).unref?.()
}

async function respawnSession(session, { resume, reason } = {}) {
  let args = null
  if (resume) {
    try { args = session.adapter.buildResumeArgs?.() || null } catch { args = null }
  }
  if (!args) args = session.adapter.buildTerminalArgs({ prompt: '' })
  emit(session, {
    type: 'data',
    data: `\r\n\x1b[2m[harpy] ${reason || (resume ? 'server restarted — resuming this agent session' : 'agent process exited unexpectedly — restarting it')}\x1b[0m\r\n`
  })
  await spawnTerm(session, args)
  session.state.status = 'running'
  session.startedAt = Date.now()
  session.lastActivityAt = Date.now()
  session.sleepingAt = 0
  pinSessionWorkspace(session)
  if (resume) session.resumedAt = Date.now()
  emit(session, { type: 'status', role: 'system', status: 'started', agent: session.state.agent })
  persistSessions()
  announcePresence()
}

// Called once at server startup: sessions recorded as running when the last
// process died are respawned under their original ids so reconnecting
// clients reattach transparently. Stopped records are dropped — the UI's
// auto-close policy only ever applies to non-running sessions.
export async function restoreSessions() {
  for (const record of persisted) {
    // Automation runs are headless one-shots — a daemon restart cannot
    // redeliver their prompt, so respawning them would leave an empty CLI.
    if (record.automation) continue
    if (!['running', 'sleeping'].includes(record.status) || sessions.has(record.sessionId)) continue
    const AdapterClass = getAdapter(record.agent)
    if (!AdapterClass) continue
    const session = {
      sessionId: record.sessionId,
      adapter: new AdapterClass(),
      state: { agent: record.agent, cwd: record.cwd || workspaceCwd(record.workspace, ''), status: record.status === 'sleeping' ? 'sleeping' : 'running' },
      workspace: record.workspace || '',
      history: [],
      historyBytes: 0,
      sequence: 0,
      owner: normalizeOwner(record.owner),
      subscribers: new Set(),
      term: null,
      flowPaused: false,
      flowTimer: null,
      viewers: new Set(),
      startedAt: record.startedAt || Date.now(),
      index: Number(record.index) || 0,
      size: dimensions(100, 30),
      autoRestarted: false,
      resumedAt: 0,
      lastActivityAt: record.startedAt || Date.now(),
      sleepingAt: Number(record.sleepingAt) || 0,
      team: record.team || null,
      prompt: record.prompt || ''
    }
    sessions.set(session.sessionId, session)
    // Sleeping sessions come back as resumable records — no process until a
    // client presses wake.
    if (session.state.status === 'sleeping') continue
    try {
      await respawnSession(session, { resume: true })
    } catch {
      session.state.status = 'stopped'
      session.closedAt = Date.now()
      emit(session, { type: 'data', data: '\r\n\x1b[2m[harpy] could not restart this agent after a server restart\x1b[0m\r\n' })
      persistSessions()
    }
  }
}

// Idle sessions are the ones that come back wedged — the CLI locks itself or
// its session file goes stale while nobody is looking. Suspending frees the
// PTY and keeps the session resumable via the adapter's resume mechanism.
function suspendSession(session) {
  session.state.status = 'sleeping'
  session.sleepingAt = Date.now()
  unpinSessionWorkspace(session)
  emit(session, { type: 'data', data: '\r\n\x1b[2m[harpy] session suspended after inactivity — press wake to resume where it left off\x1b[0m\r\n' })
  emit(session, { type: 'status', role: 'system', status: 'sleeping', agent: session.state.agent })
  terminateSessionProcess(session)
  recordActivity(session.workspace, 'agent', { action: 'sleep', agent: session.state.agent, index: session.index, user: session.ownerName })
  persistSessions()
  announcePresence()
}

const idleSweep = setInterval(() => {
  if (!config.agentIdleMs) return
  const now = Date.now()
  for (const session of sessions.values()) {
    if (session.closed || session.automation) continue
    if (session.state.status !== 'running' || !session.term) continue
    if (now - (session.lastActivityAt || session.startedAt) < config.agentIdleMs) continue
    suspendSession(session)
  }
// Sweep at most once a minute, but often enough that a short configured
// timeout is enforced without a long lag (also keeps testing practical).
}, Math.min(IDLE_SWEEP_MS, Math.max(config.agentIdleMs || IDLE_SWEEP_MS, 1000)))
idleSweep.unref?.()

// Wake is the inverse of suspend: respawn under the adapter's resume args so
// the conversation continues. Stopped-but-retained sessions can also be
// woken; closed ones are gone for good.
export async function wakeRunner(ctx, sessionId) {
  const session = getSession(ctx, sessionId, { write: true })
  if (session.state.status === 'running' && session.term) return sessionInfo(session)
  session.autoRestarted = false
  session.lockKilled = false
  await respawnSession(session, { resume: true, reason: 'resuming suspended session' })
  return sessionInfo(session)
}

export async function startRunner(ctx, { agent, prompt = '', cwd, workspace, cols = 100, rows = 30, automation, team } = {}) {
  const AdapterClass = getAdapter(agent)
  if (!AdapterClass) throw httpError(400, 'unknown agent')
  const sessionId = `s_${++counter}`
  const requestedWorkspace = workspaceRoot(workspace, ctx)
  // Scaffold .harpy/ (MEMORY.md, gitignore, AGENTS.md pointer) before the
  // spawn so the files exist by the time the agent's first prompt arrives —
  // unless the session owner opted out of workspace memory entirely.
  const sessionOwner = ownerKey(ctx)
  ensureMemory(requestedWorkspace, sessionOwner)
  // The root AGENTS.md pointer is the only memory channel — every agent CLI
  // auto-loads it, so nothing is injected into the user's prompt.
  const initialPrompt = prompt
  const index = nextSessionIndex(ctx, agent, requestedWorkspace)
  const session = {
    sessionId,
    adapter: new AdapterClass(),
    // Automation runs may point cwd at an isolated worktree outside the
    // workspace root — the synthetic owner ctx already vetted the
    // definition. The ctx marker (not the client payload) is what unlocks
    // allowOutside, so a WS client cannot opt out by sending the flag.
    state: { agent, cwd: workspaceCwd(requestedWorkspace, cwd, ctx, { allowOutside: !!automation && !!ctx?.automation }), status: 'running' },
    // Capture the workspace at spawn time. Selecting another workspace must
    // never move or terminate an already running agent process.
    workspace: requestedWorkspace,
    history: [],
    historyBytes: 0,
    sequence: 0,
    owner: ownerKey(ctx),
    subscribers: new Set([ctx]),
    viewers: new Set([ctx]),
    term: null,
    flowPaused: false,
    flowTimer: null,
    startedAt: Date.now(),
    index,
    size: dimensions(cols, rows),
    dataBuf: '',
    dataTimer: null,
    autoRestarted: false,
    resumedAt: 0,
    lastActivityAt: Date.now(),
    sleepingAt: 0,
    automation: automation || null,
    ownerName: ctx?.principal?.username || ownerKey(ctx),
    // A team is just a label on the session — the same "seats in a rig"
    // grouping, without an external orchestrator.
    team: String(team || '').trim().slice(0, 64) || null,
    // The operator's own task text (the launch prompt minus the injected
    // memory context) — shown as the session's purpose in lists/statuslines.
    prompt: String(prompt || '').trim().slice(0, 160)
  }
  let args
  try {
    args = session.adapter.buildTerminalArgs({ prompt: initialPrompt })
  } catch (error) {
    throw httpError(400, error.message || 'invalid agent arguments')
  }
  try {
    await spawnTerm(session, args)
  } catch (error) {
    throw httpError(400, error.code === 'ENOENT' ? 'agent cli not found' : (error.message || 'agent process failed to start'))
  }
  sessions.set(sessionId, session)
  pinSessionWorkspace(session)
  // Attach PTY listeners before announcing startup so fast CLIs cannot emit
  // their first screen between spawn and the initial status event.
  emit(session, { type: 'status', role: 'system', status: 'started', agent })
  if (initialPrompt) setTimeout(() => { if (session.state.status === 'running') session.term?.write(String(initialPrompt) + '\r') }, 80)
  recordActivity(requestedWorkspace, 'agent', { action: 'start', agent, index, user: session.ownerName })
  persistSessions()
  announcePresence()
  return sessionInfo(session)
}

function sessionInfo(session) {
  return {
    sessionId: session.sessionId,
    agent: session.state.agent,
    status: session.state.status,
    startedAt: session.startedAt,
    index: session.index,
    workspace: session.workspace,
    cwd: session.state.cwd,
    automation: session.automation || null,
    team: session.team || null,
    pid: session.term?.pid || null,
    sleepingAt: session.sleepingAt || 0,
    lastActivityAt: session.lastActivityAt || 0,
    prompt: session.prompt || ''
  }
}

function usernamesById() {
  try { return new Map(listUsers().map((user) => [String(user.id), user.username])) } catch { return new Map() }
}

// Presence, watch, and read-through enforce the same project boundary as
// fs/git ops: a member may only see foreign sessions that live inside a
// workspace on their allowlist. Admins are unrestricted.
function mayReachWorkspace(access, workspace) {
  if (!access) return false
  if (access.admin || !access.projects) return true
  return access.projects.has(projectIdForPath(workspace))
}

// Read access: the owner, any admin, or a context that explicitly watched the
// session (watch itself is allowlist-gated). Write access: the owner or an
// admin only — a member can watch an admin's terminal but can never type
// into it.
function getSession(ctx, sessionId, { write = false } = {}) {
  const session = sessions.get(sessionId)
  if (!session || session.closed) throw httpError(404, 'session not found')
  // A disabled/deleted owner loses live control too — session ownership is
  // not a bypass around mid-session revocation.
  const access = accessFor(ctx)
  if (!access) throw httpError(401, 'session revoked')
  if (session.owner === ownerKey(ctx)) {
    session.subscribers.add(ctx)
    return session
  }
  if (access.admin) {
    session.subscribers.add(ctx)
    return session
  }
  if (!write && session.subscribers.has(ctx) && mayReachWorkspace(access, session.workspace)) return session
  throw httpError(404, 'session not found')
}

export function inputRunner(ctx, sessionId, data) {
  const session = getSession(ctx, sessionId, { write: true })
  if (session.state.status === 'sleeping') throw httpError(409, 'session sleeping — wake it first')
  if (session.state.status !== 'running' || !session.term) throw httpError(404, 'session not running')
  if (data == null) return { ok: true }
  session.lastActivityAt = Date.now()
  session.term.write(String(data))
  return { ok: true }
}

export function resizeRunner(ctx, sessionId, cols, rows) {
  const session = sessions.get(sessionId)
  if (!session || session.closed) throw httpError(404, 'session not found')
  if (!accessFor(ctx)) throw httpError(401, 'session revoked')
  // A viewer never resizes the owner's PTY — the watcher's viewport adapts
  // to the session's dimensions, not the other way around.
  if (session.owner !== ownerKey(ctx)) return { ok: true }
  const size = dimensions(cols, rows)
  session.size = size
  if (session.state.status !== 'running' || !session.term) return { ok: true }
  session.term.resize(size.cols, size.rows)
  return { ok: true }
}

export function sendToRunner(ctx, sessionId, text) {
  const session = getSession(ctx, sessionId, { write: true })
  if (session.state.status === 'sleeping') throw httpError(409, 'session sleeping — wake it first')
  if (session.state.status !== 'running' || !session.term) throw httpError(404, 'session not running')
  if (!String(text || '').trim()) throw httpError(400, 'text required')
  session.lastActivityAt = Date.now()
  session.term.write(String(text) + '\r')
  return { ok: true }
}

export function stopRunner(ctx, sessionId) {
  const session = getSession(ctx, sessionId, { write: true })
  // Stopping a suspended session finalizes it — the PTY is already gone.
  if (session.state.status === 'sleeping') {
    session.state.status = 'stopped'
    session.sleepingAt = 0
    session.closedAt = Date.now()
    emit(session, { type: 'done', role: 'system', exitCode: null })
    persistSessions()
    announcePresence()
    // Same retention sweep a PTY exit would run — the record stays readable
    // for a few hours, then frees its history buffer.
    setTimeout(() => {
      const current = sessions.get(session.sessionId)
      if (current && current.state.status === 'stopped') {
        sessions.delete(session.sessionId)
        changedFilesCache.delete(session.sessionId)
      }
    }, STOPPED_SESSION_TTL).unref?.()
    return { ok: true }
  }
  if (session.state.status === 'running' && session.term) {
    session.state.status = 'stopped'
    terminateSessionProcess(session)
  }
  announcePresence()
  return { ok: true }
}

// Closing a tab is stronger than stopping a process: remove the reconnectable
// session and its history so an explicit close cannot reappear after refresh.
export function closeRunner(ctx, sessionId) {
  const session = getSession(ctx, sessionId, { write: true })
  session.closed = true
  if (session.state.status === 'running' && session.term) {
    terminateSessionProcess(session)
    session.state.status = 'stopped'
  }
  sessions.delete(sessionId)
  changedFilesCache.delete(sessionId)
  persistSessions()
  announcePresence()
  return { ok: true }
}

// Live sessions owned by other accounts — the presence strip under the agent
// terminal header. Members only see sessions inside their allowed projects;
// writing into a foreign session still requires admin rights (enforced per
// op above).
export function listPresence(ctx) {
  const me = ownerKey(ctx)
  const access = accessFor(ctx)
  const names = usernamesById()
  return [...sessions.values()]
    .filter((session) => !session.closed && session.state.status === 'running' && session.owner !== me)
    .filter((session) => mayReachWorkspace(access, session.workspace))
    .map((session) => ({ ...sessionInfo(session), owner: session.owner, ownerName: names.get(session.owner) || session.owner }))
}

// Watching subscribes this connection to a foreign session's live output and
// unlocks its history read. It grants no write access by itself, and it is
// bounded by the caller's project allowlist — a member cannot tail an admin
// session running in a project they were never granted.
export function watchRunner(ctx, sessionId) {
  const session = sessions.get(sessionId)
  if (!session || session.closed) throw httpError(404, 'session not found')
  if (session.owner !== ownerKey(ctx) && !mayReachWorkspace(accessFor(ctx), session.workspace)) {
    throw httpError(404, 'session not found')
  }
  session.subscribers.add(ctx)
  session.viewers.add(ctx)
  updateSessionFlowControl(session)
  const names = usernamesById()
  return { ...sessionInfo(session), owner: session.owner, ownerName: names.get(session.owner) || session.owner }
}

export function unwatchRunner(ctx, sessionId) {
  const session = sessions.get(sessionId)
  if (session) {
    session.viewers.delete(ctx)
    if (session.owner !== ownerKey(ctx)) session.subscribers.delete(ctx)
    updateSessionFlowControl(session)
  }
  return { ok: true }
}

function sessionCwd(session) {
  const cwd = path.resolve(String(session.state.cwd || session.workspace || '.'))
  const root = path.resolve(String(session.workspace || cwd))
  return cwd === root || cwd.startsWith(root + path.sep) ? cwd : root
}

function parseChangedFiles(output) {
  const files = []
  const entries = output.split('\0').filter(Boolean)
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]
    const status = entry.slice(0, 2).trim() || '?'
    const filePath = entry.slice(3)
    if (!filePath) continue
    files.push({ path: filePath, status })
    // In -z porcelain, renames/copies emit a second entry holding the source
    // path — skip it so it does not surface as a changed file.
    if (/[RC]/.test(status)) index++
  }
  return files.slice(0, 80)
}

async function changedFilesFor(session) {
  const cached = changedFilesCache.get(session.sessionId)
  if (cached && Date.now() - cached.ts < CHANGED_FILES_CACHE_MS) return cached.files
  let files = []
  try {
    const { stdout } = await execFileAsync('git', ['-C', sessionCwd(session), 'status', '--porcelain=v1', '-z', '--untracked-files=normal'], {
      timeout: 10_000,
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
    })
    files = parseChangedFiles(stdout)
  } catch { files = [] }
  changedFilesCache.set(session.sessionId, { ts: Date.now(), files })
  return files
}

export async function listChangedFiles(ctx, sessionId) {
  getSession(ctx, sessionId)
  return changedFilesFor(sessions.get(sessionId))
}

export function detachSubscriber(ctx) {
  for (const session of sessions.values()) {
    session.subscribers.delete(ctx)
    session.viewers.delete(ctx)
    updateSessionFlowControl(session)
  }
}

export function listSessions(ctx, requestedWorkspace) {
  const workspace = requestedWorkspace ? workspaceRoot(requestedWorkspace, ctx) : ''
  const own = [...sessions.values()].filter((session) => session.owner === ownerKey(ctx) && (!workspace || session.workspace === workspace))
  return own.map(sessionInfo)
}

export function getHistory(ctx, sessionId) {
  const session = getSession(ctx, sessionId)
  session.viewers.add(ctx)
  session.subscribers.add(ctx)
  updateSessionFlowControl(session)
  return session.history
}
