// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { test, expect, type Page } from "./fixtures"
import { mustExec, runtimeExec } from "./runtime-exec"
import {
  bootstrapApiBase,
  createProjectAndWait,
  makeTestUser,
  runtimeFaultViaApi,
  signUpAndOnboard,
  suspendRuntimeViaApi,
  type TestUser,
} from "./helpers"

/**
 * Metal workspace drive E2E: a project's workspace lives on its own per-VM
 * drive rather than in the few GiB the golden rootfs leaves free (the
 * "disk is full, 14 GB used of 14 GB" reports), and that drive survives a
 * wake from the durable store.
 *
 *   1. /app/workspace is a separate mount with well over the rootfs's headroom,
 *      and writing more than the rootfs could ever hold succeeds.
 *   2. Suspend, drop the host's LOCAL snapshot (`evict-local`, what a wake on
 *      another host sees), reopen: files written before the suspend are back.
 *
 * Commands run in the project's real VM through the same terminal PTY the web
 * UI uses. The fault needs `SHOGO_E2E_BOOTSTRAP_SECRET` here and
 * `METAL_E2E_FAULTS=1` + `METAL_WORKSPACE_DRIVE_MIB` on the metal hosts; the
 * suite skips when the project is not on a host with the drive.
 *
 * Run: E2E_TARGET_URL=... SHOGO_E2E_BOOTSTRAP_SECRET=... \
 *   npx playwright test --config e2e/playwright.config.ts metal-workspace-disk
 */

const TEST_USER = makeTestUser("MetalWorkspaceDisk")
const MIN_WORKSPACE_BYTES = 15 * 1024 ** 3
const BIG_MIB = 6144

async function ensureAuthenticated(page: Page, user: TestUser): Promise<void> {
  await page.goto("/home")
  const home = page.getByText("What are we building", { exact: false }).first()
  const signUpTab = page.getByRole("tab", { name: "Sign Up" })
  await Promise.race([
    home.waitFor({ state: "visible", timeout: 60_000 }).catch(() => {}),
    signUpTab.waitFor({ state: "visible", timeout: 60_000 }).catch(() => {}),
  ])
  if (await home.isVisible().catch(() => false)) return
  await signUpAndOnboard(page, user)
}

/** `df -B1 --output=source,size,avail <path>` in the runtime. */
async function df(page: Page, projectId: string, path: string) {
  const out = await mustExec(page, projectId, `df -B1 --output=source,size,avail ${path} | tail -1`)
  const [source, size, avail] = out.trim().split(/\s+/)
  return { source, size: Number(size), avail: Number(avail) }
}

test.describe("Metal workspace drive", () => {
  test.describe.configure({ mode: "serial" })

  let page: Page
  let projectId = ""
  /** GiB the live-grow test asked for; the wake test re-asserts it. */
  let targetGiB = 0
  const marker = `wsdrive-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage()
    await ensureAuthenticated(page, TEST_USER)
  })

  test.afterAll(async () => {
    await page?.close()
  })

  test("the workspace is its own disk with room to grow", async () => {
    test.setTimeout(600_000)
    await createProjectAndWait(
      page,
      "Create the simplest possible starter app: a single page that shows the word Hello. No extra pages, components, features, or backend.",
    )
    projectId = page.url().match(/\/projects\/([^/?#]+)/)?.[1] ?? ""
    expect(projectId, `expected a /projects/<id> URL, got ${page.url()}`).not.toBe("")

    const mounted = await runtimeExec(page, projectId, "findmnt -no SOURCE /app/workspace")
    test.skip(mounted.code !== 0, "runtime is not on a metal host with the workspace drive enabled")

    const ws = await df(page, projectId, "/app/workspace")
    const root = await df(page, projectId, "/")
    expect(ws.source, "workspace must not share the root device").not.toBe(root.source)
    expect(ws.size).toBeGreaterThan(MIN_WORKSPACE_BYTES)

    // More than the rootfs's entire free space: this is what used to hit ENOSPC.
    const bigMiB = Math.max(BIG_MIB, Math.ceil(root.avail / 1024 ** 2) + 1024)
    await mustExec(
      page,
      projectId,
      `dd if=/dev/zero of=/app/workspace/.wsdrive-e2e.bin bs=4M count=${bigMiB / 4} conv=fsync status=none && ` +
        `rm -f /app/workspace/.wsdrive-e2e.bin`,
      600_000,
    )
    await mustExec(page, projectId, `echo ${marker} > /app/workspace/.wsdrive-e2e-marker && sync`)
  })

  test("asking for more disk grows the live drive without a restart", async () => {
    test.setTimeout(600_000)
    // SHO-349 AC 4: PUT /disk on a RUNNING project grows /app/workspace in
    // place — no restart, no lost bytes, same device. The host does
    // freeze → ftruncate → PATCH /drives → thaw → resize2fs underneath.
    const base = bootstrapApiBase()
    const before = await df(page, projectId, "/app/workspace")
    const stateRes = await page.request.get(`${base}/api/projects/${projectId}/disk`, {
      headers: { Origin: base },
    })
    expect(stateRes.ok(), await stateRes.text()).toBe(true)
    const state = (await stateRes.json()) as {
      substrate: string
      effectiveGiB: number
      maxGiB: number
      canIncrease: boolean
    }
    test.skip(state.substrate !== "metal", "this project is not on a metal host")
    test.skip(!state.canIncrease, `the plan ceiling (${state.maxGiB} GiB) leaves no headroom`)

    targetGiB = Math.min(state.maxGiB, state.effectiveGiB + 20)
    const put = await page.request.put(`${base}/api/projects/${projectId}/disk`, {
      headers: { Origin: base, "content-type": "application/json" },
      data: { sizeGiB: targetGiB },
    })
    expect(put.ok(), await put.text()).toBe(true)

    // AC 4's budget: the guest sees the new size within 10 s, still mounted on
    // the same device, with the bytes written before the grow untouched.
    await expect
      .poll(async () => (await df(page, projectId, "/app/workspace")).size, { timeout: 20_000 })
      .toBeGreaterThan(before.size)
    const after = await df(page, projectId, "/app/workspace")
    expect(after.source, "growing the drive must not change the device").toBe(before.source)
    expect(after.size).toBeGreaterThanOrEqual(targetGiB * 1024 ** 3 * 0.95)
    const stillThere = await mustExec(page, projectId, "cat /app/workspace/.wsdrive-e2e-marker")
    expect(stillThere).toContain(marker)
  })

  test("the drive comes back from the durable store", async () => {
    test.setTimeout(600_000)
    test.skip(!process.env.SHOGO_E2E_BOOTSTRAP_SECRET, "needs SHOGO_E2E_BOOTSTRAP_SECRET for the fault backdoor")
    // An open project page keeps the runtime warm and would wake it again
    // before the fault lands.
    await page.goto("about:blank")
    expect(await suspendRuntimeViaApi(page, projectId), "runtime must really suspend").toBe(true)
    const r = await runtimeFaultViaApi(page, projectId, "evict-local")
    test.skip(!r, "runtime faults unavailable (host needs METAL_E2E_FAULTS=1)")
    expect(r!.ok, JSON.stringify(r!.body)).toBe(true)

    await page.goto(`/projects/${projectId}`)
    const out = await mustExec(page, projectId, "cat /app/workspace/.wsdrive-e2e-marker; findmnt -no SOURCE /app/workspace")
    expect(out).toContain(marker)

    // AC 5: the raised size survives suspend → wake with the local snapshot
    // dropped, i.e. a restore of the pushed drive onto this host. A fresh boot
    // that went back to the fleet default is exactly the bug this card fixes.
    if (targetGiB) {
      const restored = await df(page, projectId, "/app/workspace")
      expect(restored.size).toBeGreaterThanOrEqual(targetGiB * 1024 ** 3 * 0.95)
    }
  })
})
