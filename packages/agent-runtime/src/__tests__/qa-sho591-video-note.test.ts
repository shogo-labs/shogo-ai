// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-591 QA — the sample note has to describe the sample that was taken.
 *
 * `read_file`'s disclosure exists because a caller could not tell how densely a
 * clip was sampled (#2268). On a Google model the rate the caller asked for is
 * honoured natively, so a read at `fps: 5` is a five-frames-per-second sample —
 * but the generic note still called it "a 1 frame per second sample" and told a
 * caller who had already passed `fps` to pass `fps`. The warning is then wrong
 * about the very thing it was added to make visible.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test'
import { copyFileSync, mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { spawnSync } from 'child_process'
import { createTools, type ToolContext } from '../gateway-tools'
import { FileStateCache } from '../file-state-cache'
import { trustWorkspaceForTests, clearTrustForTests } from './helpers/test-trust'
import { clearDynamicModels, registerDynamicModels } from '@shogo/model-catalog'
import { resolveFfmpeg } from '../video-retime'

const TEST_DIR = '/tmp/test-qa-sho591-note'
const SOURCE_DIR = '/tmp/test-qa-sho591-note-source'
/** 5 s at 10 fps = 50 frames. */
const CLIP = join(SOURCE_DIR, 'short-5s-10fps.mp4')
const GOOGLE_VIDEO_MODEL = 'cc33dd44-ee55-4f66-8a77-112233445566'

const ffmpegAvailable = resolveFfmpeg().ffmpeg !== null

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
  const tool = createTools(makeCtx(model)).find((candidate) => candidate.name === 'read_file')!
  return (await tool.execute('test-call', params)) as any
}

beforeAll(() => {
  clearDynamicModels()
  registerDynamicModels([
    { id: GOOGLE_VIDEO_MODEL, provider: 'google', apiModel: 'gemini-4-hydrogen', supportsVideoInput: true },
  ])
  rmSync(SOURCE_DIR, { recursive: true, force: true })
  mkdirSync(SOURCE_DIR, { recursive: true })
  if (!ffmpegAvailable) return
  const result = spawnSync(resolveFfmpeg().ffmpeg!, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=10:duration=5',
    '-pix_fmt', 'yuv420p',
    '-c:v', 'libx264', '-preset', 'ultrafast',
    CLIP,
  ])
  if (result.status !== 0) throw new Error(`clip generation failed: ${result.stderr?.toString() ?? ''}`)
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

describe('a Google read at fps: 5 gets a note about a 5 fps sample', () => {
  test('the note names the rate that was actually used, not 1 fps', async () => {
    if (!ffmpegAvailable) return
    copyFileSync(CLIP, join(TEST_DIR, 'clip.mp4'))
    const result = await readVideo(GOOGLE_VIDEO_MODEL, { path: 'clip.mp4', fps: 5 })
    const details = result.details

    expect(details.sourceFrames).toBe(50)
    expect(details.effectiveFps).toBe(5)
    expect(details.framesSent).toBe(25)
    expect(typeof details.note).toBe('string')
    // The note must describe the 5 fps sample it took…
    expect(details.note).toMatch(/5 (frames? per second|fps)/i)
    // …not the provider default it did not use.
    expect(details.note).not.toContain('1 frame per second')
  })
})
