// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * `TeamChatNotifier`: the message cue plays for every notification that isn't
 * on screen, with or without banner permission, and respects the person's
 * message sound setting. The real sound engine runs against a fake
 * AudioContext.
 */
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { cleanup, render, waitFor } from '@testing-library/react'
import { createReactNativeMock } from '../../../test/react-native-mock'

const dir = import.meta.dir
const from = (rel: string) => resolve(dir, rel)

mock.module('react-native', () =>
  createReactNativeMock({ Platform: { OS: 'web', select: (o: any) => o.web ?? o.default } }),
)

let eventHandler: ((event: any) => void) | null = null
let activeConversation: string | null = null
let settingsState: { messageSound: 'default' | 'subtle' | 'off' } | null = { messageSound: 'default' }
let inactive = false
const notified: any[] = []
const attentionRequests: unknown[] = []

mock.module(from('../../../hooks/useActiveWorkspace'), () => ({
  useActiveWorkspace: () => ({ id: 'ws-1', name: 'Acme' }),
}))
mock.module(from('../../../hooks/useWorkspaceExperience'), () => ({
  useWorkspaceExperience: () => ({ kind: 'team', resolved: true }),
}))
mock.module(from('../../../hooks/useWorkspaceChatMode'), () => ({
  useWorkspaceChatMode: () => ({ config: { mode: 'chat' } }),
}))
mock.module(from('../../../hooks/useTeamChat'), () => ({
  useActiveConversationId: () => activeConversation,
}))
mock.module(from('../../../hooks/useChatPrefs'), () => ({
  useChatSettings: () => ({ settings: settingsState }),
}))
mock.module(from('../../../lib/team-chat-connection'), () => ({
  useTeamChatEvents: (_workspaceId: string | null, cb: (event: any) => void) => {
    eventHandler = cb
  },
}))
mock.module(from('../../../lib/team-chat-api'), () => ({
  nativeChatVisible: () => true,
}))
mock.module(from('../../../lib/notifications/chat-notifier'), () => ({
  isUserInactive: async () => inactive,
  notifyChannelMessage: async (payload: unknown) => {
    notified.push(payload)
  },
  requestAttention: async (reason: unknown) => {
    attentionRequests.push(reason)
  },
}))

class FakeOscillator {
  type = 'sine'
  frequency = { value: 0 }
  connect(node: unknown) {
    return node
  }
  start() {}
  stop() {}
}
class FakeGain {
  gain = {
    setValueAtTime: () => {},
    linearRampToValueAtTime: () => {},
    exponentialRampToValueAtTime: () => {},
  }
  connect(node: unknown) {
    return node
  }
}
class FakeAudioContext {
  static instances: FakeAudioContext[] = []
  state: 'suspended' | 'running' = 'suspended'
  currentTime = 0
  destination = {}
  oscillators = 0
  constructor() {
    FakeAudioContext.instances.push(this)
  }
  resume() {
    this.state = 'running'
    return Promise.resolve()
  }
  createOscillator() {
    this.oscillators += 1
    return new FakeOscillator()
  }
  createGain() {
    return new FakeGain()
  }
}

// Keep the real window (Testing Library needs its document) and only add the
// fake AudioContext to it.
const win = (globalThis as any).window
const hadAudioContext = 'AudioContext' in win

function installWindow() {
  win.AudioContext = FakeAudioContext
}

function uninstallWindow() {
  if (!hadAudioContext) delete win.AudioContext
}

function playedCues(): number {
  return FakeAudioContext.instances.reduce((n, ctx) => n + ctx.oscillators, 0)
}

const { TeamChatNotifier } = await import('../TeamChatNotifier')
const { _resetNotificationAudioForTests } = await import('../../../lib/notification-sound')

const dmEvent = {
  type: 'notification',
  conversationId: 'c-ada',
  messageId: 'm-1',
  threadRootId: null,
  reason: 'dm',
  title: 'Ada',
  body: 'are you free?',
}

beforeEach(() => {
  FakeAudioContext.instances = []
  notified.length = 0
  attentionRequests.length = 0
  eventHandler = null
  activeConversation = null
  settingsState = { messageSound: 'default' }
  inactive = false
  installWindow()
  _resetNotificationAudioForTests()
})

afterEach(() => {
  cleanup()
  uninstallWindow()
})

function unlockAudio() {
  win.dispatchEvent(new Event('pointerdown'))
}

describe('TeamChatNotifier message sound', () => {
  test('an off-screen message plays the cue and keeps the OS alert silent', async () => {
    render(<TeamChatNotifier />)
    unlockAudio()
    eventHandler!(dmEvent)
    await waitFor(() => expect(notified).toHaveLength(1))
    expect(playedCues()).toBeGreaterThan(0)
    expect(notified[0]).toMatchObject({ conversationId: 'c-ada', messageId: 'm-1', silent: true })
  })

  test('the cue plays even when the OS banner would not show', async () => {
    // Banner permission is handled inside notifyChannelMessage; the cue must not depend on it.
    render(<TeamChatNotifier />)
    unlockAudio()
    eventHandler!({ ...dmEvent, conversationId: 'c-other' })
    await waitFor(() => expect(notified).toHaveLength(1))
    expect(playedCues()).toBeGreaterThan(0)
  })

  test('no cue and no alert for the conversation on screen in a focused window', async () => {
    activeConversation = 'c-ada'
    render(<TeamChatNotifier />)
    unlockAudio()
    eventHandler!(dmEvent)
    await new Promise((r) => setTimeout(r, 10))
    expect(notified).toHaveLength(0)
    expect(playedCues()).toBe(0)
  })

  test('an open conversation in a window that is not focused still alerts', async () => {
    activeConversation = 'c-ada'
    inactive = true
    render(<TeamChatNotifier />)
    unlockAudio()
    eventHandler!(dmEvent)
    await waitFor(() => expect(notified).toHaveLength(1))
    expect(playedCues()).toBeGreaterThan(0)
  })

  test('message sound off: the alert still shows, but nothing plays', async () => {
    settingsState = { messageSound: 'off' }
    render(<TeamChatNotifier />)
    unlockAudio()
    eventHandler!(dmEvent)
    await waitFor(() => expect(notified).toHaveLength(1))
    expect(playedCues()).toBe(0)
    expect(notified[0].silent).toBe(false)
  })

  test('a cue is not played before the first user gesture', async () => {
    render(<TeamChatNotifier />)
    eventHandler!(dmEvent)
    await waitFor(() => expect(notified).toHaveLength(1))
    expect(playedCues()).toBe(0)
    expect(notified[0].silent).toBe(false)
  })

  test('an off-screen message asks for attention with its reason, and the reason title is passed on', async () => {
    render(<TeamChatNotifier />)
    unlockAudio()
    eventHandler!(dmEvent)
    await waitFor(() => expect(notified).toHaveLength(1))
    expect(attentionRequests).toEqual(['dm'])
    expect(notified[0]).toMatchObject({ reason: 'dm' })
  })

  test('the conversation on screen in a focused window does not ask for attention', async () => {
    activeConversation = 'c-ada'
    render(<TeamChatNotifier />)
    eventHandler!(dmEvent)
    await new Promise((r) => setTimeout(r, 10))
    expect(attentionRequests).toHaveLength(0)
  })
})
