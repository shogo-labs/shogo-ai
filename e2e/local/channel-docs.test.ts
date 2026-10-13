// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Channel docs on desktop: the "Messages | Doc" tabs, creating a doc, autosave,
 * reopening it from a `?doc=1` link, ticking a checklist item, and another
 * editor's save appearing live in an open doc.
 *
 * Needs the local stack (`E2E_LOCAL_START_STACK=1` starts it).
 */
import { expect, test, type Page } from "@playwright/test"
import { activateTeamWorkspace, api, signIn, teamWorkspaceId } from "./team-nav-seed"

const docPane = (page: Page) => page.getByTestId("channel-doc-pane")

async function serverDoc(page: Page, channelId: string) {
  return (await api(page, "GET", `/api/conversations/${channelId}/doc`)).json?.doc ?? null
}

test.describe("Channel docs", () => {
  test.describe.configure({ mode: "serial" })
  test.use({ viewport: { width: 1440, height: 900 } })

  let page: Page
  let workspaceId: string
  let channelId: string
  const suffix = Date.now().toString(36)

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(180_000)
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
    page = await context.newPage()
    await signIn(page)
    workspaceId = await teamWorkspaceId(page)
    await activateTeamWorkspace(page, workspaceId)
    const channel = await api(page, "POST", `/api/workspaces/${workspaceId}/conversations`, { name: `docs-${suffix}`, kind: "public" })
    channelId = channel.json?.conversation?.id
    if (!channelId) throw new Error(`channel create failed: ${JSON.stringify(channel.json)}`)
  })

  test.afterAll(async () => {
    await api(page, "PATCH", `/api/conversations/${channelId}`, { archived: true }).catch(() => {})
    await page.context().close()
  })

  test("a channel offers a Doc tab and creates a doc that autosaves", async () => {
    await page.goto(`/c/${channelId}`)
    const tabs = page.getByTestId("channel-tabs")
    await expect(tabs.getByRole("tab", { name: "Messages" })).toHaveAttribute("aria-selected", "true", { timeout: 60_000 })
    await tabs.getByRole("tab", { name: "Add doc" }).click()
    await expect(page).toHaveURL(/doc=1/)
    await expect(docPane(page).getByText("No doc yet")).toBeVisible()

    await docPane(page).getByRole("button", { name: "Create doc" }).click()
    await page.getByLabel("Doc title").fill(`Launch plan ${suffix}`)
    await page.getByLabel("Doc content").fill("## Checklist\n\n- [ ] Write release notes\n- [ ] Tell support")

    await expect.poll(async () => (await serverDoc(page, channelId))?.content ?? null, { timeout: 15_000 })
      .toContain("Write release notes")
    await expect(page.getByTestId("doc-status")).toContainText("Edited by", { timeout: 15_000 })
    const doc = await serverDoc(page, channelId)
    expect(doc.title).toBe(`Launch plan ${suffix}`)

    await docPane(page).getByRole("button", { name: "Done editing" }).click()
    await expect(docPane(page).getByRole("checkbox", { name: "Write release notes" })).toBeVisible()
    await expect(page.getByTestId("channel-tabs").getByRole("tab", { name: "Doc" })).toHaveAttribute("aria-selected", "true")
  })

  test("the doc reopens from a link, and ticking a task saves it", async () => {
    await page.goto(`/c/${channelId}?doc=1`)
    const task = docPane(page).getByRole("checkbox", { name: "Tell support" })
    await expect(task).toBeVisible({ timeout: 60_000 })
    await task.click()
    await expect.poll(async () => (await serverDoc(page, channelId))?.content ?? "", { timeout: 15_000 })
      .toContain("- [x] Tell support")

    await page.getByTestId("channel-tabs").getByRole("tab", { name: "Messages" }).click()
    await expect(page).not.toHaveURL(/doc=1/)
    await expect(docPane(page)).toHaveCount(0)
  })

  test("someone else's save shows up live in an open doc", async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
    const other = await context.newPage()
    try {
      await signIn(other)
      await activateTeamWorkspace(other, workspaceId)
      await other.goto(`/c/${channelId}?doc=1`)
      await expect(docPane(other).getByRole("checkbox", { name: "Write release notes" })).toBeVisible({ timeout: 60_000 })

      const current = await serverDoc(page, channelId)
      const saved = await api(page, "PUT", `/api/conversations/${channelId}/doc`, {
        title: current.title,
        content: `${current.content}\n- [ ] Live update ${suffix}`,
        baseVersion: current.version,
      })
      expect(saved.status).toBe(200)
      await expect(docPane(other).getByRole("checkbox", { name: `Live update ${suffix}` })).toBeVisible({ timeout: 15_000 })

      const stale = await api(page, "PUT", `/api/conversations/${channelId}/doc`, {
        title: current.title,
        content: "stale",
        baseVersion: current.version,
      })
      expect(stale.status).toBe(409)
    } finally {
      await context.close()
    }
  })
})
