// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The non-throwing auth accessors, and the snapshot they read without context.
 *
 * Shell chrome rendered inside a Gluestack popover portal sits *above*
 * `AuthProvider` (the portal host is mounted at `GluestackUIProvider`), so
 * `useAuth()` there throws and takes the shell down — that is how local-mode
 * boot broke in SHO-84. Components in that position must be able to ask who
 * is signed in without a context read.
 */

import { afterEach, describe, expect, it } from 'bun:test'
import { useEffect } from 'react'
import { cleanup, render, waitFor } from '@testing-library/react'
import { installHappyDom, restoreHappyDom } from '../../hooks/__tests__/happy-dom-setup.ts'
import {
  AuthProvider,
  getAuthUserSnapshot,
  useAuth,
  useAuthOptional,
} from '../AuthProvider'

installHappyDom()

afterEach(() => cleanup())

const USER = { id: 'user-1', email: 'user@example.com', name: 'User One' }

function fakeAuthClient(user: typeof USER | null) {
  return {
    getSession: async () => ({ data: user ? { user } : null }),
    signIn: { email: async () => ({ data: { user } }) },
    signOut: async () => ({ data: null }),
  } as any
}

describe('optional auth accessors', () => {
  it('reports no session outside a provider instead of throwing', () => {
    const seen: Array<unknown> = []
    function Probe() {
      seen.push(useAuthOptional())
      seen.push(getAuthUserSnapshot())
      return null
    }
    render(<Probe />)
    expect(seen).toEqual([null, null])
  })

  it('keeps useAuth throwing outside a provider', () => {
    function Probe() {
      useAuth()
      return null
    }
    const spy = () => render(<Probe />)
    expect(spy).toThrow('useAuth must be used within AuthProvider')
  })

  it('publishes the provider user to the snapshot', async () => {
    function Probe() {
      const auth = useAuthOptional()
      useEffect(() => {
        if (auth?.user) expect(getAuthUserSnapshot()?.email).toBe(USER.email)
      }, [auth?.user])
      return null
    }
    render(
      <AuthProvider authClient={fakeAuthClient(USER)}>
        <Probe />
      </AuthProvider>,
    )
    await waitFor(() => expect(getAuthUserSnapshot()?.email).toBe(USER.email))
  })
})
