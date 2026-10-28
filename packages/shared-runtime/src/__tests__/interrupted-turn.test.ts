// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * One death, one note (SHO-121).
 *
 * The runtime's boot sweep and the API's reattach job both speak for a turn
 * that was killed. They learn the interrupted step from different places — the
 * sweep from its in-memory marker, the job from the last unfinished tool part
 * on the transcript — so the two notes for the same death rarely match
 * character for character. Recognising the note by its shape is what lets one
 * of them stand down.
 */
import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_RESUME_MAX_AGE_MINUTES,
  interruptedTurnNote,
  isInterruptedTurnNote,
  resumeMaxAgeMinutes,
} from '../interrupted-turn'

describe('isInterruptedTurnNote', () => {
  test('recognises the note with or without a tool name', () => {
    expect(isInterruptedTurnNote(interruptedTurnNote('exec'))).toBe(true)
    expect(isInterruptedTurnNote(interruptedTurnNote(null))).toBe(true)
    expect(isInterruptedTurnNote(interruptedTurnNote('exec', { resuming: false }))).toBe(true)
  })

  test('a note already on the transcript is the same death whatever it names', () => {
    // The job derives "exec" from the transcript while the sweep's note says
    // the same; the sweep's note arrives first, the job must not add a second.
    expect(isInterruptedTurnNote(interruptedTurnNote('exec'), { resuming: true })).toBe(true)
    expect(isInterruptedTurnNote(interruptedTurnNote('write_file'), { resuming: true })).toBe(true)
    expect(isInterruptedTurnNote(interruptedTurnNote(null), { resuming: true })).toBe(true)
  })

  test('the two wordings are not the same note', () => {
    // A turn that promised a resume and then died must be able to say it is
    // stopped; the dedupe would otherwise leave the promise standing.
    expect(isInterruptedTurnNote(interruptedTurnNote('exec'), { resuming: false })).toBe(false)
    expect(isInterruptedTurnNote(interruptedTurnNote('exec', { resuming: false }), { resuming: true })).toBe(false)
    expect(isInterruptedTurnNote(interruptedTurnNote('exec', { resuming: false }), { resuming: false })).toBe(true)
  })

  test('ordinary assistant text is not a note', () => {
    expect(isInterruptedTurnNote('I was interrupted by a phone call earlier.')).toBe(false)
    expect(isInterruptedTurnNote('I was interrupted while running exec — resuming.')).toBe(false)
    expect(isInterruptedTurnNote('Here is the status report you asked for.')).toBe(false)
    expect(isInterruptedTurnNote('')).toBe(false)
    expect(isInterruptedTurnNote(null)).toBe(false)
    expect(isInterruptedTurnNote(undefined)).toBe(false)
  })
})

/**
 * Both sides of the resume decision read the same limit (SHO-227): the runtime
 * against its interrupted-turn marker, the API against the last human message.
 * If they parsed the variable differently, one would restart a session the
 * other had already decided was too old.
 */
describe('resumeMaxAgeMinutes', () => {
  test('reads the configured value', () => {
    expect(resumeMaxAgeMinutes('5')).toBe(5)
    expect(resumeMaxAgeMinutes('1440')).toBe(1440)
    expect(resumeMaxAgeMinutes('0')).toBe(0)
  })

  test('anything unset or unreadable is the default, not a disabled sweep', () => {
    expect(resumeMaxAgeMinutes(undefined)).toBe(DEFAULT_RESUME_MAX_AGE_MINUTES)
    expect(resumeMaxAgeMinutes(null)).toBe(DEFAULT_RESUME_MAX_AGE_MINUTES)
    expect(resumeMaxAgeMinutes('')).toBe(DEFAULT_RESUME_MAX_AGE_MINUTES)
    expect(resumeMaxAgeMinutes('soon')).toBe(DEFAULT_RESUME_MAX_AGE_MINUTES)
    // A negative limit would otherwise make every marker "too old".
    expect(resumeMaxAgeMinutes('-30')).toBe(0)
  })
})
