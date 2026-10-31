// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A reply killed mid-text is put back into the transcript as an assistant
 * message, closed by a fixed marker so the resumed model continues instead of
 * restarting — and so the recovery is idempotent (SHO-274).
 */
import { describe, expect, test } from 'bun:test'
import {
  INTERRUPTED_TURN_PARTIAL_MARKER,
  interruptedPartialMessage,
  interruptedTurnResumePrompt,
} from '../interrupted-turn'

describe('interruptedPartialMessage', () => {
  test('keeps the exact text the person read, then closes it', () => {
    const body = interruptedPartialMessage('Deploying the app to staging')
    expect(body.startsWith('Deploying the app to staging')).toBe(true)
    expect(body.endsWith(INTERRUPTED_TURN_PARTIAL_MARKER)).toBe(true)
    // The words above the marker survive byte-for-byte.
    expect(body.split(INTERRUPTED_TURN_PARTIAL_MARKER)[0]!.trim()).toBe('Deploying the app to staging')
  })

  test('trailing whitespace does not open a gap before the marker', () => {
    expect(interruptedPartialMessage('Done.\n\n  \n')).toBe(`Done.\n\n${INTERRUPTED_TURN_PARTIAL_MARKER}`)
  })

  test('an empty or whitespace-only partial is just the marker', () => {
    expect(interruptedPartialMessage('')).toBe(INTERRUPTED_TURN_PARTIAL_MARKER)
    expect(interruptedPartialMessage('   \n\t')).toBe(INTERRUPTED_TURN_PARTIAL_MARKER)
  })

  test('is a pure function, so a second recovery writes the same bytes', () => {
    const text = 'Half a thought about the migration'
    expect(interruptedPartialMessage(text)).toBe(interruptedPartialMessage(text))
  })

  test('the resume prompt still tells the model not to start over', () => {
    // The marker is only useful next to the instruction it was written for.
    expect(interruptedTurnResumePrompt(undefined)).toContain('Do not start over')
  })
})
