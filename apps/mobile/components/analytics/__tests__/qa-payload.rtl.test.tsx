// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-114 / SHO-477 contract test — the panels render the payload the API sends.
 *
 * Uses `fixtures/qa-app-installs.json`, captured from the real service against
 * a production-shaped SQLite row set (8 platform spellings, 2 CLI keys, one
 * device in two workspaces). Regenerate it with
 * `apps/api/src/__tests__/qa-install-identity.acceptance.test.ts`.
 *
 * Since SHO-477 the panels are chart-based: version rows no longer appear as
 * plain text in the HTML. These assertions cover the shape (payload contract),
 * the headline and chip counts (computed from `versions[].os`), and the
 * per-device disclosure gate.
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

  test('headline and chip totals render from the real payload (SHO-477: chart-based, no version-row table)', () => {
    render(createElement(AppVersionsPanel, { ...payload.installs, adoption: [] }))

    // "N of M on <tag>" — production's answer for the fixture.
    expect(screen.getByText('6 of 14 desktop devices on 2.3.6 (43%)')).toBeTruthy()
    expect(screen.getByText('Compared against the release this API is running.')).toBeTruthy()

    // Per-OS chip totals come from `versions[].os`, i.e. the normalisation.
    expect(screen.getByRole('button', { name: 'macOS · 5' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Windows · 7' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Linux · 2' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'CLI · 2' })).toBeTruthy()

    // Without adoption data the chart gracefully says so rather than crashing.
    expect(screen.getByText('No adoption data for this filter')).toBeTruthy()
  })

  test('the device headline renders from the real payload', () => {
    render(createElement(ActiveDevicesPanel, { data: payload.devices }))
    expect(document.querySelector('[data-rn-shim="active-devices-headline"]')).toBeTruthy()
  })

  test('per-device list is hidden behind "Show devices" disclosure', () => {
    render(createElement(ActiveDevicesPanel, { data: payload.devices }))
    // No device rows visible until the user opens the disclosure.
    expect(document.querySelectorAll('[data-rn-shim="active-device-row"]').length).toBe(0)
    // After opening…
    fireEvent.click(screen.getByText(/Show devices/))
    expect(document.querySelectorAll('[data-rn-shim="active-device-row"]').length).toBeGreaterThan(0)
  })
})
