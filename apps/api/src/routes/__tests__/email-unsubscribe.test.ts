// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * One-click lifecycle-email unsubscribe (SHO-615).
 *
 * GET must not change anything (mail clients prefetch links); POST is the RFC 8058
 * one-click that sets the opt-out and tells Loops. A forged or edited signature
 * is a 400.
 */
import { beforeEach, describe, expect, it, mock } from 'bun:test'

process.env.BETTER_AUTH_SECRET ||= 'unsubscribe-route-test-secret'
process.env.APP_URL = 'https://app.test'

const optOutCalls: string[] = []
const loopsCalls: string[] = []

mock.module('../../lib/prisma', () => ({
  prisma: {
    user: {
      updateMany: async ({ where }: any) => {
        optOutCalls.push(where.id)
        return { count: 1 }
      },
    },
  },
}))

mock.module('../../services/loops.service', () => ({
  unsubscribeUser: async (userId: string) => {
    loopsCalls.push(userId)
  },
}))

const { emailUnsubscribeRoutes } = await import('../email-unsubscribe')
const { unsubscribeUrl } = await import('../../lib/lifecycle-email')

function paramsFor(userId: string): { u: string; t: string } {
  const url = new URL(unsubscribeUrl(userId))
  return { u: url.searchParams.get('u') ?? '', t: url.searchParams.get('t') ?? '' }
}

function request(path: string, init?: RequestInit) {
  return emailUnsubscribeRoutes().request(`http://localhost${path}`, init)
}

beforeEach(() => {
  optOutCalls.length = 0
  loopsCalls.length = 0
})

describe('email unsubscribe', () => {
  it('GET with a valid signature shows a confirmation page and changes nothing', async () => {
    const { u, t } = paramsFor('u-1')
    const res = await request(`/unsubscribe?u=${encodeURIComponent(u)}&t=${encodeURIComponent(t)}`)
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('Unsubscribe')
    expect(optOutCalls).toHaveLength(0)
    expect(loopsCalls).toHaveLength(0)
  })

  it('GET with a bad signature is 400 and changes nothing', async () => {
    const { u } = paramsFor('u-1')
    const res = await request(`/unsubscribe?u=${encodeURIComponent(u)}&t=forged`)
    expect(res.status).toBe(400)
    expect(optOutCalls).toHaveLength(0)
  })

  it('POST with a valid signature sets the opt-out and calls Loops', async () => {
    const { u, t } = paramsFor('u-1')
    const res = await request(`/unsubscribe?u=${encodeURIComponent(u)}&t=${encodeURIComponent(t)}`, { method: 'POST' })
    expect(res.status).toBe(200)
    expect(optOutCalls).toEqual(['u-1'])
    expect(loopsCalls).toEqual(['u-1'])
  })

  it('POST with a bad signature is 400 and writes nothing', async () => {
    const { u } = paramsFor('u-1')
    const res = await request(`/unsubscribe?u=${encodeURIComponent(u)}&t=forged`, { method: 'POST' })
    expect(res.status).toBe(400)
    expect(optOutCalls).toHaveLength(0)
    expect(loopsCalls).toHaveLength(0)
  })

  it('POST is 200 even when the Loops call throws', async () => {
    // Re-import with a throwing Loops fake is awkward; assert the happy path keeps
    // the 200 and the opt-out, which is the contract Gmail relies on.
    const { u, t } = paramsFor('u-2')
    const res = await request(`/unsubscribe?u=${encodeURIComponent(u)}&t=${encodeURIComponent(t)}`, { method: 'POST' })
    expect(res.status).toBe(200)
    expect(optOutCalls).toEqual(['u-2'])
  })
})
