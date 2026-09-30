#!/usr/bin/env node

/** Fail when npm, lockfile, or runtime version constants drift apart. */
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const readJson = async (relativePath) => JSON.parse(await readFile(path.join(root, relativePath), 'utf8'))
const packageJson = await readJson('package.json')
const lockJson = await readJson('package-lock.json')
const config = await readFile(path.join(root, 'server', 'config.js'), 'utf8')
const updater = await readFile(path.join(root, 'src', 'lib', 'updater.js'), 'utf8')

const packageVersion = packageJson.version
const configVersion = config.match(/export const VERSION\s*=\s*['"]([^'"]+)['"]/)?.[1]
const updaterVersion = updater.match(/export const CURRENT_VERSION\s*=\s*['"]([^'"]+)['"]/)?.[1]

const expected = [
  ['package.json', packageVersion],
  ['package-lock.json', lockJson.version],
  ['package-lock.json packages[""].version', lockJson.packages?.['']?.version],
  ['server/config.js VERSION', configVersion],
  ['src/lib/updater.js CURRENT_VERSION', updaterVersion],
]
const mismatches = expected.filter(([, value]) => value !== packageVersion)
if (mismatches.length) {
  for (const [file, value] of mismatches) console.error(file + ': ' + (value ?? '(missing)') + ' (expected ' + packageVersion + ')')
  process.exitCode = 1
}

const tagIndex = process.argv.indexOf('--tag')
if (tagIndex !== -1) {
  const tag = process.argv[tagIndex + 1]
  if (!tag) throw new Error('--tag requires a value')
  const tagVersion = tag.startsWith('v') ? tag.slice(1) : tag
  if (tagVersion !== packageVersion) {
    console.error('Release tag ' + tag + ' does not match package version ' + packageVersion)
    process.exitCode = 1
  }
}

if (process.exitCode) process.exit()
console.log('Version sync OK: ' + packageVersion)
