// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Huddle notes (SHO-176) through two real browsers and a real LiveKit server:
 * notes are on for everyone by default, every participant is told before they
 * join a call that is being transcribed, anyone in the call can stop them for
 * everyone, turning them back on resumes, and a call nobody spoke in leaves
 * nothing behind — no transcript, no summary in the chat, no notes block.
 *
 * Word-level transcription needs real speech, which Chromium's fake device (a
 * tone) cannot produce; the transcript text, the summary and the metered
 * seconds are covered by the API integration suite (`huddle-notes.integration`).
 * What only a browser can prove is what every participant sees, and that the
 * server invents nothing for a silent call.
 *
 * Needs the local API started with LIVEKIT_URL / LIVEKIT_API_KEY /
 * LIVEKIT_API_SECRET (LiveKit Cloud, or `livekit-server --dev`); skipped
 * otherwise. The second and third people are written to the stack's database,
 * so set E2E_LOCAL_DATABASE_URL when running against your own stack (defaults
 * to the database E2E_LOCAL_START_STACK creates).
 */
import { execFileSync } from "child_process"
import { resolve } from "path"
import { expect, test, type Browser, type Page } from "@playwright/test"
import { LOCAL_API_BASE } from "./helpers"
import { activateTeamWorkspace, api, signIn, teamWorkspaceId } from "./team-nav-seed"

const REPO = resolve(__dirname, "../..")
const DATABASE_URL = process.env.E2E_LOCAL_DATABASE_URL || `file:${resolve(REPO, "test-results/e2e-local.db")}`
const PARTNER = { email: "notes-partner@example.com", password: "notes-partner-pass", name: "Bea Partner" }
const OUTSIDER = { email: "notes-outsider@example.com", password: "notes-outsider-pass", name: "Cy Outsider" }

test.use({
  launchOptions: { args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] },
  permissions: ["microphone", "camera"],
})
test.describe.configure({ mode: "serial" })

function seedPerson(person: typeof PARTNER): { userId: string; workspaceId: string } {
  const out = execFileSync("bun", ["--no-env-file", resolve(__dirname, "huddle-seed-user.ts"), person.email, person.password, person.name], {
    cwd: REPO,
    env: { ...process.env, DATABASE_URL },
    encoding: "utf8",
  })
  return JSON.parse(out.trim().split("\n").pop()!)
}

async function personPage(browser: Browser, workspaceId: string, person: typeof PARTNER): Promise<Page> {
  const context = await browser.newContext({ permissions: ["microphone", "camera"] })
  const signedIn = await context.request.post(`${LOCAL_API_BASE}/api/auth/sign-in/email`, {
    data: { email: person.email, password: person.password },
  })
  expect(signedIn.ok(), await signedIn.text()).toBe(true)
  await context.request.post(`${LOCAL_API_BASE}/api/onboarding/complete`)
  const page = await context.newPage()
  await activateTeamWorkspace(page, workspaceId)
  return page
}

let workspaceId: string
let partnerId: string
let outsiderId: string
let channelId: string
/** A channel the outsider is in, so "was not in this call" is decided by the call, not the channel. */
let sharedId: string
let partner: Page
let outsider: Page

/** Channel huddles open a pre-join preview first; join from it. */
async function joinFromPreview(page: Page) {
  const preview = page.getByTestId("huddle-prejoin")
  await expect(preview).toBeVisible({ timeout: 15_000 })
  await preview.getByRole("button", { name: "Join huddle" }).click()
  await expect(preview).toHaveCount(0)
}

const strip = (page: Page) => page.getByTestId("huddle-banner")
/** The call surface: a floating card or the full window, whichever the device prefers. */
const callWindow = (page: Page) => page.getByTestId("huddle-window")

test.beforeAll(async ({ browser }) => {
  test.setTimeout(240_000)
  const page = await browser.newPage()
  await signIn(page)
  workspaceId = await teamWorkspaceId(page)
  const enabled = await api(page, "GET", `/api/workspaces/${workspaceId}/huddles`)
  test.skip(!enabled.json?.enabled, "huddles need LIVEKIT_URL, LIVEKIT_API_KEY and LIVEKIT_API_SECRET on the local API")

  partnerId = seedPerson(PARTNER).userId
  outsiderId = seedPerson(OUTSIDER).userId
  const suffix = Date.now().toString(36)
  const channel = await api(page, "POST", `/api/workspaces/${workspaceId}/conversations`, {
    name: `notes-${suffix}`,
    kind: "public",
    memberUserIds: [partnerId],
  })
  channelId = channel.json?.conversation?.id
  const shared = await api(page, "POST", `/api/workspaces/${workspaceId}/conversations`, {
    name: `notes-open-${suffix}`,
    kind: "public",
    memberUserIds: [partnerId, outsiderId],
  })
  sharedId = shared.json?.conversation?.id
  expect(channelId && sharedId, JSON.stringify({ channel: channel.json, shared: shared.json })).toBeTruthy()

  partner = await personPage(browser, workspaceId, PARTNER)
  outsider = await personPage(browser, workspaceId, OUTSIDER)
})

async function leaveAll(page: Page) {
  for (const who of [page, partner, outsider]) {
    for (const id of [channelId, sharedId]) await api(who, "POST", `/api/conversations/${id}/huddle/leave`)
  }
}

test.afterEach(async ({ page }) => {
  await leaveAll(page)
  // Which call view opens is remembered per device (huddle-prefs) and the
  // tests below reload, so dropping the stored choice gives each one the default.
  for (const who of [page, partner, outsider]) {
    if (who) await who.evaluate(() => window.localStorage.removeItem("shogo:huddle-prefs")).catch(() => {})
  }
})

test.afterAll(async () => {
  await partner?.context().close()
  await outsider?.context().close()
})

test("notes are on for everyone by default, anyone can stop them, and turning them back on resumes", async ({ page }) => {
  test.setTimeout(180_000)
  await activateTeamWorkspace(page, workspaceId)
  await signIn(page)
  await page.goto(`/c/${sharedId}`)
  await partner.goto(`/c/${sharedId}`)

  await page.getByRole("button", { name: "Start a huddle" }).click()
  // Nobody joins a transcribed call without being told first.
  await expect(page.getByTestId("huddle-notes-notice")).toBeVisible({ timeout: 15_000 })
  await joinFromPreview(page)
  await expect(callWindow(page).getByTestId("huddle-notes-pill")).toContainText("Notes on", { timeout: 30_000 })

  await strip(partner).getByRole("button", { name: "Join huddle" }).click()
  await expect(partner.getByTestId("huddle-notes-notice")).toBeVisible({ timeout: 15_000 })
  await joinFromPreview(partner)
  await expect(page.getByText(`In a huddle with ${PARTNER.name}`)).toBeVisible({ timeout: 30_000 })
  await expect(callWindow(partner).getByTestId("huddle-notes-pill")).toContainText("Notes on", { timeout: 30_000 })

  // Bea stops transcription for the whole call from her own controls.
  await partner.getByRole("button", { name: "Expand huddle" }).click()
  await partner.getByTestId("huddle-expanded").getByRole("button", { name: "Turn notes off for everyone" }).click()
  await expect(partner.getByTestId("huddle-expanded").getByTestId("huddle-notes-pill")).toContainText("Notes off", { timeout: 15_000 })
  expect((await api(partner, "GET", `/api/conversations/${sharedId}/huddle`)).json?.huddle?.notes?.enabled).toBe(false)

  // Everyone is told who stopped it, and the host's own pill follows.
  await page.getByRole("button", { name: "Expand huddle" }).click()
  await expect(page.getByText(new RegExp(`Notes off \\(${PARTNER.name}\\)`)).first()).toBeVisible({ timeout: 20_000 })
  await expect(page.getByTestId("huddle-expanded").getByTestId("huddle-notes-pill")).toContainText("Notes off")

  // Turning them back on resumes for both sides.
  await page.getByTestId("huddle-expanded").getByRole("button", { name: "Turn notes on for everyone" }).click()
  await expect(page.getByTestId("huddle-expanded").getByTestId("huddle-notes-pill")).toContainText("Notes on", { timeout: 15_000 })
  await expect(callWindow(partner).getByTestId("huddle-notes-pill")).toContainText("Notes on", { timeout: 20_000 })
})

test("a huddle nobody spoke in posts no notes, keeps no transcript, and tells nobody who was not there", async ({ page }) => {
  test.setTimeout(180_000)
  await activateTeamWorkspace(page, workspaceId)
  await signIn(page)
  await page.goto(`/c/${sharedId}`)
  await partner.goto(`/c/${sharedId}`)

  await page.getByRole("button", { name: "Start a huddle" }).click()
  await joinFromPreview(page)
  await strip(partner).getByRole("button", { name: "Join huddle" }).click()
  await joinFromPreview(partner)
  await expect(page.getByText(`In a huddle with ${PARTNER.name}`)).toBeVisible({ timeout: 30_000 })

  const live = await api(page, "GET", `/api/conversations/${sharedId}/huddle`)
  const huddleId = live.json?.huddle?.id
  expect(huddleId, JSON.stringify(live.json)).toBeTruthy()

  // Nobody says anything, so the call leaves no notes behind.
  await callWindow(partner).getByRole("button", { name: "Leave huddle" }).click()
  await callWindow(page).getByRole("button", { name: "Leave huddle" }).click()
  await expect(page.getByText(/started a huddle · lasted/).first()).toBeVisible({ timeout: 15_000 })

  // Finalize runs a few seconds after the call; nothing may appear, and the
  // row must not survive as an empty transcript.
  await expect
    .poll(async () => (await api(page, "GET", `/api/huddles/${huddleId}/notes`)).status, { timeout: 45_000, intervals: [2_000] })
    .toBe(404)
  await expect(page.getByTestId("huddle-notes-block")).toHaveCount(0)
  await expect(page.getByTestId("huddle-notes-link")).toHaveCount(0)
  const messages = await api(page, "GET", `/api/conversations/${sharedId}/messages`)
  expect(JSON.stringify(messages.json)).not.toContain("huddleNotes")

  // This channel is readable by the whole workspace, so Cy gets the same "no
  // notes" Cy would get for any huddle here that left none behind.
  expect((await api(outsider, "GET", `/api/huddles/${huddleId}/notes`)).status).toBe(404)
})
