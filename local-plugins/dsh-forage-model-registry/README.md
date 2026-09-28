# dsh-forage-model-registry

DSH-side reader of the Forage mesh model registry
(`GET /api/mesh/model-registry`, project llm-model-catalog-compliance 1891788
step 16 — reader 6 of 6). The Forage side lives on branch
`agents/forge/task-133163` (`app/mesh_model_registry.py`, route in
`app/routes.py`, seed migration `mesh_model_registry_seed`, not applied).

This package holds **no model ids**. Every id a governed DSH route offers comes
from a registry row whose `pump.provider` is that route key and whose
`interactive_enabled` is not `false`; the row's `pump.model` is the DSH model
id and `name` / `modalities` become `name` / `input`.

## Library (`lib/registry.js`)

- `createRegistryReader({ baseUrl, token, ttlMs = 30000, host })` — TTL-cached
  read. Inside the TTL the snapshot is reused; past it the cache is evicted
  *before* the re-read, so a failed re-read never serves stale rows. Network
  error, non-200 (the server answers 503 `registry_unavailable` when it cannot
  read fresh) or a malformed body raise `RegistryUnavailable`.
- `admitModel(reader, route, id)` — fail closed. Refusal codes:
  `registry_unavailable`, `unknown_model` (no row claims the id or alias),
  `retired_model` (row has `interactive_enabled: false`), `wrong_route`.
- `curatedProviders(rows)` — DSH's curated provider list, derived from rows.
- `renderRouteModels(rows, route, current)` / `planSettings(...)` — the
  `llm-pi-ai.providers.<route>.models` list derived from the registry.
  `contextWindow` / `maxTokens` / `compat` / `reasoningEfforts` are carried
  from the current entry of a *surviving* id only (the registry does not record
  capacities); an id the registry does not claim is dropped, never kept.

## Generation / activation step

`llm-pi-ai` model lists are resolved synchronously from `settings.yaml`
(`packages/llm/llm-pi-ai/src/config.ts`), and the settings user layer
replaces arrays wholesale, so a plugin cannot overlay them underneath the
user file. They therefore stay a static file that is **generated** from the
registry:

```sh
cd local-plugins/dsh-forage-model-registry
export FORAGE_STUDIO_TOKEN=$(forage-secret get STUDIO_TOKEN)
node bin/generate.mjs                     # dry run: prints plan; exit 0 in sync, 3 drift
node bin/generate.mjs --write             # activation: rewrite governed lists only
node bin/generate.mjs --routes forage,forge_qwen38 --settings ~/.dsh/settings.yaml --base-url https://forage.ink
```

Exit codes: `0` in sync / written, `2` registry unavailable (nothing written),
`3` drift (dry run), `4` refused write (a governed route is not configured, or
the registry would leave it empty). `--write` keeps comments and every other
key, writes `<settings>.bak-registry-<timestamp>` first, and replaces the file
atomically. DSH re-reads `settings.yaml` on change; no restart is implied, but
open sessions keep the model they already selected.

**Activation is gated** (not done by the authoring task): it requires (1) the
Forage branch deployed and the seed migration approved/applied so the endpoint
answers 200, (2) an independent verifier PASS, and (3) the registry rows
extended to cover every `forage` id the operator wants to keep — against the
seed as authored, a dry run drops 19 hand-edited `forage` ids and keeps 3.
Default governed routes are `forage` and `forge_qwen38`; routes such as
`anthropic` are only governed when named with `--routes`.

Recommended cadence after activation: run the dry run from the operator's
health check (exit `3` flags drift) and `--write` from a timer no more often
than the registry TTL.

## Tests

```sh
node_modules/.bin/vitest run --config local-plugins/dsh-forage-model-registry/vitest.config.mjs \
  --root local-plugins/dsh-forage-model-registry
```
