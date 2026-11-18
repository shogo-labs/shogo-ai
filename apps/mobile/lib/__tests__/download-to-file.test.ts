// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Saving a remote file on native (SHO-434).
 *
 * The point of this module is what it does NOT do: it never reads the response
 * into the JS heap. A 40 MB attachment used to be an `ArrayBuffer`, a binary
 * string and a 54 MB base64 string alive at the same time, and that last
 * allocation is the one that threw `OutOfMemoryError` on Android.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test'

interface DownloadCall {
  url: string
  target: string
  headers?: Record<string, string>
}

let calls: DownloadCall[] = []
let deleted: string[] = []
let status = 200

mock.module('expo-file-system/legacy', () => ({
  cacheDirectory: 'file:///cache/',
  deleteAsync: async (uri: string) => {
    deleted.push(uri)
  },
  downloadAsync: async (
    url: string,
    target: string,
    options?: { headers?: Record<string, string> },
  ) => {
    calls.push({ url, target, headers: options?.headers })
    return { uri: target, status, headers: {}, mimeType: null }
  },
}))

const { downloadFileToCache, safeCacheFileName } = await import('../download-to-file')

const fetched: unknown[] = []

beforeEach(() => {
  calls = []
  deleted = []
  fetched.length = 0
  status = 200
  globalThis.fetch = (async (...args: unknown[]) => {
    fetched.push(args[0])
    throw new Error('fetch must not be used: the bytes would cross the JS heap')
  }) as unknown as typeof fetch
})

describe('streaming a download to disk', () => {
  test('hands the URL to the platform downloader, never to fetch', async () => {
    const uri = await downloadFileToCache('https://api.test/agent/workspace/download/big.zip', {
      name: 'big.zip',
      headers: { Cookie: 'session=abc' },
    })

    expect(fetched).toHaveLength(0)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('https://api.test/agent/workspace/download/big.zip')
    expect(calls[0]!.headers).toEqual({ Cookie: 'session=abc' })
    // Written under the cache directory, still named for the user.
    expect(calls[0]!.target.startsWith('file:///cache/')).toBe(true)
    expect(calls[0]!.target.endsWith('-big.zip')).toBe(true)
    expect(uri).toBe(calls[0]!.target)
  })

  test('a non-2xx answer throws the real status and leaves no half file', async () => {
    status = 413
    await expect(
      downloadFileToCache('https://api.test/agent/workspace/download/huge.bin', { name: 'huge.bin' }),
    ).rejects.toThrow('Download failed (413)')
    expect(deleted).toHaveLength(1)
  })

  test('sends no headers at all when the caller has none', async () => {
    await downloadFileToCache('https://api.test/api/conversation-files/att-1?t=sig&dl=1', {
      name: 'guide.pdf',
    })
    expect(calls[0]!.headers).toBeUndefined()
  })
})

describe('the local file name', () => {
  test('is the leaf alone, so a path from elsewhere cannot escape the cache', () => {
    expect(safeCacheFileName('conversations/ws-1/report.pdf')).toBe('report.pdf')
    expect(safeCacheFileName('..\\..\\etc\\passwd')).toBe('passwd')
    expect(safeCacheFileName('../../escape.txt')).toBe('escape.txt')
  })

  test('keeps a readable name and falls back when there is nothing to keep', () => {
    expect(safeCacheFileName('EM Onboarding Guide - KM.pptx')).toBe('EM Onboarding Guide - KM.pptx')
    expect(safeCacheFileName('   ')).toBe('download')
    expect(safeCacheFileName('...')).toBe('download')
  })
})
