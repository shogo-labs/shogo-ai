// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-230 acceptance 5, app side: the button never spins forever.
 *
 * The client's fetch budget (45s) turns an unanswered request into an *info*
 * line — "Still summarizing — check back in a minute" — and clears the
 * spinner, because the API keeps folding in the background. Before this the
 * dock had no timeout at all and sat on the spinner until the connection died.
 */
import { createElement } from 'react'
import { describe, expect, mock, test } from 'bun:test'
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

let attempts = 0
mock.module('../../../lib/compact-context', () => ({
  COMPACT_REQUEST_TIMEOUT_MS: 45_000,
  buildCompactUrl: () => '/api/workspaces/ws-1/chat/compact',
  requestContextCompaction: async () => {
    attempts += 1
    return {
      compacted: false,
      queued: true,
      timedOut: true,
      reason: 'Still summarizing — check back in a minute',
    }
  },
}))

const { ContextSummarySection } = await import('../ContextSummarySection')

describe('SHO-230: the summarize spinner is bounded', () => {
  test('a timed-out request shows the info line and clears the spinner', async () => {
    render(<ContextSummarySection workspaceId="ws-1" chatSessionId="chat-9" />)
    fireEvent.click(screen.getByLabelText('Summarize context now'))

    await waitFor(() =>
      expect(screen.getByText('Still summarizing — check back in a minute')).toBeTruthy(),
    )
    // Status text only renders once the section has left the "working" state.
    expect(screen.queryByRole('progressbar')).toBeNull()
    expect(screen.queryByText(/Couldn't summarize/)).toBeNull()

    // And the button is usable again.
    fireEvent.click(screen.getByLabelText('Summarize context now'))
    await waitFor(() => expect(attempts).toBe(2))
  })
})
