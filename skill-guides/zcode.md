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

Use this guide when Orca needs to drive or recover Z.AI's ZCode CLI (`zcode`) running inside an Orca-managed terminal, or when the user asks to install, refresh, or remove the Orca↔ZCode hook bridge. Replace `ORCA` with the executable resolved in the discovery stub before running anything.

## Start Here

The discovery stub resolves `ORCA` to the executable you resolved in the stub; substitute it before running.

The stub covers POSIX shells, PowerShell, and cmd.exe; the same substitution rule applies in all three. If the selected executable cannot run, report its exact error and stop — do not fall through to another executable, which could silently target a different Orca build.

Prefer `--json` for agent-driven calls. Use the selected executable's `--help` for commands or flags this guide does not cover. If a command reports that Orca is not running, start it with `ORCA open --json` and retry. If it fails with `runtime_access_denied`, your sandbox blocked the connection: re-run it with escalated permissions, and do not run `ORCA open` or restart Orca. If `skills get` is unknown, explain that updating Orca restores the guide; use `--help` for read-only discovery and do not guess unsupported commands.

## Verify the ZCode integration before launching ZCode

`orca skills get zcode` is the entrypoint for the version-matched reference. Before spawning `zcode` itself, confirm Orca knows about the integration by reading its hook status. The status object is the same shape every agent returns, and `state === 'installed'` is the only condition under which ZCode will deliver hook events to Orca.

```text
ORCA skills get zcode
ORCA agent-hooks status --agent zcode --json
```

If Orca is not running, start it with `ORCA open --json` and retry. If `agent-hooks status` reports `not_installed` or `partial`, run `ORCA agent-hooks install --agent zcode` and re-check before launching ZCode. A `partial` state usually means one of:

- `events: <event-name>` — the managed hook script is missing from `~/.orca/agent-hooks/`. Reload Orca to re-emit it.
- `` `hooks.enabled` is false, so ZCode runs no hooks `` — ZCode ships `hooks.enabled: false` in `~/.zcode/cli/config.json`; the install path must flip it to `true`, otherwise no event ever fires.

## Install / refresh / remove the managed hook bridge

The bridge is bidirectional. Orca writes its managed script into `~/.orca/agent-hooks/zcode-hook.sh` and rewrites ZCode's `~/.zcode/cli/config.json` so that `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `Stop`, `SessionEnd`, `Notification`, and any future event name forward to that path through the shared hook-stub contract.

```text
ORCA agent-hooks install --agent zcode --json
ORCA agent-hooks remove --agent zcode --json
```

Each command reads back the status it just produced — read that field, do not infer state from the absence of an error. After install, confirm:

1. `~/.zcode/cli/config.json` contains `hooks.enabled: true` (the install path flips this from the ZCode default).
2. `hooks.events.<Event>` arrays carry exactly one entry per event, whose `command` is `sh '<home>/.orca/agent-hooks/zcode-hook.sh'`.
3. `~/.orca/agent-hooks/zcode-hook.sh` is executable (`-rwxr-xr-x`).

Removing the bridge is symmetric: every event entry whose command matches the managed-script path is dropped, and the script file is left in place unless `--purge-script` is added in a future revision. If the user wants ZCode's CLI completely untracked, remove the bridge, quit Orca, then disable ZCode's hook forwarding in its own settings if it offers one.

## Watch for the composer-ready idle signal

Orca's ZCode hook reports `idle` when the prompt composer becomes interactive (its banner appears in the transcript capture). This is the only signal that proves a ZCode pane is ready to receive input. Until it arrives, sending a prompt lands in a still-loading buffer and is dropped.

The hook payload lives at `~/.orca/agent-hooks/zcode-hook.sh`. It is invoked once per event with the JSON payload on stdin. Orca's runtime derives `idle` from the captured transcript using `zcode-composer-ready-banner` matching. Read it with `terminal read --source transcript` and check the resulting `state.idle` field before any `--send`.

When ZCode posts a `Notification` event, Orca surfaces it on the agent-status store; treat that as a transient notice, not a request for input.

## Detect the missing-TUI runtime trap

Some ZCode installations ship without the interactive TUI runtime, in which case `zcode --version` succeeds but `zcode` (no flags) prints a banner that does not match the composer-ready pattern. Spawning into it leaves the pane stuck at the banner and never transitions to `idle`.

The hook stub captures this banner in `~/.orca/agent-hooks/zcode-hook.sh`'s payload stream, and Orca's runtime treats the matching pattern as `missing-tui`. If the runtime reports `missing-tui`, the right action is to install the interactive runtime ZCode ships with, then re-run `ORCA agent-hooks install --agent zcode` so the in-place files refresh.

To verify without launching ZCode, run `ORCA agent-hooks capability --agent zcode --json`. The capability probe executes a fixed argv, parses for the banner, and reports `interactive` / `missing-tui` / `unknown` so an installer can decide before opening a terminal.

## Spawning ZCode from Orca

Use Orca's standard agent launch path; do not invoke the CLI directly. ZCode is listed in `ResumableTuiAgent`, so an Orca terminal can resume an existing session by id with `zcode --resume <session_id>`.

```text
ORCA terminal create --agent zcode --cwd <abs_path> --command 'zcode' --json
ORCA terminal create --agent zcode --cwd <abs_path> --command 'zcode --resume <session_id>' --json
```

Pass `--resume <session_id>` only when the user explicitly wants to continue a ZCode session by id — `--resume` reads the in-process transcript and may bypass fresh-start logic the user did not ask for. The `command` argv is verbatim; Orca does not translate flags between agents.

After spawn, wait for the agent-status store to flip to `idle` before any prompt send. A 30 s timeout is typical; longer is acceptable when the session is being resumed (ZCode rebuilds its context window).

## Resume an existing ZCode session

ZCode sessions live at `~/.zcode/cli/agents/<sess_id>/agent_<id>/{metadata.json,task.output}`. Orca scans that root and surfaces every metadata.json-bearing row in the AI Vault session list under `agent: zcode`. From the UI, click a row to spawn a resume; from the CLI:

```text
ORCA ai-vault list --agent zcode --limit 20 --json
ORCA ai-vault resume --session <sess_id> --cwd <abs_path> --json
```

`--cwd` must match the session's recorded `workspaceRoot`; a mismatch makes ZCode rebuild context that the user did not ask for. If the recorded `workspaceRoot` is missing or points at a moved path, prefer to spawn a new session in the current worktree rather than resume the stale one.

The same path applies to AI Vault search: `ORCA search --agent zcode "<query>" --json` returns ranked transcript snippets across the same directory tree.

## When `runtime_access_denied` blocks hook POSTs

`zcode-hook.sh` POSTs each event to `http://127.0.0.1:${ORCA_AGENT_HOOK_PORT}/hook/zcode` with `X-Orca-Agent-Hook-Token`. If the sandbox blocks the loopback connection, the hook reports `runtime_access_denied`. Re-run the install command under escalated permissions; do not modify the script or relax the token check. A failed hook POST is buffered to `~/.orca/agent-hooks/spool/` and replayed on the next event so no event is lost.

## Uninstall

Removing the managed bridge leaves the script at `~/.orca/agent-hooks/zcode-hook.sh` in place (the next install reuses it). If the user wants ZCode returned to its shipped defaults, run:

```text
ORCA agent-hooks remove --agent zcode --json
```

Then verify by re-running `ORCA agent-hooks status --agent zcode --json` and reading `state`, `managedHooksPresent`, and `detail`. `state === 'not_installed'` confirms ZCode's `config.json` has every managed event entry removed.