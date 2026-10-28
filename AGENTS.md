# AGENTS.md

Harpy v2 — a self-hosted AI coding workbench. Node.js backend (ESM, Node >=22) serves a Preact/Vite frontend over HTTP and multiplexes 10 channels (`project`, `auth`, `fs`, `git`, `pty`, `agent`, `activity`, `share`, `system`, `automation`) across a single authenticated WebSocket (`server/index.js:89`).

## Verification & Commands

- **Automated Checks:** `npm run lint` (ESLint flat config) is the primary automated check. `npm run build` (production Vite build into `dist/`) must stay green. No general test runner or typecheck script. Run both `npm run lint` and `npm run build` before claiming done. Release CI (`.github/workflows/release.yml`) runs only on `v*` tags and never lints.
- **Standalone Offline Tests:** Fast regression scripts under `scripts/` run locally without a backend or credentials:
  - `node scripts/skill-context-test.mjs` — skill discovery, 4 KiB budget, symlink rejection, cwd isolation.
  - `node scripts/memory-regression-test.mjs` — memory digest prefs, handoffs, AGENTS.md pointer migration.
  - `node scripts/skills-manager-test.mjs` — git clone sandboxing, private homes, path traversal defenses.
  - `node scripts/terminal-clipboard-test.mjs` — terminal copy vs Ctrl+C SIGINT preservation.
- `npm install`: PTY backend `@lydell/node-pty` bundles per-platform native binaries in `optionalDependencies`. **Never** install with `--omit=optional`, or terminal and agent spawning fails.
- `npm start` (or `npm run server`): backend on `3001` (`0.0.0.0`). Serves `dist/` when present, 404s on `/` otherwise. Custom port: `node server/cli.js start --port N`.
- `npm run dev`: Vite on `5199`; proxies `/api` + `/ws` to `PORT || HARPY_PORT || 3001` — **requires `npm start` in parallel**.
- `npm run build`: Vite build into `dist/`.
- `npm run check:version` / `npm run version:sync`: version lives in 4 places that must agree — `package.json`, `package-lock.json`, `server/config.js` (`VERSION`), `src/lib/updater.js`. `check:version` accepts `--tag vX.Y.Z` (used by release CI).
- `scripts/ensure-dist.mjs` (`prepare`, and chained into the `version` script): rebuilds `dist/` when its embedded version drifts from `package.json`. Required because `prepack` never runs on `npm i -g .` or a git checkout, and a checkout serves its own `dist/` — a stale bundle makes the UI's `CURRENT_VERSION` lag and the update banner loop forever.
- `harpy` / `harpy-team` (both → `server/cli.js`): interactive agent shell or launcher picker. Subcommands: `chat`, `dash`, `start`, `status`, `version`, `team`, `daemon`, `settings`, `share`, `update`.
- `harpy daemon`: `install | status | logs | restart | stop | disable`. systemd on Linux, `launchctl` on macOS, Startup folder `Harpy.vbs` on Windows; detached spawn is unsupervised fallback only.

### Integration Smoke Tests (Running Server Required)

Scripts under `scripts/` hit a **running** backend (`BASE` env overrides default `http://localhost:3001`). Use an isolated `HARPY_HOME` and port, never someone's live server:

- `node scripts/smoke.mjs`: `/api/health`, first-run setup (`HARPY_SMOKE_PASSWORD`, default `secret123`), login, static serve, WS channels. Asserts `agent.agents` returns exactly **8** adapters — bump this whenever adapters change.
- `node scripts/agent-terminal-smoke.mjs`: default `http://127.0.0.1:3231`; asserts agent sessions survive client reconnects. Needs ≥1 agent CLI on PATH.
- `node scripts/shell-lifecycle-smoke.mjs`: spawns `cli.js chat` via pty at several window sizes; asserts clean exit 0 on `/exit`, `^C`, `^D` without hanging.
- `node scripts/activity-smoke.mjs`: `activity` channel event logging + subscriptions.
- `npm run screenshots` (`scripts/screenshots.mjs`): captures UI screenshots — CONTRIBUTING asks for these on UI changes.

## Environment

- `HARPY_HOME` (default `~/.harpy`) holds all runtime state: `auth.json` (0600), `cli.json` (0600, port/workspace/preferred agent), `cli-env.json` (per-user CLI env), `daemon/harpy.pid`, `daemon/cli.key` (0600), `share.json`, `agent-availability.json`, `automations/<ws-hash>/*.md`, `worktrees/`, `daemon/state.json`. Per-*workspace* state lives separately in `<workspace>/.harpy/` (`handoffs/`, memory). Secrets never belong in the repo.
- Other env: `PORT`/`HARPY_PORT`, `HARPY_HOST`, `HARPY_PROJECTS` (default `./harpy-projects`), `HARPY_WORKSPACE`, `HARPY_AGENT_IDLE_MS` (default 4h; `0` disables session suspend).

## Cross-Platform Constraints (macOS, Windows, Linux)

- **Windows CLI spawns:** Never spawn bare CLI names (npm CLIs are `.cmd` batch shims `CreateProcess` cannot exec). Resolve through `resolveCommand()` in `server/util/env.js:184`. For `spawn()`, pass `...verbatimOpts(target)` + `tail`; for `pty.spawn`, pass `target.tail ?? target.args`.
- **Env vars on Windows:** merges are case-insensitive. Never `{...process.env, PATH: ...}` (drops/duplicates `Path`). Use `enhancedEnv()`.
- **No POSIX process APIs in shared code:** no `/proc`, `process.kill(-pid)`, `ps`, `lsof`, `pgrep`. Use `server/util/proc.js` (`processTree`, `pidAlive`, `killProcessTree`, `commandLineOf`).
- **Shell selection:** `process.env.SHELL` → on Windows `powershell.exe`, else `os.userInfo().shell` (macOS must get zsh, not bash).
- **Paths & case:** Windows paths are case-insensitive; canonicalize via `realpath` + lowercase (`server/workspace.js`). `~` expands for both `~/` and `~\`.
- **Detached spawns:** always `windowsHide: true`; Windows autostart must be a hidden `Harpy.vbs`, never `.cmd`.
- **Windows self-update:** must stop the daemon before `npm i -g` — loaded `.node` binaries are locked by the OS.
- **fs watching:** `fs.watch` stays per-directory; recursive watching is unsupported on Linux.
- **Provider binary downloads:** GitHub `/releases/latest/download/<name>` only works for stable asset names — versioned names need the release API (`githubLatestAssetUrl`). Walk tarballs with `ensureBinaryTgz`, don't hardcode member paths.

## Architecture & Subsystem Rules

### WebSocket & Terminal Data Flow
- Most application RPC uses one authenticated `/ws` (`{ch, id, op, data}`), not REST CRUD. Handlers live in `server/channels/`.
- Terminal output is coalesced per ~16ms tick (`DATA_FLUSH_MS`, `server/channels/pty.channel.js:21`, `server/agents/runner.js:171`) before framing; never forward raw `onData` chunks — per-chunk frames flood high-latency tunnels and trip `bufferedAmount` flow control. Replay uses the history ring (2000 events / 2 MiB).
- Hub: ping every 30s, 30s pong budget, terminate when `bufferedAmount > 4 MiB`; **any inbound frame resets liveness** (`server/ws.js`). `maxPayload` 8 MiB so 5 MiB file saves fit one frame; `perMessageDeflate` threshold 1 KiB (big win through tunnels).
- Credentials ride in `Sec-WebSocket-Protocol: harpy, <cred>`; `?key=`/`?token=` are legacy fallbacks.
- **Client heartbeat alias:** `src/lib/ws.js:110` sends `{ch:'sys', op:'ping'}`. `sys` is *not* a registered channel — the hub answers `ping` generically before channel dispatch. Don't "fix" it to `system`, and don't route real ops through `sys`.
- Per-channel flow control pauses `term.resume()` at 2 MiB / resumes at 512 KiB per subscriber.
- Terminal clipboard (`src/lib/terminal-clipboard.js`): Ctrl+C with text selected copies and clears selection; without selection passes SIGINT to PTY. Has synchronous textarea fallback for insecure HTTP contexts.
- Terminal renderer (`src/lib/terminal-renderer.js`): xterm 6 dropped `@xterm/addon-canvas`. Uses `@xterm/addon-webgl` with fallback to built-in DOM renderer.

### Agent Adapters (`server/agents/adapters/`)
- Eight adapters: `harpy` (builtin shell), `claude`, `codex`, `devin`, `gemini`, `qwen`, `opencode`, `grok`. Adding/removing one requires editing `registerAllAdapters` (`adapters/index.js`) **and** the count assertion (`8`) in `scripts/smoke.mjs`.
- External CLIs are probed through the login-shell PATH; results cached in `$HARPY_HOME/agent-availability.json` for 24h.
- Preferred agent lives in `cli.json` (`preferredAgentId()` in `server/agents/adapter.js`); automations and digests fall back to it.
- Idle sessions suspend after `HARPY_AGENT_IDLE_MS` (default 4h) — a wedged long-idle CLI is worse than a resumable sleeping session.
- Session resume: metadata persists; wake respawns CLI with adapter resume arguments, not an OS process freeze or saved scrollback.

### Auth & Permissions (`server/auth.js`, `server/workspace.js`)
- First run requires `POST /api/auth/setup`, password ≥ 6 chars. State in `auth.json` (0600).
- Tokens: JWT (24h TTL) or API keys `hp_...`. Roles `owner`, `admin`, `member`.
- **The `pty` channel is admin-only wholesale** — a PTY is a daemon-user host shell; project allowlists must never grant it. `agent` is `requireAccess` + `requireSelfOrAdmin` and is gated by `workspaceRoot(ws, ctx)`; `fs`/`git`/`project`/`automation` mix per-op `requireAccess`/`requireAdmin` with `workspaceRoot`.
- Canonicalization goes through `workspaceRoot()` / `workspacePath()` — never join user-supplied paths yourself.

### Skills & Memory (`server/skill-context.js`, `server/skills.js`, `server/handoffs.js`)
- Skill discovery scans task cwd `.agents/skills/*/SKILL.md`, legacy `.claude/skills/*/SKILL.md`, and bundled `skills/harpy`. Reads only bounded leading YAML frontmatter (capped at 4 KiB context budget). Symlinks outside root are rejected.
- Runner injects skill context into prompt-bearing launches and fresh headless turns; blank interactive launches stay blank (raw keystrokes are never rewritten).
- Skill manager (`server/skills.js`): workspace skills install to `.agents/skills/`; user-scoped skills install to agent-specific dirs under user home (requires private home if non-admin). Strictly validates repo URLs, names, and symlinks.
- Durable project facts live in `<workspace>/.harpy/MEMORY.md`, session snapshots in `.harpy/handoffs/INDEX.md`. Session-end memory digest is off by default (`/memory digest on`).
- Root `AGENTS.md` bottom block (`<!-- harpy:memory -->`) is managed by `server/handoffs.js:ensureAgentsPointer` — keep markers intact.

### CLI Shell & Terminal Redraws (`server/cli-shell.js`, `server/cli-input.js`, `server/cli-ui.js`)
- **Row fitting:** any row later redrawn with `\x1b[nA` MUST be formatted through `fit()` (`cli-ui.js:36`) to `process.stdout.columns`. A wrapped row corrupts cursor math and duplicates text on every keystroke.
- **Keypress sink:** `emitKeypressEvents` drops its `data` consumer when `keypress` listener count hits 0. `BoxedInput.start()` attaches a permanent no-op sink; overlay listeners must attach *before* their first `await`.
- **Interactive pickers** (`choose`/`ask`/`toggleMenu`/`linkPickSession`) leave stdin cooked+paused on return — call them inside the shell only via `park(fn)`.
- **Loopback auth:** the shell reaches the daemon over WS with the ephemeral key at `$HARPY_HOME/daemon/cli.key` (0600).
- `skills/harpy/SKILL.md` is copied onto agent skill paths at every daemon boot (`server/agent-skills.js`) — `~/.agents/skills/harpy/` always, plus `~/.claude/...` and `~/.config/devin/...` only if those dirs already exist.

### Daemon & Process Management (`server/daemon.js`)
- The pidfile (`$HARPY_HOME/daemon/harpy.pid`) covers only daemon-managed instances; foreground `harpy start` writes no state file.
- Port sweeps are by **identity**: `killPortHolder()` only kills a holder whose `/api/health` returns `{name:'harpy'}`. Never kill an unrecognized service, and never trust the pidfile alone for stop/start.
- Start/stop must route through the owning supervisor (`systemdUnit()` / `launchctl bootstrap|bootout`) when one exists; a bare kill races `KeepAlive` respawns.

### Public Tunnels & Share Channel (`server/share.js`)
- Detached providers: cloudflared, `ssh -R` (sish relay), ngrok, zrok, bore.dk. State in `$HARPY_HOME/share.json`.
- bore.dk specifics: `sweepStrayProviderDaemons()` kills stray bore daemons (SIGTERM → SIGKILL after 2s, verified via `/proc` cmdline); failed `bore up` must call `reapSpawnedDaemons()`; `boreRuntime()` self-heals truncated `runtime.json` and quarantines unparseable files; `resolve({port})` matches **strictly by port** (the old `|| active[0]` fallback adopted another backend's URL) and accepts both `daemonPid` and newer `guiPid`; `pruneConflictingBoreTunnels()` must strip stale `~/.bore/config.json` registrations for the same subdomain *before* claiming the tunnel (bore's `desiredTunnels` is a list it re-publishes on every sync, so a leftover entry for a dead port splits traffic — plain requests work, WS upgrades fail).
- Diagnostic tell: bore returns `502` with body `local websocket upgrade failed with status 401` when harpy rejects the credential — a 401 disguised as a transport error ("WebSocket failed" on some devices only).

### Automations (`server/automations.js`)
- Markdown + frontmatter under `$HARPY_HOME/automations/<ws-hash>/*.md`. Triggers: `fs`, `cron`, `webhook`, `session-end`. Optional `gate:` shell command must exit 0 to proceed.
- Isolated runs execute in detached git worktrees under `$HARPY_HOME/worktrees/`.

## Code & Conventions

- **ESM only** (`"type": "module"`): `import`/`export`, never `require`.
- **New backend surface is usually a new op on an existing channel** in `server/channels/`, not a REST route.
- **Frontend is Preact**, not React — import from `preact` / `@preact/*`; state in `@preact/signals`. Entry `src/main.jsx` → `src/App.jsx`, panes in `src/components/`, wire/helpers in `src/lib/`.
- **Styling:** Tailwind v4 via `@tailwindcss/vite`, entry `src/styles/tailwind.css`; there is **no** `tailwind.config.js`. Long-standing custom rules live in `src/styles/global.css`.
- **UI Translations:** UI strings live in `src/i18n/locales/*.json`; `en.json` is the source of truth and fallback.
- **Lint gotcha:** `no-unused-vars` is `argsIgnorePattern: '^_'` — only *function arguments* may be prefixed with `_`. An unused local/const named `_x` still errors.
- ESLint ignores `dist/**`, `node_modules/**`, `scripts/sync-version.mjs`, `scripts/check-version-sync.mjs`.
- **Gitignored runtime artifacts:** `dist/`, `harpy-projects/`, `.harpy/`. Never commit them. Note this means `.harpy/` (memory + handoffs) is local-only, so durable gotchas must also land here.

<!-- harpy:memory -->
This workspace uses Harpy: read `.harpy/MEMORY.md` and update durable facts, not task logs. Session snapshots: `.harpy/handoffs/INDEX.md`. Discover reusable procedures in `.agents/skills/*/SKILL.md` (legacy `.claude/skills` supported); read only matching skills. Within the existing task, create/update a concise skill only for a verified repeatable procedure (name/description frontmatter, steps, verification). Do not auto-install remote skills or make extra model calls for learning.
<!-- /harpy:memory -->
