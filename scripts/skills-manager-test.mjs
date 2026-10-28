// Standalone local fixtures: no daemon, network, CLI logins, or credentials.
import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { syncBuiltinESMExports } from 'node:module'

const temp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'harpy-skills-test-'))
const originalEnv = { HARPY_HOME: process.env.HARPY_HOME, HARPY_PROJECTS: process.env.HARPY_PROJECTS, HARPY_WORKSPACE: process.env.HARPY_WORKSPACE }
process.env.HARPY_HOME = path.join(temp, 'data')
process.env.HARPY_PROJECTS = path.join(temp, 'projects')
process.env.HARPY_WORKSPACE = path.join(temp, 'workspace')
fs.mkdirSync(process.env.HARPY_WORKSPACE, { recursive: true })
const originalExecFile = childProcess.execFile
let fixture = ''
let cloneError = null
let afterClone = null
let clones = 0
childProcess.execFile = (command, args, options, callback) => {
  assert.equal(command, 'git')
  assert.deepEqual(args.slice(0, 4), ['clone', '--depth', '1', '--quiet'])
  assert.equal(options.env.GIT_TERMINAL_PROMPT, '0')
  clones++
  queueMicrotask(() => {
    try {
      if (cloneError) throw cloneError
      fs.cpSync(fixture, args.at(-1), { recursive: true, verbatimSymlinks: true })
      afterClone?.()
      callback(null, '', '')
    } catch (error) { callback(error, '', '') }
  })
}
syncBuiltinESMExports()

let passed = 0
async function test(name, action) {
  await action()
  passed++
  console.log(`ok ${passed} - ${name}`)
}
function file(name, content = '---\ndescription: fixture description\n---\nBody\n') {
  fs.mkdirSync(path.dirname(name), { recursive: true })
  fs.writeFileSync(name, content)
}
function newFixture(name) {
  fixture = path.join(temp, 'fixtures', name)
  fs.mkdirSync(fixture, { recursive: true })
  cloneError = null
  afterClone = null
  return fixture
}
function status(expected) { return (error) => error.status === expected }

try {
  const { config } = await import('../server/config.js')
  const { registerAdapter } = await import('../server/agents/adapter.js')
  for (const id of ['claude', 'devin', 'codex', 'gemini', 'opencode', 'qwen', 'grok', 'harpy']) {
    registerAdapter(class { static id = id })
  }
  const { installSkillRepo, listSkills, removeSkill, skillsDirFor } = await import('../server/skills.js')
  const { saveCliEnv } = await import('../server/cli-env.js')
  const { setup, createUser } = await import('../server/auth.js')
  const { agentChannel } = await import('../server/channels/agent.channel.js')
  const ops = agentChannel.ops
  const admin = { principal: { sub: 'owner' } }
  setup('skill-admin', 'fixture-password-12345')
  const user = createUser({ username: 'skill-member', password: 'fixture-password-12345', agents: ['claude'], projects: [] })
  const member = { principal: { sub: user.id } }
  saveCliEnv(user.id, { home: true })
  const dir = path.join(temp, 'installed')
  const repo = 'local/fixture'
  const cleanTmp = () => assert.deepEqual(fs.readdirSync(path.join(config.dataDir, 'tmp')), [])

  await test('validates scope and registered adapter before constructing paths', () => {
    for (const scope of ['', 'USER', '../workspace', null]) {
      assert.throws(() => skillsDirFor({ agent: 'claude', scope, workspace: temp }), status(400))
    }
    for (const agent of [undefined, '../escape', 'unknown', '__proto__', 'constructor']) {
      assert.throws(() => skillsDirFor({ agent, scope: 'workspace', workspace: temp }), status(400))
    }
    for (const agent of ['claude', 'devin', 'codex', 'gemini', 'opencode', 'qwen', 'grok', 'harpy']) {
      assert.equal(skillsDirFor({ agent, scope: 'workspace', workspace: config.workspace }), path.join(config.workspace, '.agents', 'skills'))
      assert.ok(path.isAbsolute(skillsDirFor({ agent, sub: user.id })))
    }
  })
  await test('for maps to the selected private home for list and remove', () => {
    const privateDir = skillsDirFor({ agent: 'claude', sub: user.id })
    file(path.join(privateDir, 'private-skill', 'SKILL.md'))
    assert.equal(ops.skills(admin, { agent: 'claude', for: user.id }).skills[0].name, 'private-skill')
    assert.equal(ops.skills(member, { agent: 'claude' }).skills[0].name, 'private-skill')
    assert.throws(() => ops.skills(member, { agent: 'claude', for: 'owner' }), status(403))
    assert.throws(() => ops.skills(member, { agent: 'codex' }), status(403))
    ops.skillRemove(admin, { agent: 'claude', for: user.id, name: 'private-skill' })
    assert.deepEqual(listSkills(privateDir), [])
  })
  await test('for maps install to selected home; temp clone always cleaned', async () => {
    file(path.join(newFixture('valid'), 'sample', 'SKILL.md'))
    file(path.join(fixture, 'sample', 'scripts', 'run.sh'), '#!/bin/sh\nexit 0\n')
    fs.chmodSync(path.join(fixture, 'sample', 'scripts', 'run.sh'), 0o755)
    const result = await ops.skillInstall(admin, { agent: 'claude', for: user.id, repo })
    assert.deepEqual(result, { installed: ['sample'], count: 1 })
    const privateDir = skillsDirFor({ agent: 'claude', sub: user.id })
    assert.equal(listSkills(privateDir)[0].description, 'fixture description')
    assert.ok(fs.statSync(path.join(privateDir, 'sample', 'scripts', 'run.sh')).mode & 0o100)
    cleanTmp()
  })
  await test('neutral workspace installation and access gates', async () => {
    await ops.skillInstall(admin, { agent: 'codex', scope: 'workspace', workspace: config.workspace, repo })
    assert.equal(ops.skills(admin, { agent: 'gemini', scope: 'workspace', workspace: config.workspace }).skills[0].name, 'sample')
    assert.equal(fs.existsSync(path.join(config.workspace, '.claude')), false)
    assert.throws(() => ops.skills(member, { agent: 'claude', scope: 'workspace', workspace: config.workspace }), status(403))
    assert.throws(() => ops.skills(admin, { agent: 'claude', scope: 'elsewhere' }), status(400))
    cleanTmp()
  })
  await test('existing skill causes conflict, preserving original contents', async () => {
    file(path.join(dir, 'sample', 'SKILL.md'), 'original')
    await assert.rejects(installSkillRepo({ repo, dir }), status(409))
    assert.equal(fs.readFileSync(path.join(dir, 'sample', 'SKILL.md'), 'utf8'), 'original')
    cleanTmp()
  })
  await test('clone and discovery failures clean temporary directories', async () => {
    cloneError = new Error('fixture clone failed')
    await assert.rejects(installSkillRepo({ repo, dir }), /clone failed/)
    cleanTmp()
    newFixture('empty')
    await assert.rejects(installSkillRepo({ repo, dir }), /no SKILL.md/)
    cleanTmp()
  })
  await test('source directory, metadata and nested resource symlinks are rejected', async () => {
    const outside = path.join(temp, 'outside')
    file(path.join(outside, 'SKILL.md'), 'outside sentinel')
    for (const type of ['directory', 'metadata', 'resource']) {
      newFixture(`source-link-${type}`)
      if (type === 'directory') fs.symlinkSync(outside, path.join(fixture, 'linked'), 'dir')
      else if (type === 'metadata') {
        fs.mkdirSync(path.join(fixture, 'linked'))
        fs.symlinkSync(path.join(outside, 'SKILL.md'), path.join(fixture, 'linked', 'SKILL.md'))
      } else {
        file(path.join(fixture, 'linked', 'SKILL.md'))
        fs.symlinkSync(outside, path.join(fixture, 'linked', 'resources'), 'dir')
      }
      await assert.rejects(installSkillRepo({ repo, dir }), /symlink/)
      cleanTmp()
    }
    assert.equal(fs.readFileSync(path.join(outside, 'SKILL.md'), 'utf8'), 'outside sentinel')
  })
  await test('list skips leaf links and bounded metadata never reads huge file bodies', () => {
    const listing = path.join(temp, 'listing')
    file(path.join(listing, 'huge', 'SKILL.md'), '---\ndescription: >\n  bounded metadata\n---\n')
    fs.truncateSync(path.join(listing, 'huge', 'SKILL.md'), 512 * 1024 * 1024)
    file(path.join(listing, 'body', 'SKILL.md'), '# Body\ndescription: not metadata\n')
    fs.mkdirSync(path.join(listing, 'linked-file'))
    fs.symlinkSync(path.join(temp, 'outside', 'SKILL.md'), path.join(listing, 'linked-file', 'SKILL.md'))
    fs.symlinkSync(path.join(temp, 'outside'), path.join(listing, 'linked-dir'), 'dir')
    const originalRead = fs.readFileSync
    fs.readFileSync = () => { throw new Error('unbounded readFileSync forbidden') }
    try {
      assert.deepEqual(listSkills(listing).sort((a, b) => a.name.localeCompare(b.name)), [
        { name: 'body', description: '' }, { name: 'huge', description: 'bounded metadata' }
      ])
    } finally { fs.readFileSync = originalRead }
  })
  await test('parent-path and destination symlinks block list/install/remove', async () => {
    const outside = path.join(temp, 'outside')
    const linked = path.join(temp, 'linked-parent')
    fs.symlinkSync(outside, linked, 'dir')
    assert.throws(() => listSkills(path.join(linked, 'skills')), /symlink/)
    assert.throws(() => removeSkill(path.join(linked, 'skills'), 'sample'), /symlink/)
    await assert.rejects(installSkillRepo({ repo, dir: path.join(linked, 'skills') }), /symlink/)
    assert.throws(() => removeSkill(path.join(temp, 'listing'), 'linked-dir'), /symlink/)
    const workspaceLink = path.join(temp, 'linked-workspace')
    fs.mkdirSync(workspaceLink)
    fs.symlinkSync(outside, path.join(workspaceLink, '.agents'), 'dir')
    assert.throws(() => skillsDirFor({ agent: 'claude', scope: 'workspace', workspace: workspaceLink }), /symlink/)
    file(path.join(newFixture('post-clone-link'), 'sample', 'SKILL.md'))
    const late = path.join(temp, 'late-destination')
    afterClone = () => fs.symlinkSync(outside, late, 'dir')
    await assert.rejects(installSkillRepo({ repo, dir: late }), /symlink/)
    afterClone = null
    cleanTmp()
  })
  await test('limits source size, count and depth and cleans temp on every rejection', async () => {
    file(path.join(newFixture('oversized'), 'big', 'SKILL.md'))
    fs.truncateSync(path.join(fixture, 'big', 'SKILL.md'), 9 * 1024 * 1024)
    await assert.rejects(installSkillRepo({ repo, dir }), /size limit/)
    cleanTmp()
    newFixture('too-many-skills')
    for (let i = 0; i < 41; i++) file(path.join(fixture, `skill-${i}`, 'SKILL.md'))
    await assert.rejects(installSkillRepo({ repo, dir }), /too many skills/)
    cleanTmp()
    file(path.join(newFixture('deep'), 'deep', 'SKILL.md'))
    file(path.join(fixture, 'deep', ...Array(34).fill('nested'), 'resource.txt'), 'x')
    await assert.rejects(installSkillRepo({ repo, dir }), /depth limit/)
    cleanTmp()
  })
  await test('bounded traversal rejects broad collections without leaking temporary files', async () => {
    newFixture('broad')
    for (let i = 0; i < 5001; i++) file(path.join(fixture, `file-${i}`), '')
    await assert.rejects(installSkillRepo({ repo, dir }), /traversal limit/)
    cleanTmp()
    const listing = path.join(temp, 'broad-listing')
    fs.mkdirSync(listing)
    for (let i = 0; i < 5001; i++) file(path.join(listing, `file-${i}`), '')
    assert.throws(() => listSkills(listing), /traversal limit/)
  })
  await test('copy errors clean the partial destination and clone in finally', async () => {
    file(path.join(newFixture('copy-failure'), 'partial', 'SKILL.md'))
    const originalWrite = fs.writeFileSync
    afterClone = () => {
      fs.writeFileSync = (destination, ...args) => {
        if (String(destination).startsWith(path.join(dir, 'partial'))) throw new Error('fixture copy failure')
        return originalWrite(destination, ...args)
      }
    }
    try { await assert.rejects(installSkillRepo({ repo, dir }), /fixture copy failure/) }
    finally { fs.writeFileSync = originalWrite; afterClone = null }
    assert.equal(fs.existsSync(path.join(dir, 'partial')), false)
    cleanTmp()
  })
  await test('rejects invalid names and unsafe repo schemes before cloning', async () => {
    for (const name of ['../outside', '..', '', 123, 'a/b']) assert.throws(() => removeSkill(dir, name), status(400))
    const before = clones
    for (const badRepo of ['file:///tmp/repo', '/tmp/repo', '--upload-pack=evil', 'ssh://host/repo']) {
      await assert.rejects(installSkillRepo({ repo: badRepo, dir }), status(400))
    }
    assert.equal(clones, before)
  })
  console.log(`Skills manager tests passed (${passed} cases, local fixtures only).`)
} finally {
  childProcess.execFile = originalExecFile
  syncBuiltinESMExports()
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  fs.rmSync(temp, { recursive: true, force: true })
}
