// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Live media generation through fal: a real agent turn asks for an image and a
 * short video, the media subagent calls generate_image and generate_video, the
 * API proxies to fal, and the chat shows the finished image and video cards.
 *
 * Spends real money (about $0.40 on fal plus the model turn), so it only runs
 * with E2E_LIVE_FAL=1 against a stack that has FAL_KEY and an LLM key:
 *
 *   FAL_KEY=... ANTHROPIC_API_KEY=... SHOGO_LOCAL_MODE=true bun --no-env-file apps/api/src/entry.ts
 *   EXPO_PUBLIC_LOCAL_MODE=true EXPO_PUBLIC_API_URL=http://localhost:8002 bun run web:dev
 *
 *   E2E_LIVE_FAL=1 npx playwright test --config e2e/local/playwright.config.ts fal-media-live --retries 0
 */
import { expect, test, type APIRequestContext, type Page } from "@playwright/test"
import { LOCAL_API_BASE } from "./helpers"

test.skip(process.env.E2E_LIVE_FAL !== "1", "spends real fal credit; set E2E_LIVE_FAL=1 (see the header)")

test.setTimeout(15 * 60_000)

async function json<T = any>(api: APIRequestContext, method: "GET" | "POST" | "PATCH", path: string, data?: unknown): Promise<T> {
  const res = await api.fetch(`${LOCAL_API_BASE}${path}`, { method, data })
  if (!res.ok()) throw new Error(`${method} ${path} → ${res.status()}: ${(await res.text()).slice(0, 300)}`)
  return (await res.json()) as T
}

async function createProject(api: APIRequestContext): Promise<string> {
  const workspaces = await json(api, "GET", "/api/workspaces")
  const list: any[] = workspaces?.items ?? workspaces?.data?.items ?? []
  const workspace = list.find((w) => w?.kind === "team") ?? list[0]
  if (!workspace?.id) throw new Error("local stack has no workspace")
  const created = await json(api, "POST", "/api/projects", {
    name: `fal media E2E ${Date.now()}`,
    description: "Live fal image and video generation",
    workspaceId: workspace.id,
    tier: "starter",
    status: "draft",
    accessLevel: "anyone",
  })
  const id = created?.data?.id
  if (!id) throw new Error(`project create returned no id: ${JSON.stringify(created).slice(0, 200)}`)
  await json(api, "PATCH", `/api/projects/${id}`, { settings: JSON.stringify({ videoGenEnabled: true }) })
  return id
}

function composer(page: Page) {
  return page.getByTestId("project-composer-input").or(page.getByRole("textbox", { name: "Chat message input" }))
}

test("an agent turn generates an image and a video on fal and shows both in chat", async ({ page }) => {
  const signIn = await page.request.post(`${LOCAL_API_BASE}/api/local/auto-sign-in`)
  expect(signIn.ok()).toBe(true)
  await page.request.post(`${LOCAL_API_BASE}/api/onboarding/complete`)
  const projectId = await createProject(page.request)

  await page.goto(`/projects/${projectId}`)
  const switchToText = page.getByText("Switch to text input", { exact: true })
  if (await switchToText.isVisible().catch(() => false)) await switchToText.click()
  const input = composer(page)
  await input.waitFor({ state: "visible", timeout: 120_000 })

  await input.click()
  await input.fill(
    "Use the media tools for this, nothing else. " +
      "1) Generate one image with the recraft-3 model of a friendly cartoon fox mascot and save it to images/fox.webp. " +
      "2) Generate a 5 second video with the kling-2.5-turbo-pro model, 16:9, of a red fox trotting through fresh snow, " +
      "and save it to videos/fox.mp4. Wait for the video to finish. Reply 'MEDIA DONE' when both files are saved.",
  )
  await page.keyboard.press("Enter")

  const imageCard = page.getByTestId("generated-image-card").first()
  await expect(imageCard.locator("img").first()).toBeVisible({ timeout: 5 * 60_000 })

  const videoCard = page.getByTestId("generated-video-card").first()
  await expect(videoCard.getByLabel("Download generated video")).toBeVisible({ timeout: 12 * 60_000 })
  await expect(videoCard.locator("video")).toHaveCount(1)
  await expect
    .poll(() => videoCard.locator("video").evaluate((v: HTMLVideoElement) => v.readyState >= 1 && v.duration > 0), {
      timeout: 60_000,
    })
    .toBe(true)
  await page.screenshot({ path: test.info().outputPath("fal-media-chat.png"), fullPage: false })
})
