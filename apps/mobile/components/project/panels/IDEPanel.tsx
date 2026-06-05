// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { useEffect, useMemo, useState } from 'react'
import { Platform, View, Text } from 'react-native'
import { Code2 } from 'lucide-react-native'
import { Workbench } from './ide/Workbench'
import { sdkFsFor } from './ide/workspace/sdkFs'
import { DesktopFs, getDesktopFsBridge } from './ide/workspace/desktopFs'
import type { WorkspaceService } from './ide/workspace/types'
import { agentFetch } from '../../../lib/agent-fetch'

interface IDEPanelProps {
  visible: boolean
  projectId: string
  projectName?: string | null
  agentUrl?: string | null
  isExternalProject?: boolean
}

/**
 * Web-only IDE tab. The Workbench is built on Monaco + plain DOM so it only
 * works on react-native-web — on native iOS/Android we render a placeholder
 * that points users at a desktop browser.
 *
 * File ops (list, read, write, rename, delete, mkdir, search) flow through
 * AgentClient against the project's per-project agentUrl. Terminal and git
 * are rendered as "backend-pending" placeholders until the agent-runtime
 * exposes those routes (follow-up phase).
 *
 * The Workbench stays MOUNTED even when the IDE tab is not visible (we just
 * hide it with `display: none`). This is essential for the live-edit feature:
 * the Workbench holds an SSE subscription that receives `file.changed` events
 * whenever the chat agent writes to disk, and unmounting/remounting on every
 * tab switch would constantly tear that subscription down — so the user would
 * miss any edits made while they were on another tab and have to refresh the
 * whole page to see them.
 */
export function IDEPanel({ visible, projectId, projectName, agentUrl, isExternalProject }: IDEPanelProps) {
  // SdkFs is always-on: it's the canonical backend for writes, search, and
  // SSE subscriptions even when the desktop IPC fast-path is available
  // (DesktopFs wraps and delegates to it). Memo keeps the AgentClient +
  // its in-flight read map alive across re-renders.
  const sdkService = useMemo(
    () => (agentUrl ? sdkFsFor(agentUrl, `project/${projectId}`, agentFetch) : null),
    [agentUrl, projectId],
  )

  // Desktop fast-path: on first mount, ask the Electron preload bridge
  // whether this project has a resolvable managed workspace root. If yes,
  // wrap SdkFs in DesktopFs so reads + tree listing skip the loopback HTTP
  // round-trip to agent-runtime. If no (web build, cloud mode, or external
  // folder-bound project), fall through to plain SdkFs.
  const [agentService, setAgentService] = useState<WorkspaceService | null>(sdkService)
  useEffect(() => {
    setAgentService(sdkService)
    if (!sdkService) return
    const bridge = getDesktopFsBridge()
    if (!bridge) return
    let cancelled = false
    void bridge.resolveWorkspace(projectId).then((res) => {
      if (cancelled) return
      if (res.ok && res.root) {
        setAgentService(
          new DesktopFs(bridge, res.root, sdkService, `project/${projectId} (desktop-fast-path)`),
        )
      }
    })
    return () => { cancelled = true }
  }, [sdkService, projectId])

  if (Platform.OS !== 'web') {
    if (!visible) return null
    return (
      <View className="flex-1 items-center justify-center p-6 bg-background">
        <Code2 size={32} color="#0078d4" />
        <Text className="text-foreground text-sm font-semibold mt-3">
          IDE requires a desktop browser
        </Text>
        <Text className="text-muted-foreground text-xs mt-1.5 text-center max-w-[320px]">
          The full code editor is built on Monaco (DOM-only). Open this project
          in Chrome or Edge on your desktop to use the IDE tab.
        </Text>
      </View>
    )
  }

  if (!agentService) {
    if (!visible) return null
    return (
      <View className="flex-1 items-center justify-center p-6 bg-background">
        <Text className="text-muted-foreground text-xs">Agent not ready yet…</Text>
      </View>
    )
  }

  return (
    <View style={{ flex: 1, minHeight: 0, display: visible ? 'flex' : 'none' }}>
      <div style={{ position: 'absolute', inset: 0 }}>
        <Workbench
          agentService={agentService}
          agentLabel={projectName || `project/${projectId}`}
          projectId={projectId}
          paneVisible={visible}
          agentUrl={agentUrl ?? undefined}
          fetchImpl={agentFetch}
          isExternalProject={isExternalProject}
        />
      </div>
    </View>
  )
}
