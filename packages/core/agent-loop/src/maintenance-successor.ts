/**
 * Production `maintenanceSuccessorSetup` composer for {@link HostMaintenance}.
 *
 * Confers no launch authority: only the trusted `host-maintenance.successor`
 * row does. This row validates that the trusted launch is runnable in THIS Host
 * (registered provider route, existing absolute workspace, resolvable preset)
 * and composes the successor Agent through the same canonical preset lifecycle
 * the session controller uses (`agentPresets.resolve` + `agentPresets.mount`).
 * Any refusal throws before a child effect, so the durable intent stays
 * `accepted-intent` and a later `start-successor` retry re-runs it.
 */
import { statSync } from 'node:fs'
import { Context, Service } from '@deepseek-ai/cordis'
import type { AgentSetup } from '@deepseek-ai/dsh-agent'
import type { MaintenanceLaunchConfig } from './maintenance.ts'

/** Preset id accepted by a preset-free composition (no `agentPresets` registry mounted). */
export const PRESET_FREE_SUCCESSOR = 'default'

interface PresetRegistry {
  resolve(id?: string): Promise<{ id: string; broken?: unknown }>
  mount(ctx: Context, id?: string): Promise<{ id: string }>
}

export class MaintenanceSuccessorComposer extends Service {
  static inject = ['llm', 'agents']

  constructor(ctx: Context) {
    super(ctx, 'maintenanceSuccessorSetup')
  }

  /**
   * Validate a trusted launch against this Host and return its Agent setup.
   * @param launch - schema-validated trusted launch from the immutable durable successor intent.
   * @returns setup mounting the exact preset before publication.
   * @throws when the route, workspace or preset is not runnable here.
   */
  prepare(launch: MaintenanceLaunchConfig): AgentSetup {
    if (!this.ctx.llm.listProviders().some(provider => provider.id === launch.provider)) {
      throw new Error(`maintenance successor provider route not registered: ${launch.provider}`)
    }
    let directory = false
    try { directory = statSync(launch.cwd).isDirectory() } catch {}
    if (!directory) throw new Error(`maintenance successor workspace is not an existing directory: ${launch.cwd}`)
    const presets = this.ctx.get('agentPresets') as PresetRegistry | undefined
    if (presets === undefined) {
      if (launch.agentPreset !== PRESET_FREE_SUCCESSOR) {
        throw new Error(`maintenance successor preset "${launch.agentPreset}" requires an agent preset registry`)
      }
      return () => {}
    }
    return async (agentCtx) => {
      const resolved = await presets.resolve(launch.agentPreset)
      if (resolved.id !== launch.agentPreset || resolved.broken !== undefined) {
        throw new Error(`maintenance successor preset unavailable: ${launch.agentPreset}`)
      }
      const mounted = await presets.mount(agentCtx, launch.agentPreset)
      if (mounted.id !== launch.agentPreset) throw new Error(`maintenance successor preset drifted: ${mounted.id}`)
    }
  }
}

export default MaintenanceSuccessorComposer
