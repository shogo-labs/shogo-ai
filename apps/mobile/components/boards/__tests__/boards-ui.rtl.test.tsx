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
// The real one parses markdown into a FlatList, which the RN mock renders empty.
mock.module('../../chat/MarkdownText', () => ({
  MarkdownText: ({ children }: any) => createElement('div', null, children),
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

  const detailsPane = () => document.querySelector('[data-rn-shim="card-details"]')

  test('description and summary live on their own Details tab', async () => {
    routes['GET /api/work-items/7'] = () => detail({
      description: 'Checkout 500s on retry',
      historySummary: 'Rolled back the deploy; watching the next hour.',
    })
    render(createElement(CardPane, { itemId: '7', workspaceId: 'ws', me: 'u1', mentionables: mentionables as any, conversation, visible: true, onClose: () => {} }))
    expect(await screen.findByTestId('thread')).toBeTruthy()
    expect(screen.getByLabelText('Card title')).toBeTruthy()
    expect(screen.getByLabelText('Column: Doing')).toBeTruthy()
    expect(detailsPane()).toBeNull()
    expect(document.body.textContent).not.toContain('Checkout 500s on retry')
    expect(document.body.textContent).not.toContain('Rolled back the deploy')

    fireEvent.click(screen.getByTestId('card-tab-details'))
    const details = detailsPane()!
    expect(details.textContent).toContain('Summary')
    expect(screen.queryByTestId('thread')).toBeNull()
    expect(details.textContent).toContain('Checkout 500s on retry')
    expect(details.textContent).toContain('Rolled back the deploy')

    fireEvent.click(screen.getByTestId('card-tab-thread'))
    expect(await screen.findByTestId('thread')).toBeTruthy()
    expect(detailsPane()).toBeNull()
  })

  test('a card with no description and no summary shows neither on Details', async () => {
    render(createElement(CardPane, { itemId: '7', workspaceId: 'ws', me: 'u1', mentionables: mentionables as any, conversation, visible: true, onClose: () => {} }))
    fireEvent.click(await screen.findByTestId('card-tab-details'))
    const details = detailsPane()!
    expect(details.textContent).toContain('Add a description')
    expect(details.textContent).not.toContain('Summary')
  })

  test('board fields render on Details under their schema labels', async () => {
    const base = detail({ fields: { area: 'checkout-v2' } })
    routes['GET /api/work-items/7'] = () => ({
      ...base,
      board: { ...base.board, fieldsSchema: [{ key: 'area', label: 'Area', type: 'text' }] },
    })
    render(createElement(CardPane, { itemId: '7', workspaceId: 'ws', me: 'u1', mentionables: mentionables as any, conversation, visible: true, onClose: () => {} }))
    expect(await screen.findByTestId('thread')).toBeTruthy()
    expect(document.body.textContent).not.toContain('checkout-v2')

    fireEvent.click(screen.getByTestId('card-tab-details'))
    const details = detailsPane()!
    expect(details.textContent).toContain('Area')
    expect(details.textContent).toContain('checkout-v2')
  })

  test('editing the description from Details patches the card', async () => {
    routes['PATCH /api/work-items/7'] = (c) => ({ item: item('7', 'c2', 1, c.body) })
    render(createElement(CardPane, { itemId: '7', workspaceId: 'ws', me: 'u1', mentionables: mentionables as any, conversation, visible: true, onClose: () => {} }))
    fireEvent.click(await screen.findByTestId('card-tab-details'))
    fireEvent.click(screen.getByLabelText('Add a description'))
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Retry loop double-charges' } })
    await act(async () => {
      fireEvent.blur(screen.getByLabelText('Description'))
    })
    await waitFor(() => expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ description: 'Retry loop double-charges' }))

    fireEvent.click(screen.getByLabelText('Edit description'))
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: '   ' } })
    await act(async () => {
      fireEvent.blur(screen.getByLabelText('Description'))
    })
    await waitFor(() => expect(calls.filter((c) => c.method === 'PATCH').at(-1)?.body).toEqual({ description: null }))
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

describe('cards that know their PR (SHO-64)', () => {
  const prBlock = (extra: Record<string, unknown> = {}) => ({
    number: 1519,
    repo: 'shogo-labs/shogo-ai',
    url: 'https://github.com/shogo-labs/shogo-ai/pull/1519',
    state: 'open',
    draft: false,
    merged: false,
    mergedAt: null,
    headSha: 'abc',
    headRef: 'sho-64-pr-aware-cards',
    mergeableState: 'blocked',
    checks: { total: 4, passing: 3, failing: 0, pending: 1 },
    failing: [],
    armed: true,
    queued: false,
    ok: true,
    red: false,
    syncedAt: new Date().toISOString(),
    ...extra,
  })

  beforeEach(() => {
    routes['GET /api/boards/b1'] = () => ({
      board,
      items: [
        item('1', 'c1', 1, { pr: prBlock() }),
        item('2', 'c2', 1, { pr: prBlock({ number: 1531, armed: false, red: true, mergeableState: 'unstable', checks: { total: 4, passing: 2, failing: 2, pending: 0 }, failing: [{ name: 'Lint, Typecheck, Test', url: 'https://github.com/shogo-labs/shogo-ai/runs/1' }] }) }),
        item('3', 'c3', 1, { pr: prBlock({ number: 1537, state: 'closed', merged: true, armed: false, checks: { total: 4, passing: 4, failing: 0, pending: 0 } }) }),
        item('4', 'c2', 2),
      ],
      health: { issues: [] },
    })
  })

  test('a board tile names the PR, its checks and whether it is armed', async () => {
    render(createElement(BoardKanban, { boardId: 'b1', workspaceId: 'ws', mentionables: mentionables as any, onOpenCard: () => {} }))
    await screen.findByTestId('board-card-SUP-1')
    expect(screen.getByTestId('board-card-pr-1519').textContent).toContain('#1519 · 3/4 checks · 1 running · armed')
    expect(screen.getByTestId('board-card-pr-1531').textContent).toContain('#1531 · 2/4 checks · failing')
    expect(screen.getByTestId('board-card-pr-1537').textContent).toContain('#1537 · merged')
    // A card without a PR shows no chip.
    expect(document.querySelector('[data-testid^="board-card-pr-"][data-testid="board-card-pr-"]')).toBeNull()
    expect(screen.getByTestId('board-card-SUP-4').textContent).not.toContain('#')
  })

  test('an arm that happened outside the guard shows in a warning tone', async () => {
    // Armed in a column that may not arm: the board reports it, the PR stays
    // armed, and the chip stops looking green.
    routes['GET /api/boards/b1'] = () => ({
      board,
      items: [item('6', 'c1', 6, {
        pr: prBlock({
          number: 1700,
          armed: true,
          armingWarning: true,
          mergeableState: 'clean',
          checks: { total: 4, passing: 4, failing: 0, pending: 0 },
        }),
      })],
      health: { issues: [] },
    })
    render(createElement(BoardKanban, { boardId: 'b1', workspaceId: 'ws', mentionables: mentionables as any, onOpenCard: () => {} }))
    const chip = await screen.findByTestId('board-card-pr-1700')
    expect(chip.textContent).toContain('#1700 · 4/4 checks · armed')
    const { prTone } = await import('../PullRequestChip')
    expect(prTone(prBlock({ number: 1700, armed: true, armingWarning: true }) as any)).toBe('warning')
    expect(prTone(prBlock({ number: 1700, armed: true }) as any)).not.toBe('warning')
  })

  test('a failing check that is not required still shows on the tile', async () => {
    // #1533's shape: `unstable`, only `cla` + `Android (emulator)` red. The card
    // says so, but the board does not treat it as blocked.
    routes['GET /api/boards/b1'] = () => ({
      board,
      items: [item('5', 'c1', 5, {
        pr: prBlock({
          number: 1533,
          red: false,
          mergeableState: 'unstable',
          checks: { total: 3, passing: 1, failing: 2, pending: 0 },
          failing: [{ name: 'cla', url: null }, { name: 'Android (emulator)', url: null }],
        }),
      })],
      health: { issues: [] },
    })
    render(createElement(BoardKanban, { boardId: 'b1', workspaceId: 'ws', mentionables: mentionables as any, onOpenCard: () => {} }))
    const chip = await screen.findByTestId('board-card-pr-1533')
    expect(chip.textContent).toContain('#1533 · 1/3 checks · failing')
  })

  test('the column header shows and toggles the arming rule', async () => {
    routes['PATCH /api/boards/b1/columns/c1'] = (c) => ({ column: { ...columns[0], rules: c.body.rules }, board })
    render(createElement(BoardKanban, { boardId: 'b1', workspaceId: 'ws', mentionables: mentionables as any, onOpenCard: () => {} }))
    const toggle = await screen.findByTestId('board-column-arm-Triage')
    expect(toggle.getAttribute('aria-label')).toBe('Triage: auto-merge not allowed')
    fireEvent.click(toggle)
    await waitFor(() => expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ rules: { allowAutoMerge: true } }))
  })

  test('the card pane shows the PR state, its checks and the failing run', async () => {
    routes['GET /api/work-items/7'] = () => ({
      item: item('7', 'c2', 1, { pr: prBlock({ number: 1531, red: true, mergeableState: 'unstable', failing: [{ name: 'Lint, Typecheck, Test', url: 'https://github.com/shogo-labs/shogo-ai/runs/1' }], checks: { total: 2, passing: 1, failing: 1, pending: 0 } }) }),
      board: { id: 'b1', name: 'Shogo Dev', slug: 'shogo-dev', itemType: 'ticket', conversationId: null, fieldsSchema: [], columns },
      column: columns[1],
      url: 'https://x/work?card=7',
      following: false,
      recentMessages: [],
      links: [],
      agentRuns: [],
      events: [],
    })
    render(createElement(CardPane, { itemId: '7', workspaceId: 'ws', me: 'u1', mentionables: mentionables as any, visible: true, onClose: () => {} }))
    const section = await waitFor(() => {
      const el = document.querySelector('[data-rn-shim="card-pr"]')
      if (!el) throw new Error('no PR section')
      return el
    })
    expect(section.textContent).toContain('#1531 · shogo-labs/shogo-ai')
    expect(section.textContent).toContain('A required check is failing')
    expect(section.textContent).toContain('Lint, Typecheck, Test')
    expect(section.textContent).toContain('Synced')
  })

  test('an unlinked card offers to link a PR from its details', async () => {
    routes['GET /api/work-items/7'] = () => ({
      item: item('7', 'c2', 1),
      board: { id: 'b1', name: 'Shogo Dev', slug: 'shogo-dev', itemType: 'ticket', conversationId: null, fieldsSchema: [], columns },
      column: columns[1],
      url: 'https://x/work?card=7',
      following: false,
      recentMessages: [],
      links: [],
      agentRuns: [],
      events: [],
    })
    routes['POST /api/work-items/7/links'] = () => ({ link: { id: 'l1', kind: 'pr', refId: '1519' } })
    render(createElement(CardPane, { itemId: '7', workspaceId: 'ws', me: 'u1', mentionables: mentionables as any, visible: true, onClose: () => {} }))
    fireEvent.click(await screen.findByText('Details'))
    fireEvent.change(await screen.findByLabelText('Pull request URL'), { target: { value: 'https://github.com/shogo-labs/shogo-ai/pull/1519' } })
    fireEvent.click(screen.getByText('Link'))
    await waitFor(() => expect(calls.find((c) => c.method === 'POST')?.body).toEqual({
      kind: 'pr',
      refId: '1519',
      url: 'https://github.com/shogo-labs/shogo-ai/pull/1519',
      reason: 'manual',
    }))
  })
})
