// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The mobile half of SHO-414: `AuthProvider`'s `onAuthError` must reach Sentry
 * tagged with the provider and stage.
 *
 * The shared provider is covered by `packages/shared-app/src/auth/__tests__/
 * oauth-handback.test.tsx`; what was untested is this adapter — the prop being
 * passed at all, and the tags it attaches. A refactor that dropped either would
 * have restored the silent failure with every other test still green.
 */

import { afterEach, describe, expect, mock, test } from 'bun:test'
import { cleanup, render } from '@testing-library/react'
import { useEffect } from 'react'

const captured: Array<{ error: unknown; options: any }> = []

const realSentry = await import('@sentry/react-native')
mock.module('@sentry/react-native', () => ({
  ...realSentry,
  captureException: (error: unknown, options: any) => {
    captured.push({ error, options })
    return 'event-id'
  },
}))

// Stands in for the shared provider: it reports one failure on mount, exactly
// as the real one does when the OAuth hand-back leaves no session behind.
const realSharedAuth = await import('@shogo/shared-app/auth')
mock.module('@shogo/shared-app/auth', () => ({
  ...realSharedAuth,
  AuthProvider: ({
    children,
    onAuthError,
  }: {
    children: React.ReactNode
    onAuthError?: (error: unknown, context: { provider: string; stage: string }) => void
  }) => {
    useEffect(() => {
      onAuthError?.(new Error('no user after sign-in'), {
        provider: 'google',
        stage: 'session_missing',
      })
    }, [onAuthError])
    return children
  },
}))

const { AuthProvider } = await import('../auth')

afterEach(() => {
  captured.length = 0
  cleanup()
})

describe('mobile AuthProvider → Sentry', () => {
  test('reports an auth failure tagged with provider and stage', () => {
    render(
      <AuthProvider>
        <div>app</div>
      </AuthProvider>,
    )

    expect(captured).toHaveLength(1)
    expect((captured[0].error as Error).message).toBe('no user after sign-in')
    expect(captured[0].options.tags).toEqual({
      'auth.provider': 'google',
      'auth.stage': 'session_missing',
    })
  })

  test('attaches nothing beyond the tags — no credentials in the payload', () => {
    render(
      <AuthProvider>
        <div>app</div>
      </AuthProvider>,
    )

    expect(Object.keys(captured[0].options)).toEqual(['tags'])
  })
})
