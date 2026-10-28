// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { Hono } from 'hono'
import { prisma } from '../lib/prisma'
import * as workspaceService from '../services/workspace.service'
import * as workspaceModelsService from '../services/workspace-models.service'
import { resolvePlatformVisibleModelsForRequest } from '../services/visible-models.service'
import {
  removeWorkspaceFiles,
  resolveWorkspacesDir,
  workspaceFileInventory,
} from '../services/workspace-files.service'
import { deleteConversationFile } from '../lib/conversation-files'

function authUserId(c: any): string | null {
  const auth = c.get('auth') as { userId?: string; isAuthenticated?: boolean } | undefined
  return auth?.isAuthenticated && auth.userId ? auth.userId : null
}

async function hasMembership(userId: string, workspaceId: string): Promise<boolean> {
  const member = await prisma.member.findFirst({ where: { userId, workspaceId, projectId: null } })
  return !!member
}

async function workspaceRole(userId: string, workspaceId: string): Promise<string | null> {
  const member = await prisma.member.findFirst({
    where: { userId, workspaceId, projectId: null },
    select: { role: true },
  })
  return member?.role ?? null
}

const MAX_WORKSPACE_NAME_LENGTH = 60

/**
 * The one place a local workspace name is validated. Returns the trimmed name,
 * or the `invalid_name` error the modal shows verbatim instead of a generic
 * "Failed to create workspace".
 */
function parseWorkspaceName(
  raw: unknown,
): { ok: true; name: string } | { ok: false; error: { code: string; message: string } } {
  const name = typeof raw === 'string' ? raw.trim() : ''
  if (!name) {
    return { ok: false, error: { code: 'invalid_name', message: 'Give your workspace a name.' } }
  }
  if (name.length > MAX_WORKSPACE_NAME_LENGTH) {
    return {
      ok: false,
      error: {
        code: 'invalid_name',
        message: `Workspace names can be at most ${MAX_WORKSPACE_NAME_LENGTH} characters.`,
      },
    }
  }
  return { ok: true, name }
}

export interface LocalWorkspaceRouteOptions {
  /** Needed to tear down every runtime a deleted workspace owns. */
  runtimeManager?: {
    stopWorkspace?: (workspaceId: string) => Promise<void>
    stop?: (projectId: string, reason?: string) => Promise<void>
    workspaceActivity?: (workspaceId: string) => Promise<{ running: boolean; inFlight: boolean }>
  }
  workspacesDir?: string
}

/**
 * Local workspace operations that the desktop workspace picker and model
 * picker use. Billing, instance provisioning, metrics, and storage remain
 * cloud-only and are intentionally not mounted here.
 *
 * Local mode has no billing, so the plan limit that gates `POST /api/workspaces`
 * in the cloud does not apply (Unlimited — Russell, 2026-10-19). Every other
 * rule does: one owner, one agent profile, `kind` immutable, no deleting your
 * last workspace or the companion personal one, and a delete that removes the
 * workspace's files (see `workspace-files.service.ts`).
 */
export function localWorkspaceRoutes(options: LocalWorkspaceRouteOptions = {}): Hono {
  const workspacesDir = resolveWorkspacesDir(options.workspacesDir)

  const router = new Hono()

  /**
   * Which local workspaces have a runtime up, and whether it is mid-turn.
   * Polled by the switcher so "switching away keeps agents running" is
   * visible instead of looking like the work vanished.
   */
  router.get('/workspaces/activity', async (c) => {
    const userId = authUserId(c)
    if (!userId) {
      return c.json({ error: { code: 'unauthorized', message: 'Authentication required' } }, 401)
    }
    const memberships = await prisma.member.findMany({
      where: { userId, projectId: null, workspaceId: { not: null } },
      select: { workspaceId: true },
    })
    const ids = memberships
      .map((m) => m.workspaceId)
      .filter((id): id is string => typeof id === 'string')
    const items = await Promise.all(
      ids.map(async (workspaceId) => {
        const activity = options.runtimeManager?.workspaceActivity
          ? await options.runtimeManager.workspaceActivity(workspaceId).catch(() => null)
          : null
        return {
          workspaceId,
          running: !!activity?.running,
          inFlight: !!activity?.inFlight,
        }
      }),
    )
    return c.json({ ok: true, items })
  })

  /**
   * What a delete would destroy. Read-only — the confirm dialog renders this so
   * the user sees the project directories and byte total before typing the name.
   */
  router.get('/workspaces/:id/deletion-preview', async (c) => {
    const userId = authUserId(c)
    if (!userId) {
      return c.json({ error: { code: 'unauthorized', message: 'Authentication required' } }, 401)
    }
    const workspaceId = c.req.param('id')
    if (!(await hasMembership(userId, workspaceId))) {
      return c.json({ error: { code: 'forbidden', message: 'Access denied' } }, 403)
    }
    const inventory = await workspaceFileInventory(workspaceId, { workspacesDir, prisma })
    if (!inventory) {
      return c.json({ error: { code: 'not_found', message: 'Workspace not found' } }, 404)
    }
    return c.json({ ok: true, preview: inventory })
  })

  router.post('/workspaces', async (c) => {
    const userId = authUserId(c)
    if (!userId) {
      return c.json({ error: { code: 'unauthorized', message: 'Authentication required' } }, 401)
    }
    const body = await c.req.json().catch(() => ({} as any))
    const parsed = parseWorkspaceName(body?.name)
    if (!parsed.ok) return c.json({ error: parsed.error }, 400)
    if (body?.kind && body.kind !== 'team') {
      return c.json(
        {
          error: {
            code: 'personal_workspace_exists',
            message:
              body.kind === 'personal'
                ? 'You already have a personal workspace. New workspaces are team workspaces.'
                : 'Workspaces created here are team workspaces.',
          },
        },
        409,
      )
    }
    try {
      const created = await workspaceService.createLocalWorkspace(userId, parsed.name)
      const workspace = await prisma.workspace.findUnique({ where: { id: created.workspace.id } })
      return c.json({ ok: true, data: workspace ?? created.workspace }, 201)
    } catch (error: any) {
      console.error('[Workspace] Local create failed:', error)
      return c.json(
        {
          error: {
            code: 'create_failed',
            message: error?.message || 'Unable to create workspace',
          },
        },
        500,
      )
    }
  })

  router.patch('/workspaces/:id', async (c) => {
    const userId = authUserId(c)
    if (!userId) {
      return c.json({ error: { code: 'unauthorized', message: 'Authentication required' } }, 401)
    }
    const workspaceId = c.req.param('id')
    const role = await workspaceRole(userId, workspaceId)
    if (!role) {
      return c.json({ error: { code: 'forbidden', message: 'Access denied to this workspace' } }, 403)
    }
    if (role !== 'owner' && role !== 'admin') {
      return c.json(
        { error: { code: 'forbidden', message: 'Only workspace owners and admins can update workspace settings' } },
        403,
      )
    }

    const body = await c.req.json().catch(() => ({} as any))
    // The whole shell branches on `kind` (personal = companion chat, team =
    // projects + channels), so it is not an editable field.
    if (body?.kind !== undefined) {
      const current = await prisma.workspace.findUnique({
        where: { id: workspaceId },
        select: { kind: true },
      })
      if (!current) {
        return c.json({ error: { code: 'not_found', message: 'Workspace not found' } }, 404)
      }
      if (body.kind !== (current.kind ?? 'team')) {
        return c.json({ error: { code: 'kind_immutable', message: 'A workspace cannot change kind.' } }, 400)
      }
    }

    const data: Record<string, unknown> = {}
    if (body?.name !== undefined) {
      const parsed = parseWorkspaceName(body.name)
      if (!parsed.ok) return c.json({ error: parsed.error }, 400)
      data.name = parsed.name
    }
    if (body?.description !== undefined) data.description = body.description
    // Pass through the same settings scalars the generated route accepts, so
    // shadowing it locally doesn't silently drop a Compute/Integrations toggle.
    for (const field of [
      'trainingDataMode',
      'chatMode',
      'chatProvider',
      'composioScope',
      'ssoSettings',
      'instanceSize',
      'homeRegion',
      'parentWorkspaceId',
    ]) {
      if (body?.[field] !== undefined) data[field] = body[field]
    }
    // `slug` is deliberately not writable: it is an internal identifier
    // (shared-file tokens, export manifests), and renaming a workspace must not
    // repoint or duplicate anything.
    if (Object.keys(data).length === 0) {
      const current = await prisma.workspace.findUnique({ where: { id: workspaceId } })
      return c.json({ ok: true, data: current })
    }

    // The slug is an internal identifier (shared-file tokens, export manifests);
    // renaming a workspace must not repoint or duplicate anything.
    const updated = await prisma.workspace.update({ where: { id: workspaceId }, data })
    return c.json({ ok: true, data: updated })
  })

  /**
   * True wipe: DB rows (cascading), every runtime the workspace owns, its merged
   * root, each app-owned `workspaces/<projectId>` tree and its chat-attachment
   * blobs. Row deletion commits *before* the filesystem pass so a failed `rm`
   * is a warning on an already-deleted workspace, never a 500 that leaves the
   * workspace half-alive. A folder-linked project's own folder is never touched
   * (`workspace-files.service.ts` unlinks symlinks instead of following them).
   */
  router.delete('/workspaces/:id', async (c) => {
    const userId = authUserId(c)
    if (!userId) {
      return c.json({ error: { code: 'unauthorized', message: 'Authentication required' } }, 401)
    }
    const workspaceId = c.req.param('id')

    const role = await workspaceRole(userId, workspaceId)
    if (!role) {
      return c.json({ error: { code: 'forbidden', message: 'Access denied to this workspace' } }, 403)
    }
    if (role !== 'owner') {
      return c.json({ error: { code: 'forbidden', message: 'Only workspace owners can delete workspaces' } }, 403)
    }
    const workspace = await prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { id: true, kind: true },
    })
    if (!workspace) {
      return c.json({ error: { code: 'not_found', message: 'Workspace not found' } }, 404)
    }
    // The seeded personal workspace is the companion shell and the fallback
    // default; it cannot be deleted (matches the guard Settings applies).
    if ((workspace.kind ?? 'team') === 'personal') {
      return c.json(
        {
          error: {
            code: 'personal_workspace_required',
            message: 'Your personal workspace cannot be deleted.',
          },
        },
        409,
      )
    }
    const ownedWorkspaces = await prisma.member.count({
      where: { userId, role: 'owner', projectId: null, workspaceId: { not: null } },
    })
    if (ownedWorkspaces <= 1) {
      return c.json(
        {
          error: {
            code: 'last_workspace',
            message: 'You cannot delete your only workspace. Create another one first.',
          },
        },
        409,
      )
    }

    const inventory = await workspaceFileInventory(workspaceId, { workspacesDir, prisma })

    const storageKeys: string[] = await prisma.conversationAttachment
      .findMany({
        where: { conversation: { workspaceId } },
        select: { storageKey: true },
      })
      .then((rows: Array<{ storageKey: string }>) => rows.map((row) => row.storageKey))
      .catch(() => [] as string[])

    const warnings: string[] = []

    // Zernio bills per connected account, so the profile has to go while we can
    // still name it — deleting the row first would leave a permanent charge.
    try {
      const { deleteProfileForWorkspace } = await import('../services/social/profiles.service')
      const profile = await deleteProfileForWorkspace(workspaceId)
      if (profile.error) warnings.push(`social profile: ${profile.error}`)
    } catch (err: any) {
      warnings.push(`social profile: ${err?.message ?? err}`)
    }

    // Stop every runtime this workspace owns before its files disappear: the
    // workspace-session runtime (`ws:<id>`) and each project-anchored one
    // (`ws:proj:<projectId>`), which are separate processes.
    const projectIds = (inventory?.projects ?? []).map((project) => project.id)
    try {
      await options.runtimeManager?.stopWorkspace?.(workspaceId)
    } catch (err: any) {
      warnings.push(`stop workspace runtime: ${err?.message ?? err}`)
    }
    for (const projectId of projectIds) {
      try {
        await options.runtimeManager?.stop?.(projectId, 'workspace-deleted')
      } catch (err: any) {
        warnings.push(`stop runtime for project ${projectId}: ${err?.message ?? err}`)
      }
    }

    // Rows first (cascades), then files. Chat sessions carry `workspaceId`
    // without a foreign key, so they would survive the cascade as orphans.
    await prisma.chatSession
      .deleteMany({ where: { workspaceId } })
      .catch((err: any) => warnings.push(`chat sessions: ${err?.message ?? err}`))
    try {
      await prisma.workspace.delete({ where: { id: workspaceId } })
    } catch (error: any) {
      console.error('[Workspace] Local delete failed:', error)
      return c.json(
        { error: { code: 'delete_failed', message: error?.message || 'Unable to delete workspace' } },
        500,
      )
    }

    for (const key of storageKeys) {
      await deleteConversationFile(key).catch((err: any) => {
        warnings.push(`attachment ${key}: ${err?.message ?? err}`)
      })
    }

    const report = inventory
      ? removeWorkspaceFiles(inventory, { workspacesDir })
      : { removedDirs: [] as string[], warnings: [] as string[] }

    return c.json({
      ok: true,
      removedDirs: report.removedDirs,
      warnings: [...warnings, ...report.warnings],
    })
  })

  router.get('/workspaces/:id/visible-models', async (c) => {
    const userId = authUserId(c)
    const workspaceId = c.req.param('id')
    if (!userId || !(await hasMembership(userId, workspaceId))) {
      return c.json({ error: { code: 'forbidden', message: 'Access denied' } }, 403)
    }
    try {
      const platform = await resolvePlatformVisibleModelsForRequest()
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
      where: { userId, workspaceId, projectId: null, role: { in: ['owner', 'admin'] } },
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

    const platform = await resolvePlatformVisibleModelsForRequest()
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
