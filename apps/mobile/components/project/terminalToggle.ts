// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Pure decision function for the Terminal top-tab → IDE bottom drawer toggle.
 *
 * Lives outside ProjectTopBar.tsx so it can be unit-tested without spinning up
 * React / RNW / happy-dom. The component is the *executor*: it reads state,
 * calls this helper, then applies the returned action to the store and the
 * parent-supplied callbacks.
 *
 * Three sources of truth need to agree before the drawer becomes visible
 * (mirroring DrawerHost#shouldShowDrawer):
 *   • store-open       — user has opened the drawer at least once.
 *   • web platform     — drawer is web-only.
 *   • !canvasAreaHidden — layout has actually given the canvas pane room
 *                         (false in narrow chat-only mode and chat-fullscreen).
 *
 * Behavior contract enforced by this helper (also covered by tests):
 *   1. Click while the drawer is *visible*  ⇒ close (and remember sub-tab).
 *   2. Click while the drawer is store-open but hidden by layout
 *                                          ⇒ reveal (NOT close — fixes the
 *                                            "click closes a drawer I can't
 *                                            see" footgun).
 *   3. Click while the drawer is closed     ⇒ open. If we have a remembered
 *                                            sub-tab from a previous toggle,
 *                                            restore it; otherwise land on
 *                                            'Terminal' (cold-start UX).
 *   4. When revealing from chat-fullscreen on wide, prefer the user's last
 *      non-fullscreen preview tab over a hard-coded 'dynamic-app'.
 *   5. When revealing on narrow, swap narrow active to 'canvas' so the drawer
 *      has a host pane to render into.
 */
import {
  BOTTOM_PANEL_TABS,
  type BottomPanelTab,
} from '../../lib/ide-bottom-panel-store'

export interface TerminalToggleInput {
  /** `ideBottomPanelStore.open` at click time. */
  storeOpen: boolean
  /** `ideBottomPanelStore.activeTab` at click time. */
  storeActiveSubTab: BottomPanelTab
  /** Result of `Platform.OS === 'web'`. */
  isWeb: boolean
  /** Mirrors layout `canvasAreaHidden`. */
  canvasAreaHidden: boolean
  /** True iff `onNarrowTabChange` is wired (i.e. we're in narrow layout). */
  isNarrow: boolean
  /** Current `activeTab` prop (i.e. `previewTab` from the parent). */
  activeTab: string | undefined
  /** Last sub-tab the user had selected before the previous toggle-close. */
  lastSubTab: BottomPanelTab | null
  /** Last non-fullscreen preview tab — used as the restore target. */
  lastNonFullscreenPreview: string
}

export type TerminalToggleAction =
  | {
      kind: 'close'
      /** Sub-tab to stash so the next reveal can restore it. */
      rememberSubTab: BottomPanelTab
    }
  | {
      kind: 'open'
      /** If set, parent should call `onNarrowTabChange(narrowTo)` first. */
      narrowTo?: 'canvas'
      /** If set, parent should call `onTabChange(previewTo)` first. */
      previewTo?: string
      /** If set, parent should call `setActiveTab(setSubTab)` before opening.
       *  Omitted when revealing a store-open-but-hidden drawer (the user's
       *  current sub-tab selection is preserved). */
      setSubTab?: BottomPanelTab
    }

function isKnownSubTab(t: unknown): t is BottomPanelTab {
  return (
    typeof t === 'string' && (BOTTOM_PANEL_TABS as readonly string[]).includes(t)
  )
}

export function decideTerminalToggleAction(
  i: TerminalToggleInput,
): TerminalToggleAction {
  const drawerVisible = i.isWeb && !i.canvasAreaHidden

  // (1) Drawer on screen → close. Stash the user's current sub-tab so the
  // next click can restore it.
  if (i.storeOpen && drawerVisible) {
    return { kind: 'close', rememberSubTab: i.storeActiveSubTab }
  }

  // (2) Drawer store-open but hidden by layout → reveal. Do NOT overwrite
  // the user's current sub-tab; just bring the layout back into a state
  // where the existing drawer is visible.
  if (i.storeOpen && !drawerVisible) {
    return {
      kind: 'open',
      narrowTo: i.isNarrow ? 'canvas' : undefined,
      previewTo:
        !i.isNarrow && i.activeTab === 'chat-fullscreen'
          ? i.lastNonFullscreenPreview
          : undefined,
      // setSubTab intentionally omitted — store.activeTab already correct.
    }
  }

  // (3) Drawer closed → open. Restore last sub-tab if we have one (and it's
  // still a valid value), else fall back to 'Terminal' for the cold start.
  const subTab: BottomPanelTab = isKnownSubTab(i.lastSubTab)
    ? i.lastSubTab
    : 'Terminal'

  return {
    kind: 'open',
    narrowTo: i.isNarrow ? 'canvas' : undefined,
    previewTo:
      !i.isNarrow && i.activeTab === 'chat-fullscreen'
        ? i.lastNonFullscreenPreview
        : undefined,
    setSubTab: subTab,
  }
}
