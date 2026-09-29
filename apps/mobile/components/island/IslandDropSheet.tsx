// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { useState } from "react"
import { ActivityIndicator, Pressable, ScrollView, Text, View } from "react-native"
import { FilePlus2, FileText, MessageSquarePlus, Paperclip } from "lucide-react-native"
import { cn } from "@shogo/shared-ui/primitives"
import { ProjectAvatar } from "./ProjectSwitcher"
import { isTextFile, type IslandDropAction } from "./island-drop"
import type { IslandProjectItem } from "./island-inbox"
import type { IslandFileRef, IslandResult } from "./types"

export function IslandDropSheet({
  files,
  projects,
  initialProjectId,
  canAttach,
  onAction,
  onCancel,
}: {
  files: IslandFileRef[]
  projects: IslandProjectItem[]
  initialProjectId: string | null
  /** A chat is open, so "Attach to current chat" applies. */
  canAttach: boolean
  onAction: (action: IslandDropAction, projectId: string) => Promise<IslandResult>
  onCancel: () => void
}) {
  const [projectId, setProjectId] = useState(initialProjectId ?? projects[0]?.id ?? null)
  const [busy, setBusy] = useState<IslandDropAction | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const binaryCount = files.filter((file) => !isTextFile(file)).length

  const run = async (action: IslandDropAction) => {
    if (!projectId || busy) return
    setBusy(action)
    setError(null)
    const result = await onAction(action, projectId)
    setBusy(null)
    if (!result.ok) setError(result.error)
    else if (action === "add-to-project") setDone("Added to the project")
  }

  const actionRow = (
    action: IslandDropAction,
    label: string,
    detail: string,
    Icon: typeof FileText,
    disabled = false,
  ) => (
    <Pressable
      key={action}
      onPress={() => void run(action)}
      disabled={disabled || !!busy || !projectId}
      className={cn(
        "flex-row items-center gap-2.5 rounded-lg px-2.5 py-2 hover:bg-white/5",
        disabled && "opacity-40",
      )}
    >
      <Icon size={15} color="#c4b5fd" />
      <View className="min-w-0 flex-1">
        <Text className="text-[12px] font-semibold text-zinc-100">{label}</Text>
        <Text className="text-[11px] text-zinc-500" numberOfLines={1}>
          {detail}
        </Text>
      </View>
      {busy === action ? <ActivityIndicator size="small" /> : null}
    </Pressable>
  )

  return (
    <View className="gap-2 px-3 pb-3 pt-1" style={{ flexShrink: 1, minHeight: 0 }}>
      <View className="flex-row flex-wrap gap-1">
        {files.map((file) => (
          <View key={file.path} className="flex-row items-center gap-1 rounded-md bg-white/10 px-1.5 py-0.5">
            <FileText size={10} color="#a1a1aa" />
            <Text className="max-w-[180px] text-[10px] text-zinc-200" numberOfLines={1}>
              {file.name}
            </Text>
          </View>
        ))}
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0 }}>
        <View className="flex-row gap-1.5">
          {projects.slice(0, 12).map((project) => (
            <Pressable
              key={project.id}
              onPress={() => setProjectId(project.id)}
              className={cn(
                "flex-row items-center gap-1.5 rounded-full px-2 py-1",
                project.id === projectId ? "bg-primary/30" : "bg-white/5",
              )}
            >
              <ProjectAvatar project={project} size={16} />
              <Text className="max-w-[120px] text-[11px] text-zinc-200" numberOfLines={1}>
                {project.name}
              </Text>
            </Pressable>
          ))}
        </View>
      </ScrollView>
      <View>
        {actionRow("new-chat", "Ask in a new chat", "Start a chat with these files attached", MessageSquarePlus)}
        {actionRow(
          "attach",
          "Attach to current chat",
          canAttach ? "Add them to the message you're writing" : "Open a chat first",
          Paperclip,
          !canAttach,
        )}
        {actionRow(
          "add-to-project",
          "Add to project",
          binaryCount > 0
            ? `${files.length - binaryCount} saved directly, ${binaryCount} saved by the agent`
            : "Save them to the project root",
          FilePlus2,
        )}
      </View>
      {error ? <Text className="text-[11px] text-rose-400">{error}</Text> : null}
      {done ? <Text className="text-[11px] text-emerald-400">{done}</Text> : null}
      <Pressable onPress={onCancel} className="self-end px-2 py-1">
        <Text className="text-[11px] text-zinc-400">{done ? "Close" : "Cancel"}</Text>
      </Pressable>
    </View>
  )
}
