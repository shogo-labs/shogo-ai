// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Admin → App Installs: OS×version panel.
 *
 * Regression cover for the old card, which sliced versions/platforms to 4 rows
 * and rendered `darwin-arm64` as its own OS. These assertions are about what an
 * admin actually sees: the on-latest headline, every version (no truncation),
 * the Beta chip, and the OS / CLI filters.
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

const { AppVersionsPanel } = await import('../AppVersionsPanel')

const emptyOs = { macos: 0, windows: 0, linux: 0, unknown: 0 }

const versionRow = (over: Record<string, any> = {}) => ({
  version: '2.3.6',
  channel: 'stable' as const,
  devices: 1,
  activeD7: 1,
  firstSeenAt: '2026-10-01T00:00:00.000Z',
  lastSeenAt: '2026-10-21T00:00:00.000Z',
  os: { ...emptyOs },
  ...over,
})

const desktop: any = {
  totalDevices: 6,
  active: { d1: 3, d7: 4, d30: 6 },
  newLast30d: 2,
  distinctUsers: 6,
  byVersion: [],
  byPlatform: [],
  byOs: [],
  onLatest: { version: '2.3.6', devices: 2, pct: 33, source: 'deployed' },
  versions: [
    versionRow({ version: '2.3.6', devices: 2, os: { ...emptyOs, macos: 1, windows: 1 } }),
    versionRow({ version: '2.3.5', devices: 1, os: { ...emptyOs, macos: 1 } }),
    versionRow({
      version: '2.3.4-beta.20261018t122519',
      channel: 'beta',
      devices: 1,
      os: { ...emptyOs, windows: 1 },
    }),
    versionRow({ version: '2.2.0', devices: 1, os: { ...emptyOs, linux: 1 } }),
    versionRow({ version: '1.5.1', devices: 1, os: { ...emptyOs, macos: 1 } }),
  ],
}

const cli: any = {
  totalDevices: 2,
  active: { d1: 2, d7: 2, d30: 2 },
  newLast30d: 2,
  distinctUsers: 2,
  byVersion: [],
  byPlatform: [],
  byOs: [],
  onLatest: null,
  versions: [versionRow({ version: 'shogo-cli/unknown', devices: 2 })],
}

describe('AppVersionsPanel', () => {
  test('leads with how many desktops are on the deployed release', () => {
    render(createElement(AppVersionsPanel, { desktop, cli }))
    expect(screen.getByText('2 of 6 desktop devices on 2.3.6 (33%)')).toBeTruthy()
    expect(screen.getByText('Compared against the release this API is running.')).toBeTruthy()
  })

  test('lists every version instead of truncating to four', () => {
    render(createElement(AppVersionsPanel, { desktop, cli }))
    for (const version of ['2.3.6', '2.3.5', '2.2.0', '1.5.1', '2.3.4-beta.20261018t122519']) {
      expect(screen.getAllByText(version).length).toBeGreaterThan(0)
    }
  })

  test('marks beta installs and keeps them out of the stable row', () => {
    render(createElement(AppVersionsPanel, { desktop, cli }))
    expect(screen.getByText('Beta')).toBeTruthy()
    expect(screen.getAllByText('2.3.6').length).toBe(1)
  })

  test('shows the macOS / Windows / Linux columns and their per-OS totals', () => {
    render(createElement(AppVersionsPanel, { desktop, cli }))
    // Column headers of the OS×version table.
    for (const label of ['Version', 'macOS', 'Windows', 'Linux', 'Last seen']) {
      expect(screen.getByText(label)).toBeTruthy()
    }
    // Chip labels carry the normalised per-OS totals (3 macOS, 2 Windows, 1 Linux).
    expect(screen.getByRole('button', { name: 'macOS · 3' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Windows · 2' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Linux · 1' })).toBeTruthy()
  })

  test('OS chips filter the table down to devices on that OS', () => {
    render(createElement(AppVersionsPanel, { desktop, cli }))
    fireEvent.click(screen.getByRole('button', { name: /Windows/ }))
    expect(screen.queryByText('1.5.1')).toBeNull()
    expect(screen.getAllByText('2.3.6').length).toBe(1)
  })

  test('the CLI chip shows the CLI segment, not the desktop one', () => {
    render(createElement(AppVersionsPanel, { desktop, cli }))
    fireEvent.click(screen.getByRole('button', { name: /CLI/ }))
    expect(screen.getByText('shogo-cli/unknown')).toBeTruthy()
    expect(screen.queryByText('1.5.1')).toBeNull()
    expect(screen.queryByText('2.3.5')).toBeNull()
  })

  test('says so when the deployment pins no release tag', () => {
    render(createElement(AppVersionsPanel, {
      desktop: { ...desktop, onLatest: null },
      cli,
    }))
    expect(screen.getByText('6 desktop devices signed in — deployed release tag unknown')).toBeTruthy()
    expect(screen.getByText('Set APP_VERSION on the api deployment to compare installs against a release.')).toBeTruthy()
  })
})
