// SPDX-License-Identifier: AGPL-3.0-or-later
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

export interface ChatNotificationClickData {
  sessionId: string
  projectId: string
}

export async function isUserInactive(): Promise<boolean> {
  return false
}

export async function ensureNotificationPermission(): Promise<boolean> {
  return false
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
