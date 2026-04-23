// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Runtime flag for `[screencast]` client-side diagnostic logs.
 *
 * Off by default — the CDP screencast pipeline is stable; these logs only
 * help when debugging connectivity or propagation issues and otherwise
 * spam the console on every session restore.
 *
 * Enable from the web devtools console:
 *   (globalThis as any).__DEBUG_SCREENCAST__ = true
 * or at build time via an Expo public env:
 *   EXPO_PUBLIC_DEBUG_SCREENCAST=1
 */

const ENV_FLAG =
  typeof process !== "undefined" &&
  (process.env?.EXPO_PUBLIC_DEBUG_SCREENCAST === "1" ||
    process.env?.EXPO_PUBLIC_DEBUG_SCREENCAST === "true")

export function isScreencastDebugEnabled(): boolean {
  try {
    if ((globalThis as any).__DEBUG_SCREENCAST__) return true
  } catch {
    // ignore
  }
  return ENV_FLAG
}

export function logScreencast(...args: unknown[]): void {
  if (!isScreencastDebugEnabled()) return
  // eslint-disable-next-line no-console
  console.log(...args)
}

export function warnScreencast(...args: unknown[]): void {
  if (!isScreencastDebugEnabled()) return
  // eslint-disable-next-line no-console
  console.warn(...args)
}
