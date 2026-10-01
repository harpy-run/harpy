// Generates the docs/screenshots/*.svg terminal-window screenshots — the
// content mirrors real `harpy` shell output (the card, palette, wizard and
// tables are copied verbatim from TTY captures). Re-run after UI changes:
//   node scripts/screenshots.mjs
import fs from 'node:fs'
import path from 'node:path'
import { VERSION } from '../server/config.js'

const OUT = path.resolve('docs/screenshots')
fs.mkdirSync(OUT, { recursive: true })

const C = {
  fg: '#e6edf3',
  dim: '#7d8590',
  accent: '#d2a8ff',
  ok: '#56d364',
  warn: '#d29922',
  err: '#ff7b72',
  border: '#8b949e'
}

const FS = 14
const LH = 21
const CW = 8.44 // monospace advance at 14px
const PAD_X = 18
const PAD_TOP = 52 // window chrome + breathing room

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

// lines: array of spans; a span is [text] or [text, colorKey] or
// [text, colorKey, {bold:true}]. overlays: [{img, x, y, size}] — embedded
// raster assets (the real logo) positioned over the text grid.
function termSvg(title, lines, overlays = []) {
  const widthChars = Math.max(...lines.map((l) => l.reduce((n, s) => n + s[0].length, 0)))
  const w = Math.ceil(PAD_X * 2 + widthChars * CW) + 8
  const h = PAD_TOP + lines.length * LH + 20
  const body = lines.map((spans, i) => {
    let x = PAD_X
    const ts = spans.map(([text, cls, opt]) => {
      const t = `<tspan x="${x.toFixed(1)}"${cls ? ` fill="${C[cls] || cls}"` : ''}${opt?.bold ? ' font-weight="700"' : ''}>${esc(text)}</tspan>`
      x += text.length * CW
      return t
    }).join('')
    return `    <text y="${(PAD_TOP + i * LH + 13).toFixed(1)}" xml:space="preserve">${ts}</text>`
  }).join('\n')
  const imgs = overlays.map((o) => {
    const data = fs.readFileSync(o.img).toString('base64')
    return `    <image href="data:image/png;base64,${data}" x="${o.x.toFixed(1)}" y="${o.y.toFixed(1)}" width="${o.size}" height="${o.size}"/>`
  }).join('\n')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" font-family="ui-monospace,'SF Mono','Cascadia Mono','JetBrains Mono',Menlo,monospace" font-size="${FS}" fill="${C.fg}">
  <rect width="${w}" height="${h}" rx="10" fill="#0d1117"/>
  <rect width="${w}" height="${h}" rx="10" fill="none" stroke="#30363d"/>
  <rect width="${w}" height="34" rx="10" fill="#161b22"/>
  <rect y="24" width="${w}" height="10" fill="#161b22"/>
  <circle cx="20" cy="17" r="5.5" fill="#ff5f57"/>
  <circle cx="38" cy="17" r="5.5" fill="#febc2e"/>
  <circle cx="56" cy="17" r="5.5" fill="#28c840"/>
  <text x="${w / 2}" y="21" text-anchor="middle" fill="${C.dim}" font-size="12">${esc(title)}</text>
${body}
${imgs}
</svg>
`
}

const MW = 16
const LOGO = path.resolve('public/logo-256.png')

// Re-implements the cli-shell session card layout so the shots stay honest.
// The terminal renders a braille mark; in docs we drop in the real logo PNG.
function card({ cwd, agent, port, connected }) {
  const width = Math.min(76, Math.max(64, MW + cwd.length + 16))
  const colW = width - MW - 6
  const info = (label, value, hint = '') =>
    [[` ${label.padEnd(7)}`, 'dim'], [' '], [value, label === 'cwd' ? 'dim' : 'fg'], ...(hint ? [['  '], [hint, 'dim']] : [])]
  const title = '›_ Harpy Team'
  const version = `v${VERSION}`
  const titlePad = ' '.repeat(Math.max(1, colW - title.length - version.length - 2))
  const right = [
    [[` ${title}`, 'accent', { bold: true }], [titlePad], [` ${version}`, 'dim']],
    [['']],
    info('agent', agent, '/use to switch'),
    info('cwd', cwd),
    info('daemon', connected ? `:${port} connected` : 'offline', connected ? '' : '/daemon start'),
    [['']]
  ]
  const row = (spans) => {
    const used = spans.reduce((n, s) => n + s[0].length, 0)
    return [['  │ ', 'border'], [' '.repeat(MW)], ['  '], ...spans, [' '.repeat(Math.max(0, colW + 2 - used))], [' │', 'border']]
  }
  const foot = ' / commands · /team bots · /exit quits'
  const overlay = { img: LOGO, x: PAD_X + 4 * CW + 4, y: PAD_TOP + 2 * LH + 3, size: Math.round(6 * LH - 10) }
  const lines = [
    [['']],
    [['  ╭', 'border'], ['─'.repeat(width), 'border'], ['╮', 'border']],
    ...right.map((spans) => row(spans)),
    [['  │', 'border'], [' '.repeat(width)], ['│', 'border']],
    [['  │', 'border'], [foot, 'dim'], [' '.repeat(Math.max(0, width - foot.length - 1))], [' │', 'border']],
    [['  ╰', 'border'], ['─'.repeat(width), 'border'], ['╯', 'border']],
    [['']]
  ]
  return { lines, overlay }
}

const P = (agent, rest) => [[[`${agent} › `, 'accent', { bold: true }], ...rest]]

const cardShell = card({ cwd: '~/src/harpy', agent: 'claude', port: 3001, connected: true })
const cardTeam = card({ cwd: '~/src/harpy', agent: 'claude', port: 3001, connected: true })
const cardMem = card({ cwd: '~/src/harpy', agent: 'codex', port: 3001, connected: true })

const scenes = {
  'cli-shell': { overlay: cardShell.overlay, lines: [
    ...cardShell.lines,
    ...P('claude', [['review the auth flow and flag anything risky']]),
    [['']],
    [['  ● Read ', 'dim'], ['server/auth.js', 'fg'], [' → traced ', 'dim'], ['resolvePrincipal', 'fg'], [' on every op', 'dim']],
    [['']],
    [['  Auth accepts two credential kinds:']],
    [['    • JWT bearer — 24h TTL, verified on the /ws upgrade']],
    [['    • API keys   — hp_… issued via /api/auth/keys, revoked per-user']],
    [['']],
    [['  One risk: '], ['expired tokens used to linger in the WS pool — now', 'dim']],
    [['  cleared by the 401 path. Nothing else jumps out.', 'dim']],
    [['']],
    ...P('claude', [['/exit', 'fg']]),
    [['  bye', 'dim']],
    [['']]
  ] },

  'cli-team': { overlay: cardTeam.overlay, lines: [
    ...cardTeam.lines,
    ...P('claude', [['/team']]),
    [['']],
    [['  team [default]:', 'dim']],
    [['  pick a bot agent']],
    [['  › Claude Code', 'accent', { bold: true }]],
    [['    Codex', 'dim']],
    [['    Devin', 'dim']],
    [['  what should this bot do?', 'dim'], [' review PRs on this repo']],
    [['']],
    [['  ✓ ', 'ok'], ['team:default · s_137 · claude · running']],
    [['']],
    ...P('claude', [['/team ls']]),
    [['']],
    [['  session   agent    team      status    prompt', 'dim']],
    [['  s_137     claude   default   running   review PRs on this repo']],
    [['  s_142     devin    default   running   docs only — never touch src/']],
    [['']],
    ...P('claude', [['/say default "post your diff summary in chat"']]),
    [['']]
  ] },

  'cli-memory': { overlay: cardMem.overlay, lines: [
    ...cardMem.lines,
    ...P('codex', [['/memory']]),
    [['']],
    [['  memory   ', 'dim'], ['on', 'ok'], ['   .harpy/MEMORY.md + AGENTS.md pointer + launch hint + handoffs', 'dim']],
    [['  digest   ', 'dim'], ['on', 'ok'], ['   session-end run distills durable facts into MEMORY.md', 'dim']],
    [['']],
    [['  memory on — ./.harpy + ~/.harpy/projects/*/memory/harpy/MEMORY.md', 'dim']],
    [['']],
    ...P('codex', [['remember: node-pty rides optionalDeps — never --omit=optional']]),
    [['']],
    [['  ● Wrote to ', 'dim'], ['.harpy/MEMORY.md', 'fg'], [' under Conventions', 'dim']],
    [['']],
    ...P('codex', [['/memory off']]),
    [['']],
    [['  ✓ ', 'ok'], ['persistent memory off — .harpy/ wiped from reachable workspaces']],
    [['']]
  ] }
}

for (const [name, { lines, overlay }] of Object.entries(scenes)) {
  const file = path.join(OUT, `${name}.svg`)
  fs.writeFileSync(file, termSvg(`harpy — ${name.replace('cli-', '')}`, lines, overlay ? [overlay] : []))
  console.log(`wrote ${file}`)
}
