// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-230 acceptance 1 + 3, app side: the dock's "Summarize now" reaches the
 * workspace runtime for a workspace-scoped chat.
 *
 * Russell's chat was `contextType = workspace` on staging, and the button spun
 * with no result because the panel only ever had a `projectId` to work with —
 * a landing/home workspace chat had none at all, so the button was permanently
 * disabled there.
 */
import { createElement } from 'react'
import { afterEach, describe, expect, mock, test } from 'bun:test'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createReactNativeMock } from '../../../test/react-native-mock'

mock.module('react-native', () =>
  createReactNativeMock({
    Pressable: ({ accessibilityLabel, children, onPress, disabled }: any) =>
      createElement(
        'button',
        {
          'aria-label': accessibilityLabel,
          type: 'button',
          disabled: !!disabled,
          'aria-disabled': disabled ? 'true' : undefined,
          onClick: disabled ? undefined : onPress,
        },
        children,
      ),
    ActivityIndicator: () => createElement('div', { role: 'progressbar' }),
  }),
)

const { ContextSummarySection } = await import('../ContextSummarySection')
const { API_URL } = await import('../../../lib/api-url')

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

function stubFetch(status: number, body: unknown) {
  const calls: { url: string; init: RequestInit }[] = []
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init })
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })
  }) as unknown as typeof fetch
  return calls
}

const button = () => screen.getByLabelText('Summarize context now') as HTMLButtonElement

describe('SHO-230: Summarize now on a workspace chat', () => {
  test('a workspace chat with no projectId can summarize, through the workspace route', async () => {
    const calls = stubFetch(200, { compacted: true, tokensBefore: 192_000, tokensAfter: 21_000 })

    render(<ContextSummarySection workspaceId="ws-1" chatSessionId="chat-9" />)
    expect(button().disabled).toBe(false)
    fireEvent.click(button())

    await waitFor(() => expect(screen.getByText(/Summarized/)).toBeTruthy())
    expect(calls[0]!.url).toBe(`${API_URL}/api/workspaces/ws-1/chat/compact`)
    expect(screen.getByText(/192K → 21K/)).toBeTruthy()
  })

  test('a project chat still goes to the project route', async () => {
    const calls = stubFetch(200, { compacted: true, tokensBefore: 1000, tokensAfter: 200 })

    render(<ContextSummarySection projectId="proj-1" chatSessionId="chat-9" />)
    fireEvent.click(button())

    await waitFor(() => expect(screen.getByText(/Summarized/)).toBeTruthy())
    expect(calls[0]!.url).toBe(`${API_URL}/api/projects/proj-1/chat/compact`)
  })

  test('with neither a project nor a workspace there is nothing to address', () => {
    render(<ContextSummarySection chatSessionId="chat-9" />)
    expect(button().disabled).toBe(true)
  })

  test('a queued answer is reported verbatim, not as a success', async () => {
    stubFetch(202, {
      compacted: false,
      queued: true,
      reason: 'Summarizing in the background — this can take a minute on a long chat',
    })

    render(<ContextSummarySection workspaceId="ws-1" chatSessionId="chat-9" />)
    fireEvent.click(button())

    await waitFor(() => expect(screen.getByText(/Summarizing in the background/)).toBeTruthy())
    expect(screen.queryByText(/Summarized ·/)).toBeNull()
  })
})
