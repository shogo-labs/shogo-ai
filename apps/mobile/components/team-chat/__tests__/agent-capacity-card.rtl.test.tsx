// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Settings → Chat → Agent replies. The stepper must never offer a number the
 * server would refuse (below 1, above the plan's ceiling), and whatever the
 * workspace inherits has to be visible: an admin needs to know whether raising
 * the number is a setting or a plan change.
 */
import { resolve } from 'node:path'
import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { fireEvent, render, screen } from '@testing-library/react'
import { createElement } from 'react'
import { createReactNativeMock } from '../../../test/react-native-mock'
import type { AgentCapacity } from '../../../lib/team-chat-api'

const state: { capacity: AgentCapacity | null; error: string | null } = { capacity: null, error: null }
const saves: Array<number | null> = []

mock.module('react-native', () =>
  createReactNativeMock({
    Platform: { OS: 'web' },
    View: ({ children, testID, nativeID }: any) =>
      createElement('div', { id: nativeID, 'data-testid': testID }, children),
    Pressable: ({ children, onPress, disabled, accessibilityLabel, testID }: any) =>
      createElement(
        'button',
        {
          type: 'button',
          'aria-label': accessibilityLabel,
          'data-testid': testID,
          'aria-disabled': disabled ? 'true' : undefined,
          onClick: disabled ? undefined : onPress,
        },
        children,
      ),
    Text: ({ children, testID }: any) => createElement('span', { 'data-testid': testID }, children),
  }),
)
mock.module('@shogo/shared-ui/primitives', () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
}))
mock.module(resolve(import.meta.dir, '../../settings/account-sheet-chrome'), () => ({
  Text: ({ children, testID }: any) => createElement('span', { 'data-testid': testID }, children),
}))
mock.module(resolve(import.meta.dir, '../../../hooks/useAgentCapacity'), () => ({
  useAgentCapacity: () => ({
    capacity: state.capacity,
    error: state.error,
    saving: false,
    refresh: async () => {},
    setConcurrency: async (next: number | null) => {
      saves.push(next)
      return null
    },
  }),
}))

const { AgentCapacityCard } = await import('../AgentCapacityCard')

function capacityOf(partial: Partial<AgentCapacity>): AgentCapacity {
  return {
    limit: 1,
    max: 3,
    defaultLimit: 3,
    configured: null,
    source: 'plan',
    planId: 'pro',
    running: 1,
    parked: 0,
    queued: 0,
    canManage: true,
    ...partial,
  }
}

beforeEach(() => {
  saves.length = 0
  state.error = null
  state.capacity = capacityOf({})
})

describe('AgentCapacityCard', () => {
  test('steps the limit down and up within the plan ceiling', () => {
    state.capacity = capacityOf({ limit: 2, max: 3 })
    render(createElement(AgentCapacityCard, { workspaceId: 'ws-1' }))

    expect(screen.getByTestId('agent-capacity-value').textContent).toBe('2')

    fireEvent.click(screen.getByLabelText('More agents at once'))
    fireEvent.click(screen.getByLabelText('Fewer agents at once'))
    expect(saves).toEqual([3, 1])
  })

  test('cannot go below one or above the plan', () => {
    state.capacity = capacityOf({ limit: 1, max: 3 })
    const { rerender } = render(createElement(AgentCapacityCard, { workspaceId: 'ws-1' }))

    fireEvent.click(screen.getByLabelText('Fewer agents at once'))
    expect(saves).toEqual([])
    expect(screen.getByLabelText('Fewer agents at once').getAttribute('aria-disabled')).toBe('true')

    state.capacity = capacityOf({ limit: 3, max: 3 })
    rerender(createElement(AgentCapacityCard, { workspaceId: 'ws-1' }))
    fireEvent.click(screen.getByLabelText('More agents at once'))
    expect(saves).toEqual([])
  })

  test('says where the ceiling comes from', () => {
    state.capacity = capacityOf({ limit: 3, max: 3, source: 'plan', planId: 'pro' })
    const { rerender } = render(createElement(AgentCapacityCard, { workspaceId: 'ws-1' }))
    expect(screen.getByTestId('agent-capacity-card').textContent).toContain('Your Pro plan allows up to 3')

    state.capacity = capacityOf({ limit: 6, max: 24, defaultLimit: 24, source: 'local' })
    rerender(createElement(AgentCapacityCard, { workspaceId: 'ws-1' }))
    expect(screen.getByTestId('agent-capacity-card').textContent).toContain('Desktop default is 24')
  })

  test('shows the live queue so an admin can see the backlog they are fixing', () => {
    state.capacity = capacityOf({ limit: 1, running: 1, parked: 2, queued: 4 })
    render(createElement(AgentCapacityCard, { workspaceId: 'ws-1' }))
    expect(screen.getByTestId('agent-capacity-card').textContent).toContain('1 working · 4 waiting for a slot')
  })

  test('offers the default only when the workspace overrides it', () => {
    state.capacity = capacityOf({ limit: 2, configured: 2 })
    const { rerender } = render(createElement(AgentCapacityCard, { workspaceId: 'ws-1' }))

    fireEvent.click(screen.getByTestId('agent-capacity-reset'))
    expect(saves).toEqual([null])

    state.capacity = capacityOf({ limit: 3, configured: null })
    rerender(createElement(AgentCapacityCard, { workspaceId: 'ws-1' }))
    expect(screen.queryByTestId('agent-capacity-reset')).toBeNull()
  })

  test('a viewer sees the number but no stepper', () => {
    state.capacity = capacityOf({ limit: 2, canManage: false })
    render(createElement(AgentCapacityCard, { workspaceId: 'ws-1' }))

    expect(screen.getByTestId('agent-capacity-value').textContent).toBe('2')
    expect(screen.queryByLabelText('More agents at once')).toBeNull()
  })

  test('surfaces the server’s refusal instead of silently reverting', () => {
    state.error = 'Your pro plan allows at most 3 agents working at once. Upgrade to raise it.'
    render(createElement(AgentCapacityCard, { workspaceId: 'ws-1' }))
    expect(screen.getByTestId('agent-capacity-error').textContent).toContain('Upgrade to raise it')
  })
})
