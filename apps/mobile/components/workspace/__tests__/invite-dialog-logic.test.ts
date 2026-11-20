// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The invite dialog's pure half (SHO-454): chips, what a send attempts, the
 * batch summary, link expiry, and the + menu's invite item.
 */
import { describe, expect, test } from 'bun:test'
import {
  describeExpiry,
  parseInviteChips,
  sendableEmails,
  summarizeInviteResults,
} from '../invite-dialog-logic'

describe('parseInviteChips', () => {
  test('splits a pasted list and keeps bad addresses visible', () => {
    const chips = parseInviteChips('a@x.com, b@x.com bad c@x.com')
    expect(chips.map((c) => c.value)).toEqual(['a@x.com', 'b@x.com', 'bad', 'c@x.com'])
    expect(chips.filter((c) => c.valid).map((c) => c.value)).toEqual(['a@x.com', 'b@x.com', 'c@x.com'])
    expect(chips.filter((c) => !c.valid).map((c) => c.value)).toEqual(['bad'])
  })

  test('separates on semicolons, tabs and newlines', () => {
    expect(parseInviteChips('a@x.com;b@x.com\nc@x.com\td@x.com').map((c) => c.value)).toEqual([
      'a@x.com',
      'b@x.com',
      'c@x.com',
      'd@x.com',
    ])
  })

  test('lowercases and collapses duplicates to the first occurrence', () => {
    expect(parseInviteChips('A@X.com a@x.com  A@x.com').map((c) => c.value)).toEqual(['a@x.com'])
  })

  test('ignores empty input', () => {
    expect(parseInviteChips('   ')).toEqual([])
  })
})

describe('sendableEmails', () => {
  test('skips invalid, existing members and pending invitations', () => {
    const chips = parseInviteChips('new@x.com member@x.com pending@x.com nope')
    const targets = sendableEmails(chips, new Set(['member@x.com']), new Set(['pending@x.com']))
    expect(targets).toEqual(['new@x.com'])
  })

  test('sends every valid address when nothing is known yet', () => {
    const chips = parseInviteChips('a@x.com b@x.com')
    expect(sendableEmails(chips, new Set(), new Set())).toEqual(['a@x.com', 'b@x.com'])
  })
})

describe('summarizeInviteResults', () => {
  test('reports each outcome once, in the order the dialog shows them', () => {
    const text = summarizeInviteResults([
      { email: 'a@x.com', outcome: 'sent' },
      { email: 'b@x.com', outcome: 'sent' },
      { email: 'c@x.com', outcome: 'sent' },
      { email: 'd@x.com', outcome: 'invited' },
      { email: 'e@x.com', outcome: 'failed', message: 'Seat limit reached' },
    ])
    expect(text).toBe('3 sent · 1 already invited (Resend) · 1 failed: Seat limit reached')
  })

  test('counts several failures but names only the first message', () => {
    const text = summarizeInviteResults([
      { email: 'a@x.com', outcome: 'failed', message: 'first' },
      { email: 'b@x.com', outcome: 'failed', message: 'second' },
    ])
    expect(text).toBe('2 failed: first')
  })

  test('is empty when nothing happened', () => {
    expect(summarizeInviteResults([])).toBe('')
  })
})

describe('describeExpiry', () => {
  const now = Date.parse('2026-11-20T00:00:00.000Z')

  test('a link with no expiry never expires', () => {
    expect(describeExpiry(null, now)).toBe('never expires')
  })

  test('counts whole days up', () => {
    expect(describeExpiry('2026-11-27T00:00:00.000Z', now)).toBe('expires in 7 days')
  })

  test('a link expiring within a day says today', () => {
    expect(describeExpiry('2026-11-20T06:00:00.000Z', now)).toBe('expires today')
  })

  test('a past expiry is expired', () => {
    expect(describeExpiry('2026-11-19T00:00:00.000Z', now)).toBe('expired')
  })
})

