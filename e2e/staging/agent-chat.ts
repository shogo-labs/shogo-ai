// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { expect, type Locator, type Page } from "@playwright/test"
import {
  APP_HOME_PATH,
  homeComposerInput,
  publishDomain,
  signUpAndOnboard,
  signUpAndUpgradeToPro,
  waitForAgentIdle,
  waitForProjectChat,
  type TestUser,
} from "./helpers"

/**
 * Shared helpers for specs that drive the agent through the project chat and
 * assert on the URLs it hands back (agent-localhost-publish, agent-publish).
 */

export const INITIAL_BUILD_TIMEOUT_MS = 180_000

// Match a loopback ADDRESS the user could actually click: a URL with a scheme
// (`http://localhost:37675`, `https://localhost`), or a scheme-less host:port
// (`localhost:8080`, `127.0.0.1:3000`, `[::1]:8080`).
//
// Deliberately NOT the bare words "localhost" / "localhost/" — the agent
// legitimately writes "no localhost/preview/publish url is involved" while
// explaining the guarantee it is keeping, and matching prose there failed a
// perfectly correct reply (SHO-128). Every real leak carries a scheme or a
// port; every false positive is a sentence. Apply this to the agent's own
// messages (`agentMessageText`), never to the whole page body.
export const LOCALHOST_RE =
  /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d+)?|(?:\blocalhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):\d{2,5}/i
// e.g. https://<id>.preview.staging.shogo.ai or <id>.preview.shogo.ai
export const PREVIEW_URL_RE = /https?:\/\/[a-z0-9-]+\.preview\.[a-z0-9.-]*shogo\.ai/i
// e.g. https://<sub>.shogo.one in production, https://<sub>.staging.shogo.one
// on staging — derived from E2E_PUBLISH_DOMAIN / E2E_TARGET_URL (SHO-207).
export const PUBLISHED_URL_RE = new RegExp(
  `https?:\\/\\/[a-z0-9-]+\\.${escapeForRegExp(publishDomain())}\\b`,
  "i",
)

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/**
 * Signs `user` up (hosted) or reuses the auto-signed-in session (local
 * desktop). `pro` upgrades a freshly signed-up hosted account to Pro.
 */
export async function ensureAuthenticated(
  page: Page,
  user: TestUser,
  opts: { pro?: boolean } = {},
): Promise<void> {
  await page.goto(APP_HOME_PATH)
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
  // `waitForAgentResponse` gives up silently, and a long initial build can
  // still be running; while busy the composer offers "Queue message", not Send.
  await waitForAgentIdle(page, 300_000)
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

/**
 * The agent's own words: every markdown-rendered assistant message in the
 * transcript (`.chat-md` — the chat's markdown renderer; user messages render
 * as plain text, and the agent-logs pane and preview chrome are not markdown).
 *
 * `body.innerText` is the wrong scope for anything the agent said: it also
 * carries the user's echoed prompt, the build log and preview chrome, so one
 * log line printing `localhost:37675` failed a reply that leaked nothing
 * (SHO-128). Assert on the agent's messages instead.
 */
export function agentMessages(page: Page): Locator {
  return page.locator(".chat-md")
}

/**
 * Concatenated text of the agent's messages. Fails loudly when there is
 * nothing to read — an empty string would make every `not.toMatch` pass
 * vacuously and the gate would stop gating.
 */
export async function agentMessageText(page: Page): Promise<string> {
  const messages = agentMessages(page)
  await expect(
    messages.first(),
    "the agent's reply should be rendered in the transcript",
  ).toBeVisible({ timeout: 30_000 })
  return (await messages.allInnerTexts()).join("\n")
}

/** Every href the agent actually put in front of the user, for the clickable check. */
export async function agentMessageHrefs(page: Page): Promise<string[]> {
  return page
    .locator(".chat-md a[href]")
    .evaluateAll((anchors) => anchors.map((a) => a.getAttribute("href") ?? ""))
}

/** Creates a project from the home composer, returns its id once it boots. */
export async function createProject(page: Page, prompt: string): Promise<string> {
  await page.goto(APP_HOME_PATH)
  // 60s matches `ensureAuthenticated`: staging's home can load slowly.
  await page.waitForSelector("text=What are we building", { timeout: 60_000 })
  const input = homeComposerInput(page)
  await input.click()
  await input.fill(prompt)
  await page.waitForTimeout(300)
  await page.keyboard.press("Enter")
  await page.waitForURL(/\/projects\//, { timeout: 60_000 })
  const m = page.url().match(/\/projects\/([^/?#]+)/)
  expect(m, `expected a /projects/<id> URL, got ${page.url()}`).toBeTruthy()
  await waitForProjectChat(page)
  return m![1]
}
