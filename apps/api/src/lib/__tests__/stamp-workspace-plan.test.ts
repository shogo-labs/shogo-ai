// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test'

let planImpl: () => Promise<string>
let canPublishImpl: () => Promise<boolean>
let alwaysOnImpl: () => Promise<number>

mock.module('../../services/billing.service', () => ({
  getEffectivePlanId: () => planImpl(),
  canPublishSubdomain: () => canPublishImpl(),
  getAlwaysOnAllowanceForWorkspace: () => alwaysOnImpl(),
}))

const { stampWorkspacePlan, buildPublishHostingStamp } = await import('../stamp-workspace-plan')

const originalSubstrate = process.env.PUBLISH_SUBSTRATE
// The desktop app exports SHOGO_LOCAL_MODE=true, so a plain `bun test` on a
// desktop checkout would otherwise run every cloud case against the desktop
// stamp. Pin it per test and restore it, like the other local-mode suites.
const originalLocalMode = process.env.SHOGO_LOCAL_MODE

beforeEach(() => {
  planImpl = async () => 'free'
  canPublishImpl = async () => false
  alwaysOnImpl = async () => 0
  delete process.env.PUBLISH_SUBSTRATE
  delete process.env.SHOGO_LOCAL_MODE
})

afterEach(() => {
  if (originalSubstrate === undefined) delete process.env.PUBLISH_SUBSTRATE
  else process.env.PUBLISH_SUBSTRATE = originalSubstrate
  if (originalLocalMode === undefined) delete process.env.SHOGO_LOCAL_MODE
  else process.env.SHOGO_LOCAL_MODE = originalLocalMode
})

describe('stampWorkspacePlan', () => {
  test('stamps the plan, the publish gate and what hosting can do', async () => {
    alwaysOnImpl = async () => 2
    const body: any = {}
    await stampWorkspacePlan(body, 'ws-1')
    expect(body).toEqual({
      planId: 'free',
      canPublishSubdomain: false,
      publishHosting: { substrate: 'knative', alwaysOn: true, maxReplicas: 1, staging: false },
    })
  })

  test('clears every field when the billing lookup fails', async () => {
    planImpl = async () => { throw new Error('db down') }
    const body: any = { planId: 'pro', canPublishSubdomain: true, publishHosting: { substrate: 'knative' } }
    await stampWorkspacePlan(body, 'ws-1')
    expect('planId' in body).toBe(false)
    expect('canPublishSubdomain' in body).toBe(false)
    expect('publishHosting' in body).toBe(false)
  })
})

// The stamp is what lets the agent say "up to 5 replicas" / "staging available"
// — so it must never claim either where the substrate cannot provide it, and it
// must never claim more than the plan allows (SHO-362 AC3).
describe('buildPublishHostingStamp', () => {
  test('knative × plan caps', () => {
    expect(buildPublishHostingStamp('pro', 5)).toEqual({ substrate: 'knative', alwaysOn: true, maxReplicas: 5, staging: true })
    expect(buildPublishHostingStamp('business', 5)).toEqual({ substrate: 'knative', alwaysOn: true, maxReplicas: 20, staging: true })
    expect(buildPublishHostingStamp('free', 0)).toEqual({ substrate: 'knative', alwaysOn: false, maxReplicas: 1, staging: false })
    expect(buildPublishHostingStamp('enterprise', Infinity)).toEqual({ substrate: 'knative', alwaysOn: true, maxReplicas: null, staging: true })
  })

  test('metal runs one instance and has no staging, even on business', () => {
    process.env.PUBLISH_SUBSTRATE = 'metal'
    expect(buildPublishHostingStamp('business', 5)).toEqual({ substrate: 'metal', alwaysOn: true, maxReplicas: 1, staging: false })
  })

  // QA round 1: local mode returned `Infinity` for the always-on allowance and
  // an unset PUBLISH_SUBSTRATE, so desktop advertised "always-on; up to 5
  // replicas; staging available" while desktop publish is a static upload that
  // refuses server.tsx outright. Desktop must claim none of it.
  test('desktop claims no cloud capability, whatever the plan or allowance says', () => {
    process.env.SHOGO_LOCAL_MODE = 'true'
    try {
      expect(buildPublishHostingStamp('pro', Infinity)).toEqual({ substrate: 'desktop', alwaysOn: false, maxReplicas: 1, staging: false })
      expect(buildPublishHostingStamp('business', 5)).toEqual({ substrate: 'desktop', alwaysOn: false, maxReplicas: 1, staging: false })
      // Even with the metal escape hatch set, desktop is still desktop.
      process.env.PUBLISH_SUBSTRATE = 'metal'
      expect(buildPublishHostingStamp('business', 5).substrate).toBe('desktop')
    } finally {
      if (originalLocalMode === undefined) delete process.env.SHOGO_LOCAL_MODE
      else process.env.SHOGO_LOCAL_MODE = originalLocalMode
    }
  })

  test('an unknown plan falls back to the free caps rather than to unbounded', () => {
    expect(buildPublishHostingStamp('mystery', 0)).toEqual({ substrate: 'knative', alwaysOn: false, maxReplicas: 1, staging: false })
  })
})
