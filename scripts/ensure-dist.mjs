#!/usr/bin/env node
// `npm run prepare` hook: guarantee dist/ matches package.json's version.
//
// `prepack` only runs for `npm pack`/`npm publish` — a local `npm i -g .` or
// git-dependency install copies whatever dist/ happens to be on disk, which
// can be a build from an older source tree (the daemon then serves a stale
// bundle and the updater banner loops). This script rebuilds only when
// dist is missing or embeds a different version, so plain `npm install`
// stays fast.
import fs from 'node:fs'
import path from 'node:path'
import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))

const indexHtml = path.join(root, 'dist', 'index.html')
const fresh = () => {
  try {
    const html = fs.readFileSync(indexHtml, 'utf8')
    const assets = [...html.matchAll(/assets\/[A-Za-z0-9_-]+\.js/g)].map((m) => m[0])
    return assets.some((a) => fs.readFileSync(path.join(root, 'dist', a), 'utf8').includes(`"${version}"`))
  } catch { return false }
}

if (fresh()) process.exit(0)
console.log(`prepare: dist/ is stale or missing — rebuilding for v${version}`)
try {
  execSync('npm run build', { cwd: root, stdio: 'inherit' })
} catch {
  // A failed build must not break installs (e.g. devDeps unavailable) —
  // the daemon 404s /, which is loud and fixable, unlike a silent stale bundle.
  console.warn('prepare: build failed — continuing with existing dist/')
}
