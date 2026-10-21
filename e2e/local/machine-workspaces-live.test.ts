// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-130 — choosing a paired computer's workspace from the cloud, through the
 * UI a person actually uses.
 *
 * The bug this pins: selecting a machine workspace flashed and then stayed in
 * whatever cloud workspace was open, while the sidebar announced "Connected to
 * <machine>". The API-level specs (`machine-workspaces-tunnel`,
 * `qa-machine-*`) were all green because nothing drove the click.
 *
 * What is real here
 * - the web app (Expo web), its switcher, its chat, its routing and its chrome;
 * - the machine: this process's real local API, serving the workspace's
 *   projects, sessions, agent profile and *its own disk* through the workspace
 *   file API;
 * - every relayed call uses the cloud relay's URL shape
 *   (`/api/machines/<id>/w/<localWorkspaceId>/…`) and authenticates the way the
 *   tunnel does (`x-tunnel-auth-user-id`).
 *
 * What is stubbed
 * - only the cloud's side of the relay: `/api/machines` and the transport that
 *   forwards a relayed path to the machine. A real cloud is not reachable from
 *   an offline local run, and this is the same seam `machine-workspaces-tunnel`
 *   uses.
 * - the model. There is no LLM credential in local CI, so this spec asserts the
 *   turn at the seam that matters here — it reaches the machine carrying the
 *   machine's own workspace id. The *reply* is the other local spec,
 *   `machine-workspace-agent-turn-live.test.ts`, which runs the real agent
 *   against the scripted model and has it read a canary off the machine's disk.
 */
import { expect, test, type Page } from "@playwright/test"
import { LOCAL_API_BASE } from "./helpers"
import {
  MACHINE_ID,
  MACHINE_NAME,
  MACHINE_WORKSPACE_ID,
  MACHINE_WORKSPACE_NAME,
  installCloudRelay,
  openCloudWorkspace,
  openSwitcher,
  readWorkspaces,
  type RelayCall,
} from "./machine-relay"

const MACHINE_ONLY_PROJECT = "Machine only"
const CLOUD_ONLY_PROJECT = "Cloud only"
const CANARY = "SHO130-CANARY-8f2e1c"
/** A message written into a channel that lives on the machine. */
const CHANNEL_MESSAGE = `Still on the studio machine ${Date.now().toString(36)}`

/** Two projects of the same shape, one on either side of the machine boundary. */
async function seedProjects(page: Page, cloudId: string, machineId: string): Promise<void> {
  await page.evaluate(
    async ({ api, cloudId, machineId, cloudName, machineName }) => {
      const put = (workspaceId: string, name: string) =>
        fetch(`${api}/api/projects`, {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ workspaceId, name }),
        })
      await put(cloudId, cloudName)
      await put(machineId, machineName)
    },
    {
      api: LOCAL_API_BASE,
      cloudId,
      machineId,
      cloudName: CLOUD_ONLY_PROJECT,
      machineName: MACHINE_ONLY_PROJECT,
    },
  )
}

test("SHO-130 · a paired machine's workspace opens from the cloud, stays on reload, and leaves cleanly", async ({
  page,
}) => {
  test.slow()
  const log: RelayCall[] = []

  await openCloudWorkspace(page)
  const { personal, team, userId } = await readWorkspaces(page)
  await seedProjects(page, personal.id, team.id)
  await installCloudRelay(page, { machineWorkspaceId: team.id, userId, log })
  await page.reload({ waitUntil: "domcontentloaded" })
  await page.waitForTimeout(3000)

  // ── Before: the cloud workspace is what is on screen ──────────────────────
  await expect(page.getByRole("button", { name: /Local User Personal, .*— open account/ })).toBeVisible()
  await expect(page.getByRole("tab", { name: "Channels" })).toHaveCount(0)

  // ── AC 1 — select the machine's workspace ────────────────────────────────
  await openSwitcher(page)
  await page.getByTestId(`workspace-row:machine:${MACHINE_ID}:${MACHINE_WORKSPACE_ID}`).click()

  // Its own identity, not the cloud workspace's: "says I'm controlling that
  // workspace but it doesn't work" was exactly this split.
  // Both places that name the workspace, and they agree: the wide panel header
  // (rendered, not requested — the interceptor cannot rewrite it) and the
  // account tile.
  await expect(page.getByRole("button", { name: `${MACHINE_WORKSPACE_NAME}, workspace menu` })).toBeVisible({
    timeout: 20_000,
  })
  await expect(
    page.getByRole("button", { name: new RegExp(`^${MACHINE_WORKSPACE_NAME}, .*— open account`) }),
  ).toBeVisible()
  await expect(page.getByText(/Connected to Studio Mac/)).toBeVisible()

  // Its own kind: a team workspace gets the team shell (channels), not the
  // personal companion rail.
  await expect(page.getByRole("tab", { name: "Channels" })).toBeVisible({ timeout: 20_000 })

  // Its own row is the checked one.
  await openSwitcher(page)
  await expect(page.getByTestId(`workspace-row-check:machine:${MACHINE_ID}:${MACHINE_WORKSPACE_ID}`).first()).toBeVisible()
  await page.keyboard.press("Escape")

  // ── AC 2 — what is on screen is what is on that machine ──────────────────
  // The machine's project list came back through the relay, carrying the
  // machine's project and not the cloud workspace's look-alike.
  const projectCalls = log.filter((r) => r.path.startsWith("/api/projects"))
  expect(projectCalls.length).toBeGreaterThan(0)
  expect(projectCalls.some((r) => (r.projectNames ?? []).includes(MACHINE_ONLY_PROJECT))).toBe(true)
  expect(projectCalls.every((r) => !(r.projectNames ?? []).includes(CLOUD_ONLY_PROJECT))).toBe(true)
  // …and every workspace-scoped ask named the machine's workspace, never the
  // cloud one. (An unscoped list is the machine's own full list.)
  expect(
    projectCalls.filter((r) => r.path.includes("workspaceId=") && !r.path.includes(team.id)).map((r) => r.path),
  ).toEqual([])

  // ── AC 3 — a reload does not bounce back to the cloud ────────────────────
  await page.reload({ waitUntil: "domcontentloaded" })
  await expect(page.getByRole("button", { name: `${MACHINE_WORKSPACE_NAME}, workspace menu` })).toBeVisible({
    timeout: 30_000,
  })
  await openSwitcher(page)
  await expect(page.getByTestId(`workspace-row-check:machine:${MACHINE_ID}:${MACHINE_WORKSPACE_ID}`).first()).toBeVisible()
  await page.keyboard.press("Escape")

  // ── AC 4 — a message sent from the cloud goes to the machine ─────────────
  log.length = 0
  const composer = page.getByRole("textbox").last()
  await composer.click()
  await composer.fill("What is in this workspace?")
  await page.keyboard.press("Enter")
  await expect.poll(() => log.some((r) => r.path.includes("/chat")), { timeout: 45_000 }).toBe(true)
  // Every chat call that names a workspace names the machine's, and at least
  // one does. Calls with no workspace id in the path are the machine's by
  // construction (the relay prefix already scoped them).
  const chatCalls = log.filter((r) => r.path.includes("/chat"))
  expect(
    chatCalls.filter((r) => r.path.includes(personal.id)).map((r) => r.path),
    "a chat call still named the cloud workspace that was on screen before the switch",
  ).toEqual([])
  expect(chatCalls.some((r) => r.path.includes(team.id)), JSON.stringify(chatCalls, null, 2)).toBe(true)

  // ── AC 5 (machine side, real disk) — the cloud reads the machine's disk ──
  // Written and read through the machine's own workspace file API over the
  // relay: this is the file the staging run has the live agent read; here it
  // proves the relay reaches the machine's real disk, and only that disk.
  const relayBase = `${LOCAL_API_BASE}/api/machines/${MACHINE_ID}/w/${MACHINE_WORKSPACE_ID}`
  const fileUrl = `${relayBase}/api/workspaces/${MACHINE_WORKSPACE_ID}/agent-proxy/agent/workspace/files/.tmp/sho130-canary.txt`
  const write = async () =>
    page.evaluate(async ({ url, token }) => {
      const res = await fetch(url, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: token }),
      })
      return res.status
    }, { url: fileUrl, token: CANARY })
  // The machine's workspace runtime is prewarmed by the app itself; give it a
  // moment before asserting on the file API.
  await expect.poll(write, { timeout: 120_000, intervals: [2000] }).toBe(200)
  const readBack = await page.evaluate(async (url) => {
    const res = await fetch(url)
    return { status: res.status, body: await res.text() }
  }, fileUrl)
  expect(readBack.status).toBe(200)
  expect(readBack.body).toContain(CANARY)

  // ── AC 6 — a channel that lives on the machine ────────────────────────────
  // A channel created on the machine over the relay, then written to from the
  // UI while the machine workspace is in view: the message has to be relayed to
  // the machine and land in *its* rows, not the cloud workspace's.
  const channelName = `machine-${Date.now().toString(36)}`
  const created = await page.evaluate(
    async ({ url, name }) => {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, kind: "public" }),
      })
      return { status: res.status, body: await res.json().catch(() => null) }
    },
    { url: `${relayBase}/api/workspaces/${MACHINE_WORKSPACE_ID}/conversations`, name: channelName },
  )
  const channelId: string | undefined = created.body?.conversation?.id
  expect(created.status, JSON.stringify(created.body).slice(0, 300)).toBe(201)
  expect(channelId).toBeTruthy()

  // The row belongs to the machine's workspace; the cloud workspace has never
  // heard of it. (Both live in this dev database — the id is the boundary.)
  const cloudChannels = await page.evaluate(async ({ api, cloudId, channelId }) => {
    const list = await fetch(`${api}/api/workspaces/${cloudId}/conversations`, { credentials: "include" }).then((r) =>
      r.json(),
    )
    return (list.conversations ?? []).map((conv: { id: string }) => conv.id).includes(channelId)
  }, { api: LOCAL_API_BASE, cloudId: personal.id, channelId })
  expect(cloudChannels).toBe(false)

  log.length = 0
  await page.goto(`/c/${channelId}`, { waitUntil: "domcontentloaded" })
  const channelInput = page.getByTestId("team-composer-input").first()
  await expect(channelInput).toBeVisible({ timeout: 60_000 })
  await channelInput.click()
  await channelInput.fill(CHANNEL_MESSAGE)
  await page.keyboard.press("Enter")

  // Read back through the relay, with the tunnel's own auth header: the
  // machine's message rows carry it.
  await expect
    .poll(
      async () =>
        page.evaluate(async ({ url, channelId, userId }) => {
          const res = await fetch(`${url}/api/conversations/${channelId}/messages`, {
            headers: { "x-tunnel-auth-user-id": userId },
          })
          if (!res.ok) return `HTTP ${res.status}`
          const body = await res.json()
          return (body.messages ?? []).map((m: { text?: string }) => m.text ?? "").join("\n")
        }, { url: relayBase, channelId, userId }),
      { timeout: 30_000 },
    )
    .toContain(CHANNEL_MESSAGE)

  // …and it went over the relay, not straight to the cloud.
  expect(log.filter((r) => r.path.includes(`/api/conversations/${channelId}`)).length).toBeGreaterThan(0)

  // ── AC 3 — leaving for the cloud drops the machine entirely ──────────────
  log.length = 0
  await openSwitcher(page)
  await page.getByTestId(`workspace-row:cloud:${personal.id}`).click()
  await expect(page.getByText(/Connected to Studio Mac/)).toHaveCount(0, { timeout: 30_000 })
  await expect(page.getByRole("button", { name: /Local User Personal, .*— open account/ })).toBeVisible()
  await expect(page.getByRole("tab", { name: "Channels" })).toHaveCount(0)
  // Requests still in flight when the switch happened drain here; after that
  // nothing may keep talking to a machine that is no longer in view.
  await page.waitForTimeout(3000)
  const drained = log.length
  await page.waitForTimeout(3000)
  expect(log.slice(drained)).toEqual([])
})
