import { useEffect, useRef, useState } from 'preact/hooks'
import { ArrowDownToLine, ChevronDown, ChevronUp } from '../lib/icons.jsx'
import { t } from '../lib/i18n.js'
import { scrollTerminalLines } from '../lib/terminal-touch.js'
import { terminalScrollSpeed } from '../state/app.js'

const HOLD_DELAY_MS = 280
const HOLD_REPEAT_MS = 55
const TAP_LINES = 5
// Key-repeat acceleration, stepped like a held Backspace: gentle for the
// first seconds, then it shifts up a gear instead of spinning out.
const HOLD_STEPS = [[3000, 5], [7000, 15], [Infinity, 30]]

// Floating edge arrows so any pointer can scroll a terminal like a mouse
// wheel: tap for a few lines, hold for a continuous repeat. On desktop they
// sit dimmed beside the scrollbar and brighten on hover.
export function TerminalScrollButtons({ hostRef, terminalRef, terminal }) {
  const repeat = useRef({ delay: 0, interval: 0 })
  const [awayFromLatest, setAwayFromLatest] = useState(false)

  useEffect(() => () => {
    clearTimeout(repeat.current.delay)
    clearInterval(repeat.current.interval)
  }, [])

  useEffect(() => {
    if (!terminal) return undefined
    const update = () => {
      const buffer = terminal.buffer?.active
      setAwayFromLatest(!!buffer && buffer.type !== 'alternate' && buffer.viewportY < buffer.baseY)
    }
    const scroll = terminal.onScroll(update)
    const parsed = terminal.onWriteParsed(update)
    update()
    return () => { scroll.dispose(); parsed.dispose() }
  }, [terminal])

  function scroll(direction, lines = TAP_LINES) {
    scrollTerminalLines(hostRef.current, terminalRef.current, lines * terminalScrollSpeed.value * direction)
  }

  function press(direction) {
    return (event) => {
      event.preventDefault()
      event.stopPropagation()
      release()
      scroll(direction)
      const heldAt = Date.now()
      repeat.current.delay = setTimeout(() => {
        repeat.current.interval = setInterval(() => {
          const held = Date.now() - heldAt
          const lines = HOLD_STEPS.find(([until]) => held < until)[1]
          scroll(direction, lines)
        }, HOLD_REPEAT_MS)
      }, HOLD_DELAY_MS)
    }
  }

  function pressDown(event) {
    if (!awayFromLatest) { press(1)(event); return }
    event.preventDefault()
    event.stopPropagation()
    release()
    ;(terminal || terminalRef.current)?.scrollToBottom()
  }

  // Pointer presses already scroll on pointerdown so held arrows can repeat.
  // Native keyboard and assistive-technology clicks have detail === 0 and need
  // a separate one-step action because pointerdown never fires for them.
  function activate(direction) {
    return (event) => {
      if (event.detail !== 0) return
      event.preventDefault()
      event.stopPropagation()
      scroll(direction)
    }
  }

  function activateDown(event) {
    if (event.detail !== 0) return
    event.preventDefault()
    event.stopPropagation()
    if (awayFromLatest) (terminal || terminalRef.current)?.scrollToBottom()
    else scroll(1)
  }

  function release() {
    clearTimeout(repeat.current.delay)
    clearInterval(repeat.current.interval)
    repeat.current.delay = 0
    repeat.current.interval = 0
  }

  // Taps must never reach the host's click-to-focus listener or move focus
  // onto the button — the keyboard stays in whatever state the user left it.
  const swallow = (event) => { event.preventDefault(); event.stopPropagation() }
  const stop = (event) => event.stopPropagation()

  return <div class="terminal-scroll-buttons"
    onTouchStart={stop} onTouchMove={stop} onTouchEnd={stop}
    onClick={swallow} onPointerUp={stop} onAuxClick={swallow}>
    <button type="button" class="terminal-scroll-btn" aria-label={t('terminal.scrollUp')}
      onPointerDown={press(-1)} onClick={activate(-1)} onPointerUp={release} onPointerLeave={release} onPointerCancel={release} onContextMenu={(event) => event.preventDefault()}>
      <ChevronUp size={18} />
    </button>
    <button type="button" class="terminal-scroll-btn" aria-label={awayFromLatest ? t('terminal.latest') : t('terminal.scrollDown')} title={awayFromLatest ? t('terminal.latest') : t('terminal.scrollDown')}
      onPointerDown={pressDown} onClick={activateDown} onPointerUp={release} onPointerLeave={release} onPointerCancel={release} onContextMenu={(event) => event.preventDefault()}>
      {awayFromLatest ? <ArrowDownToLine size={18} /> : <ChevronDown size={18} />}
    </button>
  </div>
}
