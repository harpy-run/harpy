# Contributing to Harpy

Thanks for helping improve Harpy. This file covers the workflow that keeps
reviews fast and merges clean.

## Getting started

```bash
git clone https://github.com/alicomert/harpy.git
cd harpy
npm install
npm start        # backend on :3001, in a second terminal:
npm run dev      # Vite frontend on :5199, proxies /api and /ws to :3001
```

The PTY backend is `@lydell/node-pty` — native binaries for Windows,
macOS and Linux (x64/arm64) ship inside the npm tarball as per-platform
optionalDependencies, so `npm install` needs no C++ toolchain. Do not
install with `--omit=optional`/`--no-optional`: that skips the platform
binary package and every terminal fails to spawn.

## Before you commit

```bash
npm run lint     # ESLint flat config — the only automated check
npm run build    # vite build must stay green
```

There is no unit test runner. For backend changes, `scripts/smoke.mjs` exercises
a running server (`node scripts/smoke.mjs`, `BASE=http://localhost:3001` by
default). Include a short screen recording or screenshots for UI changes.

## Conventions

- Everything is ESM (`"type": "module"`) — `import`/`export`, never `require`.
- Frontend is **Preact**, not React — import from `preact` / `@preact/*`.
- Styling is Tailwind v4 through `@tailwindcss/vite`; the entry is
  `src/styles/tailwind.css`. Long-standing custom styles live in
  `src/styles/global.css`.
- One WebSocket multiplexes channels (`fs`, `git`, `pty`, `agent`, `project`,
  `auth`, `activity`, `share`, `system`). New backend surface usually means a
  new op on an existing channel in `server/channels/`, not a new REST route.
- Agent adapters live in `server/agents/adapters/`. Adding one means updating
  `registerAllAdapters` and the adapter-count assertion in `scripts/smoke.mjs`.
- Unused variables fail lint — prefix intentional ones with `_`.
- Keep secrets out of commits: auth state, API keys, and tunnel credentials all
  live under `$HARPY_HOME` (default `~/.harpy/`), never in the repo.

## Pull requests

- Keep the diff scoped; unrelated cleanups belong in their own PR.
- Describe the *why* in the PR body, not just the *what*.
- If you are touching WS protocol frames, remember older clients may connect to
  newer servers — degrade gracefully instead of hard-failing.

## Translations

UI strings live in `src/i18n/locales/*.json`; `en.json` is the source of truth.
When you add a user-facing string, add the English key and a sensible value for
the locales you can cover — missing keys fall back to English.

## Reporting bugs

Open an issue with reproduction steps, the Harpy version (`harpy version`),
platform, and whether the backend or the frontend misbehaved. For security
reports use the private channel described in [`SECURITY.md`](SECURITY.md).
