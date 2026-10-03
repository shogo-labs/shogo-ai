// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Unread team chat count for web and desktop: a "(3)" prefix on the tab
 * title, and the dock/taskbar badge in the Electron app.
 */

type DesktopBadgeBridge = { isDesktop?: boolean; setBadgeCount?: (count: number) => Promise<unknown> }

const TITLE_PREFIX = /^\(\d+\+?\)\s/
let last = -1
let titleObserver: MutationObserver | null = null

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
  if (n === last) return
  last = n
  watchTitle()
  applyTitle(n)
  const desktop = typeof window !== 'undefined' ? (window as unknown as { shogoDesktop?: DesktopBadgeBridge }).shogoDesktop : undefined
  if (desktop?.isDesktop && desktop.setBadgeCount) void desktop.setBadgeCount(n).catch(() => {})
}
