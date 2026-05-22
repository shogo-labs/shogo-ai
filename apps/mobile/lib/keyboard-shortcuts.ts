// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Display labels for modifier-key shortcuts on web.
 * Key handlers should continue to use `(e.metaKey || e.ctrlKey)` — this module
 * only formats what users see in the UI.
 */

/** True when the browser reports a Mac / iOS platform string. */
export function isMacKeyboardPlatform(platform: string = getNavigatorPlatform()): boolean {
  return /Mac|iPhone|iPod|iPad/i.test(platform)
}

function getNavigatorPlatform(): string {
  if (typeof navigator === 'undefined') return ''
  return navigator.platform ?? ''
}

/**
 * Human-readable shortcut for modifier + letter (e.g. ⌘K vs Ctrl+K).
 *
 * @param key - Single letter or key name; single chars are uppercased.
 * @param platform - Optional override for tests (`navigator.platform` when omitted).
 */
export function formatModKey(key: string, platform?: string): string {
  const label = key.length === 1 ? key.toUpperCase() : key
  const resolvedPlatform = platform ?? getNavigatorPlatform()
  return isMacKeyboardPlatform(resolvedPlatform) ? `⌘${label}` : `Ctrl+${label}`
}
