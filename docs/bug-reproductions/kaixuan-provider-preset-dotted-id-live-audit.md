# kaixuan provider preset — custom dotted-id live e2e audit

Date: 2026-09-29
Branch: `feat/kaixuan-v4-custom-providers` (HEAD `6c5267ef4` at run start)
Base: `main` @ `5441ce7c4` (kaixuan v4 custom-provider registry)
Test: `src/main/kaixuan-provider-preset-dotted-id-live.test.ts` (new in this pass)

## Why this pass exists

The handoff doc at `docs/bug-reproductions/kaixuan-provider-preset-handoff.md`
called out "risk 1" as the only path still uncovered by the v4 audit: a custom
registry entry (dotted id, custom base URL, custom model subset) driven
end-to-end through the **real** Codex / ClaudeCode / OpenCode binaries from
**isolated HOME** — not just unit-asserted on the on-disk string. Defects 1
(env_key + bearer_token double-write) and 5 (dotted id nesting into a sub-table)
were both discovered because a unit test wrote the wrong string to disk; the
hand-off wanted a guard that fails if any future writer change puts the binary
back into a state it cannot load.

## What was tested

A single `ProviderPresetDefinition` mirroring what a real user saves through
the AccountsPane registry form:

| Field                | Value                                  |
| -------------------- | -------------------------------------- |
| `id`                 | `glm-5.2`                              |
| `modelProviderName`  | `glm-5.2`                              |
| `codexBaseUrl`       | `http://127.0.0.1:8782/v1` (local gw)  |
| `claudeBaseUrl`      | `http://127.0.0.1:8782`                |
| `opencodeBaseUrl`    | `http://127.0.0.1:8782/v1`             |
| `envKeyName`         | `OPENAI_API_KEY`                       |
| `opencodeModelIds`   | `glm-5.2`, `gpt-5.5`, `mimo-v2.5-pro`  |

Each agent's `apply*Provider` was called, then the real binary was spawned
inside the same `isolatedHome` (set via `HOME` / `XDG_CONFIG_HOME` /
`CLAUDE_CONFIG_DIR`) with a real bearer token pointing at the local kxpms
gateway. The success gate for codex + claude is the literal string
`ORCA_KAIXUAN_DOTTED_OK` (the model was asked to reply with exactly that
token) appearing in stdout; for opencode the gate is the dotted id being
listed as a path prefix (`glm-5.2/<model-id>`) since `opencode models` is
a list command and does not call the gateway.

## Results

All three smokes pass against HEAD `6c5267ef4`:

| Agent     | on-disk shape verified                            | live binary verifies | Wall-clock (cold) |
| --------- | ------------------------------------------------- | -------------------- | ----------------- |
| Codex     | `[model_providers."glm-5.2"]`, no env_key alongside bearer, `requires_openai_auth = false` | `codex exec --model gpt-5.5` returns `ORCA_KAIXUAN_DOTTED_OK` in stdout; provider: glm-5.2 printed at startup | 7–57 s (variable) |
| ClaudeCode | `env.ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` | `claude -p ...` returns `ORCA_KAIXUAN_DOTTED_OK` | 6–9 s |
| OpenCode  | `provider["glm-5.2"].options.baseURL/apiKey` + 3-key models map | `opencode models glm-5.2` lists `glm-5.2/glm-5.2`, `glm-5.2/gpt-5.5`, `glm-5.2/mimo-v2.5-pro` | <1 s |

Defect 5 (quoted TOML header for dotted id, `40f9210d9`) and Defect 1
(env_key + bearer_token exclusivity, `b2cc5f8c4`) are now both **proven live**,
not just unit-asserted.

## New finding (not in prior audit rounds)

The kxpms catalog lists `glm-5.2` in `/v1/models` and serves it via
`/v1/messages` (anthropic) and `/v1/chat/completions` (openai), but returns
`503 No available provider for model 'glm-5.2'` on **`/v1/responses`** — the
endpoint codex uses because `renderProviderTable` writes
`wire_api = "responses"`. `gpt-5.5` is the only catalog model routable
through all three of the local gateway's API paths.

**Impact.** The Codex smoke uses `--model gpt-5.5` instead of the
registry's natural pick `glm-5.2`. The Orca writer is correct; the gateway's
model routing is incomplete. `gpt-5.5` happens to be in the opencode
subset we picked, so the test is not asserting on a synthetic model. The
catalog live test (`provider-preset-model-catalog.live.test.ts`) is the right
place to widen — it currently only checks `/v1/models` membership, not
per-API-path routing. Until that is added, a user who picks a model the
gateway lists but does not serve on the responses path will see
`Reconnecting... 1/5 ... 5/5` then `503 No available provider`. The
writer is not at fault; the catalog-level guard is.

## Mutation evidence

Per the "new gate must be proven to actually fire" rule, the test was run
twice with deliberate writer breakage against HEAD. Each mutation reverted
before the next run.

### Mutation 1 — Defect 5 regression: unquoted header

`renderModelProvidersHeader` was changed to return `[model_providers.${id}]`
(no quotes). Result:

```
× Codex: writes the dotted id under a quoted table header and the live binary accepts it
AssertionError: expected '\nmodel_provider = "glm-5.2"\n\n[mode…' to contain '[model_providers."glm-5.2"]'
  - Expected:  [model_providers."glm-5.2"]
  + Received:  [model_providers.glm-5.2]
```

The shape assertion fires before any binary spawn. Claude + OpenCode stayed
green because their writers were not mutated — confirming the gate is
targeted at codex only.

### Mutation 2 — Defect 1 regression: env_key alongside bearer token

`renderProviderTable` was changed to emit both `experimental_bearer_token`
and `env_key` when an inline token is provided. Result:

```
× Codex: writes the dotted id under a quoted table header and the live binary accepts it
AssertionError: expected '...' not to match /env_key.*glm-5\.2|glm-5\.2[\s\S]{0,200}env_key/
```

Note: with `process.env.OPENAI_API_KEY` exported in the test environment,
codex would still have completed the call (it would have used the env var,
silently discarding the inline token — the exact defect). The shape
assertion caught the regression before the binary had a chance to mask it.
This is the stronger guard: the writer shape itself is wrong, not just the
runtime behavior.

After both mutations were reverted, all three tests pass. The gate is
proven to fire.

## How to re-run

```bash
# Throwaway install of the same codex version the original audit used.
# Lives outside the worktree so it doesn't get committed.
mkdir -p /tmp/orca-kaixuan-audit/2026-09-29
cd /tmp/orca-kaixuan-audit/2026-09-29
npm init -y >/dev/null
npm install @openai/codex@0.158.0 --no-save

# The test is opt-in (it touches the real gateway + spawns real binaries).
# It also needs a valid gateway key — read from ACC_KAIXUAN_KEY (the
# kxpms local env convention) or ORCA_KAIXUAN_KEY (older audit convention).
cd /Users/xutaohuang/workspace/ai/orca
ORCA_LIVE_KAIXUAN_AUDIT=1 \
  ACC_KAIXUAN_KEY="$ACC_KAIXUAN_KEY" \
  pnpm exec vitest run --config config/vitest.config.ts \
    src/main/kaixuan-provider-preset-dotted-id-live.test.ts
```

Without the env var, all tests are skipped (default behavior, matches the
existing `provider-preset-model-catalog.live.test.ts` convention). Without
the key, the test fails fast with a clear "export ACC_KAIXUAN_KEY" error.

## Risks not closed

1. **The mutation proves the shape gate fires, not the call gate.** A
   writer that produces the right on-disk shape but a wrong effective
   model id would still let the call succeed with the wrong model. The
   ORCA_KAIXUAN_DOTTED_OK end-to-end check is a soft gate — it only
   confirms the gateway saw *some* valid call, not that it used the
   model id encoded in the apply. To make the model-id path a hard
   gate, the smoke would have to assert a response that depends on the
   model. The catalog subset `glm-5.2`, `gpt-5.5`, `mimo-v2.5-pro` is
   small enough to add per-model probes later.
2. **The test depends on the local gateway being up.** When the local
   gateway is off, codex + claude will time out. This is a CI concern,
   not a writer concern — the test is opt-in and the handoff already
   says the test belongs on a "live audit" runner, not in the default
   suite.
3. **The opencode writer mutation (drop the models map) was not run.**
   The shape assertion (`expect(modelIds.sort()).toEqual(...)`) would
   catch it on the unit-test side, but it was not verified end-to-end
   here. Re-run the mutation when changing the opencode apply path.

## Cross-references

- `docs/bug-reproductions/kaixuan-provider-preset-live-audit.md` — the
  previous round that proved the two built-in presets end-to-end.
- `docs/bug-reproductions/kaixuan-provider-preset-handoff.md` — the
  hand-off doc that named risk 1 as the only uncovered path.
- `src/main/codex/codex-apply-provider-preset.ts` — the writer under test.
- `src/main/claude/claude-apply-provider-preset.ts` — same.
- `src/main/opencode/opencode-apply-provider-preset.ts` — same.
- `src/shared/opencode-config-directory.ts` — why the opencode path
  short-circuits to `$XDG_CONFIG_HOME/opencode` (not `.config/opencode`).
