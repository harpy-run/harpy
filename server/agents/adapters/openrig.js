import { Adapter } from '../adapter.js'

export class OpenRigAdapter extends Adapter {
  static id = 'openrig'
  static label = 'OpenRig'
  static cli = 'rig'
  static icon = '/icons/openrig.svg'
  static interactive = true
  static install = { command: 'npm install -g @openrig/cli' }

  // rig is an orchestrator, not a chat CLI: a session is its mission-control
  // TUI. Seats live in detached tmux sessions outside this PTY, so stopping
  // the tab only detaches the viewer — the rig keeps running by design.
  buildTerminalArgs() { return ['tui'] }
}
