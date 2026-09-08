// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Composer-toolbar chip rail — renders a `DockChip` for every registered
 * panel that declared a `chip` descriptor, so panels announce their own
 * toolbar pill instead of `ChatInput` hardcoding one per feature. Reacts to
 * the store so chips appear/disappear as panels register (queue empties,
 * a subagent finishes, etc.).
 *
 * The context-usage ring is a special case handled separately by
 * `ChatInput` — it always has data and renders the actual `ContextTracker`
 * ring as its chip body, rather than the default icon/count layout this
 * rail produces.
 */

import { useSyncExternalStore } from "react"
import { useChatDockStore } from "../../../lib/chat-dock-store"
import { DockChip } from "./DockChip"

export interface DockChipRailProps {
  isNative?: boolean
}

export function DockChipRail({ isNative }: DockChipRailProps) {
  const store = useChatDockStore()
  useSyncExternalStore(store.subscribe, store.getVersion, store.getVersion)

  const chipped = store.getPanels("status").filter((p) => p.chip)

  return (
    <>
      {chipped.map((panel) => (
        <DockChip
          key={panel.id}
          panelId={panel.id}
          icon={panel.chip!.icon}
          count={panel.chip!.count}
          dot={panel.chip!.dot}
          isNative={isNative}
          accessibilityLabel={panel.title}
        />
      ))}
    </>
  )
}
