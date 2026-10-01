import { useEffect, useState } from 'preact/hooks'
import { ws } from '../lib/ws.js'
import { t } from '../lib/i18n.js'
import { activeView, isAdmin, mobileTab, panelOpen, setAgentRail, workspace } from '../state/app.js'

// Installable extensions render a store-style detail page in the editor
// area. `agent` links an entry to an adapter id from `agent.agents`. The
// registry is currently empty — new entries carry the same shape the
// removed orchestrator card used.
export const EXTENSIONS = {}

export function extensionLabel(id) {
  return EXTENSIONS[id]?.label || id
}

export function useExtensionAgent(agentId) {
  const [agent, setAgent] = useState(null)

  async function probe(refresh = false) {
    try {
      const agents = await ws.request('agent', 'agents', refresh ? { refresh: true } : {})
      setAgent(agents.find((entry) => entry.id === agentId) || null)
    } catch { setAgent(null) }
  }

  // The server pushes `agent.agents` whenever availability re-probes change —
  // follow it so install/server-restart state arrives without a page reload.
  useEffect(() => {
    void probe()
    return ws.on('agent', 'agents', (list) => {
      if (Array.isArray(list)) setAgent(list.find((entry) => entry.id === agentId) || null)
    })
  }, [agentId])
  return { agent, probe }
}

// README HTML comes rendered from GitHub (sanitized); relative asset and link
// paths are rewritten to absolute repo URLs so images and links still work.
function useReadme(ext) {
  const [readme, setReadme] = useState(null)
  useEffect(() => {
    if (!ext) return undefined
    let live = true
    setReadme(null)
    fetch(ext.readmeApi, { headers: { Accept: 'application/vnd.github.html+json' } })
      .then((response) => (response.ok ? response.text() : Promise.reject(new Error(`readme ${response.status}`))))
      .then((html) => {
        if (!live) return
        const doc = new DOMParser().parseFromString(html, 'text/html')
        doc.querySelectorAll('img').forEach((img) => {
          const src = img.getAttribute('src') || ''
          if (src && !/^https?:\/\//.test(src)) img.src = ext.rawBase + src.replace(/^\.?\//, '')
        })
        doc.querySelectorAll('a').forEach((a) => {
          const href = a.getAttribute('href') || ''
          if (href.startsWith('#')) a.href = `${ext.repo}#readme`
          else if (href && !/^https?:\/\//.test(href)) a.href = `${ext.repo}/blob/main/${href.replace(/^\.?\//, '')}`
          a.target = '_blank'
          a.rel = 'noopener noreferrer'
        })
        setReadme(doc.body.innerHTML)
      })
      .catch(() => { if (live) setReadme('error') })
    return () => { live = false }
  }, [ext?.agent])
  return readme
}

export function ExtensionDetail({ id }) {
  const ext = EXTENSIONS[id]
  const { agent, probe } = useExtensionAgent(ext?.agent || id)
  const [installing, setInstalling] = useState(false)
  const readme = useReadme(ext)

  if (!ext) return <div class="ext-page"><p class="ext-page-desc">{t('extensions.unknown')}</p></div>

  const installed = Boolean(agent?.available)

  // Same install flow as the agent modal: the one-line installer runs in a
  // visible terminal so the user watches it, and availability re-probes when
  // the finish marker scrolls by.
  async function install() {
    if (installing) return
    setInstalling(true)
    try {
      const { id: ptyId } = await ws.request('pty', 'create', { cols: 100, rows: 30, workspace: workspace.value?.path || '', command: `${agent?.install?.command || ext.installCommand}; echo "[harpy] install finished"` })
      panelOpen.value = true
      window.dispatchEvent(new CustomEvent('harpy:pty-created', { detail: { id: ptyId, workspace: workspace.value?.path || '' } }))
      let tail = ''
      const unsubscribe = ws.on('pty', 'data', (event) => {
        if (event.id !== ptyId) return
        tail = (tail + String(event.data || '')).slice(-500)
        if (!tail.includes('install finished')) return
        unsubscribe()
        setInstalling(false)
        void probe(true)
      })
    } catch { setInstalling(false) }
  }

  async function openDashboard() {
    try {
      await ws.request('agent', 'start', { agent: ext.agent, workspace: workspace.value?.path || '', cols: 100, rows: 30 })
      setAgentRail(true)
      mobileTab.value = 'agent'
      activeView.value = 'agent'
    } catch { /* the agent panel surfaces session errors itself */ }
  }

  return <div class="ext-page">
    <div class="ext-page-body">
      <div class="ext-page-head">
        <span class="ext-page-icon"><img src={ext.icon} width={40} height={40} alt="" /></span>
        <span class="ext-page-meta"><strong>{ext.label}</strong><small>{ext.publisher} · npm · {ext.license}</small>{installed && <span class="extension-state">{t('extensions.installed')}</span>}</span>
      </div>
      <div class="ext-page-cta">{installed
        ? <vscode-button icon="debug-start" onClick={openDashboard}>{t('extensions.openDashboard')}</vscode-button>
        : (isAdmin.value && <vscode-button icon="cloud-download" disabled={installing ? true : undefined} onClick={install}>{installing ? t('extensions.installing') : t('extensions.install')}</vscode-button>)}</div>
      <p class="ext-page-desc">{t(`extensions.${id}Description`)}</p>
      {readme === 'error'
        ? <p class="ext-readme-fallback"><a href={ext.repo} target="_blank" rel="noopener noreferrer">{t('extensions.viewOnGithub')}</a></p>
        : readme
          ? <article class="ext-readme" dangerouslySetInnerHTML={{ __html: readme }} />
          : <div class="ext-readme-loading"><vscode-progress-ring /></div>}
    </div>
  </div>
}
