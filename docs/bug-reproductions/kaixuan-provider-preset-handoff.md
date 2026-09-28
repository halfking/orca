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

`origin/main` and `origin/feat/kaixuan-v4-custom-providers` will sit at `b7f7410db` once the
push lands. No uncommitted work remains on the branch's primary files (`.DS_Store` in
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

## Method worth reusing

Every gate in this change was mutation-checked rather than trusted: removing the
`/v1` suffix, detaching `modelProviderName` from `id`, making a validator
return `true` for anything, removing either dialog validator, swapping the
quoted header back to unquoted, and removing the OpenCode parse-failure
handler each turned exactly one case red. A new guard whose test stays green
after you break the guard is not a guard.

## Open risks

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