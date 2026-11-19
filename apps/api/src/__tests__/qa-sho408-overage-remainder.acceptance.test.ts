// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-408 acceptance: the routed `chargeOverage` provision op.
 *
 * The `customer.subscription.deleted` webhook lands in whichever region serves
 * it, so the final overage invoice is raised through
 * `POST /api/internal/billing/provision { op: 'chargeOverage', reason }` on the
 * wallet's home region. This pins the route's dispatch: the reason is passed
 * through (and an unknown reason falls back to 'block'), and the response
 * carries `{ invoiced }` so the caller can report it.
 *
 *   bun test apps/api/src/__tests__/qa-sho408-overage-remainder.acceptance.test.ts
 */

import { describe, test, expect, mock, beforeEach } from 'bun:test'

const SECRET = 'test-internal-secret'
process.env.SHOGO_INTERNAL_SECRET = SECRET

const chargeCalls: Array<{ workspaceId: string; reason: string | undefined }> = []
let chargeResult = 1

mock.module('../services/billing.service', () => ({
  chargeOverageBlocks: async (workspaceId: string, opts?: { reason?: string }) => {
    chargeCalls.push({ workspaceId, reason: opts?.reason })
    return chargeResult
  },
}))

const app = (await import('../routes/internal')).default

function provision(body: unknown, secret = SECRET) {
  return app.request('/billing/provision', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-shogo-internal-secret': secret },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  chargeCalls.length = 0
  chargeResult = 1
})

describe('POST /api/internal/billing/provision — chargeOverage (SHO-408)', () => {
  test('dispatches a final charge with its reason and returns the count', async () => {
    const res = await provision({ op: 'chargeOverage', workspaceId: 'ws-1', reason: 'final' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ invoiced: 1 })
    expect(chargeCalls).toEqual([{ workspaceId: 'ws-1', reason: 'final' }])
  })

  test('passes a cap reason through', async () => {
    chargeResult = 0
    const res = await provision({ op: 'chargeOverage', workspaceId: 'ws-2', reason: 'cap' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ invoiced: 0 })
    expect(chargeCalls).toEqual([{ workspaceId: 'ws-2', reason: 'cap' }])
  })

  test('an unknown reason falls back to the block path', async () => {
    await provision({ op: 'chargeOverage', workspaceId: 'ws-3', reason: 'nonsense' })
    expect(chargeCalls).toEqual([{ workspaceId: 'ws-3', reason: 'block' }])
  })

  test('rejects a request without the internal secret', async () => {
    const res = await provision({ op: 'chargeOverage', workspaceId: 'ws-4', reason: 'final' }, 'wrong')
    expect(res.status).toBe(401)
    expect(chargeCalls).toHaveLength(0)
  })
})
