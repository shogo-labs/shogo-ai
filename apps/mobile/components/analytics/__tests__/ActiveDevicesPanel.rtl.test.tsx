// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Admin → Active devices: last-seen bar chart + disclosure (SHO-477).
 *
 * The old panel showed a flat per-device table by default. The new one shows a
 * recency bar chart; the per-device list is hidden until "Show devices" is
 * tapped. These assertions cover: headline, bar chart bucket labels, the
 * disclosure toggle, dormant-key gating, OS/CLI chips, and unit tests for
 * `bucketDevicesByRecency`.
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

const { ActiveDevicesPanel, formatIdle, bucketDevicesByRecency } = await import('../ActiveDevicesPanel')

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
  test('headline counts every number from the same device set', () => {
    render(createElement(ActiveDevicesPanel, { data: data() }))
    // Five devices in the payload: one online, four active in 30d, one dormant.
    expect(screen.getByText('1 online now · 4 active in 30d · 1 dormant')).toBeTruthy()
    // The global total is named as global, so it can't be read as this chip's count.
    expect(screen.getByText(/Across all keys, 155 of 189 are dormant/)).toBeTruthy()
    expect(screen.getByText(/heartbeat in the last 15 min/)).toBeTruthy()
  })

  test('a chip filter keeps the headline, bars and dormant count on that chip', () => {
    render(createElement(ActiveDevicesPanel, { data: data() }))
    fireEvent.click(screen.getByRole('button', { name: 'Windows · 1' }))
    // The only Windows device is 30 h idle: not online, not active in 30d? it is
    // (30 h < 30 d), so it is active and nothing on this chip is dormant.
    expect(screen.getByText('0 online now · 1 active in 30d · 0 dormant')).toBeTruthy()
  })

  test('a failed device-activity trend is named, not shown as a flat line', () => {
    render(createElement(ActiveDevicesPanel, { data: data(), trendError: 'HTTP 500' }))
    expect(screen.getByText("Couldn't load the device activity trend: HTTP 500")).toBeTruthy()
  })

  test('recency bar chart labels are visible', () => {
    render(createElement(ActiveDevicesPanel, { data: data() }))
    for (const label of ['Online now', 'Today', '1–7 days', '7–30 days', 'Dormant']) {
      expect(screen.getByText(label)).toBeTruthy()
    }
  })

  test('per-device list is hidden until "Show devices" is pressed', () => {
    render(createElement(ActiveDevicesPanel, { data: data() }))
    // Devices are behind the disclosure by default.
    expect(screen.queryByText('online-1')).toBeNull()
    expect(screen.queryByText('ok-2')).toBeNull()
    // The toggle button is visible.
    expect(screen.getByText(/Show devices/)).toBeTruthy()
  })

  test('pressing "Show devices" reveals the online and recently-seen rows', () => {
    render(createElement(ActiveDevicesPanel, { data: data() }))
    fireEvent.click(screen.getByText(/Show devices/))
    expect(screen.getByText('online-1')).toBeTruthy()
    expect(screen.getByText('ok-2')).toBeTruthy()
    // 1.12.7 is 90 days idle — still hidden until dormant toggle.
    expect(screen.queryByText('dormant-5')).toBeNull()
    expect(screen.getByText('Showing 4 of 5 devices')).toBeTruthy()
  })

  test('toggling dormant keys after opening the list reveals the stale ones', () => {
    render(createElement(ActiveDevicesPanel, { data: data() }))
    fireEvent.click(screen.getByText(/Show devices/))
    fireEvent.click(screen.getByText(/Show dormant keys/))
    expect(screen.getByText('dormant-5')).toBeTruthy()
    expect(screen.getByText('90d')).toBeTruthy()
  })

  test('beta and CLI devices are labelled inside the per-device list', () => {
    render(createElement(ActiveDevicesPanel, { data: data() }))
    fireEvent.click(screen.getByText(/Show devices/))
    expect(screen.getByText('Beta')).toBeTruthy()
    expect(screen.getByText('CLI')).toBeTruthy()
    // 'Windows' appears in both the bar chart OS legend and the device row osLabel.
    expect(screen.getAllByText('Windows').length).toBeGreaterThan(0)
  })

  test('the CLI chip narrows the list to CLI devices', () => {
    render(createElement(ActiveDevicesPanel, { data: data() }))
    fireEvent.click(screen.getByText('CLI · 1'))
    fireEvent.click(screen.getByText(/Show devices/))
    expect(screen.getByText('shogo-cli/1.4.0')).toBeTruthy()
    expect(screen.queryByText('online-1')).toBeNull()
    expect(screen.queryByText('ok-2')).toBeNull()
  })

  test('no data does not crash the panel', () => {
    render(createElement(ActiveDevicesPanel, { data: null }))
    expect(screen.getByText('No device data')).toBeTruthy()
  })

  test('renders the devices trend with "Tracking since" once there are two days', () => {
    const trend = {
      trackingSince: '2026-10-20',
      points: [
        { date: '2026-10-20', daily: 2, weekly: 2, monthly: 2, byOs: { macos: 2, windows: 0, linux: 0, unknown: 0 }, byClient: { desktop: 2, cli: 0 } },
        { date: '2026-10-21', daily: 3, weekly: 3, monthly: 3, byOs: { macos: 2, windows: 1, linux: 0, unknown: 0 }, byClient: { desktop: 2, cli: 1 } },
      ],
    }
    render(createElement(ActiveDevicesPanel, { data: data(), trend }))
    expect(screen.getByText('Active devices over time')).toBeTruthy()
    expect(screen.getByText(/Tracking since/)).toBeTruthy()
  })

  test('says when collection started while there is under two days of data', () => {
    const trend = {
      trackingSince: '2026-10-21',
      points: [
        { date: '2026-10-21', daily: 2, weekly: 2, monthly: 2, byOs: { macos: 2, windows: 0, linux: 0, unknown: 0 }, byClient: { desktop: 2, cli: 0 } },
      ],
    }
    render(createElement(ActiveDevicesPanel, { data: data(), trend }))
    expect(screen.getByText(/Collecting data since/)).toBeTruthy()
  })

  test('days before trackingSince are not drawn, so one tracked day is not a trend', () => {
    // 30 zero-filled days from the API, but the table only started yesterday:
    // trimming to `trackingSince` must leave one point, not thirty zeros.
    const points = Array.from({ length: 30 }, (_, i) => {
      const d = new Date('2026-09-22T00:00:00Z')
      d.setUTCDate(d.getUTCDate() + i)
      return {
        date: d.toISOString().slice(0, 10),
        daily: d.toISOString().slice(0, 10) === '2026-10-21' ? 4 : 0,
        weekly: 4,
        monthly: 4,
        byOs: { macos: 4, windows: 0, linux: 0, unknown: 0 },
        byClient: { desktop: 4, cli: 0 },
      }
    })
    render(createElement(ActiveDevicesPanel, { data: data(), trend: { trackingSince: '2026-10-21', points } }))
    expect(screen.getByText(/Collecting data since/)).toBeTruthy()
  })

  test('a null trend (never recorded) does not crash the panel', () => {
    render(createElement(ActiveDevicesPanel, { data: data(), trend: null }))
    expect(screen.getByText(/Collecting data/)).toBeTruthy()
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

describe('bucketDevicesByRecency', () => {
  test('buckets sum to the full device count', () => {
    const devices = [
      device({ id: 'd1', online: true, idleHours: 0 }),
      device({ id: 'd2', idleHours: 3 }),
      device({ id: 'd3', idleHours: 30 }),
      device({ id: 'd4', idleHours: 100 }),
      device({ id: 'd5', idleHours: null }),
    ]
    const buckets = bucketDevicesByRecency(devices)
    const total = buckets.reduce((s, b) => s + b.total, 0)
    expect(total).toBe(devices.length)
  })

  test('"Online now" bucket agrees with device.online flag', () => {
    const devices = [
      device({ id: 'on', online: true, idleHours: 0 }),
      device({ id: 'off', online: false, idleHours: 2 }),
    ]
    const buckets = bucketDevicesByRecency(devices)
    const online = buckets.find((b) => b.label === 'Online now')!
    expect(online.total).toBe(1)
  })

  test('"Dormant" covers > 30d idle and null lastSeen', () => {
    const devices = [
      device({ id: 'stale', idleHours: 24 * 31 }),
      device({ id: 'never', idleHours: null }),
    ]
    const buckets = bucketDevicesByRecency(devices)
    const dormant = buckets.find((b) => b.label === 'Dormant')!
    expect(dormant.total).toBe(2)
  })
})
