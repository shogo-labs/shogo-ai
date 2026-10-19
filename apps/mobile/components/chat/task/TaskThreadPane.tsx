// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The side window a background task opens. One pane, chosen by the task's
 * `link`: a channel thread or card thread, another project's chat session, a
 * live sub-agent, or the task's own log. It never renders blank — with no
 * destination it shows the title, source, status and whatever output exists.
 */

import { useEffect, useMemo, useState } from "react"
import { ActivityIndicator, Pressable, ScrollView, Text, View } from "react-native"
import { X } from "lucide-react-native"
import { cn } from "@shogo/shared-ui/primitives"
import type { ConversationDetail, Mentionables } from "../../../lib/team-chat-api"
import { teamChatApi } from "../../../lib/team-chat-api"
import { useActiveWorkspace } from "../../../hooks/useActiveWorkspace"
import { useMentionables } from "../../../hooks/useTeamChat"
import { useWorkspaceUser } from "../../../hooks/useWorkspaceUser"
import { subagentStreamStore } from "../../../lib/subagent-stream-store"
import { linkLabel, type TaskLink } from "../../../lib/task-link"
import type { TaskThreadTarget } from "../../../lib/task-thread-pane-store"
import { TimelinePane } from "../../team-chat/TimelinePane"
import { ProjectChatView } from "../../project/ProjectChatView"

const api = teamChatApi()

export interface TaskThreadPaneProps {
  target: TaskThreadTarget
  onClose: () => void
  /** Overlay presentation inside a phone sheet: no rounded frame of its own. */
  embedded?: boolean
}

function Header({ target, label, subtitle, onClose }: { target: TaskThreadTarget; label: string; subtitle?: string; onClose: () => void }) {
  return (
    <View className="flex-row items-center gap-2 border-b border-border px-3 py-2">
      <View className="min-w-0 flex-1">
        <Text className="text-sm font-semibold text-foreground" numberOfLines={1}>
          {label}
        </Text>
        <Text className="text-[11px] text-muted-foreground" numberOfLines={1}>
          {subtitle ?? target.title ?? target.taskId}
        </Text>
      </View>
      {target.loading ? <ActivityIndicator size="small" /> : null}
      <Pressable
        onPress={onClose}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel="Close task thread"
        className="rounded p-1 active:opacity-60"
      >
        <X size={14} className="text-muted-foreground" />
      </Pressable>
    </View>
  )
}

/** The task's own log (shell commands, or a task with no thread to open). */
function LogView({ target, onClose, reason }: { target: TaskThreadTarget; onClose: () => void; reason?: string }) {
  const text = (target.output ?? "").trim()
  return (
    <View className="flex-1">
      <Header
        target={target}
        label={target.source === "shell" ? "Command output" : "Task output"}
        subtitle={target.title ?? target.taskId}
        onClose={onClose}
      />
      {reason ? (
        <Text className="border-b border-border px-3 py-2 text-[11px] text-muted-foreground">{reason}</Text>
      ) : null}
      <ScrollView className="flex-1" contentContainerClassName="p-3">
        <Text className="font-mono text-[11px] text-foreground" selectable testID="task-thread-log">
          {text || "No output yet"}
        </Text>
      </ScrollView>
    </View>
  )
}

/** A channel or card thread, live, over the existing team-chat timeline. */
function ThreadView({ link, target, onClose }: { link: Extract<TaskLink, { kind: "channel_thread" | "card" }>; target: TaskThreadTarget; onClose: () => void }) {
  const workspace = useActiveWorkspace()
  const workspaceId = link.workspaceId ?? workspace?.id ?? null
  const mentionables = useMentionables(workspaceId)
  const user = useWorkspaceUser(workspaceId)
  const [conversation, setConversation] = useState<ConversationDetail | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setError(null)
    api
      .get(link.conversationId)
      .then((next) => {
        if (!cancelled) setConversation(next)
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "This thread is no longer available.")
      })
    return () => {
      cancelled = true
    }
  }, [link.conversationId])

  const label = link.kind === "card" ? link.itemKey : conversation?.name ? `#${conversation.name}` : linkLabel(link)
  const me = user?.id ?? null

  if (error) {
    return (
      <View className="flex-1">
        <Header target={target} label={label} subtitle="This thread is no longer available." onClose={onClose} />
        <ScrollView className="flex-1" contentContainerClassName="p-3">
          <Text className="font-mono text-[11px] text-muted-foreground" selectable>
            {(target.output ?? "").trim() || "No output yet"}
          </Text>
        </ScrollView>
      </View>
    )
  }

  if (!conversation) {
    return (
      <View className="flex-1">
        <Header target={target} label={label} onClose={onClose} />
        <View className="flex-1 items-center justify-center">
          <ActivityIndicator />
        </View>
      </View>
    )
  }

  return (
    <View className="flex-1">
      <Header
        target={target}
        label={label}
        subtitle={link.kind === "card" ? target.title ?? link.board : target.title}
        onClose={onClose}
      />
      <TimelinePane
        key={`${link.conversationId}:${link.threadRootId}`}
        workspaceId={workspaceId ?? ""}
        conversation={conversation}
        threadRootId={link.threadRootId}
        me={me}
        mentionables={mentionables as Mentionables | null}
        visible
      />
    </View>
  )
}

/** Another project's chat session, live. */
function ProjectSessionView({ link, target, onClose }: { link: Extract<TaskLink, { kind: "project_session" }>; target: TaskThreadTarget; onClose: () => void }) {
  const name = link.name ?? "Project"
  return (
    <View className="flex-1">
      <Header target={target} label={name} subtitle={target.title ?? "Running agent"} onClose={onClose} />
      <ProjectChatView projectId={link.projectId} chatSessionId={link.chatSessionId} />
    </View>
  )
}

/** A sub-agent: its live stream while it runs, its log once it has stopped. */
function SubagentView({ link, target, onClose }: { link: Extract<TaskLink, { kind: "subagent" }>; target: TaskThreadTarget; onClose: () => void }) {
  const [version, setVersion] = useState(0)
  useEffect(() => {
    const store = subagentStreamStore as unknown as { subscribe?: (fn: () => void) => () => void }
    return store.subscribe?.(() => setVersion((v) => v + 1))
  }, [])
  const stream = useMemo(() => subagentStreamStore.get(link.toolCallId), [link.toolCallId, version])
  const text = (stream?.parts ?? [])
    .map((part: any) => (typeof part?.text === "string" ? part.text : ""))
    .filter(Boolean)
    .join("\n")
    .trim()
  const body = text || (target.output ?? "").trim()

  return (
    <View className="flex-1">
      <Header
        target={target}
        label={stream?.agentType ? `Sub-agent · ${stream.agentType}` : "Sub-agent"}
        subtitle={stream?.description ?? target.title}
        onClose={onClose}
      />
      <ScrollView className="flex-1" contentContainerClassName="p-3">
        <Text className="font-mono text-[11px] text-foreground" selectable>
          {body || "No output yet"}
        </Text>
      </ScrollView>
    </View>
  )
}

export function TaskThreadPane({ target, onClose, embedded }: TaskThreadPaneProps) {
  const link = target.link ?? null
  const body = (() => {
    if (!link || link.kind === "log") {
      return <LogView target={target} onClose={onClose} reason={target.error} />
    }
    if (link.kind === "channel_thread" || link.kind === "card") return <ThreadView link={link} target={target} onClose={onClose} />
    if (link.kind === "project_session") return <ProjectSessionView link={link} target={target} onClose={onClose} />
    return <SubagentView link={link} target={target} onClose={onClose} />
  })()

  return (
    <View className={cn("flex-1 bg-background", !embedded && "border-l border-border")} testID="task-thread-pane">
      {body}
    </View>
  )
}

export default TaskThreadPane
