// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * SHO-339 — `create-phase5-prices.ts` must be idempotent on `lookup_key`:
 * a second run creates nothing, and the dry run creates nothing either.
 */

import { describe, expect, it } from 'bun:test'
import { PHASE5_PRICES, PHASE5_PRODUCTS, ensurePhase5Prices } from '../create-phase5-prices'

function fakeStripe(existing: Record<string, string> = {}) {
  const created: any[] = []
  const lookups: string[][] = []
  let nextId = 1
  const stripe = {
    prices: {
      list: async ({ lookup_keys }: { lookup_keys?: string[] }) => {
        lookups.push(lookup_keys ?? [])
        const key = lookup_keys?.[0]
        const id = key ? existing[key] : undefined
        return { data: id ? [{ id, unit_amount: 1000, recurring: { interval: 'month' } }] : [] }
      },
      create: async (params: any) => {
        created.push(params)
        const id = `price_created_${nextId++}`
        existing[params.lookup_key] = id
        return { id }
      },
    },
  }
  return { stripe, created, lookups }
}

describe('PHASE5_PRICES', () => {
  it('is the v2.5.0 ladder: Business $16/mo, $156/yr, Basic $78/yr', () => {
    const byKey = Object.fromEntries(PHASE5_PRICES.map((p) => [p.lookupKey, p]))
    expect(byKey['business_seat_monthly_v2'].unitAmount).toBe(1600)
    expect(byKey['business_seat_monthly_v2'].interval).toBe('month')
    expect(byKey['business_seat_annual_v2'].unitAmount).toBe(15600)
    expect(byKey['business_seat_annual_v2'].interval).toBe('year')
    expect(byKey['basic_annual_v2'].unitAmount).toBe(7800)
  })

  it('never recreates the $8 Basic monthly price', () => {
    expect(PHASE5_PRICES.map((p) => p.lookupKey)).not.toContain('shogo_basic_monthly_v2')
  })

  it('has a product id for every plan it prices, in both environments', () => {
    for (const env of ['staging', 'production'] as const) {
      for (const price of PHASE5_PRICES) {
        expect(PHASE5_PRODUCTS[env][price.plan]).toMatch(/^prod_/)
      }
    }
  })
})

describe('ensurePhase5Prices', () => {
  it('creates the three prices once, as licensed recurring prices', async () => {
    const { stripe, created } = fakeStripe()
    const results = await ensurePhase5Prices(stripe as any, { env: 'staging', dryRun: false })

    expect(created).toHaveLength(3)
    expect(results.every((r) => r.created)).toBe(true)
    for (const params of created) {
      expect(params.recurring.usage_type).toBe('licensed')
      expect(params.currency).toBe('usd')
      expect(params.transfer_lookup_key).toBe(true)
    }
    expect(created.map((p) => p.lookup_key).sort()).toEqual(
      ['basic_annual_v2', 'business_seat_annual_v2', 'business_seat_monthly_v2'],
    )
  })

  it('is idempotent: a re-run finds every price and creates nothing', async () => {
    const { stripe, created } = fakeStripe()
    await ensurePhase5Prices(stripe as any, { env: 'staging', dryRun: false })
    const firstCount = created.length

    const second = await ensurePhase5Prices(stripe as any, { env: 'staging', dryRun: false })
    expect(created).toHaveLength(firstCount)
    expect(second.every((r) => r.created === false)).toBe(true)
    expect(second.every((r) => r.priceId.startsWith('price_'))).toBe(true)
  })

  it('a dry run creates nothing', async () => {
    const { stripe, created } = fakeStripe()
    const results = await ensurePhase5Prices(stripe as any, { env: 'staging', dryRun: true })
    expect(created).toHaveLength(0)
    expect(results.every((r) => r.priceId === '(would create)')).toBe(true)
  })

  it('attaches each price to the product for its environment', async () => {
    const { stripe, created } = fakeStripe()
    await ensurePhase5Prices(stripe as any, { env: 'production', dryRun: false })
    const business = created.find((p) => p.lookup_key === 'business_seat_monthly_v2')
    const basic = created.find((p) => p.lookup_key === 'basic_annual_v2')
    expect(business.product).toBe(PHASE5_PRODUCTS.production.business)
    expect(basic.product).toBe(PHASE5_PRODUCTS.production.basic)
  })
})
