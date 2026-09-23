export function httpError(status, message) {
  const error = new Error(message || `HTTP ${status}`)
  error.status = status
  return error
}

export function sendJson(res, status, data) {
  // headersSent guards streaming handlers (e.g. /api/preview/static) that
  // already wrote a 200 + started piping — a late sendJson would otherwise
  // throw ERR_HTTP_HEADERS_SENT and crash the process.
  if (res.writableEnded || res.headersSent) return
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'SAMEORIGIN'
  })
  res.end(JSON.stringify(data ?? null))
}

export function sendError(res, status, message) {
  sendJson(res, status, { error: message || `HTTP ${status}` })
}

export async function readBody(req, limit = 1_000_000) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw httpError(413, 'payload too large')
    chunks.push(chunk)
  }
  const raw = Buffer.concat(chunks).toString('utf8')
  if (!raw) return {}
  const contentType = req.headers['content-type'] || ''
  if (!contentType.toLowerCase().includes('json')) throw httpError(415, 'content-type must be json')
  try {
    const body = JSON.parse(raw)
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('body must be an object')
    return body
  } catch {
    throw httpError(400, 'invalid json body')
  }
}
