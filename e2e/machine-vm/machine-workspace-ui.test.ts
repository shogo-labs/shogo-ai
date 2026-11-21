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
  /** Skips the API's per-IP limiter, which one browser trips here but a pod's do not. */
  loadTestKey: string
  seeds: { cloud: Seeded; machine: Seeded }
}

const loadTestHeaders = () => ({ 'x-load-test-key': state.loadTestKey })

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
  // SHO-285: a hosted workspace is a normal cloud row, and its host is named on
  // that row instead of in an in-chat "Running on …" banner (there is no active
  // instance to connect to any more).
  await expect(
    page.getByTestId(`workspace-row-host:cloud:${state.machineWorkspaceId}`),
    "the row names the desktop that hosts it",
  ).toContainText(/Host: /, { timeout: 60_000 })
  await row.click()
  await expect(page.getByRole("button", { name: `${state.machineWorkspaceName}, workspace menu` })).toBeVisible({
    timeout: 60_000,
  })
}

async function desktopChannelTexts(page: Page): Promise<string[]> {
  const res = await page.request.get(
    `${state.localApiBase}/api/conversations/${encodeURIComponent(state.seeds.machine.channelId)}/messages?limit=100`,
    { headers: { cookie: state.localCookies, ...loadTestHeaders() } },
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

/**
 * SHO-486 — Russell: "when I send a message in a channel of a remote workspace
 * I do not see the reply unless I refresh. It works fine for a normal workspace
 * or local workspace."
 *
 * The channel is open in the cloud studio and a reply is written on the desktop
 * (which is how a desktop-run agent answers: the row lands on the machine and
 * reaches Postgres through machine sync). It has to appear on the page as it
 * arrives — no reload, no tab switch.
 */
// The stack relays the page's `/rt` WebSocket through to the cloud
// (`machine-vm-stack.ts`), so what appears on the page here comes over the same
// socket the studio uses — not a poll.
test("a reply written on the machine appears in the open channel without a refresh", async ({ page }) => {
  const seeded = state.seeds.machine
  await openMachineWorkspace(page)
  await page.goto(`/c/${seeded.channelId}`, { waitUntil: "domcontentloaded" })
  const composer = page.getByLabel("Message", { exact: true }).first()
  await expect(composer).toBeVisible({ timeout: 60_000 })
  // The page is live before the reply exists, so nothing below can be a refetch.
  for (const text of seeded.messageTexts) {
    await expect(page.getByText(text).first()).toBeVisible({ timeout: 60_000 })
  }

  const text = `written on the machine ${Date.now()}`
  const posted = await page.request.post(
    `${state.localApiBase}/api/conversations/${encodeURIComponent(seeded.channelId)}/messages`,
    { headers: { cookie: state.localCookies, origin: state.localApiBase, ...loadTestHeaders() }, data: { text } },
  )
  expect(posted.status(), await posted.text()).toBeLessThan(300)

  // Split the two halves of "it shows up": the row has to reach the cloud
  // first (machine sync), and only then can a socket deliver it. Asserting
  // them apart says which one broke instead of just "the text is not there".
  const onCloud = async () => {
    const res = await page.request.get(
      `${state.cloud}/api/conversations/${encodeURIComponent(seeded.channelId)}/messages?limit=50`,
      { headers: { cookie: state.cookies, origin: state.cloud, ...loadTestHeaders() } },
    )
    if (!res.ok()) return `HTTP ${res.status()}`
    const body = await res.json().catch(() => null)
    const rows: any[] = Array.isArray(body?.messages) ? body.messages : Array.isArray(body) ? body : []
    return rows.some((row) => String(row?.text ?? '').includes(text))
  }
  await expect.poll(onCloud, { timeout: 30_000, intervals: [500] }).toBe(true)

  await expect(page.getByText(text).first()).toBeVisible({ timeout: 30_000 })
})

test("a chat turn from the cloud runs on the machine and reads the machine's disk", async ({ page }) => {
  const canary = `SHO257-UI-CANARY-${Date.now()}`
  const path = ".tmp/sho257-ui-canary.txt"
  // The file exists only on the machine.
  // The plain cloud API: a hosted workspace's runtime calls go to its desktop
  // through the host tunnel (SHO-285). There is no relay URL to prefix.
  const relay = state.cloud
  await expect
    .poll(
      async () =>
        (
          await page.request.put(
            `${relay}/api/workspaces/${state.machineWorkspaceId}/agent-proxy/agent/workspace/files/${path}`,
            { headers: { cookie: state.cookies, origin: state.cloud, ...loadTestHeaders() }, data: { content: canary } },
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
  const asked = await (await page.request.get(`/__stack/llm?tag=${tag}`)).json()
  expect(asked[0]?.toolCalled).toBe("read_file")
  expect(asked.some((r: { toolResults?: string }) => String(r.toolResults ?? "").includes(canary))).toBe(true)
})
