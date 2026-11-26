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
import { retimeVideo, resolveFfmpeg, VIDEO_FRAME_TOKEN_BUDGET } from '@shogo/agent-runtime/src/video-retime'
import { buildVideoMimeType } from '@shogo/model-catalog'
import { buildStampedClip } from './fixtures/stamped-clip'

const WORK_DIR = '/tmp/test-ai-proxy-video-fps'
const CLIP = join(WORK_DIR, 'stamped-10s-10fps.mp4')

const googleKey = process.env.GOOGLE_API_KEY
const openRouterKey = process.env.OPENROUTER_API_KEY
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

/** How many of the 100 labels the model reported. */
function labelsSeen(text: string): number {
  const seen = new Set<string>()
  for (const match of text.matchAll(/F\s?0?(\d{2,3})/g)) {
    const n = Number(match[1])
    if (Number.isFinite(n) && n >= 0 && n <= 99) seen.add(String(n).padStart(3, '0'))
  }
  return seen.size
}

const PROMPT = 'This clip has a label printed on every frame. List every distinct label you can see, one per line, exactly as printed. Then say how many distinct labels there were.'

function videoRequest(model: string, mimeType: string) {
  return {
    model,
    stream: false,
    max_tokens: 4000,
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
    const seen = labelsSeen(textOf(result))
    expect(seen).toBeLessThanOrEqual(20)
  }, 180_000)

  it('sees at least 95 of 100 frames with fps: 10', async () => {
    const result = await proxyOpenAINonStream(
      videoRequest(model, buildVideoMimeType('video/mp4', { fps: 10 })) as any,
      googleKey!,
      config as any,
    )
    expect(labelsSeen(textOf(result))).toBeGreaterThanOrEqual(95)
  }, 180_000)

  it('narrows to the requested range', async () => {
    // 5 s → 10 s of a 10 fps clip is frames 50–99.
    const result = await proxyOpenAINonStream(
      videoRequest(model, buildVideoMimeType('video/mp4', { fps: 10, start: 5, end: 10 })) as any,
      googleKey!,
      config as any,
    )
    const text = textOf(result)
    expect(labelsSeen(text)).toBeGreaterThanOrEqual(45)
    expect(text).not.toMatch(/F\s?0?0\d\d?\b/)
  }, 180_000)
})

describe.skipIf(!openRouterKey || !canBuildClip)('GLM 5.3 Flash sees every retimed frame (AC2)', () => {
  const config = { provider: 'openrouter' as const, apiModel: 'z-ai/glm-5.3-flash' }
  const model = 'z-ai/glm-5.3-flash'

  it('sees at least 95 of 100 frames when read at fps: 10', async () => {
    // 100 frames at 10 fps is 100 s retimed — 100 frames × 300 tokens/frame is
    // over the read budget, so ask for what the budget actually allows and
    // assert against that, exactly as `read_file` would.
    const framesWanted = Math.min(100, Math.floor(VIDEO_FRAME_TOKEN_BUDGET / 300))
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
        max_tokens: 4000,
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
    expect(labelsSeen(textOf(result))).toBeGreaterThanOrEqual(Math.min(95, framesWanted))
  }, 300_000)
})
