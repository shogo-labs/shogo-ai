// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Web + Electron chat-completion notifier.
 *
 * Runs inside the Expo web export, which serves both the browser web build
 * and the Electron desktop renderer. Desktop is detected via
 * `window.shogoDesktop`; the rest falls back to the Web Notification API.
 */

import type {
  ChannelNotificationPayload,
  ChatNotificationClickData,
  ChatNotificationPayload,
  NotificationPermissionState,
} from './chat-notifier'
import { alertTagFor, alertTitleFor, type ChatAlertReason } from './alert-title'
import { readDeviceAlertPrefs, type DockBounce } from './device-alert-prefs'

/** Reasons that ask for attention. Replies and mentions get the same nudge as a DM. */
const ATTENTION_REASONS = new Set<string>(['dm', 'mention', 'broadcast', 'thread'])

/**
 * Desktop only: bounces the dock icon (macOS) or flashes the taskbar button
 * (Windows) when a message arrives while the window is in the background.
 * The main process checks focus again before it asks for attention.
 */
export async function requestAttention(reason: ChatAlertReason | null | undefined): Promise<void> {
  const desktop = getDesktop()
  if (!desktop?.requestAttention) return
  if (!reason || !ATTENTION_REASONS.has(reason)) return
  const prefs = readDeviceAlertPrefs()
  try {
    await desktop.requestAttention({ dockBounce: prefs.dockBounce, flashTaskbar: prefs.flashTaskbar })
  } catch {
    // Best-effort: a missing attention request is not an error.
  }
}

type ShogoDesktopBridge = {
  isDesktop?: boolean
  requestAttention?: (args: { dockBounce: DockBounce; flashTaskbar: boolean }) => Promise<{ ok: boolean; attention?: boolean }>
  showChatNotification?: (args: {
    title: string
    body: string
    sessionId: string
    projectId: string
  }) => Promise<void>
  onNotificationClicked?: (cb: (data: ChatNotificationClickData) => void) => void
  removeNotificationClickedListener?: () => void
  isWindowFocused?: () => Promise<boolean>
}

function getDesktop(): ShogoDesktopBridge | null {
  if (typeof window === 'undefined') return null
  const d = (window as unknown as { shogoDesktop?: ShogoDesktopBridge }).shogoDesktop
  return d && d.isDesktop ? d : null
}

export async function isUserInactive(): Promise<boolean> {
  if (typeof document === 'undefined') return false
  if (document.hidden) return true
  const desktop = getDesktop()
  if (desktop?.isWindowFocused) {
    try {
      const focused = await desktop.isWindowFocused()
      return !focused
    } catch {
      // fall through to hasFocus
    }
  }
  try {
    return !document.hasFocus()
  } catch {
    return false
  }
}

function toState(permission: NotificationPermission): NotificationPermissionState {
  if (permission === 'granted') return 'granted'
  if (permission === 'denied') return 'denied'
  return 'prompt'
}

/**
 * Only reports whether alerts can show. It never asks: browsers ignore or
 * hide a permission prompt that isn't triggered by a click, so asking is
 * left to `requestNotificationPermissionFromGesture`.
 */
export async function ensureNotificationPermission(): Promise<boolean> {
  // On desktop, the OS handles permissions; Electron's Notification API
  // doesn't require a browser-style permission prompt.
  if (getDesktop()) return true
  if (typeof window === 'undefined' || typeof Notification === 'undefined') return false
  return Notification.permission === 'granted'
}

export function subscribeNotificationPermissionGranted(_listener: () => void): () => void {
  return () => {}
}

export async function getNotificationPermissionState(): Promise<NotificationPermissionState> {
  if (getDesktop()) return 'granted'
  if (typeof window === 'undefined' || typeof Notification === 'undefined') return 'unsupported'
  return toState(Notification.permission)
}

export async function requestNotificationPermissionFromGesture(): Promise<NotificationPermissionState> {
  if (getDesktop()) return 'granted'
  if (typeof window === 'undefined' || typeof Notification === 'undefined') return 'unsupported'
  if (Notification.permission !== 'default') return toState(Notification.permission)
  try {
    return toState(await Notification.requestPermission())
  } catch {
    return toState(Notification.permission)
  }
}

export function setActiveChatNotificationContext(
  _context: { sessionId: string; projectId: string } | null,
): void {
  // Web notifications are already gated by the existing active-window logic.
}

// Module-level bus for browser-side click delivery. The Web Notification API
// only surfaces click via the Notification instance's `onclick`; we normalise
// that into the same `subscribeNotificationClicks` channel as Electron.
const clickListeners = new Set<(d: ChatNotificationClickData) => void>()

function fireClick(data: ChatNotificationClickData) {
  for (const cb of clickListeners) {
    try {
      cb(data)
    } catch {
      // ignore subscriber errors
    }
  }
}

export async function notifyChatFinished(p: ChatNotificationPayload): Promise<void> {
  const desktop = getDesktop()
  if (desktop?.showChatNotification) {
    try {
      await desktop.showChatNotification({
        title: p.title,
        body: p.preview,
        sessionId: p.sessionId,
        projectId: p.projectId,
      })
    } catch {
      // swallow — notifications are best-effort
    }
    return
  }

  if (typeof window === 'undefined' || typeof Notification === 'undefined') return
  if (Notification.permission !== 'granted') return

  try {
    const n = new Notification(p.title, {
      body: p.preview,
      tag: p.sessionId,
      data: { sessionId: p.sessionId, projectId: p.projectId },
    })
    n.onclick = () => {
      try {
        window.focus()
      } catch {
        // ignore
      }
      fireClick({ sessionId: p.sessionId, projectId: p.projectId })
      try {
        n.close()
      } catch {
        // ignore
      }
    }
  } catch {
    // e.g. Notification constructor forbidden on mobile Safari
  }
}

export function setActiveChannelNotificationContext(_conversationId: string | null): void {
  // The caller already skips the conversation on screen.
}

/** Channel alerts use the Web Notification API, which Electron's renderer also provides. */
export async function notifyChannelMessage(p: ChannelNotificationPayload): Promise<void> {
  if (typeof window === 'undefined' || typeof Notification === 'undefined') return
  if (!getDesktop() && Notification.permission !== 'granted') return
  try {
    // Same tag for a thread, with `renotify`: each new reply re-alerts and
    // replaces the previous banner instead of being dropped as a duplicate.
    // `renotify` is in every browser but missing from the DOM typings, hence the widened type.
    const options: NotificationOptions & { renotify: boolean } = {
      body: p.body,
      tag: alertTagFor(p),
      renotify: true,
      silent: p.silent === true,
    }
    const n = new Notification(alertTitleFor(p.reason, p.title), options)
    n.onclick = () => {
      try {
        window.focus()
      } catch {
        // ignore
      }
      fireClick({ conversationId: p.conversationId, threadRootId: p.threadRootId })
      try {
        n.close()
      } catch {
        // ignore
      }
    }
  } catch {
    // e.g. Notification constructor forbidden on mobile Safari
  }
}

export function subscribeNotificationClicks(
  cb: (d: ChatNotificationClickData) => void,
): () => void {
  clickListeners.add(cb)

  const desktop = getDesktop()
  if (desktop?.onNotificationClicked) {
    desktop.onNotificationClicked(cb)
    return () => {
      clickListeners.delete(cb)
      try {
        desktop.removeNotificationClickedListener?.()
      } catch {
        // ignore
      }
    }
  }

  return () => {
    clickListeners.delete(cb)
  }
}

export async function consumeColdStartNotification(): Promise<ChatNotificationClickData | null> {
  return null
}
