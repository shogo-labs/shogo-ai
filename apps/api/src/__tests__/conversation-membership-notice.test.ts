// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The wording of the channel membership notice — pure, no database.
 */

import { describe, expect, test } from 'bun:test'
import { addedMembersNoticeText, membershipChannelLabel } from '../services/conversation-membership-notice'

describe('membershipChannelLabel', () => {
  test('names a public channel the way Slack does', () => {
    expect(membershipChannelLabel('public', 'growth')).toBe('#growth')
  })

  test('marks a private channel', () => {
    expect(membershipChannelLabel('private', 'client-itau-col')).toBe('🔒 client-itau-col')
  })
})

describe('addedMembersNoticeText', () => {
  test('a single person reads as Slack reads it', () => {
    expect(addedMembersNoticeText(['Swastik Ranjan'], 'Eby', '#growth'))
      .toBe('Swastik Ranjan was added to #growth by Eby.')
  })

  test('the private channel padlock survives into the sentence', () => {
    expect(addedMembersNoticeText(['Swastik Ranjan'], 'Eby', membershipChannelLabel('private', 'client-itau-col')))
      .toBe('Swastik Ranjan was added to 🔒 client-itau-col by Eby.')
  })

  test('two people collapse to "and 1 other", with a plural verb', () => {
    expect(addedMembersNoticeText(['Sam', 'Alex'], 'Eby', '#growth'))
      .toBe('Sam and 1 other were added to #growth by Eby.')
  })

  test('three or more keep the count right', () => {
    expect(addedMembersNoticeText(['Sam', 'Alex', 'Kim'], 'Eby', '#growth'))
      .toBe('Sam and 2 others were added to #growth by Eby.')
    expect(addedMembersNoticeText(['Sam', 'Alex', 'Kim', 'Jo'], 'Eby', '#growth'))
      .toBe('Sam and 3 others were added to #growth by Eby.')
  })

  test('no actor drops the attribution rather than inventing one', () => {
    expect(addedMembersNoticeText(['Sam'], null, '#growth')).toBe('Sam was added to #growth.')
  })
})
