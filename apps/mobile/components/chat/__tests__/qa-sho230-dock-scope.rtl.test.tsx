// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-230 QA acceptance, app side — the *wiring*, not just the leaf component.
 *
 * The card's bug was that the dock only ever had a `projectId` to build its
 * URL from. The dev's RTL tests render `ContextSummarySection` directly, so a
 * break anywhere in the chain that feeds it — `ChatPanel` → `ChatInput` →
 * `ContextUsageDockPanel` → `ContextBreakdownPanel` → `ContextSummarySection`
 * — would still pass while the button went back to the wrong runtime.
 *
 * These render the panel the dock actually mounts (`ContextBreakdownPanel`) so
 * the `workspaceId` prop has to survive at least the last hop, and pin the two
 * precedence rules the fix depends on:
 *
 *   - a workspace id always wins over a project id (a workspace chat can be
 *     pinned to a project, and its session still lives on the workspace
 *     runtime — Russell's staging chat was exactly that shape), and
 *   - a chat with neither id has nothing to address, so the button stays
 *     disabled rather than posting nowhere.
 *
 * AC5's budget is asserted here too: the button must not be able to spin past
 * ~45s.
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

const { ContextBreakdownPanel } = await import('../ContextBreakdownPanel')
const { API_URL } = await import('../../../lib/api-url')
const { COMPACT_REQUEST_TIMEOUT_MS } = await import('../../../lib/compact-context')

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

function stubFetch(body: unknown, status = 200) {
  const calls: string[] = []
  globalThis.fetch = (async (url: string) => {
    calls.push(String(url))
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })
  }) as unknown as typeof fetch
  return calls
}

const button = () => screen.getByLabelText('Summarize context now') as HTMLButtonElement

function renderPanel(props: Record<string, unknown>) {
  return render(
    createElement(ContextBreakdownPanel, {
      breakdown: null,
      inputTokens: 192_000,
      contextWindowTokens: 200_000,
      ...props,
    } as any),
  )
}

describe('SHO-230: the dock panel hands the chat scope through to the summarize call', () => {
  test('a workspace chat with no project reaches the workspace compact route', async () => {
    const calls = stubFetch({ compacted: true, tokensBefore: 192_000, tokensAfter: 21_000 })

    renderPanel({ workspaceId: 'ws-1', chatSessionId: 'chat-9' })
    expect(button().disabled).toBe(false)
    fireEvent.click(button())

    await waitFor(() => expect(screen.getByText(/Summarized/)).toBeTruthy())
    expect(calls).toEqual([`${API_URL}/api/workspaces/ws-1/chat/compact`])
  })

  test('a workspace chat pinned to a project still goes to the workspace route', async () => {
    const calls = stubFetch({ compacted: true, tokensBefore: 1000, tokensAfter: 200 })

    renderPanel({ workspaceId: 'ws-1', projectId: 'proj-1', chatSessionId: 'chat-9' })
    fireEvent.click(button())

    await waitFor(() => expect(screen.getByText(/Summarized/)).toBeTruthy())
    // Sending this to the project route is precisely the reported bug.
    expect(calls).toEqual([`${API_URL}/api/workspaces/ws-1/chat/compact`])
  })

  test('a project chat keeps the project route', async () => {
    const calls = stubFetch({ compacted: true, tokensBefore: 1000, tokensAfter: 200 })

    renderPanel({ projectId: 'proj-1', chatSessionId: 'chat-9' })
    fireEvent.click(button())

    await waitFor(() => expect(screen.getByText(/Summarized/)).toBeTruthy())
    expect(calls).toEqual([`${API_URL}/api/projects/proj-1/chat/compact`])
  })

  test('no scope at all leaves the button disabled', () => {
    renderPanel({ chatSessionId: 'chat-9' })
    expect(button().disabled).toBe(true)
  })

  test('AC5 — the request budget cannot exceed ~45s', () => {
    expect(COMPACT_REQUEST_TIMEOUT_MS).toBeLessThanOrEqual(45_000)
    expect(COMPACT_REQUEST_TIMEOUT_MS).toBeGreaterThan(0)
  })
})
