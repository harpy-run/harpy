import { requireAccess, requireAdmin } from '../auth.js'
import { workspaceRoot } from '../workspace.js'
import { fireAutomation, listAutomations, readAutomation, removeAutomation, saveAutomation, toggleAutomation } from '../automations.js'

export const automationChannel = {
  ops: {
    list: (ctx, { workspace } = {}) => {
      const access = requireAccess(ctx)
      const items = listAutomations(workspaceRoot(workspace, ctx))
      // The webhook HMAC secret is a bearer credential for /api/hooks/<slug>
      // — members get the list but never the signing key.
      return access.admin ? items : items.map((a) => ({ ...a, webhookSecret: null }))
    },
    read: (ctx, { workspace, slug } = {}) => { requireAccess(ctx); return readAutomation(workspaceRoot(workspace, ctx), slug) },
    // Definitions are agent-facing config that can spawn CLIs — admin only.
    save: (ctx, { workspace, slug, content } = {}) => { requireAdmin(ctx); return saveAutomation(workspaceRoot(workspace, ctx), slug, content) },
    remove: (ctx, { workspace, slug } = {}) => { requireAdmin(ctx); return removeAutomation(workspaceRoot(workspace, ctx), slug) },
    toggle: (ctx, { workspace, slug, enabled } = {}) => { requireAdmin(ctx); return toggleAutomation(workspaceRoot(workspace, ctx), slug, !!enabled) },
    runNow: (ctx, { workspace, slug } = {}) => { requireAdmin(ctx); return fireAutomation(workspaceRoot(workspace, ctx), slug, { trigger: 'manual' }) }
  }
}
