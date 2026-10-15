// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, expect, test } from 'bun:test'
import { extractMentionedUserIds, joinNames, nonMemberMentionIds } from '../team-chat-mention-nudge'

describe('extractMentionedUserIds', () => {
  test('finds every wire-mentioned user id, deduped', () => {
    expect(extractMentionedUserIds('<@u:a> ping <@u:b> and <@u:a> again')).toEqual(['a', 'b'])
  })

  test('ignores agent, group, and broadcast tokens', () => {
    expect(extractMentionedUserIds('<@a:ws> <@g:design> <!channel> no users here')).toEqual([])
  })

  test('returns an empty array for plain text', () => {
    expect(extractMentionedUserIds('just a regular message')).toEqual([])
  })
})

describe('nonMemberMentionIds', () => {
  test('excludes the author and anyone already in the channel', () => {
    const members = new Set(['owner', 'member1'])
    expect(nonMemberMentionIds('<@u:owner> <@u:member1> <@u:outsider>', members, 'owner')).toEqual(['outsider'])
  })

  test('is empty when every mention is already a member', () => {
    const members = new Set(['a', 'b'])
    expect(nonMemberMentionIds('<@u:a> <@u:b>', members, 'a')).toEqual([])
  })

  test('is empty when there are no mentions', () => {
    expect(nonMemberMentionIds('no mentions here', new Set(), 'me')).toEqual([])
  })
})

describe('joinNames', () => {
  test('one name', () => {
    expect(joinNames(['Ana'])).toBe('Ana')
  })

  test('two names', () => {
    expect(joinNames(['Ana', 'Priya'])).toBe('Ana and Priya')
  })

  test('three or more names', () => {
    expect(joinNames(['Ana', 'Priya', 'Sam'])).toBe('Ana, Priya, and Sam')
  })

  test('empty list', () => {
    expect(joinNames([])).toBe('')
  })
})
