// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The cloud half of a paired machine, for the local specs that drive SHO-130's
 * user path.
 *
 * A local run has no cloud, so this serves exactly what the cloud owns and
 * nothing else:
 *
 *   • `GET /api/machines` — the list the switcher draws;
 *   • **the copy** — every *read* of the machine's workspace, answered from the
 *     machine's rows under the workspace id the app uses. This is SHO-185's
 *     model: a panel opens from the copy, so a machine that is asleep still
 *     serves its records and no read ever enters the tunnel;
 *   • the relay transport `/api/machines/<id>/w/<localWorkspaceId>/…` — for
 *     mutations and the live paths (agent turns, files on its disk), forwarded
 *     to this process's real local API with the tunnel's own auth header.
 *
 * The ids deliberately differ: the machine calls its workspace
 * `MACHINE_WORKSPACE_ID` while this dev database calls it `machineWorkspaceId`.
 * Reading the machine's rows under the app's id is the copy's whole job, so the
 * fixture translates on the way through — exactly what ingest does by keeping
 * the desktop's ids.
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
/** A read served by the copy: no tunnel, no relay path. */
export type CopyCall = { method: string; path: string; status: number; projectNames?: string[] }
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
export type MachinePower = { online: boolean }

/**
 * Take the machine down, as the cloud sees it: `GET /api/machines` reports it
 * offline and the relay answers the cloud's read-only refusal. The copy keeps
 * serving — that is the whole point of SHO-185's model.
 */
export function setMachinePower(power: MachinePower, online: boolean): void {
  power.online = online
}

export async function installCloudRelay(
  page: Page,
  opts: {
    machineWorkspaceId: string
    userId: string
    log: RelayCall[]
    copies?: CopyCall[]
    power?: MachinePower
    /**
     * Who the cloud says is calling, stamped on every relayed request. In
     * production that is the owner's *cloud* account, which the machine's
     * database has never heard of; defaults to the local user for the specs
     * written before that difference was modelled.
     */
    relayUserId?: string
  },
): Promise<void> {
  const { machineWorkspaceId, userId, log, copies, power } = opts
  const relayUserId = opts.relayUserId ?? userId
  const isOnline = () => power?.online ?? true
  const machineWorkspaces = [{ id: MACHINE_WORKSPACE_ID, name: MACHINE_WORKSPACE_NAME, kind: "team" }]

  /**
   * The copy: a read of the machine's workspace, answered from the machine's
   * rows under the id the app uses, without touching the relay.
   *
   * Only reads are copied — a mutation has to reach the desktop, so it keeps
   * going through the tunnel (SHO-185 §6). The ids deliberately differ here (the
   * machine calls its workspace `MACHINE_WORKSPACE_ID`, this dev database calls
   * it `machineWorkspaceId`), so the fixture translates on the way in and back
   * out: the copy carries the writer's rows, and only the workspace id differs.
   */
  if (copies) {
    const copyUrl = (url: URL): boolean =>
      url.href.includes(MACHINE_WORKSPACE_ID) && !url.pathname.startsWith("/api/machines")
    await page.route(copyUrl, async (route: Route) => {
      const url = new URL(route.request().url())
      const method = route.request().method()
      if (method !== "GET") return route.fallback()

      const copyPath = url.pathname.replaceAll(MACHINE_WORKSPACE_ID, machineWorkspaceId)
      const copyQuery = url.search.replaceAll(MACHINE_WORKSPACE_ID, machineWorkspaceId)
      const upstream = await fetch(`${LOCAL_API_BASE}${copyPath}${copyQuery}`, {
        headers: { "x-tunnel-auth-user-id": userId },
      })
      const body = (await upstream.text()).split(machineWorkspaceId).join(MACHINE_WORKSPACE_ID)
      const call: CopyCall = { method, path: url.pathname, status: upstream.status }
      if (copyPath.startsWith("/api/projects")) {
        try {
          call.projectNames = (JSON.parse(body).items ?? []).map((p: { name: string }) => p.name)
        } catch {
          call.projectNames = []
        }
      }
      copies.push(call)
      return route.fulfill({
        status: upstream.status,
        headers: { "content-type": upstream.headers.get("content-type") ?? "application/json" },
        body,
      })
    })
  }

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
              status: isOnline() ? "online" : "offline",
              lastSeenAt: new Date(Date.now() - (isOnline() ? 0 : 600_000)).toISOString(),
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
        body: JSON.stringify({
          status: isOnline() ? "online" : "offline",
          stale: !isOnline(),
          workspaces: machineWorkspaces,
        }),
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

    if (!isOnline()) {
      const refused: RelayCall = { method, path, status: 409 }
      log.push(refused)
      return route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({
          error: {
            code: "machine_offline_readonly",
            message: `${MACHINE_NAME} is offline — this workspace is read-only until it is back`,
            lastSyncedAt: new Date(Date.now() - 600_000).toISOString(),
          },
        }),
      })
    }

    const rest = path.slice(relayPrefix.length)
    const machinePath = rest.slice(rest.indexOf("/")).replaceAll(MACHINE_WORKSPACE_ID, machineWorkspaceId)
    const machineQuery = url.search.replaceAll(MACHINE_WORKSPACE_ID, machineWorkspaceId)

    const upstream = await fetch(`${LOCAL_API_BASE}${machinePath}${machineQuery}`, {
      method,
      headers: {
        "x-tunnel-auth-user-id": relayUserId,
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
