/** Isolated rebuilt OLD-source Loader proof for item (c) paths; never a live first-cutoff proof. */
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root = fileURLToPath(new URL('../../../../', import.meta.url));
const load = async path => import(pathToFileURL(join(root, path)));
const { boot } = await load('packages/boot/app-boot/lib/index.js');
const { SessionId } = await load('packages/core/session/lib/index.js');
const { LlmAdapter } = await load('packages/llm/llm/lib/index.js');
const { startInProcessRun } = await load('packages/subagent/subagent-in-process-driver/lib/index.js');
class Keyless extends LlmAdapter {
  turns = 0;
  async resolveModel(provider, id) { return { provider, id, name: id }; }
  async *stream() { this.turns++; yield { type: 'finish', reason: { kind: 'stop' } }; }
}
const tick = () => new Promise(resolve => setImmediate(resolve));
const until = async (check) => {
  const deadline = Date.now() + 5000;
  while (!check()) {
    assert.ok(Date.now() < deadline, 'bounded fixture condition did not settle');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
};
const temp = await mkdtemp(join(tmpdir(), 'step73-rebuilt-old-finish-'));
let ctx;
const gates = [];
const gate = () => { const g = Promise.withResolvers(); gates.push(g); return g; };
try {
  const rows = [
    ['workflow', 'packages/workflow/workflow-worker-thread', { provider: 'slow', disposeGraceMs: 30 }],
    ['subagents', 'packages/subagent/subagent'],
    ['loop', 'packages/core/agent-loop', { agents: [] }],
    ['agents', 'packages/core/agent', { admissionClosed: false }],
    ['persistence', 'packages/session/session-persistence-jsonl', { root: join(temp, 'sessions') }],
    ['llm', 'packages/llm/llm'], ['sessions', 'packages/core/session'],
    ['prompt', 'packages/core/system-prompt'], ['tools', 'packages/core/tools'],
  ].map(([id, path, config]) => ({ id, name: join(root, path, 'lib/index.js'), ...(config ? { config } : {}) }));
  const config = join(temp, 'finish.json');
  await writeFile(config, JSON.stringify(rows));
  ctx = await boot('rebuilt-old-finish', config, []);
  const adapter = new Keyless();
  ctx.llm.registerAdapter(['keyless'], adapter);
  const parent = ctx.agentLoop.create(SessionId('loader-finish-parent'), { provider: 'keyless', model: 'none' });
  const pending = () => ctx.hostAdmission.status().pending;

  // Already-aborted calls own no reservation and never invoke either provider path.
  let forbiddenStarts = 0;
  ctx.subagents.registerProvider({ name: 'never', inheritsParentContext: false,
    capabilities: { outputSchema: false, depthLimit: false, toolFilter: false, persona: false },
    async start() { forbiddenStarts++; throw new Error('must not start'); },
    async prepareContinuable() { forbiddenStarts++; return {}; },
  });
  const preAborted = AbortSignal.abort(new Error('already aborted'));
  const beforeAbort = [...pending()];
  await assert.rejects(ctx.subagents.start('never', { parent, signal: preAborted, prompt: [] }), /already aborted/);
  await assert.rejects(ctx.subagents.startContinuable({ provider: 'never', label: 'no',
    request: { parent, prompt: [] }, signal: preAborted }), /already aborted/);
  assert.equal(forbiddenStarts, 0);
  assert.deepEqual(pending(), beforeAbort);

  // (1) Canonical driver refusal before claim: authenticated unpublished receipt.
  const abort = new AbortController();
  let captured;
  ctx.subagents.registerProvider({ name: 'canon', inheritsParentContext: false, capabilities: { outputSchema: false, depthLimit: false, toolFilter: false, persona: false }, async start(request) {
    captured = request; await tick(); return startInProcessRun(request, {});
  } });
  const refused = ctx.subagents.start('canon', { parent, signal: abort.signal, prompt: [] });
  abort.abort();
  await assert.rejects(refused);
  await tick();
  assert.deepEqual(pending(), []);
  await assert.rejects(ctx.agents.create({ sessionId: captured.initialAdmission.sessionId,
    initialAdmission: captured.initialAdmission, parentAgent: parent, signal: captured.signal,
    meta: { parentSession: parent.id } }));

  // (2) Workflow: reservation survives bounded disposal, retires only on actual join.
  const startGate = gate(); const disposeGate = gate();
  const startEntered = gate(); const disposeEntered = gate();
  ctx.subagents.registerProvider({ name: 'slow', inheritsParentContext: false, capabilities: { outputSchema: false, depthLimit: false, toolFilter: false, persona: false }, async start(request) {
    startEntered.resolve();
    await startGate.promise;
    return { id: request.initialAdmission.sessionId, localAgent: undefined, result: new Promise(() => {}),
      dispose: async () => { disposeEntered.resolve(); await disposeGate.promise; } };
  } });
  const run = ctx.workflowEngine.start({ parent, meta: { name: 'j', description: 'j' }, script: "return await agent('p')" });
  await startEntered.promise;
  await run.dispose();
  assert.ok(pending().includes('workflow'));
  startGate.resolve(); await disposeEntered.promise;
  assert.ok(pending().includes('workflow'));
  disposeGate.resolve(); await until(() => !pending().includes('workflow'));
  assert.ok(!pending().includes('workflow'));
  // The late provider run was disposed by the run's admission refusal; actual run disposal retires delegate.
  assert.deepEqual(pending(), []);

  // (3) Continuable preclose exact acceptance publishes after CLOSED, zero forced turns.
  const prepGate = gate(); const entered = gate();
  ctx.subagents.registerProvider({ name: 'cont', inheritsParentContext: false, capabilities: { outputSchema: false, depthLimit: false, toolFilter: false, persona: false }, start() { throw new Error('unused'); },
    async prepareContinuable() { entered.resolve(); await prepGate.promise; return {}; } });
  const prompt = [{ type: 'text', text: 'loader continuable original' }];
  const started = ctx.subagents.startContinuable({ provider: 'cont', label: 'c', request: { parent, prompt }, signal: new AbortController().signal });
  await entered.promise;
  ctx.hostAdmission.close();
  prompt[0].text = 'mutated';
  prepGate.resolve();
  const { childId, messageId } = await started;
  const child = ctx.agents.get(childId);
  assert.equal(child.inbox.nextTurn.length, 1);
  assert.equal(child.inbox.nextTurn[0].id, messageId);
  assert.deepEqual(child.inbox.nextTurn[0].content, [{ type: 'text', text: 'loader continuable original' }]);
  assert.equal(adapter.turns, 0);
  assert.throws(() => child.followup(child.inbox.nextTurn[0]), /CLOSED/);
  console.log('REBUILT_OLD_LOADER_FINISH_RECEIPT_WORKFLOW_JOIN_CONTINUABLE_INITIAL');
} finally {
  for (const g of gates) g.resolve();
  if (ctx) await ctx.fiber.dispose();
  await rm(temp, { recursive: true, force: true });
}
