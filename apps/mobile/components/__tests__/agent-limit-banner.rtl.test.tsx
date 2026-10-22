// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * When more tagged messages arrive than the workspace has agent slots, the extra
 * runs wait in line. The banner is the only place that says so: it has to show
 * the count, send an admin to the stepper, and stay out of the way otherwise.
 */
import { resolve } from 'node:path'
import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { fireEvent, render, screen } from '@testing-library/react'
import { createElement } from 'react'
import { createReactNativeMock } from '../../test/react-native-mock'
import type { AgentCapacity } from '../../lib/team-chat-api'

const capacity: { value: AgentCapacity | null } = { value: null }
const pushes: string[] = []
const experience = { kind: 'team' }

mock.module('react-native', () =>
  createReactNativeMock({
    Platform: { OS: 'web' },
    View: ({ children, testID }: any) => createElement('div', { 'data-testid': testID }, children),
    Pressable: ({ children, onPress, accessibilityLabel, testID }: any) =>
      createElement(
        'button',
        { type: 'button', 'aria-label': accessibilityLabel, 'data-testid': testID, onClick: onPress },
        children,
      ),
    Text: ({ children }: any) => createElement('span', null, children),
  }),
)
mock.module('expo-router', () => ({
  useRouter: () => ({
    push: (href: string) => pushes.push(href),
    replace: () => {},
  }),
}))
mock.module(resolve(import.meta.dir, '../../hooks/useActiveWorkspace'), () => ({
  useActiveWorkspace: () => ({ id: 'ws-1', name: 'Acme' }),
}))
mock.module(resolve(import.meta.dir, '../../hooks/useWorkspaceExperience'), () => ({
  useWorkspaceExperience: () => ({ resolved: true, kind: experience.kind }),
}))
mock.module(resolve(import.meta.dir, '../../hooks/useAgentCapacity'), () => ({
  useAgentCapacity: (workspaceId: string | null) => ({
    capacity: workspaceId ? capacity.value : null,
    error: null,
    saving: false,
    refresh: async () => {},
    setConcurrency: async () => null,
  }),
}))

const { AgentLimitBanner } = await import('../AgentLimitBanner')

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
  pushes.length = 0
  experience.kind = 'team'
  capacity.value = null
})

describe('AgentLimitBanner', () => {
  test('stays hidden while nothing is queued', () => {
    capacity.value = capacityOf({ queued: 0, running: 1 })
    render(createElement(AgentLimitBanner))
    expect(screen.queryByTestId('agent-limit-banner')).toBeNull()
  })

  test('names the backlog and the limit, and links admins to the stepper', () => {
    capacity.value = capacityOf({ queued: 2, limit: 1, running: 1 })
    render(createElement(AgentLimitBanner))

    expect(screen.getByTestId('agent-limit-banner')).toBeTruthy()
    expect(screen.getByTestId('agent-limit-banner').textContent).toContain('2 agents are waiting')
    expect(screen.getByTestId('agent-limit-banner').textContent).toContain('1 works at once')

    fireEvent.click(screen.getByLabelText('Change how many agents work at once'))
    expect(pushes).toEqual(['/(app)/settings?tab=chat&section=agent-concurrency'])
  })

  test('singular for one waiting agent, and no Change link for a non-admin', () => {
    capacity.value = capacityOf({ queued: 1, limit: 2, canManage: false })
    render(createElement(AgentLimitBanner))

    expect(screen.getByTestId('agent-limit-banner').textContent).toContain('An agent is waiting')
    expect(screen.getByTestId('agent-limit-banner').textContent).toContain('2 work at once')
    expect(screen.queryByLabelText('Change how many agents work at once')).toBeNull()
  })

  test('a dismissal hides it until the queue empties', () => {
    capacity.value = capacityOf({ queued: 3 })
    const { rerender } = render(createElement(AgentLimitBanner))

    fireEvent.click(screen.getByLabelText('Dismiss'))
    expect(screen.queryByTestId('agent-limit-banner')).toBeNull()

    // Still queued: the dismissal holds.
    rerender(createElement(AgentLimitBanner))
    expect(screen.queryByTestId('agent-limit-banner')).toBeNull()

    // A fresh backlog after the line drained is news again.
    capacity.value = capacityOf({ queued: 0, running: 1 })
    rerender(createElement(AgentLimitBanner))
    capacity.value = capacityOf({ queued: 2 })
    rerender(createElement(AgentLimitBanner))
    expect(screen.getByTestId('agent-limit-banner')).toBeTruthy()
  })

  test('says nothing outside a team workspace', () => {
    experience.kind = 'local'
    capacity.value = capacityOf({ queued: 4 })
    render(createElement(AgentLimitBanner))
    expect(screen.queryByTestId('agent-limit-banner')).toBeNull()
  })
})
