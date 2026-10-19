// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-53 — a refocus has to tell "this chat is up to date" from "a turn was
 * written while this window was in the background".
 *
 * The wake watch only runs for an active panel, so a wake that ran while the
 * window was behind another chat tab, another browser tab or another app left
 * nothing armed here; the refocus probe then sees a `completed` turn, which
 * the attach path treats as "history is enough". The newest saved row is what
 * separates the two, and it has to say "up to date" for the common case or
 * every focus click would refetch the transcript.
 */

import { describe, expect, test } from 'bun:test'
import { persistedTailAwaitsReply, persistedTailIsUnseen } from '../late-turn-attach'

const assistant = (id: string) => ({ id, role: 'assistant', content: 'done' })
const user = (id: string, content = 'hi') => ({ id, role: 'user', content })

describe('the newest saved row is the one on screen', () => {
  test('is not unseen, so a refocus leaves the transcript alone', () => {
    const messages = [user('u1'), assistant('a1')]
    expect(persistedTailIsUnseen({ id: 'a1', role: 'assistant' }, messages)).toBe(false)
  })

  test('compares ids as strings (a numeric id from the wire still matches)', () => {
    expect(persistedTailIsUnseen({ id: '7' }, [{ id: 7, role: 'assistant' }])).toBe(false)
  })
})

describe('a turn was written while the window was away', () => {
  test('a wake reply the panel never rendered is unseen', () => {
    const messages = [user('u1'), assistant('a1')]
    expect(persistedTailIsUnseen({ id: 'a2', role: 'assistant' }, messages)).toBe(true)
  })

  test('a wake row whose reply is still being written is unseen', () => {
    const messages = [user('u1'), assistant('a1')]
    const tail = { id: 'u3', role: 'user' }
    expect(persistedTailIsUnseen(tail, messages)).toBe(true)
    expect(persistedTailAwaitsReply(tail)).toBe(true)
  })

  test('a panel with no rows at all paints the history it is missing', () => {
    expect(persistedTailIsUnseen({ id: 'a1', role: 'assistant' }, [])).toBe(true)
  })
})

describe('a read that told us nothing', () => {
  test('does not repaint (no row, no id, or a failed request)', () => {
    const messages = [user('u1'), assistant('a1')]
    expect(persistedTailIsUnseen(null, messages)).toBe(false)
    expect(persistedTailIsUnseen(undefined, messages)).toBe(false)
    expect(persistedTailIsUnseen({ id: null }, messages)).toBe(false)
  })
})

describe('a completed reply is not a pending prompt', () => {
  test('an assistant tail never relaxes the reply requirement', () => {
    expect(persistedTailAwaitsReply({ id: 'a2', role: 'assistant' })).toBe(false)
    expect(persistedTailAwaitsReply(null)).toBe(false)
  })
})
