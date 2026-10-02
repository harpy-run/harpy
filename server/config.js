import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const config = {
  // 3001 is the stable Harpy publication port. PORT/HARPY_PORT remain
  // available for isolated development or smoke-test instances.
  port: Number(process.env.PORT || process.env.HARPY_PORT || 3001),
  host: process.env.HARPY_HOST || '0.0.0.0',
  dataDir: process.env.HARPY_HOME || path.join(os.homedir(), '.harpy'),
  projectsDir: path.resolve(process.env.HARPY_PROJECTS || path.join(process.cwd(), 'harpy-projects')),
  workspace: process.env.HARPY_WORKSPACE ? path.resolve(process.env.HARPY_WORKSPACE) : null,
  distDir: fileURLToPath(new URL('../dist/', import.meta.url)),
  // Idle agent sessions get suspended after this much silence — a wedged
  // long-idle CLI is worse than a resumable sleeping session. 0 disables.
  agentIdleMs: process.env.HARPY_AGENT_IDLE_MS === undefined ? 4 * 60 * 60 * 1000 : Math.max(0, Number(process.env.HARPY_AGENT_IDLE_MS) || 0)
}

export const VERSION = "2.7.2"
