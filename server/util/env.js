import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const PATH_MARKER = '__HARPY_PATH__'

// Service managers (systemd user units, launchd, Task Scheduler) hand us a
// minimal PATH that misses user-level installs such as ~/.local/bin, nvm,
// Homebrew, or scoop. The agent CLIs live in exactly those places, so merge
// the login shell's PATH with well-known install roots once per process.
function nvmBinDirs() {
  const dir = path.join(os.homedir(), '.nvm', 'versions', 'node')
  try {
    return fs.readdirSync(dir)
      .filter((name) => /^v?\d/.test(name))
      .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }))
      .slice(0, 1)
      .map((name) => path.join(dir, name, 'bin'))
  } catch {
    return []
  }
}

function extraPathDirs() {
  const home = os.homedir()
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming')
    const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local')
    return [
      path.join(appData, 'npm'),
      path.join(localAppData, 'pnpm'),
      path.join(home, 'scoop', 'shims'),
      path.join(home, '.local', 'bin')
    ]
  }
  return [
    path.join(home, '.local', 'bin'),
    path.join(home, 'bin'),
    '/usr/local/bin',
    '/usr/local/sbin',
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/opt/local/bin',
    path.join(home, '.bun', 'bin'),
    path.join(home, '.deno', 'bin'),
    path.join(home, '.volta', 'bin'),
    path.join(home, '.npm-global', 'bin'),
    ...nvmBinDirs()
  ]
}

async function loginShellPath() {
  if (process.platform === 'win32') return ''
  // Service envs (launchd, systemd) often omit SHELL — prefer the account's
  // login shell so macOS gets zsh instead of the ancient bundled bash.
  const shell = process.env.SHELL || os.userInfo().shell || '/bin/bash'
  // Interactive+login covers .bashrc/.zshrc (nvm, custom exports); the login-
  // only fallback still catches .profile-based setups. The marker lets us
  // strip any banner text a noisy rc file prints.
  for (const flag of ['-ilc', '-lc']) {
    try {
      const { stdout } = await execFileAsync(shell, [flag, `printf '${PATH_MARKER}%s' "$PATH"`], { timeout: 8_000 })
      const value = String(stdout).split(PATH_MARKER).pop().trim()
      if (value.includes(path.delimiter) || value.startsWith('/')) return value
    } catch { /* try the next invocation style */ }
  }
  return ''
}

async function computeEnhancedPath() {
  const seen = new Set()
  const parts = []
  const push = (dirs) => {
    for (const dir of dirs) {
      if (dir && !seen.has(dir)) { seen.add(dir); parts.push(dir) }
    }
  }
  push(String(process.env.PATH || '').split(path.delimiter).filter(Boolean))
  push((await loginShellPath()).split(path.delimiter).filter(Boolean))
  push(extraPathDirs().filter((dir) => fs.existsSync(dir)))
  return parts.join(path.delimiter)
}

let enhancedPathPromise = null

export function enhancedPath() {
  if (!enhancedPathPromise) enhancedPathPromise = computeEnhancedPath()
  return enhancedPathPromise
}

export async function refreshEnhancedPath() {
  enhancedPathPromise = computeEnhancedPath()
  return enhancedPathPromise
}

// Windows env vars are case-insensitive but the env OBJECT is not: spreading
// `{...process.env, PATH: x}` leaves both `Path` and `PATH`, and whichever
// Node happens to serialize first wins — children then miss the enhanced
// PATH entirely. Always write through the existing key's casing on win32.
function envKey(env, key) {
  if (process.platform !== 'win32') return key
  const lower = key.toLowerCase()
  return Object.keys(env).find((name) => name.toLowerCase() === lower) || key
}

// Same merge rules for caller-supplied extras (cli-env records, adapter env):
// on Windows an override like USERPROFILE must replace the existing key even
// when the daemon's env spelled it differently.
function mergeEnv(env, extra) {
  for (const [key, value] of Object.entries(extra)) env[envKey(env, key)] = value
  return env
}

export async function enhancedEnv(extra = {}) {
  const env = { ...process.env }
  env[envKey(env, 'PATH')] = await enhancedPath()
  mergeEnv(env, extra)
  // A bare service env may omit HOME/USER/SHELL entirely; rc files then
  // expand "$HOME/…" against an empty string ("/.local/bin/env" errors).
  const info = os.userInfo()
  if (!env.HOME) env.HOME = info.homedir
  if (!env.USER) env.USER = info.username
  if (!env.LOGNAME) env.LOGNAME = info.username
  if (!env.SHELL && process.platform !== 'win32') env.SHELL = info.shell || '/bin/bash'
  return env
}

// Scans a PATH string for an executable and returns its absolute path.
// Windows lookups must consider PATHEXT — npm-installed CLIs arrive as
// `foo.cmd` shims, and CreateProcess cannot launch them by bare name.
export async function findOnPath(command, pathEnv) {
  if (!command) return null
  const value = String(command)
  if (path.isAbsolute(value) || value.includes('/') || value.includes('\\')) {
    try { await fs.promises.access(value, fs.constants.X_OK); return value } catch { return null }
  }
  const dirs = String(pathEnv || '').split(path.delimiter).filter(Boolean)
  const candidates = process.platform === 'win32'
    ? [
        // Real executables first — a .cmd shim would also spawn, but the
        // native binary avoids the cmd.exe wrapper entirely.
        '.exe', '.com',
        ...String(process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').map((ext) => ext.toLowerCase()),
        // Not in stock PATHEXT but npm drops a .ps1 next to every .cmd.
        '.ps1',
        ''
      ]
    : ['']
  const seen = new Set()
  for (const dir of dirs) {
    for (const ext of candidates) {
      const full = path.join(dir, value + ext)
      if (seen.has(full)) continue // duplicated PATH dirs / PATHEXT casing
      seen.add(full)
      try {
        await fs.promises.access(full, fs.constants.X_OK)
        return full
      } catch { /* next candidate */ }
    }
  }
  return null
}

// cmd.exe quoting: wrap every arg in double quotes and flatten newlines —
// a literal \n inside a /c string would split the command into two lines.
// Quotes INSIDE an arg cannot be escaped for cmd, so collapse them away.
function cmdQuote(arg) {
  const flat = String(arg).replace(/[\r\n]+/g, ' ').replace(/"/g, "'")
  return /[\s"&|<>^%()!]/.test(flat) || flat === '' ? `"${flat}"` : flat
}

// Turns `command args` into something the OS can actually spawn.
//   posix  → { file, args } with an absolute file when PATH resolves it
//   win32 executable/shim resolution + .cmd/.bat get a cmd.exe wrapper:
//     { file: 'cmd.exe', args: [], tail } where `tail` is the pre-escaped
//     remainder appended verbatim — spawn() needs
//     `windowsVerbatimArguments: true`, pty.spawn takes it as the string
//     args form (CommandLine option, Windows-only).
//   .ps1 shims go through powershell -File.
//   not found → { file: command, args } so the spawn errors ENOENT as usual.
export async function resolveCommand(command, args = [], pathEnv) {
  const found = await findOnPath(command, pathEnv ?? process.env.PATH)
  if (process.platform !== 'win32') return { file: found || command, args }
  if (!found) return { file: command, args }
  const ext = path.extname(found).toLowerCase()
  if (ext === '.cmd' || ext === '.bat') {
    // cmd /s /c "<line>" strips the outer quote pair, leaving the inner
    // quoted file + args — the only quoting form that survives Program
    // Files paths AND quoted arguments.
    const inner = [cmdQuote(found), ...args.map(cmdQuote)].join(' ')
    return { file: process.env.ComSpec || 'cmd.exe', args: [], tail: `/d /s /c "${inner}"` }
  }
  if (ext === '.ps1') {
    return { file: 'powershell.exe', args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', found, ...args.map(String)] }
  }
  return { file: found, args }
}

// Spawn options shared by every wrapped call site.
export function verbatimOpts(target) {
  return process.platform === 'win32' && target.tail
    ? { windowsVerbatimArguments: true }
    : {}
}
