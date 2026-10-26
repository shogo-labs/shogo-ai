// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The stack chip is part of the builder's first frame (SHO-210).
 *
 * `/(app)/new-project` used to paint nothing but the chrome skeleton, and even
 * once the builder mounted the chip returned `null` until `GET
 * /api/tech-stacks` answered — so the type picker popped in seconds later, and
 * every visit refetched. These tests hold the request open (and fail it) and
 * assert the chip is on screen from the first render, then that a second mount
 * does not ask again.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { render, screen } from '@testing-library/react'
import { createElement } from 'react'
import { createReactNativeMock } from '../../../test/react-native-mock'
import { FALLBACK_TECH_STACKS, resetTechStackCache } from '../../../lib/tech-stack-catalog'

const state: {
  getTechStacks: () => Promise<Array<{ id: string; name: string; description: string; tags: string[] }>>
  calls: number
} = {
  getTechStacks: () => new Promise(() => {}),
  calls: 0,
}

mock.module('react-native', () => createReactNativeMock())
mock.module('@shogo/shared-ui/primitives', () => ({
  cn: (...values: unknown[]) => values.filter(Boolean).join(' '),
}))
mock.module('../../../lib/native-phone-layout', () => ({
  useNativePhoneWindow: () => ({ width: 1280, height: 800, isPhone: false }),
  isNativePlatform: () => false,
}))
mock.module('../ComposerPlusMenu', () => ({ useComposerPlusClose: () => undefined }))
mock.module('../WebTooltip', () => ({
  WebTooltip: ({ children }: { children?: unknown }) => children,
}))
mock.module('@/components/ui/popover', () => ({
  Popover: ({
    trigger,
    isOpen,
    children,
  }: {
    trigger: (props: Record<string, unknown>) => unknown
    isOpen: boolean
    children?: unknown
  }) => createElement('div', null, trigger({}) as never, isOpen ? (children as never) : null),
  PopoverBackdrop: () => null,
  PopoverContent: ({ children }: { children?: unknown }) => createElement('div', null, children as never),
}))
mock.module('../../../lib/api', () => ({
  createHttpClient: () => ({}),
  api: {
    getTechStacks: () => {
      state.calls += 1
      return state.getTechStacks()
    },
  },
}))

const { TechStackPicker } = await import('../TechStackPicker')

beforeEach(() => {
  resetTechStackCache()
  state.calls = 0
  state.getTechStacks = () => new Promise(() => {})
})

describe('the stack chip on the first frame', () => {
  test('renders the fallback label while /api/tech-stacks is still in flight', () => {
    render(createElement(TechStackPicker, { value: 'react-app' }))

    // The chip's own label, painted from the fallback catalog with no answer.
    expect(screen.getByText('React App')).toBeTruthy()
    expect(state.calls).toBe(1)
  })

  test('a failed request leaves the chip on the fallback catalog', async () => {
    state.getTechStacks = async () => {
      throw new Error('boom')
    }
    render(createElement(TechStackPicker, { value: 'expo-app' }))

    expect(screen.getByText('Expo (React Native)')).toBeTruthy()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(screen.getByText('Expo (React Native)')).toBeTruthy()
  })

  test('the API list replaces the fallback labels, and a second mount does not refetch', async () => {
    state.getTechStacks = async () => [
      { id: 'react-app', name: 'React App (server)', description: '', tags: [] },
      ...FALLBACK_TECH_STACKS.slice(1),
    ]
    const first = render(createElement(TechStackPicker, { value: 'react-app' }))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(screen.getByText('React App (server)')).toBeTruthy()
    expect(state.calls).toBe(1)

    first.unmount()
    // A second visit paints the cached list synchronously — no empty chip, no
    // second request.
    render(createElement(TechStackPicker, { value: 'react-app' }))
    expect(screen.getByText('React App (server)')).toBeTruthy()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(state.calls).toBe(1)
  })
})
