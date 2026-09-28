// Classification matrix and payload shape (mesh-dsh-merge step 56).
import test from 'node:test'
import assert from 'node:assert/strict'
import { classifyUserTurn, operatorPayload, replyPayload, skipText, textOfContent } from '../lib/classify.js'
import { tokenCandidates } from '../lib/post.js'

test('payload shape matches the intent-log.py contract', () => {
  const prompt = operatorPayload({ body: '  blue shoes  ', sessionUuid: 'sess-1' })
  assert.deepEqual(prompt, {
    from: 'N8',
    body: 'blue shoes',
    kind: 'operator-terminal-prompt',
    session_uuid: 'sess-1',
    notice: null,
  })
  const reply = replyPayload({ body: 'answer', sessionUuid: 'sess-1', notice: null, from: 'claudecode_forge' })
  assert.deepEqual(reply, {
    from: 'claudecode_forge',
    body: 'answer',
    kind: 'agent-terminal-reply',
    session_uuid: 'sess-1',
    notice: null,
  })
  assert.ok(tokenCandidates({}).some(path => path.endsWith('studio-token-close')))
})

test('operator words require kind=user AND a browser time zone', () => {
  assert.deepEqual(classifyUserTurn({ kind: 'user', rpcId: 'p1', clientTimeZone: 'America/Los_Angeles' }), { origin: 'operator' })
  // Empty / whitespace zone is not a zone.
  assert.deepEqual(classifyUserTurn({ kind: 'user', clientTimeZone: '   ' }), { origin: 'notice', notice: 'user-without-timezone' })
  assert.deepEqual(classifyUserTurn({ kind: 'user', rpcId: 'p1' }), { origin: 'notice', notice: 'user-without-timezone' })
  assert.deepEqual(classifyUserTurn(undefined), { origin: 'notice', notice: 'unknown-source' })
})

test('plugin, subagent-settled and job notices are never Nate', () => {
  for (const kind of ['plugin', 'subagent-settled', 'tool-job', 'job', 'agent-message', 'some-future-kind']) {
    const classified = classifyUserTurn({ kind })
    assert.equal(classified.origin, 'notice', `${kind} must not be an operator turn`)
    assert.equal(classified.notice, kind)
  }
})

test('runtime seeding is neither an operator turn nor a notice', () => {
  assert.deepEqual(classifyUserTurn({ kind: 'agent-instructions', baseline: true }), { origin: 'seed' })
  assert.deepEqual(classifyUserTurn({ kind: 'skill-catalog', entries: [] }), { origin: 'seed' })
})

test('text extraction takes only text blocks; skipText mirrors intent-log.py', () => {
  const content = [
    { type: 'text', text: 'first' },
    { type: 'image', data: 'x' },
    { type: 'text', text: 'second' },
  ]
  assert.equal(textOfContent(content), 'first\n\nsecond')
  assert.equal(textOfContent(undefined), '')
  assert.equal(skipText(''), true)
  assert.equal(skipText('   '), true)
  assert.equal(skipText('<command-name>/close</command-name>'), true)
  assert.equal(skipText('<system-reminder>noise</system-reminder>'), true)
  assert.equal(skipText('<task-notification>job</task-notification>'), true)
  assert.equal(skipText('how many deploys in the last six hours?'), false)
})
