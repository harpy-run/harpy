import { useCallback, useEffect, useRef, useState } from 'preact/hooks'
import { ws } from '../lib/ws.js'
import { t } from '../lib/i18n.js'
import { activeView, isAdmin, mobileTab, panelOpen, setAgentRail, workspace } from '../state/app.js'
import { TInput } from './Fields.jsx'
import { VscSelect } from './vsc.jsx'

// Full-area OpenRig dashboard rendered in the editor tab strip. Data comes
// from the `rig` channel; the poll interval is user-controlled and pausable,
// so an idle dashboard can be frozen at zero rig invocations.
const INTERVALS = [0, 3000, 5000, 10000]

function seatTone(seat) {
  if (seat.attention || seat.activity === 'needs_input') return 'attention'
  if (seat.activity === 'running' || seat.sessionStatus === 'running') return 'running'
  return 'idle'
}

export function FleetView() {
  const [available, setAvailable] = useState(null)
  const [rigs, setRigs] = useState([])
  const [selected, setSelected] = useState('')
  const [seats, setSeats] = useState([])
  const [intervalMs, setIntervalMs] = useState(5000)
  const [detail, setDetail] = useState('') // seat session name shown in the bottom pane
  const [detailOutput, setDetailOutput] = useState('')
  const [sendText, setSendText] = useState('')
  const [sendBusy, setSendBusy] = useState(false)
  const [bootName, setBootName] = useState('')
  const [booting, setBooting] = useState(false)
  const [downing, setDowning] = useState('')
  const [bootMsg, setBootMsg] = useState(null)
  const [specs, setSpecs] = useState([])
  const [error, setError] = useState('')
  const selectedRef = useRef('')
  selectedRef.current = selected
  const detailRef = useRef('')
  detailRef.current = detail

  const loadOverview = useCallback(async () => {
    try {
      const data = await ws.request('rig', 'overview')
      setAvailable(!!data?.available)
      const list = Array.isArray(data?.rigs) ? data.rigs : []
      setRigs(list)
      setSelected((current) => (list.some((rig) => rig.name === current) ? current : (list[0]?.name || '')))
      setError('')
    } catch (requestError) { setError(requestError.message) }
  }, [])

  const loadSeats = useCallback(async (rigName) => {
    if (!rigName) { setSeats([]); return }
    try {
      const list = await ws.request('rig', 'seats', { rig: rigName })
      setSeats(Array.isArray(list) ? list : [])
    } catch { /* keep the previous seat list on a failed probe */ }
  }, [])

  const loadDetail = useCallback(async (session) => {
    if (!session) { setDetailOutput(''); return }
    try {
      const { output } = await ws.request('rig', 'capture', { session, lines: 120 })
      setDetailOutput(output || '')
    } catch { setDetailOutput('') }
  }, [])

  useEffect(() => { void loadOverview() }, [loadOverview])
  useEffect(() => { void loadSeats(selected) }, [selected, loadSeats])
  useEffect(() => { void loadDetail(detail) }, [detail, loadDetail])

  useEffect(() => {
    if (!intervalMs) return undefined
    const timer = setInterval(() => {
      void loadOverview()
      void loadSeats(selectedRef.current)
      if (detailRef.current) void loadDetail(detailRef.current)
    }, intervalMs)
    return () => clearInterval(timer)
  }, [intervalMs, loadOverview, loadSeats, loadDetail])

  // Same visible-terminal install flow as the Extensions card: the one-line
  // installer runs in a pty the user watches, and availability re-probes when
  // the finish marker scrolls by.
  async function installNow() {
    if (installing) return
    setInstalling(true)
    try {
      const { id: ptyId } = await ws.request('pty', 'create', { cols: 100, rows: 30, workspace: workspace.value?.path || '', command: 'npm install -g @openrig/cli; echo "[harpy] install finished"' })
      panelOpen.value = true
      let tail = ''
      const unsubscribe = ws.on('pty', 'data', (event) => {
        if (event.id !== ptyId) return
        tail = (tail + String(event.data || '')).slice(-500)
        if (!tail.includes('install finished')) return
        unsubscribe()
        setInstalling(false)
        void loadOverview()
      })
    } catch { setInstalling(false) }
  }

  if (available === null) {
    return <div class="fleet-view"><div class="fleet-empty"><vscode-progress-ring /></div></div>
  }

  if (available === false) {
    return <div class="fleet-view"><div class="fleet-empty">
      <strong>{t('fleet.notInstalled')}</strong>
      <p>{t('fleet.installHint')}</p>
      {isAdmin.value && <vscode-button icon="cloud-download" disabled={installing ? true : undefined} onClick={installNow}>{installing ? t('extensions.installing') : t('extensions.install')}</vscode-button>}
    </div></div>
  }

  async function attachSeat(session) {
    try {
      await ws.request('rig', 'attach', { session, cols: 120, rows: 34, workspace: workspace.value?.path || '' })
      panelOpen.value = true
    } catch (requestError) { setError(requestError.message) }
  }

  async function sendSeat(session) {
    const text = sendText.trim()
    if (!text || sendBusy) return
    setSendBusy(true)
    try {
      await ws.request('rig', 'send', { session, text })
      setSendText('')
    } catch (requestError) { setError(requestError.message) }
    finally { setSendBusy(false) }
  }

  async function bootRig() {
    const name = bootName.trim()
    if (!name || booting) return
    setBooting(true)
    setBootMsg(null)
    try {
      const result = await ws.request('rig', 'boot', { rig: name, workspace: workspace.value?.path || '', existing: rigs.some((entry) => entry.name === name) })
      const bits = [result.status]
      if (result.attention) bits.push(t('fleet.attention', { count: result.attention }))
      if (result.failed) bits.push(`${result.failed} ✕`)
      setBootMsg({ kind: 'ok', text: `${result.rig}: ${bits.join(' · ')}` })
      setBootName('')
      void loadOverview()
      void loadSeats(name)
    } catch (requestError) {
      // The server keeps booting past the socket ceiling — the poll picks the
      // rig up when it appears.
      const timedOut = /timed out/i.test(requestError.message || '')
      setBootMsg(timedOut ? { kind: 'ok', text: t('fleet.bootSlow') } : { kind: 'error', text: requestError.message })
    } finally { setBooting(false) }
  }

  async function downRig(rigName) {
    if (downing) return
    setDowning(rigName)
    try {
      const result = await ws.request('rig', 'down', { rig: rigName })
      setBootMsg({ kind: 'ok', text: `${result.rig}: ${result.alreadyStopped ? t('fleet.alreadyStopped') : t('fleet.stopped')}` })
      void loadOverview()
      if (selected === rigName) void loadSeats(rigName)
    } catch (requestError) { setError(requestError.message) }
    finally { setDowning('') }
  }

  function loadSpecs() {
    if (specs.length) return
    ws.request('rig', 'specs').then((list) => setSpecs(Array.isArray(list) ? list : [])).catch(() => {})
  }

  async function openTui() {
    try {
      await ws.request('agent', 'start', { agent: 'openrig', workspace: workspace.value?.path || '', cols: 120, rows: 34 })
      setAgentRail(true)
      mobileTab.value = 'agent'
      activeView.value = 'agent'
    } catch { /* the agent panel surfaces session errors itself */ }
  }

  const rig = rigs.find((entry) => entry.name === selected)
  const totalSeats = rigs.reduce((sum, entry) => sum + (entry.nodeCount || 0), 0)
  const attention = rigs.reduce((sum, entry) => sum + (entry.attentionCount || 0), 0)
  const detailSeat = seats.find((seat) => seat.name === detail)

  return (
    <div class="fleet-view">
      <div class="fleet-head">
        <div class="fleet-title">
          <strong>{t('fleet.title')}</strong>
          <span>{rigs.length ? t('rig.title', { count: rigs.length, seats: totalSeats }) : t('rig.empty')}{attention > 0 ? ` · ${t('fleet.attention', { count: attention })}` : ''}</span>
        </div>
        <div class="fleet-controls">
          <VscSelect class="fleet-poll" value={String(intervalMs)} onChange={(value) => setIntervalMs(Number(value))} aria-label={t('fleet.poll')}>
            <vscode-option value="0">{t('fleet.paused')}</vscode-option>
            <vscode-option value="3000">3s</vscode-option>
            <vscode-option value="5000">5s</vscode-option>
            <vscode-option value="10000">10s</vscode-option>
          </VscSelect>
          <vscode-toolbar-button icon="refresh" title={t('fleet.refresh')} aria-label={t('fleet.refresh')} onClick={() => { void loadOverview(); void loadSeats(selected); if (detail) void loadDetail(detail) }}></vscode-toolbar-button>
          {isAdmin.value && <vscode-button secondary icon="debug-start" onClick={openTui}>{t('fleet.dashboard')}</vscode-button>}
        </div>
      </div>
      {error && <div class="error-text fleet-error">{error}</div>}
      <div class="fleet-rigs">
        {rigs.map((entry) => (
          <div class={`fleet-chip ${entry.name === selected ? 'active' : ''}`} key={entry.rigId || entry.name}>
            <button type="button" class="fleet-chip-main" onClick={() => setSelected(entry.name)}>
              <i class={`rig-dot rig-dot-${entry.status === 'running' ? 'running' : 'idle'}`} />
              <strong>{entry.name}</strong>
              <span>{t('rig.seatSummary', { running: entry.runningCount, total: entry.nodeCount })}{entry.uptime ? ` · ${entry.uptime}` : ''}</span>
            </button>
            {entry.attentionCount > 0 && <vscode-badge>{entry.attentionCount}</vscode-badge>}
            {isAdmin.value && <vscode-toolbar-button icon={downing === entry.name ? 'loading' : 'debug-stop'} class={downing === entry.name ? 'spin' : ''} title={t('rig.down')} aria-label={t('rig.down')} disabled={!!downing} onClick={() => downRig(entry.name)}></vscode-toolbar-button>}
          </div>
        ))}
        {isAdmin.value && <div class="fleet-boot">
          <TInput type="text" list="fleet-specs" value={bootName} placeholder={t('rig.bootPlaceholder')} onFocus={loadSpecs} onInput={(event) => setBootName(event.currentTarget.value)} onKeyDown={(event) => { if (event.key === 'Enter') bootRig() }} />
          <datalist id="fleet-specs">{specs.map((spec) => <option value={spec.name} key={spec.name}>{spec.description || spec.name}</option>)}</datalist>
          <vscode-button icon={booting ? 'loading' : 'debug-start'} class={booting ? 'spin' : ''} disabled={!bootName.trim() || booting} onClick={bootRig}>{booting ? t('fleet.booting') : t('rig.boot')}</vscode-button>
        </div>}
        {bootMsg && <div class={`fleet-boot-msg ${bootMsg.kind}`}>{bootMsg.text}</div>}
      </div>
      {rigs.length === 0 && <div class="fleet-empty"><strong>{t('rig.empty')}</strong><p>{t('fleet.emptyHint')}</p></div>}
      {rig && <div class="fleet-grid">
        {seats.map((seat) => {
          const tone = seatTone(seat)
          return <div class="fleet-seat" key={seat.name}>
            <div class="fleet-seat-head">
              <i class={`rig-dot rig-dot-${tone}`} title={seat.activityReason || seat.activity || seat.sessionStatus || ''} />
              <strong title={seat.name}>{seat.logicalId || seat.name}</strong>
              <span class="fleet-seat-sub">{[seat.runtime, seat.model].filter(Boolean).join(' · ')}</span>
            </div>
            <div class="fleet-ctx" title={t('rig.context')}>
              <div class="fleet-ctx-bar"><span class={`fleet-ctx-fill fleet-ctx-${seat.contextState || 'low'}`} style={seat.contextUsed != null ? { width: `${Math.min(100, Math.round(seat.contextUsed))}%` } : { width: 0 }} /></div>
              <code>{seat.contextUsed != null ? `${Math.round(seat.contextUsed)}%` : '—'}</code>
            </div>
            <div class="fleet-stats">
              {seat.sessionStatus && <span>{seat.sessionStatus}</span>}
              {seat.uptime && <span>{seat.uptime}</span>}
              {seat.pendingWork > 0 && <span class="rig-pending">{t('rig.pending', { count: seat.assignedWork || seat.pendingWork })}</span>}
            </div>
            {seat.latestError && <div class="rig-seat-error">{seat.latestError}</div>}
            <div class="fleet-seat-actions">
              <vscode-button secondary icon="terminal" disabled={!isAdmin.value || !seat.name} onClick={() => attachSeat(seat.name)}>{t('rig.attach')}</vscode-button>
              <vscode-button secondary icon="eye" disabled={!seat.name} onClick={() => setDetail(detail === seat.name ? '' : seat.name)}>{t('rig.peek')}</vscode-button>
              <vscode-button secondary icon="send" disabled={!isAdmin.value || !seat.name} onClick={() => { setDetail(seat.name); setSendText('') }}>{t('rig.send')}</vscode-button>
            </div>
          </div>
        })}
        {seats.length === 0 && <div class="fleet-empty fleet-empty-inline"><span>{t('rig.noSeats')}</span></div>}
      </div>}
      {detailSeat && <div class="fleet-detail">
        <div class="fleet-detail-head">
          <strong>{detailSeat.logicalId || detailSeat.name}</strong>
          <span>{detailSeat.activityReason || detailSeat.activity || detailSeat.sessionStatus || ''}</span>
          <vscode-toolbar-button icon="close" title={t('editor.closeTab')} aria-label={t('editor.closeTab')} onClick={() => { setDetail(''); setDetailOutput('') }}></vscode-toolbar-button>
        </div>
        {detailOutput ? <pre class="fleet-detail-output">{detailOutput}</pre> : <div class="fleet-detail-loading"><vscode-progress-ring /></div>}
        {isAdmin.value && <div class="rig-send-row">
          <TInput type="text" value={sendText} placeholder={t('rig.sendPlaceholder')} onInput={(event) => setSendText(event.currentTarget.value)} onKeyDown={(event) => { if (event.key === 'Enter') sendSeat(detailSeat.name) }} />
          <vscode-button icon="send" disabled={!sendText.trim() || sendBusy} onClick={() => sendSeat(detailSeat.name)}>{t('rig.send')}</vscode-button>
        </div>}
      </div>}
    </div>
  )
}
