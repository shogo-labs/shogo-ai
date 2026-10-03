// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from 'bun:test'
import { messageLink, parseMessageLink } from '../team-chat-links'
import { activeEmojiQuery, emojiForShortcode, replaceFinishedShortcode, searchEmoji, EMOJI_GROUPS } from '../emoji-data'
import { applyListEvent, firstUnreadIndex } from '../team-chat-state'

describe('message links', () => {
  const hosts = new Set(['studio.shogo.ai'])

  test('round-trip channel messages and thread replies', () => {
    const top = messageLink({ conversationId: 'c1', messageId: 'm1' }, 'https://studio.shogo.ai')
    expect(top).toBe('https://studio.shogo.ai/c/c1?msg=m1')
    expect(parseMessageLink(top, hosts)).toEqual({ conversationId: 'c1', messageId: 'm1', threadRootId: null })

    const reply = messageLink({ conversationId: 'c1', messageId: 'r1', threadRootId: 'm1' }, 'https://studio.shogo.ai')
    expect(parseMessageLink(reply, hosts)).toEqual({ conversationId: 'c1', messageId: 'r1', threadRootId: 'm1' })
  })

  test('links elsewhere, or without a message, open in the browser', () => {
    expect(parseMessageLink('https://evil.example/c/c1?msg=m1', hosts)).toBeNull()
    expect(parseMessageLink('https://studio.shogo.ai/c/c1', hosts)).toBeNull()
    expect(parseMessageLink('https://studio.shogo.ai/projects/p1?msg=m1', hosts)).toBeNull()
    expect(parseMessageLink('not a url', hosts)).toBeNull()
  })
})

describe('emoji search', () => {
  test('covers every category, not just a short list', () => {
    expect(EMOJI_GROUPS.length).toBeGreaterThanOrEqual(8)
    expect(EMOJI_GROUPS.reduce((n, g) => n + g.emojis.length, 0)).toBeGreaterThan(1500)
  })

  test('finds by name, Slack shortcode, and prefix, best match first', () => {
    expect(searchEmoji('rocket')[0]?.emoji).toBe('🚀')
    expect(searchEmoji('tad')[0]?.emoji).toBe('🎉')
    expect(searchEmoji('+1')[0]?.emoji).toBe('👍')
    expect(searchEmoji('thumbs up').map((e) => e.emoji)).toContain('👍')
    expect(searchEmoji('')).toEqual([])
  })

  test('shortcodes being typed and finished', () => {
    expect(activeEmojiQuery('ship it :tad', 12)).toEqual({ start: 8, query: 'tad' })
    expect(activeEmojiQuery('at 10:30', 8)).toBeNull()
    expect(activeEmojiQuery(':a', 2)).toBeNull()
    expect(emojiForShortcode('tada')).toBe('🎉')
    expect(replaceFinishedShortcode('great :tada: work')).toBe('great 🎉 work')
    expect(replaceFinishedShortcode('meet at 10:30:00')).toBe('meet at 10:30:00')
    expect(replaceFinishedShortcode('custom :partyparrot:')).toBe('custom :partyparrot:')
  })
})

describe('unread state', () => {
  const msg = (seq: number, authorUserId: string | null, extra: Record<string, unknown> = {}): any => ({ id: `m${seq}`, seq, authorUserId, deletedAt: null, ...extra })

  test('the first unread is the first message from someone else after the read point', () => {
    const messages = [msg(1, 'u-ana'), msg(2, 'u-me'), msg(3, 'u-ana', { deletedAt: 'x' }), msg(4, null), msg(5, 'u-ana')]
    expect(firstUnreadIndex(messages, 1, 'u-me')).toBe(3)
    expect(firstUnreadIndex(messages, 5, 'u-me')).toBe(-1)
    expect(firstUnreadIndex(messages, 1, 'u-me', 3)).toBe(-1)
  })

  test('marking unread moves the sidebar count back up', () => {
    const list: any[] = [{ id: 'c1', lastReadSeq: 9, unreadCount: 0, mentionCount: 0 }]
    const back = applyListEvent(list, { type: 'read', conversationId: 'c1', userId: 'u-me', seq: 4, unreadCount: 3 }, 'u-me', null)
    expect(back.list[0]).toMatchObject({ lastReadSeq: 4, unreadCount: 3 })
    const forward = applyListEvent(back.list, { type: 'read', conversationId: 'c1', userId: 'u-me', seq: 9, unreadCount: 0 }, 'u-me', null)
    expect(forward.list[0]).toMatchObject({ lastReadSeq: 9, unreadCount: 0 })
  })
})
