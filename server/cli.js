#!/usr/bin/env node
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { ask, box, c, choose, closePrompts, confirm, isInteractive, canOpenBrowser } from './cli-ui.js'
import { cliConfigExists, readCliConfig, resolvePort, validPort, writeCliConfig } from './cli-config.js'
import { cliLang, envLang, LOCALES, noWords, translator, yesWords, ynHint } from './cli-i18n.js'

function usage() {
  console.log(`harpy
Usage: harpy <command>

Commands:
  (none)                                Interactive agent shell
  chat <prompt> [--agent ID] [--cwd P]  One-shot question, or open the shell
  dash                                  Status dashboard menu
  start [--port N] [--workspace PATH]  Start the server in the foreground
  daemon <command>                     Manage the background server
  settings [set <key> <value>]         View or change CLI settings
  share [status|enable <p> k=v|disable] Manage the public tunnel link
  update [--check] [--yes]             Update from npm or the git repo
  status                                Show server health
  version                               Print version`)
}

function lanIps() {
  return Object.values(os.networkInterfaces()).flatMap((items) => (items || [])
    .filter((item) => item.family === 'IPv4' && !item.internal)
    .map((item) => item.address))
}

function parseStartArgs(args) {
  const options = {}
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--port') {
      const value = args[++i]
      if (!value || value.startsWith('--')) throw new Error('--port requires a value')
      options.port = Number(value)
    } else if (args[i] === '--workspace') {
      const value = args[++i]
      if (!value || value.startsWith('--')) throw new Error('--workspace requires a value')
      options.workspace = value
    }
    else throw new Error(`unknown option: ${args[i]}`)
  }
  if (options.port !== undefined && !validPort(options.port)) throw new Error('invalid port')
  return options
}

function parseDaemonArgs(args) {
  const options = {}
  for (let i = 0; i < args.length; i += 1) {
    const value = args[i]
    if (value === '--port') {
      const next = args[++i]
      if (!next || next.startsWith('--')) throw new Error('--port requires a value')
      options.port = Number(next)
    } else if (value === '--workspace') {
      const next = args[++i]
      if (!next || next.startsWith('--')) throw new Error('--workspace requires a value')
      options.workspace = next
    } else if (value === '--mode') {
      const next = args[++i]
      if (!next || next.startsWith('--')) throw new Error('--mode requires a value')
      options.mode = next
    }
    else if (value === '--json') options.json = true
    else throw new Error(`unknown option: ${value}`)
  }
  if (options.port !== undefined && !validPort(options.port)) throw new Error('invalid port')
  if (options.mode && !['auto', 'system', 'user', 'desktop'].includes(options.mode)) throw new Error('invalid daemon mode')
  return options
}

async function printDaemonResult(result, json = false) {
  if (json) {
    console.log(JSON.stringify(result, null, 2))
    return
  }
  if (result.message) console.log(result.message)
  if (result.pid) console.log(`pid: ${result.pid}`)
  if (result.port) console.log(`port: ${result.port}`)
  if (result.listening && result.port) console.log(`local: http://localhost:${result.port}`)
  const share = (await import('./share.js')).shareStatus()
  if (share.url) console.log(`public: ${share.url} (${share.provider})`)
  if (result.logFile) console.log(`log: ${result.logFile}`)
  if (result.service) console.log(`autostart: ${result.service.enabled ? `enabled (${result.service.mode})` : 'disabled'}`)
}

// What is living on this port right now? Friendly wording for the three
// possible answers: our daemon, a harpy we do not manage, a foreign app.
async function describePort(port) {
  const { healthProbe } = await import('./daemon.js')
  const probe = await healthProbe(port)
  if (!probe.occupied) return { kind: 'free', probe }
  if (probe.harpy) return { kind: 'harpy', probe }
  return { kind: 'foreign', probe }
}

function openBrowser(url) {
  const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open'
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url]
  try { spawn(opener, args, { detached: true, stdio: 'ignore' }).unref() } catch { void 0 }
}

// "Open web UI" on a VPS has nowhere to open — always print the reachable
// URLs (local, LAN, public tunnel) and only launch a browser when the
// machine plausibly has one.
async function openWebUi(port) {
  const t = translator(cliLang())
  const { shareStatus } = await import('./share.js')
  const share = shareStatus()
  console.log(`  ${c.dim(t('rowLocal'))}    ${c.cyan(`http://localhost:${port}`)}`)
  for (const ip of lanIps()) console.log(`  ${c.dim(t('rowLan'))}      ${c.cyan(`http://${ip}:${port}`)}`)
  if (share.url) console.log(`  ${c.dim(t('rowPublic'))}   ${c.cyan(share.url)}`)
  if (canOpenBrowser()) openBrowser(`http://localhost:${port}`)
  else console.log(`  ${c.dim(t('homeOpenNoBrowser'))}`)
}

// --- interactive home -----------------------------------------------------

async function home() {
  const { daemonStatus, startDaemon, installAutostart, removeAutostart } = await import('./daemon.js')

  // First run: the wizard owns the screen — the language question comes
  // first and every following prompt renders in the picked language. It ends
  // by applying autostart + the background-daemon choice and printing the URL.
  if (isInteractive()) {
    if (!cliConfigExists()) {
      const merged = await firstRunWizard({})
      if (merged._wizard) {
        const t0 = translator(merged._lang)
        const cfg = readCliConfig()
        if (merged._autostart) installAutostart({ port: merged.port, workspace: cfg.workspace, mode: 'auto' })
        else removeAutostart()
        if (merged._background !== false) {
          console.log(`  ${c.dim(t0('startBg'))}`)
          const started = await startDaemon({ port: merged.port, workspace: cfg.workspace })
          console.log(`  ${started.listening ? c.ok('✓') : c.warn('!')} ${started.message}`)
          if (started.listening) console.log(`\n  ${c.cyan(`→ http://localhost:${merged.port}`)} ${c.dim(t0('linkNote'))}\n`)
        } else {
          console.log(`  ${c.dim(t0('startLater'))}\n`)
        }
      }
    } else if (!readCliConfig().lang) {
      // Existing installs from before the language pick — ask it once, alone.
      const lang = await askLanguage()
      if (lang) writeCliConfig({ lang })
    }
  }

  if (!isInteractive()) {
    await printDaemonResult(await daemonStatus({ port: resolvePort() }))
    return
  }

  // Bare `harpy` opens a launcher, not a bare prompt — Harpy Team is the
  // codex-style shell, Dashboard the classic status menu, and everything
  // loops back here so the product never strands the operator on a prompt.
  const t = translator(cliLang())
  for (;;) {
    const status = await daemonStatus({ port: resolvePort() })
    const action = await choose(t('homePick'), [
      { value: 'team', label: 'Harpy Team', hint: t('homeTeamHint') },
      { value: 'dash', label: t('homeDash'), hint: t('homeDashHint') },
      { value: 'open', label: t('homeOpen'), hint: status.listening ? `localhost:${status.port}` : t('hOpenDown') }
    ], { defaultValue: 'team' })
    if (action === null || action === 'back') break
    if (action === 'team') {
      const { chatShell } = await import('./cli-shell.js')
      await chatShell({})
    } else if (action === 'dash') {
      await dashboard()
    } else if (action === 'open') {
      if (status.listening) await openWebUi(status.port)
      else console.log(`  ${c.warn(t('msgNoListen'))}`)
    }
  }
  closePrompts()
}

// The menu-driven dashboard kept intact as `harpy dash`.
async function dashboard() {
  const { daemonStatus, stopDaemon, startDaemon, readDaemonLog } = await import('./daemon.js')
  const t = translator(cliLang())
  const settings = readCliConfig()
  const port = resolvePort()
  const status = await daemonStatus({ port })
  const label = (s) => s.padEnd(13)
  const rows = [
    `${label(t('rowStatus'))}${status.running ? c.ok(`● ${t('stRunning')}`) : c.dim(`○ ${t('stStopped')}`)}${status.pid ? c.dim(` · pid ${status.pid}`) : ''}`,
    `${label(t('rowPort'))}${status.port}`,
    `${label(t('rowAutostart'))}${status.service.enabled ? c.ok(`${t('stEnabled')} (${status.service.mode})`) : c.dim(t('stDisabled'))}`
  ]
  if (status.listening) {
    rows.push(`${label(t('rowLocal'))}${c.cyan(`http://localhost:${status.port}`)}`)
    for (const ip of lanIps()) rows.push(`${label(t('rowLan'))}${c.cyan(`http://${ip}:${status.port}`)}`)
  }
  const { shareStatus } = await import('./share.js')
  const share = shareStatus()
  if (share.url) rows.push(`${label(t('rowPublic'))}${c.cyan(share.url)} ${c.dim(`(${share.provider})`)}`)
  else if (share.enabled) rows.push(`${label(t('rowPublic'))}${c.warn(t('shareNotRunning', { provider: share.provider }))}`)
  if (!status.listening && status.running) rows.push(c.warn(t('warnNotListening')))
  box(`harpy ${c.accent('v' + status.version)}`, rows)
  console.log('')

  for (;;) {
    const action = await choose(t('menuNext'), [
      { value: 'start', label: status.running ? t('mRestart') : t('mStart') },
      { value: 'install', label: t('mAutostart'), hint: status.service.enabled ? t('hAutoOn') : t('hAutoOff') },
      { value: 'open', label: t('mOpen'), hint: status.listening ? `localhost:${status.port}` : t('hOpenDown') },
      { value: 'share', label: t('mShare'), hint: share.url || t('hShareOff') },
      { value: 'settings', label: t('mSettings'), hint: `${settings.port}${settings.workspace ? ` · ${settings.workspace}` : ''}` },
      { value: 'update', label: t('mUpdate') },
      { value: 'logs', label: t('mLogs'), hint: t('hLogs') },
      { value: 'stop', label: t('mStop') }
    ], { defaultValue: 'open' })

    if (action === null || action === 'back') break
    if (action === 'open') {
      if (status.listening) await openWebUi(status.port)
      else console.log(`  ${c.warn(t('msgNoListen'))}`)
    } else if (action === 'start') {
      if (status.running) await stopDaemon()
      const result = await startDaemon({ port: settings.port, workspace: settings.workspace })
      console.log(`  ${result.listening ? c.ok('✓') : c.warn('!')} ${result.message}`)
      Object.assign(status, result)
    } else if (action === 'stop') {
      await stopDaemon()
      console.log(`  ${c.ok('✓')} ${t('msgStopped')}`)
      break
    } else if (action === 'install') {
      await installFlow({})
      break
    } else if (action === 'settings') {
      await settingsFlow()
      break
    } else if (action === 'share') {
      await shareCommand([])
    } else if (action === 'update') {
      await updateFlow({})
    } else if (action === 'logs') {
      const output = readDaemonLog().trim().split('\n').slice(-20).join('\n')
      console.log(output ? `\n${c.dim(output)}\n` : `  ${c.dim(t('logEmpty'))}`)
    }
  }
  closePrompts()
}

// --- share / public link ---------------------------------------------------

// `harpy share` — interactive menu when TTY, plain status otherwise.
// `harpy share status` · `harpy share enable <provider> key=value …` ·
// `harpy share disable`.
async function shareCommand(args) {
  const { shareStatus, shareEnable, shareDisable, shareProviders } = await import('./share.js')
  const sub = args[0]

  if (sub === 'status' || (!sub && !isInteractive())) {
    const st = shareStatus()
    console.log(JSON.stringify(st, null, 2))
    return
  }
  if (sub === 'disable' || sub === 'off' || sub === 'stop') {
    shareDisable()
    console.log(`  ${c.ok('✓')} public link disabled`)
    return
  }
  if (sub === 'enable') {
    const provider = args[1]
    const opts = {}
    for (const a of args.slice(2)) {
      const m = a.match(/^--?([\w-]+)=(.*)$/)
      if (m) opts[m[1]] = m[2]
    }
    if (!provider) { console.error('usage: harpy share enable <provider> [key=value …]'); process.exitCode = 1; return }
    try {
      const st = await shareEnable(provider, opts)
      console.log(`  ${c.ok('✓')} ${st.url}`)
    } catch (e) {
      console.error(`  ${c.err('share failed:')} ${e.message}`)
      process.exitCode = 1
    }
    return
  }

  // interactive menu
  const t = translator(cliLang())
  const label = (s) => s.padEnd(10)
  const providers = shareProviders()
  for (;;) {
    const st = shareStatus()
    box(t('shareTitle'), [
      `${label(t('rowStatus'))}${st.running ? c.ok(`● ${t('stLive')}`) : c.dim(`○ ${t('stOff')}`)}`,
      `${label(t('rowProvider'))}${st.provider || '—'}`,
      `${label(t('rowUrl'))}${st.url ? c.cyan(st.url) : '—'}`
    ])
    const action = await choose(t('shareTitle'), [
      { value: 'enable', label: st.running ? t('mShareChange') : t('mShareEnable') },
      { value: 'open', label: t('mShareOpen'), hint: st.url || t('hNotLive') },
      { value: 'disable', label: t('mShareDisable'), hint: st.running ? '' : t('hNotEnabled') },
      { value: 'pubkey', label: t('mSharePubkey'), hint: t('hPubkey') }
    ])
    if (action === null || action === 'back') break
    if (action === 'disable') {
      shareDisable()
      console.log(`  ${c.ok('✓')} ${t('msgDisabled')}`)
    } else if (action === 'open') {
      if (st.url) {
        console.log(`  ${c.cyan(st.url)}`)
        if (canOpenBrowser()) openBrowser(st.url)
      } else console.log(`  ${c.warn(t('shareNoUrl'))}`)
    } else if (action === 'pubkey') {
      console.log(st.pubkey ? `\n  ${c.cyan(st.pubkey)}\n` : `  ${c.dim(t('shareNoKey'))}`)
    } else if (action === 'enable') {
      const pick = await choose(t('shareProviderQ'), providers.map((p) => ({
        value: p.id,
        label: p.label,
        hint: p.fixed ? t('hShareFixed') : t('hShareRandom')
      })))
      if (!pick || pick === 'back') continue
      const def = providers.find((p) => p.id === pick)
      const opts = {}
      for (const field of def.fields) {
        const v = await ask(`${field.label}${field.required ? '' : ` ${t('shareOptional')}`}`, field.default || '')
        if (v) opts[field.key] = v
      }
      try {
        const enabled = await shareEnable(pick, opts)
        console.log(`  ${c.ok('✓')} ${c.cyan(enabled.url)}`)
      } catch (e) {
        console.log(`  ${c.err(t('shareFailed'))} ${e.message}`)
      }
    }
  }
}

// --- first-run wizard ------------------------------------------------------

// The language question — always first, asked in a language-neutral picker
// (native names + English hint). Returns the locale id or null on quit.
async function askLanguage() {
  const pick = await choose('choose your language', LOCALES.map((l) => ({
    value: l.id,
    label: l.name,
    hint: l.english || undefined
  })), { defaultValue: envLang() || 'en' })
  return pick && pick !== 'back' ? pick : null
}

// yes/no plumbing for the picked language — native words on top of y/yes.
function ynOpts(lang) {
  return { yes: yesWords(lang), no: noWords(lang), hint: ynHint(lang) }
}

// Runs once on the very first interactive launch (no cli.json). Skipped
// entirely for --json, flags, or non-TTY callers. `askBackground` is false on
// `daemon install` — there the background choice is the command itself.
async function firstRunWizard(options, { askBackground = true } = {}) {
  if (!isInteractive() || options.json || options.port || cliConfigExists()) return options
  const settings = readCliConfig()

  const lang = await askLanguage()
  if (!lang) return options // quit at the picker — nothing written, ask next time
  const t = translator(lang)
  console.log(`\n  ${c.bold('harpy setup')} ${c.dim(t('setupSubtitle'))}\n`)

  const background = askBackground
    ? await confirm(t('bgQ'), true, { note: t('bgNote'), ...ynOpts(lang) })
    : true
  const autostart = await confirm(t('autoQ'), settings.autostart !== false, { note: t('autoNote'), ...ynOpts(lang) })

  let port = settings.port
  for (;;) {
    const answer = await ask(t('portQ'), String(port))
    const candidate = validPort(answer)
    if (!candidate) { console.log(`  ${c.err(t('portBad'))}`); continue }
    const holder = await describePort(candidate)
    if (holder.kind === 'free') { port = candidate; break }
    if (holder.kind === 'harpy') {
      console.log(`  ${c.ok('✓')} ${t('portHarpy', { port: candidate, version: holder.probe.version || '?' })}`)
      port = candidate
      break
    }
    console.log(`  ${c.warn(t('portForeign', { port: candidate }))}`)
    port = candidate + 1
  }

  writeCliConfig({ lang, background, autostart, port })
  console.log(`  ${c.dim(t('saved'))}\n`)
  return { ...options, port, _wizard: true, _lang: lang, _autostart: autostart, _background: background }
}

async function installFlow(options) {
  const { installAutostart, removeAutostart, startDaemon } = await import('./daemon.js')
  const settings = readCliConfig()
  const t = translator(cliLang())
  const port = resolvePort(options.port)
  const wantAutostart = options._autostart ?? settings.autostart
  const service = wantAutostart
    ? installAutostart({ port, workspace: options.workspace ?? settings.workspace, mode: options.mode || 'auto' })
    : removeAutostart()
  const started = await startDaemon({ port, workspace: options.workspace ?? settings.workspace })
  const message = options.json
    ? (wantAutostart ? 'autostart enabled and daemon started' : 'daemon started (autostart off)')
    : t(wantAutostart ? 'instOn' : 'instOff')
  const result = { ...started, service, message }
  if (options.json) printDaemonResult(result, true)
  else {
    await printDaemonResult(result)
    if (started.listening) console.log(`\n  ${c.cyan(`→ http://localhost:${port}`)} ${c.dim(t('linkNote'))}`)
  }
  return result
}

// --- settings ---------------------------------------------------------------

async function settingsFlow() {
  const { daemonStatus, installAutostart, removeAutostart, stopDaemon, startDaemon } = await import('./daemon.js')

  const apply = async (label) => {
    const t = translator(cliLang())
    const settings = readCliConfig()
    const status = await daemonStatus({ port: settings.port })
    if (settings.autostart) installAutostart({ port: settings.port, workspace: settings.workspace })
    else removeAutostart()
    if (status.running) {
      await stopDaemon()
      await startDaemon({ port: settings.port, workspace: settings.workspace })
      console.log(`  ${c.ok('✓')} ${t('daemonRestarted', { label, port: settings.port })}`)
    } else {
      console.log(`  ${c.ok('✓')} ${label}`)
    }
  }

  if (!isInteractive()) {
    console.log(JSON.stringify(readCliConfig(), null, 2))
    return
  }

  const label = (s) => s.padEnd(13)
  for (;;) {
    const t = translator(cliLang())
    const settings = readCliConfig()
    const status = await daemonStatus({ port: settings.port })
    box(t('setTitle'), [
      `${label(t('rowPort'))}${settings.port}${status.listening ? c.dim(` · ${t('stListening')}`) : ''}`,
      `${label(t('rowWorkspace'))}${settings.workspace || c.dim(t('setManaged'))}`,
      `${label(t('rowAutostart'))}${settings.autostart ? t('stEnabled') : t('stDisabled')}${status.service.enabled ? c.dim(` · ${status.service.mode}`) : ''}`,
      `${label(t('rowWebhook'))}${settings.webhook || c.dim(t('setNone'))}`
    ])
    console.log('')
    const pick = await choose(t('setPick'), [
      { value: 'port', label: t('setPort') },
      { value: 'workspace', label: t('setPinned') },
      { value: 'autostart', label: settings.autostart ? t('setAutoOff') : t('setAutoOn') },
      { value: 'webhook', label: t('setWh') },
      { value: 'lang', label: t('setLang') },
      { value: 'back', label: t('setBack') }
    ], { defaultValue: 'back' })
    if (pick === null || pick === 'back') break

    if (pick === 'lang') {
      const lang = await askLanguage()
      if (lang) writeCliConfig({ lang })
      continue
    }

    if (pick === 'webhook') {
      const value = await ask(t('whAsk'), settings.webhook || '')
      if (value && !/^https?:\/\//.test(value)) { console.log(`  ${c.err(t('whBad'))}`); continue }
      writeCliConfig({ webhook: value || null })
      // The running server re-reads cli.json on every send — no restart needed.
      console.log(`  ${c.ok('✓')} ${value ? t('whEnabled', { url: value }) : t('whDisabled')}`)
      continue
    }

    if (pick === 'autostart') {
      writeCliConfig({ autostart: !settings.autostart })
      await apply(settings.autostart ? t('autoOff') : t('autoOn'))
      continue
    }
    if (pick === 'workspace') {
      const value = await ask(t('wsAsk'), settings.workspace || '')
      writeCliConfig({ workspace: value || null })
      await apply(t('wsSaved'))
      continue
    }
    if (pick === 'port') {
      const answer = await ask(t('portAskNew'), String(settings.port))
      const candidate = validPort(answer)
      if (!candidate) { console.log(`  ${c.err(t('portBad'))}`); continue }
      const holder = await describePort(candidate)
      if (holder.kind === 'foreign') { console.log(`  ${c.err(t('portForeignShort', { port: candidate }))}`); continue }
      if (holder.kind === 'harpy' && candidate !== settings.port) {
        console.log(`  ${c.warn(t('portHarpyShort', { port: candidate }))}`)
        continue
      }
      writeCliConfig({ port: candidate })
      await apply(t('portTo', { port: candidate }))
    }
  }
}

async function settingsCommand(args) {
  if (args[0] === 'set') {
    const [key, ...rest] = args.slice(1)
    const value = rest.join(' ')
    if (key === 'port') {
      const port = validPort(value)
      if (!port) throw new Error('settings set port <1-65535>')
      writeCliConfig({ port })
    } else if (key === 'workspace') {
      writeCliConfig({ workspace: value || null })
    } else if (key === 'autostart') {
      if (!['on', 'off', 'true', 'false'].includes(value)) throw new Error('settings set autostart on|off')
      writeCliConfig({ autostart: value === 'on' || value === 'true' })
    } else if (key === 'webhook') {
      if (value && !/^https?:\/\//.test(value)) throw new Error('settings set webhook <http(s) URL|empty>')
      writeCliConfig({ webhook: value || null })
      console.log('saved — the running daemon picks this up on the next send')
      return
    } else if (key === 'lang' || key === 'language') {
      if (value && !LOCALES.some((l) => l.id === value)) {
        throw new Error(`settings set lang <${LOCALES.map((l) => l.id).join('|')}>`)
      }
      writeCliConfig({ lang: value || null })
    } else {
      throw new Error('known keys: port, workspace, autostart, webhook, lang')
    }
    console.log('saved. Restart the daemon to apply: harpy daemon restart')
    return
  }
  await settingsFlow()
}

// --- update ------------------------------------------------------------------

async function updateFlow(options) {
  const { checkForUpdate, applyUpdate, installMode, writeUpdateState, RELEASE_PAGE } = await import('./update.js')
  const t = translator(cliLang())
  const label = (s) => s.padEnd(10)
  const info = await checkForUpdate()
  box('update', [
    `${label(t('updCurrent'))}${info.current}`,
    `${label(t('updNpm'))}${info.npm || c.dim(t('updUnreachable'))}`,
    `${label(t('updGithub'))}${info.github ? 'v' + info.github : c.dim(t('updUnreachable'))}`,
    `${label(t('updChannel'))}${installMode()}`
  ])
  console.log('')
  if (!info.updateAvailable) {
    // Tells a UI-triggered update (detached `harpy update --yes`) there's
    // nothing to restart for — otherwise the client waits out its timeout.
    writeUpdateState({ phase: 'done', version: info.current, skipped: true })
    console.log(`  ${c.ok('✓')} ${t('updFresh')}`)
    return
  }
  console.log(`  ${c.accent('→')} ${c.bold(t('updAvail', { latest: info.latest }))}`)
  const go = options.yes || !isInteractive()
    ? options.yes
    : await confirm(t('updQ'), true, ynOpts(cliLang()))
  if (!go) {
    console.log(`  ${c.dim(RELEASE_PAGE)}`)
    return
  }
  const result = await applyUpdate({ restartDaemon: true })
  console.log(`  ${c.ok('✓')} ${t('updDone', { mode: result.mode, steps: result.steps.join(', ') })}`)
}

// `harpy chat [prompt] [-a agent] [--cwd dir] [--once]` — flag-bearing entry
// into the same shell bare `harpy` opens. A prompt (or piped input, handled by
// chatShell itself) means one-shot: run the turn, print the reply, exit.
async function chatCommand(args) {
  const options = {}
  const promptParts = []
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--agent' || a === '-a') options.agent = args[++i]
    else if (a === '--cwd') options.cwd = args[++i]
    else if (a === '--once' || a === '-1') { /* explicit one-shot — implied by a prompt */ }
    else promptParts.push(a)
  }
  const prompt = promptParts.join(' ').trim()
  const { chatShell } = await import('./cli-shell.js')
  await chatShell({ agent: options.agent, cwd: options.cwd, prompt: prompt || null })
}

// --- daemon command ----------------------------------------------------------

async function daemonCommand(args) {
  const command = args[0] || 'status'
  const options = parseDaemonArgs(args.slice(1))
  if (options.port) process.env.PORT = String(options.port)
  if (options.workspace) process.env.HARPY_WORKSPACE = options.workspace
  const { config } = await import('./config.js')
  const { daemonStatus, healthProbe, readDaemonLog, removeAutostart, runDaemonForeground, startDaemon, stopDaemon } = await import('./daemon.js')
  const port = options.port || readCliConfig().port || config.port
  if (command === 'run') {
    // Internal foreground entrypoint used by systemd, LaunchAgents, the
    // startup folder, and `daemon start`. It must never fork another child.
    await runDaemonForeground({ port, workspace: options.workspace })
    return
  }
  if (command === 'start') {
    const result = await startDaemon({ port, workspace: options.workspace })
    if (!result.started && result.listening && !options.json) {
      const probe = await healthProbe(port)
      if (probe.harpy) {
        console.log(`harpy is already serving on :${port}${probe.version ? ` (v${probe.version})` : ''}`)
        console.log(`→ http://localhost:${port}  ·  restart with \`harpy daemon restart\``)
        return
      }
      console.log(`${c.warn(`port ${port} is held by another app`)} — pick another: ${c.cyan(`harpy daemon start --port ${port + 1}`)}`)
      return
    }
    await printDaemonResult(result, options.json)
    return
  }
  if (command === 'stop') {
    await printDaemonResult(await stopDaemon(), options.json)
    return
  }
  if (command === 'restart') {
    await stopDaemon()
    await printDaemonResult(await startDaemon({ port, workspace: options.workspace }), options.json)
    return
  }
  if (command === 'install' || command === 'enable') {
    // `install` already IS the background choice — skip that one question.
    const merged = await firstRunWizard(options, { askBackground: false })
    await installFlow(merged)
    return
  }
  if (command === 'uninstall' || command === 'disable') {
    const service = removeAutostart()
    const stopped = await stopDaemon()
    await printDaemonResult({ ...stopped, service, message: 'autostart disabled and daemon stopped' }, options.json)
    return
  }
  if (command === 'status') {
    await printDaemonResult(await daemonStatus({ port }), options.json)
    return
  }
  if (command === 'logs') {
    const output = readDaemonLog()
    if (options.json) console.log(JSON.stringify({ output }, null, 2))
    else process.stdout.write(output || 'daemon log is empty\n')
    return
  }
  throw new Error(`unknown daemon command: ${command}`)
}

// --- entry -------------------------------------------------------------------

async function main() {
  const command = process.argv[2]
  const args = process.argv.slice(3)
  if (!command) {
    await home()
    return
  }
  if (command === 'version') {
    const { VERSION } = await import('./config.js')
    console.log(VERSION)
    return
  }
  if (command === 'chat' || command === 'shell') {
    await chatCommand(args)
    return
  }
  if (command === 'dash' || command === 'dashboard') {
    await dashboard()
    return
  }
  if (command === 'daemon') {
    await daemonCommand(args)
    return
  }
  if (command === 'settings' || command === 'config') {
    await settingsCommand(args)
    return
  }
  if (command === 'update' || command === 'upgrade') {
    const options = { check: args.includes('--check'), yes: args.includes('--yes') || args.includes('-y') }
    if (options.check) {
      const { checkForUpdate } = await import('./update.js')
      console.log(JSON.stringify(await checkForUpdate(), null, 2))
      return
    }
    await updateFlow(options)
    return
  }
  if (command === 'share') {
    await shareCommand(args)
    return
  }
  if (command === 'status') {
    const { config } = await import('./config.js')
    try {
      const response = await fetch(`http://127.0.0.1:${config.port}/api/health`)
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      console.log(await response.text())
    } catch (error) {
      console.error(`server not running: ${error.message}`)
      process.exitCode = 1
    }
    return
  }
  if (command !== 'start') {
    usage()
    process.exitCode = 1
    return
  }
  const options = parseStartArgs(args)
  const { config } = await import('./config.js')
  // config.js was already loaded by cli-config's top-level import, so the env
  // vars below are frozen — apply flags onto the live config object instead.
  if (options.workspace) config.workspace = path.resolve(options.workspace)
  const port = resolvePort(options.port) || config.port
  const holder = await describePort(port)
  if (holder.kind === 'harpy') {
    console.log(`harpy is already serving on :${port} (v${holder.probe.version || '?'})`)
    console.log(`→ http://localhost:${port}  ·  manage it with \`harpy\` or \`harpy daemon restart\``)
    return
  }
  if (holder.kind === 'foreign') {
    console.error(`port ${port} is used by another app — pick another: harpy start --port ${port + 1}`)
    process.exitCode = 1
    return
  }
  const { startServer } = await import('./index.js')
  // config.js was loaded before --port set env.PORT, so pass the resolved
  // port explicitly — config.port alone would always bind the default.
  const server = startServer({ port })
  server.once('listening', () => {
    const bound = Number(server.address()?.port || port)
    for (const ip of lanIps()) console.log(`mobile: http://${ip}:${bound}`)
  })
}

main().catch((error) => {
  closePrompts()
  console.error(error.message)
  process.exitCode = 1
})
