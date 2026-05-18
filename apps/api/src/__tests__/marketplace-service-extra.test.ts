// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Extra tests for src/services/marketplace.service.ts — targets the
 * branches the main suite under-exercises:
 *
 *  - `generateSlug` retry loop: when the base slug is taken, append a
 *    suffix; when even the suffix is taken, retry again; after 32
 *    failed attempts in total, throw.
 *  - `generateSlug` returns 'listing' as the slug for titles that
 *    slugify to the empty string (only punctuation / whitespace).
 *  - `generateSlug` strips diacritics-but-not-letters (\p{L} keeps
 *    accented chars, \p{N} keeps numbers).
 *  - `generateSlug` collapses repeated separators and trims edge
 *    dashes.
 *  - `generateSlug` handles non-Latin scripts (Cyrillic, CJK) by
 *    keeping the letters intact (\p{L}).
 *
 *   bun test apps/api/src/__tests__/marketplace-service-extra.test.ts
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { PRISMA_NAMESPACE, withPrismaExports } from './helpers/prisma-mock-exports'

let takenSlugs = new Set<string>()
let nanoIdCounter = 0

mock.module('nanoid', () => ({
  customAlphabet: () => () => {
    nanoIdCounter += 1
    return `s${nanoIdCounter.toString().padStart(4, '0')}`
  },
  nanoid: () => 'nano',
}))

mock.module('../lib/prisma', () => withPrismaExports({
  prisma: {
    marketplaceListing: {
      findUnique: async ({ where }: any) =>
        takenSlugs.has(where.slug) ? { slug: where.slug } : null,
    },
  } as any,
}))

const { generateSlug } = await import('../services/marketplace.service')

beforeEach(() => {
  takenSlugs = new Set()
  nanoIdCounter = 0
})

describe('generateSlug — happy path', () => {
  test('returns the kebab-cased base when no collision', async () => {
    expect(await generateSlug('Hello World')).toBe('hello-world')
  })

  test('strips non-letter / non-number punctuation', async () => {
    expect(await generateSlug('Hello, World! @#$%')).toBe('hello-world')
  })

  test('strips underscores entirely AND collapses whitespace runs into single dash', async () => {
    // The first regex removes underscores BEFORE the [\s_]+ replacement runs,
    // so 'hello___world' slugifies to 'helloworld', not 'hello-world'.
    expect(await generateSlug('hello   world')).toBe('hello-world')
    expect(await generateSlug('hello___world')).toBe('helloworld')
    expect(await generateSlug('hello \t\n world')).toBe('hello-world')
  })

  test('collapses repeated dashes', async () => {
    expect(await generateSlug('hello---world')).toBe('hello-world')
  })

  test('trims leading and trailing dashes', async () => {
    expect(await generateSlug('---hello---')).toBe('hello')
  })

  test('preserves diacritics (\\p{L} matches accented letters)', async () => {
    expect(await generateSlug('Café Über Naïve')).toBe('café-über-naïve')
  })

  test('preserves digits (\\p{N} matches numbers)', async () => {
    expect(await generateSlug('Top 10 Tools 2026')).toBe('top-10-tools-2026')
  })

  test('preserves non-Latin scripts (\\p{L} matches Cyrillic / CJK)', async () => {
    const cyr = await generateSlug('Привет мир')
    expect(cyr).toBe('привет-мир')
    const cjk = await generateSlug('日本語 テスト')
    expect(cjk.length).toBeGreaterThan(0)
    expect(cjk).toContain('-')
  })
})

describe('generateSlug — empty-result fallback', () => {
  test('punctuation-only title slugifies to "listing"', async () => {
    expect(await generateSlug('!!!')).toBe('listing')
  })

  test('whitespace-only title slugifies to "listing"', async () => {
    expect(await generateSlug('     ')).toBe('listing')
  })

  test('empty string slugifies to "listing"', async () => {
    expect(await generateSlug('')).toBe('listing')
  })
})

describe('generateSlug — collision retry', () => {
  test('appends nanoid suffix when base is taken', async () => {
    takenSlugs.add('hello-world')
    const slug = await generateSlug('Hello World')
    expect(slug).toMatch(/^hello-world-s\d{4}$/)
  })

  test('retries with successive suffixes until one is free', async () => {
    takenSlugs.add('hi')
    takenSlugs.add('hi-s0001') // first 5 suffixes also taken
    takenSlugs.add('hi-s0002')
    takenSlugs.add('hi-s0003')
    takenSlugs.add('hi-s0004')
    const slug = await generateSlug('Hi')
    expect(slug).toBe('hi-s0005')
  })

  test('throws after 32 failed attempts', async () => {
    takenSlugs.add('busy')
    // Force every suffix to also be taken.
    for (let i = 1; i <= 40; i++) {
      takenSlugs.add(`busy-s${i.toString().padStart(4, '0')}`)
    }
    await expect(generateSlug('Busy')).rejects.toThrow(
      'Could not generate a unique listing slug',
    )
  })

  test('base + falls-back-to-"listing" still goes through the retry loop on collision', async () => {
    takenSlugs.add('listing')
    const slug = await generateSlug('!!!')
    expect(slug).toMatch(/^listing-s\d{4}$/)
  })
})
