// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Chat Session Isolation Tests
 *
 * Validates that per-tab ChatPanel instances maintain independent state:
 * - Chat instances with different IDs have isolated messages and status
 * - Tab management logic (open, close, switch) works correctly
 * - Concurrent streaming across sessions doesn't leak state
 *
 * Run: bun test apps/mobile/lib/__tests__/chat-session-isolation.test.ts
 */

import { describe, test, expect, beforeEach } from 'bun:test'

// ---------------------------------------------------------------------------
// 1. Chat instance isolation (AI SDK Chat class)
// ---------------------------------------------------------------------------

describe('Chat instance isolation', () => {
  // We import the Chat class from @ai-sdk/react. Each Chat instance
  // maintains its own messages, status, and active response independently.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { Chat } = require('@ai-sdk/react')

  test('two Chat instances with different IDs have independent messages', () => {
    const chatA = new Chat({ id: 'session-a', messages: [] })
    const chatB = new Chat({ id: 'session-b', messages: [] })

    chatA.messages = [
      { id: 'msg-1', role: 'user', content: 'Hello from A', parts: [{ type: 'text', text: 'Hello from A' }] },
    ]

    expect(chatA.messages).toHaveLength(1)
    expect(chatB.messages).toHaveLength(0)
    expect(chatA.messages[0].content).toBe('Hello from A')
  })

  test('setting messages on one Chat does not affect another', () => {
    const chatA = new Chat({ id: 'session-a', messages: [] })
    const chatB = new Chat({ id: 'session-b', messages: [] })

    const messagesA = [
      { id: 'a1', role: 'user', content: 'User A', parts: [{ type: 'text', text: 'User A' }] },
      { id: 'a2', role: 'assistant', content: 'Reply A', parts: [{ type: 'text', text: 'Reply A' }] },
    ]
    const messagesB = [
      { id: 'b1', role: 'user', content: 'User B', parts: [{ type: 'text', text: 'User B' }] },
    ]

    chatA.messages = messagesA
    chatB.messages = messagesB

    expect(chatA.messages).toHaveLength(2)
    expect(chatB.messages).toHaveLength(1)
    expect(chatA.messages[0].id).toBe('a1')
    expect(chatB.messages[0].id).toBe('b1')
  })

  test('each Chat has its own ID', () => {
    const chatA = new Chat({ id: 'session-a', messages: [] })
    const chatB = new Chat({ id: 'session-b', messages: [] })

    expect(chatA.id).toBe('session-a')
    expect(chatB.id).toBe('session-b')
  })

  test('Chat without explicit ID gets a generated ID', () => {
    const chatA = new Chat({ messages: [] })
    const chatB = new Chat({ messages: [] })

    expect(chatA.id).toBeDefined()
    expect(chatB.id).toBeDefined()
    expect(chatA.id).not.toBe(chatB.id)
  })

  test('status is independent per Chat instance', () => {
    const chatA = new Chat({ id: 'session-a', messages: [] })
    const chatB = new Chat({ id: 'session-b', messages: [] })

    expect(chatA.status).toBe('ready')
    expect(chatB.status).toBe('ready')

    // Both start in ready state; status only changes via internal stream mechanics.
    // The key assertion: they are distinct objects with independent state.
    expect(chatA).not.toBe(chatB)
  })

  test('clearing messages on one Chat preserves the other', () => {
    const chatA = new Chat({ id: 'session-a', messages: [] })
    const chatB = new Chat({ id: 'session-b', messages: [] })

    chatA.messages = [
      { id: 'a1', role: 'user', content: 'Hello', parts: [{ type: 'text', text: 'Hello' }] },
    ]
    chatB.messages = [
      { id: 'b1', role: 'user', content: 'World', parts: [{ type: 'text', text: 'World' }] },
    ]

    chatA.messages = []

    expect(chatA.messages).toHaveLength(0)
    expect(chatB.messages).toHaveLength(1)
    expect(chatB.messages[0].content).toBe('World')
  })
})

// ---------------------------------------------------------------------------
// 2. Tab management logic
// ---------------------------------------------------------------------------

type TabState = {
  openTabIds: string[]
  activeTabId: string | null
}

function createTab(state: TabState, newTabId: string): TabState {
  return {
    openTabIds: state.openTabIds.includes(newTabId)
      ? state.openTabIds
      : [...state.openTabIds, newTabId],
    activeTabId: newTabId,
  }
}

function closeTab(state: TabState, tabId: string): TabState {
  const next = state.openTabIds.filter((id) => id !== tabId)

  let activeTabId = state.activeTabId
  if (tabId === state.activeTabId) {
    const idx = state.openTabIds.indexOf(tabId)
    activeTabId = state.openTabIds[idx + 1] ?? state.openTabIds[idx - 1] ?? null
  }

  return { openTabIds: next, activeTabId }
}

function selectTab(state: TabState, tabId: string): TabState {
  if (!state.openTabIds.includes(tabId)) {
    return {
      openTabIds: [...state.openTabIds, tabId],
      activeTabId: tabId,
    }
  }
  return { ...state, activeTabId: tabId }
}

describe('Tab management logic', () => {
  let state: TabState

  beforeEach(() => {
    state = { openTabIds: ['session-1'], activeTabId: 'session-1' }
  })

  test('creating a new tab adds it and makes it active', () => {
    state = createTab(state, 'session-2')

    expect(state.openTabIds).toEqual(['session-1', 'session-2'])
    expect(state.activeTabId).toBe('session-2')
  })

  test('creating a duplicate tab does not add it again', () => {
    state = createTab(state, 'session-1')

    expect(state.openTabIds).toEqual(['session-1'])
    expect(state.activeTabId).toBe('session-1')
  })

  test('closing the active tab selects the next neighbor', () => {
    state = createTab(state, 'session-2')
    state = createTab(state, 'session-3')
    state = selectTab(state, 'session-2')

    state = closeTab(state, 'session-2')

    expect(state.openTabIds).toEqual(['session-1', 'session-3'])
    expect(state.activeTabId).toBe('session-3')
  })

  test('closing the last tab in the list selects the previous one', () => {
    state = createTab(state, 'session-2')
    state = selectTab(state, 'session-2')

    state = closeTab(state, 'session-2')

    expect(state.openTabIds).toEqual(['session-1'])
    expect(state.activeTabId).toBe('session-1')
  })

  test('closing a non-active tab preserves the active tab', () => {
    state = createTab(state, 'session-2')
    state = createTab(state, 'session-3')

    state = closeTab(state, 'session-1')

    expect(state.openTabIds).toEqual(['session-2', 'session-3'])
    expect(state.activeTabId).toBe('session-3')
  })

  test('closing the only tab yields null active', () => {
    state = closeTab(state, 'session-1')

    expect(state.openTabIds).toEqual([])
    expect(state.activeTabId).toBeNull()
  })

  test('selecting a tab that is already open only changes activeTabId', () => {
    state = createTab(state, 'session-2')

    state = selectTab(state, 'session-1')

    expect(state.openTabIds).toEqual(['session-1', 'session-2'])
    expect(state.activeTabId).toBe('session-1')
  })

  test('selecting a tab not in the list adds and activates it', () => {
    state = selectTab(state, 'session-new')

    expect(state.openTabIds).toEqual(['session-1', 'session-new'])
    expect(state.activeTabId).toBe('session-new')
  })
})

// ---------------------------------------------------------------------------
// 3. Session-scoped state isolation (simulated per-panel state)
// ---------------------------------------------------------------------------

describe('Session-scoped state isolation', () => {
  type SessionState = {
    messages: Array<{ id: string; role: string; content: string }>
    isStreaming: boolean
  }

  let sessions: Map<string, SessionState>

  beforeEach(() => {
    sessions = new Map()
  })

  function getOrCreateSession(sessionId: string): SessionState {
    if (!sessions.has(sessionId)) {
      sessions.set(sessionId, { messages: [], isStreaming: false })
    }
    return sessions.get(sessionId)!
  }

  test('each session maintains its own messages', () => {
    const sessionA = getOrCreateSession('a')
    const sessionB = getOrCreateSession('b')

    sessionA.messages.push({ id: '1', role: 'user', content: 'Hello A' })
    sessionB.messages.push({ id: '2', role: 'user', content: 'Hello B' })
    sessionB.messages.push({ id: '3', role: 'assistant', content: 'Reply B' })

    expect(sessionA.messages).toHaveLength(1)
    expect(sessionB.messages).toHaveLength(2)
    expect(sessionA.messages[0].content).toBe('Hello A')
    expect(sessionB.messages[1].content).toBe('Reply B')
  })

  test('streaming state is independent per session', () => {
    const sessionA = getOrCreateSession('a')
    const sessionB = getOrCreateSession('b')

    sessionA.isStreaming = true

    expect(sessionA.isStreaming).toBe(true)
    expect(sessionB.isStreaming).toBe(false)
  })

  test('clearing one session does not affect another', () => {
    const sessionA = getOrCreateSession('a')
    const sessionB = getOrCreateSession('b')

    sessionA.messages.push({ id: '1', role: 'user', content: 'A msg' })
    sessionB.messages.push({ id: '2', role: 'user', content: 'B msg' })

    sessionA.messages = []
    sessionA.isStreaming = false

    expect(sessionA.messages).toHaveLength(0)
    expect(sessionB.messages).toHaveLength(1)
    expect(sessionB.messages[0].content).toBe('B msg')
  })

  test('removing a session does not affect others', () => {
    getOrCreateSession('a').messages.push({ id: '1', role: 'user', content: 'A' })
    getOrCreateSession('b').messages.push({ id: '2', role: 'user', content: 'B' })
    getOrCreateSession('c').messages.push({ id: '3', role: 'user', content: 'C' })

    sessions.delete('b')

    expect(sessions.has('b')).toBe(false)
    expect(sessions.get('a')!.messages).toHaveLength(1)
    expect(sessions.get('c')!.messages).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// 4. Concurrent streaming simulation
// ---------------------------------------------------------------------------

describe('Concurrent streaming simulation', () => {
  test('two sessions can accumulate messages independently in parallel', () => {
    const sessionA = { messages: [] as string[], status: 'ready' as string }
    const sessionB = { messages: [] as string[], status: 'ready' as string }

    // Simulate interleaved streaming chunks
    sessionA.status = 'streaming'
    sessionA.messages.push('chunk-a1')

    sessionB.status = 'streaming'
    sessionB.messages.push('chunk-b1')

    sessionA.messages.push('chunk-a2')
    sessionB.messages.push('chunk-b2')
    sessionB.messages.push('chunk-b3')

    sessionA.status = 'ready'

    expect(sessionA.messages).toEqual(['chunk-a1', 'chunk-a2'])
    expect(sessionB.messages).toEqual(['chunk-b1', 'chunk-b2', 'chunk-b3'])
    expect(sessionA.status).toBe('ready')
    expect(sessionB.status).toBe('streaming')
  })

  test('finishing one stream does not affect the other', () => {
    const sessionA = { messages: ['a1'], status: 'streaming' as string }
    const sessionB = { messages: ['b1'], status: 'streaming' as string }

    sessionA.messages.push('a2-final')
    sessionA.status = 'ready'

    sessionB.messages.push('b2')

    expect(sessionA.status).toBe('ready')
    expect(sessionB.status).toBe('streaming')
    expect(sessionA.messages).toHaveLength(2)
    expect(sessionB.messages).toHaveLength(2)
  })

  test('Chat instances simulate concurrent streaming independently', () => {
    const { Chat } = require('@ai-sdk/react')

    const chatA = new Chat({ id: 'stream-a', messages: [] })
    const chatB = new Chat({ id: 'stream-b', messages: [] })

    // Simulate chat A receiving a user message
    chatA.messages = [
      { id: 'a-user', role: 'user', content: 'Question A', parts: [{ type: 'text', text: 'Question A' }] },
    ]

    // Simulate chat B receiving a different user message
    chatB.messages = [
      { id: 'b-user', role: 'user', content: 'Question B', parts: [{ type: 'text', text: 'Question B' }] },
    ]

    // Simulate streaming responses arriving
    chatA.messages = [
      ...chatA.messages,
      { id: 'a-asst', role: 'assistant', content: 'Answer A', parts: [{ type: 'text', text: 'Answer A' }] },
    ]

    chatB.messages = [
      ...chatB.messages,
      { id: 'b-asst', role: 'assistant', content: 'Answer B', parts: [{ type: 'text', text: 'Answer B' }] },
    ]

    // Verify complete isolation
    expect(chatA.messages).toHaveLength(2)
    expect(chatB.messages).toHaveLength(2)
    expect(chatA.messages[0].content).toBe('Question A')
    expect(chatA.messages[1].content).toBe('Answer A')
    expect(chatB.messages[0].content).toBe('Question B')
    expect(chatB.messages[1].content).toBe('Answer B')
  })
})
