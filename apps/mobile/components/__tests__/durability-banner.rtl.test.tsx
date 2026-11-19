// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * A runtime whose work has not reached durable storage is one stop away from
 * losing it. On 2026-11-15 a workspace saved nothing for a day and a half while
 * the user kept working, and no surface said so (SHO-442). This banner is that
 * surface, so it has to appear for both failing states, say how long, and stay
 * out of the way when the save is fine.
 */
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { render, screen, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { createReactNativeMock } from '../../test/react-native-mock'

const state: { pathname: string; durability: any; fail: boolean } = {
  pathname: '/projects/proj-1',
  durability: null,
  fail: false,
}
const requested: string[] = []

mock.module('react-native', () =>
  createReactNativeMock({
    Platform: { OS: 'web' },
    View: ({ children, testID }: any) => createElement('div', { 'data-testid': testID }, children),
    Text: ({ children }: any) => createElement('span', null, children),
  }),
)
mock.module('expo-router', () => ({
  usePathname: () => state.pathname,
}))
mock.module(resolve(import.meta.dir, '../../contexts/domain'), () => ({
  useDomainHttp: () => ({
    get: async (path: string) => {
      requested.push(path)
      if (state.fail) throw new Error('boom')
      return { data: { durability: state.durability } }
    },
  }),
}))
mock.module(resolve(import.meta.dir, '../settings/account-sheet-chrome'), () => ({
  Text: ({ children }: any) => createElement('span', null, children),
}))

const { DurabilityBanner, formatUnsavedFor } = await import('../DurabilityBanner')

const banner = () => screen.queryByTestId('durability-banner')

beforeEach(() => {
  requested.length = 0
  state.pathname = '/projects/proj-1'
  state.durability = null
  state.fail = false
})

afterEach(() => {
  state.durability = null
})

describe('DurabilityBanner', () => {
  test('says nothing while the save is fine', async () => {
    state.durability = { state: 'ok', since: Date.now() }
    render(createElement(DurabilityBanner))

    await waitFor(() => expect(requested.length).toBeGreaterThan(0))
    expect(banner()).toBeNull()
  })

  test('says nothing outside a project route', async () => {
    state.pathname = '/home'
    state.durability = { state: 'saving-failing', since: Date.now() - 60_000 }
    render(createElement(DurabilityBanner))

    expect(banner()).toBeNull()
    expect(requested).toEqual([])
  })

  test('a failing save says how long, and that the workspace is being kept running', async () => {
    state.durability = { state: 'saving-failing', since: Date.now() - 3 * 60_000 }
    render(createElement(DurabilityBanner))

    await waitFor(() => expect(banner()).not.toBeNull())
    expect(banner()!.textContent).toContain("Your latest changes aren't backed up yet")
    expect(banner()!.textContent).toContain('since 3m ago')
    expect(banner()!.textContent).toContain("We're keeping this workspace running until they are.")
  })

  test('an untrusted runtime says it cannot save, and not to close it', async () => {
    state.durability = { state: 'untrusted', since: Date.now() - 26 * 3_600_000, reason: 'hydrate failed' }
    render(createElement(DurabilityBanner))

    await waitFor(() => expect(banner()).not.toBeNull())
    expect(banner()!.textContent).toContain("This workspace can't save to its history right now.")
    expect(banner()!.textContent).toContain("don't close it")
    expect(banner()!.textContent).toContain('since 1d 2h ago')
  })

  test('a failed status probe keeps the last known state instead of flashing off', async () => {
    state.durability = { state: 'saving-failing', since: Date.now() - 60_000 }
    const { rerender } = render(createElement(DurabilityBanner))
    await waitFor(() => expect(banner()).not.toBeNull())

    state.fail = true
    rerender(createElement(DurabilityBanner))

    expect(banner()).not.toBeNull()
  })

  test('asks the project it is on, not a cached one', async () => {
    state.pathname = '/projects/proj-9/chat'
    render(createElement(DurabilityBanner))

    await waitFor(() => expect(requested.length).toBeGreaterThan(0))
    expect(requested[0]).toBe('/api/projects/proj-9/runtime/status')
  })
})

describe('formatUnsavedFor', () => {
  test('reads as a duration a person can act on', () => {
    expect(formatUnsavedFor(30_000)).toBe('less than a minute')
    expect(formatUnsavedFor(5 * 60_000)).toBe('5m')
    expect(formatUnsavedFor(3 * 3_600_000)).toBe('3h')
    expect(formatUnsavedFor(3 * 3_600_000 + 12 * 60_000)).toBe('3h 12m')
    expect(formatUnsavedFor(26 * 3_600_000)).toBe('1d 2h')
    expect(formatUnsavedFor(48 * 3_600_000)).toBe('2d')
  })
})
