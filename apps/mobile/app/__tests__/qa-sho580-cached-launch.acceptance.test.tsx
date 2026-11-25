// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-580 acceptance (AC2/AC4): `/` routes from the device, not from `/api/me`.
 *
 * On 3G the root screen used to hold a full-screen spinner until `/api/me`
 * answered, because `onboardingCompleted` had no value until that fetch landed.
 * With the answer already on the device the screen reaches its destination on
 * the first frame, and the fetch still runs and still wins.
 *
 * The last case is the control: with nothing cached the screen still waits,
 * which is what the other two cases are allowed to skip.
 */

import { afterAll, afterEach, beforeEach, expect, mock, test } from 'bun:test'
import React from 'react'
import { createReactNativeMock } from '../../test/react-native-mock'

const hrefs: unknown[] = []

const auth: {
  user: { id: string; email: string; name: string } | null
  isAuthenticated: boolean
  isLoading: boolean
} = { user: null, isAuthenticated: false, isLoading: true }

mock.module('react-native', () =>
  createReactNativeMock({ Platform: { OS: 'ios', select: (v: any) => v.ios ?? v.default } }),
)
mock.module('expo-router', () => ({
  useLocalSearchParams: () => ({}),
  Redirect: (props: { href: unknown }) => {
    hrefs.push(props.href)
    return null
  },
}))
mock.module('../../contexts/auth', () => ({
  useAuth: () => ({ ...auth, refreshSession: async () => {} }),
}))
mock.module('../../lib/platform-config', () => ({
  usePlatformConfig: () => ({ configLoaded: true, localMode: false, needsSetup: false }),
}))
mock.module('../../lib/api', () => ({ API_URL: 'http://api.test' }))
mock.module('../../lib/auth-client', () => ({ autoSignInLocally: async () => {} }))

const { cleanup, render, waitFor } = await import('@testing-library/react')
const { default: RootIndex } = await import('../index')
const cache = await import('../../lib/auth-session-cache')

const USER = { id: 'user-580', email: 'user@example.com', name: 'User 580' }

// Every `/api/me` read this file makes stays unanswered: nothing below may
// depend on the network telling the screen where to go.
const realFetch = globalThis.fetch
const pendingFetch = (() => new Promise(() => {})) as unknown as typeof globalThis.fetch
globalThis.fetch = pendingFetch

beforeEach(() => {
  cache.resetAuthSessionCacheForTests()
  hrefs.length = 0
  auth.user = { ...USER }
  auth.isAuthenticated = true
  auth.isLoading = false
})

afterEach(() => {
  cleanup()
})

afterAll(() => {
  globalThis.fetch = realFetch
})

test('a cached "onboarding not done" answer routes there with no network answer', async () => {
  cache.rememberAuthUser(USER)
  cache.rememberOnboardingCompleted(USER.id, false)

  render(React.createElement(RootIndex))

  await waitFor(() => expect(hrefs.length).toBeGreaterThan(0))
  expect(hrefs).toContain('/(onboarding)')
})

test('a cached "onboarding done" answer goes straight into the app', async () => {
  cache.rememberAuthUser(USER)
  cache.rememberOnboardingCompleted(USER.id, true)

  render(React.createElement(RootIndex))

  await waitFor(() => expect(hrefs.length).toBeGreaterThan(0))
  expect(hrefs).not.toContain('/(onboarding)')
})

test('with nothing cached the screen still waits for the answer', async () => {
  // The control for the two cases above: no cached answer, `/api/me` never
  // answers, so nothing routes. This is the behaviour the cache lifts.
  expect(cache.readCachedOnboardingCompleted(USER.id)).toBeNull()

  render(React.createElement(RootIndex))

  await new Promise((resolve) => setTimeout(resolve, 50))
  expect(hrefs).toHaveLength(0)
})
