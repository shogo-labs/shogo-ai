// SPDX-License-Identifier: MIT
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
import { ExplorationGroup } from "./ExplorationGroup"
import { EditingGroup } from "./EditingGroup"
import type { MessagePart, GroupedMessagePart } from "./types"
import { type ToolCallData } from "../tools/types"
import { getToolSummary } from "../tools/summary"
import {
  TASK_TOOL_NAMES,
  extractOrderedParts,
} from "./messageParts"
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
import { useTodoStateStore, parseTodos as parseTodosForStore } from "../../../lib/todo-state-store"
import { logScreencast } from "../../../lib/screencast-debug"
import { FileViewerModal } from "../FileViewerModal"

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

/**
 * Hold a boolean's previous `true` for `delayMs` after it transitions to
 * `false`. Rising edges (`false` → `true`) are instantaneous, so a fresh
 * tool call relights the "streaming" state immediately, but the falling
 * edge waits — preventing the Editing… / Exploring… header from
 * flickering to its summary form during the brief gap between
 * consecutive tool calls in the same agent turn.
 */
function useDelayedFalse(value: boolean, delayMs: number): boolean {
  const [stable, setStable] = useState(value)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (value) {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
      if (!stable) setStable(true)
      return
    }
    if (!stable) return
    if (timerRef.current !== null) return
    timerRef.current = setTimeout(() => {
      timerRef.current = null
      setStable(false)
    }, delayMs)
  }, [value, delayMs, stable])

  useEffect(
    () => () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current)
      }
    },
    [],
  )

  return stable
}

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

const UNGROUPABLE_TOOLS = new Set([
  "ask_user",
  "notify_user_error",
  "TodoWrite",
  "todo_write",
  "connect",
  // Legacy: keep so historical install turns still render ungrouped
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
const TEAM_TOOL_NAMES = new Set(["team_create"])

// "Low-information" tools that render as a chrome-less, hover-highlighted
// row with a human-readable label (e.g. "Read package.json"). Bash/exec
// has its own dedicated widget (`ExecWidget`) which is already minimal
// by default, so it's NOT in this set — only tools that flow through
// `InlineToolWidget` need to be flagged here.
const MINIMAL_TOOL_NAMES = new Set([
  "Read", "read_file",
  "ReadLints", "read_lints",
  "Grep", "grep", "search",
  "Glob", "glob",
  "WebSearch", "WebFetch",
  "Delete",
  "exec_wait",
])
const MIN_GROUP_SIZE = 2

// Verbs (from tools/summary.ts) that classify a tool call as an
// "exploration" action — read-only investigation that the agent is
// likely doing in bursts. The set deliberately omits destructive verbs
// (Move, Remove, Install, etc.) so they keep their dedicated widgets,
// and omits "Read lints" since the user asked for ReadLints to stay
// inline rather than fold into the exploration roll-up.
const EXPLORATION_VERBS = new Set([
  "Read",
  "List",
  "Search for",
  "Find in",
  "Find files matching",
  "Search the web for",
  "Fetch",
  "pwd",
])
const MIN_EXPLORATION_GROUP_SIZE = 2

// Tool names that fold into the "Editing…" group. write_file / Write
// and edit_file / Edit / StrReplace stay in UNGROUPABLE_TOOLS so the
// generic same-name `ToolCallGroup` ignores them — the editing pass
// below handles them instead with a richer mixed-name run.
const EDITING_TOOL_NAMES = new Set([
  "write_file",
  "Write",
  "edit_file",
  "Edit",
  "StrReplace",
])
const MIN_EDITING_GROUP_SIZE = 2

function isExplorationTool(tool: ToolCallData): boolean {
  const { verb } = getToolSummary(tool.toolName, tool.args)
  return EXPLORATION_VERBS.has(verb)
}

function isEditingTool(tool: ToolCallData): boolean {
  return EDITING_TOOL_NAMES.has(tool.toolName)
}

/**
 * Shell command (`exec` / `Bash`) whose verb is *not* a pure
 * exploration verb — typically a generic `Run` (bun test, node x.js,
 * unknown commands), `Install`, `git X`, or mutating ops like
 * `Move` / `Remove` / `Copy` / `Touch`. These fold into the Editing
 * group alongside writes/edits since they're actions, not pure
 * inspection.
 */
function isShellRunCommand(tool: ToolCallData): boolean {
  if (tool.toolName !== "exec" && tool.toolName !== "Bash") return false
  const { verb } = getToolSummary(tool.toolName, tool.args)
  return !EXPLORATION_VERBS.has(verb)
}

/**
 * Walk forward from `start` collecting tool parts that match
 * `accept`, treating `reasoning` parts as transparent (consumed into
 * the run but not counted toward the tool threshold). Returns the
 * exclusive end of the *trimmed* slice (trailing reasoning excluded)
 * and the tool count.
 */
function scanTransparentRun(
  parts: MessagePart[],
  start: number,
  accept: (tool: ToolCallData) => boolean,
): { endIdx: number; toolCount: number } {
  let j = start + 1
  let toolCount = 1
  let lastToolIdx = start
  while (j < parts.length) {
    const next = parts[j]
    if (next.type === "reasoning") {
      j++
      continue
    }
    if (next.type === "tool" && accept(next.tool)) {
      toolCount++
      lastToolIdx = j
      j++
      continue
    }
    break
  }
  return { endIdx: lastToolIdx + 1, toolCount }
}

function groupConsecutiveParts(parts: MessagePart[]): GroupedMessagePart[] {
  const result: GroupedMessagePart[] = []
  let i = 0

  while (i < parts.length) {
    const part = parts[i]

    if (part.type !== "tool") {
      result.push(part)
      i++
      continue
    }

    // Work pass: greedy run of mixed read + edit + write tools. We
    // intentionally bypass UNGROUPABLE_TOOLS here so a `cat foo` /
    // `ls` / `grep` exec can join the run alongside a Read/Grep —
    // the verb classifier in tools/summary.ts already filters out
    // destructive exec verbs.
    //
    // Reasoning parts are "transparent": a read → thought → read →
    // thought → edit sequence still counts as 3 tools, with the
    // thoughts rendered inline inside the group body. Trailing
    // reasoning is trimmed so it belongs to the next response.
    //
    // After scanning, the run is classified:
    //   - any edit/write tool or non-read shell command  → editing-group
    //   - reads + read-only shell commands only          → exploration-group
    const isWorkTool = (t: ToolCallData) =>
      isExplorationTool(t) || isEditingTool(t) || isShellRunCommand(t)

    if (isWorkTool(part.tool)) {
      const { endIdx, toolCount } = scanTransparentRun(parts, i, isWorkTool)
      const slice = parts.slice(i, endIdx)
      const hasEditing = slice.some(
        (p) =>
          p.type === "tool" &&
          (isEditingTool(p.tool) || isShellRunCommand(p.tool)),
      )
      if (hasEditing && toolCount >= MIN_EDITING_GROUP_SIZE) {
        result.push({
          type: "editing-group",
          items: slice,
          id: `edit-${parts[i].id}`,
        })
        i = endIdx
        continue
      }
      if (!hasEditing && toolCount >= MIN_EXPLORATION_GROUP_SIZE) {
        result.push({
          type: "exploration-group",
          items: slice,
          id: `explore-${parts[i].id}`,
        })
        i = endIdx
        continue
      }
      // Run below threshold — fall through to passthrough / same-name
      // grouping so 1 lone tool still renders as a plain inline row.
    }

    if (UNGROUPABLE_TOOLS.has(part.tool.toolName)) {
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


const GROUP_FALLING_EDGE_DELAY_MS = 1500

function isItemActive(item: MessagePart): boolean {
  if (item.type === "tool") return item.tool.state === "streaming"
  if (item.type === "reasoning") return item.isStreaming
  return false
}

interface GroupSlotProps {
  items: MessagePart[]
  id: string
  messageIsStreaming: boolean
  isLastGroup: boolean
}

// Slots intentionally do NOT thread a controlled `isExpanded`/`onToggle`
// down — they let `CollapsibleToolGroup` run in its uncontrolled mode so
// the group auto-expands while `stableActive` is true and auto-collapses
// (with the height-spring animation) once it falls. The user can still
// toggle the chevron to override during either phase.
const EditingGroupSlot = memo(function EditingGroupSlot({
  items,
  messageIsStreaming,
  isLastGroup,
}: GroupSlotProps) {
  const isAnyItemActive = items.some(isItemActive)
  const rawActive = isAnyItemActive || (messageIsStreaming && isLastGroup)
  const stableActive = useDelayedFalse(rawActive, GROUP_FALLING_EDGE_DELAY_MS)
  return <EditingGroup items={items} isStreaming={stableActive} />
})

const ExplorationGroupSlot = memo(function ExplorationGroupSlot({
  items,
  messageIsStreaming,
  isLastGroup,
}: GroupSlotProps) {
  const isAnyItemActive = items.some(isItemActive)
  const rawActive = isAnyItemActive || (messageIsStreaming && isLastGroup)
  const stableActive = useDelayedFalse(rawActive, GROUP_FALLING_EDGE_DELAY_MS)
  return <ExplorationGroup items={items} isStreaming={stableActive} />
})

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

  // Per-chat TodoWrite store, provided by the enclosing ChatPanel so
  // sibling tabs don't share `latestTodos` / `orderedToolIds`.
  const todoStateStore = useTodoStateStore()

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
      if (part.type === "tool" && (part.tool.toolName === "TodoWrite" || part.tool.toolName === "todo_write")) {
        const todos = parseTodosForStore(part.tool.args)
        if (todos.length > 0) {
          todoStateStore.registerWrite(part.tool.id, todos)
        }
        continue
      }
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
      // Skip if we've already captured it — session restores replay every
      // historical agent_spawn tool part and we don't want to spam logs or
      // re-notify the store on every load.
      const instanceId = (tool.result as any)?.instance_id as string | undefined
      const existing = subagentStreamStore.get(tool.id)
      if (instanceId && existing?.instanceId !== instanceId) {
        logScreencast(
          `[screencast] AssistantContent capture instance_id toolId=${tool.id} ` +
          `instanceId=${instanceId}`,
        )
        subagentStreamStore.setInstanceId(tool.id, instanceId)
      }
      const model = (tool.result as any)?.model as string | undefined
      if (model && existing?.model !== model) {
        subagentStreamStore.setModel(tool.id, model)
      }
    }
  }, [orderedParts, todoStateStore])

  const groupedParts = useMemo(
    () => groupConsecutiveParts(orderedParts),
    [orderedParts],
  )

  if (groupedParts.length === 0) {
    return null
  }

  return (
    <View className={cn("gap-y-1", className)}>
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

        if (part.type === "exploration-group") {
          return (
            <ExplorationGroupSlot
              key={part.id}
              items={part.items}
              id={part.id}
              messageIsStreaming={isStreaming}
              isLastGroup={index === groupedParts.length - 1}
            />
          )
        }

        if (part.type === "editing-group") {
          return (
            <EditingGroupSlot
              key={part.id}
              items={part.items}
              id={part.id}
              messageIsStreaming={isStreaming}
              isLastGroup={index === groupedParts.length - 1}
            />
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
            const userToggled = expandedTools.has(part.id)
            return (
              <TodoWidget
                key={part.id}
                tool={part.tool}
                userToggled={userToggled}
                onToggle={getToggle(part.id)}
              />
            )
          }

          if (
            (part.tool.toolName === "connect" ||
              part.tool.toolName === "tool_install" ||
              part.tool.toolName === "mcp_install") &&
            part.tool.state === "success"
          ) {
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

          if (part.tool.toolName === "create_plan" || part.tool.toolName === "update_plan") {
            const args = part.tool.args as Record<string, unknown> | undefined
            const pendingPlan = chatContext?.pendingPlan
            const confirmedPlan = chatContext?.confirmedPlan
            const toolCallId = part.id
            const matchesTool = (plan?: PlanData | null) => {
              if (!plan) return false
              if (plan.toolCallId && plan.toolCallId === toolCallId) return true
              if (plan.filepath && args?.filepath && plan.filepath === args.filepath) return true
              return (
                part.tool.toolName === "create_plan" &&
                !plan.toolCallId &&
                !plan.filepath &&
                plan.name === args?.name &&
                plan.plan === args?.plan
              )
            }
            const matchingPendingPlan = matchesTool(pendingPlan) ? pendingPlan : null
            const matchingConfirmedPlan = matchesTool(confirmedPlan) ? confirmedPlan : null
            const planData: PlanData | null = matchingPendingPlan ?? matchingConfirmedPlan ?? (args
              ? {
                  name: (args.name as string) ?? "Plan",
                  overview: (args.overview as string) ?? "",
                  plan: (args.plan as string) ?? "",
                  todos: (args.todos as PlanData["todos"]) ?? [],
                  filepath: args.filepath as string | undefined,
                  toolCallId,
                }
              : null)
            if (!planData) return null
            const isConfirmed =
              !!matchingConfirmedPlan &&
              ((matchingConfirmedPlan.toolCallId && matchingConfirmedPlan.toolCallId === toolCallId) ||
                (!!matchingConfirmedPlan.filepath && matchingConfirmedPlan.filepath === planData.filepath))
            const isPending = part.tool.state === "success" && !!chatContext?.buildPlan && !!matchingPendingPlan && !isConfirmed
            return (
              <PlanCard
                key={part.id}
                plan={planData}
                onBuild={isPending ? () => chatContext!.buildPlan!(planData) : undefined}
                onOpenPlan={
                  chatContext?.openPlan && planData.filepath
                    ? () => chatContext.openPlan?.(planData.filepath)
                    : undefined
                }
                onGenerateSummary={
                  chatContext?.generateSummary && planData.filepath
                    ? () => chatContext.generateSummary!(planData.filepath!)
                    : undefined
                }
                isConfirmed={isConfirmed}
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

          if (MINIMAL_TOOL_NAMES.has(part.tool.toolName)) {
            return (
              <InlineToolWidget
                key={part.id}
                tool={part.tool}
                variant="minimal"
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
