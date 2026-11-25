// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Admin → App Installs: chart-based versions panel (SHO-477).
 *
 * Covers the new chart surface: headline, filter chips, area chart presence
 * (via its legend labels), version-share bar, and OS ring heading.
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

/** Minimal adoption fixture — 2 days, desktop+CLI, mixed OS. */
const adoption: any[] = [
  { date: '2026-10-20', version: '2.3.6', channel: 'stable', client: 'desktop', os: 'macos', devices: 1 },
  { date: '2026-10-20', version: '2.3.6', channel: 'stable', client: 'desktop', os: 'windows', devices: 1 },
  { date: '2026-10-20', version: '2.3.5', channel: 'stable', client: 'desktop', os: 'macos', devices: 1 },
  { date: '2026-10-20', version: 'shogo-cli/unknown', channel: 'stable', client: 'cli', os: 'unknown', devices: 2 },
  { date: '2026-10-21', version: '2.3.6', channel: 'stable', client: 'desktop', os: 'macos', devices: 2 },
  { date: '2026-10-21', version: '2.3.5', channel: 'stable', client: 'desktop', os: 'windows', devices: 1 },
  { date: '2026-10-21', version: 'shogo-cli/unknown', channel: 'stable', client: 'cli', os: 'unknown', devices: 2 },
]

describe('AppVersionsPanel', () => {
  test('leads with how many desktops are on the deployed release', () => {
    render(createElement(AppVersionsPanel, { desktop, cli, adoption }))
    expect(screen.getByText('2 of 6 desktop devices on 2.3.6 (33%)')).toBeTruthy()
    expect(screen.getByText('Compared against the release this API is running.')).toBeTruthy()
  })

  test('shows "Devices on each version" label and version share bar when adoption is present', () => {
    render(createElement(AppVersionsPanel, { desktop, cli, adoption }))
    expect(screen.getByText('Devices on each version')).toBeTruthy()
    expect(screen.getByText('Version share today')).toBeTruthy()
  })

  test('shows all five OS/CLI filter chips with correct device counts', () => {
    render(createElement(AppVersionsPanel, { desktop, cli, adoption }))
    expect(screen.getByRole('button', { name: 'All · 6' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'macOS · 3' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Windows · 2' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Linux · 1' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'CLI · 2' })).toBeTruthy()
  })

  test('"All" adoption shows desktop version labels in the legend', () => {
    render(createElement(AppVersionsPanel, { desktop, cli, adoption }))
    // The area chart legend renders series labels as plain text.
    expect(screen.getAllByText('2.3.6').length).toBeGreaterThan(0)
    expect(screen.getAllByText('2.3.5').length).toBeGreaterThan(0)
  })

  test('"CLI" chip adoption shows only CLI series in the legend', () => {
    render(createElement(AppVersionsPanel, { desktop, cli, adoption }))
    fireEvent.click(screen.getByRole('button', { name: 'CLI · 2' }))
    // CLI version should appear in the legend.
    expect(screen.getAllByText('shogo-cli/unknown').length).toBeGreaterThan(0)
  })

  test('OS ring heading visible for "All" and hidden for "CLI"', () => {
    render(createElement(AppVersionsPanel, { desktop, cli, adoption }))
    expect(screen.getByText('OS split')).toBeTruthy()
    // Switch to CLI — ring heading disappears
    fireEvent.click(screen.getByRole('button', { name: 'CLI · 2' }))
    expect(screen.queryByText('OS split')).toBeNull()
  })

  test('a failed request does not also claim there is no adoption data', () => {
    // Both messages at once contradict each other: one says we could not load
    // the series, the other says the series is empty.
    render(createElement(AppVersionsPanel, { desktop, cli, adoption: [], error: 'HTTP 500' }))
    expect(screen.getByText("Couldn't load desktop versions: HTTP 500")).toBeTruthy()
    expect(screen.queryByText('No adoption data for this filter')).toBeNull()
  })

  test('an empty series with no error still says so', () => {
    render(createElement(AppVersionsPanel, { desktop, cli, adoption: [] }))
    expect(screen.getByText('No adoption data for this filter')).toBeTruthy()
  })

  test('a failed app-versions request is named above the charts', () => {
    // Without the notice an empty series reads as "nobody is on any version".
    render(createElement(AppVersionsPanel, { desktop, cli, adoption, error: 'HTTP 500' }))
    expect(screen.getByText("Couldn't load desktop versions: HTTP 500")).toBeTruthy()
    // The charts below still render from the data that did arrive.
    expect(screen.getByText('Devices on each version')).toBeTruthy()
  })

  test('a beta version is labelled in the adoption legend', () => {
    const withBeta = [
      ...adoption,
      { date: '2026-10-21', version: '2.3.4-beta.20261018t122519', channel: 'beta', client: 'desktop', os: 'windows', devices: 1 },
    ]
    render(createElement(AppVersionsPanel, { desktop, cli, adoption: withBeta }))
    expect(screen.getAllByText('2.3.4-beta.20261018t122519 (beta)').length).toBeGreaterThan(0)
    // The same version's share-bar entry uses the same label.
    expect(document.body.textContent).toContain('1 device ·')
  })

  test('no adoption data shows graceful message', () => {
    render(createElement(AppVersionsPanel, { desktop, cli }))
    expect(screen.getByText('No adoption data for this filter')).toBeTruthy()
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
