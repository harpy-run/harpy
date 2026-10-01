import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { execFileSync, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { config, VERSION } from './config.js'
import { readCliConfig } from './cli-config.js'

// The daemon deliberately uses only Node's standard library.  This keeps the
// npm install small while still giving the server the same always-on behaviour
// as the legacy desktop wrapper.
const DAEMON_DIR = path.join(config.dataDir, 'daemon')
const PID_FILE = path.join(DAEMON_DIR, 'harpy.pid')
const STATE_FILE = path.join(DAEMON_DIR, 'state.json')
const LOG_FILE = path.join(DAEMON_DIR, 'harpy.log')
const SERVICE_NAME = 'harpy.service'
const LINUX_UNIT = path.join(os.homedir(), '.config', 'systemd', 'user', SERVICE_NAME)
const LINUX_SYSTEM_UNIT = `/etc/systemd/system/${SERVICE_NAME}`
const LINUX_AUTOSTART = path.join(os.homedir(), '.config', 'autostart', 'harpy.desktop')
const MAC_LAUNCH_AGENT = path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.harpy.server.plist')
const WINDOWS_STARTUP = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'Harpy.cmd')
const CLI_ENTRY = fileURLToPath(new URL('./cli.js', import.meta.url))


function ensureDaemonDir() {
  fs.mkdirSync(DAEMON_DIR, { recursive: true, mode: 0o700 })
}

function readPid() {
  try {
    const value = Number.parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10)
    return Number.isInteger(value) && value > 0 ? value : null
  } catch {
    return null
  }
}

function writeState(state) {
  ensureDaemonDir()
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), { mode: 0o600 })
  fs.writeFileSync(PID_FILE, `${state.pid}\n`, { mode: 0o600 })
}

function readState() {
  try {
    const value = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
    return value && typeof value === 'object' ? value : {}
  } catch {
    return {}
  }
}

function removeState(pid = null) {
  const current = readPid()
  if (pid && current && current !== pid) return
  for (const file of [PID_FILE, STATE_FILE]) {
    try { fs.unlinkSync(file) } catch (error) { if (error?.code !== 'ENOENT') void 0 }
  }
}

function processRunning(pid) {
 if (!pid) return false
 try { process.kill(pid, 0); return true } catch { return false }
}

// When a systemd unit already supervises the daemon, start/stop must go through
// systemctl. Killing the pidfile pid directly races with Restart=on-failure,
// and spawning a detached child alongside the unit leaves two processes
// fighting over the port — the loser lingers as an orphan.
function systemdUnit() {
  if (process.platform !== 'linux') return null
  try { execFileSync('systemctl', ['--version'], { stdio: 'ignore' }) } catch { return null }
  if (fs.existsSync(LINUX_SYSTEM_UNIT)) return []
  if (fs.existsSync(LINUX_UNIT)) return ['--user']
  return null
}

async function waitForListening(port, timeout = 5_000) {
  const deadline = Date.now() + timeout
  let status = await daemonStatus({ port })
  while (!status.listening && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100))
    status = await daemonStatus({ port })
  }
  return status
}

// A listening socket can outlive the killed process by a beat (and under a
// supervisor the port may be re-bound almost immediately). Returning while
// the port is still bound makes a follow-up startDaemon report "port already
// in use" and skip the start entirely — that exact interleave is what left
// past updates with a dead daemon.
async function waitForPortFree(port, timeout = 4_000) {
  const deadline = Date.now() + timeout
  while (await probePort(port) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

// Kills harpy daemon processes still bound to the port after the supervised
// stop — earlier builds could leave a detached child behind that kept the port
// and made every subsequent restart report "port already in use".
function reapOrphanedListeners(port) {
  if (process.platform !== 'linux') return
  try {
    const out = execFileSync('ss', ['-tlnp', `sport = :${port}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    const pids = new Set([...out.matchAll(/pid=(\d+)/g)].map((match) => Number(match[1])))
    for (const pid of pids) {
      if (pid !== process.pid && pidMatchesDaemon(pid)) {
        try { process.kill(pid, 'SIGTERM') } catch { void 0 }
      }
    }
  } catch { void 0 }
}

// Who actually listens on the port? The pidfile can be missing or stale while
// a live harpy still holds it — `harpy start` runs the server foreground with
// no state file at all, supervisors respawn under a new pid, and pids get
// reused. Cross-platform listener→pid so stop/start can reclaim the port.
function pidsOnPort(port) {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('netstat', ['-ano'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      const pids = new Set()
      for (const line of out.split('\n')) {
        const match = line.trim().match(/^TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)$/i)
        if (match && Number(match[1]) === port) pids.add(Number(match[2]))
      }
      return [...pids]
    }
    if (process.platform === 'darwin') {
      const out = execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      return [...new Set(out.split('\n').map((item) => Number(item.trim())).filter((pid) => Number.isInteger(pid) && pid > 0))]
    }
    const out = execFileSync('ss', ['-tlnp', `sport = :${port}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    return [...new Set([...out.matchAll(/pid=(\d+)/g)].map((match) => Number(match[1])))]
  } catch { return [] }
}

function killPid(pid) {
  if (!pid || pid === process.pid) return
  try {
    if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
    else {
      try { process.kill(-pid, 'SIGTERM') } catch { process.kill(pid, 'SIGTERM') }
    }
  } catch { void 0 }
}

// Kills the process holding the port — but only once /api/health proves it is
// OUR server. A foreign app bound to the same port is never touched; it keeps
// `startDaemon` honest about "port already in use".
export async function killPortHolder(port) {
  const normalized = normalizePort(port)
  if (!(await healthProbe(normalized)).harpy) return false
  const pids = pidsOnPort(normalized).filter((pid) => pid !== process.pid)
  if (!pids.length) return false
  for (const pid of pids) killPid(pid)
  await waitForPortFree(normalized, 5_000)
  for (const pid of pids) {
    if (pid === process.pid) continue
    if (processRunning(pid)) {
      try {
        if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
        else process.kill(pid, 'SIGKILL')
      } catch { void 0 }
    }
  }
  await waitForPortFree(normalized, 2_000)
  return !(await probePort(normalized))
}

function pidMatchesDaemon(pid) {
  if (!processRunning(pid)) return false
  if (process.platform === 'win32') return true
  try {
    const command = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replaceAll('\0', ' ')
    return command.includes('server/cli.js') && command.includes('daemon')
  } catch {
    // /proc is unavailable on some Unix variants; trust the PID file there.
    return true
  }
}

function normalizePort(value) {
  const port = Number(value || 3001)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('invalid port')
  return port
}

function quote(value) {
  return JSON.stringify(String(value))
}

function shellArgs({ port, workspace } = {}) {
  const args = [CLI_ENTRY, 'daemon', 'run', '--port', String(port)]
  if (workspace) args.push('--workspace', workspace)
  return args
}

function commandString({ port, workspace } = {}) {
  return [process.execPath, ...shellArgs({ port, workspace })].map(quote).join(' ')
}

function probePort(port, timeout = 900) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port })
    let settled = false
    const done = (value) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(value)
    }
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
    socket.setTimeout(timeout, () => done(false))
  })
}

// Asks the HTTP server on a port who it is. A live harpy answers
// `{name:'harpy'}` from /api/health — anything else (or nothing) means the
// port belongs to a foreign process and must not be touched.
export async function healthProbe(port, timeout = 1200) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)
  try {
    const response = await fetch(`http://127.0.0.1:${normalizePort(port)}/api/health`, { signal: controller.signal })
    if (!response.ok) return { occupied: true, harpy: false }
    const data = await response.json()
    return { occupied: true, harpy: data?.name === 'harpy', version: data?.version || null }
  } catch {
    return { occupied: false, harpy: false }
  } finally {
    clearTimeout(timer)
  }
}

export async function daemonStatus({ port } = {}) {
  const explicitPort = port !== undefined
  const normalizedPort = normalizePort(port ?? config.port)
  const pid = readPid()
  const alive = pidMatchesDaemon(pid)
  // Read state BEFORE removeState can wipe it — the remembered port is the
  // only record of where an untracked/foreground server actually listens.
  // Probe every known candidate (requested, state, cli.json): a server on a
  // custom port must be seen even when env.PORT disagrees with it.
  const state = readState()
  const candidates = [...new Set([normalizedPort, Number(state.port), Number(readCliConfig().port)]
    .filter((value) => Number.isInteger(value) && value > 0))]
  const configuredPort = Number(state.port)
    || (explicitPort ? normalizedPort : Number(readCliConfig().port))
    || normalizedPort
  // `listening` keeps its contract — something holds the REQUESTED port —
  // while `listeningPort` discovers where a real listener actually sits, so a
  // daemon on a custom port is found even when env.PORT disagrees with it.
  const listening = await probePort(normalizedPort)
  let listeningPort = listening ? normalizedPort : null
  if (!listeningPort) {
    for (const candidate of candidates) {
      if (candidate === normalizedPort) continue
      if (await probePort(candidate)) { listeningPort = candidate; break }
    }
  }
  if (!alive && pid) removeState(pid)
  return {
    version: VERSION,
    running: alive,
    listening,
    listeningPort,
    pid: alive ? pid : null,
    port: configuredPort,
    workspace: state.workspace || null,
    logFile: LOG_FILE,
    service: autostartStatus()
  }
}

export function runDaemonForeground({ port = config.port, workspace } = {}) {
  const normalizedPort = normalizePort(port)
  ensureDaemonDir()
  writeState({ pid: process.pid, port: normalizedPort, workspace: workspace || null, startedAt: new Date().toISOString(), version: VERSION })
  const cleanup = () => removeState(process.pid)
  process.once('exit', cleanup)
  // startServer installs its own signal handlers and exits after closing HTTP;
  // this handler only removes stale state when a signal arrives.
  process.once('SIGINT', cleanup)
  process.once('SIGTERM', cleanup)
  // config.js may already be cached (cli-config imports it at module load),
  // so mutate the live object rather than relying on a frozen env snapshot.
  if (workspace) config.workspace = path.resolve(workspace)
  process.env.PORT = String(normalizedPort)
  return import('./index.js').then(({ startServer }) => startServer({ port: normalizedPort }))
}

// Starts a server without writing daemon state. Used by desktop shells that
// supervise this process themselves (Tauri/Electron) and therefore should not
// be mistaken for a CLI-managed daemon.
export function runServerForeground({ port = config.port, workspace } = {}) {
  const normalizedPort = normalizePort(port)
  if (workspace) config.workspace = path.resolve(workspace)
  process.env.PORT = String(normalizedPort)
  return import('./index.js').then(({ startServer }) => startServer({ port: normalizedPort }))
}

export async function startDaemon({ port = config.port, workspace } = {}) {
  const normalizedPort = normalizePort(port)
  let current = await daemonStatus({ port: normalizedPort })
  // A predecessor that just stopped can leave the socket bound for a few
  // hundred ms — absorb that before declaring the port taken. A foreign
  // process keeps holding it and still gets refused below.
  let probeRetries = 25
  while (!current.running && current.listening && probeRetries-- > 0) {
    await new Promise((resolve) => setTimeout(resolve, 120))
    current = await daemonStatus({ port: normalizedPort })
  }
  if (current.running) return { ...current, started: false, message: 'daemon already running' }
  if (current.listening) {
    // An untracked harpy (foreground `harpy start`, orphan from an older
    // update) holding the port used to wedge every restart here forever.
    // Reclaim it by health identity — a foreign app is still refused below.
    if ((await healthProbe(normalizedPort)).harpy) {
      await killPortHolder(normalizedPort)
      current = await daemonStatus({ port: normalizedPort })
    }
    if (current.listening) return { ...current, started: false, message: `port ${normalizedPort} is already in use` }
  }

  const unit = systemdUnit()
  if (unit) {
    try {
      execFileSync('systemctl', [...unit, 'start', SERVICE_NAME], { stdio: 'ignore' })
      const status = await waitForListening(normalizedPort)
      return { ...status, started: status.running || status.listening, message: status.listening ? 'daemon started' : 'daemon is starting; inspect the log if it does not come online' }
    } catch { /* fall through to the detached spawn when systemctl fails */ }
  }

  ensureDaemonDir()
  const log = fs.openSync(LOG_FILE, 'a')
  const child = spawn(process.execPath, ['--enable-source-maps', ...shellArgs({ port: normalizedPort, workspace })], {
    cwd: path.dirname(CLI_ENTRY),
    detached: true,
    windowsHide: true,
    env: { ...process.env, PORT: String(normalizedPort), HARPY_DAEMON_CHILD: '1' },
    stdio: ['ignore', log, log]
  })
  child.once('error', (error) => {
    try { fs.appendFileSync(LOG_FILE, `[daemon] failed to spawn: ${error.message}\n`) } catch { void 0 }
  })
  child.unref()
  // Give the child a short head start so callers receive useful status data.
  const deadline = Date.now() + 5_000
  let status = await daemonStatus({ port: normalizedPort })
  while (!status.listening && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100))
    status = await daemonStatus({ port: normalizedPort })
  }
  return { ...status, started: status.running || status.listening, message: status.listening ? 'daemon started' : 'daemon is starting; inspect the log if it does not come online' }
}

export async function stopDaemon() {
  const unit = systemdUnit()
  if (unit) {
    try {
      const port = Number(readState().port) || Number(readCliConfig().port) || config.port
      execFileSync('systemctl', [...unit, 'stop', SERVICE_NAME], { stdio: 'ignore' })
      const deadline = Date.now() + 4_000
      let pid = readPid()
      while (pid && processRunning(pid) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100))
        pid = readPid()
      }
      reapOrphanedListeners(port)
      await killPortHolder(port)
      removeState()
      await waitForPortFree(port)
      return { stopped: true }
    } catch { /* fall through to the direct kill when systemctl fails */ }
  }
  const pid = readPid()
  // Capture the remembered port BEFORE killing — the dying server's own
  // cleanup removes state.json, which is the only record of a custom port.
  // Sweep every candidate: the live holder may sit on the cli.json port while
  // state.json remembers another.
  const ports = [...new Set([Number(readState().port), Number(readCliConfig().port), config.port]
    .filter((value) => Number.isInteger(value) && value > 0))]
  let stopped = false
  if (pid && processRunning(pid)) {
    killPid(pid)
    const deadline = Date.now() + 4_000
    while (processRunning(pid) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100))
    if (processRunning(pid)) {
      try {
        if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
        else process.kill(pid, 'SIGKILL')
      } catch { void 0 }
    }
    stopped = true
  }
  // The pidfile only covers daemon-managed processes — a foreground
  // `harpy start` or a respawned orphan owns no pid entry yet still holds
  // the port, which is how updates used to wedge on "port already in use".
  for (const port of ports) {
    if (await killPortHolder(port)) stopped = true
    reapOrphanedListeners(port)
    await waitForPortFree(port)
  }
  removeState(pid)
  if (!stopped) return { stopped: false, message: 'daemon is not running' }
  return { stopped: true, pid }
}

function linuxUnit({ port, workspace }) {
  const command = commandString({ port, workspace })
  return `[Unit]\nDescription=Harpy background server\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=simple\nExecStart=${command}\nRestart=on-failure\nRestartSec=2\nEnvironment=HARPY_DAEMON_CHILD=1\n\n[Install]\nWantedBy=default.target\n`
}

function linuxDesktop({ port, workspace }) {
  return `[Desktop Entry]\nType=Application\nName=Harpy\nComment=Harpy background server\nExec=${commandString({ port, workspace })}\nTerminal=false\nX-GNOME-Autostart-enabled=true\n`
}

function macLaunchAgent({ port, workspace }) {
  const values = shellArgs({ port, workspace }).map((item) => `<string>${String(item).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</string>`).join('')
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>com.harpy.server</string><key>ProgramArguments</key><array><string>${process.execPath}</string>${values}</array><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>StandardOutPath</key><string>${LOG_FILE}</string><key>StandardErrorPath</key><string>${LOG_FILE}</string></dict></plist>\n`
}

function windowsStartup({ port, workspace }) {
  const command = commandString({ port, workspace })
  return `@echo off\r\nstart "Harpy" /b ${command}\r\n`
}

export function autostartStatus() {
  if (process.platform === 'linux') {
    // A system-level unit (e.g. /etc/systemd/system/harpy.service) manages
    // the server too; report it so status does not claim autostart is off.
    if (fs.existsSync(LINUX_UNIT)) return { enabled: true, mode: 'systemd', path: LINUX_UNIT }
    if (fs.existsSync(LINUX_SYSTEM_UNIT)) return { enabled: true, mode: 'systemd-system', path: LINUX_SYSTEM_UNIT }
    return { enabled: fs.existsSync(LINUX_AUTOSTART), mode: 'desktop', path: LINUX_AUTOSTART }
  }
  if (process.platform === 'darwin') return { enabled: fs.existsSync(MAC_LAUNCH_AGENT), mode: 'launchagent', path: MAC_LAUNCH_AGENT }
  if (process.platform === 'win32') return { enabled: fs.existsSync(WINDOWS_STARTUP), mode: 'startup-folder', path: WINDOWS_STARTUP }
  return { enabled: false, mode: 'unsupported', path: null }
}

export function installAutostart({ port = config.port, workspace, mode = 'auto' } = {}) {
  const normalizedPort = normalizePort(port)
  if (process.platform === 'linux') {
    if (mode !== 'desktop') {
      try {
        fs.mkdirSync(path.dirname(LINUX_UNIT), { recursive: true })
        fs.writeFileSync(LINUX_UNIT, linuxUnit({ port: normalizedPort, workspace }), { mode: 0o600 })
        execFileSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'ignore' })
        execFileSync('systemctl', ['--user', 'enable', SERVICE_NAME], { stdio: 'ignore' })
        return autostartStatus()
      } catch {
        try { fs.unlinkSync(LINUX_UNIT) } catch { void 0 }
      }
    }
    fs.mkdirSync(path.dirname(LINUX_AUTOSTART), { recursive: true })
    fs.writeFileSync(LINUX_AUTOSTART, linuxDesktop({ port: normalizedPort, workspace }), { mode: 0o600 })
    return autostartStatus()
  }
  if (process.platform === 'darwin') {
    fs.mkdirSync(path.dirname(MAC_LAUNCH_AGENT), { recursive: true })
    fs.writeFileSync(MAC_LAUNCH_AGENT, macLaunchAgent({ port: normalizedPort, workspace }), { mode: 0o600 })
    try { execFileSync('launchctl', ['load', '-w', MAC_LAUNCH_AGENT], { stdio: 'ignore' }) } catch { void 0 }
    return autostartStatus()
  }
  if (process.platform === 'win32') {
    fs.mkdirSync(path.dirname(WINDOWS_STARTUP), { recursive: true })
    fs.writeFileSync(WINDOWS_STARTUP, windowsStartup({ port: normalizedPort, workspace }), { mode: 0o600 })
    return autostartStatus()
  }
  return autostartStatus()
}

export function removeAutostart() {
  if (process.platform === 'linux') {
    try { execFileSync('systemctl', ['--user', 'disable', '--now', SERVICE_NAME], { stdio: 'ignore' }) } catch { void 0 }
    for (const file of [LINUX_UNIT, LINUX_AUTOSTART]) { try { fs.unlinkSync(file) } catch { void 0 } }
  } else if (process.platform === 'darwin') {
    try { execFileSync('launchctl', ['unload', '-w', MAC_LAUNCH_AGENT], { stdio: 'ignore' }) } catch { void 0 }
    try { fs.unlinkSync(MAC_LAUNCH_AGENT) } catch { void 0 }
  } else if (process.platform === 'win32') {
    try { fs.unlinkSync(WINDOWS_STARTUP) } catch { void 0 }
  }
  return autostartStatus()
}

export function readDaemonLog() {
  try { return fs.readFileSync(LOG_FILE, 'utf8') } catch (error) { if (error?.code === 'ENOENT') return ''; throw error }
}
