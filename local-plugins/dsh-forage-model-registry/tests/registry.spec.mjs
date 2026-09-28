import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  admitModel,
  createRegistryReader,
  curatedProviders,
  ModelRefused,
  planSettings,
  RegistryUnavailable,
  renderRouteModels,
} from '../lib/registry.js'
import { main } from '../bin/generate.mjs'

// Shapes mirror app/mesh_model_registry.public_view rows on Forage branch
// agents/forge/task-133163. Ids here are test fixtures, not configuration.
const ROWS = [
  { id: 'deepseek/v4-pro', name: 'DeepSeek V4 Pro', aliases: ['dsv4'], pump: { provider: 'forage', model: 'deepseek/v4-pro' }, modalities: ['text'], interactive_enabled: true },
  { id: 'deepseek/v4-flash-vision', name: 'DS Flash Vision', aliases: [], pump: { provider: 'forage', model: 'deepseek/v4-flash-vision' }, modalities: ['text', 'image'], interactive_enabled: true },
  { id: 'forge/retired-14b', name: 'Retired 14B', aliases: [], pump: { provider: 'forage', model: 'forge/retired-14b' }, modalities: ['text'], interactive_enabled: false },
  { id: 'qwen-local', name: 'Qwen local', aliases: [], pump: { provider: 'forge_qwen38', model: 'qwen-local' }, modalities: ['text'], interactive_enabled: true },
  { id: 'native-only', name: 'Native only', aliases: [], pump: null, modalities: ['text'], interactive_enabled: true },
]

function fakeFetch(answers) {
  const calls = []
  const fn = async (url, init) => {
    calls.push({ url, init })
    const next = answers.length > 1 ? answers.shift() : answers[0]
    if (next instanceof Error) throw next
    return {
      status: next.status ?? 200,
      json: async () => {
        if (next.body === undefined) throw new SyntaxError('not json')
        return next.body
      },
    }
  }
  fn.calls = calls
  return fn
}

function clock(start = 1_000) {
  let t = start
  const now = () => t
  now.advance = (ms) => { t += ms }
  return now
}

describe('createRegistryReader', () => {
  it('fresh read hits the endpoint with the bearer token and host', async () => {
    const fetch = fakeFetch([{ body: { models: ROWS } }])
    const reader = createRegistryReader({ baseUrl: 'https://forage.test/', host: 'forge', token: () => 'tok', fetch, now: clock() })
    await expect(reader.rows()).resolves.toEqual(ROWS)
    expect(reader.reads).toBe(1)
    expect(fetch.calls[0].url).toBe('https://forage.test/api/mesh/model-registry?host=forge')
    expect(fetch.calls[0].init.headers.authorization).toBe('Bearer tok')
  })

  it('serves the cached snapshot inside the TTL (no second read)', async () => {
    const now = clock()
    const fetch = fakeFetch([{ body: { models: ROWS } }])
    const reader = createRegistryReader({ baseUrl: 'https://forage.test', ttlMs: 30_000, fetch, now })
    await reader.rows()
    now.advance(29_999)
    await reader.rows()
    expect(reader.reads).toBe(1)
  })

  it('re-reads past the TTL and follows a registry edit', async () => {
    const now = clock()
    const edited = ROWS.map(row => row.id === 'qwen-local' ? { ...row, interactive_enabled: false } : row)
    const fetch = fakeFetch([{ body: { models: ROWS } }, { body: { models: edited } }])
    const reader = createRegistryReader({ baseUrl: 'https://forage.test', ttlMs: 30_000, fetch, now })
    await expect(admitModel(reader, 'forge_qwen38', 'qwen-local')).resolves.toMatchObject({ id: 'qwen-local' })
    now.advance(30_000)
    await expect(admitModel(reader, 'forge_qwen38', 'qwen-local')).rejects.toMatchObject({ code: 'retired_model' })
    expect(reader.reads).toBe(2)
  })

  it('fails closed when the registry is unreachable or answers 503, and never serves the stale snapshot', async () => {
    const now = clock()
    const fetch = fakeFetch([{ body: { models: ROWS } }, { status: 503, body: { condition: 'registry_unavailable' } }, new TypeError('ECONNREFUSED')])
    const reader = createRegistryReader({ baseUrl: 'https://forage.test', ttlMs: 1_000, fetch, now })
    await expect(admitModel(reader, 'forage', 'deepseek/v4-pro')).resolves.toBeTruthy()
    now.advance(1_000)
    await expect(reader.rows()).rejects.toBeInstanceOf(RegistryUnavailable)
    // The failed re-read evicted the cache: even "inside" the old TTL window nothing stale comes back.
    await expect(admitModel(reader, 'forage', 'deepseek/v4-pro')).rejects.toMatchObject({ code: 'registry_unavailable' })
    await expect(reader.rows()).rejects.toThrow(/unreachable: ECONNREFUSED/)
  })

  it('treats a malformed answer as unavailable', async () => {
    for (const answer of [{ body: undefined }, { body: { models: 'x' } }, { body: { models: [{ name: 'no id' }] } }]) {
      const reader = createRegistryReader({ baseUrl: 'https://forage.test', ttlMs: 0, fetch: fakeFetch([answer]) })
      await expect(reader.rows()).rejects.toBeInstanceOf(RegistryUnavailable)
    }
  })

  it('rejects bad configuration loudly', () => {
    expect(() => createRegistryReader({ baseUrl: '' })).toThrow(/baseUrl/)
    expect(() => createRegistryReader({ baseUrl: 'x', ttlMs: -1 })).toThrow(/ttlMs/)
  })
})

describe('admitModel', () => {
  const reader = createRegistryReader({ baseUrl: 'https://forage.test', fetch: fakeFetch([{ body: { models: ROWS } }]) })

  it('admits an id or alias pinned to the route', async () => {
    await expect(admitModel(reader, 'forage', 'dsv4')).resolves.toMatchObject({ id: 'deepseek/v4-pro' })
  })

  it('refuses a retired id', async () => {
    const refusal = admitModel(reader, 'forage', 'forge/retired-14b')
    await expect(refusal).rejects.toBeInstanceOf(ModelRefused)
    await expect(refusal).rejects.toMatchObject({ code: 'retired_model' })
  })

  it('refuses an id no row claims (hand-edited literal)', async () => {
    await expect(admitModel(reader, 'forage', 'forge/hermes-4-14b')).rejects.toMatchObject({ code: 'unknown_model' })
  })

  it('refuses an id pinned to another route', async () => {
    await expect(admitModel(reader, 'forage', 'qwen-local')).rejects.toMatchObject({ code: 'wrong_route' })
  })
})

describe('rendering', () => {
  it('derives the curated provider list from interactive pump rows', () => {
    expect(curatedProviders(ROWS)).toEqual(['forage', 'forge_qwen38'])
  })

  it('renders route models from registry ids only, carrying capacity fields of surviving ids', () => {
    const current = [
      { id: 'deepseek/v4-pro', name: 'old label', contextWindow: 131072, maxTokens: 8192, compat: { chatTemplateKwargs: {} } },
      { id: 'forge/hermes-4-14b', name: 'hand-edited' },
    ]
    expect(renderRouteModels(ROWS, 'forage', current)).toEqual([
      { id: 'deepseek/v4-pro', name: 'DeepSeek V4 Pro', input: ['text'], contextWindow: 131072, maxTokens: 8192, compat: { chatTemplateKwargs: {} } },
      { id: 'deepseek/v4-flash-vision', name: 'DS Flash Vision', input: ['text', 'image'] },
    ])
  })

  it('plans drift per governed route', () => {
    const plan = planSettings(ROWS, { forage: { models: [{ id: 'forge/hermes-4-14b' }] } }, ['forage', 'forge_qwen38'])
    expect(plan.routes.forage.dropped).toEqual(['forge/hermes-4-14b'])
    expect(plan.routes.forge_qwen38.added).toEqual(['qwen-local'])
    expect(plan.missingRoutes).toEqual(['forge_qwen38'])
  })
})

describe('generate CLI', () => {
  const SETTINGS = [
    'agent-default-model:',
    '  provider: anthropic',
    'llm-pi-ai:',
    '  providers:',
    '    forge_qwen38:',
    '      baseURL: http://127.0.0.1:1/v1',
    '      models:',
    '        - id: qwen-local',
    '          name: Qwen local',
    '          contextWindow: 131072',
    '    forage:',
    '      # retry comment must survive',
    '      baseURL: http://127.0.0.1:2/api/llm',
    '      models:',
    '        - id: forge/hermes-4-14b',
    '          name: hand-edited',
    '',
  ].join('\n')

  function settingsFile() {
    const path = join(mkdtempSync(join(tmpdir(), 'fmr-')), 'settings.yaml')
    writeFileSync(path, SETTINGS)
    return path
  }

  it('dry run reports drift and writes nothing', async () => {
    const path = settingsFile()
    const lines = []
    const code = await main(['--settings', path], { fetch: fakeFetch([{ body: { models: ROWS } }]), env: {}, log: l => lines.push(l) })
    expect(code).toBe(3)
    expect(JSON.parse(lines[0]).routes.forage.dropped).toEqual(['forge/hermes-4-14b'])
    expect(readFileSync(path, 'utf8')).toBe(SETTINGS)
  })

  it('unreadable registry exits 2 and writes nothing, even with --write', async () => {
    const path = settingsFile()
    const lines = []
    const code = await main(['--settings', path, '--write'], { fetch: fakeFetch([{ status: 503, body: {} }]), env: {}, log: l => lines.push(l) })
    expect(code).toBe(2)
    expect(JSON.parse(lines[0]).condition).toBe('registry_unavailable')
    expect(readFileSync(path, 'utf8')).toBe(SETTINGS)
  })

  it('--write replaces only governed model lists and keeps comments', async () => {
    const path = settingsFile()
    const code = await main(['--settings', path, '--write'], { fetch: fakeFetch([{ body: { models: ROWS } }]), env: {}, log: () => {} })
    expect(code).toBe(0)
    const written = readFileSync(path, 'utf8')
    expect(written).toContain('# retry comment must survive')
    expect(written).not.toContain('forge/hermes-4-14b')
    expect(written).toContain('id: deepseek/v4-flash-vision')
    expect(written).toContain('contextWindow: 131072')
    expect(written).toContain('agent-default-model:')
  })

  it('--write refuses a route the registry would empty', async () => {
    const path = settingsFile()
    const lines = []
    const code = await main(['--settings', path, '--write', '--routes', 'forage,forge_qwen38'], {
      fetch: fakeFetch([{ body: { models: ROWS.filter(r => r.pump?.provider !== 'forge_qwen38') } }]), env: {}, log: l => lines.push(l),
    })
    expect(code).toBe(4)
    expect(JSON.parse(lines[0]).condition).toBe('route_would_be_empty')
    expect(readFileSync(path, 'utf8')).toBe(SETTINGS)
  })
})
