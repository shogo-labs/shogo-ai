// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * History seeding is a second entry point for client-sent images.
 *
 * AI SDK clients, eval runners and the desktop/web chat panel resend the whole
 * message array each turn. When the runtime session is empty (first turn after
 * a restart, a resumed conversation), `/agent/chat` rebuilds the prior turns
 * into the session. That rebuild used to flatten every `file` part into the
 * literal string `[N image(s) were attached]`, so a screenshot the user
 * attached two turns ago was invisible to the model on the replay — the live
 * turn had it, the seeded one did not.
 *
 * The seeded user message now carries real image blocks, produced through the
 * same guard the live path applies (`enforceImageSizeLimit`), so the corrupt
 * image that poisons a session (SHO-41) cannot enter through this second door.
 */
import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import type { ImageContent, Message } from '@mariozechner/pi-ai'
import { decodeImageInfo } from '../image-size-guard'
import { SessionManager } from '../session-manager'
import {
  MAX_SEEDED_HISTORY_IMAGES,
  seedEmptyChatSession,
  type SeedHistoryMessage,
} from '../file-attachment-utils'

const FIXTURE = new URL('./fixtures/screenshot-fixture.png', import.meta.url)

function fixtureBase64(name: 'png' | 'jpg' | 'gif' | 'webp' = 'png'): string {
  return readFileSync(new URL(`./fixtures/screenshot-fixture.${name}`, import.meta.url)).toString('base64')
}

/** Flip one byte inside IDAT — the fixture still sniffs as a PNG. */
function corruptPngBase64(): string {
  const bytes = readFileSync(FIXTURE)
  const corrupt = Buffer.from(bytes)
  corrupt[corrupt.length - 40] ^= 0xff
  return corrupt.toString('base64')
}

function imagePart(base64: string, mediaType = 'image/png') {
  return { type: 'file', mediaType, url: `data:${mediaType};base64,${base64}` }
}

function textPart(text: string) {
  return { type: 'text', text }
}

function userMessageWith(...parts: Array<Record<string, unknown>>): SeedHistoryMessage {
  return { role: 'user', parts: parts as SeedHistoryMessage['parts'] }
}

function assistantMessage(text: string): SeedHistoryMessage {
  return { role: 'assistant', parts: [textPart(text)] as SeedHistoryMessage['parts'] }
}

function seed(priorMessages: SeedHistoryMessage[]) {
  const manager = new SessionManager()
  const sessionId = 'seeded-session'
  const managerLike = {
    getOrCreate: (id: string) => manager.getOrCreate(id),
    addMessages: (id: string, ...msgs: Message[]) => manager.addMessages(id, ...msgs),
  }
  seedEmptyChatSession(managerLike, sessionId, priorMessages, { label: 'chat_history' })
  return manager.getOrCreate(sessionId).messages
}

function imageBlocks(messages: ReadonlyArray<Message>): ImageContent[] {
  return messages.flatMap((m) =>
    m.role === 'user' && Array.isArray(m.content)
      ? (m.content.filter((c) => c.type === 'image') as ImageContent[])
      : [],
  )
}

function textBlocks(message: Message): string[] {
  if (message.role !== 'user') return []
  if (!Array.isArray(message.content)) return [message.content]
  return message.content.filter((c) => c.type === 'text').map((c) => (c as { text: string }).text)
}

describe('chat history seeding — image attachments', () => {
  test('a real image data URL is seeded as a decodable image block', () => {
    const base64 = fixtureBase64('png')
    const messages = seed([
      userMessageWith(textPart('what is wrong with this screen?'), imagePart(base64)),
      assistantMessage('It is the sidebar.'),
      userMessageWith(textPart('and now?')),
    ])

    const images = imageBlocks(messages)
    expect(images).toHaveLength(1)
    expect(images[0].mimeType).toBe('image/png')

    const decoded = decodeImageInfo(images[0].data, images[0].mimeType)
    expect(decoded).not.toBeNull()
    expect(decoded!.width).toBe(64)
    expect(decoded!.height).toBe(64)
  })

  test('the seeded turn keeps the user text alongside the image', () => {
    const messages = seed([
      userMessageWith(textPart('what is wrong with this screen?'), imagePart(fixtureBase64())),
    ])

    expect(textBlocks(messages[0]).join('\n')).toContain('what is wrong with this screen?')
    // No legacy flattening note anywhere in the seeded history.
    expect(textBlocks(messages[0]).join('\n')).not.toContain('image(s) were attached')
  })

  test('a corrupt image data URL never enters the session — placeholder only', () => {
    const messages = seed([
      userMessageWith(textPart('what is wrong with this screen?'), imagePart(corruptPngBase64())),
      userMessageWith(textPart('still waiting')),
    ])

    expect(imageBlocks(messages)).toHaveLength(0)
    const seeded = textBlocks(messages[0])
    const placeholders = seeded.filter((t) => t.includes('[Image omitted'))
    expect(placeholders).toHaveLength(1)
    expect(placeholders[0]).toContain('[Image omitted — chat_history]')
    // The turn still seeds: the user's text survives the dropped image.
    expect(seeded.join('\n')).toContain('what is wrong with this screen?')
    expect(messages).toHaveLength(2)
  })

  test('a data-URL text attachment is inlined, not flattened to a note', () => {
    const messages = seed([
      userMessageWith(
        textPart('summarise this'),
        { type: 'file', mediaType: 'text/plain', url: `data:text/plain;base64,${Buffer.from('hello from the file').toString('base64')}` },
      ),
    ])

    const text = textBlocks(messages[0]).join('\n')
    expect(text).toContain('hello from the file')
    expect(text).not.toContain('file(s) were attached')
  })

  test('a non-data URL keeps the legacy note — seeding never fetches a host', () => {
    const messages = seed([
      userMessageWith(
        textPart('see this'),
        { type: 'file', mediaType: 'image/png', url: 'https://example.com/remote.png', name: 'remote.png' },
      ),
    ])

    expect(imageBlocks(messages)).toHaveLength(0)
    expect(textBlocks(messages[0])).toHaveLength(1)
    expect(textBlocks(messages[0])[0]).toContain('[1 file(s) were attached]')
  })

  test('a text-only prior message is seeded byte-identically to before', () => {
    const messages = seed([userMessageWith(textPart('just text')), assistantMessage('ok')])

    expect(messages).toHaveLength(2)
    expect(messages[0].role).toBe('user')
    // String content, not a one-element content array.
    expect(messages[0].content).toBe('just text')
    expect(messages[1].role).toBe('assistant')
  })

  test('an empty prior message is still skipped, as before', () => {
    const messages = seed([userMessageWith(), assistantMessage('ok')])
    expect(messages).toHaveLength(1)
    expect(messages[0].role).toBe('assistant')
  })

  test('seeding is skipped entirely when the session already has messages', () => {
    const manager = new SessionManager()
    const sessionId = 'already-populated'
    const priorMessages = [
      userMessageWith(textPart('what is wrong with this screen?'), imagePart(fixtureBase64())),
    ]

    expect(seedEmptyChatSession(manager, sessionId, priorMessages)).toBe(1)
    expect(seedEmptyChatSession(manager, sessionId, priorMessages)).toBe(0)
    expect(manager.getOrCreate(sessionId).messages).toHaveLength(1)
  })

  test(`only the last ${MAX_SEEDED_HISTORY_IMAGES} images across the history are seeded`, () => {
    const kinds = ['png', 'jpg', 'gif', 'webp', 'png', 'jpg', 'gif'] as const
    const priorMessages = kinds.map((kind, i) =>
      userMessageWith(textPart(`shot ${i + 1}`), imagePart(fixtureBase64(kind), `image/${kind === 'jpg' ? 'jpeg' : kind}`)),
    )

    const messages = seed(priorMessages)
    const images = imageBlocks(messages)

    expect(images).toHaveLength(MAX_SEEDED_HISTORY_IMAGES)
    // The oldest image (png) is dropped; the tail survives in order.
    expect(images.map((i) => i.mimeType)).toEqual([
      'image/jpeg', 'image/gif', 'image/webp', 'image/png', 'image/jpeg', 'image/gif',
    ])
    // The dropped attachment is still announced on its own turn.
    expect(textBlocks(messages[0]).join('\n')).toContain('[1 image(s) were attached]')
  })

  test('assistant turns stay text-only even next to an image turn', () => {
    const messages = seed([
      userMessageWith(textPart('look'), imagePart(fixtureBase64())),
      assistantMessage('I see it.'),
    ])

    expect(messages).toHaveLength(2)
    expect(messages[1].role).toBe('assistant')
    expect((messages[1] as { content: Array<{ type: string; text?: string }> }).content).toEqual([
      { type: 'text', text: 'I see it.' },
    ])
  })
})
