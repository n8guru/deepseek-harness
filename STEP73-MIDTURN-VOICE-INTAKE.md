# Safe-boundary mid-turn/voice intake

Status: traced source boundaries only; NOT repaired, NOT caller-qualified, NOT live PASS. Prior old-basis unit and all jobs230–249 remain preserved/collected. No new test/build/background job or runtime action in this intake.

## Human delivery: two distinct contracts

Actual native session-controller `src/commands.ts:364–365` dispatches requested `steer` to Agent.steer; every other mode to Agent.followup. Agent implementation `agent.ts:181–185` maps followup to next-turn and steer to next-step. Its running loop claims next-step after toolwork (`:389`) and rereads next-step before closing (`:384–388`). An accepted queue request is not a promise of exposure before the current final. Composer explicitly supports queue/steer preferences and accelerated opposite-mode gesture (`ui-conversation/src/client/input/submission-policy.ts`). Without the accepted requests' actual mode, these cadence replies cannot truthfully be classified as a native delivery loss.

Separately, the staged Codex adapter has a concrete current-turn input omission: `src/index.ts:274–275` resumes pending tools using only `resumeTools`; that method `:179–189` sends tool results and clears pending. It does not deliver newly admitted user messages present in GenerateOptions.messages. `newUserInput` is used only on a new backend turn (`:278–282`). Therefore native next-step acceptance is insufficient to establish Codex current-turn visibility. This is source evidence, not a reproduction of the two workspace calls, and no turn/steer API has been invented or patched.

Remaining bounded qualification: actual workspace caller -> session prompt request mode -> native next-step surface -> compiled adapter -> supported app-server current-turn input delivery. Two ordered human messages must be tested during a blocked tool, with no forced cancel and before final. If requests are queue-mode, preserve next-turn semantics and test that explicitly; do not silently turn all followups into steering. For actual steer, inspect/prove supported app-server steering and exact turn identity before adding an ordered message-diff; do not embed human input falsely as tool output or replay historical user messages.

## Audio: exact observed silent branch and separate-owner handoff

Read-only served `/tmp/cadence-live-voice.js:1339–1367`: playSpoken records each spoken key and returns when `!wantSpeak() || !ownsSpeech(sessionId)` (:1348–1350), before speakQueue/enqueue. That explains a possible absence of synthesis/playback evidence, but does not prove which condition held in Nate's tab. Do not label remembered text heard. No browser ownership/toggle/lease was inspected or changed. No configured-voice playback success claimed. espeak-ng + pw-play was the wrong computer voice, not a fix or permitted fallback.

Embed handoff to Forage owner: `/tmp/cadence-workspace-live.html:13` outer iframe allow is `microphone; clipboard-read; clipboard-write`; `/tmp/cadence-dsh-slidein-live.js:103` inner iframe allow is identical. Both omit autoplay. This is a candidate permission-policy issue, not proven sole cause; owner must qualify both layers plus actual configured-voice bridge and truthful skip/failure statuses. No Forage or installed voice files changed.

## Preserved pins / review requirement

Native base HEAD 3ec93e07aa59ff66135e81202a54ccbc4c8f4eca; adapter base HEAD 0db2b77aa69c4e8ee4e4c40ed5462a086fe4300f; broker HEAD 7ea210851277fc89dfa779e456ef32b867c8bf30. These are bases, NOT immutable qualification of current dirty source. Old-basis staged tree 0d08552c11f1c93e7b5dbb6265a5436f58630453 remains a partial cold-transition source artifact, not first-live-cutoff proof. Whole73 immutable bundles, actual caller qualification, exact fingerprints and independent completed review remain required; root canonical137796 owns evidence/review. No stale137578 completion/shared writes.

## Bounded source repair / actual caller qualification (supersedes intake-only status above)

Implemented in staged adapter only: src/index.ts retains original user-message identities per actual Session and sends the ordered newly admitted next-step diff before ANY pending dynamic-tool result. Historical/duplicate identities are not resent, changed prior input or missing stable steering identity is refused. Existing image bridge remains the input conversion path. src/app-server.ts uses the real supported turn/steer RPC with threadId and REQUIRED expectedTurnId and checks acknowledged turnId. Rejection/mismatch propagates; no forced cancel, fake user-as-tool-output, implicit new turn, auth access or fallback.

Protocol checked offline for BOTH bundled @openai/codex0.146.0 and global codex-cli0.160.0. Both generated TurnSteerParams require expectedTurnId/input/threadId; both TurnSteerResponse carry turnId. This is schema support evidence, NOT an authenticated backend/model call. Global schema SHA857e7a2b061ae46ed6aedea6a5fddd3a6ce14f0334bf7eafaf10d4cbe68ec78b; bundled schema SHA045b76f2b01b72a7be57054eb9325b497914a5a6cfa3789a4228343691bead58.

New native packages/core/agent-loop/tests/midturn-codex.host.spec.ts exercises ACTUAL SessionCommandController.prompt -> real Agent/Inbox/native tool execution -> COMPILED staged adapter. Only remote model endpoint and unrelated resolver/attachment plumbing are keyless fixtures; this is NOT browser/HTTP/live delivery qualification. A blocked native tool receives both exact human texts as ordered steer-mode controller calls plus duplicate request. Before release, two pending next-step entries and no backend result. At safe tool boundary, one same-thread/same-turn steering publication contains both messages in order BEFORE the tool result/final; one native turn total. Queue-mode companion proves accepted inputs do NOT enter current turn: each of two ordered messages starts its own following native/backend turn, no steering.

Evidence: adapter tsc passed; affected prior adapter.test.mjs3passed; new midturn.test.mjs2passed validates ACTUAL transport method/precondition/receipt mismatch and rejected RPC. Native caller2passed, /tmp/step73-midturn-caller.log. Native production sources unchanged in this unit, so no unchanged Host/Client suite rerun. Jobs250/251 failed due invalid project names (no tests);252 one steering test passed;253 exposed mistaken test assumption that queue batches both messages, corrected to actual separate-turn semantics;254 final2passed. ALL collected; none active. Initial tsc failed on optional IDs/legacy envelope typing; repaired explicit stable-identity refusal and legacy envelope check, final tsc success.

Qualified file SHA256 (NOT commits or whole73 release pin):
adapter src/index.ts 7874096d143538911edd3fcef7fd92b94de2267c567f428d34c923c32f3764bc
adapter src/app-server.ts 351c32764e549d2f36c04ea8ae8f5a3e0643ad35736c508506c6ff3a84250a38
adapter lib/index.js 387d92835b78d37d4639bfa03d8ca222cc7a16c03229adac665a7ab3ec9b1b23
adapter lib/app-server.js c9587c551209ff41531bec517df241a80bfb79d822134e29d752a64e3861fea1
native caller test f92246e5c3def41dd37ee8ff1d28e04d60716837a142bdd3b1f503259d43d95a

Audio remains READ-ONLY intake, not repaired/played: the silent branch has no skip-status call; queue-construction failure only console.warn. Handoff must report correlated skipped-speaker-disabled vs skipped-not-speech-owner and queue-unavailable failure (never report heard/completed), preserving configured voice and lease policy. Actual condition at Nate's tab remains unknown. Forage owner alone should qualify autoplay delegation at BOTH previously identified inner/outer iframe allow attributes plus actual browser/configured-voice status. Missing autoplay is not proven sole cause. No browser access, espeak fallback, installed modification or Forage edit.

Remaining: actual historical request modes unknown; authenticated real backend live behavior not exercised; source native + compiled adapter fixture qualification is not final immutable Host bundle/profile proof. Audio telemetry and embed delegation need their actual owners/evidence. Existing tar .2 was NOT regenerated/relabeled; exact versioned publishing/final fingerprints and completed independent review remain before whole73 pin/PASS. Old-source staged TREE0d08552c11f1c93e7b5dbb6265a5436f58630453 and patch preserved with initial-lineage/compiler/workflow gaps, not expanded and not a commit/live first-cutoff proof.

## Next bounded implementation: staged skip/failure observability

Previous adapter repair/caller2PASS already delivered; not repeated unchanged in this unit. No further adapter edits. Implemented tools/voice-observability/{client.js,index.js,observability.test.mjs,README.md} in native-owned source tree only. Client is exact supplied served/installed read-only snapshot1.4.8 plus narrow observability, labeled1.4.8-step73-observability.1. Host snapshot adds vocabulary descriptions only; historical Host API is NOT mounted/rc2 qualified. README explicitly identifies inherited ABI and external bridge handoff, no new receiver/scheduler.

Actual staged playSpoken emits block_skipped with speaker-disabled/not-speech-owner for newly consumed text, retaining dedupe and zero queue calls. Queue exceptions emit bounded block_failed/queue-unavailable, never completed/heard. Existing reporter now publishes local correlated CustomEvent plus its original best-effort bridge POST; offline POST cannot change playback/preference/ownership. No actual bridge acceptance/query durability or browser state claim. Native Host snapshot description avoids false heard assertions; current reporter does not call its Host route, so boot/delivery qualification remains pending, not implied.

Checks: both JS syntax checks passed;5 targeted actual-function tests passed (two skip reasons/dedupe/no enqueue, bounded queue failure, eligible original enqueue and offline reporter, truthful staged Host vocabulary). No new background jobs. Supplied outer/inner embed artifacts contain no accepted-human request evidence, so original cadence queue-vs-steer mode remainsUNKNOWN. No sessions/accounts searched or auth copied.

SHA256 voice source candidate:
client.js 886ffd91c511bf7a061ce6b6a49bcec50a36975931a73a13f784217cf8d39be6
index.js cb5f50886356f3b861a11b4cb69a531e9b8fb10adcc9db43f7ca825c22355d69
observability.test.mjs 2dd41aa9c95dad9132831a6a52485592511fbe1940b947f66a229c8bfe24000c
Installed client remains1cb79c4ce7b1f20b802555c5fb466c16aafd5815153ea5d3741b324e5c0237bd, unchanged. These are file fingerprints, not release/commit pins.

Forage embed owner exact handoff unchanged: workspace outeriframe allow lacks autoplay at suppliedHTML:13; inner frame.allow also lacks autoplay suppliedslideinJS:103. Candidate permission issue only; separate owner must prove bothlayers plus actual configuredvoice/status/ownership and useractivation. Source-only audio observation implemented; deployment/profile/bridge schema/live playback remain unqualified. No installed edits, browser access, espeak, Forage edits, restart/reload/hold release, newagent or sharedcompletion. Oldsource partial tree/patch/history preserved.
