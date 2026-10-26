// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Board card sorting (SHO-161), on the same board component desktop, web and
 * mobile render: a board opens Newest, the Sort control re-orders every column
 * at once, the choice is remembered per board across a reload, list view is one
 * flat list for Newest/Oldest, and a drag only sends a `before` anchor — or
 * reorders inside a column — in Manual.
 *
 * Needs the local stack (`E2E_LOCAL_START_STACK=1` starts it).
 */
import { expect, test, type Page } from "@playwright/test"
import { activateTeamWorkspace, api, signIn, teamWorkspaceId } from "./team-nav-seed"

const kanban = (page: Page) => page.getByTestId("board-kanban")
const sortButton = (page: Page) => page.getByTestId("board-sort")
// A card key is `<BOARD>-<n>`; `board-card-working-<key>` is a spinner inside it.
const cardKeys = (page: Page, column: string) => page.getByTestId(`board-column-${column}`).getByTestId(/^board-card-[A-Z0-9]+-\d+$/)

test.describe("Board card sorting", () => {
  test.describe.configure({ mode: "serial" })
  test.use({ viewport: { width: 1440, height: 900 } })

  let page: Page
  let workspaceId: string
  let channelId: string
  let boardId: string
  let otherBoardId: string
  const suffix = Date.now().toString(36)
  const moves: Array<{ id: string; body: any }> = []

  async function view() {
    return (await api(page, "GET", `/api/boards/${boardId}`)).json
  }

  async function columns(): Promise<Array<{ id: string; name: string }>> {
    return (await view()).board.columns
  }

  async function columnId(name: string): Promise<string> {
    const found = (await columns()).find((c) => c.name === name)
    if (!found) throw new Error(`no ${name} column: ${JSON.stringify((await columns()).map((c) => c.name))}`)
    return found.id
  }

  /** Stored cards of one column, in the order the server keeps them (position asc). */
  async function storedColumn(name: string) {
    const id = await columnId(name)
    return (await view()).items
      .filter((i: any) => i.columnId === id)
      .sort((a: any, b: any) => a.position - b.position)
  }

  /** The same column by creation, oldest first — what Oldest must show. */
  async function oldestFirst(name: string): Promise<string[]> {
    return (await storedColumn(name)).slice().sort((a: any, b: any) => a.number - b.number).map((i: any) => i.key)
  }

  async function addCard(title: string, column: string): Promise<string> {
    const created = await api(page, "POST", `/api/boards/${boardId}/items`, { title, column: await columnId(column) })
    const key = created.json?.item?.key
    if (!key) throw new Error(`card create failed: ${JSON.stringify(created.json)}`)
    return key
  }

  async function drawn(page: Page, column: string): Promise<string[]> {
    return cardKeys(page, column).evaluateAll((els) =>
      els.map((el) => (el.getAttribute("data-testid") ?? "").replace("board-card-", "")),
    )
  }

  async function listDrawn(page: Page): Promise<string[]> {
    return page
      .getByTestId("board-list")
      .getByTestId(/^work-row-/)
      .evaluateAll((els) => els.map((el) => (el.getAttribute("data-testid") ?? "").replace("work-row-", "")))
  }

  async function chooseSort(page: Page, label: "Newest" | "Oldest" | "Manual") {
    await sortButton(page).click()
    await page.getByTestId("option-sheet").getByText(label, { exact: true }).click()
    await expect(sortButton(page)).toContainText(label)
  }

  async function openBoard(id: string) {
    await page.goto(`/c/${channelId}?board=${id}`)
    await expect(kanban(page)).toBeVisible({ timeout: 60_000 })
  }

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(180_000)
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
    page = await context.newPage()
    await signIn(page)
    workspaceId = await teamWorkspaceId(page)
    await activateTeamWorkspace(page, workspaceId)
    const channel = await api(page, "POST", `/api/workspaces/${workspaceId}/conversations`, { name: `sort-${suffix}`, kind: "public" })
    channelId = channel.json?.conversation?.id
    if (!channelId) throw new Error(`channel create failed: ${JSON.stringify(channel.json)}`)
    const board = await api(page, "POST", `/api/workspaces/${workspaceId}/boards`, { name: `Sort ${suffix}`, conversationId: channelId })
    boardId = board.json?.board?.id
    if (!boardId) throw new Error(`board create failed: ${JSON.stringify(board.json)}`)
    const other = await api(page, "POST", `/api/workspaces/${workspaceId}/boards`, { name: `Sort other ${suffix}`, conversationId: channelId })
    otherBoardId = other.json?.board?.id

    // Three cards in Backlog, then one in In progress, so Oldest/Newest and the
    // flat list all have something to disagree about across columns.
    await addCard(`First ${suffix}`, "Backlog")
    await addCard(`Second ${suffix}`, "Backlog")
    await addCard(`Third ${suffix}`, "Backlog")
    await addCard(`Fourth ${suffix}`, "In progress")

    page.on("request", (req) => {
      const match = req.url().match(/\/api\/work-items\/([^/]+)\/move$/)
      if (!match || req.method() !== "POST") return
      let body: any = null
      try {
        body = req.postDataJSON()
      } catch {}
      moves.push({ id: match[1]!, body })
    })
  })

  test.afterAll(async () => {
    if (boardId) await api(page, "POST", `/api/boards/${boardId}/archive`, { archived: true }).catch(() => {})
    if (otherBoardId) await api(page, "POST", `/api/boards/${otherBoardId}/archive`, { archived: true }).catch(() => {})
    await api(page, "PATCH", `/api/conversations/${channelId}`, { archived: true }).catch(() => {})
    await page.context().close()
  })

  test("a board with no saved preference opens Newest, the newest card on top", async () => {
    await openBoard(boardId)
    await expect(sortButton(page)).toContainText("Newest")
    const newestFirst = (await oldestFirst("Backlog")).reverse()
    expect(newestFirst.length).toBe(3)
    await expect.poll(() => drawn(page, "Backlog"), { timeout: 15_000 }).toEqual(newestFirst)
  })

  test("Oldest reverses every column, and Manual is the stored drag order", async () => {
    const byCreation = await oldestFirst("Backlog")
    await chooseSort(page, "Oldest")
    await expect.poll(() => drawn(page, "Backlog")).toEqual(byCreation)

    // Manual opens on the stored order, which on an untouched board equals the
    // creation order — so the drag is what tells the two apart.
    await chooseSort(page, "Manual")
    expect((await storedColumn("Backlog")).map((i: any) => i.key)).toEqual(byCreation)
    await expect.poll(() => drawn(page, "Backlog")).toEqual(byCreation)
    await cardKeys(page, "Backlog").nth(2).dragTo(cardKeys(page, "Backlog").nth(0))
    const manualOrder = [byCreation[2], byCreation[0], byCreation[1]]
    await expect.poll(async () => (await storedColumn("Backlog")).map((i: any) => i.key), { timeout: 15_000 }).toEqual(manualOrder)
    await expect.poll(() => drawn(page, "Backlog")).toEqual(manualOrder)

    await chooseSort(page, "Oldest")
    await expect.poll(() => drawn(page, "Backlog")).toEqual(byCreation)
    await chooseSort(page, "Newest")
    await expect.poll(() => drawn(page, "Backlog")).toEqual(byCreation.slice().reverse())
    await chooseSort(page, "Manual")
    await expect.poll(() => drawn(page, "Backlog")).toEqual(manualOrder)
  })

  test("the choice survives a reload for that board and leaves other boards alone", async () => {
    await page.reload()
    await expect(kanban(page)).toBeVisible({ timeout: 60_000 })
    await expect(sortButton(page)).toContainText("Manual")
    const manualOrder = (await storedColumn("Backlog")).map((i: any) => i.key)
    await expect.poll(() => drawn(page, "Backlog"), { timeout: 15_000 }).toEqual(manualOrder)

    await openBoard(otherBoardId)
    await expect(sortButton(page)).toContainText("Newest")
  })

  test("list view is one flat list for Newest and Oldest, grouped by column for Manual", async () => {
    await openBoard(boardId)
    const all = (await view()).items.slice().sort((a: any, b: any) => a.number - b.number).map((i: any) => i.key)
    const manualOrder = (await storedColumn("Backlog")).map((i: any) => i.key)
    const doing = (await storedColumn("In progress")).map((i: any) => i.key)

    await chooseSort(page, "Newest")
    await page.getByLabel("List view").click()
    await expect.poll(() => listDrawn(page), { timeout: 15_000 }).toEqual(all.slice().reverse())
    await chooseSort(page, "Oldest")
    await expect.poll(() => listDrawn(page)).toEqual(all)
    // Manual keeps the columns in board order, each in its own order.
    await chooseSort(page, "Manual")
    await expect.poll(() => listDrawn(page)).toEqual([...manualOrder, ...doing])
    await page.getByLabel("Board view").click()
  })

  test("Newest/Oldest drags only change the column; Manual drags still carry a before anchor", async () => {
    await expect(kanban(page)).toBeVisible({ timeout: 60_000 })
    const doing = await columnId("In progress")
    const manualOrder = (await storedColumn("Backlog")).map((i: any) => i.key)
    await chooseSort(page, "Newest")
    const newestFirst = (await storedColumn("Backlog")).slice().sort((a: any, b: any) => b.number - a.number).map((i: any) => i.key)
    await expect.poll(() => drawn(page, "Backlog")).toEqual(newestFirst)

    // Same column, Newest: the drop has no visible meaning, so nothing is sent.
    moves.length = 0
    await cardKeys(page, "Backlog").nth(0).dragTo(cardKeys(page, "Backlog").nth(1))
    await page.waitForTimeout(1500)
    expect(moves).toEqual([])
    await expect.poll(() => drawn(page, "Backlog")).toEqual(newestFirst)

    // Another column, Newest: the move lands, with no `before` anchor.
    const moving = newestFirst[0]!
    moves.length = 0
    await cardKeys(page, "Backlog").nth(0).dragTo(page.getByTestId("board-column-In progress"))
    await expect.poll(async () => moves.length, { timeout: 15_000 }).toBe(1)
    expect(moves[0]!.body.column).toBe(doing)
    expect(moves[0]!.body.before).toBeUndefined()
    await expect.poll(async () => (await view()).items.find((i: any) => i.id === moves[0]!.id)?.key).toBe(moving)
    await expect.poll(async () => (await view()).items.find((i: any) => i.id === moves[0]!.id)?.columnId).toBe(doing)

    // Manual, same column: the drop sends the card it went above.
    const left = (await storedColumn("Backlog")).map((i: any) => i.key)
    expect(left.length).toBe(2)
    await chooseSort(page, "Manual")
    await expect.poll(() => drawn(page, "Backlog")).toEqual(left)
    moves.length = 0
    await cardKeys(page, "Backlog").nth(1).dragTo(cardKeys(page, "Backlog").nth(0))
    await expect.poll(async () => moves.length, { timeout: 15_000 }).toBe(1)
    expect(moves[0]!.body.column).toBe(await columnId("Backlog"))
    expect(moves[0]!.body.before).toBe((await view()).items.find((i: any) => i.key === left[0])?.id)
    await expect.poll(async () => (await storedColumn("Backlog")).map((i: any) => i.key)).toEqual([left[1], left[0]])
  })
})
