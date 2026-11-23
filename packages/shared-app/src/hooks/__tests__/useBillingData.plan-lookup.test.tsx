// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Model access when /api/billing/workspace-plan fails.
 *
 * Grant plans (Odin, Shogo, …) have no Subscription row; they reach the client
 * only through workspace-plan. When that route 500'd (SHO-459), the hook read
 * the missing answer as Free and every model but the economy one locked. A
 * failed lookup now means "plan unknown": don't lock (the AI proxy still
 * enforces tiers per request).
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, render, waitFor } from '@testing-library/react'
import React from 'react'
import { installHappyDom, restoreHappyDom } from './happy-dom-setup.ts'

let planResponse: () => Promise<unknown>
let subscriptions: Array<{ workspaceId: string; planId: string; status: string }> = []

const store = {
  subscriptionCollection: {
    get all() { return subscriptions },
    loadAll: async () => {},
  },
  usageWalletCollection: { all: [], loadAll: async () => {} },
  usageEventCollection: { all: [], loadPage: async () => {} },
}
const http = { get: (url: string) => (url.includes('workspace-plan') ? planResponse() : Promise.resolve({})) }

mock.module('../../domain', () => ({ useSDKDomain: () => store, useSDKHttp: () => http }))

const { useBillingData } = await import('../useBillingData')

let latest: ReturnType<typeof useBillingData> | null = null
function Probe({ workspaceId }: { workspaceId: string }) {
  latest = useBillingData(workspaceId)
  return null
}

describe('useBillingData — model access vs. the plan lookup', () => {
  beforeEach(() => {
    installHappyDom()
    latest = null
    subscriptions = []
  })
  afterEach(() => cleanup())
  afterAll(() => restoreHappyDom())

  it('workspace-plan fails (500) → plan unknown, models not locked', async () => {
    planResponse = () => Promise.reject(new Error('HTTP 500'))
    render(<Probe workspaceId="ws-grant" />)
    await waitFor(() => expect(latest?.planLookupFailed).toBe(true))
    expect(latest?.hasAdvancedModelAccess).toBe(true)
  })

  it('workspace-plan answers an enterprise grant → unlocked, lookup ok', async () => {
    planResponse = () => Promise.resolve({ ok: true, planId: 'enterprise', source: 'grant' })
    render(<Probe workspaceId="ws-grant" />)
    await waitFor(() => expect(latest?.effectivePlanId).toBe('enterprise'))
    expect(latest?.hasAdvancedModelAccess).toBe(true)
    expect(latest?.planLookupFailed).toBe(false)
  })

  it('workspace-plan answers Free → locked (a real answer still locks)', async () => {
    planResponse = () => Promise.resolve({ ok: true, planId: 'free', source: 'free' })
    render(<Probe workspaceId="ws-free" />)
    await waitFor(() => expect(latest?.effectivePlanId).toBe('free'))
    expect(latest?.hasAdvancedModelAccess).toBe(false)
  })

  it('lookup fails but a real Basic subscription is loaded → stays locked', async () => {
    subscriptions = [{ workspaceId: 'ws-basic', planId: 'basic', status: 'active' }]
    planResponse = () => Promise.reject(new Error('HTTP 500'))
    render(<Probe workspaceId="ws-basic" />)
    await waitFor(() => expect(latest?.planLookupFailed).toBe(true))
    expect(latest?.hasAdvancedModelAccess).toBe(false)
  })
})
