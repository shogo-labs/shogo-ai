// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * What ChatPanel reports when a usage cap stops a turn (SHO-614, G8).
 *
 * The event was declared and never fired, so the answer to "how often does a
 * first build hit the free cap" did not exist. These are the properties that
 * answer it, kept pure so they can be tested without the panel.
 */
import { describe, expect, test } from 'bun:test'
import { usageLimitHitKey, usageLimitHitProps } from '../usage-limit-hit'

/** 2026-11-29T12:00:00Z. Every case injects `now`, so this file never reads the clock. */
const NOW = 1_795_953_600_000
const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS

describe('usageLimitHitProps', () => {
  test('marks an account younger than 24 hours as a first session', () => {
    const props = usageLimitHitProps({
      createdAt: new Date(NOW - HOUR_MS).toISOString(),
      variant: 'blocked',
      window: 'weekly',
      emailVerified: false,
      promoPendingUsd: 8,
      now: NOW,
    })
    expect(props).toEqual({
      first_session: true,
      variant: 'blocked',
      window: 'weekly',
      email_verified: false,
      promo_pending_usd: 8,
    })
  })

  test('marks an older account as not a first session', () => {
    const props = usageLimitHitProps({
      createdAt: new Date(NOW - 9 * DAY_MS),
      variant: 'stopped',
      now: NOW,
    })
    expect(props.first_session).toBe(false)
    expect(props.variant).toBe('stopped')
    expect(props.window).toBeNull()
    expect(props.email_verified).toBeNull()
    expect(props.promo_pending_usd).toBe(0)
  })

  test('a missing or unparseable createdAt is not a first session', () => {
    expect(usageLimitHitProps({ createdAt: null, variant: 'blocked', now: NOW }).first_session).toBe(false)
    expect(usageLimitHitProps({ createdAt: 'garbage', variant: 'blocked', now: NOW }).first_session).toBe(false)
  })
})

describe('usageLimitHitKey', () => {
  test('one report per session and variant', () => {
    expect(usageLimitHitKey('s-1', 'blocked')).toBe('s-1:blocked')
    expect(usageLimitHitKey('s-1', 'stopped')).toBe('s-1:stopped')
    expect(usageLimitHitKey(null, 'blocked')).toBe('no-session:blocked')
  })
})
