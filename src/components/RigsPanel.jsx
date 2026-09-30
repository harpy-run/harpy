import { useCallback, useEffect, useRef, useState } from 'preact/hooks'
import { ChevronDown, ChevronUp } from '../lib/icons.jsx'
import { ws } from '../lib/ws.js'
import { t } from '../lib/i18n.js'
import { isAdmin, openFleet, panelOpen, workspace } from '../state/app.js'
import { TInput } from './Fields.jsx'

// OpenRig fleet strip inside the agent panel. All data comes from the `rig`
// channel (exec'd `rig ... --json` calls) — polling only runs while the
// section is expanded, so a closed panel costs zero rig invocations.
const POLL_OPEN_MS = 4_000
const POLL_CLOSED_MS = 20_000

function seatTone(seat) {
  if (seat.attention || seat.activity === 'needs_input') return 'attention'
  if (seat.activity === 'running' || seat.sessionStatus === 'running') return 'running'
  return 'idle'
}

export function RigsPanel() {
  const [available, setAvailable] = useState(null)
  const [rigs, setRigs] = useState([])
  const [open, setOpen] = useState(false)
  const [seats, setSeats] = useState({})
  const [openRigs, setOpenRigs] = useState({})
  const [peek, setPeek] = useState({})
  const [sendTo, setSendTo] = useState('')
  const [sendText, setSendText] = useState('')
  const [sendBusy, setSendBusy] = useState(false)
  const [bootName, setBootName] = useState('')
  const [booting, setBooting] = useState(false)
  const [specs, setSpecs] = useState([])
  const [error, setError] = useState('')
  const openRigsRef = useRef({})
  openRigsRef.current = openRigs
  const openRef = useRef(false)
  openRef.current = open

  const loadSeats = useCallback(async (rigName) => {
    try {
      const list = await ws.request('rig', 'seats', { rig: rigName })
      setSeats((current) => ({ ...current, [rigName]: Array.isArray(list) ? list : [] }))
    } catch { /* seat list is best-effort; the rig row still renders */ }
  }, [])

  const load = useCallback(async () => {
    try {
      const data = await ws.request('rig', 'overview')
      setAvailable(!!data?.available)
      setRigs(Array.isArray(data?.rigs) ? data.rigs : [])
      setError('')
      for (const rigName of Object.keys(openRigsRef.current)) {
        if (openRigsRef.current[rigName]) void loadSeats(rigName)
      }
    } catch (requestError) {
      setError(requestError.message)
    }
  }, [loadSeats])

  useEffect(() => {
    void load()
    const tick = () => { void load() }
    // Both intervals stay cheap: closed state is one `rig ps --json` every
    // 20s; open adds a --nodes call per expanded rig every 4s.
    const timer = setInterval(() => tick(), openRef.current ? POLL_OPEN_MS : POLL_CLOSED_MS)
    return () => clearInterval(timer)
  }, [load, open])

  if (available !== true) return null

  function toggleRig(rigName) {
    const next = !openRigs[rigName]
    setOpenRigs((current) => ({ ...current, [rigName]: next }))
    if (next) void loadSeats(rigName)
  }

  async function attachSeat(session) {
    try {
      await ws.request('rig', 'attach', { session, cols: 100, rows: 30, workspace: workspace.value?.path || '' })
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
      setSendTo('')
    } catch (requestError) { setError(requestError.message) }
    finally { setSendBusy(false) }
  }

  async function peekSeat(session) {
    if (peek[session]) { setPeek((current) => ({ ...current, [session]: '' })); return }
    try {
      const { output } = await ws.request('rig', 'capture', { session, lines: 40 })
      setPeek((current) => ({ ...current, [session]: output || '' }))
    } catch (requestError) { setError(requestError.message) }
  }

  async function bootRig() {
    const name = bootName.trim()
    if (!name || booting) return
    setBooting(true)
    try {
      await ws.request('rig', 'boot', { rig: name, workspace: workspace.value?.path || '', existing: rigs.some((entry) => entry.name === name) })
      setBootName('')
      await load()
    } catch (requestError) { setError(requestError.message) }
    finally { setBooting(false) }
  }

  async function downRig(rigName) {
    try {
      await ws.request('rig', 'down', { rig: rigName })
      await load()
    } catch (requestError) { setError(requestError.message) }
  }

  function loadSpecs() {
    if (specs.length) return
    ws.request('rig', 'specs').then((list) => setSpecs(Array.isArray(list) ? list : [])).catch(() => {})
  }

  const totalSeats = rigs.reduce((sum, rig) => sum + (rig.nodeCount || 0), 0)
  const attention = rigs.reduce((sum, rig) => sum + (rig.attentionCount || 0), 0)

  return (
    <div class="agent-presence rig-panel">
      <div class="rig-strip-head">
        <button class="agent-presence-toggle" type="button" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
          <i class={`agent-presence-dot ${attention ? 'rig-attention' : ''}`} />
          <span>{t('rig.title', { count: rigs.length, seats: totalSeats })}</span>
          {attention > 0 && <vscode-badge>{attention}</vscode-badge>}
          {open ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
        </button>
        <vscode-toolbar-button icon="screen-full" title={t('fleet.open')} aria-label={t('fleet.open')} onClick={openFleet}></vscode-toolbar-button>
      </div>
      {open && <div class="rig-body">
        {error && <div class="error-text rig-error">{error}</div>}
        {rigs.length === 0 && <span class="rig-empty">{t('rig.empty')}</span>}
        {rigs.map((rig) => (
          <div class="rig-rig" key={rig.rigId || rig.name}>
            <div class="rig-rig-head">
              <button class="agent-presence-main rig-rig-toggle" type="button" onClick={() => toggleRig(rig.name)} aria-expanded={!!openRigs[rig.name]}>
                <i class={`rig-dot rig-dot-${rig.status === 'running' ? 'running' : 'idle'}`} />
                <span class="agent-presence-copy"><strong>{rig.name}</strong><span>{t('rig.seatSummary', { running: rig.runningCount, total: rig.nodeCount })}{rig.uptime ? ` · ${rig.uptime}` : ''}</span></span>
                {rig.attentionCount > 0 && <vscode-badge>{rig.attentionCount}</vscode-badge>}
                {openRigs[rig.name] ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
              </button>
              {isAdmin.value && <vscode-toolbar-button icon="debug-stop" title={t('rig.down')} aria-label={t('rig.down')} onClick={() => downRig(rig.name)}></vscode-toolbar-button>}
            </div>
            {openRigs[rig.name] && <div class="rig-seats">
              {(seats[rig.name] || []).map((seat) => {
                const tone = seatTone(seat)
                return <div class="rig-seat" key={seat.name}>
                  <div class="rig-seat-row">
                    <i class={`rig-dot rig-dot-${tone}`} title={seat.activityReason || seat.activity || seat.sessionStatus || ''} />
                    <span class="rig-seat-name" title={seat.name}>{seat.logicalId || seat.name}</span>
                    <span class="rig-seat-meta">{[seat.runtime, seat.model, seat.sessionStatus].filter(Boolean).join(' · ')}</span>
                    {seat.contextUsed != null && <code class={`rig-ctx rig-ctx-${seat.contextState || 'low'}`} title={t('rig.context')}>{Math.round(seat.contextUsed)}%</code>}
                    {seat.pendingWork > 0 && <span class="rig-pending" title={t('rig.pending', { count: seat.assignedWork || seat.pendingWork })}>+{seat.pendingWork}</span>}
                    <span class="rig-seat-actions">
                      <vscode-toolbar-button icon="terminal" title={t('rig.attach')} aria-label={t('rig.attach')} disabled={!isAdmin.value || !seat.name} onClick={() => attachSeat(seat.name)}></vscode-toolbar-button>
                      <vscode-toolbar-button icon="eye" title={t('rig.peek')} aria-label={t('rig.peek')} onClick={() => peekSeat(seat.name)}></vscode-toolbar-button>
                      <vscode-toolbar-button icon="send" title={t('rig.send')} aria-label={t('rig.send')} disabled={!isAdmin.value} onClick={() => setSendTo(sendTo === seat.name ? '' : seat.name)}></vscode-toolbar-button>
                    </span>
                  </div>
                  {seat.latestError && <div class="rig-seat-error">{seat.latestError}</div>}
                  {sendTo === seat.name && <div class="rig-send-row">
                    <TInput type="text" value={sendText} placeholder={t('rig.sendPlaceholder')} onInput={(event) => setSendText(event.currentTarget.value)} onKeyDown={(event) => { if (event.key === 'Enter') sendSeat(seat.name) }} />
                    <vscode-button icon="send" disabled={!sendText.trim() || sendBusy} onClick={() => sendSeat(seat.name)}>{t('rig.send')}</vscode-button>
                  </div>}
                  {peek[seat.name] ? <pre class="rig-peek">{peek[seat.name]}</pre> : null}
                </div>
              })}
              {seats[rig.name] && seats[rig.name].length === 0 && <span class="rig-empty">{t('rig.noSeats')}</span>}
            </div>}
          </div>
        ))}
        {isAdmin.value && <div class="rig-boot-row">
          <TInput type="text" list="rig-specs" value={bootName} placeholder={t('rig.bootPlaceholder')} onFocus={loadSpecs} onInput={(event) => setBootName(event.currentTarget.value)} onKeyDown={(event) => { if (event.key === 'Enter') bootRig() }} />
          <datalist id="rig-specs">{specs.map((spec) => <option value={spec.name} key={spec.name}>{spec.description || spec.name}</option>)}</datalist>
          <vscode-button icon={booting ? 'loading' : 'debug-start'} class={booting ? 'spin' : ''} disabled={!bootName.trim() || booting} onClick={bootRig}>{t('rig.boot')}</vscode-button>
        </div>}
      </div>}
    </div>
  )
}
