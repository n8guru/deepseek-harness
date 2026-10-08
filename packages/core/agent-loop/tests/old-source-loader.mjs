/** Positive isolated rebuilt OLD-source Loader proof, never a live first-cutoff proof. */
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root = fileURLToPath(new URL('../../../../', import.meta.url));
const load = async path => import(pathToFileURL(join(root, path)));
const { boot } = await load('packages/boot/app-boot/lib/index.js');
const { SessionId } = await load('packages/core/session/lib/index.js');
const { createUserMessage, LlmAdapter } = await load('packages/llm/llm/lib/index.js');
class Keyless extends LlmAdapter {
  turns = 0;
  async resolveModel(provider, id) { return { provider, id, name: id }; }
  async *stream() { this.turns++; yield { type: 'finish', reason: { kind: 'stop' } }; }
}
const temp = await mkdtemp(join(tmpdir(), 'step73-rebuilt-old-'));
let ctx;
try {
  for (const closed of [false, true]) {
    // Deliberately put dependent loop BEFORE owner: actual injection orders mount.
    const rows = [
      ['loop', 'packages/core/agent-loop', { agents: [] }],
      ['agents', 'packages/core/agent', { admissionClosed: closed }],
      ['llm', 'packages/llm/llm'], ['sessions', 'packages/core/session'],
      ['prompt', 'packages/core/system-prompt'], ['tools', 'packages/core/tools'],
    ].map(([id, path, config]) => ({ id, name: join(root, path, 'lib/index.js'), ...(config ? { config } : {}) }));
    const config = join(temp, closed ? 'closed.json' : 'open.json');
    await writeFile(config, JSON.stringify(rows));
    ctx = await boot('rebuilt-old-cutoff', config, []);
    assert.ok(ctx.get('loader'));
    assert.equal(ctx.hostAdmission.open, !closed);
    if (!closed) {
      const adapter = new Keyless();
      ctx.llm.registerAdapter(['keyless'], adapter);
      const agent = ctx.agentLoop.create(SessionId('held'), { provider: 'keyless', model: 'none' });
      const held = agent.followup.bind(agent);
      ctx.hostAdmission.close();
      const msg = createUserMessage({ content: [{ type: 'text', text: 'refused' }], source: { kind: 'user' } });
      assert.throws(() => held(msg), /CLOSED/);
      assert.throws(() => agent.inbox.splice('next-turn', 0, 0, [msg]), /CLOSED/);
      assert.equal(adapter.turns, 0);
      assert.equal(ctx.agents.get(agent.id), agent);
    } else {
      assert.throws(() => ctx.agentLoop.create(SessionId('boot-refused')), /CLOSED/);
      assert.equal(ctx.sessions.get(SessionId('boot-refused')), undefined);
    }
    await ctx.fiber.dispose();
    ctx = undefined;
  }
  console.log('REBUILT_OLD_LOADER_GATE_ORDER_AND_HELD_INGRESS_REFUSED');
} finally {
  if (ctx) await ctx.fiber.dispose();
  await rm(temp, { recursive: true, force: true });
}
