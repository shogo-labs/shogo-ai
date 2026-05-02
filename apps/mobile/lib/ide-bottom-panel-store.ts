// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Project-wide store for the IDE bottom drawer (Terminal / Problems /
 * Output). Lifted out of `Workbench.tsx` so the drawer can be mounted
 * once at the `ProjectLayout` level and survive previewTab changes.
 *
 * Module-level mutable state is intentional: we want `⌘J` pressed
 * inside Workbench to toggle the same drawer that `ProjectLayout` is
 * rendering, without prop-drilling. React subscribers use
 * `useSyncExternalStore`. State persists to `localStorage` with the
 * existing keys so users keep their preferences after the refactor.
 *
 *   - `shogo.ide.bottomPanelOpen` (bool)
 *   - `shogo.ide.bottomPanelSize` (number, clamped 120…600)
 *   - `shogo.ide.bottomPanelTab`  (Terminal | Problems | Output)
 *
 * `unseenErrorsByProject` and `autoOpenedByProject` are *not* persisted —
 * they're a per-tab session signal that should reset on reload.
 *
 * Size and open state are tested before any React wiring exists; see
 * `__tests__/ide-bottom-panel-store.test.ts`.
 */

import { useSyncExternalStore } from 'react'

export type BottomPanelTab = 'Terminal' | 'Problems' | 'Output'

export const BOTTOM_PANEL_TABS: readonly BottomPanelTab[] = [
  'Terminal',
  'Problems',
  'Output',
]

const KEY_OPEN = 'shogo.ide.bottomPanelOpen'
const KEY_SIZE = 'shogo.ide.bottomPanelSize'
const KEY_TAB = 'shogo.ide.bottomPanelTab'

const SIZE_MIN = 120
const SIZE_MAX = 600
const SIZE_DEFAULT = 260

export interface BottomPanelState {
  open: boolean
  size: number
  activeTab: BottomPanelTab
  /** Bumps to nudge Terminal to spawn a fresh session (⌘⇧`). */
  newTerminalNonce: number
  /** Per-projectId red-dot counter for the Output tab. */
  unseenErrorsByProject: Record<string, number>
  /**
   * Tracks the projects we've already auto-opened the drawer for during
   * this tab's lifetime. The auto-open behavior fires once per (project,
   * session) — re-opens only on next page reload.
   */
  autoOpenedByProject: Record<string, true>
}

type Listener = () => void

function safeReadString(key: string): string | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null
  } catch {
    return null
  }
}

function safeWrite(key: string, value: string): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(key, value)
  } catch {
    /* ignore */
  }
}

function clampSize(n: number): number {
  if (!Number.isFinite(n)) return SIZE_DEFAULT
  return Math.min(SIZE_MAX, Math.max(SIZE_MIN, Math.round(n)))
}

function readPersistedState(): BottomPanelState {
  const openRaw = safeReadString(KEY_OPEN)
  const sizeRaw = safeReadString(KEY_SIZE)
  const tabRaw = safeReadString(KEY_TAB) as BottomPanelTab | null
  return {
    open: openRaw === 'true',
    size: sizeRaw == null ? SIZE_DEFAULT : clampSize(parseInt(sizeRaw, 10)),
    activeTab:
      tabRaw && BOTTOM_PANEL_TABS.includes(tabRaw) ? tabRaw : 'Terminal',
    newTerminalNonce: 0,
    unseenErrorsByProject: {},
    autoOpenedByProject: {},
  }
}

let state: BottomPanelState = readPersistedState()
const listeners = new Set<Listener>()

function emit(): void {
  for (const l of listeners) l()
}

function set(next: Partial<BottomPanelState>): void {
  const merged: BottomPanelState = { ...state, ...next }
  if (merged.open !== state.open) safeWrite(KEY_OPEN, String(merged.open))
  if (merged.size !== state.size) safeWrite(KEY_SIZE, String(merged.size))
  if (merged.activeTab !== state.activeTab) safeWrite(KEY_TAB, merged.activeTab)
  state = merged
  emit()
}

export const ideBottomPanelStore = {
  getState: (): BottomPanelState => state,

  subscribe(listener: Listener): () => void {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  },

  setOpen(open: boolean): void {
    if (state.open === open) return
    set({ open })
  },

  toggleOpen(): void {
    set({ open: !state.open })
  },

  setSize(size: number): void {
    const clamped = clampSize(size)
    if (state.size === clamped) return
    set({ size: clamped })
  },

  setActiveTab(tab: BottomPanelTab): void {
    if (state.activeTab === tab) return
    set({ activeTab: tab })
  },

  /**
   * Spawn a new terminal session in whatever drawer is currently
   * mounted. Always opens the drawer first so a "⌘⇧`" press from
   * outside the IDE actually surfaces a terminal.
   */
  requestNewTerminal(): void {
    set({
      open: true,
      activeTab: 'Terminal',
      newTerminalNonce: state.newTerminalNonce + 1,
    })
  },

  /**
   * Increment the unseen-error counter for a project. Auto-opens the
   * drawer + selects the Output tab on the *first* error per project
   * session (idempotent across subsequent errors).
   */
  reportError(projectId: string): void {
    const next: BottomPanelState = {
      ...state,
      unseenErrorsByProject: {
        ...state.unseenErrorsByProject,
        [projectId]: (state.unseenErrorsByProject[projectId] ?? 0) + 1,
      },
    }
    if (!state.autoOpenedByProject[projectId]) {
      next.open = true
      next.activeTab = 'Output'
      next.autoOpenedByProject = {
        ...state.autoOpenedByProject,
        [projectId]: true,
      }
    }
    if (next.open !== state.open) safeWrite(KEY_OPEN, String(next.open))
    if (next.activeTab !== state.activeTab) safeWrite(KEY_TAB, next.activeTab)
    state = next
    emit()
  },

  /** Clear the unseen counter for a project (e.g. when Output is opened). */
  markAllSeen(projectId: string): void {
    if (!state.unseenErrorsByProject[projectId]) return
    const { [projectId]: _drop, ...rest } = state.unseenErrorsByProject
    void _drop
    set({ unseenErrorsByProject: rest })
  },

  /** Reset for tests only — re-reads localStorage. */
  __resetForTest(): void {
    state = readPersistedState()
    listeners.clear()
  },
} as const

export function useBottomPanelState<T>(selector: (s: BottomPanelState) => T): T {
  return useSyncExternalStore(
    ideBottomPanelStore.subscribe,
    () => selector(ideBottomPanelStore.getState()),
    () => selector(ideBottomPanelStore.getState()),
  )
}
