import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { config, VERSION } from './config.js'

// Self-update for the published CLI. Two release channels are checked — the
// npm registry and the GitHub repo's tags/releases — because users install
// from either. Which channel *applies* the update depends on how this copy
// was installed (global npm package vs git checkout).

const NPM_PACKAGE = '@harpy-run/harpy'
const NPM_LATEST_URL = 'https://registry.npmjs.org/@harpy-run%2Fharpy/latest'
const REPO = 'harpy-run/harpy'
const RELEASE_API = `https://api.github.com/repos/${REPO}/releases/latest`
const TAGS_API = `https://api.github.com/repos/${REPO}/tags?per_page=30`
export const RELEASE_PAGE = `https://github.com/${REPO}/releases/latest`

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// Mirrors src/lib/updater.js compareVersions — keep the two in sync.
export function compareVersions(left, right) {
  const parse = (value) => {
    const match = String(value || '').trim().replace(/^v/i, '').match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?/)
    if (!match) return null
    return { numbers: [Number(match[1]), Number(match[2] || 0), Number(match[3] || 0)], prerelease: match[4] || '' }
  }
  const a = parse(left)
  const b = parse(right)
  if (!a || !b) return 0
  for (let i = 0; i < a.numbers.length; i += 1) {
    if (a.numbers[i] !== b.numbers[i]) return a.numbers[i] > b.numbers[i] ? 1 : -1
  }
  if (a.prerelease === b.prerelease) return 0
  if (!a.prerelease) return 1
  if (!b.prerelease) return -1
  return a.prerelease.localeCompare(b.prerelease, undefined, { numeric: true })
}

async function fetchJson(url, timeout = 6000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { 'user-agent': `harpy/${VERSION}`, accept: 'application/json' }
    })
    if (!response.ok) return null
    return await response.json()
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

async function latestOnGithub() {
  // Check both: releases can lag tags (a pushed tag may have no Release
  // object yet), so the newest semver across either wins.
  const [release, tags] = await Promise.all([fetchJson(RELEASE_API), fetchJson(TAGS_API)])
  const candidates = []
  if (release?.tag_name) candidates.push(String(release.tag_name).replace(/^v/i, ''))
  if (Array.isArray(tags)) {
    for (const tag of tags) {
      const version = String(tag?.name || '').replace(/^v/i, '')
      if (/^\d+\.\d+\.\d+/.test(version)) candidates.push(version)
    }
  }
  let best = null
  for (const version of candidates) {
    if (!best || compareVersions(version, best) > 0) best = version
  }
  return best
}

async function latestOnNpm() {
  const data = await fetchJson(NPM_LATEST_URL)
  return data?.version ? String(data.version) : null
}

export async function checkForUpdate() {
  const [npm, github] = await Promise.all([latestOnNpm(), latestOnGithub()])
  const candidates = [npm, github].filter(Boolean)
  let latest = null
  for (const version of candidates) {
    if (!latest || compareVersions(version, latest) > 0) latest = version
  }
  return {
    current: VERSION,
    npm,
    github,
    latest,
    updateAvailable: Boolean(latest && compareVersions(latest, VERSION) > 0),
    releasePage: RELEASE_PAGE
  }
}

// How was this copy installed? A global npm package lives under node_modules;
// a source checkout is a git working tree.
export function installMode() {
  if (PACKAGE_ROOT.includes(`${path.sep}node_modules${path.sep}`)) return 'npm'
  try {
    execFileSync('git', ['-C', PACKAGE_ROOT, 'rev-parse', '--is-inside-work-tree'], { stdio: 'ignore' })
    return 'git'
  } catch {
    return 'unknown'
  }
}

function run(command, args, options = {}) {
  // npm is a .cmd shim on Windows — batch files cannot exec directly and
  // need cmd.exe (shell:true). Harmless for real .exe targets like git.
  const result = spawnSync(command, args, { stdio: 'inherit', shell: process.platform === 'win32', windowsHide: true, ...options })
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed (${result.status})`)
}

// A second updater racing the first (two tabs, daemon + dev checkout sharing
// one $HARPY_HOME) interleaves stop/start calls and can leave the port dead —
// serialize them with an atomic lockdir. A crashed updater's lock is broken
// once its pid is gone or after a hard 15-minute cap.
const UPDATE_LOCK = () => path.join(config.dataDir, 'daemon', 'update.lock')
const UPDATE_STATE = () => path.join(config.dataDir, 'daemon', 'update-state.json')

function lockIsStale(lock) {
  try {
    const owner = JSON.parse(fs.readFileSync(path.join(lock, 'owner.json'), 'utf8'))
    if (owner?.pid && owner.pid !== process.pid) {
      try { process.kill(owner.pid, 0); return false } catch { return true }
    }
    return Date.now() - new Date(owner?.at || 0).getTime() > 15 * 60_000
  } catch {
    try { return Date.now() - fs.statSync(lock).mtimeMs > 15 * 60_000 } catch { return true }
  }
}

function acquireUpdateLock() {
  fs.mkdirSync(path.dirname(UPDATE_LOCK()), { recursive: true, mode: 0o700 })
  try {
    fs.mkdirSync(UPDATE_LOCK())
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error
    if (!lockIsStale(UPDATE_LOCK())) return null
    fs.rmSync(UPDATE_LOCK(), { recursive: true, force: true })
    return acquireUpdateLock()
  }
  try {
    fs.writeFileSync(path.join(UPDATE_LOCK(), 'owner.json'), JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), { mode: 0o600 })
  } catch { void 0 }
  return UPDATE_LOCK()
}

// Records update progress where the UI (and `harpy` on the host) can read it —
// the daemon socket dies mid-update, so this file is the source of truth for
// "installing / restarting / done / failed".
export function writeUpdateState(state) {
  try {
    fs.mkdirSync(path.dirname(UPDATE_STATE()), { recursive: true, mode: 0o700 })
    fs.writeFileSync(UPDATE_STATE(), JSON.stringify({ ...state, at: new Date().toISOString() }), { mode: 0o600 })
  } catch { void 0 }
}

function installedVersion() {
  try { return JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8')).version || null } catch { return null }
}

// Applies the update through the channel this install came from, then restarts
// the daemon so the new code actually serves. Returns a short log of steps.
export async function applyUpdate({ restartDaemon = true } = {}) {
  const lock = acquireUpdateLock()
  if (!lock) throw new Error('another update is already running — check the daemon update log')
  try {
    const mode = installMode()
    const steps = []
    const { stopDaemon, startDaemon, daemonStatus, healthProbe } = restartDaemon ? await import('./daemon.js') : {}
    const status = restartDaemon ? await daemonStatus() : null
    // `listeningPort` is where a real server was found — it can differ from
    // the configured port when the running copy came from a foreground
    // `harpy start` or an older state record. Restart must target THAT port
    // or the new daemon is spawned against a port the old one still owns.
    const restartPort = status ? (status.listeningPort || status.port) : null
    const needsRestart = Boolean(status && (status.running || status.listening || status.listeningPort))
    writeUpdateState({ phase: 'install', from: VERSION, mode })
    // Windows locks loaded native modules — a running daemon keeps the
    // node-pty .node open and `npm i -g` dies mid-write with EBUSY, leaving
    // a half-written package. POSIX replaces files while running; Windows
    // must stop the daemon BEFORE the install, then bring it back.
    const stopFirst = needsRestart && process.platform === 'win32' && mode === 'npm'
    if (stopFirst) await stopDaemon()
    try {
      if (mode === 'npm') {
        const npmBin = process.platform === 'win32' ? 'npm.cmd' : 'npm'
        run(npmBin, ['install', '-g', `${NPM_PACKAGE}@latest`])
        steps.push('npm install -g')
      } else if (mode === 'git') {
        run('git', ['-C', PACKAGE_ROOT, 'fetch', '--tags', 'origin'])
        run('git', ['-C', PACKAGE_ROOT, 'pull', '--ff-only'])
        const npmBin = process.platform === 'win32' ? 'npm.cmd' : 'npm'
        run(npmBin, ['install'], { cwd: PACKAGE_ROOT })
        run(npmBin, ['run', 'build'], { cwd: PACKAGE_ROOT })
        steps.push('git pull + rebuild')
      } else {
        throw new Error(`cannot self-update from this install — download ${RELEASE_PAGE}`)
      }
    } catch (error) {
      // A failed npm install after the pre-stop must not leave the host
      // dead — restart the old version (the package dir may still be intact).
      if (stopFirst) { try { await startDaemon({ port: restartPort }) } catch { void 0 } }
      throw error
    }
    if (restartDaemon && needsRestart) {
      {
        writeUpdateState({ phase: 'restart', from: VERSION, mode, port: restartPort })
        await stopDaemon()
        await startDaemon({ port: restartPort })
        // Verify harpy itself answers — not just a bound socket — and re-nudge
        // a supervisor that gave up. A daemon that never returns is reported
        // as a failure, not "restarted".
        const deadline = Date.now() + 45_000
        let probe = await healthProbe(restartPort)
        while (!probe.harpy && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 600))
          const check = await daemonStatus({ port: restartPort })
          if (!check.running && !check.listening) await startDaemon({ port: restartPort })
          probe = await healthProbe(restartPort)
        }
        if (!probe.harpy) {
          throw new Error('daemon did not come back after the update — recover with `harpy daemon start`')
        }
        steps.push('daemon restarted')
      }
    }
    writeUpdateState({ phase: 'done', from: VERSION, version: installedVersion(), mode })
    return { mode, steps }
  } catch (error) {
    writeUpdateState({ phase: 'failed', from: VERSION, error: error?.message || String(error) })
    throw error
  } finally {
    fs.rmSync(lock, { recursive: true, force: true })
  }
}

// The CLI's files can already be at the latest version while the daemon
// PROCESS still serves an older one — a checkout pulled out-of-band, or a
// previous install whose restart never landed. checkForUpdate() only
// compares this file's VERSION to the registry, so without this probe the
// updater reports "up to date" while the UI banner offers the same update
// forever. Returns true when it restarted a stale daemon.
export async function restartStaleDaemon() {
  const { daemonStatus, healthProbe, stopDaemon, startDaemon } = await import('./daemon.js')
  const status = await daemonStatus()
  const port = status.listeningPort || status.port
  if (!port) return false
  const probe = await healthProbe(port)
  if (!probe.harpy || !probe.version || compareVersions(probe.version, VERSION) === 0) return false
  writeUpdateState({ phase: 'restart', from: probe.version, version: VERSION, port })
  await stopDaemon()
  await startDaemon({ port })
  const deadline = Date.now() + 45_000
  let next = await healthProbe(port)
  while (!(next.harpy && next.version === VERSION) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 600))
    const check = await daemonStatus({ port })
    if (!check.running && !check.listening) await startDaemon({ port })
    next = await healthProbe(port)
  }
  if (!(next.harpy && next.version === VERSION)) {
    throw new Error('daemon did not come back on the new version — recover with `harpy daemon start`')
  }
  return true
}
