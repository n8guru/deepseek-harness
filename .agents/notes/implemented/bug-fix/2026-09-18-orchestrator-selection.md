# Agent Note: Orchestrator selection persistence

Status: implemented

English | [中文](2026-09-18-orchestrator-selection.zh.md)

## Problem

The native picker stores its last selection globally in the DSH origin. Inspecting a worker in another frame changes that restoration target, but must not change the Forage orchestrator's chosen session after a reload.

## Decision

The [selection bridge](../../../../apps/web/src/orchestrator-bridge.ts) observes the native session list only when an embedded window explicitly opts into an allowlisted Forage parent origin. It posts a selected, Host-listed session identifier to that exact parent origin; catalog-only child selections invalidate the candidate because they require a parent address. The parent owns its separate pin, validates the sending frame and origin, and requires an explicit Use this session confirmation before resuming the identifier through the existing-session embed route. A restored global worker is only a candidate, not an implicit replacement for the existing pin. The application context owns subscription disposal.

## Alternatives considered

**Read DSH storage from Forage.** Cross-origin access is prohibited, and the global value does not identify the orchestrator.

**Create a dedicated session implicitly.** That changes the user's choice and can create unwanted sessions. The native picker remains responsible for selection and creation.

## Consequences

The receipt contains only a session identifier, never transcript text, credentials, page context, or prompt authority. Normal top-level DSH and untrusted parent origins receive no receipt. Browser storage denial limits restoration to the mounted frame. Focused unit tests cover origin gating, selection changes and teardown; the assembled browser smoke covers native selection and reload after worker inspection. No agent transcript or model input changes.
