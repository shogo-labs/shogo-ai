// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Acceptance coverage for SHO-44 — a chat-UI image must survive the history
 * replay a client seeds on a continuation turn.
 *
 * `/agent/chat` rebuilds the session from `body.messages` whenever the session
 * is empty, and it hands the seeder `allMessages.slice(0, -1)` (the last entry
 * is the live turn, which the gateway appends itself). The tests below drive
 * that seam the way the route does, against a real `SessionManager`, because
 * the card's contract is about what lands *in the session* — the HTTP response
 * says nothing about the history the next turn will replay.
 */
import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import type { ImageContent, Message } from '@mariozechner/pi-ai'
import { decodeImageInfo, MAX_IMAGE_BASE64_BYTES } from '../image-size-guard'
import { SessionManager } from '../session-manager'
import {
  seedEmptyChatSession,
  type SeedHistoryMessage,
} from '../file-attachment-utils'

const FIXTURE = new URL('./fixtures/screenshot-fixture.png', import.meta.url)

function fixtureBase64(): string {
  return readFileSync(FIXTURE).toString('base64')
}

/** Flip one byte inside IDAT — the fixture still sniffs as a PNG. */
function corruptPngBase64(): string {
  const bytes = Buffer.from(readFileSync(FIXTURE))
  bytes[bytes.length - 40] ^= 0xff
  return bytes.toString('base64')
}

type Part = Record<string, unknown>

function imagePart(base64: string, extra: Part = {}): Part {
  return { type: 'file', mediaType: 'image/png', url: `data:image/png;base64,${base64}`, ...extra }
}

function textPart(text: string): Part {
  return { type: 'text', text }
}

function userTurn(...parts: Part[]): SeedHistoryMessage {
  return { role: 'user', parts: parts as SeedHistoryMessage['parts'] }
}

function assistantTurn(text: string): SeedHistoryMessage {
  return { role: 'assistant', parts: [textPart(text)] as SeedHistoryMessage['parts'] }
}

/** Exactly what `server.ts` does with the request body. */
function seedFromRequest(allMessages: SeedHistoryMessage[]): Message[] {
  const manager = new SessionManager()
  const sessionId = 'chat-history-acceptance'
  seedEmptyChatSession(
    {
      getOrCreate: (id: string) => manager.getOrCreate(id),
      addMessages: (id: string, ...msgs: Message[]) => manager.addMessages(id, ...msgs),
    },
    sessionId,
    allMessages.slice(0, -1),
    { label: 'chat_history' },
  )
  return manager.getOrCreate(sessionId).messages
}

function imageBlocks(messages: ReadonlyArray<Message>): ImageContent[] {
  return messages.flatMap((m) =>
    m.role === 'user' && Array.isArray(m.content)
      ? (m.content.filter((c) => c.type === 'image') as ImageContent[])
      : [],
  )
}

function textOf(message: Message): string {
  if (message.role !== 'user') return ''
  if (!Array.isArray(message.content)) return message.content
  return message.content
    .filter((c) => c.type === 'text')
    .map((c) => (c as { text: string }).text)
    .join('\n')
}

describe('SHO-44 acceptance — a replayed chat-UI image reaches the session', () => {
  test('the prior image is seeded, the live turn is not replayed', () => {
    const messages = seedFromRequest([
      userTurn(textPart('what is wrong with this screen?'), imagePart(fixtureBase64())),
      assistantTurn('The sidebar is collapsed.'),
      userTurn(textPart('and now?'), imagePart(fixtureBase64())),
    ])

    // Only the two prior turns — the live turn is appended by the gateway.
    expect(messages).toHaveLength(2)
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant'])
    expect(textOf(messages[0])).toContain('what is wrong with this screen?')
    expect(messages.some((m) => textOf(m).includes('and now?'))).toBe(false)

    const images = imageBlocks(messages)
    expect(images).toHaveLength(1)
    const decoded = decodeImageInfo(images[0].data, images[0].mimeType)
    expect(decoded).not.toBeNull()
    expect(decoded!.width).toBe(64)
    expect(decoded!.height).toBe(64)

    // The text comes first, then the image block — the live turn's shape.
    const content = (messages[0] as { content: Array<{ type: string }> }).content
    expect(content[0].type).toBe('text')
    expect(content[content.length - 1].type).toBe('image')
  })

  test('an attached image keeps the saved-path context so the model can re-read it', () => {
    const messages = seedFromRequest([
      userTurn(
        textPart('look at this'),
        imagePart(fixtureBase64(), { name: 'stage-1.png', savedPath: 'screens/stage-1.png' }),
      ),
      userTurn(textPart('thanks')),
    ])

    const text = textOf(messages[0])
    expect(text).toContain('Attached Image')
    expect(text).toContain('stage-1.png')
    expect(text).toContain('screens/stage-1.png')
    expect(imageBlocks(messages)).toHaveLength(1)
  })

  test('a corrupt turn does not swallow the valid image of another turn', () => {
    const messages = seedFromRequest([
      userTurn(textPart('broken one'), imagePart(corruptPngBase64())),
      assistantTurn('I cannot see that image.'),
      userTurn(textPart('valid one'), imagePart(fixtureBase64())),
      userTurn(textPart('and now?')),
    ])

    expect(messages).toHaveLength(3)
    const images = imageBlocks(messages)
    expect(images).toHaveLength(1)
    expect(decodeImageInfo(images[0].data, images[0].mimeType)).not.toBeNull()

    const corruptTurn = textOf(messages[0])
    expect(corruptTurn).toContain('broken one')
    expect(corruptTurn).toContain('[Image omitted')
    expect(corruptTurn).not.toContain('image(s) were attached')
  })

  test('an image over the per-image cap is announced, never seeded', () => {
    // PNG magic bytes so the guard classifies it as a supported format and
    // then rejects it on size, exactly as an oversized client paste would be.
    const oversized = fixtureBase64() + 'A'.repeat(MAX_IMAGE_BASE64_BYTES)
    const messages = seedFromRequest([
      userTurn(textPart('huge screenshot'), imagePart(oversized)),
      userTurn(textPart('still there?')),
    ])

    expect(imageBlocks(messages)).toHaveLength(0)
    const text = textOf(messages[0])
    expect(text).toContain('[Image omitted')
    expect(text).toContain('exceeds')
    expect(text).toContain('huge screenshot')
  })

  test('an audio attachment is announced instead of silently dropped', () => {
    const messages = seedFromRequest([
      userTurn(textPart('listen'), {
        type: 'file',
        mediaType: 'audio/wav',
        url: 'data:audio/wav;base64,UklGRg==',
      }),
      userTurn(textPart('and now?')),
    ])

    expect(messages).toHaveLength(1)
    expect(textOf(messages[0])).toContain('listen')
    expect(textOf(messages[0])).toContain('[1 file(s) were attached]')
  })

  test('a populated session is never re-seeded, so the image cannot be injected twice', () => {
    const manager = new SessionManager()
    const sessionId = 'already-live'
    manager.addMessages(sessionId, {
      role: 'user',
      content: 'the live conversation already started',
      timestamp: Date.now(),
    } as Message)

    const seeded = seedEmptyChatSession(
      {
        getOrCreate: (id: string) => manager.getOrCreate(id),
        addMessages: (id: string, ...msgs: Message[]) => manager.addMessages(id, ...msgs),
      },
      sessionId,
      [userTurn(textPart('old turn'), imagePart(fixtureBase64())), userTurn(textPart('new turn'))],
      { label: 'chat_history' },
    )

    expect(seeded).toBe(0)
    const messages = manager.getOrCreate(sessionId).messages
    expect(messages).toHaveLength(1)
    expect(imageBlocks(messages)).toHaveLength(0)
  })
})
