// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Workspace Chat + Session Routes
 *
 * The workspace-scoped sibling of `project-chat.ts`. Provides:
 *
 *   - Workspace chat session management (create / list / attach / detach
 *     projects) — fully functional today, DB-backed.
 *   - POST /workspaces/:workspaceId/chat — resolves the workspace runtime
 *     and proxies the chat. The runtime spawn lands in Phase 2b; until
 *     `SHOGO_WORKSPACE_RUNTIME=true` this returns a clean 501 rather than
 *     half-booting a single-project runtime.
 *
 * Auth: every route resolves the caller via the injected `resolveUserId`
 * (Better Auth session / API key) and checks workspace membership with
 * `hasWorkspaceAccess`. Mounted by server.ts.
 */

import { Hono } from 'hono'

import type { IRuntimeManager } from '../lib/runtime'
import { hasWorkspaceAccess } from '../services/workspace.service'
import {
  attachProject,
  createWorkspaceSession,
  detachProject,
  getAttachedProjects,
  listWorkspaceSessions,
  WorkspaceSessionError,
  type AttachMode,
} from '../services/workspace-session.service'
import {
  resolveWorkspaceRuntimeUrl,
  WorkspaceRuntimeNotEnabledError,
} from '../lib/resolve-workspace-runtime-url'
import { deriveWorkspaceRuntimeToken } from '../lib/workspace-runtime-token'

export interface WorkspaceChatRoutesConfig {
  /** Local runtime manager (used in host mode). */
  runtimeManager?: IRuntimeManager
  /**
   * Resolve the authenticated user id from the request context. In
   * production server.ts passes `getAuthUserId`; tests inject a stub.
   */
  resolveUserId: (c: any) => Promise<string | null>
}

function mapSessionError(c: any, err: unknown) {
  if (err instanceof WorkspaceSessionError) {
    const status = err.code === 'session_not_found' ? 404 : 400
    return c.json({ error: { code: err.code, message: err.message } }, status)
  }
  throw err
}

export function workspaceChatRoutes(config: WorkspaceChatRoutesConfig): Hono {
  const router = new Hono()
  const { resolveUserId, runtimeManager } = config

  /**
   * Auth guard shared by every route: returns the userId or sends the
   * 401/403 response (caller returns it directly).
   */
  async function authorize(c: any): Promise<{ userId: string } | { res: Response }> {
    const workspaceId = c.req.param('workspaceId')
    const userId = await resolveUserId(c)
    if (!userId) {
      return { res: c.json({ error: { code: 'unauthorized', message: 'Authentication required' } }, 401) }
    }
    const ok = await hasWorkspaceAccess(workspaceId, userId)
    if (!ok) {
      return { res: c.json({ error: { code: 'forbidden', message: 'No access to this workspace' } }, 403) }
    }
    return { userId }
  }

  // List workspace-scoped chat sessions.
  router.get('/workspaces/:workspaceId/sessions', async (c) => {
    const auth = await authorize(c)
    if ('res' in auth) return auth.res
    const sessions = await listWorkspaceSessions(c.req.param('workspaceId'))
    return c.json({ sessions })
  })

  // Create a workspace-scoped chat session (optionally pre-attaching projects).
  router.post('/workspaces/:workspaceId/sessions', async (c) => {
    const auth = await authorize(c)
    if ('res' in auth) return auth.res
    const body = await c.req.json().catch(() => ({}))
    try {
      const session = await createWorkspaceSession(c.req.param('workspaceId'), {
        name: body?.name,
        inferredName: body?.inferredName,
        attachProjectIds: Array.isArray(body?.attachProjectIds) ? body.attachProjectIds : undefined,
        attachMode: body?.attachMode as AttachMode | undefined,
      })
      return c.json({ session }, 201)
    } catch (err) {
      return mapSessionError(c, err)
    }
  })

  // List attached projects for a session.
  router.get('/workspaces/:workspaceId/sessions/:sessionId/projects', async (c) => {
    const auth = await authorize(c)
    if ('res' in auth) return auth.res
    const attached = await getAttachedProjects(c.req.param('sessionId'))
    return c.json({ attached })
  })

  // Attach a project to a session.
  router.post('/workspaces/:workspaceId/sessions/:sessionId/projects', async (c) => {
    const auth = await authorize(c)
    if ('res' in auth) return auth.res
    const body = await c.req.json().catch(() => ({}))
    if (!body?.projectId) {
      return c.json({ error: { code: 'bad_request', message: 'projectId is required' } }, 400)
    }
    try {
      const attached = await attachProject(
        c.req.param('sessionId'),
        body.projectId,
        (body.attachMode as AttachMode) ?? 'readwrite',
      )
      return c.json({ attached }, 201)
    } catch (err) {
      return mapSessionError(c, err)
    }
  })

  // Detach a project from a session.
  router.delete('/workspaces/:workspaceId/sessions/:sessionId/projects/:projectId', async (c) => {
    const auth = await authorize(c)
    if ('res' in auth) return auth.res
    const removed = await detachProject(c.req.param('sessionId'), c.req.param('projectId'))
    return c.json({ removed })
  })

  // Proxy chat to the workspace runtime.
  router.post('/workspaces/:workspaceId/chat', async (c) => {
    const auth = await authorize(c)
    if ('res' in auth) return auth.res
    const workspaceId = c.req.param('workspaceId')

    const body = await c.req.json().catch(() => ({} as any))
    const sessionId: string | undefined = body?.sessionId
    if (!sessionId) {
      return c.json({ error: { code: 'bad_request', message: 'sessionId is required' } }, 400)
    }

    let attachedProjectIds: string[]
    try {
      attachedProjectIds = (await getAttachedProjects(sessionId)).map((a) => a.projectId)
    } catch (err) {
      return mapSessionError(c, err)
    }

    let resolved
    try {
      resolved = await resolveWorkspaceRuntimeUrl(workspaceId, {
        attachedProjectIds,
        logTag: 'WorkspaceChat',
        runtimeManager,
      })
    } catch (err) {
      if (err instanceof WorkspaceRuntimeNotEnabledError) {
        return c.json(
          {
            error: {
              code: 'workspace_runtime_unavailable',
              message:
                'Workspace runtimes are not yet available in this environment. ' +
                'Multi-project chat lands with the merged-root runtime (Phase 2b).',
            },
          },
          501,
        )
      }
      throw err
    }

    // Runtime is enabled: proxy the chat through. Full billing/usage
    // parity with project-chat.ts is wired in Phase 2b; this is the
    // minimal forward so the merged-root runtime can be exercised once
    // SHOGO_WORKSPACE_RUNTIME is on.
    const headers = new Headers({ 'Content-Type': 'application/json' })
    headers.set('x-runtime-token', deriveWorkspaceRuntimeToken(workspaceId))
    // The runtime keys its durable-turn + billing state on the chat
    // session id, read from this header (or `chatSessionId` in the body).
    // Forward the workspace session id so it has one.
    headers.set('x-chat-session-id', sessionId)
    const upstream = await fetch(`${resolved.url}/agent/chat`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: c.req.raw.signal,
    })
    return new Response(upstream.body, { status: upstream.status, headers: upstream.headers })
  })

  return router
}
