// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A cold admin deep link must not be forwarded before the session is known
 * (SHO-116).
 *
 * `(admin)` is its own route group, so `/admin/general` never passes through
 * `app/index.tsx` — the only place local mode used to auto-sign-in. The gate
 * therefore saw an empty session and answered "not an admin", forwarding the
 * deep link to `/(app)` on every cold load and reload. These cases pin the two
 * halves of the fix: `loading` until auto-sign-in settles, and a real
 * `redirect` for a session that is genuinely not an admin.
 */
import { resolve } from 'node:path'
import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { renderHook, waitFor } from '@testing-library/react'

const modulePath = (path: string) => resolve(import.meta.dir, '../..', path)

type AuthState = { isAuthenticated: boolean; isLoading: boolean }
type Me = { ok: boolean; data?: { role?: string; adminScopes?: string[] } }

let auth: AuthState
let me: Me
let localMode: boolean
let autoSignIn: () => Promise<void>
let autoSignInCalls = 0

mock.module(modulePath('contexts/auth'), () => ({
  useAuth: () => ({
    user: auth.isAuthenticated ? { id: 'local-owner', email: 'owner@localhost', name: 'Owner' } : null,
    isLoading: auth.isLoading,
    isAuthenticated: auth.isAuthenticated,
    refreshSession: async () => {},
    signIn: async () => {},
    signUp: async () => ({ requiresVerification: false }),
    signInWithGoogle: () => {},
    signInWithApple: async () => {},
    signOut: async () => {},
    updateUser: async () => {},
    sendVerificationEmail: async () => {},
    clearError: () => {},
    error: null,
  }),
}))

mock.module(modulePath('contexts/domain'), () => {
  const http = {}
  return { useDomainHttp: () => http }
})

mock.module(modulePath('lib/api'), () => ({
  api: { getMe: async () => me },
}))

mock.module(modulePath('lib/auth-client'), () => ({
  autoSignInLocally: () => {
    autoSignInCalls += 1
    return autoSignIn()
  },
}))

mock.module(modulePath('lib/platform-config'), () => ({
  usePlatformConfig: () => ({ localMode, configLoaded: true, features: {} }),
  isLocalMode: () => localMode,
}))

const { adminGateDecision, useAdminCheck } = await import('../useAdminCheck')

const load = () =>
  renderHook(() => useAdminCheck())

beforeEach(() => {
  auth = { isAuthenticated: false, isLoading: true }
  me = { ok: true, data: { role: 'super_admin' } }
  localMode = true
  autoSignInCalls = 0
  autoSignIn = async () => {
    auth = { isAuthenticated: true, isLoading: false }
  }
})

describe('adminGateDecision', () => {
  const base = {
    authLoading: false,
    adminCheckPending: false,
    isAuthenticated: false,
    hasAdminAccess: false,
    localMode: true,
    localSignInSettled: false,
  }

  test('waits, and never redirects, while the session is still resolving', () => {
    expect(adminGateDecision({ ...base, authLoading: true, localMode: false })).toBe('loading')
    expect(adminGateDecision({ ...base, adminCheckPending: true })).toBe('loading')
  })

  test('waits for local auto-sign-in instead of deciding it is signed out', () => {
    expect(adminGateDecision({ ...base, isAuthenticated: false })).toBe('loading')
  })

  test('refuses a settled session that genuinely lacks admin access — locally too', () => {
    expect(adminGateDecision({ ...base, localSignInSettled: true })).toBe('redirect')
    expect(
      adminGateDecision({ ...base, localMode: false, isAuthenticated: true, hasAdminAccess: false }),
    ).toBe('redirect')
  })

  test('renders only for a session that exists and has admin access', () => {
    expect(adminGateDecision({ ...base, isAuthenticated: true, hasAdminAccess: true })).toBe('render')
  })
})

describe('useAdminCheck', () => {
  test('a cold local admin deep link stays loading until auto-sign-in lands', async () => {
    let release: () => void = () => {}
    autoSignIn = () =>
      new Promise<void>((done) => {
        release = () => {
          auth = { isAuthenticated: true, isLoading: false }
          done()
        }
      })

    const { result, rerender } = load()
    expect(result.current.gate).toBe('loading')

    // The session resolved empty — the exact moment the old gate forwarded.
    auth = { isAuthenticated: false, isLoading: false }
    rerender()
    await waitFor(() => expect(autoSignInCalls).toBe(1))
    expect(result.current.gate).toBe('loading')
    expect(result.current.isAuthenticated).toBe(false)

    release()
    rerender()
    await waitFor(() => expect(result.current.isAuthenticated).toBe(true))
    await waitFor(() => expect(result.current.gate).toBe('render'))
    expect(autoSignInCalls).toBe(1)
  })

  test('a local session with no admin access is still refused once auto-sign-in settles', async () => {
    me = { ok: true, data: { role: 'user', adminScopes: [] } }

    const { result, rerender } = load()
    auth = { isAuthenticated: false, isLoading: false }
    rerender()

    await waitFor(() => expect(autoSignInCalls).toBe(1))
    rerender()
    await waitFor(() => expect(result.current.gate).toBe('redirect'))
  })

  test('a failed auto-sign-in falls back to the redirect rather than waiting forever', async () => {
    const logged: unknown[][] = []
    const originalError = console.error
    console.error = (...args: unknown[]) => { logged.push(args) }
    autoSignIn = async () => {
      throw new Error('auto-sign-in returned 500')
    }

    try {
      const { result, rerender } = load()
      auth = { isAuthenticated: false, isLoading: false }
      rerender()

      await waitFor(() => expect(result.current.gate).toBe('redirect'))
      expect(logged.length).toBeGreaterThan(0)
    } finally {
      console.error = originalError
    }
  })

  test('cloud keeps its behaviour: a signed-in non-admin is forwarded', async () => {
    localMode = false
    auth = { isAuthenticated: true, isLoading: false }
    me = { ok: true, data: { role: 'user', adminScopes: [] } }

    const { result } = load()
    await waitFor(() => expect(result.current.gate).toBe('redirect'))
    expect(autoSignInCalls).toBe(0)
  })

  test('cloud signed out is forwarded without a local sign-in attempt', async () => {
    localMode = false
    auth = { isAuthenticated: false, isLoading: false }

    const { result } = load()
    await waitFor(() => expect(result.current.gate).toBe('redirect'))
    expect(autoSignInCalls).toBe(0)
  })
})
