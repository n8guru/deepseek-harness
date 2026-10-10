/**
 * The subagent model table: an editable role -> provider/model map. Code names a
 * role, never a model; the table is the only place a model id lives. Composed
 * defaults sit in the `subagent` plugin config, and the `subagent-models`
 * settings section layers the user's edits over them, read live per delegation.
 * @module @deepseek-ai/dsh-subagent/models
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import { SubagentError } from './error.ts'

/** Role the delegation tools use when the caller names none. Absent = inherit the parent's model. */
export const DEFAULT_SUBAGENT_ROLE = 'default'

/** Settings namespace carrying the subagent model table. */
export const SUBAGENT_MODELS_SETTINGS_NAMESPACE = settingsNamespace('subagent-models')

/** One table row: the provider route and model a child runs on. */
export interface SubagentModelRoute {
  provider: string
  model: string
  maxTokens?: number
}

/** Stored and composed model table, keyed by role name. */
export interface SubagentModelsSettings {
  roles: Record<string, SubagentModelRoute>
}

export const SUBAGENT_MODELS_SCHEMA: z<SubagentModelsSettings> = z.object({
  roles: z.dict(z.object({
    provider: z.string().required(),
    model: z.string().required(),
    maxTokens: z.number().step(1).min(1),
  })).default({}),
})

/** Wire the table into the runtime; `read()` is the live, detached view. */
export function installSubagentModels(ctx: Context, entry: SubagentModelsSettings): () => SubagentModelsSettings {
  let source: () => SubagentModelsSettings = () => entry
  installSettingsSection(ctx, SUBAGENT_MODELS_SETTINGS_NAMESPACE, SUBAGENT_MODELS_SCHEMA, entry, {
    setSource: (current) => { source = current },
    onChange: () => {},
  })
  return () => source()
}

/** Resolve a role to child agent options; an unknown role fails loudly and lists the table. */
export function routeForRole(table: SubagentModelsSettings, role: string): SubagentModelRoute {
  const route = Object.hasOwn(table.roles, role) ? table.roles[role] : undefined
  if (route === undefined) {
    const known = Object.keys(table.roles).join(', ') || '(none configured)'
    throw new SubagentError(
      `unknown subagent model role "${role}"; roles in the subagent-models table: ${known}`,
      'UNKNOWN_MODEL_ROLE',
    )
  }
  return { provider: route.provider, model: route.model, ...route.maxTokens === undefined ? {} : { maxTokens: route.maxTokens } }
}
