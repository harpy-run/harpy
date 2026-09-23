import { WebSocketServer } from 'ws'
import { verifyToken, checkApiKey, resolvePrincipal } from './auth.js'

// Reverse proxies and tunnels kill idle WebSockets after ~60s, and an
// aborted mid-frame read surfaces in the client as "invalid frame header".
// A periodic ping keeps the connection alive; a missed pong means the peer
// is silently gone, so the socket is terminated and removed.
const PING_INTERVAL_MS = 30_000
const PONG_TIMEOUT_MS = 10_000

export function createHub(server) {
  const channels = new Map()
  const connections = new Set()
  // The editor accepts files up to 5 MiB, so saves must fit inside one frame.
  // 8 MiB leaves headroom while still stopping the 100 MiB default's abuse.
  const wss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024 })
  // ws requires the upgrade response to select one of the offered
  // subprotocols — the credential slot itself is never echoed back.
  wss.on('headers', (headers, req) => {
    const offered = String(req.headers['sec-websocket-protocol'] || '').split(',').map((s) => s.trim())
    if (offered.includes('harpy')) headers.push('Sec-WebSocket-Protocol: harpy')
  })

  const heartbeat = setInterval(() => {
    for (const ws of connections) {
      if (ws.isAlive === false) { ws.terminate(); continue }
      ws.isAlive = false
      ws.ping()
      ws.pongTimer = setTimeout(() => { if (ws.isAlive === false) ws.terminate() }, PONG_TIMEOUT_MS)
    }
  }, PING_INTERVAL_MS)
  heartbeat.unref?.()

  function authenticate(req, url) {
    // Preferred transport is Sec-WebSocket-Protocol ("harpy, <credential>"):
    // credentials in URLs leak into access logs, browser history, and
    // referrer chains. ?key=/?token= remain for older clients and scripts.
    const offered = String(req.headers['sec-websocket-protocol'] || '')
      .split(',').map((s) => s.trim()).filter(Boolean)
    const viaProtocol = offered.indexOf('harpy') >= 0 ? offered[offered.indexOf('harpy') + 1] : ''
    const credential = viaProtocol || url.searchParams.get('key') || url.searchParams.get('token') || ''
    if (!credential) return null
    if (credential.startsWith('hp_')) return checkApiKey(credential) ? { sub: 'owner', role: 'admin' } : null
    return resolvePrincipal(verifyToken(credential))
  }

  function broadcast(channel, event, data) {
    const frame = JSON.stringify({ ch: channel, ev: event, data })
    for (const connection of connections) {
      if (connection.readyState === 1) connection.send(frame)
    }
  }

  server.on('upgrade', (req, socket, head) => {
    let url
    try { url = new URL(req.url, 'http://localhost') } catch { socket.destroy(); return }
    if (url.pathname !== '/ws') { socket.destroy(); return }
    const principal = authenticate(req, url)
    if (!principal) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.isAlive = true
      ws.on('pong', () => { ws.isAlive = true; clearTimeout(ws.pongTimer) })
      connections.add(ws)
      const context = {
        principal,
        clientId: url.searchParams.get('client') || 'legacy',
        ws,
        ch: {},
        send: (frame) => { if (ws.readyState === 1) ws.send(JSON.stringify(frame)) },
        request: async (channelName, operationName, data = {}) => {
          const channel = channels.get(channelName)
          const operation = channel?.ops?.[operationName]
          if (typeof operation !== 'function') throw new Error('unknown operation')
          return operation(context, data)
        }
      }
      context.emit = (channel, event, data) => context.send({ ch: channel, ev: event, data })
      for (const channel of channels.values()) {
        try { channel.onOpen?.(context) } catch { void 0 }
      }
      ws.on('message', async (raw) => {
        let frame
        try { frame = JSON.parse(raw.toString()) } catch { return }
        if (!frame || typeof frame !== 'object' || typeof frame.ch !== 'string') return
        const channel = channels.get(frame.ch)
        if (!channel) { context.send({ ch: frame.ch, id: frame.id, ok: false, error: 'unknown channel' }); return }
        const operation = channel.ops?.[frame.op]
        if (typeof operation !== 'function') { context.send({ ch: frame.ch, id: frame.id, ok: false, error: 'unknown op' }); return }
        try {
          const data = frame.data && typeof frame.data === 'object' ? frame.data : frame
          const result = await operation(context, data)
          context.send({ ch: frame.ch, id: frame.id, ok: true, data: result })
        } catch (error) {
          context.send({ ch: frame.ch, id: frame.id, ok: false, error: error.message || 'channel error' })
        }
      })
      ws.on('close', (code, reason) => {
        clearTimeout(ws.pongTimer)
        if (code === 1006 || code === 1002) console.warn(`[ws] abnormal close code=${code} reason=${reason?.toString().slice(0, 120) || '-'} client=${context.clientId}`)
        connections.delete(ws)
        for (const channel of channels.values()) {
          try { channel.onClose?.(context) } catch { void 0 }
        }
      })
      ws.on('error', (error) => {
        // Malformed frames (a proxy mangling the stream, a non-WS client)
        // surface here; keep the process alive but record what happened.
        console.warn(`[ws] connection error: ${error.message} client=${context.clientId}`)
      })
    })
  })

  function register(name, channel) {
    channels.set(name, channel)
    for (const context of connections) {
      try { channel.onOpen?.(context) } catch { void 0 }
    }
  }

  return { register, registerChannel: register, broadcast }
}
