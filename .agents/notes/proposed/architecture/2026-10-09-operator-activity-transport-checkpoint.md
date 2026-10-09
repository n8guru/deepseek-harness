# Agent Note: Diagnostic operator activity transport checkpoint

Status: proposed

## Problem

The reviewed operator-activity/v1 specification requires socket-authenticated activity, authoritative native holds, durable gated receipts and checks at the final model-entry boundary. Shipping only the transport as release authority would allow incomplete control state to wake the conductor.

## Proposal

This source checkpoint implements the existing Gateway activity stream and explicitly authorized producer read through Connection. Socket/browser-auth lifetime, exact Agent identity, strict frames, monotonic age and heartbeat freshness produce diagnostic activity. It introduces no poller or runtime installation.

The snapshot always reports `eligible: false`, with Stop and goal unknown. An `activityGated` producer receives 409 for every admission. Ungated existing producers keep their previous behavior. Do not remove this refusal until native control transitions, persistence compatibility, ordered replay and final claim/pre-request enforcement are complete together. A raw authenticated WebSocket fixture is not proof of trusted GUI DOM provenance.

## Acceptance criteria

The complete requirements remain in [the reviewed specification](2026-10-09-operator-activity-snapshot.md). This checkpoint does not satisfy step70. Focused transport tests and compilation are recorded in `.agents/evidence/conductor-activity-checkpoint.txt`, along with four proposed continuation steps. Independent review and assembled GUI/profile qualification remain required before acceptance. Existing installation owners retain exclusive activation authority.

## Risks

Diagnostic control revisions observe sampled values, not all native transitions. No trusted GUI adapter, native Stop/goal integration, durable gated marker, or release predicate is supplied by this checkpoint. Old runtimes without v1 remain unsupported; no fallback activity inference or backport is implied.
