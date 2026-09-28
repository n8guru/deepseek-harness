// DSH catalog adapter for the Forage mesh model registry
// (project llm-model-catalog-compliance 1891788 step 16, reader 6 of 6).
//
// The registry (GET /api/mesh/model-registry, one DecisionRule row per model)
// is the only source of model ids for the routes this adapter governs. It
// holds NO model ids of its own. Reads are TTL-cached; past the TTL the cache
// is evicted before the re-read, so a failed re-read refuses instead of
// serving a stale answer. There is no fallback list: an unreadable registry
// refuses every id, and an id no admitting row claims is refused.

export const DEFAULT_TTL_MS = 30_000
export const REGISTRY_PATH = '/api/mesh/model-registry'

/** The registry could not be read fresh; callers must refuse. */
export class RegistryUnavailable extends Error {
  constructor(message, options) {
    super(message, options)
    this.name = 'RegistryUnavailable'
    this.code = 'registry_unavailable'
  }
}

/** A model id was refused by the registry; `code` is machine-readable. */
export class ModelRefused extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'ModelRefused'
    this.code = code
  }
}

function validRows(body) {
  const models = body && typeof body === 'object' ? body.models : undefined
  if (!Array.isArray(models)) return undefined
  for (const row of models) {
    if (!row || typeof row !== 'object' || typeof row.id !== 'string' || row.id.length === 0) return undefined
  }
  return models
}

/**
 * Create a TTL-cached reader over the registry endpoint.
 * @param {object} options
 * @param {string} options.baseUrl - Forage origin, e.g. https://forage.ink
 * @param {() => string | undefined} [options.token] - studio token supplier (sent as Bearer).
 * @param {number} [options.ttlMs] - cache lifetime; 0 disables caching.
 * @param {string} [options.host] - mesh host name forwarded as ?host=.
 * @param {typeof fetch} [options.fetch]
 * @param {() => number} [options.now]
 */
export function createRegistryReader(options) {
  const { baseUrl, token, host } = options
  if (typeof baseUrl !== 'string' || baseUrl.length === 0) {
    throw new Error('forage-model-registry: baseUrl is required')
  }
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
  if (!Number.isFinite(ttlMs) || ttlMs < 0) {
    throw new Error('forage-model-registry: ttlMs must be a non-negative finite number')
  }
  const doFetch = options.fetch ?? globalThis.fetch
  const now = options.now ?? Date.now
  const url = `${baseUrl.replace(/\/+$/, '')}${REGISTRY_PATH}${host ? `?host=${encodeURIComponent(host)}` : ''}`
  let cache
  let reads = 0

  async function fetchRows() {
    reads += 1
    const secret = token?.()
    let response
    try {
      response = await doFetch(url, {
        method: 'GET',
        headers: { accept: 'application/json', ...secret ? { authorization: `Bearer ${secret}` } : {} },
      })
    } catch (error) {
      throw new RegistryUnavailable(`mesh model registry unreachable: ${error?.message ?? error}`, { cause: error })
    }
    if (response.status !== 200) {
      throw new RegistryUnavailable(`mesh model registry unreadable (HTTP ${response.status})`)
    }
    let body
    try {
      body = await response.json()
    } catch (error) {
      throw new RegistryUnavailable('mesh model registry answered non-JSON', { cause: error })
    }
    const rows = validRows(body)
    if (!rows) throw new RegistryUnavailable('mesh model registry answer has no valid "models" array')
    return rows
  }

  return {
    url,
    /** Number of network reads so far (observability for tests/diagnostics). */
    get reads() { return reads },
    /** Drop the cached snapshot so the next read goes to the network. */
    invalidate() { cache = undefined },
    /**
     * Registry rows, fresh within the TTL.
     * @returns {Promise<object[]>}
     * @throws {RegistryUnavailable}
     */
    async rows() {
      const at = now()
      if (cache && at - cache.loadedAt < ttlMs) return cache.rows
      // Evict BEFORE the re-read: a failed re-read must not leave the stale
      // snapshot behind to be served by a later call.
      cache = undefined
      const rows = await fetchRows()
      cache = { rows, loadedAt: at }
      return rows
    },
  }
}

/** Rows a DSH route may offer interactively: a pump pin on that route, interactive on. */
export function routeRows(rows, route) {
  return rows.filter(row => row.pump && row.pump.provider === route && row.interactive_enabled !== false)
}

/**
 * DSH's curated provider list: every route some interactive registry row pins,
 * in first-seen registry (priority) order.
 */
export function curatedProviders(rows) {
  const seen = []
  for (const row of rows) {
    if (row.pump && row.interactive_enabled !== false && !seen.includes(row.pump.provider)) seen.push(row.pump.provider)
  }
  return seen
}

function matches(row, id) {
  return row.id === id || row.pump?.model === id || (Array.isArray(row.aliases) && row.aliases.includes(id))
}

/**
 * Admit one model id on one route, or refuse it. Fail closed: an unreadable
 * registry, an id no row claims, or a row that is retired from interactive
 * use are all refusals.
 * @returns {Promise<object>} the admitting registry row.
 * @throws {ModelRefused}
 */
export async function admitModel(reader, route, id) {
  let rows
  try {
    rows = await reader.rows()
  } catch (error) {
    if (error instanceof RegistryUnavailable) {
      throw new ModelRefused('registry_unavailable', `refusing "${id}" on "${route}": ${error.message}`)
    }
    throw error
  }
  const claimed = rows.filter(row => matches(row, id))
  if (claimed.length === 0) throw new ModelRefused('unknown_model', `refusing "${id}": no mesh model registry row claims it`)
  const admitted = claimed.find(row => row.pump?.provider === route && row.interactive_enabled !== false)
  if (admitted) return admitted
  if (claimed.every(row => row.interactive_enabled === false)) {
    throw new ModelRefused('retired_model', `refusing "${id}": its registry row is retired from interactive use`)
  }
  throw new ModelRefused('wrong_route', `refusing "${id}": its registry row is not pinned to DSH route "${route}"`)
}

/** Presentation fields a settings entry may keep across regeneration (never identity). */
const CARRIED_FIELDS = ['contextWindow', 'maxTokens', 'compat', 'reasoningEfforts']

/**
 * Render one route's `llm-pi-ai` `models` list from registry rows. Ids and
 * names come only from the registry; capacity/compat fields of an entry whose
 * id survives are carried from the current settings entry because the
 * registry does not record them.
 * @param {object[]} rows - registry rows.
 * @param {string} route - DSH provider route key.
 * @param {object[]} [current] - the route's current settings `models` list.
 */
export function renderRouteModels(rows, route, current = []) {
  const byId = new Map(current.map(entry => [entry.id, entry]))
  const out = []
  for (const row of routeRows(rows, route)) {
    const id = row.pump.model
    if (out.some(entry => entry.id === id)) continue
    const entry = { id, name: row.name ?? id }
    const modalities = (row.modalities ?? []).filter(m => m === 'text' || m === 'image')
    if (modalities.length > 0) entry.input = modalities
    const previous = byId.get(id)
    if (previous) {
      for (const field of CARRIED_FIELDS) {
        if (previous[field] !== undefined) entry[field] = previous[field]
      }
    }
    out.push(entry)
  }
  return out
}

/**
 * Compare a settings `llm-pi-ai.providers` section against the registry.
 * @returns {{ routes: Record<string, {models: object[], added: string[], dropped: string[]}>,
 *   registryProviders: string[], missingRoutes: string[] }}
 */
export function planSettings(rows, providers, governedRoutes) {
  const routes = {}
  for (const route of governedRoutes) {
    const current = providers?.[route]?.models ?? []
    const models = renderRouteModels(rows, route, current)
    const before = current.map(entry => entry.id)
    const after = models.map(entry => entry.id)
    routes[route] = {
      models,
      added: after.filter(id => !before.includes(id)),
      dropped: before.filter(id => !after.includes(id)),
    }
  }
  const registryProviders = curatedProviders(rows)
  return {
    routes,
    registryProviders,
    missingRoutes: registryProviders.filter(route => !(providers && route in providers)),
  }
}
