# kaixuan provider preset — live-CLI audit and fixes

Date: 2026-09-28
Scope: the kaixuan provider presets that write Codex / ClaudeCode / OpenCode
configuration from the Orca settings UI.
Base: `main` @ `5441ce7c4` (kaixuan v4 custom-provider registry)
Fix: `b2cc5f8c4` (merged to `main`, pushed)

## Why this audit exists

The presets shipped with 24 green unit tests and a clean typecheck. Feeding the
generated files to the real CLIs showed the Codex path did not authenticate and
the OpenCode catalog offered a model that does not exist upstream. The gap was
verification method, not test coverage: every existing test asserted on the
string this code produced, never on whether a CLI could use it.

## Verified environment

| Component     | Version | How it was obtained                                                                                                                       |
| ------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| opencode      | 1.14.33 | pre-installed at `~/.opencode/bin/opencode`                                                                                               |
| claude        | 2.1.90  | pre-installed at `~/.local/bin/claude`                                                                                                    |
| codex         | 0.158.0 | installed for the audit: `npm i @openai/codex@0.158.0` into a throwaway dir; the `@openai/codex-darwin-arm64` binary was invoked directly |
| kaixuan kxpms | —       | `https://llm.kxpms.cn/v1` — 401 without a key, 200 with                                                                                   |
| kaixuan local | —       | `http://127.0.0.1:8782/v1` — 401 without a key, 200 with                                                                                  |

## Defect 1 — Codex aborted on `env_key` even when a bearer token was present

**Symptom.** The preset wrote both `env_key = "OPENAI_API_KEY"` and
`experimental_bearer_token = "<the key the user typed>"`. Real codex run:

```
ERROR: Missing environment variable: `OPENAI_API_KEY`.
```

The key the user entered was silently discarded.

**Cause.** Codex resolves `env_key` first and hard-fails when the variable is
absent; it never falls back to `experimental_bearer_token`. The two fields are
mutually exclusive in practice, even though the official schema only documents
them as alternatives.

**Fix.** `renderProviderTable` now takes the token and emits exactly one auth
field: `experimental_bearer_token` when a key is supplied, `env_key` only when
it is not.

**Proof (before/after, same config shape, live gateway).**

| Variant                                 | Result                                                |
| --------------------------------------- | ----------------------------------------------------- |
| `env_key` + `experimental_bearer_token` | `ERROR: Missing environment variable: OPENAI_API_KEY` |
| `experimental_bearer_token` only        | call completed, `ORCA_CODEX_FIXED_OK`                 |
| `env_key` only, variable exported       | call completed                                        |
| v4 code after the fix                   | call completed, `ORCA_V4_CODEX_OK`                    |

## Defect 2 — `minimax-m2.7-quickspeed` is served by neither gateway

**Symptom.** The OpenCode `models` map listed a model that 404s when selected.

**Cause.** The catalog was copied from a stale list. Upstream spells that family
`-highspeed` (`minimax-m2.5-highspeed`, `minimax-m2.7-highspeed`); there is no
`-quickspeed`. kxpms serves 601 models and local serves 668; this id is in
neither.

**Fix.** Removed. The remaining 10 were each checked against both live
`/v1/models` endpoints. Added a live test so the next drift fails loudly instead
of rotting silently.

## Defect 3 — a provider entry with no `models` map is never registered

Found in the earlier round and carried into this code. `opencode models <id>`
answers `Provider not found: <id>` for `{npm, name, options}` alone, even though
that JSON is valid and every unit test passed. The map is load-bearing.

## Earlier defects retained (v4 inherited the fixes)

- `api_key` is not a field in Codex's `[model_providers.<id>]` schema at all, so
  an inline token was dropped. Correct field is `experimental_bearer_token`.
- `requires_openai_auth = true` routes the provider through the OpenAI auth flow.
  On a host whose `auth.json` carries `auth_mode: "chatgpt"` the ChatGPT token
  has no scope for the gateway and fails `401 Missing scopes:
api.responses.write`. Third-party gateways need `false`.

## A UI claim that was factually wrong

The settings caveat said ClaudeCode "may 404/501 against the upstream until the
gateway team exposes an Anthropic-compatible route". Both gateways answer
`/v1/messages` with HTTP 200, and a real `claude -p` run against the generated
`settings.json` completed.

**This section claimed "The caveat was corrected" while the string was still in
the app.** A 2026-09-29 re-audit found `kaixuanCaveat` in all six locales still
carrying the disproven 404/501 sentence, so the audit record had been corrected
without the product being corrected. Re-verified both endpoints live on
2026-09-29 before changing the text:

| Endpoint | local `127.0.0.1:8782` | remote `llm.kxpms.cn` |
|---|---|---|
| `POST /v1/messages` | 200, real reply | 200, real reply |
| `POST /v1/responses` | 200, real reply | 200, real reply |
| `GET /v1/models` | 200 | 200 (601 models) |

The string now states that both gateways serve both routes and keeps the caveat
that is actually true — leaving the inline key blank writes an environment
reference, so the launching shell must export the variable.

**Lesson.** An audit doc asserting a fix landed is a claim, not evidence. When
re-verifying, grep the shipped artefact for the old text before believing the
record; `grep -c 404/501 src/renderer/src/i18n/locales/*.json` was the check
that caught this.

## Regression tests

| Test                                                      | Guards                                               |
| --------------------------------------------------------- | ---------------------------------------------------- |
| `never emits env_key alongside an inline token`           | Defect 1; verified red against the both-fields shape |
| `sets requires_openai_auth = false`                       | ChatGPT-auth hijack                                  |
| `embeds … as experimental_bearer_token, never as api_key` | dropped token                                        |
| `drops a previously embedded token when switching`        | stale secret surviving a preset switch               |
| `always writes a non-empty models map`                    | Defect 3; verified red when the map is removed       |
| `provider-preset-model-catalog.live.test.ts`              | Defect 2; live, skipped by default                   |
| `a dotted provider id lands as ONE flat model_providers key` | Defect 5; parses the header, so the unquoted shape fails it |
| `strips a legacy UNQUOTED table left by an earlier Orca version` | backward compat for configs on disk             |
| `kaixuan-provider-preset-dotted-id-live.test.ts`          | Defects 1 + 5 end-to-end on all three CLIs; opt-in   |

Both live tests are opt-in, so a plain `pnpm test` runs neither. Run them with:

```bash
ORCA_LIVE_GATEWAY_TESTS=1 ORCA_KAIXUAN_KEY=<token> \
  npx vitest run --config config/vitest.config.ts \
    src/shared/provider-preset-model-catalog.live.test.ts

ORCA_LIVE_KAIXUAN_AUDIT=1 npx vitest run --config config/vitest.config.ts \
  src/main/kaixuan-provider-preset-dotted-id-live.test.ts
```

The second one fails closed on a missing binary rather than skipping. Its three
binary paths are overridable — `ORCA_CODEX_BIN`, `ORCA_CLAUDE_BIN`,
`ORCA_OPENCODE_BIN` — because the codex path used to be a date-stamped `/tmp`
constant that macOS reaps.

## Reproducing the live checks

```bash
# model catalog vs both gateways (skipped unless opted in)
ORCA_LIVE_GATEWAY_TESTS=1 ORCA_KAIXUAN_KEY=<token> \
  npx vitest run --config config/vitest.config.ts \
  src/shared/provider-preset-model-catalog.live.test.ts

# codex: needs an isolated HOME so the real ~/.codex is not written
HOME="$(mktemp -d)" npx tsx <gen-script>
HOME="$(mktemp -d)" CODEX_HOME="$HOME/.codex" \
  /path/to/codex exec --skip-git-repo-check --model gpt-5.5 "Reply with exactly: ORCA_OK"

# opencode: XDG_CONFIG_HOME isolates the config directory
XDG_CONFIG_HOME="$(mktemp -d)" opencode models kaixuan-kxpms

# claude: CLAUDE_CONFIG_DIR isolates settings.json
CLAUDE_CONFIG_DIR="$(mktemp -d)" claude -p "Reply with exactly: ORCA_OK"
```

**Sandbox rule.** Any script that drives these apply functions must isolate the
home directory. `vi.mock` only applies inside vitest; a plain `tsx` import gets
the real `homedir()` and will write to the user's actual `~/.codex/config.toml`.
Set `HOME` (Codex follows it), pass `{XDG_CONFIG_HOME}` (OpenCode), or set
`CLAUDE_CONFIG_DIR` (ClaudeCode).

---

# Follow-up audit — the type layer had no guard, and its new guards were dead code

Date: 2026-09-29
Branch: `feat/kaixuan-v4-custom-providers`

The section above verifies the two _built-in_ presets against real CLIs. It says
nothing about the v4 custom-provider registry, which is the part a user can type
into. This pass closed that gap and then audited its own work.

## What the type layer was missing

`ProviderPresetDefinition` is consumed by interpolating its fields into generated
files, but the test file only asserted the two built-in endpoints. Nothing
covered the fields that actually get written. Added 11 cases in
`src/shared/provider-preset-types.test.ts`, each tied to a field a writer uses:

| Assertion                                               | Failure it prevents                                                                                                                                                            |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `isProviderPresetIdInterpolationSafe`                   | an id that terminates or splits a TOML header, a quoted TOML value or a JSON key                                                                                               |
| `isSafeEnvKeyName`                                      | an `env_key` / ClaudeCode env entry a shell can never export                                                                                                                   |
| `modelProviderName === id`                              | the strip regex is built from registry `id`s while the table header is written from `modelProviderName`; a divergence leaves the previous apply's table behind on every switch |
| `/v1` on codex + opencode urls, never on the claude one | a gateway called on the wrong path                                                                                                                                             |
| `opencodeModelIds` non-empty, duplicate-free            | Defect 3 above — no `models` map means the provider is never registered                                                                                                        |
| IPC result / bridge shape                               | a silently reshaped IPC contract                                                                                                                                               |

Mutation-checked rather than trusted: removing the `/v1` suffix, detaching
`modelProviderName` from `id`, and making the validator return `true` for
anything each turned exactly one case red.

## Defect 4 — the validators had no production caller

**Symptom.** The first pass added both validators plus an `it.fails('KNOWN GAP')`
case, and the suite was green. `grep` for callers outside the type module and its
test returned nothing: a user could still type `"my gateway"` as a provider id
and get a silently broken Codex config. The green suite was about the two
built-ins, which are constants and were never the risk.

The dialog validated only: non-empty, not a built-in id, not a duplicate. Its
placeholder actively suggested `glm-5.2` — an id that breaks the Codex path
(Defect 5 below).

**Fix.** The dialog now calls both validators before submit, and
`accounts-pane-kaixuan-custom-providers.validation.test.tsx` drives the real
component to prove the rejection happens on the user path. Removing either
validator turns exactly one case red.

## Defect 5 — a dotted id corrupts the Codex table header (FIXED `40f9210d9`)

`renderProviderTable` writes `[model_providers.${provider.modelProviderName}]`
unquoted. TOML reads a dot in a bare key as a path separator, verified with
`tomllib`:

```python
tomllib.loads('[model_providers.glm-5.2]\nbase_url = "https://x/v1"')
# -> {"model_providers": {"glm-5": {"2": {"base_url": "https://x/v1"}}}}
```

`model_providers["glm-5.2"]` does not exist, so the provider the config just
declared cannot be resolved. OpenCode and the registry handle dots fine, which
is why the validator allows them — restricting ids would cost OpenCode users a
legitimate key to fix a Codex-only problem.

**Fixed in `40f9210d9`.** The header is now written quoted
(`[model_providers."glm-5.2"]`, which TOML 1.0 reads as one flat key) and the
strip regex accepts the quoted, single-quoted and bare spellings, so configs
written by earlier versions and by hand are still cleaned up on a switch.
Verified against codex-cli 0.158.0: the bare form refuses to load the config
with `model_providers.glm-5: provider name must not be empty`, the quoted form
loads. The type-layer case moved from `it.fails` to a plain assertion, so
`glm-5.2` is now a supported id rather than a caveat.

This branch therefore keeps accepting dotted ids on the UI side, and the id
placeholder is back to the documented `glm-5.2`.

## What this round did not prove

*Superseded 2026-09-29.* The gap named here — a custom registry entry driven
end to end through the real CLIs — is now covered by
`src/main/kaixuan-provider-preset-dotted-id-live.test.ts`, which runs one
`glm-5.2` entry through Codex, ClaudeCode and OpenCode from an isolated HOME.
See `kaixuan-provider-preset-dotted-id-live-audit.md`.

Still open:

- **WSL path handling** (`codex-wsl-hook-install-plan`, legacy-shared-config
  compatibility) is untested against a real WSL host. Documentation-level only.
- **`experimental_bearer_token` writes a plaintext token** into
  `~/.codex/config.toml` at `0600`, with no keychain. Flagged, never addressed.
- **Both live suites are opt-in.** A plain `pnpm test` runs neither, so
  upstream gateway drift and future writer regressions stay invisible to CI.
