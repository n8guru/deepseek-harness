/** Existing old built Loader/Agent proof; never mounts in the live Host. */
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const old = '/home/n8/deepseek-harness';
const basis = '35af2007587a757527b826ed3f4da32355ffcded';
assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: old, encoding: 'utf8' }).trim(), basis);
const paths = {
  boot: 'packages/boot/app-boot/lib/index.js',
  loader: 'vendor/loader/lib/index.js',
  agent: 'packages/core/agent/lib/index.js',
  loop: 'packages/core/agent-loop/lib/index.js',
  llm: 'packages/llm/llm/lib/index.js',
  session: 'packages/core/session/lib/index.js',
};
const fingerprints = {};
for (const [key, value] of Object.entries(paths))
  fingerprints[key] = createHash('sha256').update(await readFile(join(old, value))).digest('hex');
const { boot } = await import(pathToFileURL(join(old, paths.boot)));
const { LlmAdapter, createUserMessage } = await import(pathToFileURL(join(old, paths.llm)));
const { SessionId } = await import(pathToFileURL(join(old, paths.session)));
class KeylessAdapter extends LlmAdapter {
  requests = 0;
  async resolveModel(provider, id) { return { provider, id, name: id }; }
  async *stream() {
    this.requests++;
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}
const temp = await mkdtemp(join(tmpdir(), 'step73-old-loader-'));
let ctx;
try {
  // Loader owns every real subject service; no fake Agent/Inbox/factory.
  const config = [
    ['llm', paths.llm], ['sessions', paths.session],
    ['systemPrompt', 'packages/core/system-prompt/lib/index.js'],
    ['tools', 'packages/core/tools/lib/index.js'],
    ['agents', paths.agent], ['agentLoop', paths.loop],
  ].map(([id, name]) => ({ id, name: join(old, name),
    ...(id === 'agentLoop' ? { config: { agents: [] } } : {}) }));
  const configPath = join(temp, 'cordis.json');
  await writeFile(configPath, JSON.stringify(config));
  console.error('PROBE_BOOT');
  ctx = await boot('old-additive-bypass', configPath, []);
  console.error('PROBE_BOOTED');
  assert.ok(ctx.get('loader'), 'actual old compiled Loader mounted');
  const adapter = new KeylessAdapter();
  ctx.llm.registerAdapter(['keyless-old'], adapter);
  const agent = ctx.agentLoop.create(SessionId('old-cached-ingress'), { provider: 'keyless-old', model: 'none' });
  const originalAgent = agent;
  const { symbols } = await import(pathToFileURL(join(old, 'vendor/cordis/lib/index.js')));
  const originalLoop = ctx.agentLoop[symbols.original];
  // Real consumers may hold their message ingress before a late additive plugin.
  const admittedIngress = agent.followup.bind(agent);
  let vetoCalls = 0;
  await ctx.plugin({
    name: 'additive-closed-probe',
    apply(bridge) {
      bridge.provide('hostAdmission', {
        open: false,
        assertOpen() { vetoCalls++; throw new Error('CLOSED'); },
        reserve() { vetoCalls++; throw new Error('CLOSED'); },
      });
    },
  });
  assert.equal(ctx.get('hostAdmission').open, false);
  assert.equal(ctx.agentLoop[symbols.original], originalLoop);
  assert.equal(agent, originalAgent);
  const message = createUserMessage({ content: [{ type: 'text', text: 'bypass closed additive service' }], source: { kind: 'user' } });
  admittedIngress(message);
  await agent.whenIdle();
  assert.equal(vetoCalls, 0, 'old send never consults the additive gate');
  assert.equal(adapter.requests, 1, 'closed additive service did NOT fence real old model entry');
  assert.ok(agent.session.events.some(event => event.type === 'agent/inbox/spliced'));
  console.log(JSON.stringify({ basis, fingerprints, loader: true, heldIdentities: true,
    closed: true, vetoCalls, modelTurnsAfterClose: adapter.requests,
    disposition: 'UNHOOKED_OLD_INGRESS_NO_ADDITIVE_FENCE' }));
} finally {
  if (ctx) await ctx.fiber.dispose();
  await rm(temp, { recursive: true, force: true });
}
