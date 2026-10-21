// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-114 contract test — the panels render the payload the API actually sends.
 *
 * The sibling `AppVersionsPanel.rtl.test.tsx` asserts against a hand-written
 * fixture, so a renamed field (`versions` → `byVersion`, `os.macos` →
 * `os.mac`) would keep both suites green while the admin page rendered blanks.
 * This one renders `fixtures/qa-app-installs.json`, which was captured from the
 * real service against a production-shaped SQLite row set (8 platform
 * spellings, 2 CLI keys, one device in two workspaces, one version-less touch
 * on an older row). Regenerate it with
 * `apps/api/src/__tests__/qa-install-identity.acceptance.test.ts`.
 */

import { describe, expect, mock, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
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
const { ActiveDevicesPanel } = await import('../ActiveDevicesPanel')

const payload = JSON.parse(
  readFileSync(join(import.meta.dir, 'fixtures', 'qa-app-installs.json'), 'utf-8'),
)

describe('admin install panel — real API payload', () => {
  test('the captured payload still has the shape the panel reads', () => {
    expect(payload.installs.desktop.versions).toBeArray()
    expect(payload.installs.desktop.byOs).toBeArray()
    expect(payload.installs.desktop.onLatest).toMatchObject({ version: '2.3.6', pct: 43 })
    expect(payload.installs.cli.totalDevices).toBe(2)
    expect(payload.devices.devices).toBeArray()
  })

  test('headline, chip totals and every version row render from the real payload', () => {
    render(createElement(AppVersionsPanel, payload.installs))

    // "N of M on <tag>" — production's answer for the fixture.
    expect(screen.getByText('6 of 14 desktop devices on 2.3.6 (43%)')).toBeTruthy()
    expect(screen.getByText('Compared against the release this API is running.')).toBeTruthy()

    // Per-OS chip totals come from `versions[].os`, i.e. the normalisation.
    expect(screen.getByRole('button', { name: 'macOS · 5' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Windows · 7' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Linux · 2' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'CLI · 2' })).toBeTruthy()

    // All six (version, channel) rows — 4 would be the old truncation.
    for (const version of ['2.3.6', '2.2.27', '1.12.7', '2.3.5', '2.2.24', '2.3.6-beta.20261020t083308']) {
      expect(screen.getAllByText(version).length, version).toBeGreaterThan(0)
    }
    // Exactly one beta row, and it is the only Beta chip.
    expect(screen.getAllByText('Beta')).toHaveLength(1)
  })

  test('the CLI chip shows the CLI segment and never the desktop versions', () => {
    render(createElement(AppVersionsPanel, payload.installs))
    fireEvent.click(screen.getByRole('button', { name: 'CLI · 2' }))
    expect(screen.getByText('shogo-cli/unknown')).toBeTruthy()
    expect(screen.queryByText('1.12.7')).toBeNull()
    expect(screen.queryByText('2.2.27')).toBeNull()
  })

  test('the per-version macOS column reflects darwin, darwin-arm64 and darwin-x64', () => {
    render(createElement(AppVersionsPanel, payload.installs))
    fireEvent.click(screen.getByRole('button', { name: 'macOS · 5' }))
    // Every macOS device in the fixture, across the three spellings.
    expect(screen.getAllByText('2.3.6').length).toBe(1)
    for (const version of ['2.2.27', '1.12.7', '2.3.6-beta.20261020t083308']) {
      expect(screen.getAllByText(version).length, version).toBeGreaterThan(0)
    }
    // No Windows-only or Linux-only build in the macOS view.
    expect(screen.queryByText('2.3.5')).toBeNull()
    expect(screen.queryByText('2.2.24')).toBeNull()
  })

  test('the device list renders one row per machine with its version and OS', () => {
    render(createElement(ActiveDevicesPanel, { data: payload.devices }))
    // The shared react-native mock renders `testID` as `data-rn-shim`.
    const rows = document.querySelectorAll('[data-rn-shim="active-device-row"]')
    expect(rows.length).toBe(payload.devices.devices.length)
    expect(document.querySelector('[data-rn-shim="active-devices-headline"]')).toBeTruthy()
    // The mislabelled device is reported on the version it actually moved to.
    expect(screen.getAllByText('2.3.6').length).toBeGreaterThan(0)
  })
})
