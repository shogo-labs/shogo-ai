// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from 'bun:test'
import { runningAgentReplies, typingLabel, typingLabelText, type Typist } from '../team-chat-typing'

const typists = (...names: string[]): Typist[] => names.map((name, i) => ({ id: `t${i}`, name }))

describe('typingLabel', () => {
  test('nothing when nobody is typing', () => {
    expect(typingLabel([])).toBeNull()
  })

  test('one name', () => {
    expect(typingLabel(typists('Ana'))).toBe('Ana is typing…')
  })

  test('two names', () => {
    expect(typingLabel(typists('Ana', 'Billing Bot'))).toBe('Ana and Billing Bot are typing…')
  })

  test('three names name two and count one other', () => {
    expect(typingLabel(typists('Ana', 'Billing Bot', 'Lee'))).toBe('Ana, Billing Bot and 1 other are typing…')
  })

  test('five names count the rest in the plural', () => {
    expect(typingLabel(typists('Ana', 'Billing Bot', 'Lee', 'Kim', 'Sam'))).toBe('Ana, Billing Bot and 3 others are typing…')
  })

  test('a repeated identity is listed once', () => {
    expect(typingLabel([{ id: 'agent:p1', name: 'Billing Bot' }, { id: 'agent:p1', name: 'Billing Bot' }])).toBe(
      'Billing Bot is typing…',
    )
  })

  test('the same name under different identities is listed twice', () => {
    expect(typingLabel([{ id: 'u-pat', name: 'Pat' }, { id: 'agent:p1', name: 'Pat' }])).toBe('Pat and Pat are typing…')
  })
})

describe('typingLabelText', () => {
  test('the sentence without its ellipsis, so a view can draw the dots', () => {
    expect(typingLabelText([])).toBeNull()
    expect(typingLabelText(typists('Ana'))).toBe('Ana is typing')
    expect(typingLabelText(typists('Ana', 'Billing Bot'))).toBe('Ana and Billing Bot are typing')
    expect(typingLabelText(typists('Ana', 'Billing Bot', 'Lee'))).toBe('Ana, Billing Bot and 1 other are typing')
    expect(typingLabelText(typists('Ana', 'Lee', 'Kim', 'Sam'))).toBe('Ana, Lee and 2 others are typing')
  })

  test('typingLabel is exactly the text plus the ellipsis', () => {
    const three = typists('Ana', 'Billing Bot', 'Lee')
    expect(typingLabel(three)).toBe(`${typingLabelText(three)}…`)
  })
})

describe('runningAgentReplies', () => {
  const agent = (id: string, status: string | null, projectId: string | null, name: string | null) =>
    ({
      id,
      authorType: 'agent',
      agentStatus: status,
      authorAgent: name === null ? null : { projectId, name },
    }) as any

  test('lists only running agent replies', () => {
    const messages = [
      agent('m1', 'running', 'p1', 'Billing Bot'),
      agent('m2', 'done', 'p1', 'Billing Bot'),
      agent('m3', 'error', 'p1', 'Billing Bot'),
      { id: 'm4', authorType: 'user', agentStatus: null, authorAgent: null } as any,
    ]
    expect(runningAgentReplies(messages).map((m) => m.id)).toEqual(['m1'])
  })

  test('one entry per running reply, oldest first, even for one agent', () => {
    const messages = [agent('m1', 'running', 'p1', 'Billing Bot'), agent('m2', 'running', 'p1', 'Billing Bot')]
    expect(runningAgentReplies(messages).map((m) => m.id)).toEqual(['m1', 'm2'])
  })

  test('keeps each reply whole, so the dock can name it and open its session', () => {
    expect(runningAgentReplies([agent('m9', 'running', null, null)])).toEqual([
      expect.objectContaining({ id: 'm9', authorAgent: null }),
    ])
  })

  test('nothing running is nothing to dock', () => {
    expect(runningAgentReplies([])).toEqual([])
    expect(runningAgentReplies([agent('m2', 'done', 'p1', 'Billing Bot')])).toEqual([])
  })
})
