// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, expect, test } from 'bun:test'
import { sideChatLabel, sortSideChats } from '../side-chats'

describe('sideChatLabel', () => {
  test('prefers the name, then the inferred name', () => {
    expect(sideChatLabel({ id: '1', name: ' Birthday party ', inferredName: 'x' })).toBe('Birthday party')
    expect(sideChatLabel({ id: '2', name: '  ', inferredName: 'Trip ideas' })).toBe('Trip ideas')
  })

  test('falls back to a dated label', () => {
    expect(sideChatLabel({ id: '3', createdAt: '2026-03-04T12:00:00Z' })).toStartWith('Chat · ')
  })
})

describe('sortSideChats', () => {
  test('puts the most recently active first, using creation time when never active', () => {
    const sorted = sortSideChats([
      { id: 'old', lastActiveAt: '2026-01-01T00:00:00Z' },
      { id: 'new', lastActiveAt: '2026-03-01T00:00:00Z' },
      { id: 'created', createdAt: '2026-02-01T00:00:00Z' },
    ])
    expect(sorted.map((s) => s.id)).toEqual(['new', 'created', 'old'])
  })

  test('does not mutate its input', () => {
    const input = [{ id: 'a', createdAt: '2026-01-01' }, { id: 'b', createdAt: '2026-02-01' }]
    sortSideChats(input)
    expect(input.map((s) => s.id)).toEqual(['a', 'b'])
  })
})
