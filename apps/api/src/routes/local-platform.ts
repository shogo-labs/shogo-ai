// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { Hono } from 'hono'
import { prisma } from '../lib/prisma'
import { fetchCloudVisibleModels } from '../lib/federated-upstream'
import { resolvePlatformVisibleModels } from '../services/visible-models.service'

/**
 * Platform metadata used by the desktop/local shell.
 *
 * Keeping these routes out of the local composer makes the entrypoint a
 * declarative route mount and prevents local-only feature defaults from being
 * mixed into the cloud server's much larger `/api/config` response.
 */
export function localPlatformRoutes(): Hono {
  const router = new Hono()

  router.get('/config', async (c) => {
    const userCount = await prisma.user.count().catch(() => 0)
    return c.json({
      localMode: true,
      needsSetup: userCount === 0,
      shogoKeyConnected: !!process.env.SHOGO_API_KEY,
      features: {
        billing: false,
        admin: false,
        oauth: false,
        analytics: true,
        publishing: false,
        marketplace: true,
        ezMode: true,
        phoneChannel: false,
        personalShell: true,
      },
    })
  })

  router.get('/platform/visible-models', async (c) => {
    const includeLive = c.req.query('includeLive') === 'true'
    try {
      const fromCloud = await fetchCloudVisibleModels()
      if (fromCloud) return c.json(fromCloud)
    } catch {
      // The local catalog remains usable while cloud discovery is unavailable.
    }
    return c.json(await resolvePlatformVisibleModels({ includeLive }).catch(() => ({
      catalogIds: null,
      openrouterModels: [],
    })))
  })

  router.get('/platform/agent-model-defaults', (c) => c.json({
    basic: process.env.AGENT_BASIC_MODEL || 'claude-haiku-4-5-20251001',
    advanced: process.env.AGENT_ADVANCED_MODEL || 'claude-sonnet-4-6',
    defaultMode: process.env.AGENT_DEFAULT_MODE || null,
    autoTiers: {
      economy: { id: 'gpt-5.4-nano' },
      standard: { id: 'claude-haiku-4-5-20251001' },
      premium: { id: 'claude-sonnet-4-6' },
    },
    hasAdvancedModelAccess: true,
    deepseekModelIds: [],
  }))
  return router
}
