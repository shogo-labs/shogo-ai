// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { useCallback, useMemo, useState } from 'react'
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, Text, View } from 'react-native'
import { useFocusEffect, useRouter } from 'expo-router'
import { ChevronRight, FileText, FolderOpen, Image as ImageIcon, PackageOpen } from 'lucide-react-native'
import { useProjectCollection } from '../../contexts/domain'
import { useActiveWorkspace } from '../../hooks/useActiveWorkspace'
import { api, createHttpClient } from '../../lib/api'
import { PhoneListEmpty } from '../../components/phone/PhoneListRow'

type FileSummary = { path: string; name: string; type: 'file' | 'directory'; extension?: string; size?: number }

function formatSize(bytes?: number) {
  if (!bytes) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function fileIcon(file: FileSummary) {
  if (file.extension && ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'].includes(file.extension)) return <ImageIcon size={18} className="text-muted-foreground" />
  return <FileText size={18} className="text-muted-foreground" />
}

export default function LibraryScreen() {
  const router = useRouter()
  const http = useMemo(() => createHttpClient(), [])
  const workspace = useActiveWorkspace()
  const projects = useProjectCollection()
  const [filesByProject, setFilesByProject] = useState<Record<string, FileSummary[]>>({})
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const workspaceProjects = useMemo(() => projects.all.filter((project: any) => project.workspaceId === workspace?.id), [projects.all, workspace?.id])

  const load = useCallback(async () => {
    if (workspaceProjects.length === 0) {
      setLoading(false)
      setRefreshing(false)
      return
    }
    try {
      setError(null)
      const entries = await Promise.all(workspaceProjects.map(async (project: any) => {
        try {
          return [project.id, await api.listProjectFiles(http, project.id)] as const
        } catch {
          return [project.id, []] as const
        }
      }))
      setFilesByProject(Object.fromEntries(entries))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not load library')
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [http, workspaceProjects])

  useFocusEffect(useCallback(() => {
    void load()
  }, [load]))

  return (
    <View className="flex-1 bg-background">
      <View className="border-b border-border px-4 py-4">
        <Text className="text-2xl font-semibold text-foreground">Library</Text>
        <Text className="mt-1 text-sm text-muted-foreground">Project files and generated outputs, read-only for now.</Text>
      </View>
      {error ? <Text className="px-4 py-3 text-sm text-destructive">{error}</Text> : null}
      {loading ? <View className="flex-1 items-center justify-center"><ActivityIndicator /></View> : workspaceProjects.length === 0 ? <PhoneListEmpty icon={<PackageOpen size={44} className="text-muted-foreground" />} title="Your library is empty" message="Project files and recent outputs will appear here once you create a project." /> : (
        <ScrollView className="flex-1" refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); void load() }} />}>
          {workspaceProjects.map((project: any) => {
            const files = filesByProject[project.id] || []
            const recent = files.filter((file) => file.type === 'file').slice(-3).reverse()
            return (
              <View key={project.id} className="border-b border-border px-4 py-4">
                <Pressable onPress={() => router.push({ pathname: '/(app)/projects/[id]' as any, params: { id: project.id } } as any)} className="flex-row items-center gap-3 active:opacity-70">
                  <View className="h-10 w-10 items-center justify-center rounded-xl bg-muted"><FolderOpen size={20} className="text-muted-foreground" /></View>
                  <View className="flex-1"><Text className="font-semibold text-foreground" numberOfLines={1}>{project.name}</Text><Text className="mt-1 text-sm text-muted-foreground">{files.length} {files.length === 1 ? 'library item' : 'library items'}</Text></View>
                  <ChevronRight size={19} className="text-muted-foreground" />
                </Pressable>
                {recent.length > 0 ? <View className="mt-3 gap-2 pl-[52px]">{recent.map((file) => <View key={file.path} className="flex-row items-center gap-2"><View>{fileIcon(file)}</View><Text className="flex-1 text-sm text-foreground" numberOfLines={1}>{file.path}</Text><Text className="text-xs text-muted-foreground">{formatSize(file.size)}</Text></View>)}</View> : <Text className="mt-3 pl-[52px] text-sm text-muted-foreground">No readable files or generated outputs yet.</Text>}
              </View>
            )
          })}
        </ScrollView>
      )}
    </View>
  )
}
