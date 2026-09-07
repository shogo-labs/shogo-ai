// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Per-chat store for the "chat dock" — the floating stack of panels above
 * the composer (plan, changed files, checklist, live browser, running
 * tasks, message queue, context usage, plus blocking prompts like
 * permission approval and pending questions).
 *
 * Everything that wants to appear above the composer used to invent its
 * own container, state, and collapse behavior. This store is the single
 * registry all of that now goes through: features call `useDockPanel()`
 * with a descriptor and never think about positioning, stacking,
 * animation, or persistence.
 *
 * Modeled directly on `todo-state-store.ts`: a tiny external store
 * (registry + expand state + measured height) exposed via React context,
 * with a lazily-created fallback for components rendered outside any
 * provider (tests, storybook).
 *
 * Panels have a `kind`:
 *  - "status" (default): collapsible, auto-shows/hides with its content,
 *    subject to the expand cap below.
 *  - "blocking": pins above the composer, is always considered expanded,
 *    and forces the status zone down to a single expanded panel while
 *    present. Used for prompts that park the agent turn (permission
 *    approval, pending question, an active connectivity wait) — these
 *    must stay visible and reachable, never collapsed by this store.
 */

import { createContext, useContext, type ComponentType, type ReactNode } from "react"
import { getDockPanelExpandedPreference, setDockPanelExpandedPreference } from "./chat-dock-preferences"

export type DockPanelKind = "status" | "blocking"
export type DockPanelAccent = "default" | "running" | "warning"

export type DockIconComponent = ComponentType<{ size?: number; className?: string; color?: string }>

export interface DockPanelChip {
  icon: DockIconComponent
  count?: number
  dot?: boolean
}

export interface DockPanelDescriptor {
  id: string
  /** Default "status". */
  kind?: DockPanelKind
  /** Lower renders higher up (closer to the top of the stack); ties break by insertion order. */
  order: number
  title: string
  icon: DockIconComponent
  /** Right-aligned collapsed-header text, e.g. "3 queued" or "18.2K / 200K". */
  summary?: string
  accent?: DockPanelAccent
  /** false = hidden until toggled/opened. Default true. */
  autoShow?: boolean
  /** Only consulted the first time a panel with this id is registered. Default false. */
  defaultExpanded?: boolean
  /** Rendered in the collapsed header so Retry / Reconnect / Cancel / Kill stay reachable without expanding. */
  headerActions?: ReactNode
  /** Renders a dismiss (X) affordance in the header when set. */
  onDismiss?: () => void
  /** Toolbar pill descriptor; omit for panels that shouldn't get a composer chip. */
  chip?: DockPanelChip
  /** `expanded` lets costly panels (e.g. a live browser screencast) suspend work while collapsed. */
  render: (ctx: { expanded: boolean }) => ReactNode
}

/** Max simultaneously-expanded status panels; tightened while a blocking panel is present. */
const MAX_EXPANDED_STATUS_PANELS = 2
const MAX_EXPANDED_WITH_BLOCKING = 1

export interface ChatDockStore {
  getVersion(): number
  /** Visible panels only, sorted by `order`. */
  getPanels(kind?: DockPanelKind): DockPanelDescriptor[]
  registerPanel(descriptor: DockPanelDescriptor): void
  unregisterPanel(id: string): void
  isVisible(id: string): boolean
  isExpanded(id: string): boolean
  setExpanded(id: string, next: boolean): void
  /** Toggles expansion; reveals the panel first if it was hidden (autoShow: false). */
  toggle(id: string): void
  /** Imperative deep-link — reveals and expands a panel from elsewhere in the UI. */
  openPanel(id: string): void
  closePanel(id: string): void
  hasBlocking(): boolean
  getHeight(): number
  setHeight(px: number): void
  subscribe(fn: () => void): () => void
  /** Clears all registered panels — call when the active chat session changes. */
  reset(): void
}

export function createChatDockStore(): ChatDockStore {
  const panels = new Map<string, DockPanelDescriptor>()
  const visible = new Set<string>()
  const expanded = new Set<string>()
  // Most-recently-expanded last; used to decide which status panel gets
  // evicted first when the expand cap is exceeded.
  const expandOrder: string[] = []
  const listeners = new Set<() => void>()
  let height = 0
  let version = 0

  function notify(): void {
    version++
    listeners.forEach((fn) => fn())
  }

  function touchExpandOrder(id: string): void {
    const idx = expandOrder.indexOf(id)
    if (idx !== -1) expandOrder.splice(idx, 1)
    expandOrder.push(id)
  }

  function dropFromExpandOrder(id: string): void {
    const idx = expandOrder.indexOf(id)
    if (idx !== -1) expandOrder.splice(idx, 1)
  }

  function hasBlockingPanels(): boolean {
    for (const id of visible) {
      if ((panels.get(id)?.kind ?? "status") === "blocking") return true
    }
    return false
  }

  function isBlockingKind(id: string): boolean {
    return (panels.get(id)?.kind ?? "status") === "blocking"
  }

  /** Evicts least-recently-expanded status panels until under the cap, protecting `keepId`. */
  function enforceExpandCap(keepId?: string): void {
    const cap = hasBlockingPanels() ? MAX_EXPANDED_WITH_BLOCKING : MAX_EXPANDED_STATUS_PANELS
    const expandedStatusIds = expandOrder.filter((id) => expanded.has(id) && !isBlockingKind(id))
    let i = 0
    while (expandedStatusIds.length - i > cap) {
      const evictId = expandedStatusIds[i]
      i++
      if (!evictId || evictId === keepId) continue
      expanded.delete(evictId)
      dropFromExpandOrder(evictId)
    }
  }

  function setExpandedInternal(id: string, next: boolean, persist: boolean): void {
    const panel = panels.get(id)
    if (!panel) return
    if ((panel.kind ?? "status") === "blocking") return // always considered expanded; not user-controlled
    if (expanded.has(id) === next) return
    if (next) {
      expanded.add(id)
      touchExpandOrder(id)
      enforceExpandCap(id)
    } else {
      expanded.delete(id)
      dropFromExpandOrder(id)
    }
    if (persist && panel.autoShow !== false) {
      setDockPanelExpandedPreference(id, next)
    }
  }

  return {
    getVersion() {
      return version
    },
    getPanels(kind) {
      const list = [...panels.values()].filter((p) => visible.has(p.id))
      const filtered = kind ? list.filter((p) => (p.kind ?? "status") === kind) : list
      return filtered.sort((a, b) => a.order - b.order)
    },
    registerPanel(descriptor) {
      const isNew = !panels.has(descriptor.id)
      panels.set(descriptor.id, descriptor)
      if (isNew) {
        const autoShow = descriptor.autoShow !== false
        const isBlocking = (descriptor.kind ?? "status") === "blocking"
        if (autoShow) {
          visible.add(descriptor.id)
          const persisted = getDockPanelExpandedPreference(descriptor.id)
          const shouldExpand = isBlocking
            ? true
            : persisted !== null
              ? persisted
              : !!descriptor.defaultExpanded
          if (shouldExpand && !isBlocking) {
            expanded.add(descriptor.id)
            touchExpandOrder(descriptor.id)
            enforceExpandCap(descriptor.id)
          }
        }
      }
      notify()
    },
    unregisterPanel(id) {
      if (!panels.has(id)) return
      panels.delete(id)
      visible.delete(id)
      expanded.delete(id)
      dropFromExpandOrder(id)
      notify()
    },
    isVisible(id) {
      return visible.has(id)
    },
    isExpanded(id) {
      if (isBlockingKind(id)) return true
      return expanded.has(id)
    },
    setExpanded(id, next) {
      setExpandedInternal(id, next, true)
      notify()
    },
    toggle(id) {
      if (!panels.has(id)) return
      if (!visible.has(id)) visible.add(id)
      setExpandedInternal(id, !expanded.has(id), true)
      notify()
    },
    openPanel(id) {
      if (!panels.has(id)) return
      if (!visible.has(id)) visible.add(id)
      setExpandedInternal(id, true, true)
      notify()
    },
    closePanel(id) {
      setExpandedInternal(id, false, true)
      notify()
    },
    hasBlocking() {
      return hasBlockingPanels()
    },
    getHeight() {
      return height
    },
    setHeight(px) {
      if (height === px) return
      height = px
      notify()
    },
    subscribe(fn) {
      listeners.add(fn)
      return () => {
        listeners.delete(fn)
      }
    },
    reset() {
      panels.clear()
      visible.clear()
      expanded.clear()
      expandOrder.length = 0
      height = 0
      notify()
    },
  }
}

export const ChatDockStoreContext = createContext<ChatDockStore | null>(null)

// Lazily-created fallback for components rendered outside any
// `ChatDockStoreContext.Provider` (tests, storybook, isolated previews).
// Production chat trees always supply a per-`ChatPanel` instance.
let fallbackStore: ChatDockStore | null = null

function getFallbackStore(): ChatDockStore {
  if (!fallbackStore) fallbackStore = createChatDockStore()
  return fallbackStore
}

export function useChatDockStore(): ChatDockStore {
  const store = useContext(ChatDockStoreContext)
  return store ?? getFallbackStore()
}
