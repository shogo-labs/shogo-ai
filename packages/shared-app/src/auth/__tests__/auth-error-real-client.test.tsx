// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-429 at the seam the unit tests fake: the real Better Auth client, the
 * real Better Fetch error shape, and the real provider.
 *
 * `auth-error.test.tsx` hands `AuthProvider` a hand-built `{ message, status,
 * code }`. That proves the rule but not that Better Auth actually delivers
 * those fields — if it did not, every expected 4xx would arrive with no
 * `status` and be reported again. So this test drives `createAuthClient`
 * (the same one `apps/mobile/lib/auth-client.ts` builds) with only the network
 * stubbed, and checks what reaches `onAuthError`.
 */

import { afterAll, afterEach, describe, expect, it } from 'bun:test'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { installHappyDom, restoreHappyDom } from '../../hooks/__tests__/happy-dom-setup.ts'
import { AuthProvider, useAuth, type AuthErrorContext } from '../AuthProvider'
import { createAuthClient } from '../client'
import { AuthRequestError } from '../auth-error'

installHappyDom()

const realFetch = globalThis.fetch

afterAll(() => {
  globalThis.fetch = realFetch
  restoreHappyDom()
})

afterEach(async () => {
  globalThis.fetch = realFetch
  await new Promise((resolve) => setTimeout(resolve, 0))
  cleanup()
})

/** Answer every request the way the web handler does: JSON body + HTTP status. */
function stubApi(handler: (url: string, init?: RequestInit) => { status: number; body: unknown }) {
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input?.url ?? String(input)
    const { status, body } = handler(url, init)
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch
}

type Probe = {
  error: string | null
  signIn: (email: string, password: string) => Promise<void>
  signUp: (name: string, email: string, password: string) => Promise<unknown>
}

async function renderProvider() {
  const reports: Array<{ error: unknown; context: AuthErrorContext }> = []
  const seen: Probe = { error: null, signIn: async () => {}, signUp: async () => {} }

  // The same client the mobile app builds: better-auth/react + /api/auth.
  const authClient = createAuthClient({ baseURL: 'http://localhost:3999' })

  function Rendered() {
    const auth = useAuth()
    seen.error = auth.error
    seen.signIn = auth.signIn
    seen.signUp = auth.signUp as any
    return null
  }
  render(
    <AuthProvider authClient={authClient} onAuthError={(error, context) => reports.push({ error, context })}>
      <Rendered />
    </AuthProvider>,
  )
  await act(async () => {})
  return { seen, reports }
}

const BLOCKED_MESSAGE =
  "Please use a permanent email address — temporary inboxes can't be used to sign up."

describe('real Better Auth client → AuthProvider (SHO-429)', () => {
  it('keeps status/code from a 422 SIGNUP_BLOCKED and reports nothing', async () => {
    stubApi((url) => {
      if (url.includes('sign-up')) {
        return { status: 422, body: { code: 'SIGNUP_BLOCKED', message: BLOCKED_MESSAGE } }
      }
      return { status: 200, body: {} }
    })
    const { seen, reports } = await renderProvider()

    let thrown: unknown
    await act(async () => {
      await seen.signUp('Temp', 'temp@mailinator.com', 'password123').catch((e) => { thrown = e })
    })

    // What the form shows is untouched…
    expect(seen.error).toBe(BLOCKED_MESSAGE)
    expect((thrown as Error).message).toBe(BLOCKED_MESSAGE)
    // …and the facts the API sent survive, which is what the reporting rule reads.
    expect(thrown).toBeInstanceOf(AuthRequestError)
    expect((thrown as AuthRequestError).status).toBe(422)
    expect((thrown as AuthRequestError).code).toBe('SIGNUP_BLOCKED')
    expect(reports).toHaveLength(0)
  })

  it('keeps the 401 from a wrong password and reports nothing', async () => {
    stubApi((url) => {
      if (url.includes('sign-in')) {
        return { status: 401, body: { code: 'INVALID_EMAIL_OR_PASSWORD', message: 'Invalid email or password' } }
      }
      return { status: 200, body: {} }
    })
    const { seen, reports } = await renderProvider()

    let thrown: unknown
    await act(async () => {
      await seen.signIn('user@example.com', 'wrong').catch((e) => { thrown = e })
    })

    expect(seen.error).toBe('Invalid email or password')
    expect((thrown as AuthRequestError).status).toBe(401)
    expect((thrown as AuthRequestError).code).toBe('INVALID_EMAIL_OR_PASSWORD')
    expect(reports).toHaveLength(0)
  })

  it('reports a 500 from the API exactly once', async () => {
    stubApi((url) => {
      if (url.includes('sign-up')) {
        return { status: 500, body: { code: 'INTERNAL_SERVER_ERROR', message: 'Internal server error' } }
      }
      return { status: 200, body: {} }
    })
    const { seen, reports } = await renderProvider()

    await act(async () => {
      await seen.signUp('User', 'user@example.com', 'password123').catch(() => {})
    })

    await waitFor(() => expect(reports).toHaveLength(1))
    expect(reports[0].context).toEqual({ provider: 'email', stage: 'sign_up' })
    expect((reports[0].error as AuthRequestError).status).toBe(500)
  })

  it('still reports a dead network once, with no status to read', async () => {
    globalThis.fetch = (async () => {
      throw new TypeError('Failed to fetch')
    }) as unknown as typeof fetch
    const { seen, reports } = await renderProvider()

    await act(async () => {
      await seen.signIn('user@example.com', 'password123').catch(() => {})
    })

    await waitFor(() => expect(reports).toHaveLength(1))
    expect(reports[0].context).toEqual({ provider: 'email', stage: 'sign_in' })
  })
})
