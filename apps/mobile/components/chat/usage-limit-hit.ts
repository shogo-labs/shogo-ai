// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The properties ChatPanel reports for `hit_cap` (SHO-614, G8).
 *
 * Kept pure and outside the component so the first-session rule and the
 * dedupe key are testable without mounting a 11 000-line panel: the event was
 * declared and never fired, so the numbers behind "a first build hit the free
 * cap" did not exist at all.
 */
import { isFirstSession } from '../../lib/account-age'

export interface UsageLimitHitInput {
  /** The account's `createdAt`, from the auth snapshot. */
  createdAt?: string | number | Date | null
  variant: 'blocked' | 'stopped'
  /** The rolling window that gated the turn, when the client knows it. */
  window?: 'five_hour' | 'weekly' | null
  emailVerified?: boolean
  promoPendingUsd?: number
  now?: number
}

export interface UsageLimitHitProps {
  first_session: boolean
  variant: 'blocked' | 'stopped'
  window: 'five_hour' | 'weekly' | null
  email_verified: boolean | null
  promo_pending_usd: number
}

export function usageLimitHitProps(input: UsageLimitHitInput): UsageLimitHitProps {
  return {
    first_session: isFirstSession(input.createdAt, input.now),
    variant: input.variant,
    window: input.window ?? null,
    email_verified: input.emailVerified ?? null,
    promo_pending_usd: input.promoPendingUsd ?? 0,
  }
}

/** One report per session + variant, so re-renders and retries don't spam. */
export function usageLimitHitKey(
  sessionId: string | null | undefined,
  variant: 'blocked' | 'stopped',
): string {
  return `${sessionId ?? 'no-session'}:${variant}`
}
