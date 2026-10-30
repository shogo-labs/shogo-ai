// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-257 — Russell: "I should be able to connect to a local machine from the
 * cloud and see all chats all projects everything as if I were connected to a
 * cloud vm."
 *
 * The cloud studio, in a browser, signed in as the machine's owner, on real
 * processes (see `playwright.config.ts`). It opens the machine's workspace from
 * the switcher and uses it the way a person would: its projects, its channel and
 * thread, a message sent from the cloud that lands on the machine, and a chat
 * turn whose tool reads a file that only exists on the machine.
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
  const row = page.getByTestId(`workspace-row:machine:${state.machineId}:${state.machineWorkspaceId}`)
  await expect(row, "the machine's workspace is offered in the switcher").toBeVisible({ timeout: 60_000 })
  await row.click()
  await expect(page.getByRole("button", { name: `${state.machineWorkspaceName}, workspace menu` })).toBeVisible({
    timeout: 60_000,
  })
}

async function desktopChannelTexts(page: Page): Promise<string[]> {
  const res = await page.request.get(
    `${state.localApiBase}/api/conversations/${encodeURIComponent(state.seeds.machine.channelId)}/messages?limit=100`,
    { headers: { cookie: state.localCookies } },
  )
  return ((await res.json()).messages ?? []).map((m: { text: string }) => m.text)
}

test("the machine's projects, and none of the cloud workspace's", async ({ page }) => {
  await openMachineWorkspace(page)
  await page.goto("/projects", { waitUntil: "domcontentloaded" })
  for (const name of state.seeds.machine.projectNames) {
    await expect(page.getByText(name).first()).toBeVisible({ timeout: 60_000 })
  }
  for (const name of state.seeds.cloud.projectNames) {
    await expect(page.getByText(name)).toHaveCount(0)
  }
})

test("the machine's channel, its thread, and a message sent from the cloud that lands on the machine", async ({ page }) => {
  const seeded = state.seeds.machine
  await openMachineWorkspace(page)
  await page.goto(`/c/${seeded.channelId}`, { waitUntil: "domcontentloaded" })
  for (const text of seeded.messageTexts) {
    await expect(page.getByText(text).first()).toBeVisible({ timeout: 60_000 })
  }

  await page.goto(`/c/${seeded.channelId}?thread=${seeded.threadRootId}`, { waitUntil: "domcontentloaded" })
  await expect(page.getByText(seeded.replyText).first()).toBeVisible({ timeout: 60_000 })

  await page.goto(`/c/${seeded.channelId}`, { waitUntil: "domcontentloaded" })
  const text = `sent from the cloud UI ${Date.now()}`
  const composer = page.getByLabel("Message", { exact: true }).first()
  await expect(composer).toBeVisible({ timeout: 60_000 })
  await composer.click()
  await composer.pressSequentially(text)
  await page.keyboard.press("Enter")
  await expect(page.getByText(text).first()).toBeVisible({ timeout: 30_000 })
  await expect.poll(() => desktopChannelTexts(page), { timeout: 30_000 }).toContain(text)
})

test("a chat turn from the cloud runs on the machine and reads the machine's disk", async ({ page }) => {
  const canary = `SHO257-UI-CANARY-${Date.now()}`
  const path = ".tmp/sho257-ui-canary.txt"
  // The file exists only on the machine.
  const relay = `${state.cloud}/api/machines/${state.machineId}/w/${state.machineWorkspaceId}`
  await expect
    .poll(
      async () =>
        (
          await page.request.put(
            `${relay}/api/workspaces/${state.machineWorkspaceId}/agent-proxy/agent/workspace/files/${path}`,
            { headers: { cookie: state.cookies, origin: state.cloud }, data: { content: canary } },
          )
        ).status(),
      { timeout: 120_000, intervals: [2_000] },
    )
    .toBe(200)

  await openMachineWorkspace(page)
  const tag = `ui${Date.now() % 100_000}`
  const composer = page.getByRole("textbox").last()
  await expect(composer).toBeVisible({ timeout: 60_000 })
  await composer.click()
  await composer.fill(`Read it ${marker("tool", tag, 5, { ms: 5, rounds: 1, path })}`)
  await page.keyboard.press("Enter")

  // Tokens before the tool call fold into "Worked for …"; the reply after it is
  // the last segment, ending at token n.
  await expect(page.getByText(token(tag, 5), { exact: false }).first()).toBeVisible({ timeout: 120_000 })
  await expect(page.getByText(/Running on /).first()).toBeVisible()
  const asked = await (await page.request.get(`/__stack/llm?tag=${tag}`)).json()
  expect(asked[0]?.toolCalled).toBe("read_file")
  expect(asked.some((r: { toolResults?: string }) => String(r.toolResults ?? "").includes(canary))).toBe(true)
})
