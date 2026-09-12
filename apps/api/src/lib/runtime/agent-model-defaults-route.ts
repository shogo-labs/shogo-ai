// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import type { Context } from 'hono'
import type { AuthContext } from '../../middleware/auth'
import { prisma } from '../prisma'
import { resolveEffectiveAgentModelDefaults } from './agent-model-defaults'

type RouteError = {
  status: 401 | 403 | 404
  body: { error: { code: string; message: string } }
}

type WorkspaceResolution = { workspaceId: string } | RouteError
type DefaultsResolver = (workspaceId: string) => Promise<Awaited<ReturnType<typeof resolveEffectiveAgentModelDefaults>>>
type WorkspaceResolver = (auth: AuthContext, requestedWorkspaceId?: string) => Promise<WorkspaceResolution>

/**
 * Cloud-facing endpoint handler for the model defaults consumed by local
 * runtimes. The global API auth middleware has already resolved the API key
 * or session into `c.get('auth')` before this handler runs.
 */
async function resolveWorkspaceForAuth(
  auth: AuthContext,
  requestedWorkspaceId?: string,
): Promise<WorkspaceResolution> {
  // API-key callers already carry an unambiguous workspace. Session and
  // tunnel callers do not, so honor an explicitly requested workspace after
  // verifying membership; otherwise use the user's earliest workspace,
  // matching the existing API-key minting behavior.
  let workspaceId: string | undefined = auth.workspaceId ?? undefined
  if (requestedWorkspaceId) {
    if (workspaceId && workspaceId !== requestedWorkspaceId) {
      return {
        status: 403,
        body: { error: { code: 'forbidden', message: 'Workspace does not match the authenticated key' } },
      }
    }
    if (!auth.userId) {
      return {
        status: 401,
        body: { error: { code: 'unauthorized', message: 'Authentication required' } },
      }
    }
    const member = await prisma.member.findFirst({
      where: { userId: auth.userId, workspaceId: requestedWorkspaceId },
      select: { workspaceId: true },
    })
    if (!member) {
      return {
        status: 403,
        body: { error: { code: 'forbidden', message: 'Not a member of this workspace' } },
      }
    }
    workspaceId = member.workspaceId ?? undefined
  } else if (!workspaceId && auth.userId) {
    const member = await prisma.member.findFirst({
      where: { userId: auth.userId },
      orderBy: { createdAt: 'asc' },
      select: { workspaceId: true },
    })
    workspaceId = member?.workspaceId ?? undefined
  }

  return workspaceId
    ? { workspaceId }
    : {
        status: 404,
        body: { error: { code: 'no_workspace', message: 'User has no workspace' } },
      }
}

export function createAgentModelDefaultsRoute(
  resolveDefaults: DefaultsResolver = resolveEffectiveAgentModelDefaults,
  resolveWorkspace: WorkspaceResolver = resolveWorkspaceForAuth,
) {
  return async function agentModelDefaultsRoute(c: Context): Promise<Response> {
    try {
      const auth = c.get('auth') as AuthContext | undefined
      if (!auth?.isAuthenticated) {
        return c.json({ error: { code: 'unauthorized', message: 'Authentication required' } }, 401)
      }

      const resolution = await resolveWorkspace(auth, c.req.query('workspaceId')?.trim())
      if (!('workspaceId' in resolution)) {
        return c.json(resolution.body, resolution.status)
      }
      return c.json(await resolveDefaults(resolution.workspaceId))
    } catch (err: any) {
      console.error('[AgentModels] Failed to resolve cloud defaults:', err?.message || err)
      return c.json({ error: { code: 'internal_error', message: 'Unable to resolve agent model defaults' } }, 500)
    }
  }
}

export const agentModelDefaultsRoute = createAgentModelDefaultsRoute()
