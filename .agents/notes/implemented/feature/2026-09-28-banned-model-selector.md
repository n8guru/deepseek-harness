# Agent Note: Canon R20 banned models leave the selector

Status: implemented

English | [中文](2026-09-28-banned-model-selector.zh.md)

## Problem

Nate's approved board #4 N3a (2026-09-25) and Canon R20 retire Claude Opus 5, every GPT 5.6 id, GPT 5.5, Fable 5, Grok Build, and Claude Haiku as runners. Forage already refuses those pins at mint and claim (`BANNED_MODEL_RE` / `is_banned_step_pin`). The DSH catalog still advertised them through `session.models` / `llm.models`, and `session.selectModel` accepted any adapter-resolvable id, so the GUI and a mesh `selectModel` could still land on a banned launcher. Fable 5.1 remains an explicit operator pin and must stay selectable, but it must never become the Agent default.

## Decision

The Host gateway owns the selector contract. `buildModelCatalog` drops Canon R20 banned ids from every provider group after the adapter listing, matching forage's `BANNED_MODEL_RE` (fullmatch, case-insensitive, trailing `[1m]` stripped, last slash segment also tried so `grokheavy/grok-build` matches). `claude-opus-5-5` is not `claude-opus-5`. Fable 5.1 (`claude-fable-5-1`, `fable-5.1`, `fable-5-1`) stays in the groups.

`session.selectModel` refuses a banned request or resolved id with `model-unavailable` and a Canon R20 message before `resolveCallConfig` can accept it as the session selection. An explicit Fable 5.1 switch still applies to that session and is not written through `saveDefaultModelSelection`, so it cannot become the deployment default or a mesh-inherited seed.

## Alternatives considered

**Filter only in `settings.yaml` / the live `llm-pi-ai` model lists.** Rejected: the selector is built from every registered adapter, not from one settings document, and `selectModel` still accepts unlisted ids. Editing forge's home settings would not refuse a mesh call and would not travel with the DSH source.

**A new local-mod plugin that intercepts `session.models`.** Rejected: the Host already owns catalog assembly and selection; a second owner would race the gateway and miss `llm.models`.

**Treat Fable 5.1 as banned in the selector too.** Rejected by N3a: the operator may still pin it by name. Hiding it would force a raw unlisted switch.

## Consequences

Banned ids disappear from the advisory directory even when an adapter still serves them; a session whose log already names one keeps that current selection and is not rewritten. Mesh and GUI `selectModel` to a banned id fail closed with a readable message. Fable 5.1 remains an operator-only session pin. The live GUI is unchanged until an approved combined DSH restart; this change lives on the isolated branch until then.

## Testing

`packages/host/apiproxy/tests/api-proxy-models.spec.ts` asserts banned ids are absent from `session.models`, `selectModel` refuses each of them with the Canon R20 message, Fable 5.1 remains listed and selectable, and that selection is not saved as the default.
