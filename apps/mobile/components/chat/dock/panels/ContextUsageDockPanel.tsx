// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Wraps the existing `ContextBreakdownPanel` unchanged as an on-demand dock
 * panel (`autoShow: false`) — the context ring in the composer toolbar is
 * its `DockChip`, since it always has data and doesn't need to auto-show.
 *
 * The panel also carries the manual "Summarize now" action: this is the
 * context-usage dock Russell asked to trigger summarization from (SHO-96).
 */

import { useMemo } from "react"
import { Gauge } from "lucide-react-native"
import { ContextBreakdownPanel, type ContextBreakdownData } from "../../ContextBreakdownPanel"
import { useDockPanel } from "../useDockPanel"
import type { DockPanelDescriptor } from "../../../../lib/chat-dock-store"

export interface ContextUsageDockPanelProps {
  contextUsage: { inputTokens: number; contextWindowTokens: number } | null | undefined
  contextBreakdown: ContextBreakdownData | null | undefined
  /** Project owning this chat, for the manual summarize call. */
  projectId?: string | null
  /**
   * Workspace id for a workspace-scoped chat: its session lives on the
   * workspace runtime, so the summarize call must target that route (SHO-230).
   */
  workspaceId?: string | null
  /** Chat session the compaction applies to. */
  chatSessionId?: string | null
}

export function ContextUsageDockPanel({
  contextUsage,
  contextBreakdown,
  projectId,
  workspaceId,
  chatSessionId,
}: ContextUsageDockPanelProps) {
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
          projectId={projectId}
          workspaceId={workspaceId}
          chatSessionId={chatSessionId}
        />
      ),
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contextUsage, contextBreakdown, projectId, workspaceId, chatSessionId])

  useDockPanel(descriptor)
  return null
}
