// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Video input — the agent side.
 *
 * `read_file` on an mp4/mov/webm hands the clip to a video-native model as a
 * `video/mp4` content block, and refuses with a clear text error on any other
 * model. The image guard lets `video/*` through only when the turn's model can
 * watch video, so a video never reaches Anthropic/OpenAI and never poisons
 * session history.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { createTools, type ToolContext } from '../gateway-tools'
import { FileStateCache } from '../file-state-cache'
import { trustWorkspaceForTests, clearTrustForTests } from './helpers/test-trust'
import { clearDynamicModels, registerDynamicModels } from '@shogo/model-catalog'
import { enforceImageSizeLimit, scrubInvalidImages, MAX_VIDEO_INLINE_BYTES, MAX_VIDEO_INLINE_BASE64_BYTES } from '../image-size-guard'
import { parseFileAttachments } from '../file-attachment-utils'

const TEST_DIR = '/tmp/test-gw-read-video'
const VIDEO_MODEL = 'test-glm-video-model'

function makeCtx(overrides?: Partial<ToolContext>): ToolContext {
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
    ...overrides,
  }
}

async function run(ctx: ToolContext, name: string, params: Record<string, any>) {
  const all = createTools(ctx)
  const t = all.find((x) => x.name === name)
  if (!t) throw new Error(`Tool not found: ${name}`)
  return await t.execute('test-call', params)
}

beforeAll(() => {
  registerDynamicModels([{ id: VIDEO_MODEL, provider: 'custom', supportsVideoInput: true }])
})

afterAll(() => {
  clearDynamicModels()
  clearTrustForTests()
})

describe('read_file on a video', () => {
  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true })
    mkdirSync(TEST_DIR, { recursive: true })
    trustWorkspaceForTests(TEST_DIR)
  })

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true })
  })

  test('returns a video/mp4 content block for a video-native model', async () => {
    const bytes = Buffer.from('fake-mp4-bytes')
    writeFileSync(join(TEST_DIR, 'clip.mp4'), bytes)
    const ctx = makeCtx({ fileStateCache: new FileStateCache(TEST_DIR), effectiveModel: VIDEO_MODEL })

    const r = await run(ctx, 'read_file', { path: 'clip.mp4' })
    const blocks = r.content as any[]
    expect(blocks).toHaveLength(2)
    expect(blocks[0].type).toBe('image')
    expect(blocks[0].mimeType).toBe('video/mp4')
    expect(blocks[0].data).toBe(bytes.toString('base64'))
    expect(JSON.parse(blocks[1].text).mimeType).toBe('video/mp4')
  })

  test('refuses with a text error naming GLM 5.3 Flash for a text-only model', async () => {
    writeFileSync(join(TEST_DIR, 'clip.mp4'), Buffer.from('fake-mp4-bytes'))
    const ctx = makeCtx({ fileStateCache: new FileStateCache(TEST_DIR), effectiveModel: 'claude-sonnet-5' })

    const r = await run(ctx, 'read_file', { path: 'clip.mp4' })
    const content = r.content as any[]
    expect(content).toHaveLength(1)
    expect(content[0].type).toBe('text')
    expect(content[0].text).toContain('cannot watch video')
    expect(content[0].text).toContain('GLM 5.3 Flash')
  })

  test('rejects a clip over the inline budget with an ffmpeg hint', async () => {
    writeFileSync(join(TEST_DIR, 'big.mp4'), Buffer.alloc(MAX_VIDEO_INLINE_BYTES + 1))
    const ctx = makeCtx({ fileStateCache: new FileStateCache(TEST_DIR), effectiveModel: VIDEO_MODEL })

    const r = await run(ctx, 'read_file', { path: 'big.mp4' })
    const content = r.content as any[]
    expect(content[0].type).toBe('text')
    expect(content[0].text).toContain('Video too large')
    expect(content[0].text).toContain('inline')
    expect(content[0].text).toContain('ffmpeg')
  })

  test('accepts a clip at the inline budget, whose base64 still fits the request', async () => {
    writeFileSync(join(TEST_DIR, 'edge.mp4'), Buffer.alloc(MAX_VIDEO_INLINE_BYTES))
    const ctx = makeCtx({ fileStateCache: new FileStateCache(TEST_DIR), effectiveModel: VIDEO_MODEL })

    const r = await run(ctx, 'read_file', { path: 'edge.mp4' })
    const blocks = r.content as any[]
    expect(blocks[0].type).toBe('image')
    expect(blocks[0].data.length).toBeLessThanOrEqual(MAX_VIDEO_INLINE_BASE64_BYTES)
  })
})

describe('image-size-guard and video blocks', () => {
  const videoBlock = { type: 'image' as const, data: 'ZmFrZS1tcDQ=', mimeType: 'video/mp4' }

  test('passes a video through when the model can watch it', () => {
    const out = enforceImageSizeLimit([videoBlock], { label: 'read_file', allowVideo: true })
    expect(out).toHaveLength(1)
    expect((out[0] as any).mimeType).toBe('video/mp4')
  })

  test('replaces the video with a placeholder when the model cannot', () => {
    const out = enforceImageSizeLimit([videoBlock], { label: 'read_file' })
    expect(out).toHaveLength(1)
    expect(out[0].type).toBe('text')
    expect((out[0] as any).text).toContain('Video omitted')
    expect((out[0] as any).text).toContain('GLM 5.3 Flash')
  })

  test('scrubInvalidImages forwards allowVideo into history scrubbing', () => {
    const messages = [
      { role: 'user' as const, content: [videoBlock] },
    ] as any
    const kept = scrubInvalidImages(messages, { allowVideo: true })
    expect(kept).toBe(messages)
    const scrubbed = scrubInvalidImages(messages, {})
    expect(scrubbed).not.toBe(messages)
    expect((scrubbed[0].content as any[])[0].type).toBe('text')
  })
})

describe('parseFileAttachments with a video attachment', () => {
  const part = {
    type: 'file',
    mediaType: 'video/mp4',
    url: 'data:video/mp4;base64,ZmFrZS1tcDQ=',
    name: 'clip.mp4',
  }

  test('sends the video when the model supports it', () => {
    const parsed = parseFileAttachments([part], { supportsVideo: true })
    expect(parsed.images).toHaveLength(1)
    expect(parsed.images[0].mimeType).toBe('video/mp4')
  })

  test('announces it as text when the model cannot watch video', () => {
    const parsed = parseFileAttachments([part], {})
    expect(parsed.images).toHaveLength(0)
    expect(parsed.textContext).toContain('cannot watch video')
    expect(parsed.textContext).toContain('GLM 5.3 Flash')
  })
})

describe('read_file tool description', () => {
  // The description is what the model reads before deciding to call the tool, so
  // a cap quoted there that disagrees with the enforced one makes a rejected
  // read look like a bug ("you told me 20 MB was fine"). Pin it to the constant.
  test('quotes the enforced caps, not a stale literal', () => {
    const readFile = createTools(makeCtx()).find((t) => t.name === 'read_file')!
    const expectedMb = Math.floor(MAX_VIDEO_INLINE_BYTES / (1024 * 1024))
    expect(readFile.description).toContain(`videos larger than ${expectedMb} MB are rejected`)
    expect(readFile.description).not.toContain('videos larger than 20 MB')
  })
})
