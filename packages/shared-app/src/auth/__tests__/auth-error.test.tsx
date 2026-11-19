// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Which auth failures are worth an issue (SHO-429).
 *
 * SHO-414 made every auth failure reportable, and `AuthProvider` reported every
 * one of them. A blocked throwaway sign-up (422 `SIGNUP_BLOCKED`), a wrong
 * password (401) and "account already exists" (422) all arrived in Sentry as
 * exceptions even though the API had done exactly what it should and the form
 * showed the user the message. These tests pin the split: expected 4xx answers
 * stay out of `onAuthError`, the UI message is unchanged, and a 5xx or a
 * rejected fetch still reports once with the provider and stage tags.
 */

import { afterAll, afterEach, describe, expect, it } from 'bun:test'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { installHappyDom, restoreHappyDom } from '../../hooks/__tests__/happy-dom-setup.ts'
import { AuthProvider, useAuth, EmailNotVerifiedError } from '../AuthProvider'
import { AuthRequestError, shouldReportAuthError, toAuthRequestError } from '../auth-error'
import type { AuthErrorContext } from '../AuthProvider'

installHappyDom()

afterAll(() => restoreHappyDom())
afterEach(async () => {
  await new Promise((resolve) => setTimeout(resolve, 0))
  cleanup()
})

const USER = { id: 'user-1', email: 'user@example.com', name: 'User One' }

/** The error shape Better Auth's client hands back: body spread over the fetch error. */
function apiError(status: number, message: string, code?: string) {
  return { message, status, statusText: '', ...(code ? { code } : {}) }
}

type Probe = {
  user: unknown
  error: string | null
  signIn: (email: string, password: string) => Promise<void>
  signUp: (name: string, email: string, password: string) => Promise<unknown>
}

async function renderProvider(authClient: any) {
  const reports: Array<{ error: unknown; context: AuthErrorContext }> = []
  const seen: Probe = {
    user: undefined,
    error: null,
    signIn: async () => {},
    signUp: async () => {},
  }
  function Rendered() {
    const auth = useAuth()
    seen.user = auth.user
    seen.error = auth.error
    seen.signIn = auth.signIn
    seen.signUp = auth.signUp as any
    return null
  }
  render(
    <AuthProvider
      authClient={authClient}
      onAuthError={(error, context) => reports.push({ error, context })}
    >
      <Rendered />
    </AuthProvider>,
  )
  await act(async () => {})
  return { seen, reports }
}

function client(overrides: {
  signInError?: unknown
  signUpError?: unknown
  signInThrows?: unknown
  signUpThrows?: unknown
}) {
  return {
    getSession: async () => ({ data: null }),
    signIn: {
      email: async () => {
        if (overrides.signInThrows) throw overrides.signInThrows
        return { data: null, error: overrides.signInError ?? null }
      },
    },
    signUp: {
      email: async () => {
        if (overrides.signUpThrows) throw overrides.signUpThrows
        return { data: null, error: overrides.signUpError ?? null }
      },
    },
    signOut: async () => ({ data: null }),
  } as any
}

describe('shouldReportAuthError', () => {
  it('reports failures with no status — a thrown exception or a dead network', () => {
    expect(shouldReportAuthError(new Error('Failed to fetch'))).toBe(true)
    expect(shouldReportAuthError(new TypeError('Network request failed'))).toBe(true)
    expect(shouldReportAuthError('not even an error')).toBe(true)
  })

  it('reports 5xx — the server broke', () => {
    expect(shouldReportAuthError(new AuthRequestError('boom', { status: 500 }))).toBe(true)
    expect(shouldReportAuthError(new AuthRequestError('down', { status: 503 }))).toBe(true)
  })

  it('does not report expected 4xx answers', () => {
    for (const status of [400, 401, 403, 409, 422, 429]) {
      expect(shouldReportAuthError(new AuthRequestError('expected', { status }))).toBe(false)
    }
  })
})

describe('toAuthRequestError', () => {
  it('keeps the message, status and API code', () => {
    const error = toAuthRequestError(
      apiError(422, "Please use a permanent email address — temporary inboxes can't be used to sign up.", 'SIGNUP_BLOCKED'),
      'Sign up failed',
    )
    expect(error.message).toContain('permanent email address')
    expect(error.status).toBe(422)
    expect(error.code).toBe('SIGNUP_BLOCKED')
  })

  it('finds the code in the parsed body when it is not spread to the top level', () => {
    const error = toAuthRequestError({ message: 'nope', status: 401, error: { code: 'INVALID_EMAIL_OR_PASSWORD' } }, 'Sign in failed')
    expect(error.code).toBe('INVALID_EMAIL_OR_PASSWORD')
    expect(error.status).toBe(401)
  })

  it('falls back to the caller message when the server gave none', () => {
    expect(toAuthRequestError({ status: 500 }, 'Sign in failed').message).toBe('Sign in failed')
    expect(toAuthRequestError(undefined, 'Sign up failed').message).toBe('Sign up failed')
  })
})

describe('email sign-up', () => {
  it('shows the blocked-domain message and reports nothing for a 422 SIGNUP_BLOCKED', async () => {
    const message = "Please use a permanent email address — temporary inboxes can't be used to sign up."
    const { seen, reports } = await renderProvider(
      client({ signUpError: apiError(422, message, 'SIGNUP_BLOCKED') }),
    )

    let thrown: unknown
    await act(async () => {
      await seen.signUp('Temp', 'temp@mailinator.com', 'password123').catch((e) => { thrown = e })
    })

    expect(seen.error).toBe(message)
    expect((thrown as Error).message).toBe(message)
    expect((thrown as AuthRequestError).status).toBe(422)
    expect((thrown as AuthRequestError).code).toBe('SIGNUP_BLOCKED')
    expect(reports).toHaveLength(0)
  })

  it('reports nothing when the account already exists', async () => {
    const message = 'An account with this email already exists. Please sign in.'
    const { seen, reports } = await renderProvider(
      client({ signUpError: apiError(422, message, 'USER_ALREADY_EXISTS') }),
    )

    await act(async () => {
      await seen.signUp('User', 'user@example.com', 'password123').catch(() => {})
    })

    expect(seen.error).toBe(message)
    expect(reports).toHaveLength(0)
  })

  it('reports a 500 once, tagged sign_up', async () => {
    const { seen, reports } = await renderProvider(
      client({ signUpError: apiError(500, 'Internal server error') }),
    )

    await act(async () => {
      await seen.signUp('User', 'user@example.com', 'password123').catch(() => {})
    })

    expect(reports).toHaveLength(1)
    expect(reports[0].context).toEqual({ provider: 'email', stage: 'sign_up' })
    expect((reports[0].error as AuthRequestError).status).toBe(500)
  })

  it('reports a rejected fetch once, tagged sign_up', async () => {
    const { seen, reports } = await renderProvider(
      client({ signUpThrows: new TypeError('Network request failed') }),
    )

    await act(async () => {
      await seen.signUp('User', 'user@example.com', 'password123').catch(() => {})
    })

    expect(reports).toHaveLength(1)
    expect(reports[0].context).toEqual({ provider: 'email', stage: 'sign_up' })
    expect((reports[0].error as Error).message).toBe('Network request failed')
  })
})

describe('email sign-in', () => {
  it('shows the wrong-password message and reports nothing for a 401', async () => {
    const { seen, reports } = await renderProvider(
      client({ signInError: apiError(401, 'Invalid email or password', 'INVALID_EMAIL_OR_PASSWORD') }),
    )

    let thrown: unknown
    await act(async () => {
      await seen.signIn('user@example.com', 'wrong').catch((e) => { thrown = e })
    })

    expect(seen.error).toBe('Invalid email or password')
    expect((thrown as Error).message).toBe('Invalid email or password')
    expect((thrown as AuthRequestError).status).toBe(401)
    expect(reports).toHaveLength(0)
  })

  it('still throws EmailNotVerifiedError for a 403 and reports nothing', async () => {
    const { seen, reports } = await renderProvider(
      client({ signInError: apiError(403, 'Email is not verified') }),
    )

    let thrown: unknown
    await act(async () => {
      await seen.signIn('user@example.com', 'password123').catch((e) => { thrown = e })
    })

    expect(thrown).toBeInstanceOf(EmailNotVerifiedError)
    expect(reports).toHaveLength(0)
  })

  it('reports a 500 once, tagged sign_in', async () => {
    const { seen, reports } = await renderProvider(
      client({ signInError: apiError(500, 'Internal server error') }),
    )

    await act(async () => {
      await seen.signIn('user@example.com', 'password123').catch(() => {})
    })

    expect(reports).toHaveLength(1)
    expect(reports[0].context).toEqual({ provider: 'email', stage: 'sign_in' })
  })

  it('reports a rejected fetch once, tagged sign_in', async () => {
    const { seen, reports } = await renderProvider(
      client({ signInThrows: new TypeError('Failed to fetch') }),
    )

    await act(async () => {
      await seen.signIn('user@example.com', 'password123').catch(() => {})
    })

    expect(reports).toHaveLength(1)
    expect(reports[0].context).toEqual({ provider: 'email', stage: 'sign_in' })
  })

  it('signs the user in without reporting when the call succeeds', async () => {
    const authClient = {
      getSession: async () => ({ data: null }),
      signIn: { email: async () => ({ data: { user: USER }, error: null }) },
      signUp: { email: async () => ({ data: null, error: null }) },
      signOut: async () => ({ data: null }),
    } as any
    const { seen, reports } = await renderProvider(authClient)

    await act(async () => {
      await seen.signIn('user@example.com', 'password123')
    })

    expect(reports).toHaveLength(0)
    await waitFor(() => expect(seen.user).toEqual(USER))
  })
})
