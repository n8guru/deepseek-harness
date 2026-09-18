# Agent Note: Embed session list readiness

Status: implemented

English | [中文](2026-09-18-embed-session-readiness.zh.md)

## Problem

The compact existing-session route runs before UI mount, but client plugin activation does not await the Host session list. Selecting an existing pump session during that interval fails as an unknown session even when the Host lists it.

## Decision

The [embed initializer](../../../../apps/web/src/embed.ts) awaits the session service's shared `refresh()` before selecting an existing session. Focused page-curator creation remains unchanged. Host list failures and genuinely unknown sessions remain errors; the route never creates a substitute session.

## Alternatives considered

**Delay with a timer.** Host latency varies; elapsed time does not establish list readiness.

**Create or resume using the supplied identifier.** Creation could change ownership or start a different session instead of observing the requested one.

## Consequences

Existing-session embeds wait for the authoritative list and reuse an in-flight fetch. Startup can take as long as that fetch. Tests cover delayed success and failed refresh without selection or creation. The change requires rebuilding the Web shell, not restarting the Host.
