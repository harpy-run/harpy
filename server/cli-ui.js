import readline from 'node:readline/promises'
import { emitKeypressEvents } from 'node:readline'

// Tiny interactive layer for the CLI — standard library only so the published
// package stays dependency-light. Every helper degrades to plain output when
// stdout is not a TTY (pipes, CI, daemon logs).

export const isInteractive = () => Boolean(process.stdin.isTTY && process.stdout.isTTY)

const paint = (code) => (text) => `\x1b[${code}m${text}\x1b[0m`
const noColor = Boolean(process.env.NO_COLOR) || !process.stdout.isTTY
const wrap = (code) => (text) => (noColor ? String(text) : paint(code)(text))

export const c = {
  bold: wrap(1),
  dim: wrap(2),
  accent: wrap(35),   // harpy indigo → magenta reads well on dark terminals
  ok: wrap(32),
  warn: wrap(33),
  err: wrap(31),
  cyan: wrap(36)
}

export function box(title, rows) {
  // eslint-disable-next-line no-control-regex -- stripping ANSI escapes is the point
  const plain = (row) => row.replace(/\x1b\[[0-9;]*m/g, '')
  const width = Math.min(72, Math.max(title.length + 2, ...rows.map((row) => plain(row).length + 2)))
  console.log(`  ┌─ ${c.bold(title)} ${'─'.repeat(Math.max(0, width - title.length - 2))}┐`)
  for (const row of rows) console.log(`  │ ${row}`)
  console.log(`  └${'─'.repeat(width)}┘`)
}

let rl = null
function prompt() {
  if (!rl) rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  return rl
}

export function closePrompts() {
  if (rl) { rl.close(); rl = null }
}

export async function ask(question, fallback = '') {
  const suffix = fallback ? ` ${c.dim(`[${fallback}]`)}` : ''
  try {
    const answer = (await prompt().question(`  ${question}${suffix}: `)).trim()
    return answer || fallback
  } catch {
    return fallback // EOF — accept the default
  }
}

// `opts.note` prints as a dim footnote under the question; `yes`/`no`/`hint`
// let the caller pass locale words (cli-i18n) so e.g. `e`/`evet` answers a
// Turkish prompt. An unrecognized non-empty answer falls back too — a typo
// should never silently flip a default-yes choice to no.
export async function confirm(question, fallback = true, { note, yes = ['y', 'yes'], no = ['n', 'no'], hint } = {}) {
  if (note) console.log(`  ${c.dim(note)}`)
  const keys = hint || (fallback ? `${yes[0][0].toUpperCase()}/${no[0][0]}` : `${yes[0][0]}/${no[0][0].toUpperCase()}`)
  const yesSet = new Set(yes.map((w) => w.toLowerCase()))
  const noSet = new Set(no.map((w) => w.toLowerCase()))
  try {
    const answer = (await prompt().question(`  ${question} ${c.dim(`[${keys}]`)}: `)).trim().toLowerCase()
    if (!answer) return fallback
    if (yesSet.has(answer)) return true
    if (noSet.has(answer)) return false
    return fallback
  } catch {
    return fallback
  }
}

// Arrow-key pick-list: ↑/↓ (or j/k) move the highlighted row, Enter returns
// the option's `value`, Esc returns 'back', q / Ctrl+C return null. Non-TTY
// callers get the default without prompting.
export async function choose(title, options, { defaultValue, footer } = {}) {
  if (!isInteractive()) return defaultValue ?? options[0]?.value
  if (!options.length) return null
  closePrompts() // raw mode must own stdin — an open question-rl would eat keys
  const stdin = process.stdin
  const out = process.stdout
  if (!stdin.listenerCount('keypress')) emitKeypressEvents(stdin)
  stdin.setRawMode(true)
  stdin.resume()
  let index = Math.max(0, options.findIndex((o) => o.value === defaultValue))
  let rows = 0
  const render = () => {
    if (rows) out.write(`\x1b[${rows}A\x1b[0J`) // cursor back to row 1, wipe the block
    const lines = title ? [`  ${c.bold(title)}`] : []
    for (const [i, option] of options.entries()) {
      const text = `${option.label}${option.hint ? `  ${c.dim(option.hint)}` : ''}`
      lines.push(i === index ? `  ${c.accent('›')} ${c.bold(text)}` : `    ${text}`)
    }
    lines.push(`  ${c.dim(footer || '↑↓ move · enter select · esc back')}`)
    out.write(lines.join('\n') + '\n')
    rows = lines.length
  }
  render()
  const value = await new Promise((resolve) => {
    const done = (v) => { stdin.removeListener('keypress', onKey); resolve(v) }
    const onKey = (_ch, key = {}) => {
      if (key.name === 'return') return done(options[index].value)
      if (key.name === 'escape' || key.name === 'b') return done('back')
      if ((key.ctrl && key.name === 'c') || key.name === 'q') return done(null)
      if (key.name === 'up' || key.name === 'k') index = (index - 1 + options.length) % options.length
      else if (key.name === 'down' || key.name === 'j') index = (index + 1) % options.length
      else if (key.name === 'home') index = 0
      else if (key.name === 'end') index = options.length - 1
      else return
      render()
    }
    stdin.on('keypress', onKey)
  })
  stdin.setRawMode(false)
  stdin.pause()
  out.write(`\x1b[${rows}A\x1b[0J`) // collapse the list → one summary line
  const picked = options.find((o) => o.value === value)
  console.log(`  ${c.dim(title ? `${title} —` : '')} ${picked ? c.accent(`› ${picked.label}`) : c.dim('·')}`)
  return value
}
