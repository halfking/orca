# kaixuan provider preset — handoff after the type-layer + UI validation + opencode fail-closed + live e2e dotted-id smoke

Date: 2026-09-29
Branch: `feat/kaixuan-v4-custom-providers` merged into `main` as `c49527537`; live e2e smoke commit `b7f7410db` adds to both branches.
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

1. **Custom dotted-id path has been live-CLI verified across Codex + ClaudeCode
   + OpenCode.** `b7f7410db` (test) + `docs/bug-reproductions/kaixuan-provider-preset-dotted-id-live-audit.md`
   (doc) drive a registry entry (`glm-5.2`, custom base URLs, custom model
   subset) through the real binaries from isolated HOME. The test is opt-in
   (`ORCA_LIVE_KAIXUAN_AUDIT=1`) and mutation-checked: reverting either `b2cc5f8c4`
   (env_key clash) or `40f9210d9` (dotted id header) turns the Codex case
   red. The live smoke stays opt-in because it needs a real bearer token and
   the local kxpms gateway; CI without those should not fail.

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

## If you pick this up

Do not re-run the audits already recorded in the audit doc. The live e2e smoke
at `src/main/kaixuan-provider-preset-dotted-id-live.test.ts` covers what was risk
1. Open risks left:

- The kxpms gateway lists `glm-5.2` in `/v1/models` and serves it on
  `/v1/messages` + `/v1/chat/completions` but returns 503 on `/v1/responses`.
  The Codex smoke uses `gpt-5.5` instead because the writer is not at fault.
  The catalog live test should be widened to probe per-API-path routing.
- The catalog live test (`provider-preset-model-catalog.live.test.ts`) is
  still skipped by default; keep its skip semantics consistent with the new
  dotted-id live test.

Both open risks were closed on `origin/main` as `081e538f4` (per-path probe on
`/v1/chat/completions`, `/v1/responses`, `/v1/messages` for every catalog id,
plus the local-gateway case rewritten to skip rather than throw when the dev
box is off). The merge into this branch is `1a29d8cb0`.

## §6 — this round's task closures (aac9ceae9 follow-ups)

Three independent follow-up items were closed on `feat/kaixuan-v4-i18n-renderer-handoff`,
branched off `origin/main` (`90e791f16`).

### T1 — mutation check on the opencode fail-closed guards

`src/main/opencode/opencode-apply-provider-preset.test.ts` carries **19 tests**
in total (the 17 pre-existing guards + the 2 new v4+apiKey regressions from
`aac9ceae9`). Mutation evidence: **17/19 → 1 red → 17 green**. With the
malformed-JSON guard from `50564adda` reverted (worktree-isolated against
`b7f7410db`), the test `refuses to overwrite a malformed opencode.json instead
of wiping it` turns red; the other 17 pre-existing tests stay green. The new
v4+apiKey tests stay green too — they pin the literal-token contract and the
`{env:OPENAI_API_KEY}` placeholder, not the malformed-JSON guard, so they are
not sensitive to this mutation. Net read: the fail-closed guard is observable
in the test suite; the two v4 regressions lock separate invariants and will
fail on their own regressions.

### T2.a — cancelled: no `.jsonc` handling

The candidate task was to add a `~/.config/opencode/opencode.jsonc` code path
(Codex + ClaudeCode accept either extension). Cancel basis: the user's
actual `~/.config/opencode/opencode.json` is real JSON, and opencode 1.x
reads `opencode.json` whether or not `opencode.jsonc` exists. Adding a
`.jsonc` reader would double the parser surface for zero observed value.
The literal-token + fail-closed guards already in place cover the JSON
shape that actually lands on disk. Re-open this item only if a user reports
their config arriving in `.jsonc` form.

### T2.b — implementation scope (committed as `aac9ceae9`)

- **`src/main/opencode/opencode-apply-provider-preset.ts`** — corrected the
  JSDoc on `applyOpenCodeProvider`. The previous comment claimed the literal
  path is "equivalent to `opencode auth set <id> <token>`", which is wrong:
  `auth set` writes `$XDG_DATA_HOME/opencode/auth.json` while this function
  writes `options.apiKey` inside `$XDG_CONFIG_HOME/opencode/opencode.json`.
  opencode 1.x accepts both at runtime, so behaviour was correct; the
  comment now names the actual file and key path.
- **`src/main/opencode/opencode-apply-provider-preset.test.ts`** — added 2
  tests that pin the v4 path through `applyOpenCodeProvider`:
  (a) `writes the literal apiKey verbatim when v4 applyOpenCodeProvider
  receives one` — the token lands in `provider['glm-5.2'].options.apiKey`
  and `npm` is `@ai-sdk/openai-compatible`; (b) `keeps the
  {env:OPENAI_API_KEY} placeholder when v4 applyOpenCodeProvider gets no
  apiKey` — the literal path must not default a token silently.
- **`docs/bug-reproductions/.gitignore`** — re-ignores `.DS_Store` and other
  OS junk under `docs/bug-reproductions/`. The root `.gitignore` whitelists
  the subtree with `!docs/bug-reproductions/**`, which also un-ignores
  Finder bookkeeping files; this new `.gitignore` keeps them out of the
  commit graph.

**No i18n changes in `aac9ceae9` itself.** `kaixuanApiKeyDescription` value
stays in its long English text; the renderer description in
`src/renderer/src/components/settings/accounts-pane-kaixuan-header.tsx` was
*not* touched by `aac9ceae9`. Translation work is a separate P1.

### T3 — i18n follow-up (`029dbb726`, on this branch)

After the §6 record landed, a separate i18n commit (`029dbb726`) shortened the
`kaixuanApiKeyDescription` value to a one-line security warning — the prior
text spelled out which files / keys were touched and which agents were
unaffected, which read as documentation, not a warning. The new text is
"literal token is written in plain text; restrict file permissions or export
the shell env var instead". Two files changed:

- `src/renderer/src/i18n/locales/en.json` — English value shortened.
- `src/renderer/src/components/settings/accounts-pane-kaixuan-header.tsx` —
  the inline fallback string matched to keep the no-translation case in sync.

The other five locales (`zh` / `ja` / `fr` / `ko` / `es`) still carry the
long version. That is intentional in the short term (the description was
considered English-only copy that translators can re-derive from the new
English source) but it does mean a non-English reader sees a different
description than an English reader. If that drift becomes a UX problem,
either revert `029dbb726` or have the i18n pipeline re-translate from the
shortened source. Out of scope for this branch.

### T4 — reconcile with `origin/main` (`1a29d8cb0`, on this branch)

`081e538f4` (per-API-path probe + local-gateway skip semantics) landed on
`origin/main` after this branch was cut from `90e791f16`. The merge
`1a29d8cb0` brings it in. Four files diverged between the branch tip and
`origin/main`; the merge was clean because each side modified different line
ranges:

- `081e538f4` (origin/main): `.github/workflows/kaixuan-provider-preset-live.yml`
  (filter widened from `every catalog entry exists on the kxpms gateway` to
  `kxpms` to include the new per-path probes) +
  `src/shared/provider-preset-model-catalog.live.test.ts` (per-path probes,
  local-gateway skip semantics, documented cost / reachability tradeoffs).
- This branch: `docs/bug-reproductions/kaixuan-provider-preset-handoff.md`
  (this §6 record + i18n commit note) +
  `src/renderer/src/i18n/locales/en.json` +
  `src/renderer/src/components/settings/accounts-pane-kaixuan-header.tsx`.

Tests run on the merged tree:

- `src/shared/provider-preset-model-catalog.live.test.ts` (9 cases registered,
  6 new from `081e538f4`) — all skipped without the live env var, as designed.
- `src/main/codex src/main/opencode src/main/claude src/shared` —
  13040 passed / 152 skipped / 1 expected fail, plus the two pre-existing
  `claude-structured-real-cli.test.ts` failures that pre-date this work
  (hand-off §3 / "Nine pre-existing test failures, not caused by this work").
- `src/renderer/src/components/settings/accounts-pane` — 16/16 green; the
  i18n change does not break the validation suite.