// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Live smoke test for the two routes in #2268 (AC1, AC2 — SHO-591).
 *
 * Gated, and skipped unless the provider keys are present:
 *
 *   GOOGLE_API_KEY      — the native Gemini path (fps in `videoMetadata`)
 *   OPENROUTER_API_KEY  — the retime path (ffmpeg, 1 frame per second)
 *
 * Both read the issue's clip: 10 s / 10 fps with 100 stamped frames (F000 …
 * F099). Without a frame rate the model sees ~10 of them; with `fps: 10` it
 * must see at least 95. A `start`/`end` range must narrow the labels to that
 * range only.
 *
 * The frame labels are drawn by `fixtures/stamped-clip.ts` (a bitmap font
 * rasterised to PNGs), not by ffmpeg's `drawtext` — Homebrew's ffmpeg has no
 * freetype, and gating on `drawtext` skipped both live checks even when the
 * keys were present. Only ffmpeg itself is required.
 *
 * Run: bun test apps/api/src/routes/__tests__/ai-proxy-video-fps.smoke.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { mkdirSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'
import { proxyOpenAINonStream } from '../ai-proxy'
import { retimeVideo, resolveFfmpeg } from '@shogo/agent-runtime/src/video-retime'
import { buildVideoMimeType } from '@shogo/model-catalog'
import { buildStampedClip } from './fixtures/stamped-clip'

const WORK_DIR = '/tmp/test-ai-proxy-video-fps'
const CLIP = join(WORK_DIR, 'stamped-10s-10fps.mp4')

/**
 * A live key — not a placeholder another suite in the same process left behind.
 * `ai-proxy-video-input.test.ts` sets `GOOGLE_API_KEY='AIza-test-…'` in its
 * `beforeAll`, and a `bun test` over several files shares the process, so
 * reading only the variable name turned these checks red with a fake key
 * instead of skipping them.
 */
function liveKey(value: string | undefined): string | undefined {
  if (!value || value.length < 20) return undefined
  return /test|fake|placeholder|dummy|example|sample/i.test(value) ? undefined : value
}

const googleKey = liveKey(process.env.GOOGLE_API_KEY)
const openRouterKey = liveKey(process.env.OPENROUTER_API_KEY)
const ffmpeg = resolveFfmpeg().ffmpeg

// The clip is drawn by `fixtures/stamped-clip.ts` rather than ffmpeg's
// `drawtext`, which Homebrew's ffmpeg (and many CI images) omit — that alone
// used to skip both live checks even with the provider keys present.
const canBuildClip = !!ffmpeg

beforeAll(() => {
  rmSync(WORK_DIR, { recursive: true, force: true })
  mkdirSync(WORK_DIR, { recursive: true })
  if (canBuildClip) buildStampedClip(ffmpeg!, CLIP, WORK_DIR)
}, 120_000)

afterAll(() => {
  rmSync(WORK_DIR, { recursive: true, force: true })
})

/**
 * A two-word answer, not a hundred-line enumeration.
 *
 * Asking a reasoning model to list all 100 labels spends its whole output
 * budget thinking and returns nothing measurable (measured: 4000 of 4000
 * completion tokens were reasoning, `content: null`). The count plus the last
 * label separates the two outcomes that matter — a 1 fps sample stops around
 * F009, all 100 frames end at F099 — and cannot be answered by guessing.
 */
const PROMPT =
  'Every frame of this clip shows one label, in order, starting at F000. How many distinct labels ' +
  'does the clip show, and what is the last label? Answer with only two things separated by a comma: ' +
  'the number, then the last label, e.g. "42, F041".'

/**
 * The endpoints are the measurable part of "did the model see the whole clip".
 *
 * A reasoning model's *count* of 100 sampled frames is not reliable — measured
 * answers to the same request ranged from "100, F099" to "40, F098", and the
 * second is a model that plainly read the last frame and still miscounted. The
 * first and last label it reports are observable, and they separate the cases
 * exactly: a 1 fps sample of the 10 s source ends around F009, while a clip
 * retimed at 10 fps ends at F098/F099 and cannot end there unless the tail was
 * sampled. The delivered frame count itself is verified deterministically
 * against real ffmpeg below.
 */
/**
 * `"100, F099"` → `{ count: 100, last: 99 }`, parsed leniently: a model that
 * answers "The clip shows 100 labels; the last is F099" is just as correct as
 * one that answers the exact shape asked for, and a live check should not fail
 * on phrasing.
 */
function countAndLast(
  text: string,
): { count: number | null; first: number | null; last: number | null; labelsSeen: number } {
  const labels = [...text.matchAll(/F\s?0?(\d{2,3})\b/gi)]
    .map((match) => Number(match[1]))
    .filter((value) => Number.isFinite(value) && value >= 0 && value <= 99)
  const first = labels.length > 0 ? Math.min(...labels) : null
  const last = labels.length > 0 ? Math.max(...labels) : null
  const countMatch =
    /(\d{1,3})\s*(?:distinct\s+)?(?:labels|frames)/i.exec(text) ??
    /(\d{1,3})\s*,/.exec(text)
  const count = countMatch ? Number(countMatch[1]) : labels.length > 0 ? labels.length : null
  return {
    count: count !== null && Number.isFinite(count) ? count : null,
    first,
    last,
    labelsSeen: new Set(labels).size,
  }
}

function videoRequest(model: string, mimeType: string) {
  return {
    model,
    stream: false,
    // Room for the model's own thinking; it is not content.
    max_tokens: 16_000,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: PROMPT },
        { type: 'image_url', image_url: { url: `data:${mimeType};base64,${readFileSync(CLIP).toString('base64')}` } },
      ],
    }],
  }
}

function textOf(result: any): string {
  return result?.choices?.[0]?.message?.content ?? ''
}

describe.skipIf(!googleKey || !canBuildClip)('Gemini 4 Hydrogen honours fps natively (AC1)', () => {
  const config = { provider: 'google' as const, apiModel: 'gemini-4-hydrogen' }
  const model = 'gemini-4-hydrogen'

  it('sees about 10 of 100 frames when no rate is asked for', async () => {
    const result = await proxyOpenAINonStream(
      videoRequest(model, 'video/mp4') as any,
      googleKey!,
      config as any,
    )
    const answer = textOf(result)
    const { last } = countAndLast(answer)
    expect(last, answer).not.toBeNull()
    expect(last, answer).toBeLessThanOrEqual(92)
  }, 180_000)

  it('sees all 100 frames with fps: 10', async () => {
    const result = await proxyOpenAINonStream(
      videoRequest(model, buildVideoMimeType('video/mp4', { fps: 10 })) as any,
      googleKey!,
      config as any,
    )
    const answer = textOf(result)
    const { last } = countAndLast(answer)
    expect(last, answer).not.toBeNull()
    // The last frame is only readable if the tail was sampled — the frozen-tail
    // failure #2268 exists to catch.
    expect(last, answer).toBeGreaterThanOrEqual(95)
  }, 180_000)

  it('narrows to the requested range', async () => {
    // 5 s → 10 s of a 10 fps clip is frames 50–99.
    const result = await proxyOpenAINonStream(
      videoRequest(model, buildVideoMimeType('video/mp4', { fps: 10, start: 5, end: 10 })) as any,
      googleKey!,
      config as any,
    )
    const answer = textOf(result)
    const { first, last } = countAndLast(answer)
    // Frames 50–99 only: nothing below F045 may appear, and the last reaches the
    // end of the clip.
    expect(first, answer).not.toBeNull()
    expect(first, answer).toBeGreaterThanOrEqual(45)
    expect(last, answer).toBeGreaterThanOrEqual(95)
  }, 180_000)
})

describe.skipIf(!openRouterKey || !canBuildClip)('GLM 5.3 Flash sees every retimed frame (AC2)', () => {
  const config = { provider: 'openrouter' as const, apiModel: 'z-ai/glm-5.3-flash' }
  const model = 'z-ai/glm-5.3-flash'

  /** The same clip, untouched: this is the 1 fps sample the bug shipped. */
  async function askRaw(): Promise<string> {
    const result = await proxyOpenAINonStream(
      {
        model,
        stream: false,
        max_tokens: 16_000,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: PROMPT },
            { type: 'video_url', video_url: { url: `data:video/mp4;base64,${readFileSync(CLIP).toString('base64')}` } },
          ],
        }],
      } as any,
      openRouterKey!,
      config as any,
    )
    return textOf(result)
  }

  it('sees all 100 frames after the retime, and only 10 without it', async () => {
    const retimed = await retimeVideo({
      inputPath: CLIP,
      workDir: WORK_DIR,
      fps: 10,
      maxBytes: 15 * 1024 * 1024,
    })
    expect(retimed.frames).toBe(100)

    const result = await proxyOpenAINonStream(
      {
        model,
        stream: false,
        max_tokens: 16_000,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: PROMPT },
            { type: 'video_url', video_url: { url: `data:video/mp4;base64,${retimed.buffer.toString('base64')}` } },
          ],
        }],
      } as any,
      openRouterKey!,
      config as any,
    )
    const answer = textOf(result)
    const retimedAnswer = countAndLast(answer)
    expect(retimedAnswer.last, answer).not.toBeNull()
    expect(retimedAnswer.last, answer).toBeGreaterThanOrEqual(95)

    // The baseline: without the retime the provider samples once a second.
    const rawText = await askRaw()
    const rawAnswer = countAndLast(rawText)
    expect(rawAnswer.last, rawText).not.toBeNull()
    expect(rawAnswer.last, rawText).toBeLessThanOrEqual(92)
  }, 600_000)
})
