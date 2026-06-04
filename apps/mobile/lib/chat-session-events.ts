// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

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

const changeListeners = new Set<ChangeListener>()
const selectListeners = new Set<SelectListener>()
const newChatListeners = new Set<NewChatListener>()

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
    changeListeners.forEach((fn) => fn(event))
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
