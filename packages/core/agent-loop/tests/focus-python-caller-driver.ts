/** Built-artifact Host over the shipped headless profile, driven over loopback HTTP by a real Python caller. */
import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { bootProductionProfile } from '../../../test-support/loader-smoke/tests/fixtures/production-profile.ts'

class FixtureAdapter extends LlmAdapter {
  requests: GenerateOptions[] = []
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    if (this.requests.length > 2) throw new Error('unexpected static model turn')
    const text = this.requests.length === 1 ? 'foreground checkpoint' : 'receipt checkpoint'
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

const overlay = process.argv[2]
const bearer = process.argv[3]
if (overlay === undefined || bearer === undefined) throw new Error('expected isolated profile overlay and caller bearer')
const python = process.env.DSH_PYTHON_CALLER ?? 'python3'
const caller = fileURLToPath(new URL('./fixtures/focus_python_caller.py', import.meta.url))
assert.equal(createHash('sha256').update(bearer).digest('hex').length, 64)
const ctx = await bootProductionProfile({ binName: 'focus-python-caller', profile: 'headless', overlayPaths: [resolve(overlay)] })
let handle
try {
  const adapter = new FixtureAdapter()
  ctx.llm.registerAdapter(['keyless-focus'], adapter)
  handle = await ctx.agents.create({ sessionId: SessionId('py-focus'), meta: { cwd: process.cwd() }, agentOptions: { provider: 'keyless-focus', model: 'scripted' } })
  const agent = handle.agent
  const inbox = agent.inbox.notifications
  assert.ok(inbox, 'built native capability required')
  // Index exchange is the web-runtime row's job in the Web bundle; the headless
  // profile has no index owner, so this one route is fixture plumbing.
  ctx.webServer.register({ kind: 'exact', path: '/', handler: (req: any, res: any) => {
    if (!ctx.connection.authorizeIndex(req, res)) { res.writeHead(401); res.end() }
  } })
  const base = `http://127.0.0.1:${ctx.webServer.port}`
  const statePath = join(process.cwd(), 'py-caller-state.json')
  writeFileSync(statePath, JSON.stringify({ authUrl: ctx.connection.authenticatedUrl(base), bearer, sessionId: agent.id }))
  const phases: unknown[] = []
  // Async spawn: the Host event loop must keep serving while Python calls it.
  const run = async (phase: string) => {
    const stdout = await new Promise<string>((resolvePhase, reject) => {
      execFile(python, [caller, phase, base, statePath], { timeout: 60_000 }, (error, out, err) => {
        if (error) reject(new Error(`python phase ${phase} failed: ${err || error.message}`))
        else resolvePhase(out)
      })
    })
    const line = stdout.split('\n').find(entry => entry.startsWith('PY_CALLER_PHASE '))
    assert.ok(line, `python phase ${phase} printed no receipt`)
    phases.push(JSON.parse(line.slice('PY_CALLER_PHASE '.length)))
  }
  await run('admit') // Python operator enables Focus over HTTP before the goal exists
  ctx.goals.create(agent, { objective: 'must remain static under Focus' })
  agent.wakeInbox?.()
  await agent.whenIdle()
  await new Promise(resolveTick => setImmediate(resolveTick))
  assert.equal(adapter.requests.length, 0, 'Focus must hold background notification and goal continuation')
  agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'foreground obligation' }] }))
  await agent.whenIdle()
  assert.equal(adapter.requests.length, 1)
  assert.ok(!JSON.stringify(adapter.requests[0]?.messages).includes('python worker report'))
  await run('check')
  await agent.whenIdle()
  assert.equal(adapter.requests.length, 2)
  await run('recheck')
  agent.wakeInbox?.()
  await agent.whenIdle()
  await new Promise(resolveTick => setImmediate(resolveTick))
  assert.equal(adapter.requests.length, 2, 'unchanged check and late held receipt produce no model turn')
  assert.equal(inbox.focus.queued, 1)
  const lateHeld = inbox.focus.queued
  await run('maintenance')
  await agent.whenIdle()
  assert.equal(adapter.requests.length, 2, 'maintenance delivery neither wakes nor impersonates foreground')
  assert.deepEqual(inbox.receipt('native:maintenance-receipt:py:caller', (phases[3] as { messageId: string }).messageId)?.content,
    [{ type: 'text', text: 'python supervisor checkpoint' }])
  agent.cancel({ kind: 'user' })
  assert.equal(ctx.goals.get(agent)?.phase, 'paused')
  await ctx.sessions.flush(agent.session)
  console.log('FOCUS_PY_CALLER_SNAPSHOT ' + JSON.stringify({
    python: execFileSync(python, ['-c', 'import sys; print(sys.version.split()[0])']).toString().trim(),
    phases: phases.map(phase => (phase as { phase: string }).phase),
    foregroundRequests: 1, checkRequests: 1, staticHoldRequests: adapter.requests.length - 2,
    lateHeld, heldAfterSupervisorReceipt: inbox.focus.queued, goal: ctx.goals.get(agent)?.phase,
  }))
} finally {
  await handle?.dispose()
  await ctx.fiber.dispose()
}
