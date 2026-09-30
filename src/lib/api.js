const TOKEN_KEY = 'harpy.token'

// The workbench is served same-origin by the Harpy backend, so requests use
// relative URLs — the Vite dev proxy and the production server both work
// unchanged.
export const backendOrigin = ''

export function resolveApiUrl(path) {
  return `${backendOrigin}${path}`
}

export function getToken() {
  return localStorage.getItem(TOKEN_KEY) || ''
}

export function setToken(token) {
  if (token) localStorage.setItem(TOKEN_KEY, token)
  else localStorage.removeItem(TOKEN_KEY)
}

async function request(method, path, body, origin = backendOrigin) {
  const headers = {}
  if (body !== undefined) headers['content-type'] = 'application/json'
  if (getToken()) headers.authorization = `Bearer ${getToken()}`
  // A wedged server that accepts TCP but never answers must not leave the UI
  // spinning forever — every REST call gets a hard ceiling.
  const response = await fetch(`${origin}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(25_000) })
  const text = await response.text()
  let data = null
  try { data = text ? JSON.parse(text) : null } catch { data = { error: text || response.statusText } }
  // Any authenticated call that comes back 401 means the session is dead
  // (expired JWT, revoked account) — bounce to the login gate once. The
  // login/setup endpoints themselves are excluded so a bad password still
  // surfaces its own error.
  if (response.status === 401 && getToken() && path !== '/api/auth/login' && path !== '/api/auth/setup' && typeof window !== 'undefined') {
    setToken('')
    window.dispatchEvent(new Event('harpy:auth-expired'))
  }
  if (!response.ok) throw Object.assign(new Error(data?.error || response.statusText), { status: response.status })
  return data
}

export const api = {
  get: (path) => request('GET', path),
  post: (path, body) => request('POST', path, body),
  put: (path, body) => request('PUT', path, body),
  del: (path) => request('DELETE', path),
  health: () => request('GET', '/api/health')
}
