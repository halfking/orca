---
name: zcode
description: >-
  Operate Z.AI's ZCode CLI coding agent from Orca: install/uninstall Orca's managed
  hooks into `~/.zcode/cli/config.json` (note the nested `hooks.events.<Event>`
  schema and the `hooks.enabled: false` default that must be flipped to `true`),
  detect the missing-TUI runtime trap via active capability probing, and watch
  ZCode's terminal output for the composer-ready idle signal. Use when the user
  says "zcode", "Z.AI", "~/.zcode", "zcode hooks", "zcode composer", or asks to
  install / uninstall / refresh ZCode integration in Orca settings. Do not use
  it for Claude Code, Codex, OpenCode, or Pi — those have their own skills.
---

# ZCode

This discovery stub loads the version-matched guide from the Orca executable used for this session.

## Resolve the CLI for this session

Choose the executable once and reuse it for every later command:

- If the `ORCA_CLI_COMMAND` environment variable is set, use its value. Orca exports this
  for managed WSL sessions.
- Otherwise, in a dev checkout whose session exposes `ORCA_DEV_REPO_ROOT`, use `orca-dev`.
- Otherwise, on Linux outside an Orca-managed terminal, use `orca-ide`. Never run bare
  `orca` there — outside Orca's terminals it normally resolves to the
  GNOME Orca screen reader (`/usr/bin/orca`) and starts speech on the user's machine.
- Otherwise, use `orca`.

Below, `ORCA` is a placeholder for the executable you resolved. Substitute it before
running anything; do not create a shell variable or run `ORCA` literally. This works
the same way in POSIX shells, PowerShell, and cmd.exe.

If the selected executable cannot run, report its exact error and stop. Do not fall through
to another executable, which could silently target a different Orca build.

## Load the version-matched guide before running ZCode commands

```text
ORCA skills get zcode
```

Prefer `--json`. Use the selected executable's `--help` for commands or flags the guide does
not cover. If a command reports that Orca is not running, start it with `ORCA open --json`
and retry. If it fails with `runtime_access_denied`, your sandbox blocked the connection:
re-run it with escalated permissions, and do not run `ORCA open` or restart Orca. If
`skills get` is unknown, explain that updating Orca restores the guide; use `--help` for
read-only discovery and do not guess unsupported commands.