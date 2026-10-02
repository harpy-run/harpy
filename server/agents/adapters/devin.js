import { execFileSync } from 'node:child_process'
import { Adapter } from '../adapter.js'

export class DevinAdapter extends Adapter {
  static id = 'devin'
  static label = 'Devin'
  static cli = 'devin'
  static icon = '/icons/devin-icon.svg'
  static interactive = true
  static install = { command: 'curl -fsSL https://cli.devin.ai/install.sh | bash', windows: 'irm https://static.devin.ai/cli/setup.ps1 | iex' }

  buildTerminalArgs() { return ['--permission-mode', 'dangerous'] }
  // After a daemon restart, continue the conversation this session was on
  // instead of dropping the chat into a fresh one.
  buildResumeArgs() { return ['-c', '--permission-mode', 'dangerous'] }
  // `devin -p` prints no session id — the just-created conversation is the
  // newest entry in `devin list --format json` for this working directory.
  captureSessionId({ cwd } = {}) {
    try {
      // devin installs as a .cmd shim on Windows — batch files need cmd.exe.
      const win = process.platform === 'win32'
      const raw = execFileSync(
        win ? (process.env.ComSpec || 'cmd.exe') : 'devin',
        win ? ['/d', '/s', '/c', 'devin list --format json'] : ['list', '--format', 'json'],
        { cwd, encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }
      )
      const sessions = JSON.parse(raw || '[]')
      return sessions.sort((a, b) => (b.last_activity_at || 0) - (a.last_activity_at || 0))[0]?.id || null
    } catch { return null }
  }
  // -p's optional PROMPT value must directly follow the flag, so the resume
  // flag goes last: `-r <id>` targets the captured conversation and `-c`
  // (most recent) is only a fallback.
  buildContinueArgs({ prompt, sessionId } = {}) {
    const resume = sessionId ? ['-r', sessionId] : ['-c']
    return ['-p', ...(prompt ? [prompt] : []), '--respect-workspace-trust=false', ...resume]
  }
  // -p's optional PROMPT value must directly follow the flag — anything
  // between them turns the prompt into a PATH argument instead.
  buildArgs({ prompt } = {}) { return ['-p', ...(prompt ? [prompt] : []), '--respect-workspace-trust=false'] }
  normalizeLine(line) { return [{ type: 'message', role: 'assistant', text: line, partial: true }] }
}
