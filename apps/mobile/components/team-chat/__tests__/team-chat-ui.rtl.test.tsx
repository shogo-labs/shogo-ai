// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Fragment, createElement, createRef, forwardRef, useImperativeHandle, useRef } from 'react'
import { Linking } from 'react-native'
import { createReactNativeMock } from '../../../test/react-native-mock'

const sentTyping: string[] = []
const copied: string[] = []
const pins: Array<{ id: string; pinned: boolean }> = []
const reminders: Array<{ messageId: string; remindAt: string }> = []
const uploaded: string[] = []
const updates: Array<{ id: string; patch: unknown }> = []
const decisions: Array<{ id: string; decision: string }> = []
const sentWakes: string[] = []
const removedWakes: string[] = []
let decisionError: string | null = null
const deletes: string[] = []
let deleteError: string | null = null
/** The viewer's own Shogo buddy look, as the buddy-look context reports it. */
const personalLook = { color: '#FF7A8A', topper: 'cat-ears' }
/** What `useMentionables` answers; null until a test needs the workspace agent. */
const hookMentionables: { value: unknown } = { value: null }
/** Layout handlers the View shim captured, so a test can report a width. */
const layoutHandlers = new WeakMap<Element, (event: unknown) => void>()
/** Image load handlers the Image shim captured, so a test can report a size. */
const imageLoadHandlers = new WeakMap<Element, (event: unknown) => void>()
/** `Image.getSize` requests, so a test can answer the way web measures an image. */
const imageGetSizeRequests: { uri: string; success: (width: number, height: number) => void }[] = []

mock.module('react-native', () =>
  createReactNativeMock({
    Platform: { OS: 'web', select: (s: any) => s.web ?? s.default },
    // onLayout is not a DOM event, so the shim keeps the handler and a test
    // reports a width the way a real layout pass would. Everything else about
    // a View is the shared passthrough shim.
    View: forwardRef(function LayoutView({ children, onLayout, testID, style, ...props }: any, ref: any) {
      return createElement(
        'div',
        {
          ...props,
          style: Array.isArray(style) ? Object.assign({}, ...style.filter(Boolean)) : style,
          'data-rn-shim': testID ?? undefined,
          ref: (node: any) => {
            if (node && onLayout) layoutHandlers.set(node, onLayout)
            if (typeof ref === 'function') ref(node)
            else if (ref) ref.current = node
          },
        },
        children,
      )
    }),
    // An <img> as the shared shim renders it, plus a handle on `onLoad` so a
    // test can report the natural size an attachment did not store.
    Image: (() => {
      const shim = forwardRef(function LayoutImage({ children, style, onLoad, ...props }: any, ref: any) {
        return createElement(
          'img',
          {
            ...props,
            style: Array.isArray(style) ? Object.assign({}, ...style.filter(Boolean)) : style,
            'data-rn-shim': props.testID ?? undefined,
            ref: (node: any) => {
              if (node && onLoad) imageLoadHandlers.set(node, onLoad)
              if (typeof ref === 'function') ref(node)
              else if (ref) ref.current = node
            },
          },
          children,
        )
      })
      // On web the load event carries no size, so this is what measures the
      // image; a test answers it the way react-native-web would.
      ;(shim as any).getSize = (uri: string, success: (width: number, height: number) => void) => {
        imageGetSizeRequests.push({ uri, success })
      }
      return shim
    })(),
    // A press goes to the innermost Pressable only, as in React Native — not
    // on to a modal's backdrop that closes it.
    Pressable: ({ accessibilityLabel, children, onPress, onHoverIn, onHoverOut, onPointerEnter, onPointerLeave, onContextMenu, disabled, testID }: any) =>
      createElement(
        'div',
        {
          role: 'button', 'aria-label': accessibilityLabel, onMouseEnter: onHoverIn, onMouseLeave: onHoverOut,
          onClick: (e: any) => {
            e.stopPropagation()
            onPress?.(e)
          },
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
      // The list's own scroll node, as react-native-web reports it — where its
      // native `wheel` listener lives.
      const scroller = useRef<HTMLDivElement | null>(null)
      useImperativeHandle(ref, () => ({
        scrollToIndex() {},
        scrollToOffset() {},
        getScrollableNode: () => scroller.current,
      }))
      return createElement(
        'div',
        { ref: scroller, 'data-scroll-node': 'true' },
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
  isSelfDm: (c: any) => c.kind === 'dm' && (c.participants ?? []).some((p: any) => p.type === 'user' && p.self === true),
  teamChatApi: () => ({
    pin: async (id: string, pinned: boolean) => { pins.push({ id, pinned }) },
    createReminder: async (_ws: string, input: { messageId: string; remindAt: string }) => {
      reminders.push({ messageId: input.messageId, remindAt: input.remindAt })
      return {}
    },
    workLog: (id: string) => { workLogs.push(id); return workLogResult() },
    upload: async (_id: string, file: { name: string }) => {
      uploaded.push(file.name)
      return { id: `att-${file.name}`, name: file.name, mimeType: 'text/plain', size: 1, width: null, height: null, url: '/f' }
    },
    update: async (id: string, patch: unknown) => {
      updates.push({ id, patch })
      return {}
    },
    delete: async (id: string) => {
      if (deleteError) throw new Error(deleteError)
      deletes.push(id)
    },
    sendWakeNow: async (id: string) => {
      sentWakes.push(id)
    },
    removeWake: async (id: string) => {
      removedWakes.push(id)
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
      model: projectId ? { id: '11111111-1111-4111-8111-111111111111', label: 'Claude Sonnet 4.6' } : { id: 'auto', label: 'Auto' },
      owner: { id: 'u-ana', name: 'Ana Lopez' },
      channels: [{ conversationId: 'c-eng', kind: 'public', name: 'eng', slug: 'eng', agentTrigger: 'auto', muted: false }],
    }),
    setAgentMuted: async (id: string, projectId: string | null, muted: boolean) => {
      muteCalls.push({ id, projectId, muted })
    },
  }),
}))
mock.module('../../../hooks/usePresence', () => ({ usePresence: () => null, useInHuddle: () => false }))
mock.module('../../../hooks/useChatItems', () => ({
  useDraft: () => ({ stored: '', save: () => {} }),
  useIsSaved: () => false,
  toggleSaved: async () => {},
}))
mock.module('../../../hooks/useChatPrefs', () => ({
  useUserStatus: () => null,
}))
/** What `jumboEmojiCodes` reports, and the bodies it was asked about. */
const jumboCodes: { value: string[] | null; asked: string[] } = { value: null, asked: [] }
mock.module('../../../hooks/useCustomEmoji', () => ({
  useCustomEmoji: () => new Map(),
  customEmojiFor: () => null,
  jumboEmojiCodes: (text: string) => {
    jumboCodes.asked.push(text)
    return jumboCodes.value
  },
}))
mock.module('../../../hooks/useChatShortcuts', () => ({
  useEditRequest: () => {},
  requestEditMessage: () => {},
}))
const activityTimeline: { messages: any[]; channels: any[] } = { messages: [], channels: [] }
/** People typing in the pane's scope; a running agent is the dock's business. */
const typingUsers: Array<{ id: string; name: string }> = []
/** Replies a pane asked the server to stop. */
const stoppedAgents: string[] = []
const { resolveAgentLook } = await import('@shogo/shared-app/buddy-look')
mock.module('../../../hooks/useTeamChat', () => ({
  TIMELINE_SOFT_LIMIT: 600,
  useAgentLook: (_workspaceId: string | null | undefined, projectId: string | null) => resolveAgentLook(null, projectId),
  useConversationList: () => ({ list: activityTimeline.channels, loading: false, error: null, refresh: async () => {} }),
  useChannelDirectory: () => activityTimeline.channels,
  useConversationTimeline: () => ({
    state: { messages: activityTimeline.messages, hasMoreOlder: false, streaming: {} },
    loading: false,
    error: null,
    getState: () => ({ messages: activityTimeline.messages, hasMoreOlder: false, streaming: {} }),
    loadOlder: async () => {},
    react: async () => {},
    edit: () => {},
    remove: async () => {},
    stopAgent: async (id: string) => { stoppedAgents.push(id) },
    retry: () => {},
    discard: () => {},
    send: async () => {},
    reload: async () => {},
    trimOld: () => {},
  }),
  useMarkReadWhileVisible: () => {},
  useTypingUsers: () => typingUsers,
  useMentionables: () => hookMentionables.value,
}))
const routed: any[] = []
mock.module('expo-router', () => ({ useRouter: () => ({ push: (r: any) => routed.push(r) }) }))
// The real buddy draws on a canvas; here it just reports the look it was given.
mock.module('../../island/buddy/ShogoBuddy', () => ({
  ShogoBuddy: ({ look }: any) => createElement('div', { 'data-rn-shim': 'buddy', 'data-topper': look.topper, 'data-color': look.color }),
}))
// The viewer's own Shogo, as the account-level buddy-look context holds it.
mock.module('../../../contexts/buddy-look', () => ({
  useBuddyLook: () => ({ look: personalLook, setLook: () => {}, saving: false, error: '' }),
}))
// The composer is the shared ChatInput; stub its agent-only dependencies.
mock.module('@/components/ui/popover', () => ({
  Popover: ({ children, trigger }: any) => createElement(Fragment, null, trigger?.({}), children),
  PopoverBackdrop: () => null,
  PopoverContent: ({ children }: any) => createElement(Fragment, null, children),
}))
// The add-to-channel confirmation hosts gluestack dialog chrome, which pulls in
// react-native's real entrypoint. These cases are about the flow around it.
mock.module('@/components/ui/alert-dialog', () => ({
  AlertDialog: ({ children }: any) => createElement(Fragment, null, children),
  AlertDialogBackdrop: () => null,
  AlertDialogContent: ({ children }: any) => createElement(Fragment, null, children),
  AlertDialogHeader: ({ children }: any) => createElement(Fragment, null, children),
  AlertDialogBody: ({ children }: any) => createElement(Fragment, null, children),
  AlertDialogFooter: ({ children }: any) => createElement(Fragment, null, children),
}))
mock.module('@/components/ui/heading', () => ({ Heading: ({ children }: any) => createElement('div', null, children) }))
mock.module('@/components/ui/text', () => ({ Text: ({ children }: any) => createElement('div', null, children) }))
mock.module('@/components/ui/button', () => ({
  Button: ({ children, onPress, accessibilityLabel }: any) =>
    createElement('div', { role: 'button', 'aria-label': accessibilityLabel, onClick: onPress }, children),
  ButtonText: ({ children }: any) => createElement('div', null, children),
}))
mock.module('../../../lib/platform-config', () => ({ usePlatformConfig: () => ({ features: { billing: false, ezMode: false } }) }))
// Dictation is unavailable in a DOM test, so `canRecord` is a switch: it is how
// the composer's two voice affordances are told apart.
const voiceInputState = { canRecord: false }
mock.module('../../chat/useVoiceInput', () => ({
  useVoiceInput: () => ({ isBusy: false, isRecording: false, liveTranscript: '', canRecord: voiceInputState.canRecord, error: null, clearError() {}, toggleRecording: async () => {} }),
}))
// A voice note records through MediaRecorder on a device; the recorder here is a
// switch so the composer's trigger can be observed.
const recorderState = {
  isRecording: false,
  level: 0,
  elapsedMs: 0,
  start: mock(async () => {}),
  stop: mock(async () => null),
  cancel: mock(() => {}),
}
mock.module('../../../lib/use-voice-note', () => ({ useVoiceNoteRecorder: () => recorderState }))
mock.module('../../chat/VoiceWaveform', () => ({ VoiceWaveform: () => null }))
mock.module('../../chat/AttachSourceSheet', () => ({ AttachSourceSheet: () => null }))
mock.module('../../chat/ContextTracker', () => ({ ContextTracker: () => null, formatTokenCount: (n: number) => String(n) }))
mock.module('../../chat/ModelPickerMenu', () => ({ ModelPickerMenu: () => null, ComposerModelPicker: () => null, getNativeModelMenuWidth: () => 280 }))
mock.module('../../chat/FileViewerModal', () => ({ FileViewerModal: () => null }))
// The real viewer pulls in gesture-handler + glustack Portal; probe its props
// instead so these assert the wiring, not the modal's internals.
mock.module('../../chat/ImagePreviewModal', () => ({
  ImagePreviewModal: ({ visible, url, gallery, initialIndex, title, onClose }: any) =>
    visible
      ? createElement(
          'div',
          {
            role: 'dialog',
            'data-testid': 'image-lightbox',
            'data-url': url,
            'data-index': String(initialIndex),
            'data-count': String(gallery?.length ?? 0),
            'data-title': title,
          },
          createElement('button', { 'aria-label': 'Close lightbox', onClick: onClose }),
        )
      : null,
}))
mock.module('../../chat/EnvironmentPicker', () => ({ EnvironmentPicker: () => null }))
mock.module('../../voice-mode/ChatBridgeContext', () => ({ useChatBridgeOptional: () => null }))
mock.module('../../chat/ChatContext', () => ({ useChatContextSafe: () => null }))
mock.module('../../../hooks/useWorkspaceExperience', () => ({ useWorkspaceExperience: () => ({ kind: 'team' }) }))
// A voice note records and plays through expo-audio on a device; this is a DOM test.
mock.module('expo-audio', () => ({
  RecordingPresets: { LOW_QUALITY: {}, HIGH_QUALITY: {} },
  requestRecordingPermissionsAsync: async () => ({ granted: false }),
  setAudioModeAsync: async () => {},
  useAudioRecorder: () => ({
    prepareToRecordAsync: async () => {},
    record: () => {},
    stop: async () => {},
    getStatus: () => ({ durationMillis: 0, metering: -160, isRecording: false }),
    currentTime: 0,
    uri: null,
  }),
  useAudioRecorderState: () => ({ isRecording: false, durationMillis: 0, metering: -160 }),
  createAudioPlayer: () => ({
    addListener: () => ({ remove: () => {} }),
    replace: () => {},
    play: () => {},
    pause: () => {},
    seekTo: async () => {},
    setPlaybackRate: () => {},
    remove: () => {},
  }),
}))

const { Composer } = await import('../Composer')
type ComposerHandle = import('../Composer').ComposerHandle
const { PhoneLayoutOverrideProvider } = await import('../../../lib/native-phone-layout')
const { MessageRow } = await import('../MessageRow')
const { MessageList } = await import('../MessageList')
const { ConversationHeader, splitHeaderActions } = await import('../ConversationHeader')
const { TimelinePane } = await import('../TimelinePane')

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
    expect(screen.queryByLabelText('Advanced controls')).toBeNull()
    expect(screen.queryByTestId('ez-mode-toggle')).toBeNull()
  })

  // The mic used to record a voice note here, which made it the only composer in
  // the product where it didn't dictate. The two affordances are now distinct:
  // the mic dictates, the clip button on the left records.
  test('the mic dictates and the clip button on the left records a voice note', () => {
    voiceInputState.canRecord = true
    try {
      render(<Composer workspaceId="ws" conversationId="c1" placeholder="x" mentionables={mentionables} me="u-me" onSend={() => {}} />)
      expect(screen.getByLabelText('Start voice recording')).toBeTruthy()
      expect(screen.getByLabelText('Record a voice note')).toBeTruthy()
    } finally {
      voiceInputState.canRecord = false
    }
  })

  test('where dictation is unsupported the mic explains itself instead of vanishing', () => {
    render(<Composer workspaceId="ws" conversationId="c1" placeholder="x" mentionables={mentionables} me="u-me" onSend={() => {}} />)
    expect(
      screen.getByLabelText("Voice typing isn't supported in this browser. Try Chrome, Edge, or Safari."),
    ).toBeTruthy()
  })

  test('the clip button starts a recording, which replaces the composer', () => {
    const start = mock(async () => {})
    recorderState.start = start
    render(<Composer workspaceId="ws" conversationId="c1" placeholder="x" mentionables={mentionables} me="u-me" onSend={() => {}} />)
    fireEvent.click(screen.getByLabelText('Record a voice note'))
    expect(start).toHaveBeenCalled()
  })

  test('while a voice note records the recording bar stands in for the composer', () => {
    recorderState.isRecording = true
    try {
      render(<Composer workspaceId="ws" conversationId="c1" placeholder="x" mentionables={mentionables} me="u-me" onSend={() => {}} />)
      expect(screen.getByLabelText('Finish recording')).toBeTruthy()
      expect(screen.queryByLabelText('Message')).toBeNull()
    } finally {
      recorderState.isRecording = false
    }
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

/** Members beyond the one reactor the `names` fixture names, for the "who reacted" cases. */
const reactors = {
  users: new Map([['u-ana', 'Ana Lopez'], ['u-bob', 'Bob Chen'], ['u-cid', 'Cid Rao'], ['u-dee', 'Dee Park']]),
  agents: new Map<string, string>(),
}
const handlers = () => ({
  onReact: mock(() => {}), onEdit: mock(async () => {}), onDelete: mock(() => {}),
  onRetry: mock(() => {}), onDiscard: mock(() => {}), onReply: mock(() => {}), onOpenSession: mock(() => {}),
})

describe('MessageRow', () => {
  test('an emoji-only message renders large, the way Slack draws it', () => {
    jumboCodes.value = ['🤗']
    jumboCodes.asked = []
    render(<MessageRow message={message({ text: '🤗' })} grouped={false} me="u-me" names={names} canManage={false} {...handlers()} />)

    // The row hands the body to the jumbo check rather than straight to markdown.
    expect(jumboCodes.asked).toContain('🤗')
    expect(document.querySelector('[data-rn-shim="jumbo-emoji"]')).toBeTruthy()

    // Body text is 12px on desktop web; a jumbo glyph must dwarf it.
    const glyph = screen.getByText('🤗')
    expect(Number.parseFloat(glyph.style.fontSize)).toBeGreaterThan(24)
    // A line height is set, or tall glyphs clip on Android.
    expect(glyph.style.lineHeight).toBeTruthy()
  })

  test('an emoji sitting next to text keeps the body size', () => {
    jumboCodes.value = null
    render(<MessageRow message={message({ text: '🤗 support team has no input there' })} grouped={false} me="u-me" names={names} canManage={false} {...handlers()} />)

    expect(document.querySelector('[data-rn-shim="jumbo-emoji"]')).toBeNull()
    expect(screen.getByText(/support team has no input there/)).toBeTruthy()
  })

  test('renders mentions by name, and a running agent reply is a one-line marker', () => {
    const h = handlers()
    const { rerender } = render(<MessageRow message={message()} grouped={false} me="u-me" names={names} canManage={false} {...h} />)
    expect(screen.getByText('@Billing Bot')).toBeTruthy()
    expect(screen.getByText(/hi/)).toBeTruthy()
    expect(document.body.textContent).not.toContain('**')

    const agentReply = message({
      id: 'm2', authorType: 'agent', author: null, authorUserId: null, authorAgent: { projectId: 'proj-1', name: 'Billing Bot' },
      text: '', agentStatus: 'running', agentSessionId: 's1', threadRootId: 'm1',
    })
    rerender(
      <MessageRow message={agentReply} grouped={false} me="u-me" names={names} canManage={false} inThread streaming={{ text: 'Checking invoices', tool: 'exec', tools: [{ name: 'exec', done: false }] }} {...h} />,
    )
    expect(screen.getByText('AGENT')).toBeTruthy()
    // Nothing it is writing or doing shows in the row while it runs: the dock
    // above the composer carries that, and the row keeps its place.
    expect(screen.queryByText('Checking invoices')).toBeNull()
    expect(shim('running-reply-marker')!.textContent).toBe('Replying…')
    expect(shim('group')).toBeNull()
    expect(shim('agent-working-status')).toBeNull()
    expect(document.querySelector('[data-rn-shim="planning"]')).toBeNull()
    expect(screen.queryByLabelText('Stop agent')).toBeNull()
    expect(screen.queryByLabelText('Open the session this agent is working in')).toBeNull()
    expect(screen.queryByText('Open full session')).toBeNull()

    rerender(
      <MessageRow message={{ ...agentReply, agentStatus: 'done', text: 'All paid.' }} grouped={false} me="u-me" names={names} canManage={false} inThread {...h} />,
    )
    expect(shim('running-reply-marker')).toBeNull()
    expect(screen.getByText('All paid.')).toBeTruthy()
    fireEvent.click(screen.getByText('Open full session'))
    expect(h.onOpenSession).toHaveBeenCalled()
  })

  test('a grouped running reply is just the marker, with no controls line of its own', () => {
    const h = handlers()
    const running = message({
      id: 'm5', authorType: 'agent', author: null, authorUserId: null,
      authorAgent: { projectId: 'proj-1', name: 'Billing Bot' },
      text: '', agentStatus: 'running', agentSessionId: 's1', threadRootId: 'm1',
    })
    render(
      <MessageRow message={running} grouped me="u-me" names={names} canManage={false} inThread streaming={{ text: '', tool: 'exec' }} {...h} />,
    )
    // Grouped means no header at all, so the dock row is the only handle.
    expect(screen.queryByText('Billing Bot')).toBeNull()
    expect(shim('running-reply-marker')!.textContent).toBe('Replying…')
    expect(screen.queryByLabelText('Stop agent')).toBeNull()
    expect(screen.queryByLabelText('Open the session this agent is working in')).toBeNull()
  })

  test('a running reply with no session still offers no buttons in the row', () => {
    const h = handlers()
    const running = message({
      id: 'm6', authorType: 'agent', author: null, authorUserId: null,
      authorAgent: { projectId: 'proj-1', name: 'Billing Bot' },
      text: '', agentStatus: 'running', agentSessionId: null, threadRootId: 'm1',
    })
    render(<MessageRow message={running} grouped={false} me="u-me" names={names} canManage={false} inThread {...h} />)
    expect(shim('running-reply-marker')).toBeTruthy()
    expect(screen.queryByLabelText('Stop agent')).toBeNull()
    expect(screen.queryByLabelText('Open the session this agent is working in')).toBeNull()
  })

  test('an agent reply uses the project chat markdown renderer', () => {
    const { container } = render(
      <MessageRow
        message={message({
          id: 'md',
          authorType: 'agent',
          author: null,
          authorUserId: null,
          authorAgent: { projectId: 'proj-1', name: 'Billing Bot' },
          text: '## Title\n\n**done**',
          agentStatus: 'done',
        })}
        grouped={false}
        me="u-me"
        names={names}
        canManage={false}
        {...handlers()}
      />,
    )
    const markdown = container.querySelector('.chat-md')
    expect(markdown).not.toBeNull()
    expect(markdown?.className).toContain('text-foreground')
    expect(markdown?.className).toContain('text-xs')
    expect(markdown?.className).toContain('prose-sm')
    expect(markdown?.textContent).toContain('Title')
    expect(markdown?.textContent).toContain('done')
    expect(markdown?.textContent).not.toContain('##')
    expect(markdown?.textContent).not.toContain('**')
  })

  test('tapping an agent opens its profile card with role, model, owner and channels', async () => {
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
    expect(screen.getByText('Model')).toBeTruthy()
    expect(screen.getByText('Claude Sonnet 4.6')).toBeTruthy()
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
    expect(shim('planning')).toBeNull()
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

  test('#activity lines show what happened and open the real source', () => {
    const h = handlers()
    routed.length = 0
    const { rerender } = render(
      <MessageRow
        message={message({
          authorType: 'system', author: null, authorUserId: null,
          text: '**Billing Bot** finished a task',
          blocks: { type: 'activity', kind: 'task.completed', projectId: 'p1', chatSessionId: 's1', preview: '3 invoices overdue', summary: 'Reconciled three overdue invoices.' },
          replyCount: 1,
        })}
        grouped={false} me="u-me" names={names} canManage={false} {...h}
      />,
    )
    expect(screen.getByText('Reconciled three overdue invoices.')).toBeTruthy()
    expect(screen.queryByText('3 invoices overdue')).toBeNull()
    fireEvent.click(screen.getByLabelText('Open activity'))
    expect(routed.at(-1)).toEqual({ pathname: '/(app)/projects/[id]', params: { id: 'p1', chatSessionId: 's1' } })
    fireEvent.click(screen.getByText('1 reply'))
    expect(h.onReply).toHaveBeenCalledTimes(1)

    rerender(
      <MessageRow
        message={message({
          authorType: 'system', author: null, authorUserId: null,
          text: '**Billing Bot** sent a message in #eng',
          blocks: { type: 'activity', kind: 'agent.message', conversationId: 'c9', messageId: 'm9', threadRootId: 'root', preview: 'Three are overdue.' },
        })}
        grouped={false} me="u-me" names={names} canManage={false} {...h}
      />,
    )
    expect(screen.getByText('Three are overdue.')).toBeTruthy()
    fireEvent.click(screen.getByLabelText('Open activity'))
    expect(routed.at(-1)).toEqual({
      pathname: '/(app)/c/[conversationId]',
      params: { conversationId: 'c9', msg: 'm9', thread: 'root' },
    })
  })

  test('a membership line reads as a compact record, with no author row', () => {
    const { container } = render(
      <MessageRow
        message={message({
          authorType: 'system', author: null, authorUserId: null,
          text: 'Swastik Ranjan was added to 🔒 client-itau-col by Eby.',
          blocks: { type: 'membership', addedUserIds: ['u-2'], addedById: 'u-1' },
        })}
        grouped={false} me="u-me" names={names} canManage={false} {...handlers()}
      />,
    )
    const line = 'Swastik Ranjan was added to 🔒 client-itau-col by Eby.'
    expect(screen.getByText(line)).toBeTruthy()
    const row = container.querySelector('[accessibilitylabel]')
    expect(row?.getAttribute('accessibilitylabel')).toBe(`Channel update: ${line}`)
    // A record of what happened, not a message from Shogo.
    expect(screen.queryByText('Shogo')).toBeNull()
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
    for (const name of ['Copy link', 'Copy message', 'Save for later', 'Add a reminder', 'Pin to conversation', 'Edit message', 'Delete message']) {
      expect(screen.getByRole('menuitem', { name })).toBeTruthy()
    }
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete message' }))
    expect(h.onDelete).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('menu')).toBeNull()
  })

  test('reminders are one row with a flyout, not four flat menu rows', async () => {
    reminders.length = 0
    const { container } = render(
      <MessageRow message={message()} grouped={false} me="u-me" names={names} canManage={false} workspaceId="ws" {...handlers()} />,
    )
    fireEvent.pointerEnter(container.querySelector('[role="button"]')!)
    fireEvent.click(screen.getByLabelText('More actions'))
    // The four choices belong to one action, so they are not four menu rows.
    expect(screen.queryByRole('menuitem', { name: 'Remind me: in 1 hour' })).toBeNull()
    expect(screen.queryByRole('menuitem', { name: 'In 1 hour' })).toBeNull()

    fireEvent.click(screen.getByRole('menuitem', { name: 'Add a reminder' }))
    // The parent row only toggles the flyout: the menu stays open, no reminder yet.
    expect(screen.getAllByRole('menu')).toHaveLength(2) // the menu plus its flyout
    expect(screen.getByRole('menuitem', { name: 'In 1 hour' })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: 'Tomorrow' })).toBeTruthy()
    expect(reminders).toHaveLength(0)

    await act(async () => {
      fireEvent.click(screen.getByRole('menuitem', { name: 'In 1 hour' }))
    })
    expect(reminders).toHaveLength(1)
    expect(reminders[0].messageId).toBe('m1')
    // "In 1 hour" must land in the future, not silently schedule "now".
    expect(Date.parse(reminders[0].remindAt)).toBeGreaterThan(Date.now() + 50 * 60_000)
  })

  test('copy message copies what the message reads as, not the stored wire tokens', async () => {
    const { container } = render(
      <MessageRow message={message({ text: '**hi** <@a:p:proj-1>' })} grouped={false} me="u-me" names={names} canManage={false} {...handlers()} />,
    )
    fireEvent.pointerEnter(container.querySelector('[role="button"]')!)
    fireEvent.click(screen.getByLabelText('More actions'))
    await act(async () => {
      fireEvent.click(screen.getByRole('menuitem', { name: 'Copy message' }))
    })
    // Pasting outside Shogo must not hand anyone a UUID, and must not carry markup.
    expect(copied.at(-1)).toBe('hi @Billing Bot')
    expect(copied.at(-1)).not.toContain('p:proj-1')

    fireEvent.click(screen.getByLabelText('More actions'))
    expect(screen.getByRole('menuitem', { name: 'Message copied' })).toBeTruthy()
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
    expect(h.onReact).toHaveBeenCalledWith(expect.objectContaining({ id: 'm1' }), '🚀', true)
    expect(shim('emoji-picker')).toBeNull()
  })

  test('clicking a reaction you already have removes it', () => {
    const h = handlers()
    render(<MessageRow message={message({ reactions: [{ emoji: '👍', count: 1, userIds: ['u-me'] }] })} grouped={false} me="u-me" names={names} canManage={false} {...h} />)
    fireEvent.click(screen.getByLabelText('You reacted with 👍'))
    expect(h.onReact).toHaveBeenCalledWith(expect.objectContaining({ id: 'm1' }), '👍', false)
  })

  test('clicking a reaction you do not have yet adds it', () => {
    const h = handlers()
    render(<MessageRow message={message({ reactions: [{ emoji: '👍', count: 1, userIds: ['u-ana'] }] })} grouped={false} me="u-me" names={names} canManage={false} {...h} />)
    fireEvent.click(screen.getByLabelText('Ana Lopez reacted with 👍'))
    expect(h.onReact).toHaveBeenCalledWith(expect.objectContaining({ id: 'm1' }), '👍', true)
  })

  test('hovering a reaction chip shows a card naming who reacted, and leaving hides it', async () => {
    const reactions = [{ emoji: '❤️', count: 3, userIds: ['u-me', 'u-ana', 'u-gone'] }]
    render(<MessageRow message={message({ reactions })} grouped={false} me="u-me" names={reactors} canManage={false} />)
    const chip = screen.getByLabelText('You, Ana Lopez and Someone reacted with ❤️')
    expect(document.querySelector('[data-testid="reaction-tooltip"]')).toBeNull()
    fireEvent.mouseEnter(chip.parentElement!)
    await waitFor(() => expect(document.querySelector('[data-testid="reaction-tooltip"]')).not.toBeNull())
    const card = document.querySelector('[data-testid="reaction-tooltip"]')!
    expect(card.textContent).toContain('Ana Lopez, Someone and You')
    expect(card.textContent).toContain('reacted with :heart:')
    fireEvent.mouseLeave(chip.parentElement!)
    expect(document.querySelector('[data-testid="reaction-tooltip"]')).toBeNull()
  })

  test('a crowded reaction collapses the tail in the hover card', async () => {
    const reactions = [{ emoji: '🎉', count: 5, userIds: ['u-ana', 'u-bob', 'u-cid', 'u-dee', 'u-me'] }]
    render(<MessageRow message={message({ reactions })} grouped={false} me="u-me" names={reactors} canManage={false} />)
    const chip = screen.getByLabelText('Ana Lopez, Bob Chen and 3 others reacted with 🎉')
    fireEvent.mouseEnter(chip.parentElement!)
    await waitFor(() => expect(document.querySelector('[data-testid="reaction-tooltip"]')).not.toBeNull())
    expect(document.querySelector('[data-testid="reaction-tooltip"]')!.textContent).toContain('Ana Lopez, Bob Chen, Cid Rao, Dee Park and You reacted with :tada:')
  })

  test('a pasted markdown attachment renders as a markdown card, not a file tile', () => {
    const attachment = {
      id: 'att-md', name: 'Pasted markdown.md', mimeType: 'text/markdown', size: 2100,
      url: '/api/conversation-files/att-md?t=x', width: null, height: null,
    }
    render(<MessageRow message={message({ attachments: [attachment] })} grouped={false} me="u-me" names={names} canManage={false} {...handlers()} />)
    // Views carry their testID as the shared RN shim, not as `data-testid`.
    expect(shim('pasted-markdown-card')).toBeTruthy()
    expect(shim('attachment-card-Pasted markdown.md')).toBeNull()
  })

  test('a huddle notes summary shows the title and summary, and opens the transcript', () => {
    const text = 'Huddle notes: Design review\n\n## Decisions\n- Ship it'
    render(
      <MessageRow
        message={message({
          authorType: 'system',
          text,
          blocks: { huddleNotes: { huddleId: 'h1', meetingId: 'm1', title: 'Design review', status: 'ready' } },
        })}
        grouped={false}
        me="u-me"
        names={names}
        canManage={false}
        {...handlers()}
      />,
    )
    const card = shim('huddle-notes-block')!
    expect(card).toBeTruthy()
    expect(card.textContent).toContain('Design review')
    expect(card.textContent).toContain('Ship it')
    // The title is the card's own line, not repeated in the body.
    expect(card.textContent).not.toContain('Huddle notes:')

    const before = routed.length
    fireEvent.click(screen.getByLabelText('Open the full transcript'))
    expect(routed.slice(before)).toEqual([
      expect.objectContaining({ pathname: '/(app)/huddles/[huddleId]/notes', params: { huddleId: 'h1' } }),
    ])
  })

  test('deleted notes keep the message, without a transcript to open', () => {
    render(
      <MessageRow
        message={message({
          authorType: 'system',
          text: 'Huddle notes deleted.',
          blocks: { huddleNotes: { huddleId: 'h1', meetingId: null, title: null, status: 'deleted' } },
        })}
        grouped={false}
        me="u-me"
        names={names}
        canManage={false}
        {...handlers()}
      />,
    )
    expect(shim('huddle-notes-block')!.textContent).toContain('Huddle notes deleted')
    expect(screen.queryByLabelText('Open the full transcript')).toBeNull()
  })

  test('an ended huddle card links to the notes of the call it belongs to', () => {
    render(
      <MessageRow
        message={message({
          authorType: 'system',
          text: 'Huddle ended',
          blocks: { huddle: { id: 'h1', status: 'ended', notesMeetingId: 'm1' } },
        })}
        grouped={false}
        me="u-me"
        names={names}
        canManage={false}
        {...handlers()}
      />,
    )
    expect(shim('huddle-notes-link')).toBeTruthy()
    expect(shim('huddle-notes-block')).toBeNull()

    const before = routed.length
    fireEvent.click(screen.getByLabelText("Open this huddle's notes"))
    expect(routed.slice(before)).toEqual([
      expect.objectContaining({ pathname: '/(app)/huddles/[huddleId]/notes', params: { huddleId: 'h1' } }),
    ])
  })

  test('a huddle with no notes stays the plain call card', () => {
    render(
      <MessageRow
        message={message({ authorType: 'system', text: 'Huddle ended', blocks: { huddle: { id: 'h1', status: 'ended' } } })}
        grouped={false}
        me="u-me"
        names={names}
        canManage={false}
        {...handlers()}
      />,
    )
    expect(shim('huddle-notes-link')).toBeNull()
    expect(shim('huddle-notes-block')).toBeNull()
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

describe('MessageList day dividers', () => {
  const timeline = (messages: any[]) => ({ messages, streaming: {}, hasMoreOlder: false }) as any
  const at = (day: number, hour: number, minute: number) => new Date(2026, 9, day, hour, minute).toISOString()
  /** The divider that shares a cell with the message carrying this text. */
  const dividerAbove = (text: string) =>
    shims('day-divider').find((d) => d.parentElement?.textContent?.includes(text))

  const list = () => (
    <MessageList
      state={timeline([
        message({ id: 'a', seq: 1, text: 'alpha', createdAt: at(5, 23, 56) }),
        message({ id: 'b', seq: 2, text: 'bravo', createdAt: at(5, 23, 57) }),
        message({ id: 'c', seq: 3, text: 'charlie', createdAt: at(6, 0, 0) }),
      ])}
      loading={false} me="u-me" names={names} canManage={false} {...handlers()} />
  )

  test('a divider opens each day, above the first message sent that day', () => {
    render(list())
    expect(shims('day-divider')).toHaveLength(2)
    // Midnight starts a new day; a message a minute after an earlier same-day one does not.
    expect(dividerAbove('charlie')).toBeTruthy()
    expect(dividerAbove('bravo')).toBeUndefined()
    expect(dividerAbove('alpha')).toBeTruthy()
  })

  test('a new day breaks the author grouping, so the header repeats', () => {
    render(list())
    // "bravo" is grouped under "alpha" (a minute apart, same author) and shows no
    // name; "charlie" is only three minutes later but a day has turned over, so it
    // must carry its own header rather than hanging under the previous day.
    expect(screen.getAllByText('Ana Lopez')).toHaveLength(2)
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
    expect(shim('approval-sent')!.textContent).toBe('Denied, sent to the agent')
    expect(screen.queryByLabelText('Approve')).toBeNull()

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

describe('board card posts', () => {
  const block = {
    type: 'status_card',
    messageKind: 'status',
    card: { title: 'SHO-17 · Board card posted to a channel', status: 'working', summary: 'In Development · Shogo Dev 3 · high' },
    workItem: {
      id: 'i1', key: 'SHO-17', boardId: 'b1', boardName: 'Shogo Dev',
      title: 'Board card posted to a channel renders as clipped prose',
      column: { name: 'In Development', category: 'active' }, priority: 'high',
      assignee: { kind: 'agent', name: 'Shogo Dev 3' }, dueAt: null, path: '/work?card=i1',
    },
  }
  const systemMsg = (blocks: unknown, text: string) =>
    message({ id: 'w1', authorType: 'system', author: null, authorUserId: null, text, blocks })

  test('a board card paints its own card and not the clipped markdown body', () => {
    routed.length = 0
    render(
      <MessageRow
        message={systemMsg(block, '**SHO-17 · Board card posted**\nIn Development · Shogo Dev 3 · high\n\nCLIPPED-BODY-MARKER')}
        grouped={false} me="u-me" names={names} canManage={false} {...handlers()}
      />,
    )
    expect(screen.getByTestId('work-item-card')).toBeTruthy()
    expect(shim('work-item-key')!.textContent).toBe('SHO-17')
    expect(shim('work-item-title')!.textContent).toBe(block.workItem.title)
    expect(screen.getByText('In Development')).toBeTruthy()
    expect(screen.getByText('Shogo Dev 3')).toBeTruthy()
    expect(screen.getByText('Shogo Dev')).toBeTruthy()
    expect(document.body.textContent).not.toContain('CLIPPED-BODY-MARKER')

    fireEvent.click(screen.getByTestId('work-item-card'))
    expect(routed.at(-1)).toEqual({ pathname: '/(app)/c/[conversationId]', params: { conversationId: 'c1', card: 'i1', board: 'b1' } })
  })

  test('a block posted before cards carried a title keeps the plain-text rendering', () => {
    render(
      <MessageRow
        message={systemMsg({ workItem: { id: 'i1', key: 'SHO-1', boardId: 'b1' } }, 'SHO-1 · legacy post')}
        grouped={false} me="u-me" names={names} canManage={false} {...handlers()}
      />,
    )
    expect(screen.queryByTestId('work-item-card')).toBeNull()
    expect(screen.getByText(/legacy post/)).toBeTruthy()
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

  test('every header icon names itself on hover, matching its accessible label', () => {
    render(<ConversationHeader conversation={channel()} mentionables={null} me="u-me" onChanged={() => {}} onLeft={() => {}} />)
    for (const label of ['Edit channel', 'Notification settings', 'Star', 'Pinned messages', 'Members', 'Leave channel', 'Archive']) {
      const tooltip = screen.getByLabelText(label).querySelector('[title]')
      expect(tooltip?.getAttribute('title')).toBe(label)
    }
  })

  test('the floating phone header names its icons too', () => {
    render(
      <ConversationHeader
        conversation={channel()}
        mentionables={null}
        me="u-me"
        onChanged={() => {}}
        onLeft={() => {}}
        floating
        onBack={() => {}}
      />,
    )
    for (const label of ['Back', 'More actions']) {
      const tooltip = screen.getByLabelText(label).querySelector('[title]')
      expect(tooltip?.getAttribute('title')).toBe(label)
    }
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

describe('desktop header overflow', () => {
  // The desktop channel header's actions, in the order the header builds them.
  const actions = ['agent-profile', 'edit', 'notify', 'star', 'pins', 'files', 'catchup', 'members', 'leave', 'archive', 'delete'].map((key) => ({ key }))
  const keys = (list: Array<{ key: string }>) => list.map((a) => a.key)

  test('an unmeasured or wide header keeps every action inline', () => {
    expect(splitHeaderActions(actions, 0)).toEqual({ inline: actions, overflow: [] })
    expect(splitHeaderActions(actions, 1100)).toEqual({ inline: actions, overflow: [] })
  })

  test('More appears only once the actions no longer fit', () => {
    // 196px of fixed room plus 36px per icon: all 11 actions need 592px.
    expect(splitHeaderActions(actions, 592).overflow).toEqual([])
    expect(splitHeaderActions(actions, 591).overflow.length).toBeGreaterThan(0)
  })

  test('a narrow header keeps the most useful actions inline and moves the rest under More', () => {
    const { inline, overflow } = splitHeaderActions(actions, 480)
    expect(keys(inline)).toEqual(['notify', 'star', 'pins', 'files', 'catchup', 'members'])
    expect(keys(overflow)).toEqual(['agent-profile', 'edit', 'leave', 'archive', 'delete'])
  })

  test('below the compact width only More remains, with every action under it', () => {
    expect(splitHeaderActions(actions, 240)).toEqual({ inline: [], overflow: actions })
  })
})

describe('deleting a channel', () => {
  const channel = (overrides: Record<string, unknown> = {}): any => ({
    id: 'c9', workspaceId: 'ws', kind: 'public', name: 'design', slug: 'design', topic: null, lastSeq: 0, lastMessageAt: null,
    archivedAt: null, createdAt: '2026-09-29T10:00:00.000Z', joined: true, starred: false, muted: false, notifyLevel: 'default',
    lastReadSeq: 0, canPost: true, canReply: true, canManage: true, canDelete: true, systemManaged: false, members: [], ...overrides,
  })
  const reset = () => {
    deletes.length = 0
    updates.length = 0
    deleteError = null
  }

  test('only deletes once the channel name is typed, then leaves the channel', async () => {
    reset()
    const onDeleted = mock(() => {})
    const onChanged = mock(() => {})
    render(<ConversationHeader conversation={channel()} mentionables={null} me="u-me" onChanged={onChanged} onLeft={() => {}} onDeleted={onDeleted} />)
    fireEvent.click(screen.getByLabelText('Delete channel'))
    expect(screen.getByText('Delete #design?')).toBeTruthy()

    const confirm = screen.getByLabelText('Delete permanently')
    expect(confirm.hasAttribute('disabled')).toBe(true)
    await act(async () => {
      fireEvent.click(confirm)
    })
    expect(deletes).toEqual([])

    fireEvent.change(screen.getByLabelText('Channel name to confirm'), { target: { value: 'desig' } })
    expect(screen.getByLabelText('Delete permanently').hasAttribute('disabled')).toBe(true)
    fireEvent.change(screen.getByLabelText('Channel name to confirm'), { target: { value: ' #Design ' } })
    expect(screen.getByLabelText('Delete permanently').hasAttribute('disabled')).toBe(false)
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Delete permanently'))
    })
    expect(deletes).toEqual(['c9'])
    expect(onDeleted).toHaveBeenCalled()
    expect(onChanged).not.toHaveBeenCalled()
  })

  test('offers archiving instead', async () => {
    reset()
    const onChanged = mock(() => {})
    render(<ConversationHeader conversation={channel()} mentionables={null} me="u-me" onChanged={onChanged} onLeft={() => {}} />)
    fireEvent.click(screen.getByLabelText('Delete channel'))
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Archive instead'))
    })
    expect(updates).toEqual([{ id: 'c9', patch: { archived: true } }])
    expect(deletes).toEqual([])
    expect(onChanged).toHaveBeenCalled()
  })

  test('keeps the dialog open and shows why when the server refuses', async () => {
    reset()
    deleteError = 'Only channel owners and workspace admins can do that'
    render(<ConversationHeader conversation={channel()} mentionables={null} me="u-me" onChanged={() => {}} onLeft={() => {}} />)
    fireEvent.click(screen.getByLabelText('Delete channel'))
    fireEvent.change(screen.getByLabelText('Channel name to confirm'), { target: { value: 'design' } })
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Delete permanently'))
    })
    expect(screen.getByText('Only channel owners and workspace admins can do that')).toBeTruthy()
    expect(screen.getByText('Delete #design?')).toBeTruthy()
  })

  test('explains instead of deleting a channel an agent system declares', () => {
    reset()
    render(<ConversationHeader conversation={channel({ canDelete: false, systemManaged: true })} mentionables={null} me="u-me" onChanged={() => {}} onLeft={() => {}} />)
    fireEvent.click(screen.getByLabelText('Delete channel'))
    expect(screen.getByText(/Remove it from teamChannels there and run system_apply/)).toBeTruthy()
    expect(screen.queryByLabelText('Delete permanently')).toBeNull()
    expect(screen.queryByLabelText('Channel name to confirm')).toBeNull()
  })

  test('is not offered to people who cannot delete it, or by older servers', () => {
    reset()
    render(<ConversationHeader conversation={channel({ canManage: false, canDelete: false })} mentionables={null} me="u-me" onChanged={() => {}} onLeft={() => {}} />)
    expect(screen.queryByLabelText('Delete channel')).toBeNull()
    cleanup()
    render(<ConversationHeader conversation={channel({ canDelete: undefined, systemManaged: undefined })} mentionables={null} me="u-me" onChanged={() => {}} onLeft={() => {}} />)
    expect(screen.queryByLabelText('Delete channel')).toBeNull()
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

  test('a running reply is a marker before and during tools; its work is the dock\'s job', () => {
    const running = { ...reply(), agentStatus: 'running', text: '' }
    const { rerender } = render(<MessageRow message={running} grouped={false} me="u-me" names={names} canManage={false} {...handlers()} />)
    expect(shim('planning')).toBeNull()
    expect(shim('group')).toBeNull()
    expect(shim('running-reply-marker')).toBeTruthy()
    rerender(<MessageRow message={running} grouped={false} me="u-me" names={names} canManage={false} streaming={{ text: '', tool: 'exec', tools: [{ name: 'exec', done: false }] }} {...handlers()} />)
    // The tools it ran show here only once the run has finished.
    expect(shim('group')).toBeNull()
    expect(shim('planning')).toBeNull()
    expect(shim('running-reply-marker')).toBeTruthy()
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

describe('Shogo on its own messages', () => {
  const notice = (overrides: Record<string, unknown> = {}) =>
    message({ id: 'sys-1', authorType: 'system', author: null, authorUserId: null, text: '<@u:u-ana> started a huddle', ...overrides })

  const renderNotice = () =>
    render(<MessageRow message={notice()} grouped={false} me="u-me" names={names} canManage={false} {...handlers()} />)

  test("a notice from Shogo wears the viewer's own Shogo, still", () => {
    const { container } = renderNotice()
    const buddy = shims('buddy')[0]
    expect(buddy).toBeTruthy()
    expect(buddy.getAttribute('data-color')).toBe(personalLook.color)
    expect(buddy.getAttribute('data-topper')).toBe(personalLook.topper)
    expect(shims('buddy-avatar')).toHaveLength(1)
    // Shogo is not a person who can be present, so no dot.
    expect(container.querySelector('[data-rn-shim^="presence-"]')).toBeNull()
  })

  test("the workspace agent's uploaded picture still wins over the buddy", () => {
    hookMentionables.value = {
      people: [],
      agents: [{ key: 'ws', projectId: null, name: 'Shogo', description: null, image: 'https://cdn.example.com/shogo.png' }],
    }
    try {
      const { container } = renderNotice()
      expect(container.querySelector('img')?.getAttribute('accessibilitylabel')).toBe('Shogo avatar')
      expect(shims('buddy')).toHaveLength(0)
    } finally {
      hookMentionables.value = null
    }
  })
})

describe('what a screen reader hears', () => {
  test('a mention is announced as the name, not the token in the stored source', () => {
    const { container } = render(
      <MessageRow message={message()} grouped={false} me="u-me" names={names} canManage={false} {...handlers()} />,
    )

    // The fixture's text is `hi <@a:p:proj-1>`. Spoken verbatim that is a UUID.
    expect(screen.getByLabelText('Ana Lopez: hi @Billing Bot')).toBeTruthy()
    const labels = Array.from(container.querySelectorAll('[aria-label]')).map((el) => el.getAttribute('aria-label')!)
    expect(labels.some((label) => label.includes('<@a:'))).toBe(false)
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

describe('#activity filters', () => {
  test('picking agents hides every other agent\'s lines', () => {
    activityTimeline.messages = [
      message({
        id: 'a1', seq: 1, authorType: 'system', author: null, authorUserId: null,
        text: 'finished the invoices',
        blocks: { type: 'activity', kind: 'task.completed', projectId: 'proj-1' },
      }),
      message({
        id: 'a2', seq: 2, authorType: 'system', author: null, authorUserId: null,
        text: 'ran the daily digest',
        blocks: { type: 'activity', kind: 'schedule.ok', projectId: null },
      }),
      message({
        id: 'a3', seq: 3, authorType: 'system', author: null, authorUserId: null,
        text: 'answered the ticket',
        blocks: { type: 'activity', kind: 'agent.message', projectId: 'proj-2', conversationId: 'c-eng' },
      }),
    ]
    activityTimeline.channels = [
      { id: 'c-eng', kind: 'public', name: 'eng', slug: 'eng' },
      { id: 'c-ops', kind: 'public', name: 'ops', slug: 'ops' },
      { id: 'c-dm', kind: 'dm', name: 'Ana', slug: null },
    ]
    const agents = [
      { key: 'ws', projectId: null, name: 'Workspace agent', description: null, image: null },
      { key: 'p:proj-1', projectId: 'proj-1', name: 'Billing Bot', description: null, image: null },
      { key: 'p:proj-2', projectId: 'proj-2', name: 'Support Bot', description: null, image: null },
    ]
    render(
      <TimelinePane
        workspaceId="ws"
        conversation={{
          id: 'c-activity', workspaceId: 'ws', kind: 'activity', name: 'activity', slug: 'activity',
          topic: null, lastSeq: 3, lastMessageAt: null, archivedAt: null, createdAt: '2026-09-29T10:00:00.000Z',
          joined: true, starred: false, muted: false, notifyLevel: 'all', lastReadSeq: 3,
          canPost: false, canReply: true, canManage: false, members: [],
        }}
        me="u-me"
        mentionables={{ ...mentionables, agents }}
        visible
      />,
    )
    expect(screen.getByText(/finished the invoices/)).toBeTruthy()
    expect(screen.getByText(/ran the daily digest/)).toBeTruthy()
    expect(screen.getByText(/answered the ticket/)).toBeTruthy()

    fireEvent.click(screen.getByTestId('activity-filter-agent'))
    fireEvent.click(screen.getByText('Billing Bot'))

    expect(screen.getByText(/finished the invoices/)).toBeTruthy()
    expect(screen.queryByText(/ran the daily digest/)).toBeNull()
    expect(screen.queryByText(/answered the ticket/)).toBeNull()
    expect(screen.getByLabelText('Agent: Billing Bot')).toBeTruthy()

    fireEvent.click(screen.getByText('Workspace agent'))
    expect(screen.getByText(/finished the invoices/)).toBeTruthy()
    expect(screen.getByText(/ran the daily digest/)).toBeTruthy()
    expect(screen.queryByText(/answered the ticket/)).toBeNull()
    expect(screen.getByLabelText('Agent: Workspace agent, Billing Bot')).toBeTruthy()
    expect(screen.getByText('2 agents')).toBeTruthy()
  })
})

describe('running agents in a channel', () => {
  const channel = {
    id: 'c-eng', workspaceId: 'ws', kind: 'public', name: 'eng', slug: 'eng',
    topic: null, lastSeq: 2, lastMessageAt: null, archivedAt: null, createdAt: '2026-09-29T10:00:00.000Z',
    joined: true, starred: false, muted: false, notifyLevel: 'all', lastReadSeq: 2,
    canPost: true, canReply: true, canManage: false, members: [],
  }
  const runningReply = (id: string, projectId: string, name: string) =>
    message({
      id, seq: 2, authorType: 'agent', author: null, authorUserId: null,
      authorAgent: { projectId, name }, text: '', agentStatus: 'running', agentSessionId: `s-${id}`, threadRootId: null,
    })
  const renderChannel = (props: Record<string, unknown> = {}) =>
    render(
      <TimelinePane
        workspaceId="ws"
        conversation={channel as any}
        me="u-me"
        mentionables={{ ...mentionables, agents: [] }}
        visible
        {...props}
      />,
    )

  /** The reply's own row, once it has been marked to jump to. */
  const highlighted = () => document.querySelector('[data-testid="message-highlighted"]')

  beforeEach(() => {
    typingUsers.length = 0
    stoppedAgents.length = 0
    activityTimeline.messages = []
  })
  afterEach(() => {
    cleanup()
    typingUsers.length = 0
    stoppedAgents.length = 0
    activityTimeline.messages = []
  })

  test('a running agent gets a dock row above the composer, not a typing line', () => {
    activityTimeline.messages = [runningReply('r1', 'proj-1', 'Billing Bot')]
    renderChannel()
    expect(shim('running-agents-dock')!.textContent).toContain('Billing Bot')
    expect(screen.getByTestId('running-agent-row-r1')).toBeTruthy()
    // The grey line under the list never names an agent.
    expect(document.body.textContent).not.toContain('is typing')
  })

  test('two running replies from one agent are two dock rows', () => {
    activityTimeline.messages = [runningReply('r1', 'proj-1', 'Billing Bot'), runningReply('r2', 'proj-1', 'Billing Bot')]
    renderChannel()
    expect(screen.getAllByTestId(/^running-agent-row-/)).toHaveLength(2)
  })

  test('a person and a running agent with the same name: only the person is typing', () => {
    typingUsers.push({ id: 'pat', name: 'Billing Bot' })
    activityTimeline.messages = [runningReply('r1', 'proj-1', 'Billing Bot')]
    renderChannel()
    expect(screen.getByText('Billing Bot is typing')).toBeTruthy()
    expect(document.body.textContent).not.toContain('Billing Bot and Billing Bot')
    expect(shim('running-agents-dock')!.textContent).toContain('Billing Bot')
  })

  test('two people typing while two agents run: only the people are counted', () => {
    typingUsers.push({ id: 'pat', name: 'Pat' }, { id: 'lee', name: 'Lee' })
    activityTimeline.messages = [runningReply('r1', 'proj-1', 'Billing Bot'), runningReply('r2', 'proj-2', 'Support Bot')]
    renderChannel()
    expect(screen.getByText('Pat and Lee are typing')).toBeTruthy()
    expect(screen.getAllByTestId(/^running-agent-row-/)).toHaveLength(2)
  })

  test('a thread docks its own running replies', () => {
    activityTimeline.messages = [runningReply('r1', 'proj-1', 'Billing Bot')]
    renderChannel({ threadRootId: 'root-1' })
    expect(screen.getByTestId('running-agent-row-r1')).toBeTruthy()
  })

  test('tapping a dock row jumps to and highlights that reply', () => {
    activityTimeline.messages = [runningReply('r1', 'proj-1', 'Billing Bot')]
    renderChannel()
    expect(highlighted()).toBeNull()
    fireEvent.click(screen.getByLabelText("Jump to Billing Bot's reply"))
    expect(highlighted()).not.toBeNull()
  })

  test('Stop on a dock row stops that run', () => {
    activityTimeline.messages = [runningReply('r1', 'proj-1', 'Billing Bot')]
    renderChannel()
    fireEvent.click(screen.getByLabelText('Stop agent'))
    expect(stoppedAgents).toEqual(['r1'])
  })

  test('Open session on a dock row opens that reply\'s session', () => {
    const onOpenSession = mock(() => {})
    activityTimeline.messages = [runningReply('r1', 'proj-1', 'Billing Bot')]
    renderChannel({ onOpenSession })
    fireEvent.click(screen.getByLabelText('Open the session this agent is working in'))
    expect(onOpenSession).toHaveBeenCalledWith(expect.objectContaining({ id: 'r1', agentSessionId: 's-r1' }))
  })

  test('the phone pane floats the dock in the footer above the composer', () => {
    activityTimeline.messages = [runningReply('r1', 'proj-1', 'Billing Bot')]
    renderChannel({ floating: true, topInset: 0 })
    const footer = shim('floating-composer')
    expect(footer).toBeTruthy()
    expect(footer!.querySelector('[data-rn-shim="running-agents-dock"]')).not.toBeNull()
  })
})

describe('MessageRow image attachments', () => {
  const image = (id: string, name: string) => ({
    id, name, mimeType: 'image/png', size: 2048, width: 800, height: 600, url: `/api/uploads/${id}`,
  })
  const file = (id: string, name: string) => ({
    id, name, mimeType: 'application/pdf', size: 4096, width: null, height: null, url: `/api/uploads/${id}`,
  })
  const voiceNote = (id: string) => ({
    id, name: 'Voice note.m4a', mimeType: 'audio/mp4', size: 12_000, width: null, height: null,
    url: `/api/uploads/${id}`, durationMs: 12_000, peaks: '20 40 100 60',
  })
  const renderRow = (attachments: unknown[]) =>
    render(<MessageRow message={message({ attachments })} grouped={false} me="u-me" names={names} canManage={false} {...handlers()} />)

  let openURL: ReturnType<typeof spyOn>

  beforeEach(() => {
    openURL = spyOn(Linking, 'openURL').mockImplementation(() => Promise.resolve())
  })
  afterEach(() => {
    openURL.mockRestore()
  })

  test('clicking an image opens the viewer instead of the browser, seeded with that image', () => {
    renderRow([image('a1', 'shot-1.png'), image('a2', 'shot-2.png')])
    expect(screen.queryByTestId('image-lightbox')).toBeNull()

    fireEvent.click(screen.getByLabelText('Open shot-1.png'))

    const lightbox = screen.getByTestId('image-lightbox')
    expect(lightbox.getAttribute('data-url')).toBe('/api/uploads/a1')
    expect(lightbox.getAttribute('data-index')).toBe('0')
    expect(lightbox.getAttribute('data-count')).toBe('2')
    expect(lightbox.getAttribute('data-title')).toBe('shot-1.png')
    expect(openURL).not.toHaveBeenCalled()
  })

  test('a later image in the same message opens at its own index', () => {
    renderRow([image('a1', 'one.png'), image('a2', 'two.png'), image('a3', 'three.png')])

    fireEvent.click(screen.getByLabelText('Open two.png'))

    const lightbox = screen.getByTestId('image-lightbox')
    expect(lightbox.getAttribute('data-url')).toBe('/api/uploads/a2')
    expect(lightbox.getAttribute('data-index')).toBe('1')
    expect(lightbox.getAttribute('data-count')).toBe('3')
    expect(openURL).not.toHaveBeenCalled()
  })

  test('files in the mix do not shift the gallery index', () => {
    renderRow([file('f1', 'notes.pdf'), image('a1', 'one.png'), image('a2', 'two.png')])

    fireEvent.click(screen.getByLabelText('Open two.png'))

    const lightbox = screen.getByTestId('image-lightbox')
    // Second image, not third attachment.
    expect(lightbox.getAttribute('data-index')).toBe('1')
    expect(lightbox.getAttribute('data-count')).toBe('2')
  })

  test('a video attachment plays inline instead of showing a file card', () => {
    renderRow([{ id: 'v1', name: 'demo.mp4', mimeType: 'video/mp4', size: 9000, width: null, height: null, url: '/api/uploads/v1' }])

    const video = screen.getByTestId('message-video')
    expect(video.tagName).toBe('VIDEO')
    expect(video.getAttribute('src')).toContain('/api/uploads/v1')
  })

  test('close dismisses the viewer', () => {
    renderRow([image('a1', 'shot-1.png')])
    fireEvent.click(screen.getByLabelText('Open shot-1.png'))
    expect(screen.getByTestId('image-lightbox')).toBeTruthy()

    fireEvent.click(screen.getByLabelText('Close lightbox'))

    expect(screen.queryByTestId('image-lightbox')).toBeNull()
  })

  test('a single image opens without gallery controls', () => {
    renderRow([image('a1', 'only.png')])

    fireEvent.click(screen.getByLabelText('Open only.png'))

    expect(screen.getByTestId('image-lightbox').getAttribute('data-count')).toBe('1')
  })

  test('a shared file opens the app’s own viewer, never a browser tab', () => {
    const before = routed.length
    renderRow([file('f1', 'notes.pdf')])

    fireEvent.click(screen.getByText('notes.pdf'))

    expect(openURL).not.toHaveBeenCalled()
    expect(screen.queryByTestId('image-lightbox')).toBeNull()
    expect(routed.slice(before)).toEqual([
      { pathname: '/(app)/f/[attachmentId]', params: { attachmentId: 'f1', name: 'notes.pdf' } },
    ])
  })

  test('a voice note renders a player, not a file row that opens a URL', () => {
    renderRow([voiceNote('v1')])

    expect(screen.getByLabelText('Play Voice note.m4a')).toBeDefined()
    expect(screen.getByText('0:12')).toBeDefined()
    // The waveform is scrubbable, and clicking the row does not leave the app.
    expect(screen.getByLabelText('Seek Voice note.m4a')).toBeDefined()
    expect(openURL).not.toHaveBeenCalled()
    expect(screen.queryByText('Voice note.m4a')).toBeNull()
  })

  test('a deleted message shows neither attachments nor the viewer', () => {
    render(
      <MessageRow
        message={message({ attachments: [image('a1', 'shot-1.png')], deletedAt: '2026-09-29T11:00:00.000Z' })}
        grouped={false}
        me="u-me"
        names={names}
        canManage={false}
        {...handlers()}
      />,
    )

    expect(screen.queryByLabelText('Open shot-1.png')).toBeNull()
    expect(screen.queryByTestId('image-lightbox')).toBeNull()
  })

  describe('sizing to the image and the pane', () => {
    const sized = (id: string, name: string, width: number | null, height: number | null) => ({
      id, name, mimeType: 'image/png', size: 2048, width, height, url: `/api/uploads/${id}`,
    })

    /** What a layout pass on the attachment row would report. */
    const reportRowWidth = (width: number) => {
      const row = document.querySelector('[data-rn-shim="message-attachments"]') as Element
      const handler = layoutHandlers.get(row)
      if (!handler) throw new Error('the attachment row registered no onLayout')
      act(() => handler({ nativeEvent: { layout: { width, height: 40 } } }))
    }

    /** What an image reports once it has loaded, for attachments with no stored size. */
    const reportImageSize = (
      name: string,
      width: number,
      height: number,
      shape: 'native' | 'web' | 'nulled' = 'native',
    ) => {
      const img = document.querySelector(`img[accessibilitylabel="${name}"]`) as Element
      const handler = imageLoadHandlers.get(img)
      if (!handler) throw new Error('the image registered no onLoad')
      // Native puts the size in `nativeEvent.source`; a DOM load event carries it
      // on its target, and on web it arrives after `decode()` with that target
      // already nulled.
      const event =
        shape === 'nulled'
          ? { nativeEvent: { type: 'load', target: null } }
          : shape === 'web'
            ? { nativeEvent: { type: 'load', target: { naturalWidth: width, naturalHeight: height } } }
            : { nativeEvent: { source: { width, height, uri: '' } } }
      act(() => handler(event))
    }

    const imageEl = (name: string) =>
      document.querySelector(`img[accessibilitylabel="${name}"]`) as HTMLImageElement

    /**
     * What `Image.getSize` answers, which is the only measurement that survives
     * a web load event: react-native-web defers `onLoad` through
     * `image.decode()`, and Chromium has nulled the event's target by then.
     */
    const reportGetSize = (uriPart: string, width: number, height: number) => {
      // The most recent request is the live one; an earlier uri's request is
      // ignored by the hook on purpose.
      const request = [...imageGetSizeRequests].reverse().find((entry) => entry.uri.includes(uriPart))
      if (!request) throw new Error(`no Image.getSize request matching ${uriPart}`)
      act(() => request.success(width, height))
    }

    beforeEach(() => {
      imageGetSizeRequests.length = 0
    })

    test('a wide screenshot fills the row instead of a 220px strip', () => {
      renderRow([sized('a1', 'shot.png', 1600, 900)])
      reportRowWidth(900)

      const img = imageEl('shot.png')
      expect(img.style.width).toBe('462px')
      expect(img.style.height).toBe('260px')
      // The box matches the aspect, so the image is shown whole, never cropped.
      expect(img.getAttribute('resizemode')).toBe('contain')
    })

    test('it shrinks with a narrow pane and never overflows it', () => {
      renderRow([sized('a1', 'shot.png', 1600, 900)])
      reportRowWidth(200)

      expect(imageEl('shot.png').style.width).toBe('200px')
      expect(imageEl('shot.png').style.height).toBe('113px')
    })

    test('a small image is not upscaled past its own pixels', () => {
      renderRow([sized('a1', 'tiny.png', 120, 80)])
      reportRowWidth(900)

      expect(imageEl('tiny.png').style.width).toBe('120px')
      expect(imageEl('tiny.png').style.height).toBe('80px')
    })

    test('a tall image stays within the max height', () => {
      renderRow([sized('a1', 'tall.png', 900, 1600)])
      reportRowWidth(900)

      expect(imageEl('tall.png').style.height).toBe('260px')
      // 146 wide, so the portrait keeps its aspect rather than being squeezed.
      expect(imageEl('tall.png').style.width).toBe('146px')
      expect(imageEl('tall.png').getAttribute('resizemode')).toBe('contain')
    })

    test('an extremely tall image is widened to the min width and cropped', () => {
      renderRow([sized('a1', 'sliver.png', 300, 2400)])
      reportRowWidth(900)

      expect(imageEl('sliver.png').style.width).toBe('120px')
      expect(imageEl('sliver.png').style.height).toBe('260px')
      expect(imageEl('sliver.png').getAttribute('resizemode')).toBe('cover')
    })

    test('an attachment with no stored dimensions takes its aspect from the image', () => {
      renderRow([sized('a1', 'old.png', null, null)])
      reportRowWidth(900)
      // Until it loads the fallback aspect fills the row, the size a 4:3 image would want.
      expect(imageEl('old.png').style.width).toBe('347px')

      reportImageSize('old.png', 1600, 900)

      expect(imageEl('old.png').style.width).toBe('462px')
      expect(imageEl('old.png').style.height).toBe('260px')
    })

    test('a stored smaller size is not overridden by what the image loads as', () => {
      renderRow([sized('a1', 'small.png', 200, 100)])
      reportRowWidth(900)

      reportImageSize('small.png', 1600, 900, 'web')

      expect(imageEl('small.png').style.width).toBe('200px')
      expect(imageEl('small.png').style.height).toBe('100px')
      // Stored dimensions win, so nothing is measured at all.
      expect(imageGetSizeRequests).toHaveLength(0)
    })

    test('web sizes an attachment with no stored dimensions from Image.getSize', () => {
      renderRow([sized('a1', 'old.png', null, null)])
      reportRowWidth(900)
      expect(imageEl('old.png').style.width).toBe('347px')

      // react-native-web's load event arrives after `image.decode()` with a
      // nulled target, so it carries no size at all.
      reportImageSize('old.png', 0, 0, 'nulled')
      expect(imageEl('old.png').style.width).toBe('347px')

      reportGetSize('/api/uploads/a1', 1600, 900)

      expect(imageEl('old.png').style.width).toBe('462px')
      expect(imageEl('old.png').style.height).toBe('260px')
      expect(imageEl('old.png').getAttribute('resizemode')).toBe('contain')
    })

    test('before the row is measured the preview keeps the old 220px width', () => {
      renderRow([sized('a1', 'shot.png', 800, 600)])

      expect(imageEl('shot.png').style.width).toBe('220px')
      expect(imageEl('shot.png').style.height).toBe('165px')
    })
  })
})

describe('opening a person’s profile from a message', () => {
  const profileOpener = () => mock((_userId: string) => {})
  const channelConversation = {
    id: 'c-eng', workspaceId: 'ws', kind: 'public', name: 'eng', slug: 'eng',
    topic: null, lastSeq: 2, lastMessageAt: null, archivedAt: null, createdAt: '2026-09-29T10:00:00.000Z',
    joined: true, starred: false, muted: false, notifyLevel: 'all', lastReadSeq: 2,
    canPost: true, canReply: true, canManage: false, members: [],
  }
  const renderChannel = (onOpenProfile?: (userId: string) => void) =>
    render(
      <TimelinePane
        workspaceId="ws"
        conversation={{ ...channelConversation } as any}
        me="u-me"
        mentionables={{ ...mentionables, agents: [] }}
        visible
        onOpenProfile={onOpenProfile}
      />,
    )
  const mentions = () => document.querySelectorAll('[data-testid="chat-mention"]')

  beforeEach(() => {
    activityTimeline.messages = []
  })
  afterEach(() => {
    cleanup()
    routed.length = 0
    activityTimeline.messages = []
  })

  test('their name opens their profile', () => {
    const onOpenProfile = profileOpener()
    render(
      <MessageRow message={message()} grouped={false} me="u-me" names={names} canManage={false} onOpenProfile={onOpenProfile} {...handlers()} />,
    )
    fireEvent.click(screen.getByLabelText('Ana Lopez profile'))
    expect(onOpenProfile).toHaveBeenCalledWith('u-ana')
  })

  test('their photo opens it too', () => {
    const onOpenProfile = profileOpener()
    render(
      <MessageRow message={message()} grouped={false} me="u-me" names={names} canManage={false} onOpenProfile={onOpenProfile} {...handlers()} />,
    )
    fireEvent.click(screen.getByLabelText('Ana Lopez avatar'))
    expect(onOpenProfile).toHaveBeenCalledWith('u-ana')
  })

  test('is inert in a host that has nowhere to show one', () => {
    render(
      <MessageRow message={message()} grouped={false} me="u-me" names={names} canManage={false} {...handlers()} />,
    )
    // No handler, so the name is plain text rather than a dead button.
    expect(screen.queryByLabelText('Ana Lopez profile')).toBeNull()
    expect(screen.getByText('Ana Lopez')).toBeTruthy()
  })

  test('an agent author still gets its own card', async () => {
    const onOpenProfile = profileOpener()
    render(
      <MessageRow
        message={message({
          authorType: 'agent', author: null, authorUserId: null,
          authorAgent: { projectId: 'proj-1', name: 'Billing Bot' }, text: 'hello',
        })}
        grouped={false}
        me="u-me"
        names={names}
        canManage={false}
        onOpenProfile={onOpenProfile}
        {...handlers()}
      />,
    )
    fireEvent.click(screen.getAllByLabelText('Billing Bot profile')[0]!)
    await screen.findByText('Sends invoices')
    expect(onOpenProfile).not.toHaveBeenCalled()
  })

  test('a deleted message opens nothing', () => {
    const onOpenProfile = profileOpener()
    render(
      <MessageRow
        message={message({ deletedAt: '2026-09-29T11:00:00.000Z' })}
        grouped={false}
        me="u-me"
        names={names}
        canManage={false}
        onOpenProfile={onOpenProfile}
        {...handlers()}
      />,
    )
    expect(screen.queryByLabelText('Ana Lopez profile')).toBeNull()
    expect(onOpenProfile).not.toHaveBeenCalled()
  })

  test('tapping their mention in the text opens it too', () => {
    const onOpenProfile = profileOpener()
    activityTimeline.messages = [message({ text: 'ping <@u:u-ana> about the deck' })]
    renderChannel(onOpenProfile)
    fireEvent.click(mentions()[0]!)
    expect(onOpenProfile).toHaveBeenCalledWith('u-ana')
  })

  test('an agent mention opens the agent profile page instead', () => {
    routed.length = 0
    activityTimeline.messages = [message({ text: 'thanks <@a:p:proj-1>' })]
    renderChannel(mock(() => {}))
    fireEvent.click(mentions()[0]!)
    expect(routed).toEqual([{ pathname: '/(app)/agents/[key]', params: { key: 'p:proj-1' } }])
  })

  test('mentions stay plain highlights when the host offers no profile', () => {
    const onOpenProfile = profileOpener()
    activityTimeline.messages = [message({ text: 'ping <@u:u-ana>' })]
    renderChannel()
    expect(mentions()).toHaveLength(1)
    expect(onOpenProfile).not.toHaveBeenCalled()
  })
})

describe('Composer channel references', () => {
  const channels = [
    { id: 'c-ops', kind: 'public', name: 'ops', slug: 'ops' },
    { id: 'c-itau', kind: 'private', name: 'client-itau', slug: 'client-itau' },
  ]

  afterEach(() => cleanup())

  test('# lists the channels the reader can see and sends a channel token', async () => {
    const onSend = mock(async () => {})
    render(
      <Composer workspaceId="ws" conversationId="c1" placeholder="Message" mentionables={mentionables} me="u-me" channels={channels} onSend={onSend} />,
    )
    const input = composerInput()
    type(input, 'ask in #cli')
    expect(screen.getByText('client-itau')).toBeTruthy()
    expect(screen.queryByText('ops')).toBeNull()
    fireEvent.keyDown(input, { key: 'Enter' })
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter' })
    })
    const sent = (onSend.mock.calls[0] as any[])[0]
    expect(sent.text).toContain('<#c:c-itau>')
  })

  test('the channel being read is not offered as a reference', () => {
    render(
      <Composer workspaceId="ws" conversationId="c-ops" placeholder="Message" mentionables={mentionables} me="u-me" channels={channels} onSend={async () => {}} />,
    )
    type(composerInput(), '#')
    expect(screen.getByText('client-itau')).toBeTruthy()
    expect(screen.queryByText('ops')).toBeNull()
  })
})

describe('channel mentions in a message', () => {
  const conversation = {
    id: 'c-eng', workspaceId: 'ws', kind: 'public', name: 'eng', slug: 'eng',
    topic: null, lastSeq: 2, lastMessageAt: null, archivedAt: null, createdAt: '2026-09-29T10:00:00.000Z',
    joined: true, starred: false, muted: false, notifyLevel: 'all', lastReadSeq: 2,
    canPost: true, canReply: true, canManage: false, members: [],
  }
  const renderPane = () =>
    render(
      <TimelinePane
        workspaceId="ws"
        conversation={conversation as any}
        me="u-me"
        mentionables={{ ...mentionables, agents: [] }}
        visible
      />,
    )
  const mentions = () => document.querySelectorAll('[data-testid="chat-mention"]')

  afterEach(() => {
    cleanup()
    routed.length = 0
    activityTimeline.messages = []
    activityTimeline.channels = []
  })

  test('a channel the reader can see opens from the message', () => {
    activityTimeline.channels = [{ id: 'c-ops', kind: 'public', name: 'ops', slug: 'ops' }]
    activityTimeline.messages = [message({ text: 'ask in <#c:c-ops>' })]
    renderPane()
    expect(mentions()).toHaveLength(1)
    fireEvent.click(mentions()[0]!)
    expect(routed).toEqual([{ pathname: '/(app)/c/[conversationId]', params: { conversationId: 'c-ops' } }])
  })

  test('a private channel the reader is not in shows no name and is not tappable', () => {
    activityTimeline.channels = []
    activityTimeline.messages = [message({ text: 'in <#c:secret-plans>' })]
    const { container } = renderPane()
    expect(mentions()).toHaveLength(0)
    expect(container.textContent).toContain('#privatechannel')
    expect(container.textContent).not.toContain('secret-plans')
    expect(routed).toEqual([])
  })
})

/**
 * A team-chat message queued behind a reply the agent is still writing is a
 * durable `AgentWake`, and its note is that wake's row: Send now starts it,
 * ✕ takes it off the queue. Both act on the wake, not on the transcript.
 */
describe('a queued team-chat message', () => {
  const queued = (wake: Record<string, unknown> = {}): any =>
    message({
      id: 'n1',
      authorType: 'system',
      author: null,
      authorUserId: null,
      text: 'Queued for Billing Bot — it runs when the current reply ends.',
      blocks: {
        wakeQueued: {
          wakeId: 'w1',
          agentRef: 'project:proj-1',
          agentName: 'Billing Bot',
          triggerMessageId: 'm2',
          runningMessageId: 'm3',
          ...wake,
        },
      },
    })
  const row = (msg: any) =>
    render(<MessageRow message={msg} grouped={false} me="u-me" names={names} canManage={false} {...handlers()} />)

  afterEach(() => {
    sentWakes.length = 0
    removedWakes.length = 0
  })

  test('the note is the wake row, not the old sentence, and Send now starts it', async () => {
    row(queued())

    expect(screen.getByText('Queued for Billing Bot')).toBeInTheDocument()
    expect(screen.getByLabelText('Send queued message now')).toBeInTheDocument()
    expect(document.body.textContent).not.toContain('it runs when the current reply ends')

    fireEvent.click(screen.getByLabelText('Send queued message now'))
    await waitFor(() => expect(sentWakes).toEqual(['w1']))
  })

  test('✕ takes the message off the queue', async () => {
    row(queued())

    fireEvent.click(screen.getByLabelText('Remove queued message'))
    await waitFor(() => expect(removedWakes).toEqual(['w1']))
    expect(sentWakes).toEqual([])
  })

  test('a note painted before the row knew its wake stays the plain system line', () => {
    const legacy = queued()
    delete legacy.blocks.wakeQueued.wakeId
    row(legacy)

    expect(screen.queryByLabelText('Send queued message now')).toBeNull()
    expect(screen.queryByLabelText('Remove queued message')).toBeNull()
    expect(document.body.textContent).toContain('it runs when the current reply ends')
  })

  test('a wake already running offers nothing to press and says who started it', () => {
    row(queued({ status: 'running', sentNowBy: { id: 'u-ana', name: 'Ana Lopez' } }))

    expect(screen.queryByLabelText('Send queued message now')).toBeNull()
    expect(document.body.textContent).toContain('Sent now by Ana Lopez · running')
  })
})

describe('MessageList wheel passthrough', () => {
  /**
   * A markdown table inside the inverted timeline is wider than the pane, and
   * react-native-web's inverted wheel handler answers every gesture itself —
   * it prevents the default and only ever moves the list. A nested scroller
   * therefore has to be handed back to the browser from a capture-phase
   * listener on the list (SHO-162).
   */
  const timeline = (messages: any[]) => ({ messages, streaming: {}, hasMoreOlder: false }) as any
  const table = ['| a | b | c |', '| - | - | - |', '| 1 | 2 | 3 |'].join('\n')
  const list = () => (
    <MessageList
      state={timeline([message({ id: 'a', seq: 1, text: 'before' }), message({ id: 'b', seq: 2, text: table })])}
      loading={false}
      me="u-me"
      names={names}
      canManage={false}
      {...handlers()}
    />
  )
  /** jsdom has no layout, so give the table wrapper the scroll box a browser would. */
  const scrollBox = (element: HTMLElement, width: number, scrollWidth: number) => {
    element.style.overflowX = 'auto'
    element.style.overflowY = 'auto'
    for (const [key, value] of Object.entries({ clientWidth: width, scrollWidth, clientHeight: 200, scrollHeight: 200, scrollLeft: 0, scrollTop: 0 })) {
      Object.defineProperty(element, key, { value, configurable: true, writable: true })
    }
  }
  /**
   * A real WheelEvent carrying its modifiers. jsdom reports `shiftKey` as
   * undefined (it has no KeyboardEvent base), and RTL's synthetic wheel drops
   * `deltaY`, so neither stands in for the browser here.
   */
  const wheel = (target: Element, init: WheelEventInit) => {
    const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, ...init })
    if (init.shiftKey) Object.defineProperty(event, 'shiftKey', { value: true })
    target.dispatchEvent(event)
    return event
  }
  /** Stands in for RN-web's own listener on the list's scroll node. */
  const countListWheel = () => {
    const scrollNode = document.querySelector('[data-scroll-node]') as HTMLElement
    const seen: WheelEvent[] = []
    scrollNode.addEventListener('wheel', (event) => seen.push(event as WheelEvent))
    return seen
  }
  const tableParts = () => {
    const cell = document.querySelector('[data-streamdown="table"] td') as HTMLElement | null
    const wrapper = cell?.closest('table')?.parentElement as HTMLElement | undefined
    return { cell, wrapper }
  }

  beforeEach(() => render(list()))
  afterEach(() => cleanup())

  test('a sideways swipe over a wide table scrolls it and never reaches the list', () => {
    const { cell, wrapper } = tableParts()
    expect(cell).toBeTruthy()
    scrollBox(wrapper!, 300, 700)
    const seen = countListWheel()

    expect(wheel(cell!, { deltaX: 120, deltaY: 0 }).defaultPrevented).toBe(true)
    expect(wrapper!.scrollLeft).toBe(120)

    expect(wheel(cell!, { deltaX: 0, deltaY: 120, shiftKey: true }).defaultPrevented).toBe(true)
    expect(wrapper!.scrollLeft).toBe(240)

    expect(seen).toHaveLength(0)
  })

  test('a vertical wheel over a table wrapper that only scrolls sideways is the list\'s', () => {
    const { cell, wrapper } = tableParts()
    scrollBox(wrapper!, 300, 700)
    const seen = countListWheel()

    wheel(cell!, { deltaX: 0, deltaY: -120 })
    expect(seen).toHaveLength(1)
  })

  test('a wheel over the table still reaches the list once the table is at its edge', () => {
    const { cell, wrapper } = tableParts()
    scrollBox(wrapper!, 300, 700)
    Object.defineProperty(wrapper!, 'scrollLeft', { value: 400, configurable: true, writable: true })
    const seen = countListWheel()

    wheel(cell!, { deltaX: 120, deltaY: 0 })
    expect(seen).toHaveLength(1)
    expect(wrapper!.scrollLeft).toBe(400)
  })

  test('a wheel over plain text still reaches the list', () => {
    const seen = countListWheel()
    wheel(screen.getByText('before'), { deltaX: 0, deltaY: 120 })
    expect(seen).toHaveLength(1)
  })

  test('a sideways swipe over plain text stays with the list', () => {
    const seen = countListWheel()
    wheel(screen.getByText('before'), { deltaX: 120, deltaY: 0 })
    expect(seen).toHaveLength(1)
  })
})
