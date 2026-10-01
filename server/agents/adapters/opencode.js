import { Adapter } from '../adapter.js'

export class OpenCodeAdapter extends Adapter {
  static id = 'opencode'
  static label = 'OpenCode'
  static cli = 'opencode'
  static icon = '/icons/opencode-logo-dark.svg'
  static interactive = false
  static install = { command: 'npm install -g opencode-ai' }

  buildTerminalArgs() { return [] }
  buildResumeArgs() { return ['--continue'] }
  // `run -c` only resumes opencode's *last* session — the JSON stream carries
  // sessionID on every event, so follow-ups resume it by name instead of
  // gambling on whatever session happened most recently.
  buildContinueArgs({ prompt, sessionId } = {}) {
    const resume = sessionId ? ['--session', sessionId] : ['--continue']
    return ['run', ...(prompt ? [prompt] : []), ...resume, '--format', 'json']
  }
  buildArgs({ prompt } = {}) { return ['run', ...(prompt ? [prompt] : []), '--format', 'json'] }
  normalizeLine(line) {
    let event
    try { event = JSON.parse(line) } catch { return [] }
    const out = []
    if (event.sessionID) out.push({ type: 'meta', sessionId: event.sessionID })
    if (event.type === 'text' && event.part?.text) out.push({ type: 'message', role: 'assistant', text: event.part.text })
    else if (event.type === 'error') out.push({ type: 'status', status: 'error', reason: event.error?.message || event.error?.name || 'opencode error' })
    return out
  }
}
