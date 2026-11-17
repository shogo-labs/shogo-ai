// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The tiny leaf both halves of the cross-workspace feature need (SHO-389):
 * the scope of the tool call in flight, the headers that carry it on the
 * internal API call underneath, and the argument hash an approval is bound to.
 *
 * Leaf on purpose — `internal-api.ts` (which builds every request) and
 * `cross-workspace.ts` (which resolves the target and asks the person) both
 * import it, so neither has to import the other.
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'

export const CROSS_WORKSPACE_APPROVAL_HEADER = 'X-Cross-Workspace-Approval'
export const CROSS_WORKSPACE_TOOL_HEADER = 'X-Cross-Workspace-Tool'
export const CROSS_WORKSPACE_ARGS_HEADER = 'X-Cross-Workspace-Args-Hash'
/**
 * The workspace the call is for. A `project_call` names a *project*, so the API
 * cannot tell from the URL which workspace that project lives in — and for a
 * cloud project there is no local row to look it up. This is the same target
 * the agent asked for with the `workspace` parameter, not a new permission: the
 * API still requires the person's ticket, ownership of the Personal workspace,
 * membership in this target, and an approval for a write.
 */
export const CROSS_WORKSPACE_TARGET_HEADER = 'X-Cross-Workspace-Target'

export type CrossWorkspaceScope = {
  /** The workspace the tool body should act in. */
  workspaceId: string
  /** Set for a write: the approval the API spends on this one request. */
  approvalId?: string
  /** The tool name the approval was granted for (audit + spend binding). */
  tool?: string
  /** sha256 of the arguments the person approved. */
  argsHash?: string
}

const storage = new AsyncLocalStorage<CrossWorkspaceScope>()

/** Run `fn` as an action in another workspace. */
export function runWithCrossWorkspace<T>(scope: CrossWorkspaceScope, fn: () => T): T {
  return storage.run(scope, fn)
}

/** The target of the tool call in flight, when it is another workspace. */
export function crossWorkspaceScope(): CrossWorkspaceScope | null {
  return storage.getStore() ?? null
}

/**
 * The workspace a tool should act in: the cross-workspace target when the gate
 * resolved one, otherwise the runtime's own. Every `workspaceIdOf(ctx)` uses
 * this, so no tool needs to know the feature exists.
 */
export function crossWorkspaceTargetId(): string | null {
  return storage.getStore()?.workspaceId ?? null
}

/** Headers the internal API call underneath needs to reach that workspace. */
export function crossWorkspaceHeaders(): Record<string, string> {
  const scope = storage.getStore()
  if (!scope) return {}
  const headers: Record<string, string> = {
    [CROSS_WORKSPACE_TOOL_HEADER]: scope.tool ?? '',
    [CROSS_WORKSPACE_TARGET_HEADER]: scope.workspaceId,
  }
  if (scope.approvalId) {
    headers[CROSS_WORKSPACE_APPROVAL_HEADER] = scope.approvalId
    headers[CROSS_WORKSPACE_ARGS_HEADER] = scope.argsHash ?? ''
  }
  return headers
}

/**
 * sha256 over the tool arguments, keys sorted, so the approval the person gave
 * is bound to exactly what they saw. Matches the API's `argsHash`.
 */
export function argsHashHex(args: unknown): string {
  return createHash('sha256').update(canonicalJson(args)).digest('hex')
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`
}
