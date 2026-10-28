// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Admin → Active devices: per-machine list.
 *
 * The version table says which builds are installed; this list says which
 * machines are still running. These assertions cover what an operator reads off
 * it: the online/active/dormant headline, dormant keys hidden until asked for,
 * the idle age, and the OS / CLI filters.
 */

import { describe, expect, mock, test } from 'bun:test'
import { fireEvent, render, screen } from '@testing-library/react'
import { createElement } from 'react'
import { createReactNativeMock } from '../../../test/react-native-mock'

mock.module('react-native', () =>
  createReactNativeMock({
    useWindowDimensions: () => ({ width: 1024, height: 768, scale: 1, fontScale: 1 }),
    Pressable: ({ onPress, children, ...props }: any) =>
      createElement('button', { ...props, onClick: onPress }, children),
  }),
)
mock.module('@shogo/shared-ui/primitives', () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
}))

const { ActiveDevicesPanel, formatIdle } = await import('../ActiveDevicesPanel')

const device = (over: Record<string, any> = {}) => ({
  id: 'a1b2c3d4e5',
  client: 'desktop' as const,
  os: 'macos' as const,
  osLabel: 'macOS',
  arch: 'arm64' as string | null,
  version: '2.3.6',
  channel: 'stable' as const,
  userId: 'user-1' as string | null,
  firstSeenAt: '2026-07-01T00:00:00.000Z',
  lastSeenAt: '2026-10-21T08:00:00.000Z',
  online: false,
  idleHours: 1 as number | null,
  ...over,
})

const data = (over: Record<string, any> = {}) => ({
  generatedAt: '2026-10-21T08:03:00.000Z',
  onlineWindowMinutes: 15,
  windowDays: 30,
  includeDormant: true,
  totals: { devices: 189, online: 9, active: 34, dormant: 155 },
  devices: [
    device({ id: 'online-1', online: true, idleHours: 0 }),
    device({ id: 'ok-2', idleHours: 3 }),
    device({
      id: 'beta-3',
      version: '2.3.6-beta.20261020',
      channel: 'beta',
      os: 'windows',
      osLabel: 'Windows',
      arch: 'x64',
      idleHours: 30,
    }),
    device({ id: 'cli-4', client: 'cli', version: 'shogo-cli/1.4.0', idleHours: 2 }),
    // 90 days idle — a stale key, not a running machine.
    device({ id: 'dormant-5', version: '1.12.7', idleHours: 24 * 90 }),
  ],
  ...over,
})

describe('ActiveDevicesPanel', () => {
  test('headline reports online now, active in window and live keys', () => {
    render(createElement(ActiveDevicesPanel, { data: data() }))
    expect(screen.getByText('1 online now · 4 active in 30d · 189 live keys')).toBeTruthy()
    expect(screen.getByText(/155 of 189 keys are dormant/)).toBeTruthy()
    expect(screen.getByText(/heartbeat in the last 15 min/)).toBeTruthy()
  })

  test('online and recently-seen devices render, dormant keys stay hidden', () => {
    render(createElement(ActiveDevicesPanel, { data: data() }))
    expect(screen.getByText('online-1')).toBeTruthy()
    expect(screen.getByText('ok-2')).toBeTruthy()
    // 1.12.7 is 90 days idle — hidden until asked for.
    expect(screen.queryByText('dormant-5')).toBeNull()
    expect(screen.getByText('Showing 4 of 5 devices')).toBeTruthy()
  })

  test('toggling dormant keys reveals the stale ones with their idle age', () => {
    render(createElement(ActiveDevicesPanel, { data: data() }))
    fireEvent.click(screen.getByText(/Show dormant keys/))
    expect(screen.getByText('dormant-5')).toBeTruthy()
    expect(screen.getByText('90d')).toBeTruthy()
  })

  test('beta and CLI devices are labelled, not merged into desktop', () => {
    render(createElement(ActiveDevicesPanel, { data: data() }))
    expect(screen.getByText('Beta')).toBeTruthy()
    expect(screen.getByText('CLI')).toBeTruthy()
    expect(screen.getByText('Windows')).toBeTruthy()
  })

  test('the CLI chip narrows the list to CLI devices', () => {
    render(createElement(ActiveDevicesPanel, { data: data() }))
    fireEvent.click(screen.getByText('CLI · 1'))
    expect(screen.getByText('shogo-cli/1.4.0')).toBeTruthy()
    expect(screen.queryByText('online-1')).toBeNull()
    expect(screen.queryByText('ok-2')).toBeNull()
  })

  test('no data does not crash the panel', () => {
    render(createElement(ActiveDevicesPanel, { data: null }))
    expect(screen.getByText('No device data')).toBeTruthy()
  })
})

describe('formatIdle', () => {
  test('online wins over the reported age', () => {
    expect(formatIdle(3, true)).toBe('online')
  })

  test('minutes, hours and days read naturally', () => {
    expect(formatIdle(0.2, false)).toBe('12m')
    expect(formatIdle(5, false)).toBe('5h')
    expect(formatIdle(72, false)).toBe('3d')
    expect(formatIdle(null, false)).toBe('never')
  })
})
