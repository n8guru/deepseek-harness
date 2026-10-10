import test from 'node:test'
import assert from 'node:assert/strict'
import { buildOperatorPrompt, parseDecisionId, publicPayload } from '../lib/index.js'

test('decision ids are strictly positive safe integers', () => {
  assert.equal(parseDecisionId('1504231'), 1504231)
  assert.equal(parseDecisionId('0'), null)
  assert.equal(parseDecisionId('1.2'), null)
  assert.equal(parseDecisionId('nope'), null)
})

test('prompt grants investigation but gates mutation on direct operator intent', () => {
  const prompt = buildOperatorPrompt({
    status: 'ok',
    id: 1504231,
    title: 'Central Mesh Janitor · Step 8',
    picture: 'Completion goal check says the charter GOAL is not met',
    metadata: { project_slug: 'central-mesh-janitor', step_id: 8 },
  })
  assert.match(prompt, /full-capability DSH agent/)
  assert.match(prompt, /modify its project's ledger steps when Nate directly asks/)
  assert.match(prompt, /Opening Discuss by itself is not permission/)
  assert.match(prompt, /<operator_decision_card>/)
  assert.doesNotMatch(prompt, /studio-token/)
})

test('public intake selects the capable OpenAI route without exposing credentials', () => {
  const payload = publicPayload({ status: 'ok', id: 42, title: 'A card', picture: 'Evidence' })
  assert.equal(payload.decisionId, 42)
  assert.deepEqual(payload.preferredModel, {
    provider: 'openai-codex',
    model: 'gpt-5.6-sol',
    reasoningEffort: 'medium',
  })
  assert.equal(payload.ok, true)
  assert.equal('token' in payload, false)
})
