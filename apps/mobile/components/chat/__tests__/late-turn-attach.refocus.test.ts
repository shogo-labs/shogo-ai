// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-53 — a refocus has to tell "this chat is up to date" from "a turn was
 * written while this window was in the background".
 *
 * The wake watch only runs for an active panel, so a wake that ran while the
 * window was behind another chat tab, another browser tab or another app left
 * nothing armed here; the refocus probe then sees a `completed` turn, which
 * the attach path treats as "history is enough". The newest saved row is what
 * separates the two, and it has to say "up to date" for the common case or
 * every focus click would refetch the transcript.
 */

import { describe, expect, test } from 'bun:test'
import {
  messageTextLength,
  messageTurnStartedAt,
  persistedTailAwaitsReply,
  persistedTailIsUnseen,
  persistedTailQuery,
} from '../late-turn-attach'

const assistant = (id: string) => ({ id, role: 'assistant', content: 'done' })
const user = (id: string, content = 'hi') => ({ id, role: 'user', content })

/** A message the AI SDK streamed, as it looks before any history paint: its own id, the turn's stamp. */
const liveReply = (id: string, startedAt: number, text = 'ok') => ({
  id,
  role: 'assistant',
  content: text,
  parts: [
    { type: 'text', text },
    { type: 'data-turn-start', data: { turnId: `turn-${startedAt}`, startedAt } },
  ],
})

/** A saved row rebuilt from `/chat-messages`, carrying the stamp the API persisted. */
const savedReply = (id: string, startedAt: number, text = 'ok') => ({
  id,
  role: 'assistant',
  content: text,
  parts: [
    { type: 'text', text },
    { type: 'data-turn-timing', data: { startedAt, completedAt: startedAt + 1_500 } },
  ],
})

describe('the newest saved row is the one on screen', () => {
  test('is not unseen, so a refocus leaves the transcript alone', () => {
    const messages = [user('u1'), assistant('a1')]
    expect(persistedTailIsUnseen({ id: 'a1', role: 'assistant' }, messages)).toBe(false)
  })

  test('compares ids as strings (a numeric id from the wire still matches)', () => {
    expect(persistedTailIsUnseen({ id: '7' }, [{ id: 7, role: 'assistant' }])).toBe(false)
  })
})

describe('a turn was written while the window was away', () => {
  test('a wake reply the panel never rendered is unseen', () => {
    const messages = [user('u1'), assistant('a1')]
    expect(persistedTailIsUnseen({ id: 'a2', role: 'assistant' }, messages)).toBe(true)
  })

  test('a wake row whose reply is still being written is unseen', () => {
    const messages = [user('u1'), assistant('a1')]
    const tail = { id: 'u3', role: 'user' }
    expect(persistedTailIsUnseen(tail, messages)).toBe(true)
    expect(persistedTailAwaitsReply(tail)).toBe(true)
  })

  test('a panel with no rows at all paints the history it is missing', () => {
    expect(persistedTailIsUnseen({ id: 'a1', role: 'assistant' }, [])).toBe(true)
  })
})

describe('a read that told us nothing', () => {
  test('does not repaint (no row, no id, or a failed request)', () => {
    const messages = [user('u1'), assistant('a1')]
    expect(persistedTailIsUnseen(null, messages)).toBe(false)
    expect(persistedTailIsUnseen(undefined, messages)).toBe(false)
    expect(persistedTailIsUnseen({ id: null }, messages)).toBe(false)
  })
})

describe('a completed reply is not a pending prompt', () => {
  test('an assistant tail never relaxes the reply requirement', () => {
    expect(persistedTailAwaitsReply({ id: 'a2', role: 'assistant' })).toBe(false)
    expect(persistedTailAwaitsReply(null)).toBe(false)
  })
})

describe('a reply this panel streamed keeps the AI SDK id (SHO-99)', () => {
  test('(a) the same turn under a different id is not unseen', () => {
    const startedAt = 1_792_735_430_676
    const messages = [user('u1'), liveReply('sdk-1', startedAt)]
    // The saved row for that turn; the post-turn reconcile missed it, so the
    // screen still shows the SDK id.
    expect(persistedTailIsUnseen({ id: 'a2', role: 'assistant', turnStartedAt: startedAt }, messages)).toBe(false)
  })

  test('(c) a row that landed after the reconcile window is not unseen', () => {
    const startedAt = 1_792_735_430_676
    const messages = [user('u1'), liveReply('sdk-1', startedAt), user('u2'), liveReply('sdk-2', startedAt + 60_000)]
    // only the newest reply matters
    expect(
      persistedTailIsUnseen(
        { id: 'a3', role: 'assistant', turnStartedAt: startedAt + 60_000, contentLength: 2 },
        messages,
      ),
    ).toBe(false)
  })

  test('(b) a genuinely newer reply is unseen even when the ids are unknown to each other', () => {
    const messages = [user('u1'), liveReply('sdk-1', 1_000)]
    expect(persistedTailIsUnseen({ id: 'a2', role: 'assistant', turnStartedAt: 2_000 }, messages)).toBe(true)
  })

  test('the wake reply another window ran is a different turn, so it is unseen', () => {
    // The background window's screen ends on its own reply; the wake ran later.
    const messages = [user('u1'), savedReply('a1', 1_000)]
    expect(persistedTailIsUnseen({ id: 'a2', role: 'assistant', turnStartedAt: 9_000 }, messages)).toBe(true)
  })

  test('the same turn is unseen again when the saved row carries more text (cut stream, finished server-side)', () => {
    const startedAt = 1_000
    const messages = [user('u1'), liveReply('sdk-1', startedAt, 'half a rep')]
    expect(
      persistedTailIsUnseen({ id: 'a2', role: 'assistant', turnStartedAt: startedAt, contentLength: 40 }, messages),
    ).toBe(true)
  })

  test('a row with no turn stamp falls back to the id comparison', () => {
    const messages = [user('u1'), liveReply('sdk-1', 1_000)]
    expect(persistedTailIsUnseen({ id: 'a2', role: 'assistant', turnStartedAt: null }, messages)).toBe(true)
    expect(persistedTailIsUnseen({ id: 'sdk-1', role: 'assistant' }, messages)).toBe(false)
  })

  test('(d) a reply still unwritten leaves the panel own prompt as the newest row', () => {
    // The reply is on screen and its row has not been written yet.
    const messages = [user('u1', 'just a normal message'), liveReply('sdk-1', 1_000)]
    const tail = { id: 'p1', role: 'user', content: 'just a normal message' }
    expect(persistedTailIsUnseen(tail, messages, { streamedHere: true })).toBe(false)
    // Without a stream in this window the panel has seen nothing of that turn.
    expect(persistedTailIsUnseen(tail, messages)).toBe(true)
  })

  test('a different prompt is a turn this window has never shown', () => {
    const messages = [user('u1', 'just a normal message'), liveReply('sdk-1', 1_000)]
    expect(
      persistedTailIsUnseen(
        { id: 'p2', role: 'user', content: '[Task update] the task finished' },
        messages,
        { streamedHere: true },
      ),
    ).toBe(true)
  })

  test('a prompt the screen only shows as a prompt does not count as seen', () => {
    // Screen still ends on its own prompt: there is no reply to protect.
    const messages = [user('u1', 'just a normal message')]
    expect(
      persistedTailIsUnseen({ id: 'p1', role: 'user', content: 'just a normal message' }, messages, {
        streamedHere: true,
      }),
    ).toBe(true)
  })
})

describe('the turn stamp is read off both copies of a reply', () => {
  test('the live stream part and the persisted part carry the same start', () => {
    expect(messageTurnStartedAt(liveReply('sdk-1', 42))).toBe(42)
    expect(messageTurnStartedAt(savedReply('a1', 42))).toBe(42)
  })

  test('a message with no turn part has no stamp', () => {
    expect(messageTurnStartedAt(user('u1'))).toBe(null)
    expect(messageTurnStartedAt({ id: 'a1', parts: [{ type: 'text', text: 'hi' }] })).toBe(null)
    expect(messageTurnStartedAt(undefined)).toBe(null)
  })

  test('the reply length counts its text parts, falling back to content', () => {
    expect(messageTextLength(liveReply('sdk-1', 42, 'four'))).toBe(4)
    expect(messageTextLength({ role: 'assistant', content: 'plain' })).toBe(5)
  })
})

describe('the refocus reads the newest row, not an arbitrary one (SHO-99)', () => {
  test('the row query orders newest-first', () => {
    // Without `orderBy` the list route hands back a DB-ordered slice — in local
    // mode the oldest row — so the refocus compared the screen against the
    // first message of the chat and reloaded every time.
    expect(persistedTailQuery('s1')).toEqual({
      sessionId: 's1',
      agent: 'technical',
      limit: '1',
      offset: '0',
      orderBy: 'createdAt:desc',
    })
  })
})
