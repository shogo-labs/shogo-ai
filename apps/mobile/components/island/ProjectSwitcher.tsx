// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { useEffect, useMemo, useRef, useState } from "react"
import { Image, Pressable, ScrollView, Text, TextInput, View } from "react-native"
import { observer } from "mobx-react-lite"
import { Search } from "lucide-react-native"
import { useProjectCollection } from "../../contexts/domain"
import { workspaceProjectFilter } from "../../lib/project-load"
import { StatusDot } from "./IslandCollapsed"
import {
  orderIslandSessions,
  projectActivity,
  sortIslandProjects,
  type IslandProjectItem,
} from "./island-inbox"
import { relativeTime } from "./SessionList"
import type { IslandSession } from "./types"

export function useWorkspaceProjects(workspaceId: string | undefined): IslandProjectItem[] {
  const projects = useProjectCollection()
  useEffect(() => {
    if (!workspaceId) return
    void projects.loadAll(workspaceProjectFilter(workspaceId)).catch(() => undefined)
  }, [projects, workspaceId])
  return (projects.all as any[])
    .filter((project) => !workspaceId || project.workspaceId === workspaceId)
    .map((project) => ({
      id: project.id,
      name: project.name,
      thumbnailUrl: project.thumbnailUrl || undefined,
      lastMessageAt: project.lastMessageAt,
      updatedAt: project.updatedAt,
    }))
}

export function ProjectAvatar({ project, size = 22 }: { project: IslandProjectItem; size?: number }) {
  if (project.thumbnailUrl) {
    return (
      <Image
        source={{ uri: project.thumbnailUrl }}
        style={{ width: size, height: size, borderRadius: 6 }}
        resizeMode="cover"
      />
    )
  }
  return (
    <View
      className="items-center justify-center rounded-md bg-violet-500/25"
      style={{ width: size, height: size }}
    >
      <Text className="text-[10px] font-bold text-violet-200">
        {project.name.trim().slice(0, 1).toUpperCase() || "?"}
      </Text>
    </View>
  )
}

export const ProjectSwitcher = observer(function ProjectSwitcher({
  workspaceId,
  liveSessions,
  currentProjectId,
  onSelect,
  onInputFocus,
}: {
  workspaceId: string | undefined
  liveSessions: IslandSession[]
  currentProjectId?: string | null
  onSelect: (project: IslandProjectItem) => void
  onInputFocus: () => void
}) {
  const projects = useWorkspaceProjects(workspaceId)
  const [query, setQuery] = useState("")
  const [highlight, setHighlight] = useState(0)
  const inputRef = useRef<TextInput>(null)
  const sorted = useMemo(() => sortIslandProjects(projects, liveSessions, query), [projects, liveSessions, query])
  const topStatus = useMemo(() => {
    const byProject = new Map<string, string>()
    for (const session of orderIslandSessions(liveSessions)) {
      if (!byProject.has(session.projectId)) byProject.set(session.projectId, session.status)
    }
    return byProject
  }, [liveSessions])

  useEffect(() => setHighlight(0), [query])
  useEffect(() => {
    const timer = setTimeout(() => inputRef.current?.focus(), 50)
    return () => clearTimeout(timer)
  }, [])

  return (
    <View style={{ flexShrink: 1, minHeight: 0 }}>
      <View className="mx-3 mb-1 mt-2 flex-row items-center gap-2 rounded-lg border border-white/10 bg-black/30 px-2.5">
        <Search size={13} color="#71717a" />
        <TextInput
          ref={inputRef}
          value={query}
          onChangeText={setQuery}
          onFocus={onInputFocus}
          placeholder="Switch project…"
          placeholderTextColor="#71717a"
          className="flex-1 py-2 text-[12px] text-zinc-100"
          style={{ outlineStyle: "none" } as object}
          onKeyPress={(event) => {
            const key = (event.nativeEvent as unknown as KeyboardEvent).key
            if (key === "ArrowDown") setHighlight((i) => Math.min(sorted.length - 1, i + 1))
            if (key === "ArrowUp") setHighlight((i) => Math.max(0, i - 1))
          }}
          onSubmitEditing={() => sorted[highlight] && onSelect(sorted[highlight])}
        />
      </View>
      <ScrollView style={{ flexGrow: 0, flexShrink: 1 }} contentContainerStyle={{ padding: 8 }}>
        {sorted.map((project, index) => {
          const status = topStatus.get(project.id)
          return (
            <Pressable
              key={project.id}
              onPress={() => onSelect(project)}
              className={
                index === highlight || project.id === currentProjectId
                  ? "flex-row items-center gap-2.5 rounded-lg bg-white/10 px-2 py-1.5"
                  : "flex-row items-center gap-2.5 rounded-lg px-2 py-1.5 hover:bg-white/5"
              }
            >
              <ProjectAvatar project={project} />
              <Text className="min-w-0 flex-1 text-[12px] font-medium text-zinc-100" numberOfLines={1}>
                {project.name}
              </Text>
              {status ? <StatusDot status={status} /> : null}
              <Text className="text-[10px] text-zinc-500">{relativeTime(projectActivity(project))}</Text>
            </Pressable>
          )
        })}
        {sorted.length === 0 ? (
          <Text className="px-2 py-3 text-[11px] text-zinc-500">
            {query ? "No matching projects." : "No projects yet."}
          </Text>
        ) : null}
      </ScrollView>
    </View>
  )
})
