// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * `PresenceDot` is the single place a person's status is rendered, so the
 * huddle badge belongs here rather than at its seven call sites: a headphone
 * icon takes the dot's place while they are on a call.
 */
import { resolve } from 'node:path'
import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { render } from '@testing-library/react'
import { createElement } from 'react'
import { createReactNativeMock } from '../../../test/react-native-mock'

let status: string | null = 'active'
let inHuddle = false

mock.module('react-native', () =>
  createReactNativeMock({
    Platform: { OS: 'web' },
    Pressable: ({ accessibilityLabel, children, onPress, ...props }: any) =>
      createElement('button', { ...props, 'aria-label': accessibilityLabel, onClick: onPress }, children),
  }),
)
mock.module('@shogo/shared-ui/primitives', () => ({ cn: (...args: unknown[]) => args.filter(Boolean).join(' ') }))
mock.module('lucide-react-native', () => ({
  Headphones: ({ accessibilityLabel, testID, size, className }: any) =>
    createElement('span', { 'data-icon': 'headphones', 'aria-label': accessibilityLabel, 'data-testid': testID, 'data-size': size, className }),
}))
mock.module(resolve(import.meta.dir, '../../../hooks/usePresence'), () => ({
  usePresence: () => status,
  useInHuddle: () => inHuddle,
}))

const { PresenceDot } = await import('../PresenceDot')

const dot = (container: HTMLElement) => container.querySelector('[data-rn-shim]')
const icon = (container: HTMLElement) => container.querySelector('[data-testid="in-huddle"]')

beforeEach(() => {
  status = 'active'
  inHuddle = false
})

describe('PresenceDot', () => {
  test('shows the status dot when nobody is in a huddle', () => {
    const { container } = render(createElement(PresenceDot, { userId: 'sam', workspaceId: 'ws-1' }))
    expect(dot(container)?.getAttribute('data-rn-shim')).toBe('presence-active')
    expect(icon(container)).toBeNull()
  })

  test('shows headphones instead of the dot while in a huddle', () => {
    inHuddle = true
    const { container } = render(createElement(PresenceDot, { userId: 'sam', workspaceId: 'ws-1' }))
    expect(icon(container)).not.toBeNull()
    expect(dot(container)).toBeNull()
    expect(icon(container)?.className).toContain('text-emerald-600')
    expect(icon(container)?.getAttribute('aria-label')).toBe('In a huddle')
  })

  test('the badge is not hidden by the active/away rule, since a call outlasts a socket', () => {
    inHuddle = true
    status = 'offline'
    const { container } = render(createElement(PresenceDot, { userId: 'sam', workspaceId: 'ws-1', badge: true }))
    expect(icon(container)).not.toBeNull()
  })

  test('a badge hides when the person is neither active nor away', () => {
    status = 'offline'
    const { container } = render(createElement(PresenceDot, { userId: 'sam', workspaceId: 'ws-1', badge: true }))
    expect(dot(container)).toBeNull()
    expect(icon(container)).toBeNull()
  })

  test('renders nothing without a user', () => {
    const { container } = render(createElement(PresenceDot, { userId: null, workspaceId: 'ws-1' }))
    expect(container.innerHTML).toBe('')
  })
})
