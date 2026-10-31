// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-266 — the screen a lifecycle notification opens suggests the next step.
 *
 * A build-ready / credits-reset push lands the person on the project's most
 * recently active chat. That first screen now shows a "Continue <project>" chip
 * carrying the one thing the last assistant turn left open, and tapping it
 * stages that line in the composer instead of sending it.
 *
 * The arrival is driven the way a person arrives: a notification in the inbox
 * whose `actionUrl` names the project and `?fromLifecycle=…`, tapped — which is
 * `notifications.tsx` doing `router.push(actionUrl)`, the same in-app push the
 * push-notification click router performs on native. A cold `page.goto` with
 * the query cannot stand in for it: Expo Router rewrites the URL to the matched
 * route's params on first paint and drops anything else.
 *
 * The project, its pinned (canonical) chat, that chat's messages and the
 * notification all go through `/api/*`; only the project runtime URL is stubbed,
 * because a local stack has no built runtime template. Runs in the
 * `iphone-15-pro` and `pixel-7` projects (see playwright.config.ts).
 *
 *   E2E_LOCAL_START_STACK=1 npx playwright test --config e2e/local/playwright.config.ts phone-continue-chip
 */
import { expect, test, type Page } from "@playwright/test"
import { signIn } from "./team-nav-seed"
import { ignoreDevErrorToast } from "./helpers"

const API = process.env.E2E_API_URL || "http://localhost:8002"
/** Mirrors `appBaseUrl()` in the API: the origin it writes into `actionUrl`. */
const APP_URL = process.env.APP_URL || "https://app.shogo.ai"

const QUESTION = "Want me to wire up the pricing page next?"
const PLAIN = "The build finished and the preview is live."

let workspaceId = ""
let userId = ""
/** A project whose canonical chat ends on a question. */
let questionProjectId = ""
let questionProjectName = ""
/** A project whose canonical chat ends on a plain statement. */
let plainProjectId = ""
/** The chat each seeded project's row names, as the API's metadata does. */
const sessionByProject = new Map<string, string>()

async function apiJson(page: Page, method: string, path: string, body?: unknown) {
  const res = await page.request.fetch(`${API}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    data: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let json: any = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    json = { raw: text }
  }
  return { status: res.status(), json }
}

/**
 * A project runtime needs the built runtime template, which the local stack
 * does not have: without this the page sits on "Starting your project…" and no
 * chat panel renders. The chat itself still goes to the real API.
 */
async function stubProjectRuntime(page: Page) {
  await page.route("**/api/projects/*/sandbox/url", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ready: true,
        status: "running",
        agentUrl: `${API}/stub-agent`,
        url: `${API}/stub-preview`,
        canvasBaseUrl: `${API}/stub-preview`,
      }),
    })
  })
  await page.route("**/api/projects/*/agent-proxy/**", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "{}" }),
  )
}

/**
 * Seed a project whose canonical chat ends with `reply`.
 *
 * The pinned workspace session is what the project screen opens (SHO-174 is why
 * a cold `?chatSessionId=` does not), so the turn is seeded into *that* chat —
 * exactly the transcript a lifecycle notification lands on.
 */
async function seedProject(page: Page, name: string, reply: string): Promise<string> {
  const project = await apiJson(page, "POST", "/api/projects", {
    name,
    workspaceId,
    tier: "starter",
    status: "draft",
    accessLevel: "anyone",
    schemas: [],
    settings: JSON.stringify({ activeMode: "canvas", techStackId: "react-app" }),
  })
  const projectId = project.json?.data?.id ?? project.json?.id
  expect(projectId, JSON.stringify(project.json)).toBeTruthy()

  const pinned = await apiJson(page, "POST", `/api/local/projects/${projectId}/workspace-session`)
  const sessionId = pinned.json?.session?.id
  expect(sessionId, JSON.stringify(pinned.json)).toBeTruthy()
  sessionByProject.set(projectId, sessionId)

  for (const [role, content] of [
    ["user", "Build me a landing page"],
    ["assistant", reply],
  ] as const) {
    const seeded = await apiJson(page, "POST", "/api/chat-messages", {
      sessionId,
      role,
      content,
      // A real turn stores UI-message parts; rows without them are legacy-only.
      parts: JSON.stringify([{ type: "text", text: content }]),
    })
    expect(seeded.status, JSON.stringify(seeded.json)).toBeLessThan(300)
  }
  return projectId
}

/** Local mode opens Personal; this is the team workspace the seeds live in. */
async function prepare(page: Page) {
  // Expo's web dev server paints an `#error-toast` above the app that swallows
  // taps (SHO-222); the production bundle does not have it.
  await ignoreDevErrorToast(page)
  await stubProjectRuntime(page)
  await signIn(page)
  await page.evaluate((id) => {
    localStorage.setItem("shogo:active-workspace-id", id)
    localStorage.setItem("shogo:active-workspace-kind", "team")
  }, workspaceId)
}

function composer(page: Page) {
  return page.getByRole("textbox", { name: "Chat message input" }).first()
}

/** Counts the turns the page sends, so "the chip does not send" is measurable. */
function trackChatSends(page: Page): string[] {
  const sends: string[] = []
  page.on("request", (request) => {
    if (request.method() !== "POST") return
    if (/\/api\/(projects|workspaces)\/[^/]+\/chat$/.test(new URL(request.url()).pathname)) {
      sends.push(request.url())
    }
  })
  return sends
}

/**
 * Arrive the way a lifecycle notification does: the row the API itself writes
 * (`apps/api/src/lib/lifecycle-notifications.ts`, SHO-258 §4), tapped.
 *
 * The row's `actionUrl` is the absolute web address the server builds
 * (`${APP_URL}/chat?project=<id>`) — a route `apps/mobile` does not have — so the
 * inbox maps `type` + `metadata.projectId` to the flagged project route. Seeding
 * that exact shape (rather than a hand-made `/projects/<id>?fromLifecycle=…`
 * link no server code writes) is what makes this spec cover the real entry.
 */
async function openArrival(
  page: Page,
  projectId: string,
  input: { type: "build_ready" | "credits_reset"; namesProject?: boolean },
) {
  const namesProject = input.namesProject !== false
  const title = `Lifecycle ${projectId.slice(0, 8)} ${input.type}`
  const created = await apiJson(page, "POST", "/api/notifications", {
    userId,
    type: input.type,
    title,
    message: "Your agent finished a turn while you were away.",
    // Exactly `projectChatUrl()`: absolute, `/chat`, and (for credits) no
    // project at all. Neither is a route the app can push, which is the point.
    actionUrl: namesProject
      ? `${APP_URL}/chat?project=${encodeURIComponent(projectId)}`
      : `${APP_URL}/chat`,
    metadata: JSON.stringify(
      namesProject
        ? { projectId, workspaceId, chatSessionId: sessionByProject.get(projectId) }
        : { workspaceId, resetAt: new Date().toISOString() },
    ),
  })
  expect(created.status, JSON.stringify(created.json)).toBeLessThan(300)

  await page.goto("/notifications")
  const row = page.getByText(title, { exact: false }).first()
  await row.waitFor({ state: "visible", timeout: 120_000 })
  await row.click()
}

test.describe("Continue <project> chip on a lifecycle arrival", () => {
  test.describe.configure({ mode: "serial" })
  test.use({ viewport: { width: 390, height: 844 } })

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(300_000)
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
    await signIn(page)

    const users = await apiJson(page, "GET", "/api/users")
    const list = users.json?.items ?? users.json?.data ?? users.json
    userId = Array.isArray(list) ? list[0]?.id : list?.items?.[0]?.id
    expect(userId, JSON.stringify(users.json)).toBeTruthy()

    const suffix = Date.now().toString(36)
    const workspace = await apiJson(page, "POST", "/api/workspaces", {
      name: `QA continue ${suffix}`,
      kind: "team",
    })
    workspaceId = workspace.json?.data?.id ?? workspace.json?.id
    expect(workspaceId, JSON.stringify(workspace.json)).toBeTruthy()

    questionProjectName = `Posts ${suffix}`
    questionProjectId = await seedProject(page, questionProjectName, `All set.\n\n${QUESTION}`)
    plainProjectId = await seedProject(page, `Plain ${suffix}`, PLAIN)
    await page.close()
  })

  test.afterAll(async ({ browser }) => {
    const page = await browser.newPage()
    for (const id of [questionProjectId, plainProjectId]) {
      if (id) await page.request.delete(`${API}/api/projects/${id}`).catch(() => {})
    }
    if (workspaceId) await page.request.delete(`${API}/api/workspaces/${workspaceId}`).catch(() => {})
    await page.close()
  })

  test("a build-ready arrival names the project and its open question, and tapping stages it", async ({
    page,
  }) => {
    const sends = trackChatSends(page)
    await prepare(page)
    await openArrival(page, questionProjectId, { type: "build_ready" })
    await composer(page).waitFor({ state: "visible", timeout: 120_000 })

    const chip = page.getByRole("button", {
      name: new RegExp(`^Continue ${questionProjectName}:`),
    })
    await expect(chip).toBeVisible({ timeout: 60_000 })
    await expect(page.getByTestId("continue-project-suggestion")).toHaveText(QUESTION)

    await chip.click()

    // Prefilled, not sent: the line is in the composer and no turn went out.
    await expect(composer(page)).toHaveValue(QUESTION, { timeout: 15_000 })
    await expect(page.getByTestId("continue-project-suggestion")).toBeHidden()
    expect(sends, "tapping the chip must not send a message").toEqual([])
  })

  test("a credits-reset row with no project still goes somewhere useful", async ({ page }) => {
    // `notifyCreditsReset` writes `metadata: {workspaceId, resetAt}` — no
    // project: the wallet that ran out need not have built anything. The row
    // therefore opens the project list (where the chip's project can be
    // picked), instead of the absolute `/chat` actionUrl that routes nowhere.
    await prepare(page)
    await openArrival(page, questionProjectId, { type: "credits_reset", namesProject: false })

    await expect(page).toHaveURL(/\/projects(\?|$)/, { timeout: 60_000 })
    await expect(page.getByTestId("continue-project-suggestion")).toBeHidden()
  })

  test("no chip when the last turn left nothing open", async ({ page }) => {
    await prepare(page)
    await openArrival(page, plainProjectId, { type: "build_ready" })
    await composer(page).waitFor({ state: "visible", timeout: 120_000 })

    await expect(page.getByText(PLAIN, { exact: false }).first()).toBeVisible({
      timeout: 60_000,
    })
    await expect(page.getByTestId("continue-project-suggestion")).toBeHidden()
  })

  test("no chip on an ordinary open of the same chat", async ({ page }) => {
    await prepare(page)
    await page.goto(`/projects/${questionProjectId}`)
    await composer(page).waitFor({ state: "visible", timeout: 120_000 })

    await expect(page.getByText(QUESTION, { exact: false }).first()).toBeVisible({
      timeout: 60_000,
    })
    await expect(page.getByTestId("continue-project-suggestion")).toBeHidden()
  })
})
