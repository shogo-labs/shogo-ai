// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The Sign In / Sign Up decision (SHO-613).
 *
 * An ad click must open Sign Up; someone who has signed in on this device
 * before must open Sign In; an explicit `?mode=` always wins.
 */
import { beforeEach, describe, expect, test, mock } from 'bun:test'

const platform = { OS: 'web' as string }
mock.module('react-native', () => ({ Platform: platform }))

const { hasHadSession, markHadSession } = await import('../auth-device-history')
const { parseAuthTab, resolveInitialAuthTab } = await import('../auth-tab')

beforeEach(() => {
  window.localStorage.clear()
})

describe('auth-device-history', () => {
  test('a device that has never signed in reports no history', () => {
    expect(hasHadSession()).toBe(false)
  })

  test('recording a session makes it sticky, and recording again is harmless', () => {
    markHadSession()
    markHadSession()
    expect(hasHadSession()).toBe(true)
  })
})

describe('resolveInitialAuthTab', () => {
  test('a fresh device with no mode gets Sign Up (ad traffic)', () => {
    expect(resolveInitialAuthTab(undefined, false)).toBe('signup')
  })

  test('a device that has signed in gets Sign In', () => {
    expect(resolveInitialAuthTab(undefined, true)).toBe('signin')
  })

  test('an explicit mode wins in both directions', () => {
    expect(resolveInitialAuthTab('signup', true)).toBe('signup')
    expect(resolveInitialAuthTab('signin', false)).toBe('signin')
  })

  test('a repeated parameter is read as its first value', () => {
    expect(parseAuthTab(['signup', 'signin'])).toBe('signup')
  })

  test('an unknown mode is ignored', () => {
    expect(parseAuthTab('register')).toBeNull()
    expect(resolveInitialAuthTab('register', true)).toBe('signin')
  })

  test('with no argument it reads this device', () => {
    expect(resolveInitialAuthTab(undefined)).toBe('signup')
    markHadSession()
    expect(resolveInitialAuthTab(undefined)).toBe('signin')
  })
})
