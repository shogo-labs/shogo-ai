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

import { useSyncExternalStore } from "react"
import { Eye } from "lucide-react-native"
import { LiveBrowserView } from "../../LiveBrowserView"
import { subagentStreamStore } from "../../../../lib/subagent-stream-store"
import { useDockPanel } from "../useDockPanel"
import type { DockPanelDescriptor } from "../../../../lib/chat-dock-store"

export function BrowserDockPanel() {
  useSyncExternalStore(
    subagentStreamStore.subscribe,
    () => subagentStreamStore.getVersion(),
    () => subagentStreamStore.getVersion(),
  )

  let runningInstanceId: string | null = null
  let runningAgentType: string | undefined
  for (const data of subagentStreamStore.getAll().values()) {
    if (data.status === "running" && data.instanceId) {
      runningInstanceId = data.instanceId
      runningAgentType = data.agentType
      break
    }
  }

  const descriptor: DockPanelDescriptor | null = runningInstanceId
    ? {
        id: "browser",
        kind: "status",
        order: 50,
        title: "Live browser",
        icon: Eye,
        summary: runningAgentType,
        chip: { icon: Eye, dot: true },
        render: ({ expanded }) => <LiveBrowserView instanceId={runningInstanceId!} active={expanded} />,
      }
    : null

  useDockPanel(descriptor)
  return null
}
