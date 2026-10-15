// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { afterEach, describe, expect, mock, test } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createElement } from 'react'
import { createReactNativeMock } from '../../../test/react-native-mock'

mock.module('react-native', () =>
  createReactNativeMock({
    Platform: { OS: 'web', select: (s: any) => s.web ?? s.default },
    Pressable: ({ accessibilityLabel, children, onPress, disabled }: any) =>
      createElement('div', { role: 'button', 'aria-label': accessibilityLabel, onClick: disabled ? undefined : onPress }, children),
  } as any),
)

const { MentionNudgeCard } = await import('../MentionNudgeCard')

afterEach(cleanup)

describe('MentionNudgeCard', () => {
  test('names one person and offers to add them', () => {
    render(<MentionNudgeCard names={['Priya']} onAdd={() => {}} onDismiss={() => {}} onDontShowAgain={() => {}} />)
    expect(screen.getByText('Priya')).toBeTruthy()
    expect(screen.getByText(/but they're not in this channel/)).toBeTruthy()
    expect(screen.getByLabelText('Add them to this channel')).toBeTruthy()
  })

  test('joins several names in one sentence', () => {
    render(<MentionNudgeCard names={['Ana', 'Priya', 'Sam']} onAdd={() => {}} onDismiss={() => {}} onDontShowAgain={() => {}} />)
    expect(screen.getByText('Ana, Priya, and Sam')).toBeTruthy()
  })

  test('renders nothing when there is nobody to flag', () => {
    const { container } = render(<MentionNudgeCard names={[]} onAdd={() => {}} onDismiss={() => {}} onDontShowAgain={() => {}} />)
    expect(container.querySelector('[data-rn-shim="mention-nudge-card"]')).toBeNull()
  })

  test('Add them, Dismiss, and Don\'t show again each call their handler', () => {
    const onAdd = mock(() => {})
    const onDismiss = mock(() => {})
    const onDontShowAgain = mock(() => {})
    render(<MentionNudgeCard names={['Priya']} onAdd={onAdd} onDismiss={onDismiss} onDontShowAgain={onDontShowAgain} />)
    fireEvent.click(screen.getByLabelText('Add them to this channel'))
    fireEvent.click(screen.getByLabelText('Dismiss'))
    fireEvent.click(screen.getByLabelText("Don't show this again"))
    expect(onAdd).toHaveBeenCalledTimes(1)
    expect(onDismiss).toHaveBeenCalledTimes(1)
    expect(onDontShowAgain).toHaveBeenCalledTimes(1)
  })

  test('while busy, Add them is disabled and says so', () => {
    const onAdd = mock(() => {})
    render(<MentionNudgeCard names={['Priya']} busy onAdd={onAdd} onDismiss={() => {}} onDontShowAgain={() => {}} />)
    expect(screen.getByText('Adding…')).toBeTruthy()
    fireEvent.click(screen.getByLabelText('Add them to this channel'))
    expect(onAdd).not.toHaveBeenCalled()
  })

  test('shows an error from a failed add', () => {
    render(<MentionNudgeCard names={['Priya']} error="Could not add them" onAdd={() => {}} onDismiss={() => {}} onDontShowAgain={() => {}} />)
    expect(screen.getByText('Could not add them')).toBeTruthy()
  })
})
