import { useEffect, useRef, useState } from 'preact/hooks'
import { Globe2, Maximize2, RefreshCw, X } from '../lib/icons.jsx'
import { api, resolveApiUrl } from '../lib/api.js'
import { t } from '../lib/i18n.js'
import { TInput } from './Fields.jsx'
import { workspace } from '../state/app.js'

// Device frames: the iframe keeps its own layout width while the wrapper
// constrains the visible viewport — a phone preview is just a narrower box.
const DEVICES = [
  { id: 'desktop', label: 'preview.desktop', width: null },
  { id: 'tablet', label: 'preview.tablet', width: 768 },
  { id: 'phone', label: 'preview.phone', width: 390 }
]

function targetUrl(target) {
  // The dev server lives on the Harpy host; the iframe reaches it through
  // the same hostname the browser used for this UI.
  const host = location.hostname
  return `http://${host}:${target.port}/`
}

export function PreviewPane() {
  const [targets, setTargets] = useState([])
  const [selected, setSelected] = useState('')
  const [device, setDevice] = useState('desktop')
  const [staticPath, setStaticPath] = useState('index.html')
  const [mode, setMode] = useState('server')
  const [frameKey, setFrameKey] = useState(0)
  const [error, setError] = useState('')
  const scanningRef = useRef(false)
  const targetCountRef = useRef(0)

  async function scan() {
    if (scanningRef.current) return
    scanningRef.current = true
    try {
      const { targets: found } = await api.get('/api/preview/targets')
      setTargets(found || [])
      targetCountRef.current = found?.length || 0
      setError('')
    } catch (requestError) {
      setError(requestError.message)
    } finally {
      scanningRef.current = false
    }
  }

  // Discovery stays snappy (5s) only while nothing is listening yet; once a
  // dev server is up the loop relaxes to 30s, and hidden tabs don't poll.
  useEffect(() => {
    let timer
    const tick = async () => {
      if (!document.hidden) await scan()
      timer = setTimeout(tick, targetCountRef.current ? 30_000 : 5_000)
    }
    const visible = () => { if (!document.hidden) scan() }
    tick()
    window.addEventListener('harpy:ws-open', visible)
    window.addEventListener('harpy:workspace-change', visible)
    document.addEventListener('visibilitychange', visible)
    return () => {
      clearTimeout(timer)
      window.removeEventListener('harpy:ws-open', visible)
      window.removeEventListener('harpy:workspace-change', visible)
      document.removeEventListener('visibilitychange', visible)
    }
  }, [])

  const active = targets.find((item) => String(item.port) === selected)
  useEffect(() => {
    if (!active && targets.length && !selected) setSelected(String(targets[0].port))
    if (active && selected !== String(active.port)) setSelected(String(active.port))
  }, [targets])

  // Static previews are served to an iframe, which cannot send Authorization
  // — the server issues a 60s ticket bound to (principal, workspace, path)
  // instead of putting the session JWT in the URL. Debounced so typing in
  // the path field does not mint a ticket per keystroke.
  const [staticSrc, setStaticSrc] = useState('')
  useEffect(() => {
    if (mode !== 'static') { setStaticSrc(''); return undefined }
    let cancelled = false
    const timer = setTimeout(async () => {
      const w = workspace.value?.path || ''
      const p = staticPath || 'index.html'
      try {
        const { ticket } = await api.post('/api/preview/ticket', { w, p })
        if (!cancelled) setStaticSrc(`${resolveApiUrl('/api/preview/static')}?w=${encodeURIComponent(w)}&p=${encodeURIComponent(p)}&ptok=${encodeURIComponent(ticket)}`)
      } catch { if (!cancelled) setStaticSrc('') }
    }, 350)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [mode, staticPath, workspace.value?.path, frameKey])

  const src = mode === 'static'
    ? staticSrc
    : (active ? targetUrl(active) : '')

  return <div class="preview-pane">
    <div class="preview-toolbar">
      <span class="terminal-badge"><Globe2 size={13} /> {t('preview.title')}</span>
      <div class="preview-source">
        <button type="button" class={`preview-mode ${mode === 'server' ? 'active' : ''}`} onClick={() => setMode('server')}>{t('preview.devServer')}</button>
        <button type="button" class={`preview-mode ${mode === 'static' ? 'active' : ''}`} onClick={() => setMode('static')}>{t('preview.staticFile')}</button>
      </div>
      {mode === 'server' ? (
        <select class="preview-port" value={selected} onChange={(event) => setSelected(event.currentTarget.value)} aria-label={t('preview.port')}>
          {!targets.length && <option value="">{t('preview.noServer')}</option>}
          {targets.map((item) => <option key={item.port} value={String(item.port)}>:{item.port}{item.label ? ` · ${item.label}` : ''}</option>)}
        </select>
      ) : (
        <TInput class="preview-path" value={staticPath} onInput={(event) => setStaticPath(event.currentTarget.value)} placeholder="index.html" aria-label={t('preview.staticPath')} spellcheck="false" />
      )}
      <div class="preview-devices" role="group" aria-label={t('preview.device')}>
        {DEVICES.map((item) => <button key={item.id} type="button" class={device === item.id ? 'active' : ''} aria-pressed={device === item.id} onClick={() => setDevice(item.id)} title={t(item.label)}>{t(item.label)}</button>)}
      </div>
      <span class="agent-header-spacer" />
      <vscode-toolbar-button icon="refresh" onClick={() => { setFrameKey((value) => value + 1); scan() }} title={t('preview.refresh')} aria-label={t('preview.refresh')}></vscode-toolbar-button>
      {src && mode === 'server' && <vscode-toolbar-button icon="link-external" onClick={() => window.open(src, '_blank', 'noopener')} title={t('preview.openExternal')} aria-label={t('preview.openExternal')}></vscode-toolbar-button>}
    </div>
    <div class="preview-stage">
      {src ? (
        <div class={`preview-frame preview-${device}`} style={DEVICES.find((item) => item.id === device)?.width ? { '--device-width': `${DEVICES.find((item) => item.id === device).width}px` } : {}}>
          <iframe key={frameKey + src} src={src} title={t('preview.title')} sandbox="allow-scripts allow-forms allow-modals allow-popups" />
        </div>
      ) : (
        <div class="preview-empty">
          <Maximize2 size={20} />
          <span>{t('preview.empty')}</span>
          <small>{mode === 'server' ? t('preview.emptyHint') : t('preview.staticHint')}</small>
        </div>
      )}
      {error && <div class="error-text agent-error" role="alert">{error}</div>}
    </div>
  </div>
}
