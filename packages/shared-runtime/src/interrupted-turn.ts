// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Copy for a turn that was cut off mid-work (SHO-121).
 *
 * Two surfaces deliver the same message: the runtime's boot sweep resumes the
 * interrupted turn itself, and the API's reattach job speaks for a runtime that
 * is gone. Both must say the same thing, so the strings live here rather than
 * in either caller.
 */

/** Name used when the marker did not record which tool was running. */
export const INTERRUPTED_TURN_FALLBACK_ACTION = 'while working'

function action(toolName?: string | null): string {
  const name = typeof toolName === 'string' ? toolName.trim() : ''
  return name ? `while running \`${name}\`` : INTERRUPTED_TURN_FALLBACK_ACTION
}

/**
 * The one line a person sees. `resuming` when the runtime is picking the turn
 * back up right now; otherwise the turn stays stopped and says so, so a
 * second death cannot promise a resume that will not happen.
 */
export function interruptedTurnNote(toolName?: string | null, opts: { resuming?: boolean } = {}): string {
  const what = action(toolName)
  return opts.resuming === false
    ? `I was interrupted ${what} before the turn finished. The work so far is saved — send a message when you want me to pick it up.`
    : `I was interrupted ${what} — resuming.`
}

/** Matches the note above with any tool name, capturing what follows it. */
const NOTE_PATTERN = /^I was interrupted (?:while running `[^`\n]+`|while working)(.*)$/s

/**
 * Whether `text` is an interrupted-turn note, and whether it promises a resume.
 *
 * The runtime's boot sweep and the API's reattach job can both notice one dead
 * turn — and each names the step from a different source, one with the tool and
 * one without. Comparing the finished strings misses that pair, so the note is
 * recognised by its shape instead. `resuming` asks for the wording that matters:
 * a `resume: false` note must still be written over a `resume: true` one, since
 * that is how a resume that died stops promising another (SHO-121).
 */
export function isInterruptedTurnNote(text: string | null | undefined, opts: { resuming?: boolean } = {}): boolean {
  if (typeof text !== 'string') return false
  const match = NOTE_PATTERN.exec(text.trim())
  if (!match) return false
  if (opts.resuming === undefined) return true
  return match[1].trim().startsWith('— resuming') === opts.resuming
}

/**
 * What the resumed turn is told to do. It does not repeat the note above: on
 * the cloud path the note is already the assistant line directly before it, and
 * the resume must read as one interruption, not two.
 */
export function interruptedTurnResumeInstruction(): string {
  return 'Pick up exactly where you left off. Do not start over. Check the effect of the interrupted step before repeating it.'
}

/**
 * The synthetic prompt a resume starts from when there is no transcript to put
 * the note in first (the desktop path, where the runtime starts the turn
 * itself). It opens with the note so the resume reads as a normal turn.
 */
export function interruptedTurnResumePrompt(toolName?: string | null): string {
  return [interruptedTurnNote(toolName, { resuming: true }), '', interruptedTurnResumeInstruction()].join('\n')
}
