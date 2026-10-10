# Agent Note: Gateway-scoped DSH request identity

Status: implemented

English | [中文](2026-08-25-dsh-gateway-request-identity.zh.md)

## Problem

OpenAI-compatible gateways could identify DeepSeek Harness from its static `User-Agent`, but they could not join an LLM call to the DSH session or configured provider route that issued it. Machine-bound credentials therefore collapsed unrelated DSH traffic into one caller bucket, while direct-provider DSH traffic remained visible only in the session log.

## Decision

`dsh-llm-pi-ai` sends `X-DSH-Session-ID` and `X-DSH-Provider` when the resolved profile has a `baseURL` whose path starts with `/api/llm` and the request carries `GenerateOptions.sessionId`. The adapter derives both values from the active request, and Harness-owned values replace case-insensitive profile-header collisions.

The identity is gateway-scoped. A direct provider endpoint does not receive either header, even when the request has a session id. This preserves the provider-neutral static attribution rule while giving private gateways enough opaque identity to audit DSH traffic. The DSH session log remains the authority for calls that bypass a gateway.

## Verification

The pi-ai adapter mock-server test sends one session through an `/api/llm` base path and one through a direct path. It asserts exact gateway headers, collision replacement, and absence on the direct request.

## Alternatives considered

**Send the headers to every provider.** Rejected because direct providers do not need local session correlation and may retain unknown per-session fields.

**Put identity fields in the JSON body.** Rejected because provider request schemas may refuse unknown fields, while HTTP headers cross OpenAI-compatible gateway implementations without becoming model input.

**Use the machine credential as identity.** Rejected because one credential serves many DSH sessions and provider routes; it cannot support per-session attribution.

## Consequences

Gateways can correlate streaming and non-streaming calls to DSH session records without seeing prompts or local paths. A gateway mounted outside `/api/llm` receives no dynamic identity until its route naming receives an explicit decision; this narrow detection avoids leaking session ids by endpoint analogy.
