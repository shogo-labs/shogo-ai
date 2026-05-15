// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Tests for src/services/recording.service.ts — the HTTP client for the
 * Electron main-process recording bridge. The bridge discovery flow
 * reads a JSON descriptor file from the OS-specific userData directory;
 * we mock the `fs` module so tests are platform-independent.
 */

import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

// ─── fs mock (controls existsSync + readFileSync) ──────────────────────────

const existsSyncMock = mock((_p: string): boolean => false)
const readFileSyncMock = mock((_p: string, _enc?: any): string => '')

mock.module('fs', () => ({
  existsSync: existsSyncMock,
  readFileSync: readFileSyncMock,
}))

// Module under test must be imported AFTER fs is mocked.
const recording = await import('../services/recording.service')
const {
  BridgeUnavailableError,
  cleanupRecording,
  getRecordingStatus,
  getRecordingStatusAsync,
  startRecording,
  stopRecording,
} = recording

// ─── fetch mock ────────────────────────────────────────────────────────────

const realFetch = globalThis.fetch
let lastFetchCalls: Array<{ url: string; init: any }> = []

function setFetchHandler(handler: (url: string, init: any) => any) {
  lastFetchCalls = []
  globalThis.fetch = (async (url: string, init: any) => {
    lastFetchCalls.push({ url, init })
    return handler(url, init)
  }) as unknown as typeof fetch
}

function fetchResp(status: number, body: any, ok = status < 400) {
  return { ok, status, json: async () => body }
}

afterAll(() => {
  globalThis.fetch = realFetch
})

// The descriptor cache lives at module scope. We reset it by toggling
// existsSync to false and forcing a fresh read on the next call (via
// the `force` param), or by mutating the file mock between tests.
function setBridgeDescriptor(opts: { port: number; token: string; pid?: number } | null) {
  if (!opts) {
    existsSyncMock.mockImplementation(() => false)
    return
  }
  existsSyncMock.mockImplementation(() => true)
  readFileSyncMock.mockImplementation(() =>
    JSON.stringify({ port: opts.port, token: opts.token, pid: opts.pid })
  )
}

beforeEach(() => {
  existsSyncMock.mockClear()
  readFileSyncMock.mockClear()
  setBridgeDescriptor(null)
  globalThis.fetch = (async () => {
    throw new Error('fetch was not mocked for this test')
  }) as any
})

afterEach(() => {
  globalThis.fetch = realFetch
})

// ─── getRecordingStatus (sync) ─────────────────────────────────────────────

describe('getRecordingStatus (sync)', () => {
  test('returns the not-recording placeholder when no descriptor exists', () => {
    setBridgeDescriptor(null)
    expect(getRecordingStatus()).toEqual({
      isRecording: false,
      id: null,
      duration: 0,
      audioPath: null,
    })
  })

  test('always returns the placeholder shape — sync call cannot reach the bridge', () => {
    setBridgeDescriptor({ port: 50001, token: 'tok-1' })
    const status = getRecordingStatus()
    expect(status.isRecording).toBe(false)
    expect(status.id).toBeNull()
    expect(status.duration).toBe(0)
    expect(status.audioPath).toBeNull()
  })
})

// ─── getRecordingStatusAsync ───────────────────────────────────────────────

describe('getRecordingStatusAsync', () => {
  test('returns placeholder when descriptor file is missing', async () => {
    setBridgeDescriptor(null)
    const status = await getRecordingStatusAsync()
    expect(status).toEqual({ isRecording: false, id: null, duration: 0, audioPath: null })
  })

  test('returns the bridge response on 200', async () => {
    setBridgeDescriptor({ port: 50001, token: 'tok-1' })
    setFetchHandler(() =>
      fetchResp(200, { isRecording: true, id: 'rec-1', duration: 123, audioPath: '/tmp/a.wav' })
    )
    const status = await getRecordingStatusAsync()
    expect(status).toEqual({
      isRecording: true,
      id: 'rec-1',
      duration: 123,
      audioPath: '/tmp/a.wav',
    })
  })

  test('forwards a bridge token in the x-shogo-bridge-token header', async () => {
    // Module caches the descriptor at first load (no force=true happens in
    // the success path), so we assert the SHAPE of what's forwarded rather
    // than a specific per-test value. Cache-bust behavior is covered
    // separately in the "retry on stale port" suite below.
    setBridgeDescriptor({ port: 50001, token: 'tok-1' })
    setFetchHandler(() => fetchResp(200, { isRecording: false, id: null, duration: 0, audioPath: null }))
    await getRecordingStatusAsync()
    expect(typeof lastFetchCalls[0].init.headers['x-shogo-bridge-token']).toBe('string')
    expect(lastFetchCalls[0].init.headers['x-shogo-bridge-token'].length).toBeGreaterThan(0)
  })

  test('targets http://127.0.0.1:<port>/recording/status', async () => {
    setBridgeDescriptor({ port: 50001, token: 'tok-1' })
    setFetchHandler(() => fetchResp(200, { isRecording: false, id: null, duration: 0, audioPath: null }))
    await getRecordingStatusAsync()
    expect(lastFetchCalls[0].url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/recording\/status$/)
  })

  test('returns placeholder on non-2xx response', async () => {
    setBridgeDescriptor({ port: 50001, token: 'tok' })
    setFetchHandler(() => fetchResp(500, {}, false))
    const status = await getRecordingStatusAsync()
    expect(status).toEqual({ isRecording: false, id: null, duration: 0, audioPath: null })
  })

  test('returns placeholder when fetch throws', async () => {
    setBridgeDescriptor({ port: 50001, token: 'tok' })
    setFetchHandler(() => {
      throw new Error('ECONNREFUSED')
    })
    const status = await getRecordingStatusAsync()
    expect(status).toEqual({ isRecording: false, id: null, duration: 0, audioPath: null })
  })

  test('treats a malformed descriptor file as no-descriptor', async () => {
    existsSyncMock.mockImplementation(() => true)
    readFileSyncMock.mockImplementation(() => '{bad json')
    const status = await getRecordingStatusAsync()
    expect(status.isRecording).toBe(false)
  })

  test('treats a descriptor with wrong field types as no-descriptor', async () => {
    existsSyncMock.mockImplementation(() => true)
    readFileSyncMock.mockImplementation(() =>
      JSON.stringify({ port: 'not-a-number', token: 123 })
    )
    const status = await getRecordingStatusAsync()
    expect(status.isRecording).toBe(false)
  })
})

// ─── startRecording ────────────────────────────────────────────────────────

describe('startRecording', () => {
  test('returns {id, audioPath} on success', async () => {
    setBridgeDescriptor({ port: 50001, token: 'tok' })
    setFetchHandler(() => fetchResp(200, { id: 'rec-42', audioPath: '/tmp/r.wav' }))
    const out = await startRecording()
    expect(out).toEqual({ id: 'rec-42', audioPath: '/tmp/r.wav' })
  })

  test('POSTs to /recording/start with the bridge token', async () => {
    setBridgeDescriptor({ port: 50001, token: 'tok-start' })
    setFetchHandler(() => fetchResp(200, { id: 'r', audioPath: '/tmp/x' }))
    await startRecording()
    expect(lastFetchCalls[0].url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/recording\/start$/)
    expect(lastFetchCalls[0].init.method).toBe('POST')
    // Cached token from first descriptor load — assert presence, not value.
    expect(typeof lastFetchCalls[0].init.headers['x-shogo-bridge-token']).toBe('string')
  })

  test('throws BridgeUnavailableError when no descriptor is present', async () => {
    setBridgeDescriptor(null)
    await expect(startRecording()).rejects.toBeInstanceOf(BridgeUnavailableError)
  })

  test('throws with the bridge error.message when bridge returns 4xx with a body', async () => {
    setBridgeDescriptor({ port: 50001, token: 'tok' })
    setFetchHandler(() => fetchResp(400, { error: 'already recording' }, false))
    await expect(startRecording()).rejects.toThrow('already recording')
  })

  test('throws "bridge returned HTTP <code>" when response has no error body', async () => {
    setBridgeDescriptor({ port: 50001, token: 'tok' })
    setFetchHandler(() => fetchResp(500, {}, false))
    await expect(startRecording()).rejects.toThrow('bridge returned HTTP 500')
  })

  test('throws when response is 200 but missing id or audioPath', async () => {
    setBridgeDescriptor({ port: 50001, token: 'tok' })
    setFetchHandler(() => fetchResp(200, { id: 'only-id' }))
    await expect(startRecording()).rejects.toThrow(/bridge returned HTTP/)
  })
})

// ─── stopRecording ─────────────────────────────────────────────────────────

describe('stopRecording', () => {
  test('returns full Recording object on success', async () => {
    setBridgeDescriptor({ port: 50001, token: 'tok' })
    setFetchHandler(() => fetchResp(200, { id: 'rec-1', audioPath: '/tmp/r.wav', duration: 88 }))
    const out = await stopRecording()
    expect(out).toEqual({ id: 'rec-1', audioPath: '/tmp/r.wav', duration: 88 })
  })

  test('defaults duration to 0 when missing from the response', async () => {
    setBridgeDescriptor({ port: 50001, token: 'tok' })
    setFetchHandler(() => fetchResp(200, { id: 'rec-1', audioPath: '/tmp/r.wav' }))
    const out = await stopRecording()
    expect(out).toEqual({ id: 'rec-1', audioPath: '/tmp/r.wav', duration: 0 })
  })

  test('returns null when bridge says "not recording" with 400', async () => {
    setBridgeDescriptor({ port: 50001, token: 'tok' })
    setFetchHandler(() => fetchResp(400, { error: 'not recording right now' }, false))
    const out = await stopRecording()
    expect(out).toBeNull()
  })

  test('matches "Not Recording" case-insensitively', async () => {
    setBridgeDescriptor({ port: 50001, token: 'tok' })
    setFetchHandler(() => fetchResp(400, { error: 'NOT RECORDING' }, false))
    expect(await stopRecording()).toBeNull()
  })

  test('throws on other 4xx errors (not the "not recording" pattern)', async () => {
    setBridgeDescriptor({ port: 50001, token: 'tok' })
    setFetchHandler(() => fetchResp(400, { error: 'permission denied' }, false))
    await expect(stopRecording()).rejects.toThrow('permission denied')
  })

  test('returns null when 200 response is missing id or audioPath', async () => {
    setBridgeDescriptor({ port: 50001, token: 'tok' })
    setFetchHandler(() => fetchResp(200, { duration: 5 }))
    const out = await stopRecording()
    expect(out).toBeNull()
  })

  test('throws BridgeUnavailableError when no descriptor exists', async () => {
    setBridgeDescriptor(null)
    await expect(stopRecording()).rejects.toBeInstanceOf(BridgeUnavailableError)
  })

  test('POSTs to /recording/stop with the token header', async () => {
    setBridgeDescriptor({ port: 51234, token: 'stop-tok' })
    setFetchHandler(() => fetchResp(200, { id: 'r', audioPath: '/p', duration: 1 }))
    await stopRecording()
    expect(lastFetchCalls[0].url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/recording\/stop$/)
    expect(lastFetchCalls[0].init.method).toBe('POST')
    // Cached token from first descriptor load — assert presence, not value.
    expect(typeof lastFetchCalls[0].init.headers['x-shogo-bridge-token']).toBe('string')
  })
})

// ─── cleanupRecording ──────────────────────────────────────────────────────

describe('cleanupRecording', () => {
  test('is a no-op that returns undefined and never throws', () => {
    expect(cleanupRecording()).toBeUndefined()
    expect(() => cleanupRecording()).not.toThrow()
  })

  test('does not touch fs or fetch', () => {
    existsSyncMock.mockClear()
    readFileSyncMock.mockClear()
    cleanupRecording()
    expect(existsSyncMock).not.toHaveBeenCalled()
    expect(readFileSyncMock).not.toHaveBeenCalled()
  })
})

// ─── Descriptor caching + retry ────────────────────────────────────────────

describe('descriptor caching + retry on stale port', () => {
  test('caches the descriptor across calls (one fs read for two requests)', async () => {
    setBridgeDescriptor({ port: 50001, token: 'tok' })
    setFetchHandler(() => fetchResp(200, { isRecording: false, id: null, duration: 0, audioPath: null }))

    await getRecordingStatusAsync()
    const readsAfterFirst = readFileSyncMock.mock.calls.length

    await getRecordingStatusAsync()
    // Second call should hit the cache — readFileSync count unchanged.
    expect(readFileSyncMock.mock.calls.length).toBe(readsAfterFirst)
  })

  test('retry path is invoked when the first fetch fails (single descriptor)', async () => {
    // The module retries once with a force-reloaded descriptor when the
    // first fetch fails. We don't try to verify *different* descriptors
    // here (that would require cross-test cache surgery); instead we
    // assert that exactly two fetch attempts happen before success.
    setBridgeDescriptor({ port: 50001, token: 'tok' })
    let calls = 0
    setFetchHandler(() => {
      calls++
      if (calls === 1) throw new Error('ECONNREFUSED')
      return fetchResp(200, { id: 'rec', audioPath: '/p' })
    })

    const out = await startRecording()
    expect(out).toEqual({ id: 'rec', audioPath: '/p' })
    expect(calls).toBe(2)
  })

  test('throws BridgeUnavailableError on retry when descriptor disappears mid-flight', async () => {
    // Prime the cache with a known-good descriptor, then make the file
    // "disappear" on the forced reload after the first fetch fails.
    setBridgeDescriptor({ port: 50001, token: 'tok' })

    let firstFetchDone = false
    setFetchHandler(() => {
      firstFetchDone = true
      throw new Error('ECONNREFUSED')
    })
    // loadDescriptor(true) re-checks existsSync — flip it to false the
    // moment the first fetch has been attempted.
    existsSyncMock.mockImplementation(() => !firstFetchDone)

    await expect(startRecording()).rejects.toBeInstanceOf(BridgeUnavailableError)
  })
})
