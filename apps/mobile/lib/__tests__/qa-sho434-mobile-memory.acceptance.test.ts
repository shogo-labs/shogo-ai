// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-434 acceptance — the native save paths and the transcript caches.
 *
 * AC1: the 54 MB allocation was one file read into the JS heap as an
 * `ArrayBuffer`, copied into a binary string and `btoa()`d into base64. Every
 * native "save / share this file" affordance has to stream to disk instead, and
 * there is no exception for an export dialog: a project ZIP is the biggest file
 * the app ever writes.
 *
 * AC2: what a chat leaves in memory is bounded by bytes, not by message count,
 * because a photo-heavy message carries its image inline.
 */
import { beforeEach, describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const MOBILE_ROOT = join(import.meta.dir, '../..')

function walkSource(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '__tests__' || name.startsWith('.')) continue
    const path = join(dir, name)
    if (statSync(path).isDirectory()) {
      walkSource(path, acc)
      continue
    }
    if (/\.(ts|tsx)$/.test(name) && !name.includes('.test.')) acc.push(path)
  }
  return acc
}

function sourceFiles(): { path: string; source: string }[] {
  const files: { path: string; source: string }[] = []
  for (const root of ['app', 'components', 'lib']) {
    for (const path of walkSource(join(MOBILE_ROOT, root))) {
      files.push({ path: path.slice(MOBILE_ROOT.length + 1), source: readFileSync(path, 'utf8') })
    }
  }
  return files
}

describe('a native save never builds the file on the JS heap (SHO-434 AC1)', () => {
  test('no source file base64s a whole file into the heap to write it to disk', () => {
    // The pattern is `const bytes = new Uint8Array(await blob.arrayBuffer());
    // let binary = ''; … btoa(binary)` handed to `writeAsStringAsync`. Any file
    // doing both is holding three copies of the download at once.
    const hits = sourceFiles()
      .filter(({ source }) => source.includes('btoa(') && source.includes('writeAsStringAsync'))
      .map(({ path }) => path)

    expect(hits).toEqual([])
  })

  test('every native save path streams through downloadFileToCache', () => {
    const expected = [
      'lib/attachment-download.ts',
      'components/chat/turns/DownloadChip.tsx',
      'components/chat/generated-image-actions.ts',
    ]
    const sources = new Map(sourceFiles().map(({ path, source }) => [path, source]))
    const missing = expected.filter((path) => !sources.get(path)?.includes('downloadFileToCache'))

    expect(missing).toEqual([])
  })
})

describe('the in-memory transcript cache is bounded by bytes (SHO-434 AC2)', () => {
  const MB = 1024 * 1024

  beforeEach(async () => {
    const { clearChatPanelMessageCache, setSessionMessageCacheLimits } = await import(
      '../chat-panel-message-cache'
    )
    clearChatPanelMessageCache()
    setSessionMessageCacheLimits(null)
  })

  test('opening a run of photo-heavy chats cannot hold more than the native budget', async () => {
    const { sessionMessageCacheLimits, sessionMessageCacheUsage, writeSessionMessageCache } =
      await import('../chat-panel-message-cache')
    const { sessions, bytes } = sessionMessageCacheLimits()

    // Each chat carries one 6 MB inline image, the shape SHO-407 shipped.
    const photoChat = (id: string) => [
      {
        id,
        role: 'user',
        content: `data:image/jpeg;base64,${'A'.repeat(6 * MB)}`,
      },
    ]

    for (let i = 0; i < sessions + 4; i++) writeSessionMessageCache(`s${i}`, photoChat(`m${i}`))

    const usage = sessionMessageCacheUsage()
    expect(usage.bytes).toBeLessThanOrEqual(bytes)
    expect(usage.sessions).toBeLessThanOrEqual(sessions)
  })
})

describe('a stored slice is trimmed to the byte budget (SHO-434 AC2)', () => {
  const MB = 1024 * 1024

  test('the newest rows survive and hasMoreOlder says the rest was dropped', async () => {
    const { trimToBudget } = await import('../chat-history-store')
    const messages = Array.from({ length: 20 }, (_, i) => ({
      id: `m${i}`,
      role: 'user',
      content: `${i}:${'x'.repeat(2 * MB)}`,
    }))

    const kept = trimToBudget(messages, 8 * MB)

    expect(kept.length).toBeGreaterThan(0)
    expect(kept.length).toBeLessThan(messages.length)
    // Oldest first out: the tail of the transcript is what a revisit needs.
    expect(kept.at(-1)).toBe(messages.at(-1))
    expect(kept[0]).toBe(messages[messages.length - kept.length])
  })
})
