// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from 'bun:test'
import { runningAgentTypists, typingLabel, type Typist } from '../team-chat-typing'

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

describe('runningAgentTypists', () => {
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
      { id: 'm3', authorType: 'user', agentStatus: null, authorAgent: null } as any,
    ]
    expect(runningAgentTypists(messages)).toEqual([{ id: 'agent:p1', name: 'Billing Bot' }])
  })

  test('two running replies from one agent share an identity', () => {
    const messages = [agent('m1', 'running', 'p1', 'Billing Bot'), agent('m2', 'running', 'p1', 'Billing Bot')]
    expect(runningAgentTypists(messages).map((t) => t.id)).toEqual(['agent:p1', 'agent:p1'])
  })

  test('an agent without a project falls back to its message id and a generic name', () => {
    expect(runningAgentTypists([agent('m9', 'running', null, null)])).toEqual([{ id: 'agent:m9', name: 'Agent' }])
  })
})
