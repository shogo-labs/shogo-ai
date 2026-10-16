// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Channel docs on desktop: the "Messages | Doc" tabs, writing in the inline
 * editor with autosave, the @ menu (people, dates), chips and their cards, the
 * person mentioned getting an inbox item that opens the doc, ticking a
 * checklist item, another editor's save appearing live, and a scripted agent
 * editing the doc with mentions and dates that stay chips.
 *
 * Needs the local stack (`E2E_LOCAL_START_STACK=1` starts it). Set
 * E2E_LOCAL_DATABASE_URL when running against your own stack.
 */
import { execFileSync } from "child_process"
import { mkdirSync, writeFileSync } from "fs"
import { dirname, resolve } from "path"
import { expect, test, type Browser, type Page } from "@playwright/test"
import { LOCAL_API_BASE } from "./helpers"
import { activateTeamWorkspace, api, SCRIPT_PATH, signIn, teamWorkspaceId } from "./team-nav-seed"

const REPO = resolve(__dirname, "../..")
const DATABASE_URL = process.env.E2E_LOCAL_DATABASE_URL || `file:${resolve(REPO, "test-results/e2e-local.db")}`
const PARTNER = { email: "docs-partner@example.com", password: "docs-partner-pass", name: "Dana Docs" }

const docPane = (page: Page) => page.getByTestId("channel-doc-pane")
const editor = (page: Page) => page.getByTestId("doc-editor-content")
const mentionMenu = (page: Page) => page.getByTestId("doc-mention-menu")

async function serverDoc(page: Page, channelId: string) {
  return (await api(page, "GET", `/api/conversations/${channelId}/doc`)).json?.doc ?? null
}

function seedPartner(): { userId: string } {
  const out = execFileSync("bun", ["--no-env-file", resolve(__dirname, "huddle-seed-user.ts"), PARTNER.email, PARTNER.password, PARTNER.name], {
    cwd: REPO,
    env: { ...process.env, SHOGO_LOCAL_MODE: "true", DATABASE_URL, SHOGO_APP_DATABASE_URL: DATABASE_URL },
    encoding: "utf8",
  })
  return JSON.parse(out.trim().split("\n").pop()!)
}

async function partnerPage(browser: Browser, workspaceId: string): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const signedIn = await context.request.post(`${LOCAL_API_BASE}/api/auth/sign-in/email`, {
    data: { email: PARTNER.email, password: PARTNER.password },
  })
  expect(signedIn.ok(), await signedIn.text()).toBe(true)
  await context.request.post(`${LOCAL_API_BASE}/api/onboarding/complete`)
  const page = await context.newPage()
  await activateTeamWorkspace(page, workspaceId)
  return page
}

/** Clicks a check list item's box, which Lexical draws in the item's left gutter. */
async function tick(page: Page, name: string) {
  const item = docPane(page).getByRole("checkbox", { name })
  const box = await item.boundingBox()
  if (!box) throw new Error(`no checklist item ${name}`)
  await page.mouse.click(box.x + 6, box.y + box.height / 2)
}

test.describe("Channel docs", () => {
  test.describe.configure({ mode: "serial" })
  test.use({ viewport: { width: 1440, height: 900 } })

  let page: Page
  let workspaceId: string
  let channelId: string
  let partnerId: string
  const suffix = Date.now().toString(36)
  const channelName = `docs-${suffix}`

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(180_000)
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
    page = await context.newPage()
    await signIn(page)
    workspaceId = await teamWorkspaceId(page)
    partnerId = seedPartner().userId
    await activateTeamWorkspace(page, workspaceId)
    const channel = await api(page, "POST", `/api/workspaces/${workspaceId}/conversations`, { name: channelName, kind: "public" })
    channelId = channel.json?.conversation?.id
    if (!channelId) throw new Error(`channel create failed: ${JSON.stringify(channel.json)}`)
  })

  test.afterAll(async () => {
    if (!page) return
    await api(page, "PATCH", `/api/conversations/${channelId}`, { archived: true }).catch(() => {})
    await page.context().close()
  })

  test("a channel offers a Doc tab whose editor autosaves markdown", async () => {
    await page.goto(`/c/${channelId}`)
    const tabs = page.getByTestId("channel-tabs")
    await expect(tabs.getByRole("tab", { name: "Messages" })).toHaveAttribute("aria-selected", "true", { timeout: 60_000 })
    await tabs.getByRole("tab", { name: "Add doc" }).click()
    await expect(page).toHaveURL(/doc=1/)
    await expect(editor(page)).toBeVisible({ timeout: 30_000 })
    await expect(docPane(page).getByText("No doc yet")).toHaveCount(0)

    await page.getByLabel("Doc title").fill(`Launch plan ${suffix}`)
    await editor(page).click()
    await page.keyboard.type("## Checklist")
    await page.keyboard.press("Enter")
    await page.keyboard.type("[] Write release notes")
    await page.keyboard.press("Enter")
    await page.keyboard.type("Tell support")
    await expect(docPane(page).locator("h2", { hasText: "Checklist" })).toBeVisible()
    await expect(docPane(page).getByRole("checkbox", { name: "Write release notes" })).toBeVisible()

    await expect.poll(async () => (await serverDoc(page, channelId))?.content ?? "", { timeout: 15_000 })
      .toMatch(/## Checklist\s+- \[ \] Write release notes\s+- \[ \] Tell support/)
    await expect(page.getByTestId("doc-status")).toContainText("Edited by", { timeout: 15_000 })
    expect((await serverDoc(page, channelId)).title).toBe(`Launch plan ${suffix}`)
    await expect(tabs.getByRole("tab", { name: "Doc" })).toHaveAttribute("aria-selected", "true")
  })

  test("@ opens a menu of categories; picking a person and a date inserts chips", async () => {
    await editor(page).click()
    await page.keyboard.press("ControlOrMeta+End")
    await page.keyboard.press("Enter")
    await page.keyboard.press("Enter")
    await page.keyboard.type("On call: @")
    const menu = mentionMenu(page)
    await expect(menu).toBeVisible()
    for (const category of ["people", "agents", "dates", "channels"]) {
      await expect(menu.getByTestId(`doc-menu-row-category:${category}`)).toBeVisible()
    }

    await page.keyboard.type("Dana")
    const person = menu.getByTestId(`doc-menu-row-people:<@u:${partnerId}>`)
    await expect(person).toBeVisible()
    await person.click()
    await expect(menu).toHaveCount(0)
    const personChip = editor(page).locator(`[data-testid="doc-chip"][data-doc-token="<@u:${partnerId}>"]`)
    await expect(personChip).toHaveText(`@${PARTNER.name}`)

    await page.keyboard.type("from @")
    await menu.getByTestId("doc-menu-row-category:dates").click()
    await expect(menu.getByTestId("doc-menu-row-back")).toBeVisible()
    await menu.locator('[data-testid^="doc-menu-row-dates:"]').first().click()
    await expect(editor(page).locator('[data-testid="doc-chip"][data-doc-token^="<!date:"]')).toHaveCount(1)

    await expect.poll(async () => (await serverDoc(page, channelId))?.content ?? "", { timeout: 15_000 })
      .toMatch(new RegExp(`On call: <@u:${partnerId}> from <!date:\\d{4}-\\d{2}-\\d{2}>`))
  })

  test("the person mentioned gets an inbox item that opens the doc", async ({ browser }) => {
    const other = await partnerPage(browser, workspaceId)
    try {
      await expect.poll(async () => {
        const res = await api(other, "GET", `/api/workspaces/${workspaceId}/inbox`)
        return (res.json?.items ?? []).find((i: any) => i.conversationId === channelId && i.target === "doc")?.title ?? null
      }, { timeout: 15_000 }).toContain(`#${channelName} doc`)

      await other.goto("/c/inbox")
      const items = other.getByRole("button", { name: new RegExp(`mentioned you in the #${channelName} doc`) })
      await expect(items).toHaveCount(2, { timeout: 30_000 })
      await other.getByRole("button", { name: new RegExp(`^Mention: .*#${channelName} doc`) }).click()
      await expect(other).toHaveURL(new RegExp(`/c/${channelId}\\?.*doc=1`))
      await expect(docPane(other).getByRole("checkbox", { name: "Write release notes" })).toBeVisible({ timeout: 30_000 })
      await expect(editor(other).locator(`[data-testid="doc-chip"][data-doc-token="<@u:${partnerId}>"]`)).toHaveClass(/sd-chip-me/)
    } finally {
      await other.context().close()
    }
  })

  test("chips open a person card and a date card that sets a reminder", async () => {
    await editor(page).locator(`[data-testid="doc-chip"][data-doc-token="<@u:${partnerId}>"]`).click()
    const card = page.getByTestId("person-profile-card")
    await expect(card).toContainText(PARTNER.name)
    await expect(card.getByLabel(`Message ${PARTNER.name}`)).toBeVisible()
    await card.getByLabel("Close").click()
    await expect(card).toHaveCount(0)

    await editor(page).locator('[data-testid="doc-chip"][data-doc-token^="<!date:"]').click()
    const dateCard = page.getByTestId("date-chip-card")
    await expect(page.getByTestId("date-chip-full")).toBeVisible()
    const preset = dateCard.getByRole("button", { name: /^Remind me / }).first()
    if (await preset.count()) {
      await preset.click()
      await expect(page.getByTestId("date-chip-notice")).toBeVisible()
      const reminders = await api(page, "GET", `/api/workspaces/${workspaceId}/reminders`)
      const mine = (reminders.json?.reminders ?? reminders.json?.items ?? []).find((r: any) => r.conversationId === channelId)
      expect(mine?.target).toBe("doc")
    }
    await dateCard.getByLabel("Close").click()
    await expect(dateCard).toHaveCount(0)
  })

  test("the doc reopens from a link, and ticking a task saves it", async () => {
    await page.goto(`/c/${channelId}?doc=1`)
    await expect(docPane(page).getByRole("checkbox", { name: "Tell support" })).toBeVisible({ timeout: 60_000 })
    await tick(page, "Tell support")
    await expect.poll(async () => (await serverDoc(page, channelId))?.content ?? "", { timeout: 15_000 })
      .toContain("- [x] Tell support")

    await page.getByTestId("channel-tabs").getByRole("tab", { name: "Messages" }).click()
    await expect(page).not.toHaveURL(/doc=1/)
    await expect(docPane(page)).toHaveCount(0)
  })

  test("someone else's save shows up live in an open doc", async ({ browser }) => {
    const other = await partnerPage(browser, workspaceId)
    try {
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
      await other.context().close()
    }
  })

  test("an agent edits the doc with @names and dates that stay chips", async () => {
    const agent = `Scribe${suffix}`
    mkdirSync(dirname(SCRIPT_PATH), { recursive: true })
    writeFileSync(SCRIPT_PATH, JSON.stringify({
      delayMs: 100,
      agents: {
        [agent]: [{
          when: "schedule",
          doc: { mode: "patch_section", section: "On call", content: `- <!date:2026-11-02> @${PARTNER.name}` },
          reply: "Added to the doc:\n{{doc}}",
        }],
      },
    }))
    const session = await (await page.request.get(`${LOCAL_API_BASE}/api/auth/get-session`)).json().catch(() => null)
    const project = await api(page, "POST", "/api/projects", {
      name: agent, workspaceId, createdBy: session?.user?.id, tier: "starter", status: "draft", accessLevel: "anyone", schemas: [],
    })
    const projectId = project.json?.data?.id ?? project.json?.id
    if (!projectId) throw new Error(`project create failed: ${JSON.stringify(project.json)}`)

    try {
      await page.goto(`/c/${channelId}?doc=1`)
      await expect(editor(page)).toBeVisible({ timeout: 60_000 })
      const before = (await serverDoc(page, channelId)).version

      const sent = await api(page, "POST", `/api/conversations/${channelId}/messages`, { text: `<@a:p:${projectId}> put Dana on the schedule` })
      expect(sent.status).toBeLessThan(300)

      await expect.poll(async () => {
        const doc = await serverDoc(page, channelId)
        return doc && doc.version > before ? doc.content : ""
      }, { timeout: 30_000 }).toContain(`## On call\n\n- <!date:2026-11-02> <@u:${partnerId}>`)
      expect((await serverDoc(page, channelId)).updatedBy).toMatchObject({ type: "agent", id: projectId })

      const section = editor(page).locator("h2", { hasText: "On call" })
      await expect(section).toBeVisible({ timeout: 15_000 })
      await expect(editor(page).locator('[data-testid="doc-chip"][data-doc-token="<!date:2026-11-02>"]')).toBeVisible()
      await expect(editor(page).locator(`[data-testid="doc-chip"][data-doc-token="<@u:${partnerId}>"]`)).toHaveCount(2)

      // The agent answers in a thread; the doc it quotes keeps mentions readable.
      await page.getByTestId("channel-tabs").getByRole("tab", { name: "Messages" }).click()
      await page.getByText("1 reply").last().click()
      await expect(page.getByLabel("Close thread")).toBeVisible({ timeout: 30_000 })
      const reply = page.getByText(/Added to the doc:/).last()
      await expect(reply).toBeVisible({ timeout: 30_000 })
      await expect(page.getByText(`@${PARTNER.name}`).last()).toBeVisible()
    } finally {
      await page.request.delete(`${LOCAL_API_BASE}/api/projects/${projectId}`).catch(() => {})
    }
  })
})
