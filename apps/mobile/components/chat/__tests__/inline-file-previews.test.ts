// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * What a chat message links to that is worth showing. A share link arrives as
 * `[name](url)` or a bare URL — almost never as markdown image syntax — so the
 * extractor has to find both without inventing cards for code, documents or a
 * link it cannot classify (SHO-388).
 */
import { describe, expect, test } from 'bun:test'
import { extractInlineMediaLinks } from '../inline-file-previews'

function token(claims: Record<string, unknown>): string {
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url')
  return `/api/f/${payload}.sig`
}

const png = token({ projectId: 'p1', path: 'shots/screen.png', exp: 4102444800 })
const mp4 = token({ projectId: 'p1', path: 'clips/demo.mp4', exp: 4102444800 })
const pdf = token({ projectId: 'p1', path: 'reports/q4.pdf', exp: 4102444800 })
const secret = token({ projectId: 'p1', path: 'notes/plan.md', exp: 4102444800 })

describe('extractInlineMediaLinks', () => {
  test('finds a named image link', () => {
    const found = extractInlineMediaLinks(`Here it is: [screen.png](https://studio.shogo.ai${png})`)
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({ href: `https://studio.shogo.ai${png}`, name: 'screen.png', mediaKind: 'image' })
  })

  test('finds a bare image URL', () => {
    const found = extractInlineMediaLinks(`See https://studio.shogo.ai${png} for the shot`)
    expect(found).toHaveLength(1)
    expect(found[0]!.name).toBe('screen.png')
  })

  test('finds a video', () => {
    const found = extractInlineMediaLinks(`[demo.mp4](https://studio.shogo.ai${mp4})`)
    expect(found[0]).toMatchObject({ name: 'demo.mp4', mediaKind: 'video' })
  })

  test('finds a stored conversation file by its filename', () => {
    const found = extractInlineMediaLinks(
      'https://studio.shogo.ai/api/conversation-files/ws-1/c-1/abc?filename=photo.jpg',
    )
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({ name: 'photo.jpg', mediaKind: 'image' })
  })

  test('keeps documents out', () => {
    for (const href of [`https://studio.shogo.ai${pdf}`, `https://studio.shogo.ai${secret}`]) {
      expect(extractInlineMediaLinks(`[report](${href})`)).toEqual([])
      expect(extractInlineMediaLinks(href)).toEqual([])
    }
  })

  test('does not duplicate an image already drawn from markdown image syntax', () => {
    const found = extractInlineMediaLinks(`![screen.png](https://studio.shogo.ai${png})`)
    expect(found).toEqual([])
  })

  test('de-dupes the same target written twice', () => {
    const url = `https://studio.shogo.ai${png}`
    const found = extractInlineMediaLinks(`[shot](${url}) and again ${url}`)
    expect(found).toHaveLength(1)
  })

  test('ignores links inside code', () => {
    const url = `https://studio.shogo.ai${png}`
    expect(extractInlineMediaLinks('```\n' + url + '\n```')).toEqual([])
    expect(extractInlineMediaLinks(`use \`${url}\` here`)).toEqual([])
  })

  test('returns every media link in order; the component caps the cards', () => {
    const links = Array.from({ length: 6 }, (_, index) =>
      `[shot-${index}.png](https://studio.shogo.ai${token({ path: `shots/${index}.png`, exp: 4102444800 })})`,
    )
    const found = extractInlineMediaLinks(links.join('\n'))
    expect(found.map((target) => target.name)).toEqual([
      '0.png',
      '1.png',
      '2.png',
      '3.png',
      '4.png',
      '5.png',
    ])
  })

  test('falls back to the link text when the token says only "Download"', () => {
    const bare = token({ projectId: 'p1', exp: 4102444800 })
    const found = extractInlineMediaLinks(`[screenshot.png](https://studio.shogo.ai${bare})`)
    expect(found[0]!.name).toBe('screenshot.png')
  })

  test('drops a URL that runs to the end of a still-streaming message', () => {
    const url = `https://studio.shogo.ai${png}`
    expect(extractInlineMediaLinks(`here: ${url}`, { isStreaming: true })).toEqual([])
    expect(extractInlineMediaLinks(`here: ${url}`, { isStreaming: false })).toHaveLength(1)
    // A finished link followed by text is complete even mid-stream.
    expect(extractInlineMediaLinks(`${url} done`, { isStreaming: true })).toHaveLength(1)
  })
})
