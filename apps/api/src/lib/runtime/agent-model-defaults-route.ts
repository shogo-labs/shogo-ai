// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import type { Context } from 'hono'
import { resolveEffectiveAgentModelDefaults } from './agent-model-defaults'

/**
 * Cloud-facing endpoint handler for the model defaults consumed by local
 * runtimes. The global API auth middleware has already resolved the API key
 * or session into `c.get('auth')` before this handler runs.
 */
export async function agentModelDefaultsRoute(c: Context): Promise<Response> {
  try {
    const auth = c.get('auth') as { workspaceId?: string; isAuthenticated?: boolean } | undefined
    if (!auth?.isAuthenticated || !auth.workspaceId) {
      return c.json({ error: { code: 'unauthorized', message: 'Authentication required' } }, 401)
    }
    return c.json(await resolveEffectiveAgentModelDefaults(auth.workspaceId))
  } catch (err: any) {
    console.error('[AgentModels] Failed to resolve cloud defaults:', err?.message || err)
    return c.json({ error: { code: 'internal_error', message: 'Unable to resolve agent model defaults' } }, 500)
  }
}
