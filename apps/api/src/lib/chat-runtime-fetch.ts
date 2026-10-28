// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Authenticated fetches against the runtime that owns a chat session: a
 * project's runtime (project chats, project calls) or a workspace runtime
 * (workspace chats). Shared by the chat routes and by code that tracks a
 * turn outside a request (project calls, the turn reattach job).
 */

import type { IRuntimeManager } from './runtime'
import { isMetalEnabled } from './metal-eligibility'
import { resolveWorkspaceRuntimeUrl } from './resolve-workspace-runtime-url'
import { deriveWorkspaceRuntimeToken } from './workspace-runtime-token'

const isKubernetes = () => !!process.env.KUBERNETES_SERVICE_HOST

/** How long a resume/turn read waits for a runtime that is still being assigned. */
const RUNTIME_NOT_READY_MAX_WAIT_MS = 10_000

export type WorkspaceRuntimeExtra = {
  anchorProjectId?: string
  localFolders?: string[]
  readonlyProjectIds?: string[]
}

export async function isRuntimeNotReady(response: Response): Promise<boolean> {
  if (response.status !== 503) return false
  try {
    const body = (await response.clone().json()) as { error?: { code?: string } }
    return body?.error?.code === 'runtime_not_ready'
  } catch {
    return false
  }
}

/**
 * Metal keeps each project online only in its own `ws:proj:<id>` runtime, so
 * attachments are durable records only: they never mount into, or restart, a
 * session runtime.
 */
export function isMetalSingleRuntime(): boolean {
  return process.env.SHOGO_LOCAL_MODE !== 'true' && isMetalEnabled()
}

export function runtimeMembers(attachedProjectIds: string[]): string[] {
  return isMetalSingleRuntime() ? [] : attachedProjectIds
}

/** The caller's manager when it passed the key (even as undefined), else the process-wide one off-cluster. */
async function runtimeManagerFor(opts: { runtimeManager?: IRuntimeManager }): Promise<IRuntimeManager | undefined> {
  if ('runtimeManager' in opts || isKubernetes()) return opts.runtimeManager
  const { getRuntimeManager } = await import('./runtime/manager')
  return getRuntimeManager() as unknown as IRuntimeManager
}

/**
 * Fetch `path` on a project's runtime with its runtime token. `resolveUrl`
 * lets the chat route keep its own wake handling; everyone else gets the
 * standard resolver.
 */
export async function fetchFromProjectRuntime(
  projectId: string,
  path: string,
  init?: RequestInit,
  opts: {
    resolveUrl?: (projectId: string) => Promise<string>
    runtimeManager?: IRuntimeManager
    /**
     * Agent-initiated traffic (the agent dispatcher, agent-call wakes) resolves
     * the callee into the BACKGROUND pool: waking a project to read a file for
     * a turn must never take one of the three warm-preview slots and evict the
     * preview the user is looking at (SHO-226). UI chat routes leave it unset.
     */
    background?: boolean
  } = {},
): Promise<Response> {
  let baseUrl: string
  if (opts.resolveUrl) {
    baseUrl = await opts.resolveUrl(projectId)
  } else {
    const { resolveProjectPodUrl } = await import('./resolve-pod-url')
    const runtimeManager = await runtimeManagerFor(opts)
    baseUrl = (
      await resolveProjectPodUrl(projectId, {
        logTag: 'ChatRuntimeFetch',
        runtimeManager,
        ...(opts.background ? { background: true } : {}),
      })
    ).url
  }
  const { deriveProjectRuntimeToken } = await import('./project-runtime-token')
  const headers = new Headers(init?.headers)
  if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
  headers.set('x-runtime-token', await deriveProjectRuntimeToken(projectId))
  return fetch(`${baseUrl}${path}`, { ...init, headers })
}

/**
 * Fetch `path` on a workspace runtime with the workspace runtime token.
 * Resolves the runtime URL fresh (host `startWorkspace` dedupes). Reads are
 * retried briefly while the runtime is still being assigned.
 */
export async function fetchFromWorkspaceRuntime(
  workspaceId: string,
  attachedProjectIds: string[],
  path: string,
  init?: RequestInit,
  extra?: WorkspaceRuntimeExtra,
  opts: { runtimeManager?: IRuntimeManager; alwaysEnabled?: boolean } = {},
): Promise<Response> {
  const runtimeManager = await runtimeManagerFor(opts)
  const resolved = await resolveWorkspaceRuntimeUrl(workspaceId, {
    attachedProjectIds: runtimeMembers(attachedProjectIds),
    logTag: 'WorkspaceRuntime',
    runtimeManager,
    alwaysEnabled: opts.alwaysEnabled,
    ...extra,
  })
  const headers = new Headers(init?.headers)
  if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
  headers.set('x-runtime-token', deriveWorkspaceRuntimeToken(workspaceId))
  const method = (init?.method ?? 'GET').toUpperCase()
  const retryable = method === 'GET' || method === 'HEAD'
  const deadline = Date.now() + RUNTIME_NOT_READY_MAX_WAIT_MS
  for (;;) {
    const response = await fetch(`${resolved.url}${path}`, { ...init, headers })
    if (!retryable || Date.now() >= deadline || !(await isRuntimeNotReady(response))) return response
    await response.body?.cancel().catch(() => {})
    const retryAfterSec = Number(response.headers.get('retry-after'))
    const waitMs = Number.isFinite(retryAfterSec) ? Math.min(retryAfterSec * 1000, 2_000) : 1_000
    await new Promise((resolve) => setTimeout(resolve, waitMs))
  }
}
