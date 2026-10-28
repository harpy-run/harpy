// Mobile keyboards edit a textarea (including replacing an earlier word),
// while a PTY accepts a stream of keys. Keep the text entered through this
// textarea as a known suffix, then translate native edits into backspaces
// and new text. Never infer editable input from terminal output/prompts.
export function attachTerminalMobileInput(terminal, { isModified = () => false } = {}) {
  const textarea = terminal.textarea
  const element = terminal.element
  if (!textarea || !element) return null
  const mobile = window.matchMedia?.('(any-pointer: coarse)')?.matches || navigator.maxTouchPoints > 0
  if (!mobile || terminal.options.screenReaderMode) return null

  textarea.setAttribute('autocorrect', 'on')
  textarea.setAttribute('autocomplete', 'on')
  textarea.setAttribute('spellcheck', 'true')
  textarea.setAttribute('autocapitalize', 'none')

  let text = ''
  let sending = false
  let disposed = false
  let compositionFrame = 0
  let composing = false
  let candidate = ''
  let beforeEdit = null
  let deletedWord = ''
  let automaticSpace = ''
  let automaticSpaceUntil = 0
  let spaceKey = false
  const reset = () => {
    text = ''
    textarea.value = ''
    composing = false
    candidate = ''
    beforeEdit = null
    deletedWord = ''
    automaticSpace = ''
    automaticSpaceUntil = 0
    spaceKey = false
    if (compositionFrame) cancelAnimationFrame(compositionFrame)
    compositionFrame = 0
  }
  const send = (data) => {
    if (!data || disposed || terminal.options.disableStdin) return
    sending = true
    try { terminal.input(data, true) } finally { sending = false }
  }
  const sync = () => {
    if (disposed || terminal.options.disableStdin) return
    const next = textarea.value
    const previous = Array.from(text)
    const current = Array.from(next)
    let prefix = 0
    while (prefix < previous.length && prefix < current.length && previous[prefix] === current[prefix]) prefix++
    const modified = isModified()
    text = next
    // Rewrite the entire changed suffix: the remote cursor is at its end,
    // even when a suggestion also replaces a word before a trailing space.
    send('\x7f'.repeat(previous.length - prefix) + current.slice(prefix).join(''))
    // This helper represents the editable suffix at the remote cursor. Some
    // native insertion paths leave its invisible caret at zero after input.
    // Keep subsequent typing at the suffix end without moving an active IME.
    if (!composing && textarea.value === next && document.activeElement === textarea) {
      textarea.setSelectionRange(next.length, next.length)
    }
    if (modified) reset()
  }
  const wordAtEnd = (value) => value.match(/[\p{L}\p{M}\p{N}]+$/u)
  const finishCandidate = () => {
    if (disposed || terminal.options.disableStdin || composing) return
    sync()
    if (!candidate) return
    const accepted = candidate === text
    candidate = ''
    if (!accepted) return
    if (!wordAtEnd(text)) return
    textarea.value = text + ' '
    textarea.setSelectionRange(textarea.value.length, textarea.value.length)
    sync()
    automaticSpace = text
    automaticSpaceUntil = performance.now() + 200
  }
  const scheduleCommit = () => {
    if (compositionFrame) cancelAnimationFrame(compositionFrame)
    compositionFrame = requestAnimationFrame(() => {
      compositionFrame = 0
      // A few IMEs apply their final DOM update after the input event.
      noteCandidate({ inputType: 'insertFromComposition' })
      sync()
      finishCandidate()
    })
  }
  const noteCandidate = (event) => {
    const next = textarea.value
    if (candidate !== next) candidate = ''
    const previous = text || deletedWord
    const word = wordAtEnd(previous)
    let prefix = 0
    while (prefix < previous.length && prefix < next.length && previous[prefix] === next[prefix]) prefix++
    const insertion = ['insertText', 'insertReplacementText', 'insertCompositionText', 'insertFromComposition'].includes(event.inputType)
    // Only complete the final word. Ordinary single-character IME revisions
    // (including accents) and replacements before other text get no space.
    if (insertion && word && wordAtEnd(next) && prefix >= word.index) {
      const selectedWord = !composing && event.inputType === 'insertText'
        && beforeEdit && beforeEdit.end - beforeEdit.start > 1
      if (event.inputType === 'insertReplacementText' || selectedWord
        || Array.from(next.slice(prefix)).length > 1) candidate = next
    }
    if (event.inputType === 'deleteContentBackward' && word && prefix >= word.index
      && Array.from(previous.slice(prefix)).length > 1) deletedWord = previous
    else if (insertion) deletedWord = ''
    beforeEdit = null
  }
  const owns = (event) => event.target === textarea
  const consume = (event) => event.stopImmediatePropagation()
  const beforeInput = (event) => {
    if (!owns(event)) return
    if (terminal.options.disableStdin) { event.preventDefault(); consume(event); return }
    if (event.inputType === 'insertFromPaste') return // xterm keeps bracketed paste
    if (event.inputType === 'insertLineBreak' || event.inputType === 'insertParagraph') {
      event.preventDefault()
      consume(event)
      finishCandidate()
      sync()
      reset()
      send('\r')
      return
    }
    // xterm may have populated the helper with selected output for copying.
    // It is never a correction context that may be erased in the PTY.
    // IMEs may update their composing range before dispatching beforeinput.
    // A changed helper value is therefore still a native edit to reconcile;
    // discarding the sent suffix here loses the replacement's erase range.
    if (terminal.hasSelection() || isModified()) reset()
    beforeEdit = { start: textarea.selectionStart, end: textarea.selectionEnd }
  }
  const input = (event) => {
    if (!owns(event) || event.inputType === 'insertFromPaste') return
    consume(event)
    if (event.inputType === 'insertLineBreak' || event.inputType === 'insertParagraph') {
      finishCandidate()
      reset()
      send('\r')
      return
    }
    // Some keyboards deliver their own auto-space in a separate event after
    // accepting a candidate. Reconcile that one event with our added space;
    // an explicit press of Space still inserts the user's extra space.
    if (automaticSpace && performance.now() <= automaticSpaceUntil && !spaceKey
      && event.data === ' ' && textarea.value === automaticSpace + ' ') {
      textarea.value = automaticSpace
      textarea.setSelectionRange(automaticSpace.length, automaticSpace.length)
    }
    automaticSpace = ''
    spaceKey = false
    noteCandidate(event)
    // Some Android keyboards send deletion without a keydown/beforeinput.
    if (!text && !textarea.value && event.inputType === 'deleteContentBackward') send('\x7f')
    else sync()
    if (candidate && !composing) scheduleCommit()
  }
  const composition = (event) => {
    if (!owns(event)) return
    // xterm's composition helper cannot reconcile replacements of already
    // sent words. Own this whole path so keyCode 229 and input never double
    // send a suggestion. The native IME remains responsible for composition.
    consume(event)
    if (event.type === 'compositionstart') composing = true
    if (event.type === 'compositionend') {
      composing = false
      scheduleCommit()
    }
  }
  const clearContext = (event) => { if (owns(event)) reset() }
  // Ancestor capture runs before xterm's own capture listeners on textarea.
  const listeners = [
    ['beforeinput', beforeInput], ['input', input],
    ['compositionstart', composition], ['compositionupdate', composition], ['compositionend', composition],
    ['blur', clearContext], ['paste', clearContext]
  ]
  for (const [type, listener] of listeners) element.addEventListener(type, listener, true)
  const dataListener = terminal.onData(() => { if (!sending) reset() })
  const selectionListener = terminal.onSelectionChange(() => { if (!sending) reset() })

  return {
    handleKey(event) {
      if (event.type !== 'keydown' && event.type !== 'keypress') return true
      if (terminal.options.disableStdin) return true
      const altGraph = event.getModifierState?.('AltGraph')
      if (event.metaKey || !altGraph && (event.ctrlKey || event.altKey)) {
        reset()
        return true
      }
      // Some soft keyboards leave KeyboardEvent.key empty but still report
      // a printable charCode/which. Letting those keypresses reach xterm sends
      // the character once here and again when the native input event arrives.
      const legacyKey = !event.key
      const code = event.keyCode || event.which || 0
      const controlKey = [8, 9, 13, 16, 17, 18, 19, 20, 27, 33, 34, 35, 36, 37, 38, 39, 40, 45, 46, 91, 92, 93, 144, 145].includes(code)
        || code >= 112 && code <= 135
      const printableKeydown = event.type === 'keydown' && legacyKey && !controlKey
      const charCode = event.charCode || event.which || event.keyCode || 0
      const printableKeypress = event.type === 'keypress' && charCode >= 32 && charCode !== 127
      const backspace = event.key === 'Backspace' || legacyKey && code === 8
      if (event.type === 'keydown') spaceKey = event.key === ' ' || legacyKey && code === 32
      const nativeText = event.keyCode === 229 || event.isComposing || event.key === 'Dead'
        || event.key === 'Unidentified' || Array.from(event.key || '').length === 1
        || printableKeydown || printableKeypress
        || backspace && !!textarea.value
      if (nativeText) return false
      if (event.type === 'keydown' && !['Shift', 'Control', 'Alt', 'Meta', 'CapsLock'].includes(event.key)) {
        finishCandidate()
        sync()
        reset()
      }
      return true
    },
    dispose() {
      disposed = true
      if (compositionFrame) cancelAnimationFrame(compositionFrame)
      for (const [type, listener] of listeners) element.removeEventListener(type, listener, true)
      dataListener.dispose()
      selectionListener.dispose()
    }
  }
}
