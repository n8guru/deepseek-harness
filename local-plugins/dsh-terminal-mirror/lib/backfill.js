/**
 * Idempotent backfill of the forge-agent-os conductor sessions
 * (mesh-dsh-merge step 56): replay each session's own log through the SAME
 * classifier the live plugin uses, and post the operator turns and final
 * replies the live path would have posted had it existed then.
 *
 * Idempotency is owned here, not by the route: `/v3/terminal-mirror` only
 * dedups against a 60 s window of the same `(session_uuid, kind, body)`, which
 * cannot cover a replay. Every posted row is recorded in a durable state file
 * keyed by `(session id, kind, event seq)`; a re-run skips those keys without
 * touching the network, so a second run inserts 0 rows.
 *
 * @module dsh-terminal-mirror/backfill
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { classifyUserTurn, operatorPayload, replyPayload, skipText, textOfContent } from './classify.js'

export const STATE_VERSION = 1

/** Session ids this step backfills (forge-agent-os conductor sessions). */
export const DEFAULT_PATTERNS = ['cadence-gen-', 'conductor-forge-agent-os-']

export function defaultSessionRoot(env = process.env) {
  return env.DSH_SESSION_ROOT || join(homedir(), '.dsh', 'sessions')
}

export function defaultStatePath(env = process.env) {
  return env.DSH_TERMINAL_MIRROR_STATE || join(homedir(), '.dsh', 'terminal-mirror', 'backfill-state.json')
}

/** Decompress a session artifact to text. `zstd` handles DSH's concatenated frames. */
export function readLogText(file) {
  if (!file.endsWith('.zstd')) return readFile(file, 'utf8')
  const result = spawnSync('zstd', ['-dc', '--', file], { maxBuffer: 512 * 1024 * 1024 })
  if (result.error) throw new Error(`zstd is required to read ${file}: ${result.error.message}`)
  if (result.status !== 0) {
    throw new Error(`zstd -dc ${file} failed (${result.status}): ${String(result.stderr).slice(0, 200)}`)
  }
  return result.stdout.toString('utf8')
}

/**
 * Parse one session artifact into its header and committed events.
 * Packed chunk rows (`text-chunks` / `reasoning-chunks` / `tool-call-chunks`)
 * carry streamed deltas only and are skipped: the complete text lives on the
 * `assistant/message` event.
 */
export function parseSessionLog(text) {
  let header
  const events = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    let record
    try {
      record = JSON.parse(trimmed)
    } catch {
      continue // torn tail
    }
    if (record?.type === 'session') {
      header = record
      continue
    }
    if (typeof record?.seq !== 'number' || typeof record.type !== 'string') continue
    events.push(record)
  }
  return { header, events }
}

/** Session directories under the DSH session root whose id matches a pattern. */
export async function discoverSessionLogs({ root = defaultSessionRoot(), patterns = DEFAULT_PATTERNS } = {}) {
  const found = []
  let projectDirs
  try {
    projectDirs = await readdir(root, { withFileTypes: true })
  } catch {
    return found
  }
  for (const project of projectDirs) {
    if (!project.isDirectory()) continue
    const projectPath = join(root, project.name)
    let sessionDirs
    try {
      sessionDirs = await readdir(projectPath, { withFileTypes: true })
    } catch {
      continue
    }
    for (const session of sessionDirs) {
      if (!session.isDirectory()) continue
      if (!patterns.some(pattern => session.name.startsWith(pattern))) continue
      const dir = join(projectPath, session.name)
      for (const file of ['session.jsonl.zstd', 'session.jsonl']) {
        try {
          await readFile(join(dir, file))
        } catch {
          continue
        }
        found.push({ sessionId: session.name, file: join(dir, file) })
        break
      }
    }
  }
  return found.sort((a, b) => a.sessionId.localeCompare(b.sessionId))
}

/**
 * Replay one log to the entries the live mirror would have posted.
 * @returns `{sessionId, cwd, agentPreset, operator, entries}` where each entry
 *   is `{key, kind, seq, payload}`.
 */
export function turnEntries({ sessionId, header, events, agentFrom }) {
  const entries = []
  let operator = false
  let notice = null
  let reply = null

  const push = (kind, seq, payload) => {
    entries.push({ key: entryKey(sessionId, kind, seq), kind, seq, payload })
  }

  for (const event of events) {
    if (event.type === 'user/message') {
      const classified = classifyUserTurn(event.data?.source)
      if (classified.origin === 'seed') continue
      if (classified.origin === 'operator') {
        operator = true
        notice = null
        const body = textOfContent(event.data?.content)
        if (!skipText(body)) {
          push('operator-terminal-prompt', event.seq, operatorPayload({ body, sessionUuid: sessionId }))
        }
        continue
      }
      notice = classified.notice
      continue
    }
    if (event.type === 'assistant/message') {
      if (!operator) continue
      const body = textOfContent(event.data?.message?.content)
      if (body.length > 0) reply = body
      continue
    }
    if (event.type === 'turn/end') {
      const body = reply
      const turnNotice = notice
      reply = null
      notice = null
      if (!operator || body === null || skipText(body)) continue
      push('agent-terminal-reply', event.seq, replyPayload({
        body, sessionUuid: sessionId, notice: turnNotice, from: agentFrom,
      }))
    }
  }
  return {
    sessionId,
    cwd: header?.cwd,
    agentPreset: header?.agentPreset,
    operator,
    entries,
  }
}

/** Durable idempotency key: one row per (session, kind, event seq). */
export function entryKey(sessionId, kind, seq) {
  return createHash('sha256').update(`${sessionId}|${kind}|${seq}`).digest('hex')
}

export async function loadState(file) {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'))
    if (parsed !== null && typeof parsed === 'object' && parsed.entries !== undefined) {
      return { version: parsed.version ?? STATE_VERSION, entries: parsed.entries ?? {} }
    }
  } catch {
    // A missing or unreadable state file means "nothing posted yet".
  }
  return { version: STATE_VERSION, entries: {} }
}

export async function saveState(file, state) {
  await mkdir(dirname(file), { recursive: true })
  const temporary = `${file}.tmp`
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`)
  await rename(temporary, file)
}

/** Load a log, replay it, and post whatever the state file does not already hold. */
export async function backfillLog({ sessionId, file, post, state, agentFrom, dryRun = false, logger }) {
  const text = await readLogText(file)
  const { header, events } = parseSessionLog(text)
  const replay = turnEntries({ sessionId, header, events, agentFrom })
  const summary = {
    sessionId,
    cwd: replay.cwd,
    operator: replay.operator,
    prompts: 0,
    replies: 0,
    posted: 0,
    skippedExisting: 0,
    skippedEmpty: 0,
    failures: 0,
  }
  if (!replay.operator) {
    // Mesh / headless session: no zone-bearing user turn, so nothing is stored.
    summary.skippedEmpty = 0
    return summary
  }
  for (const entry of replay.entries) {
    if (entry.kind === 'operator-terminal-prompt') summary.prompts += 1
    else summary.replies += 1
    if (state.entries[entry.key] !== undefined) {
      summary.skippedExisting += 1
      continue
    }
    if (dryRun) {
      summary.posted += 1
      continue
    }
    const result = await post(entry.payload)
    if (result?.ok === true) {
      state.entries[entry.key] = {
        session: sessionId,
        kind: entry.kind,
        seq: entry.seq,
        contentId: result.contentId ?? null,
        at: new Date().toISOString(),
      }
      summary.posted += 1
    } else {
      summary.failures += 1
      logger(`post failed for ${sessionId} seq ${entry.seq}: ${result?.error ?? 'unknown'}`)
    }
  }
  return summary
}

/**
 * Backfill every conductor session under the session root.
 * @param options - `root`, `patterns`, `sessions`, `statePath`, `post`,
 *   `agentFrom`, `dryRun`, `logger`.
 */
export async function backfill(options = {}) {
  const {
    root = defaultSessionRoot(),
    patterns = DEFAULT_PATTERNS,
    statePath = defaultStatePath(),
    post,
    agentFrom,
    dryRun = false,
    logger = message => process.stderr.write(`[dsh-terminal-mirror] ${message}\n`),
  } = options
  const logs = options.sessions !== undefined
    ? options.sessions
    : (await discoverSessionLogs({ root, patterns }))
        .filter(entry => options.only === undefined || options.only.includes(entry.sessionId))
  const state = options.state ?? await loadState(statePath)
  const totals = {
    sessions: logs.length,
    operatorSessions: 0,
    prompts: 0,
    replies: 0,
    posted: 0,
    skippedExisting: 0,
    failures: 0,
    dryRun,
    perSession: [],
  }
  for (const log of logs) {
    const summary = await backfillLog({ ...log, post, state, agentFrom, dryRun, logger })
    if (summary.operator) totals.operatorSessions += 1
    totals.prompts += summary.prompts
    totals.replies += summary.replies
    totals.posted += summary.posted
    totals.skippedExisting += summary.skippedExisting
    totals.failures += summary.failures
    totals.perSession.push(summary)
    if (!dryRun && summary.posted > 0) await saveState(statePath, state)
  }
  if (!dryRun) await saveState(statePath, state)
  return totals
}
