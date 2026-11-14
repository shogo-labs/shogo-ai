// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * "Run my other workspaces" for the Personal workspace agent (SHO-389).
 *
 * The person's Personal workspace agent may read, and with their approval
 * write, every workspace they belong to — cards, channel posts, schedules,
 * `project_call` — on the desktop and in the cloud. This module is the runtime
 * half of that:
 *
 *   - the `workspace` parameter, registered **only** on the Personal workspace
 *     agent's tools (a project agent's schema has no such parameter, so it can
 *     never ask);
 *   - `resolveTargetWorkspace`, one resolver shared by every tool: id, slug or
 *     name, case-insensitive prefix/contains, and an ambiguous name answers
 *     with the candidates instead of picking one;
 *   - `withCrossWorkspaceGate`, applied once to every registered tool (next to
 *     `withActionRules` in `createGatewayTools`): it resolves the target, asks
 *     the person for **every** write whatever the security mode says, mints
 *     the approval the API spends, and runs the tool inside the target scope so
 *     the internal API call underneath carries the target and the approval.
 *
 * Nothing here re-implements a tool. The `workspace` parameter is stripped
 * before the tool body runs, and `crossWorkspaceTargetId(ctx)` is what the
 * existing `workspaceIdOf(ctx)` helpers now read, so every route keeps one code
 * path.
 */

import type { AgentTool } from '@mariozechner/pi-agent-core'
import type { ToolContext } from './gateway-tools'
import type { ApprovalOutcome, PermissionEngine } from './permission-engine'
import {
  argsHashHex,
  runWithCrossWorkspace,
  type CrossWorkspaceScope,
} from './cross-workspace-scope'
import { fetchCrossWorkspaceTargets, mintCrossWorkspaceApproval, type CrossWorkspaceTargetSummary } from './internal-api'

export {
  argsHashHex,
  crossWorkspaceHeaders,
  crossWorkspaceScope,
  crossWorkspaceTargetId,
  type CrossWorkspaceScope,
} from './cross-workspace-scope'

/** Tools that may READ another workspace. No approval. */
export const CROSS_WORKSPACE_READ_TOOLS: ReadonlySet<string> = new Set([
  'board_list',
  'board_summary',
  'board_health',
  'work_item_list',
  'work_item_get',
  'work_item_history',
  'team_chat_list',
  'team_chat_read',
  'team_chat_search',
  'team_chat_doc_read',
  'member_activity',
  'agent_runs_list',
  'project_list',
  'schedule_list',
  'trigger_list',
  'list_projects',
])

/** Tools that may WRITE another workspace. Approved on every call. */
export const CROSS_WORKSPACE_WRITE_TOOLS: ReadonlySet<string> = new Set([
  'work_item_create',
  'work_item_update',
  'work_item_move',
  'work_item_comment',
  'work_item_link',
  'work_item_bulk_update',
  'team_chat_post',
  'team_chat_update',
  'team_chat_doc_update',
  'schedule_create',
  'schedule_update',
  'trigger_update',
  'agent_run_stop',
  'project_call',
])

/**
 * Destructive and administrative tools never cross a workspace boundary, even
 * with an approval: `schedule_delete` and `trigger_delete` would silently
 * remove someone's automation, and board/column admin and `system_apply`
 * rewrite a workspace's structure. They refuse with
 * `cross_workspace_unsupported` and do not prompt.
 */
export const CROSS_WORKSPACE_UNSUPPORTED_TOOLS: ReadonlySet<string> = new Set([
  'schedule_delete',
  'trigger_delete',
  'system_apply',
  'board_create',
  'board_update',
  'board_delete',
  'board_archive',
  'column_create',
  'column_update',
  'column_delete',
  'project_create',
  'project_attach',
  'project_detach',
  'work_template_add',
])

/**
 * Only the Personal workspace agent gets the parameter: a workspace runtime
 * whose capability profile is `personal`, with no anchor project (an anchored
 * runtime speaks for one project, not for the workspace).
 */
export function crossWorkspaceEnabledFor(config: { capabilityProfile?: string } | undefined): boolean {
  if (process.env.WORKSPACE_RUNTIME !== 'true') return false
  if (process.env.WORKSPACE_ANCHOR_PROJECT_ID) return false
  return config?.capabilityProfile === 'personal'
}

export function crossWorkspaceEnabled(ctx: ToolContext): boolean {
  return crossWorkspaceEnabledFor(ctx.config)
}

/** Every tool name that accepts a `workspace`. */
export function crossWorkspaceToolNames(): string[] {
  return [...CROSS_WORKSPACE_READ_TOOLS, ...CROSS_WORKSPACE_WRITE_TOOLS]
}

/** The `workspace` parameter, or nothing at all for an agent that can't use it. */
export function withCrossWorkspaceParam<T extends AgentTool>(tool: T, ctx: ToolContext): T {
  if (!crossWorkspaceEnabled(ctx)) return tool
  if (!CROSS_WORKSPACE_READ_TOOLS.has(tool.name) && !CROSS_WORKSPACE_WRITE_TOOLS.has(tool.name)) return tool
  const parameters = (tool.parameters ?? { type: 'object', properties: {} }) as {
    properties?: Record<string, unknown>
  }
  if (parameters.properties?.workspace) return tool
  return {
    ...tool,
    parameters: {
      ...parameters,
      properties: {
        ...(parameters.properties ?? {}),
        workspace: {
          type: 'string',
          description:
            'Another workspace you own or belong to: its name ("Samsara Game"), slug or id. Reads need no approval; every write asks the person first. An ambiguous name comes back with the candidates — pass one of their names or ids.',
        },
      },
    },
  } as T
}

export type ResolveTargetResult =
  | { ok: true; workspaceId: string; name: string; same: boolean }
  | { ok: false; code: string; error: string; candidates?: Array<{ id: string; name: string }> }

const NAME_LOOKUP_TTL_MS = 30_000
const targetCache = new Map<string, { at: number; workspaces: CrossWorkspaceTargetSummary[] }>()

async function targetsFor(callerWorkspaceId: string): Promise<CrossWorkspaceTargetSummary[]> {
  const hit = targetCache.get(callerWorkspaceId)
  if (hit && Date.now() - hit.at < NAME_LOOKUP_TTL_MS) return hit.workspaces
  const r = await fetchCrossWorkspaceTargets(callerWorkspaceId)
  if (!r.ok || !r.data?.workspaces) return hit?.workspaces ?? []
  targetCache.set(callerWorkspaceId, { at: Date.now(), workspaces: r.data.workspaces })
  return r.data.workspaces
}

export function _resetCrossWorkspaceCacheForTests(): void {
  targetCache.clear()
}

/**
 * Turn a `workspace` reference into a workspace id.
 *
 * Exact id, then exact slug, then exact name (case-insensitive), then a
 * prefix/contains match. Two or more matches at the loosest level that matched
 * is `ambiguous` with the candidates: never pick one for the person.
 */
export async function resolveTargetWorkspace(
  ctx: ToolContext,
  ref: string,
  callerWorkspaceId: string | null,
): Promise<ResolveTargetResult> {
  const needle = (ref ?? '').trim()
  if (!needle) return { ok: false, code: 'workspace_not_found', error: 'Pass a workspace name, slug or id.' }
  if (!callerWorkspaceId) {
    return { ok: false, code: 'no_workspace', error: 'This runtime has no workspace context.' }
  }
  const workspaces = await targetsFor(callerWorkspaceId)
  if (!workspaces.length) {
    return {
      ok: false,
      code: 'workspaces_unavailable',
      error: "Couldn't load the list of workspaces you belong to, so that name can't be resolved. Try again.",
    }
  }
  const lower = needle.toLowerCase()
  const exactId = workspaces.find((w) => w.id === needle)
  const exactSlug = workspaces.find((w) => w.slug && w.slug.toLowerCase() === lower)
  const exactName = workspaces.filter((w) => w.name.toLowerCase() === lower)
  const prefix = workspaces.filter((w) => w.name.toLowerCase().startsWith(lower))
  const contains = workspaces.filter((w) => w.name.toLowerCase().includes(lower))
  const winner = exactId ?? exactSlug ?? (exactName.length === 1 ? exactName[0] : undefined)
  if (winner) return allow(winner, callerWorkspaceId)
  const pool = exactName.length > 1 ? exactName : prefix.length ? prefix : contains
  if (pool.length === 1) return allow(pool[0], callerWorkspaceId)
  if (pool.length > 1) {
    return {
      ok: false,
      code: 'workspace_ambiguous',
      error: `"${needle}" matches ${pool.length} workspaces. Say which one: ${pool.map((w) => `${w.name} (${w.id})`).join(', ')}.`,
      candidates: pool.map((w) => ({ id: w.id, name: w.name })),
    }
  }
  return {
    ok: false,
    code: 'workspace_not_found',
    error: `No workspace you belong to is called "${needle}". Your workspaces: ${workspaces
      .map((w) => w.name)
      .join(', ')}.`,
  }
}

function allow(w: CrossWorkspaceTargetSummary, callerWorkspaceId: string): ResolveTargetResult {
  if (!w.reachable) {
    const code =
      w.unreachableReason === 'desktop_hosted'
        ? 'desktop_offline'
        : w.unreachableReason === 'cloud_signed_out'
          ? 'cloud_signed_out'
          : 'cloud_unreachable'
    const why =
      w.unreachableReason === 'desktop_hosted'
        ? `"${w.name}" runs on a desktop, and cross-workspace calls only reach it from that desktop itself.`
        : `Shogo Cloud isn't reachable right now, so "${w.name}" can't be read from here.`
    return { ok: false, code, error: why }
  }
  return { ok: true, workspaceId: w.id, name: w.name, same: w.id === callerWorkspaceId }
}

function textResult(data: any): any {
  return {
    content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }],
    details: data,
  }
}

export interface CrossWorkspaceGateInput {
  tool: AgentTool
  ctx: ToolContext
  /** The runtime's own workspace (the one the token belongs to). */
  workspaceId: string | null
  engine?: PermissionEngine | null
}

/**
 * Wrap one tool. A call with no `workspace` is untouched; a call naming this
 * workspace is untouched too (no approval for "here").
 */
export function withCrossWorkspaceGate(input: CrossWorkspaceGateInput): AgentTool {
  const { tool, ctx, workspaceId, engine } = input
  const original = tool.execute
  const gated: AgentTool = {
    ...tool,
    execute: async (toolCallId: string, params: any, signal?: AbortSignal, onUpdate?: any) => {
      const p = (params ?? {}) as Record<string, any>
      const ref = p.workspace
      if (typeof ref !== 'string' || !ref.trim()) {
        return original(toolCallId, p, signal, onUpdate)
      }
      const { workspace: _ref, ...rest } = p

      if (CROSS_WORKSPACE_UNSUPPORTED_TOOLS.has(tool.name)) {
        return textResult({
          error: `${tool.name} can't be used in another workspace. Destructive and admin tools stay in the workspace they belong to.`,
          code: 'cross_workspace_unsupported',
        })
      }
      const write = CROSS_WORKSPACE_WRITE_TOOLS.has(tool.name)
      if (!write && !CROSS_WORKSPACE_READ_TOOLS.has(tool.name)) {
        return textResult({
          error: `${tool.name} can't be used in another workspace.`,
          code: 'cross_workspace_unsupported',
        })
      }

      const resolved = await resolveTargetWorkspace(ctx, ref, workspaceId)
      if (!resolved.ok) {
        return textResult({ error: resolved.error, code: resolved.code, ...(resolved.candidates ? { candidates: resolved.candidates } : {}) })
      }
      if (resolved.same) {
        return original(toolCallId, rest, signal, onUpdate)
      }

      const scope: CrossWorkspaceScope = { workspaceId: resolved.workspaceId, tool: tool.name }
      if (write) {
        // Every write asks, whatever the security mode: full autonomy covers
        // this agent's own workspace, not somebody else's.
        const outcome: ApprovalOutcome = engine
          ? await engine.requestApprovalOutcome(
              toolCallId,
              tool.name,
              'project',
              { ...rest, workspace: undefined, target: resolved.name },
              `Another workspace: ${tool.name} in "${resolved.name}"`,
              { noCache: true, expireOnTimeout: true },
            )
          : 'unavailable'
        if (outcome !== 'approved') {
          const code =
            outcome === 'timeout' ? 'approval_expired' : outcome === 'unavailable' ? 'approval_required' : 'approval_denied'
          const error =
            outcome === 'denied'
              ? `The person declined ${tool.name} in "${resolved.name}". Nothing was changed; say so in your reply and carry on.`
              : outcome === 'timeout'
                ? `Nobody answered the approval for ${tool.name} in "${resolved.name}" in time, so nothing was changed.`
                : outcome === 'unavailable'
                  ? `Writing to "${resolved.name}" needs the person's approval and there is nobody to ask right now (a scheduled or background run). Do the rest, and put what you would have done in your report instead.`
                  : `Writing to "${resolved.name}" was not approved, so nothing was changed.`
          return textResult({ error, code })
        }
        const hash = argsHashHex(rest)
        const minted = await mintCrossWorkspaceApproval({
          workspaceId: workspaceId!,
          targetWorkspaceId: resolved.workspaceId,
          tool: tool.name,
          argsHash: hash,
        })
        if (!minted.ok) {
          return textResult({
            error: minted.error ?? "Couldn't record the approval, so the write was not made.",
            code: minted.code ?? 'approval_required',
          })
        }
        scope.approvalId = minted.data?.approvalId
        scope.argsHash = hash
      }

      return runWithCrossWorkspace(scope, () => original(toolCallId, rest, signal, onUpdate))
    },
  }
  return gated
}
