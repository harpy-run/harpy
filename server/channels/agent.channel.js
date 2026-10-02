import { listAgents, preferredAgentId } from '../agents/adapter.js'
import { ownerKey, requireAccess, requireSelfOrAdmin } from '../auth.js'
import { httpError } from '../util/http.js'
import { cliEnvInfo, saveCliEnv } from '../cli-env.js'
import { ensureMemory, listHandoffs, readHandoff, removeMemoryEverywhere } from '../handoffs.js'
import { memoryPrefsFor, saveMemoryPrefs } from '../memory.js'
import { installSkillRepo, listSkills, removeSkill, skillsDirFor } from '../skills.js'
import { workspaceRoot } from '../workspace.js'
import { closeRunner, detachSubscriber, getHistory, inputRunner, listChangedFiles, listPresence, listSessions, resizeRunner, sendToRunner, startRunner, stopRunner, unwatchRunner, wakeRunner, watchRunner } from '../agents/runner.js'

// Shared gate for the skills ops: `for` is admin-only, and user scope writes
// into a home dir — with no private home that is the daemon's own
// ~/.claude/skills, shared by every account, so it needs admin rights (or a
// member who actually owns a private home).
function skillsTarget(ctx, { scope, target, workspace }) {
  const self = ctx?.principal?.sub || 'owner'
  const sub = target ? String(target) : self
  const access = requireSelfOrAdmin(ctx, target ? sub : null)
  if (scope !== 'workspace' && !access.admin && !cliEnvInfo(sub).home) {
    throw httpError(403, 'user-scope skills require a private CLI home')
  }
  const base = scope === 'workspace' ? workspaceRoot(workspace, ctx) : ''
  return { sub, base }
}

export const agentChannel = {
  ops: {
    agents: async (ctx, { refresh } = {}) => {
      const access = requireAccess(ctx)
      const agents = await listAgents({ refresh: !!refresh })
      // The operator's configured pick rides the list so the UI and any
      // remote surface preselect it instead of "first available" — the
      // shell's /use writes the same cli.json key.
      const preferred = await preferredAgentId()
      const marked = agents.map((agent) => ({ ...agent, preferred: agent.id === preferred }))
      return access.agents ? marked.filter((agent) => access.agents.has(agent.id)) : marked
    },
    start: (ctx, data = {}) => {
      const access = requireAccess(ctx)
      if (access.agents && !access.agents.has(String(data.agent || ''))) throw httpError(403, 'agent is not assigned to this account')
      // Forward only the public fields — in particular `automation` stays
      // server-owned, because it relaxes the cwd workspace check.
      const { agent, prompt, cwd, workspace, cols, rows, team } = data
      return startRunner(ctx, { agent, prompt, cwd, workspace, cols, rows, team })
    },
    input: (ctx, { sessionId, data } = {}) => inputRunner(ctx, sessionId, data),
    resize: (ctx, { sessionId, cols, rows } = {}) => resizeRunner(ctx, sessionId, cols, rows),
    send: (ctx, { sessionId, text } = {}) => sendToRunner(ctx, sessionId, text),
    stop: (ctx, { sessionId } = {}) => stopRunner(ctx, sessionId),
    wake: (ctx, { sessionId } = {}) => wakeRunner(ctx, sessionId),
    close: (ctx, { sessionId } = {}) => closeRunner(ctx, sessionId),
    sessions: (ctx, { workspace } = {}) => listSessions(ctx, workspace),
    history: (ctx, { sessionId } = {}) => getHistory(ctx, sessionId),
    presence: (ctx) => { requireAccess(ctx); return listPresence(ctx) },
    watch: (ctx, { sessionId } = {}) => { requireAccess(ctx); return watchRunner(ctx, sessionId) },
    unwatch: (ctx, { sessionId } = {}) => unwatchRunner(ctx, sessionId),
    changedFiles: (ctx, { sessionId } = {}) => { requireAccess(ctx); return listChangedFiles(ctx, sessionId) },
    // Session handoffs + shared workspace memory: workspaceRoot() applies the
    // caller's project allowlist before any file under .harpy/ is touched.
    handoffs: (ctx, { workspace } = {}) => listHandoffs(workspaceRoot(workspace, ctx)),
    handoff: (ctx, { workspace, name } = {}) => ({ content: readHandoff(workspaceRoot(workspace, ctx), name) }),
    memory: (ctx, { workspace } = {}) => ({ path: ensureMemory(workspaceRoot(workspace, ctx), ctx?.principal?.sub || 'owner') }),
    // `memory` is the master switch for the whole .harpy/ integration;
    // `digest` only gates the background CLI run that distills handoffs.
    // Turning memory off also wipes .harpy/ + the AGENTS.md pointer block
    // from every workspace the caller may reach — off means gone.
    memoryPrefs: (ctx) => { requireAccess(ctx); return memoryPrefsFor(ctx?.principal?.sub || 'owner') },
    saveMemoryPrefs: (ctx, { memory, digest } = {}) => {
      const access = requireAccess(ctx)
      const sub = ctx?.principal?.sub || 'owner'
      const prefs = saveMemoryPrefs(sub, { memory, digest })
      if (memory === false) removeMemoryEverywhere({ allowlist: access.projects || null })
      return prefs
    },
    // Broadcast the same prompt to several running sessions — each target is
    // validated by sendToRunner's own write check, so a member can never
    // reach a session they could not type into directly.
    broadcast: (ctx, { sessionIds, text } = {}) => {
      requireAccess(ctx)
      const ids = Array.isArray(sessionIds) ? [...new Set(sessionIds)].slice(0, 20) : []
      if (!ids.length) throw httpError(400, 'sessionIds required')
      if (!String(text || '').trim()) throw httpError(400, 'text required')
      return {
        results: ids.map((id) => {
          try { sendToRunner(ctx, id, text); return { sessionId: id, ok: true } }
          catch (error) { return { sessionId: id, error: error.message } }
        })
      }
    },
    // Agent skill manager: installs SKILL.md collections from a git repo into
    // the agent's skills dir. `for` manages another user's private home
    // (admin-only); `workspace` scope installs into .claude/skills inside the
    // project — the same allowlist the fs ops use applies via workspaceRoot.
    skills: (ctx, params = {}) => {
      const { sub, base } = skillsTarget(ctx, params)
      return { skills: listSkills(skillsDirFor({ agent: params.agent, scope: params.scope, sub, workspace: base })) }
    },
    skillInstall: async (ctx, params = {}) => {
      const { sub, base } = skillsTarget(ctx, params)
      const dir = skillsDirFor({ agent: params.agent, scope: params.scope, sub, workspace: base })
      return installSkillRepo({ repo: params.repo, dir })
    },
    skillRemove: (ctx, params = {}) => {
      const { sub, base } = skillsTarget(ctx, params)
      return removeSkill(skillsDirFor({ agent: params.agent, scope: params.scope, sub, workspace: base }), params.name)
    },
    // Per-user CLI environment: names-only view (values are write-only) plus
    // the private-home toggle. Any signed-in user manages their own record;
    // admins may pass `for` to manage a member's (e.g. grant a private home
    // so the member signs in to claude/devin/gh with their own account).
    cliEnv: (ctx, { for: target } = {}) => {
      requireSelfOrAdmin(ctx, target ? String(target) : null)
      return cliEnvInfo(target ? String(target) : ownerKey(ctx))
    },
    saveCliEnv: (ctx, { for: target, env, home } = {}) => {
      requireSelfOrAdmin(ctx, target ? String(target) : null)
      return saveCliEnv(target ? String(target) : ownerKey(ctx), { env, home })
    }
  },
  onClose(ctx) { detachSubscriber(ctx) }
}
