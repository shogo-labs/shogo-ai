// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * GET /api/local/machine — this machine's own workspaces, for its owner.
 *
 * Reached two ways: the desktop UI itself (local session), and the cloud's
 * `/api/machines/:id/workspaces` relay, which arrives over the instance
 * tunnel with `x-tunnel-auth-user-id` stamped by the cloud after it verified
 * the session. Both are the owner; anything else — loopback curl, a runtime
 * token, an anonymous request — is refused, because "on my machine" is not
 * the same as "allowed to see my machine".
 */

import { Hono } from 'hono'
import { collectMachineSnapshot } from '../lib/machine-snapshot'

export function localMachineRoutes() {
  const router = new Hono()

  router.get('/machine', async (c) => {
    const auth = c.get('auth') as any
    const via = auth?.via
    const allowed = auth?.isAuthenticated && !!auth?.userId && (via === 'tunnel' || via === 'session')
    if (!allowed) {
      return c.json(
        { error: { code: 'forbidden', message: 'Machine snapshot is owner-only' } },
        403,
      )
    }
    return c.json(await collectMachineSnapshot())
  })

  return router
}
