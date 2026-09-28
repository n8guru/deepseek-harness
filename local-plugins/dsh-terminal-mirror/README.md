# dsh-terminal-mirror

DSH operator-session capture (mesh-dsh-merge step 56).

DSH was the one interactive surface where Nate's typing was stored nowhere:
Claude Code, Codex and Grok run a hook that mirrors each prompt and final reply
to `/v3/terminal-mirror`, and DSH had no equivalent
(`tools/insights-audit/REPORT-dsh.md`, finding 1). This plugin closes that gap
with no new Forage route and no schema change: it posts the same two kinds to
the same route the hooks already use.

## The rule it implements

An **operator session** is a DSH session in which a human typed. A human typed
iff a `user/message` event carries `source.kind === 'user'` **and** a
Host-validated browser time zone (`source.clientTimeZone`). Nate's rule,
verbatim:

> my inputs and your final turns are supposed to be stored in the content db.
> autonomous mesh can be ignored, but sessions like this - operator sessions.
> are meant to be stored.

| Event | Stored as | Kind |
|---|---|---|
| `user/message`, `source.kind === 'user'` + `clientTimeZone` | Nate (`from: N8`) | `operator-terminal-prompt` |
| the last assistant `text` of every turn in an operator session | the mirror's agent identity | `agent-terminal-reply` |
| `user/message`, `source.kind === 'user'` without a zone | never stored as Nate; tags the reply | — |
| `user/message`, `source.kind === 'plugin'` (tool-job notices) | never stored as Nate; tags the reply | — |
| `user/message`, `source.kind === 'subagent-settled'` / `subagent-report` | never stored as Nate; tags the reply | — |
| any other source kind (`skill-invocation`, …) | never stored as Nate; tags the reply | — |
| `agent-instructions`, `skill-catalog` (runtime seeding) | ignored entirely | — |
| any session with no zone-bearing turn (mesh, headless, subagent) | **nothing at all** | — |

Nate chose **option A** (scratchboard board #3 v2, question 1): an operator
session stores *all* of the agent's final replies, tagged with whether the turn
answered him or answered a machine notice. The tag rides the additive `notice`
payload field: `null` = answered Nate, otherwise the source kind of the message
that opened the turn.

The gate is structural and per session, which is what makes "headless/mesh DSH
sessions store nothing" true without an environment heuristic: the DSH host
serves operator GUI sessions and mesh sessions in **one process**, so a
process-wide `FORAGE_MESH_HEADLESS` check would either silence Nate's own typing
or fail to silence the mesh. A mesh session never carries a zone-bearing turn,
so it never latches operator and never posts. (`ignoredPresets`, default
`['mesh-worker']`, is a second, per-session belt.)

## Payload

The exact shape `mesh-infra/hooks/intent-log.py` posts, plus the `notice` tag:

```json
{
  "from": "N8",
  "body": "everyone should wear blue shoes",
  "kind": "operator-terminal-prompt",
  "session_uuid": "<dsh session id>",
  "notice": null
}
```

The route (`app/routes.py`, `v3_terminal_mirror`) resolves `from` to a User row
(`N8` → user_id 1) and stores `via: terminal-mirror`, `kind`, `session_uuid` in
`extra`. It reads a fixed field set, so `notice` is carried today but not yet
persisted — see "Known follow-on work" below.

## Install (not done here)

The plugin is host-only: no client bundle, no browser code.

1. Land this branch in the checkout the profile links against.
2. Add it to the profile that the web host boots, e.g. in
   `~/.dsh/profiles/web/package.json`:
   ```json
   "dsh-terminal-mirror": "link:../../../deepseek-harness/local-plugins/dsh-terminal-mirror"
   ```
   and append `"dsh-terminal-mirror"` to `dsh.profile.bundles`.
3. Install the profile and restart the DSH host during a drained window
   (`dsh-safe-restart`).

Rollback: remove the dependency and the bundle entry, reinstall the profile,
restart. Nothing else in DSH or Forage is touched; the plugin holds no state of
its own and no Forage data is destroyed.

Environment overrides:

| Variable | Effect |
|---|---|
| `DSH_TERMINAL_MIRROR_AGENT` | author of agent replies (default `claudecode_<host>`) |
| `DSH_TERMINAL_MIRROR_IGNORE_PRESETS` | comma list of session presets never stored; empty string disables |
| `FORAGE_STUDIO_TOKEN_FILE` | Studio token path (default `~/.config/forage/studio-token-close`, then `/etc/forage/studio-token-close`) |
| `DSH_SESSION_ROOT` / `DSH_TERMINAL_MIRROR_STATE` | backfill session root / idempotency state file |

The agent author defaults to `claudecode_<host>` — the identity the interactive
hook already uses on that host, so the reply is credited to a User row that
exists. Splitting it per provider+machine (`deepseek-forge`, `grok-forge`, …) is
the follow-on the same ledger step's pass criteria names; `DSH_TERMINAL_MIRROR_AGENT`
is the knob for it.

## Backfill

Replays the forge-agent-os conductor session logs (`cadence-gen-*`,
`conductor-forge-agent-os-*`) through the *same* classifier and posts what the
live path would have posted:

```bash
cd local-plugins/dsh-terminal-mirror
node bin/dsh-terminal-mirror-backfill.mjs --dry-run   # report only: no posts, no state
node bin/dsh-terminal-mirror-backfill.mjs             # post, recording every row
node bin/dsh-terminal-mirror-backfill.mjs             # re-run: inserts 0 duplicates
```

Idempotency is owned by the tool, not the route: `/v3/terminal-mirror` only
dedups inside a 60 s window of the same `(session_uuid, kind, body)`, which
cannot cover a replay. Every posted row is recorded in
`~/.dsh/terminal-mirror/backfill-state.json` under
`sha256(session_id|kind|event seq)`; a re-run skips those keys without touching
the network. A failed post is deliberately *not* recorded, so the next run
retries it.

`.jsonl.zstd` artifacts are decompressed with the `zstd` CLI, which handles
DSH's concatenated frames (`node:zlib` stops after the first frame). Plain
`session.jsonl` is read directly.

## Tests

```bash
cd local-plugins/dsh-terminal-mirror
node --test tests/*.test.mjs
```

Requires an installed/built workspace (`pnpm install && pnpm run build:lib:host`),
the same prerequisite as `local-plugins/dsh-operator-discuss`: the Cordis-mount
suite resolves `@deepseek-ai/cordis` from the workspace's built `lib/`. On the
machine this was built on, `build:lib:host` fails on a pre-existing, unrelated
TS6307 in `packages/client/ui-primitives`; see `EVIDENCE-step56.md` for how the
two vendored libs cordis needs were supplied instead.

Observed outputs for every acceptance clause, including the ones that do not
depend on Nate, are in `EVIDENCE-step56.md`.

## Known follow-on work (out of this step's scope)

* `notice` is not persisted server-side yet. Persisting it needs a few lines in
  `v3_terminal_mirror`'s `extra` dict (an additive change to an existing route,
  which this step is not authorized to make). Today the tag is durable in the
  producer and in the backfill state file, and a body prefix would be the
  stop-gap if filterability is needed before that lands.
* Per-provider+machine author identities (`deepseek-forge`, `grok-forge`,
  `muse`, `glm`) and Muse CLI capture are named by this ledger step's own pass
  criteria and are not part of this DSH slice.
