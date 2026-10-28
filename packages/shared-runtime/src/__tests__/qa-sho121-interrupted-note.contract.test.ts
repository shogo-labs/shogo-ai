// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * QA contract — the note a person reads and the matcher that stops it being
 * written twice must agree for EVERY wording either path can produce (SHO-121).
 *
 * Round 2 added `isInterruptedTurnNote` so the runtime's boot sweep and the
 * API's reattach job can recognise each other's line. Two functions written
 * against each other's fixtures pass while disagreeing; this walks every
 * wording the producer can emit and asserts the consumer classifies it the same
 * way, including the resuming-ness that decides whether a died resume may
 * replace the promise.
 */
import { describe, expect, test } from 'bun:test'
import {
  interruptedTurnNote,
  interruptedTurnResumeInstruction,
  interruptedTurnResumePrompt,
  isInterruptedTurnNote,
} from '../interrupted-turn'

/** Every shape of tool name a caller can hand the producer. */
const toolNames: Array<string | null | undefined> = [undefined, null, '', '   ', 'exec', 'browser_qa', 'work_item_get']

describe('resuming note — recognised as resuming, for every tool name', () => {
  for (const name of toolNames) {
    test(`tool name ${JSON.stringify(name)}`, () => {
      const note = interruptedTurnNote(name, { resuming: true })
      expect(note.endsWith('— resuming.')).toBe(true)
      expect(isInterruptedTurnNote(note)).toBe(true)
      expect(isInterruptedTurnNote(note, { resuming: true })).toBe(true)
      // A judged resume must not be mistaken for one that already died.
      expect(isInterruptedTurnNote(note, { resuming: false })).toBe(false)
    })
  }
})

describe('stopped note — recognised as stopped, and promises nothing', () => {
  for (const name of toolNames) {
    test(`tool name ${JSON.stringify(name)}`, () => {
      const note = interruptedTurnNote(name, { resuming: false })
      expect(isInterruptedTurnNote(note)).toBe(true)
      expect(isInterruptedTurnNote(note, { resuming: false })).toBe(true)
      // This is what lets a died resume replace the promise it broke.
      expect(isInterruptedTurnNote(note, { resuming: true })).toBe(false)
      expect(note.toLowerCase()).not.toContain('resuming')
    })
  }
})

describe('the two wordings are never the same note', () => {
  for (const name of toolNames) {
    test(`tool name ${JSON.stringify(name)}`, () => {
      const resuming = interruptedTurnNote(name, { resuming: true })
      const stopped = interruptedTurnNote(name, { resuming: false })
      expect(stopped).not.toBe(resuming)
      // Same death, same name: the tool is carried by both wordings.
      const tool = typeof name === 'string' ? name.trim() : ''
      if (tool) {
        expect(resuming).toContain(`\`${tool}\``)
        expect(stopped).toContain(`\`${tool}\``)
      }
    })
  }
})

describe('the desktop resume prompt is recognisable to the cloud dedupe', () => {
  test('its first line is the resuming note, and the instruction follows', () => {
    const prompt = interruptedTurnResumePrompt('exec')
    const [firstLine] = prompt.split('\n')
    expect(firstLine).toBe(interruptedTurnNote('exec', { resuming: true }))
    expect(isInterruptedTurnNote(firstLine, { resuming: true })).toBe(true)
    expect(prompt).toContain(interruptedTurnResumeInstruction())
  })
})

describe('ordinary assistant text is not a note', () => {
  test('a finished answer, an empty row and a missing row all read as "no note"', () => {
    expect(isInterruptedTurnNote('All three tests pass — the fix is pushed.')).toBe(false)
    expect(isInterruptedTurnNote('')).toBe(false)
    expect(isInterruptedTurnNote('   ')).toBe(false)
    expect(isInterruptedTurnNote(null)).toBe(false)
    expect(isInterruptedTurnNote(undefined)).toBe(false)
    // The prompt body on its own never reads as the note above it.
    expect(isInterruptedTurnNote(interruptedTurnResumeInstruction(), { resuming: true })).toBe(false)
  })
})
