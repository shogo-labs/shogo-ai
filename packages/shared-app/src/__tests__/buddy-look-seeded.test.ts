// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_BUDDY_LOOK,
  parseBuddyLook,
  resolveAgentLook,
  sameLook,
  seededBuddyLook,
} from '../buddy-look'

const ids = Array.from({ length: 60 }, (_, i) => `project-${i}-${(i * 7919).toString(16)}`)

describe('seededBuddyLook', () => {
  test('is deterministic', () => {
    for (const id of ids) expect(seededBuddyLook(id)).toEqual(seededBuddyLook(id))
  })

  test('always passes strict validation', () => {
    for (const id of ids) {
      const parsed = parseBuddyLook(seededBuddyLook(id))
      expect(parsed.ok).toBe(true)
    }
  })

  test('gives agents visibly different looks', () => {
    const keys = new Set(ids.map((id) => JSON.stringify(seededBuddyLook(id))))
    expect(keys.size).toBeGreaterThan(ids.length * 0.9)
    expect(new Set(ids.map((id) => seededBuddyLook(id).color)).size).toBeGreaterThan(5)
    expect(new Set(ids.map((id) => seededBuddyLook(id).topper)).size).toBeGreaterThan(5)
  })

  test('does not put classic-only parts on other faces', () => {
    for (const id of ids) {
      const look = seededBuddyLook(id)
      if (look.face !== 'classic') {
        expect(look.eyewear).toBe('none')
        expect(look.blush).toBe(false)
      }
    }
  })
})

describe('resolveAgentLook', () => {
  test('prefers a stored look', () => {
    const stored = { ...DEFAULT_BUDDY_LOOK, topper: 'wizard', color: '#112233' }
    expect(resolveAgentLook(stored, 'p1')).toEqual({ ...stored })
  })

  test('falls back to the seeded look for project agents', () => {
    expect(sameLook(resolveAgentLook(null, 'p1'), seededBuddyLook('p1'))).toBe(true)
  })

  test('keeps the classic Shogo for the workspace agent', () => {
    expect(resolveAgentLook(null, null)).toEqual(DEFAULT_BUDDY_LOOK)
  })
})
