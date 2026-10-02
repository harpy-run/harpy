import fs from 'node:fs'
import path from 'node:path'
import { config } from './config.js'
import { httpError } from './util/http.js'
import { accessFor } from './auth.js'

const knownWorkspaces = new Set()

// Path equality on a case-insensitive filesystem (Windows, default APFS):
// "C:\Repo" and "c:\repo" are the same directory — string compares otherwise
// throw phantom "unknown workspace"/"outside workspace" 403s. realpath
// canonicalizes stored casing when the path exists; non-existent targets
// fall back to the lexical form (still safe — the prefix rule holds).
function canon(p) {
  try { return fs.realpathSync(p) } catch { return p }
}
function sameFsPath(a, b) {
  let x = canon(a)
  let y = canon(b)
  if (process.platform === 'win32') { x = x.toLowerCase(); y = y.toLowerCase() }
  return x === y
}
function isWithin(base, resolved) {
  let a = canon(base)
  let b = canon(resolved)
  if (process.platform === 'win32') { a = a.toLowerCase(); b = b.toLowerCase() }
  return b === a || b.startsWith(a + path.sep)
}

// Per-user active workspace: projects.js installs this resolver at module
// load (it owns workspace.json). Keeping the hook here avoids a
// projects↔workspace import cycle.
let userWorkspaceResolver = null
export function setUserWorkspaceResolver(fn) { userWorkspaceResolver = fn }

export function registerWorkspace(workspacePath) {
  if (!workspacePath) return ''
  const resolved = path.resolve(String(workspacePath))
  knownWorkspaces.add(resolved)
  return resolved
}

export function listKnownWorkspaces() {
  return [...knownWorkspaces]
}

// The stable id a workspace root maps to in the project picker and in
// per-user project allowlists: the managed folder name, or `external:path`.
export function projectIdForPath(resolved) {
  const root = path.resolve(config.projectsDir)
  const relative = path.relative(root, resolved)
  if (relative && !relative.startsWith('..') && !path.isAbsolute(relative) && !relative.includes(path.sep)) return relative
  return `external:${resolved}`
}

// Resolve the workspace carried by a request without mutating the process-wide
// active project. The project picker still updates config.workspace for legacy
// callers, while channel operations can safely finish against the tab that
// created them. When ctx is present the caller's project allowlist applies:
// members may only touch workspaces an admin granted them.
export function workspaceRoot(requested, ctx) {
  const candidate = requested == null || String(requested).trim() === ''
    ? (ctx && userWorkspaceResolver?.(ctx)) || config.workspace
    : String(requested)
  if (!candidate) throw httpError(409, 'workspace is not initialized')
  const resolved = path.resolve(candidate)
  try {
    if (!fs.statSync(resolved).isDirectory()) throw httpError(400, 'workspace is not a folder')
  } catch (error) {
    if (error.status) throw error
    throw httpError(404, 'workspace not found')
  }
  const active = config.workspace ? path.resolve(config.workspace) : ''
  if (!sameFsPath(resolved, active) && ![...knownWorkspaces].some((known) => sameFsPath(known, resolved))) throw httpError(403, 'unknown workspace')
  if (ctx) {
    const access = accessFor(ctx)
    if (!access) throw httpError(401, 'session revoked')
    if (access.projects && !access.projects.has(projectIdForPath(resolved))) {
      throw httpError(403, 'project is not assigned to this account')
    }
  }
  return resolved
}

export function workspacePath(requestedWorkspace, relativePath = '.', ctx, { allowOutside = false } = {}) {
  const base = workspaceRoot(requestedWorkspace, ctx)
  const value = String(relativePath || '.')
  if (value.includes('\0') || value.includes('\n')) throw httpError(400, 'path is invalid')
  const resolved = path.resolve(base, value)
  if (!allowOutside && !isWithin(base, resolved)) throw httpError(403, 'path outside workspace')
  return { base, relative: value, resolved }
}

export function workspaceCwd(requestedWorkspace, cwd = '.', ctx, opts) {
  return workspacePath(requestedWorkspace, cwd, ctx, opts).resolved
}
