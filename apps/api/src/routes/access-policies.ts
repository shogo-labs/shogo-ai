// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Workspace access policies (SHO-417) — the settings API behind the "who may
 * use what" screen.
 *
 * Reads are open to any member for their *own* access (`/access/effective`),
 * because the chat picker and the agent runtime both need it. Everything that
 * names another person, or changes a policy, needs
 * `workspace.settings:manage`.
 *
 * The resolver itself lives in `services/access-policy.service.ts`; these
 * routes only authorize, validate and shape the response.
 */

import { Hono } from 'hono'
import { ABILITY_PERMISSIONS, MODEL_TIERS, type Permission } from '@shogo/authz'
import { loadAccess } from '../lib/authz'
import {
  AccessRequestError,
  PolicyValidationError,
  accessModelCatalog,
  allowedModelIdsFor,
  decideAccessRequest,
  deletePolicy,
  explainAccess,
  getEffectiveAccess,
  listAccessAudit,
  summarizeShadowDenials,
  listAccessRequests,
  listPolicies,
  requestAccess,
  upsertPolicy,
  validatePolicyWrite,
  type AccessRequestStatus,
  type PolicyWrite,
} from '../services/access-policy.service'
import { getAllowedModelIds } from '../services/workspace-models.service'

export interface AccessPolicyRoutesConfig {
  resolveUserId: (c: any) => Promise<string | null>
}

/**
 * What each ability means, for the settings UI. Kept next to the routes rather
 * than in `@shogo/authz` so the package stays a pure policy library; the ids
 * come from `ABILITY_PERMISSIONS`, so a new ability without a label is a
 * visible gap in the UI rather than a silent one.
 */
const ABILITY_LABELS: Readonly<Record<string, { label: string; group: string }>> = {
  'agent.exec:use': { label: 'Run shell commands', group: 'Agent' },
  'agent.browser:use': { label: 'Drive a browser', group: 'Agent' },
  'agent.media:generate': { label: 'Generate images, video, music and 3D', group: 'Agent' },
  'agent.channels:send': { label: 'Send through connected channels', group: 'Agent' },
  'agent.social:post': { label: 'Post to social accounts', group: 'Agent' },
  'agent:create': { label: 'Create agents', group: 'Unattended work' },
  'schedule:manage': { label: 'Manage schedules', group: 'Unattended work' },
  'trigger:manage': { label: 'Manage triggers', group: 'Unattended work' },
  'system:apply': { label: 'Apply a workspace manifest', group: 'Unattended work' },
  'agent.approvals:decide': { label: "Decide other people's approvals", group: 'Approvals' },
  'integrations:connect': { label: 'Connect integrations', group: 'Integrations' },
  'project.files:share_public': { label: 'Create public file links', group: 'Data' },
  'project.secrets:read': { label: 'Read project secrets', group: 'Data' },
  'instance.commands:run': { label: 'Run commands on a paired desktop', group: 'Paired desktop' },
  'channels.private:create': { label: 'Create private channels', group: 'Team chat and boards' },
  'boards:manage': { label: 'Manage boards', group: 'Team chat and boards' },
  'members.activity:read': { label: "Read other members' activity", group: 'Team chat and boards' },
  'models:use_all': { label: 'Use every model in the workspace', group: 'Models' },
}

function abilityCatalog() {
  return ABILITY_PERMISSIONS.map((id) => ({
    id,
    label: ABILITY_LABELS[id]?.label ?? id,
    group: ABILITY_LABELS[id]?.group ?? 'Other',
  }))
}

function errorResponse(c: any, err: unknown) {
  if (err instanceof PolicyValidationError) {
    return c.json({ error: { code: err.code, message: err.message } }, 400)
  }
  throw err
}

export function accessPolicyRoutes(config: AccessPolicyRoutesConfig) {
  const app = new Hono()

  /** The caller's own effective access. Any member. */
  app.get('/workspaces/:workspaceId/access/effective', async (c) => {
    const workspaceId = c.req.param('workspaceId')
    const userId = await config.resolveUserId(c)
    if (!userId) return c.json({ error: { code: 'unauthorized', message: 'Sign in required' } }, 401)
    const access = await getEffectiveAccess(workspaceId, userId)
    if (!access) return c.json({ error: { code: 'forbidden', message: 'Access denied' } }, 403)
    return c.json({
      workspaceId,
      userId,
      role: access.role,
      abilities: [...access.abilities].sort(),
      models: await allowedModelIdsFor(workspaceId, userId),
      defaultModelId: access.defaultModelId,
      spendCapUsd: access.spendCapUsd,
      spendPeriod: access.spendPeriod,
      requestsPerHour: access.requestsPerHour,
      reasons: access.reasons,
    })
  })

  /** Every policy row plus the catalogs the editor needs. Admin. */
  app.get('/workspaces/:workspaceId/access/policies', async (c) => {
    const workspaceId = c.req.param('workspaceId')
    const denied = await requireAdmin(c, workspaceId)
    if (denied) return denied

    const ceiling = await getAllowedModelIds(workspaceId)
    const models = accessModelCatalog()
      .filter((m) => ceiling === null || ceiling.has(m.id))
      .map((m) => ({ id: m.id, displayName: m.displayName, tier: m.tier }))

    return c.json({
      policies: await listPolicies(workspaceId),
      abilities: abilityCatalog(),
      modelTiers: MODEL_TIERS,
      models,
    })
  })

  /** Upsert one policy row. Admin. */
  app.put('/workspaces/:workspaceId/access/policies', async (c) => {
    const workspaceId = c.req.param('workspaceId')
    const denied = await requireAdmin(c, workspaceId)
    if (denied) return denied
    const actorUserId = await config.resolveUserId(c)

    const body = (await c.req.json().catch(() => null)) as Partial<PolicyWrite> | null
    if (!body || typeof body !== 'object') {
      return c.json({ error: { code: 'bad_request', message: 'Invalid JSON body' } }, 400)
    }

    try {
      const write = validatePolicyWrite(
        {
          subjectType: body.subjectType as PolicyWrite['subjectType'],
          subjectId: String(body.subjectId ?? ''),
          abilities: body.abilities ?? null,
          modelTiers: body.modelTiers ?? null,
          modelIds: body.modelIds ?? null,
          defaultModelId: body.defaultModelId ?? null,
          spendCapUsd: body.spendCapUsd ?? null,
          spendPeriod: body.spendPeriod ?? null,
          requestsPerHour: body.requestsPerHour ?? null,
        },
        await getAllowedModelIds(workspaceId),
        accessModelCatalog(),
      )
      await upsertPolicy(workspaceId, write, actorUserId)
      return c.json({ ok: true, policies: await listPolicies(workspaceId) })
    } catch (err) {
      return errorResponse(c, err)
    }
  })

  /** Delete one policy row, reverting the subject to its role default. Admin. */
  app.delete('/workspaces/:workspaceId/access/policies/:subjectType/:subjectId', async (c) => {
    const workspaceId = c.req.param('workspaceId')
    const denied = await requireAdmin(c, workspaceId)
    if (denied) return denied
    const actorUserId = await config.resolveUserId(c)

    const subjectType = c.req.param('subjectType')
    if (subjectType !== 'role' && subjectType !== 'group' && subjectType !== 'member') {
      return c.json({ error: { code: 'invalid_subject', message: 'Unknown subject type' } }, 400)
    }
    const removed = await deletePolicy(workspaceId, subjectType, c.req.param('subjectId'), actorUserId)
    if (!removed) return c.json({ error: { code: 'not_found', message: 'No such policy' } }, 404)
    return c.json({ ok: true, policies: await listPolicies(workspaceId) })
  })

  /** Why one member has the access they have. Admin. */
  app.get('/workspaces/:workspaceId/access/explain/:userId', async (c) => {
    const workspaceId = c.req.param('workspaceId')
    const denied = await requireAdmin(c, workspaceId)
    if (denied) return denied
    const explained = await explainAccess(workspaceId, c.req.param('userId'))
    if (!explained) return c.json({ error: { code: 'not_found', message: 'Not a workspace member' } }, 404)
    return c.json(explained)
  })

  /**
   * Ask for one ability or one model. Any member, for themselves only — the
   * requester is the session user, never a body field.
   */
  app.post('/workspaces/:workspaceId/access/requests', async (c) => {
    const workspaceId = c.req.param('workspaceId')
    const userId = await config.resolveUserId(c)
    if (!userId) return c.json({ error: { code: 'unauthorized', message: 'Sign in required' } }, 401)
    const access = await getEffectiveAccess(workspaceId, userId)
    if (!access) return c.json({ error: { code: 'forbidden', message: 'Access denied' } }, 403)

    const body = (await c.req.json().catch(() => null)) as
      | { permission?: string; modelId?: string; reason?: string }
      | null
    if (!body || typeof body !== 'object') {
      return c.json({ error: { code: 'bad_request', message: 'Invalid JSON body' } }, 400)
    }

    try {
      const request = await requestAccess({
        workspaceId,
        userId,
        permission: body.permission ?? null,
        modelId: body.modelId ?? null,
        reason: body.reason ?? null,
      })
      return c.json({ request })
    } catch (err) {
      if (err instanceof AccessRequestError) {
        return c.json({ error: { code: err.code, message: err.message } }, err.status)
      }
      throw err
    }
  })

  /** The admin queue: open requests by default, or one status. Admin. */
  app.get('/workspaces/:workspaceId/access/requests', async (c) => {
    const workspaceId = c.req.param('workspaceId')
    const denied = await requireAdmin(c, workspaceId)
    if (denied) return denied

    const status = c.req.query('status')
    if (status && status !== 'open' && status !== 'granted' && status !== 'denied') {
      return c.json({ error: { code: 'invalid_status', message: 'status must be open, granted or denied' } }, 400)
    }
    return c.json({
      requests: await listAccessRequests(workspaceId, { status: status as AccessRequestStatus | undefined }),
    })
  })

  /** Approve or deny one request. Admin. */
  app.post('/workspaces/:workspaceId/access/requests/:requestId/decide', async (c) => {
    const workspaceId = c.req.param('workspaceId')
    const denied = await requireAdmin(c, workspaceId)
    if (denied) return denied
    const actorUserId = await config.resolveUserId(c)

    const body = (await c.req.json().catch(() => null)) as { approve?: boolean } | null
    if (!body || typeof body.approve !== 'boolean') {
      return c.json({ error: { code: 'bad_request', message: 'approve must be true or false' } }, 400)
    }

    try {
      const request = await decideAccessRequest({
        workspaceId,
        requestId: c.req.param('requestId'),
        actorUserId,
        approve: body.approve,
      })
      return c.json({ request })
    } catch (err) {
      if (err instanceof AccessRequestError) {
        return c.json({ error: { code: err.code, message: err.message } }, err.status)
      }
      throw err
    }
  })

  /** The audit trail, newest first, plus what shadow mode would have blocked. Admin. */
  app.get('/workspaces/:workspaceId/access/audit', async (c) => {
    const workspaceId = c.req.param('workspaceId')
    const denied = await requireAdmin(c, workspaceId)
    if (denied) return denied

    const limitRaw = Number(c.req.query('limit') ?? 50)
    const daysRaw = Number(c.req.query('days') ?? 7)
    return c.json({
      events: await listAccessAudit(workspaceId, {
        kind: c.req.query('kind') || undefined,
        userId: c.req.query('userId') || undefined,
        limit: Number.isFinite(limitRaw) ? limitRaw : 50,
      }),
      shadow: await summarizeShadowDenials(workspaceId, {
        days: Number.isFinite(daysRaw) ? daysRaw : 7,
      }),
    })
  })

  async function requireAdmin(c: any, workspaceId: string): Promise<Response | null> {
    const userId = await config.resolveUserId(c)
    if (!userId) return c.json({ error: { code: 'unauthorized', message: 'Sign in required' } }, 401)
    const access = await loadAccess({ userId, via: 'session' }, { workspaceId })
    if (!access.permissions.has('workspace.settings:manage' as Permission)) {
      return c.json({ error: { code: 'forbidden', message: 'Workspace admin access required' } }, 403)
    }
    return null
  }

  return app
}
