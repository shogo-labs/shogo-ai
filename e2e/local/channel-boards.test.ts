// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Channel boards on desktop: adding a board from the channel tabs, adding and
 * dragging cards, a card's pane (assignee, history), a move by someone else
 * appearing live, "Make a card" from a message, My work with its keyboard
 * actions, and the Work filter in #activity.
 *
 * Needs the local stack (`E2E_LOCAL_START_STACK=1` starts it).
 */
import { expect, test, type Page } from "@playwright/test"
import { activateTeamWorkspace, api, signIn, teamWorkspaceId } from "./team-nav-seed"

const kanban = (page: Page) => page.getByTestId("board-kanban")
const cardPane = (page: Page) => page.getByTestId("card-pane")

test.describe("Channel boards", () => {
  test.describe.configure({ mode: "serial" })
  test.use({ viewport: { width: 1440, height: 900 } })

  let page: Page
  let workspaceId: string
  let channelId: string
  let boardId: string
  let userId: string
  const suffix = Date.now().toString(36)
  const boardName = `Launch ${suffix}`

  async function cards() {
    return (await api(page, "GET", `/api/boards/${boardId}`)).json
  }

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(180_000)
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
    page = await context.newPage()
    await signIn(page)
    userId = (await (await page.request.get(`${process.env.E2E_API_URL || "http://localhost:8002"}/api/auth/get-session`)).json())?.user?.id
    workspaceId = await teamWorkspaceId(page)
    await activateTeamWorkspace(page, workspaceId)
    const channel = await api(page, "POST", `/api/workspaces/${workspaceId}/conversations`, { name: `boards-${suffix}`, kind: "public" })
    channelId = channel.json?.conversation?.id
    if (!channelId) throw new Error(`channel create failed: ${JSON.stringify(channel.json)}`)
  })

  test.afterAll(async () => {
    if (boardId) await api(page, "POST", `/api/boards/${boardId}/archive`, { archived: true }).catch(() => {})
    await api(page, "PATCH", `/api/conversations/${channelId}`, { archived: true }).catch(() => {})
    await page.context().close()
  })

  test("a board is added from the channel tabs and opens as a Kanban", async () => {
    await page.goto(`/c/${channelId}`)
    const tabs = page.getByTestId("channel-tabs")
    await expect(tabs.getByRole("tab", { name: "Messages" })).toHaveAttribute("aria-selected", "true", { timeout: 60_000 })
    await tabs.getByRole("button", { name: "Add board" }).click()
    await page.getByLabel("Board name").fill(boardName)
    await page.getByTestId("create-board").click()

    await expect(page).toHaveURL(/board=/)
    boardId = new URL(page.url()).searchParams.get("board")!
    await expect(tabs.getByRole("tab", { name: boardName })).toHaveAttribute("aria-selected", "true")
    for (const column of ["Backlog", "In progress", "Review", "Done"]) {
      await expect(kanban(page).getByText(column, { exact: true }).first()).toBeVisible()
    }
  })

  test("cards are added to a column and dragged to another", async () => {
    await kanban(page).getByRole("button", { name: "Add card" }).first().click()
    await page.getByLabel("New card title").fill(`Write release notes ${suffix}`)
    await page.getByLabel("New card title").press("Enter")
    await expect.poll(async () => (await cards()).items.length, { timeout: 15_000 }).toBe(1)
    const created = (await cards()).items[0]
    const tile = page.getByTestId(`board-card-${created.key}`)
    await expect(tile).toBeVisible()

    const doing = (await cards()).board.columns.find((c: any) => c.category === "active")
    await tile.dragTo(page.getByTestId(`board-column-${doing.name}`))
    await expect.poll(async () => (await cards()).items[0].columnId, { timeout: 15_000 }).toBe(doing.id)
  })

  test("a card opens beside the board, takes an assignee, and shows its history", async () => {
    const item = (await cards()).items[0]
    await page.getByTestId(`board-card-${item.key}`).click()
    await expect(page).toHaveURL(new RegExp(`card=${item.id}`))
    await expect(cardPane(page)).toBeVisible()
    await expect(kanban(page)).toBeVisible()

    await cardPane(page).getByTestId("card-assignee").click()
    const sheet = page.getByTestId("option-sheet")
    await sheet.getByRole("button", { name: "Unassigned", exact: true }).waitFor()
    const me = (await api(page, "GET", `/api/workspaces/${workspaceId}/mentionables`)).json?.people?.find((p: any) => p.id === userId)
    await sheet.getByRole("button", { name: me?.name || me?.email }).first().click()
    await expect.poll(async () => (await api(page, "GET", `/api/work-items/${item.id}`)).json?.item?.assigneeUserId, { timeout: 15_000 }).toBe(userId)

    await cardPane(page).getByRole("tab", { name: "History" }).click()
    await expect(cardPane(page).getByText(/moved it from .* to In progress/)).toBeVisible({ timeout: 15_000 })
    await expect(cardPane(page).getByText(/assigned it to/)).toBeVisible()
  })

  test("someone else's move shows up live", async () => {
    const view = await cards()
    const item = view.items[0]
    const done = view.board.columns.find((c: any) => c.category === "done")
    const moved = await api(page, "POST", `/api/work-items/${item.id}/move`, { column: done.id })
    expect(moved.status).toBe(200)
    await expect(page.getByTestId(`board-column-${done.name}`).getByTestId(`board-card-${item.key}`)).toBeVisible({ timeout: 15_000 })
    await expect(cardPane(page).getByTestId("card-column")).toContainText(done.name, { timeout: 15_000 })
    await page.getByRole("button", { name: "Close card" }).click()
    await expect(page).not.toHaveURL(/card=/)
  })

  test("a card's description and summary live on its Details tab", async () => {
    const item = (await cards()).items[0]
    const description = `Retry loop double-charges the customer ${suffix}`
    const summary = `Rolled back the deploy; watching the next hour ${suffix}`
    const patched = await api(page, "PATCH", `/api/work-items/${item.id}`, { description, historySummary: summary })
    expect(patched.status).toBeLessThan(300)

    await page.getByTestId(`board-card-${item.key}`).click()
    await expect(page.getByTestId("card-details")).toHaveCount(0)
    await expect(cardPane(page).getByTestId("card-tab-thread")).toHaveAttribute("aria-selected", "true")

    await cardPane(page).getByTestId("card-tab-details").click()
    const details = page.getByTestId("card-details")
    await expect(details).toBeVisible()
    await expect(details).toContainText(description)
    await expect(details).toContainText("Summary")
    await expect(details).toContainText(summary)
    await expect(kanban(page)).toBeVisible()

    await cardPane(page).getByTestId("card-tab-thread").click()
    await expect(page.getByTestId("card-details")).toHaveCount(0)
    await expect(cardPane(page).getByTestId("card-tab-thread")).toHaveAttribute("aria-selected", "true")
    await page.getByRole("button", { name: "Close card" }).click()
  })

  test("a message becomes a card from its menu", async () => {
    const text = `Customers can't reset passwords ${suffix}`
    const posted = await api(page, "POST", `/api/conversations/${channelId}/messages`, { text })
    expect(posted.status).toBeLessThan(300)
    await page.getByTestId("channel-tabs").getByRole("tab", { name: "Messages" }).click()
    const message = page.getByText(text)
    await expect(message).toBeVisible({ timeout: 30_000 })
    await message.click({ button: "right" })
    await page.getByRole("menuitem", { name: "Make a card" }).click()
    await page.getByRole("button", { name: new RegExp(boardName) }).click()
    await expect(cardPane(page)).toBeVisible({ timeout: 15_000 })
    await expect.poll(async () => (await cards()).items.some((i: any) => i.title.includes("reset passwords")), { timeout: 15_000 }).toBe(true)
  })

  test("My work lists my cards and A/P/S act on the selection", async () => {
    const view = await cards()
    const mine = view.items.find((i: any) => i.title.includes("reset passwords"))
    await api(page, "PATCH", `/api/work-items/${mine.id}`, { assigneeUserId: userId })

    await page.goto("/work")
    const row = page.getByTestId(`work-row-${mine.key}`)
    await expect(row).toBeVisible({ timeout: 60_000 })
    await row.getByRole("checkbox").click()
    await expect(page.getByTestId("work-bulk-bar")).toContainText("1 selected")
    await page.keyboard.press("p")
    await page.getByTestId("option-sheet").getByRole("button", { name: "Urgent", exact: true }).click()
    await expect.poll(async () => (await api(page, "GET", `/api/work-items/${mine.id}`)).json?.item?.priority, { timeout: 15_000 }).toBe("urgent")

    await page.getByRole("tab", { name: "Board view" }).click()
    await expect(page.getByTestId("work-lane-backlog").getByTestId(`board-card-${mine.key}`)).toBeVisible({ timeout: 15_000 })
  })

  test("#activity has a Work filter for card milestones", async () => {
    const list = await api(page, "GET", `/api/workspaces/${workspaceId}/conversations`)
    const activity = (list.json?.conversations ?? list.json?.items ?? []).find((c: any) => c.kind === "activity")
    test.skip(!activity, "this workspace has no #activity channel")
    await page.goto(`/c/${activity.id}`)
    const filters = page.getByTestId("activity-filters")
    await filters.getByRole("button", { name: "Work" }).click()
    await expect(page.getByText(new RegExp(`finished .*Write release notes ${suffix}`))).toBeVisible({ timeout: 30_000 })
  })
})
