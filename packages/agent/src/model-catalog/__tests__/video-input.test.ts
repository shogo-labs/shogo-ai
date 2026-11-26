// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The video frame-rate carrier (§A.3 — SHO-591 / #2268).
 *
 * A block's MIME type is the only field pi-ai passes through untouched, so it
 * is where `read_file` puts the caller's fps/start/end and where the AI proxy
 * reads them back for Google's native `videoMetadata`. Both sides use these
 * functions, so the format cannot drift.
 *
 * Run: bun test packages/agent/src/model-catalog/__tests__
 */
import { describe, it, expect } from 'bun:test'
import {
  MAX_VIDEO_FPS,
  buildVideoMimeType,
  clampVideoFps,
  parseVideoMimeType,
  stripVideoMimeParams,
  toGeminiVideoMetadata,
} from '../video-input'
import {
  DEFAULT_VIDEO_TOKENS_PER_FRAME,
  getProviderForModel,
  getVideoTokensPerFrame,
} from '../helpers'
import { clearDynamicModels, registerDynamicModels } from '../dynamic-models'

describe('buildVideoMimeType', () => {
  it('is the bare media type when nothing was asked for', () => {
    expect(buildVideoMimeType('video/mp4')).toBe('video/mp4')
    expect(buildVideoMimeType('video/mp4', {})).toBe('video/mp4')
  })

  it('appends fps, start and end in a fixed order', () => {
    expect(buildVideoMimeType('video/mp4', { fps: 10, start: 20, end: 33 })).toBe('video/mp4;fps=10;start=20;end=33')
  })

  it('omits a zero start, which is what "from the beginning" means', () => {
    expect(buildVideoMimeType('video/mp4', { fps: 4, start: 0 })).toBe('video/mp4;fps=4')
  })

  it('clamps a rate over the documented ceiling and drops an impossible one', () => {
    expect(buildVideoMimeType('video/mp4', { fps: 60 })).toBe(`video/mp4;fps=${MAX_VIDEO_FPS}`)
    expect(buildVideoMimeType('video/mp4', { fps: 0 })).toBe('video/mp4')
    expect(buildVideoMimeType('video/mp4', { fps: -3 })).toBe('video/mp4')
    expect(buildVideoMimeType('video/mp4', { fps: Number.NaN })).toBe('video/mp4')
  })

  it('replaces parameters rather than stacking them', () => {
    expect(buildVideoMimeType('video/mp4;fps=5;start=2', { fps: 10 })).toBe('video/mp4;fps=10')
  })
})

describe('parseVideoMimeType', () => {
  it('reads back what buildVideoMimeType wrote', () => {
    expect(parseVideoMimeType('video/mp4;fps=10;start=20;end=33')).toEqual({
      mimeType: 'video/mp4',
      fps: 10,
      start: 20,
      end: 33,
    })
  })

  it('keeps a fractional rate and drops junk', () => {
    expect(parseVideoMimeType('video/mp4;fps=1.5').fps).toBe(1.5)
    expect(parseVideoMimeType('video/mp4;fps=fast;start=-1').fps).toBeUndefined()
    expect(parseVideoMimeType('video/mp4;fps=fast;start=-1').start).toBeUndefined()
  })

  it('clamps a stored rate above the ceiling', () => {
    expect(parseVideoMimeType('video/mp4;fps=120').fps).toBe(MAX_VIDEO_FPS)
  })
})

describe('stripVideoMimeParams', () => {
  it('keeps only the media type', () => {
    expect(stripVideoMimeParams('video/mp4;fps=10;start=2')).toBe('video/mp4')
    expect(stripVideoMimeParams('video/webm')).toBe('video/webm')
  })
})

describe('clampVideoFps', () => {
  it('is undefined for anything that cannot describe a rate', () => {
    for (const value of [undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(clampVideoFps(value as number)).toBeUndefined()
    }
    expect(clampVideoFps(12)).toBe(12)
    expect(clampVideoFps(30)).toBe(MAX_VIDEO_FPS)
  })
})

describe('toGeminiVideoMetadata', () => {
  it('turns the parameters into Google\'s offsets, in seconds', () => {
    expect(toGeminiVideoMetadata('video/mp4;fps=10;start=20;end=33')).toEqual({
      fps: 10,
      startOffset: '20s',
      endOffset: '33s',
    })
  })

  it('is undefined with no parameters, keeping Google\'s 1 fps default', () => {
    expect(toGeminiVideoMetadata('video/mp4')).toBeUndefined()
  })

  it('sends only the fields that were set', () => {
    expect(toGeminiVideoMetadata('video/mp4;end=33')).toEqual({ endOffset: '33s' })
  })
})

describe('catalog video capabilities', () => {
  it('carries the measured 73 tokens per frame on Gemini 4', () => {
    expect(getVideoTokensPerFrame('gemini-4-hydrogen')).toBe(73)
    expect(getVideoTokensPerFrame('carbon')).toBe(73)
  })

  it('assumes the expensive 300 for anything unmeasured', () => {
    expect(getVideoTokensPerFrame('z-ai/glm-5.3-flash')).toBe(DEFAULT_VIDEO_TOKENS_PER_FRAME)
    expect(getVideoTokensPerFrame('claude-opus-5-5')).toBe(DEFAULT_VIDEO_TOKENS_PER_FRAME)
    expect(getVideoTokensPerFrame('unknown-model')).toBe(300)
  })
})

describe('getProviderForModel', () => {
  it('resolves a static catalog entry, aliases included', () => {
    expect(getProviderForModel('gemini-4-carbon')).toBe('google')
    expect(getProviderForModel('carbon')).toBe('google')
    expect(getProviderForModel('claude-sonnet-5')).toBe('anthropic')
  })

  it('resolves a DB-defined row through the dynamic registry', () => {
    registerDynamicModels([{ id: 'row-google', provider: 'google' }])
    try {
      expect(getProviderForModel('row-google')).toBe('google')
    } finally {
      clearDynamicModels()
    }
  })

  it('is undefined for a model neither knows, rather than guessing', () => {
    expect(getProviderForModel('0f0f0f0f-0000-4000-8000-000000000000')).toBeUndefined()
  })
})
