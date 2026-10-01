import { Adapter } from '../adapter.js'

export class GeminiAdapter extends Adapter {
  static id = 'gemini'
  static label = 'Gemini CLI'
  static cli = 'gemini'
  static icon = '/icons/gemini-ai-icon.svg'
  static interactive = false
  static install = { command: 'npm install -g @google/gemini-cli' }

  buildTerminalArgs() { return ['--yolo'] }
  buildResumeArgs() { return ['--resume', '--yolo'] }
  // --resume latest picks the most recent stored session headlessly.
  buildContinueArgs({ prompt } = {}) { return ['-p', prompt || '', '--yolo', '--resume', 'latest'] }
  // --yolo auto-approves tool calls so the headless digest can write MEMORY.md.
  buildArgs({ prompt } = {}) { return ['-p', prompt || '', '--yolo'] }
  normalizeLine(line) { return [{ type: 'message', role: 'assistant', text: line, partial: true }] }
}
