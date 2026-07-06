// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { Platform } from 'react-native'

export type ChatSessionChange = {
  /** Project (context) the change belongs to. */
  projectId: string
  /** The session that should be treated as active after the change, if any. */
  activeSessionId?: string | null
  /** When true, listeners should re-fetch the project's chat list (a chat was
   *  created / renamed / deleted). When false/omitted it's an active-chat
   *  change only — update the highlight without a network round-trip. */
  refresh?: boolean
}

export type ChatSessionSelectRequest = {
  projectId: string
  sessionId: string
}

export type ChatSessionNewChatRequest = {
  projectId: string
}

type ChangeListener = (event: ChatSessionChange) => void
type SelectListener = (event: ChatSessionSelectRequest) => void
type NewChatListener = (event: ChatSessionNewChatRequest) => void

type CrossWindowChatSessionChange = ChatSessionChange & {
  eventId: string
  sourceId: string
  emittedAt: number
}

const changeListeners = new Set<ChangeListener>()
const selectListeners = new Set<SelectListener>()
const newChatListeners = new Set<NewChatListener>()

const CROSS_WINDOW_CHANGE_CHANNEL = 'shogo:chat-session-change'
const CROSS_WINDOW_STORAGE_KEY = 'shogo:last-chat-session-change'
const SOURCE_ID = `chat-${Date.now()}-${Math.random().toString(36).slice(2)}`
const seenCrossWindowEvents = new Set<string>()
let broadcastChannel: BroadcastChannel | null | undefined
let crossWindowListenerInstalled = false

function nextEventId(): string {
  return `evt-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function getBroadcastChannel(): BroadcastChannel | null {
  if (broadcastChannel !== undefined) return broadcastChannel
  if (
    Platform.OS !== 'web' ||
    typeof window === 'undefined' ||
    typeof globalThis.BroadcastChannel !== 'function'
  ) {
    broadcastChannel = null
    return broadcastChannel
  }
  try {
    broadcastChannel = new globalThis.BroadcastChannel(CROSS_WINDOW_CHANGE_CHANNEL)
  } catch {
    broadcastChannel = null
  }
  return broadcastChannel
}

function rememberCrossWindowEvent(eventId: string): boolean {
  if (!eventId) return false
  if (seenCrossWindowEvents.has(eventId)) return false
  seenCrossWindowEvents.add(eventId)
  if (seenCrossWindowEvents.size > 200) {
    const first = seenCrossWindowEvents.values().next().value
    if (first) seenCrossWindowEvents.delete(first)
  }
  return true
}

function isCrossWindowChatSessionChange(value: unknown): value is CrossWindowChatSessionChange {
  if (!value || typeof value !== 'object') return false
  const event = value as Partial<CrossWindowChatSessionChange>
  return (
    typeof event.eventId === 'string' &&
    typeof event.sourceId === 'string' &&
    typeof event.projectId === 'string'
  )
}

function notifyLocalListeners(event: ChatSessionChange): void {
  changeListeners.forEach((fn) => fn(event))
}

function receiveCrossWindowChange(value: unknown): void {
  if (!isCrossWindowChatSessionChange(value)) return
  if (value.sourceId === SOURCE_ID) return
  if (!rememberCrossWindowEvent(value.eventId)) return
  notifyLocalListeners({
    projectId: value.projectId,
    activeSessionId: value.activeSessionId,
    refresh: value.refresh,
  })
}

function installCrossWindowListener(): void {
  if (crossWindowListenerInstalled || Platform.OS !== 'web' || typeof window === 'undefined') return
  crossWindowListenerInstalled = true

  const channel = getBroadcastChannel()
  if (channel) {
    channel.addEventListener('message', (event) => receiveCrossWindowChange(event.data))
  }

  const maybeWindow = typeof window !== 'undefined' ? window : undefined
  maybeWindow?.addEventListener('storage', (event) => {
    if (event.key !== CROSS_WINDOW_STORAGE_KEY || !event.newValue) return
    try {
      receiveCrossWindowChange(JSON.parse(event.newValue))
    } catch {
      // Ignore malformed cross-window sync payloads.
    }
  })
}

function publishCrossWindowChange(event: ChatSessionChange): void {
  if (Platform.OS !== 'web') return

  const outbound: CrossWindowChatSessionChange = {
    ...event,
    eventId: nextEventId(),
    sourceId: SOURCE_ID,
    emittedAt: Date.now(),
  }
  rememberCrossWindowEvent(outbound.eventId)

  getBroadcastChannel()?.postMessage(outbound)

  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      window.localStorage.setItem(CROSS_WINDOW_STORAGE_KEY, JSON.stringify(outbound))
    }
  } catch {
    // localStorage is a best-effort fallback for windows without BroadcastChannel.
  }
}

installCrossWindowListener()

/**
 * Lightweight pub/sub bridging the project workspace and the AppSidebar (the
 * permanent home for chats) without coupling them through shared MobX state or
 * the URL.
 *
 *  - `subscribe` / `emit`: workspace -> sidebar. Refresh the project's chat
 *    list and/or re-highlight the active chat.
 *  - `subscribeSelect` / `requestSelect`: sidebar -> workspace. Ask the
 *    already-mounted project workspace to switch chats IN PLACE (no
 *    navigation, no remount) when the project is already open.
 *  - `subscribeNewChat` / `requestNewChat`: sidebar -> workspace. Ask the
 *    already-mounted project workspace to create a fresh chat (reusing its
 *    canonical creation logic) when the project is already open.
 */
export const chatSessionEvents = {
  subscribe(fn: ChangeListener) {
    changeListeners.add(fn)
    return () => {
      changeListeners.delete(fn)
    }
  },

  emit(event: ChatSessionChange) {
    notifyLocalListeners(event)
    publishCrossWindowChange(event)
  },

  subscribeSelect(fn: SelectListener) {
    selectListeners.add(fn)
    return () => {
      selectListeners.delete(fn)
    }
  },

  requestSelect(event: ChatSessionSelectRequest) {
    selectListeners.forEach((fn) => fn(event))
  },

  subscribeNewChat(fn: NewChatListener) {
    newChatListeners.add(fn)
    return () => {
      newChatListeners.delete(fn)
    }
  },

  requestNewChat(event: ChatSessionNewChatRequest) {
    newChatListeners.forEach((fn) => fn(event))
  },
}

export type ChatActivityEvent = {
  /** Project (context) the activity belongs to. */
  projectId: string
  /** Session ids whose stream is currently running. */
  streamingSessionIds: string[]
  /** Session ids that finished streaming but haven't been viewed yet. */
  completedSessionIds: string[]
}

type ActivityListener = (event: ChatActivityEvent) => void

const activityListeners = new Set<ActivityListener>()

/**
 * Separate channel from `chatSessionEvents` for high-frequency streaming
 * updates. The project workspace broadcasts which of its chats are streaming
 * / have new activity so the AppSidebar can mirror the spinner + activity dot
 * without re-fetching the chat list on every stream tick (which is why this
 * is decoupled from the create / rename / delete refresh events above).
 */
export const chatActivityEvents = {
  subscribe(fn: ActivityListener) {
    activityListeners.add(fn)
    return () => {
      activityListeners.delete(fn)
    }
  },

  emit(event: ChatActivityEvent) {
    activityListeners.forEach((fn) => fn(event))
  },
}
