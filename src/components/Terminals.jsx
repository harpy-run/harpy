import { useCallback, useEffect, useRef, useState } from 'preact/hooks'
import { ArrowDownToLine, ArrowLeft, ArrowRight, ArrowUpFromLine, ChevronDown, ClipboardPaste, Copy, Terminal as TerminalIcon, X } from '../lib/icons.jsx'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import '@xterm/xterm/css/xterm.css'
import { ws, isConnectionError } from '../lib/ws.js'
import { t } from '../lib/i18n.js'
import { useEscape } from '../lib/useEscape.js'
import { isAdmin, mobileTab, panelOpen, terminalFontSize, terminalScrollSpeed, theme, workspace } from '../state/app.js'
import { terminalFont, terminalTheme } from '../lib/terminal-theme.js'
import { attachFastRenderer } from '../lib/terminal-renderer.js'
import { watchTerminalResize } from '../lib/terminal-resize.js'
import { attachTerminalTouchScroll } from '../lib/terminal-touch.js'
import { attachTerminalKeys } from '../lib/terminal-keys.js'
import { TerminalScrollButtons } from './TerminalScrollButtons.jsx'
import { TerminalSearchBox } from './TerminalSearch.jsx'
import { TInput } from './Fields.jsx'
import { sanitizeReplay } from '../lib/terminal-replay.js'
import { createTerminalOutputQueue } from '../lib/terminal-output.js'

function TerminalView({ id, workspaceKey: viewWorkspaceKey, onReady, modifiersRef }) {
  const host = useRef(null)
  const terminalRef = useRef(null)
  const fitRef = useRef(null)
  const searchRef = useRef(null)
  const [searchOpen, setSearchOpen] = useState(false)
  const [terminalInstance, setTerminalInstance] = useState(null)

  useEffect(() => {
    if (!host.current) return undefined
    const terminal = new Terminal({
      fontFamily: terminalFont,
      fontSize: terminalFontSize.value,
      lineHeight: 1.25,
      fontWeight: 450,
      cursorBlink: true,
      disableStdin: false,
      scrollOnUserInput: true,
      scrollback: 5_000,
      theme: terminalTheme(theme.value)
    })
    terminalRef.current = terminal
    setTerminalInstance(terminal)
    const outputQueue = createTerminalOutputQueue(terminal)
    onReady?.({
      focus: () => terminal.focus(),
      blur: () => terminal.blur(),
      input: (data) => terminal.input(data, true),
      selection: () => terminal.getSelection(),
      clearSelection: () => terminal.clearSelection()
    })
    const fit = new FitAddon()
    fitRef.current = fit
    terminal.loadAddon(fit)
    const search = new SearchAddon()
    searchRef.current = search
    terminal.loadAddon(search)
    terminal.open(host.current)
    attachFastRenderer(terminal)
    attachTerminalKeys(terminal)
    const stopTouchScroll = attachTerminalTouchScroll(host.current, terminal, () => terminalScrollSpeed.value)
    // Auto-focus only on fine-pointer devices; on touch, focusing at mount
    // opens the keyboard before the user even asks to type.
    if (!window.matchMedia?.('(pointer: coarse)').matches) terminal.focus()
    // Focus on click (tap) only — never on pointerdown. On touch devices a
    // pointerdown focus pops the software keyboard mid-gesture and kills the
    // scroll drag; a scroll gesture preventDefaults its touchmoves, which
    // suppresses the click, so drags never steal focus while taps still do.
    let suppressNextTouchClick = false
    let touchClickTimer = 0
    const focusTerminal = (event) => {
      if (event.detail === 0) { terminal.focus(); return }
      if (suppressNextTouchClick) {
        suppressNextTouchClick = false
        event.preventDefault()
        return
      }
      terminal.focus()
    }
    const consumeTouchGesture = () => {
      suppressNextTouchClick = true
      clearTimeout(touchClickTimer)
      touchClickTimer = setTimeout(() => { suppressNextTouchClick = false }, 700)
    }
    host.current.addEventListener('click', focusTerminal)
    host.current.addEventListener('harpy:terminal-touch-consumed', consumeTouchGesture)
    const stopResizeWatcher = watchTerminalResize(host.current, fit, terminal, (cols, rows) => {
      ws.request('pty', 'resize', { id, cols, rows }).catch(() => {})
    })
    const isViewVisible = () => {
      const compact = window.matchMedia?.('(max-width: 767px)').matches || false
      return workspaceKey() === viewWorkspaceKey && (!compact || isAdmin.value) && (compact
        ? mobileTab.value === 'terminal'
        : panelOpen.value)
    }
    let viewVisible = isViewVisible()
    let hydrated = false
    let hydrating = false
    let rehydrateRequested = false
    let hydrationGeneration = 0
    let restoreToLatest = true
    let lastSeq = 0
    const pending = []
    const dataUnsubscribe = ws.on('pty', 'data', (event) => {
      if (event.id !== id) return
      if (!viewVisible) return
      if (event.seq && event.seq <= lastSeq) return
      if (!hydrated) {
        pending.push(event)
        return
      }
      outputQueue.write(event.data || '')
      lastSeq = Math.max(lastSeq, event.seq || lastSeq)
    })
    const exitUnsubscribe = ws.on('pty', 'exit', (event) => { if (event.id === id) outputQueue.write(`\r\n[process exited: ${event.exitCode}]\r\n`) })
    const inputDisposable = terminal.onData((data) => {
      let nextData = data
      if (modifiersRef?.current && data.length === 1 && /[a-z]/i.test(data)) {
        nextData = String.fromCharCode(data.toUpperCase().charCodeAt(0) - 64)
        modifiersRef.current = false
        modifiersRef.onChange?.(false)
      }
      ws.request('pty', 'input', { id, data: nextData }).catch(() => {})
    })
    async function hydrate() {
      if (!viewVisible) return
      if (hydrating) { rehydrateRequested = true; return }
      hydrating = true
      const generation = hydrationGeneration
      try {
        const history = await ws.request('pty', 'history', { id })
        if (generation !== hydrationGeneration) return
        const restoreLatest = restoreToLatest
        restoreToLatest = false
        const replayed = (Array.isArray(history) ? history : [])
          .filter((event) => !event.seq || event.seq > lastSeq)
          .map((event) => ({ ...event, data: sanitizeReplay(event.data) }))
        const events = [...replayed, ...pending.splice(0)].sort((left, right) => (left.seq || 0) - (right.seq || 0))
        const output = []
        for (const event of events) {
          if (event.seq && event.seq <= lastSeq) continue
          output.push(event.data || '')
          lastSeq = Math.max(lastSeq, event.seq || lastSeq)
        }
        hydrated = true
        const replayText = output.join('')
        if (replayText) outputQueue.write(replayText, () => {
          if (restoreLatest) terminal.scrollToBottom()
          stopResizeWatcher.refresh?.()
        })
        else if (restoreLatest) terminal.scrollToBottom()
      } catch (error) {
        if (generation === hydrationGeneration && !hydrated) {
          outputQueue.write(`\r\n[terminal history unavailable: ${error.message}]\r\n`)
          for (const event of pending.splice(0).sort((left, right) => (left.seq || 0) - (right.seq || 0))) {
            if (event.seq && event.seq <= lastSeq) continue
            outputQueue.write(event.data || '')
            lastSeq = Math.max(lastSeq, event.seq || lastSeq)
          }
          hydrated = true
        }
      } finally {
        hydrating = false
        if (rehydrateRequested) { rehydrateRequested = false; hydrate() }
      }
    }
    const visibilityChange = () => {
      const visible = isViewVisible()
      if (visible === viewVisible) return
      viewVisible = visible
      hydrationGeneration += 1
      hydrated = false
      pending.length = 0
      rehydrateRequested = false
      if (!visible) {
        ws.request('pty', 'unwatch', { id }).catch(() => {})
        return
      }
      hydrate()
    }
    const reconnect = () => {
      viewVisible = isViewVisible()
      hydrationGeneration += 1
      hydrated = false
      pending.length = 0
      restoreToLatest = false
      rehydrateRequested = viewVisible && hydrating
      if (viewVisible && !hydrating) hydrate()
    }
    window.addEventListener('harpy:ws-open', reconnect)
    window.addEventListener('harpy:panel-visibility', visibilityChange)
    const keyboardLayout = (event) => {
      if (event.detail?.open && !host.current?.contains(document.activeElement)) return
      const buffer = terminal.buffer.active
      const wasAtLiveEdge = buffer.type === 'alternate' || buffer.viewportY >= buffer.baseY
      requestAnimationFrame(() => {
        try {
          const rect = host.current?.getBoundingClientRect()
          if (!rect || rect.width < 4 || rect.height < 4) return
          fit.fit()
          if (event.detail?.open && wasAtLiveEdge) terminal.scrollToBottom()
          stopResizeWatcher.refresh?.()
        } catch {
          // xterm may be between open/dispose while the pane is switching.
        }
      })
    }
    window.addEventListener('harpy:keyboard', keyboardLayout)
    const toggleSearch = (event) => {
      if (event.detail !== id) return
      setSearchOpen((open) => {
        if (open) terminal.focus()
        return !open
      })
    }
    window.addEventListener('harpy:terminal-search', toggleSearch)
    if (viewVisible) hydrate()
    return () => {
      stopResizeWatcher()
      stopTouchScroll()
      host.current?.removeEventListener('click', focusTerminal)
      host.current?.removeEventListener('harpy:terminal-touch-consumed', consumeTouchGesture)
      clearTimeout(touchClickTimer)
      dataUnsubscribe()
      exitUnsubscribe()
      inputDisposable.dispose()
      outputQueue.dispose()
      window.removeEventListener('harpy:ws-open', reconnect)
      window.removeEventListener('harpy:panel-visibility', visibilityChange)
      window.removeEventListener('harpy:keyboard', keyboardLayout)
      window.removeEventListener('harpy:terminal-search', toggleSearch)
      terminal.dispose()
      terminalRef.current = null
      fitRef.current = null
      onReady?.(null)
    }
  }, [id, viewWorkspaceKey, onReady])

  useEffect(() => {
    if (terminalRef.current) {
      terminalRef.current.options.theme = terminalTheme(theme.value)
      requestAnimationFrame(() => {
        try {
          fitRef.current?.fit()
          ws.request('pty', 'resize', { id, cols: terminalRef.current.cols, rows: terminalRef.current.rows }).catch(() => {})
        } catch { /* terminal is switching */ }
      })
    }
  }, [theme.value, id])

  useEffect(() => {
    if (terminalRef.current) {
      terminalRef.current.options.fontSize = terminalFontSize.value
      requestAnimationFrame(() => {
        try {
          fitRef.current?.fit()
          ws.request('pty', 'resize', { id, cols: terminalRef.current.cols, rows: terminalRef.current.rows }).catch(() => {})
        } catch { /* terminal is switching */ }
      })
    }
  }, [terminalFontSize.value, id])

  return <div class="terminal-host" ref={host}>
    {searchOpen && <TerminalSearchBox addon={searchRef.current} onClose={() => { setSearchOpen(false); terminalRef.current?.focus() }} />}
    <TerminalScrollButtons hostRef={host} terminalRef={terminalRef} terminal={terminalInstance} />
  </div>
}

const functionKeys = [
  ['F1', '\u001bOP'], ['F2', '\u001bOQ'], ['F3', '\u001bOR'], ['F4', '\u001bOS'],
  ['F5', '\u001b[15~'], ['F6', '\u001b[17~'], ['F7', '\u001b[18~'], ['F8', '\u001b[19~'],
  ['F9', '\u001b[20~'], ['F10', '\u001b[21~'], ['F11', '\u001b[23~'], ['F12', '\u001b[24~']
]

let viewportConsumers = 0

export function TerminalAccessory({ actionsRef, modifiersRef, terminalId }) {
  const [expanded, setExpanded] = useState(false)
  const [ctrl, setCtrl] = useState(false)
  const [keyboardOpen, setKeyboardOpen] = useState(false)

  useEffect(() => {
    if (typeof window === 'undefined' || !window.visualViewport) return undefined
    const viewport = window.visualViewport
    // Android can resize innerHeight together with the visual viewport when
    // the keyboard opens. Keep the pre-keyboard height so that both resize
    // modes produce the same keyboard inset.
    let layoutHeight = Math.max(window.innerHeight, document.documentElement.clientHeight)
    let previousKeyboardOpen = false
    viewportConsumers += 1
    const updateViewport = () => {
      const currentLayoutHeight = Math.max(window.innerHeight, document.documentElement.clientHeight)
      const visualHeight = Math.round(viewport.height)
      const visualOffset = Math.round(viewport.offsetTop)
      const viewportGap = layoutHeight - (visualHeight + visualOffset)
      const keyboardHeight = Math.max(0, Math.round(viewportGap))
      const keyboardOpen = keyboardHeight > 100 && visualHeight < layoutHeight - 80
      // Refresh the baseline after the keyboard has closed (including after
      // rotation), but never while the viewport is in its reduced state.
      if (!keyboardOpen && currentLayoutHeight > layoutHeight) layoutHeight = currentLayoutHeight
      document.documentElement.style.setProperty('--harpy-keyboard-height', `${keyboardHeight}px`)
      document.documentElement.style.setProperty('--harpy-visual-height', `${visualHeight}px`)
      document.documentElement.style.setProperty('--harpy-viewport-offset', `${visualOffset}px`)
      document.documentElement.classList.toggle('harpy-keyboard-open', keyboardOpen)
      if (keyboardOpen !== previousKeyboardOpen) {
        previousKeyboardOpen = keyboardOpen
        window.dispatchEvent(new CustomEvent('harpy:keyboard', { detail: { open: keyboardOpen } }))
      }
      setKeyboardOpen(keyboardOpen)
    }
    updateViewport()
    viewport.addEventListener('resize', updateViewport)
    viewport.addEventListener('scroll', updateViewport)
    window.addEventListener('resize', updateViewport)
    const resetViewportBaseline = () => {
      layoutHeight = Math.max(window.innerHeight, document.documentElement.clientHeight)
      updateViewport()
    }
    window.addEventListener('orientationchange', resetViewportBaseline)
    return () => {
      viewport.removeEventListener('resize', updateViewport)
      viewport.removeEventListener('scroll', updateViewport)
      window.removeEventListener('resize', updateViewport)
      window.removeEventListener('orientationchange', resetViewportBaseline)
      viewportConsumers -= 1
      if (viewportConsumers === 0) {
        document.documentElement.style.removeProperty('--harpy-keyboard-height')
        document.documentElement.style.removeProperty('--harpy-visual-height')
        document.documentElement.style.removeProperty('--harpy-viewport-offset')
        document.documentElement.classList.remove('harpy-keyboard-open')
      }
    }
  }, [])

  useEffect(() => {
    setCtrl(false)
    modifiersRef.current = false
  }, [terminalId, modifiersRef])

  useEffect(() => {
    if (!modifiersRef) return undefined
    modifiersRef.onChange = setCtrl
    return () => { if (modifiersRef.onChange === setCtrl) delete modifiersRef.onChange }
  }, [modifiersRef])

  function toggleCtrl() {
    const next = !ctrl
    setCtrl(next)
    modifiersRef.current = next
  }

  function send(data, refocus = !expanded) {
    const actions = actionsRef.current
    if (!actions) return
    actions.input(data)
    if (refocus) actions.focus()
  }

  function sendControl(letter) {
    send(String.fromCharCode(letter.toUpperCase().charCodeAt(0) - 64))
    setCtrl(false)
    modifiersRef.current = false
  }

  async function pasteClipboard() {
    try {
      const text = await navigator.clipboard.readText()
      if (text) send(text)
    } catch { /* clipboard read needs a gesture / permission */ }
  }

  async function copySelection() {
    const actions = actionsRef.current
    const selected = actions?.selection()
    if (!selected) return
    try {
      await navigator.clipboard.writeText(selected)
      actions.clearSelection()
    } catch { /* clipboard access needs a secure context / permission */ }
  }

  function toggleExpanded() {
    const next = !expanded
    setExpanded(next)
    if (next) actionsRef.current?.blur()
    else actionsRef.current?.focus()
  }

  return <>
    {expanded && <div class={`terminal-mobile-tray ${keyboardOpen ? 'keyboard-open' : ''}`} role="group" aria-label={t('terminal.extraKeys')}>
      <div class="terminal-mobile-tray-heading"><span>{t('terminal.extraKeys')}</span><button type="button" class="terminal-key terminal-key-close" aria-label={t('terminal.closeExtraKeys')} onClick={toggleExpanded}><X size={14} /></button></div>
      <div class="terminal-mobile-tray-grid">
        {functionKeys.map(([label, value]) => <button key={label} type="button" class="terminal-key terminal-key-function" onPointerDown={(event) => event.preventDefault()} onClick={() => send(value)}>{label}</button>)}
        <button type="button" class="terminal-key" onPointerDown={(event) => event.preventDefault()} onClick={() => send('\u001b[H')}>Home</button>
        <button type="button" class="terminal-key" onPointerDown={(event) => event.preventDefault()} onClick={() => send('\u001b[F')}>End</button>
        <button type="button" class="terminal-key" onPointerDown={(event) => event.preventDefault()} onClick={() => send('\u001b[5~')}>PgUp</button>
        <button type="button" class="terminal-key" onPointerDown={(event) => event.preventDefault()} onClick={() => send('\u001b[6~')}>PgDn</button>
        <button type="button" class={`terminal-key ${ctrl ? 'active' : ''}`} aria-pressed={ctrl} onPointerDown={(event) => event.preventDefault()} onClick={toggleCtrl}>Ctrl</button>
        <button type="button" class="terminal-key" onPointerDown={(event) => event.preventDefault()} onClick={() => sendControl('x')}>^X</button>
        <button type="button" class="terminal-key" onPointerDown={(event) => event.preventDefault()} onClick={() => sendControl('v')}>^V</button>
        <button type="button" class="terminal-key" onPointerDown={(event) => event.preventDefault()} onClick={() => send('\u001b')}>Esc</button>
        <button type="button" class="terminal-key" onPointerDown={(event) => event.preventDefault()} onClick={() => send('\t')}>Tab</button>
        <button type="button" class="terminal-key" onPointerDown={(event) => event.preventDefault()} onClick={() => send('\u001b[3~')}>Del</button>
      </div>
    </div>}
    <div class={`terminal-mobile-accessory ${keyboardOpen ? 'keyboard-open' : ''}`} role="toolbar" aria-label={t('terminal.keyboardToolbar')}>
      <button type="button" class={`terminal-key terminal-key-modifier ${ctrl ? 'active' : ''}`} aria-pressed={ctrl} onPointerDown={(event) => event.preventDefault()} onClick={toggleCtrl}>Ctrl</button>
      <button type="button" class="terminal-key" onPointerDown={(event) => event.preventDefault()} onClick={() => sendControl('c')}>^C</button>
      <button type="button" class="terminal-key terminal-key-icon" title={t('terminal.copy')} aria-label={t('terminal.copy')} onPointerDown={(event) => event.preventDefault()} onClick={copySelection}><Copy size={15} /></button>
      <button type="button" class="terminal-key terminal-key-icon" title={t('terminal.paste')} aria-label={t('terminal.paste')} onPointerDown={(event) => event.preventDefault()} onClick={pasteClipboard}><ClipboardPaste size={15} /></button>
      <button type="button" class="terminal-key terminal-key-icon" aria-label={t('terminal.arrowLeft')} onPointerDown={(event) => event.preventDefault()} onClick={() => send('\u001b[D')}><ArrowLeft size={16} /></button>
      <button type="button" class="terminal-key terminal-key-icon" aria-label={t('terminal.arrowDown')} onPointerDown={(event) => event.preventDefault()} onClick={() => send('\u001b[B')}><ArrowDownToLine size={16} /></button>
      <button type="button" class="terminal-key terminal-key-icon" aria-label={t('terminal.arrowUp')} onPointerDown={(event) => event.preventDefault()} onClick={() => send('\u001b[A')}><ArrowUpFromLine size={16} /></button>
      <button type="button" class="terminal-key terminal-key-icon" aria-label={t('terminal.arrowRight')} onPointerDown={(event) => event.preventDefault()} onClick={() => send('\u001b[C')}><ArrowRight size={16} /></button>
      <button type="button" class="terminal-key terminal-key-more" aria-expanded={expanded} aria-label={t('terminal.extraKeys')} onPointerDown={(event) => event.preventDefault()} onClick={toggleExpanded}><span>•••</span></button>
    </div>
  </>
}

// Keep normal shell ids grouped by workspace. Unmounting the panel must not
// kill a process; the backend owns process lifetime for the websocket.
const terminalStores = new Map()

function workspaceKey() {
  return String(workspace.value?.id || workspace.value?.path || 'default')
}

function storeFor(key) {
  if (!terminalStores.has(key)) {
    let names = {}
    try { names = JSON.parse(localStorage.getItem(`harpy.termNames.${key}`) || '{}') } catch { names = {} }
    terminalStores.set(key, { tabs: [], active: '', creating: false, names })
  }
  return terminalStores.get(key)
}

function persistNames(key, names) {
  try { localStorage.setItem(`harpy.termNames.${key}`, JSON.stringify(names)) } catch { void 0 }
}

export function Terminals() {
  const initialKey = workspaceKey()
  const initialStore = storeFor(initialKey)
  const [storeKey, setStoreKey] = useState(initialKey)
  const [tabs, setTabs] = useState(initialStore.tabs)
  const [active, setActive] = useState(initialStore.active)
  const [names, setNames] = useState(initialStore.names)
  const [unread, setUnread] = useState(new Set())
  const [renaming, setRenaming] = useState('')
  const [renameValue, setRenameValue] = useState('')
  const [menuOpen, setMenuOpen] = useState(false)
  const [error, setError] = useState('')
  const [reconciling, setReconciling] = useState(false)
  const terminalActionsRef = useRef(null)
  const terminalModifiersRef = useRef(false)
  const handleTerminalReady = useCallback((actions) => { terminalActionsRef.current = actions }, [])
  const tabsRef = useRef(initialStore.tabs)
  const activeRef = useRef(initialStore.active)
  const mountedRef = useRef(true)
  const newTabRef = useRef(null)
  const reconcileRef = useRef(null)
  const menuRef = useRef(null)
  useEscape(menuOpen, () => setMenuOpen(false))


  async function newTab() {
    const store = storeFor(storeKey)
    if (store.creating) return
    store.creating = true
    const targetKey = storeKey
    const targetWorkspace = store.workspacePath || ''
    try {
      const { id } = await ws.request('pty', 'create', { cols: 80, rows: 24, workspace: targetWorkspace })
      if (targetKey !== workspaceKey()) {
        store.tabs = [...store.tabs, id]
        store.active = id
        return
      }
      store.tabs = [...store.tabs, id]
      store.active = id
      if (!mountedRef.current) return
      tabsRef.current = store.tabs
      activeRef.current = id
      setTabs(store.tabs)
      setActive(id)
      setError('')
    } catch (requestError) { setError(requestError.message) }
    finally { store.creating = false }
  }
  newTabRef.current = newTab

  useEffect(() => {
    mountedRef.current = true
    let activeWorkspace = workspaceKey() === storeKey
    let panelVisible = false
    let workspaceRevision = 0
    const store = storeFor(storeKey)
    store.workspacePath = workspace.value?.path || ''
    tabsRef.current = store.tabs
    activeRef.current = store.active
    setTabs(store.tabs)
    setActive(store.active)
    let reconcileGeneration = 0
    const reconcile = async () => {
      const generation = ++reconcileGeneration
      const revision = workspaceRevision
      if (workspaceKey() !== storeKey || !panelVisible) return
      setReconciling(true)
      try {
        const requestedPath = store.workspacePath
        const live = await ws.request('pty', 'list', { workspace: requestedPath })
        const liveIds = new Set((live || []).map((item) => item.id))
        if (generation !== reconcileGeneration || revision !== workspaceRevision || !mountedRef.current || workspaceKey() !== storeKey || !panelVisible) {
          // `pty.list` subscribes the connection as it returns. If the panel
          // was hidden while this request was in flight, undo that subscription
          // after the list op so it cannot race the earlier visibility cleanup.
          ws.request('pty', 'unwatchIds', { ids: [...liveIds] }).catch(() => {})
          return
        }
        // Rehydrate terminals created before a page refresh. The backend keeps
        // PTYs alive by client identity, so an empty in-memory tab store must
        // adopt the live ids instead of creating duplicate shells.
        const existing = store.tabs.filter((id) => liveIds.has(id))
        const known = new Set(existing)
        store.tabs = [...existing, ...[...liveIds].filter((id) => !known.has(id))]
        if (!store.tabs.includes(store.active)) store.active = store.tabs.at(-1) || ''
        tabsRef.current = store.tabs
        activeRef.current = store.active
        setTabs(store.tabs)
        setActive(store.active)
        if (!store.tabs.length) newTabRef.current?.()
      } catch {
        // Older servers do not expose pty.list; create only after that request
        // fails, so a healthy server never races startup with a new shell.
        if (generation === reconcileGeneration && revision === workspaceRevision && mountedRef.current && panelVisible && workspaceKey() === storeKey && !store.tabs.length) newTabRef.current?.()
      } finally {
        if (generation === reconcileGeneration && revision === workspaceRevision && mountedRef.current) setReconciling(false)
      }
    }
    reconcileRef.current = reconcile
    // Unread marker on inactive tabs: any output landing in a background tab
    // raises a dot until the user looks at it.
    const dataUnsubscribe = ws.on('pty', 'data', (event) => {
      if (!event.id || (panelVisible && event.id === activeRef.current)) return
      setUnread((current) => current.has(event.id) ? current : new Set(current).add(event.id))
    })
    const exitUnsubscribe = ws.on('pty', 'exit', (event) => {
      const currentStore = storeFor(storeKey)
      if (!currentStore.tabs.includes(event.id)) return
      currentStore.tabs = currentStore.tabs.filter((id) => id !== event.id)
      delete currentStore.names[event.id]
      persistNames(storeKey, currentStore.names)
      setNames({ ...currentStore.names })
      setUnread((current) => {
        if (!current.has(event.id)) return current
        const next = new Set(current)
        next.delete(event.id)
        return next
      })
      if (currentStore.active === event.id) currentStore.active = currentStore.tabs.at(-1) || ''
      if (currentStore === storeFor(workspaceKey())) {
        tabsRef.current = currentStore.tabs
        activeRef.current = currentStore.active
        setTabs(currentStore.tabs)
        setActive(currentStore.active)
      }
    })
    const workspaceChange = () => {
      const nextKey = workspaceKey()
      if (nextKey === storeKey) { activeWorkspace = true; return }
      workspaceRevision += 1
      activeWorkspace = false
      panelVisible = false
      ws.request('pty', 'unwatchIds', { ids: [...store.tabs] }).catch(() => {})
      reconcileRef.current = null
      const nextStore = storeFor(nextKey)
      nextStore.workspacePath = workspace.value?.path || ''
      reconcileGeneration += 1
      activeWorkspace = true
      setStoreKey(nextKey)
      tabsRef.current = nextStore.tabs
      activeRef.current = nextStore.active
      setTabs(nextStore.tabs)
      setActive(nextStore.active)
      setNames(nextStore.names)
      setUnread(new Set())
      setRenaming('')
      setError('')
      // The effect for the new key creates the first terminal after render.
    }
    window.addEventListener('harpy:workspace-change', workspaceChange)
    const visibilityChange = () => {
      const compact = window.matchMedia?.('(max-width: 767px)').matches
      const visible = activeWorkspace && workspaceKey() === storeKey && (!compact || isAdmin.value) && (compact
        ? mobileTab.value === 'terminal'
        : panelOpen.value && !compact)
      if (visible === panelVisible) return
      panelVisible = visible
      const ids = [...store.tabs]
      if (visible) {
        const revision = workspaceRevision
        ws.request('pty', 'list', { workspace: store.workspacePath || '' }).then((live) => {
          const liveIds = new Set((live || []).map((item) => item.id))
          if (revision !== workspaceRevision || !activeWorkspace || !panelVisible || workspaceKey() !== storeKey) {
            ws.request('pty', 'unwatchIds', { ids: [...liveIds] }).catch(() => {})
            return
          }
          const known = new Set(store.tabs.filter((id) => liveIds.has(id)))
          store.tabs = [...known, ...[...liveIds].filter((id) => !known.has(id))]
          if (!store.tabs.includes(store.active)) store.active = store.tabs.at(-1) || ''
          tabsRef.current = store.tabs
          activeRef.current = store.active
          setTabs(store.tabs)
          setActive(store.active)
          if (!store.tabs.length) newTabRef.current?.()
        }).catch(() => {
          if (activeWorkspace && panelVisible && !store.tabs.length) newTabRef.current?.()
        })
      } else ws.request('pty', 'unwatchIds', { ids }).catch(() => {})
    }
    window.addEventListener('harpy:panel-visibility', visibilityChange)
    // A terminal spawned outside this panel (Harpy Team CLI, an extension
    // installer) joins the strip directly. visibilityChange only lists on
    // open/close transitions, so without this a shell created while the panel
    // was already open stays invisible.
    const ptyCreated = (event) => {
      const { id, workspace: created } = event.detail || {}
      if (!id || !activeWorkspace) return
      if (created && store.workspacePath && created !== store.workspacePath) return
      if (!store.tabs.includes(id)) store.tabs = [...store.tabs, id]
      store.active = id
      if (workspaceKey() !== storeKey) return
      tabsRef.current = store.tabs
      activeRef.current = id
      setTabs(store.tabs)
      setActive(id)
    }
    window.addEventListener('harpy:pty-created', ptyCreated)
    visibilityChange()
    const reconnect = () => {
      // PTY ids remain server-owned across a transient socket reconnect. The
      // current terminal view will hydrate again and resume receiving events.
      setError((e) => isConnectionError(e) ? '' : e)
      if (activeWorkspace && panelVisible) {
        if (activeRef.current) setActive(activeRef.current)
        reconcile()
      }
    }
    window.addEventListener('harpy:ws-open', reconnect)
    return () => {
      mountedRef.current = false
      activeWorkspace = false
      reconcileGeneration += 1
      if (reconcileRef.current === reconcile) reconcileRef.current = null
      window.removeEventListener('harpy:workspace-change', workspaceChange)
      window.removeEventListener('harpy:panel-visibility', visibilityChange)
      window.removeEventListener('harpy:pty-created', ptyCreated)
      dataUnsubscribe()
      exitUnsubscribe()
      window.removeEventListener('harpy:ws-open', reconnect)
      ws.request('pty', 'unwatchIds', { ids: [...store.tabs] }).catch(() => {})
    }
  }, [storeKey])

  async function closeTab(event, id) {
    event.stopPropagation()
    await ws.request('pty', 'kill', { id }).catch(() => {})
    const store = storeFor(storeKey)
    const next = store.tabs.filter((item) => item !== id)
    store.tabs = next
    if (store.active === id) store.active = next.at(-1) || ''
    tabsRef.current = next
    activeRef.current = store.active
    setTabs(next)
    setActive(store.active)
  }

  function activateTab(id) {
    const store = storeFor(storeKey)
    store.active = id
    activeRef.current = id
    setActive(id)
    setRenaming('')
    setUnread((current) => {
      if (!current.has(id)) return current
      const next = new Set(current)
      next.delete(id)
      return next
    })
  }

  function commitRename(id) {
    const store = storeFor(storeKey)
    const value = renameValue.trim().slice(0, 40)
    if (value) store.names[id] = value
    else delete store.names[id]
    persistNames(storeKey, store.names)
    setNames({ ...store.names })
    setRenaming('')
  }

  useEffect(() => {
    if (!menuOpen) return undefined
    const outside = (event) => { if (!menuRef.current?.contains(event.target)) setMenuOpen(false) }
    document.addEventListener('pointerdown', outside)
    return () => document.removeEventListener('pointerdown', outside)
  }, [menuOpen])

  const renameInput = (id) => (
    <TInput class="terminal-rename" autoFocus value={renameValue} onInput={(event) => setRenameValue(event.currentTarget.value)} onClick={(event) => event.stopPropagation()} onBlur={() => commitRename(id)} onKeyDown={(event) => { event.stopPropagation(); if (event.key === 'Enter') commitRename(id); if (event.key === 'Escape') setRenaming('') }} />
  )
  const tabName = (id, index) => names[id] || `sh ${index + 1}`
  // Past two terminals a flat strip eats the whole toolbar — collapse to a
  // count-bearing dropdown instead.
  const collapsed = tabs.length > 2
  const activeIndex = Math.max(0, tabs.indexOf(active))

  return (
    <div style="display:flex; flex:1; min-height:0; flex-direction:column">
      <div class="terminal-tabs">
        {collapsed ? (
          <div class="terminal-menu" ref={menuRef}>
            <button type="button" class="terminal-tab terminal-menu-toggle active" title={t('terminal.list')} aria-haspopup="listbox" aria-expanded={menuOpen} onClick={() => setMenuOpen((open) => !open)}>
              <span><TerminalIcon size={13} /><span class="terminal-tab-name">{tabName(active, activeIndex)}</span><span class="terminal-menu-count">{tabs.length}</span><ChevronDown size={12} /></span>
            </button>
            {menuOpen && (
              <div class="terminal-menu-list" role="listbox" aria-label={t('terminal.list')}>
                {tabs.map((id, index) => (
                  <div key={id} class={`terminal-menu-item ${id === active ? 'active' : ''}`} role="option" aria-selected={id === active}>
                    <button type="button" class="terminal-menu-item-main" onClick={() => { activateTab(id); if (renaming !== id) setMenuOpen(false) }} onDoubleClick={() => { setRenaming(id); setRenameValue(names[id] || '') }} title={t('terminal.renameHint')}>
                      {unread.has(id) && <span class="terminal-tab-unread" aria-hidden="true" />}
                      <TerminalIcon size={13} />
                      {renaming === id ? renameInput(id) : <span class="terminal-tab-name">{tabName(id, index)}</span>}
                    </button>
                    <span class="terminal-tab-close" role="button" tabIndex={0} title={t('terminal.close')} aria-label={t('terminal.close')} onClick={(event) => closeTab(event, id)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); closeTab(event, id) } }}><X size={13} /></span>
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : tabs.map((id, index) => (
          <button key={id} class={`terminal-tab ${id === active ? 'active' : ''}`} type="button" title={t('terminal.renameHint')} onClick={() => activateTab(id)} onDoubleClick={() => { setRenaming(id); setRenameValue(names[id] || '') }}>
            {unread.has(id) && <span class="terminal-tab-unread" aria-hidden="true" />}
            {renaming === id
              ? renameInput(id)
              : <span><TerminalIcon size={13} /><span class="terminal-tab-name">{tabName(id, index)}</span></span>}
            <span class="terminal-tab-close" role="button" tabIndex={0} title={t('terminal.close')} aria-label={t('terminal.close')} onClick={(event) => closeTab(event, id)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); closeTab(event, id) } }}><X size={13} /></span>
          </button>
        ))}
        <vscode-toolbar-button icon="add" onClick={newTab} title={t('terminal.new')} aria-label={t('terminal.new')}></vscode-toolbar-button>
        <vscode-toolbar-button icon="search" title={t('terminal.search')} aria-label={t('terminal.search')} disabled={!active} onClick={() => { if (active) window.dispatchEvent(new CustomEvent('harpy:terminal-search', { detail: active })) }}></vscode-toolbar-button>
      </div>
      {error && <div class="error-text" role="alert" style="padding:8px">{error}</div>}
      {active && <div class="terminal-mobile-stage"><TerminalView key={active} id={active} workspaceKey={storeKey} onReady={handleTerminalReady} modifiersRef={terminalModifiersRef} /><TerminalAccessory terminalId={active} actionsRef={terminalActionsRef} modifiersRef={terminalModifiersRef} /></div>}
      {!active && !error && reconciling && <div class="terminal-empty" role="status"><span class="muted">{t('terminal.restoring')}</span></div>}
      {!active && !error && !reconciling && <div class="terminal-empty"><button type="button" class="terminal-empty-cta" onClick={newTab}><TerminalIcon size={15} />{t('terminal.new')}</button></div>}
    </div>
  )
}
