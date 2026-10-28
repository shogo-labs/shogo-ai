// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from 'bun:test'
import {
  LEGACY_INLINE_IMAGE_KEEP_BYTES,
  trimLegacyInlineAttachments,
} from '../trim-history-attachments'

const DATA_URL = 'data:application/zip;base64,AAAA'

const user = (parts: any[], id = 'u1') => ({ id, role: 'user', parts })
const assistant = (parts: any[], id = 'a1') => ({ id, role: 'assistant', parts })

function imageUrl(bytes: number): string {
  // base64 expands 3 bytes to 4 chars; a rough body of the right length is
  // all the trim looks at.
  const chars = Math.ceil((bytes / 3) * 4)
  return `data:image/png;base64,${'A'.repeat(chars)}`
}

describe('trimLegacyInlineAttachments', () => {
  test('replaces an earlier turn\'s inline attachment with a stub and a note', () => {
    const messages = [
      user([{ type: 'text', text: 'here is the zip' }, { type: 'file', mediaType: 'application/zip', url: DATA_URL, name: 'bundle.zip' }]),
      assistant([{ type: 'text', text: 'got it' }]),
      user([{ type: 'text', text: 'now what?' }]),
    ]

    const trimmed = trimLegacyInlineAttachments(messages as any) as any[]

    expect(trimmed[0].parts).toEqual([
      { type: 'text', text: 'here is the zip' },
      { type: 'file', mediaType: 'application/zip', name: 'bundle.zip' },
      {
        type: 'text',
        text: '[Attachment "bundle.zip" (application/zip) was sent earlier in this chat; its contents are not resent with later turns.]',
      },
    ])
    // The message being sent is untouched.
    expect(trimmed[2]).toBe(messages[2])
    // The input is not mutated.
    expect(messages[0].parts[1].url).toBe(DATA_URL)
  })

  test('never trims the message being sent, even on a regenerate', () => {
    // Regenerate re-sends the last user message, so its bytes have to stay.
    const messages = [
      user([{ type: 'text', text: 'look' }], 'u1'),
      assistant([{ type: 'text', text: 'half an answer' }], 'a1'),
    ]
    expect(trimLegacyInlineAttachments(messages as any)).toBe(messages as any)

    const withFile = [
      user([{ type: 'file', mediaType: 'application/zip', url: DATA_URL, name: 'z.zip' }], 'u1'),
      assistant([{ type: 'text', text: 'partial' }], 'a1'),
    ]
    const trimmed = trimLegacyInlineAttachments(withFile as any) as any[]
    expect(trimmed[0].parts[0].url).toBe(DATA_URL)
  })

  test('leaves reference parts alone — they carry no bytes', () => {
    const messages = [
      user([
        {
          type: 'file',
          mediaType: 'application/zip',
          url: 'https://agent.test/agent/workspace/download/files/bundle.zip',
          name: 'bundle.zip',
          savedPath: 'files/bundle.zip',
        },
      ]),
      user([{ type: 'text', text: 'next' }]),
    ]
    expect(trimLegacyInlineAttachments(messages as any)).toBe(messages as any)
  })

  test('keeps the newest small inline images so a cold session still gets vision', () => {
    const small = imageUrl(1024)
    const messages = [
      user([{ type: 'file', mediaType: 'image/png', url: small, name: 'a.png' }], 'u1'),
      user([{ type: 'file', mediaType: 'image/png', url: small, name: 'b.png' }], 'u2'),
      user([{ type: 'text', text: 'what do you see?' }], 'u3'),
    ]

    const trimmed = trimLegacyInlineAttachments(messages as any) as any[]
    expect(trimmed[0].parts[0].url).toBe(small)
    expect(trimmed[1].parts[0].url).toBe(small)
  })

  test('trims an inline image that is over the keep cap', () => {
    const big = imageUrl(LEGACY_INLINE_IMAGE_KEEP_BYTES + 1024)
    const messages = [
      user([{ type: 'file', mediaType: 'image/png', url: big, name: 'huge.png' }], 'u1'),
      user([{ type: 'text', text: 'and now?' }], 'u2'),
    ]

    const trimmed = trimLegacyInlineAttachments(messages as any) as any[]
    expect(trimmed[0].parts[0].url).toBeUndefined()
    expect(trimmed[0].parts[1].type).toBe('text')
  })

  test('keeps only the newest N inline images', () => {
    const small = imageUrl(1024)
    const messages = [
      ...Array.from({ length: 8 }, (_, i) =>
        user([{ type: 'file', mediaType: 'image/png', url: small, name: `p${i}.png` }], `u${i}`),
      ),
      user([{ type: 'text', text: 'go' }], 'last'),
    ]

    const trimmed = trimLegacyInlineAttachments(messages as any, { keepImageCount: 2 }) as any[]
    const inlineCount = trimmed
      .slice(0, 8)
      .filter((m: any) => m.parts.some((p: any) => typeof p.url === 'string' && p.url.startsWith('data:'))).length
    expect(inlineCount).toBe(2)
    // Newest two survive.
    expect(trimmed[6].parts[0].url).toBe(small)
    expect(trimmed[7].parts[0].url).toBe(small)
    expect(trimmed[0].parts[0].url).toBeUndefined()
  })

  test('is a no-op for a transcript with no legacy attachments', () => {
    const messages = [
      user([{ type: 'text', text: 'hi' }]),
      assistant([{ type: 'text', text: 'hello' }]),
      user([{ type: 'text', text: 'again' }]),
    ]
    expect(trimLegacyInlineAttachments(messages as any)).toBe(messages as any)
  })
})
