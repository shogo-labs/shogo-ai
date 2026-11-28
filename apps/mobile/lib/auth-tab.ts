// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Which tab the one auth screen opens on.
 *
 * `/sign-up` and `/sign-up?utm_source=ig` both land on the same screen as
 * `/sign-in` (there is one form pair, and the tab is a URL parameter rather
 * than a second route so no query string is lost). This is the rule that
 * decides the tab, kept out of the screen so it can be tested:
 *
 *   1. an explicit `?mode=` wins — the marketing link, the tab switch and the
 *      Sign Up redirect all write it;
 *   2. otherwise a device that has never had a session gets **Sign Up**
 *      (ad traffic), and a device that has gets **Sign In** (someone returning).
 *
 * `mode` arrives from expo-router as `string | string[]`, so a repeated
 * parameter is read as its first value.
 */
import { hasHadSession } from './auth-device-history'

export type AuthTab = 'signin' | 'signup'

export type AuthTabParam = string | string[] | undefined | null

/** The tab an explicit `?mode=` asks for, or null when it asks for nothing usable. */
export function parseAuthTab(mode: AuthTabParam): AuthTab | null {
  const value = Array.isArray(mode) ? mode[0] : mode
  if (value === 'signup' || value === 'signin') return value
  return null
}

export function resolveInitialAuthTab(
  mode: AuthTabParam,
  hadSession: boolean = hasHadSession(),
): AuthTab {
  return parseAuthTab(mode) ?? (hadSession ? 'signin' : 'signup')
}
