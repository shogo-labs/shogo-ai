// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { afterEach, beforeEach, describe, expect, mock, setSystemTime, test } from 'bun:test'

let storedValue: string | null = null
let reads = 0
let failDb = false

mock.module('../prisma', () => ({
  prisma: {
    platformSetting: {
      findUnique: async () => {
        reads++
        if (failDb) throw new Error('db down')
        return storedValue === null ? null : { value: storedValue }
      },
    },
  },
}))
mock.module('../resolve-language-model', () => ({ DEFAULT_ASSISTANT_MODEL: 'hoshi-2-0' }))

const { getSummarizerModelId, setSummarizerModelId, _resetSummarizerModelCache } = await import('../summarizer-model')

const origWarn = console.warn

beforeEach(() => {
  _resetSummarizerModelCache()
  storedValue = null
  reads = 0
  failDb = false
  console.warn = () => {}
  setSystemTime(new Date('2026-09-29T12:00:00Z'))
})

afterEach(() => {
  console.warn = origWarn
  setSystemTime()
})

describe('getSummarizerModelId', () => {
  test('defaults to Hoshi 2.0 when unset', async () => {
    expect(await getSummarizerModelId()).toBe('hoshi-2-0')
  })

  test('reads the stored value and caches it', async () => {
    storedValue = ' gpt-5.4-nano '
    expect(await getSummarizerModelId()).toBe('gpt-5.4-nano')
    expect(await getSummarizerModelId()).toBe('gpt-5.4-nano')
    expect(reads).toBe(1)
  })

  test('picks up a change written by another replica once the cache expires', async () => {
    storedValue = 'gpt-5.4-nano'
    await getSummarizerModelId()
    storedValue = 'claude-haiku-4-5'
    expect(await getSummarizerModelId()).toBe('gpt-5.4-nano')

    setSystemTime(new Date('2026-09-29T12:00:31Z'))
    expect(await getSummarizerModelId()).toBe('claude-haiku-4-5')
  })

  test('applies a local write immediately', async () => {
    storedValue = 'gpt-5.4-nano'
    await getSummarizerModelId()
    setSummarizerModelId('claude-haiku-4-5')
    expect(await getSummarizerModelId()).toBe('claude-haiku-4-5')
    setSummarizerModelId(null)
    expect(await getSummarizerModelId()).toBe('hoshi-2-0')
  })

  test('keeps the last known value when the database read fails', async () => {
    storedValue = 'gpt-5.4-nano'
    await getSummarizerModelId()
    failDb = true
    setSystemTime(new Date('2026-09-29T12:00:31Z'))
    expect(await getSummarizerModelId()).toBe('gpt-5.4-nano')
    expect(await getSummarizerModelId()).toBe('gpt-5.4-nano')
    expect(reads).toBe(2)
  })
})
