// Backfill replay + idempotency, against a local HTTP sink (step 56).
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { backfill, discoverSessionLogs, loadState, parseSessionLog, turnEntries } from '../lib/backfill.js'
import { createPoster } from '../lib/post.js'

const OPERATOR = { kind: 'user', rpcId: 'p1', clientTimeZone: 'America/Los_Angeles' }

function logLines({ operatorTurns = true } = {}) {
  const events = [
    { type: 'session', version: 0, id: 'conductor-fixture', createdAt: 1, cwd: '/home/n8/forge-agent-os', agentPreset: 'conductor' },
    { type: 'permission/preset', seq: 0, time: 1, data: { preset: 'danger-full-access' } },
    { type: 'user/message', seq: 1, time: 2, data: { content: [{ type: 'text', text: 'what is the state of the hub?' }], source: operatorTurns ? OPERATOR : { kind: 'user', rpcId: 'p1' }, role: 'user' } },
    { type: 'turn/start', seq: 2, time: 3, data: { turn: 1 } },
    { type: 'assistant/chunk', seq: 3, time: 4, data: { turn: 1, step: 1, delta: 'Che' } },
    { type: 'text-chunks', seq0: 3, time0: 4, data: { turn: 1, step: 1, dt: [0], texts: ['Checking'] } },
    { type: 'assistant/message', seq: 4, time: 5, data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'Checking.' }] } } },
    { type: 'assistant/message', seq: 5, time: 6, data: { turn: 1, step: 2, message: { role: 'assistant', content: [{ type: 'text', text: 'The hub is green.' }] } } },
    { type: 'turn/end', seq: 6, time: 7, data: { turn: 1, reason: { kind: 'completed' } } },
    { type: 'user/message', seq: 7, time: 8, data: { content: [{ type: 'text', text: 'tool-job 9001 finished' }], source: { kind: 'plugin', plugin: 'tool-jobs' }, role: 'user' } },
    { type: 'turn/start', seq: 8, time: 9, data: { turn: 2 } },
    { type: 'assistant/message', seq: 9, time: 10, data: { turn: 2, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'Job 9001 is done.' }] } } },
    { type: 'turn/end', seq: 10, time: 11, data: { turn: 2, reason: { kind: 'completed' } } },
  ]
  return `${events.map(event => JSON.stringify(event)).join('\n')}\n`
}

/** A local sink standing in for /v3/terminal-mirror: it counts and records. */
async function sink(t) {
  const received = []
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      received.push({ url: req.url, payload: JSON.parse(body) })
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ ok: true, content_id: received.length }))
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  return { received, endpoint: `http://127.0.0.1:${server.address().port}/v3/terminal-mirror` }
}

async function fixture(t, { operatorTurns = true } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-mirror-'))
  const file = join(dir, 'session.jsonl')
  await writeFile(file, logLines({ operatorTurns }))
  const { received, endpoint } = await sink(t)
  const statePath = join(dir, 'state.json')
  const tokenFile = join(dir, 'token')
  await writeFile(tokenFile, 'test-token\n')
  const post = createPoster({ endpoint, env: { FORAGE_STUDIO_TOKEN_FILE: tokenFile }, logger: () => {} })
  return { dir, file, statePath, received, post, sessions: [{ sessionId: 'conductor-fixture', file }] }
}

test('parseSessionLog reads the header and skips packed chunk rows', () => {
  const { header, events } = parseSessionLog(logLines())
  assert.equal(header.id, 'conductor-fixture')
  assert.equal(header.cwd, '/home/n8/forge-agent-os')
  assert.ok(events.every(event => typeof event.seq === 'number'))
  assert.ok(!events.some(event => event.type === 'text-chunks'))
})

test('replay classifies the operator turn and tags the notice turn', () => {
  const { header, events } = parseSessionLog(logLines())
  const replay = turnEntries({ sessionId: 'conductor-fixture', header, events, agentFrom: 'claudecode_forge' })
  assert.equal(replay.operator, true)
  assert.deepEqual(replay.entries.map(entry => [entry.kind, entry.payload.body, entry.payload.notice]), [
    ['operator-terminal-prompt', 'what is the state of the hub?', null],
    ['agent-terminal-reply', 'The hub is green.', null],
    ['agent-terminal-reply', 'Job 9001 is done.', 'plugin'],
  ])
  assert.equal(replay.entries[0].payload.from, 'N8')
  assert.equal(replay.entries[1].payload.from, 'claudecode_forge')
})

test('backfill posts once and a re-run inserts 0 duplicates', async t => {
  const f = await fixture(t)
  const first = await backfill({ sessions: f.sessions, statePath: f.statePath, post: f.post, agentFrom: 'claudecode_forge', logger: () => {} })
  assert.equal(first.posted, 3)
  assert.equal(first.prompts, 1)
  assert.equal(first.replies, 2)
  assert.equal(first.failures, 0)
  assert.equal(f.received.length, 3)
  assert.deepEqual(f.received.map(hit => hit.payload.kind), [
    'operator-terminal-prompt', 'agent-terminal-reply', 'agent-terminal-reply',
  ])
  assert.match(f.received[0].url, /token=test-token/)

  const second = await backfill({ sessions: f.sessions, statePath: f.statePath, post: f.post, agentFrom: 'claudecode_forge', logger: () => {} })
  assert.equal(second.posted, 0)
  assert.equal(second.skippedExisting, 3)
  assert.equal(second.failures, 0)
  assert.equal(f.received.length, 3, 're-run must not touch the network')

  const state = await loadState(f.statePath)
  assert.equal(Object.keys(state.entries).length, 3)
  assert.ok(Object.values(state.entries).every(entry => typeof entry.contentId === 'number'))
})

test('dry run posts nothing and writes no state', async t => {
  const f = await fixture(t)
  const summary = await backfill({ sessions: f.sessions, statePath: f.statePath, post: f.post, agentFrom: 'claudecode_forge', dryRun: true, logger: () => {} })
  assert.equal(summary.posted, 3)
  assert.equal(summary.dryRun, true)
  assert.equal(f.received.length, 0)
  assert.deepEqual((await loadState(f.statePath)).entries, {})
})

test('a headless replay posts nothing even with a real log', async t => {
  const f = await fixture(t, { operatorTurns: false })
  const summary = await backfill({ sessions: f.sessions, statePath: f.statePath, post: f.post, agentFrom: 'claudecode_forge', logger: () => {} })
  assert.equal(summary.posted, 0)
  assert.equal(summary.operatorSessions, 0)
  assert.equal(f.received.length, 0)
})

test('a failed post is not recorded, so the next run retries it', async t => {
  const f = await fixture(t)
  let fail = true
  const flaky = async payload => {
    if (fail) return { ok: false, error: 'HTTP 502' }
    return f.post(payload)
  }
  const first = await backfill({ sessions: f.sessions, statePath: f.statePath, post: flaky, agentFrom: 'claudecode_forge', logger: () => {} })
  assert.equal(first.posted, 0)
  assert.equal(first.failures, 3)
  fail = false
  const second = await backfill({ sessions: f.sessions, statePath: f.statePath, post: flaky, agentFrom: 'claudecode_forge', logger: () => {} })
  assert.equal(second.posted, 3)
  assert.equal(f.received.length, 3)
})

test('the CLI inserts once and reports 0 on a re-run', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-mirror-cli-'))
  const root = join(dir, 'sessions')
  const sessionDir = join(root, '--home-n8-forge-agent-os--', 'conductor-forge-agent-os-99')
  await mkdir(sessionDir, { recursive: true })
  await writeFile(join(sessionDir, 'session.jsonl'), logLines())
  const statePath = join(dir, 'state.json')
  const tokenFile = join(dir, 'token')
  await writeFile(tokenFile, 'test-token\n')
  const { received, endpoint } = await sink(t)
  const cli = fileURLToPath(new URL('../bin/dsh-terminal-mirror-backfill.mjs', import.meta.url))
  const run = async () => {
    // Asynchronous spawn: this process is also the sink, so blocking here
    // would stop the CLI's POSTs from ever being answered.
    const child = spawn(process.execPath, [cli, '--root', root, '--state', statePath, '--endpoint', endpoint], {
      env: { ...process.env, FORAGE_STUDIO_TOKEN_FILE: tokenFile },
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    const code = await new Promise(resolve => child.on('close', resolve))
    assert.equal(code, 0, stderr)
    return JSON.parse(stdout)
  }
  const first = await run()
  assert.equal(first.posted, 3)
  assert.equal(received.length, 3)
  const second = await run()
  assert.equal(second.posted, 0)
  assert.equal(second.skippedExisting, 3)
  assert.equal(received.length, 3, 'a CLI re-run must insert 0 duplicates')
})

test('discovery selects only the conductor session ids', async t => {  const root = await mkdtemp(join(tmpdir(), 'dsh-sessions-'))
  for (const [project, id] of [
    ['--home-n8--', 'cadence-gen-10'],
    ['--home-n8--', 'conductor-forge-agent-os-4'],
    ['--home-n8-forage-worktrees-task-1--', 'mesh-task-133519'],
    ['--home-n8--', 'some-other-session'],
  ]) {
    const dir = join(root, project, id)
    await import('node:fs/promises').then(fs => fs.mkdir(dir, { recursive: true }))
    await writeFile(join(dir, 'session.jsonl.zstd'), 'not-read-by-this-test')
  }
  const logs = await discoverSessionLogs({ root })
  assert.deepEqual(logs.map(log => log.sessionId), ['cadence-gen-10', 'conductor-forge-agent-os-4'])
})
