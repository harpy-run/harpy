import { execFileSync } from 'node:child_process'
import fs from 'node:fs'

// Cross-platform process utilities. Linux leans on /proc (cheapest), the
// other POSIX systems fall back to `ps` (always present on macOS/BSD), and
// Windows uses taskkill/PowerShell — the only tools guaranteed on a stock
// install (wmic is gone on Windows 11).

function execOut(cmd, args, timeout = 4_000) {
  return execFileSync(cmd, args, {
    encoding: 'utf8',
    timeout,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'ignore']
  })
}

export function pidAlive(pid) {
  if (!pid || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch (error) { return error?.code === 'EPERM' }
}

// pid → parent map for the whole system, or null when unreadable.
// Windows is intentionally skipped: taskkill /T does its own tree walk and
// a generic parent map is expensive to query there.
function parentMap() {
  if (process.platform === 'win32') return null
  const children = new Map()
  if (process.platform === 'linux') {
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
      return children
    } catch { return null }
  }
  // macOS + other POSIX: ps -Ao pid=,ppid= is the portable equivalent.
  try {
    const out = execOut('ps', ['-Ao', 'pid=,ppid='])
    for (const line of out.split('\n')) {
      const match = line.trim().match(/^(\d+)\s+(\d+)$/)
      if (!match) continue
      const pid = Number(match[1])
      const ppid = Number(match[2])
      const list = children.get(ppid)
      if (list) list.push(pid)
      else children.set(ppid, [pid])
    }
    return children
  } catch { return null }
}

export function processTree(rootPid) {
  const root = Number(rootPid)
  const tree = new Set([root])
  const children = parentMap()
  if (!children) return tree
  const queue = [root]
  while (queue.length) {
    for (const kid of children.get(queue.shift()) || []) {
      if (!tree.has(kid)) { tree.add(kid); queue.push(kid) }
    }
  }
  return tree
}

// Command line of a pid — '' when it can't be inspected. CLIs report a lock
// holder in their output; daemon stop/start also verifies pids before
// reclaiming a port.
export function commandLineOf(pid) {
  if (!pidAlive(pid)) return ''
  try {
    if (process.platform === 'linux') {
      return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replaceAll('\0', ' ').trim()
    }
    if (process.platform === 'win32') {
      return execOut('powershell.exe', [
        '-NoProfile', '-Command',
        `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine`
      ], 8_000).trim()
    }
    return execOut('ps', ['-p', String(pid), '-o', 'command=']).trim()
  } catch { return '' }
}

// SIGTERM first so a clean exit lets the CLI drop its session lock, then a
// short grace period before the sweep kills whatever ignored it. The pty
// child is a session leader on POSIX, so the group kill (-pid) also covers
// helpers that re-parented (devin → `devin acp`, codex helpers).
// Windows has no process-group signals — taskkill /T walks the tree itself.
export function killProcessTree(rootPid, { graceMs = 800 } = {}) {
  const root = Number(rootPid)
  if (!Number.isInteger(root) || root <= 0) return
  if (process.platform === 'win32') {
    const sweep = () => { try { execFileSync('taskkill', ['/PID', String(root), '/T', '/F'], { stdio: 'ignore', windowsHide: true }) } catch { void 0 } }
    sweep()
    const again = setTimeout(sweep, graceMs)
    again.unref?.()
    return
  }
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
