// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Live browser viewport for the currently-running subagent, driven by
 * `subagent-stream-store`'s running `instanceId`. `SubagentCard` no longer
 * mounts its own inline `LiveBrowserView`, so this is the only place that
 * opens the screencast SSE subscription. `active={expanded}` tears the
 * subscription down while the panel is collapsed — belt-and-suspenders on
 * top of `DockPanel` already unmounting collapsed bodies.
 */

import { useMemo, useSyncExternalStore } from "react"
import { Eye } from "lucide-react-native"
import { LiveBrowserView } from "../../LiveBrowserView"
import { subagentStreamStore } from "../../../../lib/subagent-stream-store"
import { useDockPanel } from "../useDockPanel"
import type { DockPanelDescriptor } from "../../../../lib/chat-dock-store"

export function BrowserDockPanel() {
  const version = useSyncExternalStore(
    subagentStreamStore.subscribe,
    () => subagentStreamStore.getVersion(),
    () => subagentStreamStore.getVersion(),
  )

  const { runningInstanceId, runningAgentType } = useMemo(() => {
    for (const data of subagentStreamStore.getAll().values()) {
      if (data.status === "running" && data.instanceId) {
        return { runningInstanceId: data.instanceId, runningAgentType: data.agentType }
      }
    }
    return { runningInstanceId: null as string | null, runningAgentType: undefined as string | undefined }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version])

  const descriptor = useMemo<DockPanelDescriptor | null>(() => {
    if (!runningInstanceId) return null
    return {
      id: "browser",
      kind: "status",
      order: 50,
      title: "Live browser",
      icon: Eye,
      summary: runningAgentType,
      chip: { icon: Eye, dot: true },
      render: ({ expanded }) => <LiveBrowserView instanceId={runningInstanceId} active={expanded} />,
    }
  }, [runningInstanceId, runningAgentType])

  useDockPanel(descriptor)
  return null
}
