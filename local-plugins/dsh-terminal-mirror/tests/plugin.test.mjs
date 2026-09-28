// Plugin behaviour on a real Cordis host context (mesh-dsh-merge step 56).
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import plugin, { createMirror, defaultAgentAuthor, defaultIgnorePresets } from '../lib/index.js'

// Exercise the same Cordis runtime that boots this checkout's web host.
const hostRequire = createRequire(new URL('../../../apps/cli/package.json', import.meta.url))
const { Context } = await import(hostRequire.resolve('@deepseek-ai/cordis'))

const OPERATOR = { kind: 'user', rpcId: 'p1', clientTimeZone: 'America/Los_Angeles' }

function operatorTurn(turn, text) {
  return {
    type: 'user/message',
    seq: turn * 10,
    data: { content: [{ type: 'text', text }], source: OPERATOR, role: 'user' },
  }
}

function noticeTurn(turn, kind, text) {
  return {
    type: 'user/message',
    seq: turn * 10,
    data: { content: [{ type: 'text', text }], source: { kind, plugin: 'tool-jobs' }, role: 'user' },
  }
}

function assistantMessage(turn, text) {
  return {
    type: 'assistant/message',
    seq: turn * 10 + 5,
    data: { turn, step: 1, message: { role: 'assistant', content: [{ type: 'text', text }] } },
  }
}

function turnEnd(turn) {
  return { type: 'turn/end', seq: turn * 10 + 9, data: { turn, reason: { kind: 'completed' } } }
}

/** Mount the plugin on a real Context and collect every payload it posts. */
async function mounted(t, options = {}) {
  const posted = []
  const ctx = new Context()
  const fiber = ctx.plugin(plugin, {
    agentFrom: 'claudecode_forge',
    post: async payload => {
      posted.push(payload)
      return { ok: true, status: 200, contentId: posted.length }
    },
    logger: () => {},
    ignorePresets: [],
    ...options,
  })
  t.after(() => fiber.dispose())
  await fiber.await()
  const emit = (session, event) => ctx.emit('session/event', session, event)
  const flush = () => new Promise(resolve => setImmediate(resolve))
  return { posted, emit, flush, ctx }
}

const session = (id, header = {}) => ({ id, header })

test('a canary-shaped interaction posts the operator prompt and the reply with correct author/kind', async t => {
  const { posted, emit, flush } = await mounted(t)
  const s = session('canary-session')
  emit(s, operatorTurn(1, 'everyone should wear blue shoes'))
  emit(s, assistantMessage(1, 'Stored. Blue shoes noted.'))
  emit(s, turnEnd(1))
  await flush()
  assert.equal(posted.length, 2)
  assert.deepEqual(posted[0], {
    from: 'N8',
    body: 'everyone should wear blue shoes',
    kind: 'operator-terminal-prompt',
    session_uuid: 'canary-session',
    notice: null,
  })
  assert.deepEqual(posted[1], {
    from: 'claudecode_forge',
    body: 'Stored. Blue shoes noted.',
    kind: 'agent-terminal-reply',
    session_uuid: 'canary-session',
    notice: null,
  })
})

test('option A: a reply to a notice is stored, tagged with the notice kind', async t => {
  const { posted, emit, flush } = await mounted(t)
  const s = session('operator-session')
  emit(s, operatorTurn(1, 'go'))
  emit(s, assistantMessage(1, 'on it'))
  emit(s, turnEnd(1))
  emit(s, noticeTurn(2, 'plugin', 'tool-job 4821 finished'))
  emit(s, assistantMessage(2, 'The job is done.'))
  emit(s, turnEnd(2))
  emit(s, noticeTurn(3, 'subagent-settled', 'subagent settled'))
  emit(s, assistantMessage(3, 'The subagent reported back.'))
  emit(s, turnEnd(3))
  await flush()
  assert.deepEqual(posted.map(p => [p.kind, p.notice]), [
    ['operator-terminal-prompt', null],
    ['agent-terminal-reply', null],
    ['agent-terminal-reply', 'plugin'],
    ['agent-terminal-reply', 'subagent-settled'],
  ])
  // Notices themselves are never stored, and never as Nate.
  assert.ok(posted.every(p => !(p.kind === 'operator-terminal-prompt' && p.body.includes('finished'))))
  assert.ok(posted.every(p => p.from === 'N8' || p.from === 'claudecode_forge'))
})

test('a timezone-less user turn is machine text, not Nate', async t => {
  const { posted, emit, flush } = await mounted(t)
  const s = session('operator-session')
  emit(s, operatorTurn(1, 'go'))
  emit(s, assistantMessage(1, 'ok'))
  emit(s, turnEnd(1))
  emit(s, noticeTurn(2, 'user', 'CONDUCTOR HAND-FORWARD: continue in forge-agent-os'))
  emit(s, assistantMessage(2, 'Hand-forward received.'))
  emit(s, turnEnd(2))
  await flush()
  assert.equal(posted.length, 3)
  assert.equal(posted.filter(p => p.kind === 'operator-terminal-prompt').length, 1)
  assert.equal(posted[0].body, 'go')
  assert.equal(posted[2].notice, 'user-without-timezone')
})

test('headless / mesh DSH sessions store nothing at all', async t => {
  const { posted, emit, flush } = await mounted(t)
  const s = session('mesh-task-133519', { agentPreset: 'mesh-worker' })
  emit(s, noticeTurn(1, 'user', 'TASK BODY: build the thing'))
  emit(s, assistantMessage(1, 'Working on it, report follows.'))
  emit(s, turnEnd(1))
  emit(s, noticeTurn(2, 'plugin', 'job finished'))
  emit(s, assistantMessage(2, 'Done.'))
  emit(s, turnEnd(2))
  await flush()
  assert.deepEqual(posted, [])
})

test('a session with machine text and replies but NO timezone-bearing turn stores nothing', async t => {
  const { posted, emit, flush } = await mounted(t, { ignorePresets: [] })
  const s = session('conductor-no-nate')
  emit(s, noticeTurn(1, 'plugin', 'tool-job notice'))
  emit(s, assistantMessage(1, 'A reply to a notice.'))
  emit(s, turnEnd(1))
  emit(s, noticeTurn(2, 'user', 'conductor hand-forward'))
  emit(s, assistantMessage(2, 'Another reply.'))
  emit(s, turnEnd(2))
  await flush()
  assert.deepEqual(posted, [])
})

test('runtime seeding neither latches operator nor posts', async t => {
  const { posted, emit, flush } = await mounted(t)
  const s = session('operator-session')
  emit(s, { type: 'user/message', seq: 1, data: { content: [{ type: 'text', text: 'baseline instructions' }], source: { kind: 'agent-instructions' } } })
  emit(s, { type: 'user/message', seq: 2, data: { content: [{ type: 'text', text: 'skill catalog' }], source: { kind: 'skill-catalog' } } })
  emit(s, assistantMessage(1, 'seeded reply'))
  emit(s, turnEnd(1))
  await flush()
  assert.deepEqual(posted, [])
})

test('the last assistant text of a turn is the final reply', async t => {
  const { posted, emit, flush } = await mounted(t)
  const s = session('operator-session')
  emit(s, operatorTurn(1, 'status?'))
  emit(s, assistantMessage(1, 'Checking now.'))
  emit(s, assistantMessage(1, 'All green.'))
  emit(s, turnEnd(1))
  await flush()
  assert.equal(posted[1].body, 'All green.')
})

test('skip text and empty turns post nothing', async t => {
  const { posted, emit, flush } = await mounted(t)
  const s = session('operator-session')
  emit(s, operatorTurn(1, '<command-name>/close</command-name>'))
  emit(s, turnEnd(1))
  emit(s, operatorTurn(2, 'real words'))
  emit(s, turnEnd(2))
  await flush()
  assert.deepEqual(posted.map(p => [p.kind, p.body]), [['operator-terminal-prompt', 'real words']])
})

test('the mesh-worker preset is ignored even if a zone-bearing turn appears', async t => {
  const { posted, emit, flush } = await mounted(t, { ignorePresets: ['mesh-worker'] })
  const s = session('mesh-task-133519', { agentPreset: 'mesh-worker' })
  emit(s, operatorTurn(1, 'typed into a mesh session'))
  emit(s, assistantMessage(1, 'reply'))
  emit(s, turnEnd(1))
  await flush()
  assert.deepEqual(posted, [])
})

test('a mirror failure never throws into the event dispatch', async t => {
  const { emit, flush } = await mounted(t, { post: async () => { throw new Error('network down') } })
  const s = session('operator-session')
  emit(s, operatorTurn(1, 'still works?'))
  emit(s, assistantMessage(1, 'yes'))
  emit(s, turnEnd(1))
  await flush()
  assert.ok(true)
})

test('agent author defaults to the per-machine mirror identity', () => {
  assert.equal(defaultAgentAuthor({ DSH_TERMINAL_MIRROR_AGENT: 'deepseek-forge' }), 'deepseek-forge')
  assert.match(defaultAgentAuthor({}), /^claudecode_[a-z0-9-]+$/)
  assert.deepEqual(defaultIgnorePresets({}), ['mesh-worker'])
  assert.deepEqual(defaultIgnorePresets({ DSH_TERMINAL_MIRROR_IGNORE_PRESETS: '' }), [])
})

test('createMirror is usable with no Cordis runtime', () => {
  const mirror = createMirror({ post: async () => ({ ok: true }), agentFrom: 'x', ignorePresets: [], logger: () => {} })
  const s = { id: 's', header: {} }
  mirror.observe(s, operatorTurn(1, 'hi'))
  assert.equal(mirror.stats.prompts, 1)
  assert.equal(mirror.stateFor(s).operator, true)
})
