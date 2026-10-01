# AGENTS.md

Harpy v2 — a self-hosted AI coding workbench: a Node.js backend (ESM, Node >=22)
serves a Preact/Vite frontend over HTTP plus one authenticated WebSocket that
multiplexes `fs`, `git`, `pty`, `agent`, `project`, `auth`, `activity`, `share`
channels. There is no test runner and no
typecheck script — `npm run lint` is the only automated check.
Static serving (`server/static.js`): hashed `/assets/*` get `immutable`
cache headers; everything else is `no-cache` + etag so an update can never
keep serving a stale `index.html`/`sw.js`. The service worker
(`public/sw.js`) never caches navigations and revalidates them; the update
modal's reload purges Cache Storage first. `prepare`
(`scripts/ensure-dist.mjs`) rebuilds `dist/` when its embedded version
differs from `package.json` — covers `npm i -g .`/git installs where
`prepack` never runs, so a stale bundle can't ship.

## Commands

- `npm install` — the PTY backend is `@lydell/node-pty`, whose native
  binaries ship inside the npm tarball as per-platform optionalDependencies
  (win32/darwin/linux, x64/arm64). No install scripts, no C++ toolchain —
  do not install with `--omit=optional` or terminals/agents break.
- `npm start` (a.k.a. `npm run server`) — backend only, always on the stable
  publication port `3001`. For an isolated port use `node server/cli.js start
  --port N`; host is `0.0.0.0`; serves `dist/` if it exists, otherwise 404s on `/`.
- `harpy` (no args, TTY) — opens the arrow-key launcher picker (`Harpy Team`
  → the codex-style agent shell, `Dashboard` → the classic status menu,
  `open web UI`; Esc exits). The shell chats with any installed agent CLI and
  manages daemon teams (`/team`, `/say`, `/peek`, `/join`, `/daemon`, …); `/`
  on an empty prompt opens the filtered command palette. `harpy chat [prompt]`
  skips the launcher (one-shot/REPL), `harpy dash` jumps to the dashboard.
  All pickers are cursor/highlight lists — `server/cli-ui.js`'s `choose()`
  owns raw-mode keys; non-TTY always falls back to plain status output.
- `harpy daemon install` — start the backend detached and register login
  autostart (systemd/desktop entry on Linux, LaunchAgent on macOS, Startup folder
  on Windows). On a real first run (no `~/.harpy/cli.json`, TTY, no `--port`)
  it asks port + autostart; a busy port is probed via `/api/health` — a harpy
  already serving there is reported and adopted into the message, a foreign
  app is refused. `daemon status|logs|restart|stop|disable` manage it.
- `harpy settings [set port|workspace|autostart <v>]` — edits
  `~/.harpy/cli.json` (0600); port resolution is flag > cli.json > env >
  default. Interactive `settings` rewrites autostart + restarts the daemon.
- `harpy update [--check|--yes]` — checks npm registry **and** GitHub
  releases/tags, applies through the install channel (`npm i -g` for global
  installs, `git pull --ff-only` + rebuild for checkouts), then restarts the
  daemon **and verifies `/api/health` answers before reporting success**.
  `server/update.js` holds the logic: a lockdir at
  `$HARPY_HOME/daemon/update.lock` serializes concurrent updaters and
  `update-state.json` records the phase (`install`/`restart`/`done`/`failed`)
  for the UI's `system.updateStatus` poll; `server/cli-ui.js` is the
  dependency-free prompt/ANSI layer (degrades cleanly without a TTY).
- `npm run dev` — Vite frontend only, port 5199. **It proxies `/api` and `/ws` to
  the backend at `PORT||HARPY_PORT||3001`, so you must also run `npm start` or API/WS will fail.**
- `npm run build` — Vite build into `dist/` (what the backend serves in prod).
- `npm run lint` — ESLint flat config (`eslint.config.js`); run before claiming done.

## Distribution

npm-only. `release.yml` (tag push `v*` or dispatch) creates a bare GitHub
release (notes + source archive — no binaries) and publishes
`@harpy-run/harpy` via the `NPM_TOKEN` repo secret. There is no desktop shell.

Verify order: `npm run lint`. There is no `test` script.

## Smoke tests (manual, no npm script)

`scripts/*.mjs` are plain node scripts that hit a **running** server — start the
backend first, then `node scripts/smoke.mjs`.

- `smoke.mjs` — `BASE` defaults to `http://localhost:3001`. Performs first-run
  setup itself using `HARPY_SMOKE_PASSWORD` (default `secret123`). Asserts the
  WS `agent.agents` reply has exactly **7** adapters — keep this in sync if you
  add/remove an adapter in `server/agents/adapters/`.
- `agent-terminal-smoke.mjs` — `BASE` defaults to `http://127.0.0.1:3231`
  (different port — set `BASE` or run a second server on 3231). Requires at least
  one agent CLI on PATH and verifies sessions survive reconnect.

## Architecture boundaries

- Live filesystem sync: `fs.watch`/`fs.unwatch` subscribe a connection to its
  workspace; `fs:changed` pushes `{workspace, files:[{path,kind}], git}` to
  every subscriber (debounced ~120ms). Watching is per-directory
  (node_modules/caches skipped — inotify cost stays proportional to the
  source tree); `.git` top-level + `refs/` flag `git:true` so commits/pulls
  from any side refresh the Git panel instantly. Late-appearing `.git` dirs
  are picked up live. Client subscription is centralized in
  `src/lib/fs-watch.js` (re-arms on `harpy:ws-open`, re-points on
  workspace change); views just listen for the event.
- `server/` — Node backend. Entry `server/index.js` (`createHttpServer`/`startServer`);
  CLI `server/cli.js` (`harpy start [--port N] [--workspace PATH] | status | version`).
  One file per WS channel in `server/channels/`. `server/agents/runner.js` spawns
  agent CLIs via `node-pty`; `workspaceCwd` rejects any cwd outside the workspace (403).
  `server/activity.js` keeps a per-workspace JSONL event log (fs ops, watcher
  flushes, git, pty/agent lifecycles) behind the `activity` channel; workspace
  keys are canonicalized realpaths, and running agent sessions + activity
  subscribers pin the fs watcher so logging survives closed trees/clients.
  `server/share.js` backs the admin-only `share` channel and `harpy share`:
  it spawns a detached tunnel process (cloudflared / `ssh -R` to a sish relay /
  ngrok / zrok / bore.dk) that exposes the daemon on a public HTTPS URL. State
  lives in `$HARPY_HOME/share.json` (+ `share-opts.json` 0600 for restart),
  a persistent `share-key` ed25519 keypair is the sish identity, tunnel output
  appends to `$HARPY_HOME/share.log`, and `shareResume()` +
  `shareSupervise()` (dead pid → respawn, repeated `/api/health` probe
  failures → restart) keep the tunnel alive across daemon restarts and edge
  drops. The public-URL probe also compares the upstream `version` against
  this daemon's `VERSION` — a tunnel that answers as a *different* harpy is
  pointing at a stale/foreign server and gets re-spawned. bore.dk auth is
  headless-friendly: `share.boreLogin` shadows
  `xdg-open` with a shim to capture the auth URL, rewrites its
  `127.0.0.1:port/callback` to the caller's origin, and the public
  `GET /api/share/bore/callback` route (auth:false) proxies the redirect back
  to the local listener — sign-in works from any device, incl. phones.
  `share.probe` reports live tunnel health. Provider secrets are write-only —
  `share.json` masks them. The UI entry points are `ShareModal` (opened via
  the `harpy:share-open` window event), a slim `ShareCard` row in Settings,
  and the Remote view.
  `server/automations.js` is the event-driven automation engine: Markdown +
  frontmatter definitions in `$HARPY_HOME/automations/<ws-hash>/*.md` trigger
  agent runs (`on: fs|cron|webhook|session-end`) after an optional local
  `gate:` command exits nonzero — a clean gate spends zero tokens. fs
  triggers ride the existing watcher via `registerFsListener` +
  `pinFsWatcher`; cron uses a 30s unref'd tick; webhooks arrive at
  `POST /api/hooks/<slug>` (auth:false, HMAC `x-harpy-signature`/`x-hub-
  signature-256`, per-automation `whsec_` secret in
  `$HARPY_HOME/automations-state.json`); `setSessionEndHook` in runner.js
  feeds session-end triggers. Runs spawn through `startRunner` with a
  synthetic owner ctx and `automation: <slug>` — they show as normal
  sessions, are skipped by `restoreSessions`, never retrigger other
  automations, and `isolated: true` runs in a detached worktree under
  `$HARPY_HOME/worktrees/` (session-end cleanup + boot sweep). Cooldown,
  per-automation serialization and a 3-run global cap prevent loops.
  `workspaceCwd`/`workspacePath` take `{allowOutside}` only for that path.
  WS channel `automation` (list/read = access, save/remove/toggle/runNow =
  admin); `setAutomationNotifier` broadcasts `automation.changed`.
  `server/cli-shell.js` is the codex-style shell behind `Harpy Team`
  (the launcher's first pick) and `harpy chat`:
  plain text is a headless agent turn (adapter `buildArgs`/`buildContinueArgs`
  + `normalizeLine`, so every CLI renders the same stream), and `/commands`
  drive the daemon over a loopback WebSocket authed by
  `$HARPY_HOME/daemon/cli.key` (an `hp_…` key the daemon mints at boot,
  0600, removed on shutdown — same-host local capability, no password
  prompt). "Teams" are a `team` label on daemon agent sessions (start
  input → `sessionInfo` → persisted in `agent-sessions.json` → restored):
  `/team` opens a guided new-bot form (name · agent picker · task — `default`
  is the standing team), `/team ls|up|rm|down` manages bots, `/say`
  (broadcast), `/peek` (history), `/join` (raw passthrough, Ctrl-] detaches),
  `/sessions`, `/status`, `/daemon`, `/use`, `/cwd`, `/new`, `/update`,
  `/open`, `/set`. The same ops are scriptable as `harpy team
  ls|up|say|rm|down|sessions` — the surface agent CLIs drive;
  `server/agent-skills.js` installs `skills/harpy/SKILL.md` onto
  `~/.agents/skills/harpy/` plus existing `~/.claude`/`~/.config/devin`
  skill dirs at every daemon boot so bots learn to add/remove teammates
  on their own. `harpy chat
  [prompt] [-a agent] [--cwd dir]` is the flag-bearing entry — with a
  prompt (or piped stdin) it is a one-shot turn, otherwise the REPL.
  `harpy dash` keeps the old status menu. Continuations capture the
  provider's session id (`meta` events: codex `thread.started`, claude
  `system/init`) and resume it directly — `--last`-style fallbacks could
  attach to an unrelated daemon session.
- `src/` — Preact frontend. Entry `src/main.jsx` → `App.jsx`. State via
  `@preact/signals` (`src/state/`). Styling is **Tailwind v4** through
  `@tailwindcss/vite` (CSS entry `src/styles/tailwind.css`), not a tailwind config.
- `scripts/` — standalone smoke scripts (no npm wiring).
- `docs/superpowers/{specs,plans}/` — design docs.
- `public/` — static assets incl. `sw.js`, registered in prod by `src/main.jsx`.
- `dist/` and `harpy-projects/` are gitignored — never commit either.

## Agent adapters

Seven adapters live in `server/agents/adapters/`: `claude`, `codex`, `devin`,
`gemini`, `qwen`, `opencode`, `grok`. Each wraps an external CLI
detected via a PATH scan (`server/util/env.js` builds a service-friendly PATH
from the login shell plus well-known dirs, also used for agent/pty spawn env);
`available` is false if the binary is missing. Only `claude` and `devin` set
`interactive: true`. `buildResumeArgs` re-spawns a daemon PTY session after a
restart; `buildContinueArgs({prompt, sessionId})` is the shell's headless
follow-up path — adapters that can target a conversation id (codex
`thread.started`, claude `system/init`, opencode JSONL `sessionID`) resume it
directly rather than a global `--last`/`--continue`, which can attach to an
unrelated session; `captureSessionId({cwd})` covers CLIs whose output carries
no id (devin re-reads `devin list --format json` for the newest session).
Each adapter may also declare `static
install` (`{ command, windows? }`) — the CLI's one-line installer, shown in
the new-session modal so an unavailable agent can be installed in a visible
terminal. Detection results are cached in `$HARPY_HOME/agent-availability.json`
for 24h (probing scans the login-shell/known-dir PATH, not just the service
PATH); `agent.agents` with `{ refresh: true }` forces a re-check (the shell
exposes it as `/agents refresh` for CLIs installed after the first probe),
the server
re-probes hourly and broadcasts `agent.agents` when availability changes,
and opening the new-session modal triggers a fresh check. Adding an
8th requires updating `registerAllAdapters` **and** the `agents.length !== 7`
assertion in `scripts/smoke.mjs`.

## Auth & config

- First run requires setup: `POST /api/auth/setup` with a password >= 6 chars.
  State lives in `$HARPY_HOME/auth.json` (default `~/.harpy/`, mode 0600).
- Auth accepts JWT bearer tokens (24h TTL) **or** API keys (`hp_…`, issued via
  `/api/auth/keys`). WS auth passes the token as `?token=` on the `/ws` URL.
- Session expiry: JWTs live 24h. Client-side `ws.js` reads `exp` before each
  connect, probes `/api/auth/me` once when an upgrade is refused, and any
  non-login REST 401 clears the token — all paths fire `harpy:auth-expired`,
  which `App.jsx` listens for to drop back to `AuthGate`. Reconnects use
  capped exponential backoff (~1s→15s + jitter); `ws.close()` is re-armable —
  `connect()` clears the flag so the "server unavailable → retry" path can
  reopen the socket.
- Per-user CLI environment: `cli-env.json` (0600) maps each `sub` to
  `{env: {KEY: value}, home: bool}`. `cliEnvFor(sub)` merges those vars over
  the daemon env at every spawn (`agent` runner + `pty` channel) — a user with
  no record inherits the shared daemon credentials; `home:true` gives them a
  private `cli-home/<sub>` HOME (0700, lazily created) so CLI logins/configs
  don't collide. `agent.cliEnv`/`agent.saveCliEnv` ops are per-user and take
  an admin-only `for: <sub>` to manage a member's record (UserManager's
  "Private CLI home" toggle drives this); values are write-only (names only
  in responses). `PATH`/`HOME`/`USER`/`LOGNAME`/`SHELL` overrides are
  rejected — HOME is the flag's job.
- Multi-account access: `auth.json` keeps the owner account plus `users[]`
  (admin-created, `role` `admin`/`member`, `projects`/`agents` allowlists —
  `null` means unrestricted — and `disabled`). `resolvePrincipal` maps tokens to
  live users so disable/delete revokes mid-session; `accessFor(ctx)` is checked
  per op. `workspaceRoot(ws, ctx)` enforces the project allowlist across
  fs/git/pty/agent channels; `project` create/open/clone/browse and API-key +
  user management ops are admin-only. Members see filtered `project.list` /
  `agent.agents`, and `pty`/`agent` sessions stay isolated per `sub:clientId`.
- Env (see `server/config.js`): `PORT`/`HARPY_PORT` (3001), `HARPY_HOST`
  (`0.0.0.0`), `HARPY_HOME` (auth dir), `HARPY_PROJECTS` (projects dir,
  default `./harpy-projects`), `HARPY_WORKSPACE` (pin a single external
  workspace instead of numbered projects).
- GitHub sign-in has three tiers. Primary: **web OAuth** — `git.oauthStart`
  returns the app's authorize URL; GitHub redirects the browser to
  `/api/git/oauth/callback`, where `webComplete` swaps the code for a user
  token and adopts the profile. Requires a stored `clientId` + `clientSecret`
  (0600 `$HARPY_HOME/git-oauth.json`), produced automatically by the
  manifest bootstrap (`git.appBootstrap` → `/api/git/app/callback` — the
  manifest also registers the callback URL). Fallbacks: **device flow**
  (`git.deviceStart`/`devicePoll`, needs the app owner's manual Device-Flow
  opt-in — GitHub exposes no API for it) and manual PAT paste. A client_id
  saved without a secret (legacy or `HARPY_GITHUB_CLIENT_ID` /
  `git.saveOauthClientId`) can only use device flow.

## Conventions

- `"type": "module"` — every `.js` file is ESM; use `import`/`export`, never `require`.
- ESLint: `no-unused-vars` is an error (prefix unused args with `_`); `no-console`
  is off; browser + node globals both on; `sourceType: module`, JSX enabled.
- Frontend is Preact, not React — import from `preact`/`@preact/*`, not `react`.
- `harpy-projects/` holds managed per-user project workspaces selected via the
  title bar; their contents are runtime data, not part of this repo's source.
