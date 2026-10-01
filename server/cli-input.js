// The boxed chat input — a raw-mode line editor that draws the prompt inside
// a rounded border with a live status strip above and a context/hint row
// below, claude-code style. Replaces readline for the shell prompt so the
// field reads as an actual input area.
//
// Lifecycle is event-driven (not promise-per-line): show() draws the block,
// Enter freezes the current frame into the transcript and fires onLine(),
// ^C/^D on an empty line fires onClose(). While a turn runs the editor stays
// "frozen" — only ^C reaches onSigint() — so streaming output can never
// corrupt the box. Overlays (fleet, wizards) call stop()/start() to take the
// terminal, the same way the old code rebuilt readline.

import readline from 'node:readline'
import { c, fit } from './cli-ui.js'

const dim = (s) => c.dim(s)
const border = (s) => c.dim(s)
const accent = (s) => c.accent(s)

// eslint-disable-next-line no-control-regex -- measuring visible width
const stripAnsi = (s) => String(s).replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
const cutTail = (s, n) => (s.length > n ? `…${s.slice(s.length - n + 1)}` : s)

// emitKeypressEvents unshifts chunks that arrive while no 'keypress' listener
// is attached — bytes typed in a stop()→attach() gap replay later, out of
// order, even duplicated. One permanent sink keeps the count above zero so
// parked windows (fleet overlay, /join, wizards) can never corrupt the stream.
let sinkAttached = false

export class BoxedInput {
  constructor({ agent, cwd, t, statusRow, menuItems, onLine, onClose, onSigint, onTabEmpty, history }) {
    this.agent = agent       // () => current agent name
    this.cwd = cwd           // () => working dir
    this.t = t               // i18n translator
    this.statusRow = statusRow   // () => live agents strip text
    this.menuItems = menuItems   // (buf) => [{name, desc, args}] for "/" bufs
    this.onLine = onLine
    this.onClose = onClose
    this.onSigint = onSigint
    this.onTabEmpty = onTabEmpty

    this.buf = ''
    this.cur = 0
    this.sel = 0
    this.hIdx = -1
    this.draft = ''
    this.menuOff = false     // esc dismissed the menu until the buf changes
    this.history = history || []

    this.drawn = false       // block on screen + cursor inside the input row
    this.active = false      // keys edit the buffer
    this.frozen = false      // submitted — only ^C live, for cancel
    this.tty = !!process.stdin.isTTY
    this._keyHandler = (str, key) => this.onKey(str, key)
    this._resizeHandler = () => { if (this.active) this.render() }
  }

  get line() { return this.buf }
  get busyable() { return this.tty }

  menu() {
    if (this.menuOff || !this.menuItems) return []
    return this.buf.startsWith('/') && !this.buf.includes(' ') ? this.menuItems(this.buf) : []
  }

  // --- rendering ----------------------------------------------------------

  block(final = false) {
    const out = process.stdout
    const cols = Math.min(out.columns || 80, 100)
    const viewW = cols - 10
    const start = Math.max(0, this.cur - (viewW - 1))
    const body = this.buf
      ? this.buf.slice(start, start + viewW)
      : dim(this.t('shPlaceholder').slice(0, viewW))
    const items = final ? [] : this.menu()
    if (this.sel >= items.length) this.sel = Math.max(0, items.length - 1)

    const left = dim(`  ${this.agent()} · ${cutTail(this.cwd(), Math.max(8, cols - 52))}`)
    const right = dim(` ${this.t('shInputHints')} `)
    const gap = cols - stripAnsi(left).length - stripAnsi(right).length
    const hint = fit(gap >= 2 ? left + ' '.repeat(gap) + right : left, cols)

    // Every row is fit() to the terminal width — a wrapped row would make the
    // cursor-up math in render()/reprint() land one row short and smear the
    // status line down the screen on each keystroke.
    const lines = [
      this.statusRow ? fit(this.statusRow(), cols) : '',
      '  ' + border('╭' + '─'.repeat(viewW + 4) + '╮'),
      '  ' + border('│') + ' ' + accent('›') + ' ' + body + ' '.repeat(Math.max(0, viewW - stripAnsi(body).length)) + ' ' + border('│'),
      '  ' + border('╰' + '─'.repeat(viewW + 4) + '╯'),
      hint,
      ...items.map((m, i) => {
        const label = `/${m.name}${m.args ? ' …' : ''}`
        return fit(i === this.sel
          ? `    ${accent('› ' + label.padEnd(14))} ${dim(m.desc)}`
          : `      ${dim(label.padEnd(14))} ${dim(m.desc)}`, cols)
      })
    ]
    return { lines, start }
  }

  render(final = false) {
    const out = process.stdout
    const { lines, start } = this.block(final)
    if (this.drawn) out.write('\x1b[2A') // cursor sits in the input row → back to the status row
    out.write('\r\x1b[J' + lines.join('\n') + '\n')
    // The trailing '\n' leaves the cursor one row past the block — the input
    // row is lines.length - 2 up, not -3. Landing one row low made every
    // redraw restart at the top border, drifting the block down a row per
    // keystroke and orphaning the old status row ("1 sleeping") each time.
    out.write(`\x1b[${lines.length - 2}A`) // back up to the input row
    out.write(`\x1b[${7 + this.cur - start}G`)
    this.drawn = true
  }

  // Fresh block below whatever came before (after output / a finished turn).
  show() {
    if (!this.tty) return
    this.buf = ''
    this.cur = 0
    this.sel = 0
    this.hIdx = -1
    this.menuOff = false
    this.drawn = false
    this.frozen = false
    this.active = true
    this.render()
  }

  finish(value) {
    const submitted = value !== null
    this.active = false
    this.frozen = submitted // stay attached for ^C-cancel during the turn
    if (this.tty) {
      this.render(true)
      const { lines } = this.block(true)
      process.stdout.write(`\x1b[${lines.length - 3}B\n`)
      this.drawn = false
    }
    if (!submitted) { this.stop(); this.onClose?.() }
    else this.onLine?.(value)
  }

  // --- the shell's print/status plumbing -----------------------------------

  // Repaint just the status strip above the box without moving the cursor.
  paintStatus(text) {
    if (!this.drawn || !this.active) return
    const cols = Math.min(process.stdout.columns || 80, 100)
    // No \x1b[s/\x1b[u — the input row sits exactly 2 rows below the status
    // row, and explicit math behaves the same on terminals that never
    // implemented SCOSC/SCORC. Column is recomputed like render() does.
    const viewW = cols - 10
    const start = Math.max(0, this.cur - (viewW - 1))
    process.stdout.write(`\x1b[2A\r\x1b[2K${fit(text, cols)}\r\x1b[2B\x1b[${7 + this.cur - start}G`)
  }

  // Print output above the block, then re-glue it — transcript stays clean.
  reprint(s) {
    if (!this.drawn || !this.active) { process.stdout.write(`${s}\n`); return }
    const out = process.stdout
    out.write('\x1b[2A\r\x1b[J') // to the status row, wipe the whole block
    out.write(`${s}\n`)
    this.drawn = false
    this.render()
  }

  // --- lifecycle ------------------------------------------------------------

  start() {
    const stdin = process.stdin
    if (!this.tty) {
      // Piped input — no box, just line events.
      const rl = readline.createInterface({ input: stdin, terminal: false })
      rl.on('line', (l) => this.onLine?.(l))
      rl.on('close', () => { if (!this._stopped && !this.frozen) this.onClose?.() })
      this._plain = rl
      return
    }
    readline.emitKeypressEvents(stdin)
    this._stopped = false
    stdin.setRawMode(true)
    stdin.resume()
    stdin.off('keypress', this._keyHandler) // nested start() must not double-attach
    stdin.on('keypress', this._keyHandler)
    if (!sinkAttached) { sinkAttached = true; stdin.on('keypress', () => { }) }
    process.stdout.on('resize', this._resizeHandler)
  }

  stop() {
    const stdin = process.stdin
    this._stopped = true
    if (this._plain) { this._plain.close(); this._plain = null; return }
    stdin.off('keypress', this._keyHandler)
    process.stdout.off('resize', this._resizeHandler)
    this.active = false
    this.frozen = false
    this.drawn = false
  }

  insert(text) {
    this.buf = this.buf.slice(0, this.cur) + text + this.buf.slice(this.cur)
    this.cur += text.length
    if (this.drawn) this.render()
  }

  set(s) {
    this.buf = s
    this.cur = s.length
  }

  // --- keys -----------------------------------------------------------------

  onKey(str, key = {}) {
    if (this.frozen) {
      if (key.ctrl && key.name === 'c') this.onSigint?.()
      return
    }
    if (!this.active) return
    const m = this.menu()

    if (key.ctrl && key.name === 'c') {
      if (this.buf) { this.set(''); this.sel = 0; return this.render() }
      return this.finish(null)
    }
    if (key.ctrl && key.name === 'd' && !this.buf) return this.finish(null)

    switch (key.name) {
      case 'return':
      case 'enter': {
        if (m.length) {
          const picked = m[this.sel]
          // No-arg commands run straight away; arg commands stay editable.
          if (picked.args) { this.set(`/${picked.name} `); this.sel = 0; return this.render() }
          return this.finish(`/${picked.name}`)
        }
        if (!this.buf.trim()) return this.render() // empty Enter = no-op, keep the box
        if (this.history[this.history.length - 1] !== this.buf) this.history.push(this.buf)
        return this.finish(this.buf)
      }
      case 'tab':
        if (m.length) { this.set(`/${m[this.sel].name} `); this.sel = 0 }
        else if (!this.buf) return void (this.onTabEmpty?.())
        break
      case 'escape':
        this.menuOff = true
        break
      case 'backspace':
        if (this.cur > 0) { this.buf = this.buf.slice(0, this.cur - 1) + this.buf.slice(this.cur); this.cur-- }
        break
      case 'delete':
        this.buf = this.buf.slice(0, this.cur) + this.buf.slice(this.cur + 1)
        break
      case 'left': this.cur = Math.max(0, this.cur - 1); break
      case 'right': this.cur = Math.min(this.buf.length, this.cur + 1); break
      case 'home': this.cur = 0; break
      case 'end': this.cur = this.buf.length; break
      case 'up':
        if (m.length) this.sel = (this.sel - 1 + m.length) % m.length
        else if (this.hIdx < this.history.length - 1) {
          if (this.hIdx === -1) this.draft = this.buf
          this.set(this.history[this.history.length - 1 - ++this.hIdx])
        }
        break
      case 'down':
        if (m.length) this.sel = (this.sel + 1) % m.length
        else if (this.hIdx >= 0) this.set(--this.hIdx === -1 ? this.draft : this.history[this.history.length - 1 - this.hIdx])
        break
      default:
        if (key.ctrl) {
          if (key.name === 'a') this.cur = 0
          else if (key.name === 'e') this.cur = this.buf.length
          else if (key.name === 'u') { this.buf = this.buf.slice(this.cur); this.cur = 0 }
          else if (key.name === 'k') this.buf = this.buf.slice(0, this.cur)
          else if (key.name === 'w') {
            const before = this.buf.slice(0, this.cur).replace(/\S+\s*$/, '')
            this.buf = before + this.buf.slice(this.cur)
            this.cur = before.length
          }
        } else if (str && !key.meta) {
          // eslint-disable-next-line no-control-regex -- pastes get flattened
          const t = str.replace(/[\r\n]+/g, ' ').replace(/[\x00-\x1f\x7f]/g, '')
          this.buf = this.buf.slice(0, this.cur) + t + this.buf.slice(this.cur)
          this.cur += t.length
          this.sel = 0
        }
    }
    if (this.buf !== this._lastBuf) this.menuOff = false
    this._lastBuf = this.buf
    this.render()
  }
}
