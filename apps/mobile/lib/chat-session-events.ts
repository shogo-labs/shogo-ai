// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { Platform } from 'react-native'

export type ChatSessionChange = {
  /** Project (context) the change belongs to, when project-scoped. */
  projectId?: string
  /** Workspace (context) the change belongs to, when workspace-scoped. */
  workspaceId?: string
  /** The session that should be treated as active after the change, if any. */
  activeSessionId?: string | null
  /** When true, listeners should re-fetch the relevant chat list (a chat was
   *  created / renamed / deleted). When false/omitted it's an active-chat
   *  change only — update the highlight without a network round-trip. */
  refresh?: boolean
  /** The chat whose row should read "now" right away — a send, mirrored from
   *  the screen that sent it. List rows re-sort from it without any re-fetch. */
  touchedSessionId?: string
  /** Epoch ms for `touchedSessionId`'s row. */
  lastActiveAt?: number
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
    (typeof event.projectId === 'string' ||
      typeof event.workspaceId === 'string' ||
      typeof event.touchedSessionId === 'string')
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
    workspaceId: value.workspaceId,
    activeSessionId: value.activeSessionId,
    refresh: value.refresh,
    touchedSessionId: value.touchedSessionId,
    lastActiveAt: value.lastActiveAt,
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
 *  - `subscribe` / `emit`: workspace -> sidebar. Refresh the relevant chat
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

/**
 * Exactly one scope id is set: a project workspace emits `projectId`, the
 * workspace agent emits `workspaceId`. Listeners ignore events for a scope
 * they do not own.
 */
export type ChatActivityEvent = {
  /** Project (context) the activity belongs to, for project chats. */
  projectId?: string
  /** Workspace (context) the activity belongs to, for workspace-agent chats. */
  workspaceId?: string
  /** Session ids whose stream is currently running. */
  streamingSessionIds: string[]
  /** Session ids that finished streaming but haven't been viewed yet. */
  completedSessionIds: string[]
  /**
   * Sessions whose turn this publisher watched end — a real transition, never a
   * chat switch or an unmount. It lets a list stop that row's spinner at once
   * instead of waiting for the next server poll. Additive by design: the
   * snapshot arrays above can go blank when the publisher resets (you switch
   * chats), and blank must never mean "everything finished".
   */
  finishedSessionIds?: string[]
}

type ActivityListener = (event: ChatActivityEvent) => void

const activityListeners = new Set<ActivityListener>()
/** Last published snapshot per scope (`workspace:<id>` / `project:<id>`). */
const lastActivityByScope = new Map<string, ChatActivityEvent>()

function activityScopeKey(event: ChatActivityEvent): string | null {
  if (event.workspaceId) return `workspace:${event.workspaceId}`
  if (event.projectId) return `project:${event.projectId}`
  return null
}

function isEmptySnapshot(event: ChatActivityEvent): boolean {
  return (
    event.streamingSessionIds.length === 0 &&
    event.completedSessionIds.length === 0 &&
    (event.finishedSessionIds?.length ?? 0) === 0
  )
}

/**
 * Separate channel from `chatSessionEvents` for high-frequency streaming
 * updates. The project workspace broadcasts which of its chats are streaming
 * / have new activity so the AppSidebar can mirror the spinner + activity dot
 * without re-fetching the chat list on every stream tick (which is why this
 * is decoupled from the create / rename / delete refresh events above).
 *
 * The last snapshot per scope is remembered and replayed to a new subscriber,
 * so a list that mounts mid-turn (opening the chats tab while a turn runs, or
 * opening a second window) paints the spinner immediately instead of waiting
 * for the publisher's next tick — which, for a chat that is already streaming,
 * may never come.
 */
export const chatActivityEvents = {
  subscribe(fn: ActivityListener) {
    activityListeners.add(fn)
    lastActivityByScope.forEach((event) => fn({ ...event }))
    return () => {
      activityListeners.delete(fn)
    }
  },

  emit(event: ChatActivityEvent) {
    const scope = activityScopeKey(event)
    if (scope) {
      // Replay remembers the *snapshot*, never the one-shot finish signal: a
      // subscriber mounting later must learn what is running, not be told a
      // turn ended. An all-empty emit drops the slot so the next subscriber
      // doesn't inherit a stale spinner.
      const snapshot: ChatActivityEvent = {
        projectId: event.projectId,
        workspaceId: event.workspaceId,
        streamingSessionIds: event.streamingSessionIds,
        completedSessionIds: event.completedSessionIds,
      }
      if (isEmptySnapshot(snapshot)) lastActivityByScope.delete(scope)
      else lastActivityByScope.set(scope, snapshot)
    }
    activityListeners.forEach((fn) => fn(event))
  },
}
