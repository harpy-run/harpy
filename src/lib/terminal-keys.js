import { attachTerminalMobileInput } from './terminal-mobile-input.js'
import { handleTerminalCopyKey } from './terminal-clipboard.js'

// Shared clipboard shortcuts and native mobile keyboard editing.
export function attachTerminalKeys(terminal, options) {
  const mobileInput = attachTerminalMobileInput(terminal, options)
  // Capture before xterm: its disabled-stdin path can skip custom handlers
  // in stopped/read-only agent sessions, although output remains selectable.
  const copyKey = (event) => handleTerminalCopyKey(terminal, event)
  terminal.element?.addEventListener('keydown', copyKey, true)
  terminal.attachCustomKeyEventHandler((event) => {
    if (handleTerminalCopyKey(terminal, event)) return false
    if (mobileInput?.handleKey(event) === false) return false
    if (event.type !== 'keydown' || !event.ctrlKey || event.shiftKey || event.altKey || event.metaKey) return true
    const key = event.key.toLowerCase()
    // Let the browser's native paste event through — xterm's own paste handler
    // sends it with bracketed paste. Intercepting it manually double-pastes.
    if (key === 'v') return false
    return true
  })
  const textarea = terminal.textarea
  if (textarea && !mobileInput) {
    textarea.setAttribute('autocorrect', 'off')
    textarea.setAttribute('autocapitalize', 'none')
    textarea.setAttribute('autocomplete', 'off')
    textarea.setAttribute('spellcheck', 'false')
  }
  return () => {
    terminal.element?.removeEventListener('keydown', copyKey, true)
    mobileInput?.dispose()
  }
}
