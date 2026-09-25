// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Local-mode (desktop) billing seams must return exactly what their callers
 * read. Chat routes gate on `checkUsageBalance(...).ok` and render
 * `usageLimitErrorPayload(...)`'s `{ code, message }`; a local stub with any
 * other shape rejects every desktop chat with a 402 whose body serializes to
 * `{"error":{}}`.
 */
import { afterAll, describe, expect, test } from 'bun:test'

const previousLocalMode = process.env.SHOGO_LOCAL_MODE
process.env.SHOGO_LOCAL_MODE = 'true'

const billing = await import('../services/billing-runtime')
const session = await import('../lib/proxy-billing-session-runtime')
const auth = await import('../services/auth-integrations')
const { usageLimitErrorPayload: cloudUsageLimitErrorPayload } = await import('../services/usage-limits')

afterAll(() => {
  if (previousLocalMode === undefined) delete process.env.SHOGO_LOCAL_MODE
  else process.env.SHOGO_LOCAL_MODE = previousLocalMode
})

describe('billing-runtime (local mode)', () => {
  test('the chat balance gate passes', async () => {
    const balance = await billing.checkUsageBalance('local-workspace')
    expect(balance).toEqual({ ok: true })
    // The exact expression project-chat.ts / workspace-chat.ts / ai-proxy.ts branch on.
    expect(!balance.ok).toBe(false)
  })

  test('a usage-limit payload always has a human-readable code and message', () => {
    for (const reason of [undefined, 'usage_limit_reached', 'entitlement_expired', 'overage_cap_reached'] as const) {
      const payload = billing.usageLimitErrorPayload(reason)
      expect(payload).toEqual(cloudUsageLimitErrorPayload(reason))
      expect(typeof payload.code).toBe('string')
      expect(payload.message.length).toBeGreaterThan(0)
      expect(JSON.stringify({ error: payload })).not.toBe('{"error":{}}')
    }
  })

  test('mirrors billing.service local-mode answers', async () => {
    expect(billing.SYSTEM_WORKSPACE_ID).toBe('system')
    expect(await billing.hasAdvancedModelAccess('local-workspace')).toBe(true)
    expect(await billing.hasBalance('local-workspace')).toBe(true)
    expect(await billing.ensureSystemWorkspace()).toBeUndefined()
    expect(await billing.getSubscription('local-workspace')).toBeNull()
    expect(await billing.getUsageWallet('local-workspace')).toBeNull()
    expect(await billing.hasPaidSubscription('local-workspace')).toBe(true)
  })

  test('any tech stack may run regardless of instance size (project_create / project_configure)', async () => {
    for (const stack of ['react-app', 'expo-app', null]) {
      expect((await billing.canRunTechStackOnInstanceSize('local-workspace', stack)).allowed).toBe(true)
    }
  })

  test('usage windows are uncapped snapshots, not null', async () => {
    const windows = await billing.getUsageWindows('local-workspace')
    expect(windows.fiveHour).toEqual({ kind: 'five_hour', usedUsd: 0, limitUsd: null, utilization: 0, resetsAt: null })
    expect(windows.weekly).toEqual({ kind: 'weekly', usedUsd: 0, limitUsd: null, utilization: 0, resetsAt: null })
  })

  test('recording usage succeeds without debiting', async () => {
    const result = await billing.consumeUsage({
      workspaceId: 'local-workspace',
      projectId: null,
      memberId: 'local-user',
      actionType: 'chat',
      billedUsd: 1.23,
    })
    expect(result).toEqual(expect.objectContaining({ success: true, overageChargedUsd: 0, source: 'daily' }))
  })

  test('cloud-only billing operations fail loudly instead of pretending to succeed', async () => {
    await expect(billing.allocateMonthlyIncluded('local-workspace', 'pro')).rejects.toThrow(/not available in local mode/)
    await expect(billing.syncFromStripe({} as any)).rejects.toThrow(/not available in local mode/)
  })
})

describe('proxy-billing-session-runtime (local mode)', () => {
  test('closeSession returns the full result shape', async () => {
    expect(await session.closeSession('p')).toEqual({ billedUsd: 0, rawUsd: 0, totalTokens: 0 })
  })

  test('no session is ever active, so the AI proxy records usage per call', async () => {
    await session.openSession('p', 'w', 'u')
    expect(await session.hasSession('p')).toBe(false)
    expect(await session.hasActiveSession('p')).toBe(false)
    expect(await session.accumulateUsage('p', 'm', 1, 1)).toBe(false)
    expect(await session.accumulateImageUsage('p', 'm', 0, 0)).toBe(false)
    expect(await session.setQualitySignals('p', {} as any)).toBe(false)
  })
})

describe('auth-integrations (local mode)', () => {
  test('email is disabled with the real result shape; tracking is a no-op', async () => {
    expect(await auth.sendWelcomeEmail({ to: 'a@b.c', name: 'A' })).toEqual({
      success: false,
      error: 'email integration disabled',
    })
    expect(await auth.trackEvent('u', 'e')).toBeUndefined()
    expect(await auth.resolveAttributionForUser('u', null)).toBeNull()
  })
})
