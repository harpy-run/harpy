import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harpy-memory-test-'))
process.env.HARPY_HOME = path.join(root, 'state')
const { memoryPrefsFor, saveMemoryPrefs } = await import('../server/memory.js')
const { ensureMemory } = await import('../server/handoffs.js')
try {
  assert.deepEqual(memoryPrefsFor('test'), { memory: true, digest: false })
  assert.equal(saveMemoryPrefs('test', { digest: true }).digest, true)
  assert.equal(memoryPrefsFor('test').digest, true)
  assert.equal(saveMemoryPrefs('test', { memory: false }).digest, true)
  assert.equal(saveMemoryPrefs('test', { digest: false, memory: true }).digest, false)
  const workspace = path.join(root, 'workspace')
  fs.mkdirSync(path.join(workspace, '.harpy'), { recursive: true })
  const memory = path.join(workspace, '.harpy/MEMORY.md')
  const prose = 'An important human-authored decision without section headings.\n'
  fs.writeFileSync(memory, prose)
  const guidance = path.join(workspace, 'AGENTS.md')
  fs.writeFileSync(guidance, 'before\n<!-- harpy:memory -->\nold managed text\n<!-- /harpy:memory -->\nafter\n')
  ensureMemory(workspace, 'test')
  assert.equal(fs.readFileSync(memory, 'utf8'), prose)
  const updated = fs.readFileSync(guidance, 'utf8')
  assert(updated.startsWith('before\n'))
  assert(updated.endsWith('\nafter\n'))
  assert(updated.includes('.agents/skills'))
  ensureMemory(workspace, 'test')
  assert.equal(fs.readFileSync(guidance, 'utf8'), updated)
  fs.writeFileSync(guidance, 'before\n<!-- harpy:memory -->\nmissing end\n')
  ensureMemory(workspace, 'test')
  assert.equal(fs.readFileSync(guidance, 'utf8'), 'before\n<!-- harpy:memory -->\nmissing end\n')
  console.log('PASS digest opt-in persistence, prose preservation and managed pointer migration')
} finally { fs.rmSync(root, { recursive: true, force: true }) }
