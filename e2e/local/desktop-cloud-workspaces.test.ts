// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Desktop signed in to Shogo Cloud shows the user's cloud team workspace next
 * to the local ones and works in it live, like the Slack desktop app.
 *
 * Needs a real cloud-mode API (Postgres + Redis) and a desktop API started
 * with `E2E_CLOUD_URL` (the config passes it through as SHOGO_CLOUD_URL):
 *
 *   createdb shogo_cloud_e2e && bun x prisma db push --schema=prisma/schema.prisma --url <pg-url>
 *   DATABASE_URL=<pg-url> REDIS_URL=redis://localhost:6379 BETTER_AUTH_SECRET=x \
 *     BETTER_AUTH_URL=http://localhost:8012 API_PORT=8012 bun --no-env-file apps/api/src/entry.ts
 *   E2E_CLOUD_URL=http://localhost:8012 E2E_LOCAL_START_STACK=1 \
 *     npx playwright test --config e2e/local/playwright.config.ts desktop-cloud-workspaces
 *
 * The cloud side is driven through its real sign-up and device-approval
 * routes; the desktop is signed in with the keys that approval hands out.
 */
import { expect, request, test, type APIRequestContext, type Locator, type Page } from "@playwright/test"
import { LOCAL_API_BASE, openTeamHome } from "./helpers"

const CLOUD = process.env.E2E_CLOUD_URL
const suffix = Date.now().toString(36)

test.skip(!CLOUD, "E2E_CLOUD_URL is not set")

function accountTrigger(page: Page): Locator {
  return page.getByRole("button", { name: /— open account/ })
}

async function openSwitcher(page: Page) {
  const open = () => page.getByText("All workspaces").isVisible().catch(() => false)
  const trigger = accountTrigger(page)
  await trigger.waitFor({ state: "visible", timeout: 30_000 })
  await trigger.click()
  await page.waitForTimeout(400)
  if (!(await open())) await trigger.evaluate((el: HTMLElement) => el.click())
  await expect(page.getByText("All workspaces")).toBeVisible({ timeout: 10_000 })
}

async function json(res: { json(): Promise<any>; status(): number }) {
  return { status: res.status(), body: await res.json().catch(() => null) }
}

test.describe("Desktop + Shogo Cloud workspaces", () => {
  test.describe.configure({ mode: "serial" })

  let page: Page
  let cloud: APIRequestContext
  let teamId: string
  let teamName: string
  let teamKey: string
  let cloudUserId: string
  let generalId: string

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(180_000)
    cloud = await request.newContext({ baseURL: CLOUD, extraHTTPHeaders: { origin: CLOUD! } })
    const signUp = await json(
      await cloud.post("/api/auth/sign-up/email", {
        data: { email: `desktop-e2e-${suffix}@example.com`, password: "Passw0rd!long-enough", name: "Cloud Russ" },
      }),
    )
    expect(signUp.status, JSON.stringify(signUp.body)).toBe(200)
    cloudUserId = signUp.body.user.id

    const workspaces = (await json(await cloud.get("/api/workspaces"))).body.items as Array<{ id: string; name: string; kind: string }>
    const personal = workspaces.find((w) => w.kind === "personal")!
    const team = workspaces.find((w) => w.kind === "team")!
    teamId = team.id
    teamName = team.name

    const start = (await json(
      await cloud.post("/api/cli/login/start", {
        data: { deviceId: `e2e-desktop-${suffix}`, deviceName: "E2E Desktop", devicePlatform: "darwin-arm64", clientHint: "desktop" },
      }),
    )).body
    const approve = await json(
      await cloud.post("/api/cli/login/approve", { data: { state: start.state, workspaceId: personal.id, allWorkspaces: true } }),
    )
    expect(approve.status, JSON.stringify(approve.body)).toBe(200)
    const poll = (await json(await cloud.get(`/api/cli/login/poll?state=${start.state}`))).body
    expect(poll.workspaces.map((w: any) => w.workspace.id)).toEqual([teamId])
    teamKey = poll.workspaces[0].key

    const channels = (await json(
      await cloud.get(`/api/workspaces/${teamId}/conversations`, { headers: { authorization: `Bearer ${teamKey}` } }),
    )).body.conversations as Array<{ id: string; slug: string }>
    generalId = channels.find((c) => c.slug === "general")!.id

    page = await browser.newPage()
    await page.setViewportSize({ width: 1440, height: 900 })
    await openTeamHome(page)
    const signIn = await json(
      await page.request.put(`${LOCAL_API_BASE}/api/local/shogo-key`, { data: { key: poll.key, workspaces: poll.workspaces } }),
    )
    expect(signIn.status, JSON.stringify(signIn.body)).toBe(200)
  })

  test.afterAll(async () => {
    await page?.request.delete(`${LOCAL_API_BASE}/api/local/shogo-key`).catch(() => {})
    await page?.evaluate(() => localStorage.removeItem("shogo:cloud-workspaces")).catch(() => {})
    await page?.close()
    await cloud?.dispose()
  })

  test("the switcher shows the local workspaces and the cloud team workspace", async () => {
    await page.goto("/")
    await openSwitcher(page)
    const rows = page.getByText("All workspaces").locator("..")
    await expect(rows.getByText(teamName, { exact: true })).toBeVisible({ timeout: 15_000 })
    await expect(rows.getByText("Cloud", { exact: true })).toBeVisible()
    await expect(rows.getByText("Personal", { exact: true }).first()).toBeVisible()
    await expect(rows.getByText("Team", { exact: true }).first()).toBeVisible()

    await Promise.all([page.waitForEvent("load", { timeout: 30_000 }), rows.getByText(teamName, { exact: true }).click()])
    await openSwitcher(page)
    await expect(page.getByText("Manage in Shogo Cloud")).toBeVisible()
    await page.keyboard.press("Escape")
  })

  test("a message posted on the desktop lands in the cloud, as the cloud user", async () => {
    await page.goto(`/c/${generalId}`)
    const composer = page.getByLabel("Message", { exact: true }).first()
    await composer.waitFor({ state: "visible", timeout: 30_000 })
    const text = `hello from the desktop ${suffix}`
    await composer.click()
    await composer.pressSequentially(text)
    await page.keyboard.press("Enter")

    await expect(async () => {
      const res = await json(
        await cloud.get(`/api/conversations/${generalId}/messages`, { headers: { authorization: `Bearer ${teamKey}` } }),
      )
      const mine = (res.body?.messages ?? []).find((m: any) => m.text === text)
      expect(mine?.authorUserId).toBe(cloudUserId)
    }).toPass({ timeout: 15_000 })
    // Shown as the user's own message, not someone else's.
    await expect(page.getByText(text, { exact: true })).toBeVisible()
  })

  test("a message posted in the cloud shows up live on the desktop", async () => {
    await page.goto(`/c/${generalId}`)
    await page.getByLabel("Message", { exact: true }).first().waitFor({ state: "visible", timeout: 30_000 })
    await page.waitForTimeout(1_000)
    const text = `hello from the cloud ${suffix}`
    const posted = await json(
      await cloud.post(`/api/conversations/${generalId}/messages`, {
        headers: { authorization: `Bearer ${teamKey}` },
        data: { text, clientMsgId: `cloud-${suffix}` },
      }),
    )
    expect(posted.status, JSON.stringify(posted.body)).toBeLessThan(300)
    await expect(page.getByText(text, { exact: true })).toBeVisible({ timeout: 15_000 })
  })
})
