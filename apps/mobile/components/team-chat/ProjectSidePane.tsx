// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * An agent's project shown beside a conversation: its canvas, files, plans
 * and chat. Each tab stays mounted once visited so switching back doesn't
 * reload the canvas.
 */
import { useState } from 'react'
import { Pressable, Text, View } from 'react-native'
import { useRouter } from 'expo-router'
import { ExternalLink, X } from 'lucide-react-native'
import { SegmentedFilter } from '../phone/SegmentedFilter'
import { ProjectSurfaceView } from '../project/ProjectSurfaceView'
import { ProjectChatView } from '../project/ProjectChatView'
import { AgentAvatar } from './AgentAvatar'

export type ProjectPaneTab = 'canvas' | 'files' | 'plans' | 'chat'

const TABS = [
  { value: 'canvas', label: 'Canvas' },
  { value: 'files', label: 'Files' },
  { value: 'plans', label: 'Plans' },
  { value: 'chat', label: 'Chat' },
] as const

export interface ProjectSidePaneProps {
  projectId: string
  workspaceId?: string | null
  name: string
  onClose: () => void
}

export function ProjectSidePane({ projectId, workspaceId, name, onClose }: ProjectSidePaneProps) {
  const router = useRouter()
  const [tab, setTab] = useState<ProjectPaneTab>('canvas')
  const [visited, setVisited] = useState<ReadonlySet<ProjectPaneTab>>(() => new Set(['canvas']))
  const select = (next: ProjectPaneTab) => {
    setTab(next)
    setVisited((prev) => (prev.has(next) ? prev : new Set(prev).add(next)))
  }

  const show = (t: ProjectPaneTab) => ({ display: tab === t ? ('flex' as const) : ('none' as const), flex: 1 })

  return (
    <View className="flex-1 bg-background" testID="project-side-pane">
      <View className="flex-row items-center gap-2 border-b border-border px-3 py-2">
        <AgentAvatar name={name} projectId={projectId} workspaceId={workspaceId} size={20} />
        <Text className="min-w-0 flex-1 text-sm font-semibold text-foreground" numberOfLines={1}>{name}</Text>
        <Pressable
          onPress={() => router.push({ pathname: '/(app)/projects/[id]', params: { id: projectId } } as any)}
          accessibilityRole="button"
          accessibilityLabel="Open full project"
          className="rounded p-1.5 active:bg-muted"
        >
          <ExternalLink size={15} className="text-muted-foreground" />
        </Pressable>
        <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel="Close project panel" className="rounded p-1.5 active:bg-muted">
          <X size={16} className="text-muted-foreground" />
        </Pressable>
      </View>
      <View className="px-3 py-2">
        <SegmentedFilter options={TABS} value={tab} onChange={select} equalWidth testID="project-pane-tabs" />
      </View>
      <View className="min-h-0 flex-1">
        {visited.has('canvas') && <View style={show('canvas')}><ProjectSurfaceView projectId={projectId} surface="canvas" /></View>}
        {visited.has('files') && <View style={show('files')}><ProjectSurfaceView projectId={projectId} surface="files" /></View>}
        {visited.has('plans') && <View style={show('plans')}><ProjectSurfaceView projectId={projectId} surface="plans" /></View>}
        {visited.has('chat') && <View style={show('chat')}><ProjectChatView projectId={projectId} /></View>}
      </View>
    </View>
  )
}
