// Shared xterm input behavior: desktop Ctrl+C/V clipboard shortcuts and mobile
// keyboard corrections. Autocorrect must stay off — a soft-keyboard suggestion
// replaces the whole composing word, which xterm replays as garbled input.
export function attachTerminalKeys(terminal) {
  terminal.attachCustomKeyEventHandler((event) => {
    if (event.type !== 'keydown' || !event.ctrlKey || event.shiftKey || event.altKey || event.metaKey) return true
    const key = event.key.toLowerCase()
    // Selection present → copy; no selection → let ^C through as SIGINT.
    // Clearing after copy matters: a forgotten selection must not swallow
    // the next Ctrl+C forever — press once to copy, again to interrupt.
    if (key === 'c' && terminal.hasSelection()) {
      navigator.clipboard?.writeText(terminal.getSelection()).catch(() => {})
      terminal.clearSelection()
      return false
    }
    // Let the browser's native paste event through — xterm's own paste handler
    // sends it with bracketed paste. Intercepting it manually double-pastes.
    if (key === 'v') return false
    return true
  })
  const textarea = terminal.textarea
  if (textarea) {
    textarea.setAttribute('autocorrect', 'off')
    textarea.setAttribute('autocapitalize', 'none')
    textarea.setAttribute('autocomplete', 'off')
    textarea.setAttribute('spellcheck', 'false')
  }
}
