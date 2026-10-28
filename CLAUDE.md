# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development and verification

Harpy requires Node.js >=22 and uses ESM throughout. Install with `npm install`; do not omit optional dependencies, since `@lydell/node-pty` needs its platform-native package.

- `npm start` / `npm run server`: foreground HTTP/WebSocket backend on port 3001, serving `dist/` when present. To choose another port: `node server/cli.js start --port 3231`.
- `npm run dev`: Vite on port 5199. Run the backend separately; Vite proxies `/api` and `/ws` to `PORT || HARPY_PORT || 3001`.
- `npm run lint`: repository ESLint check. `npm run build`: production Vite build. Run both for implementation changes.
- `npm run check:version`: verifies package/lockfile/backend/frontend versions. `npm run version:sync` synchronizes them. The `version`/`prepare` hooks also ensure the served `dist` version is current; otherwise the update banner can loop despite an updated backend.
- Standalone regressions: `node scripts/skill-context-test.mjs`, `node scripts/memory-regression-test.mjs`, and `node scripts/skills-manager-test.mjs`. Each runs independently without a backend or provider credentials. There is no general test runner, npm test script, or typecheck script; run a specific script directly rather than inventing test-runner flags.
- Integration smoke: `node scripts/smoke.mjs` against a running backend (`BASE=http://localhost:3001` by default). It exercises setup/login and can initialize a fresh instance; use an isolated `HARPY_HOME` and port, not someone's live server. `HARPY_SMOKE_PASSWORD` overrides its setup password.
- Other standalone smoke scripts: `scripts/activity-smoke.mjs` tests event logging; `scripts/agent-terminal-smoke.mjs` tests reconnect persistence (defaults to port 3231, needs an installed agent CLI); `scripts/shell-lifecycle-smoke.mjs` exercises interactive shell exits. Read each script's setup before running.
- `npm run screenshots` captures UI screenshots. CONTRIBUTING asks for screenshots/recording for UI changes.

`dist/`, `harpy-projects/`, and `.harpy/` are runtime/build artifacts, not committed source. Release CI runs on version tags or manual dispatch; it does not replace local lint/build verification. ESLint permits `_` prefixes only on unused arguments, not unused locals.

## Runtime architecture

One Node daemon serves the browser SPA and owns subprocesses: provider CLI PTYs, ordinary shell PTYs, and optional tunnel providers. `server/cli.js` is both the `harpy` and `harpy-team` executable; `server/index.js` assembles HTTP routes, the WS hub, adapters, channels, restored sessions, watchers and automations. Foreground startup and supervised daemon lifecycle are separate paths.

The UI is **Preact**, not React, with `@preact/signals`. `src/App.jsx` gates shell mounting on health/auth; `src/state/app.js` owns shared signals and browser-local presentation state. CodeMirror and xterm are the editor/terminal engines. Tailwind v4 runs through the Vite plugin (`src/styles/tailwind.css`), alongside custom `global.css`; there is no Tailwind config file. English translation keys in `src/i18n/locales/en.json` are the fallback for other locales.

Most application RPC uses one authenticated `/ws`, not REST CRUD: requests `{ch,id,op,data}`, replies `{id,ok,data/error}`, pushes `{ch,ev,data}`. Add operations to `server/channels/` and use `src/lib/ws.js`; HTTP mainly handles auth/health and specialized preview/OAuth/share/webhook routes. Credentials prefer WS subprotocol `['harpy', token]`; query credentials remain compatibility fallbacks. `sys/ping` is a hub-level heartbeat alias, not a channel to rename or use for real operations.

Server persistence is filesystem-based. `HARPY_HOME` (default `~/.harpy`) contains auth, workspace selection, CLI settings, session metadata, automation definitions and tunnel/daemon state. Workspace `.harpy/` separately contains curated memory and handoffs. Browser storage is UI state/tokens, not session ownership. `HARPY_WORKSPACE` pins an external workspace; managed projects default to `./harpy-projects`.

## Session and workspace invariants

- Agent integrations are adapters under `server/agents/adapters/`, executing installed CLIs, not an API-provider service. Register adapters centrally and update the adapter-count assertion in `scripts/smoke.mjs` when the set changes. Teams are session labels, not a separate orchestrator.
- Shell PTYs are admin-only and survive browser disconnects, but not daemon restarts. Agent sessions persist metadata; restore/wake respawns the CLI using adapter resume arguments, not a surviving process or persisted scrollback. Idle agent suspension defaults to four hours (`HARPY_AGENT_IDLE_MS=0` disables it). Automation one-shots do not restore.
- Output is coalesced, sequence-numbered and kept in bounded replay buffers. Flush data before exit/status frames. Reconnect hydration must merge replay/live output by sequence, and replay must strip ANSI queries that cause xterm to send stale terminal replies. Preserve socket backpressure and heartbeat handling.
- Capture workspace/cwd at spawn and carry them through asynchronous operations. Changing the UI workspace must not retarget running work. Resolve client paths with `workspaceRoot`/`workspacePath`; project allowlists and realpath containment live in `server/workspace.js`. Only a trusted server-created automation context may launch outside the root.
- Filesystem subscriptions are connection-owned, but sessions/activity/automations can pin watchers. `src/lib/fs-watch.js` centralizes active/split-pane subscriptions and reconnect rearming; views consume filesystem events. Keep per-directory watches for Linux and preserve observability of external writes/git changes.
- Account authorization is not an OS sandbox: CLIs execute as the daemon user. Ownership is account-based, not browser-tab based. Foreign-session watchers are explicit/read-only; ordinary host shells remain admin-only.

## Skill and memory context

`server/skill-context.js` discovers task-cwd `.agents/skills/*/SKILL.md`, legacy `.claude/skills/*/SKILL.md`, and the bundled Harpy skill. Only bounded leading metadata is read at discovery; the launch catalog has a 4 KiB UTF-8 budget, with directory pointers for omitted entries. Metadata is untrusted data, not authority to run scripts or install repositories. Discovery itself never spawns a CLI, accesses the network or writes files.

The runner injects context into prompt-bearing launches; the CLI shell adds it only for actually fresh headless calls, including adapters without continuation support. Blank interactive launches stay blank; the first logical send can provide context, but raw keystrokes must never be rewritten. A resumed provider conversation must not receive unsolicited setup input. Isolated automation skills come from the actual worktree; memory references point to the logical workspace.

The existing task agent can author a verified reusable procedure in `.agents/skills/<slug>/SKILL.md`; durable project facts belong in `.harpy/MEMORY.md`, transient progress in handoffs. Do not manufacture skills for every task or eagerly load all bodies. Background memory digest is separately opt-in because it launches additional model work; preserve explicit saved preferences. Memory scaffolding/pointers live in `server/handoffs.js`; migration must preserve human prose and bytes outside managed markers.

## Platform and terminal constraints

Use `resolveCommand`/`enhancedEnv` in `server/util/env.js` for CLI spawning: Windows npm `.cmd` shims need wrapping and PATH merges are case-insensitive. Use `server/util/proc.js` for process trees and termination, not ad hoc POSIX-only process commands. Killing an agent must release helper processes/session locks too.

CLI redraw rows must fit terminal columns through `fit()` in `server/cli-ui.js`; wrapping breaks cursor-up math. `BoxedInput` retains a no-op keypress sink because Node drops its data consumer at zero listeners. Interactive pickers inside the shell must run through `park(fn)` to restore stdin mode/listeners.

Daemon start/stop must honor the owning systemd/launchctl supervisor. A foreground instance may have no pidfile; port-holder cleanup must verify `/api/health` identifies Harpy before terminating anything. Do not treat the pidfile alone as proof of process identity.

Read `AGENTS.md` for additional subsystem-specific constraints and `.harpy/MEMORY.md` for local durable context when present. No Cursor or Copilot instruction files were present when this guide was created.
