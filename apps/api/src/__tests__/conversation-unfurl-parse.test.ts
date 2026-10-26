// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * What the link-preview parser makes of a page. The crawler had no unit tests
 * at all, which is how a 200KB read window survived while YouTube — whose head
 * alone runs past 512KB — silently never previewed.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { extractLinks, parseUnfurl } from '../services/conversation-unfurl'

const page = (head: string) => `<!doctype html><html><head>${head}</head><body>body</body></html>`

describe('parseUnfurl', () => {
  test('reads metadata that sits far into the document', () => {
    // Padded the way a real heavy page is: the tags are nowhere near the top.
    const filler = `<script>${'x'.repeat(400_000)}</script>`
    const html = page(`${filler}<meta property="og:title" content="Quarterly Plan"><meta property="og:image" content="https://cdn.example.com/q.png">`)

    const card = parseUnfurl('https://example.com/deep', html)

    expect(card?.title).toBe('Quarterly Plan')
    expect(card?.image).toBe('https://cdn.example.com/q.png')
  })

  test('keeps a plain page that has a real title and description but no OG tags', () => {
    const html = page('<title>How we cut build times in half</title><meta name="description" content="A post about CI.">')

    const card = parseUnfurl('https://blog.example.com/ci', html)

    expect(card?.title).toBe('How we cut build times in half')
    expect(card?.description).toBe('A post about CI.')
  })

  test('resolves a relative og:image and drops an insecure one', () => {
    expect(parseUnfurl('https://example.com/a/b', page('<meta property="og:title" content="T"><meta property="og:image" content="/i.png">'))?.image)
      .toBe('https://example.com/i.png')
    expect(parseUnfurl('https://example.com/a/b', page('<meta property="og:title" content="T"><meta property="og:image" content="http://example.com/i.png">'))?.image)
      .toBeNull()
  })

  test('accepts the tags with content before property', () => {
    const html = page('<meta content="Reversed" property="og:title">')

    expect(parseUnfurl('https://example.com/', html)?.title).toBe('Reversed')
  })

  describe('pages that are walls, not documents', () => {
    test('a restricted Google Doc, handed a sign-in page, gets no card', () => {
      const html = page('<title>Sign in - Google Accounts</title><meta name="description" content="to continue to Google Docs">')

      expect(parseUnfurl('https://docs.google.com/document/d/SECRET/edit', html)).toBeNull()
    })

    test('a page titled only with its own hostname gets no card', () => {
      expect(parseUnfurl('https://www.nytimes.com/', page('<title>nytimes.com</title>'))).toBeNull()
      expect(parseUnfurl('https://www.instagram.com/p/abc/', page('<title>Instagram</title>'))).toBeNull()
    })

    test('an error or consent interstitial gets no card', () => {
      expect(parseUnfurl('https://example.com/', page('<title>Page Not Found</title>'))).toBeNull()
      expect(parseUnfurl('https://example.com/', page('<title>Just a moment...</title>'))).toBeNull()
    })

    test('a page that does declare rich metadata is kept whatever its title', () => {
      const html = page('<title>Instagram</title><meta property="og:title" content="Instagram"><meta property="og:image" content="https://cdn.example.com/i.png">')

      expect(parseUnfurl('https://www.instagram.com/p/abc/', html)?.title).toBe('Instagram')
    })

    test('a title that merely starts with a filler word is kept', () => {
      const html = page('<title>Error handling in Rust</title>')

      expect(parseUnfurl('https://blog.example.com/rust', html)?.title).toBe('Error handling in Rust')
    })
  })

  test('a page with no title at all gets no card', () => {
    expect(parseUnfurl('https://example.com/', page('<meta name="viewport" content="width=device-width">'))).toBeNull()
  })
})

describe('extractLinks', () => {
  const APP_URL = 'https://qa70.example.test'
  const saved = process.env.APP_URL

  afterEach(() => {
    if (saved === undefined) delete process.env.APP_URL
    else process.env.APP_URL = saved
  })

  test('a link to our own app is never unfurled', () => {
    process.env.APP_URL = APP_URL

    // Every one of these answers with the same SPA shell, so a preview of it is
    // an empty card — and it would sit right next to the quote of the message.
    expect(extractLinks(`${APP_URL}/c/abc?msg=123`)).toEqual([])
    expect(extractLinks(`${APP_URL}/f/att-123`)).toEqual([])
    expect(extractLinks(`${APP_URL}/c/abc?doc=1`)).toEqual([])
  })

  test('links to anyone else are still previewed', () => {
    process.env.APP_URL = APP_URL

    expect(extractLinks(`${APP_URL}/c/abc?msg=1 and https://elsewhere.dev/post`)).toEqual(['https://elsewhere.dev/post'])
  })

  test('code fences and the <…> no-preview convention still win', () => {
    process.env.APP_URL = APP_URL

    expect(extractLinks('`https://elsewhere.dev/a` <https://elsewhere.dev/b>')).toEqual([])
    expect(extractLinks('```\nhttps://elsewhere.dev/c\n```')).toEqual([])
  })
})
