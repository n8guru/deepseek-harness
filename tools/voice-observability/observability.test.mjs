import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
const client = readFileSync(new URL('./client.js', import.meta.url), 'utf8')
const host = readFileSync(new URL('./index.js', import.meta.url), 'utf8')
function extract(source, name) {
  const start = source.indexOf('function ' + name + '(')
  assert.ok(start >= 0)
  let depth = 0
  for (let i = source.indexOf('{', start); i < source.length; i++) {
    if (source[i] === '{') depth++
    if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1)
  }
  throw Error('unbalanced function')
}
function fixture({ enabled = true, owned = true, broken = false, offline = false } = {}) {
  const events = [], posts = [], queued = [], seen = new Set()
  let queueCalls = 0
  const window = { dispatchEvent: event => events.push(event.detail) }
  const CustomEvent = class { constructor(type, init) { this.type = type; this.detail = init.detail } }
  const fetch = (_url, init) => { posts.push(JSON.parse(init.body)); return offline ? Promise.reject(Error('offline')) : Promise.resolve() }
  const play = new Function('window', 'CustomEvent', 'fetch', 'voiceBridgeBase', 'spokenParts', 'spokenKey',
    'rememberSpoken', 'wantSpeak', 'ownsSpeech', 'speakQueue', 'console',
    extract(client, 'reportTtsStatus') + ';' + extract(client, 'playSpoken') + '; return playSpoken')(
      window, CustomEvent, fetch, () => '/configured-bridge',
      () => ['configured voice text'], text => text,
      key => { if (seen.has(key)) return false; seen.add(key); return true },
      () => enabled, () => owned,
      () => { queueCalls++; if (broken) throw Error('queue unavailable'); return { enqueue: (...args) => queued.push(args) } },
      { warn() {} },
    )
  const invoke = () => play('<spoken>configured voice text</spoken>', 'block-key', 'session-key', 7)
  return { invoke, events, posts, queued, queueCalls: () => queueCalls }
}
for (const [reason, options] of [
  ['speaker-disabled', { enabled: false }],
  ['not-speech-owner', { owned: false }],
]) test('truthful one-shot skip: ' + reason, () => {
  const f = fixture(options); f.invoke(); f.invoke()
  assert.equal(f.queueCalls(), 0); assert.equal(f.queued.length, 0)
  assert.deepEqual(f.events, [{ event: 'block_skipped', sessionId: 'session-key', key: 'block-key', turn: 7, reason }])
  assert.deepEqual(f.posts, f.events)
})
test('queue failure is visible, bounded and never called playback complete', () => {
  const f = fixture({ broken: true }); f.invoke(); f.invoke()
  assert.equal(f.queued.length, 0)
  assert.deepEqual(f.events, [{ event: 'block_failed', sessionId: 'session-key', key: 'block-key', turn: 7, reason: 'queue-unavailable' }])
})
test('eligible speech keeps original enqueue and observational delivery failure cannot enable/change playback', async () => {
  const f = fixture({ offline: true }); f.invoke(); f.invoke()
  assert.equal(f.events.length, 0); assert.equal(f.queued.length, 1)
  assert.deepEqual(f.queued[0], ['configured voice text', 'session-key', 'configured voice text', 7])
  const skipped = fixture({ enabled: false, offline: true }); skipped.invoke()
  await Promise.resolve()
  assert.equal(skipped.events.length, 1); assert.equal(skipped.queued.length, 0)
  assert.match(client, /voice: "fenn"/)
})
test('staged native receiver accepts skip/failure vocabulary without claiming heard', () => {
  const describe = new Function(extract(host, 'describeEvent') + '; return describeEvent')()
  for (const event of ['block_skipped', 'block_failed']) {
    assert.ok(host.includes('"' + event + '"'))
    assert.match(describe({ event, reason: 'fixture' }), /Playback is not confirmed/)
    assert.doesNotMatch(describe({ event }), /finished playing|Nate heard/)
  }
})
