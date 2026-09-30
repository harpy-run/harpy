#!/usr/bin/env node

/**
 * Keep the package version as the single source of truth for all distributable
 * manifests. npm runs this file through its version lifecycle hook after it
 * updates package.json and package-lock.json, and it can also be run manually
 * with npm run version:sync.
 */
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const packagePath = path.join(root, 'package.json')
const lockPath = path.join(root, 'package-lock.json')
const configPath = path.join(root, 'server', 'config.js')
const updaterPath = path.join(root, 'src', 'lib', 'updater.js')

const packageJson = JSON.parse(await readFile(packagePath, 'utf8'))
const version = packageJson.version

if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  throw new Error('Invalid package version: ' + version)
}

const writeJsonIfChanged = async (filePath, value) => {
  const current = await readFile(filePath, 'utf8')
  const next = JSON.stringify(value, null, 2) + '\n'
  if (current !== next) await writeFile(filePath, next)
}

// npm normally updates this field itself. Updating it here also makes a
// manually edited package.json safe before the next npm install/publish.
const lockJson = JSON.parse(await readFile(lockPath, 'utf8'))
let lockChanged = false
if (lockJson.version !== version) {
  lockJson.version = version
  lockChanged = true
}
if (lockJson.packages?.[''] && lockJson.packages[''].version !== version) {
  lockJson.packages[''].version = version
  lockChanged = true
}
if (lockChanged) await writeJsonIfChanged(lockPath, lockJson)

const config = await readFile(configPath, 'utf8')
const configVersion = config.match(/export const VERSION\s*=\s*['"]([^'"]+)['"]/)
if (!configVersion) throw new Error('Missing VERSION export in ' + configPath)
if (configVersion[1] !== version) {
  await writeFile(configPath, config.replace(/(export const VERSION\s*=\s*)['"][^'"]+['"]/, '$1' + JSON.stringify(version)))
}

const updater = await readFile(updaterPath, 'utf8')
const updaterVersion = updater.match(/export const CURRENT_VERSION\s*=\s*['"]([^'"]+)['"]/)
if (!updaterVersion) throw new Error('Missing CURRENT_VERSION export in ' + updaterPath)
if (updaterVersion[1] !== version) {
  await writeFile(updaterPath, updater.replace(/(export const CURRENT_VERSION\s*=\s*)['"][^'"]+['"]/, '$1' + JSON.stringify(version)))
}

console.log('Synchronized release manifests to ' + version)
