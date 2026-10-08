/** Built Host over the shipped headless profile, driven by the real forge-agent-os native maintenance adapter. */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { GenerateOptions, LlmBackendStatus, StreamChunk } from '@deepseek-ai/dsh-llm'
import { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { bootProductionProfile } from '../../../test-support/loader-smoke/tests/fixtures/production-profile.ts'

/** The caller's turn stays in-flight until released: it must be counted, never cancelled. */
class GatedAdapter extends LlmAdapter {
  requests: GenerateOptions[] = []
  entered!: () => void
  readonly inFlight = new Promise<void>((ok) => { this.entered = ok })
  open!: () => void
  readonly gate = new Promise<void>((ok) => { this.open = ok })
  started = false
  settled = false
  settle(): void { this.settled = true }
  /** Truthful provider evidence: the backend turn joins only when settle() says so, not when the Agent goes idle. */
  override backendStatus(): LlmBackendStatus {
    if (!this.started) return { state: 'JOINED', turns: [], startingTurns: 0, uncertainStarts: 0, unattributedEvents: 0 }
    const turn = this.settled
      ? { threadId: 'caller-agent', turnId: 't1', state: 'JOINED' as const, pendingRequests: [], terminal: { threadId: 'caller-agent', turnId: 't1', status: 'completed' as const } }
      : { threadId: 'caller-agent', turnId: 't1', state: 'UNKNOWN' as const, pendingRequests: ['req-1'] }
    return { state: this.settled ? 'JOINED' : 'UNKNOWN', turns: [turn], startingTurns: 0, uncertainStarts: 0, unattributedEvents: 0 }
  }
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.started = true
    this.requests.push(options)
    this.entered()
    await this.gate
    const text = 'caller returned'
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

const overlay = process.argv[2]
const bearer = process.argv[3]
const faoLib = process.env.DSH_FAO_LIB
if (overlay === undefined || bearer === undefined || faoLib === undefined) throw new Error('expected overlay, bearer and DSH_FAO_LIB')
const python = process.env.DSH_PYTHON_CALLER ?? 'python3'
const caller = fileURLToPath(new URL('./fixtures/maintenance_adapter_caller.py', import.meta.url))
const boot = () => bootProductionProfile({ binName: 'maintenance-adapter', profile: 'headless', overlayPaths: [
  resolve(new URL('../maintenance.staged.patch.yml', import.meta.url).pathname), resolve(overlay),
] })
interface DurableEvent { type?: string; data?: { id?: string; content?: { text?: string }[] } }
/** The durable JSONL session directories named `id` (store layout root/<project>/<id>/<generation>.jsonl), read from disk. */
const persisted = (id: string) => {
  const root = join(process.env.DSH_HOME ?? join(process.cwd(), '.dsh'), 'sessions')
  const dirs: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      if (entry.name.includes(id)) dirs.push(join(dir, entry.name))
      else walk(join(dir, entry.name))
    }
  }
  walk(root)
  const logs = dirs.flatMap(dir => readdirSync(dir).filter(name => name.endsWith('.jsonl')).map(name => join(dir, name)))
  const events = logs.flatMap(file => readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as DurableEvent))
  return { files: dirs.length, logs: logs.length, events }
}
let ctx = await boot()
let handle
const phases: Record<string, unknown> = {}
try {
  const isOpen = (): boolean => ctx.hostMaintenanceReady.open
  const adapter = new GatedAdapter()
  ctx.llm.registerAdapter(['keyless-maint'], adapter)
  handle = await ctx.agents.create({ sessionId: SessionId('caller-agent'), meta: { cwd: process.cwd() }, agentOptions: { provider: 'keyless-maint', model: 'scripted' } })
  const agent = handle.agent
  const statePath = join(process.cwd(), 'maint-adapter-state.json')
  writeFileSync(statePath, JSON.stringify({ bearer, faoLib, runDir: join(process.cwd(), 'run') }))
  const run = async (phase: string) => {
    const base = `http://127.0.0.1:${ctx.webServer.port}`
    const stdout = await new Promise<string>((ok, reject) => {
      execFile(python, [caller, phase, base, statePath], { timeout: 60_000 }, (error, out, err) => {
        if (error) reject(new Error(`python phase ${phase} failed: ${err || error.message}`))
        else ok(out)
      })
    })
    const line = stdout.split('\n').find(entry => entry.startsWith('MAINT_ADAPTER_PHASE '))
    assert.ok(line, `python phase ${phase} printed no receipt`)
    phases[phase] = JSON.parse(line.slice('MAINT_ADAPTER_PHASE '.length))
    return phases[phase] as { session?: string }
  }
  // The initiating caller is mid-turn when the controller closes the Host.
  agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'caller obligation' }] }))
  await adapter.inFlight
  assert.equal(isOpen(), true)
  await run('close')
  const closedWhileCallerActive = !isOpen()
  await run('early-external-release')
  // Caller returns on its own; maintenance never cancelled it.
  adapter.open()
  await agent.whenIdle()
  const callerCompleted = adapter.requests.length === 1 && agent.status === 'idle'
  // Agent idle is NOT backend settlement (Oct 3 d24 defect): must still refuse idle.
  await run('probe')
  adapter.settle()
  await run('drain')
  const drained = (phases.drain as { result: string }).result === 'drained'
  let successor: Record<string, unknown> | undefined
  if (drained) {
    await run('claim')
    const started = await run('start')
    await run('start-retry') // same live Host, fresh controller object
    const id = String(started.session)
    const live = ctx.agents.get(SessionId(id))
    const callerTurns = adapter.requests.length
    // Host crash/restart while still closed: replayed control log, no in-memory successor.
    await handle.dispose(); handle = undefined
    await ctx.fiber.dispose()
    ctx = await boot()
    const restartAdapter = new GatedAdapter()
    restartAdapter.open(); restartAdapter.settle()
    ctx.llm.registerAdapter(['keyless-maint'], restartAdapter)
    const closedAfterRestart = !isOpen()
    const retried = await run('start-retry')
    const durable = persisted(id)
    const baton = durable.events.filter(event => event.type === 'user/message' && event.data?.id === `successor-input-${id.slice('successor-'.length)}`)
    const bindings = durable.events.filter(event => event.type === 'host/maintenance-successor')
    const batonText = baton[0]?.data?.content?.[0]?.text
    successor = {
      id, liveAfterStart: live !== undefined, closedAfterRestart,
      sameAfterRestart: retried.session === id, restartModelTurns: restartAdapter.requests.length,
      successorModelTurns: callerTurns - 1,
      sessionFiles: durable.files, sessionLogs: durable.logs, batonMessages: baton.length, bindings: bindings.length,
      binding: bindings[0]?.data, baton: typeof batonText === 'string' ? JSON.parse(batonText) : undefined,
    }
    await run('release')
  } else {
    await run('rollback-release')
  }
  console.log('MAINT_ADAPTER_SNAPSHOT ' + JSON.stringify({
    closedWhileCallerActive, callerCompleted, reopenedAfterRelease: isOpen(),
    modelTurns: adapter.requests.length, successor, phases,
  }))
} finally {
  await handle?.dispose()
  await ctx.fiber.dispose()
}
