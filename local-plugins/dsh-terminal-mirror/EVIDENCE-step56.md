# Evidence — DSH operator-session capture (mesh-dsh-merge step 56)

Branch `agents/forge/mesh-dsh-merge-step56-session-capture` in the DSH repo,
isolated worktree `/home/n8/wt-dsh-task-133519`, based on DSH commit
`f20c04fd2451743ca5cd0c6f8f127821b76a4cba`. Producer task 133519.

Everything below was observed on forge on 2026-09-28. Nothing was deployed:
the production checkout `/home/n8/deepseek-harness` was not edited and no DSH
process was restarted, so the live canary is still outstanding (last section).

## What was built

`local-plugins/dsh-terminal-mirror/` — new files only:

| File | Role |
|---|---|
| `lib/classify.js` | the rule: who typed, who only spoke, what is seeding; payload builders |
| `lib/post.js` | Studio-token lookup + fail-open POST to the existing `/v3/terminal-mirror` |
| `lib/index.js` | the Cordis host plugin (`session/event` firehose → mirror) |
| `lib/backfill.js` | conductor-log replay with a durable idempotency key |
| `bin/dsh-terminal-mirror-backfill.mjs` | the backfill CLI |
| `tests/classify.test.mjs`, `tests/plugin.test.mjs`, `tests/backfill.test.mjs` | 25 tests |
| `README.md` | the rule, the payload, install/rollback, follow-on work |

No new Forage route: the payload goes to `/v3/terminal-mirror`, the same
endpoint `mesh-infra/hooks/intent-log.py` posts to, with the same author
(`N8`), the same two kinds, and the same `{from, body, kind, session_uuid}`
keys — plus one additive tag (`notice`, see below).

## Clause 1 — payload shape

`node --test tests/classify.test.mjs`, test *payload shape matches the
intent-log.py contract*:

```
{ from: 'N8', body: 'blue shoes', kind: 'operator-terminal-prompt', session_uuid: 'sess-1', notice: null }
{ from: 'claudecode_forge', body: 'answer', kind: 'agent-terminal-reply', session_uuid: 'sess-1', notice: null }
```

The four keys intent-log.py posts are byte-identical in name and value
semantics (`from`, `body` stripped, `kind`, `session_uuid`). `notice` is the
option-A tag: `null` = the turn answered Nate, otherwise the source kind of the
message that opened the turn. The route reads a fixed field set, so `notice` is
carried but not yet persisted — recorded as follow-on work in the README, not
claimed as landed.

## Clause 2 — classification matrix

`node --test tests/*.test.mjs` (25 tests, all green; 279 ms):

```
# tests 25
# pass 25
# fail 0
```

The matrix is pinned by these tests:

| Test | Assertion |
|---|---|
| *operator words require kind=user AND a browser time zone* | zone-bearing `kind:'user'` → operator; whitespace zone, missing zone → `notice: 'user-without-timezone'` |
| *plugin, subagent-settled and job notices are never Nate* | `plugin`, `subagent-settled`, `tool-job`, `job`, `agent-message`, and an unseen future kind all classify as notices |
| *runtime seeding is neither an operator turn nor a notice* | `agent-instructions`, `skill-catalog` → `seed`, ignored entirely |
| *a canary-shaped interaction posts the operator prompt and the reply with correct author/kind* | operator body posted `from: 'N8'` / `operator-terminal-prompt`; reply posted `from: 'claudecode_forge'` / `agent-terminal-reply` |
| *option A: a reply to a notice is stored, tagged with the notice kind* | observed `[['operator-terminal-prompt', null], ['agent-terminal-reply', null], ['agent-terminal-reply', 'plugin'], ['agent-terminal-reply', 'subagent-settled']]` — notices themselves are never posted, and never as Nate |
| *a timezone-less user turn is machine text, not Nate* | a conductor hand-forward turn produces exactly one operator prompt (the real one) and its reply carries `notice: 'user-without-timezone'` |

Cross-check against the real conductor logs (see clause 5 table): 142 replies
tagged `plugin`, 113 `subagent-report`, 110 `subagent-settled`, 4
`skill-invocation`, 404 tagged `null`. Notices appear only as reply tags; not
one of them becomes an operator prompt.

## Clause 3 — headless / mesh DSH sessions store nothing

Two independent tests:

* *headless / mesh DSH sessions store nothing at all* — a `mesh-worker` session
  with a task-body prompt, two assistant replies and two tool-job notices posts
  `[]` with `ignorePresets: []`, i.e. on the structural rule alone.
* *a session with machine text and replies but NO timezone-bearing turn stores
  nothing* — same result with no preset involvement at all.
* *the mesh-worker preset is ignored even if a zone-bearing turn appears* —
  the per-session preset belt, tested separately.

The gate is per session, not per process, deliberately: the DSH host serves
operator GUI sessions and mesh sessions in one process, so a process-wide
`FORAGE_MESH_HEADLESS` check (what `intent-log.py` uses) would either silence
Nate's own typing or fail to silence the mesh.

## Clause 4 — backfill idempotency (re-run inserts 0 duplicates)

Proven twice: at library level and through the shipped CLI binary.

`tests/backfill.test.mjs`, test *backfill posts once and a re-run inserts 0
duplicates* (synthetic log, real HTTP sink, real token file):

```
first  run: posted 3 (1 prompt, 2 replies), failures 0, sink received 3
second run: posted 0, skippedExisting 3, failures 0, sink received 3  ← no network at all
state file: 3 keys, each with the returned content_id
```

Test *the CLI inserts once and reports 0 on a re-run* runs
`node bin/dsh-terminal-mirror-backfill.mjs` twice as a child process against a
local sink:

```
run 1: {"posted":3,"skippedExisting":0,"failures":0}
run 2: {"posted":0,"skippedExisting":3,"failures":0}
```

Two supporting properties:

* *a failed post is not recorded, so the next run retries it* — 3 failures then
  3 posts, no silent loss.
* *dry run posts nothing and writes no state* — the reported 3 rows are never
  sent and the state file stays empty.

Idempotency lives in the tool because the route cannot provide it: its dedup
window is 60 s over the same `(session_uuid, kind, body)`. The key is
`sha256(session_id|kind|event seq)` recorded in
`~/.dsh/terminal-mirror/backfill-state.json`.

## Clause 5 — the real conductor logs replay cleanly (dry run only)

```
$ node bin/dsh-terminal-mirror-backfill.mjs --dry-run       # 2026-09-28T02:51Z
{ "statePath": ".../backfill-state.json", "sessions": 16, "operatorSessions": 16,
  "prompts": 502, "replies": 773, "posted": 1275, "skippedExisting": 0,
  "failures": 0, "dryRun": true, ... }
```

Per-session and tag detail from the same replay (real `.jsonl.zstd`, decoded
with the `zstd` CLI, which handles DSH's concatenated frames — `node:zlib`
stops after the first frame and returned 171 of 898 lines on
`conductor-forge-agent-os-2`):

```
cadence-gen-9  prompts=32 replies=36 notice_turns=9      conductor-forge-agent-os-3  prompts=107 replies=210 notice_turns=134
cadence-gen-10 prompts=13 replies=13 notice_turns=6      conductor-forge-agent-os-4  prompts=25  replies=34  notice_turns=13
cadence-gen-11 prompts=17 replies=29 notice_turns=17     conductor-forge-agent-os-5  prompts=28  replies=29  notice_turns=4
cadence-gen-12 prompts=32 replies=43 notice_turns=16     conductor-forge-agent-os-6  prompts=21  replies=23  notice_turns=7
cadence-gen-13 prompts=33 replies=49 notice_turns=19     conductor-forge-agent-os-7  prompts=18  replies=21  notice_turns=4
cadence-gen-14 prompts=29 replies=39 notice_turns=16     conductor-forge-agent-os-8  prompts=45  replies=56  notice_turns=15
cadence-gen-15 prompts=22 replies=31 notice_turns=13     conductor-forge-agent-os-9  prompts=40  replies=74  notice_turns=41
                                                         conductor-forge-agent-os-10 prompts=33 replies=80 notice_turns=54
reply notice tags: null=404, plugin=142, subagent-report=113, subagent-settled=110, skill-invocation=4
```

The `--dry-run` run touched no network and wrote no state file. **The live
insert was deliberately not run**: `verifier_gate` requires an independent
cross-provider verify before any deploy, and writing production content rows is
the deploy-side effect of this step. Run it after the verify, in one command:

```bash
cd local-plugins/dsh-terminal-mirror && node bin/dsh-terminal-mirror-backfill.mjs
```

## Test prerequisites on this host

`pnpm install` and `pnpm run build:lib:host` were run in the worktree.
`build:lib:host` FAILS on this checkout with pre-existing, unrelated TS6307
errors in `packages/client/ui-primitives` (files this branch does not touch;
the same command fails on untouched master). The node `--test` suites need
`@deepseek-ai/cordis` resolvable, exactly as `local-plugins/dsh-operator-discuss`
does, so the two built vendored libs cordis needs (`vendor/cordis/lib`,
`vendor/cosmokit/lib` — both gitignored build output) were copied from the
already-built sibling checkout `/home/n8/deepseek-harness`, which is at the same
commit `f20c04fd24`. A verifier in a fresh worktree reproduces this with
`pnpm install && pnpm run build:lib:host` where that gate passes, or by copying
those two `lib/` directories.

## Outstanding verification asks

1. **Operator-dependent canary (not run, not faked).** A phrase Nate types in
   the DSH GUI, and the agent's reply to it, must both appear in content within
   30 s with author `N8` / `claudecode_forge` and kinds
   `operator-terminal-prompt` / `agent-terminal-reply`. This is impossible until
   the plugin is installed into the profile the web host boots
   (`~/.dsh/profiles/web/package.json` + a drained-window DSH restart), which is
   the deploy action this dispatch forbids. Exact install/rollback steps are in
   the plugin README.
2. **Independent cross-provider verify** before any deploy, per `verifier_gate`.
3. **Production backfill run** (one command above) after the verify.
4. **Server-side tag persistence** (`notice`) is a few lines in
   `v3_terminal_mirror`'s `extra` dict — an edit to an existing Forage route,
   outside this step's grant.
