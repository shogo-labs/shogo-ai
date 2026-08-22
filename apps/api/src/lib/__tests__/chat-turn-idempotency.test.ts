// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Tests for the in-memory `clientTurnId` dedupe map consulted by
 * `POST /projects/:projectId/chat` (see `../chat-turn-idempotency.ts`'s
 * module doc) — the mechanism that lets the offline send queue retry a POST
 * without risking a second agent turn if the original request actually
 * reached the runtime.
 *
 * Run: bun test apps/api/src/lib/__tests__/chat-turn-idempotency.test.ts
 */
import { describe, test, expect, beforeEach } from 'bun:test'
import {
  recordClientTurn,
  isRecentClientTurn,
  _resetClientTurnIdempotencyForTests,
} from '../chat-turn-idempotency'

const TEN_MINUTES_MS = 10 * 60 * 1000

beforeEach(() => {
  _resetClientTurnIdempotencyForTests()
})

describe('isRecentClientTurn', () => {
  test('false for a session with no recorded turn', () => {
    expect(isRecentClientTurn('session-1', 'ctid-abc')).toBe(false)
  })

  test('true immediately after recording the same clientTurnId', () => {
    recordClientTurn('session-1', 'ctid-abc', 1_000)
    expect(isRecentClientTurn('session-1', 'ctid-abc', 1_000)).toBe(true)
  })

  test('false for a different clientTurnId on the same session (a genuinely new turn)', () => {
    recordClientTurn('session-1', 'ctid-abc', 1_000)
    expect(isRecentClientTurn('session-1', 'ctid-xyz', 1_000)).toBe(false)
  })

  test('false for the same clientTurnId on a different session', () => {
    recordClientTurn('session-1', 'ctid-abc', 1_000)
    expect(isRecentClientTurn('session-2', 'ctid-abc', 1_000)).toBe(false)
  })

  test('still true just under the MAX_AGE_MS window', () => {
    recordClientTurn('session-1', 'ctid-abc', 0)
    expect(isRecentClientTurn('session-1', 'ctid-abc', TEN_MINUTES_MS - 1)).toBe(true)
  })

  test('ages out once MAX_AGE_MS has elapsed', () => {
    recordClientTurn('session-1', 'ctid-abc', 0)
    expect(isRecentClientTurn('session-1', 'ctid-abc', TEN_MINUTES_MS + 1)).toBe(false)
  })

  test('an aged-out entry is pruned — a later record for the same session works normally', () => {
    recordClientTurn('session-1', 'ctid-old', 0)
    // Aged-out check prunes the stale entry as a side effect.
    expect(isRecentClientTurn('session-1', 'ctid-old', TEN_MINUTES_MS + 1)).toBe(false)

    recordClientTurn('session-1', 'ctid-new', TEN_MINUTES_MS + 1)
    expect(isRecentClientTurn('session-1', 'ctid-new', TEN_MINUTES_MS + 1)).toBe(true)
    // The stale id must not match anymore even though the map has an entry
    // for the session again now.
    expect(isRecentClientTurn('session-1', 'ctid-old', TEN_MINUTES_MS + 1)).toBe(false)
  })

  test('recording a new turn for a session supersedes the previous one', () => {
    recordClientTurn('session-1', 'ctid-first', 1_000)
    recordClientTurn('session-1', 'ctid-second', 2_000)
    // The offline queue reuses the SAME clientTurnId across retries of one
    // logical send, so a later, distinct turn's id must be the only match —
    // otherwise a retry of the FIRST turn's original POST (arriving late)
    // could incorrectly attach to the second turn's stream.
    expect(isRecentClientTurn('session-1', 'ctid-first', 2_500)).toBe(false)
    expect(isRecentClientTurn('session-1', 'ctid-second', 2_500)).toBe(true)
  })

  test('repeated retries with the same clientTurnId keep matching (the offline-retry case)', () => {
    recordClientTurn('session-1', 'ctid-retry-me', 0)
    // Simulates the client retrying the same failed POST multiple times
    // while offline, each time re-checking before re-recording.
    expect(isRecentClientTurn('session-1', 'ctid-retry-me', 100)).toBe(true)
    recordClientTurn('session-1', 'ctid-retry-me', 100)
    expect(isRecentClientTurn('session-1', 'ctid-retry-me', 5_000)).toBe(true)
    recordClientTurn('session-1', 'ctid-retry-me', 5_000)
    expect(isRecentClientTurn('session-1', 'ctid-retry-me', 10_000)).toBe(true)
  })

  test('multiple sessions are tracked independently', () => {
    recordClientTurn('session-a', 'ctid-a', 0)
    recordClientTurn('session-b', 'ctid-b', 0)
    expect(isRecentClientTurn('session-a', 'ctid-a', 0)).toBe(true)
    expect(isRecentClientTurn('session-b', 'ctid-b', 0)).toBe(true)
    expect(isRecentClientTurn('session-a', 'ctid-b', 0)).toBe(false)
    expect(isRecentClientTurn('session-b', 'ctid-a', 0)).toBe(false)
  })

  test('defaults `now` to Date.now() when omitted', () => {
    recordClientTurn('session-1', 'ctid-abc')
    expect(isRecentClientTurn('session-1', 'ctid-abc')).toBe(true)
  })
})
