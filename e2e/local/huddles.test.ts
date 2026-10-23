// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Huddles between real people through a real LiveKit server: start and join
 * in a channel (through the pre-join preview), hear each other, camera and
 * screen share, ringing in a DM (decline, then answer), the system messages
 * left behind, and a three-person call: a third person rung in mid-call
 * without being in the channel, the call minimized to a floating card, a
 * reaction reaching everyone, a link knock that the host admits, and the call
 * chat: two people chat in their DM, and once a third (who is not in that DM)
 * is rung in everyone moves to the group of exactly those three, where the
 * newcomer can write, run a poll and vote.
 *
 * Needs the local API started with LIVEKIT_URL / LIVEKIT_API_KEY /
 * LIVEKIT_API_SECRET (LiveKit Cloud, or `livekit-server --dev`); skipped
 * otherwise. The second person is written to the stack's database, so set
 * E2E_LOCAL_DATABASE_URL when running against your own stack (defaults to the
 * database E2E_LOCAL_START_STACK creates).
 *
 * Chromium's fake devices stand in for the mic and camera; screen capture is
 * a canvas, since headless Chromium has no screen picker.
 */
import { execFileSync } from "child_process"
import { resolve } from "path"
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test"
import { LOCAL_API_BASE } from "./helpers"
import { activateTeamWorkspace, api, signIn, teamWorkspaceId } from "./team-nav-seed"

const REPO = resolve(__dirname, "../..")
const DATABASE_URL = process.env.E2E_LOCAL_DATABASE_URL || `file:${resolve(REPO, "test-results/e2e-local.db")}`
const SECOND = { email: "huddle-partner@example.com", password: "huddle-partner-pass", name: "Bea Partner" }
const THIRD = { email: "huddle-third@example.com", password: "huddle-third-pass", name: "Cy Third" }

test.use({
  launchOptions: { args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] },
  permissions: ["microphone", "camera"],
})
test.describe.configure({ mode: "serial" })

type Person = typeof SECOND

function seedPerson(person: Person): { userId: string; workspaceId: string } {
  const out = execFileSync("bun", ["--no-env-file", resolve(__dirname, "huddle-seed-user.ts"), person.email, person.password, person.name], {
    cwd: REPO,
    env: { ...process.env, DATABASE_URL },
    encoding: "utf8",
  })
  return JSON.parse(out.trim().split("\n").pop()!)
}

/** A screen to share: an animated canvas, since headless Chromium has no picker. */
async function fakeScreen(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    if (!navigator.mediaDevices) return
    navigator.mediaDevices.getDisplayMedia = async () => {
      const canvas = document.createElement("canvas")
      canvas.width = 640
      canvas.height = 360
      const g = canvas.getContext("2d")!
      let frame = 0
      setInterval(() => {
        g.fillStyle = "#3366cc"
        g.fillRect(0, 0, 640, 360)
        g.fillStyle = "#fff"
        g.font = "40px sans-serif"
        g.fillText(`shared screen ${frame++}`, 40, 180)
      }, 66)
      return canvas.captureStream(15)
    }
  })
}

async function personPage(browser: Browser, workspaceId: string, person: Person = SECOND): Promise<Page> {
  const context = await browser.newContext({ permissions: ["microphone", "camera"] })
  await fakeScreen(context)
  const signedIn = await context.request.post(`${LOCAL_API_BASE}/api/auth/sign-in/email`, {
    data: { email: person.email, password: person.password },
  })
  expect(signedIn.ok(), await signedIn.text()).toBe(true)
  await context.request.post(`${LOCAL_API_BASE}/api/onboarding/complete`)
  const page = await context.newPage()
  await activateTeamWorkspace(page, workspaceId)
  return page
}

async function playingVideo(page: Page, source: "camera" | "screen") {
  await expect
    .poll(
      () =>
        page.evaluate(
          (s) => Array.from(document.querySelectorAll<HTMLVideoElement>(`[data-testid=huddle-video-${s}]`)).some((v) => v.videoWidth > 0 && !v.paused),
          source,
        ),
      { timeout: 30_000 },
    )
    .toBe(true)
}

async function remoteAudioElements(page: Page): Promise<number> {
  return page.evaluate(() => Array.from(document.querySelectorAll("audio")).filter((a) => (a.srcObject as MediaStream | null)?.getAudioTracks().length).length)
}

let workspaceId: string
let partnerId: string
let channelId: string
let dmId: string
let partner: Page
let third: Page
let thirdId: string
/** A private channel with only the host and Bea in it. Cy is in the workspace but not here. */
let privateId: string

/** Channel huddles open a pre-join preview first; join from it. */
async function joinFromPreview(page: Page) {
  const preview = page.getByTestId("huddle-prejoin")
  await expect(preview).toBeVisible({ timeout: 15_000 })
  await preview.getByRole("button", { name: "Join huddle" }).click()
  await expect(preview).toHaveCount(0)
}

test.beforeAll(async ({ browser }) => {
  test.setTimeout(240_000)
  const page = await browser.newPage()
  await signIn(page)
  workspaceId = await teamWorkspaceId(page)
  const enabled = await api(page, "GET", `/api/workspaces/${workspaceId}/huddles`)
  test.skip(!enabled.json?.enabled, "huddles need LIVEKIT_URL, LIVEKIT_API_KEY and LIVEKIT_API_SECRET on the local API")

  partnerId = seedPerson(SECOND).userId
  thirdId = seedPerson(THIRD).userId
  const suffix = Date.now().toString(36)
  const channel = await api(page, "POST", `/api/workspaces/${workspaceId}/conversations`, {
    name: `huddle-${suffix}`,
    kind: "public",
    memberUserIds: [partnerId],
  })
  channelId = channel.json?.conversation?.id
  const dm = await api(page, "POST", `/api/workspaces/${workspaceId}/dms`, { userIds: [partnerId] })
  dmId = dm.json?.conversation?.id
  const priv = await api(page, "POST", `/api/workspaces/${workspaceId}/conversations`, {
    name: `huddle-3p-${suffix}`,
    kind: "private",
    memberUserIds: [partnerId],
  })
  privateId = priv.json?.conversation?.id
  expect(channelId && dmId && privateId, JSON.stringify({ channel: channel.json, dm: dm.json, priv: priv.json })).toBeTruthy()

  partner = await personPage(browser, workspaceId, SECOND)
  third = await personPage(browser, workspaceId, THIRD)
  // The DM is reused across runs; a crashed run can leave a huddle live in it.
  await leaveAll(page)
  await page.close()
})

/** Leave both huddles as both people, so a failed test can't leave a call live for the next one. */
async function leaveAll(page: Page) {
  for (const who of [page, partner]) {
    for (const id of [channelId, dmId, privateId]) await api(who, "POST", `/api/conversations/${id}/huddle/leave`)
  }
  for (const id of [channelId, dmId, privateId]) await api(third, "POST", `/api/conversations/${id}/huddle/leave`)
}

test.afterEach(async ({ page }) => {
  await leaveAll(page)
})

test.afterAll(async () => {
  await partner?.context().close()
  await third?.context().close()
})

test("two people talk in a channel huddle, with camera and screen share", async ({ page }) => {
  test.setTimeout(180_000)
  await fakeScreen(page.context())
  await activateTeamWorkspace(page, workspaceId)
  await signIn(page)
  await page.goto(`/c/${channelId}`)
  await partner.goto(`/c/${channelId}`)

  await page.getByRole("button", { name: "Start a huddle" }).click()
  await joinFromPreview(page)
  await expect(page.getByText("In a huddle · waiting for others")).toBeVisible({ timeout: 30_000 })
  await expect(partner.getByText("Huddle live · 1 person")).toBeVisible({ timeout: 15_000 })
  await expect(page.getByText(/started a huddle$/).first()).toBeVisible()

  await partner.getByTestId("huddle-banner").getByRole("button", { name: "Join huddle" }).click()
  await joinFromPreview(partner)
  await expect(page.getByText(`In a huddle with ${SECOND.name}`)).toBeVisible({ timeout: 30_000 })
  await expect(partner.getByText(/In a huddle with Local User/)).toBeVisible({ timeout: 30_000 })
  await expect.poll(() => remoteAudioElements(page), { timeout: 20_000 }).toBe(1)
  await expect.poll(() => remoteAudioElements(partner), { timeout: 20_000 }).toBe(1)

  // The call floats over the chat as a card; the camera is one tap there.
  await page.getByTestId("huddle-mini").getByRole("button", { name: "Turn on camera" }).click()
  await playingVideo(partner, "camera")
  // Sharing a screen is on the full call view.
  await partner.getByRole("button", { name: "Expand huddle" }).click()
  await partner.getByTestId("huddle-expanded").getByRole("button", { name: "Share screen" }).click()
  await page.getByRole("button", { name: "Expand huddle" }).click()
  await playingVideo(page, "screen")
  await expect(page.getByLabel(`${SECOND.name} is sharing a screen`)).toBeVisible()

  await partner.getByTestId("huddle-expanded").getByRole("button", { name: "Stop sharing" }).click()
  await expect(page.locator("[data-testid=huddle-video-screen]")).toHaveCount(0, { timeout: 15_000 })

  await partner.getByTestId("huddle-expanded").getByRole("button", { name: "Leave huddle" }).click()
  await expect(page.getByText("In a huddle · waiting for others")).toBeVisible({ timeout: 15_000 })
  await expect.poll(() => remoteAudioElements(page), { timeout: 15_000 }).toBe(0)
  await page.getByRole("button", { name: "Leave huddle" }).first().click()
  await expect(page.getByText(/started a huddle · lasted/).first()).toBeVisible({ timeout: 15_000 })
  await expect(partner.getByTestId("huddle-banner")).toHaveCount(0)
})

test("a DM huddle rings the other person, who can decline or answer from anywhere", async ({ page }) => {
  test.setTimeout(180_000)
  await activateTeamWorkspace(page, workspaceId)
  await signIn(page)
  await page.goto(`/c/${dmId}`)
  await partner.goto(`/c/${channelId}`)
  await expect(partner.getByPlaceholder(/Message #huddle-/)).toBeVisible({ timeout: 30_000 })

  await page.getByRole("button", { name: "Start a huddle" }).click()
  await expect(page.getByText(`Calling ${SECOND.name}…`)).toBeVisible({ timeout: 30_000 })
  const ringer = partner.getByTestId("huddle-ringer")
  await expect(ringer).toBeVisible({ timeout: 15_000 })
  await expect(ringer).toContainText("Local User")
  await partner.getByRole("button", { name: "Decline huddle" }).click()
  await expect(ringer).toHaveCount(0)
  await expect(page.getByText(`${SECOND.name} declined`)).toBeVisible({ timeout: 15_000 })
  await expect(page.getByText(/Missed huddle from/).first()).toBeVisible({ timeout: 15_000 })

  await page.getByRole("button", { name: `${SECOND.name} declined. Dismiss` }).click()
  await page.getByRole("button", { name: "Start a huddle" }).click()
  await expect(ringer).toBeVisible({ timeout: 15_000 })
  await partner.getByRole("button", { name: "Answer huddle" }).click()
  await expect(page.getByText(`In a huddle with ${SECOND.name}`)).toBeVisible({ timeout: 30_000 })
  // Answered from another conversation, the call follows them there as a floating card.
  await expect(partner.getByTestId("huddle-mini")).toBeVisible({ timeout: 30_000 })

  await partner.getByTestId("huddle-mini").getByRole("button", { name: "Leave huddle" }).click()
  await page.getByRole("button", { name: "Leave huddle" }).first().click()
  await expect(page.getByText(/started a huddle · lasted/).first()).toBeVisible({ timeout: 15_000 })
})

test("a third person is rung in mid-call without joining the channel; the call minimizes to a card and reactions reach everyone", async ({ page }) => {
  test.setTimeout(240_000)
  await activateTeamWorkspace(page, workspaceId)
  await signIn(page)
  await page.goto(`/c/${privateId}`)
  await partner.goto(`/c/${privateId}`)
  await third.goto("/")

  await page.getByRole("button", { name: "Start a huddle" }).click()
  await joinFromPreview(page)
  await partner.getByTestId("huddle-banner").getByRole("button", { name: "Join huddle" }).click()
  await joinFromPreview(partner)
  await expect(page.getByText(`In a huddle with ${SECOND.name}`)).toBeVisible({ timeout: 30_000 })

  // Add Cy from the full call view.
  await page.getByRole("button", { name: "Expand huddle" }).click()
  await page.getByTestId("huddle-expanded").getByRole("button", { name: "Add people" }).click()
  const sheet = page.getByTestId("huddle-invite-sheet")
  await sheet.getByLabel("Search people").fill("Cy")
  await sheet.getByRole("checkbox", { name: new RegExp(THIRD.name) }).click()
  await sheet.getByRole("button", { name: "Ring 1 person" }).click()
  await expect(page.getByTestId(`huddle-tile-${thirdId}`)).toContainText("Ringing", { timeout: 15_000 })

  // Cy is not in the channel, yet the ring arrives and answering puts them in the call.
  const ringer = third.getByTestId("huddle-ringer")
  await expect(ringer).toBeVisible({ timeout: 20_000 })
  await expect(ringer).toContainText("huddle-3p")
  await third.getByRole("button", { name: "Answer huddle" }).click()
  await expect(third.getByTestId("huddle-mini")).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId(`huddle-tile-${thirdId}`)).not.toContainText("Ringing", { timeout: 30_000 })
  expect((await api(third, "GET", `/api/conversations/${privateId}`)).status).toBeGreaterThanOrEqual(400)

  // Minimize: the call becomes a card that stays over the chat.
  await page.getByRole("button", { name: "Minimize to a floating card" }).click()
  await expect(page.getByTestId("huddle-mini")).toBeVisible()
  await expect(page.getByTestId("huddle-expanded")).toHaveCount(0)
  await expect(page.getByPlaceholder(/Message #huddle-3p-/)).toBeVisible()

  // A reaction from Cy floats over the card for the host and for Bea.
  await third.getByTestId("huddle-mini").getByRole("button", { name: "Send a reaction" }).click()
  await third.getByRole("button", { name: "React 🎉" }).click()
  await expect(page.getByLabel(`${THIRD.name} reacted 🎉`)).toBeVisible({ timeout: 15_000 })
  await expect(partner.getByLabel(`${THIRD.name} reacted 🎉`)).toBeVisible({ timeout: 15_000 })

  // A raised hand shows on the host's full view.
  await third.getByTestId("huddle-mini").getByRole("button", { name: "Raise hand" }).click()
  await page.getByTestId("huddle-mini").getByRole("button", { name: "Expand huddle" }).click()
  await expect(page.getByTestId(`huddle-hand-${thirdId}`)).toBeVisible({ timeout: 15_000 })

  // The host removes Cy from the call.
  await page.getByTestId(`huddle-tile-${thirdId}`).getByRole("button", { name: `More for ${THIRD.name}` }).click()
  await page.getByRole("menuitem", { name: /Remove/ }).click()
  await expect(third.getByTestId("huddle-window")).toHaveCount(0, { timeout: 20_000 })
})

test("someone outside the channel opens the huddle link, knocks, and the host lets them in", async ({ page }) => {
  test.setTimeout(180_000)
  await activateTeamWorkspace(page, workspaceId)
  await signIn(page)
  await page.goto(`/c/${privateId}`)

  await page.getByRole("button", { name: "Start a huddle" }).click()
  await joinFromPreview(page)
  await expect(page.getByText("In a huddle · waiting for others")).toBeVisible({ timeout: 30_000 })
  const link = await api(page, "POST", `/api/conversations/${privateId}/huddle/link`)
  expect(link.json?.token, JSON.stringify(link.json)).toBeTruthy()

  await third.goto(`/huddle/join/${link.json.token}`)
  await expect(third.getByText(/in the call/)).toBeVisible({ timeout: 30_000 })
  await third.getByRole("button", { name: "Ask to join" }).click()
  await expect(third.getByText("Asking to join…")).toBeVisible()

  const request = page.getByTestId("huddle-request-strip")
  await expect(request).toContainText(THIRD.name, { timeout: 20_000 })
  await request.getByRole("button", { name: `Admit ${THIRD.name}` }).click()
  await expect(third.getByTestId("huddle-window")).toBeVisible({ timeout: 30_000 })
  await expect(page.getByText(`In a huddle with ${THIRD.name}`)).toBeVisible({ timeout: 30_000 })
  // They are in the call, not the channel.
  expect((await api(third, "GET", `/api/conversations/${privateId}`)).status).toBeGreaterThanOrEqual(400)

  // Declined people stay out: a second knock is refused.
  await third.getByTestId("huddle-window").getByRole("button", { name: "Leave huddle" }).click()
  await third.goto(`/huddle/join/${link.json.token}`)
  await third.getByRole("button", { name: "Ask to join" }).click()
  await page.getByTestId("huddle-request-strip").getByRole("button", { name: `Deny ${THIRD.name}` }).click()
  await expect(third.getByText("You weren't let in")).toBeVisible({ timeout: 20_000 })
})

test("the call chat is the DM for two people, and moves to a group with the newcomer when a third joins", async ({ page }) => {
  test.setTimeout(240_000)
  await activateTeamWorkspace(page, workspaceId)
  await signIn(page)
  await page.goto(`/c/${dmId}`)
  await partner.goto("/")
  await third.goto("/")

  // Host calls Bea in their DM and Bea answers.
  await page.getByRole("button", { name: "Start a huddle" }).click()
  await partner.getByRole("button", { name: "Answer huddle" }).click()
  await expect(page.getByText(`In a huddle with ${SECOND.name}`)).toBeVisible({ timeout: 30_000 })
  await page.getByRole("button", { name: "Expand huddle" }).click()
  await partner.getByRole("button", { name: "Expand huddle" }).click()

  // With two people the call chat is the DM thread.
  await page.getByTestId("huddle-expanded").getByRole("button", { name: "Show huddle chat" }).click()
  await page.getByLabel("Huddle message").fill("hello from the DM")
  await page.getByRole("button", { name: "Send", exact: true }).click()
  await expect(page.getByTestId("huddle-chat-pane").getByText("hello from the DM")).toBeVisible({ timeout: 15_000 })
  await partner.getByTestId("huddle-expanded").getByRole("button", { name: "Show huddle chat" }).click()
  await expect(partner.getByTestId("huddle-chat-pane").getByText("hello from the DM")).toBeVisible({ timeout: 15_000 })
  await expect(page.getByTestId("huddle-chat-group-note")).toHaveCount(0)
  const dmChat = await api(page, "GET", `/api/conversations/${dmId}/huddle/chat`)
  expect(dmChat.json?.chat).toMatchObject({ conversationId: dmId, moved: false })

  // Ring Cy, who is not in the DM, and let them in.
  await page.getByTestId("huddle-expanded").getByRole("button", { name: "Add people" }).click()
  const sheet = page.getByTestId("huddle-invite-sheet")
  await sheet.getByLabel("Search people").fill("Cy")
  await sheet.getByRole("checkbox", { name: new RegExp(THIRD.name) }).click()
  await sheet.getByRole("button", { name: "Ring 1 person" }).click()
  await third.getByRole("button", { name: "Answer huddle" }).click()
  await expect(third.getByTestId("huddle-mini")).toBeVisible({ timeout: 30_000 })
  expect((await api(third, "GET", `/api/conversations/${dmId}`)).status).toBeGreaterThanOrEqual(400)

  // Everyone's chat moves to the same group of the three of them.
  await third.getByRole("button", { name: "Expand huddle" }).click()
  await third.getByTestId("huddle-expanded").getByRole("button", { name: "Show huddle chat" }).click()
  for (const who of [page, partner, third]) {
    await expect(who.getByTestId("huddle-chat-group-note")).toHaveText("Chatting with the 3 people in this call", { timeout: 20_000 })
  }
  const groups = await Promise.all([page, partner, third].map((who) => api(who, "GET", `/api/conversations/${dmId}/huddle/chat`)))
  const groupId = groups[0]!.json?.chat?.conversationId
  expect(groupId && groupId !== dmId).toBeTruthy()
  for (const g of groups) expect(g.json?.chat).toMatchObject({ conversationId: groupId, kind: "group_dm", moved: true })

  // Cy writes without an error, and the others read it.
  await third.getByLabel("Huddle message").fill("hi, Cy here")
  await third.getByRole("button", { name: "Send", exact: true }).click()
  await expect(third.getByTestId("huddle-chat-pane").getByText("hi, Cy here")).toBeVisible({ timeout: 15_000 })
  await expect(page.getByTestId("huddle-chat-pane").getByText("hi, Cy here")).toBeVisible({ timeout: 15_000 })
  await expect(partner.getByTestId("huddle-chat-pane").getByText("hi, Cy here")).toBeVisible({ timeout: 15_000 })

  // Cy runs a poll and the host votes on it.
  const pane = third.getByTestId("huddle-chat-pane")
  await pane.getByRole("button", { name: "Start a poll" }).click()
  await pane.getByLabel("Poll question").fill("Ship it?")
  await pane.getByLabel("Poll option 1").fill("Yes")
  await pane.getByLabel("Poll option 2").fill("No")
  await pane.getByText("Post poll").click()
  const hostPoll = page.getByTestId("huddle-chat-pane").getByTestId("poll-card")
  await expect(hostPoll).toContainText("Ship it?", { timeout: 15_000 })
  await hostPoll.getByRole("radio", { name: /^Yes/ }).click()
  await expect(third.getByTestId("huddle-chat-pane").getByTestId("poll-card")).toContainText("1 person has voted", { timeout: 15_000 })

  // "Open conversation" takes Cy to the group they can read, not to the DM they can't.
  await third.getByTestId("huddle-expanded").getByRole("button", { name: "Open conversation" }).click()
  await expect(third).toHaveURL(new RegExp(`/c/${groupId}`), { timeout: 15_000 })
  await expect(third.getByText("hi, Cy here").first()).toBeVisible({ timeout: 15_000 })

  // The earlier DM is untouched by the group conversation.
  const dmMessages = await api(page, "GET", `/api/conversations/${dmId}/messages`)
  expect(JSON.stringify(dmMessages.json)).not.toContain("hi, Cy here")
})
