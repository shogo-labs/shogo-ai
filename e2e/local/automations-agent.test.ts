// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * "When someone joins, welcome them in a channel": a member.joined trigger
 * whose agent posts the welcome, seen in the team chat UI. The trigger is
 * created through the same route `trigger_create` calls (the tool path itself
 * is covered by e2e/events/trigger-tools.integration.test.ts), and the join is
 * simulated with the trigger's test event, since the local stack has a single
 * signed-in user.
 *
 * Trigger agents are scripted (SHOGO_EVENT_AGENT_SCRIPT, local mode only):
 * this spec writes the script file and the API re-reads it on every run.
 */
import { mkdirSync, writeFileSync } from "fs"
import { dirname, resolve } from "path"
import { expect, test, type Page } from "@playwright/test"
import { LOCAL_API_BASE, openTeamHome } from "./helpers"

const SCRIPT_PATH =
  process.env.SHOGO_EVENT_AGENT_SCRIPT || resolve(__dirname, "../../test-results/event-agents.script.json")

const suffix = Date.now().toString(36)
const TRIGGER = `Welcome newcomers ${suffix}`
const CHANNEL = `welcome-${suffix}`

function writeScript() {
  mkdirSync(dirname(SCRIPT_PATH), { recursive: true })
  writeFileSync(
    SCRIPT_PATH,
    JSON.stringify({
      triggers: {
        [TRIGGER]: [{
          when: "^member\\.joined$",
          actions: [{
            tool: "team_chat_post",
            args: { channel: CHANNEL, text: "Everyone, please welcome {{payload.member.name}} to the team!" },
          }],
          reply: "Posted a welcome for {{payload.member.name}}.",
        }],
      },
    }),
  )
}

async function apiJson(page: Page, method: string, path: string, body?: unknown) {
  const res = await page.request.fetch(`${LOCAL_API_BASE}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    data: body ? JSON.stringify(body) : undefined,
  })
  return { status: res.status(), json: await res.json().catch(() => null) }
}

test.describe("Automations: welcome new members", () => {
  test.describe.configure({ mode: "serial" })

  let page: Page
  let workspaceId: string
  let channelId: string
  let triggerId: string
  let userId: string

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(120_000)
    writeScript()
    page = await browser.newPage()
    await page.setViewportSize({ width: 1440, height: 900 })
    await openTeamHome(page)

    const workspaces = await apiJson(page, "GET", "/api/workspaces")
    const rows = (workspaces.json?.items ?? workspaces.json?.data?.items ?? []) as Array<{ id: string; kind?: string }>
    workspaceId = rows.find((w) => w.kind !== "personal")?.id as string
    expect(workspaceId, JSON.stringify(workspaces.json)).toBeTruthy()

    const session = await (await page.request.get(`${LOCAL_API_BASE}/api/auth/get-session`)).json().catch(() => null)
    userId = session?.user?.id
    expect(userId).toBeTruthy()

    const channel = await apiJson(page, "POST", `/api/workspaces/${workspaceId}/conversations`, { name: CHANNEL, kind: "public" })
    channelId = channel.json?.conversation?.id
    expect(channelId, JSON.stringify(channel.json)).toBeTruthy()
  })

  test.afterAll(async () => {
    if (triggerId) await apiJson(page, "DELETE", `/api/workspaces/${workspaceId}/triggers/${triggerId}`).catch(() => {})
    await page?.close()
  })

  test("the trigger is created and listed", async () => {
    const created = await apiJson(page, "POST", `/api/workspaces/${workspaceId}/triggers`, {
      name: TRIGGER,
      eventType: "member.joined",
      prompt: `Welcome the new member in #${CHANNEL}.`,
      notifyConversationId: CHANNEL,
    })
    expect(created.status, JSON.stringify(created.json)).toBe(201)
    triggerId = created.json.trigger.id

    const listed = await apiJson(page, "GET", `/api/workspaces/${workspaceId}/triggers`)
    expect(listed.json.triggers.map((t: any) => t.name)).toContain(TRIGGER)
  })

  test("a join posts the agent's welcome in the channel", async () => {
    const fired = await apiJson(page, "POST", `/api/workspaces/${workspaceId}/triggers/${triggerId}/test`, {
      payload: { member: { userId, name: "Riley Newcomer", role: "member" }, source: "invite_link" },
    })
    expect(fired.status, JSON.stringify(fired.json)).toBe(202)

    await page.goto(`/c/${channelId}`)
    await expect(page.getByText("please welcome Riley Newcomer to the team", { exact: false })).toBeVisible({ timeout: 45_000 })
    await expect(page.getByText("Posted a welcome for Riley Newcomer", { exact: false })).toBeVisible({ timeout: 30_000 })

    await expect(async () => {
      const deliveries = await apiJson(page, "GET", `/api/workspaces/${workspaceId}/triggers/${triggerId}/deliveries`)
      expect(deliveries.json?.deliveries?.[0]?.status).toBe("ok")
    }).toPass({ timeout: 15_000 })
  })
})
