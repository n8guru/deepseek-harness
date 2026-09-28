/**
 * DSH operator-session capture (mesh-dsh-merge step 56).
 *
 * A DSH host plugin that mirrors, per turn, the operator's typed words and the
 * agent's final reply to the existing `/v3/terminal-mirror` route — the same
 * two kinds (`operator-terminal-prompt`, `agent-terminal-reply`) the
 * interactive Claude Code / Codex / Grok hooks already post, so DSH stops
 * being the one surface where Nate's input is stored nowhere
 * (tools/insights-audit/REPORT-dsh.md, finding 1).
 *
 * Host half only: it needs no browser code, no new route and no schema change.
 *
 *   * Operator words: `user/message` with `source.kind === 'user'` AND
 *     `source.clientTimeZone` -> `operator-terminal-prompt`, `from: 'N8'`.
 *   * Final reply per turn: the last assistant text of a turn, posted at
 *     `turn/end` -> `agent-terminal-reply`, tagged `notice: null` when it
 *     answered Nate or `notice: <source kind>` when it answered a notice.
 *   * Nothing else is ever stored. Plugin / subagent-settled / timezone-less
 *     user turns are never filed as Nate, and a session that never saw a
 *     zone-bearing user turn (mesh, headless, subagent) stores nothing at all.
 *
 * @module dsh-terminal-mirror
 */
import { hostname } from 'node:os'
import { classifyUserTurn, operatorPayload, replyPayload, skipText, textOfContent } from './classify.js'
import { createPoster } from './post.js'

const name = 'dsh-terminal-mirror'

// No service dependency: `session/event` is a global-scope core event, injected
// here so the listener is mounted as soon as the host is up.
const inject = []

/** Author for DSH agent turns: the per-machine mirror identity, overridable. */
export function defaultAgentAuthor(env = process.env) {
  const configured = env.DSH_TERMINAL_MIRROR_AGENT
  if (typeof configured === 'string' && configured.trim().length > 0) return configured.trim()
  return `claudecode_${hostname().split('.', 1)[0].toLowerCase()}`
}

/** Session presets that are machine harnesses by construction (never stored). */
export function defaultIgnorePresets(env = process.env) {
  const raw = env.DSH_TERMINAL_MIRROR_IGNORE_PRESETS
  if (typeof raw === 'string') {
    return raw.split(',').map(value => value.trim()).filter(value => value.length > 0)
  }
  return ['mesh-worker']
}

/**
 * The mirror state machine, separated from the plugin shell so tests can drive
 * it without a Cordis runtime.
 * @param options - `post`, `agentFrom`, `ignorePresets`, `logger`.
 */
export function createMirror(options = {}) {
  const {
    post = createPoster(),
    agentFrom = defaultAgentAuthor(),
    ignorePresets = defaultIgnorePresets(),
    logger = message => process.stderr.write(`[${name}] ${message}\n`),
  } = options

  const sessions = new WeakMap()
  const stats = { prompts: 0, replies: 0, skipped: 0, failures: 0 }

  function stateFor(session) {
    if (session === null || typeof session !== 'object') return undefined
    let state = sessions.get(session)
    if (state === undefined) {
      state = { operator: false, notice: null, reply: null, ignored: false }
      sessions.set(session, state)
    }
    return state
  }

  function isIgnored(session) {
    const preset = session?.header?.agentPreset
    return typeof preset === 'string' && ignorePresets.includes(preset)
  }

  /** Fire a payload without ever letting a mirror failure disturb the turn. */
  function send(payload, counter) {
    stats[counter] += 1
    void Promise.resolve()
      .then(() => post(payload))
      .then(result => {
        if (result !== undefined && result.ok === false) stats.failures += 1
      })
      .catch(error => {
        stats.failures += 1
        logger(`post failed: ${String(error?.message ?? error)}`)
      })
  }

  /**
   * Observe one appended session event. Called for every committed event in
   * every session on this host.
   */
  function observe(session, event) {
    if (stateFor(session) === undefined || event === null || typeof event !== 'object') return
    const state = sessions.get(session)
    if (!state.ignored && isIgnored(session)) state.ignored = true

    if (event.type === 'user/message') {
      if (state.ignored) return
      const source = event.data?.source
      const classified = classifyUserTurn(source)
      if (classified.origin === 'seed') return
      if (classified.origin === 'operator') {
        state.operator = true
        state.notice = null
        const body = textOfContent(event.data?.content)
        // The turn is real either way; an empty or system-echo prompt just is
        // not stored (same rule as intent-log.py `_skip_text`).
        if (skipText(body)) {
          stats.skipped += 1
          return
        }
        send(operatorPayload({ body, sessionUuid: session.id }), 'prompts')
        return
      }
      // Machine text: never stored as Nate. It only tags the reply it opens.
      state.notice = classified.notice
      return
    }

    if (event.type === 'assistant/message') {
      if (state.ignored || !state.operator) return
      const body = textOfContent(event.data?.message?.content)
      // A turn runs many steps; the LAST text of the turn is its final reply.
      if (body.length > 0) state.reply = body
      return
    }

    if (event.type === 'turn/end') {
      const body = state.reply
      const notice = state.notice
      state.reply = null
      state.notice = null
      if (state.ignored || !state.operator) return
      if (body === null || body === undefined || skipText(body)) {
        if (body !== null && body !== undefined) stats.skipped += 1
        return
      }
      send(replyPayload({ body, sessionUuid: session.id, notice, from: agentFrom }), 'replies')
    }
  }

  return { observe, stateFor, stats, agentFrom, ignorePresets }
}

/**
 * Cordis plugin entry: mount the mirror on the host's event firehose.
 * @param ctx - the plugin's Cordis context.
 * @param config - optional `post`, `agentFrom`, `ignorePresets`, `logger`.
 */
function apply(ctx, config) {
  const mirror = createMirror(config)
  // `global: true`: the mirror must see every session on the host, not only the
  // ones entered through this plugin's own context — Cordis filters a scoped
  // dispatch by the listener's context, and operator sessions belong to the web
  // client's agent scope, not to this plugin's.
  ctx.on('session/event', (session, event) => mirror.observe(session, event), { global: true })
  return mirror
}

export { name, inject, apply }
export default { name, inject, apply }
