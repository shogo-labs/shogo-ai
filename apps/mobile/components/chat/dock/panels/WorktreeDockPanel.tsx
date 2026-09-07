// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Dock panel for the per-chat git worktree bar. Uses `useWorktreeStatus` to
 * poll independently of the dock's own visibility so it can decide whether
 * to register itself in the first place — the old `WorktreeBar` decided
 * this from inside its own render, which doesn't work once "am I rendered
 * at all" is controlled by a registry the component has to ask first.
 */

import { useMemo } from "react"
import { GitBranch } from "lucide-react-native"
import { useWorktreeStatus, WorktreeBarView } from "../../WorktreeBar"
import { useDockPanel } from "../useDockPanel"
import type { DockPanelDescriptor } from "../../../../lib/chat-dock-store"

export interface WorktreeDockPanelProps {
  agentUrl: string | null
  chatSessionId: string | null
  isStreaming: boolean
  onSendMessage: (text: string) => void
}

export function WorktreeDockPanel({ agentUrl, chatSessionId, isStreaming, onSendMessage }: WorktreeDockPanelProps) {
  const worktree = useWorktreeStatus(agentUrl, chatSessionId, isStreaming, onSendMessage)

  const summary = worktree.status
    ? worktree.mergeState === "merged"
      ? "Merged"
      : worktree.mergeState === "conflict"
        ? "Resolving conflicts…"
        : worktree.status.ahead > 0
          ? `${worktree.status.ahead} ahead`
          : "Up to date"
    : undefined

  const descriptor = useMemo<DockPanelDescriptor | null>(() => {
    if (!worktree.visible) return null
    return {
      id: "worktree",
      kind: "status",
      order: 10,
      title: "Worktree",
      icon: GitBranch,
      summary,
      render: () => <WorktreeBarView {...worktree} isStreaming={isStreaming} />,
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [worktree.visible, worktree.status, worktree.siblings, worktree.mergeState, worktree.error, summary, isStreaming])

  useDockPanel(descriptor)

  return null
}
