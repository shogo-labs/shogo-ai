// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { Hono } from 'hono'
import { prisma } from '../lib/prisma'
import { fetchCloudAgentModelDefaults, fetchCloudVisibleModels, getUpstreamCredential } from '../lib/federated-upstream'
import { resolvePlatformVisibleModels } from '../services/visible-models.service'
import { getNativeProviderApiKeySync } from '../services/provider-credentials.service'

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
    // `getUpstreamCredential()` also sees a key that is only in localConfig
    // (the window right after a restart), so the panel and the publish route
    // can't disagree about whether publishing is possible.
    const cloudKey = await getUpstreamCredential()
    const shogoKeyConnected = !!cloudKey
    return c.json({
      localMode: true,
      needsSetup: userCount === 0,
      shogoKeyConnected,
      features: {
        billing: false,
        admin: false,
        oauth: false,
        analytics: true,
        // Publishing works on desktop whenever a Shogo Cloud key is connected:
        // the desktop builds, the cloud hosts (SHO-245). Without a key there is
        // nowhere to host, so the panel stays disabled.
        publishing: shogoKeyConnected,
        marketplace: true,
        ezMode: true,
        ezModeVoiceProvider:
          Boolean(
            getNativeProviderApiKeySync('openai') ||
              (!!process.env.SHOGO_API_KEY &&
                process.env.AI_MODE !== 'api-keys' &&
                process.env.AI_MODE !== 'local-llm'),
          )
            ? 'gpt-live'
            : 'elevenlabs',
        phoneChannel: false,
        personalShell: true,
        workBoards: true,
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

  router.get('/platform/agent-model-defaults', async (c) => {
    const fromCloud = await fetchCloudAgentModelDefaults().catch(() => null)
    if (fromCloud) return c.json(fromCloud)
    return c.json(localAgentModelDefaults())
  })
  return router
}

function localAgentModelDefaults() {
  return {
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
  }
}
