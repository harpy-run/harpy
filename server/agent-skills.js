// Installs the shipped Harpy skill onto agent skill paths at daemon boot so
// any agent CLI the user chats with knows how to add/remove/direct team bots
// through `harpy team …`. Rewritten every boot, so the installed copy tracks
// the running version; only agent-specific dirs that already exist are
// touched (never create config roots for tools the user doesn't have).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SOURCE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'skills', 'harpy', 'SKILL.md')

// ~/.agents/skills is the cross-agent convention and is always written —
// it costs one small file for tools that never read it. ~/.claude and
// ~/.config/devin are only extended when the user already has them.
const targets = () => [
  path.join(os.homedir(), '.agents', 'skills', 'harpy', 'SKILL.md'),
  ...(fs.existsSync(path.join(os.homedir(), '.claude')) ? [path.join(os.homedir(), '.claude', 'skills', 'harpy', 'SKILL.md')] : []),
  ...(fs.existsSync(path.join(os.homedir(), '.config', 'devin')) ? [path.join(os.homedir(), '.config', 'devin', 'skills', 'harpy', 'SKILL.md')] : [])
]

export function installAgentSkills() {
  let body
  try { body = fs.readFileSync(SOURCE, 'utf8') } catch { return }
  for (const target of targets()) {
    try {
      if (fs.existsSync(target) && fs.readFileSync(target, 'utf8') === body) continue
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, body)
    } catch { void 0 }
  }
}
