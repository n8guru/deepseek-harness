/**
 * Opt-in `record_successor` tool: the old cadence session records its one
 * durable successor after a generation hand-forward, then (by default)
 * archives itself. Mounted beside `hand_forward` under the same opt-in.
 * Readiness and lineage rules live in `ctx.sessionSuccessor`; a refusal leaves
 * the old session's log unchanged and unarchived, so it stays selected.
 * @module @deepseek-ai/dsh-command-compact/record-successor
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
// Type-only: the ctx.sessionSuccessor merge.
import type { RecordSuccessorResult } from '@deepseek-ai/dsh-session-successor'

/**
 * The slice of the optional host workspace registry this tool reads, stated
 * structurally so the agent-side package takes no dependency on the
 * registry's storage stack.
 */
interface WorkspaceRegistryFace {
  list(): readonly { readonly sessionIds: readonly string[] }[]
  archiveSession(sessionId: SessionId): Promise<void>
}

/** Tool arguments (wire names). */
export interface RecordSuccessorArgs {
  successor_session_id: string
  successor_generation: number
  handoff_id: string
  pointer_session_id: string | null
  archive_old?: boolean
}

/** Tool result. */
export interface RecordSuccessorOutput {
  status: RecordSuccessorResult['status']
  successor_session_id: string
  successor_generation: number
  handoff_id: string
  seq: number
  archived: boolean
  archive_error?: string
}

/** Once the old session is accounted in a workspace, the successor must be accounted in that same one. */
function sameWorkspaceIn(registry: WorkspaceRegistryFace): (oldId: SessionId, successorId: SessionId) => boolean {
  return (oldId, successorId) => {
    const home = registry.list().filter(workspace => workspace.sessionIds.includes(oldId))
    return home.length === 0 || home.some(workspace => workspace.sessionIds.includes(successorId))
  }
}

/**
 * Record the successor of `old` and optionally archive it. Workspace
 * membership comes from the workspace registry when composed: once the old
 * session is accounted in a workspace, the successor must be accounted in
 * that same workspace.
 * @param ctx - context resolving the optional successor and workspace services.
 * @param old - the calling (old) session.
 * @param args - the tool arguments.
 * @param signal - caller cancellation.
 * @returns the durable fact plus the archive outcome.
 */
export async function executeRecordSuccessor(
  ctx: Context, old: Session, args: RecordSuccessorArgs, signal?: AbortSignal,
): Promise<RecordSuccessorOutput> {
  const successors = ctx.get('sessionSuccessor')
  if (successors === undefined) throw new Error('record_successor requires the session-successor service')
  const registry = (ctx as unknown as { get(name: string): unknown }).get('workspaceRegistry') as WorkspaceRegistryFace | undefined
  const sameWorkspace = registry === undefined ? undefined : sameWorkspaceIn(registry)
  const result = await successors.record(old, {
    successorSessionId: args.successor_session_id,
    successorGeneration: args.successor_generation,
    handoffId: args.handoff_id,
    pointerSessionId: args.pointer_session_id,
  }, { ...(sameWorkspace === undefined ? {} : { sameWorkspace }), ...(signal === undefined ? {} : { signal }) })
  const output: RecordSuccessorOutput = {
    status: result.status,
    successor_session_id: result.fact.successorSessionId,
    successor_generation: result.fact.successorGeneration,
    handoff_id: result.fact.handoffId,
    seq: result.seq,
    archived: false,
  }
  // The fact is durable (flushed) before archive; an archive failure keeps it.
  if (args.archive_old !== false && registry !== undefined) {
    try {
      await registry.archiveSession(old.id)
      output.archived = true
    } catch (error: unknown) {
      output.archive_error = String(error)
    }
  }
  return output
}

/**
 * Register `record_successor` on the agent tool registry.
 * @param ctx - agent/tool scope.
 */
export function installRecordSuccessor(ctx: Context): void {
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'record_successor',
    description: 'After a cadence hand-forward: record this session\'s one durable successor once the successor\'s first turn completed and the current conductor pointer resolves to it, then archive this session. Refuses (and changes nothing) when not ready, conflicting, cyclic, or in another workspace. Idempotent by handoff_id.',
    parameters: {
      successor_session_id: { type: 'string', required: true, description: 'Exact DSH session id of the new generation.' },
      successor_generation: { type: 'integer', required: true, description: 'Generation number of the successor (N+1).' },
      handoff_id: { type: 'string', required: true, description: 'Stable id of this hand-off; replays with the same id are no-ops.' },
      pointer_session_id: { type: 'string', required: true, description: 'Session id the current conductor pointer resolve returned just now.' },
      archive_old: { type: 'boolean', description: 'Archive this session after recording (default true).' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          status: { type: 'string', required: true },
          successor_session_id: { type: 'string', required: true },
          successor_generation: { type: 'integer', required: true },
          handoff_id: { type: 'string', required: true },
          seq: { type: 'integer', required: true },
          archived: { type: 'boolean', required: true },
          archive_error: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      const agent = exec.agent
      if (!agent) throw new Error('record_successor requires a live agent')
      return await executeRecordSuccessor(ctx, agent.session, args, exec.signal)
    },
  })), 'record-successor tool')
}
