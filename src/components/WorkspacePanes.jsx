import { useEffect, useRef, useState } from 'preact/hooks'
import { ws } from '../lib/ws.js'
import { t } from '../lib/i18n.js'
import { lazyView } from '../lib/lazy.jsx'
import { FileTree } from './FileTree.jsx'
import { X, Files, FolderOpen, Bot } from '../lib/icons.jsx'
import {
  activePaneId, closingPaneId, draggingWorkspace, focusPane, implicitLeaf, insertPane, leafList, maxPanes,
  paneLeaf, paneTree, rebindPane, registerPaneFileHandler,
  removePane, setPaneRatio, setWorkspace, viewMode, readEditorState, writeEditorState
} from '../state/app.js'

// Heavy views load on first use — same code-split pattern as the shell.
const AgentPanel = lazyView(() => import('./AgentPanel.jsx'), 'AgentPanel')
const Editor = lazyView(() => import('./EditorPane.jsx'), 'Editor')

// Leaf header: workspace name + close, same in both modes — workspaces are
// picked from the topbar tabs (click to bind the focused pane, drag to split),
// not from a per-pane picker.
function PaneHeader({ leaf, single }) {
  return (
    <header class="pane-leaf-header">
      <FolderOpen size={13} class="pane-leaf-icon" />
      <span class="pane-leaf-title" title={leaf.path}>{leaf.name}</span>
      {!single && (
        <button type="button" class="pane-leaf-close" title={t('pane.close')} aria-label={t('pane.close')}
          onClick={(event) => { event.stopPropagation(); removePane(leaf.id) }}>
          <X size={12} />
        </button>
      )}
    </header>
  )
}

// Resizable divider between two split children. Ratio is stored on the split
// node so the layout survives reloads.
function PaneSash({ node }) {
  const ref = useRef(null)
  function begin(event) {
    event.preventDefault()
    event.stopPropagation()
    const sash = ref.current
    const parent = sash?.parentElement
    if (!parent) return
    const rect = parent.getBoundingClientRect()
    const horizontal = node.dir === 'row'
    const size = horizontal ? rect.width : rect.height
    const start = horizontal ? event.clientX : event.clientY
    const startRatio = node.ratio
    sash.setPointerCapture?.(event.pointerId)
    const move = (moveEvent) => {
      const next = horizontal ? moveEvent.clientX : moveEvent.clientY
      if (size > 0) setPaneRatio(node.id, startRatio + (next - start) / size)
    }
    const end = () => {
      document.body.classList.remove('is-resizing')
      document.removeEventListener('pointermove', move)
      document.removeEventListener('pointerup', end)
      document.removeEventListener('pointercancel', end)
      window.dispatchEvent(new Event('harpy:panel-visibility'))
    }
    document.body.classList.add('is-resizing')
    document.addEventListener('pointermove', move)
    document.addEventListener('pointerup', end, { once: true })
    document.addEventListener('pointercancel', end, { once: true })
  }
  return <div ref={ref} class={`pane-sash ${node.dir === 'row' ? 'vertical' : 'horizontal'}`} role="separator"
    aria-orientation={node.dir === 'row' ? 'vertical' : 'horizontal'} onPointerDown={begin} />
}

function readDrag(event) {
  try {
    return JSON.parse(event.dataTransfer.getData('application/x-harpy-workspace') || 'null')
  } catch {
    return null
  }
}

// Inner section widths (file tree / agent panel) persist per pane id, so a
// split keeps the exact proportions the user dialed in across reloads.
const PANE_INNER_KEY = 'harpy.paneInnerWidths'
const INNER_LIMITS = { tree: [120, 460], agent: [200, 560] }

function clampInner(key, value) {
  const [min, max] = INNER_LIMITS[key]
  const numeric = Number(value)
  return Number.isFinite(numeric) ? Math.min(max, Math.max(min, Math.round(numeric))) : 0
}

function readPaneWidths(paneId) {
  try {
    const entry = JSON.parse(localStorage.getItem(PANE_INNER_KEY) || '{}')?.[paneId]
    return {
      tree: clampInner('tree', entry?.tree) || 190,
      agent: clampInner('agent', entry?.agent) || 270
    }
  } catch {
    return { tree: 190, agent: 270 }
  }
}

function writePaneWidths(paneId, widths) {
  try {
    const all = JSON.parse(localStorage.getItem(PANE_INNER_KEY) || '{}')
    all[paneId] = widths
    localStorage.setItem(PANE_INNER_KEY, JSON.stringify(all))
  } catch { void 0 }
}

// Slim vertical sash between a pane's inner sections (rail | tree | editor |
// agents). Mirrors PaneSash's drag handling but reports pixel deltas to the
// owning workbench instead of rewriting the split tree.
function PaneInnerSash({ onDelta, onEnd }) {
  function begin(event) {
    event.preventDefault()
    event.stopPropagation()
    event.currentTarget.setPointerCapture?.(event.pointerId)
    let last = event.clientX
    const move = (moveEvent) => {
      onDelta(moveEvent.clientX - last)
      last = moveEvent.clientX
    }
    const end = () => {
      document.body.classList.remove('is-resizing')
      document.removeEventListener('pointermove', move)
      document.removeEventListener('pointerup', end)
      document.removeEventListener('pointercancel', end)
      window.dispatchEvent(new Event('harpy:panel-visibility'))
      onEnd?.()
    }
    document.body.classList.add('is-resizing')
    document.addEventListener('pointermove', move)
    document.addEventListener('pointerup', end, { once: true })
    document.addEventListener('pointercancel', end, { once: true })
  }
  return <div class="pane-sash vertical pane-inner-sash" role="separator" aria-orientation="vertical" onPointerDown={begin} />
}

// Normal-mode pane body — the same workbench as the classic shell in
// miniature: a slim rail with tree/agent toggles, the file tree, editor tabs
// and the pane's own agent terminal panel. Editor tabs persist per workspace
// via the shared editor-state store.
function PaneWorkbench({ leaf }) {
  const record = { id: leaf.projectId, name: leaf.name, path: leaf.path }
  const [treeOpen, setTreeOpen] = useState(true)
  const [agentOpen, setAgentOpen] = useState(true)
  const widthsRef = useRef(readPaneWidths(leaf.id))
  const [treeW, setTreeW] = useState(widthsRef.current.tree)
  const [agentW, setAgentW] = useState(widthsRef.current.agent)
  function resizeTree(delta) {
    widthsRef.current.tree = clampInner('tree', widthsRef.current.tree + delta)
    setTreeW(widthsRef.current.tree)
  }
  function resizeAgent(delta) {
    widthsRef.current.agent = clampInner('agent', widthsRef.current.agent - delta)
    setAgentW(widthsRef.current.agent)
  }
  const saveWidths = () => writePaneWidths(leaf.id, widthsRef.current)
  const [editorState, setEditorState] = useState(() => readEditorState(record))
  const [dirty, setDirty] = useState({})
  const { openFiles: files, activeFile: active } = editorState

  useEffect(() => { writeEditorState(record, editorState) }, [editorState])

  const openPath = (path) => {
    if (String(path).startsWith('$')) return false
    setEditorState((current) => ({
      openFiles: current.openFiles.includes(path) ? current.openFiles : [...current.openFiles, path],
      activeFile: path
    }))
    return true
  }

  useEffect(() => registerPaneFileHandler(leaf.id, openPath), [leaf.id])

  function close(path) {
    if (dirty[path] && !window.confirm(t('editor.closeDirty'))) return
    setEditorState((current) => {
      const files = current.openFiles.filter((item) => item !== path)
      return { openFiles: files, activeFile: current.activeFile === path ? (files.at(-1) || '') : current.activeFile }
    })
    setDirty((current) => { const next = { ...current }; delete next[path]; return next })
  }

  return (
    <div class="pane-workbench">
      <div class="pane-rail">
        <button type="button" class={`pane-rail-btn ${treeOpen ? 'open' : ''}`} title={t('pane.toggleFiles')}
          aria-label={t('pane.toggleFiles')} aria-pressed={treeOpen} onClick={() => setTreeOpen((open) => !open)}>
          <Files size={13} />
        </button>
        <button type="button" class={`pane-rail-btn ${agentOpen ? 'open' : ''}`} title={t('pane.toggleAgent')}
          aria-label={t('pane.toggleAgent')} aria-pressed={agentOpen} onClick={() => setAgentOpen((open) => !open)}>
          <Bot size={13} />
        </button>
      </div>
      {treeOpen && (
        <>
          <div class="pane-tree" style={{ width: `${treeW}px` }}><FileTree workspacePath={leaf.path} onOpenFile={openPath} /></div>
          <PaneInnerSash onDelta={resizeTree} onEnd={saveWidths} />
        </>
      )}
      <div class="pane-editor">
        {files.length > 0 && (
          <div class="editor-tabs">
            {files.map((filePath) => (
              <button key={filePath} type="button" class={`editor-tab ${filePath === active ? 'active' : ''}`}
                title={filePath} onClick={() => setEditorState((current) => ({ ...current, activeFile: filePath }))}
                onAuxClick={(event) => { if (event.button === 1) { event.preventDefault(); close(filePath) } }}>
                <span class="editor-tab-name">{dirty[filePath] && <span class="dirty-dot" role="img" aria-label="modified">●</span>}{filePath.split('/').at(-1)}</span>
                <span class="close" role="button" tabIndex={0} title={t('editor.closeTab')} aria-label={t('editor.closeTab')}
                  onClick={(event) => { event.stopPropagation(); close(filePath) }}
                  onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); close(filePath) } }}><X size={13} /></span>
              </button>
            ))}
          </div>
        )}
        <div class="pane-editor-host">
          {active ? <Editor key={`${leaf.projectId}:${active}`} path={active} workspacePath={leaf.path}
            onDirty={(value) => setDirty((current) => ({ ...current, [active]: value }))} />
            : <div class="pane-editor-empty"><FolderOpen size={22} /><span>{t('pane.emptyEditor')}</span></div>}
        </div>
      </div>
      {agentOpen && (
        <>
          <PaneInnerSash onDelta={resizeAgent} onEnd={saveWidths} />
          <div class="pane-agent" style={{ width: `${agentW}px` }}><AgentPanel key={leaf.path} workspacePath={leaf.path} paneId={leaf.id} /></div>
        </>
      )}
    </div>
  )
}

function PaneLeaf({ leaf, single }) {
  const focused = single || activePaneId.value === leaf.id
  const closing = closingPaneId.value === leaf.id
  const colorIndex = leafList().findIndex((item) => item.id === leaf.id)
  const sectionRef = useRef(null)
  // Workspace swap (tab click rebind / center drop): keep the leaf mounted and
  // just wash its body so the change reads as a handoff, not a flicker.
  const prevWs = useRef(leaf.projectId)
  useEffect(() => {
    if (prevWs.current === leaf.projectId) return
    prevWs.current = leaf.projectId
    const el = sectionRef.current
    if (!el) return
    el.classList.remove('pane-leaf-swapped')
    void el.offsetWidth
    el.classList.add('pane-leaf-swapped')
  }, [leaf.projectId])
  function focus() {
    if (focused) return
    focusPane(leaf.id)
    ws.request('project', 'select', { id: leaf.projectId }).catch(() => {})
  }
  return (
    <section ref={sectionRef} class={`pane-leaf ${focused ? 'focused' : ''} ${closing ? 'closing' : ''}`} data-pane-id={leaf.id}
      style={{ '--flip-delay': `${Math.max(0, colorIndex) * 45}ms` }}
      data-pane-color={colorIndex >= 0 ? colorIndex : undefined} onPointerDown={focus}>
      <PaneHeader leaf={leaf} single={single} />
      <div class="pane-leaf-body">
        {viewMode.value === 'agents'
          ? <AgentPanel key={leaf.path} workspacePath={leaf.path} paneId={leaf.id} />
          : <PaneWorkbench key={leaf.projectId} leaf={leaf} />}
      </div>
    </section>
  )
}

function PaneNode({ node }) {
  if (node.type === 'pane') return <PaneLeaf leaf={node} single={false} />
  return (
    <div class="pane-split" style={{ flexDirection: node.dir === 'row' ? 'row' : 'column' }}>
      <div class="pane-cell" style={{ flex: `${node.ratio} 1 0` }}><PaneNode node={node.a} /></div>
      <PaneSash node={node} />
      <div class="pane-cell" style={{ flex: `${1 - node.ratio} 1 0` }}><PaneNode node={node.b} /></div>
    </div>
  )
}

/* Drop targeting — one preview slot at a time, driven by pointer position:
 * whichever edge of whichever pane the cursor nears opens at half size
 * (existing content reads as shrunk onto the other side). Dropping on a
 * pane's center swaps that pane's workspace instead of splitting. Nothing is
 * highlighted for drops that would be no-ops (the pane that already holds the
 * dragged workspace, or splits past the mode cap).
 */
const SIDES = {
  left: { dir: 'row', after: false },
  right: { dir: 'row', after: true },
  top: { dir: 'col', after: false },
  bottom: { dir: 'col', after: true }
}

// Covers the workbench whenever the agent grid or a normal-mode split is
// active — and while a workspace tab is dragged so a drop target exists even
// before the first split exists.
export function WorkspaceArea() {
  const host = useRef(null)
  const layerRef = useRef(null)
  const slotRef = useRef(null)
  const slotLabel = useRef(null)
  const dropTarget = useRef(null)
  const mode = viewMode.value
  const tree = paneTree(mode)
  const dragging = draggingWorkspace.value
  const leaves = leafList(mode)
  const [flip, setFlip] = useState(false)
  const [exiting, setExiting] = useState(false)

  // Mode change: panes re-deal themselves with a short staggered flip so the
  // switch reads as a transition, not a jump cut.
  const prevMode = useRef(mode)
  useEffect(() => {
    if (prevMode.current === mode) return
    prevMode.current = mode
    setFlip(true)
    const timer = setTimeout(() => setFlip(false), 460)
    return () => clearTimeout(timer)
  }, [mode])

  // Focus belongs to whatever lives under the overlay now — a hidden xterm or
  // editor would otherwise keep swallowing keystrokes.
  useEffect(() => {
    if (host.current && !host.current.contains(document.activeElement)) document.activeElement?.blur?.()
  }, [tree, mode])

  // The visible occupancy: a null tree still shows the implicit workspace.
  const occupied = leaves.length ? leaves : [implicitLeaf()]
  const draggingId = dragging?.projectId || ''
  // Dragging the only visible workspace cannot open a new area — the drop
  // would be a no-op, so the affordance stays hidden instead of lying.
  const soleSelf = occupied.length === 1 && occupied[0].projectId === draggingId
  const isMove = !!draggingId && occupied.some((leaf) => leaf.projectId === draggingId)
  const canSplit = !!dragging && !soleSelf && (occupied.length < maxPanes(mode) || isMove)
  // A drag in unsplit normal mode shows a translucent drop surface over the
  // classic UI instead of mounting a real pane.
  const transient = !tree && mode === 'normal'

  function hideSlot() {
    dropTarget.current = null
    if (slotRef.current) slotRef.current.style.display = 'none'
  }

  function showSlot(box, label) {
    const el = slotRef.current
    if (!el) return
    el.style.display = 'grid'
    el.style.left = `${box.left}px`
    el.style.top = `${box.top}px`
    el.style.width = `${box.width}px`
    el.style.height = `${box.height}px`
    if (slotLabel.current) slotLabel.current.textContent = label
  }

  function onDragOver(event) {
    event.preventDefault()
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
    const layer = layerRef.current
    if (!layer || !dragging) return
    const x = event.clientX
    const y = event.clientY
    // The drop layer spans the whole workbench; the pane grid itself keeps
    // its narrow home cell. Edges of the screen map to the matching outer
    // edge of the grid — a pointer left of the panes still splits left.
    const layerRect = layer.getBoundingClientRect()
    const area = host.current
    const areaRect = area ? area.getBoundingClientRect() : layerRect
    let leafEl = null
    for (const el of (area || document).querySelectorAll('.pane-leaf')) {
      const r = el.getBoundingClientRect()
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) { leafEl = el; break }
    }
    const leafId = leafEl?.dataset.paneId || ''
    const leaf = leafId ? paneLeaf(leafId, mode) : null
    const rect = leafEl ? leafEl.getBoundingClientRect() : areaRect
    const dl = x - rect.left
    const dr = rect.right - x
    const dt = y - rect.top
    const db = rect.bottom - y
    // Same targeting model whether a leaf sits under the pointer or the
    // surface is still unsplit: edge bands split, the center opens/swaps.
    const bandX = Math.min(rect.width * 0.3, 150)
    const bandY = Math.min(rect.height * 0.3, 120)
    const onSelf = !!leaf && leaf.projectId === draggingId
    const cands = []
    if (canSplit && !onSelf) {
      if (dl <= bandX) cands.push({ side: 'left', d: dl })
      if (dr <= bandX) cands.push({ side: 'right', d: dr })
      if (dt <= bandY) cands.push({ side: 'top', d: dt })
      if (db <= bandY) cands.push({ side: 'bottom', d: db })
    }
    const rel = { left: rect.left - layerRect.left, top: rect.top - layerRect.top, width: rect.width, height: rect.height }
    if (cands.length) {
      cands.sort((a, b) => a.d - b.d)
      const side = cands[0].side
      const half = side === 'left' ? { ...rel, width: rel.width / 2 }
        : side === 'right' ? { ...rel, left: rel.left + rel.width / 2, width: rel.width / 2 }
        : side === 'top' ? { ...rel, height: rel.height / 2 }
        : { ...rel, top: rel.top + rel.height / 2, height: rel.height / 2 }
      dropTarget.current = { leafId: tree ? leafId : null, side, ...SIDES[side] }
      showSlot(half, `${t('pane.dropHere')}${dragging.name ? ` — ${dragging.name}` : ''}`)
      return
    }
    // Center of a leaf: swap what that pane shows (works even at the cap).
    // Center of the empty surface: just open the dragged workspace.
    if (leafEl && leaf && !onSelf) {
      dropTarget.current = { leafId, side: 'center' }
      showSlot(rel, `${t('pane.dropHere')}${dragging.name ? ` — ${dragging.name}` : ''}`)
      return
    }
    if (!leafEl && !tree) {
      // Middle of the unsplit surface opens the workspace like a tab click —
      // still worth a full-area preview so the drop doesn't look dead.
      dropTarget.current = { leafId: '', side: 'open' }
      showSlot(rel, `${t('pane.dropHere')}${dragging.name ? ` — ${dragging.name}` : ''}`)
      return
    }
    hideSlot()
  }

  function onDragLeave(event) {
    if (!layerRef.current?.contains(event.relatedTarget)) hideSlot()
  }

  function onDrop(event) {
    event.preventDefault()
    const record = dragging || readDrag(event)
    const target = dropTarget.current
    hideSlot()
    draggingWorkspace.value = null
    if (!record) return
    if (!target) return
    if (target.side === 'open') {
      const opened = { id: record.projectId || record.id || record.path, name: record.name, path: record.path }
      setWorkspace(opened)
      window.dispatchEvent(new CustomEvent('harpy:workspace-change', { detail: opened }))
      ws.request('project', 'select', { id: opened.id }).catch(() => {})
      return
    }
    if (target.side === 'center') {
      const rec = { id: record.projectId || record.id || record.path, name: record.name, path: record.path }
      if (tree && target.leafId) {
        rebindPane(target.leafId, rec)
        focusPane(target.leafId)
      } else {
        setWorkspace(rec)
        window.dispatchEvent(new CustomEvent('harpy:workspace-change', { detail: rec }))
      }
      ws.request('project', 'select', { id: rec.id }).catch(() => {})
      return
    }
    insertPane(record, target.leafId || null, target.dir, target.after)
  }

  // When the area disappears (last pane closed / mode left with no tree /
  // dropped drag), keep it mounted a beat longer for a fade-out instead of a
  // hard cut to the classic UI.
  const wouldHide = (!dragging && transient) || (transient && !canSplit) || (mode === 'agents' && !dragging && !leaves.length)
  const wasVisible = useRef(false)
  useEffect(() => {
    if (wouldHide && wasVisible.current) {
      wasVisible.current = false
      setExiting(true)
      const timer = setTimeout(() => setExiting(false), 230)
      return () => clearTimeout(timer)
    }
    if (!wouldHide) {
      wasVisible.current = true
      if (exiting) setExiting(false)
    }
  }, [wouldHide])
  if (wouldHide && !exiting) return null

  // Two siblings: the pane grid stays in its own grid cell so panes never
  // jump mid-drag; a separate full-workbench layer captures the drag so the
  // drop works from anywhere on screen.
  return (
    <>
      <div class={`pane-area ${mode === 'agents' ? 'pane-area-full' : ''} ${transient ? 'pane-area-transient' : ''} ${flip ? 'pane-area-flip' : ''} ${exiting ? 'pane-area-exit' : ''}`} ref={host}>
        {transient ? null : (tree ? <PaneNode node={tree} /> : (leaves[0] ? <PaneLeaf leaf={leaves[0]} single /> : null))}
      </div>
      {dragging && (
        <div class="pane-drop-layer" ref={layerRef}
          onDragOver={onDragOver} onDrop={onDrop} onDragLeave={onDragLeave}>
          <div class="pane-drop-slot" ref={slotRef} style={{ display: 'none' }}><span class="pane-dz-label" ref={slotLabel} /></div>
          {!canSplit && !soleSelf && <div class="pane-drop-full"><span>{t('pane.maxReached', { count: maxPanes(mode) })}</span></div>}
          {transient && <div class="pane-drop-hint"><FolderOpen size={18} /><span>{t('pane.dropHint')}</span></div>}
        </div>
      )}
    </>
  )
}
