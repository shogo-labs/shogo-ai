// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-119: Home's sidebar list is the project chat list, flat. It renders the
 * same row component the project tree uses (`ChatSessionList` → `ChatTreeItem`
 * with `variant="workspacePane"`), so a workspace-agent chat has the same
 * relative time and overflow menu as a project chat — and, because the agent
 * screen now publishes its streaming state on the chat activity bus, its row
 * spins while the turn runs.
 *
 * Needs the local stack; `E2E_LOCAL_START_STACK=1` boots it.
 *
 *   npx playwright test --config e2e/local/playwright.config.ts workspace-chat-sidebar
 */
import { expect, test, type Page } from "@playwright/test"
import { LOCAL_API_BASE } from "./helpers"
import { signIn } from "./team-nav-seed"

/** The workspace agent's composer (ChatInput's default accessibility label). */
function composer(page: Page) {
  return page
    .getByRole("textbox", { name: "Chat message input" })
    .filter({ visible: true })
    .first()
}

/** A finished UI message stream, so the held turn never reaches a model. */
function completedTurnStream(text: string): string {
  const frame = (event: Record<string, unknown>) => `data: ${JSON.stringify(event)}\n\n`
  return [
    frame({ type: "start", messageId: "msg_sho119_e2e" }),
    frame({ type: "start-step" }),
    frame({ type: "text-start", id: "text_sho119_e2e" }),
    frame({ type: "text-delta", id: "text_sho119_e2e", delta: text }),
    frame({ type: "text-end", id: "text_sho119_e2e" }),
    frame({ type: "finish-step" }),
    frame({ type: "finish" }),
  ].join("")
}

/**
 * Hold the next workspace chat turn open until the returned `release()` is
 * called, so the test can observe the sidebar mid-stream.
 */
async function holdNextTurn(page: Page): Promise<() => void> {
  let release = () => {}
  const gate = new Promise<void>((resolve) => {
    release = () => resolve()
  })
  await page.route("**/api/workspaces/*/chat", async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue()
      return
    }
    await gate
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      headers: { "Cache-Control": "no-cache" },
      body: completedTurnStream("Noted."),
    })
  })
  // The live-turn probe the composer runs before sending.
  await page.route("**/api/workspaces/*/chat/*/turn", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ status: "completed" }),
    })
  })
  return release
}

async function personalWorkspaceId(page: Page): Promise<string> {
  const res = await page.request.get(`${LOCAL_API_BASE}/api/workspaces`)
  const json = await res.json()
  const items = (json?.items ?? json?.data?.items ?? []) as Array<{ id: string; kind?: string }>
  const id = items.find((w) => w.kind === "personal")?.id
  if (!id) throw new Error(`local stack has no personal workspace: ${JSON.stringify(json)}`)
  return id
}

function chatsPanel(page: Page) {
  return page.getByTestId("workspace-chats-panel")
}

test.describe("Workspace-agent chat list (local)", () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  test("Home's list is flat, with the project chat row's affordances", async ({ page }) => {
    test.setTimeout(180_000)
    await signIn(page)
    await personalWorkspaceId(page)
    await page.goto("/")

    const chats = chatsPanel(page)
    await expect(chats).toBeVisible({ timeout: 90_000 })

    // Flat: no project headers, no section title, and no project rows.
    await expect(chats.getByText("Workspace agent", { exact: true })).toHaveCount(0)
    await expect(chats.getByLabel(/^Project: /)).toHaveCount(0)

    // The one chat row looks like a project chat row: label, relative time and
    // the hover overflow menu (the project row's own affordances).
    const row = chats.getByRole("link", { name: /^Chat: / }).first()
    await expect(row).toBeVisible({ timeout: 60_000 })
    await expect(chats.getByLabel(/^Manage /).first()).toBeVisible()
    await expect(chats.getByText(/just now|\d+[mhd] ago/).first()).toBeVisible()

    // Creating a chat is a list row here too, not a bespoke header button.
    await expect(chats.getByRole("button", { name: "New chat" })).toBeVisible()
  })

  test("the running chat's row spins while its turn streams, then stops", async ({ page }) => {
    test.setTimeout(180_000)
    await signIn(page)
    await page.goto("/")

    const chats = chatsPanel(page)
    await expect(chats).toBeVisible({ timeout: 90_000 })
    const input = composer(page)
    await expect(input).toBeVisible({ timeout: 90_000 })

    const release = await holdNextTurn(page)

    await input.click()
    await input.fill("hold this turn open for the sidebar spinner")
    await page.keyboard.press("Enter")

    // Nothing else in the workspace panel ever renders this label: it is the
    // shared row's streaming slot, painted from the activity bus.
    // (Lucide paints the label on both the <svg> and its <path>.)
    await expect(chats.getByLabel("Chat running").first()).toBeVisible({ timeout: 30_000 })

    release()

    await expect(chats.getByLabel("Chat running")).toHaveCount(0, { timeout: 30_000 })
  })
})
