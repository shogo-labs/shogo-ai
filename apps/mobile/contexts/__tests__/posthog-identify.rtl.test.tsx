// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-611: a `ph_did` carried from the website onto a studio link is aliased
 * onto the signed-in account, once per browser.
 *
 * Without the alias the website's anonymous visitor and the app's new
 * anonymous id stay two people, so the website funnel and the app funnel never
 * join. `identify` alone cannot fix that — PostHog needs the alias first.
 */

import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { cleanup, render } from '@testing-library/react'

process.env.EXPO_PUBLIC_POSTHOG_API_KEY = 'phc_test_key'

let distinctId = 'anon_app_local'
const calls: Array<{ fn: string; args: unknown[] }> = []

const fakePostHog = {
  identify: (...args: unknown[]) => { calls.push({ fn: 'identify', args }) },
  alias: (...args: unknown[]) => { calls.push({ fn: 'alias', args }) },
  register: (...args: unknown[]) => { calls.push({ fn: 'register', args }) },
  reset: (...args: unknown[]) => { calls.push({ fn: 'reset', args }) },
  getDistinctId: () => distinctId,
}

mock.module('posthog-react-native', () => ({
  PostHogProvider: ({ children }: { children: React.ReactNode }) => children,
  usePostHog: () => fakePostHog,
}))

let authenticated = true
mock.module('../auth', () => ({
  useAuth: () => ({ user: { id: 'user-1', email: 'ada@example.com', name: 'Ada' }, isAuthenticated: authenticated }),
}))

const { usePostHogIdentify } = await import('../posthog')

function Probe() {
  usePostHogIdentify()
  return null
}

function setQuery(search: string): void {
  window.history.replaceState({}, '', `/${search}`)
}

beforeEach(() => {
  calls.length = 0
  distinctId = 'anon_app_local'
  authenticated = true
  localStorage.clear()
  setQuery('')
  cleanup()
})

describe('usePostHogIdentify', () => {
  test('aliases the website distinct_id onto the account, then identifies', () => {
    setQuery('?ph_did=ph_website_1')
    render(<Probe />)

    const fns = calls.map((c) => c.fn)
    expect(fns).toContain('alias')
    expect(calls.find((c) => c.fn === 'alias')!.args[0]).toBe('ph_website_1')
    expect(calls.find((c) => c.fn === 'identify')!.args[0]).toBe('user-1')
    // The alias comes first: identify would otherwise mint a fresh person.
    expect(fns.indexOf('alias')).toBeLessThan(fns.indexOf('identify'))
  })

  test('aliases only once per browser', () => {
    setQuery('?ph_did=ph_website_1')
    render(<Probe />)
    cleanup()
    render(<Probe />)

    expect(calls.filter((c) => c.fn === 'alias')).toHaveLength(1)
  })

  test('never aliases the app to its own anonymous id', () => {
    distinctId = 'ph_website_1'
    setQuery('?ph_did=ph_website_1')
    render(<Probe />)

    expect(calls.filter((c) => c.fn === 'alias')).toHaveLength(0)
    expect(calls.filter((c) => c.fn === 'identify')).toHaveLength(1)
  })

  test('a visit with no ph_did identifies without an alias', () => {
    render(<Probe />)

    expect(calls.filter((c) => c.fn === 'alias')).toHaveLength(0)
    expect(calls.filter((c) => c.fn === 'identify')).toHaveLength(1)
  })
})
