// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The signup trust hold (SHO-416): every branch of the decision, the cache and
 * its invalidation, the billing-workspace resolution, and the 403 the AI proxy
 * throws for a held key.
 *
 * `resolveHold` is pure, so the branch table is tested without a database. The
 * async paths take a structural client, which is what `mintDeviceApiKey` passes
 * through, so a plain object stands in for Prisma here.
 */

import { beforeEach, describe, expect, test } from 'bun:test'
import {
  _clearSignupTrustCacheForTests,
  getBillingWorkspaceTrustHold,
  getSignupTrustHold,
  invalidateSignupTrustHold,
  resolveHold,
  SIGNUP_TRUST_MESSAGES,
  SignupTrustHoldError,
  signupTrustHoldPayload,
  type SignupTrustClient,
} from '../signup-trust'

const HIGH_UNVERIFIED = { band: 'high', reviewDecision: null, signals: { provider: 'credential' } }
const HIGH_VERIFIED = { band: 'high', reviewDecision: null, signals: { provider: 'credential' } }

describe('resolveHold (pure)', () => {
  test('no assessment row: not held (legacy users and scoring failures stay as they were)', () => {
    expect(resolveHold(null, false)).toBeNull()
    expect(resolveHold(null, true)).toBeNull()
  })

  test('an admin approval releases the hold', () => {
    expect(resolveHold({ ...HIGH_UNVERIFIED, reviewDecision: 'approved' }, false)).toBeNull()
  })

  test('a social sign-in is verified by the provider, so it is never held', () => {
    expect(resolveHold({ band: 'high', reviewDecision: null, signals: { provider: 'social' } }, false)).toBeNull()
  })

  test('medium and low bands are not held', () => {
    for (const band of ['medium', 'low']) {
      expect(resolveHold({ band, reviewDecision: null, signals: { provider: 'credential' } }, false)).toBeNull()
      expect(resolveHold({ band, reviewDecision: null, signals: { provider: 'credential' } }, true)).toBeNull()
    }
  })

  test('high band + unverified email: email_verification_required', () => {
    expect(resolveHold(HIGH_UNVERIFIED, false)).toBe('email_verification_required')
  })

  test('high band + verified email: account_review_required (the re-score kept it high)', () => {
    expect(resolveHold(HIGH_VERIFIED, true)).toBe('account_review_required')
  })

  test('a missing signals object is treated as a credential signup', () => {
    expect(resolveHold({ band: 'high', reviewDecision: null, signals: null }, false)).toBe(
      'email_verification_required',
    )
  })
})

/** A client double that records how many times it was read. */
function stubClient(opts: {
  assessment?: Record<string, unknown> | null
  emailVerified?: boolean
  ownerUserId?: string | null
}) {
  const reads = { assessment: 0, user: 0, member: 0 }
  const client: SignupTrustClient = {
    signupRiskAssessment: {
      findUnique: async () => {
        reads.assessment++
        return opts.assessment ?? null
      },
    },
    user: {
      findUnique: async () => {
        reads.user++
        return { emailVerified: opts.emailVerified ?? false }
      },
    },
    member: {
      findFirst: async () => {
        reads.member++
        return opts.ownerUserId === undefined ? null : { userId: opts.ownerUserId }
      },
    },
  }
  return { client, reads }
}

beforeEach(() => {
  _clearSignupTrustCacheForTests()
  // The desktop runtime that spawns this shell exports SHOGO_LOCAL_MODE=true,
  // and the gate is a no-op there. Pin it off so the branches are reachable;
  // the local-mode test below flips it back.
  process.env.SHOGO_LOCAL_MODE = 'false'
})

describe('getSignupTrustHold', () => {
  test('local mode is a no-op, not a fork', async () => {
    process.env.SHOGO_LOCAL_MODE = 'true'
    const { client, reads } = stubClient({ assessment: HIGH_UNVERIFIED, emailVerified: false })
    expect(await getSignupTrustHold('u-1', client)).toBeNull()
    expect(reads.assessment).toBe(0)
    process.env.SHOGO_LOCAL_MODE = 'false'
  })

  test('returns the hold for a high-band unverified account', async () => {
    const { client } = stubClient({ assessment: HIGH_UNVERIFIED, emailVerified: false })
    expect(await getSignupTrustHold('u-1', client)).toBe('email_verification_required')
  })

  test('returns account_review_required once the email is verified', async () => {
    const { client } = stubClient({ assessment: HIGH_VERIFIED, emailVerified: true })
    expect(await getSignupTrustHold('u-1', client)).toBe('account_review_required')
  })

  test('caches the answer: a second call does not read the database', async () => {
    const { client, reads } = stubClient({ assessment: HIGH_UNVERIFIED, emailVerified: false })
    await getSignupTrustHold('u-1', client)
    await getSignupTrustHold('u-1', client)
    expect(reads.assessment).toBe(1)
    expect(reads.user).toBe(1)
  })

  test('invalidateSignupTrustHold forces a re-read (verification, admin approve/revoke)', async () => {
    const { client, reads } = stubClient({ assessment: HIGH_UNVERIFIED, emailVerified: false })
    await getSignupTrustHold('u-1', client)
    invalidateSignupTrustHold('u-1')
    await getSignupTrustHold('u-1', client)
    expect(reads.assessment).toBe(2)
  })

  test('an empty userId is never held', async () => {
    const { client, reads } = stubClient({ assessment: HIGH_UNVERIFIED })
    expect(await getSignupTrustHold('', client)).toBeNull()
    expect(reads.assessment).toBe(0)
  })

  // The read sits on the debit hot path: a database error there must not stop
  // every account from spending, and must not be retried on every request.
  test('a failing read fails open instead of throwing', async () => {
    const client: SignupTrustClient = {
      signupRiskAssessment: {
        findUnique: async () => {
          throw new Error('connection reset')
        },
      },
      user: { findUnique: async () => ({ emailVerified: false }) },
      member: { findFirst: async () => null },
    }
    expect(await getSignupTrustHold('u-1', client)).toBeNull()
  })

  test('a failing read is cached, so a persistent outage logs once per TTL', async () => {
    let reads = 0
    const client: SignupTrustClient = {
      signupRiskAssessment: {
        findUnique: async () => {
          reads++
          throw new Error('connection reset')
        },
      },
      user: { findUnique: async () => ({ emailVerified: false }) },
      member: { findFirst: async () => null },
    }
    await getSignupTrustHold('u-1', client)
    await getSignupTrustHold('u-1', client)
    expect(reads).toBe(1)
  })
})

describe('getBillingWorkspaceTrustHold', () => {
  test("the caller's own hold wins", async () => {
    const { client } = stubClient({ assessment: HIGH_UNVERIFIED, emailVerified: false, ownerUserId: 'owner-1' })
    expect(await getBillingWorkspaceTrustHold('ws-1', 'u-1', client)).toBe('email_verification_required')
  })

  test("a clean caller still inherits the wallet owner's hold", async () => {
    // The caller has no assessment; the owner does.
    const client: SignupTrustClient = {
      signupRiskAssessment: {
        findUnique: async ({ where }: any) =>
          where.userId === 'owner-1' ? HIGH_UNVERIFIED : null,
      },
      user: { findUnique: async () => ({ emailVerified: false }) },
      member: { findFirst: async () => ({ userId: 'owner-1' }) },
    }
    expect(await getBillingWorkspaceTrustHold('ws-1', 'u-1', client)).toBe('email_verification_required')
  })

  test('nobody held: null', async () => {
    const { client } = stubClient({ assessment: null, ownerUserId: 'owner-1' })
    expect(await getBillingWorkspaceTrustHold('ws-1', 'u-1', client)).toBeNull()
  })

  test('the owner is not looked up twice when the caller is the owner', async () => {
    const { client, reads } = stubClient({ assessment: null, ownerUserId: 'u-1' })
    expect(await getBillingWorkspaceTrustHold('ws-1', 'u-1', client)).toBeNull()
    expect(reads.assessment).toBe(1)
  })

  test('a workspace with no owner row is not held', async () => {
    const { client } = stubClient({ assessment: null, ownerUserId: null })
    expect(await getBillingWorkspaceTrustHold('ws-1', 'u-1', client)).toBeNull()
  })
})

describe('the 403 payload', () => {
  test('carries the code and a message the client can show', () => {
    for (const hold of ['email_verification_required', 'account_review_required'] as const) {
      const payload = signupTrustHoldPayload(hold)
      expect(payload.error.code).toBe(hold)
      expect(payload.error.message).toBe(SIGNUP_TRUST_MESSAGES[hold])
      expect(payload.error.message.length).toBeGreaterThan(20)
    }
  })

  test('SignupTrustHoldError is a 403 with that body', async () => {
    const err = new SignupTrustHoldError('email_verification_required')
    expect(err.status).toBe(403)
    expect(err.hold).toBe('email_verification_required')
    const res = err.getResponse()
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual(signupTrustHoldPayload('email_verification_required'))
  })
})
