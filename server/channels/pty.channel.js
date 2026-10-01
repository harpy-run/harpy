import { spawnPty } from '../util/pty.js'
import { httpError } from '../util/http.js'
import { enhancedEnv } from '../util/env.js'
import { cliEnvFor } from '../cli-env.js'
import { workspaceCwd, workspaceRoot } from '../workspace.js'
import { accessAlive, ownerKey, requireAdmin } from '../auth.js'
import { recordActivity } from '../activity.js'

const shells = new Map()
let counter = 0
const MAX_HISTORY_EVENTS = 2_000
const MAX_HISTORY_BYTES = 2 * 1024 * 1024
const WS_HIGH_WATER_BYTES = 2 * 1024 * 1024
const WS_LOW_WATER_BYTES = 512 * 1024
// node-pty's onData fires once per read — a big redraw is dozens of tiny
// chunks a second, and forwarding each as its own WS frame floods the
// socket (worst-case pattern for high-latency tunnels: bufferedAmount
// balloons, flow control trips, the tunnel drops the connection). Coalesce
// per ~16ms tick instead: one frame per screen refresh, replay-ordered.
const DATA_FLUSH_MS = 16

function queueShellData(shell, data) {
  shell.pendingData += data
  if (shell.dataTimer) return
  shell.dataTimer = setTimeout(() => flushShellData(shell), DATA_FLUSH_MS)
  shell.dataTimer.unref?.()
}

function flushShellData(shell) {
  if (shell.dataTimer) { clearTimeout(shell.dataTimer); shell.dataTimer = null }
  const data = shell.pendingData
  if (!data) return
  shell.pendingData = ''
  const event = { data, seq: ++shell.sequence }
  shell.history.push(event)
  shell.historyBytes += Buffer.byteLength(data)
  while (shell.history.length > MAX_HISTORY_EVENTS || shell.historyBytes > MAX_HISTORY_BYTES) shell.historyBytes -= Buffer.byteLength(shell.history.shift()?.data || '')
  for (const subscriber of shell.subscribers) {
    // Drop revoked accounts mid-stream instead of streaming them output.
    if (!accessAlive(subscriber)) { shell.subscribers.delete(subscriber); continue }
    try {
      subscriber.emit('pty', 'data', { id: shell.id, data, seq: event.seq })
    } catch { shell.subscribers.delete(subscriber) }
  }
  updateFlowControl(shell)
}

function updateFlowControl(shell) {
  const subscribers = [...shell.subscribers].filter((subscriber) => subscriber.ws?.readyState === 1)
  if (!subscribers.length) {
    if (shell.flowPaused) { shell.flowPaused = false; shell.term.resume() }
    clearInterval(shell.flowTimer)
    shell.flowTimer = null
    return
  }
  const high = subscribers.some((subscriber) => (subscriber.ws?.bufferedAmount || 0) >= WS_HIGH_WATER_BYTES)
  const low = subscribers.every((subscriber) => (subscriber.ws?.bufferedAmount || 0) <= WS_LOW_WATER_BYTES)
  if (high && !shell.flowPaused) {
    shell.term.pause()
    shell.flowPaused = true
    shell.flowTimer = setInterval(() => updateFlowControl(shell), 100)
    shell.flowTimer.unref?.()
  } else if (low && shell.flowPaused) {
    shell.term.resume()
    shell.flowPaused = false
    clearInterval(shell.flowTimer)
    shell.flowTimer = null
  }
}

// Terminals belong to the account, not the tab: reopening Harpy on another
// device reattaches to the same running shells. The whole channel is
// admin-only — a PTY is a daemon-user shell, and a member's project
// allowlist was never meant to grant host-level command execution.

function defaultShell() {
  return process.env.SHELL || (process.platform === 'win32' ? 'powershell.exe' : 'bash')
}

function dimensions(cols, rows) {
  return {
    cols: Math.min(Math.max(Number(cols) || 80, 20), 500),
    rows: Math.min(Math.max(Number(rows) || 24, 5), 200)
  }
}

function getOwnedShell(ctx, id, { subscribe = false } = {}) {
  requireAdmin(ctx)
  const shell = shells.get(id)
  if (!shell || shell.owner !== ownerKey(ctx)) throw httpError(404, 'terminal not found')
  if (subscribe) shell.subscribers.add(ctx)
  return shell
}

export const ptyChannel = {
  ops: {
    async create(ctx, { cols = 80, rows = 24, cwd, workspace: requestedWorkspace, command } = {}) {
      requireAdmin(ctx)
      const id = `pty_${++counter}`
      const size = dimensions(cols, rows)
      const workspacePath = workspaceRoot(requestedWorkspace, ctx)
      const term = await spawnPty(defaultShell(), [], {
        name: 'xterm-256color',
        ...size,
        cwd: workspaceCwd(workspacePath, cwd, ctx),
        env: await enhancedEnv({ TERM: 'xterm-256color', ...(cliEnvFor(ownerKey(ctx)) || {}) })
      })
      const shell = { id, term, owner: ownerKey(ctx), subscribers: new Set([ctx]), workspace: workspacePath, history: [], historyBytes: 0, sequence: 0, flowPaused: false, flowTimer: null, pendingData: '', dataTimer: null }
      shells.set(id, shell)
      recordActivity(workspacePath, 'pty', { action: 'open', user: ctx?.principal?.username || '' })
      term.onData((data) => queueShellData(shell, data))
      term.onExit(({ exitCode }) => {
        // Flush the tail before the exit frame so the last output lands
        // ahead of the lifecycle event on every subscriber.
        flushShellData(shell)
        shells.delete(id)
        clearInterval(shell.flowTimer)
        recordActivity(shell.workspace, 'pty', { action: 'exit', exitCode, user: ctx?.principal?.username || '' })
        for (const subscriber of shell.subscribers) {
          try { subscriber.emit('pty', 'exit', { id, exitCode }) } catch { shell.subscribers.delete(subscriber) }
        }
      })
      if (command) setTimeout(() => { try { term.write(`${String(command)}\r`) } catch { void 0 } }, 80)
      return { id }
    },

    list(ctx, { workspace } = {}) {
      requireAdmin(ctx)
      const requested = workspace ? workspaceRoot(workspace, ctx) : ''
      for (const shell of shells.values()) {
        if (shell.owner === ownerKey(ctx) && (!requested || shell.workspace !== requested)) {
          shell.subscribers.delete(ctx)
          updateFlowControl(shell)
        }
      }
      const live = [...shells.entries()]
        .filter(([, shell]) => shell.owner === ownerKey(ctx) && (!requested || shell.workspace === requested))
        .map(([id, shell]) => ({ id, workspace: shell.workspace, pid: shell.term.pid }))
      for (const { id } of live) {
        const shell = getOwnedShell(ctx, id, { subscribe: true })
        updateFlowControl(shell)
      }
      return live
    },

    unwatchIds(ctx, { ids } = {}) {
      requireAdmin(ctx)
      const selected = new Set(Array.isArray(ids) ? ids.map(String) : [])
      for (const id of selected) {
        const shell = shells.get(id)
        if (shell?.owner === ownerKey(ctx)) {
          shell.subscribers.delete(ctx)
          updateFlowControl(shell)
        }
      }
      return { ok: true }
    },

    watchIds(ctx, { ids } = {}) {
      requireAdmin(ctx)
      const selected = new Set(Array.isArray(ids) ? ids.map(String) : [])
      for (const id of selected) {
        const shell = shells.get(id)
        if (shell?.owner === ownerKey(ctx)) {
          shell.subscribers.add(ctx)
          updateFlowControl(shell)
        }
      }
      return { ok: true }
    },

    watch(ctx, { id } = {}) {
      const shell = getOwnedShell(ctx, id, { subscribe: true })
      updateFlowControl(shell)
      return { ok: true }
    },

    unwatch(ctx, { id } = {}) {
      requireAdmin(ctx)
      const shell = shells.get(id)
      if (!shell || shell.owner !== ownerKey(ctx)) return { ok: true }
      shell.subscribers.delete(ctx)
      updateFlowControl(shell)
      return { ok: true }
    },

    history(ctx, { id } = {}) {
      const shell = getOwnedShell(ctx, id, { subscribe: true })
      return shell.history
    },

    input(ctx, { id, data } = {}) {
      const shell = getOwnedShell(ctx, id)
      if (data != null) shell.term.write(String(data))
      return { ok: true }
    },

    resize(ctx, { id, cols, rows } = {}) {
      const shell = getOwnedShell(ctx, id)
      const size = dimensions(cols, rows)
      shell.term.resize(size.cols, size.rows)
      return { ok: true }
    },

    kill(ctx, { id } = {}) {
      const shell = getOwnedShell(ctx, id)
      try { shell.term.kill() } catch { void 0 }
      flushShellData(shell)
      clearInterval(shell.flowTimer)
      shell.subscribers.clear()
      shells.delete(id)
      return { ok: true }
    },

    killWorkspace(ctx, { workspace } = {}) {
      requireAdmin(ctx)
      const requested = workspaceRoot(workspace, ctx)
      let killed = 0
      for (const [id, shell] of [...shells.entries()]) {
        if (shell.workspace !== requested) continue
        // Notify before clearing so other clients drop the tab instantly
        // instead of waiting for their next reconcile.
        flushShellData(shell)
        for (const subscriber of shell.subscribers) {
          try { subscriber.emit('pty', 'exit', { id, exitCode: null }) } catch { void 0 }
        }
        try { shell.term.kill() } catch { void 0 }
        clearInterval(shell.flowTimer)
        shell.subscribers.clear()
        shells.delete(id)
        killed += 1
      }
      return { killed }
    }
  },

  onClose(ctx) {
    for (const shell of shells.values()) {
      shell.subscribers.delete(ctx)
      updateFlowControl(shell)
    }
  }
}
