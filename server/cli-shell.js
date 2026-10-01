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
import { box, c, canOpenBrowser } from './cli-ui.js'
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

class DaemonLink {
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
    const write = (chunk) => { process.stdout.write(chunk); wroteSinceBreak = true }
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
    child.on('close', (code) => {
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
      if (code === 0) { state.fresh = false; resolve(true); return }
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

// Command palette entries — `args` flags commands that take arguments: the
// palette prefills `/name ` instead of running them blindly.
const PALETTE = [
  { name: 'agents', desc: 'list installed agent CLIs' },
  { name: 'use', args: true, desc: 'switch the chat agent' },
  { name: 'new', desc: 'fresh conversation' },
  { name: 'cwd', args: true, desc: 'working directory' },
  { name: 'team', args: true, desc: 'teams — up <name> <agent> · down' },
  { name: 'say', args: true, desc: 'prompt a team or session' },
  { name: 'sessions', desc: 'all agent sessions' },
  { name: 'peek', args: true, desc: 'tail a session' },
  { name: 'join', args: true, desc: 'attach live — Ctrl-] leaves' },
  { name: 'stop', args: true, desc: 'stop a session' },
  { name: 'status', desc: 'daemon & teams at a glance' },
  { name: 'daemon', args: true, desc: 'start|stop|restart|status' },
  { name: 'open', desc: 'web UI' },
  { name: 'update', desc: 'self-update' },
  { name: 'set', args: true, desc: 'cli settings' },
  { name: 'settings', desc: 'show settings' },
  { name: 'help', desc: 'all commands' },
  { name: 'quit', desc: 'leave the shell' }
]

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

  console.log('')
  box(`harpy ${c.accent('v' + VERSION)}`, [
    `${c.dim('agent')}   ${state.agent ? c.ok(state.agent) : warn('none — pick one with /use')}`,
    `${c.dim('dir')}     ${state.cwd}`,
    `${c.dim('daemon')}  ${link.ws ? c.ok(`:${port} connected`) : warn(`offline — /daemon start`)}`,
    `${c.dim('help')}    /help for commands · /team for fleets · Ctrl-C cancels a turn`
  ])
  console.log('')

  // The rl instance is rebuilt after /join (raw-mode passthrough fights
  // readline's own keypress handling) — `rebuilding` keeps close from
  // tearing the shell down with it.
  let rl = null
  let rebuilding = false
  let rebuiltThisTurn = false
  let shellDone = null
  const shellClosed = new Promise((resolve) => { shellDone = resolve })

  const setPrompt = () => rl?.setPrompt(`${state.agent || 'harpy'} › `)

  async function sessions() {
    return (await link.call('agent', 'sessions', {})) || []
  }

  async function findSession(ref) {
    const all = await sessions()
    return all.find((s) => s.sessionId === ref)
      || all.find((s) => String(s.index) === String(ref).replace(/^s_/, ''))
      || all.find((s) => s.team === ref)
      || null
  }

  async function teamSessions(name) {
    return (await sessions()).filter((s) => s.team === name)
  }

  const print = (s) => { process.stdout.write(`${s}\n`) }
  const err = (s) => print(`  ${warn('!')} ${s}`)

  const commands = {
    async help() {
      print(table([
        [c.accent('chat'), ''],
        ['/agents', 'list installed agent CLIs'],
        ['/use <id>', 'switch the chat agent (claude, codex, gemini, …)'],
        ['/new', 'start a fresh conversation (drops resume)'],
        ['/cwd [path]', 'show or change the working directory'],
        [c.accent('teams — agents running together in the daemon'), ''],
        ['/team', 'list teams and their sessions'],
        ['/team up <name> <agent>', 'spawn a team member (optional prompt)'],
        ['/team down <name>', 'stop every session in the team'],
        ['/say <team|id> <text>', 'send a prompt to a team or one session'],
        ['/sessions', 'all agent sessions'],
        ['/peek <id> [n]', 'read the last n lines of a session'],
        ['/join <id>', 'attach live to a session (Ctrl-] to leave)'],
        ['/stop <id>', 'stop one session'],
        [c.accent('system'), ''],
        ['/status', 'daemon, agents and teams at a glance'],
        ['/daemon start|stop|restart', 'manage the background server'],
        ['/open', 'open the web UI'],
        ['/update', 'self-update harpy'],
        ['/set <key> <value>', 'settings: port, workspace, agent, lang'],
        ['/settings', 'show cli settings'],
        ['/quit', 'leave the shell']
      ]))
    },

    async agents() {
      const rows = state.listed.map((a) => [
        a.id === state.agent ? c.ok(`● ${a.id}`) : `  ${a.id}`,
        a.label,
        a.available ? ok('installed') : dim('missing'),
        a.available ? '' : dim(a.install?.command || '')
      ])
      print(table(rows))
    },

    async use(rest) {
      const id = String(rest).trim()
      if (!id) return err('usage: /use <id>')
      if (!state.adapters.has(id)) return err(`unknown agent '${id}' — /agents`)
      state.agent = id
      state.fresh = true
      state.agentSession = null
      writeCliConfig({ agent: id })
      setPrompt()
      print(`  ${ok('✓')} chatting with ${c.accent(id)} — ${listed.find((a) => a.id === id)?.available ? '' : warn('not installed yet, /agents shows the installer')}`)
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
      if (!sub) {
        const all = await sessions()
        const teams = new Map()
        for (const s of all) {
          if (!s.team) continue
          if (!teams.has(s.team)) teams.set(s.team, [])
          teams.get(s.team).push(s)
        }
        if (!teams.size) return print(`  ${dim('no teams yet — /team up <name> <agent>')}`)
        for (const [name, members] of teams) {
          print(`  ${c.accent(name)}`)
          for (const s of members) print(`    ${sessionTag(s)} ${dim(`· ${fmtAge(s.startedAt)} ago`)}`)
        }
        return
      }
      if (sub === 'up') {
        const [name, agentId, ...promptParts] = parts
        if (!name || !agentId) return err('usage: /team up <name> <agent> [prompt]')
        if (!state.adapters.has(agentId)) return err(`unknown agent '${agentId}' — /agents`)
        if (!listed.find((a) => a.id === agentId)?.available) return err(`${agentId} is not installed — /agents`)
        const promptText = promptParts.join(' ')
        // No workspace field — the daemon resolves its active project root.
        // (An explicit path would 403 unless it is already a registered
        // workspace; team sessions live where the daemon points.)
        const session = await link.call('agent', 'start', { agent: agentId, team: name, prompt: promptText })
        print(`  ${ok('✓')} ${sessionTag(session)} — /say ${session.sessionId} <text> · /peek ${session.sessionId} · /join ${session.sessionId}`)
        return
      }
      if (sub === 'down') {
        const [name] = parts
        if (!name) return err('usage: /team down <name>')
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
      return err('usage: /team [up <name> <agent> [prompt] | down <name>]')
    },

    async say(rest) {
      if (!(await daemonUp())) return err(`daemon offline — /daemon start`)
      const [ref, ...textParts] = String(rest).trim().split(/\s+/)
      const text = textParts.join(' ')
      if (!ref || !text) return err('usage: /say <team|sessionId> <text>')
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
      if (!all.length) return print(`  ${dim('no agent sessions — /team up <name> <agent>')}`)
      print(table(all.map((s) => [s.sessionId, s.agent, s.team || '—', s.status, s.pid || '—', dim(fmtAge(s.startedAt) + ' ago')])))
    },

    async peek(rest) {
      if (!(await daemonUp())) return err(`daemon offline — /daemon start`)
      const [ref, count] = String(rest).trim().split(/\s+/)
      if (!ref) return err('usage: /peek <id> [lines]')
      const session = await findSession(ref)
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
      if (!ref) return err('usage: /join <id>')
      const session = await findSession(ref)
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
      rl.prompt()
      rebuilding = false
      rebuiltThisTurn = true
    },

    async stop(rest) {
      if (!(await daemonUp())) return err(`daemon offline — /daemon start`)
      const ref = String(rest).trim()
      const session = await findSession(ref)
      if (!session) return err(`no session or team '${ref}'`)
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
      rl.prompt()
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
    const text = line.trim()
    if (!text) { rl?.prompt(); return }
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
          try { await runAgentTurn(state, text) } catch (error) { err(error.message || String(error)) }
          state.busy = false
        }
      }
    } catch (error) {
      err(error.message || String(error))
    }
    // /join rebuilt rl mid-command — it already prompted.
    if (rebuiltThisTurn) { rebuiltThisTurn = false; return }
    try { rl?.prompt() } catch { void 0 }
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
      const lines = [`  ${c.accent('›')} /${filter}`]
      for (const [i, p] of list.slice(0, 9).entries()) {
        const row = `/${p.name}${p.args ? ' …' : ''} ${dim(p.desc)}`
        lines.push(i === sel ? `    ${c.accent('›')} ${c.bold(row)}` : `      ${row}`)
      }
      if (!list.length) lines.push(`      ${dim('no match')}`)
      out.write(lines.join('\n') + '\n')
      shown = lines.length
    }
    out.write('\r\x1b[0J') // erase the `agent › /` prompt line
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
    rl.prompt()
    rebuilding = false
    paletteOpen = false
    if (!picked) return
    if (picked.args) rl.write(`/${picked.name} `)
    else enqueue(`/${picked.name}`)
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

  rl = makeRl()
  rl.prompt()

  // '/' on an empty prompt opens the command palette. Punctuation arrives
  // with an undefined key.name — the character itself is the match. The
  // listener lives on stdin so it survives rl rebuilds after /join, and
  // setImmediate lets rl consume the keystroke first regardless of the
  // listener order a rebuilt rl leaves behind.
  process.stdin.on('keypress', (ch, key = {}) => {
    if (ch !== '/' || key.ctrl || key.meta) return
    setImmediate(() => {
      if (rl && !paletteOpen && !draining && rl.line === '/') void openPalette()
    })
  })

  await shellClosed
  print(`  ${dim('bye')}`)
  link.close()
}
