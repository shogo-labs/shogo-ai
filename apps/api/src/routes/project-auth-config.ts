// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Project auth-config admin routes — used by the Studio Settings tab
 * (Auth & Database pane) to read and write the per-project sign-in
 * allowlist that gates `shogo.auth` sign-ins for users of the project.
 *
 * Endpoints (mounted under `/api`, project-scoped paths gated by
 * `requireProjectAccess` at the server level):
 *   - GET    /projects/:projectId/auth-config
 *   - PUT    /projects/:projectId/auth-config
 *   - GET    /projects/:projectId/auth-users
 *   - DELETE /projects/:projectId/auth-users/:userId
 */

import { Hono } from 'hono'
import {
  getConfig,
  upsertConfig,
  listUsers,
  revokeUser,
  ProjectAuthConfigError,
} from '../services/project-auth-config.service'

export function projectAuthConfigRoutes() {
  const router = new Hono()

  /**
   * GET /projects/:projectId/auth-config
   * Returns the current allowlist (defaults to `mode: 'anyone'`).
   */
  router.get('/projects/:projectId/auth-config', async (c) => {
    const projectId = c.req.param('projectId')
    if (!projectId) {
      return c.json({ error: { code: 'bad_request', message: 'Project ID is required' } }, 400)
    }
    const config = await getConfig(projectId)
    return c.json({ config })
  })

  /**
   * PUT /projects/:projectId/auth-config
   * Upserts the allowlist. Body fields are all optional and applied
   * additively to the existing row (mirrors PATCH semantics, but PUT
   * is what the SettingsPanel UI uses for whole-form saves).
   */
  router.put('/projects/:projectId/auth-config', async (c) => {
    const projectId = c.req.param('projectId')
    if (!projectId) {
      return c.json({ error: { code: 'bad_request', message: 'Project ID is required' } }, 400)
    }

    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: { code: 'bad_request', message: 'Invalid JSON body' } }, 400)
    }
    if (!body || typeof body !== 'object') {
      return c.json({ error: { code: 'bad_request', message: 'Body must be an object' } }, 400)
    }

    try {
      const config = await upsertConfig(projectId, body as Record<string, unknown>)
      return c.json({ config })
    } catch (err) {
      if (err instanceof ProjectAuthConfigError) {
        return c.json({ error: { code: err.code, message: err.message } }, 400)
      }
      console.error('[project-auth-config] upsert failed', err)
      return c.json(
        { error: { code: 'internal', message: 'Failed to update auth config' } },
        500,
      )
    }
  })

  /**
   * GET /projects/:projectId/auth-users
   * Paginated list of users who have signed in to this project via the
   * Shogo SDK, keyed off `ProjectAuthSignIn`. Supports `?cursor=&q=&limit=`.
   */
  router.get('/projects/:projectId/auth-users', async (c) => {
    const projectId = c.req.param('projectId')
    if (!projectId) {
      return c.json({ error: { code: 'bad_request', message: 'Project ID is required' } }, 400)
    }
    const cursor = c.req.query('cursor') ?? undefined
    const queryStr = c.req.query('q') ?? undefined
    const rawLimit = c.req.query('limit')
    const limit = rawLimit ? Number.parseInt(rawLimit, 10) : undefined

    const { items, nextCursor } = await listUsers(projectId, {
      cursor,
      query: queryStr,
      limit: Number.isFinite(limit) ? (limit as number) : undefined,
    })
    return c.json({ items, nextCursor })
  })

  /**
   * DELETE /projects/:projectId/auth-users/:userId
   * Revokes a user's access — removes the audit row and invalidates
   * their sessions. Does not touch the allowlist; the caller can
   * follow up with a PUT /auth-config to remove the email/domain.
   */
  router.delete('/projects/:projectId/auth-users/:userId', async (c) => {
    const projectId = c.req.param('projectId')
    const userId = c.req.param('userId')
    if (!projectId || !userId) {
      return c.json({ error: { code: 'bad_request', message: 'Missing path params' } }, 400)
    }
    await revokeUser(projectId, userId)
    return c.json({ ok: true })
  })

  return router
}
