// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * When more tagged messages arrive than the workspace has agent slots, the extra
 * runs wait in line. This banner is the only place that says so, and the action
 * it offers has to match the surface: in the cloud at the plan ceiling the
 * stepper cannot go any higher, so the only useful button is Upgrade; on the
 * desktop (or a cloud workspace an admin lowered) it is the stepper.
 */
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
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
    realtime: 'open',
    refresh: async () => {},
    setConcurrency: async () => null,
  }),
}))

const { AgentLimitBanner, _resetAgentLimitBannerForTests } = await import('../AgentLimitBanner')

function capacityOf(partial: Partial<AgentCapacity>): AgentCapacity {
  return {
    limit: 8,
    max: 8,
    defaultLimit: 8,
    configured: null,
    source: 'plan',
    planId: 'pro',
    running: 8,
    parked: 0,
    queued: 3,
    canManage: true,
    ...partial,
  }
}

const banner = () => screen.getByTestId('agent-limit-banner')

beforeEach(() => {
  pushes.length = 0
  experience.kind = 'team'
  capacity.value = null
  _resetAgentLimitBannerForTests()
})

afterEach(() => {
  _resetAgentLimitBannerForTests()
})

describe('AgentLimitBanner', () => {
  test('stays hidden while nothing is queued', () => {
    capacity.value = capacityOf({ queued: 0 })
    render(createElement(AgentLimitBanner))
    expect(screen.queryByTestId('agent-limit-banner')).toBeNull()
  })

  test('cloud at the plan ceiling: counts, plan line, and Upgrade → Billing', () => {
    capacity.value = capacityOf({ limit: 8, max: 8, running: 8, queued: 3, source: 'plan', planId: 'pro' })
    render(createElement(AgentLimitBanner))

    expect(banner().textContent).toContain('Agent limit reached: 8 running, 3 queued.')
    expect(banner().textContent).toContain('Your Pro plan runs up to 8 at once.')

    fireEvent.click(screen.getByLabelText('Upgrade your plan'))
    expect(pushes).toEqual(['/(app)/settings?tab=billing'])
  })

  test('names every plan tier, including the one with no decoration', () => {
    // `basic` is a real plan id and the only one whose name is not its id
    // capitalised by luck; a lookup table that missed it printed "basic".
    capacity.value = capacityOf({ limit: 4, max: 4, running: 4, queued: 1, source: 'plan', planId: 'basic' })
    render(createElement(AgentLimitBanner))
    expect(banner().textContent).toContain('Your Basic plan runs up to 4 at once.')
  })

  test('cloud with the limit lowered below the plan: the stepper is the fix, not an upgrade', () => {
    capacity.value = capacityOf({ limit: 2, max: 8, configured: 2, running: 2, queued: 1 })
    render(createElement(AgentLimitBanner))

    expect(banner().textContent).toContain('Your Pro plan runs up to 8 at once.')
    fireEvent.click(screen.getByLabelText('Change settings'))
    expect(pushes).toEqual(['/(app)/settings?tab=chat&section=agent-concurrency'])
  })

  test('desktop: no plan text, and Change settings → the concurrency stepper', () => {
    capacity.value = capacityOf({
      limit: 24,
      max: 24,
      defaultLimit: 24,
      configured: null,
      source: 'local',
      planId: 'free',
      running: 24,
      queued: 2,
    })
    render(createElement(AgentLimitBanner))

    expect(banner().textContent).toContain('Agent limit reached: 24 running, 2 queued.')
    expect(banner().textContent).toContain('This desktop runs up to 24 at once.')
    expect(banner().textContent).not.toContain('plan runs up to')

    fireEvent.click(screen.getByLabelText('Change settings'))
    expect(pushes).toEqual(['/(app)/settings?tab=chat&section=agent-concurrency'])
  })

  test('a viewer gets the counts but no action', () => {
    capacity.value = capacityOf({ canManage: false })
    render(createElement(AgentLimitBanner))

    expect(banner().textContent).toContain('3 queued')
    expect(screen.queryByLabelText('Upgrade your plan')).toBeNull()
    expect(screen.queryByLabelText('Change settings')).toBeNull()
  })

  test('a dismissal hides it until the queue drains, and a fresh backlog brings it back', () => {
    capacity.value = capacityOf({ queued: 3 })
    const { rerender } = render(createElement(AgentLimitBanner))

    fireEvent.click(screen.getByLabelText('Dismiss'))
    expect(screen.queryByTestId('agent-limit-banner')).toBeNull()

    // Still queued: the dismissal holds across a re-render (and a remount).
    rerender(createElement(AgentLimitBanner))
    expect(screen.queryByTestId('agent-limit-banner')).toBeNull()

    capacity.value = capacityOf({ queued: 0 })
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
