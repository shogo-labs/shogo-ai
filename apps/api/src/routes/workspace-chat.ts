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
 *     and proxies the chat through the shared merged-root workspace runtime.
 *
 * Auth: every route resolves the caller via the injected `resolveUserId`
 * (Better Auth session / API key) and checks workspace membership with
 * `hasWorkspaceAccess`. Mounted by server.ts.
 */

import { join, resolve } from 'path'

import { Hono } from 'hono'

import type { IRuntimeManager } from '../lib/runtime'
import { prisma } from '../lib/prisma'
import * as billingService from '../services/billing-runtime'
import { getModelTier, resolveModelId } from '@shogo/model-catalog'
import { stampModelProvider } from '../lib/stamp-model-provider'
import { getPersonalCompanionModelId } from '../lib/personal-companion-model'
import { getWorkspaceKind, loadWorkspaceContext, type WorkspaceKind } from '../services/workspace.service'
import { autoCheckpointWorkspaceProjects } from '../services/workspace-checkpoint.service'
import {
  attachProject,
  assertWorkspaceSessionInWorkspace,
  createWorkspaceSession,
  detachProject,
  getOrCreatePrimaryWorkspaceSession,
  getAttachedProjects,
  listWorkspaceSessions,
  pinWorkspaceSessionToProject,
  unpinWorkspaceSession,
  upgradeProjectSessionToWorkspace,
  WorkspaceSessionError,
  type AttachMode,
} from '../services/workspace-session.service'
import { resolveWorkspaceRuntimeUrl, WorkspaceRuntimeNotEnabledError } from '../lib/resolve-workspace-runtime-url'
import { deriveWorkspaceRuntimeToken } from '../lib/workspace-runtime-token'
import { setProjectUser } from '../lib/project-user-context'
import { openSession, closeSession } from '../lib/proxy-billing-session-runtime'
import { enrichWorkspaceReferences, enrichProjectReferences, enrichChatReferences } from '../lib/chat-references'
import {
  attachProjectToProject,
  syncPinnedSessionAttachments,
} from '../services/project-attachment.service'
import {
  clearActiveTurn,
  markTurnEnded,
  markTurnStarted,
  startTurnHeartbeat,
} from '../services/chat-turn-state.service'
import { trackUsageFromStream } from './project-chat'

// Same resolution as project-chat.ts / RuntimeManager: the `workspaces/`
// parent where each project lives at `<dir>/<projectId>`. Auto-checkpoints
// commit the per-project git repo there.
const PROJECT_ROOT = resolve(import.meta.dir, '../../../..')
const WORKSPACES_DIR = process.env.WORKSPACES_DIR || join(PROJECT_ROOT, 'workspaces')

export interface WorkspaceChatRoutesConfig {
  /** Local runtime manager (used in host mode). */
  runtimeManager?: IRuntimeManager
  /**
   * Resolve the authenticated user id from the request context. In
   * production server.ts passes `getAuthUserId`; tests inject a stub.
   */
  resolveUserId: (c: any) => Promise<string | null>
  /** Internal integrations may opt into the workspace runtime as their only path. */
  alwaysEnabled?: boolean
}

function mapSessionError(c: any, err: unknown) {
  if (err instanceof WorkspaceSessionError) {
    const status = err.code === 'session_not_found' || err.code === 'session_not_in_workspace' ? 404 : 400
    return c.json({ error: { code: err.code, message: err.message } }, status)
  }
  throw err
}

/**
 * Tear down the anchor-keyed merged-root runtime (`ws:proj:<anchorId>`) so the
 * next resolve respawns it. Used after a mid-chat attachment change: a member's
 * real dir is shipped as `LINKED_FOLDERS` and parsed once at runtime boot, so a
 * newly-attached project is only admitted as an allowed root after a fresh
 * spawn. Best-effort — swallowed when nothing is running. Mirrors
 * `local-projects.ts:restartAnchorRuntime` (minus the explicit re-resolve,
 * which the chat route does itself right after).
 */
async function stopAnchorRuntime(anchorProjectId: string, manager?: any): Promise<void> {
  try {
    const { getRuntimeManager, projectWorkspaceRuntimeKey } = await import('../lib/runtime/manager')
    const mgr: any = manager ?? getRuntimeManager()
    if (typeof mgr?.stop === 'function') {
      await mgr.stop(projectWorkspaceRuntimeKey(anchorProjectId))
    }
  } catch {
    /* not running / no manager — nothing to tear down */
  }
}

/**
 * Anchor-aware runtime resolution opts for a session.
 *
 * A workspace session can be PROJECT-PINNED: its `contextId` is the anchor
 * project of an anchor-keyed merged-root runtime (the universal "every
 * project runs on the workspace runtime" path). When pinned we tell the
 * resolver the anchor (so it keys `ws:proj:<anchor>` + adds the anchor's
 * linked folders) and which attached projects are read-only. Home/workspace
 * sessions (no `contextId`) resolve the workspace-keyed runtime as before.
 */
async function anchorRuntimeOpts(
  sessionId: string,
  attached: { projectId: string; attachMode: AttachMode }[],
): Promise<{ anchorProjectId?: string; localFolders?: string[]; readonlyProjectIds?: string[] }> {
  let anchorProjectId: string | undefined
  try {
    const session = (await prisma.chatSession.findUnique({
      where: { id: sessionId },
      select: { contextId: true } as any,
    })) as { contextId?: string | null } | null
    anchorProjectId = session?.contextId ?? undefined
  } catch {
    anchorProjectId = undefined
  }
  if (!anchorProjectId) return {}

  const readonlyProjectIds = attached
    .filter((a) => a.attachMode === 'readonly')
    .map((a) => a.projectId)

  let localFolders: string[] = []
  try {
    const folders = (await prisma.projectFolder.findMany({
      where: { projectId: anchorProjectId },
      select: { path: true },
    })) as Array<{ path: string }>
    localFolders = folders.map((f) => f.path).filter((p) => typeof p === 'string' && p.length > 0)
  } catch {
    localFolders = []
  }

  return { anchorProjectId, localFolders, readonlyProjectIds }
}

/**
 * Load the runtime resolution inputs for a session: the attached project
 * ids plus the anchor-aware extras (anchor, linked folders, read-only set).
 * One call so every route resolves the same merged-root runtime.
 */
async function loadRuntimeArgs(workspaceId: string, sessionId: string): Promise<{
  attachedProjectIds: string[]
  extra: { anchorProjectId?: string; localFolders?: string[]; readonlyProjectIds?: string[] }
}> {
  const upgradedAnchorId = await upgradeProjectSessionToWorkspace(workspaceId, sessionId)
  if (upgradedAnchorId) await syncPinnedSessionAttachments(upgradedAnchorId, sessionId)
  await assertWorkspaceSessionInWorkspace(workspaceId, sessionId)
  const attached = await getAttachedProjects(sessionId)
  const attachedProjectIds = attached.map((a) => a.projectId)
  const extra = await anchorRuntimeOpts(sessionId, attached)
  return { attachedProjectIds, extra }
}

export function workspaceChatRoutes(config: WorkspaceChatRoutesConfig): Hono {
  const router = new Hono()
  const { resolveUserId, runtimeManager } = config

  /**
   * Attachment rows affect the runtime's allowed roots, which are parsed at
   * spawn time. Scope mutations are therefore not complete until the active
   * runtime has been stopped and a replacement resolves with the new args.
   */
  const refreshSessionRuntime = async (
    workspaceId: string,
    sessionId: string,
    opts: { keepAnchorRuntime?: boolean } = {},
  ) => {
    const args = await loadRuntimeArgs(workspaceId, sessionId)
    const manager: any = runtimeManager
    if (args.extra.anchorProjectId) {
      if (!opts.keepAnchorRuntime) await stopAnchorRuntime(args.extra.anchorProjectId, manager)
    } else if (typeof manager?.stopWorkspace === 'function') {
      await manager.stopWorkspace(workspaceId)
    }
    return resolveWorkspaceRuntimeUrl(workspaceId, {
      attachedProjectIds: args.attachedProjectIds,
      logTag: 'WorkspaceScopeRefresh',
      runtimeManager,
      ...args.extra,
    })
  }

  /**
   * Auth guard shared by every route: returns the userId or sends the
   * 401/403 response (caller returns it directly).
   */
  async function authorize(c: any): Promise<{ userId: string; kind: WorkspaceKind } | { res: Response }> {
    const workspaceId = c.req.param('workspaceId')
    const userId = await resolveUserId(c)
    if (!userId) {
      return { res: c.json({ error: { code: 'unauthorized', message: 'Authentication required' } }, 401) }
    }
    // Loaded together (one round-trip pair via Promise.all) since most
    // callers that need auth also end up needing `kind` a few lines later
    // (see `resolveOr501`'s `precomputedKind` param) — avoids a second
    // `getWorkspaceKind` query in the same request.
    const { hasAccess, kind } = await loadWorkspaceContext(workspaceId, userId)
    if (!hasAccess) {
      return { res: c.json({ error: { code: 'forbidden', message: 'No access to this workspace' } }, 403) }
    }
    return { userId, kind }
  }

  /**
   * Resolve the workspace runtime URL, mapping the disabled-flag case to a
   * clean 501. Returns the resolved url/mode, or `{ res }` with the 501
   * response for the caller to return directly.
   */
  async function resolveOr501(
    c: any,
    workspaceId: string,
    attachedProjectIds: string[],
    logTag: string,
    extra?: { anchorProjectId?: string; localFolders?: string[]; readonlyProjectIds?: string[] },
    /**
     * Pass `auth.kind` when the caller already ran `authorize(c)` for this
     * request — `loadWorkspaceContext` fetched it there, so re-querying it
     * here would just be a second round trip for the same answer.
     */
    precomputedKind?: WorkspaceKind,
  ): Promise<{ url: string; mode: string } | { res: Response }> {
    let workspaceKind: WorkspaceKind | undefined = precomputedKind
    if (!workspaceKind) {
      try {
        workspaceKind = await getWorkspaceKind(workspaceId)
      } catch {
        // The resolver can still return the normal feature-gate response when
        // the kind lookup is unavailable.
      }
    }
    try {
      const resolved = await resolveWorkspaceRuntimeUrl(workspaceId, {
        attachedProjectIds,
        logTag,
        runtimeManager,
        alwaysEnabled: config.alwaysEnabled,
        workspaceKind,
        ...extra,
      })
      return { url: resolved.url, mode: resolved.mode }
    } catch (err) {
      if (err instanceof WorkspaceRuntimeNotEnabledError) {
        return {
          res: c.json(
            {
              error: {
                code: 'workspace_runtime_unavailable',
                message:
                  'Workspace runtimes are not yet available in this environment. ' +
                  'Multi-project chat lands with the merged-root runtime (Phase 2b).',
              },
            },
            501,
          ),
        }
      }
      throw err
    }
  }

  /**
   * Authenticated fetch against the workspace runtime. Resolves the runtime
   * URL fresh (host `startWorkspace` dedupes) and injects the workspace
   * runtime token. Used by the resume hook + turn/stream/stop routes.
   */
  async function fetchFromWorkspaceRuntime(
    workspaceId: string,
    attachedProjectIds: string[],
    path: string,
    init?: RequestInit,
    extra?: { anchorProjectId?: string; localFolders?: string[]; readonlyProjectIds?: string[] },
  ): Promise<Response> {
    const resolved = await resolveWorkspaceRuntimeUrl(workspaceId, {
      attachedProjectIds,
      logTag: 'WorkspaceRuntime',
      runtimeManager,
      alwaysEnabled: config.alwaysEnabled,
      ...extra,
    })
    const headers = new Headers(init?.headers)
    if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
    headers.set('x-runtime-token', deriveWorkspaceRuntimeToken(workspaceId))
    return fetch(`${resolved.url}${path}`, { ...init, headers })
  }

  // Generic agent-proxy passthrough for the project-less workspace runtime
  // (today, exclusively the free personal-companion chat — see
  // build-workspace-env.ts). Mirrors `/api/projects/:projectId/agent-proxy/*`
  // in server.ts, but resolves the pod by workspaceId directly instead of
  // via a Project row, since a personal companion has none.
  //
  // Added for `GenerateImageWidget` (apps/mobile), which fetches a
  // generated image's bytes back from the pod's workspace filesystem via
  // `GET .../agent-proxy/agent/workspace/download/:path`. Before this
  // route existed, the client had no way to build a working `agentUrl` for
  // a project-less chat (`resolvedAgentUrl` in ChatPanel.tsx falls back to
  // `/api/projects/:projectId/agent-proxy`, which requires a projectId that
  // doesn't exist here) — so a successfully generated avatar image showed
  // only the "Image generated" placeholder, never the actual picture.
  router.all('/workspaces/:workspaceId/agent-proxy/*', async (c) => {
    const auth = await authorize(c)
    if ('res' in auth) return auth.res
    const workspaceId = c.req.param('workspaceId')
    const path = c.req.path.replace(`/api/workspaces/${workspaceId}/agent-proxy`, '') || '/'
    const qs = new URL(c.req.url).search

    const runtimeRes = await resolveOr501(c, workspaceId, [], 'WorkspaceAgentProxy', undefined, auth.kind)
    if ('res' in runtimeRes) return runtimeRes.res

    const headers = new Headers()
    const contentType = c.req.header('content-type')
    if (contentType) headers.set('content-type', contentType)
    headers.set('x-runtime-token', deriveWorkspaceRuntimeToken(workspaceId))

    try {
      const method = c.req.method
      const body = method === 'GET' || method === 'HEAD' ? undefined : await c.req.arrayBuffer()
      const response = await fetch(`${runtimeRes.url}${path}${qs}`, { method, headers, body })
      const responseHeaders = new Headers()
      const respContentType = response.headers.get('content-type')
      if (respContentType) responseHeaders.set('content-type', respContentType)
      const respContentLength = response.headers.get('content-length')
      if (respContentLength) responseHeaders.set('content-length', respContentLength)
      return new Response(response.body, { status: response.status, headers: responseHeaders })
    } catch (err: any) {
      console.warn(`[WorkspaceAgentProxy] proxy error for ${workspaceId}${path}:`, err?.message || err)
      return c.json({ error: { code: 'proxy_error', message: 'Failed to reach the workspace runtime' } }, 502)
    }
  })

  // List workspace-scoped chat sessions.
  router.get('/workspaces/:workspaceId/sessions', async (c) => {
    const auth = await authorize(c)
    if ('res' in auth) return auth.res
    const workspaceId = c.req.param('workspaceId')
    const kind = await getWorkspaceKind(workspaceId)
    if (kind === 'personal') {
      await getOrCreatePrimaryWorkspaceSession(workspaceId)
    }
    const sessions = await listWorkspaceSessions(workspaceId)
    return c.json({ sessions })
  })

  /**
   * Return the stable main chat for this workspace, creating it once when it
   * does not exist. Unlike the sessions list, this works for team workspaces
   * too: the agent shell always has one predictable home conversation while
   * POST /sessions continues to create side chats.
   */
  router.post('/workspaces/:workspaceId/sessions/primary', async (c) => {
    const auth = await authorize(c)
    if ('res' in auth) return auth.res

    const session = await getOrCreatePrimaryWorkspaceSession(c.req.param('workspaceId'))
    return c.json({ session })
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
        anchorProjectId: typeof body?.anchorProjectId === 'string' ? body.anchorProjectId : undefined,
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
    try {
      await assertWorkspaceSessionInWorkspace(c.req.param('workspaceId'), c.req.param('sessionId'))
    } catch (err) {
      return mapSessionError(c, err)
    }
    const attached = await getAttachedProjects(c.req.param('sessionId'))
    return c.json({ attached })
  })

  // Attach a project to a session. `pinAsAnchor` additionally pins the session
  // to that project when safe (see pinWorkspaceSessionToProject) so a chat
  // handed off to the project page runs on the runtime serving its preview;
  // the response's `pinned` tells the caller whether that happened.
  router.post('/workspaces/:workspaceId/sessions/:sessionId/projects', async (c) => {
    const auth = await authorize(c)
    if ('res' in auth) return auth.res
    const body = await c.req.json().catch(() => ({}))
    if (!body?.projectId) {
      return c.json({ error: { code: 'bad_request', message: 'projectId is required' } }, 400)
    }
    try {
      const workspaceId = c.req.param('workspaceId')
      const sessionId = c.req.param('sessionId')
      await assertWorkspaceSessionInWorkspace(workspaceId, sessionId)
      const previous = (await getAttachedProjects(sessionId)).find((item) => item.projectId === body.projectId)
      const attached = await attachProject(
        sessionId,
        body.projectId,
        (body.attachMode as AttachMode) ?? 'readwrite',
      )
      const pin = body.pinAsAnchor === true
        ? await pinWorkspaceSessionToProject(sessionId, body.projectId)
        : { pinned: false, changed: false }
      try {
        // A fresh pin means the session's only project is the anchor, which
        // its `ws:proj:` runtime (possibly already warming for the canvas)
        // mounts anyway, so there's no reason to restart it.
        await refreshSessionRuntime(workspaceId, sessionId, { keepAnchorRuntime: pin.changed })
      } catch (err) {
        // Do not leave a durable scope that the currently selected runtime
        // cannot actually mount. Restore the prior relationship on failure.
        if (pin.changed) await unpinWorkspaceSession(sessionId, body.projectId)
        if (previous) {
          await attachProject(sessionId, previous.projectId, previous.attachMode)
        } else {
          await detachProject(sessionId, body.projectId)
        }
        throw err
      }
      return c.json({ attached, pinned: pin.pinned, runtime: { ready: true } }, 201)
    } catch (err) {
      if (err instanceof WorkspaceRuntimeNotEnabledError) {
        return c.json({ error: { code: 'workspace_runtime_unavailable', message: 'Workspace runtime is unavailable' } }, 503)
      }
      return mapSessionError(c, err)
    }
  })

  // Detach a project from a session.
  router.delete('/workspaces/:workspaceId/sessions/:sessionId/projects/:projectId', async (c) => {
    const auth = await authorize(c)
    if ('res' in auth) return auth.res
    try {
      const workspaceId = c.req.param('workspaceId')
      const sessionId = c.req.param('sessionId')
      const projectId = c.req.param('projectId')
      await assertWorkspaceSessionInWorkspace(workspaceId, sessionId)
      const previous = (await getAttachedProjects(sessionId)).find((item) => item.projectId === projectId)
      const removed = await detachProject(sessionId, projectId)
      if (removed) {
        try {
          await refreshSessionRuntime(workspaceId, sessionId)
        } catch (err) {
          if (previous) await attachProject(sessionId, previous.projectId, previous.attachMode)
          throw err
        }
      }
      return c.json({ removed, runtime: { ready: true } })
    } catch (err) {
      if (err instanceof WorkspaceRuntimeNotEnabledError) {
        return c.json({ error: { code: 'workspace_runtime_unavailable', message: 'Workspace runtime is unavailable' } }, 503)
      }
      return mapSessionError(c, err)
    }
  })

  // Per-project preview URL within a workspace runtime.
  //
  // A workspace runtime serves every attached project's built app under
  // the `/p/<projectId>/` path prefix on its single port (see the
  // agent-runtime `/p/:projectId/*` routes). This resolves the running
  // workspace runtime (spawning it in host mode if needed) and returns the
  // client-facing preview URL for one attached project. Session-scoped so
  // it shares the chat session's attached-project set.
  router.get('/workspaces/:workspaceId/sessions/:sessionId/projects/:projectId/preview-url', async (c) => {
    const auth = await authorize(c)
    if ('res' in auth) return auth.res
    const workspaceId = c.req.param('workspaceId')
    const sessionId = c.req.param('sessionId')
    const projectId = c.req.param('projectId')

    let attachedProjectIds: string[]
    let runtimeExtra: { anchorProjectId?: string; localFolders?: string[]; readonlyProjectIds?: string[] } = {}
    try {
      const args = await loadRuntimeArgs(workspaceId, sessionId)
      attachedProjectIds = args.attachedProjectIds
      runtimeExtra = args.extra
    } catch (err) {
      return mapSessionError(c, err)
    }
    if (!attachedProjectIds.includes(projectId)) {
      return c.json(
        {
          error: {
            code: 'project_not_attached',
            message: `Project ${projectId} is not attached to session ${sessionId}`,
          },
        },
        404,
      )
    }

    const resolved = await resolveWorkspaceRuntimeUrl(workspaceId, {
      attachedProjectIds,
      logTag: 'WorkspacePreview',
      runtimeManager,
      ...runtimeExtra,
    })

    return c.json({
      projectId,
      mode: resolved.mode,
      runtimeUrl: resolved.url,
      // Trailing slash is canonical: the app is built with vite base
      // `/p/<projectId>/`, so its absolute asset URLs resolve under this.
      previewUrl: `${resolved.url}/p/${projectId}/`,
    })
  })

  // Runtime status for a workspace (null when not running).
  router.get('/workspaces/:workspaceId/runtime', async (c) => {
    const auth = await authorize(c)
    if ('res' in auth) return auth.res
    const mgr: any = runtimeManager
    const status =
      mgr && typeof mgr.workspaceStatus === 'function'
        ? mgr.workspaceStatus(c.req.param('workspaceId'))
        : null
    return c.json({ runtime: status })
  })

  // Tear down a workspace runtime (idempotent).
  router.delete('/workspaces/:workspaceId/runtime', async (c) => {
    const auth = await authorize(c)
    if ('res' in auth) return auth.res
    const mgr: any = runtimeManager
    if (mgr && typeof mgr.stopWorkspace === 'function') {
      await mgr.stopWorkspace(c.req.param('workspaceId'))
    }
    return c.json({ stopped: true })
  })

  // Preemptively warm a workspace runtime so the merged-root pod is being
  // claimed / cold-started while the user is still composing. The attached
  // project set (resolved from `attachProjectIds` in the body, or from a
  // `sessionId`'s attachments) drives which subfolders the runtime mounts.
  // Returns 202 immediately and resolves in the background (idempotent —
  // `startWorkspace` dedupes concurrent starts).
  router.post('/workspaces/:workspaceId/runtime/prewarm', async (c) => {
    const auth = await authorize(c)
    if ('res' in auth) return auth.res
    const workspaceId = c.req.param('workspaceId')
    const body = await c.req.json().catch(() => ({} as any))

    let attachedProjectIds: string[] = Array.isArray(body?.attachProjectIds)
      ? body.attachProjectIds.filter((x: unknown): x is string => typeof x === 'string')
      : []
    let runtimeExtra: { anchorProjectId?: string; localFolders?: string[]; readonlyProjectIds?: string[] } = {}
    if (typeof body?.sessionId === 'string' && body.sessionId) {
      try {
        const args = await loadRuntimeArgs(workspaceId, body.sessionId)
        if (attachedProjectIds.length === 0) attachedProjectIds = args.attachedProjectIds
        runtimeExtra = args.extra
      } catch {
        // Session may not exist yet / not a workspace session — warm with an
        // empty set rather than failing the (best-effort) prewarm.
      }
    }

    // Fire-and-forget: don't await so the client gets a snappy 202 and the
    // pod warms while the user keeps composing. Swallow the disabled-flag
    // case (prewarm is best-effort); log everything else.
    void resolveWorkspaceRuntimeUrl(workspaceId, {
      attachedProjectIds,
      logTag: 'WorkspacePrewarm',
      runtimeManager,
      ...runtimeExtra,
    }).catch((err) => {
      console.error(
        `[WorkspaceChat] Background prewarm failed for ${workspaceId}:`,
        err?.message ?? err,
      )
    })

    return c.json({ success: true, workspaceId, status: 'warming' }, 202)
  })

  // Proxy chat to the workspace runtime.
  //
  // Parity with project-chat.ts POST /projects/:projectId/chat: workspace
  // membership auth (above), a usage-balance gate, model-tier downgrade for
  // non-advanced plans, a per-turn billing session keyed on the billing
  // anchor project (first attached, since the AI proxy + runtime default
  // token are project-scoped), decoupled upstream streaming so a client
  // disconnect never aborts the runtime, and trackUsageFromStream for
  // persistence + server-side auto-resume + billing close. Runtime
  // resolution always uses the merged-root workspace runtime.
  router.post('/workspaces/:workspaceId/chat', async (c) => {
    const auth = await authorize(c)
    if ('res' in auth) return auth.res
    const workspaceId = c.req.param('workspaceId')

    // Usage gate (workspace-level balance) — mirrors project-chat.
    const balanceCheck = await billingService.checkUsageBalance(workspaceId)
    if (!balanceCheck.ok) {
      const { code, message } = billingService.usageLimitErrorPayload(balanceCheck.reason)
      return c.json(
        { error: { code, message } },
        402,
      )
    }

    let body = await c.req.text()
    let parsedBody: any = {}
    try {
      parsedBody = JSON.parse(body)
    } catch {
      /* not JSON, that's fine */
    }

    // chat-session id is REQUIRED. Header takes precedence, then
    // `sessionId` / `chatSessionId` in the body. The runtime keys its
    // in-memory SessionManager + durable turn buffer on this id, and the
    // billing session below is opened under it.
    const sessionId: string | null =
      c.req.header('X-Chat-Session-Id') ||
      parsedBody?.sessionId ||
      parsedBody?.chatSessionId ||
      null
    if (!sessionId || typeof sessionId !== 'string' || sessionId.trim() === '') {
      return c.json(
        {
          error: {
            code: 'chat_session_id_required',
            message:
              'sessionId is required — send it as the X-Chat-Session-Id header or as `sessionId` in the JSON body',
          },
        },
        400,
      )
    }
    // Normalize the body so the runtime reads the same session id from
    // `chatSessionId` (its durable buffer + resume key) that we billed under.
    if (parsedBody.chatSessionId !== sessionId) {
      parsedBody.chatSessionId = sessionId
      body = JSON.stringify(parsedBody)
    }

    let attachedProjectIds: string[]
    let runtimeExtra: { anchorProjectId?: string; localFolders?: string[]; readonlyProjectIds?: string[] } = {}
    try {
      const args = await loadRuntimeArgs(workspaceId, sessionId)
      attachedProjectIds = args.attachedProjectIds
      runtimeExtra = args.extra
    } catch (err) {
      return mapSessionError(c, err)
    }

    // A focused project is a per-turn hint, never a scope expansion. Reject
    // forged/stale ids before forwarding to the runtime so the signal can only
    // select from projects already attached to this chat session.
    if (parsedBody.focusedProjectId !== undefined && parsedBody.focusedProjectId !== null) {
      if (
        typeof parsedBody.focusedProjectId !== 'string' ||
        !attachedProjectIds.includes(parsedBody.focusedProjectId)
      ) {
        return c.json(
          {
            error: {
              code: 'focused_project_not_attached',
              message: 'The focused project must be attached to this workspace chat session.',
            },
          },
          400,
        )
      }
    } else {
      delete parsedBody.focusedProjectId
    }
    body = JSON.stringify(parsedBody)

    // Personal companions hide the model picker — one companion per person,
    // not a per-message user pick (see `useWorkspaceExperience`'s
    // `showModelPicker: !isPersonal`) — so the model is a platform-wide
    // super-admin choice (default: Hoshi 2.0; see
    // `lib/personal-companion-model.ts`). It overrides whatever `agentMode`
    // the client sent and is intentionally exempt from the
    // advanced-model-access tier gate below: that gate exists to stop a user
    // from picking an expensive model their plan doesn't cover, which
    // doesn't apply to an explicit admin decision (same reasoning as the
    // title-generation model override, which also ignores plan tier).
    if (auth.kind === 'personal') {
      parsedBody.agentMode = getPersonalCompanionModelId()
      stampModelProvider(parsedBody)
      body = JSON.stringify(parsedBody)
    } else if (parsedBody.agentMode) {
      // Model-tier guard: downgrade non-economy models for workspaces without
      // advanced access (server-side enforcement, same as project chat).
      const resolvedModel = resolveModelId(parsedBody.agentMode)
      if (getModelTier(resolvedModel) !== 'economy') {
        if (!(await billingService.hasAdvancedModelAccess(workspaceId))) {
          parsedBody.agentMode = 'claude-haiku-4-5-20251001'
        }
      }
      // Resolve the model's native provider from the registry and stamp it on
      // the forwarded body (after any tier-downgrade) so a UUID-addressed DB
      // model routes natively instead of being inferred as `custom`.
      stampModelProvider(parsedBody)
      body = JSON.stringify(parsedBody)
    }

    // Harden "@" references before forwarding to the runtime:
    //  - workspace refs: re-derive the summary from the DB after membership;
    //  - project refs: access-check, then DURABLY attach any newly-referenced
    //    same-workspace sibling to this chat's anchor so the merged-root runtime
    //    mounts it (and WORKSPACE.md tells the agent it owns it). New
    //    attachments are env-coupled (LINKED_FOLDERS is parsed once at boot), so
    //    the anchor runtime is restarted before we resolve; refs that are
    //    already attached are a no-op and stay warm.
    if (Array.isArray(parsedBody?.references) && parsedBody.references.length > 0) {
      const wsChanged = await enrichWorkspaceReferences(parsedBody, auth.userId)
      const projectRefs = await enrichProjectReferences(parsedBody, auth.userId, workspaceId)
      const anchorProjectId = runtimeExtra.anchorProjectId
      const historyChanged = await enrichChatReferences(
        parsedBody,
        auth.userId,
        anchorProjectId,
        workspaceId,
      )
      if (anchorProjectId && projectRefs.attachProjectIds.length > 0) {
        const alreadyAttached = new Set(attachedProjectIds)
        const newIds = projectRefs.attachProjectIds.filter(
          (id) => id !== anchorProjectId && !alreadyAttached.has(id),
        )
        if (newIds.length > 0) {
          try {
            for (const id of newIds) {
              await attachProjectToProject(anchorProjectId, id, 'readwrite')
            }
            // attachProjectToProject only syncs the anchor's pinned session;
            // reconcile THIS session too so loadRuntimeArgs picks up the members.
            await syncPinnedSessionAttachments(anchorProjectId, sessionId)
            // Restart so the new members are admitted as allowed roots, then
            // re-read the (now larger) attached set for the resolve below.
            await stopAnchorRuntime(anchorProjectId, runtimeManager)
            const reload = await loadRuntimeArgs(workspaceId, sessionId)
            attachedProjectIds = reload.attachedProjectIds
            runtimeExtra = reload.extra
          } catch (err: any) {
            console.warn(
              `[WorkspaceChat] attach-on-mention failed for anchor ${anchorProjectId}:`,
              err?.message ?? err,
            )
          }
        }
      }
      if (wsChanged || projectRefs.changed || historyChanged) body = JSON.stringify(parsedBody)
    }

    // Billing anchor: the AI proxy accumulates usage keyed by projectId, and
    // build-workspace-env mints the first attached project's token as the
    // runtime's default AI_PROXY_TOKEN, so we anchor billing on the first
    // attached project. Computed AFTER attach-on-mention so a freshly-attached
    // member is reflected. Per-call multi-project attribution is Phase 2b.
    const billingProjectId: string | null = attachedProjectIds[0] ?? null

    // Resolve the unconditional merged-root workspace runtime.
    const runtimeRes = await resolveOr501(c, workspaceId, attachedProjectIds, 'WorkspaceChat', runtimeExtra, auth.kind)
    if ('res' in runtimeRes) return runtimeRes.res
    let podUrl = runtimeRes.url

    // The caller already passed hasWorkspaceAccess, so attribute billing +
    // Composio identity to the authenticated user.
    const billingUserId =
      parsedBody?.userId || c.req.header('X-Billing-User-Id') || auth.userId
    if (billingProjectId && billingUserId && billingUserId !== 'system') {
      setProjectUser(billingProjectId, billingUserId)
    }

    // Open the billing session (anchor project) so the AI proxy accumulates
    // tokens across the agentic loop instead of charging per-call. Only when
    // we have an anchor project; a zero-attachment session degrades to a bare
    // proxy. trackUsageFromStream closes the session after the stream ends;
    // the finally guard closes an orphaned session on early exit.
    // trackUsageFromStream owns the stream (persistence, billing close when
    // anchored, active-turn end) once handed off, with or without a project.
    let streamHandedOff = false
    if (billingProjectId) {
      await openSession(billingProjectId, workspaceId, billingUserId || 'system', sessionId)
    }
    let activityTurnId: string | null = null
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      headers['x-runtime-token'] = deriveWorkspaceRuntimeToken(workspaceId)

      const authHeader = c.req.header('Authorization')
      if (authHeader) headers['Authorization'] = authHeader
      const sessHeader = c.req.header('X-Session-Id')
      if (sessHeader) headers['X-Session-Id'] = sessHeader
      if (billingUserId && billingUserId !== 'system') {
        headers['X-Billing-User-Id'] = billingUserId
      }
      // The caller passed workspace membership above, so X-User-Id is trusted.
      headers['X-User-Id'] = auth.userId
      // Runtime keys its durable-turn + billing state on the chat session id.
      headers['x-chat-session-id'] = sessionId

      const MAX_RETRIES = 30
      const BASE_DELAY_MS = 500
      const MAX_DELAY_MS = 4000
      const FETCH_TIMEOUT_MS = parseInt(
        process.env.CHAT_UPSTREAM_FETCH_TIMEOUT_MS || '14400000',
        10,
      )
      // A client disconnect must NOT abort the upstream fetch — the runtime
      // keeps the agent running so the client can resume, and
      // trackUsageFromStream needs the full stream for billing/persistence.
      const clientSignal = c.req.raw.signal
      const fetchSignal = AbortSignal.timeout(FETCH_TIMEOUT_MS)
      let lastError: Error | null = null

      for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        if (clientSignal?.aborted) {
          return new Response(null, { status: 499 })
        }
        try {
          const upstream = await fetch(`${podUrl}/agent/chat`, {
            method: 'POST',
            headers,
            body,
            signal: fetchSignal,
          })

          if (!upstream.ok) {
            const errorText = await upstream.text()
            console.error(
              `[WorkspaceChat] Runtime returned error: ${upstream.status} ${errorText}`,
            )
            const isTransient =
              upstream.status === 401 ||
              upstream.status === 403 ||
              upstream.status === 404 ||
              upstream.status >= 500
            if (isTransient && attempt < MAX_RETRIES) {
              const delay = Math.min(BASE_DELAY_MS * Math.pow(2, attempt - 1), MAX_DELAY_MS)
              await new Promise((r) => setTimeout(r, delay))
              // Re-resolve in case the runtime port/host changed mid-retry.
              try {
                const refreshed = await resolveWorkspaceRuntimeUrl(workspaceId, {
                  attachedProjectIds,
                  logTag: 'WorkspaceChat',
                  runtimeManager,
                  ...runtimeExtra,
                })
                podUrl = refreshed.url
              } catch {
                /* keep old url */
              }
              continue
            }
            return c.json(
              {
                error: {
                  code: 'runtime_error',
                  message: `Runtime error: ${upstream.status}`,
                  detail: errorText.slice(0, 200),
                },
              },
              upstream.status as any,
            )
          }

          // Copy response headers (minus hop-by-hop), add CORS + expose the
          // turn-ledger headers so the browser can read them cross-origin.
          const responseHeaders = new Headers()
          upstream.headers.forEach((value, key) => {
            if (
              !['content-length', 'transfer-encoding', 'connection'].includes(key.toLowerCase())
            ) {
              responseHeaders.set(key, value)
            }
          })
          responseHeaders.set('Access-Control-Allow-Origin', '*')
          responseHeaders.set('Access-Control-Allow-Methods', 'POST, OPTIONS')
          responseHeaders.set(
            'Access-Control-Allow-Headers',
            'Content-Type, Authorization, X-Session-Id',
          )
          responseHeaders.set(
            'Access-Control-Expose-Headers',
            'X-Turn-Id, X-Chat-Session-Id, X-Last-Seq, X-Turn-Status',
          )

          if (!upstream.body) {
            return new Response(null, { status: upstream.status, headers: responseHeaders })
          }

          try {
            activityTurnId = await markTurnStarted(sessionId)
          } catch (error) {
            // Activity is observational; a schema/database issue must not block chat.
            console.warn(`[WorkspaceChat] Failed to mark active chat ${sessionId}:`, error)
          }

          // Decoupled fan-out (same pattern as project-chat): read the
          // upstream body in a background loop and independently push chunks
          // to both the client stream and a tracking queue, so billing +
          // persistence always see the full stream even if the client drops.
          const bgReader = upstream.body.getReader()
          const trackingChunks: Uint8Array[] = []
          let trackingDone = false
          let trackingNotify: (() => void) | null = null
          const trackingWait = () =>
            new Promise<void>((res) => {
              trackingNotify = res
            })
          const trackingStream = new ReadableStream<Uint8Array>({
            async pull(controller) {
              while (trackingChunks.length === 0 && !trackingDone) {
                await trackingWait()
              }
              if (trackingChunks.length > 0) {
                controller.enqueue(trackingChunks.shift()!)
                return
              }
              controller.close()
            },
            cancel() {
              trackingDone = true
              trackingNotify?.()
              trackingNotify = null
            },
          })

          const clientStream = new ReadableStream<Uint8Array>({
            start(controller) {
              const keepaliveChunk = new TextEncoder().encode(': proxy-keep-alive\n\n')
              const proxyKeepalive = setInterval(() => {
                try {
                  controller.enqueue(keepaliveChunk)
                } catch {
                  clearInterval(proxyKeepalive)
                }
              }, 15_000)
              ;(async () => {
                try {
                  while (true) {
                    const { done, value } = await bgReader.read()
                    if (done) break
                    trackingChunks.push(value)
                    trackingNotify?.()
                    trackingNotify = null
                    try {
                      controller.enqueue(value)
                    } catch {
                      /* client gone — stream continues for tracking */
                    }
                  }
                } catch (err: any) {
                  try {
                    controller.error(err)
                  } catch {
                    /* client gone */
                  }
                } finally {
                  clearInterval(proxyKeepalive)
                  trackingDone = true
                  trackingNotify?.()
                  trackingNotify = null
                  try {
                    controller.close()
                  } catch {
                    /* already closed */
                  }
                }
              })()
            },
          })

          // trackUsageFromStream owns persistence (+ tool-call logging) always,
          // and additionally billing close + auto-checkpoint when there's an
          // anchor project. Workspace-scoped chats with nothing attached yet
          // (e.g. a brand-new personal companion space) pass `project: null`
          // — there's no billing session to close and no project workspace
          // to checkpoint, but the assistant's reply must still be saved so
          // chat history survives a page reload. See the doc comment on
          // `trackUsageFromStream` in project-chat.ts.
          streamHandedOff = true
          const turnId = activityTurnId
          const stopTurnHeartbeat = turnId ? startTurnHeartbeat(sessionId, turnId) : null
          trackUsageFromStream(
            trackingStream,
            parsedBody,
            billingProjectId ? { id: billingProjectId, workspaceId } : null,
            {
              chatSessionId: sessionId,
              userId: billingUserId && billingUserId !== 'system' ? billingUserId : undefined,
              projectName: 'Workspace project',
              resume: async (fromSeq) => {
                try {
                  return await fetchFromWorkspaceRuntime(
                    workspaceId,
                    attachedProjectIds,
                    `/agent/chat/${encodeURIComponent(sessionId)}/stream?fromSeq=${fromSeq}`,
                    { method: 'GET' },
                    runtimeExtra,
                  )
                } catch (err: any) {
                  console.warn(
                    `[WorkspaceChat] Resume fetch failed for ${workspaceId}/${sessionId}:`,
                    err?.message || err,
                  )
                  return null
                }
              },
            },
          ).catch((err) => console.error('[WorkspaceChat] Usage tracking error:', err)).finally(() => {
            stopTurnHeartbeat?.()
            if (turnId) {
              markTurnEnded(sessionId, turnId).catch((error) =>
                console.warn(`[WorkspaceChat] Failed to clear active chat ${sessionId}:`, error),
              )
            }
          })

          // Multi-project auto-checkpoint for the NON-anchor attached projects
          // (the anchor is checkpointed by trackUsageFromStream). Best-effort,
          // fires on clean client-stream close.
          const checkpointTargets = attachedProjectIds.filter((id) => id !== billingProjectId)
          let outBody: ReadableStream<Uint8Array> = clientStream
          if (checkpointTargets.length > 0) {
            const checkpointWatcher = new TransformStream<Uint8Array, Uint8Array>({
              flush() {
                autoCheckpointWorkspaceProjects(checkpointTargets, {
                  workspacesDir: WORKSPACES_DIR,
                  message: `AI: workspace turn (session ${sessionId.slice(0, 8)})`,
                }).catch((err) =>
                  console.warn(
                    '[WorkspaceChat] Auto-checkpoint failed (non-blocking):',
                    err?.message ?? err,
                  ),
                )
              },
            })
            outBody = clientStream.pipeThrough(checkpointWatcher)
          }

          return new Response(outBody, { status: upstream.status, headers: responseHeaders })
        } catch (fetchError: any) {
          lastError = fetchError
          const isClientAbort = fetchError.name === 'AbortError' && clientSignal?.aborted
          if (isClientAbort) return new Response(null, { status: 499 })

          const isTransient =
            fetchError.code === 'ECONNREFUSED' ||
            fetchError.code === 'ECONNRESET' ||
            fetchError.code === 'ETIMEDOUT' ||
            fetchError.cause?.code === 'ECONNREFUSED' ||
            fetchError.cause?.code === 'ECONNRESET' ||
            fetchError.cause?.code === 'ETIMEDOUT' ||
            fetchError.name === 'TimeoutError'
          if (isTransient && attempt < MAX_RETRIES) {
            const delay = Math.min(BASE_DELAY_MS * Math.pow(2, attempt - 1), MAX_DELAY_MS)
            try {
              const refreshed = await resolveWorkspaceRuntimeUrl(workspaceId, {
                attachedProjectIds,
                logTag: 'WorkspaceChat',
                runtimeManager,
                ...runtimeExtra,
              })
              podUrl = refreshed.url
            } catch {
              /* keep old url */
            }
            await new Promise((r) => setTimeout(r, delay))
            continue
          }
          throw fetchError
        }
      }

      return c.json(
        { error: { code: 'proxy_error', message: lastError?.message || 'Max retries exceeded' } },
        503,
      )
    } catch (error: any) {
      console.error('[WorkspaceChat] Proxy error:', error)
      return c.json(
        { error: { code: 'proxy_error', message: error.message || 'Proxy failed' } },
        500,
      )
    } finally {
      // Guard: close the billing session if trackUsageFromStream never took
      // ownership (retry exhaustion, client disconnect, thrown error).
      if (billingProjectId && !streamHandedOff) {
        closeSession(billingProjectId, { chatSessionId: sessionId }).catch((err: any) =>
          console.error(
            `[WorkspaceChat] Failed to close orphaned billing session for ${billingProjectId}:`,
            err,
          ),
        )
      }
      if (activityTurnId && !streamHandedOff) {
        markTurnEnded(sessionId, activityTurnId).catch((error) =>
          console.warn(`[WorkspaceChat] Failed to clear abandoned active chat ${sessionId}:`, error),
        )
      }
    }
  })

  // Resume an active workspace turn stream (AI SDK resume URL pattern:
  // ${chatPostUrl}/${sessionId}/stream). Optional ?fromSeq=N for delta replay.
  router.get('/workspaces/:workspaceId/chat/:sessionId/stream', async (c) => {
    const auth = await authorize(c)
    if ('res' in auth) return auth.res
    const workspaceId = c.req.param('workspaceId')
    const sessionId = c.req.param('sessionId')
    const fromSeq = c.req.query('fromSeq')

    let attachedProjectIds: string[]
    let runtimeExtra: { anchorProjectId?: string; localFolders?: string[]; readonlyProjectIds?: string[] } = {}
    try {
      const args = await loadRuntimeArgs(workspaceId, sessionId)
      attachedProjectIds = args.attachedProjectIds
      runtimeExtra = args.extra
    } catch (err) {
      return mapSessionError(c, err)
    }
    const runtimeRes = await resolveOr501(c, workspaceId, attachedProjectIds, 'WorkspaceResume', runtimeExtra, auth.kind)
    if ('res' in runtimeRes) return runtimeRes.res

    const runtimePath =
      fromSeq !== undefined && fromSeq !== ''
        ? `/agent/chat/${encodeURIComponent(sessionId)}/stream?fromSeq=${encodeURIComponent(fromSeq)}`
        : `/agent/chat/${encodeURIComponent(sessionId)}/stream`
    try {
      const response = await fetchFromWorkspaceRuntime(workspaceId, attachedProjectIds, runtimePath, {
        method: 'GET',
      }, runtimeExtra)
      if (response.status === 204 || !response.body) {
        return new Response(null, { status: 204 })
      }
      const responseHeaders = new Headers()
      response.headers.forEach((value, key) => {
        if (!['content-length', 'transfer-encoding', 'connection'].includes(key.toLowerCase())) {
          responseHeaders.set(key, value)
        }
      })
      responseHeaders.set('Access-Control-Allow-Origin', '*')
      responseHeaders.set('Access-Control-Expose-Headers', 'X-Turn-Id, X-Last-Seq, X-Turn-Status')
      responseHeaders.set('X-Accel-Buffering', 'no')
      return new Response(response.body, { status: response.status, headers: responseHeaders })
    } catch (err: any) {
      console.warn(
        `[WorkspaceChat] resume proxy error for ${workspaceId}/${sessionId}:`,
        err?.message || err,
      )
      return new Response(null, { status: 204 })
    }
  })

  // Read-only durable turn snapshot (poll without opening a stream).
  router.get('/workspaces/:workspaceId/chat/:sessionId/turn', async (c) => {
    const auth = await authorize(c)
    if ('res' in auth) return auth.res
    const workspaceId = c.req.param('workspaceId')
    const sessionId = c.req.param('sessionId')

    let attachedProjectIds: string[]
    let runtimeExtra: { anchorProjectId?: string; localFolders?: string[]; readonlyProjectIds?: string[] } = {}
    try {
      const args = await loadRuntimeArgs(workspaceId, sessionId)
      attachedProjectIds = args.attachedProjectIds
      runtimeExtra = args.extra
    } catch (err) {
      return mapSessionError(c, err)
    }
    const runtimeRes = await resolveOr501(c, workspaceId, attachedProjectIds, 'WorkspaceTurn', runtimeExtra, auth.kind)
    if ('res' in runtimeRes) return runtimeRes.res
    try {
      const response = await fetchFromWorkspaceRuntime(
        workspaceId,
        attachedProjectIds,
        `/agent/chat/${encodeURIComponent(sessionId)}/turn`,
        { method: 'GET' },
        runtimeExtra,
      )
      if (response.status === 404) return c.json({ status: 'unknown' as const }, 404)
      const data = await response.json()
      return c.json(data, response.status as any)
    } catch (err: any) {
      console.warn(
        `[WorkspaceChat] turn snapshot proxy error for ${workspaceId}/${sessionId}:`,
        err?.message || err,
      )
      return c.json({ status: 'unknown' as const }, 404)
    }
  })

  // Stop/interrupt active generation on the workspace runtime.
  router.post('/workspaces/:workspaceId/chat/stop', async (c) => {
    const auth = await authorize(c)
    if ('res' in auth) return auth.res
    const workspaceId = c.req.param('workspaceId')

    const body = await c.req.text()
    let parsed: any = {}
    try {
      parsed = JSON.parse(body || '{}')
    } catch {
      /* noop */
    }
    // sessionId resolves the attached project set for runtime resolution.
    const sessionId: string | undefined =
      c.req.header('X-Chat-Session-Id') || parsed?.sessionId || parsed?.chatSessionId
    let attachedProjectIds: string[] = []
    let runtimeExtra: { anchorProjectId?: string; localFolders?: string[]; readonlyProjectIds?: string[] } = {}
    if (sessionId) {
      try {
        const args = await loadRuntimeArgs(workspaceId, sessionId)
        attachedProjectIds = args.attachedProjectIds
        runtimeExtra = args.extra
      } catch {
        /* noop */
      }
    }
    const runtimeRes = await resolveOr501(c, workspaceId, attachedProjectIds, 'WorkspaceStop', runtimeExtra, auth.kind)
    if ('res' in runtimeRes) return runtimeRes.res
    try {
      const response = await fetchFromWorkspaceRuntime(workspaceId, attachedProjectIds, '/agent/stop', {
        method: 'POST',
        body: body || '{}',
      }, runtimeExtra)
      const result = await response.json()
      if (sessionId && response.ok) {
        await clearActiveTurn({
          id: sessionId,
          OR: [{ workspaceId }, { project: { workspaceId } }],
        }).catch((error) =>
          console.warn(`[WorkspaceChat] Failed to clear stopped chat ${sessionId}:`, error),
        )
      }
      return c.json(result)
    } catch (error: any) {
      console.error('[WorkspaceChat] Stop error:', error)
      return c.json({ success: false, error: error.message }, 500)
    }
  })

  return router
}
