// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createElement, forwardRef } from 'react'
import { createReactNativeMock } from '../../../test/react-native-mock'

mock.module('react-native', () =>
  createReactNativeMock({
    Platform: { OS: 'web', select: (s: any) => s.web ?? s.default },
    // Double click stands in for a long press.
    Pressable: ({ accessibilityLabel, children, onPress, onLongPress, disabled, testID }: any) =>
      createElement(
        'div',
        {
          role: 'button',
          'aria-label': accessibilityLabel,
          'data-testid': testID,
          onClick: (e: any) => {
            e.stopPropagation()
            if (!disabled) onPress?.(e)
          },
          onDoubleClick: (e: any) => {
            e.stopPropagation()
            onLongPress?.(e)
          },
        },
        children,
      ),
    TextInput: forwardRef(function Input({ value, onChangeText, onSubmitEditing, onBlur, placeholder, accessibilityLabel }: any, ref: any) {
      return createElement('input', {
        ref,
        value,
        placeholder,
        'aria-label': accessibilityLabel ?? placeholder,
        onChange: (e: any) => onChangeText?.(e.target.value),
        onBlur: () => onBlur?.(),
        onKeyDown: (e: any) => {
          if (e.key === 'Enter') onSubmitEditing?.()
        },
      })
    }),
  } as any),
)
mock.module('@shogo/shared-ui/primitives', () => ({ cn: (...a: unknown[]) => a.filter(Boolean).join(' ') }))
mock.module('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }) }))
const routed: unknown[] = []
mock.module('expo-router', () => ({ useRouter: () => ({ push: (r: unknown) => routed.push(r) }) }))
mock.module('../../team-chat/TimelinePane', () => ({
  TimelinePane: ({ threadRootId }: any) => createElement('div', { 'data-testid': 'thread' }, `thread ${threadRootId}`),
}))
mock.module('../../../lib/team-chat-connection', () => ({ useTeamChatEvents: () => 'open' }))

type Call = { method: string; path: string; body?: any }
const calls: Call[] = []
let routes: Record<string, (call: Call) => unknown> = {}

function respond(call: Call) {
  calls.push(call)
  const bare = call.path.split('?')[0]!
  const handler = routes[`${call.method} ${bare}`]
  if (!handler) throw new Error(`unexpected ${call.method} ${bare}`)
  return { data: handler(call), status: 200 }
}

mock.module('../../../lib/api', () => ({
  API_URL: 'http://api.test',
  createHttpClient: () => ({
    get: async (path: string) => respond({ method: 'GET', path }),
    post: async (path: string, body?: unknown) => respond({ method: 'POST', path, body }),
    patch: async (path: string, body?: unknown) => respond({ method: 'PATCH', path, body }),
    delete: async (path: string) => respond({ method: 'DELETE', path }),
    request: async (path: string, opts: any) => respond({ method: opts.method, path, body: opts.body }),
  }),
}))

const { BoardKanban } = await import('../BoardKanban')
const { CardPane } = await import('../CardPane')
const { ChannelTabs } = await import('../../team-chat/ChannelTabs')

const columns = [
  { id: 'c1', name: 'Triage', position: 0, category: 'backlog', wipLimit: null, agentRef: 'project:p1', slaHours: 4 },
  { id: 'c2', name: 'Doing', position: 1, category: 'active', wipLimit: 1, agentRef: null, slaHours: null },
  { id: 'c3', name: 'Done', position: 2, category: 'done', wipLimit: null, agentRef: null, slaHours: null },
]
const board = {
  id: 'b1', workspaceId: 'ws', conversationId: 'conv', name: 'Support', slug: 'support', keyPrefix: 'SUP', position: 0,
  itemType: 'ticket', description: null, fieldsSchema: [], postToChannel: 'all', requiresHumanReview: false,
  defaultAssigneeAgentRef: null, managedBy: 'user', archivedAt: null, columns,
}
function item(id: string, columnId: string, position: number, extra: Record<string, unknown> = {}) {
  return {
    id, key: `SUP-${id}`, number: 1, boardId: 'b1', columnId, position, title: `Card ${id}`, description: null, fields: {},
    priority: 'none', assigneeUserId: null, assigneeAgentRef: null, dueAt: null, conversationId: null, threadRootMessageId: null,
    source: 'manual', externalRef: null, historySummary: null, columnEnteredAt: new Date().toISOString(),
    lastActivityAt: new Date().toISOString(), completedAt: null, archivedAt: null, createdAt: new Date().toISOString(), ...extra,
  }
}
const mentionables = {
  people: [{ id: 'u1', name: 'Ada', email: 'ada@x', image: null, role: 'member' }],
  agents: [{ key: 'p:p1', projectId: 'p1', name: 'Support bot', description: null, image: null }],
}

beforeEach(() => {
  calls.length = 0
  routed.length = 0
  routes = {}
})
afterEach(() => cleanup())

describe('BoardKanban', () => {
  beforeEach(() => {
    routes['GET /api/boards/b1'] = () => ({
      board,
      items: [item('1', 'c1', 1, { priority: 'urgent' }), item('2', 'c2', 1), item('3', 'c2', 2, { assigneeAgentRef: 'project:p1' })],
      health: { issues: [{ type: 'wip_exceeded', columnId: 'c2', column: 'Doing', detail: '2 cards, WIP limit 1' }, { type: 'stale', itemId: '2', key: 'SUP-2', title: 'Card 2', columnId: 'c2', detail: 'No activity for 80h' }] },
    })
  })

  test('shows columns, cards, the column agent, WIP use and health issues', async () => {
    render(createElement(BoardKanban, { boardId: 'b1', workspaceId: 'ws', mentionables: mentionables as any, onOpenCard: () => {} }))
    await screen.findByTestId('board-card-SUP-1')
    expect(document.querySelector('[data-rn-shim="board-column-Triage"]')!.textContent).toContain('Support bot')
    expect(screen.getByText('2/1')).toBeTruthy()
    expect(screen.getByTestId('board-card-SUP-3').textContent).toContain('Support bot')
    expect(screen.getByTestId('board-card-SUP-2').textContent).toContain('Stale')
    fireEvent.click(screen.getByTestId('board-health'))
    expect(screen.getByText(/WIP limit 1/)).toBeTruthy()
  })

  test('long press opens the move menu and moving posts to the server', async () => {
    routes['POST /api/work-items/1/move'] = () => ({ item: item('1', 'c3', 1), warnings: [] })
    render(createElement(BoardKanban, { boardId: 'b1', workspaceId: 'ws', mentionables: mentionables as any, onOpenCard: () => {} }))
    fireEvent.doubleClick(await screen.findByTestId('board-card-SUP-1'))
    fireEvent.click(screen.getAllByText('Done').at(-1)!)
    await waitFor(() => expect(calls.find((c) => c.method === 'POST')).toEqual({ method: 'POST', path: '/api/work-items/1/move', body: { column: 'c3' } }))
  })

  test('a server warning about WIP shows under the toolbar', async () => {
    routes['POST /api/work-items/1/move'] = () => ({ item: item('1', 'c2', 3), warnings: ['Doing is over its WIP limit (3/1)'] })
    render(createElement(BoardKanban, { boardId: 'b1', workspaceId: 'ws', mentionables: mentionables as any, onOpenCard: () => {} }))
    fireEvent.doubleClick(await screen.findByTestId('board-card-SUP-1'))
    fireEvent.click(screen.getAllByText('Doing').at(-1)!)
    expect(await screen.findByText('Doing is over its WIP limit (3/1)')).toBeTruthy()
  })

  test('adding a card posts it to that column', async () => {
    routes['POST /api/boards/b1/items'] = () => ({ item: item('4', 'c1', 2) })
    render(createElement(BoardKanban, { boardId: 'b1', workspaceId: 'ws', mentionables: mentionables as any, onOpenCard: () => {} }))
    await screen.findByTestId('board-card-SUP-1')
    fireEvent.click(screen.getAllByText('Add card')[0]!)
    fireEvent.change(screen.getByLabelText('New card title'), { target: { value: 'Refund for order 1182' } })
    fireEvent.click(screen.getByText('Add'))
    await waitFor(() => expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ title: 'Refund for order 1182', column: 'c1' }))
  })

  test('a card shows a spinner and the agent name while its reply runs', async () => {
    routes['GET /api/boards/b1'] = () => ({
      board,
      items: [item('1', 'c1', 1), item('2', 'c2', 1, { working: [{ messageId: 'm1', name: 'Support bot' }] })],
      health: { issues: [] },
    })
    render(createElement(BoardKanban, { boardId: 'b1', workspaceId: 'ws', mentionables: mentionables as any, onOpenCard: () => {} }))
    await screen.findByTestId('board-card-SUP-2')
    const working = document.querySelector('[data-rn-shim="board-card-working-SUP-2"]')
    expect(working!.textContent).toContain('Support bot is working')
    expect(document.querySelector('[data-rn-shim="board-card-working-SUP-1"]')).toBeNull()
  })

  test('pressing a card opens it', async () => {
    const opened: string[] = []
    render(createElement(BoardKanban, { boardId: 'b1', workspaceId: 'ws', mentionables: mentionables as any, onOpenCard: (i: any) => opened.push(i.id) }))
    fireEvent.click(await screen.findByTestId('board-card-SUP-2'))
    expect(opened).toEqual(['2'])
  })
})

describe('ChannelTabs', () => {
  const conversation = { id: 'conv', kind: 'public', hasDoc: false } as any

  test('lists boards between Messages and Doc and switches between them', () => {
    const opened: string[] = []
    let adding = 0
    render(createElement(ChannelTabs, {
      conversation,
      docOpen: false,
      onOpenDoc: () => {},
      onShowMessages: () => {},
      boards: [board as any, { ...board, id: 'b2', slug: 'renewals', name: 'Renewals' } as any],
      activeBoardId: 'b2',
      onOpenBoard: (id: string) => opened.push(id),
      onAddBoard: () => adding++,
    }))
    const labels = screen.getAllByRole('button').map((b) => b.getAttribute('aria-label'))
    expect(labels).toEqual(['Messages', 'Support', 'Renewals', 'Add doc', 'Add board'])
    fireEvent.click(screen.getByTestId('channel-tab-board-support'))
    fireEvent.click(screen.getByTestId('channel-add-board'))
    expect(opened).toEqual(['b1'])
    expect(adding).toBe(1)
  })
})

describe('CardPane', () => {
  const detail = (extra: Record<string, unknown> = {}) => ({
    item: item('7', 'c2', 1, { title: 'Checkout 500s', priority: 'high', conversationId: 'conv', threadRootMessageId: 'root1', ...extra }),
    board: { id: 'b1', name: 'Support', slug: 'support', itemType: 'ticket', conversationId: 'conv', fieldsSchema: [], columns },
    column: columns[1],
    url: 'https://x/c/conv?thread=root1&card=7',
    following: false,
    recentMessages: [],
    links: [],
    agentRuns: [{ sessionId: 's1', name: 'Investigate 500s', projectId: 'p1', agentRef: 'project:p1', startedAt: new Date().toISOString(), lastActiveAt: new Date().toISOString() }],
    events: [],
  })
  const conversation = { id: 'conv', kind: 'public' } as any

  beforeEach(() => {
    routes['GET /api/work-items/7'] = () => detail()
  })

  test('shows the card and its thread', async () => {
    render(createElement(CardPane, { itemId: '7', workspaceId: 'ws', me: 'u1', mentionables: mentionables as any, conversation, visible: true, onClose: () => {} }))
    expect(await screen.findByTestId('thread')).toBeTruthy()
    expect(screen.getByText('thread root1')).toBeTruthy()
    expect(screen.getByLabelText('Column: Doing')).toBeTruthy()
    expect(screen.getByLabelText('Priority: high')).toBeTruthy()
    expect(screen.getByLabelText('Assignee: Unassigned')).toBeTruthy()
  })

  test('assigning to an agent patches the card', async () => {
    routes['PATCH /api/work-items/7'] = (c) => ({ item: item('7', 'c2', 1, c.body) })
    render(createElement(CardPane, { itemId: '7', workspaceId: 'ws', me: 'u1', mentionables: mentionables as any, conversation, visible: true, onClose: () => {} }))
    fireEvent.click(await screen.findByTestId('card-assignee'))
    fireEvent.click(screen.getByText('Support bot (agent)'))
    await waitFor(() => expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ assigneeUserId: null, assigneeAgentRef: 'project:p1' }))
    expect(screen.getByLabelText('Assignee: Support bot')).toBeTruthy()
  })

  test('history describes card events and filters by kind', async () => {
    routes['GET /api/work-items/7/history'] = (c) => ({
      entries: c.path.includes('filter=status')
        ? [{ type: 'event', at: new Date().toISOString(), event: { id: 'e1', type: 'moved', actorUserId: 'u1', actorAgentRef: null, sessionId: null, data: { from: { column: 'Triage' }, to: { column: 'Doing' } }, createdAt: '' } }]
        : [
            { type: 'message', at: new Date().toISOString(), message: { id: 'm1', author: 'Support bot', authorType: 'agent', text: 'Rolled back the deploy.', agentSessionId: 's1', agentStatus: 'done', createdAt: '' } },
            { type: 'link', at: new Date().toISOString(), link: { id: 'l1', kind: 'message', refId: 'm9', conversationId: 'dm1', reason: 'mention', snippet: null, url: null, private: true, createdAt: '' } },
          ],
      nextBefore: null,
    })
    render(createElement(CardPane, { itemId: '7', workspaceId: 'ws', me: 'u1', mentionables: mentionables as any, conversation, visible: true, onClose: () => {} }))
    fireEvent.click(await screen.findByText('History'))
    expect(await screen.findByText('Rolled back the deploy.')).toBeTruthy()
    expect(screen.getByText(/Mentioned in a private conversation/)).toBeTruthy()
    fireEvent.click(screen.getByText('Status'))
    expect(await screen.findByText('Ada moved it from Triage to Doing')).toBeTruthy()
  })

  test('agent runs open the agent session', async () => {
    render(createElement(CardPane, { itemId: '7', workspaceId: 'ws', me: 'u1', mentionables: mentionables as any, conversation, visible: true, onClose: () => {} }))
    fireEvent.click(await screen.findByText('Agent runs (1)'))
    fireEvent.click(screen.getByText('Investigate 500s'))
    expect(routed).toEqual([{ pathname: '/(app)/projects/[id]', params: { id: 'p1', chatSessionId: 's1' } }])
  })

  test('a card without a thread offers a comment box', async () => {
    routes['GET /api/work-items/7'] = () => detail({ conversationId: null, threadRootMessageId: null })
    routes['POST /api/work-items/7/comments'] = () => ({ messageId: null })
    render(createElement(CardPane, { itemId: '7', workspaceId: 'ws', me: 'u1', mentionables: mentionables as any, visible: true, onClose: () => {} }))
    fireEvent.change(await screen.findByLabelText('Comment'), { target: { value: 'Customer replied' } })
    await act(async () => {
      fireEvent.click(screen.getAllByText('Comment').at(-1)!)
    })
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ text: 'Customer replied' })
  })
})
