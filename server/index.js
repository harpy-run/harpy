import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { config, VERSION } from './config.js'
import { authMiddleware, authRoutes, checkApiKey, issueApiKey, loadAuth } from './auth.js'
import { Router } from './router.js'
import { serveStatic } from './static.js'
import { installAgentSkills } from './agent-skills.js'
import { sendJson } from './util/http.js'
import { createHub } from './ws.js'
import { fsChannel } from './channels/fs.channel.js'
import { gitChannel } from './channels/git.channel.js'
import { ptyChannel } from './channels/pty.channel.js'
import { agentChannel } from './channels/agent.channel.js'
import { authChannel } from './channels/auth.channel.js'
import { registerAllAdapters } from './agents/adapters/index.js'
import { listAgents } from './agents/adapter.js'
import { restoreSessions, setPresenceNotifier, setSessionEndHook } from './agents/runner.js'
import { initializeWorkspace } from './projects.js'
import { projectChannel } from './channels/project.channel.js'
import { activityChannel } from './channels/activity.channel.js'
import { shareChannel } from './channels/share.channel.js'
import { systemChannel } from './channels/system.channel.js'
import { shareResume, shareRoutes, shareSupervise } from './share.js'
import { previewRoutes } from './preview.js'
import { oauthRoutes } from './git-oauth.js'
import { automationChannel } from './channels/automation.channel.js'

import { automationRoutes, onFsChanged, sessionEnded, setAutomationNotifier, startScheduler } from './automations.js'
import { registerFsListener } from './channels/fs.channel.js'
import { getPty } from './util/pty.js'

function allowLocalOrigin(origin) {
  if (!origin) return false
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)
}

function setCors(req, res) {
  const origin = req.headers.origin
  if (!allowLocalOrigin(origin)) return false
  res.setHeader('access-control-allow-origin', origin)
  res.setHeader('access-control-allow-headers', 'authorization, content-type')
  res.setHeader('access-control-allow-methods', 'GET, POST, PUT, DELETE, OPTIONS')
  res.setHeader('vary', 'Origin')
  return true
}

export function createHttpServer() {
  loadAuth()
  initializeWorkspace()
  const router = new Router()
  authRoutes(router)
  previewRoutes(router)
  oauthRoutes(router)
  shareRoutes(router)
  automationRoutes(router)
  const distExists = fs.existsSync(config.distDir)
  const server = http.createServer(async (req, res) => {
    const localOrigin = setCors(req, res)
    if (req.method === 'OPTIONS' && localOrigin) {
      res.writeHead(204)
      res.end()
      return
    }
    if (req.url?.startsWith('/api/')) {
      try {
        const handled = await router.handle(req, res, { verify: authMiddleware })
        if (handled || res.writableEnded) return
      } catch (error) {
        // A throwing verifier or a router-level bug must never leave the
        // request hanging — answer 500 instead of stalling the client.
        console.error(`[api] ${String(req.url || '').split('?')[0]}: ${error?.message || error}`)
        if (!res.writableEnded) sendJson(res, 500, { error: 'internal error' })
        return
      }
      sendJson(res, 404, { error: 'not found' })
      return
    }
    if (distExists && serveStatic(req, res, config.distDir)) return
    sendJson(res, 404, { error: 'not found' })
  })
  server.on('clientError', (_error, socket) => socket.destroy())

  const hub = createHub(server)
  registerAllAdapters()
  // Respawn agent sessions that were running when the previous process died.
  restoreSessions().catch(() => {})
  hub.register('project', projectChannel)
  hub.register('auth', authChannel)
  hub.register('fs', fsChannel)
  hub.register('git', gitChannel)
  hub.register('pty', ptyChannel)
  hub.register('agent', agentChannel)
  hub.register('activity', activityChannel)
  hub.register('share', shareChannel)
  hub.register('system', systemChannel)
  hub.register('automation', automationChannel)
  // Automation engine: fs watcher flushes, the cron tick, and the runner's
  // session-end hook feed trigger → gate → spawn. All idle work is local.
  registerFsListener(onFsChanged)
  setSessionEndHook(sessionEnded)
  setAutomationNotifier(() => hub.broadcast('automation', 'changed', {}))
  startScheduler()
  // Agent session lifecycle changes are broadcast so every client can refresh
  // its "who else is working" presence strip.
  setPresenceNotifier(() => hub.broadcast('agent', 'presence', {}))

  // Re-detect agent CLIs in the background so installs and removals surface
  // without a manual refresh. Only broadcast when availability changed.
  const AGENT_RECHECK_MS = 60 * 60 * 1_000
  const fingerprintOf = (agents) => agents.map((agent) => `${agent.id}:${agent.available}`).join(',')
  let agentFingerprint = null
  listAgents().then((agents) => { agentFingerprint = fingerprintOf(agents) }).catch(() => {})
  setInterval(async () => {
    try {
      const agents = await listAgents({ refresh: true })
      const fingerprint = fingerprintOf(agents)
      if (agentFingerprint !== null && fingerprint !== agentFingerprint) hub.broadcast('agent', 'agents', agents)
      agentFingerprint = fingerprint
    } catch { void 0 }
  }, AGENT_RECHECK_MS).unref?.()

  return { server, router, hub }
}

// A loopback-only capability file lets the interactive `harpy` shell drive
// daemon ops (teams, sessions, send) without asking for the password — it
// lives at 0600 inside the 0700 data dir, so only the owning account reads
// it. Reused across restarts; minted fresh whenever it does not verify.
const CLI_KEY_FILE = () => path.join(config.dataDir, 'daemon', 'cli.key')
function writeCliKey() {
  try {
    const file = CLI_KEY_FILE()
    const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim() : ''
    const key = existing && checkApiKey(existing) ? existing : issueApiKey('harpy cli').key
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    fs.writeFileSync(file, `${key}\n`, { mode: 0o600 })
  } catch { void 0 }
}

export function startServer(options = {}) {
  const { server } = createHttpServer()
  const port = Number(options.port || config.port)
  const host = options.host || config.host
  const activePort = port
  const listen = () => {
    const onListening = () => {
      const displayHost = host === '0.0.0.0' ? 'localhost' : host
      console.log(`harpy v${VERSION} listening on http://${displayHost}:${activePort}`)
      // Surface a broken PTY backend at boot — a missing native binary
      // otherwise only shows up as a cryptic spawn error much later.
      getPty().catch((error) => console.warn(`[pty] ${error.message}`))
      writeCliKey()
      installAgentSkills()
      shareResume({ port: activePort })
      shareSupervise({ port: activePort })
    }
    const onError = (error) => {
      const detail = error?.code === 'EADDRINUSE'
        ? `port ${activePort} is already in use`
        : (error?.message || 'server failed to start')
      console.error(`harpy could not start: ${detail}`)
      process.exitCode = 1
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(activePort, host)
  }
  listen()
  const shutdown = () => {
    try { fs.unlinkSync(CLI_KEY_FILE()) } catch { void 0 }
    server.close(() => process.exit(0))
    // Open WebSockets keep server.close() pending forever; drop every socket
    // and cap the graceful window so service restarts stay fast.
    server.closeAllConnections?.()
    setTimeout(() => process.exit(0), 3_000).unref?.()
  }
  // A daemon child is supervised by the platform service/launcher. Keep the
  // process in the foreground so signals terminate the HTTP server cleanly;
  // the parent daemon command is the component that detaches from the shell.
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
  return server
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) startServer()
