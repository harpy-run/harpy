// The interactive `harpy` shell — a codex-style REPL on top of everything
// harpy already is. Plain text chats with the current agent (each turn is a
// headless spawn via the adapter's own args/normalizer, so every supported
// CLI renders the same way). Slash commands drive the daemon over the local
// WebSocket: a "team" is a named group of daemon-side agent sessions — the
// same seats-in-a-fleet idea, minus the external orchestrator.

import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import { spawn } from 'node:child_process'
import { ask, c, canOpenBrowser, choose, toggleMenu } from './cli-ui.js'
import { readCliConfig, resolvePort, writeCliConfig } from './cli-config.js'
import { config, VERSION } from './config.js'
import { enhancedEnv } from './util/env.js'

const CLI_KEY_FILE = () => path.join(config.dataDir, 'daemon', 'cli.key')

// eslint-disable-next-line no-control-regex -- terminal output sanitization needs the control bytes
const stripAnsi = (text) => String(text).replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')

const dim = (s) => c.dim(s)
const ok = (s) => c.ok(s)
const warn = (s) => c.warn(s)

// --- daemon link: local WS client -----------------------------------------
// Auth rides the loopback capability file the daemon writes at boot
// ($HARPY_HOME/daemon/cli.key, 0600). No password prompts on the host's own
// account; when the file is missing the daemon is simply down or unconfigured.

export class DaemonLink {
  constructor(port) {
    this.port = port
    this.ws = null
    this.nextId = 0
    this.pending = new Map()
    this.push = null // (channel, event, data) push handler
    this.closed = false
  }

  async connect() {
    if (this.ws?.readyState === WebSocket.OPEN) return this
    const key = fs.existsSync(CLI_KEY_FILE()) ? fs.readFileSync(CLI_KEY_FILE(), 'utf8').trim() : ''
    if (!key) throw new Error('no cli key — the daemon did not finish setup or is not running')
    const ws = new WebSocket(`ws://127.0.0.1:${this.port}/ws`, ['harpy', key])
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { ws.close(); reject(new Error('connection timed out')) }, 5_000)
      ws.onopen = () => { clearTimeout(timer); resolve() }
      ws.onerror = () => { clearTimeout(timer); reject(new Error(`cannot reach daemon on :${this.port}`)) }
      ws.onclose = () => { /* handled below */ }
    })
    ws.onmessage = (msg) => {
      let frame
      try { frame = JSON.parse(msg.data) } catch { return }
      if (frame.id && this.pending.has(frame.id)) {
        const { resolve, reject } = this.pending.get(frame.id)
        this.pending.delete(frame.id)
        frame.ok ? resolve(frame.data) : reject(new Error(frame.error || 'request failed'))
      } else if (frame.ch && frame.ev) {
        try { this.push?.(frame.ch, frame.ev, frame.data) } catch { void 0 }
      }
    }
    ws.onclose = () => {
      this.ws = null
      for (const { reject } of this.pending.values()) reject(new Error('daemon connection dropped'))
      this.pending.clear()
      this.push?.('daemon', 'closed', null)
    }
    this.ws = ws
    return this
  }

  call(ch, op, data = {}) {
    if (this.ws?.readyState !== WebSocket.OPEN) return Promise.reject(new Error('daemon not connected'))
    const id = `cli-${++this.nextId}`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('request timed out')) }, 30_000)
      this.pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v) }, reject: (e) => { clearTimeout(timer); reject(e) } })
      this.ws.send(JSON.stringify({ ch, op, id, data }))
    })
  }

  close() { try { this.ws?.close() } catch { void 0 } }
}

// --- agent chat turns ------------------------------------------------------
// One process per turn: the adapter's headless args + line normalizer give
// every CLI the same rendered stream. Follow-ups use buildContinueArgs when
// the agent supports headless resume; the runner's PTY sessions stay a
// separate, daemon-owned thing.

async function runAgentTurn(state, text) {
  const AdapterClass = state.adapters.get(state.agent)
  if (!AdapterClass) throw new Error(`no agent selected — /use <id>`)
  const adapter = new AdapterClass()
  // Fresh conversations get the same persistent-memory context a daemon
  // session would: .harpy/ scaffold + the MEMORY.md launch hint, so a bot
  // chatting here and a team bot spawned via /team learn the same project.
  // Resumed turns skip it — the conversation already carries the context.
  if (state.fresh) {
    const { ensureMemory, memoryPromptHint } = await import('./handoffs.js')
    ensureMemory(state.cwd, 'owner')
    const hint = memoryPromptHint(state.cwd, 'owner')
    if (hint) text = `${hint}\n\n${text}`
  }
  const args = state.fresh
    ? adapter.buildArgs({ prompt: text })
    : (adapter.buildContinueArgs({ prompt: text, sessionId: state.agentSession }) ?? adapter.buildArgs({ prompt: text }))
  const env = await enhancedEnv()
  return new Promise((resolve) => {
    const child = spawn(AdapterClass.cli, args, { cwd: state.cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
    state.child = child
    let tail = ''
    let stderr = ''
    let wroteSinceBreak = false
    // First real output kills the "thinking…" spinner row the caller draws.
    const write = (chunk) => {
      if (!state.wroteOutput) { state.wroteOutput = true; process.stdout.write('\r\x1b[2K') }
      process.stdout.write(chunk)
      wroteSinceBreak = true
    }
    child.stdout.on('data', (chunk) => {
      tail += chunk.toString('utf8')
      let nl
      while ((nl = tail.indexOf('\n')) >= 0) {
        const line = tail.slice(0, nl)
        tail = tail.slice(nl + 1)
        for (const event of adapter.normalizeLine(line, state) || []) {
          if (event.type === 'meta' && event.sessionId) state.agentSession = event.sessionId
          else if (event.providerSessionId) state.agentSession = event.providerSessionId
          else if (event.type === 'message' && event.text) write(event.partial ? event.text : `${event.text}\n`)
          else if (event.type === 'tool') write(dim(`  ⚙ ${event.tool?.name || 'tool'}\n`))
          else if (event.type === 'status' && event.status === 'error') write(warn(`  ! ${event.reason || 'error'}\n`))
        }
      }
    })
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); stderr = stderr.slice(-8_000) })
    child.on('error', (error) => {
      state.child = null
      write(warn(`\n  could not run ${AdapterClass.cli}: ${error.message}\n`))
      resolve(false)
    })
    child.on('close', async (code) => {
      state.child = null
      // Flush the unterminated tail through the same normalizer.
      if (tail.trim()) {
        for (const event of adapter.normalizeLine(tail, state) || []) {
          if (event.type === 'meta' && event.sessionId) state.agentSession = event.sessionId
          else if (event.providerSessionId) state.agentSession = event.providerSessionId
          else if (event.type === 'message' && event.text) write(`${event.text}\n`)
        }
      }
      if (wroteSinceBreak) write('\n')
      if (code === 0) {
        state.fresh = false
        // CLIs that never print a session id (devin) get one targeted resume
        // anyway: the adapter locates the just-created conversation.
        if (!state.agentSession && adapter.captureSessionId) {
          try { state.agentSession = (await adapter.captureSessionId({ cwd: state.cwd })) || null } catch { void 0 }
        }
        resolve(true); return
      }
      // A resume that failed (stale/expired session file) is retried once as
      // a fresh turn — the user sees one clean answer either way.
      if (!state.fresh && !state.cancelled) {
        state.fresh = true
        state.agentSession = null
        resolve(runAgentTurn(state, text))
        return
      }
      const detail = stripAnsi(stderr).trim().split('\n').filter(Boolean).slice(-2).join(' ')
      if (detail) write(warn(`  ${AdapterClass.label} exited (${code}): ${detail.slice(0, 300)}\n`))
      resolve(false)
    })
  })
}

// --- small formatting helpers ----------------------------------------------

function fmtAge(ts) {
  const secs = Math.max(0, Math.round((Date.now() - ts) / 1000))
  if (secs < 60) return `${secs}s`
  if (secs < 3600) return `${Math.round(secs / 60)}m`
  return `${Math.round(secs / 3600)}h`
}

function table(rows) {
  if (!rows.length) return ''
  const widths = rows[0].map((_, i) => Math.max(...rows.map((row) => stripAnsi(String(row[i] ?? '')).length)))
  return rows.map((row) => '  ' + row.map((cell, i) => String(cell ?? '').padEnd(widths[i])).join('  ').trimEnd()).join('\n')
}

function sessionTag(s) {
  const bits = [s.sessionId, s.agent, s.status]
  if (s.team) bits.unshift(`team:${s.team}`)
  return bits.join(' · ')
}

// Session lookups shared by the interactive shell and the non-interactive
// `harpy team` subcommands — they take the link explicitly so both callers
// can reuse them.
async function linkSessions(link) {
  return (await link.call('agent', 'sessions', {})) || []
}

async function linkFindSession(link, ref) {
  const all = await linkSessions(link)
  return all.find((s) => s.sessionId === ref)
    || all.find((s) => String(s.index) === String(ref).replace(/^s_/, ''))
    || all.find((s) => s.team === ref)
    || null
}

async function linkTeamSessions(link, name) {
  return (await linkSessions(link)).filter((s) => s.team === name)
}

// Session picker used by /peek /join /stop /say /team rm when no id is given —
// arrow keys over live sessions instead of memorizing s_N ids.
async function linkPickSession(link, title, filter = () => true) {
  const all = (await linkSessions(link)).filter(filter)
  if (!all.length) return null
  const value = await choose(title, all.map((s) => ({
    value: s.sessionId,
    label: `${s.sessionId}  ${s.agent}${s.team ? ` · ${s.team}` : ''}`,
    hint: `${s.status} · ${fmtAge(s.startedAt)} ago${s.prompt ? ` · ${s.prompt.slice(0, 36)}` : ''}`
  })))
  if (!value || value === 'back') return null
  return all.find((s) => s.sessionId === value) || null
}

// Command palette entries — `args` flags commands that take arguments: the
// palette prefills `/name ` instead of running them blindly.
const PALETTE = [
  { name: 'agents', desc: 'list agent CLIs · /agents refresh re-probes' },
  { name: 'memory', desc: 'toggle persistent memory + digest' },
  { name: 'use', desc: 'pick the chat agent' },
  { name: 'new', desc: 'fresh conversation' },
  { name: 'cwd', args: true, desc: 'working directory' },
  { name: 'team', desc: 'bots — menu: add · ls · rm · down' },
  { name: 'say', desc: 'prompt a team or session' },
  { name: 'sessions', desc: 'all agent sessions' },
  { name: 'peek', desc: 'pick a session, tail its output' },
  { name: 'join', desc: 'pick a session, attach live' },
  { name: 'resume', desc: 'wake a sleeping session, attach' },
  { name: 'stop', desc: 'pick a session, stop it' },
  { name: 'status', desc: 'daemon & teams at a glance' },
  { name: 'daemon', args: true, desc: 'start|stop|restart|status' },
  { name: 'open', desc: 'web UI' },
  { name: 'update', desc: 'self-update' },
  { name: 'set', args: true, desc: 'cli settings' },
  { name: 'settings', desc: 'show settings' },
  { name: 'help', desc: 'all commands' },
  { name: 'exit', desc: 'leave the shell' },
  { name: 'quit', desc: 'leave the shell' }
]

// Codex-style session card — rounded frame, the harpy glyph (braille-
// rasterized from public/logo.svg) on the left, label: value rows on the
// right. Deliberately separate from cli-ui's box(): the dashboard keeps the
// angular frame, the shell gets the agent-terminal look.
const HARPY_MARK = [
  '⣿⢦⣄',
  '⡙⢦⣈⠛⢦⣄    ⣀⣀⣀⣀⣀',
  '⢻⡗⠮⣝⡲⢬⣙⠦⣄⣠⠞⠃ ⣠⠼⢷',
  ' ⠙⠓⠦⠭⣝⣛⠆⠈⠙⣆⢀⡾⠁',
  '  ⠈⠉⠛⠓⢲⡄⢀⣰⠿⠋',
  '    ⣠⡾⠿⠚⠋⠁'
]
const MARK_W = Math.max(...HARPY_MARK.map((l) => l.length))

function sessionCard(state, link, port) {
  // eslint-disable-next-line no-control-regex -- stripping ANSI escapes is the point
  const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '')
  const width = Math.min(76, Math.max(64, MARK_W + state.cwd.length + 16))
  const colW = width - MARK_W - 6 // right column: ' ' + cell + trailing space
  const row = (mark, cellText) =>
    `  │ ${c.accent(mark.padEnd(MARK_W))}  ${cellText}${' '.repeat(Math.max(0, colW + 2 - strip(cellText).length))} │`
  const info = (label, value, hint = '') => {
    const maxV = colW - 9 - (hint ? hint.length + 2 : 0)
    const v = value.length > maxV ? `…${value.slice(-Math.max(1, maxV - 1))}` : value
    return ` ${dim(label.padEnd(7))} ${label === 'cwd' ? dim(v) : v}${hint ? `  ${dim(hint)}` : ''}`
  }
  const title = '›_ Harpy Team'
  const titlePad = ' '.repeat(Math.max(1, colW - title.length - `v${VERSION}`.length - 2))
  const right = [
    ` ${c.accent(c.bold(title))}${titlePad} ${dim(`v${VERSION}`)}`,
    '',
    info('agent', state.agent || 'none', '/use to switch'),
    info('cwd', state.cwd),
    info('daemon', link.ws ? `:${port} connected` : 'offline', link.ws ? '' : '/daemon start'),
    ''
  ]
  const foot = ' / commands · tab agents · /exit quits'
  return [
    '',
    `  ╭${'─'.repeat(width)}╮`,
    ...right.map((cellText, i) => row(HARPY_MARK[i] || '', cellText)),
    `  │${' '.repeat(width)}│`,
    `  │${dim(foot)}${' '.repeat(Math.max(0, width - foot.length - 1))} │`,
    `  ╰${'─'.repeat(width)}╯`,
    ''
  ]
}

// --- the shell --------------------------------------------------------------

export async function chatShell({ agent, prompt, cwd } = {}) {
  const { registerAllAdapters } = await import('./agents/adapters/index.js')
  registerAllAdapters()
  const { getAdapter, listAgents } = await import('./agents/adapter.js')
  const listed = await listAgents()

  const state = {
    adapters: new Map(),
    listed,
    agent: '',
    fresh: true,
    agentSession: null,
    cwd: cwd ? path.resolve(cwd) : process.cwd(),
    child: null,
    cancelled: false,
    link: null,
    busy: false
  }
  for (const a of listed) {
    const AdapterClass = getAdapter(a.id)
    if (AdapterClass) state.adapters.set(a.id, AdapterClass)
  }

  const pickDefault = () => {
    if (agent && state.adapters.has(agent)) return agent
    const saved = readCliConfig().agent
    if (saved && state.adapters.has(saved) && listed.find((a) => a.id === saved)?.available) return saved
    return listed.find((a) => a.available)?.id || ''
  }
  state.agent = pickDefault()

  const port = resolvePort() || config.port
  const link = new DaemonLink(port)
  const daemonUp = async () => {
    try { await link.connect(); return true }
    catch { return false }
  }
  await daemonUp()

  // One-shot: `harpy chat "..."` / `--once` — a single turn, no REPL.
  if (prompt) {
    if (!state.agent) { console.error('no agent CLI found — see /agents inside `harpy`'); process.exitCode = 1; return }
    const done = await runAgentTurn(state, prompt)
    link.close()
    process.exitCode = done ? 0 : 1
    return
  }

  if (!process.stdin.isTTY) { console.error('harpy shell needs a terminal — use `harpy chat "prompt"` for one-shot turns'); process.exitCode = 1; return }

  for (const line of sessionCard(state, link, port)) console.log(line)

  // The rl instance is rebuilt after /join (raw-mode passthrough fights
  // readline's own keypress handling) — `rebuilding` keeps close from
  // tearing the shell down with it.
  let rl = null
  let rebuilding = false
  let rebuiltThisTurn = false
  let shellDone = null
  const shellClosed = new Promise((resolve) => { shellDone = resolve })

  const setPrompt = () => rl?.setPrompt(`${state.agent || 'harpy'} › `)

  const sessions = () => linkSessions(link)
  const findSession = (ref) => linkFindSession(link, ref)
  const teamSessions = (name) => linkTeamSessions(link, name)

  // --- live statusline + prompt framing ------------------------------------
  // One reserved row sits directly above the input line: daemon sessions are
  // polled every ~2.5s and the row is rewritten in place (cursor save → up →
  // clear → restore). Working sessions get animated spinner dots, idle ones a
  // solid dot, sleeping a hollow one — the fleet is always visible in-context,
  // like claude code's task strip. `promptVisible` guards every in-place
  // write so nothing lands mid-typed-input while a command runs.
  const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
  let spinTick = 0
  let promptVisible = false
  let daemonSessions = []
  const spinChar = () => SPINNER[spinTick % SPINNER.length]
  const trunc = (s, n) => (s && s.length > n ? `${s.slice(0, n - 1)}…` : (s || ''))

  const statusLine = () => {
    const now = Date.now()
    const running = daemonSessions.filter((s) => s.status === 'running')
    const working = running.filter((s) => now - (s.lastActivityAt || s.startedAt || 0) < 10_000)
    const sleeping = daemonSessions.filter((s) => s.status === 'sleeping')
    const segs = []
    for (const s of working.slice(0, 2)) {
      segs.push(`${ok(spinChar())} ${s.sessionId} ${s.agent}${s.prompt ? ` ${dim(`— ${trunc(s.prompt, 26)}`)}` : ''}`)
    }
    const idle = running.length - working.length
    if (idle > 0) segs.push(`${ok('●')} ${idle} idle`)
    if (sleeping.length) segs.push(`${dim('○')} ${sleeping.length} sleeping`)
    if (!segs.length) segs.push(dim(`${state.agent || 'harpy'} · / commands · tab shows agents`))
    return `  ${segs.join(dim('  ·  '))}`
  }

  const drawStatus = () => {
    if (!promptVisible || paletteOpen || rebuilding) return
    process.stdout.write(`\x1b[s\x1b[1A\r\x1b[2K${statusLine()}\x1b[u`)
  }

  const showPrompt = () => {
    if (!rl) return
    process.stdout.write(`${statusLine()}\n`)
    promptVisible = true
    rl.prompt()
  }

  // Command/push output must never splice into a live input line — wipe the
  // prompt row, print, re-glue status + prompt below it so the stack is
  // always [output…][status][input]. _refreshLine is node's own prompt+line
  // re-render; it keeps whatever the user had typed.
  const print = (s) => {
    if (promptVisible && rl && !rebuilding && !paletteOpen) {
      process.stdout.write(`\r\x1b[2K${s}\n${statusLine()}\n`)
      rl._refreshLine?.()
    } else {
      process.stdout.write(`${s}\n`)
    }
  }
  const err = (s) => print(`  ${warn('!')} ${s}`)

  const pollSessions = async () => {
    if (!link.ws || rebuilding || paletteOpen) return
    try { daemonSessions = await linkSessions(link); drawStatus() } catch { void 0 }
  }
  const pollTimer = setInterval(pollSessions, 2_500)
  const tickTimer = setInterval(() => { spinTick++; drawStatus() }, 400)
  // First paint comes from the interval — an immediate call here would touch
  // paletteOpen/rebuilding before their `let`s initialize (TDZ).
  const firstPoll = setTimeout(pollSessions, 600)

  const commands = {
    async help() {
      print(table([
        [c.accent('chat'), ''],
        ['/agents', 'list agent CLIs — refresh re-probes'],
        ['/memory', 'toggle memory + digest (checkbox menu; on by default)'],
        ['/use', 'pick the chat agent — arrows, or /use <id>'],
        ['/new', 'start a fresh conversation (drops resume)'],
        ['/cwd [path]', 'show or change the working directory'],
        [c.accent('teams — bots running together in the daemon'), ''],
        ['/team', 'menu — add a bot (guided form) · list · remove · stop'],
        ['/team ls', 'list teams and their bots'],
        ['/team rm [id]', 'remove one bot — no id picks from the list'],
        ['/team down [name]', 'stop every bot in a team'],
        ['/say', 'pick a team or session, type the prompt'],
        ['/sessions', 'fleet grouped by working · idle · sleeping'],
        ['/peek [id] [n]', 'pick a session, read its last n lines'],
        ['/join [id]', 'pick a session, attach live (Ctrl-] leaves)'],
        ['/resume [id]', 'wake a sleeping session and attach'],
        ['/stop [id]', 'pick a session, stop it'],
        [c.accent('system'), ''],
        ['/status', 'daemon, agents and teams at a glance'],
        ['/daemon start|stop|restart', 'manage the background server'],
        ['/open', 'open the web UI'],
        ['/update', 'self-update harpy'],
        ['/set <key> <value>', 'settings: port, workspace, agent, lang'],
        ['/settings', 'show cli settings'],
        ['/quit · /exit', 'leave the shell']
      ]))
    },

    async memory(rest) {
      if (!(await daemonUp())) return err(`daemon offline — /daemon start`)
      const arg = String(rest).trim().toLowerCase()
      const report = (prefs) => print(`  ${dim('memory')} ${prefs.memory ? ok('on') : warn('off')} ${dim('· digest')} ${prefs.digest ? ok('on') : warn('off')}${!prefs.memory ? ` ${dim('— .harpy/ wiped from reachable workspaces')}` : ''}`)
      if (arg === 'on' || arg === 'off' || arg === 'digest on' || arg === 'digest off') {
        const [key, value] = arg.startsWith('digest') ? ['digest', arg.endsWith('on')] : ['memory', arg === 'on']
        const prefs = await link.call('agent', 'saveMemoryPrefs', { [key]: value })
        print(`  ${ok('✓')} ${key === 'memory' ? 'persistent memory' : 'memory digest'} ${value ? 'on' : 'off'}${key === 'memory' && !value ? ` — ${dim('.harpy/ wiped from reachable workspaces')}` : ''}`)
        if (key === 'memory' && !value && prefs.digest) print(`  ${dim('digest stays on — it only runs when memory is on anyway')}`)
        return
      }
      if (arg) return err('usage: /memory [on|off|digest on|digest off]')
      const prefs = await link.call('agent', 'memoryPrefs', {})
      if (!process.stdin.isTTY) return report(prefs)
      // Checkbox menu — space flips, esc settles. Nothing to memorize.
      const items = [
        { label: 'persistent memory', hint: '.harpy/MEMORY.md · AGENTS.md pointer · handoffs · launch hint', on: prefs.memory },
        { label: 'memory digest', hint: 'session-end run distills durable facts into MEMORY.md', on: prefs.digest }
      ]
      await toggleMenu('memory', items, async (i) => {
        const key = i === 0 ? 'memory' : 'digest'
        const saved = await link.call('agent', 'saveMemoryPrefs', { [key]: !items[i].on })
        return saved[key]
      })
      report(await link.call('agent', 'memoryPrefs', {}))
    },

    async agents(rest) {
      // The availability cache lives 24h — a CLI installed after the first
      // probe reads as missing until `refresh` re-scans the PATH.
      if (String(rest).trim() === 'refresh') {
        state.listed = await listAgents({ refresh: true })
        print(`  ${ok('✓')} re-probed agent CLIs`)
      }
      const rows = state.listed.map((a) => [
        a.id === state.agent ? c.ok(`● ${a.id}`) : `  ${a.id}`,
        a.label,
        a.available ? ok('installed') : dim('missing'),
        a.available ? '' : dim(a.install?.command || '')
      ])
      print(table(rows))
    },

    async use(rest) {
      let id = String(rest).trim()
      if (!id) {
        // Radio list — the current agent carries the filled dot.
        const picked = await choose('chat with', state.listed.map((a) => ({
          value: a.id,
          label: `${a.id === state.agent ? '●' : '○'} ${a.id}`,
          hint: a.available ? 'installed' : dim(`missing — ${a.install?.command || 'install first'}`)
        })), { defaultValue: state.agent })
        if (!picked || picked === 'back') return
        id = picked
      }
      if (!state.adapters.has(id)) return err(`unknown agent '${id}' — /agents`)
      state.agent = id
      state.fresh = true
      state.agentSession = null
      writeCliConfig({ agent: id })
      setPrompt()
      print(`  ${ok('✓')} chatting with ${c.accent(id)} — ${state.listed.find((a) => a.id === id)?.available ? '' : warn('not installed yet, /agents shows the installer')}`)
    },

    async new() { state.fresh = true; state.agentSession = null; print(`  ${dim('next message starts a fresh conversation')}`) },

    async cwd(rest) {
      const target = String(rest).trim()
      if (!target) return print(`  ${state.cwd}`)
      const resolved = path.resolve(state.cwd, target)
      if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) return err('not a folder')
      state.cwd = resolved
      state.fresh = true
      state.agentSession = null
      print(`  ${ok('✓')} ${resolved}`)
    },

    async team(rest) {
      if (!(await daemonUp())) return err(`daemon offline — /daemon start`)
      const [sub, ...parts] = String(rest).trim().split(/\s+/)
      const teamList = async () => {
        const all = await sessions()
        const teams = new Map()
        for (const s of all) {
          if (!s.team) continue
          if (!teams.has(s.team)) teams.set(s.team, [])
          teams.get(s.team).push(s)
        }
        if (!teams.size) return print(`  ${dim('no bots yet — /team walks you through adding one')}`)
        for (const [name, members] of teams) {
          print(`  ${c.accent(name)}`)
          for (const s of members) print(`    ${sessionTag(s)} ${dim(`· ${fmtAge(s.startedAt)} ago`)}`)
        }
      }
      // Bare /team opens an action menu — add a bot (guided form), list, or
      // remove/stop via pickers. `default` is the standing team name so casual
      // users never manage namespaces. /team add skips the menu entirely.
      if (sub === 'add') return teamWizard()
      if (!sub) {
        const all = await sessions()
        if (!all.length) return teamWizard()
        await teamList()
        const action = await choose('team', [
          { value: 'add', label: '＋ add a bot', hint: 'guided form — name · agent · task' },
          { value: 'rm', label: '✕ remove a bot', hint: 'pick from the list' },
          { value: 'down', label: '■ stop a team', hint: 'kills every bot in it' },
          { value: 'ls', label: '≡ list teams', hint: '' }
        ])
        if (!action || action === 'back') return
        if (action === 'add') return teamWizard()
        if (action === 'ls') return
        if (action === 'rm') {
          const bot = await linkPickSession(link, 'remove which bot', (s) => Boolean(s.team))
          if (!bot) return print(`  ${dim('no team bots — /team adds one')}`)
          await link.call('agent', 'stop', { sessionId: bot.sessionId })
          return print(`  ${ok('✓')} ${bot.sessionId} removed`)
        }
        if (action === 'down') {
          const names = [...new Set(all.map((s) => s.team).filter(Boolean))]
          const name = await choose('stop which team', names.map((t) => ({ value: t, label: t, hint: `${all.filter((s) => s.team === t).length} bots` })))
          if (!name || name === 'back') return
          const members = await teamSessions(name)
          let stopped = 0
          for (const s of members) {
            if (s.status === 'stopped') continue
            try { await link.call('agent', 'stop', { sessionId: s.sessionId }); stopped++ } catch { void 0 }
          }
          return print(`  ${ok('✓')} team '${name}' — ${stopped} stopped`)
        }
        return
      }
      if (sub === 'ls' || sub === 'list') return teamList()
      if (sub === 'rm' || sub === 'remove') {
        const ref = parts.join(' ')
        const session = ref ? await findSession(ref) : await linkPickSession(link, 'remove which bot', (s) => Boolean(s.team))
        if (!session) return ref ? err(`no session '${ref}' — /sessions`) : print(`  ${dim('no team bots')}`)
        await link.call('agent', 'stop', { sessionId: session.sessionId })
        print(`  ${ok('✓')} ${session.sessionId} removed`)
        return
      }
      if (sub === 'up') {
        const [name, agentId, ...promptParts] = parts
        if (!name || !agentId) return err('usage: /team up <name> <agent> [prompt]')
        if (!state.adapters.has(agentId)) return err(`unknown agent '${agentId}' — /agents`)
        if (!state.listed.find((a) => a.id === agentId)?.available) return err(`${agentId} is not installed — /agents refresh if you just installed it`)
        const promptText = promptParts.join(' ')
        // No workspace field — the daemon resolves its active project root.
        // (An explicit path would 403 unless it is already a registered
        // workspace; team sessions live where the daemon points.)
        const session = await link.call('agent', 'start', { agent: agentId, team: name, prompt: promptText })
        print(`  ${ok('✓')} ${sessionTag(session)} — /say ${session.sessionId} <text> · /peek ${session.sessionId} · /join ${session.sessionId}`)
        return
      }
      if (sub === 'down') {
        let [name] = parts
        if (!name) {
          const all = await sessions()
          const names = [...new Set(all.map((s) => s.team).filter(Boolean))]
          const picked = await choose('stop which team', names.map((t) => ({ value: t, label: t, hint: `${all.filter((s) => s.team === t).length} bots` })))
          if (!picked || picked === 'back') return
          name = picked
        }
        const members = await teamSessions(name)
        if (!members.length) return err(`no team '${name}'`)
        let stopped = 0
        for (const s of members) {
          if (s.status === 'stopped') continue
          try { await link.call('agent', 'stop', { sessionId: s.sessionId }); stopped++ } catch { void 0 }
        }
        print(`  ${ok('✓')} team '${name}' — ${stopped} stopped`)
        return
      }
      return err('usage: /team [add | ls | up <name> <agent> [prompt] | rm <id> | down <name>]')
    },

    async say(rest) {
      if (!(await daemonUp())) return err(`daemon offline — /daemon start`)
      const [ref, ...textParts] = String(rest).trim().split(/\s+/)
      const text = textParts.join(' ')
      if (!ref) {
        // Pick a target — teams broadcast, sessions get a direct message.
        const all = await sessions()
        if (!all.length) return print(`  ${dim('no sessions — /team adds bots')}`)
        const teamNames = [...new Set(all.map((s) => s.team).filter(Boolean))]
        const picked = await choose('say to', [
          ...teamNames.map((t) => ({ value: `team:${t}`, label: `▣ ${t}`, hint: `team · ${all.filter((s) => s.team === t).length} bots` })),
          ...all.map((s) => ({ value: s.sessionId, label: `${s.sessionId}  ${s.agent}${s.team ? ` · ${s.team}` : ''}`, hint: `${s.status} · ${fmtAge(s.startedAt)} ago` }))
        ])
        if (!picked || picked === 'back') return
        const target = picked.startsWith('team:') ? picked.slice(5) : picked
        const message = await ask('message')
        if (!message) return
        if (picked.startsWith('team:')) {
          const live = all.filter((s) => s.team === target && s.status === 'running').map((s) => s.sessionId)
          if (!live.length) return err(`team '${target}' has no running sessions`)
          const result = await link.call('agent', 'broadcast', { sessionIds: live, text: message })
          const okCount = (result.results || []).filter((r) => r.ok).length
          print(`  ${ok('✓')} sent to ${okCount}/${live.length} in '${target}'`)
        } else {
          await link.call('agent', 'send', { sessionId: target, text: message })
          print(`  ${ok('✓')} sent to ${target}`)
        }
        return
      }
      if (!text) return err('usage: /say <team|sessionId> <text>')
      const members = await teamSessions(ref)
      if (members.length) {
        const live = members.filter((s) => s.status === 'running').map((s) => s.sessionId)
        if (!live.length) return err(`team '${ref}' has no running sessions`)
        const result = await link.call('agent', 'broadcast', { sessionIds: live, text })
        const okCount = (result.results || []).filter((r) => r.ok).length
        print(`  ${ok('✓')} sent to ${okCount}/${live.length} in '${ref}'`)
        return
      }
      const session = await findSession(ref)
      if (!session) return err(`no session or team '${ref}'`)
      await link.call('agent', 'send', { sessionId: session.sessionId, text })
      print(`  ${ok('✓')} sent to ${session.sessionId}`)
    },

    async sessions() {
      if (!(await daemonUp())) return err(`daemon offline — /daemon start`)
      const all = await sessions()
      if (!all.length) return print(`  ${dim('no agent sessions — /team adds a bot')}`)
      const now = Date.now()
      const groups = [
        ['working', (s) => s.status === 'running' && now - (s.lastActivityAt || s.startedAt || 0) < 10_000],
        ['idle', (s) => s.status === 'running' && now - (s.lastActivityAt || s.startedAt || 0) >= 10_000],
        ['sleeping', (s) => s.status === 'sleeping'],
        ['stopped', (s) => s.status === 'stopped']
      ]
      for (const [label, match] of groups) {
        const rows = all.filter(match)
        if (!rows.length) continue
        print(`  ${c.accent(label)}`)
        for (const s of rows) {
          const purpose = s.prompt ? ` ${dim(`— ${trunc(s.prompt, 34)}`)}` : ''
          const note = s.status === 'sleeping' ? ` ${dim('· /resume wakes')}` : ''
          print(`    ${s.sessionId.padEnd(7)} ${s.agent.padEnd(8)} ${(s.team || '—').padEnd(9)}${purpose}${note} ${dim(fmtAge(s.startedAt))}`)
        }
      }
    },

    async resume(rest) {
      if (!(await daemonUp())) return err(`daemon offline — /daemon start`)
      const ref = String(rest).trim()
      const session = ref ? await findSession(ref) : await linkPickSession(link, 'resume which', (s) => s.status === 'sleeping')
      if (!session) return print(`  ${dim(ref ? `no session '${ref}'` : 'no sessions')}`)
      if (session.status === 'sleeping') {
        try { await link.call('agent', 'wake', { sessionId: session.sessionId }); print(`  ${ok('✓')} woke ${session.sessionId}`) }
        catch (e) { return err(e.message) }
      }
      return commands.join(session.sessionId)
    },

    async peek(rest) {
      if (!(await daemonUp())) return err(`daemon offline — /daemon start`)
      const [ref, count] = String(rest).trim().split(/\s+/)
      let session
      if (!ref) {
        session = await linkPickSession(link, 'peek which')
        if (!session) return print(`  ${dim('no sessions — /team adds bots')}`)
      } else {
        session = await findSession(ref)
      }
      if (!session) return err(`no session or team '${ref}'`)
      const n = Math.min(Math.max(Number(count) || 30, 1), 300)
      const history = await link.call('agent', 'history', { sessionId: session.sessionId })
      const text = (history?.events || history || [])
        .filter((e) => e.type === 'data' && e.data)
        .map((e) => e.data).join('')
      const lines = stripAnsi(text).split('\n').map((l) => l.trimEnd()).filter((l) => l.trim())
      for (const line of lines.slice(-n)) print(`  ${line}`)
      if (!lines.length) print(`  ${dim('(no output yet)')}`)
    },

    async join(rest) {
      if (!(await daemonUp())) return err(`daemon offline — /daemon start`)
      const ref = String(rest).trim()
      let session
      if (!ref) {
        session = await linkPickSession(link, 'join which', (s) => s.status === 'running')
        if (!session) return print(`  ${dim('no running sessions — /team adds bots')}`)
      } else {
        session = await findSession(ref)
      }
      if (!session) return err(`no session or team '${ref}'`)
      print(`  ${dim(`attached to ${session.sessionId} — Ctrl-] detaches, output is the live terminal`)}`)
      // Hand stdin raw to the session PTY: closing rl detaches its keypress
      // plumbing so keystrokes go only where they should.
      rebuilding = true
      rl.close()
      const onPush = (ch, ev, data) => {
        if (ch === 'agent' && ev === 'session' && data?.sessionId === session.sessionId && data.type === 'data') {
          process.stdout.write(data.data)
        }
      }
      link.push = onPush
      try { await link.call('agent', 'watch', { sessionId: session.sessionId }) } catch { void 0 }
      const stdin = process.stdin
      stdin.setRawMode?.(true)
      stdin.resume()
      await new Promise((resolve) => {
        const onData = (buf) => {
          if ([...buf].includes(0x1d)) { stdin.off('data', onData); resolve(); return } // Ctrl-]
          link.call('agent', 'input', { sessionId: session.sessionId, data: buf.toString('utf8') }).catch(() => {})
        }
        stdin.on('data', onData)
      })
      stdin.setRawMode?.(false)
      link.push = null
      try { await link.call('agent', 'unwatch', { sessionId: session.sessionId }) } catch { void 0 }
      print(`\n  ${dim('detached — session keeps running in the daemon')}`)
      rl = makeRl()
      showPrompt()
      rebuilding = false
      rebuiltThisTurn = true
    },

    async stop(rest) {
      if (!(await daemonUp())) return err(`daemon offline — /daemon start`)
      const ref = String(rest).trim()
      const session = ref ? await findSession(ref) : await linkPickSession(link, 'stop which', (s) => s.status === 'running')
      if (!session) return ref ? err(`no session or team '${ref}'`) : print(`  ${dim('no running sessions')}`)
      await link.call('agent', 'stop', { sessionId: session.sessionId })
      print(`  ${ok('✓')} ${session.sessionId} stopped`)
    },

    async status() {
      const { daemonStatus, healthProbe } = await import('./daemon.js')
      const st = await daemonStatus({ port })
      const probe = await healthProbe(port)
      const all = link.ws ? await sessions().catch(() => []) : []
      const teams = new Map()
      for (const s of all) { if (s.team) teams.set(s.team, (teams.get(s.team) || 0) + 1) }
      print(table([
        ['daemon', st.running ? ok(`running · pid ${st.pid}`) : warn('stopped'), st.listening ? ok(`listening :${st.port}`) : dim('not listening')],
        ['version', VERSION, probe.harpy ? dim(`v${probe.version} on :${port}`) : ''],
        ['autostart', st.service?.enabled ? `${st.service.mode}` : 'disabled', ''],
        ['agents', `${state.listed.filter((a) => a.available).length}/${state.listed.length} installed`, state.listed.filter((a) => a.available).map((a) => a.id).join(' ')],
        ['teams', teams.size ? [...teams].map(([n, count]) => `${n}×${count}`).join('  ') : dim('none'), ''],
        ['shell agent', state.agent || dim('none — /use'), state.cwd]
      ]))
    },

    async daemon(rest) {
      const sub = String(rest).trim() || 'status'
      const { daemonStatus, startDaemon, stopDaemon } = await import('./daemon.js')
      if (sub === 'start' || sub === 'restart') {
        if (sub === 'restart') await stopDaemon()
        const result = await startDaemon({ port })
        print(`  ${result.listening ? ok('✓') : warn('!')} ${result.message}${result.pid ? ` · pid ${result.pid}` : ''}`)
        link.ws = null
        await daemonUp()
        return
      }
      if (sub === 'stop') {
        await stopDaemon()
        link.ws = null
        print(`  ${ok('✓')} daemon stopped — teams pause, local chat still works`)
        return
      }
      const st = await daemonStatus({ port })
      print(`  ${st.running ? ok('● running') : dim('○ stopped')} · port ${st.port}${st.pid ? ` · pid ${st.pid}` : ''}`)
    },

    async open() {
      const local = `http://localhost:${port}`
      const { shareStatus } = await import('./share.js')
      const share = shareStatus()
      print(`  ${dim('local')}    ${c.cyan(local)}`)
      if (share.url) print(`  ${dim('public')}   ${c.cyan(share.url)}`)
      // Headless shells (VPS over ssh) have nowhere to open — the links
      // above are the point; only launch a browser when one can exist.
      if (!canOpenBrowser()) return print(`  ${dim('no browser on this machine — copy a link')}`)
      const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open'
      const args = process.platform === 'win32' ? ['/c', 'start', '', local] : [local]
      try { spawn(opener, args, { detached: true, stdio: 'ignore' }).unref() } catch { void 0 }
    },

    async update() {
      const { checkForUpdate, applyUpdate } = await import('./update.js')
      const info = await checkForUpdate()
      if (!info.updateAvailable) { print(`  ${ok('✓')} already on ${info.current}`); return }
      print(`  ${c.accent('→')} v${info.latest} — updating (daemon restarts, this shell survives)`)
      rl.pause()
      try {
        const result = await applyUpdate({ restartDaemon: true })
        print(`  ${ok('✓')} ${result.steps.join(', ')}`)
        link.ws = null
        await daemonUp()
      } catch (error) { err(error.message) }
      rl.resume()
      showPrompt()
    },

    async settings() {
      const cfg = readCliConfig()
      const rows = Object.entries(cfg).map(([k, v]) => [k, String(v)])
      print(rows.length ? table(rows) : `  ${dim('no overrides — defaults in effect')}`)
    },

    async set(rest) {
      const [key, ...valueParts] = String(rest).trim().split(/\s+/)
      const value = valueParts.join(' ')
      if (!key || !value) return err('usage: /set <port|workspace|agent|lang> <value>')
      const allowed = ['port', 'workspace', 'agent', 'lang', 'autostart']
      if (!allowed.includes(key)) return err(`known keys: ${allowed.join(', ')}`)
      writeCliConfig({ [key]: key === 'port' ? Number(value) : value })
      if (key === 'agent' && state.adapters.has(value)) { state.agent = value; state.fresh = true; state.agentSession = null; setPrompt() }
      print(`  ${ok('✓')} ${key} = ${value}`)
    }
  }
  commands.exit = () => 'quit'
  commands.quit = () => 'quit'

  const onLine = async (line) => {
    // Strip stray control bytes a lone ESC/Tab may leave in the buffer —
    // otherwise "\x1b/exit" reaches the agent instead of the command router.
    // eslint-disable-next-line no-control-regex
    const text = line.replace(/^[\x00-\x1f\x7f]+/, '').trim()
    promptVisible = false // Enter consumed the row — status/prompt re-glue at the end
    if (!text) { showPrompt(); return }
    try {
      if (text.startsWith('/')) {
        const [name, ...rest] = text.slice(1).split(/\s+/)
        const command = commands[name]
        const out = command ? await command.call(commands, rest.join(' ')) : err(`unknown command /${name} — /help`)
        if (out === 'quit') { markQuit(); rl.close(); return }
      } else {
        if (state.busy) print(`  ${dim('agent is still working — Ctrl-C cancels the turn')}`)
        else {
          state.busy = true
          state.cancelled = false
          // "thinking…" spinner — a one-line braille indicator that rewrites
          // itself in place until the agent's first output arrives (write()
          // above erases the row), devin/claude-code style.
          state.wroteOutput = false
          const startedAt = Date.now()
          const spinner = setInterval(() => {
            if (state.wroteOutput || !state.busy) return
            const el = Math.floor((Date.now() - startedAt) / 1000)
            process.stdout.write(`\r\x1b[2K  ${c.accent(spinChar())} ${state.agent} ${dim(`thinking…${el ? ` ${el}s ·` : ''} ctrl-c cancels`)}`)
          }, 120)
          try { await runAgentTurn(state, text) } catch (error) { err(error.message || String(error)) }
          clearInterval(spinner)
          process.stdout.write('\r\x1b[2K')
          state.busy = false
        }
      }
    } catch (error) {
      err(error.message || String(error))
    }
    // /join rebuilt rl mid-command — it already prompted.
    if (rebuiltThisTurn) { rebuiltThisTurn = false; return }
    try { showPrompt() } catch { void 0 }
  }

  // readline emits 'line' synchronously for buffered (piped) input — a
  // manual queue keeps commands strictly sequential so output never
  // interleaves.
  const lineQueue = []
  let draining = false
  let quitSeen = false
  const enqueue = (line) => {
    if (quitSeen) return
    lineQueue.push(line)
    void drain()
  }
  async function drain() {
    if (draining) return
    draining = true
    while (lineQueue.length) {
      await onLine(lineQueue.shift())
      if (quitSeen) break
    }
    draining = false
  }
  // Detect quit inside onLine via rl close — the drain loop then stops.
  const markQuit = () => { quitSeen = true }

  // `/` on an empty prompt opens the command palette — a raw-mode overlay
  // that filters as you type. Enter runs the pick straight away; commands
  // that take args instead prefill the prompt (`/team ` stays editable).
  // Esc cancels. rl is closed for the duration — same trick /join uses.
  let paletteOpen = false
  async function openPalette() {
    paletteOpen = true
    rebuilding = true
    promptVisible = false
    const old = rl
    rl = null
    old.close()
    const stdin = process.stdin
    const out = process.stdout
    stdin.setRawMode(true)
    stdin.resume()
    let filter = ''
    let sel = 0
    let shown = 0
    let list = []
    const draw = () => {
      if (shown) out.write(`\x1b[${shown}A\x1b[0J`) // back to row 1, wipe block
      list = PALETTE.filter((p) => p.name.startsWith(filter))
      if (sel >= list.length) sel = Math.max(0, list.length - 1)
      // Show every entry the screen can hold — a hard 9-row crop used to hide
      // half the commands. The window follows the selection when the list is
      // taller than the terminal.
      const maxRows = Math.max(5, (out.rows || 24) - 6)
      const top = Math.min(Math.max(0, sel - maxRows + 1), Math.max(0, list.length - maxRows))
      const lines = [`  ${c.accent('›')} /${filter}`, '']
      for (const [row, p] of list.slice(top, top + maxRows).entries()) {
        const i = top + row
        const line = `/${p.name}${p.args ? ' …' : ''} ${dim(p.desc)}`
        lines.push(i === sel ? `    ${c.accent('›')} ${c.bold(line)}` : `      ${line}`)
      }
      if (top + maxRows < list.length) lines.push(`      ${dim(`… ${list.length - top - maxRows} more below ↓`)}`)
      if (!list.length) lines.push(`      ${dim('no match')}`)
      out.write(lines.join('\n') + '\n')
      shown = lines.length
    }
    out.write('\x1b[1A\r\x1b[0J') // erase the status row + the `agent › /` prompt line
    draw()
    const picked = await new Promise((resolve) => {
      const done = (v) => { stdin.removeListener('keypress', onKey); resolve(v) }
      const onKey = (ch, key = {}) => {
        if (key.name === 'return') return done(list[sel] || null)
        if (key.name === 'escape' || (key.ctrl && key.name === 'c')) return done(null)
        if (key.name === 'up') sel = Math.max(0, sel - 1)
        else if (key.name === 'down') sel = Math.min(Math.max(0, list.length - 1), sel + 1)
        else if (key.name === 'backspace') { filter = filter.slice(0, -1); sel = 0 }
        else if (ch && ch.length === 1 && /[a-z0-9_-]/i.test(ch) && !key.ctrl && !key.meta) { filter += ch; sel = 0 }
        else return
        draw()
      }
      stdin.on('keypress', onKey)
    })
    stdin.setRawMode(false)
    out.write(`\x1b[${shown}A\x1b[0J`) // erase the palette block
    rl = makeRl()
    showPrompt()
    rebuilding = false
    paletteOpen = false
    if (!picked) return
    if (picked.args) rl.write(`/${picked.name} `)
    else enqueue(`/${picked.name}`)
  }

  // Tab on an empty prompt — claude-code-style fleet overlay. A live, raw-mode
  // table of every agent session: animated dot on working sessions, solid on
  // idle, hollow on sleeping, each with its purpose. Enter attaches (waking a
  // sleeper first), w wakes in place, r removes, esc backs out. The overlay
  // redraws on a poll so states move without touching the transcript.
  let fleetOpen = false
  async function openFleet() {
    fleetOpen = true
    rebuilding = true
    promptVisible = false
    const old = rl
    rl = null
    old.close()
    const stdin = process.stdin
    const out = process.stdout
    stdin.setRawMode(true)
    stdin.resume()
    let list = []
    let sel = 0
    let shown = 0
    const draw = () => {
      if (shown) out.write(`\x1b[${shown}A\x1b[0J`)
      const now = Date.now()
      const running = list.filter((s) => s.status === 'running').length
      const sleeping = list.filter((s) => s.status === 'sleeping').length
      const lines = [`  ${c.bold('agents')} ${dim(`— ${running} running · ${sleeping} sleeping`)}`, '']
      for (const [i, s] of list.entries()) {
        const working = s.status === 'running' && now - (s.lastActivityAt || s.startedAt || 0) < 10_000
        const mark = s.status === 'sleeping' ? dim('○') : working ? ok(spinChar()) : s.status === 'stopped' ? dim('◌') : ok('●')
        const row = `${mark} ${s.sessionId}  ${s.agent}${s.team ? ` · ${s.team}` : ''}  ${s.status}${s.prompt ? `  ${dim(trunc(s.prompt, 34))}` : ''}  ${dim(fmtAge(s.startedAt))}`
        lines.push(i === sel ? `  ${c.accent('›')} ${c.bold(row)}` : `    ${row}`)
      }
      if (!list.length) lines.push(`    ${dim('no sessions yet — /team adds a bot')}`)
      lines.push('', `  ${dim('↑↓ select · enter attach · w wake · r remove · esc back')}`)
      out.write(lines.join('\n') + '\n')
      shown = lines.length
    }
    const refresh = async () => {
      try { list = await linkSessions(link); daemonSessions = list } catch { void 0 }
      if (sel >= list.length) sel = Math.max(0, list.length - 1)
      draw()
    }
    out.write('\x1b[1A\r\x1b[0J') // erase status + prompt rows, overlay takes over
    await refresh()
    const pollInt = setInterval(refresh, 2_000)
    const animInt = setInterval(() => { spinTick++; draw() }, 400)
    const action = await new Promise((resolve) => {
      const done = (v) => { stdin.removeListener('keypress', onKey); resolve(v) }
      const onKey = async (ch, key = {}) => {
        const selSession = list[sel]
        if (key.name === 'escape' || (key.ctrl && key.name === 'c')) return done(null)
        if (key.name === 'return' && selSession) return done(selSession)
        if (key.name === 'up') sel = Math.max(0, sel - 1)
        else if (key.name === 'down') sel = Math.min(Math.max(0, list.length - 1), sel + 1)
        else if ((ch === 'w' || ch === 'W') && selSession?.status === 'sleeping') {
          try { await link.call('agent', 'wake', { sessionId: selSession.sessionId }) } catch { void 0 }
          await refresh()
          return
        } else if ((ch === 'r' || ch === 'R') && selSession) {
          try { await link.call('agent', 'stop', { sessionId: selSession.sessionId }) } catch { void 0 }
          await refresh()
          return
        } else return
        draw()
      }
      stdin.on('keypress', onKey)
    })
    clearInterval(pollInt)
    clearInterval(animInt)
    stdin.setRawMode(false)
    out.write(`\x1b[${shown}A\x1b[0J`)
    rl = makeRl()
    showPrompt()
    rebuilding = false
    fleetOpen = false
    if (!action) return
    if (action.status === 'sleeping') enqueue(`/resume ${action.sessionId}`)
    else enqueue(`/join ${action.sessionId}`)
  }

  const onSigint = () => {
    if (state.child) {
      state.cancelled = true
      try { state.child.kill('SIGINT') } catch { void 0 }
      print(`\n  ${dim('turn cancelled')}`)
    } else {
      rl?.close()
    }
  }

  function makeRl() {
    const next = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: `${state.agent || 'harpy'} › `,
      historySize: 200,
      terminal: true
    })
    next.on('line', enqueue)
    next.on('SIGINT', onSigint)
    next.on('close', () => { if (!rebuilding) shellDone() })
    return next
  }

  // Guided "new bot" form — bare /team walks through it instead of making
  // anyone memorize `/team up <name> <agent> [prompt]`. The shell readline
  // is parked like openPalette does so ask()/choose() can own the terminal,
  // then control comes back. `default` is the standing team so casual use
  // never touches namespaces.
  async function teamWizard() {
    rebuilding = true
    const old = rl
    rl = null
    old.close()
    try {
      print('')
      const name = (await ask('team', 'default')) || 'default'
      const installed = state.listed.filter((a) => a.available && state.adapters.has(a.id))
      if (!installed.length) { print(`  ${warn('!')} no agent CLIs installed — /agents`); return }
      const agentId = await choose('pick a bot agent', installed.map((a) => ({ value: a.id, label: a.label || a.id })), { defaultValue: state.agent || installed[0].id })
      if (!agentId || agentId === 'back') { print(`  ${dim('cancelled')}`); return }
      const task = await ask('what should this bot do? (blank = just idle)')
      const session = await link.call('agent', 'start', { agent: agentId, team: name, prompt: task })
      print(`  ${ok('✓')} ${sessionTag(session)}`)
      print(`  ${dim(`/say ${name} <text> broadcasts · /peek ${session.sessionId} tails · /join ${session.sessionId} attaches · /team rm ${session.sessionId} removes`)}`)
    } catch (e) {
      print(`  ${warn('!')} ${e.message}`)
    } finally {
      rl = makeRl()
      showPrompt()
      rebuilding = false
    }
  }

  rl = makeRl()
  showPrompt()

  // '/' on an empty prompt opens the command palette. Punctuation arrives
  // with an undefined key.name — the character itself is the match. The
  // listener lives on stdin so it survives rl rebuilds after /join, and
  // setImmediate lets rl consume the keystroke first regardless of the
  // listener order a rebuilt rl leaves behind.
  process.stdin.on('keypress', (ch, key = {}) => {
    setImmediate(() => {
      // eslint-disable-next-line no-control-regex
      const clean = (s) => (s || '').replace(/^[\x00-\x1f\x7f]+/, '')
      // Tab on an empty prompt opens the live agent overlay — the fleet's
      // who/what/state strip claude-code-style, without touching the chat.
      if ((key.name === 'tab' || ch === '\t') && rl && !paletteOpen && !fleetOpen && !draining && !state.busy && clean(rl.line) === '') {
        return void openFleet()
      }
      // '/' on an empty prompt opens the command palette. Punctuation arrives
      // with an undefined key.name — the character itself is the match.
      if (ch === '/' && !key.ctrl && !key.meta && rl && !paletteOpen && !draining && clean(rl.line) === '/') void openPalette()
    })
  })

  await shellClosed
  clearInterval(pollTimer)
  clearInterval(tickTimer)
  clearTimeout(firstPoll)
  print(`  ${dim('bye')}`)
  link.close()
}

// --- non-interactive `harpy team …` -----------------------------------------
// The same ops the shell's /team commands use, as scriptable subcommands —
// this is the surface agent CLIs drive when the user asks a bot to add or
// remove teammates (see skills/harpy/SKILL.md, installed onto agent skill
// paths at daemon boot).
export async function teamCli(args, port) {
  // Callers (humans and agent bots alike) pipe this output — a closed pipe
  // must exit quietly, not dump an EPIPE stack.
  process.stdout.once('error', (e) => { if (e.code === 'EPIPE') process.exit(0); throw e })
  const print = (s) => process.stdout.write(`${s}\n`)
  const fail = (s) => { console.error(`harpy team: ${s}`); process.exitCode = 1 }
  // `harpy team ... --port N` — strip the flag before subcommand parsing.
  const pi = args.indexOf('--port')
  if (pi >= 0) { port = Number(args[pi + 1]) || port; args = args.filter((_, i) => i !== pi && i !== pi + 1) }
  const link = new DaemonLink(port)
  try { await link.connect() } catch {
    return fail(`daemon is not running on :${port} — start it with \`harpy daemon start\``)
  }
  try {
    const [sub, ...rest] = args
    if (!sub || sub === 'ls' || sub === 'list') {
      const all = await linkSessions(link)
      const teams = new Map()
      for (const s of all) { if (s.team) { if (!teams.has(s.team)) teams.set(s.team, []); teams.get(s.team).push(s) } }
      if (!teams.size) { print('no teams — add a bot: harpy team up default <agent> "<role>"'); return }
      for (const [name, members] of teams) {
        print(`${name}`)
        for (const s of members) print(`  ${sessionTag(s)} · ${fmtAge(s.startedAt)} ago`)
      }
      return
    }
    if (sub === 'sessions') {
      const all = await linkSessions(link)
      if (!all.length) { print('no sessions'); return }
      for (const s of all) print(sessionTag(s))
      return
    }
    if (sub === 'up' || sub === 'add') {
      const [name, agent, ...promptParts] = rest
      if (!name || !agent) return fail('usage: harpy team up <team> <agent> "<prompt>"')
      const session = await link.call('agent', 'start', { agent, team: name, prompt: promptParts.join(' ') })
      print(`${sessionTag(session)}`)
      return
    }
    if (sub === 'rm' || sub === 'remove' || sub === 'stop') {
      const ref = rest.join(' ')
      if (!ref) return fail('usage: harpy team rm <sessionId>')
      const session = await linkFindSession(link, ref)
      if (!session) return fail(`no session or team '${ref}' — see: harpy team sessions`)
      await link.call('agent', 'stop', { sessionId: session.sessionId })
      print(`${session.sessionId} stopped`)
      return
    }
    if (sub === 'down') {
      const name = rest.join(' ')
      if (!name) return fail('usage: harpy team down <team>')
      const members = await linkTeamSessions(link, name)
      if (!members.length) return fail(`no team '${name}' — see: harpy team ls`)
      let stopped = 0
      for (const s of members) {
        if (s.status === 'stopped') continue
        try { await link.call('agent', 'stop', { sessionId: s.sessionId }); stopped++ } catch { void 0 }
      }
      print(`team '${name}' — ${stopped} stopped`)
      return
    }
    if (sub === 'say') {
      const [ref, ...textParts] = rest
      const text = textParts.join(' ')
      if (!ref || !text) return fail('usage: harpy team say <team|sessionId> "<text>"')
      const members = await linkTeamSessions(link, ref)
      if (members.length) {
        const live = members.filter((s) => s.status === 'running').map((s) => s.sessionId)
        if (!live.length) return fail(`team '${ref}' has no running sessions`)
        const result = await link.call('agent', 'broadcast', { sessionIds: live, text })
        const okCount = (result.results || []).filter((r) => r.ok).length
        print(`sent to ${okCount}/${live.length} in '${ref}'`)
        return
      }
      const session = await linkFindSession(link, ref)
      if (!session) return fail(`no session or team '${ref}'`)
      await link.call('agent', 'send', { sessionId: session.sessionId, text })
      print(`sent to ${session.sessionId}`)
      return
    }
    fail(`unknown subcommand '${sub}' — try: ls | up | say | rm | down | sessions`)
  } catch (e) {
    fail(e.message)
  } finally {
    link.close()
  }
}
