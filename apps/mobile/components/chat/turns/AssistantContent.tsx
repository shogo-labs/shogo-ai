// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * AssistantContent Component (React Native)
 *
 * Renders assistant message parts in order (text, tools, images interleaved).
 * Preserves the natural ordering from the AI SDK message.parts array.
 */

import { memo, useState, useCallback, useMemo, useRef, useEffect } from "react"
import { View, Text, Image, Pressable, Linking } from "react-native"
import { cn } from "@shogo/shared-ui/primitives"
import { FileText } from "lucide-react-native"
import type { UIMessage } from "@ai-sdk/react"
import { InlineToolWidget } from "./InlineToolWidget"
import { SubagentCard } from "./SubagentCard"
import { TeamCard } from "./TeamCard"
import { ExecWidget } from "./ExecWidget"
import {
  ConnectToolWidget,
  parseToolInstallResult,
} from "./ConnectToolWidget"
import { AskUserQuestionWidget } from "./AskUserQuestionWidget"
import { TodoWidget } from "./TodoWidget"
import { ToolCallGroup } from "./ToolCallGroup"
import type { MessagePart, GroupedMessagePart } from "./types"
import { type ToolCallData, getToolCategory } from "../tools/types"
import { useChatContextSafe } from "../ChatContext"
import { MarkdownText } from "../MarkdownText"
import { GenerateImageWidget } from "./GenerateImageWidget"
import { BrowserWidget } from "./BrowserWidget"
import { NotifyErrorWidget } from "./NotifyErrorWidget"
import { ThinkingWidget } from "./ThinkingWidget"
import { WriteFileWidget } from "./WriteFileWidget"
import { EditFileWidget } from "./EditFileWidget"
import { PlanCard, type PlanData } from "../PlanCard"
import { subagentStreamStore } from "../../../lib/subagent-stream-store"
import { FileViewerModal } from "../FileViewerModal"

function safeErrorString(error: unknown): string | undefined {
  if (error == null) return undefined
  if (typeof error === "string") return error
  if (error instanceof Error) return error.message
  return String(error)
}

/**
 * Throttle a streaming value so heavy downstream work (markdown parsing, part
 * extraction, JSX reconciliation for tool widgets) only fires at ~`intervalMs`
 * cadence instead of on every token. When `throttle` flips false (stream
 * ended), the latest value is flushed synchronously so the final snapshot is
 * always pixel-correct.
 *
 * The component's render function still runs on every parent re-render (cheap),
 * but any `useMemo`/`memo` keyed on the returned throttled value gets its
 * cached result back, which is where the per-token 50–260ms cost was
 * concentrated (Streamdown re-parsing the full message text per character).
 */
const STREAMING_THROTTLE_MS = 50

function useThrottledWhileStreaming<T>(value: T, isStreaming: boolean): T {
  const [throttled, setThrottled] = useState<T>(value)
  const lastEmitAtRef = useRef(0)
  const pendingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const latestValueRef = useRef(value)
  latestValueRef.current = value

  useEffect(() => {
    if (!isStreaming) {
      if (pendingTimerRef.current !== null) {
        clearTimeout(pendingTimerRef.current)
        pendingTimerRef.current = null
      }
      lastEmitAtRef.current = performance.now()
      setThrottled(value)
      return
    }

    const now = performance.now()
    const elapsed = now - lastEmitAtRef.current
    if (elapsed >= STREAMING_THROTTLE_MS) {
      lastEmitAtRef.current = now
      setThrottled(value)
      return
    }

    if (pendingTimerRef.current === null) {
      pendingTimerRef.current = setTimeout(() => {
        pendingTimerRef.current = null
        lastEmitAtRef.current = performance.now()
        setThrottled(latestValueRef.current)
      }, STREAMING_THROTTLE_MS - elapsed)
    }
  }, [value, isStreaming])

  useEffect(
    () => () => {
      if (pendingTimerRef.current !== null) {
        clearTimeout(pendingTimerRef.current)
      }
    },
    [],
  )

  return throttled
}

export interface AssistantContentProps {
  message: UIMessage
  isStreaming?: boolean
  className?: string
}

function mapToolState(state?: string, preliminary?: boolean): ToolCallData["state"] {
  if (state === "input-streaming") return "streaming"
  if (state === "output-available") return preliminary ? "streaming" : "success"
  if (state === "output-error") return "error"
  if (state === "result") return "success"
  if (state === "error") return "error"
  return "streaming"
}

function extractOrderedParts(message: UIMessage): MessagePart[] {
  const parts = (message as any).parts as any[] | undefined

  if (!parts || !Array.isArray(parts)) {
    if (
      typeof (message as any).content === "string" &&
      (message as any).content
    ) {
      return [{ type: "text", text: (message as any).content, id: "text-0" }]
    }
    return []
  }

  const result: MessagePart[] = []

  for (let index = 0; index < parts.length; index++) {
    const part = parts[index]

    if (part.type === "reasoning") {
      const hasContent = part.text?.trim().length > 0
      const isPartStreaming = "state" in part && part.state === "streaming"
      if (hasContent || isPartStreaming) {
        const durationMs = part.durationMs as number | undefined
        result.push({
          type: "reasoning",
          text: part.text || "",
          isStreaming: isPartStreaming,
          durationSeconds: durationMs ? Math.ceil(durationMs / 1000) : undefined,
          id: `reasoning-${index}`,
        })
      }
    } else if (part.type === "text") {
      if (part.text && part.text.trim()) {
        result.push({ type: "text", text: part.text, id: `text-${index}` })
      }
    } else if (part.type === "tool-invocation") {
      const inv = part.toolInvocation
      if (inv) {
        result.push({
          type: "tool",
          id: inv.toolCallId || `tool-${index}`,
          tool: {
            id: inv.toolCallId || `tool-${index}`,
            toolName: inv.toolName || "unknown",
            category: getToolCategory(inv.toolName || ""),
            state: mapToolState(inv.state),
            args: inv.args,
            result: inv.result,
            error: safeErrorString(inv.error),
            timestamp: 0,
          },
        })
      }
    } else if (part.type === "dynamic-tool") {
      const toolCallId = part.toolCallId || `tool-${index}`
      const rawError =
        part.state === "output-error"
          ? (part as { errorText?: string }).errorText ?? part.error
          : part.error
      const preliminary = part.state === "output-available" && (part as any).preliminary === true
      result.push({
        type: "tool",
        id: toolCallId,
        tool: {
          id: toolCallId,
          toolName: part.toolName || "unknown",
          category: getToolCategory(part.toolName || ""),
          state: mapToolState(part.state, preliminary),
          args: part.input,
          result: part.output,
          error: safeErrorString(rawError),
          timestamp: 0,
        },
      })
    } else if (part.type === "file" && part.url) {
      if (part.mediaType?.startsWith("image/")) {
        result.push({
          type: "image",
          url: part.url,
          mediaType: part.mediaType,
          id: `img-${index}`,
        })
      } else {
        result.push({
          type: "file",
          url: part.url,
          mediaType: part.mediaType || "application/octet-stream",
          id: `file-${index}`,
        })
      }
    }
  }

  return result
}

const UNGROUPABLE_TOOLS = new Set([
  "ask_user",
  "notify_user_error",
  "TodoWrite",
  "todo_write",
  "tool_install",
  "mcp_install",
  "generate_image",
  "exec",
  "Bash",
  "task",
  "Task",
  "agent_spawn",
  "team_create",
  "browser",
  "create_plan",
  // keep styled widgets even when consecutive:
  "write_file",
  "Write",
  "edit_file",
  "Edit",
  "StrReplace",
])
const TASK_TOOL_NAMES = new Set(["task", "Task", "agent_spawn"])
const TEAM_TOOL_NAMES = new Set(["team_create"])
const MIN_GROUP_SIZE = 2

function groupConsecutiveParts(parts: MessagePart[]): GroupedMessagePart[] {
  const result: GroupedMessagePart[] = []
  let i = 0

  while (i < parts.length) {
    const part = parts[i]

    if (part.type !== "tool" || UNGROUPABLE_TOOLS.has(part.tool.toolName)) {
      result.push(part)
      i++
      continue
    }

    const toolName = part.tool.toolName
    let j = i + 1
    while (
      j < parts.length &&
      parts[j].type === "tool" &&
      !UNGROUPABLE_TOOLS.has(
        (parts[j] as { type: "tool"; tool: ToolCallData }).tool.toolName
      ) &&
      (parts[j] as { type: "tool"; tool: ToolCallData }).tool.toolName ===
        toolName
    ) {
      j++
    }

    const runLength = j - i
    if (runLength >= MIN_GROUP_SIZE) {
      const groupTools = parts.slice(i, j).map((p) => ({
        tool: (p as { type: "tool"; tool: ToolCallData; id: string }).tool,
        id: p.id,
      }))
      result.push({
        type: "tool-group",
        toolName,
        tools: groupTools,
        id: `group-${parts[i].id}`,
      })
    } else {
      result.push(part)
    }

    i = j
  }

  return result
}


function ImageThumbnail({
  url,
  index,
}: {
  url: string
  mediaType: string
  index: number
}) {
  const [hasError, setHasError] = useState(false)

  const handlePress = useCallback(() => {
    Linking.openURL(url)
  }, [url])

  if (hasError) {
    return (
      <View className="max-w-[200px] rounded-md border border-border bg-muted p-2">
        <Text className="text-xs text-muted-foreground">
          Failed to load image
        </Text>
      </View>
    )
  }

  return (
    <Pressable onPress={handlePress} testID="image-thumbnail">
      <Image
        source={{ uri: url }}
        className="max-w-[280px] rounded-md"
        resizeMode="contain"
        accessibilityLabel={`Image attachment ${index + 1}`}
        onError={() => setHasError(true)}
        style={{ width: 280, aspectRatio: 4 / 3 }}
      />
    </Pressable>
  )
}

function FileThumbnail({
  url,
  mediaType,
  index,
}: {
  url: string
  mediaType: string
  index: number
}) {
  const [showModal, setShowModal] = useState(false)
  const [fileContent, setFileContent] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const label = mediaType.includes("pdf")
    ? "PDF"
    : mediaType.split("/").pop()?.toUpperCase() || "FILE"

  const isTextLike =
    mediaType.startsWith("text/") ||
    mediaType.includes("json") ||
    mediaType.includes("xml") ||
    mediaType.includes("javascript") ||
    mediaType.includes("yaml")

  const handlePress = useCallback(async () => {
    if (!isTextLike) {
      Linking.openURL(url)
      return
    }
    if (fileContent !== null) {
      setShowModal(true)
      return
    }
    setLoading(true)
    try {
      const res = await fetch(url)
      const text = await res.text()
      setFileContent(text)
      setShowModal(true)
    } catch {
      Linking.openURL(url)
    } finally {
      setLoading(false)
    }
  }, [url, isTextLike, fileContent])

  return (
    <>
      <Pressable
        onPress={handlePress}
        className="flex-row items-center gap-2 rounded-md border border-border bg-muted/50 px-3 py-2"
        accessibilityLabel={`File attachment ${index + 1}: ${label}`}
        accessibilityRole="button"
      >
        <FileText size={16} className="text-muted-foreground" />
        <Text className="text-xs text-muted-foreground">
          {loading ? "Loading…" : `${label} · Tap to view`}
        </Text>
      </Pressable>
      {fileContent !== null && (
        <FileViewerModal
          visible={showModal}
          onClose={() => setShowModal(false)}
          content={fileContent}
          title={`${label} File`}
          kind={mediaType.includes("json") ? "json" : "plain"}
        />
      )}
    </>
  )
}

/**
 * Memoized: markdown + tool-widget rendering is the single most expensive
 * part of a chat turn. Re-rendering prior turns on every streaming-token
 * delta, MobX reaction, or parent tab-switch was the primary source of the
 * 700ms+ click-handler blocks.
 */
export const AssistantContent = memo(
  function AssistantContent({
    message,
    isStreaming = false,
    className,
  }: AssistantContentProps) {
  const chatContext = useChatContextSafe()

  const [expandedTools, setExpandedTools] = useState<Set<string>>(new Set())

  const toggleTool = useCallback((toolId: string) => {
    setExpandedTools((prev) => {
      const next = new Set(prev)
      if (next.has(toolId)) {
        next.delete(toolId)
      } else {
        next.add(toolId)
      }
      return next
    })
  }, [])

  const toggleCacheRef = useRef<Map<string, () => void>>(new Map())
  const getToggle = useCallback((id: string) => {
    let fn = toggleCacheRef.current.get(id)
    if (!fn) {
      fn = () => toggleTool(id)
      toggleCacheRef.current.set(id, fn)
    }
    return fn
  }, [toggleTool])

  // Throttle the streaming message to ~30fps so markdown re-parsing and part
  // extraction don't run per-token. When streaming ends, the final value is
  // flushed immediately so the committed UI is always exact.
  const throttledMessage = useThrottledWhileStreaming(message, isStreaming)

  const orderedParts = useMemo(
    () => extractOrderedParts(throttledMessage),
    [throttledMessage],
  )

  // Populate subagentStreamStore from agent_spawn tool results for the Agents panel
  useEffect(() => {
    for (const part of orderedParts) {
      if (part.type !== "tool" || !TASK_TOOL_NAMES.has(part.tool.toolName)) continue
      const tool = part.tool
      const args = tool.args as Record<string, unknown> | undefined
      const agentType = (args?.subagent_type as string) ?? (args?.type as string) ?? "task"
      const description = (args?.description as string) ?? (args?.prompt as string) ?? ""
      const isDone = tool.state === "success"
      const isError = tool.state === "error"
      subagentStreamStore.init(tool.id, {
        agentId: tool.id,
        agentType,
        description,
        status: isError ? "error" : isDone ? "completed" : "running",
      })
      const resultParts = (tool.result as any)?.parts as any[] | undefined
      if (resultParts?.length) {
        subagentStreamStore.setParts(tool.id, resultParts)
      }
      // Capture the AgentManager instance id from the preliminary/final tool output
      // so the Agents panel can open the live browser screencast for this run.
      const instanceId = (tool.result as any)?.instance_id as string | undefined
      if (instanceId) {
        console.log(
          `[screencast] AssistantContent capture instance_id toolId=${tool.id} ` +
          `instanceId=${instanceId}`,
        )
        subagentStreamStore.setInstanceId(tool.id, instanceId)
      }
    }
  }, [orderedParts])

  const groupedParts = useMemo(
    () => groupConsecutiveParts(orderedParts),
    [orderedParts],
  )

  const firstTodoWriteId = useMemo(() => {
    const first = groupedParts.find(
      (p): p is Extract<GroupedMessagePart, { type: "tool" }> =>
        p.type === "tool" && (p.tool.toolName === "TodoWrite" || p.tool.toolName === "todo_write"),
    )
    return first?.id
  }, [groupedParts])

  if (groupedParts.length === 0) {
    return null
  }

  return (
    <View className={cn("gap-y-2", className)}>
      {groupedParts.map((part, index) => {
        if (part.type === "reasoning") {
          return (
            <ThinkingWidget
              key={part.id}
              text={part.text}
              isStreaming={part.isStreaming}
              durationSeconds={part.durationSeconds}
            />
          )
        }

        if (part.type === "text") {
          return (
            <View key={part.id}>
              <MarkdownText
                className="text-foreground text-xs prose-sm"
                isStreaming={isStreaming}
              >
                {part.text}
              </MarkdownText>
            </View>
          )
        }

        if (part.type === "tool-group") {
          return (
            <ToolCallGroup
              key={part.id}
              toolName={part.toolName}
              tools={part.tools}
              isExpanded={expandedTools.has(part.id)}
              onToggle={getToggle(part.id)}
            />
          )
        }

        if (part.type === "tool") {
          if (TEAM_TOOL_NAMES.has(part.tool.toolName)) {
            return <TeamCard key={part.id} tool={part.tool} />
          }

          if (TASK_TOOL_NAMES.has(part.tool.toolName)) {
            return <SubagentCard key={part.id} tool={part.tool} />
          }

          if (part.tool.toolName === "ask_user") {
            const isPending = part.tool.result === undefined
            const isExpanded = isPending || expandedTools.has(part.id)

            return (
              <AskUserQuestionWidget
                key={part.id}
                tool={part.tool}
                isExpanded={isExpanded}
                onToggle={getToggle(part.id)}
                onSubmitResponse={(response) => {
                  if (chatContext?.sendMessage) {
                    chatContext.sendMessage(response)
                  }
                  if (chatContext?.saveToolOutput) {
                    chatContext.saveToolOutput({
                      messageId: message.id,
                      toolCallId: part.id,
                      output: response,
                    })
                  }
                }}
              />
            )
          }

          if (part.tool.toolName === "TodoWrite" || part.tool.toolName === "todo_write") {
            const isFirst = part.id === firstTodoWriteId
            const isExpanded = isFirst
              ? !expandedTools.has(part.id)
              : expandedTools.has(part.id)

            return (
              <TodoWidget
                key={part.id}
                tool={part.tool}
                isExpanded={isExpanded}
                onToggle={getToggle(part.id)}
              />
            )
          }

          if (part.tool.toolName === "tool_install" && part.tool.state === "success") {
            const installResult = parseToolInstallResult(part.tool.result)
            if (installResult?.authStatus === "needs_auth" && installResult?.authUrl) {
              return (
                <ConnectToolWidget
                  key={part.id}
                  toolkitName={installResult.integration || "Service"}
                  authUrl={installResult.authUrl}
                  toolCount={installResult.toolCount || 0}
                />
              )
            }
          }

          if (part.tool.toolName === "generate_image") {
            return (
              <GenerateImageWidget key={part.id} tool={part.tool} />
            )
          }

          if (part.tool.toolName === "create_plan") {
            const args = part.tool.args as Record<string, unknown> | undefined
            const planData: PlanData | null = args
              ? {
                  name: (args.name as string) ?? "Plan",
                  overview: (args.overview as string) ?? "",
                  plan: (args.plan as string) ?? "",
                  todos: (args.todos as PlanData["todos"]) ?? [],
                  filepath: args.filepath as string | undefined,
                }
              : null
            if (!planData) return null
            const isPending = part.tool.state === "success" && !!chatContext?.confirmPlan
            return (
              <PlanCard
                key={part.id}
                plan={planData}
                onConfirm={isPending ? chatContext!.confirmPlan! : undefined}
                isConfirmed={false}
              />
            )
          }

          if (part.tool.toolName === "notify_user_error") {
            return (
              <NotifyErrorWidget key={part.id} tool={part.tool} />
            )
          }

          if (part.tool.toolName === "exec" || part.tool.toolName === "Bash") {
            return (
              <ExecWidget
                key={part.id}
                tool={part.tool}
                isExpanded={expandedTools.has(part.id)}
                onToggle={getToggle(part.id)}
              />
            )
          }

          if (part.tool.toolName === "write_file" || part.tool.toolName === "Write") {
            return (
              <WriteFileWidget
                key={part.id}
                tool={part.tool}
                isExpanded={expandedTools.has(part.id)}
                onToggle={getToggle(part.id)}
              />
            )
          }

          if (part.tool.toolName === "edit_file" || part.tool.toolName === "Edit" || part.tool.toolName === "StrReplace") {
            return (
              <EditFileWidget
                key={part.id}
                tool={part.tool}
                isExpanded={expandedTools.has(part.id)}
                onToggle={getToggle(part.id)}
              />
            )
          }

          if (part.tool.toolName === "browser") {
            return (
              <BrowserWidget
                key={part.id}
                tool={part.tool}
                isExpanded={expandedTools.has(part.id)}
                onToggle={getToggle(part.id)}
              />
            )
          }

          return (
            <InlineToolWidget
              key={part.id}
              tool={part.tool}
              isExpanded={expandedTools.has(part.id)}
              onToggle={getToggle(part.id)}
            />
          )
        }

        if (part.type === "image") {
          return (
            <ImageThumbnail
              key={part.id}
              url={part.url}
              mediaType={part.mediaType}
              index={index}
            />
          )
        }

        if (part.type === "file") {
          return (
            <FileThumbnail
              key={part.id}
              url={part.url}
              mediaType={part.mediaType}
              index={index}
            />
          )
        }

        return null
      })}
    </View>
  )
  },
  (prev, next) =>
    prev.message === next.message &&
    prev.isStreaming === next.isStreaming &&
    prev.className === next.className,
)

export default AssistantContent
