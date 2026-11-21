// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { test, expect, type Page } from "./fixtures"
import {
  bootstrapApiBase,
  bootstrapInstanceSizeViaApi,
  createProjectAndWait,
  makeTestUser,
  signUpAndOnboard,
} from "./helpers"
import { mustExec } from "./runtime-exec"

/**
 * Settings → Machine end to end on a real metal host: a user upgrades a
 * project's machine, restarts it from the panel, and the guest really has the
 * new vCPUs and memory; then downgrades back to Standard and the guest goes
 * back to the standard size. The project's files survive both restarts.
 *
 *   1. Workspace on the Large tier (16 GB budget) through the e2e backdoor, so
 *      Medium (4 vCPU / 8 GB) fits next to the workspace agent's VM and XLarge
 *      is still locked.
 *   2. Baseline: `nproc` and MemTotal of the standard VM; a marker file.
 *   3. Upgrade in the UI → "Restart to apply" → confirm. The guest reports
 *      4 vCPUs and ≥ 90% of 8 GiB, the marker is intact, GET /machine says Medium.
 *   4. XLarge is refused by the API with the plan error (422 plan_ceiling).
 *   5. Downgrade to Standard in the UI and restart. The guest is back at the
 *      baseline size and the marker is still there.
 *
 * Commands run in the VM through the terminal PTY the web UI uses. Needs
 * `SHOGO_E2E_BOOTSTRAP_SECRET`; skips when the project isn't on metal.
 *
 * Run: E2E_TARGET_URL=... SHOGO_E2E_BOOTSTRAP_SECRET=... \
 *   npx playwright test --config e2e/playwright.config.ts project-machine-size
 */

const TEST_USER = makeTestUser("MachineSize")
const GiB_KB = 1024 * 1024
/** A restart backs up, stops and cold-boots the VM; give it room on a busy host. */
const RESIZE_TIMEOUT_MS = 300_000

interface GuestSize {
  vcpus: number
  memKb: number
}

async function guestSize(page: Page, projectId: string): Promise<GuestSize> {
  const out = await mustExec(page, projectId, "nproc; awk '/^MemTotal:/{print $2}' /proc/meminfo")
  const [vcpus, memKb] = out.trim().split(/\s+/).map(Number)
  return { vcpus, memKb }
}

async function machineState(page: Page, projectId: string) {
  const base = bootstrapApiBase()
  const res = await page.request.get(`${base}/api/projects/${projectId}/machine`, { headers: { Origin: base } })
  expect(res.ok(), await res.text()).toBe(true)
  return (await res.json()) as {
    current: { id: string; vcpus: number; memMiB: number }
    options: Array<{ id: string; allowed: boolean }>
    substrate: string
    running: boolean
  }
}

/**
 * Opens Settings → Machine the way a person does: the gear tab in the project
 * top bar. `?tab=settings` is not enough on a project that has just built, the
 * canvas preview wins and Settings never mounts.
 */
async function openMachinePanel(page: Page, projectId: string): Promise<void> {
  await page.goto(`/projects/${projectId}`)
  const settingsTab = page
    .getByTestId("project-tab-settings")
    .or(page.getByLabel("Settings", { exact: true }))
    .first()
  await expect(settingsTab).toBeVisible({ timeout: 60_000 })
  await settingsTab.click()
  const nav = page.getByTestId("settings-nav-machine").first()
  await expect(nav).toBeVisible({ timeout: 30_000 })
  await nav.click()
  await expect(page.getByText("Current size").first()).toBeVisible({ timeout: 30_000 })
}

/** Pick a size in the panel, save it, and restart from the panel to apply it. */
async function changeSizeAndRestart(page: Page, projectId: string, label: string, verb: "Upgrade" | "Downgrade") {
  await openMachinePanel(page, projectId)
  await page.getByRole("radio", { name: new RegExp(`^${label},`) }).click()
  await page.getByText(`${verb} to ${label}`).click()
  // The project is open and running, so the save must say a restart is needed.
  await expect(page.getByText("Restart the project to switch to the new size", { exact: false })).toBeVisible({
    timeout: 30_000,
  })
  await page.getByText("Restart to apply").click()
  await page.getByLabel("Confirm restart").click()
  await expect(page.getByText("Restarting.", { exact: false })).toBeVisible({ timeout: 180_000 })
}

/** Poll the guest until it reports `want` (the old VM may answer briefly). */
async function expectGuest(page: Page, projectId: string, want: (g: GuestSize) => boolean, what: string) {
  let last: GuestSize | null = null
  await expect
    .poll(
      async () => {
        last = await guestSize(page, projectId).catch(() => null)
        return !!last && want(last)
      },
      { timeout: RESIZE_TIMEOUT_MS, intervals: [5_000, 10_000] },
    )
    .toBe(true)
    .catch((err) => {
      throw new Error(`${what}; guest last reported ${JSON.stringify(last)}\n${err}`)
    })
}

test.describe("Project machine size", () => {
  test.describe.configure({ mode: "serial" })

  let page: Page
  let projectId = ""
  let baseline: GuestSize = { vcpus: 0, memKb: 0 }
  const marker = `machine-e2e-${Date.now()}`

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage()
    await signUpAndOnboard(page, TEST_USER)
  })

  test.afterAll(async () => {
    await page?.close()
  })

  test("a Large-plan project starts at the standard size", async () => {
    test.setTimeout(600_000)
    test.skip(
      !(await bootstrapInstanceSizeViaApi(page, TEST_USER, "large")),
      "needs SHOGO_E2E_BOOTSTRAP_SECRET for the instance-tier backdoor",
    )
    await createProjectAndWait(
      page,
      "Create the simplest possible starter app: a single page that shows the word Hello. No extra pages, components, features, or backend.",
    )
    projectId = page.url().match(/\/projects\/([^/?#]+)/)?.[1] ?? ""
    expect(projectId, `expected a /projects/<id> URL, got ${page.url()}`).not.toBe("")

    const state = await machineState(page, projectId)
    test.skip(state.substrate !== "metal", `project runs on ${state.substrate}, not a metal host`)
    expect(state.current.id).toBe("standard")
    expect(state.options.find((o) => o.id === "large")?.allowed).toBe(true)
    expect(state.options.find((o) => o.id === "xlarge")?.allowed).toBe(false)

    baseline = await guestSize(page, projectId)
    expect(baseline.vcpus).toBeGreaterThan(0)
    expect(baseline.vcpus, "Medium must be an upgrade on this host").toBeLessThan(4)
    expect(baseline.memKb, "Medium must be an upgrade on this host").toBeLessThan(8 * GiB_KB * 0.9)
    await mustExec(page, projectId, `echo ${marker} > /app/workspace/.machine-e2e-marker && sync`)
  })

  test("upgrading to Medium and restarting gives the guest 4 vCPUs and 8 GB", async () => {
    test.setTimeout(900_000)
    test.skip(!projectId || !baseline.vcpus, "no metal project from the first step")

    await changeSizeAndRestart(page, projectId, "Medium", "Upgrade")
    await expectGuest(
      page,
      projectId,
      (g) => g.vcpus === 4 && g.memKb >= 8 * GiB_KB * 0.9,
      "after the upgrade the guest should have 4 vCPUs and ~8 GiB",
    )
    expect(await mustExec(page, projectId, "cat /app/workspace/.machine-e2e-marker")).toContain(marker)

    const state = await machineState(page, projectId)
    expect(state.current).toMatchObject({ id: "medium", vcpus: 4, memMiB: 8192 })
  })

  test("a size above the plan is refused", async () => {
    test.skip(!projectId || !baseline.vcpus, "no metal project from the first step")
    const base = bootstrapApiBase()
    const res = await page.request.put(`${base}/api/projects/${projectId}/machine`, {
      headers: { Origin: base, "content-type": "application/json" },
      data: { size: "xlarge" },
    })
    expect(res.status()).toBe(422)
    expect((await res.json()).error?.code).toBe("plan_ceiling")
    expect((await machineState(page, projectId)).current.id).toBe("medium")
  })

  test("downgrading to Standard and restarting puts the guest back to the standard size", async () => {
    test.setTimeout(900_000)
    test.skip(!projectId || !baseline.vcpus, "no metal project from the first step")

    await changeSizeAndRestart(page, projectId, "Standard", "Downgrade")
    await expectGuest(
      page,
      projectId,
      (g) => g.vcpus === baseline.vcpus && Math.abs(g.memKb - baseline.memKb) <= baseline.memKb * 0.05,
      `after the downgrade the guest should be back at ${JSON.stringify(baseline)}`,
    )
    expect(await mustExec(page, projectId, "cat /app/workspace/.machine-e2e-marker")).toContain(marker)
    expect((await machineState(page, projectId)).current.id).toBe("standard")
  })
})
