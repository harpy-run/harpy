import { Adapter } from '../adapter.js'

export class ClaudeAdapter extends Adapter {
  static id = 'claude'
  static label = 'Claude Code'
  static cli = 'claude'
  static icon = '/icons/claude-ai-icon.svg'
  static interactive = true
  static install = { command: 'npm install -g @anthropic-ai/claude-code' }
  // Claude refuses --dangerously-skip-permissions under root/sudo. When the
  // daemon itself runs as root (containers, VPS installs) IS_SANDBOX is the
  // documented opt-in that tells claude the whole box is disposable anyway.
  spawnEnv() { return process.getuid?.() === 0 ? { IS_SANDBOX: '1' } : null }

  buildTerminalArgs() { return ['--dangerously-skip-permissions'] }
  buildResumeArgs() { return ['--continue', '--dangerously-skip-permissions'] }
  // Headless follow-up: --resume <id> targets the conversation this shell
  // started (captured from the init frame); --continue is the fallback and
  // picks the most recent conversation in this cwd.
  buildContinueArgs({ prompt, sessionId } = {}) {
    const args = this.buildArgs({ prompt })
    const flag = sessionId ? ['--resume', sessionId] : ['--continue']
    if (prompt) args.splice(-1, 0, ...flag)
    else args.push(...flag)
    return args
  }
  buildArgs({ prompt } = {}) {
    // Skip-permissions is required for the headless memory digest to write
    // MEMORY.md — without it every file edit stalls on an approval nobody sees.
    const args = ['-p', '--dangerously-skip-permissions', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--input-format', 'stream-json']
    if (prompt) args.push(prompt)
    return args
  }

  buildUserFrame(text) {
    return `${JSON.stringify({ type: 'user', message: { role: 'user', content: text } })}\n`
  }

  normalizeLine(line) {
    let object
    try { object = JSON.parse(line) } catch { return [{ type: 'message', role: 'assistant', text: line }] }
    const events = []
    if (object.type === 'system' && object.subtype === 'init') {
      events.push({ type: 'status', role: 'system', status: 'ready', providerSessionId: object.session_id })
    } else if (object.type === 'assistant') {
      const content = object.message?.content
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'text' && block.text) events.push({ type: 'message', role: 'assistant', text: block.text })
          if (block.type === 'tool_use') events.push({ type: 'tool', role: 'assistant', tool: { name: block.name, input: block.input } })
        }
      }
    } else if (object.type === 'result') {
      events.push({ type: 'done', role: 'system', result: object.result, usage: object.usage })
    }
    return events
  }
}
