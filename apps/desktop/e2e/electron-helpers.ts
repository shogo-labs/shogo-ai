// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import type { ElectronApplication, Page } from '@playwright/test'

/**
 * API port for runs with SHOGO_SKIP_LOCAL_SERVER. Nothing listens here by
 * default, so a developer's running Shogo (on 39100) never sees test traffic.
 * Set SHOGO_E2E_API_PORT to point at a real API on purpose.
 */
export const E2E_API_PORT = process.env.SHOGO_E2E_API_PORT || '38917'

function isMainWindow(page: Page): boolean {
  try {
    const url = new URL(page.url())
    return url.protocol.startsWith('http') && !url.pathname.startsWith('/island')
  } catch {
    return false
  }
}

/**
 * The app window. `firstWindow()` is a race: the notch island opens its own
 * window at about the same time, and it can win.
 */
export async function mainAppWindow(app: ElectronApplication, timeoutMs = 60_000): Promise<Page> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const page = app.windows().find(isMainWindow)
    if (page) return page
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`main window did not open within ${timeoutMs}ms (windows: ${app.windows().map((w) => w.url()).join(', ')})`)
}
