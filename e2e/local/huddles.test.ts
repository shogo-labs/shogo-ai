// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Huddles between two real people through a real LiveKit server: start and
 * join in a channel, hear each other, camera and screen share, ringing in a
 * DM (decline, then answer), and the system messages left behind.
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

test.use({
  launchOptions: { args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] },
  permissions: ["microphone", "camera"],
})
test.describe.configure({ mode: "serial" })

function seedSecondPerson(): { userId: string; workspaceId: string } {
  const out = execFileSync("bun", ["--no-env-file", resolve(__dirname, "huddle-seed-user.ts"), SECOND.email, SECOND.password, SECOND.name], {
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

async function partnerPage(browser: Browser, workspaceId: string): Promise<Page> {
  const context = await browser.newContext({ permissions: ["microphone", "camera"] })
  await fakeScreen(context)
  const signedIn = await context.request.post(`${LOCAL_API_BASE}/api/auth/sign-in/email`, {
    data: { email: SECOND.email, password: SECOND.password },
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

test.beforeAll(async ({ browser }) => {
  test.setTimeout(240_000)
  const page = await browser.newPage()
  await signIn(page)
  workspaceId = await teamWorkspaceId(page)
  const enabled = await api(page, "GET", `/api/workspaces/${workspaceId}/huddles`)
  test.skip(!enabled.json?.enabled, "huddles need LIVEKIT_URL, LIVEKIT_API_KEY and LIVEKIT_API_SECRET on the local API")

  partnerId = seedSecondPerson().userId
  const suffix = Date.now().toString(36)
  const channel = await api(page, "POST", `/api/workspaces/${workspaceId}/conversations`, {
    name: `huddle-${suffix}`,
    kind: "public",
    memberUserIds: [partnerId],
  })
  channelId = channel.json?.conversation?.id
  const dm = await api(page, "POST", `/api/workspaces/${workspaceId}/dms`, { userIds: [partnerId] })
  dmId = dm.json?.conversation?.id
  expect(channelId && dmId, JSON.stringify({ channel: channel.json, dm: dm.json })).toBeTruthy()

  partner = await partnerPage(browser, workspaceId)
  // The DM is reused across runs; a crashed run can leave a huddle live in it.
  await leaveAll(page)
  await page.close()
})

/** Leave both huddles as both people, so a failed test can't leave a call live for the next one. */
async function leaveAll(page: Page) {
  for (const who of [page, partner]) {
    for (const id of [channelId, dmId]) await api(who, "POST", `/api/conversations/${id}/huddle/leave`)
  }
}

test.afterEach(async ({ page }) => {
  await leaveAll(page)
})

test.afterAll(async () => {
  await partner?.context().close()
})

test("two people talk in a channel huddle, with camera and screen share", async ({ page }) => {
  test.setTimeout(180_000)
  await fakeScreen(page.context())
  await activateTeamWorkspace(page, workspaceId)
  await signIn(page)
  await page.goto(`/c/${channelId}`)
  await partner.goto(`/c/${channelId}`)

  await page.getByRole("button", { name: "Start a huddle" }).click()
  await expect(page.getByText("In a huddle · waiting for others")).toBeVisible({ timeout: 30_000 })
  await expect(partner.getByText("1 person in a huddle")).toBeVisible({ timeout: 15_000 })
  await expect(page.getByText(/started a huddle$/).first()).toBeVisible()

  await partner.getByRole("button", { name: "Join huddle" }).first().click()
  await expect(page.getByText(`In a huddle with ${SECOND.name}`)).toBeVisible({ timeout: 30_000 })
  await expect(partner.getByText(/In a huddle with Local User/)).toBeVisible({ timeout: 30_000 })
  await expect.poll(() => remoteAudioElements(page), { timeout: 20_000 }).toBe(1)
  await expect.poll(() => remoteAudioElements(partner), { timeout: 20_000 }).toBe(1)

  await page.getByRole("button", { name: "Turn on camera" }).click()
  await playingVideo(partner, "camera")
  await partner.getByRole("button", { name: "Share screen" }).click()
  await playingVideo(page, "screen")
  await expect(page.getByLabel(`${SECOND.name}, sharing screen`)).toBeVisible()

  await partner.getByRole("button", { name: "Stop sharing" }).click()
  await expect(page.locator("[data-testid=huddle-video-screen]")).toHaveCount(0, { timeout: 15_000 })

  await partner.getByRole("button", { name: "Leave huddle" }).first().click()
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
  await expect(partner.getByTestId("huddle-dock")).toBeVisible({ timeout: 30_000 })

  await partner.getByTestId("huddle-dock").getByRole("button", { name: "Leave huddle" }).click()
  await page.getByRole("button", { name: "Leave huddle" }).first().click()
  await expect(page.getByText(/started a huddle · lasted/).first()).toBeVisible({ timeout: 15_000 })
})
