# Agent Note: Diagnostic operator activity transport checkpoint

English | [中文](2026-10-09-operator-activity-transport-checkpoint.zh.md)

Status: proposed

## Problem

The reviewed operator-activity/v1 specification requires socket-authenticated activity, authoritative native holds, durable gated receipts and checks at the final model-entry boundary. Shipping only the transport as release authority would allow incomplete control state to wake the conductor.

## Proposal

This source checkpoint implements the existing Gateway activity stream and explicitly authorized producer read through Connection. Socket/browser-auth lifetime, exact Agent identity, strict frames, monotonic age and heartbeat freshness produce diagnostic activity. It introduces no poller or runtime installation.

The snapshot always reports `eligible: false`. Native Stop and goal owners supply control state. A producer with explicit read and gated-admission grants can obtain held durable custody after exact tuple, freshness and native-hold checks. Connection rechecks the grant, live owner and activity after the awaited flush. No gated admission wakes input or authorizes model entry; final claim/pre-request enforcement remains separate. Ungated existing producers retain their behavior. A raw authenticated WebSocket fixture is not proof of trusted GUI DOM input.

## Custody persistence

Native staging records the complete ordered receipt selection and its original activity/control tuple in a required-on-read event before ordinary inbox insertion. An optional splice marker alone is unsafe: older readers could ignore it and run held input. The required event instead makes incompatible readers refuse the log, while marked splices also reject a missing custody record. Keeping messages in this event lets restart reconstruct interrupted insertion without a second queue. Projection caches use a new state version.

The staging result is in-memory evidence only; a participating successful Session flush is required before custody acknowledgement. Exact receipt-only retries may return original identities while held, but mixed retries require a current unheld tuple before new mutation. Neither custody nor duplicate or terminal receipts establish delivery. Recorded epochs remain historical, and all gated messages remain held. Admission/post-flush validation does not complete final model-entry checks or assembled qualification. The inherited canonical persistence-history compatibility finding remains an explicit qualification obligation; this admission delta changes no persisted types.

## Alternatives considered

A separate pending queue would duplicate native inbox ownership. Optional splice metadata without a required event would let older readers silently drop the hold. Neither is used.

## Acceptance criteria

The complete requirements remain in the reviewed specification, `2026-10-09-operator-activity-snapshot.md`. This checkpoint does not satisfy step70. Focused transport tests and compilation are recorded in `.agents/evidence/conductor-activity-checkpoint.txt`, along with four proposed continuation steps. Independent review and assembled GUI/profile qualification remain required before acceptance. Existing installation owners retain exclusive activation authority.

## Risks

Custody metadata does not authorize release: the staged path deliberately keeps every gated receipt held until complete native admission and final model-entry validation exists. Diagnostic snapshots and raw socket fixtures cannot establish those guarantees. Old runtimes without v1 remain unsupported; no fallback activity inference or backport is implied.
