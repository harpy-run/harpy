// Pty-driven shell lifecycle smoke — spawns `cli.js chat` at several
// terminal sizes and asserts every exit path returns to exit code 0 instead
// of hanging on "bye" (regression for the resumed-stdin/ws-close pin).
// Not wired into npm — run after the daemon is up: node scripts/shell-lifecycle-smoke.mjs
import pty from '@lydell/node-pty'

function run(name, cols, rows, script, env = {}) {
  return new Promise((resolve) => {
    const child = pty.spawn('node', ['server/cli.js', 'chat'], { name: 'xterm-256color', cols, rows, cwd: new URL('..', import.meta.url).pathname, env: { ...process.env, ...env } })
    let out = ''
    let exited = false
    const done = (ok, why) => {
      if (exited) return
      exited = true
      try { child.kill() } catch { /* already gone */ }
      resolve({ name, ok, why, tail: out.slice(-300) })
    }
    child.onExit(({ exitCode }) => done(true, `exit=${exitCode}`))
    child.onData((d) => { out += d })
    setTimeout(() => done(false, 'TIMEOUT — hung'), 15_000)
    const steps = [...script]
    const tick = () => {
      const next = steps.shift()
      if (next === undefined) return
      setTimeout(() => { child.write(next); tick() }, 1500)
    }
    setTimeout(tick, 2500)
  })
}

const results = []
results.push(await run('exit@40x10', 40, 10, ['/exit', '\r']))
results.push(await run('ctrlc@40x10', 40, 10, ['\x03']))
results.push(await run('exit@24x8', 24, 8, ['/exit', '\r']))
results.push(await run('exit@12x6', 12, 6, ['/exit', '\r']))
results.push(await run('ctrlc-clear-then-exit@40x10', 40, 10, ['hello world', '\x03', '\x03']))
results.push(await run('ctrld@40x10', 40, 10, ['\x04']))

let fail = 0
for (const r of results) {
  console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.name} — ${r.why}`)
  if (!r.ok) { fail++; console.log('  tail:', JSON.stringify(r.tail)) }
}
process.exit(fail ? 1 : 0)
