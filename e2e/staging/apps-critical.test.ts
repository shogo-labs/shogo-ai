// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { test, expect, type Page } from "@playwright/test"
import { bootstrapApiBase, makeTestUser, signUpAndOnboard, type TestUser } from "./helpers"

/**
 * Workspace automations and the actions API on a fresh account: the event
 * catalog is served, a member.joined trigger runs its agent on a test event,
 * Settings → Automations lists it with its delivery, and a personal API key
 * can call /api/v1 (members.list, channels.list) but not another workspace.
 *
 * Part of the critical path (staging/critical-path.ts): a broken event worker
 * or actions API silently stops every installed app and automation.
 *
 * Run:
 *   npx playwright test --config e2e/playwright.config.ts apps-critical
 */

const USER: TestUser = makeTestUser("Apps")
const API = bootstrapApiBase().replace(/\/+$/, "")

async function api(page: Page, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await page.request.fetch(`${API}${path}`, {
    method,
    headers: { Origin: API, ...(body ? { "content-type": "application/json" } : {}), ...headers },
    data: body ? JSON.stringify(body) : undefined,
  })
  return { status: res.status(), json: (await res.json().catch(() => null)) as any }
}

test.describe("Workspace automations and apps API", () => {
  test.describe.configure({ mode: "serial" })

  let page: Page
  let workspaceId: string
  let personalWorkspaceId: string
  let triggerId: string | undefined

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(240_000)
    page = await browser.newPage()
    await page.setViewportSize({ width: 1440, height: 900 })
    await signUpAndOnboard(page, USER)
    const workspaces = await api(page, "GET", "/api/workspaces")
    const rows = (workspaces.json?.items ?? workspaces.json?.data?.items ?? []) as Array<{ id: string; kind?: string }>
    workspaceId = rows.find((w) => w.kind !== "personal")?.id as string
    personalWorkspaceId = rows.find((w) => w.kind === "personal")?.id as string
    expect(workspaceId, JSON.stringify(workspaces.json)).toBeTruthy()
  })

  test.afterAll(async () => {
    if (triggerId) await api(page, "DELETE", `/api/workspaces/${workspaceId}/triggers/${triggerId}`).catch(() => {})
    await page?.close()
  })

  test("the event catalog is served", async () => {
    const types = await api(page, "GET", `/api/workspaces/${workspaceId}/trigger-types`)
    expect(types.status, JSON.stringify(types.json)).toBe(200)
    expect(types.json.native.map((t: any) => t.type)).toContain("member.joined")
  })

  test("a member.joined trigger runs its agent on a test event", async () => {
    test.setTimeout(240_000)
    const created = await api(page, "POST", `/api/workspaces/${workspaceId}/triggers`, {
      name: "E2E welcome",
      eventType: "member.joined",
      prompt: "Reply with exactly: Welcome noted. Do not take any other action.",
    })
    expect(created.status, JSON.stringify(created.json)).toBe(201)
    triggerId = created.json.trigger.id

    const fired = await api(page, "POST", `/api/workspaces/${workspaceId}/triggers/${triggerId}/test`)
    expect(fired.status, JSON.stringify(fired.json)).toBe(202)
    await expect(async () => {
      const res = await api(page, "GET", `/api/workspaces/${workspaceId}/triggers/${triggerId}/deliveries`)
      expect(res.json?.deliveries?.[0]?.status).toBe("ok")
    }).toPass({ timeout: 180_000, intervals: [3_000] })
  })

  test("Settings → Automations lists the trigger and its delivery", async () => {
    await page.goto(`/automations?workspace=${workspaceId}`)
    await expect(page.getByTestId("automations-tab")).toBeVisible({ timeout: 30_000 })
    const row = page.getByTestId(`automation-trigger-${triggerId}`)
    await expect(row).toBeVisible()
    await row.getByText("E2E welcome").click()
    await expect(row.getByText("ok", { exact: true })).toBeVisible({ timeout: 15_000 })
  })

  test("a personal API key can call the actions API for its own workspace only", async () => {
    const minted = await api(page, "POST", "/api/api-keys", { name: "E2E actions", workspaceId })
    expect(minted.status, JSON.stringify(minted.json)).toBe(200)
    const auth = { authorization: `Bearer ${minted.json.key}` }
    try {
      const members = await api(page, "POST", "/api/v1/members.list", {}, auth)
      expect(members.status, JSON.stringify(members.json)).toBe(200)
      expect(members.json.members.some((m: any) => m.email === USER.email)).toBe(true)

      const channels = await api(page, "POST", "/api/v1/channels.list", {}, auth)
      expect(channels.status, JSON.stringify(channels.json)).toBe(200)

      if (personalWorkspaceId) {
        const other = await api(page, "POST", "/api/v1/members.list", { workspaceId: personalWorkspaceId }, auth)
        expect(other.status).toBe(403)
        expect(other.json.error).toBe("wrong_workspace")
      }

      const grants = await api(page, "GET", `/api/workspaces/${workspaceId}/app-grants`)
      expect(grants.status).toBe(200)
      expect(grants.json.grants).toEqual([])
    } finally {
      await api(page, "DELETE", `/api/api-keys/${minted.json.id}`).catch(() => {})
    }
  })
})
