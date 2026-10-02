import { computed, signal } from '@preact/signals'

// The signed-in account, decoded from the stored JWT. `role` is the server's
// resolved role ('admin' for the owner account); members carry 'member'.
function readPrincipal() {
  try {
    const token = localStorage.getItem('harpy.token') || ''
    const body = token.split('.')[1]
    if (!body) return null
    const payload = JSON.parse(atob(body.replace(/-/g, '+').replace(/_/g, '/')))
    if (!payload?.exp || Number(payload.exp) < Date.now()) return null
    return {
      sub: payload.sub || '',
      username: payload.username || '',
      role: payload.role === 'owner' ? 'admin' : (payload.role || 'member')
    }
  } catch {
    return null
  }
}
export const principal = signal(readPrincipal())
export const isAdmin = computed(() => principal.value?.role === 'admin')
export function setPrincipal(value) {
  principal.value = value && typeof value === 'object'
    ? { sub: value.sub || '', username: value.username || '', role: value.role === 'owner' ? 'admin' : (value.role || 'member') }
    : null
}

export const theme = signal(localStorage.getItem('harpy.theme') || 'dark')
export const mobileTab = signal('files')
export const activeAgent = signal('')
export const agentSessions = signal([])
export const agentRailOpen = signal(localStorage.getItem('harpy.agentRail') === 'open')
export function setAgentRail(open) {
  agentRailOpen.value = open
  localStorage.setItem('harpy.agentRail', open ? 'open' : 'closed')
}
// The backend exposes one active workspace at a time, while the browser can
// keep several workspace tabs open. Keep the selected record in a signal so
// every view can refresh its data without a full page reload.
function readWorkspace() {
  try {
    const value = JSON.parse(localStorage.getItem('harpy.workspace.active') || 'null')
    return value && typeof value === 'object' ? value : null
  } catch {
    return null
  }
}

export const workspace = signal(readWorkspace())
// Projects list published by ProjectSwitcher so workspace panes can offer a
// picker without re-querying the socket.
export const projects = signal([])
export const openFiles = signal([])
export const activeFile = signal('')
// The preview lives inside the editor tab strip as a sentinel path — it
// persists per workspace and survives file switches like any other tab.
export const PREVIEW_TAB = '$preview'
export const activeView = signal('explorer')
// Sidebar views stack instead of swapping: the rail toggles each view's
// section in/out, so explorer + search + remote can all stay open at once.
// `activeView` keeps tracking the most recently used view (mobile flows and
// the settings takeover still render a single view).
const SIDEBAR_VIEWS = ['explorer', 'search', 'source', 'run', 'agent', 'activity', 'remote', 'extensions']

function readSidebarViews() {
  const raw = localStorage.getItem('harpy.sidebarViews')
  if (raw === null) return ['explorer']
  try {
    const list = JSON.parse(raw)
    return [...new Set((Array.isArray(list) ? list : []).filter((id) => SIDEBAR_VIEWS.includes(id)))]
  } catch {
    return ['explorer']
  }
}

export const sidebarViews = signal(readSidebarViews())

function persistSidebarViews() {
  try { localStorage.setItem('harpy.sidebarViews', JSON.stringify(sidebarViews.value)) } catch { void 0 }
}

// Programmatic opens (shortcuts, command field, file actions) add the view to
// the stack; exclusive=true restores the single-view feel for mobile pickers.
export function showSidebarView(id, { exclusive = false } = {}) {
  if (!SIDEBAR_VIEWS.includes(id)) { activeView.value = id; return }
  activeView.value = id
  if (exclusive) {
    sidebarViews.value = [id]
  } else if (!sidebarViews.value.includes(id)) {
    sidebarViews.value = [...sidebarViews.value, id]
  } else {
    return
  }
  persistSidebarViews()
}

// Rail clicks toggle sections: an open view leaves the stack, a closed one
// joins it — N highlighted rail buttons means N stacked sections.
export function toggleSidebarView(id) {
  if (!SIDEBAR_VIEWS.includes(id)) return
  activeView.value = id
  sidebarViews.value = sidebarViews.value.includes(id)
    ? sidebarViews.value.filter((item) => item !== id)
    : [...sidebarViews.value, id]
  persistSidebarViews()
}

export function isSidebarView(id) {
  return sidebarViews.value.includes(id)
}

export const panelOpen = signal(false)
export const sidebarWidth = signal(Number(localStorage.getItem('harpy.sidebarWidth') || 276))
export const agentWidth = signal(Number(localStorage.getItem('harpy.agentWidth') || 368))
export const panelHeight = signal(Number(localStorage.getItem('harpy.panelHeight') || 260))
export const terminalFontSize = signal(Math.min(18, Math.max(11, Number(localStorage.getItem('harpy.terminalFontSize') || 13.5))))
export const terminalScrollSpeed = signal(Math.min(3, Math.max(0.25, Number(localStorage.getItem('harpy.terminalScrollSpeed') || 1))))

function workspaceKey(record = workspace.value) {
  return String(record?.id || record?.path || 'default')
}

const EDITOR_STATE_KEY = 'harpy.workspace.editorState'
const editorByWorkspace = new Map()
try {
  const stored = JSON.parse(localStorage.getItem(EDITOR_STATE_KEY) || '{}')
  for (const [key, value] of Object.entries(stored || {})) {
    if (Array.isArray(value?.openFiles)) editorByWorkspace.set(key, { openFiles: value.openFiles, activeFile: String(value.activeFile || '') })
  }
} catch {
  // A malformed browser cache should never prevent the workbench from booting.
}

function persistEditorState() {
  try {
    const value = Object.fromEntries([...editorByWorkspace.entries()].slice(-24))
    localStorage.setItem(EDITOR_STATE_KEY, JSON.stringify(value))
  } catch { void 0 }
}

function rememberEditorState(record = workspace.value) {
  // A mounted pane persists its own editor tabs through writeEditorState —
  // while the pane area is up the global openFiles copy is stale, so writing
  // it back here would clobber the pane's authoritative state.
  if (paneAreaVisible.value && leafList().some((leaf) => leaf.projectId === workspaceKey(record))) return
  editorByWorkspace.set(workspaceKey(record), {
    openFiles: [...openFiles.value],
    activeFile: activeFile.value
  })
  persistEditorState()
}

// Workspace panes keep their own editor tab lists but share the same
// per-workspace persistence the classic editor uses.
export function readEditorState(record) {
  return editorByWorkspace.get(workspaceKey(record)) || { openFiles: [], activeFile: '' }
}

export function writeEditorState(record, state) {
  editorByWorkspace.set(workspaceKey(record), {
    openFiles: [...(state?.openFiles || [])],
    activeFile: String(state?.activeFile || '')
  })
  persistEditorState()
}

export function setWorkspace(record) {
  if (!record || typeof record !== 'object') return
  const previous = workspace.value
  if (previous && workspaceKey(previous) !== workspaceKey(record)) rememberEditorState(previous)
  workspace.value = { ...record }
  const next = editorByWorkspace.get(workspaceKey(record)) || { openFiles: [], activeFile: '' }
  openFiles.value = [...next.openFiles]
  activeFile.value = next.activeFile || ''
  try { localStorage.setItem('harpy.workspace.active', JSON.stringify(workspace.value)) } catch { void 0 }
  syncPanesToWorkspace(record)
}

export function setTheme(value) {
  theme.value = value === 'light' ? 'light' : 'dark'
  localStorage.setItem('harpy.theme', theme.value)
  document.documentElement.dataset.theme = theme.value
}

export function openFile(filePath) {
  // While the pane area is up the classic editor is hidden — route the open
  // to the focused workspace pane instead of swallowing it silently.
  if (paneAreaVisible.value && openFileInActivePane(filePath)) {
    mobileTab.value = 'editor'
    return
  }
  if (!openFiles.value.includes(filePath)) openFiles.value = [...openFiles.value, filePath]
  activeFile.value = filePath
  rememberEditorState()
  mobileTab.value = 'editor'
}

export function openPreview() {
  openFile(PREVIEW_TAB)
}

// Extension detail pages reuse the same sentinel-tab trick as the preview:
// `$extension:<id>` opens inside the editor area instead of the sidebar.
export const EXTENSION_TAB_PREFIX = '$extension:'

export function openExtension(id) {
  openFile(`${EXTENSION_TAB_PREFIX}${id}`)
}

// Set before switching to the explorer — FileTree consumes it on mount, so a
// create-file request survives the race where the view (and its listeners)
// was not mounted yet when the request event fired.
export const pendingFileAction = signal(null)

// Fullscreen CLI mode: the active agent session's terminal takes the whole
// window with every piece of panel chrome hidden — pure CLI, Esc to leave.
export const agentFullscreen = signal(false)

export function closeFile(filePath) {
  const next = openFiles.value.filter((item) => item !== filePath)
  openFiles.value = next
  if (activeFile.value === filePath) activeFile.value = next.at(-1) || ''
  rememberEditorState()
}

export function setSidebarWidth(value) {
  const numeric = Number(value)
  sidebarWidth.value = numeric <= 0 ? 0 : Math.min(480, Math.max(220, Math.round(numeric)))
  localStorage.setItem('harpy.sidebarWidth', String(sidebarWidth.value))
}

export function setAgentWidth(value) {
  agentWidth.value = Math.min(560, Math.max(300, Math.round(value)))
  localStorage.setItem('harpy.agentWidth', String(agentWidth.value))
}

export function setPanelHeight(value) {
  panelHeight.value = Math.min(520, Math.max(150, Math.round(value)))
  localStorage.setItem('harpy.panelHeight', String(panelHeight.value))
}

export function setTerminalFontSize(value) {
  const numeric = Math.min(18, Math.max(11, Number(value) || 13.5))
  terminalFontSize.value = Math.round(numeric * 2) / 2
  localStorage.setItem('harpy.terminalFontSize', String(terminalFontSize.value))
}

export function setTerminalScrollSpeed(value) {
  const numeric = Math.min(3, Math.max(0.25, Number(value) || 1))
  terminalScrollSpeed.value = Math.round(numeric * 4) / 4
  localStorage.setItem('harpy.terminalScrollSpeed', String(terminalScrollSpeed.value))
}

/* === Workspace panes =======================================================
 * Two workbench modes: 'normal' is the classic shell; 'agents' turns the whole
 * workbench into a grid of per-workspace agent terminals. Both modes support a
 * split layout stored as a binary tree:
 *   leaf  = { type: 'pane', id, projectId, name, path }
 *   split = { type: 'split', id, dir: 'row'|'col', ratio, a, b }
 * Normal mode keeps the classic UI while its tree is null (max 2 panes);
 * agents mode always renders the pane area (max 4, a null tree means a single
 * implicit pane bound to the active workspace). Everything persists under
 * 'harpy.paneLayout' so the user's arrangement survives reloads.
 */

export const viewMode = signal(localStorage.getItem('harpy.viewMode') === 'agents' ? 'agents' : 'normal')
export const activePaneId = signal('')
export const draggingWorkspace = signal(null)

const PANES_KEY = 'harpy.paneLayout'
const MAX_PANES = { normal: 2, agents: 4 }

function readLayouts() {
  try {
    const value = JSON.parse(localStorage.getItem(PANES_KEY) || '{}')
    return {
      normal: sanitizeNode(value?.normal, 'normal'),
      agents: sanitizeNode(value?.agents, 'agents')
    }
  } catch {
    return { normal: null, agents: null }
  }
}

// Drop malformed/capped nodes instead of trusting stale storage blindly.
function sanitizeNode(node, mode) {
  if (!node || typeof node !== 'object') return null
  if (node.type === 'pane') {
    if (!node.id || !node.path) return null
    return { type: 'pane', id: String(node.id), projectId: String(node.projectId || node.path), name: String(node.name || node.path), path: String(node.path) }
  }
  if (node.type === 'split') {
    const a = sanitizeNode(node.a, mode)
    const b = sanitizeNode(node.b, mode)
    if (!a) return b
    if (!b) return a
    const leaves = paneLeaves(a).length + paneLeaves(b).length
    if (leaves > MAX_PANES[mode]) return a
    return { type: 'split', id: String(node.id || uid()), dir: node.dir === 'row' ? 'row' : 'col', ratio: clampRatio(node.ratio), a, b }
  }
  return null
}

export const paneLayouts = signal(readLayouts())

export const paneAreaVisible = computed(() =>
  viewMode.value === 'agents' || !!paneLayouts.value.normal)

let paneCounter = 0
function uid() {
  paneCounter += 1
  return `pane_${Date.now().toString(36)}_${paneCounter}`
}

function clampRatio(value) {
  const numeric = Number(value)
  return Number.isFinite(numeric) ? Math.min(0.85, Math.max(0.15, numeric)) : 0.5
}

function persistLayouts() {
  try { localStorage.setItem(PANES_KEY, JSON.stringify(paneLayouts.value)) } catch { void 0 }
}

export function paneTree(mode = viewMode.value) {
  return paneLayouts.value[mode] || null
}

export function maxPanes(mode = viewMode.value) {
  return MAX_PANES[mode] || 2
}

export function paneLeaves(tree = paneTree()) {
  if (!tree) return []
  return tree.type === 'pane' ? [tree] : [...paneLeaves(tree.a), ...paneLeaves(tree.b)]
}

// The implicit leaf used when agents mode has no stored tree yet: it follows
// the global workspace so the first agent pane always shows something useful.
export function implicitLeaf() {
  const record = workspace.value || {}
  return { type: 'pane', id: 'implicit', projectId: String(record.id || record.path || ''), name: record.name || record.path || '', path: record.path || '' }
}

export function leafList(mode = viewMode.value) {
  const tree = paneTree(mode)
  return tree ? paneLeaves(tree) : (mode === 'agents' ? [implicitLeaf()] : [])
}

// A pane's color slot is its position in the visible leaf order. Workspace
// tabs read the same index so each on-screen pane and its tab wear matching
// colors — workspaces not on screen return -1 and render muted.
export function paneColorIndex(projectId, mode = viewMode.value) {
  const key = String(projectId || '')
  return leafList(mode).findIndex((leaf) => leaf.projectId === key)
}

function setTree(mode, tree) {
  // Normal mode collapses back to the classic shell once only one leaf
  // remains; agents mode may keep a single explicit leaf.
  if (mode === 'normal' && tree && tree.type === 'pane') {
    const leaf = tree
    // Clear the tree first so setWorkspace's pane sync sees normal mode as
    // unsplit, then let the regular switch path restore editor state.
    paneLayouts.value = { ...paneLayouts.value, [mode]: null }
    persistLayouts()
    if (workspaceKey(workspace.value) !== leaf.projectId) {
      setWorkspace({ id: leaf.projectId, name: leaf.name, path: leaf.path })
    } else {
      // Same workspace: the pane wrote the authoritative tab state while the
      // global signals sat stale — reload them so the classic editor reopens
      // exactly what the pane showed.
      const saved = editorByWorkspace.get(leaf.projectId)
      if (saved) {
        openFiles.value = [...saved.openFiles]
        activeFile.value = saved.activeFile || ''
      }
    }
    return
  }
  paneLayouts.value = { ...paneLayouts.value, [mode]: tree }
  persistLayouts()
}

function findLeaf(node, id) {
  if (!node) return null
  if (node.type === 'pane') return node.id === id ? node : null
  return findLeaf(node.a, id) || findLeaf(node.b, id)
}

export function paneLeaf(id, mode = viewMode.value) {
  const tree = paneTree(mode)
  if (!tree) return implicitLeaf().id === id ? implicitLeaf() : null
  return findLeaf(tree, id)
}

// Replace the leaf `targetId` with a split containing it plus `leaf`, or wrap
// the root when targetId is null.
function spliceLeaf(node, targetId, dir, after, leaf) {
  if (!node) return null
  if (node.type === 'pane') {
    if (node.id !== targetId) return node
    return { type: 'split', id: uid(), dir, ratio: 0.5, a: after ? node : leaf, b: after ? leaf : node }
  }
  return { ...node, a: spliceLeaf(node.a, targetId, dir, after, leaf) || node.a, b: spliceLeaf(node.b, targetId, dir, after, leaf) || node.b }
}

function removeLeaf(node, id) {
  if (!node) return { node: null, removed: null }
  if (node.type === 'pane') return node.id === id ? { node: null, removed: node } : { node, removed: null }
  const left = removeLeaf(node.a, id)
  if (left.removed) return { node: left.node ? { ...node, a: left.node } : node.b, removed: left.removed }
  const right = removeLeaf(node.b, id)
  if (right.removed) return { node: right.node ? { ...node, b: right.node } : node.a, removed: right.removed }
  return { node, removed: null }
}

// Drop a workspace record into the layout. `targetId` null targets the root
// edge; `dir`+`after` say which side the new pane lands on. Dropping a record
// that is already a leaf moves it.
export function insertPane(record, targetId, dir, after) {
  const mode = viewMode.value
  const projectId = String(record?.projectId || record?.id || record?.path || '')
  const path = String(record?.path || '')
  if (!path) return false
  const leaf = { type: 'pane', id: uid(), projectId, name: String(record?.name || path), path }
  let tree = paneTree(mode)
  if (!tree) {
    const base = implicitLeaf()
    if (!base.path) return false
    tree = { ...base, id: uid() }
  }
  const leaves = paneLeaves(tree)
  const source = leaves.find((item) => item.projectId === projectId)
  // Splitting a lone pane on itself would duplicate the same workspace.
  if (source && leaves.length === 1) return false
  if (source && targetId === source.id) return false
  if (!source && leaves.length >= maxPanes(mode)) return false
  if (source) {
    const result = removeLeaf(tree, source.id)
    tree = result.node
    if (!tree) {
      // The dragged leaf was the only pane — treat as a no-op reorder.
      tree = source
      paneLayouts.value = { ...paneLayouts.value, [mode]: tree }
      persistLayouts()
      return true
    }
  }
  const next = targetId ? spliceLeaf(tree, targetId, dir, after, leaf) : { type: 'split', id: uid(), dir, ratio: 0.5, a: after ? tree : leaf, b: after ? leaf : tree }
  if (!next) return false
  setTree(mode, next)
  // The freshly dropped workspace becomes the focused pane — and the global
  // workspace — so terminals/git follow where the user is working.
  focusPane(leaf.id)
  animateSplitOpen(mode, leaf.id, after)
  return true
}

// The split that directly parents a leaf — the node whose ratio should
// animate when a new pane opens beside it.
function parentSplitOf(node, leafId) {
  if (!node || node.type !== 'split') return null
  if ((node.a?.type === 'pane' && node.a.id === leafId) || (node.b?.type === 'pane' && node.b.id === leafId)) return node
  return parentSplitOf(node.a, leafId) || parentSplitOf(node.b, leafId)
}

// OS "reduce motion" opt-out — JS-driven ratio tweens must honor it the same
// way the global CSS media rule neutralizes declarative animations.
function reducedMotion() {
  try { return matchMedia('(prefers-reduced-motion: reduce)').matches } catch { return false }
}

// The leaf currently animating closed — PaneLeaf dims/disables it so a
// shrinking pane stops eating pointer events.
export const closingPaneId = signal('')

// Opening animation: the new pane grows from a sliver to half so the existing
// content visibly shrinks aside instead of snapping. Runs through the same
// setPaneRatio path as sash drags, so persistence stays consistent.
function animateSplitOpen(mode, leafId, after) {
  const parent = parentSplitOf(paneTree(mode), leafId)
  if (!parent || reducedMotion()) return
  const from = after ? 0.85 : 0.15
  const startedAt = performance.now()
  const duration = 220
  setPaneRatio(parent.id, from)
  const tick = (now) => {
    // Bail if the split went away mid-animation or the user grabbed a sash.
    if (!parentSplitOf(paneTree(mode), leafId) || document.body.classList.contains('is-resizing')) return
    const progress = Math.min(1, (now - startedAt) / duration)
    const eased = 1 - Math.pow(1 - progress, 3)
    setPaneRatio(parent.id, from + (0.5 - from) * eased)
    if (progress < 1) requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
}

// Closing is the mirror of opening: the departing leaf's parent split animates
// toward it so the survivor expands smoothly, THEN the leaf leaves the tree.
function animateSplitClosed(mode, leafId, done) {
  const parent = parentSplitOf(paneTree(mode), leafId)
  if (!parent || reducedMotion()) { done(); return }
  const closingA = parent.a?.type === 'pane' && parent.a.id === leafId
  const target = closingA ? 0.001 : 0.999
  const from = parent.ratio
  const startedAt = performance.now()
  const duration = 190
  const tick = (now) => {
    const progress = Math.min(1, (now - startedAt) / duration)
    const gone = !parentSplitOf(paneTree(mode), leafId)
    // Whatever interrupted the shrink — a sash grab, the leaf leaving — the
    // close still lands; the animation is cosmetic, never the gatekeeper.
    if (gone || progress >= 1 || document.body.classList.contains('is-resizing')) { done(); return }
    const eased = 1 - Math.pow(1 - progress, 3)
    setPaneRatio(parent.id, from + (target - from) * eased)
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
}

export function removePane(id) {
  const mode = viewMode.value
  const tree = paneTree(mode)
  if (!tree) return
  const finish = () => {
    closingPaneId.value = ''
    const { node } = removeLeaf(paneTree(mode), id)
    setTree(mode, node || null)
    if (activePaneId.value === id) {
      // Keep focus coherent: the surviving leaf becomes active and, where a
      // leaf remains visible, the global workspace follows it.
      const next = paneLeaves(node)[0]
      if (next) focusPane(next.id)
      else activePaneId.value = ''
    }
  }
  // A lone leaf has no sibling to expand into — close instantly (the area's
  // own exit fade still softens the handoff back to the classic UI).
  if (!parentSplitOf(tree, id)) { finish(); return }
  closingPaneId.value = id
  animateSplitClosed(mode, id, finish)
}

export function rebindPane(id, record) {
  const mode = viewMode.value
  const projectId = String(record?.id || record?.path || '')
  const patch = (node) => {
    if (!node) return null
    if (node.type === 'pane') return node.id === id ? { ...node, projectId, name: String(record?.name || node.name), path: String(record?.path || node.path) } : node
    return { ...node, a: patch(node.a), b: patch(node.b) }
  }
  const tree = paneTree(mode)
  if (!tree) return
  setTree(mode, patch(tree))
}

export function setPaneRatio(id, ratio) {
  const patch = (node) => {
    if (!node) return null
    if (node.type === 'split') return node.id === id ? { ...node, ratio: clampRatio(ratio) } : { ...node, a: patch(node.a), b: patch(node.b) }
    return node
  }
  const mode = viewMode.value
  const tree = paneTree(mode)
  if (!tree) return
  paneLayouts.value = { ...paneLayouts.value, [mode]: patch(tree) }
  persistLayouts()
}

export function setViewMode(mode) {
  viewMode.value = mode === 'agents' ? 'agents' : 'normal'
  localStorage.setItem('harpy.viewMode', viewMode.value)
}

export function focusPane(id) {
  const leaf = paneLeaf(id)
  if (!leaf) return
  activePaneId.value = id
  if (workspaceKey(workspace.value) !== leaf.projectId) {
    const record = { id: leaf.projectId, name: leaf.name, path: leaf.path }
    setWorkspace(record)
    // Views that listen for explicit switches (terminals, git) still need the
    // fan-out — pane focus is a workspace change as far as they are concerned.
    window.dispatchEvent(new CustomEvent('harpy:workspace-change', { detail: record }))
  }
}

// Called from setWorkspace: when the pane area is up and a leaf already shows
// that project, just focus it. Leaves are NOT rebound here — boot-time
// setWorkspace must not shuffle the saved arrangement. Explicit tab clicks
// rebind through bindWorkspaceToPane instead.
function syncPanesToWorkspace(record) {
  const tree = paneTree()
  if (!tree) return
  const leaves = paneLeaves(tree)
  const key = String(record?.id || record?.path || '')
  const existing = leaves.find((leaf) => leaf.projectId === key)
  if (existing) { activePaneId.value = existing.id; return }
  // The workspace the server selected is not one of the panes — still give
  // focus to a real leaf so pane-targeted actions (new agent, open file)
  // land somewhere visible instead of nowhere.
  if (!leaves.some((leaf) => leaf.id === activePaneId.value)) activePaneId.value = leaves[0]?.id || ''
}

// Explicit user activation (workspace tab click / new workspace): focus the
// leaf already showing that project when there is one. Otherwise agents mode
// appends a new pane while capacity remains — a workspace that "opens" must
// be visible — and beyond the cap the focused leaf rebinds to it. Normal
// mode always rebinds the focused leaf (its cap is two, splitting on every
// tab click would fight the user).
export function bindWorkspaceToPane(record) {
  const mode = viewMode.value
  const tree = paneTree(mode)
  const key = String(record?.id || record?.path || '')
  if (!tree) {
    // Agents mode accrues panes: activating a different workspace while the
    // implicit single pane is up splits it in instead of silently swapping
    // the pane's contents — the previous workspace stays on screen.
    // Callers must invoke this before setWorkspace so the implicit base
    // still reads the workspace being left.
    if (mode === 'agents' && record?.path) {
      const base = implicitLeaf()
      if (base.path && base.projectId !== key) {
        insertPane({ projectId: key, name: record.name, path: record.path }, null, 'row', true)
      }
    }
    return
  }
  const leaves = paneLeaves(tree)
  const existing = leaves.find((leaf) => leaf.projectId === key)
  if (existing) {
    activePaneId.value = existing.id
    return
  }
  if (mode === 'agents' && leaves.length < maxPanes(mode) && record?.path) {
    insertPane({ projectId: key, name: record.name, path: record.path }, null, 'row', true)
    return
  }
  const target = leaves.find((leaf) => leaf.id === activePaneId.value) || leaves[0]
  if (target) rebindPane(target.id, record)
}

// Remove leaves whose project disappeared from the granted project list.
export function prunePanes() {
  const available = new Set(projects.value.map((project) => String(project.id)))
  if (!available.size) return
  for (const mode of ['normal', 'agents']) {
    const tree = paneLayouts.value[mode]
    if (!tree) continue
    const prune = (node) => {
      if (node.type === 'pane') return available.has(node.projectId) ? node : null
      const a = prune(node.a)
      const b = prune(node.b)
      if (!a) return b
      if (!b) return a
      return { ...node, a, b }
    }
    const next = prune(tree)
    if (next !== tree) setTree(mode, next)
  }
}

// Pane-scoped file opening: each pane registers an opener; global openFile()
// routes to the focused pane while the pane area is up.
const paneFileHandlers = new Map()
export function registerPaneFileHandler(paneId, handler) {
  paneFileHandlers.set(paneId, handler)
  return () => paneFileHandlers.delete(paneId)
}

export function openFileInActivePane(filePath) {
  const leaves = leafList()
  const target = leaves.find((leaf) => leaf.id === activePaneId.value) || leaves[0]
  const handler = target && paneFileHandlers.get(target.id)
  return handler ? handler(filePath) : false
}

setTheme(theme.value)
