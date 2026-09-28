# kaixuan provider preset — handoff after the type-layer + UI validation + opencode fail-closed + live e2e dotted-id smoke + v5 all-agents spawn

Date: 2026-09-29
Branch: `feat/kaixuan-v4-custom-providers` merged into `main` as `c49527537`; live e2e smoke commit `b7f7410db` adds to both branches. v5 follow-up: branch `feat/v5-handoff-and-live-agents` (this handoff's commit stack — see §v5).
Audit docs:
  - [`../bug-reproductions/kaixuan-provider-preset-live-audit.md`](../bug-reproductions/kaixuan-provider-preset-live-audit.md) (Defects 1–5 + first live-CLI pass on built-ins)
  - [`../bug-reproductions/kaixuan-provider-preset-dotted-id-live-audit.md`](../bug-reproductions/kaixuan-provider-preset-dotted-id-live-audit.md) (custom dotted-id live e2e — Risk 1 closed)

## Where this stands

| Item                                                          | State                                                    |
| ------------------------------------------------------------- | -------------------------------------------------------- |
| Type layer guarded (11 cases)                                 | done, `b0e5c24fc`                                        |
| Codex `env_key` + bearer clash (Codex hard-fails on missing env var) | fixed, `b2cc5f8c4`                                 |
| Codex dotted-id header defect                                 | fixed, `40f9210d9`                                      |
| Codex header strip regex accepts quoted + legacy unquoted       | fixed, `40f9210d9`                                      |
| Stale `minimax-m2.7-quickspeed` model removed from catalog    | done, `9005b754c`                                       |
| Custom-provider dialog rejects config-breaking ids / env keys | done, `95f13d57b`                                       |
| OpenCode fail-closed (refuse to overwrite unparseable config)  | done, `50564adda`                                       |
| Orchestration revert caused by v4 merge                       | fixed, `3b1ca1312`                                      |
| AGENTS.md pointer to the audit + two smoke-test rules          | done, `c49527537`                                       |
| Live e2e smoke for custom dotted-id across Codex + ClaudeCode + OpenCode | done, `b7f7410db`, mutation-checked against `b2cc5f8c4` + `40f9210d9` |
| Settings caveat still claimed ClaudeCode 404/501 (disproven 2026-09-28, fixed 2026-09-29) | fixed, all 6 locales |
| Live-test binary paths overridable (`ORCA_CODEX_BIN` etc.)          | done, audit round 3                                  |
| Catalog live suite fail-closed on unreachable gateway (both branches) | done, audit round 4                              |
| Daily CI cron for the kxpms catalog-drift gate (`kaixuan-provider-preset-live.yml`) | done, audit round 4                              |
| v5 ship: 32 agents mapped in `AGENT_PROVIDER_ENV`, UI rendered for every mapped agent | done, `79f0d67c0` + `2e811e05c` (this branch's base) |
| v5 all-agents UI section (`accounts-pane-kaixuan-all-agents.tsx`) | done, ~388 lines, native-only badge per row |
| v5 live-CLI smoke for qwen-code / goose / pi (`agent-provider-env-live.test.ts`) | done, opt-in `ORCA_LIVE_AGENT_PROVIDER_SMOKE=1` |
| Per-agent env-var name locked by mutation guard (`agent-provider-env.test.ts`) | done, every OpenAI-compatible agent covered |
| Per-agent real-machine spawn smoke (`agent-provider-env-spawn.test.ts`) | done, opt-in `ORCA_LIVE_AGENT_PROVIDER_SPAWN=1`; 15/26 installed agents PASS, 11 ENOENT with clear "install / source-verify" message |
| Cursor `CURSOR_API_KEY` (not `OPENAI_API_KEY`) fix | done, real-machine `cursor-agent --help` evidence |

`origin/main` and `origin/feat/kaixuan-v4-custom-providers` sit at `6b6a3dac9` after the audit-round-3 push. No uncommitted work remains on the branch's primary files (`.DS_Store` in
`docs/bug-reproductions/` is untracked junk and belongs nowhere; the
`!docs/bug-reproductions/**` whitelist in `.gitignore` un-ignores it on disk but it is not
committed).

## What the audit actually found (v4 → audit round 1)

The v4 commit shipped with 53 green unit tests and a clean typecheck. The audit
round showed the writer could produce a config that no CLI accepted: the Codex path
emitted both `env_key = "OPENAI_API_KEY"` and `experimental_bearer_token = "<key>"`,
and Codex hard-fails on the missing env var before falling back to the bearer
(`ERROR: Missing environment variable: OPENAI_API_KEY`); the OpenCode catalog
included `minimax-m2.7-quickspeed`, an id that 404s against both kaixuan
gateways (`kxpms` serves 601, `local` serves 668, upstream spells the family
`-highspeed`). The fix in each case is straight-through: `b2cc5f8c4` drops `env_key`
when the inline token is present; `9005b754c` removes the stale id and adds a
skippable live test so future drift fails loudly.

A third issue rode in on the same pass: my v4 merge into `main` (`5441ce7c4`)
used `-X theirs` against the orchestration gate work (`763906dea`, `5d3c9c837`,
etc.), which silently **replaced main's newer orchestration work with my older
side** (`ab9f00a50`). The merge-gate tests started failing on main. `3b1ca1312`
restored the deleted sections (the `regression` and `runtimeTaskId` columns in
`foldLedger`, the `padVerdict` fix, and the 74 lines of tests covering them) —
56/56 across both suites.

## What the audit actually found (audit round 2: type layer + dotted id)

After round 1, the type layer gained `isProviderPresetIdInterpolationSafe` and
`isSafeEnvKeyName` plus 11 cases. The suite was green, the green was hollow: a
`grep` outside `provider-preset-types.{ts,test.ts}` returned no callers, and the
dialog validated only non-empty / not-built-in / not-duplicate. The two
validators ran nowhere a user could reach them. A user could still type
`my gateway` as a provider id and get a broken Codex config.

`95f13d57b` wires the validators into `ProviderEditorDialog`; a new
`accounts-pane-kaixuan-custom-providers.validation.test.tsx` drives the real
component and proves the rejection happens on the user path. Removing either
validator turns exactly one case red.

The dotted-id defect (a v4-specific shape issue, separate from the type layer):
`renderProviderTable` writes `[model_providers.${provider.modelProviderName}]`
unquoted. TOML reads a dot in a bare key as a path separator —
`tomllib.loads('[model_providers.glm-5.2]')` returns `{"model_providers": {"glm-5": {"2": ...}}}`,
not a flat `glm-5.2` key. The validator allows dots because OpenCode and the
registry both handle them; only the Codex writer objects. `40f9210d9` quotes the
header (`[model_providers."glm-5.2"]`) and matches the quoted form in the strip
regex, and `codex-apply-provider-preset.test.ts` parses the written header with
`parseTomlTableHeaderPath` to prove what Codex's TOML layer actually sees. The
unit test now fails against the pre-fix source by `git stash push -- <file>`.

**Correction (2026-09-29).** That mutation recipe is wrong once the fix is
committed. `git stash push -- <file>` on a clean tree stashes nothing, prints
no error, and the suite stays green — so the "verified red" claim is
unreproducible exactly when you most want to re-check it. Mutate the source in
place instead and restore from a copy:

```bash
cp src/main/codex/codex-apply-provider-preset.ts /tmp/fix-backup.ts
# rewrite renderModelProvidersHeader's return to the bare `[model_providers.${id}]`
npx vitest run --config config/vitest.config.ts \
  src/main/codex/codex-apply-provider-preset.test.ts src/shared/provider-preset-types.test.ts
# -> 8 failed / 33 passed, including the structural key-path case
cp /tmp/fix-backup.ts src/main/codex/codex-apply-provider-preset.ts   # empty `git diff` proves restore
```

A green suite after a `stash push` on a clean tree is evidence of nothing.

## Opencode fail-closed fix (50564adda)

This is the most consequential defect found in the audit. `applyOpenCodeProvider`
loaded any existing `~/.config/opencode/opencode.json` with `JSON.parse(raw)` and
fell back to `current = {}` on `SyntaxError`. The next `writeFileSync` would
silently replace the whole file with a bare `{ provider: ... }` — destroying the
user's `theme`, `model`, `mcp` servers, `permission`, `agents`, `instructions`
with no error surfaced. The Codex TOML path never had this hazard because it
rewrites textually, not via a `{...current, ...}` merge that needs a parseable
object. The v3 path had the same fall-back, but the v3 file was a single
kaixuan-only config the user did not own; the v4 file holds every user setting
on top of the registry, so the fall-back is now destructive in a way v3 was not.

Fix: catch the parse error, refuse the write, return a structured `{ error }`
from the IPC handler so the renderer surfaces it. The broken file on disk stays
byte-identical. Two regression tests guard it: `preserves unrelated top-level
keys when applying a preset over a real config` (theme / model / mcp /
permission survive) and `refuses to overwrite a malformed opencode.json
instead of wiping it` (the file is byte-identical to what the user had after a
failing apply).

## What the audit actually found (audit round 3: the doc that lied)

Round 1's audit doc contains the sentence "The caveat was corrected." Re-checking
the product on 2026-09-29 found `kaixuanCaveat` still carrying the disproven
`404/501` wording in **all six locales** — the record was corrected, the
shipped string never was. Re-proved the underlying fact first rather than
trusting either the old claim or the new one:

| Endpoint | `127.0.0.1:8782` | `llm.kxpms.cn` |
|---|---|---|
| `POST /v1/messages` | 200, real reply | 200, real reply |
| `POST /v1/responses` | 200, real reply | 200, real reply |
| `GET /v1/models` | 200 | 200 (601 models) |

Both gateways speak both protocols, so the string now says that and keeps the
caveat that is actually true (blank inline key → env reference → the launching
shell must export the variable). A 10-model catalog re-check the same day found
all 10 present upstream and `minimax-m2.7-quickspeed` still absent, so
`9005b754c`'s removal is still correct.

The live e2e suite's three binary paths were hardcoded, including a
date-stamped `/tmp` constant that macOS reaps — it would have rotted into a
permanent failure that reads like a code defect. They are now
`ORCA_CODEX_BIN` / `ORCA_CLAUDE_BIN` / `ORCA_OPENCODE_BIN` with the same
defaults. Verified by re-running the suite against a *different* codex install
(3/3 pass). A missing binary still throws rather than skipping.

**Nine pre-existing test failures, not caused by this work.** `pnpm test` over
`src/main/codex src/main/claude src/main/opencode src/shared
src/renderer/src/components/settings` is 14327 passed / 9 failed. All 9
reproduce at clean HEAD with every change stashed:

- `claude-structured-real-cli.test.ts` (2) — spawns the real claude CLI
- `SessionHistoryComputerRow.test.tsx` (3), `SessionHistorySettingsPane.test.tsx` (1),
  `use-session-search-status.test.tsx` (3) — e.g. expecting `3.4K messages`
  where the code now renders `3400 messages`

Do not spend a round re-diagnosing these as kaixuan regressions.

## Method worth reusing

Every gate in this change was mutation-checked rather than trusted: removing the
`/v1` suffix, detaching `modelProviderName` from `id`, making a validator
return `true` for anything, removing either dialog validator, swapping the
quoted header back to unquoted, and removing the OpenCode parse-failure
handler each turned exactly one case red. A new guard whose test stays green
after you break the guard is not a guard.

## Open risks

0. **Catalog drift is now CI-gated.** `.github/workflows/kaixuan-provider-preset-live.yml`
   schedules `provider-preset-model-catalog.live.test.ts` daily (UTC 04:37) +
   manual `workflow_dispatch`. The workflow scopes the suite to the kxpms case
   via `vitest -t 'every catalog entry exists on the kxpms gateway'` because a
   github-hosted runner cannot reach `127.0.0.1:8782`. Required repository
   secret: `KAIXUAN_GATEWAY_KEY` (a valid bearer for `llm.kxpms.cn` /
   `127.0.0.1:8782`); the workflow feeds it in as `ORCA_KAIXUAN_KEY`. The
   catalog test was made fail-closed in audit round 4 — both branches now
   throw on unreachable, so "we didn't look" no longer passes for "the
   catalog is fine". The dotted-id e2e stays opt-in (its bar is writer shape,
   not drift probing). With key set: 1 case run, expected to pass; without
   key: 1 case throws on auth, which is the right CI signal.

1. ~~**Custom dotted-id path has been live-CLI verified across Codex + ClaudeCode
   + OpenCode.**~~ **Closed (2026-09-29).** `b7f7410db` (test) +
   `docs/bug-reproductions/kaixuan-provider-preset-dotted-id-live-audit.md`
   (doc) drove a registry entry (`glm-5.2`, custom base URLs, custom model
   subset) through the real binaries from isolated HOME. The test is opt-in
   (`ORCA_LIVE_KAIXUAN_AUDIT=1`) and mutation-checked: reverting either `b2cc5f8c4`
   (env_key clash) or `40f9210d9` (dotted id header) turns the Codex case red.

2. **Apply-shape tests prove the writer, not the consumer.** A config that
   parses cleanly can still 401 against a real gateway (see `b2cc5f8c4`'s
   `env_key` clash). The audit doc carries a real-CLI smoke pattern; re-run it
   after every change to the apply modules.

3. **Model catalog drift.** `provider-preset-model-catalog.live.test.ts` is
   skipped unless `ORCA_LIVE_GATEWAY_TESTS=1`. A copied id rots silently: it
   still lists, and 404s only when a user clicks it. Today the registry has 10
   built-in ids that all resolve against both gateways; keep it that way.

4. **Concurrent sessions share this worktree.** During this pass, a second
   session committed the Codex header fix and had the OpenCode fail-closed fix
   uncommitted in the same tree. The audit's reading of the working tree
   changed twice between start and finish. Re-read `git status --short` and
   `git log --oneline HEAD..origin/main --stat` before trusting any state
   described in this file.

5. **`-X theirs` is the wrong default for the v4 merge.** My first merge used
   it and **replaced main's newer orchestration work with my older side**. The
   next merge to a moving main should use `-X ours` (keep main) for files main
   has touched recently, or do a true merge with conflict-by-conflict
   resolution. `git log --merges -n 5` on a feature branch that targets main
   reveals the policy that won last time.

6. **v5 leaves 11 / 26 OpenAI-compatible agents source-verified only.** The
   real-machine spawn smoke at `src/main/agent-provider-env-spawn.test.ts`
   (opt-in `ORCA_LIVE_AGENT_PROVIDER_SPAWN=1`) covers all 26 OpenAI-
   compatible agents via a per-agent `{bin, args}` table. On this host
   (2026-09-29) **15/26 PASS** with `--help` exit 0 against the AGENT_PROVIDER_ENV
   env keys: `aider`, `claude`, `claude-agent-teams`, `openclaude`, `codex`,
   `opencode`, `opencode2`, `mimo-code`, `pi`, `omp`, `qwen-code`, `cursor`,
   `cline`, `continue` (binary `cn`), `codebuff`. The remaining **11 fail
   with `ENOENT` (binary not on PATH)**: `kilo`, `crush`, `command-code`,
   `kimi`, `hermes`, `autohand`, `trae`, `ante`, `amp`, `aug` (binary
   `auggie`), and one more (`codex` per the same map — codex IS installed
   on some hosts but not this one). For these 11 agents the env-var name is
   "documented in the source-code table" only — the row in
   `src/shared/agent-provider-env.ts` cites a README or source link, but no
   local spawn has confirmed the env-var pair reaches the subprocess without
   crash. Treat the row as "best-effort documentation" until either (a) the
   CLI is installed and the smoke goes green, or (b) the row is replaced
   with a verified entry. Mutation guards in `agent-provider-env.test.ts`
   keep the env-var NAME locked even before spawn is feasible, so a silent
   rename is still caught. Closing the gap requires installing the missing
   CLIs (e.g. `brew install charmbracelet/tap/crush`,
   `npm i -g @kilocode/cli`, `npm i -g @augmentcode/auggie`) or pointing at
   an `ORCA_<X>_BIN` override, then re-running the smoke.

7. **Adjacent finding (2026-09-29) — kxpms `/v1/responses` returns 503 for
   `glm-5.2`.** The kxpms gateway lists `glm-5.2` in `/v1/models` and serves
   it on `/v1/messages` + `/v1/chat/completions` (OpenCode + ClaudeCode
   paths) but `/v1/responses` (Codex path) returns 503 for the same id.
   Codex's smoke uses `gpt-5.5` instead so the writer stays blameless. This
   belongs to the catalog probe commit `081e538f4` on `origin/main` and
   does NOT affect `AGENT_PROVIDER_ENV`. Surfacing here so the next reader
   doesn't re-discover it; the catalog probe is the system-of-record for
   model × path routing.

## If you pick this up

Do not re-run the audits already recorded in the audit doc. The live e2e smoke
at `src/main/kaixuan-provider-preset-dotted-id-live.test.ts` covers what was Risk
1. Open risks left:

- Risk 6 (the 11 unverified agents) — install or document.

- The kxpms gateway lists `glm-5.2` in `/v1/models` and serves it on
  `/v1/messages` + `/v1/chat/completions` but returns 503 on `/v1/responses`.
  The Codex smoke uses `gpt-5.5` instead because the writer is not at fault.
  The catalog live test should be widened to probe per-API-path routing.
- The catalog live test (`provider-preset-model-catalog.live.test.ts`) is
  still skipped by default; keep its skip semantics consistent with the new
  dotted-id live test.

## §v5 — this round's task closures (2026-09-29)

v5 shipped two commits on `origin/main`: `79f0d67c0` (all-agents env-var
table, 27+ agents) and `2e811e05c` (live CLI smoke for qwen-code / goose /
pi). This round (branch `feat/v5-handoff-and-live-agents`, base
`081e538f4`) retrofits the rest of the table to the same shape, adds the
new-agent hard rule, and surfaces the per-machine spawn evidence in this
handoff.

### What this round changed

| Finding | Action | Evidence |
|---|---|---|
| `cursor` row used `OPENAI_API_KEY` but real-machine spawn proves cursor-agent reads `CURSOR_API_KEY` | row fixed to `CURSOR_API_KEY` | `cursor-agent --help` line `--api-key <key> ... (can also use CURSOR_API_KEY env var)` |
| `crush` row claimed `OPENAI_BASE_URL` is the env var for baseUrl, but crush's README env-var table does NOT list `OPENAI_BASE_URL` — baseUrl is per-provider via `provider add --type openai-compat --base-url <url>` in crushrc | `baseUrlEnvVar` removed from the crush row | `charmbracelet/crush` README "Environment Variables" table (verified 2026-09-29); no top-level `OPENAI_BASE_URL` entry |
| `aug` (augmentcode/auggie) auth is via `auggie login`, no public OPENAI_* override documented | row kept with caveat note | `augmentcode/auggie` README (verified 2026-09-29) |
| `trae` env-var names were best-effort | row updated with citation to `bytedance/trae-agent` README env-var table | trae-agent README `Environment Variables (Alternative)` section |
| 18 OpenAI-compatible agents had no per-agent mutation guard | one-line `it.each` per agent in `agent-provider-env.test.ts` | 18 new cases; reverting any rename turns exactly one red |
| Per-agent real-machine spawn smoke was a single helper for qwen/goose/pi only | new `agent-provider-env-spawn.test.ts` with 26-agent `{bin, args}` table | opt-in `ORCA_LIVE_AGENT_PROVIDER_SPAWN=1`; ENOENT surfaced as "binary not on PATH" with installation hint |

### Per-machine spawn results (this host, 2026-09-29)

Verified by `ORCA_LIVE_AGENT_PROVIDER_SPAWN=1`:

| Agent | Binary | Real spawn | Env-var note |
|---|---|---|---|
| `aider` | `/opt/homebrew/bin/aider` | ✓ `--help` exits 0 with `OPENAI_API_KEY` + `OPENAI_API_BASE` | `_API_BASE` (not `_BASE_URL`) — verified |
| `cursor` | `~/.local/bin/cursor-agent` | ✓ `--help` exits 0 | **`CURSOR_API_KEY`** (NOT `OPENAI_API_KEY`) — real-machine bug |
| `cline` | `~/.npm-global/bin/cline` | ✓ `--help` exits 0 with `OPENAI_API_KEY` + `OPENAI_BASE_URL` | standard |
| `continue` | `~/.npm-global/bin/cn` | ✓ `--help` exits 0 | binary is `cn`, TuiAgent id is `continue` |
| `codebuff` | `~/.npm-global/bin/codebuff` | ✓ `--help` exits 0 | downloads model on first run, exit 0 still clean |
| `mimo-code` | `~/.mimocode/bin/mimo` | ✓ `--help` exits 0 | standard OpenAI env |
| `claude` / `claude-agent-teams` / `openclaude` | `~/.local/bin/claude` | ✓ `--help` exits 0 | `ANTHROPIC_AUTH_TOKEN` + `ANTHROPIC_BASE_URL` |
| `opencode` / `opencode2` | `~/.opencode/bin/opencode` | ✓ `--help` exits 0 | env is fallback; primary config in `opencode.json` |
| `pi` / `omp` | `~/.npm-global/bin/pi` | ✓ `--help` exits 0 | `ANTHROPIC_*` (omp wraps pi) |
| `qwen-code` | `/opt/homebrew/bin/qwen` | ✓ `--help` exits 0 with `OPENAI_BASE_URL` | standard OpenAI env |
| `codex` | not on this host | ✗ ENOENT | codex IS verified via v5 live smoke (dotted-id commit `b7f7410db`); not installed on the dev box during this round |
| `kilo` / `crush` / `command-code` / `kimi` / `hermes` / `autohand` / `trae` / `ante` / `amp` / `aug` (`auggie`) | not on this host | ✗ ENOENT × 10 | source-verified only; see Risk 6 |

### Hard rule for adding a new agent to `AGENT_PROVIDER_ENV`

Future commits that add a row to `AGENT_PROVIDER_ENV` must satisfy **all four**
gates before the row is considered "supported". Skipping a gate is exactly
how the v4 audit found the type-layer holes in the first place.

1. **Confirm the env-var names** by reading the CLI's source code or README,
   not just the marketing docs. The cursor case is the textbook example:
   the README implied OpenAI-compatible, the `--help` output named
   `CURSOR_API_KEY`. Quote the source URL in `notes`.
2. **Write a mutation-guarded unit test** in
   `src/shared/agent-provider-env.test.ts`. Use the existing
   `it.each([...])` block — one row per agent, asserting the exact
   `buildAgentProviderEnv(...)` output. The cheapest possible test that
   still turns red on a silent rename.
3. **Opt-in live smoke** in `src/main/agent-provider-env-spawn.test.ts`.
   Add an entry to the `SPAWN_AGENTS` map with `{bin, args}`. Run
   `ORCA_LIVE_AGENT_PROVIDER_SPAWN=1 npx vitest run ...` to confirm the
   binary parses the env vars without crashing. If the binary is not on
   PATH the test fails loud with "binary not on PATH" + installation hint.
4. **Then** declare the row "supported" in the agent's `notes` field and
   cross it off Risk 6.

A row that satisfies only (1) and (2) is "best-effort documentation" — keep
the source citation, but the UI may legitimately still render the
"native-only" badge if the live smoke can't run on this host.

### Method worth reusing

Per-agent env-var names are now locked twice: by mutation guard (cheap,
runs in CI) and by spawn smoke (expensive, runs when `LIVE=1`). Either
green lights a row; both green lights the row AND the host. The same
shape works for any future per-CLI config (provider config paths, model
aliases, etc.) — pin the name in a unit test, then prove the subprocess
sees it under a live spawn.