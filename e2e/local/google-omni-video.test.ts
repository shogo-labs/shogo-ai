// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Gemini Omni 1.2 Flash through the real local stack (SHO-393).
 *
 * The default half spends nothing and needs no Google key: it proves the model
 * is published in the video listing with its four resolutions and marked-up
 * per-second rates, that a stack without a key refuses a submit instead of
 * running it, and that the clip route answers 404 for a job that is not ours.
 * That is the whole surface a key-less stack can reach — the rest of the
 * acceptance criteria (validation before the hold, usage-token billing, the
 * `previous_job_id` chain) are covered by the mocked route tests in
 * `apps/api/src/__tests__/ai-proxy-google-omni.test.ts`, which never call
 * Google.
 *
 *   GOOGLE_OMNI_LIVE=1   the paid tier: one 3 s 360p draft, then a follow-up
 *                        turn at 1080p through `previous_job_id` (about $0.40
 *                        at Google's published rates). This is the §6 probe
 *                        from the card, in a form that can be re-run.
 *
 * Run it against a local stack (never in CI):
 *
 *   SHOGO_LOCAL_MODE=true bun run api:dev
 *   npx playwright test --config e2e/local/playwright.config.ts google-omni-video --retries 0
 */
import { expect, test, type APIRequestContext } from "@playwright/test"
import { LOCAL_API_BASE } from "./helpers"

const LIVE = process.env.GOOGLE_OMNI_LIVE === "1"
const MODEL = "google-omni-1.2-flash"

/**
 * Two solid 320x180 PNGs (red, then blue) as data URIs: real frames the API
 * accepts. The live test animates one into the other; the free tests only need
 * bytes the proxy will take.
 */
const PNG_RED = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAUAAAAC0CAIAAABqhmJGAAACJ0lEQVR4nO3TMQ0AIADAMEAI/qUgCw88ZEmrYM/m2XsATet3APDOwBBmYAgzMIQZGMIMDGEGhjADQ5iBIczAEGZgCDMwhBkYwgwMYQaGMANDmIEhzMAQZmAIMzCEGRjCDAxhBoYwA0OYgSHMwBBmYAgzMIQZGMIMDGEGhjADQ5iBIczAEGZgCDMwhBkYwgwMYQaGMANDmIEhzMAQZmAIMzCEGRjCDAxhBoYwA0OYgSHMwBBmYAgzMIQZGMIMDGEGhjADQ5iBIczAEGZgCDMwhBkYwgwMYQaGMANDmIEhzMAQZmAIMzCEGRjCDAxhBoYwA0OYgSHMwBBmYAgzMIQZGMIMDGEGhjADQ5iBIczAEGZgCDMwhBkYwgwMYQaGMANDmIEhzMAQZmAIMzCEGRjCDAxhBoYwA0OYgSHMwBBmYAgzMIQZGMIMDGEGhjADQ5iBIczAEGZgCDMwhBkYwgwMYQaGMANDmIEhzMAQZmAIMzCEGRjCDAxhBoYwA0OYgSHMwBBmYAgzMIQZGMIMDGEGhjADQ5iBIczAEGZgCDMwhBkYwgwMYQaGMANDmIEhzMAQZmAIMzCEGRjCDAxhBoYwA0OYgSHMwBBmYAgzMIQZGMIMDGEGhjADQ5iBIczAEGZgCDMwhBkYwgwMYQaGMANDmIEhzMAQZmAIMzCEGRjCDAxhBoYwA0OYgSHMwBBmYAgzMIQZGMIMDGEGhjADQ5iBIczAEGZgGF0XQ+oCbA0Qjo0AAAAASUVORK5CYII="
const PNG_BLUE = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAUAAAAC0CAIAAABqhmJGAAACKElEQVR4nO3TQQ3AIADAQJgQNCEbWfPAhzS5U9BP59pnAE3f6wDgnoEhzMAQZmAIMzCEGRjCDAxhBoYwA0OYgSHMwBBmYAgzMIQZGMIMDGEGhjADQ5iBIczAEGZgCDMwhBkYwgwMYQaGMANDmIEhzMAQZmAIMzCEGRjCDAxhBoYwA0OYgSHMwBBmYAgzMIQZGMIMDGEGhjADQ5iBIczAEGZgCDMwhBkYwgwMYQaGMANDmIEhzMAQZmAIMzCEGRjCDAxhBoYwA0OYgSHMwBBmYAgzMIQZGMIMDGEGhjADQ5iBIczAEGZgCDMwhBkYwgwMYQaGMANDmIEhzMAQZmAIMzCEGRjCDAxhBoYwA0OYgSHMwBBmYAgzMIQZGMIMDGEGhjADQ5iBIczAEGZgCDMwhBkYwgwMYQaGMANDmIEhzMAQZmAIMzCEGRjCDAxhBoYwA0OYgSHMwBBmYAgzMIQZGMIMDGEGhjADQ5iBIczAEGZgCDMwhBkYwgwMYQaGMANDmIEhzMAQZmAIMzCEGRjCDAxhBoYwA0OYgSHMwBBmYAgzMIQZGMIMDGEGhjADQ5iBIczAEGZgCDMwhBkYwgwMYQaGMANDmIEhzMAQZmAIMzCEGRjCDAxhBoYwA0OYgSHMwBBmYAgzMIQZGMIMDGEGhjADQ5iBIczAEGZgCDMwhBkYwgwMYQaGMANDmIEhzMAQZmAIMzCEGRjCDAxhBoYwA0OYgSHMwDC6fkMWAp4pG/i7AAAAAElFTkSuQmCC"

test.describe.configure({ mode: "serial" })
test.setTimeout(20 * 60_000)

interface Proxy {
  token: string
  projectId: string
}

async function json<T = any>(
  request: APIRequestContext,
  method: "GET" | "POST",
  path: string,
  data?: unknown,
): Promise<T> {
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
    name: `google omni ${Date.now()}`,
    description: "Gemini Omni video checks",
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

async function submit(
  request: APIRequestContext,
  proxy: Proxy,
  body: Record<string, unknown>,
): Promise<{ status: number; body: any }> {
  const res = await request.fetch(`${LOCAL_API_BASE}/api/ai/v1/videos/generations`, {
    method: "POST",
    headers: proxyHeaders(proxy),
    data: { model: MODEL, ...body },
  })
  return { status: res.status(), body: await res.json().catch(() => ({})) }
}

/** Poll a job to completion; the clip itself is fetched separately. */
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
let googleConfigured = false

test.beforeAll(async ({ request }) => {
  proxy = await connect(request)
  const health = await json<any>(request, "GET", "/api/ai/proxy/health")
  googleConfigured = !!health.providers?.google
})

// ===========================================================================
// Free tier — no Google key needed, spends nothing
// ===========================================================================

test("the video listing publishes Omni with all four resolutions and their rates", async ({ request }) => {
  const res = await request.fetch(`${LOCAL_API_BASE}/api/ai/v1/media/models?kind=video`, {
    headers: proxyHeaders(proxy),
  })
  expect(res.ok()).toBe(true)
  const listing = await res.json()

  const omni = (listing.videos ?? []).find((model: any) => model.id === MODEL)
  expect(omni, `${MODEL} is missing from the video listing`).toBeDefined()
  expect(omni.provider).toBe("google")
  expect(omni.text_to_video).toBe(true)
  expect(omni.image_to_video).toBe(true)
  expect(omni.audio).toBe(true)
  expect(omni.max_reference_images).toBe(6)
  expect(omni.parameters.resolutions).toEqual(["360p", "720p", "1080p", "4k"])
  expect(omni.parameters.aspect_ratios).toEqual(["16:9", "9:16"])
  expect(omni.parameters.durations[0]).toBe(3)
  expect(omni.parameters.durations[omni.parameters.durations.length - 1]).toBe(15)
  // Omni interpolates between two stills, so its entry must say so — that flag
  // is what tells an agent it can name a last frame at all (SHO-400).
  expect(omni.last_frame, "Omni is missing last_frame: true").toBe(true)
  expect(omni.parameters.previous_job_id, "the listing must advertise the continue path").toBeTruthy()
  expect(omni.options.map((option: any) => option.name)).toContain("task")

  // Priced per output second, from the rate card, with every tier quoted.
  expect(omni.price.unit).toBe("second")
  expect(omni.price.source).toBe("rate_card")
  expect(Object.keys(omni.price.by_resolution).sort()).toEqual(["1080p", "360p", "4k", "720p"])
  for (const [resolution, usd] of Object.entries(omni.price.by_resolution)) {
    expect(usd, `${resolution} has no price`).toBeGreaterThan(0)
  }
  // 4K is the most expensive tier and 360p the cheapest, in that order.
  expect(omni.price.by_resolution["4k"]).toBeGreaterThan(omni.price.by_resolution["1080p"])
  expect(omni.price.by_resolution["1080p"]).toBeGreaterThan(omni.price.by_resolution["360p"])
  expect(omni.price.default_clip_usd).toBeGreaterThan(0)

  // Adding a second provider must not move the product default.
  expect(listing.default_video_model).toBe("hf-hailuo-2.3")

  if (googleConfigured) {
    expect(omni.available).toBeUndefined()
  } else {
    expect(omni.available).toBe(false)
    expect(omni.requires).toBe("provider_not_configured")
  }
})

test("without a Google key a submit is refused, not run", async ({ request }) => {
  test.skip(googleConfigured, "this stack has a Google key; the refusal path cannot be reached")
  const { status, body } = await submit(request, proxy, { prompt: "a red paper boat on a pond", duration: 3 })
  expect(status).toBe(503)
  expect(body.error?.code).toBe("provider_not_configured")
  // Nothing was quoted, so nothing was held.
  expect(body.estimated_usd).toBeUndefined()
})

test("end_image needs a start frame, and a two-frame clip is capped at 10 s", async ({ request }) => {
  // Both refusals happen before a hold, so this test spends nothing and needs
  // no Google key: a last frame alone cannot interpolate from anything, and
  // 12 s is inside the model's menu but outside Google's limit for the mode.
  const alone = await submit(request, proxy, { prompt: "x", duration: 5, end_image: PNG_BLUE })
  expect(alone.status, JSON.stringify(alone.body)).toBe(400)
  expect(alone.body.error?.code).toBe("invalid_end_image")
  expect(alone.body.estimated_usd).toBeUndefined()

  const tooLong = await submit(request, proxy, {
    prompt: "x",
    duration: 12,
    start_image: PNG_RED,
    end_image: PNG_BLUE,
  })
  expect(tooLong.status, JSON.stringify(tooLong.body)).toBe(400)
  expect(tooLong.body.error?.code).toBe("invalid_duration")
  expect(tooLong.body.error?.message).toContain("10 s")
  expect(tooLong.body.estimated_usd).toBeUndefined()
})

test("a start image plus a reference is not a last frame", async ({ request }) => {
  test.skip(googleConfigured, "a keyed stack would actually render the 12 s clip and bill for it")
  // Regression for the removed cap: this used to be refused as a first-and-last
  // pair. It is a normal reference request, so it must reach the provider check
  // (503 on a key-less stack) instead of the 10 s refusal.
  const { status, body } = await submit(request, proxy, {
    prompt: "x",
    duration: 12,
    start_image: PNG_RED,
    reference_images: [PNG_BLUE],
  })
  expect(body.error?.code, JSON.stringify(body)).not.toBe("invalid_duration")
  expect(status).toBe(503)
})

test("the clip route 404s a job that is not ours", async ({ request }) => {
  const content = await request.fetch(`${LOCAL_API_BASE}/api/ai/v1/videos/vid_does_not_exist/content`, {
    headers: proxyHeaders(proxy),
  })
  expect(content.status()).toBe(404)
  expect((await content.json()).error?.code).toBe("job_not_found")

  const status = await request.fetch(`${LOCAL_API_BASE}/api/ai/v1/videos/vid_does_not_exist`, {
    headers: proxyHeaders(proxy),
  })
  expect(status.status()).toBe(404)
})

test("the clip route needs a proxy token", async ({ request }) => {
  const res = await request.fetch(`${LOCAL_API_BASE}/api/ai/v1/videos/vid_does_not_exist/content`)
  expect(res.status()).toBe(401)
})

// ===========================================================================
// Paid tier — the §6 probe: a 360p draft, then a 1080p re-render of it
// ===========================================================================

test("a 360p draft is generated, then re-rendered at 1080p through previous_job_id", async ({ request }) => {
  test.skip(!LIVE, "live Google spend; set GOOGLE_OMNI_LIVE=1 (see the header)")
  test.skip(!googleConfigured, "GOOGLE_API_KEY is not configured on this stack")

  const draft = await submit(request, proxy, {
    prompt: "A red paper boat drifting across a calm pond, static camera, soft morning light.",
    resolution: "360p",
    duration: 3,
  })
  expect(draft.status, JSON.stringify(draft.body)).toBe(200)
  expect(draft.body.provider).toBe("google")
  expect(draft.body.estimated_usd).toBeGreaterThan(0)
  expect(draft.body.estimated_usd).toBeLessThan(0.2)

  const draftId: string = draft.body.id
  const finished = await pollVideo(request, proxy, draftId)
  expect(finished.video?.content_path).toBe(`/v1/videos/${draftId}/content`)

  const draftClip = await request.fetch(`${LOCAL_API_BASE}/api/ai/v1/videos/${draftId}/content`, {
    headers: proxyHeaders(proxy),
  })
  expect(draftClip.status()).toBe(200)
  expect(draftClip.headers()["content-type"]).toContain("video/mp4")
  const draftBytes = (await draftClip.body()).byteLength
  expect(draftBytes, "the draft clip is empty").toBeGreaterThan(10_000)

  // No prompt + a higher resolution is the upscale: a follow-up turn on the
  // same interaction, which re-renders the clip rather than resampling it.
  const upscale = await submit(request, proxy, { previous_job_id: draftId, resolution: "1080p" })
  expect(upscale.status, JSON.stringify(upscale.body)).toBe(200)
  expect(upscale.body.previous_job_id).toBe(draftId)
  expect(upscale.body.duration, "an upscale keeps the draft's length").toBe(3)

  const upId: string = upscale.body.id
  await pollVideo(request, proxy, upId)
  const upClip = await request.fetch(`${LOCAL_API_BASE}/api/ai/v1/videos/${upId}/content`, {
    headers: proxyHeaders(proxy),
  })
  expect(upClip.status()).toBe(200)
  const upBytes = (await upClip.body()).byteLength
  // A 1080p re-render of the same 3 s is a bigger file than the 360p draft.
  expect(upBytes, "the 1080p clip is not larger than the 360p draft").toBeGreaterThan(draftBytes)

  // A resolution at or below the draft is not an upscale.
  const same = await submit(request, proxy, { previous_job_id: draftId, resolution: "360p" })
  expect(same.status).toBe(400)
  expect(same.body.error?.code).toBe("invalid_resolution")
})

test("a 5 s 360p first-and-last-frame clip is generated end to end", async ({ request }) => {
  test.skip(!LIVE, "live Google spend (about $0.12); set GOOGLE_OMNI_LIVE=1 (see the header)")
  test.skip(!googleConfigured, "GOOGLE_API_KEY is not configured on this stack")

  const job = await submit(request, proxy, {
    prompt: "The red frame becomes the blue frame: the camera pushes slowly forward, no cut.",
    resolution: "360p",
    duration: 5,
    start_image: PNG_RED,
    end_image: PNG_BLUE,
  })
  expect(job.status, JSON.stringify(job.body)).toBe(200)
  expect(job.body.provider).toBe("google")
  expect(job.body.estimated_usd).toBeGreaterThan(0)
  expect(job.body.estimated_usd, "a 5 s 360p clip should stay near $0.12").toBeLessThan(0.3)

  const id: string = job.body.id
  const finished = await pollVideo(request, proxy, id)
  expect(finished.video?.content_path).toBe(`/v1/videos/${id}/content`)

  const clip = await request.fetch(`${LOCAL_API_BASE}/api/ai/v1/videos/${id}/content`, {
    headers: proxyHeaders(proxy),
  })
  expect(clip.status()).toBe(200)
  expect(clip.headers()["content-type"]).toContain("video/mp4")
  expect((await clip.body()).byteLength, "the interpolated clip is empty").toBeGreaterThan(10_000)
})
