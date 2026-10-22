// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The cloud half of a paired machine, for the local specs that drive SHO-130's
 * user path.
 *
 * A local run has no cloud, so this serves exactly what the cloud owns and
 * nothing else: `GET /api/machines` (the list the switcher draws) and the relay
 * transport `/api/machines/<id>/w/<localWorkspaceId>/…`, which forwards to this
 * process's real local API with the tunnel's own auth header. The machine's
 * projects, sessions, channels, messages and *disk* are all real.
 *
 * The seam is the same one `machine-workspaces-tunnel` uses, so a change to the
 * relay's URL shape breaks both.
 */
import { expect, type Page, type Route } from "@playwright/test"
import { LOCAL_API_BASE } from "./helpers"

export const MACHINE_ID = "machine-sho130"
/** The machine's own id for the workspace — deliberately unlike the cloud's. */
export const MACHINE_WORKSPACE_ID = "mws-studio-team"
export const MACHINE_NAME = "Studio Mac"
export const MACHINE_WORKSPACE_NAME = "Studio Mac Team"

export type RelayCall = { method: string; path: string; status: number; projectNames?: string[] }
export type Workspace = { id: string; name: string; kind: string }

/** Sign in, finish onboarding, and wait for the switcher to be on screen. */
export async function openCloudWorkspace(page: Page): Promise<void> {
  await page.goto("/", { waitUntil: "domcontentloaded" })
  await page.waitForTimeout(3000)
  await page.evaluate(async (api) => {
    await fetch(`${api}/api/local/auto-sign-in`, { method: "POST", credentials: "include" })
    await fetch(`${api}/api/onboarding/complete`, { method: "POST", credentials: "include" })
  }, LOCAL_API_BASE)
  await page.reload({ waitUntil: "domcontentloaded" })
  await expect(page.getByRole("button", { name: /— open account/ }).first()).toBeVisible({ timeout: 60_000 })
}

export async function readWorkspaces(page: Page): Promise<{ personal: Workspace; team: Workspace; userId: string }> {
  return page.evaluate(async (api) => {
    const list = await fetch(`${api}/api/workspaces`, { credentials: "include" }).then((r) => r.json())
    const items: Workspace[] = list.items ?? []
    const me = await fetch(`${api}/api/auth/get-session`, { credentials: "include" }).then((r) => r.json())
    const personal = items.find((w) => w.kind === "personal")
    const team = items.find((w) => w.kind !== "personal") ?? personal
    return { personal: personal!, team: team!, userId: me?.user?.id ?? me?.session?.userId }
  }, LOCAL_API_BASE)
}

/**
 * Serve the cloud's machine list and relay, forwarding to the real local API.
 *
 * `machineWorkspaceId` is the id on this dev machine that stands in for the
 * machine's workspace, so the relay maps it back the way the tunnel would.
 */
export async function installCloudRelay(
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

/** The relay's base URL, as the app asks it. */
export function relayBase(): string {
  return `${LOCAL_API_BASE}/api/machines/${MACHINE_ID}/w/${MACHINE_WORKSPACE_ID}`
}

export async function openSwitcher(page: Page): Promise<void> {
  await page.getByRole("button", { name: /— open account/ }).first().click()
  await page
    .getByTestId(`workspace-row:machine:${MACHINE_ID}:${MACHINE_WORKSPACE_ID}`)
    .waitFor({ state: "visible", timeout: 30_000 })
}

/** Open the paired machine's workspace from the cloud switcher. */
export async function selectMachineWorkspace(page: Page): Promise<void> {
  await openSwitcher(page)
  await page.getByTestId(`workspace-row:machine:${MACHINE_ID}:${MACHINE_WORKSPACE_ID}`).click()
}
