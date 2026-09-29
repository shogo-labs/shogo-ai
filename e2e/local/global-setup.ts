// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { chromium, request } from "@playwright/test"

/**
 * A stack booted by E2E_LOCAL_START_STACK starts from an empty database, so the
 * local user lands on onboarding. The specs assume a machine that has been set
 * up (as a developer's has), so finish onboarding once before they run.
 */
export default async function globalSetup(): Promise<void> {
  if (process.env.E2E_LOCAL_START_STACK !== "1") return
  const api = await request.newContext({ baseURL: "http://localhost:8002" })
  try {
    const signIn = await api.post("/api/local/auto-sign-in")
    if (!signIn.ok()) throw new Error(`local auto-sign-in failed (${signIn.status()}): ${await signIn.text()}`)
    const onboarding = await api.post("/api/onboarding/complete")
    if (!onboarding.ok()) throw new Error(`onboarding/complete failed (${onboarding.status()}): ${await onboarding.text()}`)
  } finally {
    await api.dispose()
  }

  const browser = await chromium.launch()
  try {
    const page = await browser.newPage({ baseURL: "http://localhost:8081" })
    await page.goto("/", { timeout: 180_000 })
    await page
      .getByRole("navigation", { name: "App sidebar" })
      .or(page.getByText("What are we building", { exact: false }))
      .first()
      .waitFor({ state: "visible", timeout: 180_000 })
  } finally {
    await browser.close()
  }
}
