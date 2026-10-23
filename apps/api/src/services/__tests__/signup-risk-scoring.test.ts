// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Pure scorer tests. No database: every input is an explicit feature set.
 */
import { describe, expect, test } from 'bun:test'
import {
  bandForScore,
  isBlockedEmailDomain,
  scoreSignupRisk,
  type SignupRiskFeatures,
} from '../signup-risk-scoring'
import { BLOCKED_EMAIL_DOMAINS, SIGNUP_RISK_WEIGHTS } from '../../config/signup-risk-config'

function features(over: Partial<SignupRiskFeatures> = {}): SignupRiskFeatures {
  return {
    email: 'alice@company.io',
    provider: 'credential',
    emailVerified: false,
    allowlisted: false,
    canonicalCollisions: 0,
    deviceLinkedAccounts: 0,
    ipLinkedAccounts: 0,
    burstSignups: 0,
    ...over,
  }
}

describe('bandForScore', () => {
  test('score below medium is low, medium up to high, high at or above high', () => {
    expect(bandForScore(0)).toBe('low')
    expect(bandForScore(29)).toBe('low')
    expect(bandForScore(30)).toBe('medium')
    expect(bandForScore(59)).toBe('medium')
    expect(bandForScore(60)).toBe('high')
  })
})

describe('credit decisions for clean signups', () => {
  test('clean unverified credential signup gets the $2 initial stage, $8 on verification', () => {
    const r = scoreSignupRisk(features())
    expect(r.band).toBe('low')
    expect(r.decision).toBe('credit_initial')
    expect(r.initialCreditUsd).toBe(2)
    expect(r.verificationCreditUsd).toBe(8)
    expect(r.trialAllowed).toBe(true)
  })

  test('verified-at-signup account (Google) gets the full $10 now', () => {
    const r = scoreSignupRisk(features({ emailVerified: true, provider: 'social' }))
    expect(r.decision).toBe('credit_full')
    expect(r.initialCreditUsd).toBe(10)
    expect(r.verificationCreditUsd).toBe(0)
  })
})

describe('disposable and blocked domains', () => {
  test('disposable domain: no credit even though the band alone is only medium', () => {
    const r = scoreSignupRisk(features({ email: 'bob@yopmail.com' }))
    expect(r.disposableDomain).toBe(true)
    expect(r.score).toBe(SIGNUP_RISK_WEIGHTS.disposableDomain)
    expect(r.decision).toBe('no_credit')
    expect(r.initialCreditUsd).toBe(0)
    expect(r.verificationCreditUsd).toBe(0)
  })

  test('blocked domain (production abuse farm) is flagged and gets no credit', () => {
    const blocked = [...BLOCKED_EMAIL_DOMAINS][0]
    const email = `carol@${blocked}`
    expect(isBlockedEmailDomain(email)).toBe(true)
    const r = scoreSignupRisk(features({ email }))
    expect(r.blockedDomain).toBe(true)
    expect(r.decision).toBe('no_credit')
  })

  test('verification does not rescue a disposable domain', () => {
    const r = scoreSignupRisk(features({ email: 'dan@yopmail.com', emailVerified: true }))
    expect(r.decision).toBe('no_credit')
  })
})

describe('IP cluster weight is a tier, not additive', () => {
  test('one other account from the IP is still a 2-account cluster: +20', () => {
    const r = scoreSignupRisk(features({ ipLinkedAccounts: 1 }))
    expect(r.signals.map((s) => s.name)).toEqual(['ip_cluster_2plus'])
    expect(r.score).toBe(SIGNUP_RISK_WEIGHTS.ipCluster2)
  })

  test('three other accounts (4 total) is +40, not 20 + 20 + 20', () => {
    const r = scoreSignupRisk(features({ ipLinkedAccounts: 3 }))
    expect(r.signals.map((s) => s.name)).toEqual(['ip_cluster_4plus'])
    expect(r.score).toBe(SIGNUP_RISK_WEIGHTS.ipCluster4)
  })

  test('no other accounts from the IP adds nothing', () => {
    expect(scoreSignupRisk(features({ ipLinkedAccounts: 0 })).score).toBe(0)
  })
})

describe('bands and staged credit', () => {
  test('medium band with unverified email holds the credit until verification', () => {
    // 2-account IP cluster (+20) + a burst (+20) = 40 → medium.
    const r = scoreSignupRisk(features({ ipLinkedAccounts: 1, burstSignups: 1 }))
    expect(r.band).toBe('medium')
    expect(r.decision).toBe('credit_held')
    expect(r.initialCreditUsd).toBe(0)
    expect(r.verificationCreditUsd).toBe(10)
  })

  test('high band gets no credit and no trial', () => {
    // 4-account cluster (+40) + burst (+20) = 60 → high.
    const r = scoreSignupRisk(features({ ipLinkedAccounts: 3, burstSignups: 1 }))
    expect(r.band).toBe('high')
    expect(r.decision).toBe('no_credit')
    expect(r.trialAllowed).toBe(false)
  })

  test('a canonical email collision (another account with the same Gmail) is medium', () => {
    const r = scoreSignupRisk(features({ email: 'eve@gmail.com', canonicalCollisions: 1 }))
    expect(r.signals.map((s) => s.name)).toContain('canonical_email_collision')
    expect(r.band).toBe('medium')
  })

  test('a verified medium account gets the full $10 (verification clears the hold)', () => {
    const r = scoreSignupRisk(features({ ipLinkedAccounts: 1, burstSignups: 1, emailVerified: true }))
    expect(r.band).toBe('medium')
    expect(r.decision).toBe('credit_full')
    expect(r.initialCreditUsd).toBe(10)
  })
})

describe('allowlisted (e2e) signups', () => {
  test('score is zero and every penalty is ignored, even for a disposable domain', () => {
    const r = scoreSignupRisk(
      features({ email: 'e2e-x@mailnull.com', allowlisted: true, ipLinkedAccounts: 3, burstSignups: 1 }),
    )
    expect(r.score).toBe(0)
    expect(r.signals).toHaveLength(0)
    expect(r.allowlisted).toBe(true)
    expect(r.disposableDomain).toBe(false)
    expect(r.blockedDomain).toBe(false)
    expect(r.band).toBe('low')
    expect(r.decision).toBe('credit_initial')
  })
})

describe('trusted OAuth provider', () => {
  test('social sign-in lowers the score (never below zero)', () => {
    const r = scoreSignupRisk(features({ provider: 'social' }))
    expect(r.signals.map((s) => s.name)).toContain('trusted_oauth_provider')
    expect(r.score).toBe(0)
  })
})
