// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * The dock above the composer: one row per running agent reply, wherever its
 * message has ended up in the thread. The row is the run's handle — jump to the
 * reply, open its session, stop it — and the dock never grows past three rows.
 */
import { afterEach, describe, expect, mock, test } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createElement } from 'react'
import { createReactNativeMock } from '../../../test/react-native-mock'
import type { ChatMessage } from '../../../lib/team-chat-api'

mock.module('react-native', () =>
  createReactNativeMock({
    Platform: { OS: 'web' },
    View: ({ testID, children, style, className }: any) =>
      createElement('div', { 'data-testid': testID, style, className }, children),
    Text: ({ testID, children, numberOfLines: _lines, style }: any) =>
      createElement('span', { 'data-testid': testID, style }, children),
    Pressable: ({ accessibilityLabel, children, onPress, testID }: any) =>
      createElement(
        'div',
        {
          role: 'button',
          'aria-label': accessibilityLabel,
          'data-testid': testID,
          onClick: (e: any) => {
            // As in React Native, the innermost pressable handles the press.
            e.stopPropagation()
            onPress?.(e)
          },
        },
        children,
      ),
  }),
)
mock.module('@shogo/shared-ui/primitives', () => ({ cn: (...args: unknown[]) => args.filter(Boolean).join(' ') }))
// The dock's rows come from a real AgentWorkingStatus; only its work-group
// widgets are stubbed, because they animate.
mock.module('../../chat/turns/WorkGroup', () => ({
  WorkGroup: ({ items }: any) => createElement('div', { 'data-rn-shim': 'group' }, `${items.length}:false`),
}))
// The finished-run widgets ride along in AgentWork's module graph and reach the
// Expo router; the dock never renders them.
mock.module('../../chat/turns/AssistantContent', () => ({ AssistantContent: () => null }))
mock.module('../../chat/turns/WorkedForGroup', () => ({ WorkedForGroup: () => null }))
mock.module('../../../lib/team-chat-api', () => ({
  absoluteApiUrl: (url: string) => url,
  teamChatApi: () => ({ workLog: async () => ({ parts: [], startedAt: 0, completedAt: 1, toolCalls: 0 }) }),
}))
// An agent's avatar is its buddy, drawn on a canvas; the row's business here is
// the name and the controls beside it.
mock.module('../AgentAvatar', () => ({
  AgentAvatar: ({ name }: any) => createElement('div', { 'data-rn-shim': 'agent-avatar', 'data-name': name }),
}))
mock.module('../../ui/LiquidGlassBackdrop', () => ({
  LiquidGlassBackdrop: () => createElement('div', { 'data-rn-shim': 'glass' }),
}))
// CappedContentScroll pins a pixel height from its own measurement; here it
// reports the cap it was given so a test can check the dock stays three rows.
mock.module('../../chat/dock/CappedContentScroll', () => ({
  CappedContentScroll: ({ maxHeight, children, testID }: any) =>
    createElement('div', { 'data-testid': testID, 'data-max-height': String(maxHeight) }, children),
}))

const { RunningAgentsDock, MAX_DOCK_ROWS } = await import('../RunningAgentsDock')

const running = (id: string, name: string, extra: Partial<ChatMessage> = {}): ChatMessage =>
  ({
    id,
    conversationId: 'c1',
    workspaceId: 'ws',
    seq: 1,
    threadRootId: null,
    replyCount: 0,
    lastReplyAt: null,
    alsoSentToChannel: false,
    authorType: 'agent',
    author: null,
    authorUserId: null,
    authorAgent: { projectId: `proj-${id}`, name },
    text: '',
    blocks: null,
    clientMsgId: null,
    agentSessionId: `s-${id}`,
    agentStatus: 'running',
    reactions: [],
    attachments: [],
    editedAt: null,
    deletedAt: null,
    createdAt: new Date(0).toISOString(),
    ...extra,
  }) as any

const noop = () => {}
const handlers = () => ({ onJump: mock(noop), onStop: mock(noop), onOpenSession: mock(noop) })

afterEach(cleanup)

describe('RunningAgentsDock', () => {
  test('renders nothing when no agent is running', () => {
    const { container } = render(
      createElement(RunningAgentsDock, { replies: [], streaming: {}, ...handlers() }),
    )
    expect(container.firstChild).toBeNull()
    expect(screen.queryByTestId('running-agents-dock')).toBeNull()
  })

  test('one row per running reply, oldest first, each naming its agent', () => {
    render(
      createElement(RunningAgentsDock, {
        replies: [running('m1', 'Billing Bot'), running('m2', 'Billing Bot'), running('m3', 'Support Bot')],
        streaming: {},
        ...handlers(),
      }),
    )
    const rows = screen.getAllByTestId(/^running-agent-row-/)
    expect(rows.map((row) => row.getAttribute('data-testid'))).toEqual([
      'running-agent-row-m1',
      'running-agent-row-m2',
      'running-agent-row-m3',
    ])
    expect(rows[0]!.textContent).toContain('Billing Bot')
    expect(rows[2]!.textContent).toContain('Support Bot')
  })

  test('a working reply shows the tool it is on, one line', () => {
    render(
      createElement(RunningAgentsDock, {
        replies: [running('m1', 'Billing Bot')],
        streaming: { m1: { text: '', tool: 'exec', tools: [{ name: 'exec', done: false }] } },
        ...handlers(),
      }),
    )
    expect(screen.getByTestId('agent-working-status-compact').textContent).toBe('Running 1 command')
  })

  test('a reply with no tool yet still says it is working', () => {
    render(
      createElement(RunningAgentsDock, {
        replies: [running('m1', 'Billing Bot')],
        streaming: {},
        ...handlers(),
      }),
    )
    expect(screen.getByTestId('agent-working-status-compact').textContent).toBe('Working…')
  })

  test('a queued reply says where it is in line', () => {
    render(
      createElement(RunningAgentsDock, {
        replies: [running('m1', 'Billing Bot')],
        streaming: { m1: { text: '', tool: null, queue: { position: 2, ahead: 1, running: 1, limit: 1 } } },
        ...handlers(),
      }),
    )
    expect(screen.getByTestId('agent-queue-status').textContent).toContain('Queued · #2 in line')
  })

  test('a reply parked on an open tool says what it waits on', () => {
    render(
      createElement(RunningAgentsDock, {
        replies: [running('m1', 'Billing Bot')],
        streaming: { m1: { text: '', tool: null, waiting: { tool: 'wait' } } },
        ...handlers(),
      }),
    )
    expect(screen.getByTestId('agent-queue-status').textContent).toContain('Waiting on wait…')
  })

  test('a reply queued from the start says so after a reload', () => {
    render(
      createElement(RunningAgentsDock, {
        replies: [running('m1', 'Billing Bot', { blocks: { queued: { since: new Date(0).toISOString() } } })],
        streaming: {},
        ...handlers(),
      }),
    )
    expect(screen.getByTestId('agent-queue-status').textContent).toContain('Queued')
  })

  test('pressing a row jumps to its reply', () => {
    const h = handlers()
    render(createElement(RunningAgentsDock, { replies: [running('m1', 'Billing Bot')], streaming: {}, ...h }))
    fireEvent.click(screen.getByLabelText("Jump to Billing Bot's reply"))
    expect(h.onJump).toHaveBeenCalledWith('m1')
    expect(h.onStop).not.toHaveBeenCalled()
  })

  test('Stop and Open session act on that reply without jumping to it', () => {
    const h = handlers()
    render(createElement(RunningAgentsDock, { replies: [running('m1', 'Billing Bot')], streaming: {}, ...h }))
    fireEvent.click(screen.getByLabelText('Stop agent'))
    expect(h.onStop).toHaveBeenCalledWith(expect.objectContaining({ id: 'm1' }))
    fireEvent.click(screen.getByLabelText('Open the session this agent is working in'))
    expect(h.onOpenSession).toHaveBeenCalledWith(expect.objectContaining({ id: 'm1', agentSessionId: 's-m1' }))
    expect(h.onJump).not.toHaveBeenCalled()
  })

  test('a reply with no session offers Stop alone', () => {
    render(
      createElement(RunningAgentsDock, {
        replies: [running('m1', 'Billing Bot', { agentSessionId: null })],
        streaming: {},
        ...handlers(),
      }),
    )
    expect(screen.getByLabelText('Stop agent')).toBeTruthy()
    expect(screen.queryByLabelText('Open the session this agent is working in')).toBeNull()
  })

  test('past three rows the dock scrolls instead of growing', () => {
    const replies = ['m1', 'm2', 'm3', 'm4'].map((id) => running(id, `Agent ${id}`))
    render(createElement(RunningAgentsDock, { replies, streaming: {}, ...handlers() }))
    const scroll = screen.getByTestId('running-agents-dock-scroll')
    const cap = Number(scroll.getAttribute('data-max-height'))
    // Three rows' worth, however tall a row is.
    expect(cap).toBeGreaterThan(0)
    expect(MAX_DOCK_ROWS).toBe(3)
    expect(cap / MAX_DOCK_ROWS).toBeLessThan(48)
    expect(screen.getAllByTestId(/^running-agent-row-/)).toHaveLength(4)
  })

  test('the phone pane gets the glass card; a docked pane gets the composer card', () => {
    const replies = [running('m1', 'Billing Bot')]
    const { unmount } = render(
      createElement(RunningAgentsDock, { replies, streaming: {}, floating: true, ...handlers() }),
    )
    expect(screen.getByTestId('running-agents-dock').querySelector('[data-rn-shim="glass"]')).toBeTruthy()
    unmount()

    render(createElement(RunningAgentsDock, { replies, streaming: {}, ...handlers() }))
    const card = screen.getByTestId('running-agents-dock')
    expect(card.querySelector('[data-rn-shim="glass"]')).toBeNull()
    expect(card.className).toContain('bg-popover')
  })
})
