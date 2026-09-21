// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { Hono } from 'hono'
import { prisma } from '../lib/prisma'
import * as workspaceService from '../services/workspace.service'
import * as workspaceModelsService from '../services/workspace-models.service'
import { resolvePlatformVisibleModels } from '../services/visible-models.service'

function authUserId(c: any): string | null {
  const auth = c.get('auth') as { userId?: string; isAuthenticated?: boolean } | undefined
  return auth?.isAuthenticated && auth.userId ? auth.userId : null
}

async function hasMembership(userId: string, workspaceId: string): Promise<boolean> {
  const member = await prisma.member.findFirst({ where: { userId, workspaceId } })
  return !!member
}

/**
 * Local workspace operations that the desktop workspace picker and model
 * picker use. Billing, instance provisioning, metrics, and storage remain
 * cloud-only and are intentionally not mounted here.
 */
export function localWorkspaceRoutes(): Hono {
  const router = new Hono()

  router.get('/workspaces/:id/visible-models', async (c) => {
    const userId = authUserId(c)
    const workspaceId = c.req.param('id')
    if (!userId || !(await hasMembership(userId, workspaceId))) {
      return c.json({ error: { code: 'forbidden', message: 'Access denied' } }, 403)
    }
    try {
      const platform = await resolvePlatformVisibleModels()
      const allowed = await workspaceModelsService.getAllowedModelIds(workspaceId)
      if (allowed === null) return c.json({ ...platform, allowedModelIds: null })
      const narrowed = workspaceModelsService.filterToAllowlist(platform, allowed)
      return c.json({
        catalogIds: platform.catalogIds,
        catalogModels: narrowed.catalogModels,
        openrouterModels: narrowed.openrouterModels,
        allowedModelIds: Array.from(allowed),
      })
    } catch (error: any) {
      return c.json({
        error: { code: 'internal_error', message: error?.message || 'Unable to load models' },
      }, 500)
    }
  })

  router.put('/workspaces/:id/visible-models', async (c) => {
    const userId = authUserId(c)
    const workspaceId = c.req.param('id')
    if (!userId || !(await hasMembership(userId, workspaceId))) {
      return c.json({ error: { code: 'forbidden', message: 'Access denied' } }, 403)
    }
    const admin = await prisma.member.findFirst({
      where: { userId, workspaceId, role: { in: ['owner', 'admin'] } },
    })
    if (!admin) {
      return c.json({ error: { code: 'forbidden', message: 'Workspace admin access required' } }, 403)
    }

    const body = await c.req.json().catch(() => ({} as any))
    const rawIds = Array.isArray(body?.allowedModelIds)
      ? body.allowedModelIds.filter((id: unknown): id is string => typeof id === 'string')
      : []
    if (rawIds.length === 0) {
      await workspaceModelsService.setAllowedModelIds(workspaceId, [], userId)
      return c.json({ ok: true, allowedModelIds: null })
    }

    const platform = await resolvePlatformVisibleModels()
    const invalid = workspaceModelsService.modelsOutsidePlatform(rawIds, platform)
    if (invalid.length > 0) {
      return c.json({
        error: {
          code: 'invalid_models',
          message: `These models are not in the platform-visible set: ${invalid.join(', ')}`,
        },
      }, 400)
    }
    await workspaceModelsService.setAllowedModelIds(workspaceId, rawIds, userId)
    return c.json({ ok: true, allowedModelIds: rawIds })
  })

  router.post('/workspaces/:id/leave', async (c) => {
    const userId = authUserId(c)
    const workspaceId = c.req.param('id')
    if (!userId) return c.json({ error: 'Unauthorized' }, 401)
    const memberships = await prisma.member.findMany({ where: { userId, workspaceId } })
    if (memberships.length === 0) {
      return c.json({ error: { code: 'not_found', message: 'You are not a member of this workspace.' } }, 404)
    }
    const workspaceMembership = memberships.find((member) => !member.projectId) || memberships[0]
    if (workspaceMembership.role === 'owner') {
      const otherOwners = await prisma.member.count({
        where: { workspaceId, role: 'owner', userId: { not: userId }, projectId: null },
      })
      if (otherOwners === 0) {
        return c.json({
          error: {
            code: 'last_owner',
            message: 'You are the only owner. Transfer ownership to another member before leaving.',
          },
        }, 400)
      }
    }
    await prisma.member.deleteMany({ where: { userId, workspaceId } })
    return c.json({ ok: true })
  })

  router.post('/workspaces/personal', async (c) => {
    const userId = authUserId(c)
    if (!userId) {
      return c.json({ error: { code: 'unauthorized', message: 'Authentication required' } }, 401)
    }
    try {
      if (await workspaceService.hasPersonalWorkspace(userId)) {
        return c.json({
          error: { code: 'personal_workspace_exists', message: 'You already have a personal workspace.' },
        }, 409)
      }
      const user = await prisma.user.findUnique({ where: { id: userId }, select: { name: true } })
      const result = await workspaceService.createPersonalWorkspace(userId, user?.name || 'User')
      return c.json({ ok: true, workspace: result.workspace, member: result.member })
    } catch (error: any) {
      return c.json({
        error: {
          code: 'create_personal_workspace_failed',
          message: error?.message || 'Unable to create personal workspace',
        },
      }, 500)
    }
  })

  return router
}
