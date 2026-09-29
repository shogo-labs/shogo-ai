// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test, mock } from 'bun:test'
import { Hono } from 'hono'

const cloudModel = {
  id: 'cloud-model-uuid',
  provider: 'anthropic',
  displayName: 'Cloud Claude',
  shortDisplayName: 'Cloud Claude',
  tier: 'standard',
}

const staticModel = {
  id: 'claude-haiku-4-5-20251001',
  provider: 'anthropic',
  displayName: 'Claude Haiku 4.5',
  shortDisplayName: 'Haiku 4.5',
  tier: 'economy',
}

let resolveCalls = 0

mock.module('../../lib/prisma', () => ({
  prisma: {
    member: {
      findFirst: async () => ({ id: 'membership-1' }),
    },
  },
}))

mock.module('../../services/workspace.service', () => ({}))

mock.module('../../services/workspace-models.service', () => ({
  getAllowedModelIds: async () => new Set([cloudModel.id]),
  filterToAllowlist: (platform: any, allowed: Set<string>) => ({
    catalogModels: platform.catalogModels.filter((model: any) => allowed.has(model.id)),
    openrouterModels: platform.openrouterModels.filter((model: any) => allowed.has(model.id)),
  }),
  modelsOutsidePlatform: () => [],
  setAllowedModelIds: async () => {},
}))

mock.module('../../services/visible-models.service', () => ({
  resolvePlatformVisibleModelsForRequest: async () => {
    resolveCalls += 1
    return {
      catalogIds: null,
      catalogModels: [cloudModel, staticModel],
      openrouterModels: [],
    }
  },
}))

const { localWorkspaceRoutes } = await import('../local-workspaces')

describe('local workspace visible models', () => {
  test('uses the cloud-aware catalog before applying the workspace allowlist', async () => {
    resolveCalls = 0
    const app = new Hono()
    app.use('*', async (c, next) => {
      ;(c as any).set('auth', { isAuthenticated: true, userId: 'user-1' })
      await next()
    })
    app.route('/api', localWorkspaceRoutes())

    const response = await app.request('/api/workspaces/workspace-1/visible-models')

    expect(response.status).toBe(200)
    expect(resolveCalls).toBe(1)
    expect(await response.json()).toMatchObject({
      catalogModels: [cloudModel],
      allowedModelIds: [cloudModel.id],
    })
  })
})
