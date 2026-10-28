import { useCallback, useEffect, useRef, useState } from 'preact/hooks'
import { Trash2 } from '../lib/icons.jsx'
import { ws } from '../lib/ws.js'
import { t } from '../lib/i18n.js'
import { isAdmin, workspace } from '../state/app.js'
import { VscSelect } from './vsc.jsx'
import { TField } from './Fields.jsx'

// User installations are per adapter; workspace collections are neutral and
// live in .agents/skills so every adapter can consume the same collection.
export function SkillManager() {
  const [agents, setAgents] = useState([])
  const [agent, setAgent] = useState('')
  const [scope, setScope] = useState('user')
  const [users, setUsers] = useState([])
  const [target, setTarget] = useState('')
  const [skills, setSkills] = useState([])
  const [repo, setRepo] = useState('')
  const [busy, setBusy] = useState(false)
  const [installing, setInstalling] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const workspacePath = workspace.value?.path || ''
  const selectedTarget = scope === 'user' ? target : ''
  const selection = JSON.stringify([agent, scope, selectedTarget, workspacePath])
  const currentSelection = useRef({ key: selection, epoch: 0 })
  if (currentSelection.current.key !== selection) {
    currentSelection.current = { key: selection, epoch: currentSelection.current.epoch + 1 }
  }
  const selectionEpoch = currentSelection.current.epoch
  const loadId = useRef(0)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    ws.request('agent', 'agents').then((list) => {
      if (!mounted.current) return
      const known = Array.isArray(list) ? list : []
      setAgents(known)
      setAgent((current) => known.some((item) => item.id === current)
        ? current : (known.find((item) => item.preferred)?.id || known[0]?.id || ''))
    }).catch((requestError) => { if (mounted.current) setError(requestError.message) })
    if (isAdmin.value) {
      ws.request('auth', 'users').then((list) => {
        if (mounted.current) setUsers(Array.isArray(list) ? list : [])
      }).catch(() => {})
    }
    return () => { mounted.current = false; loadId.current++ }
  }, [])

  const load = useCallback(async () => {
    const id = ++loadId.current
    const active = () => mounted.current && currentSelection.current.epoch === selectionEpoch && loadId.current === id
    setSkills([])
    setError('')
    if (!agent) { setBusy(false); return }
    setBusy(true)
    try {
      const { skills: list } = await ws.request('agent', 'skills', {
        agent, scope, for: selectedTarget || undefined, workspace: workspacePath
      })
      if (active()) setSkills(list || [])
    } catch (requestError) {
      if (active()) setError(requestError.message)
    } finally {
      if (active()) setBusy(false)
    }
  }, [agent, scope, selectedTarget, workspacePath, selectionEpoch])

  useEffect(() => {
    setNotice('')
    load()
    return () => { loadId.current++ }
  }, [load])

  async function install() {
    const value = repo.trim()
    if (!value || installing || !agent) return
    const active = () => mounted.current && currentSelection.current.epoch === selectionEpoch
    setInstalling(true)
    setError('')
    setNotice('')
    try {
      const result = await ws.request('agent', 'skillInstall', {
        agent, scope, for: selectedTarget || undefined, workspace: workspacePath, repo: value
      })
      if (active()) {
        setRepo('')
        setNotice(t('skills.installed', { count: result.count || 0 }))
        await load()
      }
    } catch (requestError) {
      if (active()) setError(requestError.message)
    } finally {
      if (mounted.current) setInstalling(false)
    }
  }

  async function remove(name) {
    const active = () => mounted.current && currentSelection.current.epoch === selectionEpoch
    try {
      await ws.request('agent', 'skillRemove', {
        agent, scope, for: selectedTarget || undefined, workspace: workspacePath, name
      })
      if (active()) await load()
    } catch (requestError) {
      if (active()) setError(requestError.message)
    }
  }

  return <div class="settings-card skill-manager">
    <div class="settings-control-row">
      <div class="settings-control-copy"><span><strong>{t('skills.agent')}</strong></span></div>
      <VscSelect value={agent} onChange={setAgent} aria-label={t('skills.agent')}>
        {agents.map((item) => <vscode-option key={item.id} value={item.id}>{item.label || item.id}</vscode-option>)}
      </VscSelect>
    </div>
    <div class="settings-control-row">
      <div class="settings-control-copy"><span><strong>{t('skills.scope')}</strong></span></div>
      <VscSelect value={scope} onChange={setScope} aria-label={t('skills.scope')}>
        <vscode-option value="user">{t('skills.scopeUser')}</vscode-option>
        <vscode-option value="workspace">{t('skills.scopeWorkspace')}</vscode-option>
      </VscSelect>
    </div>
    {isAdmin.value && scope === 'user' && users.length > 0 && (
      <div class="settings-control-row">
        <div class="settings-control-copy"><span><strong>{t('skills.forUser')}</strong></span></div>
        <VscSelect value={target} onChange={setTarget} aria-label={t('skills.forUser')}>
          <vscode-option value="">{t('skills.self')}</vscode-option>
          {users.map((user) => <vscode-option key={user.id} value={user.id}>{user.username}</vscode-option>)}
        </VscSelect>
      </div>
    )}
    <div class="settings-control-row">
      <TField class="skill-repo-input" value={repo} placeholder={t('skills.repoPlaceholder')} onInput={(event) => setRepo(event.currentTarget.value)} onKeyDown={(event) => { if (event.key === 'Enter') install() }} />
      <vscode-button icon="cloud-download" disabled={!agent || !repo.trim() || installing} onClick={install}>{installing ? t('skills.installing') : t('skills.install')}</vscode-button>
    </div>
    {error && <span class="error-text" role="alert">{error}</span>}
    {notice && <span class="skill-notice">{notice}</span>}
    <div class="skill-list">
      {busy && <span class="muted">{t('tree.loading')}</span>}
      {!busy && !skills.length && <span class="muted">{t('skills.empty')}</span>}
      {skills.map((skill) => (
        <div class="skill-row" key={skill.name}>
          <span class="skill-name"><strong>{skill.name}</strong>{skill.description && <small>{skill.description}</small>}</span>
          <button class="tw-icon-button" type="button" title={t('skills.remove')} aria-label={t('skills.remove')} onClick={() => remove(skill.name)}><Trash2 size={13} /></button>
        </div>
      ))}
    </div>
  </div>
}
