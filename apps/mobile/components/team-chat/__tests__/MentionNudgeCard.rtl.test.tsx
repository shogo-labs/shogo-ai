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

// The real markdown renderer is exercised elsewhere; here the notice's own
// copy is what matters, so unwrap its mention links back to `@Name`.
mock.module('../../chat/ChatMarkdown', () => ({
  ChatMarkdown: ({ children }: any) =>
    createElement('div', null, String(children).replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')),
}))
mock.module('../AgentAvatar', () => ({
  AgentAvatar: () => createElement('div', { 'data-rn-shim': 'agent-avatar' }),
}))

const { MentionNudgeCard } = await import('../MentionNudgeCard')

afterEach(cleanup)

const names = {
  users: new Map<string, string>([['u-1', 'Priya'], ['u-2', 'Ana'], ['u-3', 'Sam']]),
  agents: new Map<string, string>(),
}
const base = { names, createdAt: '2026-10-16T10:00:00.000Z', onAdd: () => {}, onDismiss: () => {}, onDontShowAgain: () => {} }

describe('MentionNudgeCard', () => {
  test('reads as a Shogo ephemeral, only visible to the sender', () => {
    const { container } = render(<MentionNudgeCard ids={['u-1']} {...base} />)
    expect(container.querySelector('[data-rn-shim="mention-nudge-card"]')).toBeTruthy()
    expect(screen.getByText('Shogo')).toBeTruthy()
    expect(screen.getByText('Only visible to you')).toBeTruthy()
    expect(screen.getByText("You mentioned @Priya, but they're not in this channel.")).toBeTruthy()
    expect(screen.getByLabelText('Add them to this channel')).toBeTruthy()
  })

  test('says "private channel" when the channel is private, as Slack does', () => {
    render(<MentionNudgeCard ids={['u-1']} isPrivate {...base} />)
    expect(screen.getByText("You mentioned @Priya, but they're not in this private channel.")).toBeTruthy()
  })

  test('lists everyone mentioned in one sentence', () => {
    render(<MentionNudgeCard ids={['u-2', 'u-1', 'u-3']} {...base} />)
    expect(screen.getByText("You mentioned @Ana, @Priya, @Sam, but they're not in this channel.")).toBeTruthy()
  })

  test('renders nothing when there is nobody to flag', () => {
    const { container } = render(<MentionNudgeCard ids={[]} {...base} />)
    expect(container.querySelector('[data-rn-shim="mention-nudge-card"]')).toBeNull()
  })

  test('Add them, Dismiss, and Don\'t show again each call their handler', () => {
    const onAdd = mock(() => {})
    const onDismiss = mock(() => {})
    const onDontShowAgain = mock(() => {})
    render(<MentionNudgeCard ids={['u-1']} names={names} createdAt={base.createdAt} onAdd={onAdd} onDismiss={onDismiss} onDontShowAgain={onDontShowAgain} />)
    fireEvent.click(screen.getByLabelText('Add them to this channel'))
    fireEvent.click(screen.getByLabelText('Dismiss'))
    fireEvent.click(screen.getByLabelText("Don't show this again"))
    expect(onAdd).toHaveBeenCalledTimes(1)
    expect(onDismiss).toHaveBeenCalledTimes(1)
    expect(onDontShowAgain).toHaveBeenCalledTimes(1)
  })

  test('while busy, Add them is disabled and says so', () => {
    const onAdd = mock(() => {})
    render(<MentionNudgeCard ids={['u-1']} busy {...base} onAdd={onAdd} />)
    expect(screen.getByText('Adding…')).toBeTruthy()
    fireEvent.click(screen.getByLabelText('Add them to this channel'))
    expect(onAdd).not.toHaveBeenCalled()
  })

  test('shows an error from a failed add', () => {
    render(<MentionNudgeCard ids={['u-1']} error="Could not add them" {...base} />)
    expect(screen.getByText('Could not add them')).toBeTruthy()
  })
})
