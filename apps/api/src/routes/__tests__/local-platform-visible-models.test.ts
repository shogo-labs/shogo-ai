// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test, mock } from 'bun:test'
import { Hono } from 'hono'

const cloudModels = [
  {
    id: 'gpt-6-sol',
    provider: 'openai',
    displayName: 'GPT-6 Sol',
    shortDisplayName: 'Sol',
    tier: 'premium',
  },
  {
    id: 'live-model',
    provider: 'google',
    displayName: 'Live model',
    shortDisplayName: 'Live',
    tier: 'standard',
    kind: 'live',
  },
]

mock.module('../../lib/prisma', () => ({ prisma: {} }))
mock.module('../../lib/federated-upstream', () => ({
  fetchCloudAgentModelDefaults: async () => null,
  fetchCloudVisibleModels: async () => ({
    catalogIds: null,
    catalogModels: cloudModels,
    openrouterModels: [],
  }),
  getUpstreamCredential: async () => null,
}))
mock.module('../../lib/runtime/agent-model-defaults', () => ({
  AUTO_MODEL_DEFAULTS: { economy: 'economy', standard: 'standard', premium: 'premium' },
}))
mock.module('../../services/visible-models.service', () => ({
  resolvePlatformVisibleModels: async () => ({ catalogIds: null, catalogModels: [], openrouterModels: [] }),
}))
mock.module('../../services/provider-credentials.service', () => ({
  getNativeProviderApiKeySync: () => null,
}))

const { localPlatformRoutes } = await import('../local-platform')

describe('local platform visible models', () => {
  test('adds supported efforts to cloud models and keeps the includeLive filter', async () => {
    const app = new Hono()
    app.route('/api', localPlatformRoutes())

    const response = await app.request('/api/platform/visible-models')
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.catalogModels).toHaveLength(1)
    expect(body.catalogModels[0]).toMatchObject({
      id: 'gpt-6-sol',
      reasoningEfforts: ['minimal', 'low', 'medium', 'high', 'xhigh'],
    })

    const liveResponse = await app.request('/api/platform/visible-models?includeLive=true')
    const liveBody = await liveResponse.json()
    expect(liveBody.catalogModels).toHaveLength(2)
    expect(liveBody.catalogModels[1]).toMatchObject({ id: 'live-model', kind: 'live' })
  })
})
