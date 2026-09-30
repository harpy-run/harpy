import { t } from './i18n.js'

// Native-feel touch scrolling for xterm. The rendered screen overlays the
// scrollable viewport, so the browser's own pan can never reach it; instead
// we own the gesture (touch-action:none) and drive the scroll ourselves:
//
//   normal buffer — move the viewport's scrollTop in pixels for smooth,
//                   1:1 finger tracking plus release momentum;
//   alt-buffer / mouse-reporting TUI (devin, claude, vim, …) — the viewport
//                   has nothing to scroll. When the app reports mouse mode
//                   we forward real wheel events (xterm turns them into SGR
//                   mouse reports); when it does not, we translate drags into
//                   arrow keys — the same thing xterm does for wheel input in
//                   the alternate buffer.
const DRAG_THRESHOLD_PX = 6
const MOMENTUM_DECAY = 0.94
const MOMENTUM_MIN_PX = 0.4
const FRAME_MS = 16.7
const LONG_PRESS_MS = 450

const terminalViewport = (host) => host?.querySelector('.xterm-viewport')
const terminalXterm = (host) => host?.querySelector('.xterm')
const lineHeightPx = (terminal) => Math.max(8, (terminal?.options?.fontSize || 13) * (terminal?.options?.lineHeight || 1.25))
const inMouseMode = (terminal) => terminal?.modes?.mouseTrackingMode !== 'none'
const inAltBuffer = (terminal) => terminal?.buffer?.active?.type === 'alternate'

const WORD_SEPARATORS = /[\s'"`()[\]{}<>|&;:=]/

// Long-press word selection: converts the touch point into a buffer cell via
// the render service's cell metrics, expands to word bounds on that line, and
// selects it. A copy chip then offers one-tap clipboard copy.
function selectWordAt(terminal, host, clientX, clientY) {
  const rows = host.querySelector('.xterm-rows')
  const dims = terminal?._core?._renderService?.dimensions?.css?.cell
  const buffer = terminal?.buffer?.active
  if (!rows || !dims?.width || !dims?.height || !buffer) return
  const rect = rows.getBoundingClientRect()
  const col = Math.floor((clientX - rect.left) / dims.width)
  const vRow = Math.floor((clientY - rect.top) / dims.height)
  const lineIdx = buffer.viewportY + vRow
  const line = buffer.getLine(lineIdx)
  if (!line || col < 0) return

  // Buffer columns and JS string indexes diverge for surrogate pairs and
  // wide cells (CJK/emoji). Keep each printable cell's actual column range
  // so the selected range remains correct for every glyph width.
  const cells = []
  if (typeof line.getCell === 'function') {
    for (let column = 0; column < line.length; column++) {
      const cell = line.getCell(column)
      const width = cell?.getWidth?.() ?? 1
      if (width === 0) continue // second half of a wide character
      cells.push({
        start: column,
        end: column + Math.max(1, width) - 1,
        text: cell?.getChars?.() || ' '
      })
    }
  } else {
    const text = line.translateToString(true)
    let column = 0
    for (const char of text) {
      const width = /[\u1100-\u115f\u2329\u232a\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe19\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6\u{1f300}-\u{1faff}]/u.test(char) ? 2 : 1
      cells.push({ start: column, end: column + width - 1, text: char })
      column += width
    }
  }

  const cellIndex = cells.findIndex((cell) => col >= cell.start && col <= cell.end)
  if (cellIndex < 0 || WORD_SEPARATORS.test(cells[cellIndex].text)) return
  let start = cellIndex
  let end = cellIndex
  while (start > 0 && !WORD_SEPARATORS.test(cells[start - 1].text)) start--
  while (end < cells.length - 1 && !WORD_SEPARATORS.test(cells[end + 1].text)) end++
  const startColumn = cells[start].start
  const endColumn = cells[end].end
  terminal.select(startColumn, lineIdx, endColumn - startColumn + 1)
  navigator.vibrate?.(8)
}

// Button-driven scroll shared by the edge arrow strip and keyboard helpers.
// Lines are whole terminal rows; positive scrolls down through scrollback.
export function scrollTerminalLines(host, terminal, lines) {
  const px = lines * lineHeightPx(terminal)
  if (inMouseMode(terminal)) {
    terminalXterm(host)?.dispatchEvent(new WheelEvent('wheel', { deltaY: px, deltaMode: 0, bubbles: true, cancelable: true }))
  } else if (inAltBuffer(terminal)) {
    const seq = lines > 0 ? '\x1b[B' : '\x1b[A'
    for (let i = 0; i < Math.abs(Math.round(lines)); i++) terminal?.input(seq, false)
  } else {
    terminalViewport(host)?.scrollBy({ top: px, behavior: 'smooth' })
  }
}

export function attachTerminalTouchScroll(host, terminal, getSpeed = () => 1) {
  if (!host) return () => {}

  let startY = 0
  let lastY = 0
  let lastT = 0
  let velocity = 0 // px per ms, positive when dragging up (content scrolls down)
  let target = null
  let scrolling = false
  let momentumFrame = 0
  let longPressTimer = 0
  let longPressPoint = null

  // Mouse-reporting apps get real wheel events; other alt-buffer TUIs get
  // arrow keys — xterm only listens to wheel while mouse mode is active, so
  // a wheel event on a plain alt-buffer app would go nowhere.
  const viaMouse = () => inMouseMode(terminal)
  const viaArrows = () => !inMouseMode(terminal) && inAltBuffer(terminal)

  const cancelMomentum = () => {
    if (momentumFrame) cancelAnimationFrame(momentumFrame)
    momentumFrame = 0
  }

  const wheel = (deltaY) => {
    terminalXterm(host)?.dispatchEvent(new WheelEvent('wheel', { deltaY, deltaMode: 0, bubbles: true, cancelable: true }))
  }

  // Carry of partial-line drags so a slow finger still accumulates whole
  // arrow presses instead of losing the remainder on every event.
  let arrowRemainder = 0
  const arrows = (delta) => {
    arrowRemainder += delta
    const unit = lineHeightPx(terminal)
    while (Math.abs(arrowRemainder) >= unit) {
      // delta > 0 means the finger moved up, i.e. content scrolls down.
      // wasUserInput=false keeps scrollOnUserInput from snapping back to the
      // prompt while the user is still dragging through history.
      terminal?.input(arrowRemainder > 0 ? '\x1b[B' : '\x1b[A', false)
      arrowRemainder -= Math.sign(arrowRemainder) * unit
    }
  }

  const apply = (delta) => {
    if (viaMouse()) wheel(delta)
    else if (viaArrows()) arrows(delta)
    else { const vp = terminalViewport(host); if (vp) vp.scrollTop += delta }
  }

  const onStart = (event) => {
    cancelMomentum()
    // The edge scroll strip and the touch scrollbar own their own gestures;
    // a touch starting there must not be treated as a content drag.
    if (event.touches.length !== 1 || event.target?.closest?.('.terminal-scroll-buttons, .terminal-scrollbar, .terminal-copy-chip')) { target = null; return }
    target = event.target
    startY = lastY = event.touches[0].pageY
    lastT = performance.now()
    velocity = 0
    arrowRemainder = 0
    scrolling = false
    longPressPoint = { x: event.touches[0].clientX, y: event.touches[0].clientY }
    longPressTimer = setTimeout(() => {
      if (longPressPoint && !scrolling) {
        selectWordAt(terminal, host, longPressPoint.x, longPressPoint.y)
        longPressPoint = null
        host.dispatchEvent(new CustomEvent('harpy:terminal-touch-consumed', { bubbles: true }))
      }
    }, LONG_PRESS_MS)
  }

  const onMove = (event) => {
    if (!target || event.touches.length !== 1) return
    const y = event.touches[0].pageY
    const now = performance.now()
    if (!scrolling && Math.abs(y - startY) < DRAG_THRESHOLD_PX) { lastY = y; lastT = now; return }
    scrolling = true
    if (target?.closest?.('.xterm')) {
      host.dispatchEvent(new CustomEvent('harpy:terminal-touch-consumed', { bubbles: true }))
      event.preventDefault()
      event.stopPropagation()
    }
    longPressPoint = null
    clearTimeout(longPressTimer)
    // Claim the gesture before xterm or the browser can: the page must not
    // scroll or pull-to-refresh while a terminal drag is in progress.
    event.preventDefault()
    event.stopPropagation()
    const delta = lastY - y
    const dt = now - lastT
    lastY = y
    lastT = now
    if (delta === 0) return
    // Exponential moving average of recent drag speed feeds the release
    // momentum; a slow careful drag barely moves after the finger lifts.
    if (dt > 0) velocity = velocity * 0.6 + (delta / dt) * 0.4
    apply(delta * (Number(getSpeed()) || 1))
  }

  const momentum = () => {
    momentumFrame = 0
    if (!target) return
    velocity *= MOMENTUM_DECAY
    const step = velocity * FRAME_MS
    if (Math.abs(step) < MOMENTUM_MIN_PX) { target = null; snapIfNearBottom(); return }
    apply(step * (Number(getSpeed()) || 1))
    momentumFrame = requestAnimationFrame(momentum)
  }

  // Within ~3 rows of the bottom the user is at the live edge, not reading
  // scrollback — glue them back so output never lands just out of view.
  const snapIfNearBottom = () => {
    const vp = terminalViewport(host)
    if (!vp) return
    const gap = vp.scrollHeight - vp.clientHeight - vp.scrollTop
    if (gap > 0 && gap < lineHeightPx(terminal) * 3) vp.scrollTop = vp.scrollHeight
  }

  const onEnd = (event) => {
    if (event.touches && event.touches.length > 0) return
    clearTimeout(longPressTimer)
    longPressPoint = null
    if (!target) return
    if (scrolling && Math.abs(velocity * FRAME_MS) >= MOMENTUM_MIN_PX) momentumFrame = requestAnimationFrame(momentum)
    else target = null
    scrolling = false
    // A tap's 6px wobble can leave the viewport parked a few px above the
    // bottom — then the next TUI paint (option screens, prompts) renders
    // below the fold and looks like the screen vanished. Near-bottom snaps.
    snapIfNearBottom()
  }

  host.addEventListener('touchstart', onStart, { capture: true, passive: true })
  host.addEventListener('touchmove', onMove, { capture: true, passive: false })
  host.addEventListener('touchend', onEnd, { capture: true, passive: true })
  host.addEventListener('touchcancel', onEnd, { capture: true, passive: true })

  // Draggable scrollbar + long-press copy chip for touch: mobile browsers
  // render overlay scrollbars that can never be grabbed, and xterm has no
  // touch text selection — so we draw our own thumb on the right edge and a
  // copy affordance after a long-press word select. The scrollbar hides
  // whenever the buffer fits the screen.
  let detachScrollbar = () => {}
  let detachCopyChip = () => {}
  if (window.matchMedia?.('(pointer: coarse)')?.matches) {
    detachScrollbar = attachScrollbar(host, terminal)
    detachCopyChip = attachCopyChip(host, terminal)
  }

  return () => {
    cancelMomentum()
    clearTimeout(longPressTimer)
    detachScrollbar()
    detachCopyChip()
    host.removeEventListener('touchstart', onStart, { capture: true })
    host.removeEventListener('touchmove', onMove, { capture: true })
    host.removeEventListener('touchend', onEnd, { capture: true })
    host.removeEventListener('touchcancel', onEnd, { capture: true })
  }
}

function attachScrollbar(host, _terminal) {
  const track = document.createElement('div')
  track.className = 'terminal-scrollbar'
  const thumb = document.createElement('div')
  thumb.className = 'terminal-scrollbar-thumb'
  track.appendChild(thumb)
  host.appendChild(track)

  const viewport = () => terminalViewport(host)
  const update = () => {
    const vp = viewport()
    if (!vp || vp.scrollHeight <= vp.clientHeight + 2) {
      track.classList.add('hidden')
      return
    }
    track.classList.remove('hidden')
    const trackH = track.clientHeight
    const thumbH = Math.max(28, trackH * (vp.clientHeight / vp.scrollHeight))
    const top = (trackH - thumbH) * (vp.scrollTop / Math.max(1, vp.scrollHeight - vp.clientHeight))
    thumb.style.height = `${thumbH}px`
    thumb.style.transform = `translateY(${top}px)`
  }

  let dragging = false
  const positionToScroll = (clientY) => {
    const vp = viewport()
    if (!vp) return
    const rect = track.getBoundingClientRect()
    const thumbH = thumb.clientHeight
    const y = clientY - rect.top - thumbH / 2
    const ratio = Math.min(1, Math.max(0, y / Math.max(1, rect.height - thumbH)))
    vp.scrollTop = ratio * (vp.scrollHeight - vp.clientHeight)
  }
  const onTouchStart = (event) => {
    event.preventDefault()
    event.stopPropagation()
    host.dispatchEvent(new CustomEvent('harpy:terminal-touch-consumed', { bubbles: true }))
    update() // scrollback may have grown while the viewport sat still
    dragging = true
    track.classList.add('dragging')
    positionToScroll(event.touches[0].clientY)
  }
  const onTouchMove = (event) => {
    if (!dragging) return
    event.preventDefault()
    event.stopPropagation()
    positionToScroll(event.touches[0].clientY)
  }
  const onTouchEnd = (event) => {
    if (event.touches && event.touches.length > 0) return
    dragging = false
    track.classList.remove('dragging')
  }

  track.addEventListener('touchstart', onTouchStart, { passive: false })
  track.addEventListener('touchmove', onTouchMove, { passive: false })
  track.addEventListener('touchend', onTouchEnd, { passive: true })
  track.addEventListener('touchcancel', onTouchEnd, { passive: true })

  const vp = viewport()
  vp?.addEventListener('scroll', update, { passive: true })
  const observer = new ResizeObserver(update)
  if (vp) observer.observe(vp)
  // The scrollable content grows without firing scroll events when the user
  // is parked mid-scrollback — watching it keeps the thumb size honest.
  if (vp?.firstElementChild) observer.observe(vp.firstElementChild)
  observer.observe(host)
  update()

  return () => {
    observer.disconnect()
    vp?.removeEventListener('scroll', update)
    track.remove()
  }
}

// One-tap copy affordance shown while a touch selection exists. Desktop gets
// Ctrl+C; touch gets this chip.
function attachCopyChip(host, terminal) {
  const chip = document.createElement('button')
  chip.type = 'button'
  chip.className = 'terminal-copy-chip'
  chip.textContent = `⧉ ${t('terminal.copy')}`
  chip.hidden = true
  host.appendChild(chip)

  const sync = () => { chip.hidden = !terminal.hasSelection() }
  const copy = (event) => {
    event.preventDefault()
    event.stopPropagation()
    if (terminal.hasSelection()) {
      navigator.clipboard?.writeText(terminal.getSelection()).catch(() => {})
      terminal.clearSelection()
    }
    sync()
  }
  chip.addEventListener('click', copy)
  chip.addEventListener('touchstart', (event) => event.stopPropagation(), { passive: true })
  const selectionListener = terminal.onSelectionChange(sync)
  sync()

  return () => {
    selectionListener.dispose()
    chip.remove()
  }
}
