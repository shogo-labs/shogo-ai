// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Wraps the existing `ContextBreakdownPanel` unchanged as an on-demand dock
 * panel (`autoShow: false`) — the context ring in the composer toolbar is
 * its `DockChip`, since it always has data and doesn't need to auto-show.
 */

import { useMemo } from "react"
import { Gauge } from "lucide-react-native"
import { ContextBreakdownPanel, type ContextBreakdownData } from "../../ContextBreakdownPanel"
import { useDockPanel } from "../useDockPanel"
import type { DockPanelDescriptor } from "../../../../lib/chat-dock-store"

export interface ContextUsageDockPanelProps {
  contextUsage: { inputTokens: number; contextWindowTokens: number } | null | undefined
  contextBreakdown: ContextBreakdownData | null | undefined
}

export function ContextUsageDockPanel({ contextUsage, contextBreakdown }: ContextUsageDockPanelProps) {
  const descriptor = useMemo<DockPanelDescriptor | null>(() => {
    if (!contextUsage) return null
    return {
      id: "context-usage",
      kind: "status",
      order: 80,
      title: "Context usage",
      icon: Gauge,
      autoShow: false,
      render: () => (
        <ContextBreakdownPanel
          breakdown={contextBreakdown ?? null}
          inputTokens={contextUsage.inputTokens}
          contextWindowTokens={contextUsage.contextWindowTokens}
        />
      ),
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contextUsage, contextBreakdown])

  useDockPanel(descriptor)
  return null
}
