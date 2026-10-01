import { Adapter } from '../adapter.js'

export class CodexAdapter extends Adapter {
  static id = 'codex'
  static label = 'Codex'
  static cli = 'codex'
  static icon = '/icons/codex-white.svg'
  static interactive = false
  static install = { command: 'npm install -g @openai/codex' }

  buildTerminalArgs() { return [] }
  buildResumeArgs() { return ['resume', '--last'] }
  // `codex exec resume <thread>` keeps exec's flags — a follow-up turn stays
  // headless and still streams the same item.completed events. The caller
  // passes the thread_id captured from `thread.started`; --last is only a
  // fallback (it resumes the newest codex session anywhere, which may be a
  // daemon PTY session instead of this shell's turn).
  buildContinueArgs({ prompt, sessionId } = {}) {
    // resume has its own flag surface — --sandbox is an exec-only flag.
    return ['exec', 'resume', '--json', '--skip-git-repo-check', sessionId || '--last', ...(prompt ? [prompt] : [])]
  }
  // Digest runs from a scratch dir (not a git repo) and writes an absolute
  // path — skip the repo check and lift the workspace-write sandbox.
  buildArgs({ prompt } = {}) { return ['exec', '--json', '--skip-git-repo-check', '--sandbox', 'danger-full-access', ...(prompt ? [prompt] : [])] }

  normalizeLine(line) {
    let object
    try { object = JSON.parse(line) } catch { return [{ type: 'message', role: 'assistant', text: line }] }
    if (object.type === 'thread.started' && object.thread_id) {
      return [{ type: 'meta', sessionId: object.thread_id }]
    }
    if (object.type === 'item.completed' && (object.item?.type === 'message' || object.item?.type === 'agent_message')) {
      // Newer codex emits {type:'agent_message', text}; older wraps output_text
      // parts in content[] — accept both.
      const text = typeof object.item.text === 'string'
        ? object.item.text
        : (object.item.content || []).filter((part) => part.type === 'output_text').map((part) => part.text).join('')
      return text ? [{ type: 'message', role: 'assistant', text }] : []
    }
    if (object.type === 'item.completed' && object.item?.type === 'function_call') {
      return [{ type: 'tool', role: 'assistant', tool: { name: object.item.name, input: object.item.arguments } }]
    }
    if (object.type === 'task.completed') return [{ type: 'done', role: 'system', result: object }]
    return []
  }
}
