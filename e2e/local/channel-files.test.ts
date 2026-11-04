// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The Files pane: files shared in a channel are listed, searchable and
 * filterable, and "Show in chat" jumps to the message that shared them.
 * Beside the timeline on wide screens; in its place on phones.
 */
import { expect, test, type Page } from "@playwright/test"
import { LOCAL_API_BASE } from "./helpers"
import { activateTeamWorkspace, api, signIn, signInByApi, teamWorkspaceId } from "./team-nav-seed"

const suffix = Date.now().toString(36)
// A 1x1 transparent PNG.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64")

async function share(page: Page, conversationId: string, text: string, file: { name: string; mimeType: string; buffer: Buffer }) {
  const upload = await page.request.post(`${LOCAL_API_BASE}/api/conversations/${conversationId}/attachments`, { multipart: { file } })
  expect(upload.status(), await upload.text()).toBe(201)
  const attachment = (await upload.json()).attachment
  const sent = await api(page, "POST", `/api/conversations/${conversationId}/messages`, {
    text,
    attachmentIds: [attachment.id],
    clientMsgId: crypto.randomUUID(),
  })
  expect(sent.status, JSON.stringify(sent.json)).toBe(201)
  return { attachmentId: attachment.id as string, messageId: sent.json.message.id as string }
}

test.describe("Channel files", () => {
  test.describe.configure({ mode: "serial" })

  let channelId: string
  let workspaceId: string
  let spec: { attachmentId: string; messageId: string }

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(120_000)
    const page = await browser.newPage()
    await signIn(page)
    workspaceId = await teamWorkspaceId(page)
    const channel = await api(page, "POST", `/api/workspaces/${workspaceId}/conversations`, { name: `files-${suffix}`, kind: "public" })
    channelId = channel.json?.conversation?.id
    expect(channelId, JSON.stringify(channel.json)).toBeTruthy()
    spec = await share(page, channelId, "Here is the launch spec", {
      name: `launch-spec-${suffix}.md`,
      mimeType: "text/markdown",
      buffer: Buffer.from("# Launch\nWe ship on Friday."),
    })
    await share(page, channelId, "Offsite photo", { name: `offsite-${suffix}.png`, mimeType: "image/png", buffer: PNG })
    for (let i = 0; i < 25; i++) {
      await api(page, "POST", `/api/conversations/${channelId}/messages`, { text: `filler ${i}`, clientMsgId: crypto.randomUUID() })
    }
    await page.close()
  })

  test("wide screens show files beside the timeline, with search, filters and Show in chat", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await activateTeamWorkspace(page, workspaceId)
    await page.goto(`/c/${channelId}`)
    await page.getByRole("button", { name: "Files", exact: true }).click()

    const pane = page.getByTestId("files-pane")
    await expect(pane).toBeVisible({ timeout: 30_000 })
    await expect(page).toHaveURL(/files=1/)
    await expect(page.getByLabel("Message", { exact: true }).first()).toBeVisible()
    await expect(pane.getByText(`launch-spec-${suffix}.md`)).toBeVisible({ timeout: 15_000 })
    await expect(pane.getByText(`offsite-${suffix}.png`)).toBeVisible()

    await pane.getByLabel("Search files").fill("launch-spec")
    await expect(pane.getByText(`offsite-${suffix}.png`)).toHaveCount(0)
    await expect(pane.getByText(`launch-spec-${suffix}.md`)).toBeVisible()
    await pane.getByLabel("Search files").fill("")

    await pane.getByRole("tab", { name: "Images" }).click()
    await expect(pane.getByText(`launch-spec-${suffix}.md`)).toHaveCount(0)
    await expect(pane.getByText(`offsite-${suffix}.png`)).toBeVisible()
    await pane.getByRole("tab", { name: "Documents" }).click()
    await expect(pane.getByText(`launch-spec-${suffix}.md`)).toBeVisible()

    await pane.getByRole("button", { name: `Show launch-spec-${suffix}.md in chat` }).click()
    await expect(pane).toHaveCount(0)
    await expect(page).toHaveURL(new RegExp(`msg=${spec.messageId}`))
    await expect(page.getByText("Here is the launch spec")).toBeVisible({ timeout: 15_000 })
  })

  test("a new file shows up in an open pane without a reload", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await activateTeamWorkspace(page, workspaceId)
    await page.goto(`/c/${channelId}?files=1`)
    const pane = page.getByTestId("files-pane")
    await expect(pane.getByText(`launch-spec-${suffix}.md`)).toBeVisible({ timeout: 30_000 })
    await share(page, channelId, "Budget", { name: `budget-${suffix}.csv`, mimeType: "text/csv", buffer: Buffer.from("a,b\n1,2") })
    await expect(pane.getByText(`budget-${suffix}.csv`)).toBeVisible({ timeout: 15_000 })
  })

  test("an upload that carries no bytes is refused instead of stored empty", async ({ page }) => {
    // The composer that lost a file's content still posted the multipart
    // framing (SHO-303). Over real HTTP the API must say no, and the file must
    // never reach the Files pane — a stored 0-byte row downloads as an empty
    // file days later, with nothing anywhere saying why.
    // Sign in before touching the API: every call below rides this page's
    // cookie jar, and `activateTeamWorkspace` alone only sets localStorage.
    await signInByApi(page)
    await activateTeamWorkspace(page, workspaceId)
    const empty = await page.request.post(`${LOCAL_API_BASE}/api/conversations/${channelId}/attachments`, {
      multipart: { file: { name: `lost-kit-${suffix}.zip`, mimeType: "application/zip", buffer: Buffer.alloc(0) } },
    })
    expect(empty.status()).toBe(400)
    expect((await empty.json()).error.code).toBe("empty_file")

    const oneByte = await page.request.post(`${LOCAL_API_BASE}/api/conversations/${channelId}/attachments`, {
      multipart: { file: { name: `tiny-${suffix}.zip`, mimeType: "application/zip", buffer: Buffer.from([7]) } },
    })
    expect(oneByte.status(), await oneByte.text()).toBe(201)
    const tiny = (await oneByte.json()).attachment
    expect(tiny.size).toBe(1)
    // Only attachments on a message reach the Files pane, so send it.
    const sent = await api(page, "POST", `/api/conversations/${channelId}/messages`, {
      text: "one byte",
      attachmentIds: [tiny.id],
      clientMsgId: crypto.randomUUID(),
    })
    expect(sent.status, JSON.stringify(sent.json)).toBe(201)

    await page.goto(`/c/${channelId}?files=1`)
    const pane = page.getByTestId("files-pane")
    await expect(pane.getByText(`tiny-${suffix}.zip`)).toBeVisible({ timeout: 30_000 })
    await expect(pane.getByText(`lost-kit-${suffix}.zip`)).toHaveCount(0)
  })

  test("phones open Files from the actions sheet, in place of the timeline", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await activateTeamWorkspace(page, workspaceId)
    await page.goto(`/c/${channelId}`)
    await page.getByRole("button", { name: "More actions" }).click()
    await page.getByTestId("conversation-actions-sheet").getByRole("button", { name: "Files", exact: true }).click()
    const pane = page.getByTestId("files-pane")
    await expect(pane).toBeVisible({ timeout: 30_000 })
    await expect(pane.getByText(`launch-spec-${suffix}.md`)).toBeVisible({ timeout: 15_000 })
    await pane.getByRole("button", { name: "Close files" }).click()
    await expect(pane).toHaveCount(0)
    await expect(page.getByText("filler 24")).toBeVisible()
  })
})
