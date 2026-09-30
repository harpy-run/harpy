import { useEffect, useState } from 'preact/hooks'
import { api, getToken, setToken } from './lib/api.js'
import { ws } from './lib/ws.js'
import { t } from './lib/i18n.js'
import { setPrincipal } from './state/app.js'
import { AuthGate } from './components/AuthGate.jsx'
import { Shell } from './components/Shell.jsx'

export function App() {
  const [state, setState] = useState({ loading: true, setupRequired: false, authenticated: false })
  const [retryKey, setRetryKey] = useState(0)

  useEffect(() => {
    let cancelled = false
    const wait = (delay) => new Promise((resolve) => setTimeout(resolve, delay))

    // The daemon may still be booting (fresh start, update restart). Give it
    // a brief window to bind its port before treating the backend as down.
    async function healthWithRetry() {
      let lastError
      for (let attempt = 0; attempt < 20; attempt += 1) {
        if (cancelled) return null
        try { return await api.health() } catch (error) {
          lastError = error
          if (attempt < 19) {
            await wait(Math.min(300 + attempt * 150, 1_200))
            if (cancelled) return null
          }
        }
      }
      throw lastError || new Error('server unavailable')
    }

    async function boot() {
      try {
        const health = await healthWithRetry()
        if (!health || cancelled) return
        let authenticated = false
        if (getToken()) {
          try {
            const me = await api.get('/api/auth/me')
            // Rehydrate the principal on reload — admin-only UI (user manager,
            // Git bootstrap) keys off this and must not depend on the login
            // response having just run.
            if (me?.principal) setPrincipal(me.principal)
            authenticated = true
          } catch {
            setToken('')
          }
        }
        if (!cancelled) setState({ loading: false, setupRequired: health.setupRequired, authenticated })
      } catch {
        if (!cancelled) setState({ loading: false, setupRequired: false, authenticated: false, unavailable: true })
      }
    }
    boot()
    return () => { cancelled = true; ws.close() }
  }, [retryKey])

  // The socket layer clears the credential and fires this when the session is
  // unrecoverable (token expired, account revoked). Drop back to the gate.
  useEffect(() => {
    const expired = () => setState((current) => ({ ...current, authenticated: false }))
    window.addEventListener('harpy:auth-expired', expired)
    return () => window.removeEventListener('harpy:auth-expired', expired)
  }, [])

  // The server may still be booting or restarting — keep probing instead of
  // stranding the user on this screen.
  useEffect(() => {
    if (!state.unavailable) return
    const timer = setInterval(() => {
      setState({ loading: true, setupRequired: false, authenticated: false })
      setRetryKey((value) => value + 1)
    }, 15000)
    return () => clearInterval(timer)
  }, [state.unavailable])

  if (state.loading) return <div class="loading-screen"><img src="/logo.png" alt="Harpy" /><span>Harpy</span></div>
  if (state.unavailable) return <div class="loading-screen loading-unavailable"><img src="/logo.png" alt="Harpy" /><span>{t('app.unavailable')}</span><small>{t('app.unavailableHint')}</small><button type="button" class="btn-accent" onClick={() => { setState({ loading: true, setupRequired: false, authenticated: false }); setRetryKey((value) => value + 1) }}>{t('app.retry')}</button></div>
  if (state.authenticated) return <Shell />
  return <AuthGate setupRequired={state.setupRequired} onAuthenticated={() => setState((current) => ({ ...current, authenticated: true }))} />
}

export default App
