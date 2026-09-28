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

| Component | Version | How it was obtained |
|---|---|---|
| opencode | 1.14.33 | pre-installed at `~/.opencode/bin/opencode` |
| claude | 2.1.90 | pre-installed at `~/.local/bin/claude` |
| codex | 0.158.0 | installed for the audit: `npm i @openai/codex@0.158.0` into a throwaway dir; the `@openai/codex-darwin-arm64` binary was invoked directly |
| kaixuan kxpms | — | `https://llm.kxpms.cn/v1` — 401 without a key, 200 with |
| kaixuan local | — | `http://127.0.0.1:8782/v1` — 401 without a key, 200 with |

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

| Variant | Result |
|---|---|
| `env_key` + `experimental_bearer_token` | `ERROR: Missing environment variable: OPENAI_API_KEY` |
| `experimental_bearer_token` only | call completed, `ORCA_CODEX_FIXED_OK` |
| `env_key` only, variable exported | call completed |
| v4 code after the fix | call completed, `ORCA_V4_CODEX_OK` |

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
`settings.json` completed. The caveat was corrected.

## Regression tests

| Test | Guards |
|---|---|
| `never emits env_key alongside an inline token` | Defect 1; verified red against the both-fields shape |
| `sets requires_openai_auth = false` | ChatGPT-auth hijack |
| `embeds … as experimental_bearer_token, never as api_key` | dropped token |
| `drops a previously embedded token when switching` | stale secret surviving a preset switch |
| `always writes a non-empty models map` | Defect 3; verified red when the map is removed |
| `provider-preset-model-catalog.live.test.ts` | Defect 2; live, skipped by default |

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
