// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Desktop signed in to Shogo Cloud works in the user's cloud workspaces live,
 * like the Slack desktop app: their cloud workspaces (Personal, shared with
 * mobile, and team) are listed next to the local ones, tagged Local/Cloud,
 * with typing and presence.
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
 * The cloud side is driven through its real sign-up, invite and
 * device-approval routes; the desktop is signed in with the keys that
 * approval hands out. A second cloud user (the teammate) watches from a
 * browser page on the cloud origin with its own team chat socket.
 */
import { expect, request, test, type APIRequestContext, type Browser, type Locator, type Page } from "@playwright/test"
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

async function cloudUser(name: string): Promise<{ api: APIRequestContext; id: string }> {
  const api = await request.newContext({ baseURL: CLOUD, extraHTTPHeaders: { origin: CLOUD! } })
  const signUp = await json(
    await api.post("/api/auth/sign-up/email", {
      data: { email: `${name.toLowerCase()}-${suffix}@example.com`, password: "Passw0rd!long-enough", name },
    }),
  )
  expect(signUp.status, JSON.stringify(signUp.body)).toBe(200)
  return { api, id: signUp.body.user.id }
}

/** The teammate's own team chat socket, held open in a page on the cloud origin. */
async function teammateSocket(browser: Browser, api: APIRequestContext, workspaceId: string) {
  const context = await browser.newContext({ storageState: await api.storageState() })
  const page = await context.newPage()
  await page.goto(`${CLOUD}/api/health`)
  await page.evaluate((url) => {
    const w = window as any
    w.frames_ = []
    w.sock = new WebSocket(url)
    w.sock.onmessage = (ev: MessageEvent) => w.frames_.push(JSON.parse(ev.data))
    return new Promise((resolve) => (w.sock.onopen = resolve))
  }, `${CLOUD!.replace(/^http/, "ws")}/api/workspaces/${workspaceId}/rt`)
  return {
    frames: () => page.evaluate(() => (window as any).frames_ as any[]),
    send: (frame: unknown) => page.evaluate((f) => (window as any).sock.send(JSON.stringify(f)), frame),
    close: () => context.close(),
  }
}

test.describe("Desktop + Shogo Cloud workspaces", () => {
  test.describe.configure({ mode: "serial" })

  let page: Page
  let owner: { api: APIRequestContext; id: string }
  let teammate: { api: APIRequestContext; id: string }
  let personal: { id: string; name: string }
  let team: { id: string; name: string }
  let teamKey: string
  let generalId: string
  let localPersonalName: string

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(180_000)
    owner = await cloudUser("CloudRuss")
    const workspaces = (await json(await owner.api.get("/api/workspaces"))).body.items as Array<{ id: string; name: string; kind: string }>
    personal = workspaces.find((w) => w.kind === "personal")!
    team = workspaces.find((w) => w.kind === "team")!

    teammate = await cloudUser("Teammate")
    const link = await json(await owner.api.post("/api/invite-links", { data: { workspaceId: team.id } }))
    expect(link.status, JSON.stringify(link.body)).toBe(200)
    const accepted = await json(await teammate.api.post(`/api/invite-links/${link.body.data.token}/accept`))
    expect(accepted.status, JSON.stringify(accepted.body)).toBeLessThan(300)

    const start = (await json(
      await owner.api.post("/api/cli/login/start", {
        data: { deviceId: `e2e-desktop-${suffix}`, deviceName: "E2E Desktop", devicePlatform: "darwin-arm64", clientHint: "desktop" },
      }),
    )).body
    const approve = await json(
      await owner.api.post("/api/cli/login/approve", { data: { state: start.state, workspaceId: personal.id, allWorkspaces: true } }),
    )
    expect(approve.status, JSON.stringify(approve.body)).toBe(200)
    const poll = (await json(await owner.api.get(`/api/cli/login/poll?state=${start.state}`))).body
    expect(poll.workspaces.map((w: any) => [w.workspace.id, w.workspace.kind])).toEqual([
      [personal.id, "personal"],
      [team.id, "team"],
    ])
    teamKey = poll.workspaces[1].key

    const channels = (await json(
      await owner.api.get(`/api/workspaces/${team.id}/conversations`, { headers: { authorization: `Bearer ${teamKey}` } }),
    )).body.conversations as Array<{ id: string; slug: string }>
    generalId = channels.find((c) => c.slug === "general")!.id

    page = await browser.newPage()
    await page.setViewportSize({ width: 1440, height: 900 })
    await openTeamHome(page)

    // Sit in the local Personal workspace before signing in.
    const local = await page.evaluate(async (apiBase) => {
      const res = await fetch(`${apiBase}/api/workspaces`, { credentials: "include" })
      return ((await res.json()).items as Array<{ id: string; name: string; kind: string }>).find((w) => w.kind === "personal")!
    }, LOCAL_API_BASE)
    localPersonalName = local.name
    await page.evaluate((id) => {
      localStorage.setItem("shogo:active-workspace-id", id)
      localStorage.setItem("shogo:active-workspace-kind", JSON.stringify({ id, kind: "personal" }))
    }, local.id)

    const signIn = await json(
      await page.request.put(`${LOCAL_API_BASE}/api/local/shogo-key`, { data: { key: poll.key, workspaces: poll.workspaces } }),
    )
    expect(signIn.status, JSON.stringify(signIn.body)).toBe(200)
  })

  test.afterAll(async () => {
    await page?.request.delete(`${LOCAL_API_BASE}/api/local/shogo-key`).catch(() => {})
    await page?.evaluate(() => {
      localStorage.removeItem("shogo:cloud-workspaces")
      localStorage.removeItem("shogo:active-workspace-id")
      localStorage.removeItem("shogo:active-workspace-kind")
    }).catch(() => {})
    await page?.close()
    await owner?.api.dispose()
    await teammate?.api.dispose()
  })

  test("signing in keeps the local Personal active; the cloud Personal is shared with the web and mobile apps", async () => {
    await page.goto("/")
    await expect.poll(() => page.evaluate(() => localStorage.getItem("shogo:cloud-workspaces")), { timeout: 20_000 }).toContain(personal.id)
    expect(await page.evaluate(() => localStorage.getItem("shogo:active-workspace-id"))).not.toBe(personal.id)

    // Something made on the web/mobile side shows up on the desktop.
    const created = await json(
      await owner.api.post("/api/projects", {
        data: { name: `From mobile ${suffix}`, workspaceId: personal.id, createdBy: owner.id, tier: "starter", status: "draft", accessLevel: "anyone", schemas: [] },
      }),
    )
    expect(created.status, JSON.stringify(created.body)).toBeLessThan(300)
    const names = await page.evaluate(async ({ apiBase, id }) => {
      const res = await fetch(`${apiBase}/api/projects?workspaceId=${id}`, { credentials: "include" })
      const body = await res.json()
      return ((body.items ?? body.data?.items ?? []) as Array<{ name: string }>).map((p) => p.name)
    }, { apiBase: LOCAL_API_BASE, id: personal.id })
    expect(names).toContain(`From mobile ${suffix}`)
  })

  test("the switcher shows local and cloud workspaces side by side, tagged Local and Cloud", async () => {
    await page.goto("/")
    await openSwitcher(page)
    const rows = page.getByText("All workspaces").locator("..")
    await expect(rows.getByText(personal.name, { exact: true })).toBeVisible({ timeout: 15_000 })
    await expect(rows.getByText(team.name, { exact: true })).toBeVisible()
    await expect(rows.getByText(localPersonalName, { exact: true }).first()).toBeVisible()
    await expect(rows.getByText("Cloud", { exact: true })).toHaveCount(2)
    await expect(rows.getByText("Local", { exact: true }).first()).toBeVisible()
    await expect(rows.getByText(/@example\.com$/)).toBeVisible()
    await expect(rows.getByLabel("Sign out of Shogo Cloud")).toBeVisible()

    await Promise.all([page.waitForEvent("load", { timeout: 30_000 }), rows.getByText(team.name, { exact: true }).click()])
    await openSwitcher(page)
    await expect(page.getByText("Manage in Shogo Cloud")).toBeVisible()
    await page.keyboard.press("Escape")
  })

  test("messages go both ways, as the cloud user", async ({ browser }) => {
    const mate = await teammateSocket(browser, teammate.api, team.id)
    try {
      await page.goto(`/c/${generalId}`)
      const composer = page.getByLabel("Message", { exact: true }).first()
      await composer.waitFor({ state: "visible", timeout: 30_000 })
      const text = `hello from the desktop ${suffix}`
      await composer.click()
      await composer.pressSequentially(text)
      await page.keyboard.press("Enter")
      await expect(async () => {
        const res = await json(await teammate.api.get(`/api/conversations/${generalId}/messages`))
        expect((res.body?.messages ?? []).find((m: any) => m.text === text)?.authorUserId).toBe(owner.id)
      }).toPass({ timeout: 15_000 })

      // Through the desktop, the same message is authored by the local account.
      const seen = await page.evaluate(async ({ apiBase, conversationId, text }) => {
        const session = await (await fetch(`${apiBase}/api/auth/get-session`, { credentials: "include" })).json()
        const res = await fetch(`${apiBase}/api/conversations/${conversationId}/messages`, { credentials: "include" })
        const author = ((await res.json()).messages ?? []).find((m: any) => m.text === text)?.authorUserId
        return { localId: session?.user?.id, author }
      }, { apiBase: LOCAL_API_BASE, conversationId: generalId, text })
      expect(seen.localId).toBeTruthy()
      expect(seen.author).toBe(seen.localId)

      const reply = `hello from the cloud ${suffix}`
      const posted = await json(
        await teammate.api.post(`/api/conversations/${generalId}/messages`, { data: { text: reply, clientMsgId: `cloud-${suffix}` } }),
      )
      expect(posted.status, JSON.stringify(posted.body)).toBeLessThan(300)
      await expect(page.getByText(reply, { exact: true })).toBeVisible({ timeout: 15_000 })
    } finally {
      await mate.close()
    }
  })

  test("typing and presence work in the cloud workspace", async ({ browser }) => {
    const mate = await teammateSocket(browser, teammate.api, team.id)
    try {
      await page.goto(`/c/${generalId}`)
      const composer = page.getByLabel("Message", { exact: true }).first()
      await composer.waitFor({ state: "visible", timeout: 30_000 })

      // The desktop is online in the cloud workspace.
      await expect(async () => {
        const res = await json(await teammate.api.get(`/api/workspaces/${team.id}/presence?userIds=${owner.id}`))
        expect(res.body?.presence?.[owner.id]).toBe("active")
      }).toPass({ timeout: 15_000 })

      // Both authors in #general (the desktop user and the teammate) show as online.
      const online = page.getByTestId("presence-active")
      await expect(online).toHaveCount(2, { timeout: 15_000 })

      // Desktop typing reaches the teammate.
      await composer.click()
      await composer.pressSequentially("thinking about it")
      await expect(async () => {
        const frames = await mate.frames()
        expect(frames.some((f) => f.type === "typing" && f.userId === owner.id && f.conversationId === generalId)).toBe(true)
      }).toPass({ timeout: 10_000 })

      // Teammate typing shows on the desktop.
      await expect(async () => {
        await mate.send({ type: "typing", conversationId: generalId })
        await expect(page.getByText("Teammate is typing", { exact: false })).toBeVisible({ timeout: 2_500 })
      }).toPass({ timeout: 15_000 })

      // The teammate going offline clears their dot live.
      await mate.close()
      await expect(online).toHaveCount(1, { timeout: 15_000 })
    } finally {
      await mate.close()
    }
  })
})
