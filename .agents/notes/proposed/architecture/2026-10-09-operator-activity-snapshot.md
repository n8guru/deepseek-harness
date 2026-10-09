# Agent Note: Authenticated operator activity in native Focus

Status: proposed

## Problem

The notifier can obtain durable notification receipts, but cannot tell whether an authenticated operator recently interacted with its target session. Focus inspection reports a hold, not activity. Generic user messages include programmatic prompts. A receipt is neither proof of a human gesture nor permission to release a held report.

## Proposal

Define **operator-activity/v1** as an extension of the existing native Focus owner and authenticated Connection/Gateway ingress. This document and the adjacent [wire schema](2026-10-09-operator-activity-v1.schema.json) are a source-only contract and adversarial test specification, not an implemented endpoint or live acceptance. Project conductor-relay step 69 owns this specification; subsequent authorized native implementation and notifier integration consume it. Installation remains with mesh-dsh-merge steps 71/72.

No second notifier, registry, polling service, transport, or scheduler is introduced. Retain the existing notifier's capture tick, durable pending journal, ordered receipt validation and producer identities. R13 result processing/capture continues while delivery is held; suppression must not cancel children, lose completion records, or require an LLM turn.

### Inspected source and extension points

Paths below are relative to the repository root. The published source pins and task provenance belong in the ledger evidence, not in maintained API documentation.

| Existing owner | Inspected behavior | Proposed bounded delta |
| --- | --- | --- |
| `packages/client/connection/src/index.ts`, `apply` | Registers browser-fenced `/api/session.focus`; separates producer-only `/api/notifications.admit` and maintenance ingress | Add a producer read action at the existing notification path, and explicit read/gated-delivery grants; keep browser controls separate |
| `packages/client/connection/src/browser-auth.ts`, `BrowserAuth.isAuthenticated`; `rpc-host.ts`, `requestRejection/admit` | Validates signed, expiring, authority-bound browser cookie after Host/Origin checks; all admitted requests share the operator Peer | Retain authentication; derive an opaque browser-auth binding and socket generation at the transport boundary, not from Peer equality or body labels |
| `packages/api/gateway/src/index.ts`, upgrade handler; `stream-server.ts`, `RemoteStreamMuxServer.handleUpgrade` | Authenticates the upgrade; binds streams to Peer and socket lifetime; existing ping/pong detects transport failure | Bind activity stream to the actual authenticated socket and epoch; reuse its heartbeat/lifetime, never infer human activity from pong |
| `packages/client/connection/src/client/index.ts`, `connection.generation` | Client runtime generation changes on readiness/reconnect | Invalidate client gesture capability on loss/replacement; its numeric generation is NOT a server authority or epoch |
| `packages/client/ui-conversation/src/client/input/editor/keymap.ts`, `view-binding.ts`; `service.ts`, `sendSession` | DOM submit travels through the composer to generic session prompt | Capture genuine interaction at the DOM boundary before async submission; no activity side effect in generic `sendSession` or `session.prompt` |
| `packages/api/session-controller/src/commands.ts`, `prompt`; `packages/sdk/server/src/server.ts` | Both browser and automation can create `kind: user` messages | Do not derive activity from message source, text, updatedAt, RPC id, timezone, or model turns |
| `packages/client/connection/src/notification-admission.ts`, `authenticateNotification/admitNotifications/controlFocus` | Bearer selects configured origin/session grants; ordered item receipts flush before ACK; inspect/set/check controls are browser-only | Read the same native activity state; recheck gated admission before mutation and after flush; never lend producer credentials browser authority |
| `packages/core/agent-loop/src/inbox.ts`, `isHeld/claim/admit/check`; `notifications.ts`, notification projection | Durable receipts, Focus and bounded explicit Check; `hasForeground` means non-notification input, not authenticated activity | Persist the gated-delivery marker with receipts and enforce the activity predicate at claim; keep explicit Check separate |
| `packages/goal/goal/src/index.ts`, `get`; `types.ts`, `GoalView` | Durable phase/revision and separate live armed/disarmed state | Read current state, including paused and disarmed; absence of service is unknown, not absence of goal |
| `packages/core/agent-loop/src/maintenance.ts` and native Host admission | Owner/run-bound maintenance and admission closure | Preserve all closure, receipt and prior-pause obligations unchanged; activity never opens admission |

These are inspection anchors, not a claim that the new data already exists. Graphify returned the Forage corpus rather than native DSH; native conclusions above were checked in the pinned files. A generic connected client or the current single operator Peer is insufficient to identify a foreground session.

### Authenticated foreground input

The existing Gateway multiplexed stream is the carrier. Add one narrowly typed `session.operatorActivity` logical stream, bound at upgrade to the validated browser-auth context and actual socket. Its open request is exactly `{version:1, sessionId}`. It requires the same browser cookie and Host/Origin validation as Focus, plus access to the exact existing target session. It cannot create/resume an Agent. Producer bearers, SDK/ACP peers, process launch tokens presented as activity credentials, and internal agent handles are not eligible. No cookie, bearer, principal id or capability is logged.

The server opening frame returns `{version:1, bindingEpoch}`, an unpredictable opaque generation unique to this host activation, socket and target session. Opening/reopening does not record activity. Each eligible frame is exactly `{version:1, bindingEpoch, sequence, interaction}`, where sequence is a strictly increasing positive safe integer and interaction is `input`, `submit`, `focus-control`, `stop`, or `leave`. Bindings cannot be selected by a caller's origin/session/clientId header. A different session needs a new stream binding. A stale epoch, repeated sequence or invalid field changes no state and returns a typed rejection; duplicates do not refresh time.

The shipped GUI adapter emits input/submit/control/stop only from an actual trusted DOM event in a visible, focused view of the bound session. Check `event.isTrusted`, document visibility/focus and the active session at the event boundary, not after an upload/await. Input includes keyboard/pointer interaction within the session view (not pointer movement, rendering, scrolling caused by code, voice synthesis or a heartbeat). Do not submit draft content or keystrokes. Synthetic dispatchEvent, programmatic composer submission, background tab callbacks and queued retry closures cannot emit qualifying frames. A human-origin voice submit may qualify only through a separately authenticated existing UI gesture binding; automatic transcription or a voice-worker message alone cannot.

The server records its own observation time only after authentication, epoch/sequence validation and current binding checks. Unknown keys such as `origin`, `isHuman`, `clientTime`, `lastActivityAt`, `trusted` or `principal` are rejected, not ignored. Browser origin headers are anti-CSRF/rebinding checks, not an identity claim. A body asserting foreground never grants anything.

This authenticates a trusted GUI's report, NOT biological presence. Cookie theft, XSS or automation controlling the authenticated GUI can impersonate that GUI; browser userActivation/isTrusted are local checks, not remotely verifiable attestations. The security boundary assumes the operator GUI and its credential are trusted, as existing Focus controls do. If resistance to a compromised operator browser is required, this contract is insufficient and requires a separately approved attestation design. Ordinary programmatic prompts, even with operator RPC authority, never qualify by themselves.

A leave frame is emitted on blur, hidden view or session switch; it invalidates that binding for release without refreshing activity. Socket close, auth expiry/revocation, host restart, client reload and session disposal invalidate it server-side too. Reconnect creates a new epoch with no qualifying activity, and old queued gesture frames are discarded rather than replayed. No tab may withdraw another tab's binding. Multi-tab selection uses only currently valid bindings: most recent server-observed qualifying event for this exact session wins (ties use server sequence); a newer socket without a gesture cannot displace it. No activity from another session is borrowed.

### One producer read contract

Extend existing `POST /api/notifications.admit` with a discriminated read-only body:

```json
{"version":1,"action":"activity","sessionId":"conductor-session"}
```

The legacy `{sessionId, items}` branch remains notification admission, never a read or an activity write. The read branch is authenticated by the existing producer bearer, Host/Origin checks and exact sessionIds grant. Add explicit host-provisioned `activityRead: boolean = false` to that producer grant. Do not infer this from notify or maintenance authority. Read yields the schema-defined snapshot, `Cache-Control: no-store`, zero session creation, zero Check, zero wake and zero activity writes. A producer without the read grant receives 403 without revealing activity. A browser cookie alone does not authenticate this branch.

Add `activityGated: boolean = false` to the same host-provisioned notification producer grant. The notifier integration must require both explicit grants and version 1; it cannot fall back to ungated delivery. Configuration/credential installation is a later authorized action, not authorized by this specification. Per-request `activityGated:false` is forbidden. Other producer grants retain their existing semantics.

The snapshot exposes no prompt text, browser IP, raw credential, stable browser fingerprint or cross-session activity. Exact fields are in the wire schema. An opaque binding epoch is correlation, not authorization. `principalClass` is `authenticated-operator-gui`, never a user-supplied label. Missing/unknown versions or malformed snapshots fail closed in the consumer.

### Time, freshness and state

Default `idleThresholdMs = 300000` (five minutes). Host configuration may select an integer from 1000 through 3600000; invalid values fail startup, never silently default. A producer cannot select a longer threshold. This is inactivity since qualifying session interaction, not a measure of how long the session has been running.

Use a host monotonic clock for age/expiry. Export server UTC epoch milliseconds for observedAt and lastActivityAt only as diagnostics; never compare the producer's wall clock to decide release. Wall-clock rollback, a clock continuity failure, or an impossible future observation makes activity unknown until a new valid observation establishes it. A process restart changes hostEpoch and invalidates live activity even if historical timestamps were persisted.

A snapshot is immediately useful to the client for at most `snapshotTtlMs = 5000`, measured with its own monotonic elapsed time since receipt; it must still be revalidated by native admission. Reading repeatedly does not refresh activity. Transport freshness reuses the existing Gateway heartbeat: a binding must be open and have a server-observed pong (or accepted qualifying frame) within two configured heartbeat intervals. An interval <= 0, unreadable freshness, or expired authentication is unknown. Lazy checks on read/admission/claim suffice; no new timer is required. Pong updates transport liveness only.

| state | Definition |
| --- | --- |
| unknown | No current qualifying event/binding, missing control/service/schema, failed auth continuity, restart/reconnect without a new gesture, or corrupt/unsupported activity state |
| stale | There is a prior qualifying observation, but its socket/epoch/visibility/auth/liveness is no longer valid; historical time is diagnostic only |
| idle | Valid current binding and liveness, but monotonic activity age is greater than or equal to idleThresholdMs |
| active | Valid current binding and liveness, and activity age is nonnegative and strictly less than idleThresholdMs |

Unknown/stale/idle never release automatically. A newly connected idle browser remains unknown; an existing browser that only answers pings becomes idle. At the threshold equality, hold. Fresh input while Focus is enabled can make activity active but cannot remove the hold. Merely clearing Focus cannot resume a paused/disarmed goal.

The snapshot reads native Focus, Stop, goal and Host admission in one synchronous cut. Native Stop latches a session-local background hold even when there is no goal; expose it as `stop: clear/stopped/unknown`. Stop may record the operator gesture but can never release notices. Only a subsequent explicit authenticated foreground submit/resume clears that Stop hold through the native owner; typing, pong, reconnect, clearing Focus or producer admission cannot. Unknown Stop state holds. This requires the implementation to bind the existing native cancellation event into its control state, not infer a stop from an idle Agent. `focus` is enabled/disabled/unknown; `goal` is none, unknown or the exact id/revision/phase/activation; `hostAdmission` is open/closed/unknown. Missing goal is none only when the loaded authoritative goal service confirms it. Closed or unknown admission, stopped/unknown Stop, unknown Focus/goal, enabled Focus, paused/blocked goal, or an active-but-disarmed goal means held. Complete/no goal does not itself hold notifications; this never arms goal continuation. Also defer while native foreground input or an active foreground turn owns the next boundary.

Server-owned `activityRevision` increments on activity/binding selection or invalidation; `controlRevision` increments on Focus/Stop/goal/admission/foreground-boundary changes. Both are scoped to hostEpoch and target session. A revision cannot be supplied as a state mutation. The snapshot's eligibility is diagnostic only; expiry can change eligibility without a revision.

### Native admission and release race

A gated producer submits the existing ordered items with `activityGuard: {version:1, hostEpoch, bindingEpoch, activityRevision, controlRevision}`. The guard is the exact tuple from its recent active snapshot, not a bearer or one-time release ticket. No guard, old epoch, altered revision, ineligible current state or missing native capability yields 409 with no new mutation. Ungranted/forged origin remains 403/400. Before mutation, synchronously recompute age, freshness, exact live Agent identity and every hold from native state; never trust a caller's eligibility or timestamps.

Persist the gated marker with each admitted receipt in the existing native notification projection. Guard validity before enqueue is not sufficient: native `inbox.isHeld/claim` and the last pre-request admission boundary must recompute the same predicate for these notices. Existing per-origin/per-sequence dedupe, payload-conflict rejection, exact ordered ACK coverage and flush-before-ACK remain. No raw requestId or notification text is used as human provenance.

After each async persistence/admission boundary, recheck Agent ownership and holds before wake/model entry. If a hold wins after durable insertion, acknowledge durable custody with `accepted:true, delivery:"held"`, ordered receipts and the current snapshot; keep notices held in the native inbox. `delivery:"eligible"` means only currently eligible, never delivered or user-seen. Unflushed/unknown durability never receives accepted ACK. On a lost ACK, replay the same items: exact existing receipts are returned in request order even if activity is now held; this receipt-only replay adds no message, releases nothing and wakes nothing. A mixed replay/new batch must pass current gating for the new items; otherwise refuse the entire request before new mutation.

On the next qualifying interaction/hold-clear event, the existing native inbox wake path may schedule the held batch only after rechecking at an idle boundary, with no fresh LLM turn for an unchanged hold. It does not arm goals, disable Focus or reopen maintenance. The selected release set is bounded to the existing maximum of ten items and fixed in order before persistence. A late arrival belongs to the next batch; persisted selection alone must not bypass a later hold. Larger local queues release across later eligible bounded snapshots, not by raising the limit.

Linearization: a Stop/Focus/goal-pause/maintenance-close event ordered before the batch's final native claim wins; no gated message enters the next model request. If the batch already entered before the hold, record that order honestly and preserve native Stop's cancellation-before-next-tool behavior; do not claim to retract a request already sent. A concurrent foreground prompt is not cancelled to deliver reports. Existing children and jobs continue under their existing controls.

Explicit browser Check remains a separate operator-authorized bounded action, not a notifier escape hatch. Activity/read/reconnect cannot call it. A manual Check may retain its existing explicitly selected-message semantics; it never converts all idle-held messages to ungated, unpauses goals, or opens Host admission.

### Durability and compatibility

Retain last server-observed activity only as a session-local diagnostic in the existing native state/projection; no new presence database. Live epochs, authorization and monotonic validity are process-local and must not be revived from disk. Fold/fork must not inherit a parent's live activity. Unknown persisted versions hold, not fail open. Implementation must follow the repository's persistence-type acknowledgement and adjacent-version rules; this specification changes no released type.

Keep reviewed old-Host maintenance receiver, initial-admission, disposal/join and cold-transition obligations intact. An old Host without operator-activity/v1 is unsupported for gated notification release, not approximated through updatedAt or browser credentials. Notifier retains its durable pending queue and reports the missing version without waking the conductor. This contract neither requires a speculative old-source backport nor treats reviewed old-source controls as providing the new activity field.

## Alternatives considered

- Use user/message, updatedAt, hasForeground or session.presence: rejected because programmatic traffic and reconnect can produce these without human interaction.
- Give the notifier the browser cookie or call Focus Check on every tick: rejected; it widens authority and can start a turn merely to ask whether a turn is safe.
- Add a separate activity daemon/database/poller: rejected; Connection, native Focus, Gateway heartbeat, goal projection and the existing notifier already own the needed lifetimes.
- Trust a signed snapshot as irrevocable permission: rejected; even a genuine snapshot cannot stop a later Focus/Stop/goal-pause race.
- Require WebAuthn for every gesture: not selected; it changes operator interaction and attestation policy beyond the authorized trusted-GUI contract.

## Acceptance criteria

The **specification** is complete only after an independent cross-provider reviewer accepts the schema, threat boundary, owner mapping, thresholds and cases below on the exact published native pin. Schema validation checks shape only; neither that nor this table is implementation or live proof. Run the adjacent `2026-10-09-operator-activity-schema-check.py` with Python and `jsonschema` installed for executable positive/negative wire examples. It uses no server, credentials or model. Timing, provenance and concurrency cases below remain mandatory future native tests, not assertions that the shape checker proves.

The later native implementation must use real authenticated HTTP + Gateway stream boundaries with fake time and a keyless model adapter. Extend existing `focus-transport.host.spec.ts`, `focus-profile.spec.ts`, `focus-native.spec.ts` and Gateway transport tests rather than substitute notifier mocks. Every negative case asserts unchanged activity timestamp/revisions (except legitimate invalidation), zero unauthorized releases and zero new model turns; observe durable events as well as function returns.

| ID | Adversarial arrangement | Required observation |
| --- | --- | --- |
| A01 | Real authenticated GUI, exact session, trusted visible gesture | Server time recorded; new epoch/sequence bound correctly; active snapshot; no turn from the activity frame itself |
| A02 | Missing/wrong bearer or cookie; forged Host/Origin; null/cross-site origin | Authentication/trust refusal; no state leaked or updated; matching labels never authorize |
| A03 | SDK, ACP, mesh prompt, generic operator session.prompt, synthetic DOM submission | Prompt behavior unchanged; none updates operator activity |
| A04 | Producer adds origin/foreground/isHuman/clientTime fields; clock far in past/future | Strict 400; no timestamp import, overflow or field stripping to an accepted body |
| A05 | Correct GUI credential but wrong session binding, epoch or replayed sequence | Refuse; no cross-session presence and no replay refresh |
| A06 | Reconnect, refresh, host restart, auth expiry/revocation, stale queued event | Old tuple invalid; new connection without gesture unknown; old timestamps never restore active |
| A07 | Visible tab hides/blurs/switches; second tab opens, idles or leaves | Only its own binding invalidated; latest still-valid qualifying same-session binding chosen; hidden gestures ignored |
| A08 | Pong-only browser; missed-heartbeat boundary; closed socket | Pong changes liveness only; old interaction becomes idle at 300000ms; stale after freshness loss |
| A09 | Ages 299999, 300000, 300001ms; snapshot used after 5000ms; wall rollback | Strict boundary; client refetch after TTL; native recheck refuses aged state regardless of client clock |
| A10 | Missing goal service vs authoritative no goal; disarmed active, paused, blocked, complete | Unknown/paused/blocked/disarmed hold; none/complete alone do not hold; no goal resume side effect |
| A11 | Active gesture during Focus hold or maintenance close | Activity may update, delivery stays held; prior-pause state and owner/run fence unchanged |
| A12 | Snapshot then Focus/Stop/goal-pause/foreground arrival before insertion | 409, no insertion/release/wake; existing work not interrupted |
| A13 | Same races injected during flush, after ACK and immediately before claim | Durable custody may ACK held; claim excludes gated messages; zero post-hold model entry |
| A14 | Notification enters, then human Stop, with and without a goal | Durable order proves entry preceded Stop; no next tool after cancellation; subsequent notices held even with no goal; typing/reconnect cannot clear Stop, explicit human submit can; no false claim of retroactive prevention |
| A15 | N ordered notices, lost ACK, fresh notifier process, identical retry while idle | Same exact ordered receipt identities; no duplicate or wake; native-held custody survives; reordered ACK rejected by notifier |
| A16 | Duplicate sequence with changed payload; mixed old/new batch while held | Conflict/refusal before new mutation; journal/cursors not advanced without exact durable coverage |
| A17 | Ten selected notices plus a racing eleventh; stop between selection and claim | Fixed bounded order; eleventh excluded from that selection; all held when Stop wins |
| A18 | Repeated reads/ticks/unchanged holds; R13 results and worker completion | No activity refresh or LLM turns; child processing, result capture and durable pending retention continue |
| A19 | Read grant absent; read-only grant; activityGated grant with omitted/forged guard | Least privilege enforced; read never delivers; mandatory gating not bypassed by legacy body |
| A20 | Old Host, unsupported schema, storage failure, alternate driver, fork | Fail closed, no accepted durability claim on failure; no fallback activity inference or inherited live epoch |
| A21 | Browser Check with explicit id vs producer read/reconnect | Check stays bounded/idempotent under original controls; producer cannot invoke it |
| A22 | Boot reviewed old-source and rc2 control suites alongside new cases | Existing authenticated maintenance, reservations, initial admission, Stop, child disposal/join and no-auto-activation obligations remain passing |

## Risks

The intentional trusted-GUI boundary cannot detect credential theft or browser automation controlling the operator surface. Passive reading produces no gestures and eventually holds reports; no attempt is made to infer attention from gaze or screen contents. Credential binding and stream lifetime must remain server-owned despite today's shared operator Peer. Native claim-time gating is necessary: a notifier-only check is unsafe. Updating durable receipt types requires reviewed schema/version work in the implementation step. No installation, restart, control release, account change or live conductor probe is authorized here.
