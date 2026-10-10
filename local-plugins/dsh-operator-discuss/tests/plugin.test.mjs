import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import plugin, { buildOperatorPrompt, parseDecisionId, publicPayload } from '../lib/index.js'

// Exercise the same Cordis runtime that boots this checkout's web host.
const hostRequire = createRequire(new URL('../../../apps/cli/package.json', import.meta.url))
const { Context } = await import(hostRequire.resolve('@deepseek-ai/cordis'))

async function mountedCarrier(t, carrierFirst) {
  const ctx = new Context()
  const routes = []
  const carrier = {
    register(route) {
      routes.push(route)
      return () => { routes.splice(routes.indexOf(route), 1) }
    },
  }
  if (carrierFirst) ctx.provide('webServer', carrier)
  const fiber = ctx.plugin(plugin)
  t.after(() => fiber.dispose())
  if (!carrierFirst) {
    await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(routes.length, 0)
    ctx.provide('webServer', carrier)
  }
  await fiber.await()
  return { routes, fiber }
}

for (const carrierFirst of [true, false]) {
  test(`intake registers with webServer ${carrierFirst ? 'before' : 'after'} plugin`, async t => {
    const { routes, fiber } = await mountedCarrier(t, carrierFirst)
    assert.equal(routes.length, 1)
    assert.equal(routes[0].path, '/api/operator-discuss-card')
    assert.equal(routes[0].kind, 'exact')
    const headers = {}
    const response = {
      setHeader(key, value) { headers[key] = value },
      end(body) { this.body = JSON.parse(body) },
    }
    await routes[0].handler({ method: 'GET', url: '/api/operator-discuss-card?decision_id=0' }, response)
    assert.equal(response.statusCode, 400)
    assert.match(headers['content-type'], /application\/json/)
    assert.equal(response.body.ok, false)
    await routes[0].handler({ method: 'POST', url: '/api/operator-discuss-card' }, response)
    assert.equal(response.statusCode, 405)
    await fiber.dispose()
    assert.equal(routes.length, 0, 'disposing the plugin removes its route')
  })
}

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
