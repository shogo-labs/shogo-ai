// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Tests for the per-platform unread badge.
 *
 * macOS and Linux badge the app icon with `app.setBadgeCount()`. Windows has
 * no equivalent — it needs a taskbar overlay image — so the Windows path is
 * asserted separately, including the "no window yet" case and re-applying the
 * count to a recreated window.
 *
 * Run: bun test apps/desktop/src/__tests__/badge.test.ts
 */

import { describe, expect, test } from 'bun:test'

import { createBadgeController, overlayDescription, WINDOWS_OVERLAY_DOT_PNG } from '../badge'

function makeAdapter(options: { badgeReturns?: boolean; overlayReturns?: boolean } = {}) {
  const badgeCalls: number[] = []
  const overlayCalls: Array<{ icon: Buffer | null; description: string }> = []
  const logs: string[] = []
  const adapter = {
    setBadgeCount: (count: number) => {
      badgeCalls.push(count)
      return options.badgeReturns ?? true
    },
    setOverlayIcon: (icon: Buffer | null, description: string) => {
      overlayCalls.push({ icon, description })
      return options.overlayReturns ?? true
    },
  }
  const controller = (platform: NodeJS.Platform) =>
    createBadgeController({ platform, adapter, log: (message) => logs.push(message) })
  return { badgeCalls, overlayCalls, logs, controller }
}

describe('badge — macOS and Linux', () => {
  test('uses app.setBadgeCount, including to clear it', () => {
    const { badgeCalls, overlayCalls, controller } = makeAdapter()
    const badge = controller('darwin')

    expect(badge.apply(3)).toEqual({ ok: true })
    expect(badge.apply(0)).toEqual({ ok: true })

    expect(badgeCalls).toEqual([3, 0])
    expect(overlayCalls).toHaveLength(0)
  })

  test('surfaces a refused badge instead of swallowing it', () => {
    const { logs, controller } = makeAdapter({ badgeReturns: false })
    const badge = controller('linux')

    expect(badge.apply(4)).toEqual({ ok: false, reason: 'setBadgeCount-returned-false' })
    expect(logs.join('\n')).toContain('setBadgeCount(4) returned false')
  })
})

describe('badge — Windows overlay', () => {
  test('overlays the dot with the count in the accessibility description', () => {
    const { overlayCalls, badgeCalls, controller } = makeAdapter()
    const badge = controller('win32')

    expect(badge.apply(3)).toEqual({ ok: true })

    expect(badgeCalls).toHaveLength(0)
    expect(overlayCalls).toHaveLength(1)
    expect(overlayCalls[0].icon).toBe(WINDOWS_OVERLAY_DOT_PNG)
    expect(overlayCalls[0].description).toBe('3 unread messages')
  })

  test('clears the overlay at zero', () => {
    const { overlayCalls, controller } = makeAdapter()
    const badge = controller('win32')

    expect(badge.apply(0)).toEqual({ ok: true })

    expect(overlayCalls[0].icon).toBeNull()
    expect(overlayCalls[0].description).toBe('No unread messages')
  })

  test('re-applies the count when the primary window is recreated', () => {
    const { overlayCalls, controller } = makeAdapter()
    const badge = controller('win32')

    badge.apply(7)
    badge.reattach()

    expect(overlayCalls).toHaveLength(2)
    expect(overlayCalls[1].icon).toBe(WINDOWS_OVERLAY_DOT_PNG)
    expect(badge.getCount()).toBe(7)
  })

  test('reports when there is no window to carry the overlay', () => {
    const { controller } = makeAdapter({ overlayReturns: false })
    const badge = controller('win32')

    expect(badge.apply(2)).toEqual({ ok: false, reason: 'no-window' })
  })

  test('the embedded overlay asset is a real 16x16 PNG', () => {
    const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    expect(WINDOWS_OVERLAY_DOT_PNG.subarray(0, 8).equals(signature)).toBe(true)
    // Width and height live at bytes 16 and 20 of an IHDR-first PNG.
    expect(WINDOWS_OVERLAY_DOT_PNG.readUInt32BE(16)).toBe(16)
    expect(WINDOWS_OVERLAY_DOT_PNG.readUInt32BE(20)).toBe(16)
  })
})

describe('badge — count normalisation', () => {
  test('clamps to a sane, non-negative integer', () => {
    const { badgeCalls, controller } = makeAdapter()
    const badge = controller('darwin')

    badge.apply(-5)
    badge.apply(2.7)
    badge.apply(Number.NaN)
    badge.apply(1e9)

    expect(badgeCalls).toEqual([0, 2, 0, 9999])
  })

  test('describes singular and plural counts', () => {
    expect(overlayDescription(1)).toBe('1 unread message')
    expect(overlayDescription(2)).toBe('2 unread messages')
    expect(overlayDescription(0)).toBe('No unread messages')
  })
})
