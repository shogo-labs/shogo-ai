// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Cluster-wide signup limits, keyed by IP *prefix* rather than by address.
 *
 * On 2026-11-17 (PT) an API-key farm made ~1,600 accounts in about an hour
 * (peak ~110/min) from 15 addresses. Better Auth's own `/sign-up/email` rule
 * (3 per 10s) did not stop it for two reasons:
 *
 *   1. its limiter stores counters in process memory, so the limit was really
 *      "3 per 10s per pod" across 8 API pods, and
 *   2. it keys on the raw address, and 1,108 of the signups came from WARP
 *      egress spread over only 10 IPv6 /64s (~110 each).
 *
 * So the counters live in the shared Redis (`takeRateLimit`, which falls back
 * to process memory when Redis is down) and the key is the IPv4 address or the
 * IPv6 /64 — the same prefix the risk scorer clusters on. WARP is not blocked;
 * the daily cap just bounds it.
 *
 * Legit baseline over the 30 days before the incident: the most signups from
 * one prefix in one day was 14 (p99.9 = 12.5), so 20/day leaves headroom.
 */

import { takeRateLimit } from './chat-limits'
import { readSignupRequestInfo, type HeaderSource } from '../services/signup-risk.service'

/**
 * Named limits, all per IP prefix unless noted. Windows are fixed (a bucket
 * boundary, not a rolling window) because that is what `takeRateLimit` does;
 * the daily cap is therefore per UTC day.
 */
export const SIGNUP_RATE_LIMITS = {
  /** Burst: today's 3-per-10s, now shared across the cluster. */
  burst: { max: 3, windowMs: 10_000 },
  /** Daily ceiling per prefix. Legit max observed: 14. */
  daily: { max: 20, windowMs: 24 * 60 * 60 * 1000 },
  /** Verification resends per email address, so a held bot can't spam. */
  verificationEmail: { max: 3, windowMs: 60 * 60 * 1000 },
} as const

export interface SignupLimitVerdict {
  allowed: boolean
  /** Seconds until the window that refused resets. */
  retryAfterSeconds: number
}

const ALLOWED: SignupLimitVerdict = { allowed: true, retryAfterSeconds: 0 }

/** Matches Better Auth's `rateLimit.enabled`: production only. */
export function signupLimitsEnabled(): boolean {
  return process.env.NODE_ENV === 'production'
}

/**
 * Count one signup against the burst and daily limits for the caller's prefix.
 * A request with no resolvable IP is allowed: refusing it would break local
 * and test traffic, and the risk scorer still sees it.
 */
export async function checkSignupRateLimit(
  headers: HeaderSource,
  opts: { bypass?: boolean } = {},
): Promise<SignupLimitVerdict> {
  if (!signupLimitsEnabled()) return ALLOWED
  if (opts.bypass) return ALLOWED

  const info = readSignupRequestInfo(headers)
  if (info.e2eAllowlisted) return ALLOWED
  const prefix = info.ipPrefix
  if (!prefix) return ALLOWED

  const burst = await takeRateLimit(
    `signup:burst:${prefix}`,
    SIGNUP_RATE_LIMITS.burst.max,
    SIGNUP_RATE_LIMITS.burst.windowMs,
  )
  if (!burst.allowed) return { allowed: false, retryAfterSeconds: burst.retryAfterSeconds }

  const daily = await takeRateLimit(
    `signup:daily:${prefix}`,
    SIGNUP_RATE_LIMITS.daily.max,
    SIGNUP_RATE_LIMITS.daily.windowMs,
  )
  if (!daily.allowed) return { allowed: false, retryAfterSeconds: daily.retryAfterSeconds }

  return ALLOWED
}

/**
 * Count one verification-email send against the per-address limit and the
 * caller's daily prefix cap. The prefix cap is shared with signups on purpose:
 * a farm that can't sign up shouldn't be able to resend either.
 */
export async function checkVerificationEmailRateLimit(
  headers: HeaderSource,
  email: string,
  opts: { bypass?: boolean } = {},
): Promise<SignupLimitVerdict> {
  if (!signupLimitsEnabled()) return ALLOWED
  if (opts.bypass) return ALLOWED

  const info = readSignupRequestInfo(headers)
  if (info.e2eAllowlisted) return ALLOWED

  const address = email.trim().toLowerCase()
  if (address) {
    const perEmail = await takeRateLimit(
      `signup:verify-email:${address}`,
      SIGNUP_RATE_LIMITS.verificationEmail.max,
      SIGNUP_RATE_LIMITS.verificationEmail.windowMs,
    )
    if (!perEmail.allowed) return { allowed: false, retryAfterSeconds: perEmail.retryAfterSeconds }
  }

  if (info.ipPrefix) {
    const daily = await takeRateLimit(
      `signup:daily:${info.ipPrefix}`,
      SIGNUP_RATE_LIMITS.daily.max,
      SIGNUP_RATE_LIMITS.daily.windowMs,
    )
    if (!daily.allowed) return { allowed: false, retryAfterSeconds: daily.retryAfterSeconds }
  }

  return ALLOWED
}
