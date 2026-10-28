import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { discoverSkills, buildSkillContext, withSkillContext } from '../server/skill-context.js'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harpy-skill-test-'))
const skill = (name, header, body = '') => {
  const dir = path.join(root, '.agents/skills', name)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'SKILL.md'), header + body)
}
try {
  skill('valid', '---\nname: valid\ndescription: >\n  Run a repeatable\n  verification.\n---\n', 'X'.repeat(100_000))
  skill('bad', 'not frontmatter\nname: bad\ndescription: invalid\n')
  skill('huge', '---\nname: huge\ndescription: ' + 'x'.repeat(5000) + '\n---\n')
  const records = discoverSkills({ workspace: root })
  assert.equal(records.find((r) => r.name === 'valid').description, 'Run a repeatable verification.')
  assert(!records.some((r) => ['bad', 'huge'].includes(r.name)))
  fs.mkdirSync(path.join(root, '.claude/skills/valid'), { recursive: true })
  fs.writeFileSync(path.join(root, '.claude/skills/valid/SKILL.md'), '---\nname: valid\ndescription: legacy\n---\n')
  assert.equal(discoverSkills({ workspace: root }).filter((r) => r.name === 'valid').length, 1)
  const outside = path.join(root, 'outside.md')
  fs.writeFileSync(outside, '---\nname: escape\ndescription: outside\n---\n')
  fs.mkdirSync(path.join(root, '.agents/skills/escape'))
  fs.symlinkSync(outside, path.join(root, '.agents/skills/escape/SKILL.md'))
  assert(!discoverSkills({ workspace: root }).some((r) => r.name === 'escape'))
  for (let i = 0; i < 200; i++) skill(`many-${i}`, `---\nname: many-${i}\ndescription: "${'é'.repeat(200)}"\n---\n`)
  assert(Buffer.byteLength(buildSkillContext({ workspace: root })) <= 4096)
  for (const blank of [null, undefined, '', ' \n\t']) assert.equal(withSkillContext(blank, { workspace: root }), blank)
  assert(withSkillContext('do task', { workspace: root }).endsWith('[task]\ndo task'))
  assert(!discoverSkills({ workspace: root, cwd: 'missing' }).some((r) => r.name === 'valid'))
  console.log('PASS skill discovery, metadata, precedence, symlink, budget, blank prompt and cwd isolation')
} finally { fs.rmSync(root, { recursive: true, force: true }) }
