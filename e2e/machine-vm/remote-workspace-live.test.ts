// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-488 — the last layer: what a person actually sees.
 *
 * The API suites in `apps/api/src/__tests__/remote-workspace/` prove the socket
 * carries an event. They cannot prove the studio **renders** it, and "the reply
 * only shows up after a refresh" is a UI bug even when the socket is perfect —
 * a component that subscribes on mount but is keyed by the wrong conversation,
 * or a query cache that never gets invalidated, passes every API test.
 *
 * So: open the machine's workspace in the cloud studio, stop touching the page,
 * make the change on the machine through the machine's own API, and require the
 * change to appear. A `window` flag set before the change proves the assertion
 * was not satisfied by a reload or a navigation.
 *
 * Real processes, one worker (`playwright.config.ts` boots
 * `helpers/machine-vm-stack.ts`: cloud API on Postgres + Redis, a paired
 * desktop, the studio web build in front of the cloud).
 *
 *   (cd apps/mobile && bun run build)
 *   CHANNELS_TEST_PG_URL=… TEST_REDIS_URL=… \
 *     npx playwright test --config e2e/machine-vm/playwright.config.ts
 *
 * CI runs this in the `rbac-postgres` job, "Machine workspace in the cloud UI".
 * It needs the web build and Playwright's Chromium, so it is not part of the
 * per-file API loop.
 */
import { expect, test, type Page } from "@playwright/test"
import { marker, token } from "../../apps/desktop/e2e/streaming/fake-llm-server"

interface Seeded {
  tag: string
  projectNames: string[]
  channelId: string
  channelName: string
  messageTexts: string[]
  threadRootId: string
  replyText: string
}
interface StackState {
  web: string
  cloud: string
  cookies: string
  localApiBase: string
  localCookies: string
  machineId: string
  machineWorkspaceId: string
  machineWorkspaceName: string
  cloudWorkspaceId: string
  seeds: { cloud: Seeded; machine: Seeded }
}

let state: StackState

test.describe.configure({ mode: "serial" })

test.beforeAll(async ({ request }) => {
  state = await (await request.get("/__stack/state")).json()
})

test.beforeEach(async ({ context }) => {
  const url = new URL(state.web)
  await context.addCookies(
    state.cookies
      .split("; ")
      .filter(Boolean)
      .map((pair) => {
        const [name, ...rest] = pair.split("=")
        return { name, value: rest.join("="), domain: url.hostname, path: "/" }
      }),
  )
})

async function openMachineWorkspace(page: Page): Promise<void> {
  await page.goto("/", { waitUntil: "domcontentloaded" })
  const account = page.getByRole("button", { name: /— open account/ }).first()
  await expect(account).toBeVisible({ timeout: 120_000 })
  await account.click()
  const row = page.getByTestId(`workspace-row:cloud:${state.machineWorkspaceId}`)
  await expect(row, "the machine's workspace is offered in the switcher").toBeVisible({ timeout: 60_000 })
  await row.click()
  await expect(page.getByRole("button", { name: `${state.machineWorkspaceName}, workspace menu` })).toBeVisible({
    timeout: 60_000,
  })
}

/** Sets a flag that a reload or a navigation would wipe. */
async function markWindow(page: Page): Promise<void> {
  await page.evaluate(() => {
    ;(window as unknown as { __sho488NoReload?: string }).__sho488NoReload = "set"
  })
}

async function windowSurvived(page: Page): Promise<boolean> {
  return page.evaluate(
    () => (window as unknown as { __sho488NoReload?: string }).__sho488NoReload === "set",
  )
}

test("a message sent on the machine appears in the open cloud channel, with no reload", async ({ page }) => {
  const seeded = state.seeds.machine
  await openMachineWorkspace(page)
  await page.goto(`/c/${seeded.channelId}`, { waitUntil: "domcontentloaded" })
  await expect(page.getByText(seeded.messageTexts[0]).first()).toBeVisible({ timeout: 60_000 })

  await markWindow(page)

  // Written on the machine, through the machine's own API: the studio never
  // hears about it except over the push channel.
  const text = `from the desktop ${Date.now()}`
  const sent = await page.request.post(
    `${state.localApiBase}/api/conversations/${encodeURIComponent(seeded.channelId)}/messages`,
    {
      headers: { cookie: state.localCookies, origin: state.localApiBase },
      data: { text },
    },
  )
  expect(sent.status(), await sent.text()).toBeLessThan(300)

  await expect(page.getByText(text).first(), "the machine's message reached the open channel").toBeVisible({
    timeout: 60_000,
  })
  expect(await windowSurvived(page), "the message arrived without a reload").toBe(true)
})

test("a turn started in the cloud streams into the open chat view, with no reload", async ({ page }) => {
  await openMachineWorkspace(page)
  await markWindow(page)

  const tag = `ui${Date.now() % 100_000}`
  const composer = page.getByRole("textbox").last()
  await expect(composer).toBeVisible({ timeout: 60_000 })
  await composer.click()
  await composer.fill(`Stream it ${marker("long", tag, 60, { ms: 25 })}`)
  await page.keyboard.press("Enter")

  // The last token of the turn, rendered while the page stayed put.
  await expect(page.getByText(token(tag, 60), { exact: false }).first(), "the turn streamed to the end").toBeVisible({
    timeout: 120_000,
  })
  expect(await windowSurvived(page), "the turn streamed without a reload").toBe(true)
})
