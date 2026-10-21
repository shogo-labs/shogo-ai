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
 * - the model. There is no LLM credential in local CI, so the agent turn is
 *   asserted at the seam that matters for this card — the turn reaches the
 *   machine carrying the machine's own workspace id. The *reply* is not
 *   asserted here; a live agent reading a canary off the machine's disk is the
 *   staging run (`e2e/staging/remote-control.test.ts`).
 */
import { expect, test, type Page, type Route } from "@playwright/test"
import { LOCAL_API_BASE } from "./helpers"

const MACHINE_ID = "machine-sho130"
/** The machine's own id for the workspace — deliberately unlike the cloud's. */
const MACHINE_WORKSPACE_ID = "mws-studio-team"
const MACHINE_NAME = "Studio Mac"
const MACHINE_WORKSPACE_NAME = "Studio Mac Team"
const MACHINE_ONLY_PROJECT = "Machine only"
const CLOUD_ONLY_PROJECT = "Cloud only"
const CANARY = "SHO130-CANARY-8f2e1c"

type RelayCall = { method: string; path: string; status: number; projectNames?: string[] }
type Workspace = { id: string; name: string; kind: string }

/** Sign in, finish onboarding, and wait for the switcher to be on screen. */
async function openCloudWorkspace(page: Page): Promise<void> {
  await page.goto("/", { waitUntil: "domcontentloaded" })
  await page.waitForTimeout(3000)
  await page.evaluate(async (api) => {
    await fetch(`${api}/api/local/auto-sign-in`, { method: "POST", credentials: "include" })
    await fetch(`${api}/api/onboarding/complete`, { method: "POST", credentials: "include" })
  }, LOCAL_API_BASE)
  await page.reload({ waitUntil: "domcontentloaded" })
  await expect(page.getByRole("button", { name: /— open account/ }).first()).toBeVisible({ timeout: 60_000 })
}

async function readWorkspaces(page: Page): Promise<{ personal: Workspace; team: Workspace; userId: string }> {
  return page.evaluate(async (api) => {
    const list = await fetch(`${api}/api/workspaces`, { credentials: "include" }).then((r) => r.json())
    const items: Workspace[] = list.items ?? []
    const me = await fetch(`${api}/api/auth/get-session`, { credentials: "include" }).then((r) => r.json())
    const personal = items.find((w) => w.kind === "personal")
    const team = items.find((w) => w.kind !== "personal") ?? personal
    return { personal: personal!, team: team!, userId: me?.user?.id ?? me?.session?.userId }
  }, LOCAL_API_BASE)
}

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

/**
 * Serve the cloud's machine list and relay, forwarding to the real local API.
 *
 * `machines` is what the cloud would say the paired computer has; the relay
 * prefix is the cloud's `/api/machines/<id>/w/<localWorkspaceId>` transport.
 */
async function installCloudRelay(
  page: Page,
  opts: { machineWorkspaceId: string; userId: string; log: RelayCall[] },
): Promise<void> {
  const { machineWorkspaceId, userId, log } = opts
  const machineWorkspaces = [{ id: MACHINE_WORKSPACE_ID, name: MACHINE_WORKSPACE_NAME, kind: "team" }]

  await page.route("**/api/machines**", async (route: Route) => {
    const url = new URL(route.request().url())
    const path = url.pathname
    const method = route.request().method()

    if (path === "/api/machines") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          machines: [
            {
              id: MACHINE_ID,
              name: MACHINE_NAME,
              hostname: "studio-mac",
              kind: "desktop",
              status: "online",
              lastSeenAt: new Date().toISOString(),
              snapshot: { workspaces: machineWorkspaces },
            },
          ],
        }),
      })
    }

    if (path === `/api/machines/${MACHINE_ID}/workspaces`) {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ status: "online", stale: false, workspaces: machineWorkspaces }),
      })
    }

    const relayPrefix = `/api/machines/${MACHINE_ID}/w/`
    if (!path.startsWith(relayPrefix)) {
      return route.fulfill({
        status: 404,
        contentType: "application/json",
        body: JSON.stringify({ error: { code: "not_found" } }),
      })
    }

    const rest = path.slice(relayPrefix.length)
    // The machine's own workspace id stands in for a workspace on this dev
    // machine, so the relay maps it back the way the tunnel would.
    const machinePath = rest.slice(rest.indexOf("/")).replaceAll(MACHINE_WORKSPACE_ID, machineWorkspaceId)
    const machineQuery = url.search.replaceAll(MACHINE_WORKSPACE_ID, machineWorkspaceId)

    const upstream = await fetch(`${LOCAL_API_BASE}${machinePath}${machineQuery}`, {
      method,
      headers: {
        "x-tunnel-auth-user-id": userId,
        "content-type": route.request().headerValue("content-type") ?? "application/json",
      },
      body: ["GET", "HEAD"].includes(method) ? undefined : route.request().postDataBuffer(),
    })
    const body = Buffer.from(await upstream.arrayBuffer())
    const call: RelayCall = { method, path: machinePath, status: upstream.status }
    if (machinePath.startsWith("/api/projects")) {
      try {
        call.projectNames = (JSON.parse(body.toString("utf8")).items ?? []).map((p: { name: string }) => p.name)
      } catch {
        call.projectNames = []
      }
    }
    log.push(call)

    return route.fulfill({
      status: upstream.status,
      headers: { "content-type": upstream.headers.get("content-type") ?? "application/json" },
      body,
    })
  })
}

async function openSwitcher(page: Page): Promise<void> {
  await page.getByRole("button", { name: /— open account/ }).first().click()
  await expect(page.getByTestId(`workspace-row:machine:${MACHINE_ID}:${MACHINE_WORKSPACE_ID}`)).toBeVisible({
    timeout: 30_000,
  })
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
  await expect(page.getByRole("button", { name: new RegExp(`^${MACHINE_WORKSPACE_NAME}, `) })).toBeVisible({
    timeout: 20_000,
  })
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
  await expect(page.getByRole("button", { name: new RegExp(`^${MACHINE_WORKSPACE_NAME}, `) })).toBeVisible({
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
  expect(log.filter((r) => r.path.includes("/chat")).every((r) => r.path.includes(team.id))).toBe(true)

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
