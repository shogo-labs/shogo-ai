// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Live Higgsfield media against a real local stack and a real account, in two
 * tiers that spend very different amounts of money.
 *
 *   HIGGSFIELD_LIVE=1        free tier: listing, prices, presets, upload
 *                            handshake, 404 lookup. Spends nothing.
 *   HIGGSFIELD_LIVE_PAID=1   paid tier: one SOUL V2 image, one Hailuo 2.3 clip,
 *                            one Kling 3.0 Std 3 s clip with sound (text→video
 *                            and image→video), one Genjutsu restyle of that
 *                            clip at 480p.
 *
 * Every paid test posts to `/ai/v1/media/estimate` first and **hard-fails
 * before submitting** if the quote is over that test's cap, so a pricing change
 * upstream cannot quietly turn this file into a large bill.
 *
 * Run it against a local stack (never in CI):
 *
 *   SHOGO_LOCAL_MODE=true ANTHROPIC_API_KEY=... HIGGSFIELD_API_KEY=... bun run api:dev
 *   HIGGSFIELD_LIVE=1 npx playwright test --config e2e/local/playwright.config.ts higgsfield-media-live --retries 0
 *
 * Budget (dev, one run): soul image ≈ $0.11, Hailuo 6 s ≈ $0.08, Kling 3.0 Std
 * 3 s with sound ≈ $0.23 (twice), restyle 480p of a 6 s clip ≈ $1.9 — under
 * $2.6 total. QA runs the free tier plus the cheap paid tests (~$0.70) and
 * leaves the Genjutsu test to the dev.
 */
import { expect, test, type APIRequestContext } from "@playwright/test"
import { LOCAL_API_BASE } from "./helpers"

const LIVE = process.env.HIGGSFIELD_LIVE === "1"
const PAID = process.env.HIGGSFIELD_LIVE_PAID === "1"
const GENJUTSU = PAID && process.env.HIGGSFIELD_LIVE_GENJUTSU !== "0"

/** Per-test ceilings, in USD (what the workspace would be charged). */
const CAP_IMAGE_USD = 0.25
const CAP_VIDEO_USD = 0.3
/** Kling 3.0 Std, 3 s with sound: the clock is short, the tier is the expensive one. */
const CAP_KLING_USD = 1.2
const CAP_GENJUTSU_USD = 2.5

test.describe.configure({ mode: "serial" })
test.setTimeout(20 * 60_000)

interface Proxy {
  token: string
  projectId: string
}

async function json<T = any>(request: APIRequestContext, method: "GET" | "POST", path: string, data?: unknown): Promise<T> {
  const res = await request.fetch(`${LOCAL_API_BASE}${path}`, { method, data })
  if (!res.ok()) throw new Error(`${method} ${path} → ${res.status()}: ${(await res.text()).slice(0, 400)}`)
  return (await res.json()) as T
}

/** Sign in, open a scratch project, and mint the proxy token every /ai/v1 call needs. */
async function connect(request: APIRequestContext): Promise<Proxy> {
  const signedIn = await request.post(`${LOCAL_API_BASE}/api/local/auto-sign-in`)
  expect(signedIn.ok()).toBe(true)

  const workspaces = await json<any>(request, "GET", "/api/workspaces")
  const list: any[] = workspaces?.items ?? workspaces?.data?.items ?? workspaces?.workspaces ?? []
  const workspace = list.find((w) => w?.kind === "team") ?? list[0]
  if (!workspace?.id) throw new Error("the local stack has no workspace to put the project in")

  const project = await json<any>(request, "POST", "/api/projects", {
    name: `higgsfield live ${Date.now()}`,
    description: "Live Higgsfield media checks",
    workspaceId: workspace.id,
    tier: "starter",
    status: "draft",
    accessLevel: "anyone",
  })
  const projectId = project?.data?.id ?? project?.id
  if (!projectId) throw new Error(`project create returned no id: ${JSON.stringify(project).slice(0, 300)}`)

  const minted = await json<any>(request, "POST", "/api/ai/proxy/tokens", {
    projectId,
    workspaceId: workspace.id,
  })
  if (!minted?.token) throw new Error("proxy token mint returned no token")
  return { token: minted.token, projectId }
}

function proxyHeaders(proxy: Proxy) {
  return { Authorization: `Bearer ${proxy.token}` }
}

async function estimate(request: APIRequestContext, proxy: Proxy, body: Record<string, unknown>): Promise<number> {
  const res = await request.fetch(`${LOCAL_API_BASE}/api/ai/v1/media/estimate`, {
    method: "POST",
    headers: proxyHeaders(proxy),
    data: body,
  })
  expect(res.ok(), `estimate failed: ${await res.text()}`).toBe(true)
  const quote = (await res.json()) as { usd?: number; model?: string }
  expect(typeof quote.usd, `estimate for ${body.model} returned no usd`).toBe("number")
  return quote.usd!
}

async function pollVideo(request: APIRequestContext, proxy: Proxy, id: string, timeoutMs = 12 * 60_000) {
  const deadline = Date.now() + timeoutMs
  let last: any = null
  while (Date.now() < deadline) {
    const res = await request.fetch(`${LOCAL_API_BASE}/api/ai/v1/videos/${id}`, { headers: proxyHeaders(proxy) })
    expect(res.ok(), `status failed: ${await res.text()}`).toBe(true)
    last = await res.json()
    if (last.status === "completed") return last
    if (last.status === "failed") throw new Error(`job ${id} failed: ${last.error}`)
    await new Promise((r) => setTimeout(r, 5_000))
  }
  throw new Error(`job ${id} did not finish in ${timeoutMs / 60_000} minutes (last status: ${last?.status})`)
}

let proxy: Proxy
let generatedVideoUrl: string | undefined

test.beforeAll(async ({ request }) => {
  test.skip(!LIVE, "live provider checks; set HIGGSFIELD_LIVE=1 (see the header)")
  proxy = await connect(request)
})

// ===========================================================================
// Free tier — spends nothing
// ===========================================================================

test("health and the model listing report Higgsfield as the default", async ({ request }) => {
  const health = await json<any>(request, "GET", "/api/ai/proxy/health")
  expect(health.providers?.higgsfield, "HIGGSFIELD_API_KEY is not configured on this stack").toBe(true)

  const res = await request.fetch(`${LOCAL_API_BASE}/api/ai/v1/media/models`, { headers: proxyHeaders(proxy) })
  expect(res.ok()).toBe(true)
  const listing = await res.json()
  expect(listing.images[0].id).toBe("hf-soul-v2")
  expect(listing.videos[0].id).toBe("hf-hailuo-2.3")
  expect(listing.default_video_model).toBe("hf-hailuo-2.3")
  // Higgsfield is the only provider: nothing fal-shaped may be listed, and every
  // model must publish the options an agent needs to fill a request.
  for (const model of [...listing.images, ...listing.videos]) {
    expect(model.provider, `${model.id} is not a Higgsfield model`).toBe("higgsfield")
    expect(model.endpoints?.length, `${model.id} lists no endpoints`).toBeGreaterThan(0)
    expect(model.options?.length, `${model.id} lists no options`).toBeGreaterThan(0)
  }
})

test("Kling 3.0 Std is listed with both endpoints, 3–15 s and sound", async ({ request }) => {
  const res = await request.fetch(`${LOCAL_API_BASE}/api/ai/v1/media/models?model=hf-kling-3.0-std`, {
    headers: proxyHeaders(proxy),
  })
  expect(res.ok()).toBe(true)
  const listing = await res.json()
  const model = listing.videos?.[0]
  expect(model?.id).toBe("hf-kling-3.0-std")
  expect(model.audio).toBe(true)
  expect(model.endpoints).toEqual([
    "kling-video/v3.0/std/text-to-video",
    "kling-video/v3.0/std/image-to-video",
  ])
  expect(model.parameters.durations[0]).toBe(3)
  expect(model.parameters.durations[model.parameters.durations.length - 1]).toBe(15)
  const names = model.options.map((o: any) => o.name)
  for (const name of ["sound", "multi_prompt", "multi_shots", "cfg_scale"]) {
    expect(names, `Kling 3.0 Std is missing '${name}'`).toContain(name)
  }
})

test("every listed image model carries a price, and the catalog is complete", async ({ request }) => {
  const res = await request.fetch(`${LOCAL_API_BASE}/api/ai/v1/media/models`, { headers: proxyHeaders(proxy) })
  expect(res.ok()).toBe(true)
  const listing = await res.json()
  const higgsfield = (listing.images ?? []).filter((m: any) => m.provider === "higgsfield")
  expect(higgsfield.length, "all Higgsfield image endpoints should be listed").toBe(18)
  for (const model of listing.images ?? []) {
    // A listed model with no price cannot be budgeted, and a Higgsfield model
    // that cannot be quoted will refuse to run — neither may show up here.
    expect(model.price?.usd, `${model.id} lists no price`).toBeGreaterThan(0)
    expect(model.best_for, `${model.id} has no best_for`).toBeTruthy()
    expect(typeof model.max_reference_images, `${model.id} has no reference limit`).toBe("number")
  }
})

test("prices come back for an image and a clip", async ({ request }) => {
  const image = await estimate(request, proxy, { model: "hf-soul-v2", size: "1024x1024" })
  expect(image).toBeGreaterThan(0)
  const clip = await estimate(request, proxy, { model: "hf-hailuo-2.3", duration: 6 })
  expect(clip).toBeGreaterThan(0)
  console.log(`live estimates — soul image: $${image}, hailuo 6s: $${clip}`)
})

test("a Genjutsu edit is quoted from the rate card, not from the vendor", async ({ request }) => {
  // Genjutsu answers /estimate with prose, so the proxy prices the edit itself:
  // vendor per-source-second rate × the declared length, plus the usual markup.
  // Nothing is submitted, so this costs nothing.
  const draft = await estimate(request, proxy, {
    model: "hf-genjutsu-motion-transfer",
    source_duration_seconds: 4,
    resolution: "480p",
  })
  expect(draft).toBeCloseTo(0.318 * 4 * 1.2, 2)

  const hero = await estimate(request, proxy, {
    model: "hf-genjutsu-restyle",
    source_duration_seconds: 8,
    resolution: "1080p",
    preset_id: "preset-not-verified-by-an-estimate",
  })
  expect(hero).toBeCloseTo(1.632 * 8 * 1.2, 2)

  // The provider trims a source clip to 30 s, so a longer one bills 30 s.
  const trimmed = await estimate(request, proxy, {
    model: "hf-genjutsu-object-swap",
    source_duration_seconds: 60,
    resolution: "720p",
  })
  expect(trimmed).toBeCloseTo(0.681 * 30 * 1.2, 2)
})

test("a Genjutsu edit with no declared length is refused, never quoted at zero", async ({ request }) => {
  const res = await request.fetch(`${LOCAL_API_BASE}/api/ai/v1/media/estimate`, {
    method: "POST",
    headers: proxyHeaders(proxy),
    data: { model: "hf-genjutsu-motion-transfer", resolution: "720p" },
  })
  expect(res.status(), await res.text()).toBe(400)
  expect((await res.json() as any).error.code).toBe("missing_source_duration")
})

test("the restyle presets list is reachable", async ({ request }) => {
  const res = await request.fetch(`${LOCAL_API_BASE}/api/ai/v1/media/presets`, { headers: proxyHeaders(proxy) })
  expect(res.ok(), await res.text()).toBe(true)
  const body = await res.json()
  expect(Array.isArray(body.presets)).toBe(true)
  for (const preset of body.presets) expect(typeof preset.id).toBe("string")
  console.log(`live presets: ${body.presets.length}`)
})

test("an upload round trip returns a public URL", async ({ request }) => {
  // A minimal MP4 header is enough for the storage handshake; the provider
  // does not decode the file until a generation references it.
  const bytes = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109])
  const res = await request.fetch(`${LOCAL_API_BASE}/api/ai/v1/media/uploads`, {
    method: "POST",
    headers: { ...proxyHeaders(proxy), "Content-Type": "video/mp4" },
    data: bytes,
  })
  expect(res.ok(), await res.text()).toBe(true)
  const body = await res.json()
  expect(body.url).toMatch(/^https:\/\//)
})

test("an unknown job id is a 404, not a crash", async ({ request }) => {
  const res = await request.fetch(`${LOCAL_API_BASE}/api/ai/v1/videos/vid_does_not_exist`, { headers: proxyHeaders(proxy) })
  expect(res.status()).toBe(404)
})

// ===========================================================================
// Paid tier — each test quotes first and refuses to overspend
// ===========================================================================

test("a SOUL V2 image generates, within its price cap", async ({ request }) => {
  test.skip(!PAID, "spends real Higgsfield credit; set HIGGSFIELD_LIVE_PAID=1")

  const quote = await estimate(request, proxy, { model: "hf-soul-v2", size: "1024x1024", quality: "standard" })
  console.log(`soul v2 image quote: $${quote}`)
  expect(quote, `refusing to submit: $${quote} is over the $${CAP_IMAGE_USD} cap`).toBeLessThanOrEqual(CAP_IMAGE_USD)

  const res = await request.fetch(`${LOCAL_API_BASE}/api/ai/v1/images/generations`, {
    method: "POST",
    // An image render takes ~20 s; Playwright's default request timeout is well
    // under that, and a timeout here would look like a provider failure.
    timeout: 180_000,
    headers: proxyHeaders(proxy),
    data: { model: "hf-soul-v2", prompt: "a single red apple on a plain white seamless background, studio light", size: "1024x1024", n: 1 },
  })
  expect(res.ok(), await res.text()).toBe(true)
  const body = await res.json()
  expect(body.data?.length).toBe(1)
  expect(Buffer.from(body.data[0].b64_json, "base64").byteLength).toBeGreaterThan(1_000)
})

test("a Kling 3.0 Std clip with sound completes: text-to-video, 3 s", async ({ request }) => {
  test.skip(!PAID, "spends real Higgsfield credit; set HIGGSFIELD_LIVE_PAID=1")

  // The headline of the card: Kling 3.0 Standard on Higgsfield, shortest clip,
  // native audio on. `sound` is the documented field; nothing about it is
  // hand-wired in the proxy.
  const quote = await estimate(request, proxy, { model: "hf-kling-3.0-std", duration: 3, audio: true })
  console.log(`kling 3.0 std 3s with sound quote: $${quote}`)
  expect(quote, `refusing to submit: $${quote} is over the $${CAP_KLING_USD} cap`).toBeLessThanOrEqual(CAP_KLING_USD)

  const res = await request.fetch(`${LOCAL_API_BASE}/api/ai/v1/videos/generations`, {
    method: "POST",
    timeout: 120_000,
    headers: proxyHeaders(proxy),
    data: {
      model: "hf-kling-3.0-std",
      prompt: "a red apple rotating slowly on a white table, soft studio light, quiet room tone",
      duration: 3,
      audio: true,
    },
  })
  expect(res.ok(), await res.text()).toBe(true)
  const job = await res.json()
  // The response proves the audio flag survived the request builder.
  expect(job).toMatchObject({ model: "hf-kling-3.0-std", duration: 3, audio: true })
  expect(job.estimated_usd).toBeGreaterThan(0)
  expect(job.estimated_usd).toBeLessThanOrEqual(CAP_KLING_USD)

  const done = await pollVideo(request, proxy, job.id)
  expect(done.video?.url).toMatch(/^https:\/\//)
  const download = await request.fetch(done.video.url)
  expect(download.ok()).toBe(true)
})

test("a Kling 3.0 Std clip with sound completes: image-to-video, 3 s", async ({ request }) => {
  test.skip(!PAID, "spends real Higgsfield credit; set HIGGSFIELD_LIVE_PAID=1")

  const quote = await estimate(request, proxy, { model: "hf-kling-3.0-std", duration: 3, audio: true })
  expect(quote, `refusing to submit: $${quote} is over the $${CAP_KLING_USD} cap`).toBeLessThanOrEqual(CAP_KLING_USD)

  // A tiny PNG is enough: the proxy uploads it and submits to the image-to-video
  // endpoint, which is the path that took the most work to get right.
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAF0lEQVR42mP8z8Dwn4GBgYGJgYGBAQB2CgoBvhZ5FwAAAABJRU5ErkJggg==",
    "base64",
  )
  const res = await request.fetch(`${LOCAL_API_BASE}/api/ai/v1/videos/generations`, {
    method: "POST",
    timeout: 120_000,
    headers: proxyHeaders(proxy),
    data: {
      model: "hf-kling-3.0-std",
      prompt: "the scene comes alive, slow push in, quiet room tone",
      duration: 3,
      audio: true,
      start_image: `data:image/png;base64,${png.toString("base64")}`,
    },
  })
  expect(res.ok(), await res.text()).toBe(true)
  const job = await res.json()
  expect(job).toMatchObject({ model: "hf-kling-3.0-std", duration: 3, audio: true })

  const done = await pollVideo(request, proxy, job.id)
  expect(done.video?.url).toMatch(/^https:\/\//)
})

test("a Hailuo 2.3 clip completes, within its price cap", async ({ request }) => {
  test.skip(!PAID, "spends real Higgsfield credit; set HIGGSFIELD_LIVE_PAID=1")

  const quote = await estimate(request, proxy, { model: "hf-hailuo-2.3", duration: 6 })
  console.log(`hailuo 6s quote: $${quote}`)
  expect(quote, `refusing to submit: $${quote} is over the $${CAP_VIDEO_USD} cap`).toBeLessThanOrEqual(CAP_VIDEO_USD)

  const res = await request.fetch(`${LOCAL_API_BASE}/api/ai/v1/videos/generations`, {
    method: "POST",
    timeout: 120_000,
    headers: proxyHeaders(proxy),
    data: { model: "hf-hailuo-2.3", prompt: "a red apple rotating slowly on a white table, soft studio light", duration: 6 },
  })
  expect(res.ok(), await res.text()).toBe(true)
  const job = await res.json()
  expect(job.estimated_usd).toBeGreaterThan(0)
  expect(job.estimated_usd).toBeLessThanOrEqual(CAP_VIDEO_USD)

  const done = await pollVideo(request, proxy, job.id)
  expect(done.video?.url).toMatch(/^https:\/\//)

  const download = await request.fetch(done.video.url)
  expect(download.ok()).toBe(true)
  generatedVideoUrl = done.video.url
})

test("Genjutsu restyles that clip at 480p, within its price cap", async ({ request }) => {
  test.skip(!GENJUTSU, "spends real Higgsfield credit per source second; set HIGGSFIELD_LIVE_PAID=1")

  // Reuse the clip from the previous test so the source costs nothing extra.
  const sourceUrl = generatedVideoUrl ?? process.env.HIGGSFIELD_LIVE_SOURCE_VIDEO
  test.skip(!sourceUrl, "run the Hailuo test first, or set HIGGSFIELD_LIVE_SOURCE_VIDEO to a public clip URL")

  const presetsRes = await request.fetch(`${LOCAL_API_BASE}/api/ai/v1/media/presets`, { headers: proxyHeaders(proxy) })
  expect(presetsRes.ok()).toBe(true)
  const presetId: string | undefined = (await presetsRes.json())?.presets?.[0]?.id
  test.skip(!presetId, "the account returned no restyle presets")

  const quote = await estimate(request, proxy, {
    model: "hf-genjutsu-restyle",
    source_video_url: sourceUrl,
    source_duration_seconds: 6,
    preset_id: presetId,
    resolution: "480p",
  })
  console.log(`genjutsu restyle 480p quote: $${quote}`)
  expect(quote, `refusing to submit: $${quote} is over the $${CAP_GENJUTSU_USD} cap`).toBeLessThanOrEqual(CAP_GENJUTSU_USD)

  const res = await request.fetch(`${LOCAL_API_BASE}/api/ai/v1/videos/generations`, {
    method: "POST",
    timeout: 180_000,
    headers: proxyHeaders(proxy),
    data: {
      model: "hf-genjutsu-restyle",
      source_video_url: sourceUrl,
      source_duration_seconds: 6,
      preset_id: presetId,
      resolution: "480p",
    },
  })
  expect(res.ok(), await res.text()).toBe(true)
  const job = await res.json()
  expect(job.estimated_usd).toBeLessThanOrEqual(CAP_GENJUTSU_USD)

  const done = await pollVideo(request, proxy, job.id, 20 * 60_000)
  expect(done.video?.url).toMatch(/^https:\/\//)
})
