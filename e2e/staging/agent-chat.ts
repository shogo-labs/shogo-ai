// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { expect, type Page } from "@playwright/test"
import {
  homeComposerInput,
  signUpAndOnboard,
  signUpAndUpgradeToPro,
  type TestUser,
} from "./helpers"

/**
 * Shared helpers for specs that drive the agent through the project chat and
 * assert on the URLs it hands back (agent-localhost-publish, agent-publish).
 */

export const INITIAL_BUILD_TIMEOUT_MS = 180_000

// Match an actual localhost ADDRESS the user might be handed — a localhost URL
// (`http://localhost…`), a host:port (`localhost:8080`), or a loopback IP.
// Deliberately NOT the bare word "localhost", which legitimately appears in
// unrelated UI text (e.g. an account name) and would false-positive against the
// lowercased page body.
export const LOCALHOST_RE = /https?:\/\/localhost\b|\blocalhost[:/]|\b127\.0\.0\.1\b|\b0\.0\.0\.0\b/
// e.g. https://<id>.preview.staging.shogo.ai or <id>.preview.shogo.ai
export const PREVIEW_URL_RE = /https?:\/\/[a-z0-9-]+\.preview\.[a-z0-9.-]*shogo\.ai/i
export const PUBLISHED_URL_RE = /https?:\/\/[a-z0-9-]+\.shogo\.one\b/i

/**
 * Signs `user` up (hosted) or reuses the auto-signed-in session (local
 * desktop). `pro` upgrades a freshly signed-up hosted account to Pro.
 */
export async function ensureAuthenticated(
  page: Page,
  user: TestUser,
  opts: { pro?: boolean } = {},
): Promise<void> {
  await page.goto("/")
  const home = page.getByText("What are we building", { exact: false }).first()
  const signUpTab = page.getByRole("tab", { name: "Sign Up" })
  await Promise.race([
    home.waitFor({ state: "visible", timeout: 60_000 }).catch(() => {}),
    signUpTab.waitFor({ state: "visible", timeout: 60_000 }).catch(() => {}),
  ])
  if (await home.isVisible().catch(() => false)) return
  if (opts.pro) {
    await signUpAndUpgradeToPro(page, user)
  } else {
    await signUpAndOnboard(page, user)
  }
}

/** The currently-visible project chat composer (ChatInput, not the home one). */
function visibleComposer(page: Page) {
  return page
    .getByRole("textbox", { name: "Chat message input" })
    .filter({ visible: true })
    .first()
}

/** Sends a message into the project chat composer and confirms it landed. */
export async function sendProjectChatMessage(page: Page, text: string): Promise<void> {
  const snippet = text.slice(0, 24)
  for (let attempt = 0; attempt < 2; attempt++) {
    const box = visibleComposer(page)
    await box.waitFor({ state: "visible", timeout: 15_000 })
    await box.fill(text)
    await page
      .getByRole("button", { name: "Send message" })
      .filter({ visible: true })
      .first()
      .click({ force: true })
    const landed = await page
      .getByText(snippet, { exact: false })
      .first()
      .waitFor({ state: "visible", timeout: 8_000 })
      .then(() => true)
      .catch(() => false)
    if (landed) return
  }
  throw new Error("sendProjectChatMessage: message never appeared in the transcript")
}

/** Concatenated visible transcript text (lowercased). */
export async function transcript(page: Page): Promise<string> {
  return (await page.locator("body").innerText()).toLowerCase()
}

/** Creates a project from the home composer, returns its id once it boots. */
export async function createProject(page: Page, prompt: string): Promise<string> {
  await page.goto("/")
  await page.waitForSelector("text=What are we building", { timeout: 30_000 })
  const input = homeComposerInput(page)
  await input.click()
  await input.fill(prompt)
  await page.waitForTimeout(300)
  await page.keyboard.press("Enter")
  await page.waitForURL(/\/projects\//, { timeout: 60_000 })
  const m = page.url().match(/\/projects\/([^/?#]+)/)
  expect(m, `expected a /projects/<id> URL, got ${page.url()}`).toBeTruthy()
  return m![1]
}
