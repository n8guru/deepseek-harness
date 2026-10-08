# Bounded old35af one-shot initial lineage — source acceptance only

Basis/HEAD35af2007587a757527b826ed3f4da32355ffcded unchanged.
Preserved predecessor staged TREE0d08552c11f1c93e7b5dbb6265a5436f58630453,
its /tmp/step73-old-source-candidate.patch and9tests/rebuiltLoader proof unchanged.
NEW staged SOURCE TREE8879892ee6d4e8034fadd21888fc3d677f25ac43 (NOT commit).
Delta STEP73-OLD-INITIAL.patch SHA256473d64b42d0c34dcc4a8bc08b5fbc27e39c52ee9f1f08c2f8796d3f93cf9c8b6.
Tree includes prior source candidate plus the10 bounded source/test paths below;
this new checkpoint/patch are separate evidence files, not circularly included.
No whole73pin/PASS, runtime activation or current-oldHost firstcutoff claim.

## Actual old API adaptation

Old ResolvedSubagentStartRequest had no child capability; old driver generated
child ID and fresh user message AFTER providerawait; old factory reserved only
at later create; Inbox admitted raw splices through globalassert; old run reader
could otherwise mistake CLOSED childidle for completed initial work.

Old SubagentRuntime.start now reserves delegate + exact publication/childID/
initialmessage BEFORE provider.start or any await. Serializable original request
fields are snapshotted/deep frozen; resolved request is frozen while actual parent
and AbortSignal identity remain untouched. Capability is frozen object identity,
privately indexed by HostCutoff WeakMap, bound to exact resolved request, live
parent, original signal, child ID and original message snapshot. Copied/forged
request or capability does not confer permission. Existing external providers
can ignore the optional capability but cannot use it to publish another child.

Canonical in-process driver validates exact original request identity, uses
reserved childID, and passes capability/parent/signal to existing factory. Factory
consumes one publication claim before setup; validates exact parent metadata
BEFORE consuming (failed negatives do not burn the good original). It publishes
through the existing transaction, commits exactly original initialmessage through
existing Inbox.splice with a narrowly typed one-shot capability, then consumes
the Inbox acceptance once. No ambient root opening or maintenance Agent facade.

Driver does NOT deliver a second fresh followup. When CLOSED it waits for actual
claim/cancel/owned disposal rather than idle fabricating a completed result.
Initial input is queued, but send does NOT force wake while globalcutoff CLOSED.
OPEN path uses existing driverwake and spends exactly one model turn.
Cancellation/result alone is not disposaljoin: publication reservation remains
until actual handle.dispose succeeds, delegate until actual run.dispose succeeds.
Failed start without authoritative returned handle remains UNKNOWN, not zero.
Capability survives only its reserved publication/initial acceptance; it does not
authorize later prompts, raw unrelated Inbox writes or new descendants.

## Changed source

packages/core/agent/src/admission.ts
packages/core/agent/src/index.ts
packages/core/agent/src/inbox.ts
packages/core/agent/src/runtime-types.ts
packages/core/agent-loop/src/agent.ts
packages/core/agent-loop/src/index.ts
packages/subagent/subagent/src/types.ts
packages/subagent/subagent/src/index.ts
packages/subagent/subagent-in-process-driver/src/index.ts
packages/core/agent-loop/tests/old-initial-lineage.spec.ts

## Concrete producer evidence

Affected canonical project references compiled exit0:
pnpm exec tsc -b packages/core/agent packages/core/agent-loop
  packages/subagent/subagent packages/subagent/subagent-in-process-driver
Log /tmp/step73-old-initial-compile.log.
New targeted source suite3PASS:
pnpm exec vitest run --project thread-safe
  packages/core/agent-loop/tests/old-initial-lineage.spec.ts
Log /tmp/step73-old-initial-tests.log.

Actual old service -> delayed provider -> canonical in-process driver ->
factory -> Agent/Inbox race proves preclose accepted original child publishes
afterclose, original immutable message and stable IDs, zero forced model turns.
Tests refuse copied/forged capability, copied/mutated resolved request, wrongchild,
wrongparent/metadata, wrongsignal, replayed initial acceptance, mutated Inbox input,
postclose ordinary followup, new factory/descendant/start. Original caller prompt
mutation during providerawait does not change accepted initial input.
Held input does not settle merely because Agentidle; cancellation can settle
result, but reservations remain until real disposal. OPEN canonical flow1modelturn/
1initial insertion, result-before-dispose does not retire reservations.
Aborted prepublication canonical request publishes nothing; no false join.

Jobs262–266 ALL collected, noneactive.262 compile failed optional property typing,
fixed by optional spread;263 compilepassed.264 test exposed parent metadata check
consuming the original capability before rejection; moved check beforeconsume.
265 affectedcompile+2tests passed.266 final3tests passed incl ordinaryOPENflow.
No assertions weakened, sandbox workarounds or unchanged9/Loader/backend suites
rerun. Diff checks passed.

## PRECISE remaining acceptance / receiver conditions

- This is SOURCE-alias native test qualification plus actual affected canonical
  TS emit, NOT a fresh bundled oldLoader/profile qualification. Old lib/index.js
  bundles/Loader fingerprints still refer to prior0d085 tree. Do not inherit them
  as proof for887989. Final exact bundled/profile proof remains separately needed.
- Old HostCutoff has no authorized maintenance release/resume controller. CLOSED
  initial input stays queued with pending result until cancellation/disposal or
  a future qualified native reopening/wake path; no controller/release was added
  or called in this unit. Do not claim delayed held work resumed.
- Initial lineage here is ONE-SHOT only. Old continuable materialization/compiler
  must bind its exact initial acceptance through actual SubagentInbox/catalog,
  guidance/image/auth and receipt semantics; NOT implemented or silently borrowed.
- Old workflows still lack actual all-producer join: old grace-abandon disposal
  remains UNKNOWN. No workflow/compiler/coverage expansion in this unit.
- Reservations/capability evidence are process-local. No durable authenticated old
  maintenance receiver/outbox/reservation recovery was added. Rebuilt/coldtransition
  guard is NOT proof already-loaded old saved ingress fenced or safefirstcutoff.
- Provider failure/no returned run keeps unresolved ownership UNKNOWN. An exact
  authoritative failed-publication cleanup/join receipt/reclamation path remains
  necessary before those rejected starts could certify actual idlezero.
- Unsupported/unmatched backend settlement still UNKNOWN. No inherited Agentidle,
  abort, processkill or quiet-time join inference.
- No notifier/supervision65 edits, rc2/adapter/currentturn/voice/oldhistory reset,
  production/profile/installed changes, newworker, stale137578 shared completion.
  Root canonical137796 owns evidence/independent review; partialsource is pending.
