// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from 'bun:test'
import { DETAIL_NAMED_MAX, hasReacted, reactionDetail, reactionTooltip, reactorName } from '../team-chat-reactions'

const names = {
  users: new Map([
    ['u-ana', 'Ana Lopez'],
    ['u-bob', 'Bob Chen'],
    ['u-cid', 'Cid Rao'],
    ['u-dee', 'Dee Park'],
  ]),
}

describe('hasReacted', () => {
  test('true only when the viewer is in that emoji’s reactors', () => {
    const reactions = [{ emoji: '👍', count: 1, userIds: ['u-me'] }]
    expect(hasReacted(reactions, '👍', 'u-me')).toBe(true)
    expect(hasReacted(reactions, '👍', 'u-other')).toBe(false)
    expect(hasReacted(reactions, '🎉', 'u-me')).toBe(false)
  })

  test('false when signed out or the message has no reactions', () => {
    expect(hasReacted([{ emoji: '👍', count: 1, userIds: ['u-me'] }], '👍', null)).toBe(false)
    expect(hasReacted(undefined, '👍', 'u-me')).toBe(false)
    expect(hasReacted([], '👍', 'u-me')).toBe(false)
  })
})

describe('reactorName', () => {
  test('names the viewer "You" and falls back for someone who left', () => {
    expect(reactorName('u-me', 'u-me', names)).toBe('You')
    expect(reactorName('u-ana', 'u-me', names)).toBe('Ana Lopez')
    expect(reactorName('u-gone', 'u-me', names)).toBe('Someone')
  })
})

describe('reactionTooltip', () => {
  test('reads "You" for the viewer alone', () => {
    expect(reactionTooltip('👍', ['u-me'], 'u-me', names)).toBe('You reacted with 👍')
  })

  test('joins two and three names', () => {
    expect(reactionTooltip('👍', ['u-me', 'u-ana'], 'u-me', names))
      .toBe('You and Ana Lopez reacted with 👍')
    expect(reactionTooltip('👍', ['u-me', 'u-ana', 'u-bob'], 'u-me', names))
      .toBe('You, Ana Lopez and Bob Chen reacted with 👍')
  })

  test('collapses a long list into "and N others"', () => {
    expect(reactionTooltip('👍', ['u-me', 'u-ana', 'u-bob', 'u-cid', 'u-dee'], 'u-me', names))
      .toBe('You, Ana Lopez and 3 others reacted with 👍')
  })

  test('does not say "You" when the viewer has not reacted', () => {
    expect(reactionTooltip('❤️', ['u-ana', 'u-bob'], 'u-me', names))
      .toBe('Ana Lopez and Bob Chen reacted with ❤️')
  })

  test('keeps a custom emoji code readable', () => {
    expect(reactionTooltip(':party_blob:', ['u-ana'], 'u-me', names))
      .toBe('Ana Lopez reacted with :party_blob:')
  })
})

describe('reactionDetail', () => {
  test('names the viewer alone', () => {
    expect(reactionDetail('👍', ['u-me'], 'u-me', names)).toEqual({ who: 'You', verb: 'reacted with :+1:' })
  })

  test('puts "You" last, as Slack does', () => {
    expect(reactionDetail('❤️', ['u-me', 'u-ana', 'u-bob'], 'u-me', names))
      .toEqual({ who: 'Ana Lopez, Bob Chen and You', verb: 'reacted with :heart:' })
  })

  test('falls back for someone who left', () => {
    expect(reactionDetail('👍', ['u-gone', 'u-ana'], 'u-me', names).who).toBe('Someone and Ana Lopez')
  })

  test('keeps custom and unmapped emoji as they are', () => {
    expect(reactionDetail(':party_blob:', ['u-ana'], 'u-me', names).verb).toBe('reacted with :party_blob:')
    expect(reactionDetail('🦄', ['u-ana'], 'u-me', names).verb).toBe('reacted with 🦄')
  })

  test('lists everyone up to the cap, then collapses while still naming the viewer', () => {
    const ids = Array.from({ length: DETAIL_NAMED_MAX }, (_, i) => `u-${i}`)
    const exact = reactionDetail('👍', ids, null, { users: new Map(ids.map((id) => [id, id])) })
    expect(exact.who).not.toContain('others')

    const many = [...ids, 'u-extra', 'u-me']
    const detail = reactionDetail('👍', many, 'u-me', { users: new Map(many.map((id) => [id, id])) })
    expect(detail.who.endsWith(`, You and ${many.length - (DETAIL_NAMED_MAX - 1)} others`)).toBe(true)
  })
})
