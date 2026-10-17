// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// Unread team-chat count on the app icon, per platform.
//
// `app.setBadgeCount()` supports **Linux and macOS only**. On Windows it
// returns false and does nothing, so the count never reached the taskbar and
// there was no Windows badge at all — Windows needs
// `BrowserWindow.setOverlayIcon()`.
//
// That overlay API takes an image and an accessibility description, not a
// number, so the badge is a red dot and the count travels in the description.
// Drawing digits would mean packaging ten glyph images per scale factor and
// adding them to `extraResource`, which is not worth it for a taskbar icon.
//
// The Electron objects arrive through `BadgeAdapter` so this module stays
// testable without an Electron runtime.

/**
 * A 16x16 red dot (#E5484D), 1px transparent margin, antialiased edge — the
 * Windows taskbar overlay. Embedded rather than shipped as a file because
 * `packagerConfig.ignore` excludes assets that are not in the explicit
 * `extraResource` list, and a 216-character constant is cheaper than another
 * packaging rule that can silently drop the icon.
 *
 * Regenerate with the 16x16 circle rasteriser in the PR that added this file.
 */
export const WINDOWS_OVERLAY_DOT_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAaElEQVR42mN46uHLQAnGJcEJxMFA' +
    'XAXFwVAxogwAafgCxP/R8BeoHF4DFmHRiI4X4TKgigjNMFyFbgAnDmfjwl9gYQIzIJgEzTAcjGxA' +
    'FRkGVFHVAIq9QHEgUhyNVElIVEnKVMlMJGEAMT/+SGXGPcEAAAAASUVORK5CYII=',
  'base64',
)

export interface BadgeAdapter {
  /** Returns what Electron's `app.setBadgeCount()` reported. */
  setBadgeCount(count: number): boolean
  /** Returns false when there is no window to carry the overlay. */
  setOverlayIcon(icon: Buffer | null, description: string): boolean
}

export interface BadgeControllerOptions {
  platform: NodeJS.Platform
  adapter: BadgeAdapter
  log?: (message: string) => void
}

export interface BadgeResult {
  ok: boolean
  reason?: string
}

export interface BadgeController {
  /** Apply the unread count to the dock / taskbar icon. */
  apply(count: number): BadgeResult
  /**
   * Re-apply the last count. Windows overlays belong to a window, so a
   * recreated primary window comes back without its badge.
   */
  reattach(): BadgeResult
  getCount(): number
}

const MAX_COUNT = 9999

export function createBadgeController(options: BadgeControllerOptions): BadgeController {
  const { platform, adapter } = options
  const log = options.log ?? (() => {})
  let count = 0

  const apply = (raw: number): BadgeResult => {
    count = normalize(raw)
    if (platform === 'win32') {
      const ok = adapter.setOverlayIcon(count > 0 ? WINDOWS_OVERLAY_DOT_PNG : null, overlayDescription(count))
      if (!ok) log('[Badge] no window to carry the taskbar overlay')
      return ok ? { ok: true } : { ok: false, reason: 'no-window' }
    }
    const ok = adapter.setBadgeCount(count)
    if (!ok) {
      log(
        `[Badge] app.setBadgeCount(${count}) returned false — the dock badge was not applied ` +
          '(unsupported platform, or the OS has notifications turned off for Shogo)',
      )
    }
    return ok ? { ok: true } : { ok: false, reason: 'setBadgeCount-returned-false' }
  }

  return {
    apply,
    reattach: () => apply(count),
    getCount: () => count,
  }
}

export function overlayDescription(count: number): string {
  if (count <= 0) return 'No unread messages'
  return count === 1 ? '1 unread message' : `${count} unread messages`
}

function normalize(raw: number): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return 0
  return Math.max(0, Math.min(Math.floor(raw), MAX_COUNT))
}
