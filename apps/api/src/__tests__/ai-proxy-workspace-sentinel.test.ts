// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

process.env.AI_PROXY_SECRET = process.env.AI_PROXY_SECRET || 'test-secret-ai-proxy-do-not-use-in-prod'
process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET || 'test-better-auth-secret'

/**
 * Regression coverage for the `'workspace'` proxy-token sentinel.
 *
 * Staging incident: a brand-new personal companion workspace (zero attached
 * projects) got AI_PROXY_URL set on its runtime env but no AI_PROXY_TOKEN,
 * because `buildWorkspaceEnv` only minted a token for the FIRST attached
 * project — and there wasn't one. The agent-runtime's `configureAIProxy()`
 * throws hard when the URL is set without a token, which failed metal
 * `/pool/assign` and surfaced to the user as a generic "Something went
 * wrong on our end" on every message.
 *
 * The fix (`build-workspace-env.ts`) mints a fallback token scoped to the
 * `'workspace'` sentinel projectId when there are no attached projects.
 * This file proves `recordUsage` treats that sentinel exactly like the
 * pre-existing `'api-key'` / `'system'` sentinels: bill at the workspace
 * level with a null Project FK, never attributed to a real Project row.
 * (`isTurnInFlight` / `touchRuntimeFor` share the same `isNonProjectSentinel`
 * helper but aren't exported for direct unit testing.)
 *
 *   bun test apps/api/src/__tests__/ai-proxy-workspace-sentinel.test.ts
 */

import { describe, test, expect, beforeEach, mock } from 'bun:test'
import { withPrismaExports } from './helpers/prisma-mock-exports'

delete process.env.SHOGO_LOCAL_MODE
delete process.env.SHOGO_API_KEY

const createdEvents: any[] = []
const consumeUsageCalls: any[] = []

mock.module('../lib/prisma', () => withPrismaExports({
  prisma: {
    usageEvent: {
      create: async (args: any) => {
        createdEvents.push(args.data)
        return args.data
      },
    },
  },
}))

mock.module('../services/billing.service', () => ({
  hasBalance: async () => true,
  hasAdvancedModelAccess: async () => true,
  consumeUsage: async (params: any) => {
    consumeUsageCalls.push(params)
    return { success: true, remainingIncludedUsd: 100 }
  },
  getSubscription: async () => null,
  getUsageWallet: async () => null,
  syncFromStripe: async () => ({}),
  allocateMonthlyIncluded: async () => ({}),
}))

mock.module('../lib/proxy-billing-session', () => ({
  openSession: () => null,
  hasSession: () => false,
  hasActiveSession: () => false,
  accumulateUsage: () => false,
  accumulateImageUsage: () => {},
  setQualitySignals: () => false,
  closeSession: async () => null,
}))

mock.module('../lib/project-user-context', () => ({
  getProjectUser: () => undefined,
}))

const { recordUsage } = await import('../routes/ai-proxy')

const WORKSPACE_SENTINEL_PAYLOAD = {
  projectId: 'workspace',
  workspaceId: 'ws-personal-1',
  userId: 'ws-owner-1',
  type: 'ai-proxy' as const,
  authKind: 'proxy-jwt' as const,
  iat: 0,
  exp: 0,
}

beforeEach(() => {
  createdEvents.length = 0
  consumeUsageCalls.length = 0
})

describe("recordUsage — 'workspace' sentinel (project-less workspace runtime)", () => {
  test('bills the workspace directly with a null projectId FK', async () => {
    await recordUsage(WORKSPACE_SENTINEL_PAYLOAD, 'claude-haiku-4-5', 1000, 200, 0, 0, null)

    expect(consumeUsageCalls.length).toBe(1)
    const call = consumeUsageCalls[0]
    expect(call.workspaceId).toBe('ws-personal-1')
    expect(call.projectId).toBeNull()
    expect(call.memberId).toBe('ws-owner-1')
    expect(call.actionType).toBe('ai_proxy_completion')
  })

  test('never attributes usage to a project record', async () => {
    await recordUsage(WORKSPACE_SENTINEL_PAYLOAD, 'claude-haiku-4-5', 500, 100, 0, 0, null)
    for (const call of consumeUsageCalls) {
      expect(call.projectId).not.toBe('workspace')
    }
  })
})
