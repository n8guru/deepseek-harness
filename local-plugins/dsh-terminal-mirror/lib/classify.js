/**
 * Pure classification for the DSH -> Forage terminal mirror.
 *
 * One rule decides everything (mesh-dsh-merge step 56, Nate verbatim: "my
 * inputs and your final turns are supposed to be stored in the content db.
 * autonomous mesh can be ignored, but sessions like this - operator sessions.
 * are meant to be stored."):
 *
 *   An *operator session* is a DSH session in which a human typed. A human
 *   typed iff a `user/message` event carries `source.kind === 'user'` AND a
 *   Host-validated browser time zone (`source.clientTimeZone`, set from
 *   `resolvedClientTimeZone()` in the web client's prompt RPC). Every other
 *   `user/message` event is machine text: the plugin's own notices
 *   (`kind: 'plugin'`), a settled child (`kind: 'subagent-settled'`), a
 *   conductor hand-forward (`kind: 'user'` with no zone), or runtime seeding
 *   (`agent-instructions`, `skill-catalog`).
 *
 * That rule is structural, so "headless/mesh DSH sessions store nothing" needs
 * no environment heuristic: a mesh task's session has machine prompts only,
 * never latches operator, and therefore stores nothing. This matters because
 * the DSH host serves operator GUI sessions and mesh sessions in ONE process,
 * so any process-wide `FORAGE_MESH_HEADLESS` gate would either silence the
 * operator's own typing or fail to silence the mesh.
 *
 * The evidence for the discriminator is tools/insights-audit/REPORT-dsh.md
 * ("[new] DSH already knows who typed", Appendix A7).
 */

/** Author the Forage route maps to the operator (user_id=1). */
export const OPERATOR_AUTHOR = 'N8'

/** The two kinds /v3/terminal-mirror accepts. */
export const OPERATOR_KIND = 'operator-terminal-prompt'
export const REPLY_KIND = 'agent-terminal-reply'

/**
 * Source kinds that are runtime seeding, not a turn from anybody: they arrive
 * before the first turn/start and must neither latch operator nor be recorded
 * as a notice.
 */
export const SEED_SOURCE_KINDS = new Set(['agent-instructions', 'skill-catalog'])

/**
 * Prompt text the interactive hooks already refuse to mirror — slash-command
 * echoes and injected system blocks. Kept byte-identical to
 * mesh-infra/hooks/intent-log.py `_skip_text` so DSH and the other harnesses
 * agree on what an operator prompt is.
 */
export const SKIPPED_PREFIXES = [
  '<command-name>',
  '<command-message>',
  '<system-reminder>',
  '<task-notification>',
]

/** Text of one message content array: the `text` blocks, joined by blank lines. */
export function textOfContent(content) {
  if (!Array.isArray(content)) return ''
  return content
    .filter(block => block !== null && typeof block === 'object' && block.type === 'text')
    .map(block => (typeof block.text === 'string' ? block.text : ''))
    .filter(text => text.length > 0)
    .join('\n\n')
    .trim()
}

/** Whether the interactive hooks would refuse this body (mirrors intent-log.py). */
export function skipText(text) {
  const value = String(text ?? '').trim()
  if (value.length === 0) return true
  return SKIPPED_PREFIXES.some(prefix => value.startsWith(prefix))
}

/**
 * Classify one `user/message` source.
 * @param source - the event's `data.source` (untrusted shape).
 * @returns `{origin:'operator'}` for the operator's own typing,
 *   `{origin:'notice', notice:<kind>}` for machine text, or
 *   `{origin:'seed'}` for runtime seeding.
 */
export function classifyUserTurn(source) {
  const kind = typeof source?.kind === 'string' ? source.kind : ''
  if (kind === 'user') {
    const zone = source?.clientTimeZone
    if (typeof zone === 'string' && zone.trim().length > 0) return { origin: 'operator' }
    return { origin: 'notice', notice: 'user-without-timezone' }
  }
  if (SEED_SOURCE_KINDS.has(kind)) return { origin: 'seed' }
  // Unknown kinds are machine text: only a zone-bearing user turn is ever the
  // operator, so a kind this build has never seen can never be credited to him.
  return { origin: 'notice', notice: kind.length > 0 ? kind : 'unknown-source' }
}

/**
 * The mirror payload for one operator prompt.
 * @param body - the operator's typed words.
 * @param sessionUuid - the DSH session id (the route's dedup + linking key).
 */
export function operatorPayload({ body, sessionUuid }) {
  return {
    from: OPERATOR_AUTHOR,
    body: String(body).trim(),
    kind: OPERATOR_KIND,
    session_uuid: sessionUuid,
    notice: null,
  }
}

/**
 * The mirror payload for one turn's final reply.
 *
 * Nate chose option A (scratchboard board #3 v2, question 1): an operator
 * session stores ALL of the agent's final replies, tagged with whether the
 * turn answered him or answered a machine notice. The tag rides this additive
 * `notice` field: `null` = answered Nate, otherwise the source kind of the
 * message that opened the turn.
 */
export function replyPayload({ body, sessionUuid, notice, from }) {
  return {
    from,
    body: String(body).trim(),
    kind: REPLY_KIND,
    session_uuid: sessionUuid,
    notice: notice ?? null,
  }
}
