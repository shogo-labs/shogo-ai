// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-130 AC 8 — the staging half, against a **real** paired host.
 *
 * Russell, verbatim: "prove everything works locally and then prove it works in
 * staging. from staging you should be able to see a workspace that you create
 * on this computer and its channels. you should be able to send a message from
 * staging that can read the harddrive of this computer."
 *
 * So nothing here is mocked: a throwaway staging account, a device key minted
 * through `cli/login`, and an isolated local API on *this* machine (own data
 * dir + DB, so this Mac's production pairing is untouched) which the staging
 * cloud lists at `/api/machines`. The spec then signs the browser into that
 * staging account, opens the machine's workspace, and asks its agent — over the
 * relay — to read a canary from this machine's disk.
 *
 * Red now, green after merge (Russell's call): staging serves `main`, so on
 * today's deploy the flash-back this card fixes is still there and this spec is
 * expected to fail at the identity assertion. That failure is the evidence; it
 * goes green once PR #1620 is on `main` and staging redeploys.
 *
 * Run:
 *   E2E_STAGING_MACHINE=1 STAGING_URL=https://studio.staging.shogo.ai \
 *     npx playwright test --config e2e/playwright.config.ts machine-workspaces --project chromium
 *
 * Measured on 2026-10-21 against staging v2.3.8 (= `main`, pre-fix): the
 * machine row is listed and clicked, and the page goes **blank** — the hard
 * reload the switch ends in never restores the machine workspace.
 */
import { expect, test, type BrowserContext, type Page } from "./fixtures"
import { pairMachine, writeMachineCanary, type PairedMachine } from "./machine-pairing"

const STAGING_URL = (process.env.STAGING_URL || process.env.E2E_TARGET_URL || "https://studio.staging.shogo.ai").replace(
  /\/$/,
  "",
)
const INSTANCE = `sho130-${Math.random().toString(36).slice(2, 8)}`
const CANARY = `SHO130-STAGING-CANARY-${Math.random().toString(36).slice(2, 8)}`
const CANARY_PATH = `.tmp/sho130-staging-canary.txt`

// Pairs a real local API to a live cloud and spends a real agent turn, so it is
// opt-in rather than part of the staged suite: until #1620 is on `main` it is
// *expected* to fail at the flash-back.
test.skip(
  process.env.E2E_STAGING_MACHINE !== "1",
  "pairs this machine to the target cloud and runs a live agent turn; set E2E_STAGING_MACHINE=1 to run it",
)

test.describe("SHO-130 · a paired machine's workspace, from staging", () => {
  test.describe.configure({ mode: "serial" })
  test.setTimeout(600_000)

  let machine: PairedMachine
  let context: BrowserContext
  let page: Page

  test.beforeAll(async ({ browser }) => {
    machine = await pairMachine(STAGING_URL, { instanceName: INSTANCE })
    context = await browser.newContext({ baseURL: STAGING_URL })
    const cookies = machine.cookies
      .split("; ")
      .filter(Boolean)
      .map((pair) => {
        const [name, ...rest] = pair.split("=")
        return { name, value: rest.join("="), url: STAGING_URL }
      })
    await context.addCookies(cookies)
    page = await context.newPage()
  })

  test.afterAll(async () => {
    await context?.close()
    await machine?.stop()
  })

  test("staging lists this machine and opens one of its workspaces", async () => {
    // ── The machine is real and the cloud can see it ───────────────────────
    const listed = await page.request.get(`${STAGING_URL}/api/machines`)
    expect(listed.ok()).toBe(true)
    const rows = (await listed.json()).machines ?? []
    const row = rows.find((m: { name?: string }) => m.name === INSTANCE)
    expect(row, `staging should list "${INSTANCE}"`).toBeTruthy()
    expect((row.snapshot?.workspaces ?? []).length).toBeGreaterThan(0)

    // ── The staging UI, signed in as that account ──────────────────────────
    await page.goto("/", { waitUntil: "domcontentloaded" })
    await expect(page.getByRole("button", { name: /— open account/ }).first()).toBeVisible({ timeout: 120_000 })

    // Its workspace is offered in the switcher.
    await page.getByRole("button", { name: /— open account/ }).first().click()
    const machineRow = page.getByTestId(`workspace-row:machine:${machine.machineId}:${machine.machineWorkspaceId}`)
    await expect(machineRow, "the machine's workspace should be in the switcher").toBeVisible({ timeout: 60_000 })
    await machineRow.click()

    // ── AC 1 — it is the workspace in view, and it stays ───────────────────
    // `pairMachine` renamed the machine's workspace to something no cloud
    // workspace is called, so this cannot pass by matching the cloud row of the
    // same name (a seeded workspace is named after the cloud account).
    await expect(page.getByRole("button", { name: `${machine.machineWorkspaceName}, workspace menu` })).toBeVisible({
      timeout: 60_000,
    })
    await expect(
      page.getByRole("button", { name: new RegExp(`^${machine.cloudWorkspaceName}, .*— open account`) }),
    ).toHaveCount(0)
    await page.reload({ waitUntil: "domcontentloaded" })
    await expect(page.getByRole("button", { name: `${machine.machineWorkspaceName}, workspace menu` })).toBeVisible({
      timeout: 120_000,
    })

    // ── AC 5 — the agent on this computer reads this computer's disk ───────
    expect(await writeMachineCanary(machine, CANARY_PATH, CANARY)).toBe(200)
    const composer = page.getByRole("textbox").last()
    await expect(composer).toBeVisible({ timeout: 60_000 })
    await composer.click()
    await composer.fill(`Read ${CANARY_PATH} and reply with its exact contents.`)
    await page.keyboard.press("Enter")

    await expect(page.getByText(CANARY, { exact: false })).toBeVisible({ timeout: 240_000 })

    // ── The same question in a cloud workspace: no canary ──────────────────
    // (recorded rather than asserted twice — the machine's read is the claim;
    // this keeps the negative control in the same run.)
    await page.getByRole("button", { name: /— open account/ }).first().click()
    await page.getByTestId(`workspace-row:cloud:${machine.cloudWorkspaceId}`).click()
    const cloudComposer = page.getByRole("textbox").last()
    await expect(cloudComposer).toBeVisible({ timeout: 60_000 })
    await cloudComposer.click()
    await cloudComposer.fill(`Read ${CANARY_PATH} and reply with its exact contents.`)
    await page.keyboard.press("Enter")
    await expect(page.getByText(CANARY, { exact: false })).toHaveCount(0, { timeout: 120_000 })
  })
})
