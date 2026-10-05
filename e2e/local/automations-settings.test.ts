// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Settings → Automations on desktop and phone: a trigger and its delivery
 * history are listed, a delivery can be redelivered, and the switch turns the
 * trigger off. Trigger agents are scripted (SHOGO_EVENT_AGENT_SCRIPT), as in
 * automations-agent.test.ts.
 */
import { mkdirSync, readFileSync, writeFileSync } from "fs"
import { dirname, resolve } from "path"
import { expect, test, type Page } from "@playwright/test"
import { api, teamWorkspaceId } from "./team-nav-seed"

const SCRIPT_PATH =
  process.env.SHOGO_EVENT_AGENT_SCRIPT || resolve(__dirname, "../../test-results/event-agents.script.json")

const suffix = Date.now().toString(36)
const TRIGGER = `Settings welcome ${suffix}`

function writeScript() {
  mkdirSync(dirname(SCRIPT_PATH), { recursive: true })
  let current: { triggers?: Record<string, unknown> } = {}
  try {
    current = JSON.parse(readFileSync(SCRIPT_PATH, "utf8"))
  } catch {}
  const triggers = { ...current.triggers, [TRIGGER]: [{ reply: "Welcomed {{payload.member.name}}." }] }
  writeFileSync(SCRIPT_PATH, JSON.stringify({ ...current, triggers }))
}

async function latestDelivery(page: Page, workspaceId: string, triggerId: string) {
  const res = await api(page, "GET", `/api/workspaces/${workspaceId}/triggers/${triggerId}/deliveries`)
  return res.json?.deliveries?.[0]
}

for (const viewport of [
  { name: "desktop", width: 1440, height: 900 },
  { name: "phone", width: 390, height: 844 },
]) {
  test.describe(`Settings → Automations (${viewport.name})`, () => {
    test.describe.configure({ mode: "serial" })

    let page: Page
    let workspaceId: string
    let triggerId: string
    let deliveryId: string

    test.beforeAll(async ({ browser }) => {
      test.setTimeout(120_000)
      writeScript()
      page = await browser.newPage()
      await page.setViewportSize({ width: viewport.width, height: viewport.height })
      await page.goto("/")
      await expect(async () => {
        workspaceId = await teamWorkspaceId(page)
      }).toPass({ timeout: 30_000 })

      const created = await api(page, "POST", `/api/workspaces/${workspaceId}/triggers`, {
        name: `${TRIGGER}`,
        eventType: "member.joined",
        prompt: "Welcome the new member.",
      })
      expect(created.status, JSON.stringify(created.json)).toBe(201)
      triggerId = created.json.trigger.id
      const fired = await api(page, "POST", `/api/workspaces/${workspaceId}/triggers/${triggerId}/test`, {
        payload: { member: { userId: "e2e-user", name: "Riley", role: "member" }, source: "invite_link" },
      })
      expect(fired.status, JSON.stringify(fired.json)).toBe(202)
      await expect(async () => {
        const delivery = await latestDelivery(page, workspaceId, triggerId)
        expect(delivery?.status).toBe("ok")
        deliveryId = delivery.id
      }).toPass({ timeout: 45_000 })
    })

    test.afterAll(async () => {
      if (triggerId) await api(page, "DELETE", `/api/workspaces/${workspaceId}/triggers/${triggerId}`).catch(() => {})
      await page?.close()
    })

    test("the trigger and its delivery history are listed", async () => {
      await page.goto(`/automations?workspace=${workspaceId}`)
      await expect(page.getByTestId("automations-tab")).toBeVisible({ timeout: 30_000 })
      const row = page.getByTestId(`automation-trigger-${triggerId}`)
      await expect(row).toBeVisible()
      await expect(row.getByText("member.joined")).toBeVisible()
      await row.getByText(TRIGGER).click()
      await expect(row.getByTestId(`automation-delivery-${deliveryId}`)).toContainText("Welcomed Riley", { timeout: 15_000 })
    })

    test("a delivery can be redelivered", async () => {
      const row = page.getByTestId(`automation-trigger-${triggerId}`)
      await row.getByTestId(`automation-redeliver-${deliveryId}`).click()
      await expect(async () => {
        const delivery = await latestDelivery(page, workspaceId, triggerId)
        expect(delivery?.status).toBe("ok")
        expect(delivery?.attempts).toBe(1)
        expect(new Date(delivery.updatedAt).getTime()).toBeGreaterThan(new Date(delivery.createdAt).getTime())
      }).toPass({ timeout: 45_000 })
    })

    test("the switch turns the trigger off", async () => {
      const row = page.getByTestId(`automation-trigger-${triggerId}`)
      await row.getByTestId(`automation-trigger-toggle-${triggerId}`).getByRole("switch").click()
      await expect(async () => {
        const listed = await api(page, "GET", `/api/workspaces/${workspaceId}/triggers`)
        expect(listed.json.triggers.find((t: any) => t.id === triggerId)?.enabled).toBe(false)
      }).toPass({ timeout: 15_000 })
    })
  })
}
