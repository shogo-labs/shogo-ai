// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * `read_file` on a video honours a real frame rate (§B, §C — SHO-591 / #2268).
 *
 * The point of the card: sampling used to be invisible. Every video read now
 * reports durationSeconds / sourceFps / sourceFrames / effectiveFps /
 * framesSent, a Google model gets the requested rate natively (no re-encode,
 * the settings riding on the block's MIME type), every other model gets a
 * retimed clip, and a chat attachment says how many frames the model will see.
 *
 * Run: bun test packages/agent-runtime/src/__tests__/video-frame-rate.test.ts
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test'
import { copyFileSync, mkdirSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'
import { spawnSync } from 'child_process'
import { createTools, type ToolContext } from '../gateway-tools'
import { FileStateCache } from '../file-state-cache'
import { trustWorkspaceForTests, clearTrustForTests } from './helpers/test-trust'
import { clearDynamicModels, registerDynamicModels } from '@shogo/model-catalog'
import { resolveFfmpeg, __resetFfmpegCacheForTests, __setExtraBinDirsForTests } from '../video-retime'
import { parseFileAttachments, describeVideoSampling } from '../file-attachment-utils'
import { readMp4Probe } from '../mp4-probe'

const TEST_DIR = '/tmp/test-video-frame-rate'
const SOURCE_DIR = '/tmp/test-video-frame-rate-source'
/** 5 s at 10 fps = 50 frames. */
const SHORT_CLIP = join(SOURCE_DIR, 'short-5s-10fps.mp4')
/** 33 s at 20 fps = 660 frames — the clip from the issue. */
const LONG_CLIP = join(SOURCE_DIR, 'long-33s-20fps.mp4')

/** A DB row served by OpenRouter: samples at 1 fps, no rate setting. */
const OPENROUTER_VIDEO_MODEL = 'aa11bb22-cc33-4d44-8e55-ff6677889900'
/** A DB row served by Google: goes through the native `generateContent` path. */
const GOOGLE_VIDEO_MODEL = 'bb22cc33-dd44-4e55-9f66-001122334455'

const ffmpegAvailable = resolveFfmpeg().ffmpeg !== null

function makeClip(path: string, seconds: number, fps: number): void {
  const { ffmpeg } = resolveFfmpeg()
  const result = spawnSync(ffmpeg!, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `testsrc=size=160x120:rate=${fps}:duration=${seconds}`,
    '-pix_fmt', 'yuv420p',
    '-c:v', 'libx264', '-preset', 'ultrafast',
    path,
  ])
  if (result.status !== 0) throw new Error(`clip generation failed: ${result.stderr?.toString() ?? ''}`)
}

function makeCtx(model: string): ToolContext {
  return {
    workspaceDir: TEST_DIR,
    channels: new Map(),
    config: {
      heartbeatInterval: 1800,
      heartbeatEnabled: false,
      quietHours: { start: '23:00', end: '07:00', timezone: 'UTC' },
      channels: [],
      model: { provider: 'anthropic', name: 'claude-sonnet-4-5' },
    } as any,
    projectId: 'test',
    fileStateCache: new FileStateCache(TEST_DIR),
    effectiveModel: model,
  } as ToolContext
}

async function readVideo(model: string, params: Record<string, unknown>) {
  const tool = createTools(makeCtx(model)).find((t) => t.name === 'read_file')!
  return (await tool.execute('test-call', params)) as any
}

function detailsOf(result: any): any {
  return result.details
}

beforeAll(() => {
  clearDynamicModels()
  registerDynamicModels([
    { id: OPENROUTER_VIDEO_MODEL, provider: 'openrouter', apiModel: 'z-ai/glm-5.3-flash', supportsVideoInput: true },
    { id: GOOGLE_VIDEO_MODEL, provider: 'google', apiModel: 'gemini-4-hydrogen', supportsVideoInput: true },
  ])
  rmSync(SOURCE_DIR, { recursive: true, force: true })
  mkdirSync(SOURCE_DIR, { recursive: true })
  if (!ffmpegAvailable) return
  makeClip(SHORT_CLIP, 5, 10)
  makeClip(LONG_CLIP, 33, 20)
}, 180_000)

afterAll(() => {
  clearDynamicModels()
  clearTrustForTests()
  rmSync(SOURCE_DIR, { recursive: true, force: true })
})

beforeEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true })
  mkdirSync(TEST_DIR, { recursive: true })
  trustWorkspaceForTests(TEST_DIR)
})

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true })
})

describe('disclosure on a plain video read', () => {
  test('reports the sampling the model will actually get, with the sample note', async () => {
    if (!ffmpegAvailable) return
    copyFileSync(SHORT_CLIP, join(TEST_DIR, 'clip.mp4'))
    const result = await readVideo(OPENROUTER_VIDEO_MODEL, { path: 'clip.mp4' })
    const details = detailsOf(result)
    expect(details.durationSeconds).toBeCloseTo(5, 1)
    expect(details.sourceFps).toBeCloseTo(10, 1)
    expect(details.sourceFrames).toBe(50)
    expect(details.effectiveFps).toBe(1)
    expect(details.framesSent).toBe(5)
    // 5 of 50 is the whole bug in one line.
    expect(details.note).toContain('5 of 50 frames')
    expect(details.note).toContain('fps')
    // The block itself is the untouched clip at the plain media type.
    expect(result.content[0].mimeType).toBe('video/mp4')
    expect(result.content[0].data).toBe(readFileSync(join(TEST_DIR, 'clip.mp4')).toString('base64'))
  })

  test('says nothing it cannot prove when the container cannot be read', async () => {
    const { writeFileSync } = require('fs') as typeof import('fs')
    writeFileSync(join(TEST_DIR, 'mystery.mp4'), Buffer.from('not really an mp4'))
    const result = await readVideo(OPENROUTER_VIDEO_MODEL, { path: 'mystery.mp4' })
    const details = detailsOf(result)
    expect(details.durationSeconds).toBeNull()
    expect(details.sourceFps).toBeNull()
    expect(details.sourceFrames).toBeNull()
    expect(details.effectiveFps).toBe(1)
    expect(details.framesSent).toBeNull()
    expect(details.note).toBeUndefined()
  })
})

describe('a Google model gets the rate natively', () => {
  test('carries fps and the range on the block MIME type and sends the clip unchanged', async () => {
    if (!ffmpegAvailable) return
    copyFileSync(SHORT_CLIP, join(TEST_DIR, 'clip.mp4'))
    const source = readFileSync(join(TEST_DIR, 'clip.mp4')).toString('base64')
    const result = await readVideo(GOOGLE_VIDEO_MODEL, { path: 'clip.mp4', fps: 10 })
    const details = detailsOf(result)
    expect(result.content[0].mimeType).toBe('video/mp4;fps=10')
    // No re-encode: the bytes are the source file's, frame for frame.
    expect(result.content[0].data).toBe(source)
    expect(details.effectiveFps).toBe(10)
    expect(details.framesSent).toBe(50)
    expect(details.sourceFrames).toBe(50)
    // Every frame arrived, so no "you only saw a sample" note.
    expect(details.note).toBeUndefined()
  })

  test('sends the requested range as start/end, and counts only that span', async () => {
    if (!ffmpegAvailable) return
    copyFileSync(SHORT_CLIP, join(TEST_DIR, 'clip.mp4'))
    const result = await readVideo(GOOGLE_VIDEO_MODEL, { path: 'clip.mp4', fps: 10, start: 2, end: 3 })
    expect(result.content[0].mimeType).toBe('video/mp4;fps=10;start=2;end=3')
    expect(detailsOf(result).framesSent).toBe(10)
    expect(detailsOf(result).start).toBe(2)
    expect(detailsOf(result).end).toBe(3)
  })

  test('clamps a rate that would blow the frame budget and says it did', async () => {
    if (!ffmpegAvailable) return
    copyFileSync(LONG_CLIP, join(TEST_DIR, 'long.mp4'))
    // 33 s at 20 fps is 660 frames; the budget is 60k tokens at ~73/frame, so
    // only ~820 fit — but at 24 fps it would be 792, so use a rate that busts.
    const result = await readVideo(GOOGLE_VIDEO_MODEL, { path: 'long.mp4', fps: 24 })
    const details = detailsOf(result)
    expect(details.fpsClamped).toBe(true)
    expect(details.requestedFps).toBe(24)
    expect(details.effectiveFps).toBeLessThan(24)
    expect(details.framesSent).toBeLessThanOrEqual(Math.floor(60_000 / 73))
  })
})

describe('a non-Google model gets a retimed clip', () => {
  test('delivers every requested frame, at one frame per second of clip', async () => {
    if (!ffmpegAvailable) return
    copyFileSync(SHORT_CLIP, join(TEST_DIR, 'clip.mp4'))
    const result = await readVideo(OPENROUTER_VIDEO_MODEL, { path: 'clip.mp4', fps: 10 })
    const details = detailsOf(result)
    expect(details.effectiveFps).toBe(10)
    expect(details.framesSent).toBe(50)
    expect(details.retimed.secondsPerFrame).toBe(1)
    expect(details.retimed.frameInterval).toBeCloseTo(0.1, 5)
    // The retimed clip is what goes on the wire, and it really holds all 50
    // frames — that is what the provider's own 1 fps sampling then returns.
    expect(result.content[0].mimeType).toBe('video/mp4')
    const sent = Buffer.from(result.content[0].data, 'base64')
    expect(readMp4Probe(sent)!.sourceFrames).toBe(50)
    expect(details.note).toContain('50 frames')
  }, 120_000)

  test('sends the clip plus a "needs ffmpeg" note when ffmpeg is missing, not an error', async () => {
    if (!ffmpegAvailable) return
    copyFileSync(SHORT_CLIP, join(TEST_DIR, 'clip.mp4'))
    const previousPath = process.env.PATH
    const previousFfmpeg = process.env.FFMPEG_PATH
    process.env.PATH = TEST_DIR
    delete process.env.FFMPEG_PATH
    __setExtraBinDirsForTests([])
    try {
      const result = await readVideo(OPENROUTER_VIDEO_MODEL, { path: 'clip.mp4', fps: 10 })
      const details = detailsOf(result)
      expect(result.content[0].type).toBe('image')
      expect(details.effectiveFps).toBe(1)
      expect(details.note).toContain('needs ffmpeg')
      // Still a usable read: the probe is container-based, so the caller learns
      // exactly how few frames the model saw.
      expect(details.sourceFrames).toBe(50)
      expect(details.framesSent).toBe(5)
    } finally {
      process.env.PATH = previousPath
      if (previousFfmpeg === undefined) delete process.env.FFMPEG_PATH
      else process.env.FFMPEG_PATH = previousFfmpeg
      __setExtraBinDirsForTests(null)
      __resetFfmpegCacheForTests()
    }
  })

  test('ignores offset/limit on a video read and says so', async () => {
    if (!ffmpegAvailable) return
    copyFileSync(SHORT_CLIP, join(TEST_DIR, 'clip.mp4'))
    const result = await readVideo(OPENROUTER_VIDEO_MODEL, { path: 'clip.mp4', offset: 10, limit: 5 })
    const details = detailsOf(result)
    expect(result.content[0].type).toBe('image')
    expect(details.offsetNote).toContain('ignored for video files')
    expect(details.sourceFrames).toBe(50)
  })
})

describe('the chat attachment line (§C)', () => {
  test('names the duration, the source rate and the frames the model will see', async () => {
    if (!ffmpegAvailable) return
    copyFileSync(SHORT_CLIP, join(TEST_DIR, 'clip.mp4'))
    const parsed = parseFileAttachments(
      [{ type: 'file', mediaType: 'video/mp4', savedPath: 'clip.mp4', name: 'clip.mp4' } as any],
      { workspaceDir: TEST_DIR, supportsVideo: true },
    )
    expect(parsed.images).toHaveLength(1)
    expect(parsed.textContext).toContain('5.0 s, 10 fps source')
    expect(parsed.textContext).toContain('the model sees ~5 of 50 frames (1 fps)')
    expect(parsed.textContext).toContain('Use read_file on `clip.mp4` with fps')
  })

  test('describeVideoSampling adds nothing it cannot prove', () => {
    expect(describeVideoSampling(null, 'clip.mp4')).toBe('')
    expect(describeVideoSampling({ durationSeconds: 5, sourceFrames: null, sourceFps: null }, 'clip.mp4')).toBe(
      ' — 5.0 s; the model sees ~5 frames (1 fps). Use read_file on `clip.mp4` with fps to inspect motion.',
    )
  })
})
