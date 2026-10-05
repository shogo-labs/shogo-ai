// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, mock, test } from 'bun:test'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Fragment, createElement, createRef, forwardRef, useImperativeHandle } from 'react'
import { createReactNativeMock } from '../../../test/react-native-mock'

const sentTyping: string[] = []
const copied: string[] = []
const pins: Array<{ id: string; pinned: boolean }> = []
const uploaded: string[] = []
const updates: Array<{ id: string; patch: unknown }> = []
const decisions: Array<{ id: string; decision: string }> = []
let decisionError: string | null = null

mock.module('react-native', () =>
  createReactNativeMock({
    Platform: { OS: 'web', select: (s: any) => s.web ?? s.default },
    Pressable: ({ accessibilityLabel, children, onPress, onHoverIn, onHoverOut, onPointerEnter, onPointerLeave, onContextMenu, disabled, testID }: any) =>
      createElement(
        'div',
        {
          role: 'button', 'aria-label': accessibilityLabel, onClick: onPress, onMouseEnter: onHoverIn, onMouseLeave: onHoverOut,
          onPointerEnter, onPointerLeave, onContextMenu, disabled, 'data-testid': testID,
        },
        children,
      ),
    TextInput: forwardRef(function Input({ value, onChangeText, onSelectionChange, onKeyPress, placeholder, accessibilityLabel }: any, ref: any) {
      return createElement('textarea', {
        ref,
        value,
        placeholder,
        'aria-label': accessibilityLabel ?? placeholder,
        onChange: (e: any) => {
          onChangeText?.(e.target.value)
          const end = e.target.value.length
          onSelectionChange?.({ nativeEvent: { selection: { start: end, end } } })
        },
        onKeyDown: (e: any) => onKeyPress?.({ nativeEvent: { key: e.key, shiftKey: e.shiftKey }, preventDefault: () => e.preventDefault() }),
      })
    }),
    FlatList: forwardRef(function List({ data, renderItem, keyExtractor, ListEmptyComponent, ListFooterComponent }: any, ref: any) {
      useImperativeHandle(ref, () => ({ scrollToIndex() {}, scrollToOffset() {} }))
      return createElement(
        'div',
        null,
        data.length
          ? data.map((item: any, index: number) => createElement(Fragment, { key: keyExtractor ? keyExtractor(item, index) : index }, renderItem({ item, index })))
          : ListEmptyComponent,
        ListFooterComponent,
      )
    }),
  } as any),
)
mock.module('expo-clipboard', () => ({
  setStringAsync: async (text: string) => {
    copied.push(text)
    return true
  },
}))
mock.module('@shogo/shared-ui/primitives', () => ({ cn: (...a: unknown[]) => a.filter(Boolean).join(' ') }))
mock.module('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
  SafeAreaView: ({ children }: any) => createElement('div', null, children),
}))
const workLogs: string[] = []
let workLogResult: () => Promise<any> = async () => ({ parts: [{ type: 'text', text: 'Checking the remote.' }], startedAt: 0, completedAt: 1, toolCalls: 1 })
mock.module('../../chat/turns/PlanningStatusLine', () => ({ PlanningStatusLine: () => createElement('div', { 'data-rn-shim': 'planning' }, 'Planning') }))
mock.module('../../chat/turns/WorkGroup', () => ({
  WorkGroup: ({ items, isStreaming }: any) => createElement('div', { 'data-rn-shim': 'group' }, `${items.length}:${isStreaming}`),
}))
mock.module('../../chat/turns/WorkedForGroup', () => ({
  WorkedForGroup: ({ startedAt, completedAt, onToggle, isExpanded, children }: any) =>
    createElement('div', { 'data-rn-shim': 'worked-for' }, createElement('button', { onClick: onToggle }, `Worked ${completedAt - startedAt}`), isExpanded ? children : null),
}))
mock.module('../../chat/turns/AssistantContent', () => ({
  AssistantContent: ({ message, bare }: any) =>
    createElement('div', { 'data-rn-shim': 'log' }, `${bare ? 'bare:' : ''}${message.parts.map((p: any) => p.text ?? p.type).join('|')}`),
}))
mock.module('../../chat/MarkdownText', () => ({ MarkdownText: ({ children }: any) => createElement('p', null, children) }))
mock.module('../../../lib/team-chat-connection', () => ({
  useTeamChatEvents: () => 'closed',
  sendTyping: (_ws: string, conversationId: string) => sentTyping.push(conversationId),
}))
const muteCalls: Array<{ id: string; projectId: string | null; muted: boolean }> = []
mock.module('../../../lib/team-chat-api', () => ({
  absoluteApiUrl: (url: string) => url,
  newClientMsgId: () => 'client-msg-1',
  conversationTitle: () => 'DM',
  isAgentDm: (c: any) => c.kind === 'dm' && (c.participants ?? []).some((p: any) => p.type === 'agent'),
  teamChatApi: () => ({
    pin: async (id: string, pinned: boolean) => { pins.push({ id, pinned }) },
    workLog: (id: string) => { workLogs.push(id); return workLogResult() },
    upload: async (_id: string, file: { name: string }) => {
      uploaded.push(file.name)
      return { id: `att-${file.name}`, name: file.name, mimeType: 'text/plain', size: 1, width: null, height: null, url: '/f' }
    },
    update: async (id: string, patch: unknown) => {
      updates.push({ id, patch })
      return {}
    },
    decideApproval: async (id: string, decision: string) => {
      if (decisionError) throw Object.assign(new Error('failed'), { response: { data: { error: { message: decisionError } } } })
      decisions.push({ id, decision })
      return {}
    },
    agentCard: async (_ws: string, projectId: string | null) => ({
      projectId,
      name: 'Billing Bot',
      iconUrl: 'https://cdn.example.com/billing.png',
      role: 'Sends invoices',
      owner: { id: 'u-ana', name: 'Ana Lopez' },
      channels: [{ conversationId: 'c-eng', kind: 'public', name: 'eng', slug: 'eng', agentTrigger: 'auto', muted: false }],
    }),
    setAgentMuted: async (id: string, projectId: string | null, muted: boolean) => {
      muteCalls.push({ id, projectId, muted })
    },
  }),
}))
mock.module('../../../hooks/usePresence', () => ({ usePresence: () => null }))
mock.module('../../../hooks/useChatItems', () => ({
  useDraft: () => ({ stored: '', save: () => {} }),
  useIsSaved: () => false,
  toggleSaved: async () => {},
}))
mock.module('../../../hooks/useChatPrefs', () => ({
  useUserStatus: () => null,
}))
mock.module('../../../hooks/useCustomEmoji', () => ({
  useCustomEmoji: () => new Map(),
  customEmojiFor: () => null,
  jumboEmojiCodes: () => null,
}))
mock.module('../../../hooks/useChatShortcuts', () => ({
  useEditRequest: () => {},
}))
const { resolveAgentLook } = await import('@shogo/shared-app/buddy-look')
mock.module('../../../hooks/useTeamChat', () => ({
  useAgentLook: (_workspaceId: string | null | undefined, projectId: string | null) => resolveAgentLook(null, projectId),
}))
const routed: any[] = []
mock.module('expo-router', () => ({ useRouter: () => ({ push: (r: any) => routed.push(r) }) }))
// The real buddy draws on a canvas; here it just reports the look it was given.
mock.module('../../island/buddy/ShogoBuddy', () => ({
  ShogoBuddy: ({ look }: any) => createElement('div', { 'data-rn-shim': 'buddy', 'data-topper': look.topper, 'data-color': look.color }),
}))
// The composer is the shared ChatInput; stub its agent-only dependencies.
mock.module('@/components/ui/popover', () => ({
  Popover: ({ children, trigger }: any) => createElement(Fragment, null, trigger?.({}), children),
  PopoverBackdrop: () => null,
  PopoverContent: ({ children }: any) => createElement(Fragment, null, children),
}))
mock.module('../../../lib/platform-config', () => ({ usePlatformConfig: () => ({ features: { billing: false, ezMode: false } }) }))
mock.module('../../chat/useVoiceInput', () => ({
  useVoiceInput: () => ({ isBusy: false, isRecording: false, liveTranscript: '', canRecord: false, error: null, clearError() {}, toggleRecording: async () => {} }),
}))
mock.module('../../chat/VoiceWaveform', () => ({ VoiceWaveform: () => null }))
mock.module('../../chat/AttachSourceSheet', () => ({ AttachSourceSheet: () => null }))
mock.module('../../chat/ContextTracker', () => ({ ContextTracker: () => null, formatTokenCount: (n: number) => String(n) }))
mock.module('../../chat/ModelPickerMenu', () => ({ ModelPickerMenu: () => null, ComposerModelPicker: () => null, getNativeModelMenuWidth: () => 280 }))
mock.module('../../chat/FileViewerModal', () => ({ FileViewerModal: () => null }))
mock.module('../../chat/EnvironmentPicker', () => ({ EnvironmentPicker: () => null }))
mock.module('../../voice-mode/ChatBridgeContext', () => ({ useChatBridgeOptional: () => null }))
mock.module('../../chat/ChatContext', () => ({ useChatContextSafe: () => null }))
mock.module('../../../hooks/useWorkspaceExperience', () => ({ useWorkspaceExperience: () => ({ kind: 'team' }) }))

const { Composer } = await import('../Composer')
type ComposerHandle = import('../Composer').ComposerHandle
const { PhoneLayoutOverrideProvider } = await import('../../../lib/native-phone-layout')
const { MessageRow } = await import('../MessageRow')
const { MessageList } = await import('../MessageList')
const { ConversationHeader } = await import('../ConversationHeader')

const mentionables = {
  people: [
    { id: 'u-me', name: 'Me Myself', email: 'me@x.io', image: null, role: 'owner' },
    { id: 'u-ana', name: 'Ana Lopez', email: 'ana@x.io', image: null, role: 'member' },
  ],
  agents: [{ key: 'p:proj-1', projectId: 'proj-1', name: 'Billing Bot', description: null, image: null }],
}

/** Host views keep `testID` as `data-rn-shim`. */
function shim(id: string): HTMLElement | null {
  return document.querySelector(`[data-rn-shim="${id}"]`)
}

function shims(id: string): HTMLElement[] {
  return Array.from(document.querySelectorAll(`[data-rn-shim="${id}"]`))
}

function type(input: HTMLElement, value: string) {
  fireEvent.change(input, { target: { value } })
}

const composerInput = () => screen.getByLabelText('Message') as HTMLTextAreaElement

describe('Composer', () => {
  test('@ autocomplete inserts a mention that is sent as a wire token', async () => {
    const onSend = mock(async () => {})
    render(
      <Composer workspaceId="ws" conversationId="c1" placeholder="Message #general" mentionables={mentionables} me="u-me" onSend={onSend} />,
    )
    const input = composerInput()
    type(input, 'ask @bil')
    expect(screen.getByText('Billing Bot')).toBeTruthy()
    expect(screen.queryByText('Me Myself')).toBeNull()
    fireEvent.keyDown(input, { key: 'Enter' })
    expect((input as HTMLTextAreaElement).value).toBe('ask @Billing Bot ')

    type(input, 'ask @Billing Bot about @ana')
    fireEvent.keyDown(input, { key: 'Tab' })
    type(input, 'ask @Billing Bot about @Ana Lopez now')
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter' })
    })
    expect(onSend).toHaveBeenCalledWith({
      text: 'ask <@a:p:proj-1> about <@u:u-ana> now',
      attachmentIds: [],
      alsoSentToChannel: undefined,
    })
    expect((input as HTMLTextAreaElement).value).toBe('')
    expect(sentTyping).toContain('c1')
  })

  test('Escape dismisses suggestions; Shift+Enter does not send; threads offer "also send to channel"', async () => {
    const onSend = mock(async () => {})
    render(
      <Composer workspaceId="ws" conversationId="c1" threadRootId="root-1" placeholder="Reply" mentionables={mentionables} me="u-me" onSend={onSend} />,
    )
    const input = composerInput()
    type(input, '@an')
    expect(screen.getByText('Ana Lopez')).toBeTruthy()
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(screen.queryByText('Ana Lopez')).toBeNull()

    type(input, 'done')
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })
    expect(onSend).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText('Also send to channel'))
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter' })
    })
    expect(onSend).toHaveBeenCalledWith({ text: 'done', attachmentIds: [], alsoSentToChannel: true })
  })

  test('read-only conversations explain why instead of showing an input', () => {
    render(
      <Composer workspaceId="ws" conversationId="c1" placeholder="x" mentionables={null} me="u-me" disabled disabledReason="This channel is archived." onSend={() => {}} />,
    )
    expect(screen.getByText('This channel is archived.')).toBeTruthy()
    expect(screen.queryByLabelText('Message')).toBeNull()
  })

  test('agent-only controls stay out of team chat', () => {
    render(<Composer workspaceId="ws" conversationId="c1" placeholder="x" mentionables={mentionables} me="u-me" onSend={() => {}} />)
    expect(screen.queryByTestId('interaction-mode-trigger')).toBeNull()
    expect(screen.queryByLabelText('Advanced controls')).toBeNull()
  })
})

describe('Composer on a phone', () => {
  const renderPhone = (props: Partial<Parameters<typeof Composer>[0]> = {}) =>
    render(
      <PhoneLayoutOverrideProvider value>
        <Composer workspaceId="ws" conversationId="c1" placeholder="Message Ana" mentionables={mentionables} me="u-me" onSend={() => {}} {...props} />
      </PhoneLayoutOverrideProvider>,
    )

  test('uses the + menu instead of the desktop toolbar', () => {
    renderPhone()
    expect(screen.queryByLabelText('Attach file')).toBeNull()
    expect(screen.queryByLabelText('Emoji')).toBeNull()
    expect(screen.getByTestId('project-composer-plus')).toBeTruthy()
  })

  test('the desktop layout has the toolbar instead of the + menu', () => {
    render(<Composer workspaceId="ws" conversationId="c1" placeholder="x" mentionables={mentionables} me="u-me" onSend={() => {}} />)
    expect(screen.queryByTestId('project-composer-plus')).toBeNull()
    expect(screen.getByLabelText('Attach file')).toBeTruthy()
    expect(screen.getByLabelText('Emoji')).toBeTruthy()
  })

  test('Return adds a line; the send button sends', async () => {
    const onSend = mock(async () => {})
    renderPhone({ onSend })
    const input = composerInput()
    expect(screen.queryByLabelText('Send message')).toBeNull()
    type(input, 'on my way')
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onSend).not.toHaveBeenCalled()
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Send message'))
    })
    expect(onSend).toHaveBeenCalledWith({ text: 'on my way', attachmentIds: [], alsoSentToChannel: undefined })
  })

  test('thread replies toggle "also send to channel" from the + menu', async () => {
    const onSend = mock(async () => {})
    renderPhone({ threadRootId: 'root-1', onSend })
    type(composerInput(), 'done')
    fireEvent.click(screen.getByTestId('project-composer-plus'))
    fireEvent.click(screen.getByLabelText('Also send to channel'))
    expect(screen.getByText('Also sending to the channel')).toBeTruthy()
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Send message'))
    })
    expect(onSend).toHaveBeenCalledWith({ text: 'done', attachmentIds: [], alsoSentToChannel: true })
  })
})

function message(overrides: Record<string, unknown> = {}): any {
  return {
    id: 'm1', conversationId: 'c1', workspaceId: 'ws', seq: 1, threadRootId: null, replyCount: 0, lastReplyAt: null,
    alsoSentToChannel: false, authorType: 'user', author: { id: 'u-ana', name: 'Ana Lopez', image: null },
    authorUserId: 'u-ana', authorAgent: null, text: 'hi <@a:p:proj-1>', blocks: null, clientMsgId: null,
    agentSessionId: null, agentStatus: null, reactions: [], attachments: [], editedAt: null, deletedAt: null,
    createdAt: '2026-09-29T10:00:00.000Z', ...overrides,
  }
}

const names = { users: new Map([['u-ana', 'Ana Lopez']]), agents: new Map([['p:proj-1', 'Billing Bot']]) }
const handlers = () => ({
  onReact: mock(() => {}), onEdit: mock(async () => {}), onDelete: mock(() => {}), onStopAgent: mock(() => {}),
  onRetry: mock(() => {}), onDiscard: mock(() => {}), onReply: mock(() => {}), onOpenSession: mock(() => {}),
})

describe('MessageRow', () => {
  test('renders mentions by name, and a running agent reply streams with a Stop control', () => {
    const h = handlers()
    const { rerender } = render(<MessageRow message={message()} grouped={false} me="u-me" names={names} canManage={false} {...h} />)
    expect(screen.getByText('hi **@Billing Bot**')).toBeTruthy()

    const agentReply = message({
      id: 'm2', authorType: 'agent', author: null, authorUserId: null, authorAgent: { projectId: 'proj-1', name: 'Billing Bot' },
      text: '', agentStatus: 'running', agentSessionId: 's1', threadRootId: 'm1',
    })
    rerender(
      <MessageRow message={agentReply} grouped={false} me="u-me" names={names} canManage={false} inThread streaming={{ text: 'Checking invoices', tool: 'exec', tools: [{ name: 'exec', done: false }] }} {...h} />,
    )
    expect(screen.getByText('AGENT')).toBeTruthy()
    // A running agent shows its status; what it is writing appears once it is done.
    expect(screen.queryByText('Checking invoices')).toBeNull()
    expect(shim('group')!.textContent).toBe('1:true')
    fireEvent.click(screen.getByLabelText('Stop agent'))
    expect(h.onStopAgent).toHaveBeenCalled()
    expect(screen.queryByText('Open full session')).toBeNull()

    rerender(
      <MessageRow message={{ ...agentReply, agentStatus: 'done', text: 'All paid.' }} grouped={false} me="u-me" names={names} canManage={false} inThread {...h} />,
    )
    fireEvent.click(screen.getByText('Open full session'))
    expect(h.onOpenSession).toHaveBeenCalled()
  })

  test('tapping an agent opens its profile card with role, owner and channels', async () => {
    const h = handlers()
    const agentReply = message({
      id: 'm9', authorType: 'agent', author: null, authorUserId: null,
      authorAgent: { projectId: 'proj-1', name: 'Billing Bot', iconUrl: 'https://cdn.example.com/billing.png' },
      text: 'Invoice sent', agentStatus: 'done',
    })
    const { container } = render(<MessageRow message={agentReply} grouped={false} me="u-me" names={names} canManage={false} {...h} />)
    // A project agent shows its buddy, not its project's screenshot.
    expect(container.querySelector('img')).toBeNull()
    expect(shims('buddy').length).toBeGreaterThan(0)
    expect(screen.queryByTestId('agent-profile-card')).toBeNull()
    fireEvent.click(screen.getAllByLabelText('Billing Bot profile')[0])
    expect(await screen.findByText('Sends invoices')).toBeTruthy()
    expect(screen.getByText('Ana Lopez')).toBeTruthy()
    expect(screen.getByText('eng')).toBeTruthy()
    expect(screen.getByText('Replies when relevant')).toBeTruthy()
    fireEvent.click(screen.getByLabelText('Mute in eng'))
    expect(await screen.findByText('Muted')).toBeTruthy()
    expect(muteCalls).toEqual([{ id: 'c-eng', projectId: 'proj-1', muted: true }])
    fireEvent.click(screen.getByLabelText('Unmute in eng'))
    expect(await screen.findByText('Replies when relevant')).toBeTruthy()
    fireEvent.click(screen.getByLabelText('Close'))
    expect(screen.queryByText('Sends invoices')).toBeNull()
  })

  test('a finished reply shows "Worked for" above its closing message; one that ended on a tool shows only the fold', () => {
    const h = handlers()
    const work = { chatMessageId: 'cm1', startedAt: 1_000, completedAt: 66_000, toolCalls: 3 }
    const reply = message({
      id: 'm9', authorType: 'agent', author: null, authorUserId: null, authorAgent: { projectId: 'proj-1', name: 'Billing Bot' },
      text: 'PR #3 is merged.', agentStatus: 'done', agentSessionId: 's1', blocks: { work },
    })
    const { rerender } = render(<MessageRow message={reply} grouped={false} me="u-me" names={names} canManage={false} {...h} />)
    expect(shim('worked-for')!.textContent).toBe('Worked 65000')
    expect(screen.getByText('PR #3 is merged.')).toBeTruthy()
    expect(shim('group')).toBeNull()

    rerender(<MessageRow message={{ ...reply, text: '' }} grouped={false} me="u-me" names={names} canManage={false} {...h} />)
    expect(shim('worked-for')).toBeTruthy()
    expect(screen.queryByText('PR #3 is merged.')).toBeNull()

    rerender(<MessageRow message={{ ...reply, agentStatus: 'running', text: '' }} grouped={false} me="u-me" names={names} canManage={false} {...h} />)
    expect(shim('worked-for')).toBeNull()
    expect(shim('planning')).toBeTruthy()
  })

  test('failed sends offer retry and discard; threads show reply counts', () => {
    const h = handlers()
    const { rerender } = render(
      <MessageRow message={message({ pending: 'failed', clientMsgId: 'cm1', authorUserId: 'u-me' })} grouped={false} me="u-me" names={names} canManage={false} {...h} />,
    )
    fireEvent.click(screen.getByText('Retry'))
    expect(h.onRetry).toHaveBeenCalled()
    fireEvent.click(screen.getByText('Discard'))
    expect(h.onDiscard).toHaveBeenCalled()

    rerender(<MessageRow message={message({ replyCount: 3 })} grouped={false} me="u-me" names={names} canManage={false} {...h} />)
    fireEvent.click(screen.getByText('3 replies'))
    expect(h.onReply).toHaveBeenCalled()
  })

  test('#activity lines can be discussed in a thread', () => {
    const h = handlers()
    render(
      <MessageRow
        message={message({ authorType: 'system', author: null, authorUserId: null, text: '**Billing Bot** finished a task', blocks: { type: 'activity', kind: 'task.completed' }, replyCount: 1 })}
        grouped={false} me="u-me" names={names} canManage={false} {...h}
      />,
    )
    fireEvent.click(screen.getByText('1 reply'))
    expect(h.onReply).toHaveBeenCalledTimes(1)
  })

  test('copy link copies a link to the message; mark unread is offered outside threads', async () => {
    const h = { ...handlers(), onMarkUnread: mock(() => {}) }
    const { container } = render(
      <MessageRow message={message({ id: 'm7', seq: 7 })} grouped={false} me="u-me" names={names} canManage={false} {...h} />,
    )
    fireEvent.pointerEnter(container.querySelector('[role="button"]')!)
    fireEvent.click(screen.getByLabelText('More actions'))
    await act(async () => {
      fireEvent.click(screen.getByRole('menuitem', { name: 'Copy link' }))
    })
    expect(copied.at(-1)).toMatch(/\/c\/c1\?msg=m7$/)
    fireEvent.click(screen.getByLabelText('More actions'))
    expect(screen.getByRole('menuitem', { name: 'Link copied' })).toBeTruthy()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Mark unread' }))
    expect(h.onMarkUnread).toHaveBeenCalledTimes(1)

    cleanup()
    const thread = render(<MessageRow message={message({ id: 'r1', threadRootId: 'm7' })} grouped={false} me="u-me" names={names} canManage={false} inThread {...h} />)
    fireEvent.pointerEnter(thread.container.querySelector('[role="button"]')!)
    fireEvent.click(screen.getByLabelText('More actions'))
    expect(screen.queryByRole('menuitem', { name: 'Mark unread' })).toBeNull()
    await act(async () => {
      fireEvent.click(screen.getByRole('menuitem', { name: 'Copy link' }))
    })
    expect(copied.at(-1)).toMatch(/\/c\/c1\?thread=m7&msg=r1$/)
  })

  test('the bar keeps only the primary actions; the rest live in the More actions menu', () => {
    const h = handlers()
    const { container } = render(
      <MessageRow message={message({ authorUserId: 'u-me' })} grouped={false} me="u-me" names={names} canManage={false} canPin workspaceId="ws" {...h} />,
    )
    fireEvent.pointerEnter(container.querySelector('[role="button"]')!)
    for (const label of ['Copy link', 'Save for later', 'Pin to conversation', 'Edit message', 'Delete message', 'Remind me about this']) {
      expect(screen.queryByLabelText(label)).toBeNull()
    }
    expect(screen.queryByLabelText('More reactions')).toBeTruthy()
    fireEvent.click(screen.getByLabelText('More actions'))
    for (const name of ['Copy link', 'Save for later', 'Remind me: in 1 hour', 'Pin to conversation', 'Edit message', 'Delete message']) {
      expect(screen.getByRole('menuitem', { name })).toBeTruthy()
    }
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete message' }))
    expect(h.onDelete).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('menu')).toBeNull()
  })

  test('right-clicking a message opens the actions menu, with Delete only when permitted', () => {
    const h = handlers()
    const { container } = render(<MessageRow message={message()} grouped={false} me="u-me" names={names} canManage={false} canPin {...h} />)
    const row = container.querySelector('[role="button"]')!
    expect(fireEvent.contextMenu(row, { clientX: 40, clientY: 50 })).toBe(false) // default prevented
    expect(screen.getByRole('menu')).toBeTruthy()
    expect(screen.queryByRole('menuitem', { name: 'Delete message' })).toBeNull()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Pin to conversation' }))
    expect(pins.at(-1)).toEqual({ id: 'm1', pinned: true })
    expect(screen.queryByRole('menu')).toBeNull()
    cleanup()

    const mine = render(<MessageRow message={message({ authorUserId: 'u-me' })} grouped={false} me="u-me" names={names} canManage={false} {...h} />)
    fireEvent.contextMenu(mine.container.querySelector('[role="button"]')!)
    expect(screen.getByRole('menuitem', { name: 'Delete message' })).toBeTruthy()
    cleanup()

    const pending = render(<MessageRow message={message({ pending: 'sending' as any })} grouped={false} me="u-me" names={names} canManage={false} {...h} />)
    expect(fireEvent.contextMenu(pending.container.querySelector('[role="button"]')!)).toBe(true) // browser menu
    expect(screen.queryByRole('menu')).toBeNull()
  })

  test('the action bar survives the pointer moving onto it and its buttons, and goes after leaving', async () => {
    const { container } = render(<MessageRow message={message()} grouped={false} me="u-me" names={names} canManage={false} {...handlers()} />)
    const row = container.querySelector('[role="button"]')!
    fireEvent.pointerEnter(row)
    // Pressable's own hover would end the row's hover as soon as a nested Pressable is entered.
    fireEvent.mouseLeave(row)
    fireEvent.mouseEnter(screen.getByLabelText('More reactions'))
    fireEvent.mouseLeave(screen.getByLabelText('More reactions'))
    await new Promise((r) => setTimeout(r, 260))
    expect(screen.queryByLabelText('More reactions')).toBeTruthy()
    await act(async () => {
      fireEvent.pointerLeave(row)
      await new Promise((r) => setTimeout(r, 260))
    })
    expect(screen.queryByLabelText('More reactions')).toBeNull()
  })

  test('the bar stays while its menu is open, even after the pointer leaves the row', async () => {
    const { container } = render(<MessageRow message={message()} grouped={false} me="u-me" names={names} canManage={false} {...handlers()} />)
    const row = container.querySelector('[role="button"]')!
    fireEvent.pointerEnter(row)
    fireEvent.click(screen.getByLabelText('More actions'))
    await act(async () => {
      fireEvent.pointerLeave(row)
      await new Promise((r) => setTimeout(r, 260))
    })
    expect(screen.queryByLabelText('More reactions')).toBeTruthy()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(screen.queryByLabelText('More reactions')).toBeNull()
  })

  test('more reactions opens the searchable picker', () => {
    const h = handlers()
    const { container } = render(<MessageRow message={message()} grouped={false} me="u-me" names={names} canManage={false} workspaceId="ws" {...h} />)
    fireEvent.pointerEnter(container.querySelector('[role="button"]')!)
    fireEvent.click(screen.getByLabelText('More reactions'))
    fireEvent.change(screen.getByLabelText('Search emoji'), { target: { value: 'rocket' } })
    fireEvent.click(screen.getByLabelText('rocket'))
    expect(h.onReact).toHaveBeenCalledWith(expect.objectContaining({ id: 'm1' }), '🚀')
    expect(shim('emoji-picker')).toBeNull()
  })
})

describe('Composer emoji and files', () => {
  test(':shortcode suggests emoji, and a finished :code: becomes the emoji', () => {
    render(<Composer workspaceId="ws" conversationId="c1" placeholder="x" mentionables={mentionables} me="u-me" onSend={() => {}} />)
    const input = composerInput()
    type(input, 'ship it :tad')
    expect(shim('composer-completions-emoji')).toBeTruthy()
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(input.value).toBe('ship it 🎉 ')

    type(input, 'nice :+1:')
    expect(input.value).toBe('nice 👍')
    type(input, 'see :not_an_emoji_code:')
    expect(input.value).toBe('see :not_an_emoji_code:')
  })

  test('the emoji button opens a searchable picker that inserts at the cursor', () => {
    render(<Composer workspaceId="ws" conversationId="c1" placeholder="x" mentionables={mentionables} me="u-me" onSend={() => {}} />)
    const input = composerInput()
    type(input, 'launch')
    fireEvent.click(screen.getByLabelText('Emoji'))
    fireEvent.change(screen.getByLabelText('Search emoji'), { target: { value: 'rocket' } })
    fireEvent.click(screen.getByLabelText('rocket'))
    expect(input.value).toBe('launch 🚀 ')
    expect(shim('emoji-picker')).toBeNull()
  })

  test('dropped files are staged in the composer and uploaded when the message is sent', async () => {
    uploaded.length = 0
    const onSend = mock(async () => {})
    const ref = createRef<ComposerHandle>()
    render(<Composer ref={ref} workspaceId="ws" conversationId="c1" placeholder="x" mentionables={mentionables} me="u-me" onSend={onSend} />)
    await act(async () => {
      ref.current!.addFiles([new File(['notes'], 'notes.txt', { type: 'text/plain' })])
    })
    await waitFor(() => expect(screen.getByText('notes.txt')).toBeTruthy())
    expect(uploaded).toEqual([])

    const input = composerInput()
    type(input, 'see attached')
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter' })
    })
    await waitFor(() => expect(onSend).toHaveBeenCalledWith({ text: 'see attached', attachmentIds: ['att-notes.txt'], alsoSentToChannel: undefined }))
    expect(uploaded).toEqual(['notes.txt'])
  })
})

describe('MessageList unread line', () => {
  const timeline = (messages: any[]) => ({ messages, streaming: {}, hasMoreOlder: false }) as any
  const list = (props: Record<string, unknown>) => (
    <MessageList state={timeline([
      message({ id: 'a', seq: 1, text: 'read already' }),
      message({ id: 'b', seq: 2, text: 'mine after', authorUserId: 'u-me', author: { id: 'u-me', name: 'Me', image: null } }),
      message({ id: 'c', seq: 3, text: 'first new' }),
      message({ id: 'd', seq: 4, text: 'second new' }),
    ])} loading={false} me="u-me" names={names} canManage={false} {...handlers()} {...props} />
  )

  test('a "New" line sits above the first unread message from someone else', () => {
    const { container, rerender } = render(list({ unreadAfterSeq: 1 }))
    const line = shim('new-messages-line')!
    expect(line.parentElement?.textContent).toContain('first new')
    expect(line.parentElement?.textContent).not.toContain('mine after')
    expect(container.querySelectorAll('[data-rn-shim="new-messages-line"]').length).toBe(1)

    rerender(list({ unreadAfterSeq: null }))
    expect(shim('new-messages-line')).toBeNull()
    rerender(list({ unreadAfterSeq: 1, unreadUpToSeq: 2 }))
    expect(shim('new-messages-line')).toBeNull()
  })

  test('the linked message is highlighted', () => {
    render(list({ highlightId: 'd' }))
    expect(screen.getByTestId('message-highlighted').textContent).toContain('second new')
  })

  test('unread messages older than what is loaded offer a jump', () => {
    const onRevealUnread = mock(() => {})
    render(list({ unreadAfterSeq: 0, unreadNotLoaded: true, onRevealUnread }))
    fireEvent.click(screen.getByLabelText('Jump to first unread message'))
    expect(onRevealUnread).toHaveBeenCalledTimes(1)
  })
})

describe('agent message kinds', () => {
  const agentMsg = (id: string, seq: number, text: string, blocks: unknown, extra: Record<string, unknown> = {}) =>
    message({
      id, seq, text, blocks, authorType: 'agent', author: null, authorUserId: null, agentStatus: 'done',
      authorAgent: { projectId: 'proj-1', name: 'Builder' }, ...extra,
    })
  const timeline = (messages: any[]) => ({ messages, streaming: {}, hasMoreOlder: false }) as any

  test('a status card shows its steps, criteria, links and summary instead of markdown', () => {
    const card = {
      title: 'Fix invoice totals', status: 'working', step: 1, steps: ['Triage', 'Implement', 'Review'],
      criteria: ['Totals round to cents'], links: [{ label: 'PR #12', url: 'https://github.com/o/r/pull/12' }],
    }
    const { rerender } = render(
      <MessageRow message={agentMsg('k1', 1, '**Fix invoice totals**', { type: 'status_card', messageKind: 'status', card })} grouped={false} me="u-me" names={names} canManage={false} {...handlers()} />,
    )
    expect(shim('status-card')!).toBeTruthy()
    expect(screen.getByText('In progress')).toBeTruthy()
    expect(screen.getByText('Implement')).toBeTruthy()
    expect(screen.getByText('• Totals round to cents')).toBeTruthy()
    expect(screen.getByLabelText('PR #12')).toBeTruthy()
    expect(shims('status-step-done')).toHaveLength(1)
    expect(shims('status-step-current')).toHaveLength(1)
    expect(shims('status-step-pending')).toHaveLength(1)

    rerender(
      <MessageRow message={agentMsg('k1', 1, 'x', { type: 'status_card', messageKind: 'status', card: { ...card, status: 'done', summary: 'Merged after review.' } })} grouped={false} me="u-me" names={names} canManage={false} {...handlers()} />,
    )
    expect(screen.getByText('Done')).toBeTruthy()
    expect(shims('status-step-done')).toHaveLength(3)
    expect(shim('status-card-summary')!.textContent).toContain('Merged after review.')
  })

  test('decisions and alerts are flagged; plain results are not', () => {
    const { rerender } = render(
      <MessageRow message={agentMsg('d1', 1, 'Merge PR #12?', { messageKind: 'decision' })} grouped={false} me="u-me" names={names} canManage={false} {...handlers()} />,
    )
    expect(screen.getByText('NEEDS A DECISION')).toBeTruthy()
    rerender(<MessageRow message={agentMsg('d1', 1, 'Build is failing', { messageKind: 'alert' })} grouped={false} me="u-me" names={names} canManage={false} {...handlers()} />)
    expect(screen.getByText('ALERT')).toBeTruthy()
    rerender(<MessageRow message={agentMsg('d1', 1, 'Opened PR #12', { messageKind: 'result' })} grouped={false} me="u-me" names={names} canManage={false} {...handlers()} />)
    expect(screen.queryByText('ALERT')).toBeNull()
    expect(screen.queryByText('NEEDS A DECISION')).toBeNull()
  })

  test('an approval request offers Approve and Deny; the answer is sent and errors are shown', async () => {
    decisions.length = 0
    decisionError = null
    const approval = { requestId: 'perm-1', toolName: 'github_merge_pr', summary: 'Merge pull request #12 (squash)', reason: 'Merging is set to ask first', status: 'pending' }
    const blocks = (a: unknown) => ({ messageKind: 'decision', type: 'approval_request', approval: a })
    const { rerender } = render(
      <MessageRow message={agentMsg('a1', 1, 'Builder needs approval', blocks(approval))} grouped={false} me="u-me" names={names} canManage={false} {...handlers()} />,
    )
    expect(shim('approval-card')!).toBeTruthy()
    expect(screen.getByText('Merge pull request #12 (squash)')).toBeTruthy()
    expect(screen.getByText('NEEDS A DECISION')).toBeTruthy()

    decisionError = 'Already approved by Ada'
    await act(async () => { fireEvent.click(screen.getByLabelText('Approve')) })
    expect(shim('approval-error')!.textContent).toBe('Already approved by Ada')

    decisionError = null
    await act(async () => { fireEvent.click(screen.getByLabelText('Deny')) })
    expect(decisions).toEqual([{ id: 'a1', decision: 'deny' }])

    rerender(
      <MessageRow message={agentMsg('a1', 1, 'x', blocks({ ...approval, status: 'approved', decidedBy: { userId: 'u-ana', name: 'Ana' } }))} grouped={false} me="u-me" names={names} canManage={false} {...handlers()} />,
    )
    expect(shim('approval-outcome')!.textContent).toBe('Approved by Ana')
    expect(screen.queryByLabelText('Approve')).toBeNull()
    expect(screen.queryByText('NEEDS A DECISION')).toBeNull()

    rerender(
      <MessageRow message={agentMsg('a1', 1, 'x', blocks({ ...approval, status: 'expired' }))} grouped={false} me="u-me" names={names} canManage={false} {...handlers()} />,
    )
    expect(shim('approval-outcome')!.textContent).toBe('Not run: no answer in time')
  })

  test('a run of status posts folds into one row that expands to show each one', () => {
    render(
      <MessageList
        state={timeline([
          agentMsg('s1', 1, 'Reading the failing test', { messageKind: 'status' }),
          agentMsg('s2', 2, 'Found the rounding bug', { messageKind: 'status' }),
          agentMsg('s3', 3, 'Patch is written', { messageKind: 'status' }),
          agentMsg('r1', 4, 'Opened PR #12', { messageKind: 'result' }),
        ])}
        loading={false} me="u-me" names={names} canManage={false} {...handlers()}
      />,
    )
    expect(shims('status-run')).toHaveLength(1)
    expect(screen.getByText('Builder · 3 updates')).toBeTruthy()
    expect(screen.getByText('Patch is written')).toBeTruthy()
    expect(screen.queryByText('Reading the failing test')).toBeNull()
    expect(screen.getByText('Opened PR #12')).toBeTruthy()

    fireEvent.click(screen.getByLabelText('Builder: 3 updates'))
    expect(screen.getByText('Reading the failing test')).toBeTruthy()
    expect(screen.getByText('Found the rounding bug')).toBeTruthy()
  })

  test('the "New" line lands on a folded run when the first unread post is inside it', () => {
    render(
      <MessageList
        state={timeline([
          message({ id: 'p', seq: 1, text: 'read already' }),
          agentMsg('s1', 2, 'one', { messageKind: 'status' }),
          agentMsg('s2', 3, 'two', { messageKind: 'status' }),
        ])}
        loading={false} me="u-me" names={names} canManage={false} unreadAfterSeq={1} {...handlers()}
      />,
    )
    expect(shim('new-messages-line')!.parentElement?.textContent).toContain('2 updates')
  })
})

describe('ConversationHeader channel editing', () => {
  const channel = (overrides: Record<string, unknown> = {}): any => ({
    id: 'c9', workspaceId: 'ws', kind: 'public', name: 'design', slug: 'design', topic: null, lastSeq: 0, lastMessageAt: null,
    archivedAt: null, createdAt: '2026-09-29T10:00:00.000Z', joined: true, starred: false, muted: false, notifyLevel: 'default',
    lastReadSeq: 0, canPost: true, canReply: true, canManage: true, members: [], ...overrides,
  })

  test('owners rename the channel and set its topic', async () => {
    updates.length = 0
    const onChanged = mock(() => {})
    render(<ConversationHeader conversation={channel()} mentionables={null} me="u-me" onChanged={onChanged} onLeft={() => {}} />)
    fireEvent.click(screen.getByLabelText('Edit channel'))
    fireEvent.change(screen.getByLabelText('Channel name'), { target: { value: 'Release Notes' } })
    expect(screen.getByText('Will be saved as #release-notes')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Channel topic'), { target: { value: 'What shipped this week' } })
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Save channel'))
    })
    expect(updates).toEqual([{ id: 'c9', patch: { name: 'release-notes', topic: 'What shipped this week' } }])
    expect(onChanged).toHaveBeenCalled()
  })

  test('members who are not owners can only edit the topic', async () => {
    updates.length = 0
    render(<ConversationHeader conversation={channel({ canManage: false, topic: 'Old topic' })} mentionables={null} me="u-me" onChanged={() => {}} onLeft={() => {}} />)
    expect(screen.queryByLabelText('Edit channel')).toBeNull()
    fireEvent.click(screen.getByLabelText('Topic: Old topic. Edit topic'))
    expect(screen.queryByLabelText('Channel name')).toBeNull()
    fireEvent.change(screen.getByLabelText('Channel topic'), { target: { value: '' } })
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Save channel'))
    })
    expect(updates).toEqual([{ id: 'c9', patch: { topic: null } }])
  })

  test('the floating phone header goes back and keeps every action in its sheet', async () => {
    updates.length = 0
    const onBack = mock(() => {})
    render(
      <ConversationHeader
        conversation={channel({ members: [{ id: 'm1', type: 'user', userId: 'u-ana', name: 'Ana' }, { id: 'm2', type: 'user', userId: 'u-me', name: 'Me' }] })}
        mentionables={null}
        me="u-me"
        onChanged={() => {}}
        onLeft={() => {}}
        floating
        onBack={onBack}
      />,
    )
    expect(screen.getByText('2 members')).toBeTruthy()
    fireEvent.click(screen.getByLabelText('Back'))
    expect(onBack).toHaveBeenCalled()
    for (const label of ['Edit channel', 'Notification settings', 'Star', 'Pinned messages', 'Members', 'Leave channel', 'Archive']) {
      expect(screen.getByLabelText(label)).toBeTruthy()
    }
    expect(screen.getByLabelText('Catch me up')).toBeTruthy()
    fireEvent.click(screen.getByLabelText('Edit channel'))
    fireEvent.change(screen.getByLabelText('Channel topic'), { target: { value: 'Ship it' } })
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Save channel'))
    })
    expect(updates).toEqual([{ id: 'c9', patch: { topic: 'Ship it' } }])
  })
})

describe('agent work', () => {
  const work = { chatMessageId: 'cm1', startedAt: 0, completedAt: 65_000, toolCalls: 2 }
  const reply = () => message({
    id: 'm1', authorType: 'agent', author: null, authorUserId: null, authorAgent: { projectId: 'proj-1', name: 'Billing Bot' },
    text: 'Done.', agentStatus: 'done', agentSessionId: 's1', blocks: { work },
  })

  test('the work log is fetched only when the fold is opened, and shown without the closing text', async () => {
    workLogs.length = 0
    render(<MessageRow message={reply()} grouped={false} me="u-me" names={names} canManage={false} {...handlers()} />)
    expect(workLogs).toEqual([])
    fireEvent.click(screen.getByText('Worked 65000'))
    await waitFor(() => expect(screen.getByText('bare:Checking the remote.|')).toBeTruthy())
    expect(workLogs).toEqual(['m1'])
  })

  test('a log that cannot be loaded says so instead of spinning', async () => {
    workLogResult = async () => { throw new Error('nope') }
    render(<MessageRow message={reply()} grouped={false} me="u-me" names={names} canManage={false} {...handlers()} />)
    fireEvent.click(screen.getByText('Worked 65000'))
    await waitFor(() => expect(screen.getByText('The work log is not available.')).toBeTruthy())
    workLogResult = async () => ({ parts: [], startedAt: 0, completedAt: 1, toolCalls: 0 })
  })

  test('the running status opens the session the agent is working in', () => {
    const h = handlers()
    const running = { ...reply(), agentStatus: 'running', text: '' }
    render(<MessageRow message={running} grouped={false} me="u-me" names={names} canManage={false} {...h} />)
    fireEvent.click(screen.getByLabelText('Open the session this agent is working in'))
    expect(h.onOpenSession).toHaveBeenCalledWith(expect.objectContaining({ id: 'm1', agentSessionId: 's1' }))
  })

  test('before any tool runs the row says the agent is planning; once tools run it shows them', () => {
    const running = { ...reply(), agentStatus: 'running', text: '' }
    const { rerender } = render(<MessageRow message={running} grouped={false} me="u-me" names={names} canManage={false} {...handlers()} />)
    expect(shim('planning')).toBeTruthy()
    rerender(<MessageRow message={running} grouped={false} me="u-me" names={names} canManage={false} streaming={{ text: '', tool: 'exec', tools: [{ name: 'exec', done: false }] }} {...handlers()} />)
    expect(shim('group')).toBeTruthy()
  })
})

describe('agent avatars', () => {
  const agentReply = (projectId: string | null, extra: Record<string, unknown> = {}) =>
    message({
      id: `a-${projectId}`, authorType: 'agent', author: null, authorUserId: null,
      authorAgent: { projectId, name: 'Agent', ...extra }, text: 'hi', agentStatus: 'done',
    })

  test('agents get their own buddy instead of the robot icon, and different agents look different', () => {
    const h = handlers()
    const toppers: string[] = []
    for (const id of ['proj-a', 'proj-b', 'proj-c', 'proj-d', 'proj-e', 'proj-f']) {
      const { unmount } = render(<MessageRow message={agentReply(id)} grouped={false} me="u-me" names={names} canManage={false} {...h} />)
      const buddy = shims('buddy')[0]
      expect(buddy).toBeTruthy()
      toppers.push(`${buddy.getAttribute('data-topper')}:${buddy.getAttribute('data-color')}`)
      unmount()
    }
    expect(new Set(toppers).size).toBeGreaterThan(3)
  })

  test("the workspace agent's uploaded picture still wins over its buddy", () => {
    const { container } = render(
      <MessageRow message={agentReply(null, { iconUrl: 'https://cdn.example.com/shogo.png' })} grouped={false} me="u-me" names={names} canManage={false} {...handlers()} />,
    )
    expect(container.querySelector('img')).toBeTruthy()
    expect(shims('buddy')).toHaveLength(0)
  })
})

describe('agent profile links', () => {
  const tap = async (projectId: string | null, onOpenProjectPane?: any) => {
    const h = handlers()
    const reply = message({
      id: 'm-link', authorType: 'agent', author: null, authorUserId: null,
      authorAgent: { projectId, name: 'Billing Bot' }, text: 'hello', agentStatus: 'done',
    })
    render(<MessageRow message={reply} grouped={false} me="u-me" names={names} canManage={false} onOpenProjectPane={onOpenProjectPane} {...h} />)
    fireEvent.click(screen.getAllByLabelText('Billing Bot profile')[0])
    await screen.findByText('Sends invoices')
  }

  test('a project agent card links to its profile, project and the side panel', async () => {
    routed.length = 0
    const pane = mock(() => {})
    await tap('proj-1', pane)
    fireEvent.click(screen.getByLabelText('Open project'))
    expect(routed).toEqual([{ pathname: '/(app)/projects/[id]', params: { id: 'proj-1' } }])
    expect(screen.queryByTestId('agent-profile-card')).toBeNull()
    cleanup()

    routed.length = 0
    await tap('proj-1', pane)
    fireEvent.click(screen.getByLabelText('Side panel'))
    expect(pane).toHaveBeenCalledWith('proj-1', 'Billing Bot')
    cleanup()

    routed.length = 0
    await tap('proj-1', pane)
    fireEvent.click(screen.getByLabelText('View profile'))
    expect(routed).toEqual([{ pathname: '/(app)/agents/[key]', params: { key: 'proj-1' } }])
  })

  test('the side panel link is left out where there is no room, and the workspace agent has no project', async () => {
    await tap('proj-1')
    expect(screen.getByLabelText('Open project')).toBeTruthy()
    expect(screen.queryByLabelText('Side panel')).toBeNull()
    cleanup()

    routed.length = 0
    await tap(null, mock(() => {}))
    expect(screen.queryByLabelText('Open project')).toBeNull()
    expect(screen.queryByLabelText('Side panel')).toBeNull()
    fireEvent.click(screen.getByLabelText('View profile'))
    expect(routed).toEqual([{ pathname: '/(app)/agents/[key]', params: { key: 'ws' } }])
  })
})

describe('ConversationHeader agent DMs', () => {
  const dm = (projectId: string | null, overrides: Record<string, unknown> = {}): any => ({
    id: 'dm1', workspaceId: 'ws', kind: 'dm', name: null, slug: null, topic: null, lastSeq: 0, lastMessageAt: null,
    archivedAt: null, createdAt: '2026-09-29T10:00:00.000Z', joined: true, starred: false, muted: false, notifyLevel: 'default',
    lastReadSeq: 0, canPost: true, canReply: true, canManage: false,
    members: [
      { id: 'm1', type: 'user', userId: 'u-me', name: 'Me' },
      { id: 'm2', type: 'agent', projectId, name: 'Billing Bot', agentTrigger: 'mention' },
    ],
    ...overrides,
  })
  const header = (conversation: any, extra: Record<string, unknown> = {}) =>
    render(<ConversationHeader conversation={conversation} mentionables={null} me="u-me" onChanged={() => {}} onLeft={() => {}} {...extra} />)

  test('a project agent DM links to the profile and project, and the side panel when there is room', () => {
    routed.length = 0
    const pane = mock(() => {})
    header(dm('proj-1'), { onOpenProjectPane: pane })
    expect(shims('buddy').length).toBeGreaterThan(0)
    fireEvent.click(screen.getByLabelText('Open project'))
    fireEvent.click(screen.getByLabelText('View profile'))
    fireEvent.click(screen.getByLabelText('Show in side panel'))
    expect(routed).toEqual([
      { pathname: '/(app)/projects/[id]', params: { id: 'proj-1' } },
      { pathname: '/(app)/agents/[key]', params: { key: 'proj-1' } },
    ])
    expect(pane).toHaveBeenCalledWith('proj-1', 'Billing Bot')
  })

  test('no side panel action without a handler', () => {
    header(dm('proj-1'))
    expect(screen.getByLabelText('Open project')).toBeTruthy()
    expect(screen.queryByLabelText('Show in side panel')).toBeNull()
  })

  test('the workspace agent has a profile but no project; people DMs have neither', () => {
    header(dm(null), { onOpenProjectPane: mock(() => {}) })
    expect(screen.getByLabelText('View profile')).toBeTruthy()
    expect(screen.queryByLabelText('Open project')).toBeNull()
    expect(screen.queryByLabelText('Show in side panel')).toBeNull()
    cleanup()

    header(dm('proj-1', { members: [{ id: 'm1', type: 'user', userId: 'u-me', name: 'Me' }, { id: 'm3', type: 'user', userId: 'u-ana', name: 'Ana' }] }), { onOpenProjectPane: mock(() => {}) })
    expect(screen.queryByLabelText('View profile')).toBeNull()
    expect(screen.queryByLabelText('Open project')).toBeNull()
  })

  test('the phone header puts Open project beside Catch me up', () => {
    routed.length = 0
    header(dm('proj-1'), { floating: true, onBack: () => {} })
    fireEvent.click(screen.getAllByLabelText('Open project')[0])
    expect(routed).toEqual([{ pathname: '/(app)/projects/[id]', params: { id: 'proj-1' } }])
  })
})
