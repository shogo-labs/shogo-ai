// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Auto-open policy for a folder-linked project's Preview tab (SHO-200).
 *
 * The project layout brings Preview forward when a dev server for the folder
 * appears. Russell's report: it kept popping up while nobody was editing code,
 * because the detected URL flaps (a fixture server starts and exits, a probe
 * times out, a second server appears, the dev server restarts) and the old
 * effect treated any change of that string — including a change back to `null`
 * — as a fresh "server started".
 *
 * The rules, as product behaviour:
 *   1. Open at most **once per project per page session**, and only on a real
 *      off → on transition. "Off" means no URL for a sustained grace period
 *      (not a single missed poll), so a restart, a slow compile, or a second
 *      URL can never re-open it.
 *   2. User intent wins, and it is remembered across reloads. Once the user
 *      has picked a tab for this project, the auto-open never fires again.
 *   3. Only the tab switch is gated. The address bar and the empty-state chip
 *      keep following the detected URL as they always did.
 *
 * The state machine lives here rather than inline in `_layout.tsx` so it can be
 * tested without mounting a 5,700-line screen (same split as `preview-gate.ts`
 * and `project-preview-tab.ts`).
 */

/** How long a project must show no detected URL before the next one is a start. */
export const PREVIEW_AUTO_OPEN_GRACE_MS = 30_000

/**
 * AsyncStorage key for "the user chose this project's tab themselves". Its
 * presence means the auto-open is off for that project for good (S5: a reload
 * must not re-pop Preview over the tab the user left the project on).
 */
export const PREVIEW_TAB_USER_PICK_PREFIX = 'shogo:previewTabUserPicked:'

export function previewTabUserPickKey(projectId: string): string {
  return `${PREVIEW_TAB_USER_PICK_PREFIX}${projectId}`
}

export type AutoOpenReason =
  | 'no-project'
  | 'not-external'
  | 'phone-layout'
  | 'ide-chat-embed'
  | 'not-desktop-shell'
  | 'tab-not-restored'
  | 'user-picked'
  | 'already-opened'
  | 'no-url'
  | 'url-changed'
  | 'opened'

export interface AutoOpenDecision {
  open: boolean
  reason: AutoOpenReason
  /** True when this observation saw the URL come back after the grace window. */
  transition: boolean
}

interface ProjectState {
  /** Last time a URL was observed for this project (ms epoch). */
  lastOnAt: number | null
  /** Latched on the first open — one auto-open per project per page session. */
  opened: boolean
}

export class PreviewAutoOpenTracker {
  private readonly state = new Map<string, ProjectState>()

  observe(projectId: string, detectedUrl: string | null, now: number): AutoOpenDecision {
    const st = this.state.get(projectId) ?? { lastOnAt: null, opened: false }
    this.state.set(projectId, st)

    if (!detectedUrl) {
      // A missing URL is not "the server stopped" — only time is. `lastOnAt`
      // keeps its value so the next observation can measure the gap.
      return { open: false, reason: 'no-url', transition: false }
    }

    const transition =
      st.lastOnAt === null || now - st.lastOnAt >= PREVIEW_AUTO_OPEN_GRACE_MS
    st.lastOnAt = now

    if (st.opened) return { open: false, reason: 'already-opened', transition }
    // Same server, different URL (a second listener appeared / a port moved).
    if (!transition) return { open: false, reason: 'url-changed', transition: false }

    st.opened = true
    return { open: true, reason: 'opened', transition: true }
  }

  /** Drop the latch for one project (tests, and a project whose folder changed). */
  reset(projectId?: string): void {
    if (projectId === undefined) this.state.clear()
    else this.state.delete(projectId)
  }
}

/** One tracker per JS session: navigating away and back must not re-open. */
export const previewAutoOpenTracker = new PreviewAutoOpenTracker()

export interface AutoOpenInput {
  projectId: string | null
  isExternalProject: boolean
  phoneLayout: boolean
  isIdeChatEmbed: boolean
  /** `window.shogoDesktop?.preview` exists — the embedded webview is available. */
  isDesktopShell: boolean
  /** The project whose tab has finished restoring (`previewTabRestoredFor`). */
  restoredFor: string | null
  /** The user picked a tab for this project (this session, or a past one). */
  userPicked: boolean
  detectedUrl: string | null
  now: number
  tracker?: PreviewAutoOpenTracker
}

/**
 * The whole decision the project layout makes before it calls
 * `setPreviewTab('external-preview')`.
 */
export function decideAutoOpenPreview(input: AutoOpenInput): AutoOpenDecision {
  if (!input.projectId) return { open: false, reason: 'no-project', transition: false }
  if (!input.isExternalProject) return { open: false, reason: 'not-external', transition: false }
  if (input.phoneLayout) return { open: false, reason: 'phone-layout', transition: false }
  if (input.isIdeChatEmbed) return { open: false, reason: 'ide-chat-embed', transition: false }
  if (!input.isDesktopShell) return { open: false, reason: 'not-desktop-shell', transition: false }
  if (input.restoredFor !== input.projectId) {
    return { open: false, reason: 'tab-not-restored', transition: false }
  }
  if (input.userPicked) return { open: false, reason: 'user-picked', transition: false }
  const tracker = input.tracker ?? previewAutoOpenTracker
  return tracker.observe(input.projectId, input.detectedUrl, input.now)
}
