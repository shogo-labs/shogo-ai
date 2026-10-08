// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { test, expect, type APIRequestContext } from "./fixtures"

/**
 * Composio triggers against real Composio and GitHub: create a GitHub "issue
 * added" trigger, open an issue on a test repo, wait for the delivery, then
 * delete the trigger and check Composio no longer has it.
 *
 * Needs a pre-provisioned staging user whose workspace has GitHub connected
 * through Composio:
 *   E2E_COMPOSIO_SHOGO_API_KEY    Shogo API key for that user
 *   E2E_COMPOSIO_WORKSPACE_ID     the workspace
 *   E2E_COMPOSIO_GITHUB_ENTITY    its Composio entity (shogo_<user>_<workspace>)
 *   E2E_GITHUB_TEST_REPO          owner/repo the connected account can see
 *   E2E_GITHUB_TOKEN              token that can open/close issues there
 *   COMPOSIO_API_KEY              optional: also checks listActive is clean
 *
 * The staging API must have COMPOSIO_WEBHOOK_SECRET set and the Composio
 * project's webhook URL pointing at <API>/api/webhooks/composio
 * (check with scripts/composio-trigger-webhook-check.ts).
 *
 * Run: bun run test:e2e:staging:composio-triggers
 */

const API = (process.env.E2E_API_URL || process.env.STAGING_API_URL || "https://studio-staging.shogo.ai").replace(/\/+$/, "")
const KEY = process.env.E2E_COMPOSIO_SHOGO_API_KEY
const WORKSPACE = process.env.E2E_COMPOSIO_WORKSPACE_ID
const ENTITY = process.env.E2E_COMPOSIO_GITHUB_ENTITY
const REPO = process.env.E2E_GITHUB_TEST_REPO
const GH_TOKEN = process.env.E2E_GITHUB_TOKEN
const configured = !!(KEY && WORKSPACE && ENTITY && REPO && GH_TOKEN)

async function shogo(request: APIRequestContext, method: string, path: string, body?: unknown) {
  const res = await request.fetch(`${API}/api${path}`, {
    method,
    headers: { authorization: `Bearer ${KEY}`, ...(body ? { "content-type": "application/json" } : {}) },
    data: body ? JSON.stringify(body) : undefined,
  })
  return { status: res.status(), json: await res.json().catch(() => null) as any }
}

async function github(request: APIRequestContext, method: string, path: string, body?: unknown) {
  const res = await request.fetch(`https://api.github.com${path}`, {
    method,
    headers: { authorization: `Bearer ${GH_TOKEN}`, accept: "application/vnd.github+json", ...(body ? { "content-type": "application/json" } : {}) },
    data: body ? JSON.stringify(body) : undefined,
  })
  return { status: res.status(), json: await res.json().catch(() => null) as any }
}

test.describe("Composio triggers (real Composio)", () => {
  test.skip(!configured, "E2E_COMPOSIO_* / E2E_GITHUB_* not set")
  test.describe.configure({ mode: "serial" })

  const [owner, repo] = (REPO ?? "/").split("/")
  const title = `Shogo trigger e2e ${Date.now().toString(36)}`
  let trigger: any
  let issueNumber: number | undefined

  test.afterAll(async ({ request }) => {
    if (trigger) await shogo(request, "DELETE", `/workspaces/${WORKSPACE}/triggers/${trigger.id}`).catch(() => {})
    if (issueNumber) await github(request, "PATCH", `/repos/${owner}/${repo}/issues/${issueNumber}`, { state: "closed" }).catch(() => {})
  })

  test("GitHub issue triggers are offered for the connected account", async ({ request }) => {
    const types = await shogo(request, "GET", `/workspaces/${WORKSPACE}/trigger-types?toolkit=github`)
    expect(types.status).toBe(200)
    expect(types.json.composio.available).toBe(true)
    expect(types.json.composio.types.map((t: any) => t.slug)).toContain("GITHUB_ISSUE_ADDED_EVENT")
  })

  test("a new issue is delivered to the trigger", async ({ request }) => {
    test.setTimeout(240_000)
    const created = await shogo(request, "POST", `/workspaces/${WORKSPACE}/triggers`, {
      name: `E2E issue trigger ${title}`,
      eventType: "composio.github.GITHUB_ISSUE_ADDED_EVENT",
      prompt: "Reply with one sentence naming the new issue's title. Do not take any other action.",
      triggerConfig: { owner, repo },
    })
    expect(created.status, JSON.stringify(created.json)).toBe(201)
    trigger = created.json.trigger
    expect(trigger.composioEntityId).toBe(ENTITY)
    expect(trigger.composioTriggerId).toBeTruthy()

    const issue = await github(request, "POST", `/repos/${owner}/${repo}/issues`, { title, body: "Opened by the Shogo trigger e2e test." })
    expect(issue.status).toBe(201)
    issueNumber = issue.json.number

    await expect(async () => {
      const res = await shogo(request, "GET", `/workspaces/${WORKSPACE}/triggers/${trigger.id}/deliveries`)
      const delivery = res.json?.deliveries?.[0]
      expect(delivery?.event?.type).toBe("composio.github.GITHUB_ISSUE_ADDED_EVENT")
      expect(["ok", "running"]).toContain(delivery?.status)
    }).toPass({ timeout: 120_000, intervals: [5_000] })
  })

  test("deleting the trigger removes it from Composio", async ({ request }) => {
    const triggerId = trigger.composioTriggerId
    const deleted = await shogo(request, "DELETE", `/workspaces/${WORKSPACE}/triggers/${trigger.id}`)
    expect(deleted.status).toBe(200)
    const listed = await shogo(request, "GET", `/workspaces/${WORKSPACE}/triggers`)
    expect(listed.json.triggers.map((t: any) => t.id)).not.toContain(trigger.id)
    trigger = null

    if (process.env.COMPOSIO_API_KEY) {
      const { Composio } = await import("@composio/core")
      const composio: any = new Composio({ apiKey: process.env.COMPOSIO_API_KEY })
      const active = await composio.triggers.listActive({ triggerIds: [triggerId], showDisabled: true })
      expect(active.items ?? []).toHaveLength(0)
    }
  })
})
