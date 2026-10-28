import assert from 'node:assert/strict'
import { handleTerminalCopyKey } from '../src/lib/terminal-clipboard.js'

const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
const originalDocument = globalThis.document
let selection = 'selected output'
let copied = ''
let prevented = false
let stopped = false
let focused = false
let removed = false
const terminal = {
  hasSelection: () => !!selection,
  getSelection: () => selection,
  clearSelection: () => { selection = '' }
}
const key = (shiftKey = false) => ({
  type: 'keydown', key: 'c', ctrlKey: true, shiftKey,
  preventDefault() { prevented = true },
  stopImmediatePropagation() { stopped = true }
})
try {
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { clipboard: { writeText: async text => { copied = text } } } })
  assert.equal(handleTerminalCopyKey(terminal, key()), true)
  await Promise.resolve()
  assert.equal(copied, 'selected output')
  assert.equal(selection, '')
  assert(prevented && stopped)
  prevented = false
  assert.equal(handleTerminalCopyKey(terminal, key()), false)
  assert.equal(prevented, false) // no selection: preserve Ctrl+C interrupt
  assert.equal(handleTerminalCopyKey(terminal, key(true)), true)
  assert.equal(prevented, true) // no selection: still block inspector shortcut
  selection = 'HTTP fallback'
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {} })
  globalThis.document = {
    activeElement: { focus() { focused = true } },
    body: { appendChild() {} },
    createElement: () => ({ style: {}, setAttribute() {}, select() {}, remove() { removed = true } }),
    execCommand: command => { assert.equal(command, 'copy'); return true }
  }
  assert.equal(handleTerminalCopyKey(terminal, key(true)), true)
  assert.equal(selection, '')
  assert(focused && removed)
  selection = 'denied clipboard'
  navigator.clipboard = { writeText: async () => { throw new Error('permission denied') } }
  handleTerminalCopyKey(terminal, key())
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(selection, '')
  console.log('PASS terminal copy shortcuts, SIGINT preservation, inspector cancellation and HTTP/denied clipboard fallbacks')
} finally {
  if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator)
  else delete globalThis.navigator
  if (originalDocument === undefined) delete globalThis.document
  else globalThis.document = originalDocument
}
