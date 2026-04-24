// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Web + Electron chat-completion notifier.
 *
 * Runs inside the Expo web export, which serves both the browser web build
 * and the Electron desktop renderer. Desktop is detected via
 * `window.shogoDesktop`; the rest falls back to the Web Notification API.
 */

import type {
  ChatNotificationClickData,
  ChatNotificationPayload,
} from './chat-notifier'

type ShogoDesktopBridge = {
  isDesktop?: boolean
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

let permissionCache: NotificationPermission | null = null

export async function ensureNotificationPermission(): Promise<boolean> {
  // On desktop, the OS handles permissions; Electron's Notification API
  // doesn't require a browser-style permission prompt.
  if (getDesktop()) return true
  if (typeof window === 'undefined' || typeof Notification === 'undefined') return false
  if (permissionCache === null) permissionCache = Notification.permission
  if (permissionCache === 'granted') return true
  if (permissionCache === 'denied') return false
  try {
    permissionCache = await Notification.requestPermission()
  } catch {
    return false
  }
  return permissionCache === 'granted'
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
