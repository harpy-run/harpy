---
name: harpy
description: Add, remove and direct teammate bots inside Harpy. Use when the user asks to "set up a bot", "add an agent", "create a team", "remove the bot", "takım kur", "bot ekle/sil", "ajan ayarla", "devin/claude ile bot yap", or wants agent work delegated to a background teammate. Everything runs through the `harpy` CLI — no interactive session needed.
---

# Harpy Team

Harpy's daemon (:3001) owns agent CLI sessions. A **bot** is a session running
a specific agent CLI (claude, codex, devin, gemini, opencode, qwen, grok) with
a standing instruction as its first prompt. Bots are grouped into named
**teams**; `default` is the standing team when the user doesn't name one.
Sessions keep running after any terminal closes — they live in the daemon.

## Commands

Run these directly — they are plain non-interactive subcommands:

- `harpy team ls` — teams and their member sessions (alias: bare `harpy team`)
- `harpy team sessions` — every session: `id · agent · status`, team-tagged
- `harpy team up <team> <agent> "<instruction>"` — **add a bot**. The quoted
  instruction is the bot's standing role — write it as "You only do X…", not
  a one-off task, so every later message builds on it.
- `harpy team say <team|sessionId> "<text>"` — broadcast to a whole team, or
  message one bot
- `harpy team rm <sessionId>` — **remove one bot**
- `harpy team down <team>` — stop every bot in a team
- `harpy daemon status` — check the daemon is up (commands fail without it)
- `harpy chat "<prompt>"` — one-shot question to the default agent

## Rules

- List before acting: `harpy team sessions` shows current members and ids —
  never guess a session id.
- `<agent>` must be an installed CLI: `claude`, `codex`, `devin`, `gemini`,
  `qwen`, `opencode`, `grok`. If a spawn errors with "not installed", say so.
- Prefer `default` as the team unless the user names one.
- `rm`/`down` are destructive — resolve the id with `ls` first.
- Specialization lives in the instruction: "a devin bot that only reviews
  code" = `harpy team up default devin "You are a code reviewer…"`.

## Examples

User: "devin ile sadece code review yapan bir bot ayarla" /
"set up a devin bot that only reviews code"

    harpy team up default devin "You are a code reviewer. Review the diffs and
    files you are shown; report issues by severity. Do not modify files."

User: "takıma test yazan bir bot ekle" / "add a test-writer bot"

    harpy team up default codex "You write unit tests. For each module you are
    given, produce tests — no refactors, no feature work."

User: "frontend takımına bir de claude botu koy" / "add claude to the frontend team"

    harpy team up frontend claude "You handle UI polish in the frontend team:
    layout, spacing, copy. Coordinate with teammates via the session feed."

User: "review botunu sil" / "remove the reviewer bot"

    harpy team sessions          # find its id, e.g. s_3
    harpy team rm s_3

User: "takıma login bug'ına odaklanmalarını söyle" / "tell the team to focus on the login bug"

    harpy team say default "New priority: the login bug. Investigate and report findings here."

User: "frontend takımını kapat" / "shut the frontend team down"

    harpy team down frontend
