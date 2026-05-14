// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'

// fs mock state — flipped per test to control bridge descriptor discovery.
let fakeFileExists = true
let fakeFileContents: string | null = null

mock.module('fs', () => ({
  existsSync: (_p: string) => fakeFileExists && fakeFileContents !== null,
  readFileSync: (_p: string, _enc?: string) => {
    if (fakeFileContents === null) throw new Error('ENOENT')
    return fakeFileContents
  },
}))

const {
  BridgeUnavailableError,
  cleanupRecording,
  getRecordingStatus,
  getRecordingStatusAsync,
  startRecording,
  stopRecording,
} = await import('../recording.service')

let fetchSpy: ReturnType<typeof spyOn>
let fetchImpl: (url: string, init: any) => Promise<Response> = async () =>
  new Response('{}', { status: 200 })

beforeEach(() => {
  fetchImpl = async () => new Response('{}', { status: 200 })
  fetchSpy = spyOn(global, 'fetch').mockImplementation(((url: any, init: any) =>
    fetchImpl(String(url), init)) as any)
})

afterEach(() => {
  fetchSpy.mockRestore()
})

// IMPORTANT: the SUT keeps a module-level descriptor cache that is only
// refreshed when `loadDescriptor(true)` runs (after a fetch failure).
// All "descriptor missing / invalid file" tests live in the first
// describe block so the cache is empty when they execute. Subsequent
// tests warm the cache with a real descriptor and assume it stays warm.

describe('descriptor discovery (runs first — cache must be empty)', () => {
  beforeEach(() => {
    fakeFileExists = false
    fakeFileContents = null
  })

  it('getRecordingStatus returns placeholder when no bridge file', () => {
    expect(getRecordingStatus()).toEqual({
      isRecording: false,
      id: null,
      duration: 0,
      audioPath: null,
    })
  })

  it('getRecordingStatusAsync returns placeholder when descriptor unavailable', async () => {
    const res = await getRecordingStatusAsync()
    expect(res).toEqual({ isRecording: false, id: null, duration: 0, audioPath: null })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('startRecording throws BridgeUnavailableError when descriptor file is missing', async () => {
    await expect(startRecording()).rejects.toBeInstanceOf(BridgeUnavailableError)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('stopRecording throws BridgeUnavailableError when descriptor file is missing', async () => {
    await expect(stopRecording()).rejects.toBeInstanceOf(BridgeUnavailableError)
  })

  it('rejects malformed JSON in the bridge descriptor', async () => {
    fakeFileExists = true
    fakeFileContents = 'not-json'
    await expect(startRecording()).rejects.toBeInstanceOf(BridgeUnavailableError)
  })

  it('rejects descriptor with non-numeric port', async () => {
    fakeFileExists = true
    fakeFileContents = JSON.stringify({ port: 'oops', token: 'tok' })
    await expect(startRecording()).rejects.toBeInstanceOf(BridgeUnavailableError)
  })

  it('rejects descriptor with missing token', async () => {
    fakeFileExists = true
    fakeFileContents = JSON.stringify({ port: 1234 })
    await expect(startRecording()).rejects.toBeInstanceOf(BridgeUnavailableError)
  })

  for (const platform of ['darwin', 'win32', 'linux']) {
    it(`resolves a bridge file location on ${platform} (file missing → BridgeUnavailable)`, async () => {
      const orig = process.platform
      Object.defineProperty(process, 'platform', { value: platform })
      try {
        fakeFileExists = false
        fakeFileContents = null
        await expect(startRecording()).rejects.toBeInstanceOf(BridgeUnavailableError)
      } finally {
        Object.defineProperty(process, 'platform', { value: orig })
      }
    })
  }
})

describe('bridge calls (cache warmed with valid descriptor)', () => {
  beforeEach(() => {
    fakeFileExists = true
    fakeFileContents = JSON.stringify({ port: 9999, token: 'tok-1' })
  })

  describe('getRecordingStatus (sync)', () => {
    it('returns non-recording placeholder even when bridge file exists', () => {
      expect(getRecordingStatus()).toEqual({
        isRecording: false,
        id: null,
        duration: 0,
        audioPath: null,
      })
    })
  })

  describe('getRecordingStatusAsync', () => {
    it('returns the bridge JSON body on 2xx', async () => {
      fetchImpl = async () =>
        new Response(
          JSON.stringify({ isRecording: true, id: 'rec-1', duration: 12, audioPath: '/tmp/a.wav' }),
          { status: 200 },
        )
      const res = await getRecordingStatusAsync()
      expect(res.isRecording).toBe(true)
      expect(res.id).toBe('rec-1')
      expect(res.duration).toBe(12)
    })

    it('returns placeholder when bridge responds non-2xx', async () => {
      fetchImpl = async () => new Response('err', { status: 500 })
      const res = await getRecordingStatusAsync()
      expect(res).toEqual({ isRecording: false, id: null, duration: 0, audioPath: null })
    })

    it('returns placeholder when bridge fetch throws (both attempts)', async () => {
      fetchImpl = async () => {
        throw new Error('ECONNREFUSED')
      }
      const res = await getRecordingStatusAsync()
      expect(res).toEqual({ isRecording: false, id: null, duration: 0, audioPath: null })
    })
  })

  describe('startRecording', () => {
    it('returns id and audioPath on success', async () => {
      fetchImpl = async () =>
        new Response(JSON.stringify({ id: 'rec-1', audioPath: '/tmp/a.wav' }), { status: 200 })
      const out = await startRecording()
      expect(out).toEqual({ id: 'rec-1', audioPath: '/tmp/a.wav' })
    })

    it('uses POST /recording/start with the bridge token header at 127.0.0.1', async () => {
      let capturedUrl = ''
      let capturedInit: any = null
      fetchImpl = async (url, init) => {
        capturedUrl = url
        capturedInit = init
        return new Response(JSON.stringify({ id: 'rec-1', audioPath: '/x' }), { status: 200 })
      }
      await startRecording()
      expect(capturedUrl).toContain('/recording/start')
      expect(capturedUrl).toContain('127.0.0.1:9999')
      expect(capturedInit.method).toBe('POST')
      expect(capturedInit.headers['x-shogo-bridge-token']).toBe('tok-1')
    })

    it('throws with bridge-supplied error message on non-2xx', async () => {
      fetchImpl = async () =>
        new Response(JSON.stringify({ error: 'device busy' }), { status: 409 })
      await expect(startRecording()).rejects.toThrow(/device busy/)
    })

    it('falls back to "bridge returned HTTP" when 2xx body lacks id/audioPath', async () => {
      fetchImpl = async () => new Response(JSON.stringify({}), { status: 200 })
      await expect(startRecording()).rejects.toThrow(/HTTP 200/)
    })
  })

  describe('stopRecording', () => {
    it('returns recording metadata on 2xx', async () => {
      fetchImpl = async () =>
        new Response(JSON.stringify({ id: 'rec-1', audioPath: '/tmp/a.wav', duration: 5 }), {
          status: 200,
        })
      const out = await stopRecording()
      expect(out).toEqual({ id: 'rec-1', audioPath: '/tmp/a.wav', duration: 5 })
    })

    it('defaults duration to 0 when omitted by bridge', async () => {
      fetchImpl = async () =>
        new Response(JSON.stringify({ id: 'rec-1', audioPath: '/tmp/a.wav' }), { status: 200 })
      const out = await stopRecording()
      expect(out?.duration).toBe(0)
    })

    it("returns null on 400 with 'not recording' (idempotent stop)", async () => {
      fetchImpl = async () =>
        new Response(JSON.stringify({ error: 'not recording right now' }), { status: 400 })
      expect(await stopRecording()).toBeNull()
    })

    it('throws on 400 with a non-matching error message', async () => {
      fetchImpl = async () =>
        new Response(JSON.stringify({ error: 'something else' }), { status: 400 })
      await expect(stopRecording()).rejects.toThrow(/something else/)
    })

    it('throws on 500-level errors', async () => {
      fetchImpl = async () =>
        new Response(JSON.stringify({ error: 'boom' }), { status: 500 })
      await expect(stopRecording()).rejects.toThrow(/boom/)
    })

    it('returns null when 2xx body has no id or audioPath', async () => {
      fetchImpl = async () => new Response(JSON.stringify({ duration: 3 }), { status: 200 })
      expect(await stopRecording()).toBeNull()
    })
  })

  describe('cleanupRecording', () => {
    it('is a no-op that does not throw', () => {
      expect(() => cleanupRecording()).not.toThrow()
    })
  })
})
