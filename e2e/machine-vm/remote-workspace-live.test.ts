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
 * CI runs this in the `rbac-live` job's "machine workspace UI" leg.
 * It needs the web build and Playwright's Chromium, so it is not part of the
 * per-file API loop.
 */
import { expect, test, type APIRequestContext, type Page } from "@playwright/test"
import { marker, token } from "../../apps/desktop/e2e/streaming/fake-llm-server"
import { signSharedFileToken } from "../../apps/api/src/lib/shared-file-token"

interface Seeded {
  tag: string
  projectNames: string[]
  channelId: string
  channelName: string
  messageTexts: string[]
  threadRootId: string
  replyText: string
  /** The workspace-scoped chat a person types into (`/agent?chatSessionId=`). */
  workspaceChatId: string
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
  /** The `BETTER_AUTH_SECRET` both processes were started with (stack state). */
  shareSecret: string
  seeds: { cloud: Seeded; machine: Seeded }
}

let state: StackState

// Each case opens its own page, so one red case does not hide the others.
test.describe.configure({ mode: "default" })

test.beforeAll(async ({ request }) => {
  state = await (await request.get("/__stack/state")).json()
  await wakeMachine(request)
})

/**
 * Ask the paired computer for its tunnel, and wait until it has one.
 *
 * A desktop holds no tunnel while nobody is using it: it polls at `nextPollIn`
 * (60 s idle) and opens the WS only when a request marks it. That is what the
 * Studio's instance picker does when a person picks the machine, and what the
 * API suite does before it touches a hosted workspace (`warmHostTunnel`). A
 * browser case that skipped it raced that idle poll: the first turn was answered
 * `host_offline` — the message is queued for when the machine is back — long
 * before the computer had any reason to wake, which says nothing about the UI
 * these cases exist to check.
 */
async function wakeMachine(request: APIRequestContext): Promise<void> {
  const headers = { cookie: state.cookies, origin: state.cloud }
  const asked = await request.post(`${state.cloud}/api/instances/${state.machineId}/request-connect`, { headers })
  expect(asked.status(), await asked.text()).toBeLessThan(300)

  const deadline = Date.now() + 180_000
  while (Date.now() < deadline) {
    const res = await request.get(`${state.cloud}/api/instances/${state.machineId}`, { headers })
    const body = await res.json().catch(() => ({}))
    if (body?.status === "online") return
    await new Promise((r) => setTimeout(r, 2_000))
  }
  throw new Error("the paired computer never opened its tunnel")
}

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
  await expect(account, "the studio's sidebar offers the account menu").toBeVisible({ timeout: 60_000 })
  await account.click()
  const row = page.getByTestId(`workspace-row:cloud:${state.machineWorkspaceId}`)
  await expect(row, "the machine's workspace is offered in the switcher").toBeVisible({ timeout: 60_000 })
  await row.click()
  await expect(page.getByRole("button", { name: `${state.machineWorkspaceName}, workspace menu` })).toBeVisible({
    timeout: 60_000,
  })
}

/**
 * Opens the machine's channel. A phone has no sidebar and no workspace switcher
 * (measured: the phone shell renders the companion home with only "Shogo profile
 * and settings", "Chats" and "Notifications"), but a channel URL carries its own
 * workspace, so the phone goes straight there — the same link a person taps.
 */
async function openMachineChannel(page: Page, phone: boolean): Promise<void> {
  const channelId = state.seeds.machine.channelId
  if (phone) {
    await page.goto(`/c/${channelId}`, { waitUntil: "domcontentloaded" })
    return
  }
  await openMachineWorkspace(page)
  await page.goto(`/c/${channelId}`, { waitUntil: "domcontentloaded" })
}

/**
 * The phone could not address a paired computer's workspace.
 *
 * Measured on this stack before SHO-494: a cold `/agent?workspace=<id>` load
 * resolved to the companion's own space ("This is your Personal space"), so a
 * turn typed there ran on the cloud and the machine never streamed. The cause
 * was that only the **web sidebar** adopted `?workspace=` — a phone has no
 * sidebar, so nothing did. The shell adopts it now
 * (`apps/mobile/hooks/useWorkspaceParamAdoption`), and the cases below run on
 * both viewports: a phone opens the link, wide web opens the workspace the way
 * the sidebar does.
 */

/**
 * Where a turn is typed: the workspace chat.
 *
 * Wide web reaches it the way the sidebar does — select the machine's
 * workspace, then the chat it lands on. A phone has no workspace switcher, so
 * it opens the link a person would be sent, which names the workspace and the
 * session: `/agent?workspace=<id>&chatSessionId=<id>` (SHO-494).
 */
async function openMachineChat(page: Page, phone = false): Promise<void> {
  if (phone) {
    await page.goto(
      `/agent?chatSessionId=${encodeURIComponent(state.seeds.machine.workspaceChatId)}` +
        `&workspace=${encodeURIComponent(state.machineWorkspaceId)}`,
      { waitUntil: "domcontentloaded" },
    )
    return
  }
  await openMachineWorkspace(page)
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

// Measured on this stack (17:03, port 8795): the machine accepts the write
// (the API answers 2xx), the cloud's socket delivers the event — the API suite
// `remote workspace · team chat` asserts exactly that and passes — and the open
// channel never paints the message. Not a reload in the way: the window flag is
// still set and the seeded messages were on screen the whole time. That is the
// "it only shows up after a refresh" bug this layer exists to catch.
//
// Recorded as `test.fail` while SHO-486 was open. That card (#2139) publishes the
// bus event from the machine-sync insert point, and the case now paints on both
// viewports — measured: chromium 2/2 in isolation and the Pixel 7 project, after
// a run on the pre-merge head where it did not. Asserted as the requirement
// again, so a regression here is red rather than expected.
test("a message sent on the machine appears in the open cloud channel, with no reload", async ({ page }, testInfo) => {
  const seeded = state.seeds.machine
  await openMachineChannel(page, testInfo.project.name === "phone")
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

test("a turn started in the cloud streams into the open chat view, with no reload", async ({ page }, testInfo) => {
  await openMachineChat(page, testInfo.project.name === "phone")
  await markWindow(page)

  const tag = `ui${Date.now() % 100_000}`
  await startTurn(page, `Stream it ${marker("long", tag, 60, { ms: 25 })}`, testInfo.project.name === "phone")

  // The last token of the turn, rendered while the page stayed put.
  await expect(page.getByText(token(tag, 60), { exact: false }).first(), "the turn streamed to the end").toBeVisible({
    timeout: 120_000,
  })
  expect(await windowSurvived(page), "the turn streamed without a reload").toBe(true)
})

/** Types into the open chat and sends, leaving the turn streaming on the machine. */
async function startTurn(page: Page, text: string, phone = false): Promise<void> {
  const composer = page.getByRole("textbox").last()
  await expect(composer, "the chat offers a composer").toBeVisible({ timeout: 60_000 })
  await composer.click()
  await composer.fill(text)
  // A phone sends with the button: its keyboard's return key types a newline,
  // and the shell's composer is the one place that stays true on the web build
  // too (the input's Enter-to-send is the wide composer's).
  if (phone) {
    await page.getByRole("button", { name: "Send message" }).click()
    return
  }
  await page.keyboard.press("Enter")
}

/**
 * The app's own model-error banner. The stack's scripted model is a plain
 * OpenAI-compatible server; when its call is refused the app says so and no turn
 * exists to watch, which is a failing stack rather than a failing workspace.
 */
function modelRefused(page: Page) {
  return page.getByText(/model provider rejected/i).first()
}

/** Waits for a turn to be running, or skips when the stack's model refused. */
async function awaitTurnOrSkip(page: Page, what: string): Promise<void> {
  const streaming = page.getByTestId("stop-streaming")
  const refused = modelRefused(page)
  await expect(streaming.or(refused).first(), `${what} started`).toBeVisible({ timeout: 90_000 })
  if (await refused.isVisible().catch(() => false)) {
    test.skip(true, "the stack's scripted model refused this turn (no turn to watch)")
  }
}

// The activity feed's poll follows what the screen can see (`useAgentActivity`:
// 5 s while it shows a run, 30 s idle) and a freshly mounted screen makes one
// confirm ask 5 s after it mounts, so a row can be a few seconds behind the
// turn; the budget covers that confirm ask plus a cold snapshot.
test("the activity row appears while a machine turn runs, and clears when it ends", async ({ page }, testInfo) => {
  await openMachineChat(page, testInfo.project.name === "phone")
  // ~24 s of tokens: long enough that the feed has to report it still running.
  const tag = `ac${Date.now() % 100_000}`
  await startTurn(page, `Activity ${marker("long", tag, 400, { ms: 60 })}`, testInfo.project.name === "phone")
  // The turn really is running here: the composer shows its stop button while
  // the machine streams.
  await awaitTurnOrSkip(page, "the machine turn")

  await page.goto(`/activity?workspace=${encodeURIComponent(state.machineWorkspaceId)}`, {
    waitUntil: "domcontentloaded",
  })
  const running = page.getByTestId("running-now")
  await expect(running, "the running turn is in the activity feed").toBeVisible({ timeout: 60_000 })
  await expect(running).toContainText(/running/i)

  // …and it leaves when the turn ends, without a reload.
  await expect(running, "the row clears once the turn is done").toBeHidden({ timeout: 180_000 })
})

test("a message queued mid-turn shows in the composer's queue and runs after the turn", async ({ page }, testInfo) => {
  await openMachineChat(page, testInfo.project.name === "phone")
  const tag = `qu${Date.now() % 100_000}`
  // ~30 s of tokens, so there is room to queue a second message behind it.
  await startTurn(page, `First ${marker("long", tag, 500, { ms: 60 })}`, testInfo.project.name === "phone")
  await awaitTurnOrSkip(page, "the first turn")

  const queued = marker("long", `${tag}q`, 3, { ms: 5 })
  const composer = page.getByRole("textbox").last()
  await composer.click()
  await composer.fill(queued)
  await page.getByRole("button", { name: "Queue message" }).click()

  // Held, not sent: the text left the composer and the row is on screen while
  // the first turn still streams.
  await expect(composer, "the composer handed the text to the queue").toHaveValue("", { timeout: 15_000 })
  await expect(page.getByText(`e2e:long:tag=${tag}q`, { exact: false }).first(), "the queued message shows").toBeVisible({
    timeout: 30_000,
  })
  await expect(page.getByTestId("stop-streaming"), "the first turn was not interrupted").toBeVisible()

  // …and it runs when the first turn ends.
  await expect(page.getByText(token(`${tag}q`, 3), { exact: false }).first(), "the queued turn ran").toBeVisible({
    timeout: 180_000,
  })
})

/**
 * Russell, reported 2026-11-21: "closing the app and reopening a chat while it
 * streams shows it stuck until done." The old page is gone, so this case is
 * about what a *new* window paints on its own: the partial reply as it stands,
 * then the rest of the tokens as they are produced, then the finished reply
 * once. Nothing here reloads the new page — if it needed one, the reply would
 * not move past what it painted first.
 */
test("closing the app mid-stream and reopening that chat paints the partial reply, keeps streaming and ends once", async ({
  page,
  context,
}, testInfo) => {
  await openMachineChat(page, testInfo.project.name === "phone")
  // The chat this case closes and reopens, addressed the way the sidebar does
  // (`?chatSessionId=`), so the reopened window is the same conversation and not
  // whatever the shell picks as its default.
  const chatUrl =
    `/agent?chatSessionId=${encodeURIComponent(state.seeds.machine.workspaceChatId)}` +
    `&workspace=${encodeURIComponent(state.machineWorkspaceId)}`
  await page.goto(chatUrl, { waitUntil: "domcontentloaded" })
  const tag = `re${Date.now() % 100_000}`
  const n = 300
  // ~15 s of tokens: the window below has to reopen while this is still running.
  await startTurn(page, `Long ${marker("long", tag, n, { ms: 50 })}`, testInfo.project.name === "phone")
  await awaitTurnOrSkip(page, "the long turn")
  // Part of the reply is already painted in the window that is about to close.
  await expect(page.getByText(token(tag, 3), { exact: false }).first(), "the turn started painting").toBeVisible({
    timeout: 60_000,
  })

  // The app is closed: no page survives.
  await page.close()

  // A new window opens on that same chat, mid-stream.
  const reopened = await context.newPage()
  await reopened.goto(chatUrl, { waitUntil: "domcontentloaded" })

  // 1. The partial reply is on screen shortly after the window opens — it is the
  //    reply so far, not an empty chat waiting for the turn to end.
  await expect(
    reopened.getByText(token(tag, 3), { exact: false }).first(),
    "the reopened window painted the reply written so far",
  ).toBeVisible({ timeout: 5_000 + 25_000 })

  // 2. Tokens keep arriving in that window, with no reload of its own.
  await expect(
    reopened.getByText(token(tag, n), { exact: false }).first(),
    "the rest of the reply streamed into the reopened window",
  ).toBeVisible({ timeout: 120_000 })

  // 3. The finished reply is on screen exactly once.
  const painted = await reopened.evaluate(() => document.body.innerText)
  const occurrences = painted.split(token(tag, n)).length - 1
  expect(occurrences, `the finished reply was painted ${occurrences} times`).toBe(1)
})

const machineHeaders = () => ({ cookie: state.localCookies, origin: state.localApiBase })

/** Writes a file into the machine's workspace through its own runtime API. */
async function writeMachineFile(request: APIRequestContext, path: string, content: string): Promise<void> {
  const res = await request.put(
    `${state.localApiBase}/api/workspaces/${encodeURIComponent(state.machineWorkspaceId)}/agent-proxy/agent/workspace/files/${path}`,
    { headers: { ...machineHeaders(), "content-type": "application/json" }, data: { content } },
  )
  expect(res.status(), `write ${path}: ${await res.text()}`).toBeLessThan(300)
}

test("a share_file link from the machine opens as a chip in the cloud channel, not a raw URL", async ({
  page,
  request,
}, testInfo) => {
  const seeded = state.seeds.machine
  const name = `sho488-chip-${Date.now()}.md`
  const path = `.tmp/${name}`
  // Plain text: the viewer renders the file's markdown, so a `#` heading would
  // reach the DOM as the heading's text, not as `# …`.
  const content = `chip payload ${Date.now()}`
  await writeMachineFile(request, path, content)

  // The link a desktop agent's `share_file` result carries: a capability token
  // on the cloud's origin, never the desktop's own address (channel rule SHO-80).
  process.env.BETTER_AUTH_SECRET = state.shareSecret
  const token = signSharedFileToken({
    workspaceId: state.machineWorkspaceId,
    path,
    exp: Math.floor(Date.now() / 1000) + 600,
  })
  const link = `${state.web}/api/f/${token}`

  const posted = await request.post(
    `${state.localApiBase}/api/conversations/${encodeURIComponent(seeded.channelId)}/messages`,
    { headers: machineHeaders(), data: { text: `Saved the notes: ${link}` } },
  )
  expect(posted.status(), await posted.text()).toBeLessThan(300)

  // The channel URL carries its own workspace, so a phone opens it directly —
  // the same link a person taps.
  await openMachineChannel(page, testInfo.project.name === "phone")
  const chip = page.getByText(name, { exact: false }).first()
  await expect(chip, "the link renders as a file chip").toBeVisible({ timeout: 60_000 })
  await expect(page.getByText(/\/api\/f\//), "the raw link is not on screen").toHaveCount(0)

  await chip.click()
  await expect(page.getByTestId("share-file-view"), "the chip opens the file").toBeVisible({ timeout: 60_000 })
  await expect(page.getByTestId("share-file-content")).toContainText(content, { timeout: 60_000 })
})
