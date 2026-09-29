// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, test, expect, beforeEach, mock } from 'bun:test'

let planImpl: () => Promise<string>
let canPublishImpl: () => Promise<boolean>

mock.module('../../services/billing.service', () => ({
  getEffectivePlanId: () => planImpl(),
  canPublishSubdomain: () => canPublishImpl(),
}))

const { stampWorkspacePlan } = await import('../stamp-workspace-plan')

beforeEach(() => {
  planImpl = async () => 'free'
  canPublishImpl = async () => false
})

describe('stampWorkspacePlan', () => {
  test('stamps the plan and whether subdomain publishing is allowed', async () => {
    const body: any = {}
    await stampWorkspacePlan(body, 'ws-1')
    expect(body).toEqual({ planId: 'free', canPublishSubdomain: false })
  })

  test('clears both fields when the billing lookup fails', async () => {
    planImpl = async () => { throw new Error('db down') }
    const body: any = { planId: 'pro', canPublishSubdomain: true }
    await stampWorkspacePlan(body, 'ws-1')
    expect('planId' in body).toBe(false)
    expect('canPublishSubdomain' in body).toBe(false)
  })
})
