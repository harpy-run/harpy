import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { getAdapter } from './agents/adapter.js'
import { config } from './config.js'
import { cliEnvInfo, cliHomeFor } from './cli-env.js'
import { httpError } from './util/http.js'

const execFileAsync = promisify(execFile)
const AGENT_SKILL_DIRS = {
  claude: '.claude/skills',
  devin: '.config/devin/skills',
  codex: '.codex/skills',
  gemini: '.gemini/skills',
  opencode: '.config/opencode/skills',
  qwen: '.qwen/skills',
  grok: '.grok/skills'
}
const MAX_SKILLS = 40
const MAX_ENTRIES = 5000
const MAX_BYTES = 32 * 1024 * 1024
const MAX_FILE_BYTES = 8 * 1024 * 1024
const METADATA_BYTES = 8192
const CLONE_TIMEOUT_MS = 60_000
const NAME_PATTERN = /^[\w][\w.-]{0,63}$/

export function validateSkillOptions({ agent, scope = 'user' } = {}) {
  if (scope !== 'user' && scope !== 'workspace') throw httpError(400, 'invalid skill scope')
  if (typeof agent !== 'string' || !NAME_PATTERN.test(agent) || !getAdapter(agent)) {
    throw httpError(400, 'unknown skill adapter')
  }
  return { agent, scope }
}

// Check all existing components: a symlink in a CLI home, workspace ancestor,
// .agents, or the leaf must not redirect a read or write outside its root.
function safePath(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) throw httpError(400, 'absolute skills path required')
  const resolved = path.resolve(value)
  const { root } = path.parse(resolved)
  let current = root
  for (const part of resolved.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part)
    let stat
    try { stat = fs.lstatSync(current) } catch (error) {
      if (error.code === 'ENOENT') return resolved
      throw error
    }
    if (stat.isSymbolicLink()) throw httpError(403, 'symlinks are not allowed in skills paths')
    if (current !== resolved && !stat.isDirectory()) throw httpError(400, 'invalid skills parent directory')
  }
  return resolved
}

function homeForSub(sub) {
  if (!cliEnvInfo(sub).home) return os.homedir()
  if (typeof sub !== 'string' || !NAME_PATTERN.test(sub)) throw httpError(400, 'invalid skill target')
  return cliHomeFor(sub)
}

export function skillsDirFor(options = {}) {
  const { agent, scope } = validateSkillOptions(options)
  if (scope === 'workspace') {
    if (!options.workspace) throw httpError(400, 'workspace required')
    return safePath(path.join(safePath(options.workspace), '.agents', 'skills'))
  }
  const rel = AGENT_SKILL_DIRS[agent] || path.join('.harpy', 'skills', agent)
  return safePath(path.join(safePath(homeForSub(options.sub)), rel))
}

// Never accept file/SSH remotes or command-line flags.
export function normalizeRepo(input) {
  const value = String(input || '').trim()
  if (!value) throw httpError(400, 'repo required')
  if (/^https:\/\/[\w.-]+(?::\d+)?\/[\w./-]+$/i.test(value)) return value.replace(/\.git$/i, '')
  if (/^[\w.-]+\/[\w./-]+$/.test(value) && !value.startsWith('/')) return `https://github.com/${value.replace(/\.git$/i, '')}`
  throw httpError(400, 'use a https:// git URL or owner/repo shorthand')
}

function* entriesIn(dir, budget) {
  const handle = fs.opendirSync(dir)
  try {
    let entry
    while ((entry = handle.readSync())) {
      if (++budget.entries > MAX_ENTRIES) throw httpError(400, 'skill traversal limit exceeded')
      yield entry
    }
  } finally { handle.closeSync() }
}

function inspectTree(root, budget, depth = 0, files = []) {
  if (depth > 32) throw httpError(400, 'skill depth limit exceeded')
  safePath(root)
  for (const entry of entriesIn(root, budget)) {
    const file = path.join(root, entry.name)
    const stat = fs.lstatSync(file)
    if (stat.isSymbolicLink()) throw httpError(400, 'source skill symlinks are not allowed')
    if (entry.name === '.git') continue
    if (stat.isDirectory()) inspectTree(file, budget, depth + 1, files)
    else if (stat.isFile()) {
      budget.bytes += stat.size
      if (stat.size > MAX_FILE_BYTES || budget.bytes > MAX_BYTES) throw httpError(400, 'skill size limit exceeded')
      files.push(file)
    } else throw httpError(400, 'only regular skill files are allowed')
  }
  return files
}

function skillDirs(root, budget, depth = 0, found = []) {
  safePath(root)
  const directories = []
  let skill = false
  for (const entry of entriesIn(root, budget)) {
    const file = path.join(root, entry.name)
    const stat = fs.lstatSync(file)
    if (stat.isSymbolicLink()) throw httpError(400, 'source skill symlinks are not allowed')
    if (entry.name === 'SKILL.md' && stat.isFile()) skill = true
    if (entry.name !== '.git' && stat.isDirectory()) directories.push(file)
  }
  if (skill) {
    if (found.length >= MAX_SKILLS) throw httpError(400, 'too many skills in repository')
    found.push(root)
  } else if (depth < 4) {
    for (const dir of directories) skillDirs(dir, budget, depth + 1, found)
  }
  return found
}

function readDescription(file) {
  safePath(file)
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK)
  try {
    if (!fs.fstatSync(fd).isFile()) return null
    const buffer = Buffer.alloc(METADATA_BYTES)
    const bytes = fs.readSync(fd, buffer, 0, buffer.length, 0)
    const lines = buffer.subarray(0, bytes).toString('utf8').split('\n').slice(0, 40)
    if (lines[0]?.trim() !== '---') return ''
    const end = lines.slice(1).findIndex((line) => line.trim() === '---')
    const metadata = end < 0 ? lines.slice(1) : lines.slice(1, end + 1)
    const index = metadata.findIndex((line) => /^description:/i.test(line))
    if (index < 0) return ''
    let description = metadata[index].slice(metadata[index].indexOf(':') + 1).trim()
    if (/^[>|][-+]?$/.test(description)) description = (metadata[index + 1] || '').trim()
    return description.replace(/^(['"])(.*)\1$/, '$2').slice(0, 140)
  } finally { fs.closeSync(fd) }
}

function copySkillFiles(source, target, files) {
  for (const file of files) {
    safePath(file)
    const output = safePath(path.join(target, path.relative(source, file)))
    fs.mkdirSync(path.dirname(output), { recursive: true })
    // Bounded no-follow reads, then exclusive creation: do not turn a source
    // link or an existing destination into a silent overwrite.
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK)
    try {
      const stat = fs.fstatSync(fd)
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw httpError(400, 'invalid source skill file')
      const content = Buffer.alloc(stat.size)
      let bytes = 0
      while (bytes < content.length) {
        const read = fs.readSync(fd, content, bytes, content.length - bytes, bytes)
        if (!read) break
        bytes += read
      }
      safePath(output)
      fs.writeFileSync(output, content.subarray(0, bytes), { flag: 'wx', mode: stat.mode & 0o777 })
    } finally { fs.closeSync(fd) }
  }
}

export async function installSkillRepo({ repo, dir }) {
  const url = normalizeRepo(repo)
  dir = safePath(dir)
  const tmpParent = safePath(path.join(config.dataDir, 'tmp'))
  fs.mkdirSync(tmpParent, { recursive: true, mode: 0o700 })
  const tmp = fs.mkdtempSync(path.join(tmpParent, 'skill-'))
  try {
    const root = path.join(tmp, 'repo')
    try {
      await execFileAsync('git', ['clone', '--depth', '1', '--quiet', url, root], {
        timeout: CLONE_TIMEOUT_MS,
        maxBuffer: 64 * 1024,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
      })
    } catch (error) {
      throw httpError(400, `clone failed: ${error.message?.split('\n')[0] || 'git error'}`)
    }
    const budget = { entries: 0, bytes: 0 }
    const found = skillDirs(root, budget)
    if (!found.length) throw httpError(400, 'no SKILL.md found in this repository')
    const names = new Set()
    const sources = found.map((source) => {
      const name = path.basename(source)
      if (!NAME_PATTERN.test(name)) throw httpError(400, 'invalid skill name in repository')
      if (names.has(name)) throw httpError(409, `duplicate skill name: ${name}`)
      names.add(name)
      const files = inspectTree(source, budget)
      const target = safePath(path.join(dir, name))
      if (fs.existsSync(target)) throw httpError(409, `skill already exists: ${name}`)
      return { source, name, files }
    })
    safePath(dir)
    fs.mkdirSync(dir, { recursive: true, mode: 0o755 })
    const installed = []
    for (const { source, name, files } of sources) {
      const target = safePath(path.join(dir, name))
      try { fs.mkdirSync(target) } catch (error) {
        if (error.code === 'EEXIST') throw httpError(409, `skill already exists: ${name}`)
        throw error
      }
      try {
        copySkillFiles(source, target, files)
        installed.push(name)
      } catch (error) {
        safePath(target)
        fs.rmSync(target, { recursive: true, force: true })
        throw error
      }
    }
    return { installed, count: installed.length }
  } finally {
    safePath(tmp)
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

export function listSkills(dir) {
  dir = safePath(dir)
  if (!fs.existsSync(dir)) return []
  const result = []
  for (const entry of entriesIn(dir, { entries: 0 })) {
    if (!entry.isDirectory() || !NAME_PATTERN.test(entry.name)) continue
    try {
      const description = readDescription(path.join(dir, entry.name, 'SKILL.md'))
      if (description !== null) result.push({ name: entry.name, description })
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR', 'ELOOP'].includes(error.code) && error.status !== 403) throw error
    }
    if (result.length >= 200) break
  }
  return result
}

export function removeSkill(dir, name) {
  if (typeof name !== 'string' || !NAME_PATTERN.test(name)) throw httpError(400, 'invalid skill name')
  const target = safePath(path.join(safePath(dir), name))
  if (fs.existsSync(target)) inspectTree(target, { entries: 0, bytes: 0 })
  safePath(target)
  fs.rmSync(target, { recursive: true, force: true })
  return { ok: true }
}
