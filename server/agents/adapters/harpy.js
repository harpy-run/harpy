import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Adapter } from '../adapter.js'

// server/agents/adapters/harpy.js → server/cli.js — the same entrypoint the
// `harpy`/`harpy-team` bins map to. `chat` skips the launcher and the
// first-run wizard, opening the shell's REPL directly.
const CLI_JS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'cli.js')

// The Harpy Team shell as a first-class agent session: instead of a foreign
// CLI the PTY runs `node cli.js chat`, so the codex-style shell renders in
// the agent terminal like any other session — joins, wakes, sleeps and
// persists the same way. `builtin` marks it as shipped inside the package:
// never PATH-probed, always available. cli = the node binary running the
// daemon, so the spawn works even without a global `harpy` install.
export class HarpyAdapter extends Adapter {
  static id = 'harpy'
  static label = 'Harpy Team'
  static cli = process.execPath
  static icon = '/logo.svg'
  static interactive = true
  static builtin = true

  // The REPL manages its own resume surface (/resume, fleet overlay) — a
  // daemon restart just relaunches a fresh shell.
  buildTerminalArgs() { return [CLI_JS, 'chat'] }
  buildResumeArgs() { return [CLI_JS, 'chat'] }
  // Headless one-shot for automations/`/say`-style runs: `harpy chat
  // <prompt>` prints a single turn and exits.
  buildArgs({ prompt } = {}) { return [CLI_JS, 'chat', ...(prompt ? [prompt] : [])] }

  normalizeLine(line) { return line ? [{ type: 'message', role: 'assistant', text: line }] : [] }
}
