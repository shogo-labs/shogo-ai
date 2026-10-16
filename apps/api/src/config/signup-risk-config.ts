// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Signup risk scoring configuration.
 *
 * Pure data: no Prisma, no env reads. `services/signup-risk-scoring.ts` and
 * `scripts/backfill-signup-risk.ts` both import from here, so the production
 * calibration run scores with exactly the weights the live hook uses.
 *
 * Weights and bands were calibrated against the production abuse clusters
 * (read-only analysis, Oct 2026). See `scripts/backfill-signup-risk.ts`.
 */

export type SignupRiskBand = 'low' | 'medium' | 'high'

/** Score weights. Positive = more suspicious, negative = trusted signal. */
export const SIGNUP_RISK_WEIGHTS = {
  disposableDomain: 45,
  canonicalEmailCollision: 50,
  deviceLinkedToOtherAccount: 60,
  /** Other accounts from the same IP / IPv6 /64 in the last 30 days (2 to 3). */
  ipCluster2: 20,
  /** Other accounts from the same IP / IPv6 /64 in the last 30 days (4 or more). */
  ipCluster4: 40,
  /** Another signup from the same IP or device in the last 10 minutes. */
  signupBurst10m: 20,
  randomLookingLocalPart: 15,
  /** Google / Apple sign-in: the provider has already verified the mailbox. */
  trustedOAuthProvider: -15,
} as const

/** Band thresholds. `score < medium` is low; `score >= high` is high. */
export const SIGNUP_RISK_BANDS = {
  medium: 30,
  high: 60,
} as const

export const SIGNUP_RISK_WINDOW_DAYS = 30
export const SIGNUP_RISK_BURST_MINUTES = 10

/**
 * Well-known disposable / throwaway mail providers. Each one adds the
 * `disposableDomain` weight. Disposable addresses can receive the verification
 * email, so a disposable signup never earns the verification-based credit.
 */
export const DISPOSABLE_EMAIL_DOMAINS: ReadonlySet<string> = new Set([
  'yopmail.com',
  'mailinator.com',
  'guerrillamail.com',
  'guerrillamailblock.com',
  '10minutemail.com',
  'tempmail.com',
  'temp-mail.org',
  'trashmail.com',
  'sharklasers.com',
  'maildrop.cc',
  'getnada.com',
  'throwawaymail.com',
  'mailnull.com',
])

/**
 * Hard-blocked at signup (rejected in `user.create.before`). Built from our own
 * production farm data: every domain here had several accounts, zero Google
 * sign-ins and zero paid subscriptions (checked Oct 2026). A signup carrying
 * the e2e bootstrap secret is exempt, so hosted suites keep their test domain.
 */
export const BLOCKED_EMAIL_DOMAINS: ReadonlySet<string> = new Set([
  'hidepost.net',
  'hidesit.net',
  'telegmail.com',
  'minitts.net',
  'prodbits.com',
  'robustq.com',
  'kolsea.com',
  'pumpoly.com',
  'hebase.com',
  'ncleap.com',
  'liondapt.com',
  'bocably.com',
  'necub.com',
  'novelv.com',
  'slotbeer.com',
  'kingdais.com',
  'hudzer.com',
  'fanzher.com',
  'omanarts.com',
  'caps7.com',
  'fidhost.com',
  'crybio.com',
  'hiredify.com',
  '94an.com',
  'duidir.com',
  'dreameg.com',
  'bitproy.com',
  'pointsta.com',
  'dd2car.com',
  'archifun.com',
  'sssonar.com',
  'mapsguy.com',
])

/** Domains whose local-part dots and plus tags are not significant. */
export const GMAIL_DOMAINS: ReadonlySet<string> = new Set(['gmail.com', 'googlemail.com'])

/**
 * Random-looking local parts seen in the farms:
 *  - 8 characters of lowercase letters and digits with both kinds present
 *    (e.g. `vjb76ptj`). Pure-letter names are excluded so real names such as
 *    `johnsmit` are not flagged.
 *  - `adjective.animal.xxxx` (e.g. `good.herring.mvdu`).
 */
export const RANDOM_LOCAL_PART_PATTERNS: readonly RegExp[] = [
  /^(?=.*\d)(?=.*[a-z])[a-z0-9]{8}$/,
  /^[a-z]+\.[a-z]+\.[a-z0-9]{4}$/,
]
