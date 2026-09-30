import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { listAgents } from '../agents/adapter.js'
import { requireAccess, requireAdmin, ownerKey } from '../auth.js'
import { cliEnvFor } from '../cli-env.js'
import { enhancedEnv } from '../util/env.js'
import { httpError } from '../util/http.js'
import { workspaceRoot } from '../workspace.js'
import { ptyChannel } from './pty.channel.js'

const execFileAsync = promisify(execFile)
const RIG_TIMEOUT_MS = 15_000
const RIG_MAX_BUFFER = 4 * 1024 * 1024

// OpenRig is an external orchestrator: every op below shells out to the
// `rig` CLI's documented --json surface instead of speaking the daemon's
// internal API. Seat state, queue counts, context usage and the tmux attach
// target all come from `rig ps --nodes`; nothing here is polled on a timer —
// clients refresh while their panel is open, so an idle Harpy spends zero
// cycles on rigs.

async function rigAvailable() {
  const agents = await listAgents()
  return !!agents.find((agent) => agent.id === 'openrig')?.available
}

// Per-user env so a member with a private cli-home talks to their own
// ~/.openrig instance and their own tmux server, not the daemon user's.
async function rigRun(ctx, args, { timeout = RIG_TIMEOUT_MS } = {}) {
  const env = await enhancedEnv({ ...(cliEnvFor(ownerKey(ctx)) || {}) })
  try {
    const { stdout } = await execFileAsync('rig', args, { env, timeout, maxBuffer: RIG_MAX_BUFFER })
    return stdout
  } catch (error) {
    if (error?.code === 'ENOENT') throw httpError(400, 'openrig cli not found')
    const detail = String(error?.stderr || error?.message || '').trim().split('\n').slice(-3).join(' ')
    throw httpError(400, detail || 'rig command failed')
  }
}

// Control variant for boot/down: a non-zero exit is a *result* (bad spec
// name, restore failure), not a channel error — return both streams and let
// the op decide what the user sees inline.
async function rigControl(ctx, args, timeout) {
  const env = await enhancedEnv({ ...(cliEnvFor(ownerKey(ctx)) || {}) })
  try {
    const { stdout } = await execFileAsync('rig', args, { env, timeout, maxBuffer: RIG_MAX_BUFFER })
    return { code: 0, stdout, stderr: '' }
  } catch (error) {
    if (error?.code === 'ENOENT') throw httpError(400, 'openrig cli not found')
    return { code: Number(error.code) || 1, stdout: String(error.stdout || ''), stderr: String(error.stderr || error.message || '') }
  }
}

function parseJson(stdout) {
  try { return JSON.parse(stdout) } catch { return null }
}

// --json normally emits a bare array; --limit/--fields/--filter switch to an
// envelope. Accept both so a different openrig version never breaks the UI.
function rowsOf(parsed) {
  if (Array.isArray(parsed)) return parsed
  if (parsed && typeof parsed === 'object') {
    for (const key of ['nodes', 'items', 'rows', 'rigs', 'results']) {
      if (Array.isArray(parsed[key])) return parsed[key]
    }
  }
  return []
}

function normalizeRig(row) {
  return {
    name: row.name || row.rigName || row.rigId || '',
    rigId: row.rigId || row.name || '',
    status: row.status || 'unknown',
    lifecycleState: row.lifecycleState || null,
    nodeCount: Number(row.nodeCount) || 0,
    runningCount: Number(row.runningCount) || 0,
    activeCount: Number(row.activeCount) || 0,
    hasWorkCount: Number(row.hasWorkCount) || 0,
    attentionCount: Number(row.attentionCount) || 0,
    uptime: row.uptime || null,
    archived: !!row.isArchived
  }
}

// Whitelist projection — `rig ps --full` carries secret material
// (resumeToken values, resumeCommand) that must never reach a socket frame.
function normalizeSeat(row) {
  const activity = row.agentActivity?.state || null
  const attention = row.lifecycleState === 'attention_required'
    || ['attention_required', 'failed'].includes(row.startupStatus)
    || activity === 'needs_input'
  return {
    name: row.canonicalSessionName || (row.logicalId && row.rigName ? `${row.logicalId}@${row.rigName}` : row.logicalId || ''),
    logicalId: row.logicalId || '',
    rig: row.rigName || row.rigId || '',
    kind: row.nodeKind || 'agent',
    runtime: row.runtime || null,
    model: row.model || null,
    sessionStatus: row.sessionStatus || null,
    startupStatus: row.startupStatus || null,
    lifecycleState: row.lifecycleState || null,
    activity,
    activityReason: row.agentActivity?.reason || null,
    contextUsed: row.contextUsage?.usedPercentage ?? null,
    contextState: row.contextUsage?.state || null,
    pendingWork: Number(row.pendingWorkCount) || 0,
    assignedWork: Number(row.assignedWorkCount) || 0,
    hasWork: !!row.hasAssignedWork,
    heldReason: row.heldReason || null,
    latestError: row.latestError || null,
    lastActivity: row.agentActivity?.sampledAt || row.startupCompletedAt || row.lastActivity || null,
    attention
  }
}

// Read ops ride the caller's agent allowlist for `openrig`; control ops are
// admin-only because a seat is a daemon-user process — same trust level the
// pty channel applies to host shells.
function requireRigAccess(ctx) {
  const access = requireAccess(ctx)
  if (access.agents && !access.agents.has('openrig')) throw httpError(403, 'openrig is not assigned to this account')
  return access
}

const RIG_NAME_RE = /^[a-zA-Z0-9][\w-]{0,63}$/
// Single-quote for embedding inside the shell command pty.create runs.
const sh = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`

async function findSeat(ctx, session) {
  const parsed = parseJson(await rigRun(ctx, ['ps', '--nodes', '-A', '--json']))
  const seats = rowsOf(parsed)
  return seats.find((node) => node.canonicalSessionName === session
    || (node.logicalId && node.rigName && `${node.logicalId}@${node.rigName}` === session)) || null
}

export const rigChannel = {
  ops: {
    async overview(ctx) {
      requireRigAccess(ctx)
      if (!(await rigAvailable())) return { available: false, rigs: [] }
      // A stopped/never-started daemon is a normal state (fresh install) —
      // report an empty fleet instead of erroring the panel away.
      try {
        const parsed = parseJson(await rigRun(ctx, ['ps', '--json']))
        return { available: true, rigs: rowsOf(parsed).map(normalizeRig) }
      } catch { return { available: true, rigs: [] } }
    },

    async seats(ctx, { rig } = {}) {
      requireRigAccess(ctx)
      if (!rig || typeof rig !== 'string') throw httpError(400, 'rig name required')
      // --full adds contextUsage + attach details; normalizeSeat whitelists
      // the fields so resume tokens never leave this process.
      const parsed = parseJson(await rigRun(ctx, ['ps', '--nodes', '--rig', String(rig), '--json', '--full']))
      return rowsOf(parsed).map(normalizeSeat)
    },

    async send(ctx, { session, text } = {}) {
      requireAdmin(ctx)
      if (!session || !String(text || '').trim()) throw httpError(400, 'session and text required')
      const stdout = await rigRun(ctx, ['send', String(session), String(text)])
      return { ok: true, output: stdout.trim().slice(0, 2_000) }
    },

    async capture(ctx, { session, lines } = {}) {
      requireRigAccess(ctx)
      if (!session) throw httpError(400, 'session required')
      const count = Math.min(Math.max(Number(lines) || 40, 5), 200)
      const stdout = await rigRun(ctx, ['capture', String(session), '--lines', String(count)])
      return { output: stdout.slice(-200_000) }
    },

    // A seat's terminal is a tmux session owned by openrig — attaching a
    // plain pty to it gives a live read/write window without reimplementing
    // any streaming. The terminal lands in the regular Terminals panel.
    async attach(ctx, { session, cols, rows, workspace } = {}) {
      requireAdmin(ctx)
      if (!session) throw httpError(400, 'session required')
      const node = await findSeat(ctx, String(session))
      const tmuxName = node?.canonicalSessionName || String(session)
      const workspacePath = workspace ? workspaceRoot(workspace, ctx) : ''
      return ptyChannel.ops.create(ctx, {
        cols, rows,
        workspace: workspacePath,
        command: `tmux attach-session -t ${sh(tmuxName)}`
      })
    },

    // `rig up`/`rig down` exit on their own (up typically 5-60s while seats
    // boot) and `--json` reports per-seat results — so they run right here in
    // the background instead of popping a terminal into the user's face. The
    // result summary lands inline in the dashboard; seat states show up on
    // the next poll.
    async boot(ctx, { rig, workspace, existing } = {}) {
      requireAdmin(ctx)
      const name = String(rig || '').trim()
      if (!RIG_NAME_RE.test(name)) throw httpError(400, 'rig name must be a slug (letters, digits, -, _)')
      const workspacePath = workspaceRoot(workspace, ctx)
      const args = ['up', name, '--json', '--yes', '--cwd', workspacePath || '.']
      if (existing) args.push('--existing')
      const { code, stdout, stderr } = await rigControl(ctx, args, 180_000)
      const parsed = parseJson(stdout)
      // `rig up --json` reports failures as exit-0 JSON ({error, code}) — a
      // missing spec must surface as an inline error, not a fake launch.
      if (parsed?.error) throw httpError(400, String(parsed.error).slice(0, 300))
      if (code !== 0 && !parsed) {
        const detail = String(stderr || stdout || '').trim().split('\n').filter(Boolean).slice(-2).join(' ')
        throw httpError(400, detail.slice(0, 300) || 'rig up failed')
      }
      const nodes = Array.isArray(parsed?.nodes) ? parsed.nodes : []
      const count = (state) => nodes.filter((node) => node.status === state).length
      return {
        ok: true,
        rig: parsed?.rigName || name,
        status: parsed?.status || 'launched',
        result: parsed?.rigResult || null,
        attention: count('attention_required'),
        failed: count('failed'),
        fresh: count('fresh-primed'),
        warnings: Array.isArray(parsed?.warnings) ? parsed.warnings.slice(0, 4) : []
      }
    },

    async down(ctx, { rig } = {}) {
      requireAdmin(ctx)
      const name = String(rig || '').trim()
      if (!RIG_NAME_RE.test(name)) throw httpError(400, 'rig name must be a slug (letters, digits, -, _)')
      const { code, stdout, stderr } = await rigControl(ctx, ['down', name, '--json'], 60_000)
      const parsed = parseJson(stdout)
      if (parsed?.error) throw httpError(400, String(parsed.error).slice(0, 300))
      if (code !== 0 && !parsed) {
        const detail = String(stderr || stdout || '').trim().split('\n').filter(Boolean).slice(-2).join(' ')
        throw httpError(400, detail.slice(0, 300) || 'rig down failed')
      }
      return { ok: true, rig: parsed?.rigName || name, alreadyStopped: !!parsed?.alreadyStopped }
    },

    // Named rig specs the user can `rig up` — feeds the boot picker via
    // `rig specs ls` (the library). Older releases lack this subcommand; any
    // failure is just an empty list and the input stays free-text.
    async specs(ctx) {
      requireAdmin(ctx)
      try {
        const parsed = parseJson(await rigRun(ctx, ['specs', 'ls', '--json', '--kind', 'rig']))
        return rowsOf(parsed).map((row) => ({
          name: row.name || row.id || '',
          description: row.summary || row.description || ''
        })).filter((row) => row.name)
      } catch { return [] }
    }
  }
}
