#!/usr/bin/env node
// Generate the registry-governed llm-pi-ai model lists in a DSH settings.yaml.
//
//   FORAGE_STUDIO_TOKEN=$(forage-secret get STUDIO_TOKEN) \
//     node bin/generate.mjs [--settings ~/.dsh/settings.yaml] [--routes forage,forge_qwen38]
//                           [--base-url https://forage.ink] [--write]
//
// Without --write this is a dry run: it prints the plan and exits 3 when the
// file drifts from the registry (0 when in sync). --write replaces ONLY the
// governed routes' `models` lists (comments and every other key preserved)
// after writing a timestamped backup. An unreadable registry exits 2 and
// writes nothing: there is no fallback list.

import { copyFileSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { parseArgs } from 'node:util'
import { createRegistryReader, planSettings, RegistryUnavailable } from '../lib/registry.js'

export const DEFAULT_ROUTES = ['forage', 'forge_qwen38']

const requireYaml = createRequire(new URL('../../../packages/settings/settings-file/package.json', import.meta.url))
const YAML = requireYaml('yaml')

/**
 * @returns {Promise<number>} process exit code.
 */
export async function main(argv, { fetch: doFetch, env = process.env, log = console.log } = {}) {
  const { values } = parseArgs({
    args: argv,
    options: {
      'settings': { type: 'string', default: `${homedir()}/.dsh/settings.yaml` },
      'routes': { type: 'string', default: DEFAULT_ROUTES.join(',') },
      'base-url': { type: 'string', default: env.FORAGE_BASE_URL ?? 'https://forage.ink' },
      'write': { type: 'boolean', default: false },
    },
  })
  const routes = values.routes.split(',').map(s => s.trim()).filter(Boolean)
  const reader = createRegistryReader({
    baseUrl: values['base-url'],
    token: () => env.FORAGE_STUDIO_TOKEN,
    ttlMs: 0,
    ...doFetch ? { fetch: doFetch } : {},
  })
  let rows
  try {
    rows = await reader.rows()
  } catch (error) {
    if (!(error instanceof RegistryUnavailable)) throw error
    log(JSON.stringify({ ok: false, condition: 'registry_unavailable', error: error.message }))
    return 2
  }
  const text = readFileSync(values.settings, 'utf8')
  const doc = YAML.parseDocument(text)
  const providers = doc.getIn(['llm-pi-ai', 'providers'])?.toJSON() ?? {}
  const plan = planSettings(rows, providers, routes)
  const drift = Object.values(plan.routes).some(r => r.added.length > 0 || r.dropped.length > 0)
  const summary = {
    ok: true,
    registryProviders: plan.registryProviders,
    missingRoutes: plan.missingRoutes,
    routes: Object.fromEntries(Object.entries(plan.routes).map(([route, r]) => [route, {
      ids: r.models.map(m => m.id), added: r.added, dropped: r.dropped,
    }])),
    drift,
  }
  if (!values.write) {
    log(JSON.stringify(summary, null, 2))
    return drift ? 3 : 0
  }
  for (const [route, r] of Object.entries(plan.routes)) {
    if (!(route in providers)) {
      log(JSON.stringify({ ok: false, condition: 'route_not_configured', route }))
      return 4
    }
    if (r.models.length === 0) {
      log(JSON.stringify({ ok: false, condition: 'route_would_be_empty', route }))
      return 4
    }
  }
  for (const [route, r] of Object.entries(plan.routes)) {
    doc.setIn(['llm-pi-ai', 'providers', route, 'models'], doc.createNode(r.models))
  }
  const backup = `${values.settings}.bak-registry-${new Date().toISOString().replace(/[:.]/g, '')}`
  copyFileSync(values.settings, backup)
  const tmp = `${values.settings}.tmp-registry`
  writeFileSync(tmp, doc.toString(), { mode: 0o600 })
  renameSync(tmp, values.settings)
  log(JSON.stringify({ ...summary, written: values.settings, backup }, null, 2))
  return 0
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = await main(process.argv.slice(2))
}
