// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Cross-platform chat-completion notifier.
 *
 * This file is the shared interface. Metro picks one of the following
 * platform-extension implementations at bundle time:
 *   - chat-notifier.web.ts     (browser + Electron)
 *   - chat-notifier.native.ts  (iOS / Android)
 *
 * The file you are reading now is a safe fallback / TypeScript surface only —
 * it should never actually load at runtime because every platform has a
 * matching extension file.
 */

export interface ChatNotificationPayload {
  sessionId: string
  projectId: string
  title: string
  preview: string
}

export type ChatNotificationClickData =
  | { taskId: string; sessionId?: string; projectId?: string; conversationId?: undefined }
  | { sessionId: string; projectId: string; taskId?: string; conversationId?: undefined }
  | { conversationId: string; threadRootId?: string | null; taskId?: undefined }
  /** A tap on the agents notification: open that agent (`shogo://agents/<key>`). */
  | { agentKey: string; conversationId?: undefined; taskId?: undefined }

export interface ChannelNotificationPayload {
  conversationId: string
  messageId: string
  threadRootId: string | null
  title: string
  body: string
}

export async function notifyChannelMessage(_p: ChannelNotificationPayload): Promise<void> {
  // no-op fallback
}

export function setActiveChannelNotificationContext(_conversationId: string | null): void {
  // no-op fallback
}

export async function isUserInactive(): Promise<boolean> {
  return false
}

export async function ensureNotificationPermission(): Promise<boolean> {
  return false
}

/**
 * `prompt` means asking will show the system prompt; `denied` means only the
 * browser or OS settings can turn notifications back on.
 */
export type NotificationPermissionState = 'granted' | 'prompt' | 'denied' | 'unsupported'

export async function getNotificationPermissionState(): Promise<NotificationPermissionState> {
  return 'unsupported'
}

/** Native only: called when notification permission becomes granted. */
export function subscribeNotificationPermissionGranted(_listener: () => void): () => void {
  return () => {}
}

/** Browsers only show the prompt when this runs inside a click handler. */
export async function requestNotificationPermissionFromGesture(): Promise<NotificationPermissionState> {
  return 'unsupported'
}

export function setActiveChatNotificationContext(
  _context: { sessionId: string; projectId: string } | null,
): void {
  // no-op fallback
}

export async function notifyChatFinished(_p: ChatNotificationPayload): Promise<void> {
  // no-op fallback
}

export function subscribeNotificationClicks(
  _cb: (d: ChatNotificationClickData) => void,
): () => void {
  return () => {}
}

export async function consumeColdStartNotification(): Promise<ChatNotificationClickData | null> {
  return null
}
