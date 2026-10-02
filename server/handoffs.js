import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { config } from './config.js'
import { memoryEnabledFor } from './memory.js'
import { listKnownWorkspaces, projectIdForPath } from './workspace.js'

// Persistent memory, split the way the agent ecosystem converged on:
// .harpy/MEMORY.md holds curated facts (conventions, decisions, gotchas)
// written by humans AND agents — never transcripts. .harpy/handoffs/
// holds one snapshot per stopped session plus an auto-generated INDEX.md.
// Agents learn the files exist through a marked pointer block the daemon
// maintains in the workspace's root AGENTS.md — every agent CLI auto-loads
// AGENTS.md, so no memory text is ever injected into user prompts.
// The whole integration is per-user opt-out: when memory is disabled Harpy
// creates nothing, injects nothing, and removeMemoryEverywhere wipes what
// earlier sessions left behind.
const MAX_HANDOFFS = 30
const TAIL_LINES = 40
const TAIL_BYTES = 24 * 1024
const TAIL_LINE_CHARS = 240
const LIST_LIMIT = 20
const NAME_PATTERN = /^[\w.-]+\.md$/
const SESSIONS_START = '<!-- harpy:sessions -->'
const SESSIONS_END = '<!-- /harpy:sessions -->'
const INDEX_MAX = 12
const AGENTS_BLOCK_START = '<!-- harpy:memory -->'
const AGENTS_BLOCK_END = '<!-- /harpy:memory -->'

const MEMORY_SEED = `# Project memory

<!--
Persistent memory for this workspace — shared by every agent session and
every human working here.

Agents: read this file BEFORE starting work. When you learn something
durable — a coding convention, a decision and the reason behind it, a
gotcha that cost time, an environment quirk — record it under the
matching heading below, one line per entry. Do NOT store session logs,
chat transcripts, or task progress here; ephemeral state belongs in
.harpy/handoffs/ session snapshots.
-->

## Conventions

## Decisions

## Gotchas

## Environment
`

// Minimal pointer most agent CLIs (codex, devin, claude, gemini, opencode,
// grok) auto-load from the workspace root on session start.
const AGENTS_POINTER = `# AGENTS.md

This workspace runs on Harpy. Before starting work, read
\`.harpy/MEMORY.md\` — the project's persistent memory — and update it
when you learn durable conventions, decisions, or gotchas (never chat
logs). Recent session snapshots live under \`.harpy/handoffs/\`
(start with \`INDEX.md\`).
`

// TUI chrome glyphs: Braille spinner cells, box drawing, blocks/shading,
// geometric frames, misc symbols — plus the ASCII spinner/prompt marks that
// decorate interactive CLIs (codex, claude, devin, gemini all redraw in place).
const DECORATION_RE = /[⠀-⣿─-╿▀-▟■-◿☀-➿⬀-⯿·❭❯│┃]/gu
const EDGE_DECORATION_RE = /^[\s⠀-⣿─-╿▀-▟■-◿☀-➿⬀-⯿·❭❯│┃|/\\_-]+|[\s⠀-⣿─-╿▀-▟■-◿☀-➿⬀-⯿·❭❯│┃|/\\_-]+$/gu

function stripAnsi(text) {
  // eslint-disable-next-line no-control-regex
  return String(text).replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\)|[()#][0-9A-B]|[@-Z\\-_])/g, '')
}

// Keep lines that carry real text; drop spinner frames, box borders, and
// status-bar redraws where decoration outweighs readable characters.
function cleanTailLine(raw) {
  const squashed = raw.replace(/\s+/g, ' ').trim()
  if (squashed.length < 2) return ''
  const visible = squashed.replace(/\s/g, '')
  const decoration = (visible.match(DECORATION_RE) || []).length
  const alnum = (visible.match(/[0-9A-Za-zÀ-ɏ]/g) || []).length
  if (decoration / visible.length > 0.55 && alnum < 3) return ''
  const text = squashed.replace(EDGE_DECORATION_RE, '').trim()
  // Bare numbers and single glyphs are status-bar/shadow-DOM debris.
  if (text.length < 2 || /^\d+$/.test(text)) return ''
  return text.slice(0, TAIL_LINE_CHARS)
}

function dirFor(workspace) {
  return path.join(workspace, '.harpy', 'handoffs')
}

function stamp(ts) {
  return new Date(ts).toISOString().slice(0, 16).replace('T', ' ')
}

function prune(dir) {
  let entries = []
  try { entries = fs.readdirSync(dir) } catch { return }
  const aged = entries
    .filter((name) => name.endsWith('.md'))
    .map((name) => ({ name, ts: fs.statSync(path.join(dir, name)).mtimeMs }))
    .sort((a, b) => b.ts - a.ts)
  for (const old of aged.slice(MAX_HANDOFFS)) {
    try { fs.rmSync(path.join(dir, old.name), { force: true }) } catch { void 0 }
  }
}

// .harpy/ is runtime data — ignore it inside the dir itself so `git status`
// in the project stays clean without touching tracked files or .git/info.
function hideFromGit(dir) {
  try {
    const ignore = path.join(dir, '.gitignore')
    if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, '*\n', { mode: 0o644 })
  } catch { void 0 }
}

export function ensureMemory(workspace, owner) {
  if (!memoryEnabledFor(owner)) return null
  try {
    const dir = path.join(workspace, '.harpy')
    fs.mkdirSync(dir, { recursive: true, mode: 0o755 })
    hideFromGit(dir)
    const file = path.join(dir, 'MEMORY.md')
    if (!fs.existsSync(file)) {
      fs.writeFileSync(file, MEMORY_SEED, { mode: 0o644 })
    } else {
      migrateMemory(file)
    }
    ensureAgentsPointer(workspace)
    return '.harpy/MEMORY.md'
  } catch { return null }
}

// Early builds wrote the session index into MEMORY.md and seeded it with
// boilerplate prose. Strip the generated block and upgrade the bare seed to
// the structured layout — anything a human actually wrote survives.
function migrateMemory(file) {
  try {
    let content = fs.readFileSync(file, 'utf8')
    if (content.includes(SESSIONS_START) && content.includes(SESSIONS_END)) {
      const start = content.indexOf(SESSIONS_START)
      const end = content.indexOf(SESSIONS_END) + SESSIONS_END.length
      content = (content.slice(0, start) + content.slice(end)).replace(/## Recent sessions\s*$/m, '')
    }
    // No sections means the file still holds only the old prose seed.
    if (!/^## /m.test(content)) {
      if (content === MEMORY_SEED || !fs.existsSync(file)) return
      fs.writeFileSync(file, MEMORY_SEED, { mode: 0o644 })
      return
    }
    if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') === content) return
    fs.writeFileSync(file, content.trimEnd() + '\n', { mode: 0o644 })
  } catch { void 0 }
}

const AGENTS_BLOCK = `${AGENTS_BLOCK_START}
This workspace uses Harpy: before starting work, read \`.harpy/MEMORY.md\` — the project's persistent memory — and update it with durable conventions, decisions, or gotchas (never chat logs or task progress). Recent session snapshots live under \`.harpy/handoffs/\` (start with \`INDEX.md\`).
${AGENTS_BLOCK_END}`

// A root AGENTS.md is the channel that teaches agents about the memory —
// every CLI auto-loads it, whether the session is interactive or prompt-
// driven. When absent the
// minimal pointer is created (a tracked-but-deleted AGENTS.md is a
// deliberate removal — leave it gone). When a project already has its own
// AGENTS.md — as CLIs like codex generate — a marked `harpy:memory` block
// is appended instead: same discovery, zero takeover, and the marker makes
// it idempotent and strippable when memory is disabled.
function ensureAgentsPointer(workspace) {
  try {
    const file = path.join(workspace, 'AGENTS.md')
    if (fs.existsSync(file)) {
      const content = fs.readFileSync(file, 'utf8')
      if (content.includes(AGENTS_BLOCK_START) || content.trim() === AGENTS_POINTER.trim()) return
      fs.appendFileSync(file, `\n\n${AGENTS_BLOCK}\n`, { mode: 0o644 })
      return
    }
    try {
      execFileSync('git', ['-C', workspace, 'ls-files', '--error-unmatch', 'AGENTS.md'], { stdio: 'pipe' })
      return
    } catch { /* untracked or not a repo — safe to write */ }
    fs.writeFileSync(file, AGENTS_POINTER, { mode: 0o644 })
    const exclude = path.join(workspace, '.git', 'info', 'exclude')
    if (fs.existsSync(exclude)) {
      const lines = fs.readFileSync(exclude, 'utf8').split('\n')
      if (!lines.some((line) => line.trim() === 'AGENTS.md')) fs.appendFileSync(exclude, 'AGENTS.md\n')
    }
  } catch { void 0 }
}

// handoffs/INDEX.md is the session log — rewritten on every handoff, newest
// first. Keeping it out of MEMORY.md is deliberate: memory is curated facts,
// the index is history an agent can consult when continuing prior work.
function writeIndex(workspace, session, fileCount, handoffName) {
  try {
    const dir = dirFor(workspace)
    const row = `- ${stamp(Date.now())} · ${session.state?.agent || 'agent'} #${session.index || 1} · ${fileCount} changed file${fileCount === 1 ? '' : 's'} · [\`${handoffName}\`](${handoffName})`
    const file = path.join(dir, 'INDEX.md')
    let rows = [row]
    try {
      rows = rows.concat(fs.readFileSync(file, 'utf8').split('\n').filter((line) => line.startsWith('- ')))
    } catch { /* first index */ }
    fs.writeFileSync(file, [
      '# Session handoffs',
      '',
      'Newest first — one snapshot per stopped session: changed files, terminal',
      'tail, who ran it. Read the latest before continuing earlier work.',
      '',
      ...rows.slice(0, INDEX_MAX),
      ''
    ].join('\n'), { mode: 0o644 })
  } catch { void 0 }
}

export function writeHandoff(session, { files = [], branch = '', tail = '' } = {}) {
  if (!session?.workspace || !memoryEnabledFor(session.owner)) return null
  try {
    // The store dir itself must never appear in the changed-files list.
    const changed = files.filter((file) => !/^\.harpy([/\\]|$)/.test(file.path))
    const dir = dirFor(session.workspace)
    fs.mkdirSync(dir, { recursive: true, mode: 0o755 })
    const memory = ensureMemory(session.workspace, session.owner)
    const name = `${session.sessionId}-${session.state?.agent || 'agent'}.md`
    const lines = [
      `# Session handoff — ${session.state?.agent || 'agent'} #${session.index || 1}`,
      '',
      `- **Agent**: ${session.state?.agent || '?'} (session ${session.sessionId})`,
      `- **Started**: ${stamp(session.startedAt || Date.now())}`,
      `- **Ended**: ${stamp(Date.now())}`,
      `- **Owner**: ${session.ownerName || session.owner || '?'}`,
      branch ? `- **Branch**: ${branch}` : null,
      '',
      '## Changed files',
      '',
      ...(changed.length ? changed.map((file) => `- \`${file.status}\` ${file.path}`) : ['_(none recorded)_']),
      '',
      '## Terminal tail',
      '',
      '```',
      tail || '(no output captured)',
      '```',
      '',
      '---',
      memory ? `Continue this work: read \`${memory}\` for project memory and \`.harpy/handoffs/INDEX.md\` for earlier sessions, then pick up where this session left off.` : 'Continue this work where this session left off.',
      ''
    ].filter((line) => line !== null)
    fs.writeFileSync(path.join(dir, name), lines.join('\n'), { mode: 0o644 })
    prune(dir)
    writeIndex(session.workspace, session, changed.length, name)
    return name
  } catch { return null }
}

export function tailFromHistory(history) {
  let text = ''
  for (const event of history || []) {
    if (event?.type !== 'data' || typeof event.data !== 'string') continue
    text += event.data
    if (text.length > TAIL_BYTES) text = text.slice(-TAIL_BYTES)
  }
  // In-place TUI redraws arrive as CR-separated frames — every \r is a line
  // boundary, then decoration-only lines and consecutive repeats are dropped.
  // eslint-disable-next-line no-control-regex
  const cleaned = stripAnsi(text).replace(/\x07/g, '').replace(/\r/g, '\n')
  const lines = []
  let previous = ''
  for (const raw of cleaned.split('\n')) {
    const line = cleanTailLine(raw)
    if (!line || line === previous) continue
    previous = line
    lines.push(line)
  }
  // Keystroke-echo frames leave tiny fragments ("B", "Ne", "xt.js") that a
  // later frame renders in full — drop any line already contained in a
  // later one (also collapses non-consecutive repeats to the last copy).
  const kept = lines.filter((line, i) => {
    for (let j = i + 1; j < lines.length; j += 1) {
      if (lines[j].includes(line)) return false
    }
    return true
  })
  return kept.slice(-TAIL_LINES).join('\n')
}

export function listHandoffs(workspace) {
  const dir = dirFor(workspace)
  let entries = []
  try { entries = fs.readdirSync(dir) } catch { return [] }
  return entries
    .filter((name) => NAME_PATTERN.test(name))
    .map((name) => {
      const stat = fs.statSync(path.join(dir, name))
      const match = name.match(/^(s_\d+)-([\w-]+)\.md$/)
      return { name, sessionId: match?.[1] || '', agent: match?.[2] || '', ts: stat.mtimeMs, size: stat.size }
    })
    .sort((a, b) => b.ts - a.ts)
    .slice(0, LIST_LIMIT)
}

export function readHandoff(workspace, name) {
  if (!NAME_PATTERN.test(String(name || ''))) return null
  try { return fs.readFileSync(path.join(dirFor(workspace), name), 'utf8') } catch { return null }
}

// Opt-out cleanup: delete .harpy/ entirely and undo the AGENTS.md
// integration. A file Harpy created wholesale (exact pointer content) is
// removed along with its .git/info/exclude hiding line; a pre-existing
// AGENTS.md only loses the marked harpy:memory block — everything the human
// or another CLI wrote is preserved byte-for-byte.
export function removeMemory(workspace) {
  try {
    fs.rmSync(path.join(workspace, '.harpy'), { recursive: true, force: true })
    const file = path.join(workspace, 'AGENTS.md')
    let deleted = false
    if (fs.existsSync(file)) {
      const content = fs.readFileSync(file, 'utf8')
      if (content.trim() === AGENTS_POINTER.trim()) {
        fs.rmSync(file, { force: true })
        deleted = true
      } else if (content.includes(AGENTS_BLOCK_START)) {
        const cleaned = content
          .replace(new RegExp(`\\n*${escapeRegExp(AGENTS_BLOCK_START)}[\\s\\S]*?${escapeRegExp(AGENTS_BLOCK_END)}\\n*`, 'g'), '')
          .trimEnd() + '\n'
        if (cleaned.trim()) fs.writeFileSync(file, cleaned, { mode: 0o644 })
        else { fs.rmSync(file, { force: true }); deleted = true }
      }
    }
    if (deleted) {
      const exclude = path.join(workspace, '.git', 'info', 'exclude')
      if (fs.existsSync(exclude)) {
        const lines = fs.readFileSync(exclude, 'utf8').split('\n').filter((line) => line.trim() !== 'AGENTS.md')
        fs.writeFileSync(exclude, lines.join('\n'), { mode: 0o644 })
      }
    }
    return true
  } catch { return false }
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// Enumerate every workspace the daemon knows — runtime-registered roots,
// workspace.json externals/actives, and managed projects — and wipe memory
// from each. `allowlist` (a Set of project ids) restricts members to
// workspaces they could reach anyway; admins/owners pass null.
export function removeMemoryEverywhere({ allowlist } = {}) {
  const roots = new Set(listKnownWorkspaces())
  try {
    const state = JSON.parse(fs.readFileSync(path.join(config.dataDir, 'workspace.json'), 'utf8'))
    const put = (value) => {
      const id = String(value || '')
      if (id.startsWith('external:')) roots.add(path.resolve(id.slice('external:'.length)))
      else if (id) roots.add(path.join(config.projectsDir, id))
    }
    for (const item of state.externals || []) if (item?.path) roots.add(path.resolve(item.path))
    for (const value of Object.values(state.actives || {})) put(value)
    put(state.active)
  } catch { void 0 }
  try {
    for (const entry of fs.readdirSync(config.projectsDir, { withFileTypes: true })) {
      if (entry.isDirectory()) roots.add(path.join(config.projectsDir, entry.name))
    }
  } catch { void 0 }
  let removed = 0
  for (const root of roots) {
    if (allowlist && !allowlist.has(projectIdForPath(root))) continue
    if (removeMemory(root)) removed += 1
  }
  return { removed, workspaces: roots.size }
}
