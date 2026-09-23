import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { config } from './config.js'
import { httpError, readBody, sendJson } from './util/http.js'
import { workspacePath } from './workspace.js'

const execFileAsync = promisify(execFile)

// Ports that commonly host dev servers even when the socket scan misses.
const CANDIDATE_PORTS = [3000, 3002, 4200, 4321, 5000, 5173, 5174, 5175, 8000, 8080, 8081, 8888, 9000, 9090, 1234, 1111]

// Listing dev servers = reading LISTEN sockets on this machine. /proc is the
// cheapest source on Linux; lsof covers macOS. Both are best-effort.
async function listeningPorts() {
  const ports = new Set(CANDIDATE_PORTS)
  try {
    for (const file of ['/proc/net/tcp', '/proc/net/tcp6']) {
      const raw = fs.readFileSync(file, 'utf8')
      for (const line of raw.split('\n').slice(1)) {
        const parts = line.trim().split(/\s+/)
        if (parts[3] === '0A') ports.add(parseInt(parts[1].split(':')[1], 16))
      }
    }
  } catch {
    try {
      const { stdout } = await execFileAsync('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN'], { timeout: 4_000 })
      for (const line of stdout.split('\n')) {
        const match = line.match(/:(\d+)\s*\(LISTEN\)/)
        if (match) ports.add(Number(match[1]))
      }
    } catch { /* candidates only */ }
  }
  for (const port of ports) {
    if (!port || port < 80 || port > 65535 || port === config.port) ports.delete(port)
  }
  return ports
}

// Other Harpy instances on this machine answer /api/health with a marker
// body — filtering them keeps the workbench out of its own target list.
function isHarpyServer(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/health', timeout: 600 }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => { body += chunk; if (body.length > 2048) req.destroy() })
      res.on('end', () => {
        try { resolve(JSON.parse(body)?.name === 'harpy') } catch { resolve(false) }
      })
      res.on('error', () => resolve(false))
    })
    req.on('timeout', () => { req.destroy(); resolve(false) })
    req.on('error', () => resolve(false))
  })
}

// A dev server counts as previewable when it answers HTTP with an HTML page.
// Anything else (API-only services, databases, our own socket) is skipped.
function probe(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: 700 }, (res) => {
      const type = String(res.headers['content-type'] || '')
      let head = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => { head += chunk; if (head.length > 4096) req.destroy() })
      res.on('end', () => {
        const html = type.includes('html') || /<(!doctype|html|head|body)\b/i.test(head)
        resolve(html ? {
          port,
          label: res.headers['x-powered-by'] || res.headers.server || '',
          url: `http://127.0.0.1:${port}/`
        } : null)
      })
      res.on('error', () => resolve(null))
    })
    req.on('timeout', () => { req.destroy(); resolve(null) })
    req.on('error', () => resolve(null))
  })
}

let targetsCache = { ts: 0, targets: [] }
export async function previewTargets() {
  if (Date.now() - targetsCache.ts < 3_000) return targetsCache.targets
  const ports = await listeningPorts()
  const found = (await Promise.all([...ports].map(async (port) => (await isHarpyServer(port)) ? null : probe(port)))).filter(Boolean)
  targetsCache = { ts: Date.now(), targets: found.sort((a, b) => a.port - b.port) }
  return found
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json',
  '.map': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
  '.wasm': 'application/wasm', '.xml': 'application/xml', '.pdf': 'application/pdf',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg'
}

// ─── static preview tickets ──────────────────────────────────────────────
// The preview iframe cannot send Authorization, so something has to travel
// in the URL — but a bearer JWT there leaks via history, logs, screenshots,
// and the framed page itself reading location.href. Instead the UI mints a
// short-lived ticket bound to (principal, workspace, path): a leaked ticket
// re-reads that one file for a minute and authenticates nothing else.
const PREVIEW_TICKET_TTL_MS = 60_000
const previewTickets = new Map()

function issueTicket(principal, w, p) {
  const now = Date.now()
  for (const [key, entry] of previewTickets) if (entry.exp < now) previewTickets.delete(key)
  const ticket = crypto.randomBytes(24).toString('base64url')
  previewTickets.set(ticket, {
    exp: now + PREVIEW_TICKET_TTL_MS,
    principal,
    w: String(w || ''),
    p: String(p || 'index.html')
  })
  return { ticket, expiresIn: Math.floor(PREVIEW_TICKET_TTL_MS / 1000) }
}

function redeemTicket(ticket, w, p) {
  const entry = previewTickets.get(String(ticket || ''))
  if (!entry || entry.exp < Date.now()) return null
  if (entry.w !== String(w || '') || entry.p !== String(p || 'index.html')) return null
  return entry.principal
}

// Static preview: serve a workspace file (or its folder's index.html) over
// HTTP so plain HTML/CSS/JS previews instantly with no dev server at all.
function serveStaticFile(req, res) {
  const w = req.query.get('w') || ''
  const file = req.query.get('p') || 'index.html'
  const principal = redeemTicket(req.query.get('ptok'), w, file)
  if (!principal) { sendJson(res, 401, { error: 'unauthorized' }); return }
  let resolved
  try {
    const { base, resolved: lexical } = workspacePath(w, file, { principal })
    resolved = lexical
    if (fs.statSync(resolved).isDirectory()) resolved = path.join(resolved, 'index.html')
    // A symlink inside the workspace must not hand out files outside it —
    // compare realpaths, not just the lexical resolve.
    const realBase = fs.realpathSync(base)
    resolved = fs.realpathSync(resolved)
    if (resolved !== realBase && !resolved.startsWith(`${realBase}${path.sep}`)) throw httpError(403, 'path outside workspace')
  } catch (error) {
    sendJson(res, error.status || 404, { error: error.status ? error.message : 'not found' })
    return
  }
  const type = MIME[path.extname(resolved).toLowerCase()] || 'application/octet-stream'
  try {
    const stat = fs.statSync(resolved)
    // Previews are source files — cap them so a giant artifact cannot stall
    // the event loop, and stream rather than buffering the whole file.
    if (!stat.isFile() || stat.size > 50 * 1024 * 1024) { sendJson(res, 404, { error: 'not found' }); return }
    res.writeHead(200, {
      'content-type': type,
      'cache-control': 'no-store',
      'content-length': stat.size,
      'x-content-type-options': 'nosniff',
      // Previewed files are untrusted workspace content: sandbox forces an
      // opaque origin so the framed page cannot reach the parent
      // (localStorage, WS, DOM) even though it is served same-origin.
      'content-security-policy': "sandbox allow-scripts allow-forms; frame-ancestors 'self'"
    })
    fs.createReadStream(resolved).on('error', () => { if (!res.writableEnded) res.end() }).pipe(res)
  } catch {
    sendJson(res, 404, { error: 'not found' })
  }
}

export function previewRoutes(router) {
  router.get('/api/preview/targets', async () => ({ targets: await previewTargets() }))
  router.post('/api/preview/ticket', async (req) => {
    const body = await readBody(req, 8_000)
    return issueTicket(req.principal, body.w, body.p)
  })
  // Iframes cannot send Authorization headers; a single scoped ticket
  // travels as a query param instead of a bearer token.
  router.get('/api/preview/static', (req, res) => serveStaticFile(req, res), { auth: false })
}
