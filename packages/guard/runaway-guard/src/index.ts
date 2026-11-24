/** Preset-scoped runaway policy for top-level agents. @module @deepseek-ai/dsh-runaway-guard */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { JobSnapshot } from '@deepseek-ai/dsh-jobs'
import { installRunawayGuard } from '@deepseek-ai/dsh-subagent'

export const name = 'runaway-guard'
export const inject = ['jobs']

/** Configured limits; zero disables one limit. */
export interface Config {
  maxSteps?: number
  maxTokens?: number
  maxRepeatCalls?: number
  jobSettleTimeoutMs?: number
}

export const Config: z<Config> = z.object({
  maxSteps: z.number().default(200),
  maxTokens: z.number().default(20_000_000),
  maxRepeatCalls: z.number().default(20),
  jobSettleTimeoutMs: z.number().default(30_000),
})

function limit(value: number | undefined, field: string): number | undefined {
  if (value === 0) return undefined
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error(`runaway-guard: ${field} must be zero or a positive safe integer`)
  }
  return value
}

async function stopOwnedJobs(ctx: Context, agent: Agent, timeoutMs: number): Promise<void> {
  const live = ctx.jobs.list(agent).filter(job => job.status === 'running' || job.status === 'stopping')
  for (const job of live) {
    if (job.status === 'running') ctx.jobs.kill(job.id, agent, 'owner stopped by runaway guard')
  }
  await Promise.all(live.map(async (job: JobSnapshot) => {
    await ctx.jobs.wait(job.id, timeoutMs, agent)
  }))
}

/** Install one guard in the current agent-preset scope. */
export function apply(ctx: Context, config: Config): void {
  const timeoutMs = limit(config.jobSettleTimeoutMs, 'jobSettleTimeoutMs')
  if (timeoutMs === undefined) throw new Error('runaway-guard: jobSettleTimeoutMs cannot be zero')
  installRunawayGuard(ctx, {
    maxSteps: limit(config.maxSteps, 'maxSteps'),
    maxTokens: limit(config.maxTokens, 'maxTokens'),
    maxRepeatCalls: limit(config.maxRepeatCalls, 'maxRepeatCalls'),
  }, {
    eventType: 'agent/runaway-stop',
    onStop: async agent => stopOwnedJobs(ctx, agent, timeoutMs),
  })
}

export default { name, inject, Config, apply }
