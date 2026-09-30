// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Personal meetings: list, search, detail tabs, action items, notes errors,
 * recording with the live transcript, and delete. Runs against the local
 * stack, which has no transcription or model backend, so the failure paths
 * are asserted to be readable rather than the AI output itself.
 */
import { expect, test, type Page } from "@playwright/test"

const API_BASE = process.env.E2E_API_URL || "http://localhost:8002"

test.use({
  permissions: ["microphone"],
  launchOptions: {
    args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"],
  },
})

async function personalWorkspaceId(page: Page): Promise<string> {
  await page.goto("/")
  const id = await page.evaluate(async (apiBase) => {
    await fetch(`${apiBase}/api/local/auto-sign-in`, { method: "POST", credentials: "include" })
    const res = await fetch(`${apiBase}/api/local/meetings/workspace`, { credentials: "include" })
    return res.ok ? ((await res.json()).workspaceId as string) : null
  }, API_BASE)
  expect(id, "local mode resolves a personal workspace for meetings").toBeTruthy()
  return id!
}

async function api<T = any>(page: Page, method: string, path: string, body?: unknown): Promise<T> {
  return page.evaluate(
    async ({ apiBase, method, path, body }) => {
      const res = await fetch(`${apiBase}${path}`, {
        method,
        credentials: "include",
        headers: body === undefined ? {} : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${await res.text()}`)
      return res.json()
    },
    { apiBase: API_BASE, method, path, body },
  )
}

async function seedMeeting(page: Page, workspaceId: string, title: string) {
  const base = `/api/workspaces/${workspaceId}/meetings`
  const { meeting } = await api(page, "POST", base, { notes: "Ask who owns the rollout checklist.", title })
  await api(page, "PATCH", `${base}/${meeting.id}`, {
    enhancedNotes: "## Decisions\n- Beta ships Friday.\n\n## Action items\n- [ ] Prepare the rollout checklist — Alex",
    actionItems: [{ text: "Prepare the rollout checklist", owner: "Alex", done: false }],
  })
  return meeting.id as string
}

test.describe("meetings", () => {
  test("browse, search and edit a meeting", async ({ page }) => {
    test.setTimeout(180_000)
    const workspaceId = await personalWorkspaceId(page)
    const title = `E2E design review ${Date.now()}`
    const id = await seedMeeting(page, workspaceId, title)

    await page.goto("/meetings")
    await expect(page.getByText("Meetings", { exact: true }).first()).toBeVisible({ timeout: 60_000 })
    await expect(page.getByText(title)).toBeVisible()

    await page.getByLabel("Search meetings").fill("rollout checklist")
    await expect(page.getByText(title)).toBeVisible()
    await page.getByLabel("Clear search").click()

    await page.getByLabel(`Open ${title}`).click()
    await expect(page.getByText("Beta ships Friday.")).toBeVisible()

    const item = page.getByRole("checkbox").filter({ hasText: "Prepare the rollout checklist" })
    await expect(item).toHaveAttribute("aria-checked", "false")
    await item.click()
    await expect(item).toHaveAttribute("aria-checked", "true")
    await expect
      .poll(async () => (await api(page, "GET", `/api/workspaces/${workspaceId}/meetings/${id}`)).meeting.actionItems[0].done)
      .toBe(true)
    await page.reload()
    await expect(page.getByRole("checkbox").filter({ hasText: "Prepare the rollout checklist" })).toHaveAttribute(
      "aria-checked",
      "true",
    )

    await page.getByRole("tab", { name: "My notes", exact: true }).click()
    await expect(page.getByLabel("My notes")).toHaveValue("Ask who owns the rollout checklist.")
    await page.getByRole("tab", { name: "Transcript", exact: true }).click()
    await expect(page.getByText("No transcript available")).toBeVisible()

    // Without a model the regenerate fails; the message must be for people, not a stack trace.
    await page.getByRole("tab", { name: "Notes", exact: true }).click()
    await page.getByLabel("Regenerate").click()
    await expect(page.getByLabel("Regenerate")).toBeVisible({ timeout: 60_000 })
    const banner = page.getByText(/Couldn't regenerate notes\./)
    if (await banner.isVisible()) {
      await expect(banner).not.toContainText("/ai/v1")
      await expect(banner).not.toContainText(/\b[45]\d\d\b/)
      await expect(page.getByText("Beta ships Friday.")).toBeVisible()
    }

    await page.getByLabel("Delete", { exact: true }).click()
    await expect(page.getByText("Delete meeting")).toBeVisible()
    await page.getByText("Delete", { exact: true }).last().click()
    await expect(page.getByText(title)).toHaveCount(0, { timeout: 15_000 })
  })

  test("recording shows a live transcript and lands in the list without a reload", async ({ page }) => {
    test.setTimeout(180_000)
    const workspaceId = await personalWorkspaceId(page)
    const before = (await api(page, "GET", `/api/workspaces/${workspaceId}/meetings`)).meetings.length

    await page.goto("/meetings")
    await page.getByLabel("Start recording").first().click()
    await expect(page.getByText("Your notes", { exact: true })).toBeVisible()
    await expect(page.getByText("Let everyone know you're recording")).toBeVisible()
    const live = page.getByLabel("Live transcript")
    await expect(live).toContainText("Listening")
    await page.getByLabel("Meeting notes").fill("Follow up on pricing.")

    // The fake mic's tone is loud enough to send a chunk after ~8 s. Locally
    // there is no transcriber, so the panel explains that instead of words.
    await expect(live).not.toContainText("Listening", { timeout: 30_000 })
    await expect(live).toContainText(/Settings|\d:\d\d/)

    // The floating indicator has a stop button too; use the header one.
    await page.getByText(/^Stop · \d/).click()
    await expect
      .poll(async () => (await api(page, "GET", `/api/workspaces/${workspaceId}/meetings`)).meetings.length, {
        timeout: 30_000,
      })
      .toBe(before + 1)
    const rows = page.getByLabel(/^Open /)
    await expect(rows).toHaveCount(before + 1, { timeout: 15_000 })

    const { meetings } = await api(page, "GET", `/api/workspaces/${workspaceId}/meetings`)
    const { meeting } = await api(page, "GET", `/api/workspaces/${workspaceId}/meetings/${meetings[0].id}`)
    expect(meeting.notes).toBe("Follow up on pricing.")
    await api(page, "DELETE", `/api/workspaces/${workspaceId}/meetings/${meeting.id}`)
  })
})
