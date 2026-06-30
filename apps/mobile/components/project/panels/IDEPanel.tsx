// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { useEffect, useMemo, useState } from 'react'
import { Platform, View, Text, Pressable } from 'react-native'
import { Code2, ExternalLink } from 'lucide-react-native'
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
  onOpenCodeWorkbench?: () => void
  isExternalProject?: boolean
  folderPath?: string | null
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
 * In Shogo Desktop, this IDE tab remains the in-app editing surface while
 * its header can open/focus the managed external Shogo-IDE window.
 */
export function IDEPanel({
  visible,
  projectId,
  projectName,
  agentUrl,
  onOpenCodeWorkbench,
  isExternalProject,
  folderPath,
}: IDEPanelProps) {
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
  const [desktopWorkspaceRoot, setDesktopWorkspaceRoot] = useState<string | null | undefined>(undefined)
  useEffect(() => {
    setAgentService(sdkService)
    setDesktopWorkspaceRoot(undefined)
    const bridge = getDesktopFsBridge()
    if (!bridge) {
      setDesktopWorkspaceRoot(null)
      return
    }
    let cancelled = false
    void bridge.resolveWorkspace(projectId)
      .then((res) => {
        if (cancelled) return
        const root = res.ok && res.root ? res.root : null
        setDesktopWorkspaceRoot(root)
        if (root && sdkService) {
          setAgentService(
            new DesktopFs(bridge, root, sdkService, `project/${projectId} (desktop-fast-path)`),
          )
        }
      })
      .catch(() => {
        if (!cancelled) setDesktopWorkspaceRoot(null)
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
      {onOpenCodeWorkbench && (
        <View className="h-10 flex-row items-center justify-between border-b border-border bg-background px-3">
          <View className="flex-row items-center gap-2">
            <Code2 size={14} className="text-muted-foreground" />
            <Text className="text-xs font-semibold text-foreground">IDE</Text>
          </View>
          <Pressable
            onPress={onOpenCodeWorkbench}
            className="h-7 flex-row items-center gap-1.5 rounded-md border border-orange-500/40 bg-orange-500/10 px-2.5 active:bg-orange-500/15"
            accessibilityRole="button"
            accessibilityLabel="Open full Shogo IDE"
          >
            <ExternalLink size={12} className="text-orange-400" />
            <Text className="text-[10px] font-semibold text-orange-400">Open full Shogo IDE</Text>
          </Pressable>
        </View>
      )}
      <div style={{ flex: 1, minHeight: 0 }}>
        <Workbench
          agentService={agentService}
          agentLabel={projectName || `project/${projectId}`}
          projectId={projectId}
          paneVisible={visible}
          agentUrl={agentUrl ?? undefined}
          fetchImpl={agentFetch}
          isExternalProject={isExternalProject}
          folderPath={folderPath}
        />
      </div>
    </View>
  )
}
