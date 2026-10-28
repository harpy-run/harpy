// Clipboard API requires a secure context. Keep a synchronous fallback for
// self-hosted HTTP deployments and browsers that deny clipboard permission.
export function copyTerminalSelection(terminal) {
  const text = terminal.getSelection()
  if (!text) return
  const copied = () => terminal.clearSelection()
  const fallback = () => {
    const active = document.activeElement
    const input = document.createElement('textarea')
    input.value = text
    input.setAttribute('readonly', '')
    input.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0'
    document.body.appendChild(input)
    try {
      input.select()
      if (document.execCommand('copy')) copied()
    } catch { /* Keep the selection available for a native copy retry. */ }
    finally { input.remove(); active?.focus({ preventScroll: true }) }
  }
  if (!navigator.clipboard?.writeText) { fallback(); return }
  try { Promise.resolve(navigator.clipboard.writeText(text)).then(copied, fallback) }
  catch { fallback() }
}

export function handleTerminalCopyKey(terminal, event) {
  if (event.type !== 'keydown' || event.altKey) return false
  const key = event.key.toLowerCase()
  const copy = key === 'c' && (event.ctrlKey || event.metaKey)
  if (!copy || (!event.shiftKey && !terminal.hasSelection())) return false
  // Returning false to xterm alone does not cancel browser shortcuts such
  // as Chrome's Ctrl+Shift+C element inspector.
  event.preventDefault()
  event.stopImmediatePropagation()
  if (terminal.hasSelection()) copyTerminalSelection(terminal)
  return true
}
