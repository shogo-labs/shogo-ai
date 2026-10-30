// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A paired machine's workspace, opened from the cloud, shows *that machine's*
 * rows on every screen — not the cloud workspace that was selected before.
 *
 * Reported against production: with the laptop's workspace open, the projects
 * tab listed another workspace's projects, the activity panel showed another
 * workspace's activity, the chat list showed the cloud chats, and clicking an
 * agent did nothing. `machine-workspaces-live` stayed green through all of it:
 * it only looks at the home screen, which already asks for the machine's id,
 * and its relay calls the machine as the *local* user — while production's
 * relay stamps the owner's cloud account, which the machine has never heard of.
 *
 * Two seams, both real here:
 *   • every read the app makes while the machine is in view is recorded at the
 *     network, after the interceptor — a read of the machine's rows that names
 *     the cloud workspace, or a project/task list that names no workspace at
 *     all, is answered by the wrong workspace;
 *   • the relay calls the machine as a cloud user id that is not in its
 *     database, the way the cloud does.
 */
import { expect, test, type Page } from "@playwright/test"
import { shouldRouteToRemote } from "../../packages/shared-app/src/services/remote-http-interceptor"
import { LOCAL_API_BASE } from "./helpers"
import {
  MACHINE_WORKSPACE_ID,
  MACHINE_WORKSPACE_NAME,
  installCloudRelay,
  openCloudWorkspace,
  readWorkspaces,
  relayBase,
  selectMachineWorkspace,
  type CopyCall,
  type RelayCall,
} from "./machine-relay"

const MACHINE_ONLY_PROJECT = "Machine only project"
const CLOUD_ONLY_PROJECT = "Cloud only project"
/** The owner's cloud account: what the relay stamps, unknown to the machine's database. */
const CLOUD_OWNER_ID = "cloud-owner-5648b9fe"

async function seed(page: Page, cloudId: string, machineId: string): Promise<{ machineProjectId: string }> {
  return page.evaluate(
    async ({ api, cloudId, machineId, cloudName, machineName }) => {
      const put = async (workspaceId: string, name: string) => {
        const res = await fetch(`${api}/api/projects`, {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ workspaceId, name }),
        })
        const body = await res.json()
        return (body.data ?? body).id as string
      }
      await put(cloudId, cloudName)
      return { machineProjectId: await put(machineId, machineName) }
    },
    { api: LOCAL_API_BASE, cloudId, machineId, cloudName: CLOUD_ONLY_PROJECT, machineName: MACHINE_ONLY_PROJECT },
  )
}

/** Reads that went to the cloud for the machine's rows under the wrong scope. */
function misScopedReads(urls: string[], cloudWorkspaceId: string): string[] {
  return urls.filter((href) => {
    const url = new URL(href)
    if (!url.href.startsWith(LOCAL_API_BASE) || url.pathname.startsWith("/api/machines/")) return false
    const path = `${url.pathname}${url.search}`
    const machineOwned = shouldRouteToRemote(path, { machineWorkspaceId: MACHINE_WORKSPACE_ID, isRead: false })
    if (!machineOwned) return false
    if (path.includes(cloudWorkspaceId)) return true
    // A list that names no workspace is answered across every workspace the
    // cloud account can see.
    return /^\/api\/(projects|agent-tasks|folders)(\?|$)/.test(path) && !url.searchParams.has("workspaceId")
  })
}

test("a machine workspace opened from the cloud reads the machine's rows on every screen", async ({ page }) => {
  test.slow()
  const log: RelayCall[] = []
  const copies: CopyCall[] = []

  await openCloudWorkspace(page)
  const { personal, team, userId } = await readWorkspaces(page)
  await seed(page, personal.id, team.id)
  await installCloudRelay(page, { machineWorkspaceId: team.id, userId, log, copies })
  await page.reload({ waitUntil: "domcontentloaded" })
  await page.waitForTimeout(3000)

  await selectMachineWorkspace(page)
  await expect(page.getByRole("button", { name: `${MACHINE_WORKSPACE_NAME}, workspace menu` })).toBeVisible({
    timeout: 20_000,
  })

  const reads: string[] = []
  page.on("request", (request) => {
    if (request.method() === "GET") reads.push(request.url())
  })

  // The projects tab: the machine's project, and nothing of the cloud workspace's.
  await page.goto("/projects", { waitUntil: "domcontentloaded" })
  await expect(page.getByText(MACHINE_ONLY_PROJECT).first()).toBeVisible({ timeout: 60_000 })
  await expect(page.getByText(CLOUD_ONLY_PROJECT)).toHaveCount(0)

  // Activity and the agent work behind it.
  await page.goto("/activity", { waitUntil: "domcontentloaded" })
  await expect(page.getByRole("tab", { name: "Activity", selected: true })).toBeVisible({ timeout: 60_000 })
  await page.waitForTimeout(3000)

  // Back home, where the chat list loads.
  await page.goto("/", { waitUntil: "domcontentloaded" })
  await expect(page.getByRole("button", { name: `${MACHINE_WORKSPACE_NAME}, workspace menu` })).toBeVisible({
    timeout: 30_000,
  })
  await page.waitForTimeout(3000)

  expect(reads.length).toBeGreaterThan(0)
  expect(misScopedReads(reads, personal.id), "a read of the machine's rows was scoped to the cloud workspace").toEqual([])
})

test("a write relayed for the machine's cloud owner lands on the machine", async ({ page }) => {
  test.slow()
  const log: RelayCall[] = []

  await openCloudWorkspace(page)
  const { team, userId } = await readWorkspaces(page)
  const { machineProjectId } = await seed(page, team.id, team.id)
  await installCloudRelay(page, { machineWorkspaceId: team.id, userId, log, relayUserId: CLOUD_OWNER_ID })

  const post = (path: string, body: unknown) =>
    page.evaluate(
      async ({ url, body }) => {
        const res = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        })
        return { status: res.status, body: await res.json().catch(() => null) }
      },
      { url: `${relayBase()}${path}`, body },
    )

  // Clicking an agent opens its DM: a write, so it goes through the relay.
  const dm = await post(`/api/workspaces/${MACHINE_WORKSPACE_ID}/dms`, { agent: { projectId: machineProjectId } })
  expect(dm.status, JSON.stringify(dm.body).slice(0, 300)).toBe(200)
  expect(dm.body?.conversation?.id).toBeTruthy()

  const channel = await post(`/api/workspaces/${MACHINE_WORKSPACE_ID}/conversations`, {
    name: `cloud-owner-${Date.now().toString(36)}`,
    kind: "public",
  })
  expect(channel.status, JSON.stringify(channel.body).slice(0, 300)).toBe(201)
})
