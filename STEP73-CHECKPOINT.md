# Step73 source checkpoint

Native source only. HEAD `3ec93e07aa59ff66135e81202a54ccbc4c8f4eca`; pending merge basis `639ed015397290b3745d163aafe02ffee4aa3f84` (exact rc2). Release foundation staged; feature edits unstaged/new; no unresolved conflicts at last check. Preserve `.r84-evidence` and all work. No new commit/publication/PASS or production changes.

## Own changes

Tracked edits: packages/client/connection/{package.json,src/index.ts,tsconfig.host.json}; packages/client/ui-conversation/src/client/queue/QueueDock.tsx; packages/core/agent-loop/src/{agent,inbox,index}.ts and tests/inbox.spec.ts; packages/core/agent/src/{runtime-types,types}.ts; packages/core/session/src/known-event-types.ts; packages/goal/goal-round-driver/src/index.ts and tests/goal-round-driver.spec.ts; packages/jobs/tool-jobs/src/index.ts and tests/tool-jobs.spec.ts; packages/schedule/schedule/src/runtime.ts; packages/subagent/subagent/src/continuation-activation.ts.

New product/tests: packages/core/agent-loop/src/notifications.ts and tests/focus-native.spec.ts; packages/client/connection/src/notification-admission.ts and tests/focus-transport.host.spec.ts; packages/client/ui-conversation/src/client/queue/FocusControl.tsx and tests/focus-control.client.spec.tsx. Temporary diagnostic-only `.step73-vitest.config.ts` and `.step73-typecheck.mjs` must not ship.

## Actual results

Delegate reported temporary-resolver Vitest: core Inbox7+Agent9+Focus1+Goal52=69 pass; latest Focus2+cancel44 pass; jobs60+schedule34 pass; UI3 pass. Individual command transcripts not retained in parent context. Initial broad workers247/410 passed,163 failed;18 fake inbox cases subsequently repaired; remaining durable cases unqualified. Logs `/tmp/native-workers-test.log`.

Normal `node_modules/.bin/tsc -b tsconfig.client.json --pretty false` exited2: missing rc2 workspace dependency links/generated remotes including react/jsx-runtime, ws, @vitest/spy/controller types. Log `/tmp/native-client-tsc.log`. Actual HTTP+JSONL caller test fails missing @deepseek-ai/node-addon-system-linux-x64 persistence addon; no mocked durability. `git diff --check` against rc2 passed per delegate. No successful normal full build or shipped-profile snapshot; inline Context+Goal snapshot is not built-profile proof.

## Resume attempt4 commands

- Working directory confirmed native named tree; Node v22.23.1, pnpm11.7.0.
- `pnpm install --frozen-lockfile > /tmp/step73-native-install.log 2>&1`: jobs `bash-67`, `bash-68`, `bash-69` exited1 OUTDATED_LOCKFILE. Paired my new Connection workspace deps with native pnpm-lock importer and removed duplicate llm/session devDependencies; job `bash-70` completed exit0 same frozen command. Native `pnpm run build:native-system` succeeded (linux-x64 system.node); chained Host/all Client build job `bash-71` in flight initially emitted notification projection readonly mismatch; corrected schema arrays to readonly. Normal dependencies Focus/durable-caller/UI test job `bash-72` in flight, log `/tmp/step73-native-focus-tests.log`. Build logs `/tmp/step73-native-addon-build.log`, `/tmp/step73-native-host-build.log`, `/tmp/step73-native-client-check.log`. Native isolated install/build newly authorized; no reference or production install.
- Fresh graphify query attempted; named tree graph absent. Read actual AgentRegistry/AgentSetupCommit, SessionCommandController.create, private AgentLoop prepared-publication, and transient workspace archive-admission seams. Rev4 blocker: no established durable owner/run transaction spanning central admissions+late publication+supervisor notification+successor create/start-once. Focus/runtime maintenance is process-local/session-local and cannot supply this transaction. Do not implement guessed endpoints. Parent reported blocker; continue bounded Focus qualification only.

- Frozen install job70 exit0; native addon built successfully. Normal `pnpm exec vitest run` Focus native2+UI3+real HTTP/JSONL1 passed6 (job72). Concurrent duplicate actual HTTP/JSONL caller variant passed job74; log `/tmp/step73-native-caller-concurrent.log`.
- Host build job71 exit2 projection schema readonly mismatch fixed; job73 exit2 exhaustive scoped-event test missing new agent/cancelled row fixed. Host build retry job77: tsc passed, bundle exited1 MISSING_EXPORT deepEqualJson from stale lib/types/index.js. Independent `pnpm run typecheck:contracts-ready` all-Client compile job81 exit0 (full tsconfig.client.json). Native safe generated-output clean+addon+Host+Client rebuild now job82 running; logs `/tmp/step73-native-clean.log`, `/tmp/step73-native-host-clean-build.log`, `/tmp/step73-native-client-clean-check.log`. Read repository safe cleaner: generated outputs only, preserves package source/unknown orphan residue and .r84-evidence. No clean executed yet. `DSH_SNAPSHOT=replay pnpm run test:snapshot -- -t 'replays tool-call-turn.*through dsh --profile headless'` job76 running genuine shipped-profile replay; baseline only, not a Focus-specific built-profile scenario.

- `pnpm exec vitest run packages/client/connection/tests/focus-transport.host.spec.ts` job80 exit0 after failed Check-flush guard: rejected durability revokes release and leaves late receipt held/no new model request. Successful concurrent duplicate test remains real HTTP+JSONL; only failure branch intentionally injected.
- `pnpm run gen-persistence-catalog` exit0; generated known-event-types.ts plus docs/persistence-catalog.{md,zh.md,i18n.yaml}, docs/persistence-schema.json updated by canonical generator (no fabricated review/provenance).
- Snapshot command correction: job76 accidentally passed literal `--` from pnpm script, full suite ran and exit1; kill attempt found already complete. Do not use as Focus proof. Correctly filtered native job78 ran2 variants, failed before complete Host build (missing Typert built contributors). Retry only after clean build, never record/refresh or spend keys.

- Clean build job82 exit0: canonical native clean, native addon build, full `pnpm run build:lib:host` (TypeScript+Host bundles+desktop bundle), and all Client `pnpm run typecheck:contracts-ready` all succeeded. This is isolated source-tree build, NOT runtime activation. Built-profile retry job85 exit0 with correct exact file/-t (current+retainedV3 tool-call-turn2 pass,136 skipped; baseline shipped-profile proof only, not Focus-specific recording); log `/tmp/step73-native-profile-built.log`.
- Canonical persistence generator produces a broad schema/catalog diff against rc2 (4499 additions/3064 deletions over generated docs/schema+lock). Retained, not silently reverted; requires owner scope review. `git diff --check` rc2 exit0.

- Final native `pnpm exec vitest run` Focus2+cancel44+UI3+HTTP/JSONL1+durable continuation149 job86 exit1:195 pass/4 fail. Log `/tmp/step73-native-qualified-regression.log`: residency capacity timeout; legacy Steer/followup refusal-injection tests bypassed by actual notification capability2; unread teardown settlement retention now contradicts old discard-on-disposal test1. This is NOT PASS.
- Fixed actual resident-parent lifecycle wake bypass in continuation-activation.sendWaking: wake resident Activation in finally independently of Focus model gate. Targeted residency test job87 exited1, timeout persists; attempted resident wake addition is NOT a verified fix. Native recoverUnentered restores every unentered receipt, including pre-step policy rejection used by parkParent; this can pin continuable residency/capacity indefinitely. Requires explicit durable rejected-vs-cancelled admission disposition, not another wake. Targeted residency test job87 (`pnpm exec vitest run packages/subagent/subagent/tests/continuation.spec.ts -t 'shares slots across siblings'`), log `/tmp/step73-native-residency-regression.log`. Latest full Host tsc+all Client compile job88 exit0, logs `/tmp/step73-native-final-{host,client}-tsc.log`.
- Remaining4 regressions (including unresolved actual residency/recovery timeout) require actual native admission refusal test seam and explicit discard-vs-preserve teardown policy review; do not alter tests merely to obtain PASS. Rev4 durable owner/run maintenance and central admissions/start-once not implemented for architectural blocker above; Focus-specific shipped-profile scenario still absent. Return bounded checkpoint to parent, no grind/commit.

## Same-writer disposition continuation

- Prior job87 targeted residency exit1 timeout and job88 Host+allClient compile exit0 logs read directly; runtime no longer retains those job handles (job_output unknown), job_list empty at resume. These are prior results, not running jobs.
- Implemented explicit durable agent/notification/terminal reasons rejected/discarded/disposed retaining original receipt evidence. Recovery excludes terminal IDs; preStep rejection or rewritten-away claimed inputs become rejected; explicit user queue removal becomes discarded; human Stop preserves admitted notifications, disposed cancellation settles/removes them. Receipt projection version2. Native refusal tests now inject at real notifications.admit seam, retaining original rejection/error/settlement assertions.
- `pnpm exec vitest run packages/subagent/subagent/tests/continuation.spec.ts packages/core/agent-loop/tests/focus-native.spec.ts packages/core/agent-loop/tests/cancel.spec.ts packages/core/agent-loop/tests/inbox.spec.ts` managed job bash-97 exit1:198 pass/4 fail solely unregistered new terminal event (started before generation), original4 failed cases repaired without dropping assertions. Canonical catalog regenerated exit0. Rerun same exact command job bash-98 exit0:202 passed, all original continuation assertions retained/repaired; log `/tmp/step73-disposition-tests-final.log`.
- Canonical generated schema root digest comparison against exactrc2: only agent/focus, agent/inbox/spliced, agent/notification/terminal, developer/message, user/message, session/title-llm-request change; none removed. Last3 follow notification MessageSource union closure. Broad nodes/reference changes are necessary canonical closure, not unrelated root churn; preserve canonical outputs.

## Native receiver implementation unit (partial)

- New packages/core/agent-loop/src/maintenance.ts: optional HostMaintenance Service owns exclusive write-leased native control Session; strict exported maintenanceCommandSchema owner authenticated separately, owner/run-bound close/status/release; atomic batch notification+supervisor receipts; deterministic runId+baton digest successor CLAIM only, not started/executed. Flush uncertainty poisons admission; close suppresses new admission before persistence await; replay validates sequential revisions. Does not mutate prior user/goal pause states, restart, activate, or release external claims.
- Source central barrier wired initial registry create/resume/enter and driver send/wake; epoch ticket rechecked at private prepared publication; direct inbox additions checked. Goal create/resume and automatic driver gate wired. Other jobs/workflow/start-once execution/real transport and startup ordering still outstanding; NOT complete/PASS.
- New maintenance.spec.ts uses actual native JSONL lease, cross-owner/stale releases, concurrent same receipts, restart replay, divergent baton and delayed setup-publication tests. Managed job pending catalogue+tests; Host tsc job bash-102 in progress. bash-102 Host tsc exit2 missing required header.isSeeded fixed; bash-103 catalogue exit1 wrong module declaration outlet fixed; bash-105 catalogue+actual native receiver tests exit0 (2 pass). Receiver claim explicitly remains claim-only, no advertised started execution. Registry initial+late storage/restore+prepared publication tickets, new direct prompt/inbox admission, goals create/resume+driver, subagent one-shot/provider late publication, jobs initial/reentrant registration, workflow initial start guards added. bash-107 compile exit2 only test unchecked array indices fixed. New compile bash-109 pending; regression bash-110 pending (actual IDs corrected on collection). Real `/api/maintenance.receive` SOURCE route registered through existing Connection trust+request waterfall, same provisioned producer bearer with explicit maintenanceOwners role whitelist; owner derived from authenticated origin, not request. Strict command service schema refuses owner spoof; source real HTTP test exercises close/wrong-run/spoof release and no model wakes. No profile/prod configuration enabled. no prod/Forage/reference changes.

## Latest same-writer receiver qualification

- bash-109 collected exit2: compiler ran before receiveMaintenance function insertion, missing export only; `/tmp/step73-maintenance-host-tsc-latest.log`. Current-source Host+allClient retry bash-112 running, logs `/tmp/step73-receiver-{host,client}-tsc.log`.
- bash-110 collected exit0: normal native real HTTP+JSONL receiver/Focus, durable maintenance, goals, jobs, scheduler, continuation regression **300 tests passed in 7 files**. `/tmp/step73-receiver-regression.log`. This is producer test evidence, not independent PASS.
- Small follow-up: maintenance admission epoch now changes only at close/release, not ordinary receipt/claim commits, preserving concurrent admitted worker setup. Cancelled unentered receipt recovery uses internal splice while closed (not a new public work admission). New assertion preserves worker ticket across late receipt publication. Needs rerun.
- Implemented source caller contract: POST `/api/maintenance.receive` through existing Connection HTTP bridge/trusted Host+Origin; provisioned producer Bearer authenticated, origin must ALSO appear in explicit `maintenanceOwners`. Owner derived from origin, no body owner allowed. Strict JSON actions: close/status/release `{action,runId}`; receipts `{action:'receipts',runId,items:[{sequence,kind:'notification'|'supervisor',payload}]}` max10; claim-successor `{action:'claim-successor',runId,batonDigest}` SHA256 lowercase64. Durable reply is run `{owner,runId,phase,receipts,successor}`. Successor status **claimed only, NOT created/started**. Browser cookie is insufficient. No grants/profile/prod activation made.
- Remaining actual gaps: successor claim is not native create/start-once execution; journal atomic receipt batch is not atomic downstream notification/supervisor publication; optional receiver startup ordering/default shipped-profile composition not qualified; workflow late async publication not fully covered; genuine Focus-specific shipped-profile keyless snapshot absent (baseline replay only). Separate control and agent JSONL handles cannot alone claim atomic cross-log execution; need explicit durable outbox/execution recovery design and crash-window tests, not a claimed-started ACK.

## Parent-requested bounded closing repair

- Parent source review found native sendWaking bypassed SubagentInbox lifecycle admission. Reused extracted `SubagentInbox.assertAccepting()` before native receipt admission; all sendWaking paths now require exact current registry owner, matching resident Activation, no closing inbox, and no teardown lineage. No spies/assertions removed.
- Track exact disposed-cancel Agent identities separately from human Stop; notifySettlement refuses post-disposed-cancel appends even while registry still contains parent. Closing teardown before parent disposal can still journal settlement without wake, retaining original evidence/discard semantics. Previously admitted receipts remain preserved by human Stop, terminally disposed by actual teardown; new undeliverable sends are not accepted.
- Added actual resident Activation dispose/model-gate race, human Stop vs disposed cancel, and delayed child settlement after parent disposed cancel; bash-122 collected exit0:152pass plus Host compile. Added real handle dispose/same-id resume stale-owner assertion; bash-125 collected exit1:152pass/1fail, fixture empty session not persisted (SessionPersistenceNotFoundError replaced-parent), no compile reached. Materialize fixture via actual Focus event before disposal; retry bash-126 collected exit0:153passed (all prior149 plus4actual closing/cancel/dispose/staleowner races), current Host AND allClient compile succeeded. All bash-122/125/126 collected; none left running. Exactrc2 diff whitespace check exit0. No commit/PASS, logs `/tmp/step73-parent-closing-final{,-tsc}.log` and `/tmp/step73-parent-closing-client-tsc.log`. No production/source ownership expansion.

## Reject/reload and complete Client bundle unit

- Read current agent.preStep: policy reject settles claimed admissions rejected; rewriting-away settles omitted claims rejected; kick finally recoverUnentered excludes entered/terminal via receipt projection stateVersion2. Existing fix retained, no duplicate disposition implementation.
- Added smallest actual JSONL reload test in focus-native.spec.ts: native admission rejected before model, terminal rejected event retained, handle disposed/reloaded, receipt evidence remains, both inboxes empty, Focus+Check+wake remains static0requests. `pnpm exec vitest run packages/core/agent-loop/tests/focus-native.spec.ts packages/core/agent-loop/tests/cancel.spec.ts packages/subagent/subagent/tests/continuation.spec.ts` bash-131 exit0 **200pass** (3+44+153); `/tmp/step73-reject-reload-tests.log`.
- Normal `pnpm run build:lib:client` bash-130 exit0 complete allClient TypeScript AND tsdown bundle build; `/tmp/step73-client-bundles.log`. This pass produces BOTH Node-half lib/index.js and browser lib/client.js for Client packages (Host-only build intentionally omits most Client Node halves). Connection lib/index.js now PRESENT, not missing.
- Exact native artifact map (paths relative named tree; bytes, SHA256): Connection `packages/client/connection/lib/index.js` 47616 `3985a713f10cb5dfdeaa159184d5b788105c5630829a89e5b0248fef45f8295f`; Connection `lib/client.js` 59411 `0fbb93fa2382bb66919767f69c909585c6255486f9536f9232231edaeac8c4e6`; UIconversation `packages/client/ui-conversation/lib/index.js` 1524 `046ea85e5fa3b6bb2950b6a0ce55cd06ae516f37e8b6a84497c2ca74a3364c31`; UIconversation `lib/client.js` 719607 `262f4ec3c9aa629970126b7626722cbf53337529d697a28683d3d93dfaf31ffa`. Browser bundles are __ModuleLoader__.load factories, not Node-importable modules.
- Current normal `pnpm run build:lib:host` Host/CLI full bundles bash-132 collected exit0 (TypeScript+tsdown+desktop bundle); all bash-130/131/132 completed/collected, no active jobs, `/tmp/step73-current-host-bundles.log`; needed because earlier full Host bundles predate latest source. Requested broker checkpoint exact path via report; not located/read yet, no broker edits. Source assembly is not Focus-specific shipped-profile snapshot substitute. Next proof unit remains native built profile Focus; rev4 actual outbox deferred until that proof.

## Current built Focus profile proof

- New focus-profile.spec.ts + focus-profile-driver.ts reuse established loader-smoke bootProductionProfile helper to load shipped headless profile/bundle layers with plain Node and built package exports (no tsx/path resolver). Isolated DSH_HOME/workspace, keyless scripted adapter only; narrow overlay disables metered provider/title and uses actual JSONL. Fixture directly drives canonical registry Agent: expected1foreground+1fixedCheck+0staticrequests,1lateheld,pausedgoal. This is shipped-profile Loader assembly, NOT real CLI task/GUI proof.
- `pnpm exec vitest run packages/core/agent-loop/tests/focus-profile.spec.ts` bash-133 collected exit1: test overlay relative path refused by createRequire before profile startup; corrected absolute resolution. Retry bash-134 collected exit1: required headlessStartup/cmdlineArgs unavailable in embedding fixture. Provide actual built cmdline helper/readiness with fixture-owned turn sequence (real app mounted, readiness intentionally not fired; NOT actual CLI task proof). bash-135 exit1 fixture lacked cmdline package dependency, changed to explicit native built helper import, no dependency install. bash-136 running, `/tmp/step73-built-focus-profile-launch.log`. All prior proof jobs collected. No qualified snapshot yet. Prior full build jobs all collected.
- bash136 collected exit1: real one-shot app started despite fixture readiness (headless app does not use appReady), notification projection unavailable during boot. bash137 collected exit1 after explicitly disabling app rows: foreground0requests; bash138 diagnostic exit1 pinned missing canonical meta.cwd -> prompt {{cwd}} assembly refused. Canonical fixture meta.cwd fixed. bash139 built profile test1passed, chained Hostcompileexit1 six fixture type errors; removed unused cmdline helper, optionalwake calls, diagnostic narrowing. No test assertions deleted. bash140 collected exit0: final normal builtprofile1+Focus3+Stop44+continuation153 **201passed**, followed by current Host AND allClient compile succeeded; allproofjobs133-140collected, noneactive. Final normal builtprofile+Focus+Stop+continuation regression followed by Host+allClient compile, `/tmp/step73-built-focus-final{,-types}.log`, `/tmp/step73-built-focus-client-types.log`.
- Proof boundary: headless bundle/profile Loader and actual built core exports +JSONL; explicit overlay DISABLES headless-runner/startup so fixture owns multi-turn sequence. NOT actual CLI task lifecycle/GUI proof, not broker source fixture masquerading as snapshot. Runtime snapshot observed bash139:1foreground+1Check+0staticrequests,lateheld1,pausedgoal.
- Parent receiver requirements acknowledged: owner/run successor WHILE CLOSED, no generic bypass; status must count active/unknown participants not imply idle from run record; receipts journal not supervisor delivery; restart ordering and prior-pause tests required. Deferred until proof, no new agents/prod changes.

## Authorized active same-writer turn

STARTED now in native source tree: reading current maintenance/Focus seams, not parked or merely queued. Current built profile core fixture201pass + Host/allClient compile evidence already recorded; actual CLI startup gap remains distinct. Next bounded work assesses actual profile startup before receiver owner/run outbox/admission drainage. No new agents/prod edits. Actual proof job bash-141 collected exit0: BOTH built profile fixture and actual shipped CLI task tests passed. bash142 collected exit0 current Host/allClient compile. Proof job bash-141: `pnpm exec vitest run packages/core/agent-loop/tests/focus-profile.spec.ts > /tmp/step73-actual-cli-focus.log 2>&1`. Added actual built CLI task case using normal --profile headless --patch, shipped app rows NOT disabled, keyless provider/control fixture and realJSONL; no tsx/path resolver. This is separate from prior fixture-owned multi-turn profile proof. Tool-backed current turn active, not queued. New focus-cli-plugin.ts keyless trusted fixture injects native Focus and receipt+goal during actual CLI agent/created; real built app owns foreground/exit, held receipt excluded and snapshot1request/0static. Earlier artificial embedding startup race is not reproduced by actual CLI. Next maintenance prior-pause+Focus preservation test added; bash143 collected exit1: maintenance3+profile2 tests5passed, Hosttypecheck refused guessed GoalView.goalId fields. Read actual GoalView.id schema, fixed identity assertion to compare real IDs; bash144 collected exit0 Host+allClientcompile; bash145 collected exit0 maintenance3+profile2+Focus3+Stop44+continuation153 **205passed**, `/tmp/step73-cli-maintenance-regression.log`. All141-145completed/collectednoneactive. Priorpause and Focus preserved acrossclose/release, no request/header. Original command maintenance3+profile2 followed by Host compile, `/tmp/step73-prior-pause-{cli,types}.log`. Receiver API assessment: current epoch-invalidating latepublication test intentionally conflicts new parent preclose-drain contract; needs reservation ownership+finish accounting rather than simply bypassing closed gate. Ownerclosed successor requires a session-bound native permit recognized by registry/factory assertions; no ambient global bypass will be added.

## Parent small admission-epoch review

Verified current source: tickets compare private admissionEpoch, NOT durable state.revision; close request increments epoch synchronously, committed release increments epoch; receipt/claim bookkeeping never changes epoch. Existing actual JSONL workerTicket assertion survives late receipt while open. No duplicate source fix made. Added assertion that same ticket also survives successor claim bookkeeping, and actual JSONL injected flush-failure test: formerly-open receiver rejects ACK, poisons open=false, refuses existing/new tickets. `pnpm exec vitest run packages/core/agent-loop/tests/maintenance.spec.ts` followed by Host tsc, bash146 collected exit0:4tests passed + Hostcompile. Logs `/tmp/step73-epoch-review-{tests,types}.log`. This fail-closed uncertainty test intentionally injects only control handle flush failure, not mocked durability. No active jobs, no prod/PASS.

## Authorized durable outbox turn STARTED

Actual same sole-writer turn active now. Read maintenance schema and canonical admission seams; not queued/parked. Scope immutable owner/run successor intent with fixed session/message identity, default-disabled trusted Host launch configuration, closed-run authority and recovery/fault tests. No provider/model/preset/cwd authority from request text, no ambient gate bypass. Existing gate only accepts global open or epoch ticket; closed canonical create/resume needs unforgeable session-bound permit propagation through registry/factory/driver, not a guessed route or globally open successor window. Implemented first durable outbox stage: strict start-successor {runId,baton,batonDigest} stores immutable accepted-intent, fixedsessionId/stablemessageId and trustedHost launch configuration only under exact CLOSED owner/run. Native config defaultsdisabled; schema successor:{owner,agentPreset,provider,model,cwd:absolute}. Body cannot supply launchoptions; digestchecked, duplicateidempotent, changedconfig/batonconflicts. Claim can now bind exactclosedrun (legacyreleasedclaim remainsread-compatible). No canonical childeffect or started/completeACK advertised yet. bash147 collected exit0 canonical persistence generator+realJSONLintenttests5pass+Hostcompile; bash148 collected exit0 intent/Focus/Stop/continuation/actualHTTP/builtprofile regression208pass +allClientcompile. All147/148completedcollectednoneactive. Commands: `pnpm run gen-persistence-catalog && pnpm exec vitest run packages/core/agent-loop/tests/maintenance.spec.ts && pnpm exec tsc -b tsconfig.host.json --pretty false`; finalnormal Vitest includes maintenance/focus-native/cancel/continuation/focus-transport.host/focus-profile then `pnpm run typecheck:contracts-ready`. Logs `/tmp/step73-outbox-intent-{regression,client-types}.log`. Actual tests: absentHostconfig refusesbeforeeffects, tamperedbatonrefuses, concurrentduplicatesoneimmutableintent, restartrecoverssameintentunderclosedgate, changedHostmodelconflictsratherthanmutatinglaunch; no child-effect crash tests claimed. Earlier builtprofile artifacts predate newintentstage (no currentintentbundledproof). First command canonical persistence generator+realJSONLintenttests+Hostcompile, logs `/tmp/step73-outbox-intent-{catalog,tests,types}.log`. Concrete next integration requires unforgeable session-bound permit through current registry.create/resume+factory.runtime admission checks and ReactLoopAgent loopCtx gate; opening wholehost or caller-context-only shadow would be unsafe/inoperative. Receipt typedtarget/downstreamoutbox and drain accounting stillunimplemented.

## Canonical closed-run materialization unit active

STARTED same-writer continuation beyond accepted-intent. Added opaque session-bound permit capability for native registry create/resume/enter, factory initial/late publication and own driver/inbox/wake only. Private issuer WeakMap binds exact CLOSED owner/run/session; arbitrary {} and unrelatedcreate refuse, no global open/ambient window. Permit retired after operation; other tools/delegates still use root closed gate. Trusted Host `maintenanceSuccessorSetup.prepare(launch)` must return actual approved AgentSetup; absent composer keeps accepted-intent (no effect). Uses existing canonical agents.resume NotFound-only create fallback; stable receipt flushed before Check/wake; existing user/message evidence prevents repeatmodelentry after restart; control status started/complete only derived from real entered/completed events after childflush.
- bash149 collected exit0 canonicalgen+Hostcompile. bash150 actualJSONLfaulttests5pass/1fail: missed outer factory.resume global admission check, refused closed beforeeffects; fixed same validatedpermit there. bash151 collected exit0 maintenance6tests+Hostcompile (actual canonical beforeeffect/afterchildflush/restart/concurrent fault recovery qualified producer evidence). Added immutable host/maintenance-successor binding in child Session beforepublication and verifyexactbinding onresume; completion onlyaftermatchinginitialmessageentry. bash152 collected exit0 canonical persistence regeneration + maintenance6/Focus3/Stop44/continuation153/actualHTTP1 **207passed**, current Host AND allClientcompile succeeded, `/tmp/step73-materialize-regression.log`, `/tmp/step73-materialize-{final,client}-types.log`. All149-152completedcollectednoneactive. Prior command maintenancefaulttest retry+Hostcompile, `/tmp/step73-materialize-{tests,types}-retry.log`. Newfaulttest: trustedcomposer refusal beforeeffect afterintent, afterchildflush controlappendfailure, restart/concurrentretries samechild/receipt/no secondmodelrequest, arbitrarypermit and unrelatedwork refuse, retiredchild extra prompt refuses. No qualified result yet, not PASS. Receipt actualdelivery/status/drain/bootordering remaining.

## Replay barrier / live status bounded unit

- bash153 collected exit0 normal `pnpm run build:lib:host`, log `/tmp/step73-boot-barrier-host-build.log`. Explicit opt-in maintenance.staged.patch.yml introduces hostMaintenanceReady dependencies for official admission-capable producer initializers; ready service published only after leased control replay and flush. HostMaintenance deliberately mounted last in patch to test dependency ordering, not row-order assumptions. Default profile/config remains unchanged.
- bash154 collected exit1: actual two-process built Loader/profile CLOSED-log replay test **1 passed** (`/tmp/step73-boot-loader-test.log`), then Host compile failed exactly boot fixture JobKind 'boot-probe' unsupported (`/tmp/step73-boot-loader-types.log`). Fixed fixture to registered bash kind, not unsafe cast. Proof configured native agent and job initializer cannot publish/start after CLOSED restart; no model keys/live runtime.
- bash155 collected exit2: maintenance6 + actual built Loader1 =7passed, then Host compile caught obsolete unreachable status comparison after new early status branch (`/tmp/step73-boot-status-{tests,types}.log`); removed unreachable branch. bash156 collected exit0 current maintenance7 including real active initiating caller and hanging canonical successor: STATUS resolves without joining blocked mutation tail, caller included and closed/busy, receiver cancels neither. Log `/tmp/step73-live-status-tests.log`.
- Live status samples all registered non-idle agents (including initiator) and active tools without waiting mutation tail; global jobs/delegates/workflows/preclose publications remain explicitly UNKNOWN/busy, not guessed idle. This is conservative partial drain telemetry, not an idle certificate. Typed receipt delivery and authoritative drain accounting remain unfinished. No PASS/pin. bash157 COLLECTED exit0 `pnpm run build:lib:host && pnpm exec vitest run` maintenance-boot/maintenance/focus-native/cancel/continuation/focus-transport.host `&& pnpm run typecheck:contracts-ready`; current Host compile+normal Host/CLI/desktop bundles succeeded, 209tests passed, allClientcompile succeeded. Logs `/tmp/step73-ready-status-{host-build,regression,client-types}.log`. All153-157 collected; job_list confirms none running. This turn did not rebuild Client bundles (prior bundles predate newest status); no claim of final all-bundle proof.
- Remaining receipt contract: existing receipts action ONLY owner/run evidence journal, NOT notification/supervisor delivery. Existing authenticated maintenance.receive transport supplies producer-origin owner, no trusted destination consumer grant presently configured. Safe implementation needs explicit Host-approved source→typed target grant and actual durable read/consume, OR session-bound native delivery capability to an approved existing Agent with stale-owner/teardown checks; cannot reuse successor permit for arbitrary notification targets or fabricate destination authority from payload. No speculative new route or delivery ACK added.
- Remaining drain implementation: global jobs/delegates/workflows/preclose reservations still UNKNOWN. Current epoch gate rolls back delayed admitted publication rather than authorized preclose drain; that contract is not complete. STATUS is deliberately busy/failclosed, including active caller, therefore external70 must NOT treat current status as usable idle proof. Existing late-publication assertions unchanged. Default production profile remains unchanged; explicit staged patch mandatory, additional admission-capable rows must declare readiness dependency. No all-profile startup claim.

## Resume6 rev5 same-writer STARTED

Actual authorized turn resumed. Fresh mesh-dsh-merge insights and project fetched; graphify query attempted native graph absent. HEAD remains3ec. Parent requests FIRST minimal OLD35af additive bridge, native source/test only, no runtime edits. `git rev-parse 35af^{commit}` ambiguous (35af200758 vs35af8698c2); reported exact authority ambiguity parent, read-only API evidence extracted from likely35af2007587a757527b826ed3f4da32355ffcded WITHOUT assuming activeHost authority. No jobs started yet. Exact candidate oldsource read-only evidence `/tmp/step73-old-host-{agent-types,agent-index,agent-loop,agent,jobs-local}.ts`: registrycreate/resume/enter noadmissionhook; driver.send/privatewakeDriver noadmission; jobstart producer.run beforepublication, barelist filtersownedjobs. CandidatecontrollercannotfenceoldHost. Safe add-on needs oldrelease sourceguards+startupdependency, not public-method monkeypatch or nativecontrollerassumption. Read-only canonical launcher resolution subsequently confirmed `/home/n8/.local/opt/node22/bin/dsh` → `/home/n8/deepseek-harness/apps/cli/lib/bin.js`, owning checkout HEAD `35af2007587a757527b826ed3f4da32355ffcded`. This resolves source basis only, NOT live process module identity/installed admission fence. OLD bridge is not yet implemented or qualified. No compatibility or oldHost protection claim. No agents/production/queue mutations. All previous work preserved. Step73 remains whole pending, no pin/PASS.

## Rev5 explicit Close acceptance repair

Parent reaffirmed CLOSE must ACK closed+busy with activeinitiator, not awaitcaller. Fixed actual receiver response (previously rawrunonly) to append current live STATUS telemetry AFTERdurablecloseflush, without awaitingcaller/quiescence. Added regression: caller staysrunning whenCLOSE resolves and ACK activity includescaller; then exactclosedrun successor proceeds without release; separate STATUS resolves while successorawaitscheckpoint. bash158 collected exit0 `pnpm exec vitest run packages/core/agent-loop/tests/maintenance.spec.ts && pnpm exec tsc -b tsconfig.host.json --pretty false`: maintenance7passed +Hostcompile. Logs `/tmp/step73-close-caller-{tests,types}.log`. No current bundles/allClientrerun for this latest two-line ACK change. All158collectednoneactive. DEPLOY-N/A sourceonly; noForagedeploypins, no PASS/nativepin. OLDbridge, allproducerdrain/status and actualsupervisordelivery stillunimplemented as above; prior209producer results retained notwholecriteria.

## Typed grant receipt delivery unit STARTED

Source implemented strict deliver-receipts typedtarget{kind:agent,sessionId}; Host receiptGrants[{owner,kind,target}] defaultempty, refusalbeforeintent/effects. Original receipts action remains evidenceonly. Immutableacceptedintent/stablemessageID beforeeffect; actualnativeinboxreceipt flush thencontrolACK, coldreplay reconciles targetJSONL withoutcreating/resuming executor. Privateclosedrun/session permit retiredfinally; no genericambientwindow. Native inboxdisposed guard Stop!=dispose, ordinarynotificationadmit nowenforceshostfence (priorbypass found). Posttargetflush checks exactowner and synchronousaccepting flag torefuse teardownrace. ExistingFocus/pause unchanged. bash159 COLLECTED exit0 maintenance8pass+Hostcompile. bash160 COLLECTED exit0 canonicalgen+209regressions+Host/allClientcompile, `/tmp/step73-typed-receipt-{regression,final-types,client-types}.log`. bash161 COLLECTED exit0 newestdisposedrace9pass+Hostcompile, `/tmp/step73-typed-receipt-race-{tests,types}.log`. Then strict wholeHost configschema/export and authenticatedowner originnamespace added plus ACTUALHTTPdeliveryassertions. bash162 COLLECTED exit1 canonicalgen succeeded; native9pass, actualHTTP1failed409 (initial stale-built-capability hypothesis later disproved; doNOTretarget to sourcefixture). Host/Clientchecks aftertestnotrun. Logs `/tmp/step73-granted-http-{gen,tests}.log`. bash163 COLLECTED exit1 normalHostbuildSUCCEEDED, native9pass/HTTP1failed409. bash164 COLLECTED exit1 realreceiver diagnostic confirmed Cordis 'cannot get property sessions without inject', NOT stalebuiltcapability. Receiver earlybootstrap deliberately injectsonlypersistence toavoid agents→ready cycle; supportedcommandpaths now resolve REQUIRED sessions/agents with ctx.get and refuseifabsent (neverabsenceopen). bash165 COLLECTED exit0 latestnative9+realHTTP1=10pass +Host/allClientcompile. Logs `/tmp/step73-granted-http-{host-build,built-tests,diagnostic,seam-retry,seam-types,seam-client-types}.log`. ActualHTTPauth sourcegrantedtargetdelivery concurrentduplicates heldbyFocus, changedpayload/ungrantedtargetrefused, no newmodelrequest. It assembles sourcecontroller with normalbuiltNativeDriver; not wholebuiltreceiverprofileproof. bash166 COLLECTED exit1:209pass/1fail+unhandled inexistingcancel tests. My extra ordinaryforegroundsplice disposalguard conflated cancel({kind:disposed}) primitive withirreversibleobjectteardown; originals explicitlyprove turnbrackets+nextforeground and no uncaughtlatewake. Removed ONLYnewestoverbroad splice restriction, preserved alloriginalassertions; rootmaintenanceinsertionfence and typednotificationdisposalguards retained. bash167 COLLECTED exit0 corrected210pass +Host/allClientcompile, logs `/tmp/step73-grant-corrected-{regression,host-types,client-types}.log`. All159-167collectednoneactive. No latestfullbundle/profileproof afterreceiverctx.get correction; normalHostbuild163 succeeded beforethatcorrection. No whole73completion/pin/PASS. Exact remainingnextseam: count authoritativeglobaljobs/delegates/workflows/preclose reservations; pass same reservation through asyncsessionload/setup/prepare/publication and retireitaftersettlement, allowpreclosedrain rather thanepochrollback; don'tallowretiredticket reuse/newambientadmission. Keepexistinglatepublicationassertions untilcorrectnewnormaldrain regression demonstrates intendedcontract, notdelete them forgreen. Globaldrain/preclose preservation stillnotimplemented; whole73pending noPASS/pin/prod.

## Transferred sole-writer reservation unit — attempt10 / rev6

Parent transferred remaining native ownership to existing broker child after
a309/d24 idle/settled; full live authenticated project73 rev6 pending read.
No messages, cancellation, disposal or archive of prior writers; no new agent.

Source edits only:
- core/agent/src/types.ts: optional counted HostReservation capability.
- core/agent-loop/src/maintenance.ts: globally counted activeReservations in
  live STATUS; opaque preclose tickets remain valid until their exact release,
  but failed/not-ready receiver still refuses. Session-bound publication grant
  cannot authorize a different session/new public prompt. provider-backends
  explicitly UNKNOWN whenever Agents are registered: idle/aborted is not join.
- core/agent-loop/src/index.ts: create/createAgent/resume count storage/setup/
  publication awaits and retire after completion/rollback. Existing preclose
  setup can publish while CLOSED instead of being cancelled by epoch rollover;
  its new prompt/wake authority remains CLOSED after publication.
- jobs/jobs-local/src/index.ts: count actual producer through done+pump drain;
  forced cancelled job status does not retire producer reservation. Rejected
  done (contract violation) remains counted UNKNOWN, not guessed joined.
- subagent/subagent/src/index.ts: count one-shot provider start/lifetime;
  result/aborted outcome is not backend join, only successful holder dispose
  retires. Provider-start rejection retains UNKNOWN (no inferred cleanup).
- workflow/workflow-ptc/src/index.ts: count workflow until documented holder
  disposal joins script/child cleanup, not merely workflow/end/result.
Five focused tests added/updated across maintenance/jobs/service/workflow tests.

Actual commands/results:
- Normal Vitest maintenance10/jobs84/subagent47 all pass; workflow40 pass and
  one failure before child startup: host read-only sandbox unavailable. No
  assertions removed, unsafe confinement workaround or baseline PASS claim.
- Final focused new cases: maintenance2 + subagent1 + workflow1 pass; separate
  jobs "counts a preclose job"1 pass. Five new cases pass after typing repair.
- First Host compile failed two new fixture typings (ticket any and invalid
  cancelled stopReason), corrected to HostAdmissionTicket/aborted. Managed
  bash169 collected exit0: normal Host tsc + all Client contracts-ready.
  Earlier bash168 collected exit2; no active jobs remain. No unchanged210 suite
  repeat or bundles rebuilt. Inherited producer evidence remains intact.

Boundary/gaps: STATUS remains deliberately busy/failclosed with jobs-global,
delegates-global, workflows-global and preclose-publications UNKNOWN until
complete per-service coverage exists. New reservations give exact counted
operations, not an authoritative zero certificate for services mounted before
receiver, third-party providers, continuable materializations or arbitrary
backend adapters. Preclose canonical factory setup is preserved; delayed
provider-internal child creation/workflow child spawning across root CLOSED
still needs explicit bounded admitted-lineage propagation, not a global reopen.
Pending-message execution under CLOSED remains gated/preserved, not force-run.
Backend join must be actual provider capability; aborted local loop is never
proof. Exact retired permits/session binding remain load-bearing.
Therefore globaldrain unit is PARTIAL, whole73 stays pending; external70 cannot
use this status as idle. No native pin/publication/review/production effects.
Next units: finish service coverage/admitted lineage/backend settlement seam;
then isolated additive old35af bridge and final current bundles/profile hashes.
Narrow transferred Codex adapter repair not touched in this bounded unit.

## Continuable accounting follow-up — attempt10 / rev6 (partial)

Existing sole writer; no ownership/production/pin/queue changes. Added source
accounting in subagent/subagent/src/continuation.ts before provider preparation
await; successful initial acceptance retires that exact publication reservation.
Preparation/rollback failure retains UNKNOWN, never inferred provider join.
subagent/subagent/src/continuation-activation.ts counts fresh and cold residency
until actual AgentHandle.dispose succeeds; result, initial acceptance and local
idle are not join evidence. Wrapped handle retains only its actual public agent
and dispose methods. Existing cleanup assertions and CLOSED authority unchanged.
Two targeted continuation.spec.ts tests pass: preparation count across close /
new closed call refusal / unjoined failure remains counted / zero model turns;
materialization residency remains counted after acceptance and retires at actual
handle disposal. These use the real continuation/factory/JSONL stack with a
keyless adapter and explicitly test-fixture admission counter, not native global
receiver zero certification. Logs /tmp/step73-lineage-continuation.log.

Delayed publication lineage is NOT complete: provider-internal factory entry
still uses root admission, and workflow child start still uses public root start.
Existing forSession publication capability validates publication only; passing
it as maintenancePermit would install a prompt-capable Agent admission facade
and is forbidden. Required remaining seam is an exact live parent-reservation /
child-session-bound internal factory publication capability plus one immutable
initial-input acceptance capability, retired independently of execution/join.
Workflow descendants must derive only from their still-live workflow reservation
and bounded existing caps; no ambient CLOSED bypass, no new public prompt/start
API authority. This follow-up deliberately does not invent such a broad bypass.

Read-only workflow failure reproduced isolated BEFORE provider startup:
/tmp/step73-lineage-sandbox.log, sandbox-unavailable, agentsStarted=0.
Actual package-context backend probe: native/system/packages/linux-x64/bin/
landlock-run absent, probe=unusable; bubblewrap exits1 with uid-map Permission
denied. Addon library availability does NOT imply launcher availability. This
is concrete environment/prerequisite failure independent of child publication;
no sandbox edits, weakened assertion or unconfined workaround. HEAD does not
contain this newer workflow test path, so no historical baseline PASS claimed.

Final collected results: bash170 exit2 on two fixture implicit-any parameters;
fixed ticket/kind typings. bash171 collected exit0 Host tsc + allClient
contracts-ready + git diff --check, logs /tmp/step73-lineage-{host,client}.log.
bash172 collected exit0 all155 affected continuation tests, log
/tmp/step73-lineage-continuation-all.log. Two targeted tests already passed.
No active jobs remain. No unchanged210 repeat, bundled proof or final pin.
Remaining groups: exact admitted provider/workflow lineage; global coverage/
UNKNOWN/backend settlement including transferred adapter actual-turn join;
staged additive oldHost35af bridge; final current bundled/profile fingerprints.

## Immutable admitted child/input unit — attempt10 / rev6

Sole writer SOURCE ONLY. Added HostInitialAdmission identity capability on
existing HostReservation: each delegate snapshots ONE exact child session,
initial UserMessage and original AbortSignal while root OPEN. Native WeakMaps
reject body-shaped copies, wrong child, wrong/stale parent object, replay and
retired lineage. Parent must be the exact live Agent in registry. Claim consumes
once BEFORE any factory await. Canonical factory reuses existing preparation,
setup, publication and actual write handle; queues precisely the stored input
through existing durable receipt splice+flush. Child Agent keeps root admission,
NOT a maintenancePermit facade. Child tickets cannot become general maintenance
permits or arbitrary receipts; immutable message comparison/once cutoff applies.
No new descendants after CLOSED, even from a preclose workflow; only children
individually accepted through SubagentRuntime.start before close can publish.

Native receiver/types/factory/registry/inbox changes in
packages/core/agent/src/{types,index}.ts and
packages/core/agent-loop/src/{maintenance,index,inbox}.ts; provider-facing
resolved request and service supply the authentic capability, overriding any
caller alleged field; subagent-in-process-driver uses exact reserved id/input,
waits initial claim rather than reporting false completion while CLOSED, and
only wakes that existing pending child when root OPEN again. Cancellation and
holder dispose resolve the wait and join actual child disposal. Unused remote
child permits retire only with their delegate holder's actual successful join;
result/aborted is insufficient and start/cleanup failure remains UNKNOWN.

New initial-lineage.spec.ts uses real native receiver + leased JSONL + canonical
factory + actual in-process provider and actual Node PTC workflow, keyless LLM.
Tests exercise provider await/close/delayed publication, immutable caller-input
mutation, cloned capability/wrong session/wrong live parent, general permit
refusal, concurrent duplicate factory claim, later prompt/start/workflow refusal,
zero model turns while CLOSED, exactly one initial model entry after RELEASE,
workflow cancellation/actual child join and remote aborted-result/dispose race.
No confined read-only test modified or bypassed; workflow uses existing supported
danger-full-access fixture configuration, not a workaround of the failing test.

Precise distinct continuable gap remains, now an ACTUAL negative experiment in
initial-lineage.spec.ts: startContinuable -> prepareContinuable awaits -> CLOSED
-> ContinuableActivationRegistry.materialize -> ownerCtx.agents.create refuses
new root publication, zero Agents/model turns; original publication reservation
remains UNKNOWN. Existing MaterializeInputs has no initial capability. More
importantly startContinuable selects initial raw request.prompt OR
withContinuableReturnGuidance only AFTER materialization by consulting actual
child send_message tool; submitMaterialized then awaits model image capability,
authorizes exact parent and delivers through SubagentInbox.deliver/followup.
Therefore using the new already-bound UserMessage capability unchanged at that
factory would either double-deliver or silently change guidance/image-validation
and lifecycle/catalog acceptance semantics. I did NOT mask that contract mismatch
with a broad facade, arbitrary post-close message binding or weakened assertion.
The one-shot/workflow individually admitted path is implemented; this separate
continuable initial-input compiler/admission integration still needs qualification.

Prior preserved155pass continuation history is unchanged. Collected results:
bash173 exit2 optional undefined field typing (fixed); bash174 exit0 initial
native2+maintenance10. bash175 exit2 test status return typing (fixed), tests58
passed. bash176 exit0 workflow2+maintenance10+service47=59 and Host/allClient.
bash177 exit0 affected10files/162tests incl native2+maintenance10+service47,
in-process-driver/fork/spawn suites, Host/allClient and diffcheck;
/tmp/step73-initial-final-{tests,types,client}.log. Final added4 native tests:
bash178 exit1 negative fixture omitted required label, fixed fixture and handled
outcome to avoid early unhandled assertion. bash179 COLLECTED exit0 native4,
Host/allClient and diffcheck, /tmp/step73-initial-last-{tests,types,client}.log.
No active jobs, unchanged210 repeat, final pin/bundle or whole73 PASS. Remaining: continuable exact initial compiler seam, full global
coverage/UNKNOWN/backend settlement and transferred adapter actual-turn join,
staged additive old35af Host bridge, final exact bundled/profile fingerprints.

## Continuable exact compiler/acceptance unit — attempt10 / rev6

Existing sole writer, SOURCE ONLY. Supersedes the preceding distinct continuable
negative gap; old checkpoint/results remain historical evidence, not rewritten.
HostReservation.child optionally binds a native compiler function BEFORE await
along with detached original UserMessage, exact live parent, owned AbortSignal,
exact child and stable messageId. Compiler exists only in native WeakMap state,
not capability JSON; it cannot be installed/replaced by a later request. The
continuation compiler transforms only its immutable original message after the
actual child tool composition: unchanged task OR existing deterministic
withContinuableReturnGuidance. Its output retains original id/source; native
compiler transitions pending/running/complete/failed consume once even on throw
or identity violation, with NO fallback admission of uncompiled raw input.
Provider/signal/reserved child and composition descriptor are captured preawait;
mutating the borrowed caller request later cannot change accepted authority.

Canonical factory defers initial delivery only for this bound compiler, holds
publication reservation across publication/image validation/initial acceptance,
and returns normal root-gated Agent, NOT a maintenancePermit facade. New optional
native identity argument on Agent.followup flows through existing SubagentInbox
-> parent authorization -> followup wake/splice semantics, but records precisely
one existing durable notification receipt instead of losing producer identity.
Existing submitMaterialized performs image capability check, exact parent auth,
acceptance and catalog commit; then actual child JSONL flush precedes caller ACK.
No prequeue raw prompt, duplicate delivery, or arbitrary later followup authority.
Root CLOSED prevents execution; one pending initial id alone may wake on RELEASE.
Initial publication retires after durable acceptance; continuable residency stays
counted until actual returned AgentHandle.dispose completes. Failed handle close
keeps reservation/UNKNOWN; local idle, result and aborted status do not retire it.

Source files this unit: packages/core/agent/src/{types,runtime-types}.ts;
packages/core/agent-loop/src/{maintenance,index,agent}.ts;
packages/subagent/subagent/src/{continuation,continuation-activation,inbox}.ts.
New actual-native tests: packages/core/agent-loop/tests/continuable-initial.spec.ts.
Historical initial-lineage.spec.ts negative test now becomes a positive prepare /
close / compiled acceptance / actual drain test, corresponding to fixed behavior.

Proof uses real receiver, write leases, JSONL readback, canonical child setup,
actual tool restriction/marker and actual SubagentInbox.followup/catalog. Keyless
adapter only. Close during prepare, actual serial publication and image read;
exact guidance once iff actual child tool visible; unchanged original prompt
under caller/provider/signal mutation; image check maintained; no model turns
CLOSED, exactly one original entry/turn RELEASE, exactly one durable receipt and
catalog fact. Preaccept mutated compiled message, forged capability and compiler
replay refused; later/duplicate followups refused. Unsupported image and original
signal cancellation during image read do NOT accept input/catalog. Real child
handle close is delayed by a test barrier (actual storage/flush unchanged): both
publication and delegate reservations persist until actual close completes,
then retire. Failed compiler/identity violation cannot compile twice or enqueue
raw input; actual handle join remains the retirement boundary. Sandbox historical
failure unchanged; no confinement assertion or runner weakened/bypassed.

Collected results before final two compiler-failure cases: bash180 exit2 typing /
unused import (fixed); bash181 exit0 affected continuation/compiler162 pass.
bash182 exit1 native3pass/continuable1 Cordis sessions-without-inject error,
fixed with required ctx.get sessions and failclosed absence; bash183 exit0 Host
compile+native4pass. bash184 exit0 native8pass. bash185 COLLECTED exit0 affected
7files/194tests (full continuation155, inheritance, compiler+adapter, native
lineage and receiver), Host/allClient and gitdiffcheck. Logs
/tmp/step73-compiler-full-{tests,types,client}.log. bash186 COLLECTED exit0
final native12 tests (new continuable8 + lineage4), final Host/allClient and
gitdiffcheck, /tmp/step73-compiler-final-{native-tests,types,client}.log.
Final native/compiler fixtures explicitly typed; all jobs collected, none active.
These are current source-mode qualification, NOT new bundled/profile proof.

Remaining SOURCE groups: authoritative global coverage/UNKNOWN/backend settlement
including transferred adapter actual-turn/join repair; isolated additive old35af
Host bridge; final exact current bundles/profile fingerprints. No continuable
initial compiler gap remains for this tested start path. Public cold followups or
new descendants gain no CLOSED authority. Whole73 still pending for remaining
acceptance/independent review; no native pin, review, queue or production effects.

## Transferred bounded unit — staged Codex adapter turn routing/settlement

Task137578 attempt10 rev6; parent queue authority retained. Adapter basis
/home/n8/forage-worktrees/codex-adapter-recovery HEAD
0db2b77aa69c4e8ee4e4c40ed5462a086fe4300f; staged candidate only, no new pin/commit.
Detailed preserved-overlay/evidence/activation checkpoint there:
STEP73-CHECKPOINT.md. Native/broker source/history/.r84 untouched by adapter unit
apart from this additive checkpoint.

Actual compiled AppServer JSONL receive/watchTransport and adapter now route by
immutable actual thread+turn ID, not thread FIFO/latest turn. Late started /
completed / tool / error cannot adopt or terminate the next turn. Early events
before start ACK kept exact; dynamic-call backlog also partitioned by actual
turn. Cancel during streaming or after tool handoff closes old RPC authority;
new prompt cannot resume its old pending requests. Backend completion evidence
retained across new turns and transport loss; conflicting/missing identity,
unmatched terminals, lost start reply and unjoined work stay UNKNOWN. Tool RPCs
remain counted until successful actual pipe-write callback. Interrupt ACK,
local idle and process kill are not backend join. No quiet-time join heuristic.

Read-only installed image/runtime-policy/permission/workspace/globalCLI/transport
/account/catalog overlays integrated into staged version 0.4.0-step73.1;
features.sleep_tool=false explicit with keyless global/bundled launch-args tests.
No installed edit/apply-script run/auth copy/account request/model spend/reload.

bash187–191 all COLLECTED. bash191 exit0 staged tsc/client build +30 affected
keyless tests +diffcheck +package. /tmp/step73-adapter-{build,keyless-tests}.log.
Keyless tests exercise ACTUAL compiled receive/routing over JSONL pipe delivery;
only backend protocol is fixture. No real account/model/server request. Native
continuable194/previous155/210 suites not repeated.
Staged tarball codex-adapter-recovery/dsh-openai-oauth-0.4.0-step73.1.tgz SHA256
8e58ce6cccbb13bbf0cb8a0a9e1609091cb320b78a85a5f8eeea78e3d2081631.

Exact native integration seam: LlmAdapter/prepareCall in
packages/llm/llm/src/index.ts:208–291 has no join/settlement interface.
Staged adapter backendSettlement()/backendStatus() exposes terminal/request /
UNKNOWN evidence for its owned AppServer instance; NO invented maintenance ABI
or fabricated global drain PASS. Host provider-backends must remain UNKNOWN.

Concrete activation prerequisite: old installed apply.py is a textual-shape
patcher copying the old runtime helper. Blind boot reapply to the integrated
candidate would fail shapes or lose the new write-completion extension. Future
staged oldHost/activation qualification must reconcile versioned boot overlay
ownership before any installation. Installed apply.py unchanged.
Remaining whole73: authoritative global coverage/UNKNOWN; additive old35af Host
bridge; final exact native Host/Client/profile/broker bundled qualification;
independent review and final native pins only after whole source acceptance.
No activation/hold release/queue effects. All existing checkpoints preserved.

## Rev8 bounded native/backend integration — supersedes absent-interface gap

Source-only b2 unit; original137578 is failed and has no fenced-write authority.
No queue/ledger/review/pin, installed edit/apply, auth/model request or activation.

Native actual LlmAdapter now has typed optional backendStatus() evidence (default
undefined), exported backend-settlement.ts identities/terminal/pending-request
contract. LlmRuntime.backendCoverage uses actual registered and call-captured
adapter instances, retains them after route disposal, and counts pre-await
prepare and live stream consumers including initiating caller. Matching actual
thread+turn terminal and successful owned response writes are required; missing,
malformed, stale, disappearing or unsupported evidence stays UNKNOWN. No parallel
routing registry, quiet-time join or local Agent-idle inference. HostMaintenance
consumes this coverage while retaining tools/reservations/active Agent accounting.
jobs-global, delegates-global, workflows-global, preclose-publications remain
explicit UNKNOWN; overall idle is NOT claimed.

Staged adapter 0.4.0-step73.2 maps actual AppServer evidence into this typed contract.
Actual rc2 compile migration preserves system-message instructions, first-class
role:tool results plus legacy overlay compatibility, ToolCallId and response replay
envelope. Existing image/runtime/workspace/globalCLI/account overlays preserved.
Matching current native LLM types are required: isolated node_modules LLM link
points at this native tree; old rc6 dependency retained as dsh-llm.rc6-step73-preserved.
Installed modules/apply.py untouched; old boot patcher compatibility still unresolved.

Collected bash195 Host compile/scoped LLM bundle. Disclosed bash196 wrong-workdir
normal isolated native root build completed exit0 (Host/Client/Web/desktop); this
is producer build evidence only, NOT final immutable profile proof. bash197 found
real rc2 type mismatches, repaired. bash198 30pass/5cancelled fixture metadata
failure superseded by bash199 six compiled native integration passes.
Final bash202 exit0 proper adapter build + ALL43 keyless tests + diffcheck + pack.
Six new tests use actual compiled native LLM/Agent/HostMaintenance/JSONL services
and compiled adapter receive/routing; only backend JSONL delivery/metadata is keyless
fixture. Covers caller pending after terminal, concurrent cancellation/late stale
events and route disposal, native role:tool handoff with delayed write callback,
prepare await, unsupported provider, actual Agent Stop/idle not join, and invalid
terminal/disappearing evidence. Existing staged30 tests retained.
bash203 123pass/1expected-outdated empty-registry assertion; assertion replaced with
exact empty-provider JOINED AND all four remaining global UNKNOWNs (not weakened).
bash204 exit0 native affected124 tests + Host compile + allClient
typecheck:contracts-ready + diffcheck. No active jobs remain; accepted194/native12
unchanged suites not repeated. Logs /tmp/step73-backend-{native-final,
native-regression-final,host-final,client-final,adapter-build-final}.log.

Candidate .2 tarball SHA256 bd763dfc32d9b724255a8c418ca196dc350542397bcd1f8d8219360241882cc7.
Preserved .1 tarball SHA256 8e58ce6cccbb13bbf0cb8a0a9e1609091cb320b78a85a5f8eeea78e3d2081631.
Current native LLM lib/index.js 22d9896be8ad49407f183fe588d115a4df0ae828b99e09b5dafcbe47a6b80379;
maintenance lib/maintenance.js 147ef9da5c68ad3e833a568c43618f70ae85a8a3c9dce1b7327396e83674b8ff.
Current adapter lib/index.js d656eb4ab8e3ee13cdb28379f8285ab5eb61e2b089b057380e3d305eb8d50f97.
These mutable producer fingerprints are not final whole73 published pins.

Remaining: authoritative four global coverage groups, staged additive oldHost
35af2007587a757527b826ed3f4da32355ffcded bridge, boot overlay qualification and final
exact bundled/profile/broker evidence, then root-carrier independent review.

## Rev8 native registration generation/withdrawal refinement

COLLECTED bash212 exit1: first new test identified current-first coverage ordering;
no compile launched after test failure. Commit-order canonical retained set fixed.
COLLECTED bash213 exit0: two new native tests, Host compile, allClient
typecheck:contracts-ready, normal scoped LLM bundle and diffcheck.
COLLECTED bash215 exit0: six affected actual COMPILED native/backend integration
cases including NEW real compiled adapter re-registration while old concurrent
backend remains unjoined. No unchanged30/194/native12 suite rerun. No active jobs.
Logs /tmp/step73-backend-generation-{tests-final,host,client,build}.log and
/tmp/step73-backend-reregister-compiled.log.
Current native LLM source index SHA256 d3153150108dae6621e7daa6af09c097199ce5e7552e1975419176cb3c2fb8dd;
backend-settlement.ts 94aafb61db4ef84f7bcc07283cfec099e8bd9b25b6104b7e821ad1157e6b2d7d;
compiled LLM lib/index.js abd71ce067bcdbdb1765ae35d26b53fa6954ba4fe99de6cbdd06740c2e501cf5.
Earlier native LLM fingerprint is superseded, not inherited qualification.
Native HEAD still3ec93e07aa59ff66135e81202a54ccbc4c8f4eca; no final pin or review.

Native source extension: actual AdapterRegistration now carries monotonic immutable
generation; typed coverage exposes registrations per actual adapter instance.
Every successfully committed registration is retained at the existing registry
commit point, not only when prepare/stream happens. This closes the pre-stream
provider-initialization/lost-start ownership hole: withdrawal or a newly registered
supported replacement cannot erase old UNKNOWN authority. No parallel routing
registry; the existing retained registration set provides insertion-ordered
coverage. Real terminal+tool-write evidence still drives settlement, not disposal.
New native tests/backend-settlement.spec.ts covers never-streamed lost-start
retention, same-route replacement, new generations and unsupported withdrawal.
Actual compiled native integration test now also installs a fresh real compiled
adapter after deregistration during concurrent turns; old delayed terminal/RPC
coverage cannot be replaced by that fresh joined instance.

Broker/notifier exact partition (no broker edit this unit): broker HEAD
7ea210851277fc89dfa779e456ef32b867c8bf30. Child changed only
tools/conductor-notify/README.md, test_transport.py, check_rc2_contract.mjs,
rc2-assembly-native.mts, rc2_assembly_check.py, RC2-ASSEMBLY-CHECKPOINT.md,
RC2-BUILT-ACCEPTANCE-SEAM.md. notifier.py unchanged reviewed2529fb6e;
notifier1919970/18/pending137754 and installed registry NOT owned/modified.
Parent seam doc and historical assembly/R78/R88 artifacts preserved.
Consumer POST /api/notifications.admit authenticated explicit bearer/grant-bound
origin/session/urgency; body sessionId/items(sequence,text,evidenceRefs?,urgency?),
1–10. Durable input-ordered stable messageId receipts with duplicate flag, exact
content identity; ACK not execution. Python currently validates set/multiplicity
but not receipt ordering. Focus holds all notifications/goals with static zero
model turns; fixed bounded Check max10; Stop/foreground priority, child survival,
prior pause preservation; closed ingress rejects new work. Source8-check evidence
not final built/profile proof.

## Rev8 four-group actual coverage source unit — producer evidence

Supersedes historical blanket jobs-global/delegates-global/workflows-global/
preclose-publications UNKNOWN. No source reset, new worker or runtime action.
HostAdmission.coverage issues object-identity capability bound to the exact actual
producer and receiver. Native Cordis exported symbols.original resolves only its
real context proxy to its original service for identity checking; a receipt copied
to another owner cannot authorize coverage. Each known instrumented service binds
during construction. Missing, preexisting-before-receiver, copied, replaced or
uninstrumented service remains UNKNOWN; empty lists never create a receipt.
Existing HostReservations still count admitted work and survive producer/route
withdrawal. No public new admission while CLOSED, no parallel scheduler/registry.

Native paths changed in this unit:
- packages/core/agent/src/types.ts: narrow optional constructor coverage contract.
- packages/core/agent-loop/src/maintenance.ts: actual four service proofs, existing
  reservations, captured persistence instance identity/write settlement, typed
  status return; request/auth/control ABI unchanged.
- packages/core/agent-loop/src/index.ts: factory coverage from existing startup
  registry; original setup/create/open and abandoned-handle close stay tracked
  beyond cancelled public waiters. One join covers backend AND cleanup without a
  zero-accounting cut; failed close/disposal is retained UNKNOWN.
- packages/jobs/jobs-local/src/index.ts: coverage binding; started producer failure
  cannot release authority before actual producerDone; rejected done stays UNKNOWN.
- packages/subagent/subagent/src/index.ts and
  packages/workflow/workflow-ptc/src/index.ts: exact service capability bindings;
  existing result-vs-dispose reservation joins preserved.
- packages/session/session-persistence/src/index.ts: optional writeJoined(),
  undefined by default, MUST mean UNKNOWN.
- packages/session/session-persistence-jsonl/src/{index,storage}.ts: existing
  tracker/claim/handle-chain/live-buffer/open/create/close/migration state supplies
  actual synchronous write settlement. Failed write/lease close uncertainty
  survives handle deregistration; no timer-based join.
- tests/global-coverage.spec.ts (new), maintenance.spec.ts and
  maintenance-boot-driver.ts under packages/core/agent-loop/tests.

Actual native assembly proves busy=false/all groups joined when genuinely empty,
plus absence of write evidence and wrong-owner capability stay UNKNOWN. Existing
work before receiver cannot be retrospectively joined even after its producer done.
Cases cover cancelled job before producerDone/service unload/replacement, delegate
close during provider await with publication preserved and result-before-dispose,
REAL Node workflow return7/result-before-dispose/engine withdrawal/replacement,
idle Agent's actual buffered JSONL writes, aborted setup still pending, delayed
real write-handle creation and actual abandoned close; failed close remains UNKNOWN.
Real workflow uses existing standard fixture runtime default, not a workaround for
preserved read-only Landlock/bwrap baseline failures.

Evidence collected so far:
bash223 affectedjobs84 PASS (global fixture lacked canonical surfaceOp; corrected).
bash224 globals8+maintenance10 PASS; test typing exposed exactOptional/status return
errors, fixed without weakening assertions.
bash225 exit0 Host/allClient compile, affected normal scoped bundles, actual built
Loader1 PASS. Seed asserts all four constructor-bound groups; persisted CLOSED
replay refuses configured Agent and job with zero job effects. Readiness dependency
edges in unchanged maintenance.staged.patch.yml, never inferred row ordering.
bash226 exit0 globals8 including unsupported write evidence +incrementalHost.
bash227 exit0 affected actual JSONL183 tests. Original194/native12/adapter43 unchanged
suites NOT repeated.
bash228 wrong-owner negative fixture used an uninjected test child and failed;
fixture corrected to copy a valid capability to wrong actual owner, assertions
retained. Final bash229 COLLECTED exit0: globals8 +Host/allClient compile +affected
normal scoped bundles +ACTUAL built Loader1 +diffcheck. No active jobs remain.
Logs /tmp/step73-global-coverage-bound-owner-{tests-final,build,loader}.log,
/tmp/step73-global-coverage-{host-final,client-final,jsonl-regression}.log and
fingerprints-final.txt. All jobs218–229 collected; earlier failed experiments
remain in their /tmp logs, not silently promoted to PASS.
Current mutable producer fingerprints: maintenance source
119d61804bdd89450df48405e926ba3b31cd7ba63823b60764af1284ca55acd2;
compiled maintenance.js 62b1c9663d6941cfab2e1191e38afb84779cf3514b0cb6a61a2575389d670140;
compiled agent-loop/index.js 1d3bfa46a54218ae55ff86063672cd6d8b7cd3578c5f28492645ea07f0cfd7b4;
compiled JSONL/index.js 4917e008e5581f3acaf897c68f37c768384a8145be5aab33243dad2d909566fb.
Native HEAD remains3ec93e07aa59ff66135e81202a54ccbc4c8f4eca; adapter/broker untouched.
All evidence producer-only; no whole73 review/final pin/activation claimed.
Broker/notifier exact partition and consumer contract above unchanged this unit.
Remaining source group: staged old35af additive bridge/boot overlays, then final
exact bundles/profile/broker proof and root-carrier independent review.

## Root scope-reset STOP checkpoint

Root reset supersedes all queued next-unit instructions. No new implementation,
test/build job, bridge, bundle expansion, worker or runtime action after reset.
Current job-list inspected on reset follow-up: NO running jobs. Newly collected
active job IDs at this checkpoint: NONE; all previous jobs were already collected.
Backend213/215 complete producer evidence retained. Later four-group source work
was finished before reset arrived; 225/226/227/229 successful results retained,
including actual workflow/maintenance tests and compile/Loader evidence.
Earlier failures218/219/220/221/222/223/224/228 remain historical failures with their
corrections qualified as above; no new failure or partial running job at STOP.
All source, staged edits, artifacts and history preserved; no reset/discard/deploy.
Remaining UNVERIFIED whole73 gaps: old35af additive bridge and boot overlay
compatibility, final immutable exact bundle/profile Focus+Pythoncaller proof,
whole-source independent review/native pins and71/72 activation. These are
NOT next steps authorized to start now. Source proof is not runtime proof.
No sharedledger/queue/fence137578/completion, installed patch, auth/model or live
action; root independently owns conductor lifecycle assessment. STOP/FINAL RETURN.

## Fresh-root bounded old-Host / boot-overlay intake after STOP

Fresh root explicitly resumed ONLY sequential source/staging remaining73;
this entry does not authorize live activation or failed137578 shared writes.
No native source was changed in this bounded unit. Preserved all four-global
and backend213/215 source evidence and all STOP/history.

New adapter artifacts:
STEP73-OLD-BOOT-COMPATIBILITY.md and tests/boot-compatibility.test.py.
Three keyless read-only negative-qualification tests exit0; log
/tmp/step73-old-boot-compatibility.log. No background jobs started; none active.
Actual isolated current-adapter lib import against preserved old LLM fails:
missing ToolCallId export. Actual historical pure runtime_text refuses current
index AND app-server; marker bypass would still allow old patch_runtime to
overwrite helper and remove owned RPC successful-write callback. Installed
apply.py/helpers/profiles/boot recorder were never modified or executed.

Exact35af basis has no maintenance receiver/admission hook; old create/resume
and driver.send bypass a newly mounted controller. Thus additive bridge remains
UNIMPLEMENTED, not falsely complete: requires source-level guards in old native
factory/message/job/delegate/workflow and actual backend evidence, Loader ordering,
old-source compile/race tests. Exact APIs and negative experiment in new adapter
artifact. No new runtime facade/updater/guessed zero introduced.

Versioned .2 tarball retained intact, SHA
bd763dfc32d9b724255a8c418ca196dc350542397bcd1f8d8219360241882cc7.
Whole73 gaps unchanged: actual old bridge, final immutable bundled/profile/Python
caller qualification, root independent review/exact pins; activation separate.
This unit is PARTIAL negative qualification, not bridge PASS/native pin.
No notifier18/65 owner paths, broker, adapter source/lib, sharedledger/queue,
auth/account/runtime/pointer changes. Return root for bounded continuation.

## Old additive bridge concrete feasibility disposition

Actual old compiled Loader bypass proof: new
packages/core/agent-loop/tests/old-host-additive-bypass.mjs, exit0 (expected bypass,
NOT fencePASS), /tmp/step73-old-loader-bypass.log. Isolated real old services,
same Agent/underlying AgentLoop; captured followup before CLOSED additive
hostAdmission yields real inbox commit and ONE keyless model entry, gate callsZERO.
Exact35af checkout and compiled hashes bound in log; no live process touched.
Old private input/driver path lacks supported pre-entry reservation interception.
Complete supported additive firstcutoff infeasible at this held ingress; no
internal patch/service replacement/oldfork/source-restart relabel attempted.
Root must separately coordinate external cold transition/quiescence then current
qualified native boot, NOT automatic interrupt or old Agentidle join inference.

Adapter tools/check-native-delivery.mjs explicitly refuses actual old native ABI
or absent modules exit6; tests/native-delivery-guard.test.mjs twoPASS. Supported
shape is ABI_PREFLIGHT_ONLY/deliveryAuthorized=false/drainNOTPROVEN. Guard is
external staging companion, NOT installed hook/updater. Detailed disposition in
adapter STEP73-OLD-BOOT-COMPATIBILITY.md. Preserved .2 tar/source/lib and installed
apply/helpers unchanged. No unchanged suites/build/agents/sharedwrites/live actions.
No jobsactive. STOP/FINAL RETURN bounded feasibility blocker. Final immutable
bundle/profile/root review and exactpins remain separate; no whole73PASS.

## Isolated exact old35af source implementation bounded candidate

Fresh root authorized old SOURCE guards (not additive live interception).
Sanctioned forage-wt created scratch-step73-old-source at exact35af, branch
agents/forge/step73-old-source. Concrete guarded factory/message/Inbox/job/
delegate/continuable/workflow ingress, preclose factory/raw-setup reservations,
actual LLM instance+generation+pending caller+backendStatus retention implemented.
Nine targeted source tests job248 exit0 and affected canonical package compile
239/243/248 exit0; wholeHost236 retains unrelated baseline spoken UI TS6307.
No65/notifier files edited, no assertion weakening. Rebuilt actual plain-Node old
Loader job247 exit0 verifies dependency ordering and formerly-held ingress now
refused zero model turns. Final249 collected exit0 current affected closure
bundles +real Loader proof; final248 affected compile+9tests exit0. All230–249
collected noneactive; detailed exact compiled fingerprints in old source checkpoint.

Detailed partial implementation/source checkpoint:
scratch-step73-old-source/STEP73-OLD-SOURCE-CHECKPOINT.md.
Final staged source tree 0d08552c11f1c93e7b5dbb6265a5436f58630453 (not commit/nativewholepin);
source patch /tmp/step73-old-source-candidate.patch SHA256
281d959d2948c545dae0fb84c52e80609807da58d5ecd3cf46440a2ae388485b.

Explicit remaining demonstrated contract: old preclose providerawait then later
factorycreate still lacks original-request-bound HostInitialAdmission; negative
test proves refusal + retained delegateUNKNOWN, not accepted lineage. Minimal
next extension is current exact one-shot initial capability into old resolved
request/driver/factory/Inbox; no general maintenance facade. Old WorkerRun.dispose
may grace-abandon child starts (host.ts237–245) and contain dispose failures;
workflow reservation remainsUNKNOWN, not released as join. Continuable compiler/
acceptance and durable authenticated closed boot receiver remain unqualified.
Existing actual backend evidence consumes optional status; unsupported old adapters
remainUNKNOWN. Current .2 staged delivery still REFUSES oldABI; no old textualapply.

No live Host already-fenced or safe firstcutoff claim, install/restart/profile/
auth/account/pointer/sharedledger/queue/newworker action. Frozen isolated deps
installed after only stale3line lock importer removal; generated files local
and hooks worktree-local. Source producer candidate PARTIAL, no whole73PASS/review.

## Blockers and jobs

CURRENT: bash-112 collected exit0 current native Host `pnpm exec tsc -b tsconfig.host.json --pretty false` AND allClient `pnpm run typecheck:contracts-ready`; logs `/tmp/step73-receiver-{host,client}-tsc.log`. bash-113 collected exit0 follow-up maintenance2+Focus2+actualHTTP1+cancel44 =49pass, `/tmp/step73-receiver-followup.log`. All jobs started in this continuation collected; none left running. Earlier full clean bundle build predates receiver additions (not current receiver bundle proof). These remain producer-only results, not independent PASS. Same sole native writer, no additional agents.

Focus disposition repair COMPLETE as source implementation/unit evidence: rejected/discarded/disposed terminal vs cancelled-before-entry recoverable, Stop != dispose. Original assertions retained and 202pass then broad300pass. Remaining: genuine Focus-specific shipped-profile keyless snapshot, current full bundled receiver build, independent scope/review. Canonical generator includes necessary host/maintenance event in addition to notification closure; no unexplained source/generated work reset.

Rev4 receiver PARTIAL implemented as described above; historical absent-receiver paragraphs are superseded, not external blockers. Remaining implementation invariants: control-log claim cannot be ACKed as executed successor because native agent creation/publication and inbox/model entry happen on another leased session log; crash after effect/before control receipt must not create/start twice, and crash before effect must not lose the baton. Proposed minimal next implementation: durable outbox launch intent carrying immutable validated native launch options plus stable initial messageId, materialize deterministic session through existing create/resume factory, reconcile inbox/entered evidence before re-enqueue, durably settle outbox; never infer started from claim alone. Similarly receipt batch currently commits evidence only, not downstream supervisor/notification execution; needs idempotent outbox delivery. Actual crash/restart tests must qualify those two-log reconciliation windows. Caller launch authority/profile contract is NOT present in claim-only schema; do not accept arbitrary prompt-supplied owner/profile. This is unfinished native implementation, not mere absence-of-transaction blocker. Task70 external owner separate; no external edits or activation.
