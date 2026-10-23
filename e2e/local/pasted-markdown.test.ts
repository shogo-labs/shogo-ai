// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-113 — a pasted markdown plan renders as markdown in the channel.
 *
 * The acceptance is the person's own sentence: paste a markdown document into
 * a channel, send it, and read it **without tapping anything**. So this spec
 * drives the real composer (a long `onChangeText` insert is what the app sees
 * when you paste) and then asserts on the rendered document itself: a heading
 * that is a heading, bold that is bold, a list that is a list, a fenced block
 * whose indentation survived — with zero clicks in between.
 *
 * It also pins the two things the fix could quietly get wrong:
 *
 * - the body must come from the file **as written** (`?raw=1`), not from the
 *   tidied search text, or paragraphs glue together and code indentation dies;
 * - at 390 px a long code line or a table must scroll inside its own block and
 *   never widen the timeline.
 */

import { expect, test, type Page } from "@playwright/test"
import { LOCAL_API_BASE } from "./helpers"
import { activateTeamWorkspace, api, signIn, teamWorkspaceId } from "./team-nav-seed"

const suffix = Date.now().toString(36)

/** A plan with every markdown feature the acceptance names, plus bulk. */
const LONG_CODE_LINE =
  "    return orders.reduce((sum, order) => sum + order.amount + order.tax + order.shipping + order.discount + order.credits + order.adjustments, 0) // a line far wider than a phone"

const FILLER = Array.from({ length: 78 }, (_, i) => `Paragraph ${i + 1} of the plan, written out so the paste is long enough to be a paste.`)

const PLAN = [
  "# Q4 billing plan",
  "",
  "Ship the **billing** rewrite first.",
  "",
  "- invoices",
  "  - retries",
  "- dunning",
  "",
  "```ts",
  "total(orders) {",
  LONG_CODE_LINE,
  "}",
  "```",
  "",
  "| stage | owner | note |",
  "| --- | --- | --- |",
  "| invoices | Ana | first |",
  "| dunning | Bob | after |",
  "",
  ...FILLER,
  "",
  "The end of the plan.",
].join("\n")

/** Same length, but no markdown: the composer files this as `Pasted code.txt`. */
const CODE_PASTE = [
  "export const totals = (orders: Order[]) => {",
  ...Array.from({ length: 90 }, (_, i) => `  const part${i} = orders.reduce((sum, o) => sum + o.amount, 0)`),
  "}",
].join("\n")

async function channel(page: Page): Promise<string> {
  const workspaceId = await teamWorkspaceId(page)
  const created = await api(page, "POST", `/api/workspaces/${workspaceId}/conversations`, {
    name: `paste-${suffix}-${Math.random().toString(36).slice(2, 6)}`,
    kind: "public",
  })
  const id = created.json?.conversation?.id
  expect(id, JSON.stringify(created.json)).toBeTruthy()
  return id
}

/** The attachment the message carried, so the raw route can be read back. */
async function lastAttachment(page: Page, conversationId: string, name: string) {
  const res = await api(page, "GET", `/api/conversations/${conversationId}/messages`)
  const messages: any[] = res.json?.messages ?? []
  for (const message of [...messages].reverse()) {
    const hit = (message.attachments ?? []).find((a: any) => a.name === name)
    if (hit) return { attachment: hit, message }
  }
  throw new Error(`no ${name} attachment in ${conversationId}: ${JSON.stringify(res.json).slice(0, 500)}`)
}

/** Paste-like insert: one `onChangeText` carrying the whole block. */
async function paste(page: Page, text: string): Promise<void> {
  const input = page.getByLabel("Message", { exact: true }).first()
  await expect(input).toBeVisible({ timeout: 30_000 })
  await input.click()
  await input.fill(text)
}

test.describe("SHO-113 pasted markdown", () => {
  // Each test signs its own context in first: a throwaway page's cookie jar is
  // not the one `page.request` uses, so the seed below would be unauthorized.
  test.beforeEach(async ({ page }) => {
    test.setTimeout(180_000)
    await signIn(page)
  })

  test("a pasted plan is rendered as markdown on send, with no tap", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    const pageErrors: string[] = []
    page.on("pageerror", (err) => pageErrors.push(String(err)))
    const workspaceId = await teamWorkspaceId(page)
    await activateTeamWorkspace(page, workspaceId)
    const conversationId = await channel(page)
    await page.goto(`/c/${conversationId}`)

    await paste(page, PLAN)
    // The composer files a long block as a paste chip, not as input text.
    await expect(page.getByText("Markdown paste").first()).toBeVisible({ timeout: 15_000 })
    await page.getByLabel("Send message").first().click()

    const card = page.getByTestId("pasted-markdown-card").first()
    await expect(card).toBeVisible({ timeout: 30_000 })

    // ── The document itself, before any click ─────────────────────────────
    await expect(card.locator('[data-streamdown="heading-1"]').first()).toHaveText("Q4 billing plan", { timeout: 20_000 })
    await expect(card.locator('[data-streamdown="strong"]').first()).toHaveText("billing")
    await expect(card.locator('[data-streamdown="list-item"], li').first()).toBeVisible()
    expect(await card.locator('[data-streamdown="list-item"], li').count()).toBeGreaterThanOrEqual(3)

    const code = card.locator("pre").first()
    await expect(code).toBeVisible()
    // The four-space indent is the thing the tidied search text destroys.
    expect(await code.innerText()).toContain("    return orders.reduce")

    // Blank lines survived as block boundaries (paragraphs, not one run-on).
    expect(await card.locator("p").count()).toBeGreaterThanOrEqual(2)

    // The file header is kept: name, size and a working Download.
    await expect(card).toContainText("Pasted markdown.md")
    await expect(card).toContainText(/[\d.]+ KB/)
    await expect(card.getByLabel("Download Pasted markdown.md").first()).toBeVisible()
    // The old plain sample is replaced, not stacked underneath.
    await expect(card.getByTestId("attachment-preview-text")).toHaveCount(0)

    // ── The raw read the card is built on ────────────────────────────────
    const { attachment } = await lastAttachment(page, conversationId, "Pasted markdown.md")
    expect(String(attachment.mimeType).toLowerCase()).toBe("text/markdown")
    const raw = await page.request.get(`${LOCAL_API_BASE}/api/conversation-files/${attachment.id}/text?raw=1`)
    expect(raw.status()).toBe(200)
    const rawBody = await raw.json()
    expect(rawBody.text).toContain("\n\n")
    expect(rawBody.text).toContain("    return orders.reduce")
    // The default read is still the tidied search text — no behaviour change.
    const tidied = await (await page.request.get(`${LOCAL_API_BASE}/api/conversation-files/${attachment.id}/text`)).json()
    expect(tidied.text).not.toContain("\n\n")

    // ── 390 px: the block never widens the timeline ──────────────────────
    const widths = await card.evaluate((el) => {
      const node = el as HTMLElement
      const rect = node.getBoundingClientRect()
      return {
        cardRight: rect.right,
        cardWidth: rect.width,
        cardScroll: node.scrollWidth - node.clientWidth,
        docScroll: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        viewport: window.innerWidth,
        codeScrolls: Array.from(node.querySelectorAll("pre")).map((pre) => pre.scrollWidth > pre.clientWidth + 1),
      }
    })
    expect(widths.cardRight).toBeLessThanOrEqual(widths.viewport + 1)
    expect(widths.cardScroll).toBeLessThanOrEqual(1)
    expect(widths.docScroll).toBeLessThanOrEqual(1)
    expect(widths.codeScrolls.some(Boolean), "a long code line scrolls inside its own block").toBe(true)

    // ── Show more expands in place ───────────────────────────────────────
    const toggle = card.getByTestId("pasted-markdown-toggle")
    await expect(toggle).toHaveText("Show more")
    const collapsed = (await card.boundingBox())!.height
    const urlBefore = page.url()
    const pagesBefore = page.context().pages().length
    await toggle.click()
    await expect(card.getByTestId("pasted-markdown-toggle")).toHaveText("Show less", { timeout: 15_000 })
    expect((await card.boundingBox())!.height).toBeGreaterThan(collapsed)
    expect(page.url()).toBe(urlBefore)
    expect(page.context().pages().length).toBe(pagesBefore)
    await expect(card).toContainText("The end of the plan.")

    // Open file still opens the whole document in the app — never a browser tab.
    await card.getByTestId("pasted-markdown-open").click()
    await expect(page).toHaveURL(new RegExp(`/f/${attachment.id}`), { timeout: 20_000 })
    expect(page.context().pages().length).toBe(pagesBefore)

    expect(pageErrors).toEqual([])
  })

  test("the raw read is capped at 60k and pages the rest of a big document", async ({ page }) => {
    const workspaceId = await teamWorkspaceId(page)
    const conversationId = await channel(page)
    const big = `# Big plan\n\n${"x".repeat(90_000)}`

    const upload = await page.request.post(`${LOCAL_API_BASE}/api/conversations/${conversationId}/attachments`, {
      multipart: { file: { name: "Pasted markdown.md", mimeType: "text/markdown", buffer: Buffer.from(big) } },
    })
    expect(upload.status(), await upload.text()).toBe(201)
    const attachment = (await upload.json()).attachment
    const sent = await api(page, "POST", `/api/conversations/${conversationId}/messages`, {
      text: "The big plan",
      attachmentIds: [attachment.id],
      clientMsgId: crypto.randomUUID(),
    })
    expect(sent.status, JSON.stringify(sent.json)).toBe(201)

    const first = await (await page.request.get(`${LOCAL_API_BASE}/api/conversation-files/${attachment.id}/text?raw=1&limit=999999`)).json()
    expect(first.text.length).toBe(60_000)
    expect(first.nextOffset).toBe(60_000)
    expect(first.totalChars).toBe(big.length)

    const second = await (await page.request.get(`${LOCAL_API_BASE}/api/conversation-files/${attachment.id}/text?raw=1&offset=60000&limit=60000`)).json()
    expect(second.offset).toBe(60_000)
    expect(second.text.length).toBe(big.length - 60_000)
    expect(second.text.startsWith("xxxx")).toBe(true)
    expect(second.nextOffset).toBeNull()
  })

  test("a body that will not load leaves today's sample, with no error banner", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    const pageErrors: string[] = []
    page.on("pageerror", (err) => pageErrors.push(String(err)))
    const workspaceId = await teamWorkspaceId(page)
    await activateTeamWorkspace(page, workspaceId)
    const conversationId = await channel(page)
    await page.route(
      (url) => url.pathname.includes("/conversation-files/") && url.pathname.endsWith("/text") && url.searchParams.get("raw") === "1",
      (route) => route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: { code: "boom", message: "nope" } }) }),
    )
    await page.goto(`/c/${conversationId}`)

    await paste(page, PLAN)
    await expect(page.getByText("Markdown paste").first()).toBeVisible({ timeout: 15_000 })
    await page.getByLabel("Send message").first().click()

    const card = page.getByTestId("pasted-markdown-card").first()
    await expect(card).toBeVisible({ timeout: 30_000 })
    // The plain sample the file card has always shown, and the way out of it.
    await expect(card.getByTestId("attachment-preview-text")).toBeVisible({ timeout: 20_000 })
    await expect(card.getByTestId("pasted-markdown-open")).toBeVisible()
    await expect(card.getByRole("alert")).toHaveCount(0)
    expect(pageErrors).toEqual([])
  })

  test("a paste that is not markdown keeps the plain file card", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    const workspaceId = await teamWorkspaceId(page)
    await activateTeamWorkspace(page, workspaceId)
    const conversationId = await channel(page)
    await page.goto(`/c/${conversationId}`)

    await paste(page, CODE_PASTE)
    await expect(page.getByText("Code paste").first()).toBeVisible({ timeout: 15_000 })
    await page.getByLabel("Send message").first().click()

    await expect(page.getByTestId("attachment-card-Pasted code.txt").first()).toBeVisible({ timeout: 30_000 })
    await expect(page.getByTestId("pasted-markdown-card")).toHaveCount(0)
  })
})
