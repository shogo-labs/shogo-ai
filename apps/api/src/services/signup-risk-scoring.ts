// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Pure signup risk scorer. No database access, so every branch is unit
 * testable and the backfill script can run the exact same logic against
 * historical production data.
 *
 * The DB-backed feature collection lives in `signup-risk.service.ts`.
 */

import {
  BLOCKED_EMAIL_DOMAINS,
  DISPOSABLE_EMAIL_DOMAINS,
  EXTRA_BLOCKED_EMAIL_DOMAINS,
  RANDOM_LOCAL_PART_PATTERNS,
  SIGNUP_RISK_BANDS,
  SIGNUP_RISK_WEIGHTS,
  type SignupRiskBand,
} from '../config/signup-risk-config'
import { GENERATED_DISPOSABLE_DOMAINS } from '../config/disposable-domains.generated'
import {
  SIGNUP_CREDIT_INITIAL_USD,
  SIGNUP_CREDIT_TOTAL_USD,
} from '../config/usage-plans'
import { emailDomain, emailLocalPartWithoutTag } from '../lib/email-canonical'

export type SignupProvider = 'credential' | 'social'

/** Facts about one signup, gathered before scoring. */
export interface SignupRiskFeatures {
  /** Raw email as typed or returned by the provider. */
  email: string
  provider: SignupProvider
  /** Provider or request already marked the email verified at signup. */
  emailVerified: boolean
  /** Request carried a valid e2e bootstrap secret. Skips every penalty. */
  allowlisted: boolean
  /** Other users whose canonical email matches this one. */
  canonicalCollisions: number
  /** Other accounts created with the same device id in the window. */
  deviceLinkedAccounts: number
  /** Other accounts created from the same IP / IPv6 /64 in the window. */
  ipLinkedAccounts: number
  /** Other signups from the same IP or device in the burst window. */
  burstSignups: number
}

export interface SignupRiskSignal {
  name: string
  weight: number
}

export type SignupCreditDecision =
  | 'credit_full'
  | 'credit_initial'
  | 'credit_held'
  | 'no_credit'

export interface SignupRiskResult {
  score: number
  band: SignupRiskBand
  signals: SignupRiskSignal[]
  disposableDomain: boolean
  blockedDomain: boolean
  randomLocalPart: boolean
  allowlisted: boolean
  decision: SignupCreditDecision
  /** Promo credit granted now, in USD. */
  initialCreditUsd: number
  /** Promo credit that will be released when the email is verified. */
  verificationCreditUsd: number
  /** Trial eligibility is based on band only; the checkout route also checks redemptions. */
  trialAllowed: boolean
}

export function bandForScore(score: number): SignupRiskBand {
  if (score >= SIGNUP_RISK_BANDS.high) return 'high'
  if (score >= SIGNUP_RISK_BANDS.medium) return 'medium'
  return 'low'
}

/**
 * True when the address's domain — or any parent of it — is on one of the
 * blocklists. Walking parents means `mail.mailinator.com` is blocked by
 * `mailinator.com`, and `x.0-mailer.dynv6.net` by `0-mailer.dynv6.net`,
 * without needing an entry per subdomain.
 *
 * The lists: our own farm domains, the well-known disposable providers, the
 * vendors' farm domains and the 10k-entry community blocklist. Signup rejects
 * all of them (SHO-258 §8).
 */
export function isBlockedEmailDomain(email: string): boolean {
  const domain = emailDomain(email)
  if (!domain) return false
  const labels = domain.split('.')
  // Stop at the registrable domain: never test a bare TLD.
  for (let i = 0; i <= labels.length - 2; i++) {
    const candidate = labels.slice(i).join('.')
    if (
      BLOCKED_EMAIL_DOMAINS.has(candidate) ||
      DISPOSABLE_EMAIL_DOMAINS.has(candidate) ||
      EXTRA_BLOCKED_EMAIL_DOMAINS.has(candidate) ||
      GENERATED_DISPOSABLE_DOMAINS.has(candidate)
    ) {
      return true
    }
  }
  return false
}

export function isDisposableEmailDomain(email: string): boolean {
  return DISPOSABLE_EMAIL_DOMAINS.has(emailDomain(email))
}

export function hasRandomLookingLocalPart(email: string): boolean {
  const local = emailLocalPartWithoutTag(email)
  return RANDOM_LOCAL_PART_PATTERNS.some((re) => re.test(local))
}

/**
 * IP cluster weight. `ipLinkedAccounts` counts other accounts, so the
 * account being scored is added back in: 2 accounts total is +20, and 4 or
 * more is +40 (a tier, not additive).
 */
function ipClusterWeight(otherAccounts: number): number {
  const total = otherAccounts + 1
  if (total >= 4) return SIGNUP_RISK_WEIGHTS.ipCluster4
  if (total >= 2) return SIGNUP_RISK_WEIGHTS.ipCluster2
  return 0
}

export function scoreSignupRisk(f: SignupRiskFeatures): SignupRiskResult {
  const blockedDomain = isBlockedEmailDomain(f.email)
  // A blocked domain is also disposable. The hard block normally rejects it
  // before scoring; this covers the allowlisted path.
  const disposableDomain = isDisposableEmailDomain(f.email) || blockedDomain
  const randomLocalPart = hasRandomLookingLocalPart(f.email)

  // Allowlisted (e2e) signups are scored as clean, low risk.
  if (f.allowlisted) {
    return finalize(f, [], {
      disposableDomain: false,
      blockedDomain: false,
      randomLocalPart: false,
      allowlisted: true,
    })
  }

  const signals: SignupRiskSignal[] = []
  const add = (name: string, weight: number) => {
    if (weight !== 0) signals.push({ name, weight })
  }

  if (disposableDomain) add('disposable_domain', SIGNUP_RISK_WEIGHTS.disposableDomain)
  if (f.canonicalCollisions > 0) add('canonical_email_collision', SIGNUP_RISK_WEIGHTS.canonicalEmailCollision)
  if (f.deviceLinkedAccounts > 0) add('device_linked_account', SIGNUP_RISK_WEIGHTS.deviceLinkedToOtherAccount)
  const ipWeight = ipClusterWeight(f.ipLinkedAccounts)
  if (ipWeight === SIGNUP_RISK_WEIGHTS.ipCluster4) add('ip_cluster_4plus', ipWeight)
  else if (ipWeight === SIGNUP_RISK_WEIGHTS.ipCluster2) add('ip_cluster_2plus', ipWeight)
  if (f.burstSignups > 0) add('signup_burst_10m', SIGNUP_RISK_WEIGHTS.signupBurst10m)
  if (randomLocalPart) add('random_local_part', SIGNUP_RISK_WEIGHTS.randomLookingLocalPart)
  // Social sign-in is only Google and Apple (see `auth.ts`), both of which
  // verify the mailbox before Shogo sees it.
  if (f.provider === 'social') add('trusted_oauth_provider', SIGNUP_RISK_WEIGHTS.trustedOAuthProvider)

  return finalize(f, signals, {
    disposableDomain,
    blockedDomain,
    randomLocalPart,
    allowlisted: false,
  })
}

function finalize(
  f: SignupRiskFeatures,
  signals: SignupRiskSignal[],
  flags: Pick<SignupRiskResult, 'disposableDomain' | 'blockedDomain' | 'randomLocalPart' | 'allowlisted'>,
): SignupRiskResult {
  const raw = signals.reduce((sum, s) => sum + s.weight, 0)
  const score = Math.max(0, raw)
  const band = bandForScore(score)

  // Credit rules. Disposable and high-band accounts never receive credit now or
  // on verification. Verified-at-signup accounts (Google, Apple, or an
  // already-verified email) get the full amount immediately. Otherwise the
  // amount is staged: low gets the initial stage now, medium waits for
  // verification.
  let decision: SignupCreditDecision
  let initialCreditUsd: number
  let verificationCreditUsd: number
  if (band === 'high' || (flags.disposableDomain && !flags.allowlisted)) {
    decision = 'no_credit'
    initialCreditUsd = 0
    verificationCreditUsd = 0
  } else if (f.emailVerified) {
    decision = 'credit_full'
    initialCreditUsd = SIGNUP_CREDIT_TOTAL_USD
    verificationCreditUsd = 0
  } else if (band === 'low') {
    decision = 'credit_initial'
    initialCreditUsd = SIGNUP_CREDIT_INITIAL_USD
    verificationCreditUsd = SIGNUP_CREDIT_TOTAL_USD - SIGNUP_CREDIT_INITIAL_USD
  } else {
    decision = 'credit_held'
    initialCreditUsd = 0
    verificationCreditUsd = SIGNUP_CREDIT_TOTAL_USD
  }

  return {
    score,
    band,
    signals,
    ...flags,
    decision,
    initialCreditUsd,
    verificationCreditUsd,
    trialAllowed: band !== 'high',
  }
}
