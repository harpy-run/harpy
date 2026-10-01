import fs from 'node:fs'
import path from 'node:path'

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
  '.map': 'application/json; charset=utf-8'
}

export function serveStatic(req, res, root) {
  if (!['GET', 'HEAD'].includes(req.method)) return false
  let pathname
  try { pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname) } catch {
    res.writeHead(400)
    res.end('bad path')
    return true
  }
  const base = path.resolve(root)
  const candidate = path.resolve(base, `.${pathname}`)
  if (candidate !== base && !candidate.startsWith(`${base}${path.sep}`)) {
    res.writeHead(400)
    res.end('bad path')
    return true
  }
  let filePath = candidate
  try {
    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) filePath = path.join(base, 'index.html')
    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) return false
    const type = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream'
    const stat = fs.statSync(filePath)
    // Cache policy: hashed /assets/* are immutable (new name per build) —
    // everything else must revalidate so a daemon update can never keep
    // serving a stale index.html/sw.js through the browser's HTTP cache.
    const cacheControl = pathname.startsWith('/assets/')
      ? 'public, max-age=31536000, immutable'
      : 'no-cache'
    // Weak etag + mtime so `no-cache` revalidations answer 304 instead of a
    // full re-download when the file is unchanged.
    const etag = `W/"${stat.size}-${Math.floor(stat.mtimeMs)}"`
    const lastModified = stat.mtime.toUTCString()
    if (req.headers['if-none-match'] === etag ||
        (req.headers['if-modified-since'] && Date.parse(req.headers['if-modified-since']) >= Math.floor(stat.mtimeMs / 1000) * 1000)) {
      res.writeHead(304, { 'cache-control': cacheControl, etag, 'last-modified': lastModified })
      res.end()
      return true
    }
    res.writeHead(200, {
      'content-type': type,
      'content-length': stat.size,
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'SAMEORIGIN',
      'cache-control': cacheControl,
      etag,
      'last-modified': lastModified
    })
    if (req.method === 'HEAD') { res.end(); return true }
    // The file can vanish between stat() and open() — an unhandled stream
    // 'error' event would crash the process, so fail the request instead.
    fs.createReadStream(filePath)
      .on('error', () => { if (!res.writableEnded) res.end() })
      .pipe(res)
    return true
  } catch {
    if (!res.writableEnded) res.writeHead(500).end('failed to serve file')
    return true
  }
}
