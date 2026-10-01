import { useEffect, useState } from 'preact/hooks'
import { Clock, Copy, FileCode, Pencil, Play, Plus, Radio, Trash2, Webhook, Workflow, X } from '../lib/icons.jsx'
import { ws } from '../lib/ws.js'
import { t } from '../lib/i18n.js'
import { isAdmin, workspace } from '../state/app.js'
import { VscSelect } from './vsc.jsx'
import { TField } from './Fields.jsx'

const triggerIcons = { fs: FileCode, cron: Clock, webhook: Webhook, 'session-end': Radio }

function ago(ts) {
  const seconds = Math.max(0, Math.floor((Date.now() - Number(ts || 0)) / 1000))
  if (seconds < 45) return t('activity.now')
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`
  return new Date(ts).toLocaleDateString()
}

// Settings section for automations — definitions live under
// $HARPY_HOME/automations/ (kept out of the workspace on purpose: the
// `gate:` field is a shell command, so workspace-writable definitions were
// a code-exec path). This view is list + form + actions.
export function AutomationsPanel() {
  const [items, setItems] = useState(null)
  const [error, setError] = useState('')
  const [editing, setEditing] = useState(null) // list item, or {} for new
  const [copied, setCopied] = useState('')

  const wsPath = () => workspace.value?.path || ''

  async function refresh() {
    try {
      setError('')
      setItems(await ws.request('automation', 'list', { workspace: wsPath() }) || [])
    } catch (err) {
      setError(err?.message || String(err))
    }
  }

  useEffect(() => {
    refresh()
    const offChanged = ws.on('automation', 'changed', refresh)
    const onWorkspace = () => { setItems(null); refresh() }
    window.addEventListener('harpy:workspace-change', onWorkspace)
    window.addEventListener('harpy:ws-open', refresh)
    return () => {
      offChanged()
      window.removeEventListener('harpy:workspace-change', onWorkspace)
      window.removeEventListener('harpy:ws-open', refresh)
    }
  }, [])

  async function toggle(item) {
    try { await ws.request('automation', 'toggle', { workspace: wsPath(), slug: item.slug, enabled: !item.enabled }) }
    catch (err) { setError(err?.message || String(err)) }
    refresh()
  }

  async function runNow(item) {
    try { await ws.request('automation', 'runNow', { workspace: wsPath(), slug: item.slug }) }
    catch (err) { setError(err?.message || String(err)) }
    refresh()
  }

  async function remove(item) {
    if (!window.confirm(t('automation.removeConfirm', { name: item.name }))) return
    try { await ws.request('automation', 'remove', { workspace: wsPath(), slug: item.slug }) }
    catch (err) { setError(err?.message || String(err)) }
    refresh()
  }

  function copy(value, key) {
    navigator.clipboard?.writeText(value)
    setCopied(key)
    setTimeout(() => setCopied(''), 1500)
  }

  return <div class="settings-card automation-card">
    <div class="settings-control-row automation-head">
      <div class="settings-control-copy">
        <Workflow size={16} />
        <span><strong>{t('automation.count', { count: items?.length ?? 0 })}</strong>
          <small>{t('automation.hint')}</small></span>
      </div>
      {isAdmin.value && <vscode-button secondary onClick={() => setEditing({})}><Plus size={13} />{t('automation.new')}</vscode-button>}
    </div>
    {error && <div class="settings-control-row"><small class="error-text">{error}</small></div>}
    {items === null && <div class="settings-control-row"><small class="muted">{t('automation.loading')}</small></div>}
    {items?.length === 0 && <div class="settings-control-row"><small class="muted">{t('automation.empty')}</small></div>}
    {items?.map((item) => {
      const TriggerIcon = triggerIcons[item.on] || FileCode
      const last = item.lastRun
      return <div class="settings-control-row automation-row" key={item.slug}>
        <div class="settings-control-copy">
          <TriggerIcon size={16} />
          <span>
            <strong>{item.name}{item.running && <em class="automation-running">{t('automation.running')}</em>}</strong>
            <small>
              {t(`automation.when.${item.on === 'session-end' ? 'sessionEnd' : item.on}`)}{item.agent ? ` · ${item.agent}` : ''}
              {last && ` · ${t(`automation.status.${last.status}`)} ${ago(last.ts)}`}
              {item.webhookPath && (
                <span class="automation-hook">
                  <code>{item.webhookPath}</code>
                  <button class="tw-icon-button" type="button" title={t('share.copy')} aria-label={t('share.copy')} onClick={() => copy(`${location.origin}${item.webhookPath} · secret ${item.webhookSecret}`, item.slug)}>
                    <Copy size={11} />
                  </button>
                  {copied === item.slug && <span class="muted">{t('share.copied')}</span>}
                </span>
              )}
            </small>
          </span>
        </div>
        {isAdmin.value && <div class="automation-actions">
          <vscode-button secondary onClick={() => toggle(item)}>{item.enabled ? t('settings.on') : t('settings.off')}</vscode-button>
          <button class="tw-icon-button" type="button" title={t('automation.runNow')} aria-label={t('automation.runNow')} onClick={() => runNow(item)}><Play size={13} /></button>
          <button class="tw-icon-button" type="button" title={t('automation.edit')} aria-label={t('automation.edit')} onClick={() => setEditing(item)}><Pencil size={13} /></button>
          <button class="tw-icon-button" type="button" title={t('automation.delete')} aria-label={t('automation.delete')} onClick={() => remove(item)}><Trash2 size={13} /></button>
        </div>}
      </div>
    })}
    {editing && <AutomationEditor item={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); refresh() }} wsPath={wsPath} />}
  </div>
}

// The friendly form writes the .md file — the user answers questions, the
// frontmatter is generated for them. Raw markdown stays editable on disk.
const SCHEDULE_PRESETS = [
  { value: 'every 15m', key: '15m' },
  { value: 'every 1h', key: '1h' },
  { value: 'every 6h', key: '6h' },
  { value: '0 3 * * *', key: 'daily' },
  { value: '0 3 * * 1', key: 'weekly' },
  { value: 'custom', key: 'custom' }
]

const PATH_PRESETS = [
  { value: 'src/**', key: 'src' },
  { value: '**/*.js', key: 'js' },
  { value: '**/*.ts', key: 'ts' },
  { value: 'docs/**', key: 'docs' },
  { value: 'package.json', key: 'pkg' },
  { value: '**/*', key: 'all' }
]

const GATE_PRESETS = [
  { value: '', key: 'always' },
  { value: 'npx eslint --quiet', key: 'lint' },
  { value: 'npm test --silent', key: 'tests' },
  { value: 'git diff --quiet && git diff --cached --quiet', key: 'dirty' },
  { value: 'npm outdated --json | grep -q .', key: 'deps' },
  { value: 'custom', key: 'custom' }
]

const COOLDOWN_PRESETS = [
  { value: 60, key: '1m' },
  { value: 300, key: '5m' },
  { value: 900, key: '15m' },
  { value: 3600, key: '1h' }
]

function slugify(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
}

function toMarkdown(form) {
  const lines = ['---', `name: ${form.name}`, `on: ${form.on}`]
  if (form.on === 'fs' && form.paths.length) {
    lines.push(`paths: [${form.paths.map((p) => JSON.stringify(p)).join(', ')}]`)
  }
  if (form.on === 'cron' && form.schedule) lines.push(`schedule: ${JSON.stringify(form.schedule)}`)
  if (form.on === 'session-end' && form.agentFilter) lines.push(`agentFilter: ${form.agentFilter}`)
  if (form.gate) lines.push(`gate: ${JSON.stringify(form.gate)}`)
  lines.push(`agent: ${form.agent}`)
  if (form.isolated) lines.push('isolated: true')
  if (Number(form.cooldown) > 0) lines.push(`cooldown: ${Number(form.cooldown)}`)
  lines.push('---', '', form.task || '')
  return lines.join('\n')
}

function AutomationEditor({ item, onClose, onSaved, wsPath }) {
  const isNew = !item.slug
  const customSchedule = item.schedule && !SCHEDULE_PRESETS.some((p) => p.value === item.schedule)
  const customGate = item.gate && !GATE_PRESETS.some((p) => p.value === item.gate)
  const [form, setForm] = useState({
    name: item.name || '',
    on: item.on || 'fs',
    paths: item.paths || [],
    schedule: customSchedule ? 'custom' : (item.schedule || 'every 1h'),
    scheduleCustom: customSchedule ? item.schedule : '',
    agentFilter: item.agentFilter || '',
    gate: customGate ? 'custom' : (item.gate || ''),
    gateCustom: customGate ? item.gate : '',
    agent: item.agent || 'claude',
    isolated: !!item.isolated,
    cooldown: item.cooldown ?? 300,
    task: item.task || ''
  })
  const [agents, setAgents] = useState([])
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const setText = (key) => (event) => setForm((f) => ({ ...f, [key]: event.currentTarget.value }))
  const patch = (key, value) => setForm((f) => ({ ...f, [key]: value }))
  const togglePath = (value) => setForm((f) => ({
    ...f,
    paths: f.paths.includes(value) ? f.paths.filter((p) => p !== value) : [...f.paths, value]
  }))

  useEffect(() => {
    ws.request('agent', 'agents').then((list) => setAgents(list || [])).catch(() => {})
  }, [])

  async function save() {
    const slug = isNew ? slugify(form.name) : item.slug
    if (!slug) return setError(t('automation.slugError'))
    if (form.on === 'fs' && !form.paths.length) return setError(t('automation.pathsError'))
    if (!form.task.trim()) return setError(t('automation.taskError'))
    setSaving(true)
    setError('')
    try {
      const schedule = form.schedule === 'custom' ? form.scheduleCustom.trim() : form.schedule
      const gate = form.gate === 'custom' ? form.gateCustom.trim() : form.gate
      const content = toMarkdown({ ...form, schedule, gate })
      await ws.request('automation', 'save', { workspace: wsPath(), slug, content })
      onSaved()
    } catch (err) {
      setError(err?.message || String(err))
      setSaving(false)
    }
  }

  // The built-in `harpy` shell is an interactive REPL — an automation run
  // would spawn it and never exit, so it stays out of the picker.
  const agentOptions = agents.length ? agents.filter((agent) => agent.id !== 'harpy') : [{ id: 'claude' }, { id: 'codex' }, { id: 'devin' }, { id: 'gemini' }, { id: 'qwen' }, { id: 'opencode' }, { id: 'grok' }]
  const triggers = [
    { value: 'fs', icon: FileCode, label: t('automation.when.fs'), hint: t('automation.whenHint.fs') },
    { value: 'cron', icon: Clock, label: t('automation.when.cron'), hint: t('automation.whenHint.cron') },
    { value: 'webhook', icon: Webhook, label: t('automation.when.webhook'), hint: t('automation.whenHint.webhook') },
    { value: 'session-end', icon: Radio, label: t('automation.when.sessionEnd'), hint: t('automation.whenHint.sessionEnd') }
  ]

  return <div class="modal-backdrop automation-backdrop" role="presentation" onClick={(event) => { if (event.target === event.currentTarget) onClose() }}>
    <section class="automation-modal" role="dialog" aria-modal="true" aria-labelledby="automation-modal-title">
      <div class="share-modal-heading">
        <strong id="automation-modal-title"><Workflow size={15} />{isNew ? t('automation.newTitle') : t('automation.editTitle', { name: item.name })}</strong>
        <button class="tw-icon-button" type="button" title={t('common.cancel')} aria-label={t('common.cancel')} onClick={onClose}><X size={14} /></button>
      </div>
      <vscode-scrollable class="automation-modal-body">
        <label class="automation-field">
          <span>{t('automation.form.name')}</span>
          <TField value={form.name} onInput={setText('name')} placeholder="lint-watch" disabled={!isNew} />
        </label>

        <div class="automation-field">
          <span>{t('automation.form.when')}</span>
          <div class="automation-options" role="radiogroup">
            {triggers.map((opt) => {
              const Icon = opt.icon
              return <button key={opt.value} type="button" role="radio" aria-checked={form.on === opt.value}
                class={`automation-opt ${form.on === opt.value ? 'active' : ''}`} onClick={() => patch('on', opt.value)}>
                <Icon size={15} />
                <span><strong>{opt.label}</strong><small>{opt.hint}</small></span>
              </button>
            })}
          </div>
        </div>

        {form.on === 'fs' && (
          <div class="automation-field">
            <span>{t('automation.form.paths')}</span>
            <div class="automation-chips">
              {PATH_PRESETS.map((p) => (
                <button key={p.value} type="button" class={`automation-chip ${form.paths.includes(p.value) ? 'active' : ''}`}
                  onClick={() => togglePath(p.value)}>{t(`automation.paths.${p.key}`)}</button>
              ))}
            </div>
            <small class="muted">{t('automation.form.pathsHint')}</small>
          </div>
        )}

        {form.on === 'cron' && (
          <div class="automation-field">
            <span>{t('automation.form.schedule')}</span>
            <div class="automation-chips">
              {SCHEDULE_PRESETS.map((p) => (
                <button key={p.value} type="button" class={`automation-chip ${form.schedule === p.value ? 'active' : ''}`}
                  onClick={() => patch('schedule', p.value)}>{t(`automation.schedule.${p.key}`)}</button>
              ))}
            </div>
            {form.schedule === 'custom' && <TField value={form.scheduleCustom} onInput={setText('scheduleCustom')} placeholder="*/10 * * * *" />}
          </div>
        )}

        {form.on === 'webhook' && <small class="muted automation-note">{t('automation.form.webhookHint')}</small>}

        {form.on === 'session-end' && (
          <div class="automation-field">
            <span>{t('automation.form.onlyAgent')}</span>
            <div class="automation-chips">
              <button type="button" class={`automation-chip ${!form.agentFilter ? 'active' : ''}`} onClick={() => patch('agentFilter', '')}>{t('automation.form.anyAgent')}</button>
              {agentOptions.map((a) => (
                <button key={a.id} type="button" class={`automation-chip ${form.agentFilter === a.id ? 'active' : ''}`}
                  onClick={() => patch('agentFilter', a.id)}>{a.label || a.id}</button>
              ))}
            </div>
          </div>
        )}

        <div class="automation-field">
          <span>{t('automation.form.gate')}</span>
          <div class="automation-chips">
            {GATE_PRESETS.map((p) => (
              <button key={p.key} type="button" class={`automation-chip ${form.gate === p.value ? 'active' : ''}`}
                onClick={() => patch('gate', p.value)}>{t(`automation.gate.${p.key}`)}</button>
            ))}
          </div>
          {form.gate === 'custom' && <TField value={form.gateCustom} onInput={setText('gateCustom')} placeholder="npm test" />}
          <small class="muted">{t('automation.form.gateHint')}</small>
        </div>

        <div class="automation-field">
          <span>{t('automation.form.agent')}</span>
          <div class="automation-chips">
            {agentOptions.map((a) => (
              <button key={a.id} type="button" disabled={a.available === false}
                class={`automation-chip ${form.agent === a.id ? 'active' : ''}`}
                onClick={() => patch('agent', a.id)}>{a.label || a.id}</button>
            ))}
          </div>
        </div>

        <label class="automation-field">
          <span>{t('automation.form.task')}</span>
          <textarea class="automation-editor automation-task" value={form.task} onInput={setText('task')} spellcheck={false} rows={3} placeholder={t('automation.form.taskPlaceholder')} />
        </label>

        <div class="automation-field">
          <span>{t('automation.form.safety')}</span>
          <div class="automation-chips">
            <button type="button" class={`automation-chip ${form.isolated ? 'active' : ''}`}
              onClick={() => patch('isolated', !form.isolated)}>{t('automation.form.isolated')}</button>
            {COOLDOWN_PRESETS.map((c) => (
              <button key={c.value} type="button" class={`automation-chip ${Number(form.cooldown) === c.value ? 'active' : ''}`}
                onClick={() => patch('cooldown', c.value)}>{t(`automation.cooldown.${c.key}`)}</button>
            ))}
          </div>
          <small class="muted">{t('automation.form.safetyHint')}</small>
        </div>

        {error && <small class="error-text">{error}</small>}
      </vscode-scrollable>
      <div class="share-modal-actions">
        <vscode-button secondary onClick={onClose}>{t('common.cancel')}</vscode-button>
        <vscode-button onClick={save} disabled={saving}>{saving ? t('automation.saving') : t('automation.save')}</vscode-button>
      </div>
    </section>
  </div>
}
