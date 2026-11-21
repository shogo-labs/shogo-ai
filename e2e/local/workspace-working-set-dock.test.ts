// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-484 — the Working set is a chat-dock panel, and the phone pays the
 * header's clearance once.
 *
 * Russell: *"there is too much padding on mobile with a working set. Also I
 * think these should just be in the dock panel on desktop and mobile."*
 *
 * On `origin/main` the workspace agent's chat drew the Working set as its own
 * row between the header and the transcript: on a phone the screen inserted an
 * `insets.top + 112` spacer for it *and* `ChatPanel` still padded the transcript
 * `pt-32` for the floating header, so the first message started ~160 px lower
 * than in the same chat with no attachments. The row is a dock panel now, above
 * the composer, and the spacer only exists for the personal welcome card.
 *
 * So this spec measures what the report was about: the first message's `y` in a
 * chat with an attached project must equal the same chat's `y` with the project
 * detached, and the "Working set" header must sit *below* that message (in the
 * dock), not above it.
 *
 * Each test seeds its own throwaway workspace through the local API — one
 * session, one message, one project, the attachment — so no model turn runs and
 * nothing another spec reads is touched. The workspace is deleted afterwards.
 *
 *   E2E_LOCAL_START_STACK=1 npx playwright test --config e2e/local/playwright.config.ts \
 *     workspace-working-set-dock --project chromium --retries 0
 */
import { expect, test, type Page } from "@playwright/test"
import { LOCAL_API_BASE, ignoreDevErrorToast } from "./helpers"
import { activateTeamWorkspace, signInByApi } from "./team-nav-seed"

test.setTimeout(180_000)

type ApiResult = { status: number; json: any }

async function api(
  page: Page,
  method: string,
  path: string,
  body?: unknown,
): Promise<ApiResult> {
  const res = await page.request.fetch(`${LOCAL_API_BASE}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    data: body ? JSON.stringify(body) : undefined,
  })
  return { status: res.status(), json: await res.json().catch(() => null) }
}

interface Fixture {
  workspaceId: string
  sessionId: string
  projectId: string
  projectName: string
  /** Unique per test: the primary session is per user, and other specs share it. */
  message: string
}

/**
 * A private workspace whose agent chat holds one message and one attached
 * project.
 *
 * The session comes from `sessions/primary` (per user, so it can carry rows
 * from another spec); the message text is unique per test so the transcript
 * assertion can never resolve somebody else's row.
 */
async function seedChat(page: Page): Promise<Fixture> {
  const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  const created = await api(page, "POST", "/api/workspaces", {
    name: `E2E working set ${stamp}`,
  })
  const workspaceId: string | undefined =
    created.json?.workspace?.id ?? created.json?.data?.id ?? created.json?.id
  expect(workspaceId, `no workspace: ${JSON.stringify(created.json)}`).toBeTruthy()

  await activateTeamWorkspace(page, workspaceId!)

  const primary = await api(
    page,
    "POST",
    `/api/workspaces/${workspaceId}/sessions/primary`,
    {},
  )
  const sessionId: string | undefined = primary.json?.session?.id
  expect(sessionId, `no session: ${JSON.stringify(primary.json)}`).toBeTruthy()

  const me = await api(page, "GET", "/api/auth/get-session")
  const projectName = `E2E working set ${stamp}`

  const project = await api(page, "POST", "/api/projects", {
    name: projectName,
    workspaceId,
    createdBy: me.json?.user?.id,
    tier: "starter",
    status: "draft",
    accessLevel: "anyone",
    schemas: [],
    settings: JSON.stringify({ activeMode: "canvas", techStackId: "react-app" }),
  })
  const projectId: string | undefined =
    project.json?.data?.id ?? project.json?.id
  expect(projectId, `no project: ${JSON.stringify(project.json)}`).toBeTruthy()

  const message = `hello from the working-set dock e2e ${stamp}`
  const posted = await api(page, "POST", "/api/chat-messages", {
    sessionId,
    role: "user",
    content: message,
  })
  expect(
    posted.status,
    `message failed: ${JSON.stringify(posted.json)}`,
  ).toBeLessThan(300)

  return {
    workspaceId: workspaceId!,
    sessionId: sessionId!,
    projectId: projectId!,
    projectName,
    message,
  }
}

async function attach(page: Page, fixture: Fixture): Promise<void> {
  const res = await api(
    page,
    "POST",
    `/api/workspaces/${fixture.workspaceId}/sessions/${fixture.sessionId}/projects`,
    { projectId: fixture.projectId, attachMode: "readwrite" },
  )
  expect(res.status, `attach failed: ${JSON.stringify(res.json)}`).toBeLessThan(300)
}

/** Workspace delete is a true wipe (rows, runtimes, project directories). */
async function dropFixture(page: Page, fixture: Fixture): Promise<void> {
  await api(page, "DELETE", `/api/projects/${fixture.projectId}`).catch(() => {})
  await api(page, "DELETE", `/api/workspaces/${fixture.workspaceId}`).catch(() => {})
}

function composer(page: Page) {
  return page
    .getByRole("textbox", { name: "Chat message input" })
    .filter({ visible: true })
    .first()
}

async function openChat(page: Page, fixture: Fixture): Promise<void> {
  await page.goto(`/?chatSessionId=${fixture.sessionId}`)
  await composer(page).waitFor({ state: "visible", timeout: 120_000 })
  await messageNode(page, fixture).waitFor({ state: "visible", timeout: 60_000 })
}

/** The seeded message in the transcript (unique text, so exactly one row). */
function messageNode(page: Page, fixture: Fixture) {
  return page.getByText(fixture.message).first()
}

/** Where the chat's first message starts, in viewport pixels. */
async function messageY(page: Page, fixture: Fixture): Promise<number> {
  const box = await messageNode(page, fixture).boundingBox()
  expect(box, "the seeded message has no box").not.toBeNull()
  return box!.y
}

/**
 * The dock header for *this* project: the collapsed panel whose summary is the
 * focused project's name.
 *
 * Both qualifiers are load-bearing. `name: "Working set"` is matched exactly,
 * or the sidebar's own "E2E working set …" workspace button matches the
 * substring; and on a wide screen more than one `ChatPanel` is mounted (hidden
 * siblings for restored chats), so the first "Working set" button on the page
 * is not necessarily the visible one.
 */
function workingSetHeaderFor(page: Page, fixture: Fixture) {
  return page
    .getByRole("button", { name: "Working set", exact: true })
    .filter({ has: page.getByText(fixture.projectName, { exact: true }) })
    .first()
}

function chip(page: Page, fixture: Fixture) {
  return page.getByLabel(`${fixture.projectName} project`).first()
}

test.describe("workspace agent chat, phone", () => {
  test.use({ viewport: { width: 390, height: 844 } })

  let fixture: Fixture
  let page: Page

  test.beforeEach(async ({ browser }) => {
    page = await browser.newPage()
    await ignoreDevErrorToast(page)
    await signInByApi(page)
    fixture = await seedChat(page)
  })

  test.afterEach(async () => {
    if (fixture) await dropFixture(page, fixture)
    await page.close()
  })

  test("the working set is a dock panel and adds no padding above the transcript", async () => {
    // 1. With the project attached: the panel is in the dock, below the message.
    await attach(page, fixture)
    await openChat(page, fixture)

    const header = workingSetHeaderFor(page, fixture)
    // Visible *and* carrying the focused project's name in its collapsed
    // summary; the chip strip stays hidden until it expands (next test).
    await expect(header).toBeVisible()
    await expect(chip(page, fixture)).toHaveCount(0)

    const attachedY = await messageY(page, fixture)
    const headerBox = await header.boundingBox()
    expect(headerBox, "the dock header has no box").not.toBeNull()
    // The dock sits above the composer at the bottom of the screen: its header
    // is *below* the message, so nothing was inserted between the header and the
    // transcript.
    expect(headerBox!.y).toBeGreaterThan(attachedY)

    // 2. Detach it and reload: the panel goes away and the message does not
    //    move. (The scope sheet's own Detach would be a nicer path, but its
    //    modal locks the page scroll while it is open and shifts the transcript
    //    ~10 px, which would be measured as the thing under test.)
    const detached = await api(
      page,
      "DELETE",
      `/api/workspaces/${fixture.workspaceId}/sessions/${fixture.sessionId}/projects/${fixture.projectId}`,
    )
    expect(
      detached.status,
      `detach failed: ${JSON.stringify(detached.json)}`,
    ).toBeLessThan(300)
    await page.reload()
    await composer(page).waitFor({ state: "visible", timeout: 120_000 })
    await messageNode(page, fixture).waitFor({ state: "visible", timeout: 60_000 })

    await expect(workingSetHeaderFor(page, fixture)).toHaveCount(0)
    const detachedY = await messageY(page, fixture)

    // The regression: on `origin/main` the attached case paid `insets.top + 112`
    // plus the row itself, so this delta was ~160 px. Two separate loads still
    // land within a few px of each other (measured 0–5 px across runs and
    // runners); the bug this pins is an order of magnitude bigger than that.
    expect(Math.abs(attachedY - detachedY)).toBeLessThanOrEqual(12)
  })

  test("expanding the panel lists the project and Manage opens the scope sheet", async () => {
    await attach(page, fixture)
    await openChat(page, fixture)

    const header = workingSetHeaderFor(page, fixture)
    await expect(header).toBeVisible()
    await header.click()

    // One chip per attached project, wrapping inside the dock.
    await expect(chip(page, fixture)).toBeVisible()

    // The scope sheet is one tap away from the collapsed header too.
    await page.getByLabel("Manage project scope").first().click()
    await expect(page.getByText("Project scope").first()).toBeVisible()
  })

  test("a chip on the phone opens the project page, not a pane", async () => {
    await attach(page, fixture)
    await openChat(page, fixture)

    await workingSetHeaderFor(page, fixture).click()
    await chip(page, fixture).click()

    await page.waitForURL(new RegExp(`/projects/${fixture.projectId}`), {
      timeout: 60_000,
    })
    expect(page.url()).toContain(`chatSessionId=${fixture.sessionId}`)
  })
})

test.describe("workspace agent chat, desktop", () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  let fixture: Fixture
  let page: Page

  test.beforeEach(async ({ browser }) => {
    page = await browser.newPage()
    await ignoreDevErrorToast(page)
    await signInByApi(page)
    fixture = await seedChat(page)
  })

  test.afterEach(async () => {
    if (fixture) await dropFixture(page, fixture)
    await page.close()
  })

  test("the panel is in the dock and a chip opens the project beside the chat", async () => {
    await attach(page, fixture)
    await openChat(page, fixture)

    const header = workingSetHeaderFor(page, fixture)
    // Same shape as the phone case: the collapsed header carries the project's
    // name, and it sits below the transcript's first message.
    await expect(header).toBeVisible()
    expect((await header.boundingBox())!.y).toBeGreaterThan(
      await messageY(page, fixture),
    )

    await header.click()
    const alpha = chip(page, fixture)
    await expect(alpha).toBeVisible()

    // A side-pane press opens the project beside the chat: the pane appears and
    // the chat itself stays put (no route change).
    await alpha.click()
    await expect(page.getByTestId("project-side-pane").first()).toBeVisible({
      timeout: 60_000,
    })
    expect(page.url()).not.toContain(`/projects/${fixture.projectId}`)
    // The chip follows the pane it opened (AC3's `aria-selected`).
    await expect(alpha).toHaveAttribute("aria-selected", "true")

    // A second press on the same chip puts the pane away — and the chip goes
    // back to unselected, which is only true if the dock re-rendered the panel
    // body: its `render` closure is the one that decides both.
    await alpha.click()
    await expect(page.getByTestId("project-side-pane")).toHaveCount(0)
    await expect(alpha).toHaveAttribute("aria-selected", "false")

    // And it can open it again, so the chip is not left holding a stale handler.
    await alpha.click()
    await expect(page.getByTestId("project-side-pane").first()).toBeVisible({
      timeout: 60_000,
    })
  })
})
