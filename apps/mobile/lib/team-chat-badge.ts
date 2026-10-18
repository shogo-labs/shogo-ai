// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Unread team chat count for web and desktop: a "(3)" prefix on the tab
 * title, and the dock/taskbar badge in the Electron app.
 */

type DesktopBadgeBridge = {
  isDesktop?: boolean
  setBadgeCount?: (count: number) => Promise<{ ok?: boolean; reason?: string } | unknown>
}

const TITLE_PREFIX = /^\(\d+\+?\)\s/
let last = -1
/** The count the dock/taskbar icon is known to be showing. */
let lastApplied = -1
let titleObserver: MutationObserver | null = null

/**
 * A badge the OS refused must not be remembered. `last` used to be set before
 * the IPC call resolved, so one failed update froze the icon at a stale count
 * until the number happened to change again.
 */
function badgeApplied(result: unknown): boolean {
  if (result && typeof result === 'object' && 'ok' in result) {
    return (result as { ok?: unknown }).ok !== false
  }
  return true
}

function applyTitle(n: number): void {
  if (typeof document === 'undefined') return
  const base = document.title.replace(TITLE_PREFIX, '')
  const next = n ? `(${n > 99 ? '99+' : n}) ${base}` : base
  if (document.title !== next) document.title = next
}

/** Screens set their own titles; re-apply the prefix whenever the title changes. */
function watchTitle(): void {
  if (titleObserver || typeof document === 'undefined' || typeof MutationObserver === 'undefined') return
  const head = document.querySelector('head')
  if (!head) return
  titleObserver = new MutationObserver(() => {
    if (last > 0 && !TITLE_PREFIX.test(document.title)) applyTitle(last)
  })
  titleObserver.observe(head, { subtree: true, childList: true, characterData: true })
}

export function setChatBadgeCount(count: number): void {
  const n = Math.max(0, Math.floor(count))
  if (n !== last) {
    last = n
    watchTitle()
    applyTitle(n)
  }
  const desktop = typeof window !== 'undefined' ? (window as unknown as { shogoDesktop?: DesktopBadgeBridge }).shogoDesktop : undefined
  if (!desktop?.isDesktop || !desktop.setBadgeCount) return
  // Retry whenever the icon does not already show this count: `lastApplied`
  // only advances on a call the OS accepted, so a refused badge is re-sent on
  // the next update instead of leaving the icon stale.
  if (n === lastApplied) return
  void desktop
    .setBadgeCount(n)
    .then((result) => {
      if (badgeApplied(result)) lastApplied = n
    })
    .catch(() => {})
}
