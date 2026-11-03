// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { existsSync } from "node:fs"
import { chromium, firefox, webkit, request, type FullConfig } from "@playwright/test"

const BROWSERS = { chromium, firefox, webkit } as const

type BrowserName = keyof typeof BROWSERS

/**
 * Warm the app in an engine this run actually has on disk. `E2E (phone)` runs
 * one project per job and installs only that project's browser (SHO-298), so a
 * hardcoded `chromium.launch()` killed the WebKit job with "Executable doesn't
 * exist ... chromium_headless_shell" before a single spec ran — and a chromium
 * warm-up never exercised the WebKit first paint the phone specs assert on.
 *
 * `config.projects` lists every project in the config, not just the ones
 * `--project` selected, so the run's own engine is preferred but a job that
 * installed only WebKit still gets a browser it can launch.
 *
 * `use.browserName` is unset for a project built from a `devices[...]`
 * descriptor — the engine lives in `defaultBrowserType` — so read both.
 */
export function warmupBrowserName(config: FullConfig): BrowserName {
  const wanted = config.projects.map(
    (project) => project.use.defaultBrowserType ?? project.use.browserName ?? "chromium",
  )
  const candidates = [...new Set<BrowserName>(wanted)]
  return candidates.find((name) => existsSync(BROWSERS[name].executablePath())) ?? candidates[0] ?? "chromium"
}

/**
 * A stack booted by E2E_LOCAL_START_STACK starts from an empty database, so the
 * local user lands on onboarding. The specs assume a machine that has been set
 * up (as a developer's has), so finish onboarding once before they run.
 */
export default async function globalSetup(config: FullConfig): Promise<void> {
  if (process.env.E2E_LOCAL_START_STACK !== "1") return
  const api = await request.newContext({ baseURL: process.env.E2E_API_URL || "http://localhost:8002" })
  try {
    const signIn = await api.post("/api/local/auto-sign-in")
    if (!signIn.ok()) throw new Error(`local auto-sign-in failed (${signIn.status()}): ${await signIn.text()}`)
    const onboarding = await api.post("/api/onboarding/complete")
    if (!onboarding.ok()) throw new Error(`onboarding/complete failed (${onboarding.status()}): ${await onboarding.text()}`)
  } finally {
    await api.dispose()
  }

  // Warm the app in the engine this run actually uses (see warmupBrowserName).
  const browser = await BROWSERS[warmupBrowserName(config)].launch()
  try {
    const page = await browser.newPage({
      baseURL: process.env.E2E_TARGET_URL || `http://localhost:${process.env.E2E_LOCAL_WEB_PORT || "8081"}`,
    })
    // The config's own webServer window is 300s and every boot runs
    // `dev:web --clear`, so a 180s first paint here can fail while the server
    // is still warming — and globalSetup is never retried, which turned a slow
    // Metro start into a red `E2E (chat context)` on a green head (SHO-137 R6).
    await page.goto("/", { timeout: 300_000 })
    await page
      .getByRole("navigation", { name: "App sidebar" })
      .or(page.getByText("What are we building", { exact: false }))
      .first()
      .waitFor({ state: "visible", timeout: 300_000 })
  } finally {
    await browser.close()
  }
}
