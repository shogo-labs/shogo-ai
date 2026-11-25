// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Launch from the session already on the device (SHO-580).
 *
 * A signed-in relaunch on a slow network used to hold a full-screen spinner
 * until `get-session` answered, because `isLoading` started `true` and only the
 * network could clear it. `cachedUser` gives the provider the device's own copy:
 * with one it renders on the first frame and confirms in the background, and a
 * failed read keeps it (SHO-430's rule). Without one — web, desktop — the
 * provider must behave exactly as it did, which the first two cases pin.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { installHappyDom, restoreHappyDom } from '../../hooks/__tests__/happy-dom-setup.ts'
import { AuthProvider, useAuth, type AuthUser } from '../AuthProvider'

installHappyDom()

afterAll(() => restoreHappyDom())
afterEach(async () => {
  await new Promise((resolve) => setTimeout(resolve, 0))
  cleanup()
})

const USER = { id: 'user-1', email: 'user@example.com', name: 'User One' }
const CACHED: AuthUser = { ...USER }

type SessionAnswer =
  | { kind: 'user'; user: AuthUser }
  | { kind: 'signed-out' }
  | { kind: 'error'; error: unknown }
  | { kind: 'throws'; error: Error }

function fakeAuthClient(answers: SessionAnswer[], onCall?: () => void) {
  let call = 0
  return {
    getSession: async () => {
      onCall?.()
      const answer = answers[Math.min(call, answers.length - 1)]
      call += 1
      switch (answer.kind) {
        case 'user':
          return { data: { user: answer.user }, error: null }
        case 'signed-out':
          return { data: null, error: null }
        case 'error':
          return { data: null, error: answer.error }
        case 'throws':
          throw answer.error
      }
    },
    signOut: async () => ({ data: null }),
  } as any
}

interface Probe {
  user: AuthUser | null
  isLoading: boolean
  /** What the provider reported to `onUserChanged`. */
  reported: Array<AuthUser | null>
}

async function renderProvider(
  authClient: any,
  props: { cachedUser?: () => AuthUser | null; settle?: boolean } = {},
): Promise<Probe> {
  const probe: Probe = { user: null, isLoading: true, reported: [] }
  function Snapshot() {
    const auth = useAuth()
    probe.user = auth.user
    probe.isLoading = auth.isLoading
    return null
  }
  render(
    <AuthProvider
      authClient={authClient}
      cachedUser={props.cachedUser}
      onUserChanged={(user) => probe.reported.push(user)}
    >
      <Snapshot />
    </AuthProvider>,
  )
  // `settle: false` reads the very first frame, before the session read lands.
  if (props.settle !== false) await act(async () => {})
  return probe
}

describe('AuthProvider without a cached user (web/desktop)', () => {
  it('starts loading and only the network clears it', async () => {
    const probe = await renderProvider(fakeAuthClient([{ kind: 'user', user: USER }]), { settle: false })

    expect(probe.isLoading).toBe(true)
    expect(probe.user).toBeNull()

    await act(async () => {})
    expect(probe.isLoading).toBe(false)
    expect(probe.user).toEqual(USER)
  })

  it('a read that never answers leaves the spinner up', async () => {
    // The behaviour the card is about: nothing on the device to draw means the
    // screen waits. It is unchanged where no cache is passed.
    const client = { getSession: () => new Promise(() => {}), signOut: async () => ({ data: null }) } as any
    const probe = await renderProvider(client, { settle: false })
    await act(async () => {})

    expect(probe.isLoading).toBe(true)
    expect(probe.user).toBeNull()
  })

  it('a failing read retries once, then settles signed out', async () => {
    let calls = 0
    const client = fakeAuthClient([{ kind: 'throws', error: new Error('network down') }], () => { calls += 1 })
    const probe = await renderProvider(client)
    await waitFor(() => expect(probe.isLoading).toBe(false))

    expect(calls).toBe(2)
    expect(probe.user).toBeNull()
  })
})

describe('AuthProvider with the device session', () => {
  beforeEach(() => {})

  it('renders the cached user on the first frame, with no spinner', async () => {
    const probe = await renderProvider(fakeAuthClient([{ kind: 'user', user: USER }]), {
      cachedUser: () => CACHED,
      settle: false,
    })

    expect(probe.isLoading).toBe(false)
    expect(probe.user).toEqual(CACHED)
  })

  it('a dropped connection keeps the cached user signed in', async () => {
    const probe = await renderProvider(fakeAuthClient([{ kind: 'throws', error: new Error('offline') }]), {
      cachedUser: () => CACHED,
    })

    await waitFor(() => expect(probe.isLoading).toBe(false))
    expect(probe.user).toEqual(CACHED)
  })

  it('a 5xx keeps the cached user signed in', async () => {
    const probe = await renderProvider(fakeAuthClient([{ kind: 'error', error: { status: 503 } }]), {
      cachedUser: () => CACHED,
    })

    await waitFor(() => expect(probe.isLoading).toBe(false))
    expect(probe.user).toEqual(CACHED)
  })

  it('a 401 signs the cached user out', async () => {
    const probe = await renderProvider(fakeAuthClient([{ kind: 'error', error: { status: 401 } }]), {
      cachedUser: () => CACHED,
    })

    await waitFor(() => expect(probe.user).toBeNull())
    expect(probe.isLoading).toBe(false)
  })

  it('a clean "no session" signs the cached user out', async () => {
    const probe = await renderProvider(fakeAuthClient([{ kind: 'signed-out' }]), { cachedUser: () => CACHED })

    await waitFor(() => expect(probe.user).toBeNull())
  })

  it('the network answer replaces the cached user', async () => {
    const renamed = { ...USER, name: 'Renamed' }
    const probe = await renderProvider(fakeAuthClient([{ kind: 'user', user: renamed }]), { cachedUser: () => CACHED })

    await waitFor(() => expect(probe.user).toEqual(renamed))
  })

  it('publishes the user it holds for the host to persist', async () => {
    const probe = await renderProvider(fakeAuthClient([{ kind: 'user', user: USER }]), { cachedUser: () => CACHED })

    await waitFor(() => expect(probe.reported).toContainEqual(CACHED))
    expect(probe.reported).toContainEqual(USER)
  })
})
