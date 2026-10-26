// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { beforeEach, describe, expect, test } from 'bun:test'
import {
  FALLBACK_TECH_STACKS,
  cachedTechStacks,
  loadTechStacks,
  mergeTechStacks,
  resetTechStackCache,
  techStackDisplayName,
} from '../tech-stack-catalog'

describe('techStackDisplayName', () => {
  test('resolves known ids from the fallback catalog', () => {
    expect(techStackDisplayName('react-app')).toBe('React App')
    expect(techStackDisplayName('expo-app')).toBe('Expo (React Native)')
    expect(techStackDisplayName('video-editor')).toBe('Video Editor')
    expect(techStackDisplayName('missing')).toBe('Stack')
    expect(techStackDisplayName(undefined)).toBe('Stack')
  })

  test('the fallback catalog includes every project type the picker offers', () => {
    const ids = FALLBACK_TECH_STACKS.map((stack) => stack.id)
    for (const id of ['react-app', 'expo-app', 'python-data', 'video-editor', 'custom', 'none']) {
      expect(ids).toContain(id)
    }
  })
})

describe('mergeTechStacks', () => {
  test('keeps the accordion populated when the API is empty or missing', () => {
    expect(mergeTechStacks(undefined)).toEqual(FALLBACK_TECH_STACKS)
    expect(mergeTechStacks([])).toEqual(FALLBACK_TECH_STACKS)
  })

  test('uses the fetched list when it has stacks', () => {
    const fetched = [{ id: 'react-app', name: 'React App', description: '', tags: [] }]
    expect(mergeTechStacks(fetched)).toEqual(fetched)
  })
})

describe('the shared stack catalog', () => {
  beforeEach(() => {
    resetTechStackCache()
  })

  test('paints the fallback before any request answers', () => {
    expect(cachedTechStacks()).toEqual(FALLBACK_TECH_STACKS)
  })

  test('one request per page, and every later mount starts from its result', async () => {
    const fetched = [{ id: 'react-app', name: 'React App (server)', description: '', tags: [] }]
    let calls = 0
    const fetch = async () => {
      calls += 1
      return fetched
    }

    // The toolbar chip and the plus-sheet's list mount together.
    const [a, b] = await Promise.all([loadTechStacks(fetch), loadTechStacks(fetch)])
    expect(a).toEqual(fetched)
    expect(b).toEqual(fetched)
    expect(calls).toBe(1)
    expect(cachedTechStacks()).toEqual(fetched)

    // A second visit (a fresh mount) paints the cached list and asks nothing.
    expect(await loadTechStacks(fetch)).toEqual(fetched)
    expect(calls).toBe(1)
  })

  test('a failed request keeps the fallback and lets the next mount retry', async () => {
    let calls = 0
    const fetch = async (): Promise<never> => {
      calls += 1
      throw new Error('boom')
    }

    expect(await loadTechStacks(fetch)).toEqual(FALLBACK_TECH_STACKS)
    expect(cachedTechStacks()).toEqual(FALLBACK_TECH_STACKS)
    expect(await loadTechStacks(fetch)).toEqual(FALLBACK_TECH_STACKS)
    expect(calls).toBe(2)
  })
})
