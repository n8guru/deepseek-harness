/**
 * Transport for the DSH terminal mirror: the Studio token lookup and a
 * fail-open POST to the existing `/v3/terminal-mirror` route.
 *
 * Payload shape and endpoint are the same ones mesh-infra/hooks/intent-log.py
 * already uses for interactive Claude Code / Codex / Grok, so DSH rows land in
 * canvas3 beside them with no new Forage route and no schema change.
 * @module dsh-terminal-mirror/post
 */
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const DEFAULT_ENDPOINT = 'https://forage.ink/v3/terminal-mirror'

/** Token file candidates, in priority order (same list as the other surfaces). */
export function tokenCandidates(env = process.env) {
  return [
    env.FORAGE_STUDIO_TOKEN_FILE,
    join(homedir(), '.config', 'forage', 'studio-token-close'),
    '/etc/forage/studio-token-close',
  ].filter(candidate => typeof candidate === 'string' && candidate.length > 0)
}

/** First readable, non-empty Studio token, or '' when none is available. */
export async function readStudioToken(env = process.env) {
  for (const file of tokenCandidates(env)) {
    try {
      const token = (await readFile(file, 'utf8')).trim()
      if (token.length > 0) return token
    } catch {
      // Try the next candidate; a missing token is a fail-open no-op.
    }
  }
  return ''
}

/**
 * Build the poster the plugin and the backfill both use.
 *
 * Fail-open by construction: a missing token, a network error, a timeout or a
 * non-2xx answer returns a result object and logs; it never throws into the
 * caller's event dispatch, because a mirror failure must not affect a turn.
 * @param options - `endpoint`, `fetchImpl`, `timeoutMs`, `logger`, `env`.
 */
export function createPoster(options = {}) {
  const {
    endpoint = DEFAULT_ENDPOINT,
    fetchImpl = globalThis.fetch,
    timeoutMs = 5000,
    logger = defaultLogger,
    env = process.env,
  } = options
  return async function post(payload) {
    const token = await readStudioToken(env)
    if (token.length === 0) {
      logger(`skip ${payload.kind}: no Studio token`)
      return { ok: false, skipped: true, error: 'no-studio-token' }
    }
    const url = `${endpoint}?${new URLSearchParams({ token }).toString()}`
    try {
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(timeoutMs),
      })
      const text = await response.text()
      let parsed = undefined
      try {
        parsed = JSON.parse(text)
      } catch {
        // A non-JSON body is still an answer; the status decides.
      }
      if (!response.ok) {
        const error = parsed?.error ?? text.slice(0, 200) ?? `HTTP ${response.status}`
        logger(`fail ${payload.kind}: HTTP ${response.status} ${error}`)
        return { ok: false, status: response.status, error: String(error) }
      }
      return { ok: true, status: response.status, contentId: parsed?.content_id ?? null, deduped: parsed?.deduped === true }
    } catch (error) {
      logger(`fail ${payload.kind}: ${String(error?.message ?? error)}`)
      return { ok: false, error: String(error?.message ?? error) }
    }
  }
}

function defaultLogger(message) {
  process.stderr.write(`[dsh-terminal-mirror] ${message}\n`)
}
