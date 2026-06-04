// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * ChatPanel - Smart component that integrates useChat hook with studio-chat domain
 * Tasks: task-2-4-004, task-3-1-004, task-cpbi-004, task-cpbi-005
 *
 * React Native migration of apps/web/src/components/app/chat/ChatPanel.tsx
 *
 * Integrates AI SDK useChat hook for streaming chat, composes child components,
 * handles message persistence to studio-chat domain, and provides chat state to context.
 *
 * Features:
 * - useChat from @ai-sdk/react with /api/chat endpoint
 * - Persists user messages optimistically before sending
 * - Persists assistant messages in onFinish callback
 * - Tool call data is embedded in chat messages (logging to separate table disabled)
 * - Auto-creates ChatSession if none exists for feature
 * - Collapse/expand with AsyncStorage persistence
 * - Error display with Retry button
 * - Smart query triggers: Detects tool calls in onFinish and triggers targeted data refreshes
 *
 * Mobile-specific adaptations:
 * - No resize drag handle (full-width on mobile)
 * - AsyncStorage instead of localStorage
 * - ScrollView with scrollToEnd instead of scrollIntoView
 * - expo-router instead of react-router-dom
 * - No document/window DOM APIs
 */

import { useState, useEffect, useRef, useCallback, useMemo } from "react"
import * as Sentry from "@sentry/react-native"
import {
  Alert,
  View,
  Text,
  Pressable,
  ScrollView,
  Platform,
  StyleSheet,
  type ViewStyle,
  ActivityIndicator,
  KeyboardAvoidingView,
  Keyboard,
  useWindowDimensions,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from "react-native"
import { observer } from "mobx-react-lite"
import { useChat, type UIMessage } from "@ai-sdk/react"
import { useRouter } from "expo-router"
import { DefaultChatTransport } from "ai"
import AsyncStorage from "@react-native-async-storage/async-storage"
import {
  extractTextContent,
  formatErrorMessage,
  isTunnelDisconnectError,
  formatToolName,
  getToolCategory,
  ERROR_CODE_MESSAGES,
} from "@shogo/shared-app/chat"
import {
  useChatTransportConfig,
  buildChatTurnUrl,
  truncateMessagesFrom,
  getPrecedingCheckpoint,
  rollbackProjectToCheckpoint,
  type PrecedingCheckpointResult,
} from "@shogo/shared-app/chat"
import { useSDKDomains, useDomainActions, useChatMessageCollectionForSession } from "@shogo/shared-app/domain"
import { decideMessagesPropagation } from "./messages-propagation"
import { useNotifyOnTurnComplete } from "./useNotifyOnTurnComplete"
import { probeChatTurnStatus, shouldAttachLiveStream } from "./probe-turn-status"
import { cn } from "@shogo/shared-ui/primitives"
import { API_URL, api, createHttpClient } from "../../lib/api"
import { hasAcceptedAiConsent, acceptAiConsent, revokeAiConsent, AI_PROVIDERS } from "../../lib/ai-consent"

import { isNativePhoneIntegrationsLayout } from "../../lib/native-phone-layout"
import { authClient } from "../../lib/auth-client"
import { useActiveInstance } from "../../contexts/active-instance"
import { ChatHeader } from "./ChatHeader"
import { MessageList } from "./MessageList"
import {
  ChatInput,
  DEFAULT_MODEL_PRO,
  DEFAULT_MODEL_FREE,
  type InteractionMode,
  type FileAttachment,
  type RestoreDraftRequest,
} from "./ChatInput"
import {
  loadInteractionModePreference,
  saveInteractionModePreference,
} from "../../lib/interaction-mode-preference"
import { useDualPlan } from "../../lib/dual-plan-preference"
import {
  isChatStalled,
  DEFAULT_SUBMITTED_STALL_MS,
  DEFAULT_STREAMING_STALL_MS,
} from "../../lib/chat-stall-watchdog"
import { createTodoStateStore, TodoStateStoreContext } from "../../lib/todo-state-store"
import {
  loadModelPreference,
  saveModelPreference,
} from "../../lib/agent-mode-preference"
import { CompactChatInput } from "./CompactChatInput"
import { ExecutionBadge } from "./ExecutionBadge"
import { ExpandTab } from "./ExpandTab"
import { ToolCallDisplay, type ToolCallState } from "./ToolCallDisplay"
import {
  ChatContextProvider,
  type ChatContextValue,
  type ChatMessage,
} from "./ChatContext"

// Stable empty array we hand to the chat context's `messages` field.
// See the long comment near `contextValue` below — we intentionally do
// not plumb the live message list through context, so this constant
// satisfies the type without flipping per token.
const EMPTY_CONTEXT_MESSAGES: ChatMessage[] = []
import { TurnList } from "./turns"
import {
  MessageEditProvider,
  type MessageEditOptions,
} from "./turns/MessageEditContext"
import { EditConfirmDialogHost } from "./turns/EditConfirmDialog"
import { PhaseEmptyState } from "./empty"
import {
  SubagentPanel,
  type SubagentProgress as SubagentProgressType,
  type RecentTool as RecentToolType,
} from "./subagent"
import {
  type ToolCallData,
  getToolCategory as getToolCategoryFromTools,
} from "./tools/types"
import { subagentStreamStore } from "../../lib/subagent-stream-store"
import { teamStore } from "../../lib/team-store"
import * as ExpoLinking from "expo-linking"
import { AlertCircle, RefreshCw, X, ChevronDown } from "lucide-react-native"
import { type PlanData } from "./PlanCard"
import { usePlanStreamSafe } from "./PlanStreamContext"
import { AgentClient } from "@shogo-ai/sdk/agent"
import { agentFetch } from "../../lib/agent-fetch"
import { openAuthFlow, preCreateAuthWindow } from "@shogo/ui-kit/platform"
import { PermissionApprovalDialog } from "../security/PermissionApprovalDialog"
import { buildStopRequest } from "../../lib/chat-stop"
import { configureSubagentStop } from "../../lib/subagent-stop"
import { useChatBridgeRegistrar } from "../voice-mode/ChatBridgeContext"
import { extractTaskToolsFromMessages } from "./turns/messageParts"
import { derivePendingQuestion } from "./turns/pendingQuestion"
import {
  FIX_IN_AGENT_EVENT,
  buildFixPrompt,
  type FixInAgentPayload,
} from "../project/panels/ide/agentFixProvider"

// ============================================================
// Types
// ============================================================

type SubagentProgressEvent =
  | { type: "subagent-start"; agentId: string; agentType: string; timestamp: number }
  | { type: "subagent-stop"; agentId: string; timestamp: number }
  | { type: "tool-complete"; toolName: string; toolUseId: string; timestamp: number }

interface VirtualToolEvent {
  type: "virtual-tool-execute"
  toolUseId: string
  toolName: string
  args: Record<string, unknown>
  timestamp: number
}

type OptimisticUserInput = {
  sessionId: string
  content: string
  files?: FileAttachment[]
}

export type QueuedMessage = {
  id: string
  content: string
  files?: FileAttachment[]
  selectedModel?: string
}

function buildOptimisticUserMessage(input: OptimisticUserInput, id = "optimistic-user-pending"): UIMessage {
  const parts: any[] = []
  const text = input.content.trim()

  if (text) {
    parts.push({ type: "text", text })
  }

  for (const file of input.files ?? []) {
    parts.push({
      type: "file",
      mediaType: file.type || "application/octet-stream",
      url: file.dataUrl,
      ...(file.name ? { name: file.name } : {}),
    })
  }

  return {
    id,
    role: "user",
    parts,
  } as unknown as UIMessage
}

function hasMatchingUserMessage(messages: UIMessage[], input: OptimisticUserInput): boolean {
  const text = input.content.trim()
  return messages.some((message) => {
    if (message.role !== "user") return false
    if (text && extractTextContent(message).trim() === text) return true
    return !text && (input.files?.length ?? 0) > 0
  })
}

interface SubagentProgress {
  agentId: string
  agentType: string
  startTime: number
  status: "running" | "completed"
  toolCount: number
}

interface RecentToolCall {
  id: string
  toolName: string
  timestamp: number
}

// ============================================================
// Virtual Tool v2 Mappings
// ============================================================

const LAYOUT_TO_TEMPLATE: Record<string, string> = {
  single: "layout-workspace-flexible",
  "split-h": "layout-workspace-split-h",
  "split-v": "layout-workspace-split-v",
}

export interface WorkspacePanelData {
  id: string
  type: "preview" | "code" | "schema" | "docs"
  title: string
  content?: React.ReactNode
}

export interface ChatPanelProps {
  mode?: "compact" | "full"
  featureId: string | null
  featureName?: string
  phase: string | null
  workspaceId?: string
  userId?: string
  projectId?: string
  /**
   * Chat routing scope. `'project'` (default) chats against the per-project
   * runtime (`/api/projects/:projectId/chat`); `'workspace'` chats against
   * the merged-root workspace runtime (`/api/workspaces/:workspaceId/chat`)
   * using `chatSessionId` as a workspace-scoped session id. The workspace
   * path requires `workspaceId`.
   */
  chatScope?: "project" | "workspace"
  localAgentUrl?: string | null
  children?: React.ReactNode
  className?: string
  onSchemaRefresh?: () => void
  onRefresh?: () => Promise<void>
  onStreamingChange?: (isStreaming: boolean) => void
  isPolling?: boolean
  onNavigateToPhase?: (phase: string) => void
  onOpenPanel?: (panel: WorkspacePanelData) => void
  chatSessionId?: string | null
  onChatSessionChange?: (sessionId: string) => void
  isCollapsed?: boolean
  onCollapsedChange?: (collapsed: boolean) => void
  initialMessage?: string
  initialFiles?: FileAttachment[]
  /** When set (e.g. from home composer), overrides stored interaction mode for this session and first message */
  initialInteractionMode?: InteractionMode
  onCompactSubmit?: (prompt: string, files?: FileAttachment[]) => void
  compactValue?: string
  onCompactValueChange?: (value: string) => void
  onChatError?: (error: Error | null) => void
  injectMessage?: string | null
  onFilesChanged?: (paths: string[]) => void
  onActiveToolCall?: (toolName: string | null) => void
  selectedThemeId?: string
  onSelectTheme?: (themeId: string) => void
  onCreateTheme?: () => void
  projectType?: string
  /** Legacy domain stores (platformFeatures, componentBuilder) — optional on mobile */
  legacyDomains?: {
    platformFeatures?: any
    componentBuilder?: any
  }
  /** Billing data — optional on mobile; if not provided, defaults to basic mode */
  billingData?: {
    hasActiveSubscription: boolean
    hasAdvancedModelAccess?: boolean
    refetchUsageWallet: () => void
  }
  /** Called whenever the streaming messages array changes (for TerminalPanel etc.) */
  onMessagesChange?: (messages: any[]) => void
  /** Triggered from the Plans panel Build button — executes a saved plan */
  buildPlanRequest?: { plan: PlanData; modelId: string; nonce: number } | null
  /** Notifies the parent that a build request has been consumed so it can clear state. */
  onBuildPlanConsumed?: (nonce: number) => void
  /** Opens the saved plan artifact in the Plans panel. */
  onOpenPlan?: (filepath?: string | null) => void
  /** Controlled model selection — when provided, ChatPanel uses this instead of its own state */
  selectedModel?: string
  onModelChange?: (modelId: string) => void
  /** When false, defers non-essential network requests (quick-actions, stream reconnect). Defaults to true. */
  isActive?: boolean
}

// ============================================================
// Constants
// ============================================================

const STORAGE_KEY_COLLAPSED = "chat-panel-collapsed"

// ============================================================
// AsyncStorage Helpers
// ============================================================

async function getStoredCollapsed(): Promise<boolean> {
  try {
    const stored = await AsyncStorage.getItem(STORAGE_KEY_COLLAPSED)
    return stored === "true"
  } catch {
    return false
  }
}

async function setStoredCollapsed(collapsed: boolean): Promise<void> {
  try {
    await AsyncStorage.setItem(STORAGE_KEY_COLLAPSED, String(collapsed))
  } catch {
    // Silently ignore storage errors
  }
}

// ============================================================
// Tool Call Extraction Helper
// ============================================================

interface ExtractedToolCall {
  toolName: string
  state: ToolCallState
  args?: Record<string, unknown>
  result?: unknown
  error?: string
}

function extractToolCalls(message: UIMessage): ExtractedToolCall[] {
  if (!("parts" in message) || !Array.isArray((message as any).parts)) {
    return []
  }

  return ((message as any).parts as any[])
    .filter((part) => part.type === "tool-invocation" || part.type === "dynamic-tool")
    .map((part) => {
      if (part.type === "tool-invocation") {
        const invocation = part.toolInvocation
        return {
          toolName: invocation?.toolName || "unknown",
          state: mapToolCallState(invocation?.state),
          args: invocation?.args,
          result: invocation?.result,
          error: invocation?.error,
        }
      } else {
        const errorContent =
          part.state === "output-error"
            ? (part as { errorText?: string }).errorText ?? part.error
            : part.error
        return {
          toolName: part.toolName || "unknown",
          state: mapToolCallState(part.state),
          args: part.input || part.args,
          result: part.output || part.result,
          error: errorContent,
        }
      }
    })
}

function mapToolCallState(state: string | undefined): ToolCallState {
  switch (state) {
    case "partial-call":
      return "input-streaming"
    case "call":
      return "input-available"
    case "result":
    case "output-available":
    case "success":
      return "output-available"
    case "error":
    case "output-error":
      return "output-error"
    default:
      return "input-streaming"
  }
}

// ============================================================
// Parts Serialization Helpers
// ============================================================

function hasToolCalls(message: UIMessage): boolean {
  const parts = (message as any).parts as any[] | undefined
  if (!parts || !Array.isArray(parts)) return false
  return parts.some((p) => p.type === "tool-invocation" || p.type === "dynamic-tool")
}

function serializeParts(parts: any[] | undefined): string | undefined {
  if (!parts || !Array.isArray(parts)) return undefined

  const persistableParts = parts.filter(
    (p) =>
      p.type === "text" ||
      p.type === "tool-invocation" ||
      p.type === "dynamic-tool" ||
      p.type === "file"
  )

  if (persistableParts.length === 0) return undefined

  const MAX_RESULT_SIZE = 50000
  const truncatedParts = persistableParts.map((p) => {
    if (p.type === "tool-invocation" && p.toolInvocation?.result) {
      const resultStr = JSON.stringify(p.toolInvocation.result)
      if (resultStr.length > MAX_RESULT_SIZE) {
        return {
          ...p,
          toolInvocation: {
            ...p.toolInvocation,
            result: { _truncated: true, size: resultStr.length },
          },
        }
      }
    }
    if (p.type === "dynamic-tool" && p.output) {
      const outputStr = JSON.stringify(p.output)
      if (outputStr.length > MAX_RESULT_SIZE) {
        return { ...p, output: { _truncated: true, size: outputStr.length } }
      }
    }
    return p
  })

  return JSON.stringify(truncatedParts)
}

// ============================================================
// Smart Query Trigger Mapping (task-3-1-004)
// ============================================================

const PLATFORM_FEATURES_MODEL_MAP: Record<string, string> = {
  Requirement: "requirementCollection",
  AnalysisFinding: "analysisFindingCollection",
  DesignDecision: "designDecisionCollection",
  ImplementationTask: "implementationTaskCollection",
  TestSpecification: "testSpecificationCollection",
  ImplementationRun: "implementationRunCollection",
  TaskExecution: "taskExecutionCollection",
  FeatureSession: "featureSessionCollection",
}

const COMPONENT_BUILDER_MODEL_MAP: Record<string, string> = {
  ComponentDefinition: "componentDefinitionCollection",
  Registry: "registryCollection",
  RendererBinding: "rendererBindingCollection",
  LayoutTemplate: "layoutTemplateCollection",
  Composition: "compositionCollection",
  ComponentSpec: "componentSpecCollection",
}

interface RefreshTarget {
  schema: "platform-features" | "component-builder"
  collections: string[]
}

function getRefreshTarget(toolCall: ExtractedToolCall): RefreshTarget | null {
  const { toolName, args } = toolCall

  const normalizedToolName = toolName.includes("__")
    ? toolName.split("__").pop() || toolName
    : toolName

  if (!["store_create", "store_update", "store_delete"].includes(normalizedToolName)) {
    return null
  }

  const model = args?.model as string | undefined
  const schema = args?.schema as string | undefined

  if (!model) return null

  if (schema === "component-builder") {
    const collection = COMPONENT_BUILDER_MODEL_MAP[model]
    if (collection) {
      return { schema: "component-builder", collections: [collection] }
    }
  } else {
    const collection = PLATFORM_FEATURES_MODEL_MAP[model]
    if (collection) {
      return { schema: "platform-features", collections: [collection] }
    }
  }

  return null
}

function requiresSchemaRefresh(toolCall: ExtractedToolCall): boolean {
  const { toolName } = toolCall

  const normalizedToolName = toolName.includes("__")
    ? toolName.split("__").pop() || toolName
    : toolName

  return normalizedToolName === "schema_set" || normalizedToolName === "schema_load"
}

const FILE_OPERATION_TOOLS = new Set([
  "Write",
  "Edit",
  "StrReplace",
  "Delete",
  "template_copy",
  "template.copy",
])

function getModifiedFilePaths(toolCalls: ExtractedToolCall[]): string[] {
  const paths: string[] = []

  for (const toolCall of toolCalls) {
    if (toolCall.state !== "output-available") {
      continue
    }

    const normalizedToolName = toolCall.toolName.includes("__")
      ? toolCall.toolName.split("__").pop() || toolCall.toolName
      : toolCall.toolName

    if (!FILE_OPERATION_TOOLS.has(normalizedToolName)) {
      continue
    }

    const args = toolCall.args as Record<string, unknown> | undefined
    const filePath = (args?.file_path ?? args?.path ?? args?.filePath) as string | undefined
    if (filePath && typeof filePath === "string") {
      paths.push(filePath)
    }

    if (normalizedToolName === "template_copy" || normalizedToolName === "template.copy") {
      paths.push("*")
    }
  }

  return [...new Set(paths)]
}

async function refreshCollections(
  domain: any,
  collectionNames: string[],
  domainName: string = "domain"
): Promise<void> {
  if (!domain || collectionNames.length === 0) {
    return
  }

  const uniqueCollections = [...new Set(collectionNames)]

  const refreshPromises = uniqueCollections.map(async (collectionName) => {
    const collection = domain[collectionName]
    if (collection?.query && typeof collection.query === "function") {
      try {
        await collection.query().toArray()
      } catch (err) {
        console.warn(`[ChatPanel] Failed to refresh ${domainName}.${collectionName}:`, err)
      }
    }
  })

  await Promise.all(refreshPromises)
}

// ============================================================
// Toolkit Error Messages
// ============================================================

// ============================================================
// Message list scroll — load-older thresholds (domain SDK loads via chatMessageCollection)
// ============================================================

/** Y offset from top below which we treat the viewport as "at the top" for loading older messages. */
const LOAD_OLDER_SCROLL_EDGE_PX = 80

/** Pixels from bottom to consider the user "at bottom" for follow-scroll heuristics (web). */
const SCROLL_NEAR_BOTTOM_PX = 100

/**
 * Web only: debounce scheduling load-older when the user rests near the top.
 * Avoids firing on every scroll frame (wheel/trackpad).
 */
const LOAD_OLDER_WEB_DEBOUNCE_MS = 450

/** react-native-web exposes scrollbar*; not in core ViewStyle — cast for StyleSheet. */
const CHAT_MESSAGES_SCROLL_WEB: ViewStyle = {
  scrollbarWidth: "thin",
  scrollbarColor: "rgba(150,150,150,0.3) transparent",
} as ViewStyle

const chatMessagesScrollStyles = StyleSheet.create({
  scroll: Platform.select({
    web: CHAT_MESSAGES_SCROLL_WEB,
    default: {},
  }),
})

// ============================================================
// Per-session UIMessage cache
// ============================================================
//
// Survives session switches and panel remounts so revisiting a session renders
// its messages instantly instead of showing a loading UI while Effect 1
// refetches from the API. The stale-while-revalidate fetch still runs in the
// background and reconciles via `setMessages` if the server differs.
//
// Keyed by sessionId. Evicted on explicit `clearChatPanelMessageCache()` (e.g.
// user logout). Memory cost is small: a few UIMessage arrays per session.
const sessionMessageCache = new Map<string, UIMessage[]>()

/** Clear the in-memory per-session UIMessage cache (e.g. on logout). */
export function clearChatPanelMessageCache(): void {
  sessionMessageCache.clear()
}

// Per-session queued-message cache. Survives ChatPanel unmount/remount during
// navigation so users don't lose what they've typed and queued. Keyed by
// sessionId; cleared on explicit `clearChatPanelQueueCache()` or whenever the
// queue for a session drains naturally (delete, send, edit-out).
const sessionQueueCache = new Map<string, QueuedMessage[]>()

/** Clear the in-memory per-session queued-message cache (e.g. on logout). */
export function clearChatPanelQueueCache(): void {
  sessionQueueCache.clear()
}

function normalizePlanFilepath(filepath?: string | null): string | undefined {
  if (!filepath) return undefined
  const normalized = filepath.replace(/^\/+/, "").replace(/\\/g, "/")
  const filename = normalized.split("/").pop()
  if (!filename || !/^[a-zA-Z0-9._-]+\.plan\.md$/.test(filename)) return undefined
  return `.shogo/plans/${filename}`
}

function normalizePlanData(plan: PlanData): PlanData {
  return {
    ...plan,
    todos: plan.todos ?? [],
    filepath: normalizePlanFilepath(plan.filepath),
    summary: plan.summary,
    summaryStatus: plan.summaryStatus,
  }
}

// ============================================================
// Component
// ============================================================

export const ChatPanel = observer(function ChatPanel({
  mode = "full",
  featureId,
  featureName,
  phase,
  workspaceId,
  userId,
  projectId,
  chatScope = "project",
  localAgentUrl,
  children,
  className,
  onSchemaRefresh,
  onRefresh,
  onStreamingChange,
  isPolling,
  onNavigateToPhase,
  onOpenPanel,
  chatSessionId,
  onChatSessionChange,
  isCollapsed: controlledIsCollapsed,
  onCollapsedChange,
  initialMessage,
  initialFiles,
  initialInteractionMode,
  onCompactSubmit,
  compactValue,
  onCompactValueChange,
  onChatError,
  injectMessage,
  onFilesChanged,
  onActiveToolCall,
  selectedThemeId,
  onSelectTheme,
  onCreateTheme,
  projectType,
  legacyDomains,
  billingData,
  onMessagesChange,
  buildPlanRequest,
  onBuildPlanConsumed,
  onOpenPlan,
  selectedModel: controlledSelectedModel,
  onModelChange: controlledOnModelChange,
  isActive = true,
}: ChatPanelProps) {
  const { width: windowWidth, height: windowHeight } = useWindowDimensions()
  const isNativePhoneLayout = isNativePhoneIntegrationsLayout(windowWidth, windowHeight)

  const { studioChat } = useSDKDomains()
  const actions = useDomainActions()

  const platformFeatures = legacyDomains?.platformFeatures
  const componentBuilder = legacyDomains?.componentBuilder

  const router = useRouter()

  const hasActiveSubscription = billingData?.hasActiveSubscription ?? false
  const hasAdvancedModelAccess = billingData?.hasAdvancedModelAccess ?? hasActiveSubscription
  const refetchUsageWallet = billingData?.refetchUsageWallet ?? (() => {})

  const handleUpgradeClick = useCallback(() => {
    router.push('/(app)/billing' as any)
  }, [router])

  // Panel state
  const [internalIsCollapsed, setInternalIsCollapsed] = useState(false)
  const isCollapsed = controlledIsCollapsed ?? internalIsCollapsed
  const setIsCollapsed = onCollapsedChange ?? setInternalIsCollapsed

  // Load stored collapse state from AsyncStorage on mount
  useEffect(() => {
    getStoredCollapsed().then((stored) => {
      if (controlledIsCollapsed === undefined) {
        setInternalIsCollapsed(stored)
      }
    })
  }, [controlledIsCollapsed])


  const nativeHeaders = useMemo(() => {
    if (Platform.OS === 'web') return undefined
    return (): Record<string, string> => {
      const cookie = authClient.getCookie()
      return cookie ? { Cookie: cookie } : {}
    }
  }, [])

  const expoFetch = useMemo(() => {
    if (Platform.OS === 'web') return undefined
    return require('expo/fetch').fetch as typeof globalThis.fetch
  }, [])

  // Quick actions state
  const [quickActions, setQuickActions] = useState<{ label: string; prompt: string }[]>([])

  const fetchQuickActions = useCallback(async () => {
    const url = localAgentUrl || (projectId ? `${API_URL}/api/projects/${projectId}/agent-proxy` : null)
    if (!url) return
    try {
      const fetchFn = expoFetch ?? globalThis.fetch
      const headers: Record<string, string> = nativeHeaders ? nativeHeaders() : {}
      const res = await fetchFn(`${url}/agent/quick-actions`, {
        headers,
        credentials: Platform.OS === 'web' ? 'include' : undefined,
      } as any)
      if (res.ok) {
        const data = await res.json()
        if (Array.isArray(data?.actions)) {
          setQuickActions(data.actions)
        }
      }
    } catch {
      // Silently ignore — quick actions are non-critical
    }
  }, [localAgentUrl, projectId, nativeHeaders, expoFetch])

  useEffect(() => {
    if (!isActive) return

    fetchQuickActions()

    // Retry after a delay — the agent runtime may not be ready on first mount
    const retryTimer = setTimeout(() => fetchQuickActions(), 3000)
    return () => clearTimeout(retryTimer)
  }, [fetchQuickActions, isActive])

  // Track whether we've already triggered AI naming for this session
  const hasTriggeredNamingRef = useRef(false)

  useEffect(() => {
    hasTriggeredNamingRef.current = false
  }, [chatSessionId])

  // Auto-scroll refs
  const scrollViewRef = useRef<ScrollView>(null)
  const isUserAtBottomRef = useRef(true)
  /** Native only: true = follow new content; set false the instant the user drags */
  const stickToBottomRef = useRef(true)
  const isLoadingOlderRef = useRef(false)
  const contentHeightBeforeLoadRef = useRef(0)
  const prevDisplayLengthRef = useRef(0)
  /** Web only: debounce timer for near-top load-older (see LOAD_OLDER_WEB_DEBOUNCE_MS). */
  const loadOlderWebDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  /**
   * Timestamp (ms) until which any onScroll events should be treated as
   * programmatic and NOT used to flip follow state. Our own scrollToEnd /
   * scrollTo calls fire onScroll on web; without this guard, streaming-token
   * auto-scrolls silently re-engage follow after the user scrolled away.
   */
  const programmaticScrollUntilRef = useRef(0)
  const MESSAGE_PAGE_SIZE = 10
  const isNative = Platform.OS !== "web"
  /** Native re-engage threshold: distance from bottom (px) on drag/momentum end
   * within which we treat the user as having returned to the bottom and resume
   * follow. 40px is forgiving enough that a soft release after a peek-up does
   * not snap follow back on against the user's intent. */
  const STICK_BOTTOM_PX = 40
  const pendingScrollRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastScrollTimeRef = useRef(0)
  const SCROLL_THROTTLE_MS = 300
  /**
   * Minimum positive `onContentSizeChange` delta that triggers an
   * auto-follow on native. Filters out spring-jitter (≤3px) and
   * contractions (negative delta, e.g. a thinking widget closing) so
   * the parent ScrollView only chases real new content. See the long
   * comment at the call site (~line 4220).
   */
  const AUTOSCROLL_MIN_DELTA_PX = 4
  /** Duration of the programmatic-scroll guard window (ms). Must comfortably
   * exceed the time between a scrollTo* call and the resulting onScroll event. */
  const PROGRAMMATIC_SCROLL_GUARD_MS = 250

  /**
   * Mark the next ~250ms of onScroll events as programmatic so handlers ignore
   * them. Call this immediately before any of our own scrollTo/scrollToEnd. */
  const markProgrammaticScroll = useCallback(() => {
    programmaticScrollUntilRef.current = Date.now() + PROGRAMMATIC_SCROLL_GUARD_MS
  }, [])

  /** Mirrors stick/at-bottom into React so we can show the "Jump to latest"
   * pill. Source of truth for streaming follow remains the refs above. */
  const [isFollowing, setIsFollowing] = useState(true)

  const shouldFollowBottom = useCallback(
    () => (isNative ? stickToBottomRef.current : isUserAtBottomRef.current),
    [isNative]
  )

  const scrollToBottomIfFollowing = useCallback(
    (animated = false) => {
      if (shouldFollowBottom()) {
        markProgrammaticScroll()
        scrollViewRef.current?.scrollToEnd({ animated })
      }
    },
    [shouldFollowBottom, markProgrammaticScroll]
  )

  const throttledScrollToEnd = useCallback(() => {
    const now = Date.now()
    const elapsed = now - lastScrollTimeRef.current
    if (elapsed >= SCROLL_THROTTLE_MS) {
      markProgrammaticScroll()
      scrollViewRef.current?.scrollToEnd({ animated: true })
      lastScrollTimeRef.current = now
    } else if (!pendingScrollRef.current) {
      pendingScrollRef.current = setTimeout(() => {
        markProgrammaticScroll()
        scrollViewRef.current?.scrollToEnd({ animated: true })
        lastScrollTimeRef.current = Date.now()
        pendingScrollRef.current = null
      }, SCROLL_THROTTLE_MS - elapsed)
    }
  }, [markProgrammaticScroll])

  const syncStickFromNativeEvent = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      if (!isNative) return
      const { layoutMeasurement, contentOffset, contentSize } = e.nativeEvent
      const fromBottom =
        contentSize.height - contentOffset.y - layoutMeasurement.height
      const atBottom = fromBottom <= STICK_BOTTOM_PX
      stickToBottomRef.current = atBottom
      setIsFollowing(atBottom)
    },
    [isNative]
  )

  /** Re-engage follow and snap to the latest message. Used by the
   * "Jump to latest" pill. */
  const jumpToLatest = useCallback(() => {
    isUserAtBottomRef.current = true
    stickToBottomRef.current = true
    setIsFollowing(true)
    markProgrammaticScroll()
    scrollViewRef.current?.scrollToEnd({ animated: true })
  }, [markProgrammaticScroll])

  useEffect(() => {
    const sub = Keyboard.addListener("keyboardDidShow", () => {
      scrollToBottomIfFollowing(true)
    })
    return () => sub.remove()
  }, [scrollToBottomIfFollowing])

  useEffect(() => {
    return () => {
      if (pendingScrollRef.current) clearTimeout(pendingScrollRef.current)
      if (loadOlderWebDebounceRef.current) clearTimeout(loadOlderWebDebounceRef.current)
      if (contextUsageTimerRef.current) clearTimeout(contextUsageTimerRef.current)
    }
  }, [])

  /**
   * Web only: any user-initiated scroll input immediately disengages follow,
   * independent of distance from the bottom. Without this, the onScroll-only
   * heuristic requires the user to scroll up >100px between streaming chunks
   * to escape auto-scroll, which feels like fighting the chat. Wheel, touch,
   * and keyboard navigation all count as intent to leave the bottom.
   */
  useEffect(() => {
    if (Platform.OS !== "web") return
    const node: any =
      (scrollViewRef.current as any)?.getScrollableNode?.() ??
      (scrollViewRef.current as any)
    if (!node || typeof node.addEventListener !== "function") return

    const disengage = () => {
      isUserAtBottomRef.current = false
      setIsFollowing(false)
    }

    const onWheel = (e: WheelEvent) => {
      if (e.deltaY < 0) disengage()
    }
    const onTouchStart = () => {
      disengage()
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (
        e.key === "ArrowUp" ||
        e.key === "PageUp" ||
        e.key === "Home"
      ) {
        disengage()
      }
    }

    node.addEventListener("wheel", onWheel, { passive: true })
    node.addEventListener("touchstart", onTouchStart, { passive: true })
    node.addEventListener("keydown", onKeyDown)
    return () => {
      node.removeEventListener("wheel", onWheel)
      node.removeEventListener("touchstart", onTouchStart)
      node.removeEventListener("keydown", onKeyDown)
    }
  }, [])

  // Chat session state — each ChatPanel instance receives a stable chatSessionId
  const currentSessionId = chatSessionId ?? null
  const [isInitialLoadComplete, setIsInitialLoadComplete] = useState(false)
  const prevSessionIdRef = useRef<string | null>(currentSessionId)
  const [internalSelectedModel, setInternalSelectedModel] = useState<string>(DEFAULT_MODEL_FREE)
  const isModelControlled = controlledSelectedModel !== undefined

  useEffect(() => {
    if (isModelControlled) return
    loadModelPreference(projectId).then((stored) => {
      if (stored) {
        setInternalSelectedModel(stored)
      } else if (hasAdvancedModelAccess) {
        setInternalSelectedModel(DEFAULT_MODEL_PRO)
      }
    })
  }, [hasAdvancedModelAccess, isModelControlled, projectId])

  const selectedModel = isModelControlled ? controlledSelectedModel : internalSelectedModel

  const handleModelChange = useCallback((modelId: string) => {
    if (controlledOnModelChange) {
      controlledOnModelChange(modelId)
    } else {
      setInternalSelectedModel(modelId)
      saveModelPreference(modelId, projectId)
    }
  }, [controlledOnModelChange, projectId])

  const [interactionMode, setInteractionMode] = useState<InteractionMode>(
    () => initialInteractionMode ?? "agent"
  )

  useEffect(() => {
    if (initialInteractionMode) {
      setInteractionMode(initialInteractionMode)
      void saveInteractionModePreference(initialInteractionMode)
      return
    }
    void loadInteractionModePreference().then((stored) => {
      if (stored) {
        setInteractionMode(stored)
      }
    })
  }, [initialInteractionMode])

  // Mirror interactionMode in a ref so callbacks (sendMessageInternal, queue
  // processor) always observe the latest value even when fired in the same
  // tick as a mode change (e.g. plan confirm → switch to agent → send).
  const interactionModeRef = useRef<InteractionMode>(interactionMode)
  useEffect(() => {
    interactionModeRef.current = interactionMode
  }, [interactionMode])

  const handleInteractionModeChange = useCallback((mode: InteractionMode) => {
    interactionModeRef.current = mode
    setInteractionMode(mode)
    void saveInteractionModePreference(mode)
  }, [])

  // Dual Plan preference — singleton-backed hook so the chat input, Plans
  // panel header, and user settings page all stay in sync. Persistent
  // per-device; the toggle stays sticky across sessions. Default is ON.
  const [dualPlan, setDualPlanAsync] = useDualPlan()
  const dualPlanRef = useRef<boolean>(dualPlan)
  useEffect(() => {
    dualPlanRef.current = dualPlan
  }, [dualPlan])
  const handleDualPlanChange = useCallback(
    (next: boolean) => {
      dualPlanRef.current = next
      void setDualPlanAsync(next)
    },
    [setDualPlanAsync]
  )

  const [restoreDraftRequest, setRestoreDraftRequest] = useState<RestoreDraftRequest | null>(null)

  // Bridge for EZ Mode overlay (voice + text translator). The overlay
  // calls `send` / `setMode` to drive this panel, and subscribes to the
  // typed lifecycle event stream (turn-start / tool-activity / turn-end)
  // emitted below. We capture the emitters in refs so hooks declared
  // before the registrar runs can reach the latest implementations
  // without a closure dance.
  const emitTurnStartRef = useRef<(() => void) | null>(null)
  const emitToolActivityRef = useRef<((args: {
    toolName: string
    phase: 'start' | 'end'
    label: string
    ok?: boolean
  }) => void) | null>(null)
  const emitTurnEndRef = useRef<((text: string) => void) | null>(null)
  const setSubagentCardsRef = useRef<((cards: ToolCallData[]) => void) | null>(null)
  const lastEmittedMessageIdRef = useRef<string | null>(null)
  /**
   * Per-tool-invocation state cache so the messages-watch effect only
   * emits `tool-activity` events when a part transitions to a new phase.
   * Keyed by a stable `${messageId}:${toolCallId||index}` string.
   */
  const toolActivityStateRef = useRef<Map<string, 'start' | 'end'>>(new Map())

  const [confirmedPlan, setConfirmedPlan] = useState<PlanData | null>(null)
  const confirmedPlanRef = useRef<PlanData | null>(null)
  const [pendingPlan, setPendingPlan] = useState<PlanData | null>(null)
  const pendingPlanRef = useRef<PlanData | null>(null)

  const planStream = usePlanStreamSafe()

  // Per-panel TodoWrite store. Each open chat tab gets its own
  // instance so descendants (AssistantContent, TodoWidget) read
  // and write isolated state — see todo-state-store.ts. Stable
  // for the panel's lifetime; the clear() below is a defensive
  // reset for the rare case where a panel switches sessions.
  const todoStateStore = useMemo(() => createTodoStateStore(), [])

  useEffect(() => {
    pendingPlanRef.current = null
    setPendingPlan(null)
    setConfirmedPlan(null)
    confirmedPlanRef.current = null
    todoStateStore.clear()
  }, [currentSessionId, todoStateStore])

  // Load session metadata from API if not already cached. Gated on
  // `isActive` so the N-1 hidden sibling ChatPanels mounted for every
  // restored chat tab don't each fire their own request on mount. Uses
  // `loadById` (not `loadAll({ id })`) so the response doesn't
  // destructively wipe sibling sessions out of the shared MST collection.
  useEffect(() => {
    if (!isActive || !chatSessionId) return
    if (studioChat.chatSessionCollection.get(chatSessionId)) return
    studioChat.chatSessionCollection
      .loadById(chatSessionId)
      .catch((err: any) => console.warn("[ChatPanel] Failed to load session:", err))
  }, [isActive, chatSessionId, studioChat])

  const currentSession = currentSessionId
    ? studioChat.chatSessionCollection.get(currentSessionId)
    : null

  // Per-session MST collection: isolated from sibling ChatPanels. Reads never
  // flip to 0 because another session's `loadPage` clobbered the singleton.
  const sessionMessages = useChatMessageCollectionForSession(currentSessionId)

  // Loading state for Effect 1. Kept as *both* a ref (for synchronous reads
  // elsewhere) AND state (so changes to it can retrigger Effect 1 via deps,
  // which is what unsticks the "skip: already loading" wedge when a prior
  // fetch was stalled behind a streaming SSE request).
  const [isLoadingMessages, setIsLoadingMessages] = useState(false)
  const isLoadingMessagesRef = useRef(false)
  // Monotonic counter bumped on every Effect 1 run. The async .then() /
  // .finally() callbacks compare their captured generation against the
  // current value to detect a session switch (or any other re-run) that
  // happened mid-load and skip writing to stale state. This is what stops
  // the post-loadPage `resumeStream()` probe from attaching to the wrong
  // chat session if the user tab-switches while the history fetch is in
  // flight.
  const loadGenerationRef = useRef(0)
  // Per-session timestamp of the last successful (or attempted) refetch.
  // Used to skip redundant fetches on rapid Effect 1 re-runs — otherwise the
  // promote-ref-to-state change would drive an infinite refetch loop.
  const cacheRefreshedAtRef = useRef<Map<string, number>>(new Map())
  // Tracks previous streaming state so the post-stream revalidate effect only
  // fires on the true→false transition (not every idle render).
  const wasStreamingRef = useRef(false)
  const cachedMessagesRef = useRef<any[] | null>(null)
  const hasInjectedInitialMessageRef = useRef(false)
  const isSendingMessageRef = useRef(false)
  const lastUserInputRef = useRef<{ content: string; files?: FileAttachment[] } | null>(null)
  const lastNonEmptyMessagesRef = useRef<UIMessage[]>([])

  // Reset stale state synchronously when the session changes so we never
  // render one frame of the previous session's messages before showing
  // the loading indicator for the new session.
  //
  // Hydrate from the module-level `sessionMessageCache` if we've seen this
  // session before — this is what makes re-visits render instantly instead
  // of briefly showing a loader while the stale-while-revalidate fetch runs.
  if (prevSessionIdRef.current !== currentSessionId) {
    const cachedForSession =
      currentSessionId ? sessionMessageCache.get(currentSessionId) ?? null : null
    prevSessionIdRef.current = currentSessionId
    cachedMessagesRef.current = cachedForSession
    lastNonEmptyMessagesRef.current = cachedForSession ?? []
    isLoadingMessagesRef.current = false
    // State-mirror reset is deferred to an effect (can't call setState in
    // render); Effect 1 reads the ref for its in-flight dedup so behaviour
    // is correct immediately regardless.
    // No session → complete. With session → only "complete" if we have a
    // cache hit; otherwise Effect 1 will flip it true after first fetch.
    setIsInitialLoadComplete(
      !currentSessionId || (cachedForSession != null && cachedForSession.length > 0),
    )
  }

  const [messageQueue, setMessageQueue] = useState<QueuedMessage[]>(() =>
    currentSessionId ? sessionQueueCache.get(currentSessionId) ?? [] : []
  )
  const isProcessingQueueRef = useRef(false)

  const sessionContextUsage = (currentSession as any)?.contextUsageTokens
  const sessionContextWindow = (currentSession as any)?.contextWindowTokens
  useEffect(() => {
    if (sessionContextUsage > 0 && sessionContextWindow > 0) {
      setContextUsage({ inputTokens: sessionContextUsage, contextWindowTokens: sessionContextWindow })
    }
  }, [sessionContextUsage, sessionContextWindow])

  // Subagent progress tracking
  const [activeSubagents, setActiveSubagents] = useState<Map<string, SubagentProgress>>(new Map())
  const [recentTools, setRecentTools] = useState<RecentToolCall[]>([])
  const MAX_RECENT_TOOLS = 8
  const [accumulatedSubagentTools, setAccumulatedSubagentTools] = useState<ToolCallData[]>([])
  const processedProgressEventsRef = useRef<Set<string>>(new Set())

  // Durable-turn lifecycle tracking. The runtime emits `data-turn-start`
  // exactly once per turn, periodic `data-turn-seq` heartbeats, and
  // `data-turn-complete` exactly once at clean termination. The fetch-level
  // auto-resume wrapper handles transparent reconnects on premature EOF;
  // these refs let the UI react to the higher-level lifecycle (e.g. show a
  // "stalled" indicator if we ever exhaust the resume budget).
  const currentTurnIdRef = useRef<string | null>(null)
  const turnCompletedRef = useRef<boolean>(false)
  const turnLastSeqRef = useRef<number>(0)

  const [toolErrorBanner, setToolErrorBanner] = useState<{ toolkitName: string; error: string; isAuthError?: boolean } | null>(null)
  const [reconnecting, setReconnecting] = useState(false)
  const [contextUsage, setContextUsage] = useState<{ inputTokens: number; contextWindowTokens: number } | null>(null)
  const contextUsageThrottleRef = useRef<{ inputTokens: number; contextWindowTokens: number } | null>(null)
  const contextUsageTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (!toolErrorBanner) return
    if (toolErrorBanner.isAuthError) return
    const timer = setTimeout(() => setToolErrorBanner(null), 10000)
    return () => clearTimeout(timer)
  }, [toolErrorBanner])



  // Stall watchdog liveness timestamp. Declared up here (before
  // `useChat`/`useChatTransportConfig`) so the auto-resuming fetch
  // wrapper's `onChunk` callback and the `useChat({ onData })` callback
  // can both bump it. See the watchdog effect further down for how it's
  // consumed (`isChatStalled`) and the `chat-stall-watchdog.ts` history
  // comment for the underlying production incident.
  const lastChatProgressAtRef = useRef<number>(Date.now())
  const bumpChatProgress = useCallback(() => {
    lastChatProgressAtRef.current = Date.now()
  }, [])

  // Flipped synchronously in `handleStop` so `onFinish` (which fires after
  // `stop()` finalises the in-flight assistant message) can distinguish a
  // user-initiated abort from a real "agent returned nothing" condition.
  // Without this we raise a scary "context corruption" banner every time
  // the user taps Stop before the model produced any text or tool calls.
  const userInitiatedStopRef = useRef(false)

  // Workspace-scoped chat routes to `/api/workspaces/:workspaceId/chat`
  // instead of the per-project endpoint. Only set when this panel is
  // operating in workspace scope and we actually have a workspace id.
  const chatWorkspaceId =
    chatScope === "workspace" && workspaceId ? workspaceId : undefined

  const transportConfig = useChatTransportConfig({
    apiBaseUrl: API_URL!,
    projectId,
    workspaceId: chatWorkspaceId,
    localAgentUrl,
    credentials: Platform.OS === 'web' ? 'include' : 'omit',
    headers: nativeHeaders,
    fetch: expoFetch,
    chatSessionId: currentSessionId,
    // Any byte off the wire — including the API's `: proxy-keep-alive`
    // SSE comments and the runtime's first `data-turn-start` frame —
    // resets the stall watchdog. Without this, the watchdog only sees
    // AI-SDK status flips and `messages` updates, which can lag the
    // POST by tens of seconds on a cold turn (system-prompt build +
    // Anthropic TTFB).
    onChunk: bumpChatProgress,
  })
  const chatTransport = useMemo(
    () => (transportConfig ? new DefaultChatTransport(transportConfig) : undefined),
    [transportConfig]
  )

  // AI SDK useChat hook.
  //
  // `resume` is intentionally `false`: we do NOT want the AI SDK firing
  // `resumeStream()` automatically on every mount keyed off
  // `isInitialLoadComplete`. That used to race the /chat-messages history
  // loader (two writers to `messages`) and produced the "I see the same
  // message twice" bug, plus the orphan
  // `[AgentChat] Stream reconnect ... snapshot=none` server log spam on
  // every refresh of an already-completed chat.
  //
  // Instead, after the history fetch completes (Effect 1's `.then()`) we
  // probe the runtime's read-only `/turn` snapshot and ONLY call
  // `resumeStream()` when there is genuinely a live, in-progress turn to
  // attach to. See `probe-turn-status.ts` for the gate.
  const {
    messages,
    sendMessage,
    addToolOutput,
    status,
    error,
    setMessages,
    stop,
    resumeStream,
  } = useChat({
    transport: chatTransport,
    id: currentSessionId || undefined,
    resume: false,
    experimental_throttle: 120,
    onError: (err) => {
      console.error("[ChatPanel] Stream error:", err)

      setMessages((prev) =>
        prev.map((msg) => {
          if (msg.role !== "assistant" || !msg.parts) return msg
          const hasStuckTool = msg.parts.some(
            (p: any) =>
              (p.type === "tool-invocation" || p.type === "dynamic-tool") &&
              (p.state === "partial-call" ||
                p.state === "call" ||
                p.state === "input-streaming" ||
                p.state === "input-available")
          )
          if (!hasStuckTool) return msg
          return {
            ...msg,
            parts: msg.parts.map((p: any) => {
              if (
                (p.type === "tool-invocation" || p.type === "dynamic-tool") &&
                (p.state === "partial-call" ||
                  p.state === "call" ||
                  p.state === "input-streaming" ||
                  p.state === "input-available")
              ) {
                return { ...p, state: "error", output: { error: "Interrupted" } }
              }
              return p
            }),
          }
        })
      )
    },
    onData: async (dataPart) => {
      // Any `data-*` frame (including `data-turn-start`, `data-turn-seq`,
      // and `data-usage`) is wire-level forward progress. The AI SDK
      // doesn't flip `status` → `'streaming'` on these — only on the
      // first `text-delta` — so without this bump the watchdog can
      // still trip on a long pre-Anthropic warm-up even after we see
      // bytes. Cheap, safe, and orthogonal to message rendering.
      bumpChatProgress()

      // Handle virtual tool events
      if (dataPart.type === "data-virtual-tool") {
        const event = (dataPart as any).data as VirtualToolEvent
        console.log("[ChatPanel:VirtualTool] Received virtual tool event:", event)

        if (event.toolName === "navigate_to_phase") {
          const targetPhase = event.args?.phase as string
          if (targetPhase && onNavigateToPhase) {
            console.log("[ChatPanel:VirtualTool] Navigating to phase:", targetPhase)
            onNavigateToPhase(targetPhase)
          }
        } else if (event.toolName === "open_panel") {
          const panelId = (event.args?.panelId as string) || `panel-${event.toolUseId}`
          const panelType =
            (event.args?.type as "code" | "schema" | "preview" | "docs") || "preview"
          const panelTitle = (event.args?.title as string) || "Panel"
          const panelContent = event.args?.content as React.ReactNode

          if (onOpenPanel) {
            console.log("[ChatPanel:VirtualTool] Opening panel:", panelId, panelType, panelTitle)
            onOpenPanel({
              id: panelId,
              type: panelType,
              title: panelTitle,
              content: panelContent,
            })
          }
        } else if (event.toolName === "show_schema") {
          const schemaName = event.args?.schemaName as string
          const defaultTab = (event.args?.defaultTab as string) || "schema"

          if (!schemaName) {
            console.warn("[ChatPanel:VirtualTool] show_schema called without schemaName")
            return
          }

          console.log("[ChatPanel:VirtualTool] Showing schema:", schemaName, "defaultTab:", defaultTab)

          try {
            if (featureId && platformFeatures?.featureSessionCollection) {
              await platformFeatures.featureSessionCollection.updateOne(featureId, {
                schemaName: schemaName,
              })
            }

            if (componentBuilder?.compositionCollection) {
              const workspaceComposition =
                componentBuilder.compositionCollection.findByName?.("workspace")
              if (workspaceComposition) {
                const currentSlotContent = workspaceComposition.slotContent || []
                const hasDesignSection = currentSlotContent.some?.(
                  (slot: any) =>
                    slot.component === "comp-design-container" ||
                    slot.sectionRef === "DesignContainerSection"
                )

                if (!hasDesignSection) {
                  const newSlotContent = [
                    {
                      slot: "main",
                      component: "comp-design-container",
                      config: { defaultTab, expandGraph: true },
                    },
                  ]
                  await componentBuilder.compositionCollection.updateOne(
                    workspaceComposition.id,
                    { slotContent: newSlotContent }
                  )
                } else {
                  const updatedSlotContent = currentSlotContent.map?.((slot: any) => {
                    if (
                      slot.component === "comp-design-container" ||
                      slot.sectionRef === "DesignContainerSection"
                    ) {
                      return { ...slot, config: { ...slot.config, defaultTab } }
                    }
                    return slot
                  })
                  await componentBuilder.compositionCollection.updateOne(
                    workspaceComposition.id,
                    { slotContent: updatedSlotContent }
                  )
                }
              } else {
                const newSlotContent = [
                  {
                    slot: "main",
                    component: "comp-design-container",
                    config: { defaultTab, expandGraph: true },
                  },
                ]
                const newComposition = {
                  id: `composition-workspace-${Date.now()}`,
                  name: "workspace",
                  layout: "layout-workspace-flexible",
                  slotContent: newSlotContent,
                  dataContext: { context: "workspace" },
                  providerWrapper: "WorkspaceProvider",
                }
                await componentBuilder.compositionCollection.insertOne(newComposition)
              }
            }
          } catch (err) {
            console.error("[ChatPanel:VirtualTool] Error handling show_schema:", err)
          }
        } else if (event.toolName === "set_workspace") {
          console.log("[ChatPanel:VirtualTool] Setting workspace state:", event.args)

          const args = event.args as {
            layout?: string
            panels?: Array<{
              slot: string
              section: string
              config?: Record<string, unknown>
            }>
          }

          try {
            for (const panel of args.panels ?? []) {
              if (panel.config?.schemaName && featureId) {
                await platformFeatures?.featureSessionCollection?.updateOne(featureId, {
                  schemaName: panel.config.schemaName as string,
                })
              }
            }

            const slotContent = (args.panels ?? []).map((panel) => ({
              slot: panel.slot,
              section: panel.section,
              config: panel.config ?? {},
            }))

            if (componentBuilder?.compositionCollection) {
              const workspaceComposition =
                componentBuilder.compositionCollection.findByName?.("workspace")
              if (workspaceComposition) {
                const updates: Record<string, unknown> = { slotContent }
                if (args.layout && LAYOUT_TO_TEMPLATE[args.layout]) {
                  updates.layout = LAYOUT_TO_TEMPLATE[args.layout]
                }
                await componentBuilder.compositionCollection.updateOne(
                  workspaceComposition.id,
                  updates
                )
              } else {
                const layoutTemplate =
                  args.layout && LAYOUT_TO_TEMPLATE[args.layout]
                    ? LAYOUT_TO_TEMPLATE[args.layout]
                    : "layout-workspace-flexible"
                const newComposition = {
                  id: `composition-workspace-${Date.now()}`,
                  name: "workspace",
                  layout: layoutTemplate,
                  slotContent,
                  dataContext: { context: "workspace" },
                  providerWrapper: "WorkspaceProvider",
                }
                await componentBuilder.compositionCollection.insertOne(newComposition)
              }
            }
          } catch (err) {
            console.error("[ChatPanel:VirtualTool] Error handling set_workspace:", err)
          }
        } else if (event.toolName === "execute") {
          console.log("[ChatPanel:VirtualTool] Executing operations:", event.args)

          const args = event.args as {
            operations?: Array<{
              domain: string
              action: "create" | "update" | "delete" | "load"
              model: string
              id?: string
              data?: Record<string, unknown>
            }>
          }

          const domains: Record<string, any> = {
            "component-builder": componentBuilder,
            "studio-chat": studioChat,
            "platform-features": platformFeatures,
          }

          for (const op of args.operations ?? []) {
            try {
              const store = domains[op.domain]
              if (!store) {
                console.warn(`[ChatPanel:VirtualTool] Unknown domain: ${op.domain}`)
                continue
              }

              const collectionName = `${op.model.charAt(0).toLowerCase()}${op.model.slice(1)}Collection`
              const collection = store[collectionName]
              if (!collection) {
                console.warn(`[ChatPanel:VirtualTool] Unknown collection: ${collectionName}`)
                continue
              }

              switch (op.action) {
                case "create":
                  await collection.insertOne(op.data)
                  break
                case "update":
                  if (op.id) {
                    await collection.updateOne(op.id, op.data)
                  }
                  break
                case "delete":
                  if (op.id) {
                    await collection.deleteOne(op.id)
                  }
                  break
                case "load":
                  if (collection.query) {
                    await collection.query().toArray()
                  }
                  break
              }
            } catch (err) {
              console.error(
                `[ChatPanel:VirtualTool] Error executing ${op.action} on ${op.domain}.${op.model}:`,
                err
              )
            }
          }
        } else {
          console.warn("[ChatPanel:VirtualTool] Unknown virtual tool:", event.toolName)
        }
      }

      // Handle subagent progress events
      if (dataPart.type === "data-progress") {
        const event = (dataPart as any).data as SubagentProgressEvent

        const eventId =
          event.type === "tool-complete"
            ? `tool:${event.toolUseId}`
            : `${event.type}:${event.agentId}`

        if (processedProgressEventsRef.current.has(eventId)) {
          return
        }
        processedProgressEventsRef.current.add(eventId)

        if (event.type === "subagent-start") {
          setActiveSubagents((prev) => {
            const next = new Map(prev)
            next.set(event.agentId, {
              agentId: event.agentId,
              agentType: event.agentType,
              startTime: event.timestamp,
              status: "running",
              toolCount: 0,
            })
            return next
          })
        } else if (event.type === "subagent-stop") {
          setActiveSubagents((prev) => {
            const next = new Map(prev)
            const existing = next.get(event.agentId)
            if (existing) {
              next.set(event.agentId, { ...existing, status: "completed" })
            }
            return next
          })
        } else if (event.type === "tool-complete") {
          setRecentTools((prev) => {
            const newTool: RecentToolCall = {
              id: event.toolUseId,
              toolName: event.toolName,
              timestamp: event.timestamp,
            }
            return [newTool, ...prev].slice(0, MAX_RECENT_TOOLS)
          })
          setAccumulatedSubagentTools((prev) => [
            ...prev,
            {
              id: event.toolUseId,
              toolName: event.toolName,
              category: getToolCategoryFromTools(event.toolName),
              state: "success" as const,
              timestamp: event.timestamp,
            },
          ])
          setActiveSubagents((prev) => {
            const next = new Map(prev)
            for (const [id, subagent] of next) {
              if (subagent.status === "running") {
                next.set(id, { ...subagent, toolCount: subagent.toolCount + 1 })
              }
            }
            return next
          })
        }
      }

      // Durable-turn lifecycle markers (emitted by agent-runtime). The
      // fetch wrapper already auto-resumes on premature EOF; we just track
      // the latest state here so the UI/idle-watchdog know whether the
      // stream completed cleanly.
      if (dataPart.type === "data-turn-start") {
        const d = (dataPart as any).data ?? {}
        if (d.turnId && d.turnId !== currentTurnIdRef.current) {
          currentTurnIdRef.current = d.turnId
          turnCompletedRef.current = false
          turnLastSeqRef.current = 0
        }
      }
      if (dataPart.type === "data-turn-seq") {
        const seq = (dataPart as any).data?.seq
        if (typeof seq === "number" && seq > turnLastSeqRef.current) {
          turnLastSeqRef.current = seq
        }
      }
      if (dataPart.type === "data-turn-complete") {
        turnCompletedRef.current = true
        const d = (dataPart as any).data ?? {}
        if (typeof d.lastSeq === "number" && d.lastSeq > turnLastSeqRef.current) {
          turnLastSeqRef.current = d.lastSeq
        }
        if (d.status && d.status !== "completed") {
          console.warn(
            "[ChatPanel] turn ended with non-completed status:",
            d.status,
            d.error,
          )
        }
      }

      // Team coordination events
      if (dataPart.type === "data-team-snapshot") {
        const d = (dataPart as any).data
        if (d) teamStore.hydrate(d)
      }
      if (dataPart.type === "data-team-created") {
        const { teamId, name, description, leaderId } = (dataPart as any).data ?? {}
        if (teamId) teamStore.initTeam(teamId, name, description, leaderId)
      }
      if (dataPart.type === "data-team-deleted") {
        const { teamId } = (dataPart as any).data ?? {}
        if (teamId) teamStore.deleteTeam(teamId)
      }
      if (dataPart.type === "data-team-activity") {
        const { event, agentId: aid, teamId: tid, reason } = (dataPart as any).data ?? {}
        if (event === "idle") teamStore.updateMemberStatus(aid, tid, "idle")
        else if (event === "wake") teamStore.updateMemberStatus(aid, tid, "active")
        else if (event === "shutdown") teamStore.updateMemberStatus(aid, tid, "shutdown")
        else if (event === "member-joined") {
          const { name: mName, color } = (dataPart as any).data ?? {}
          teamStore.upsertMember(tid, { agentId: aid, teamId: tid, name: mName, color, status: "active", joinedAt: Date.now() })
        }
      }
      if (dataPart.type === "data-team-task") {
        const { teamId: tid, task } = (dataPart as any).data ?? {}
        if (tid && task) teamStore.upsertTask(tid, task)
      }
      if (dataPart.type === "data-team-message") {
        const d = (dataPart as any).data
        if (d?.teamId) {
          teamStore.addMessage(d.teamId, {
            from: d.from,
            to: d.to,
            messageType: d.messageType,
            message: d.message,
            summary: d.summary,
            timestamp: Date.now(),
          })
        }
      }
      if (dataPart.type === "data-teammate-text") {
        const { agentId: aid, teamId: tid, phase, textId, delta } = (dataPart as any).data ?? {}
        if (phase === "start") {
          teamStore.appendMemberStreamPart(aid, tid, { type: "text", text: "", id: textId })
        } else if (phase === "delta" && delta) {
          teamStore.updateMemberStreamPart(aid, tid, textId, (p) =>
            p.type === "text" ? { ...p, text: p.text + delta } : p,
          )
        } else if (phase === "reasoning-start") {
          teamStore.appendMemberStreamPart(aid, tid, { type: "reasoning", text: "", isStreaming: true, id: textId })
        } else if (phase === "reasoning-delta" && delta) {
          teamStore.updateMemberStreamPart(aid, tid, textId, (p) =>
            p.type === "reasoning" ? { ...p, text: p.text + delta } : p,
          )
        } else if (phase === "reasoning-end") {
          teamStore.updateMemberStreamPart(aid, tid, textId, (p) =>
            p.type === "reasoning" ? { ...p, isStreaming: false } : p,
          )
        }
      }
      if (dataPart.type === "data-teammate-tool") {
        const { agentId: aid, teamId: tid, toolCallId, toolName, phase, args, result, isError } = (dataPart as any).data ?? {}
        if (phase === "start") {
          teamStore.appendMemberStreamPart(aid, tid, {
            type: "tool",
            id: toolCallId,
            tool: { id: toolCallId, toolName, args, state: "streaming" as any, category: "other" as any, timestamp: Date.now() },
          })
        } else if (phase === "output") {
          teamStore.updateMemberStreamPart(aid, tid, toolCallId, (p) =>
            p.type === "tool"
              ? { ...p, tool: { ...p.tool, state: isError ? "error" : "success", result } }
              : p,
          )
        }
      }
      if (dataPart.type === "data-agent-types") {
        const { types } = (dataPart as any).data ?? {}
        if (types) teamStore.setAgentTypes(types)
      }

      if (dataPart.type === "data-tool-error" && !toolErrorBanner) {
        const { toolkitName, error: errText, isAuthError: authErr } = (dataPart as any).data ?? {}
        setToolErrorBanner({
          toolkitName: toolkitName || "Integration",
          error: typeof errText === "string" ? errText : JSON.stringify(errText ?? ""),
          isAuthError: !!authErr,
        })
      }

      if ((dataPart as any).type === "data-plan") {
        const planData = (dataPart as any).data
        if (planData) {
          // A fresh plan event always discards any stale summary belonging
          // to a previous plan; the runtime will re-emit
          // data-plan-summary-* if Dual Plan is enabled for this turn.
          planStream?.resetSummary()
          const normalizedPlan = normalizePlanData(planData)
          pendingPlanRef.current = normalizedPlan
          setPendingPlan(normalizedPlan)
          planStream?.setStreamingPlan(normalizedPlan)
          if (normalizedPlan.filepath) {
            planStream?.setStreamingPlanFilepath(normalizedPlan.filepath)
          }
          planStream?.notifyPlanCreated()
        }
      }

      if ((dataPart as any).type === "data-plan-update") {
        const planData = (dataPart as any).data
        if (planData) {
          const previousPlan = pendingPlanRef.current
          const normalizedPlan = normalizePlanData({
            name: planData.name ?? previousPlan?.name ?? "Plan",
            overview: planData.overview ?? previousPlan?.overview ?? "",
            plan: planData.plan ?? previousPlan?.plan ?? "",
            todos: planData.todos ?? previousPlan?.todos ?? [],
            filepath: planData.filepath ?? previousPlan?.filepath,
            toolCallId: planData.toolCallId ?? previousPlan?.toolCallId,
            summary: previousPlan?.summary,
            summaryStatus: previousPlan?.summaryStatus,
          })
          pendingPlanRef.current = normalizedPlan
          setPendingPlan(normalizedPlan)
          planStream?.setStreamingPlan(normalizedPlan)
          if (normalizedPlan.filepath) {
            planStream?.setStreamingPlanFilepath(normalizedPlan.filepath)
          }
        }
        planStream?.notifyPlanCreated()
      }

      // Dual Plan: stakeholder summary lifecycle. The runtime emits these
      // three events asynchronously after create_plan / update_plan so
      // the UI can show a "Summary" tab spinner immediately and then swap in
      // the summary markdown when it's ready.
      if ((dataPart as any).type === "data-plan-summary-start") {
        planStream?.setSummaryStatus("pending")
        planStream?.setStreamingSummary(null)
        planStream?.setSummaryError(null)
        const previousPlan = pendingPlanRef.current
        if (previousPlan) {
          const next = normalizePlanData({
            ...previousPlan,
            summary: undefined,
            summaryStatus: "pending",
          })
          pendingPlanRef.current = next
          setPendingPlan(next)
          planStream?.setStreamingPlan(next)
        }
      }

      if ((dataPart as any).type === "data-plan-summary") {
        const data = (dataPart as any).data
        const summary = typeof data?.summary === "string" ? data.summary : null
        if (summary) {
          planStream?.setSummaryStatus("ready")
          planStream?.setStreamingSummary(summary)
          planStream?.setSummaryError(null)
          const previousPlan = pendingPlanRef.current
          if (previousPlan) {
            const next = normalizePlanData({
              ...previousPlan,
              summary,
              summaryStatus: "ready",
            })
            pendingPlanRef.current = next
            setPendingPlan(next)
            planStream?.setStreamingPlan(next)
          }
          planStream?.notifyPlanCreated()
        }
      }

      if ((dataPart as any).type === "data-plan-summary-error") {
        const data = (dataPart as any).data
        const message =
          typeof data?.message === "string" && data.message
            ? data.message
            : "Failed to generate summary"
        planStream?.setSummaryStatus("error")
        planStream?.setSummaryError(message)
        const previousPlan = pendingPlanRef.current
        if (previousPlan) {
          const next = normalizePlanData({
            ...previousPlan,
            summaryStatus: "error",
          })
          pendingPlanRef.current = next
          setPendingPlan(next)
          planStream?.setStreamingPlan(next)
        }
      }

      // Handle permission approval requests from the agent runtime
      if ((dataPart as any).type === "data-permission-request") {
        const req = (dataPart as any).data
        if (req) {
          setPendingPermissionRequest({
            id: req.id,
            toolName: req.toolName,
            category: req.category,
            params: req.params ?? {},
            reason: req.reason ?? '',
            timeout: req.timeout ?? 60,
          })
        }
      }

      if ((dataPart as any).type === "data-context-usage") {
        const ctx = (dataPart as any).data
        if (ctx?.inputTokens && ctx?.contextWindowTokens) {
          contextUsageThrottleRef.current = {
            inputTokens: ctx.inputTokens,
            contextWindowTokens: ctx.contextWindowTokens,
          }
          if (!contextUsageTimerRef.current) {
            contextUsageTimerRef.current = setTimeout(() => {
              contextUsageTimerRef.current = null
              if (contextUsageThrottleRef.current) {
                setContextUsage(contextUsageThrottleRef.current)
              }
            }, 500)
          }
        }
      }

      if ((dataPart as any).type === "data-usage") {
        const usage = (dataPart as any).data
        const ctxTokens = usage?.estimatedContextTokens || usage?.inputTokens
        const ctxWindow = usage?.contextWindowTokens
        if (ctxTokens && ctxWindow) {
          setContextUsage({ inputTokens: ctxTokens, contextWindowTokens: ctxWindow })
          if (currentSessionId) {
            studioChat.chatSessionCollection
              .update(currentSessionId, {
                contextUsageTokens: ctxTokens,
                contextWindowTokens: ctxWindow,
              } as any)
              .catch((err: any) => console.warn("[ChatPanel] Failed to persist context usage:", err))
          }
        }

      }
    },
    onFinish: async ({ message, isAbort }: { message: any; isAbort?: boolean }) => {
      const contentLength = (message as any).content?.length ?? message.parts?.length ?? 0

      // Push a `turn-end` event to the EZ Mode bridge so the translator
      // overlay (voice or text) can summarise the outcome for the user.
      // De-dupe by message id so retries / React strict-mode double-invokes
      // don't fire twice.
      const msgId = (message as any)?.id as string | undefined
      if (
        msgId &&
        msgId !== lastEmittedMessageIdRef.current &&
        emitTurnEndRef.current
      ) {
        const assistantText = (message.parts ?? [])
          .filter((p: any) => p.type === "text" && typeof p.text === "string")
          .map((p: any) => p.text)
          .join("\n")
          .trim()
        lastEmittedMessageIdRef.current = msgId
        try {
          emitTurnEndRef.current(assistantText)
        } catch (err) {
          console.warn("[ChatPanel] bridge.emitTurnEnd threw", err)
        }
      }

      const hasTextContent = message.parts?.some(
        (p: any) => p.type === "text" && p.text?.trim()
      )
      const hasToolCallsInMessage = message.parts?.some(
        (p: any) => p.type === "tool-invocation" || p.type === "tool-result"
      )
      // `isAbort` comes straight from the AI SDK (see ai/dist/index.mjs
      // `AbstractChat#makeRequest` finally block) and is set whenever the
      // active response's AbortController fires — covers user-initiated
      // Stop, the stall watchdog, panel unmount, and any future caller of
      // `stop()` without us having to instrument each path. The ref is
      // kept as a belt-and-braces fallback.
      if (isAbort || userInitiatedStopRef.current) {
        userInitiatedStopRef.current = false
        setEmptyResponseError(null)
      } else if (!hasTextContent && !hasToolCallsInMessage && contentLength === 0) {
        console.warn("[ChatPanel] Agent returned empty response — possible context corruption")
        setEmptyResponseError("The agent returned no content.")
      } else {
        setEmptyResponseError(null)
      }

      if (currentSessionId) {
        refetchUsageWallet()

        const toolCalls = extractToolCalls(message)
        if (toolCalls.length > 0) {
          const platformFeaturesCollections: string[] = []
          const componentBuilderCollections: string[] = []
          let needsSchemaRefresh = false

          for (const toolCall of toolCalls) {
            if (toolCall.state !== "output-available") {
              continue
            }

            if (requiresSchemaRefresh(toolCall)) {
              needsSchemaRefresh = true
            }

            const target = getRefreshTarget(toolCall)
            if (target) {
              if (target.schema === "component-builder") {
                componentBuilderCollections.push(...target.collections)
              } else {
                platformFeaturesCollections.push(...target.collections)
              }
            }
          }

          if (needsSchemaRefresh && onSchemaRefresh) {
            onSchemaRefresh()
          }

          if (platformFeaturesCollections.length > 0) {
            refreshCollections(
              platformFeatures,
              platformFeaturesCollections,
              "platformFeatures"
            ).catch((err) => {
              console.warn("[ChatPanel] Smart refresh (platformFeatures) failed:", err)
            })
          }
          if (componentBuilderCollections.length > 0) {
            refreshCollections(
              componentBuilder,
              componentBuilderCollections,
              "componentBuilder"
            ).catch((err) => {
              console.warn("[ChatPanel] Smart refresh (componentBuilder) failed:", err)
            })
          }

          if (onRefresh) {
            onRefresh().catch((err) => {
              console.warn("[ChatPanel] onRefresh callback failed:", err)
            })
          }

          if (onFilesChanged) {
            const modifiedPaths = getModifiedFilePaths(toolCalls)
            if (modifiedPaths.length > 0) {
              console.log("[ChatPanel] Files modified by agent:", modifiedPaths)
              filesChangedFiredRef.current = true
              onFilesChanged(modifiedPaths)
            }
          }
        }
      }

      fetchQuickActions()

      // Auto-name "Untitled" sessions after the first assistant response
      if (currentSessionId && !hasTriggeredNamingRef.current) {
        const session = studioChat.chatSessionCollection.get(currentSessionId)
        const sessionName = (session as any)?.inferredName || (session as any)?.name
        if (!sessionName || sessionName === 'Untitled') {
          const firstUserMsg = messages.find((m: any) => m.role === 'user')
          const userText = firstUserMsg?.parts
            ?.filter((p: any) => p.type === 'text')
            .map((p: any) => p.text)
            .join(' ')
            ?.trim()
          if (userText) {
            hasTriggeredNamingRef.current = true
            const http = createHttpClient()
            api
              .generateProjectName(http, userText, workspaceId)
              .then(({ name }) => {
                if (!name) return
                // Guard: the session may have been deleted (or never persisted
                // server-side) between sending the naming RPC and its
                // resolution — e.g. the user switched chat tabs and removed
                // the original session. Calling `updateChatSession` on a
                // missing id throws "Item not found" inside the MST flow,
                // which becomes an UnhandledPromiseRejection (the inner
                // Promise was previously NOT returned from the .then, so the
                // outer .catch couldn't see it). Check first AND return the
                // inner Promise so any future error path is funneled through
                // the outer .catch.
                if (!studioChat.chatSessionCollection.get(currentSessionId)) {
                  return
                }
                return actions.updateChatSession(currentSessionId, {
                  inferredName: name,
                })
              })
              .catch(() => {})
          }
        }
      }
    },
  })

  const [stoppedMessages, setStoppedMessages] = useState<UIMessage[] | null>(null)
  const messagesRef = useRef(messages)
  messagesRef.current = messages

  if (isActive && messages.length > 0) {
    cachedMessagesRef.current = messages
    if (currentSessionId) {
      // Keep the module cache in sync with the latest UI state so a subsequent
      // session switch (or panel remount) can hydrate instantly. This runs on
      // every render while streaming, which is cheap (Map.set by reference).
      sessionMessageCache.set(currentSessionId, messages)
    }
  }
  if (messages.length > 0) {
    lastNonEmptyMessagesRef.current = messages
  }

  const isStreaming = (status === "streaming" || status === "submitted") && stoppedMessages === null
  const filesChangedFiredRef = useRef(false)

  // Watch messages for tool-invocation state transitions during a live
  // turn and emit `tool-activity` events so the EZ Mode overlay can
  // (a) keep a fresh activity buffer for mid-turn summaries, and
  // (b) surface the activity in its on-screen log.
  //
  // We translate raw tool names into short, human-friendly labels rather
  // than leaking schema names — the voice agent is explicitly told never
  // to read raw tool / file identifiers, so the bridge enforces that at
  // the emission boundary.
  useEffect(() => {
    const emit = emitToolActivityRef.current
    if (!emit) return
    const stateMap = toolActivityStateRef.current

    const labelForTool = (toolName: string, args: unknown): string => {
      const safeName = (toolName || 'tool').replace(/_/g, ' ')
      // Extract any obvious file / path hint from the args, but in a
      // humanised form (strip leading slashes, trim long paths).
      let target = ''
      if (args && typeof args === 'object') {
        const a = args as Record<string, unknown>
        const candidate =
          (typeof a.path === 'string' && a.path) ||
          (typeof a.file === 'string' && a.file) ||
          (typeof a.filename === 'string' && a.filename) ||
          (typeof a.target === 'string' && a.target) ||
          (typeof a.name === 'string' && a.name) ||
          (typeof a.query === 'string' && a.query) ||
          ''
        if (candidate) {
          const basename = String(candidate).split(/[\\/]/).pop() || String(candidate)
          target = basename.length > 60 ? basename.slice(0, 60) + '…' : basename
        }
      }
      return target ? `${safeName}: ${target}` : safeName
    }

    for (const msg of messages) {
      if ((msg as any).role !== 'assistant') continue
      const parts = (msg as any).parts as any[] | undefined
      if (!Array.isArray(parts)) continue
      parts.forEach((part, idx) => {
        if (part.type !== 'tool-invocation' && part.type !== 'dynamic-tool') return
        const inv = part.type === 'tool-invocation' ? part.toolInvocation : part
        const toolName = (inv?.toolName ?? part.toolName ?? 'tool') as string
        const toolCallId = (inv?.toolCallId ?? part.toolCallId ?? `${idx}`) as string
        const rawState = (inv?.state ?? part.state ?? '') as string
        const isEnd =
          rawState === 'result' ||
          rawState === 'output-available' ||
          rawState === 'success' ||
          rawState === 'error' ||
          rawState === 'output-error'
        const isStart =
          rawState === 'partial-call' ||
          rawState === 'call' ||
          rawState === 'input-streaming' ||
          rawState === 'input-available'
        if (!isStart && !isEnd) return

        const key = `${(msg as any).id || 'nomsg'}:${toolCallId}`
        const last = stateMap.get(key)
        if (isStart && last === undefined) {
          stateMap.set(key, 'start')
          try {
            emit({
              toolName,
              phase: 'start',
              label: labelForTool(toolName, inv?.args ?? part.input ?? part.args),
            })
          } catch (err) {
            console.warn('[ChatPanel] bridge.emitToolActivity(start) threw', err)
          }
        } else if (isEnd && last !== 'end') {
          stateMap.set(key, 'end')
          const ok = rawState !== 'error' && rawState !== 'output-error'
          try {
            emit({
              toolName,
              phase: 'end',
              label: labelForTool(toolName, inv?.args ?? part.input ?? part.args),
              ok,
            })
          } catch (err) {
            console.warn('[ChatPanel] bridge.emitToolActivity(end) threw', err)
          }
        }
      })
    }
  }, [messages])

  // Publish a snapshot of the technical agent's task / agent_spawn tool
  // calls through the ChatBridge so the EZ Mode overlay can render
  // the same `<SubagentCard>` UI as the regular chat (including any
  // card-level features like the live browser preview). The bridge
  // dedupes by reference so this is cheap to call on every messages
  // update.
  useEffect(() => {
    const publish = setSubagentCardsRef.current
    if (!publish) return
    try {
      publish(extractTaskToolsFromMessages(messages))
    } catch (err) {
      console.warn('[ChatPanel] bridge.setSubagentCards threw', err)
    }
  }, [messages])

  // Abort any active stream when this panel unmounts (e.g. tab closed)
  const stopRef = useRef(stop)
  stopRef.current = stop
  useEffect(() => {
    return () => { stopRef.current() }
  }, [])

  useEffect(() => {
    if (status === 'ready' && stoppedMessages !== null) {
      setMessages(stoppedMessages)
      setStoppedMessages(null)
    }
  }, [status, stoppedMessages, setMessages])

  // Propagate messages to parent (for pendingToolInstalls, TerminalPanel, etc.)
  // but skip the flood of per-token updates during streaming. Firing this on
  // every chunk causes `setChatMessages` in the parent to re-render the entire
  // ProjectLayout subtree — which cascades into ALL open ChatPanel tabs and
  // the full TurnList/TurnGroup/AssistantContent chain per character.
  //
  // Parent consumers only care about:
  //   1. message count changes (new user/assistant turn)
  //   2. terminal tool-state transitions (streaming → result/error)
  //   3. the final state when streaming ends
  // so we propagate on those events only.
  const lastPropagatedRef = useRef<readonly UIMessage[] | null>(null)
  const lastPropagatedToolSigRef = useRef<string>("")
  const lastPropagatedIsStreamingRef = useRef<boolean>(false)
  useEffect(() => {
    if (!onMessagesChange) return
    const decision = decideMessagesPropagation({
      prev: lastPropagatedRef.current,
      next: messages,
      isStreaming,
      prevIsStreaming: lastPropagatedIsStreamingRef.current,
      prevToolSig: lastPropagatedToolSigRef.current,
    })
    lastPropagatedIsStreamingRef.current = isStreaming
    if (!decision.shouldPropagate) return
    lastPropagatedRef.current = messages
    lastPropagatedToolSigRef.current = decision.toolSig
    onMessagesChange(messages)
  }, [messages, onMessagesChange, isStreaming])

  useEffect(() => {
    onChatError?.(error ?? null)
  }, [error, onChatError])

  const [emptyResponseError, setEmptyResponseError] = useState<string | null>(null)
  const [errorBannerExpanded, setErrorBannerExpanded] = useState(false)
  const [errorDismissed, setErrorDismissed] = useState(false)
  const [tunnelReconnecting, setTunnelReconnecting] = useState(false)

  const isRemoteInstance = !!localAgentUrl
  const isTunnelError = !!(error && isRemoteInstance && isTunnelDisconnectError(error.message))
  const { clearInstance: clearActiveInstance } = useActiveInstance()

  const errorBannerText = useMemo(
    () => {
      if (isTunnelError && tunnelReconnecting) return 'Connection to desktop instance lost. Reconnecting\u2026'
      if (isTunnelError) return 'Connection to desktop instance lost. Tap Reconnect to retry.'
      return (error ? formatErrorMessage(error.message) : emptyResponseError) ?? ''
    },
    [error?.message, emptyResponseError, isTunnelError, tunnelReconnecting]
  )
  useEffect(() => {
    setErrorBannerExpanded(false)
    // A new error message after a dismissal should re-surface the banner —
    // otherwise tapping X once would permanently mute future errors.
    setErrorDismissed(false)
  }, [errorBannerText])

  useEffect(() => {
    if (!isTunnelError || !localAgentUrl) {
      setTunnelReconnecting(false)
      return
    }
    setTunnelReconnecting(true)

    let cancelled = false
    const RECONNECT_POLL_MS = 3000
    const MAX_RECONNECT_POLLS = 20

    async function pollForReconnect() {
      for (let i = 0; i < MAX_RECONNECT_POLLS && !cancelled; i++) {
        await new Promise((r) => setTimeout(r, RECONNECT_POLL_MS))
        if (cancelled) return
        try {
          const fetchFn = expoFetch ?? globalThis.fetch
          const hdrs: Record<string, string> = nativeHeaders ? nativeHeaders() : {}
          const res = await fetchFn(`${localAgentUrl}/agent/health`, {
            headers: hdrs,
            credentials: Platform.OS === 'web' ? 'include' : undefined,
            signal: AbortSignal.timeout(5000),
          } as any)
          if (res.ok) {
            if (!cancelled) {
              setTunnelReconnecting(false)
              handleRetryRef.current?.()
            }
            return
          }
        } catch {}
      }
      if (!cancelled) setTunnelReconnecting(false)
    }
    pollForReconnect()
    return () => { cancelled = true }
  }, [isTunnelError, localAgentUrl])

  const errorBannerNeedsReadMore =
    errorBannerText.split(/\n/).length > 2 || errorBannerText.length > 140

  const [pendingInitialMessage, setPendingInitialMessage] = useState<string | null>(null)
  const [optimisticUserInput, setOptimisticUserInput] = useState<OptimisticUserInput | null>(null)

  // Permission approval state (local mode security)
  const [pendingPermissionRequest, setPendingPermissionRequest] = useState<{
    id: string
    toolName: string
    category: string
    params: Record<string, any>
    reason: string
    timeout: number
  } | null>(null)

  const initialMessageRef = useRef<string | undefined>(undefined)
  if (initialMessage != null && initialMessage.trim() !== "") {
    initialMessageRef.current = initialMessage
  }

  useEffect(() => {
    if (messages.length > 0 && pendingInitialMessage !== null) {
      setPendingInitialMessage(null)
    }
  }, [messages.length, pendingInitialMessage])

  useEffect(() => {
    if (!optimisticUserInput) return
    if (optimisticUserInput.sessionId !== currentSessionId) {
      setOptimisticUserInput(null)
      return
    }
    if (hasMatchingUserMessage(messages, optimisticUserInput)) {
      setOptimisticUserInput(null)
    }
  }, [currentSessionId, messages, optimisticUserInput])

  const displayMessages = useMemo((): UIMessage[] => {
    const effectiveMessages = stoppedMessages ?? messages
    const currentOptimisticInput =
      optimisticUserInput?.sessionId === currentSessionId ? optimisticUserInput : null
    const shouldPrependOptimisticUser =
      currentOptimisticInput && !hasMatchingUserMessage(effectiveMessages, currentOptimisticInput)

    if (effectiveMessages.length > 0) {
      return shouldPrependOptimisticUser
        ? [buildOptimisticUserMessage(currentOptimisticInput), ...effectiveMessages]
        : effectiveMessages
    }

    if (isStreaming || isSendingMessageRef.current) {
      // While streaming/sending, show the last known messages (plus an optimistic
      // user bubble) so the conversation doesn't vanish during the brief gap
      // before the AI SDK populates its internal state.
      const fallback = lastNonEmptyMessagesRef.current
      const lastInput =
        currentOptimisticInput ??
        (currentSessionId && lastUserInputRef.current
          ? { sessionId: currentSessionId, ...lastUserInputRef.current }
          : null)
      const lastFallbackMsg = fallback[fallback.length - 1]
      const needsOptimisticUser =
        lastInput?.content && (!lastFallbackMsg || lastFallbackMsg.role !== "user")

      if (needsOptimisticUser) {
        return [
          ...fallback,
          buildOptimisticUserMessage(lastInput),
        ]
      }
      return fallback
    }

    const text = (pendingInitialMessage ?? initialMessage ?? initialMessageRef.current ?? "").trim()
    if (text !== "") {
      return [
        {
          id: "initial-optimistic",
          role: "user",
          parts: [{ type: "text", text }],
        } as unknown as UIMessage,
      ]
    }
    return []
  }, [currentSessionId, messages, stoppedMessages, pendingInitialMessage, initialMessage, optimisticUserInput, isStreaming])

  // Stable references for memo'd downstream components (TurnList / SubagentPanel).
  // Previously these were `Array.from(Map.values())` inline, which allocated on
  // every render and defeated React.memo on TurnList — a primary cause of the
  // 700ms tab-switch re-render cascade.
  const activeSubagentsList = useMemo(
    () => Array.from(activeSubagents.values()) as SubagentProgressType[],
    [activeSubagents],
  )
  const recentToolsList = useMemo(
    () => recentTools as RecentToolType[],
    [recentTools],
  )

  const isStreamingRef = useRef(false)
  isStreamingRef.current = isStreaming

  // Detect when the AI SDK stream ends but we never observed a
  // `data-turn-complete` marker. The fetch wrapper auto-resumes through
  // transient disconnects, so reaching this state means it gave up after
  // exhausting its retry budget — the turn may still be running on the
  // server while the UI looks "done".
  const prevIsStreamingForTurnRef = useRef(false)
  const turnStalledRef = useRef(false)
  useEffect(() => {
    const wasStreaming = prevIsStreamingForTurnRef.current
    prevIsStreamingForTurnRef.current = isStreaming
    if (isStreaming && !wasStreaming) {
      turnStalledRef.current = false
      return
    }
    if (wasStreaming && !isStreaming) {
      if (currentTurnIdRef.current && !turnCompletedRef.current) {
        console.warn(
          "[ChatPanel] stream ended without data-turn-complete (turnId=" +
            currentTurnIdRef.current +
            ", lastSeq=" +
            turnLastSeqRef.current +
            "); turn may still be running on the server",
        )
        turnStalledRef.current = true
      }
    }
  }, [isStreaming])

  const handleStop = useCallback(() => {
    userInitiatedStopRef.current = true
    // Clear any pre-existing empty-response banner immediately so that a
    // stale banner from an earlier turn dismisses the moment the user taps
    // Stop — they shouldn't have to send a new message to get rid of it.
    setEmptyResponseError(null)
    setStoppedMessages([...messagesRef.current])
    stop()

    const req = buildStopRequest({
      localAgentUrl,
      projectId,
      workspaceId: chatWorkspaceId,
      apiBaseUrl: API_URL!,
      platform: Platform.OS,
      getCookie: () => authClient.getCookie(),
      chatSessionId: currentSessionId,
    })
    if (req) {
      const fetchFn = expoFetch || fetch
      fetchFn(req.url, req.init).catch((err) => {
        console.warn("[ChatPanel] Failed to send stop signal to backend:", err)
      })
    }
  }, [stop, projectId, chatWorkspaceId, localAgentUrl, expoFetch, currentSessionId])

  // Keep the shared subagent-stop helper pointed at the current API/runtime
  // so SubagentCard (chat) and AgentEntry (agents panel) can cancel without
  // having handlers threaded through the tree.
  useEffect(() => {
    configureSubagentStop({
      localAgentUrl,
      projectId,
      apiBaseUrl: API_URL!,
      platform: Platform.OS,
      getCookie: () => authClient.getCookie(),
      fetchFn: expoFetch || undefined,
    })
    return () => { configureSubagentStop(null) }
  }, [localAgentUrl, projectId, expoFetch])

  // Idle timeout to force-complete hung streams.
  //
  // The runtime emits `data-tool-progress` heartbeats every 15s during long
  // tool executions and the API proxy injects keep-alive frames, so a true
  // idle window of 30 minutes means the runtime really has gone silent.
  // Anything shorter risks killing legitimate long Anthropic / Opus turns.
  //
  // We rely on the `messages` array reference being swapped by the AI SDK on
  // every chunk (text delta, tool input, tool output, data part). React's
  // dependency check on `messages` reruns this effect on each chunk, which
  // resets the timer below. The previous implementation also computed a
  // `JSON.stringify` hash of the entire message tree to detect changes, but
  // that hash was never read for any decision — the timer was unconditionally
  // reset on each effect run anyway. With long histories that stringify cost
  // O(history bytes × tokens) of main-thread freeze per stream chunk, which
  // is exactly the sort of cost that doesn't show up in the React Profiler.
  const idleTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const IDLE_TIMEOUT_MS = 1_800_000

  useEffect(() => {
    if (idleTimeoutRef.current) {
      clearTimeout(idleTimeoutRef.current)
      idleTimeoutRef.current = null
    }

    if (!isStreaming) return

    idleTimeoutRef.current = setTimeout(() => {
      console.warn("[ChatPanel] Stream idle timeout - forcing stop()")
      handleStop()
    }, IDLE_TIMEOUT_MS)

    return () => {
      if (idleTimeoutRef.current) {
        clearTimeout(idleTimeoutRef.current)
        idleTimeoutRef.current = null
      }
    }
  }, [isStreaming, messages, handleStop])

  // Fallback: detect file changes when streaming ends
  const prevStreamingForScanRef = useRef(false)
  useEffect(() => {
    const wasStreaming = prevStreamingForScanRef.current
    prevStreamingForScanRef.current = isStreaming

    if (wasStreaming && !isStreaming && !filesChangedFiredRef.current && onFilesChanged) {
      const latestAssistant = [...messages].reverse().find((m) => m.role === "assistant")
      if (latestAssistant) {
        const toolCalls = extractToolCalls(latestAssistant)
        const modifiedPaths = getModifiedFilePaths(toolCalls)
        if (modifiedPaths.length > 0) {
          console.log("[ChatPanel] Fallback: Files modified by agent (onFinish missed):", modifiedPaths)
          onFilesChanged(modifiedPaths)
        }
      }
    }

    if (isStreaming && !wasStreaming) {
      filesChangedFiredRef.current = false
      setToolErrorBanner(null)
    }
  }, [isStreaming, messages, onFilesChanged])

  // Process progress events from message parts
  useEffect(() => {
    const latestMessage = messages[messages.length - 1]
    if (!latestMessage || latestMessage.role !== "assistant") return

    const parts = (latestMessage as any).parts as any[] | undefined
    if (!parts) {
      return
    }

    parts.forEach((part) => {
      if (part.type === "data-progress") {
        const event = part.data as SubagentProgressEvent

        const eventId =
          event.type === "tool-complete"
            ? `tool:${event.toolUseId}`
            : `${event.type}:${event.agentId}`

        if (processedProgressEventsRef.current.has(eventId)) {
          return
        }
        processedProgressEventsRef.current.add(eventId)

        if (event.type === "subagent-start") {
          setActiveSubagents((prev) => {
            const next = new Map(prev)
            next.set(event.agentId, {
              agentId: event.agentId,
              agentType: event.agentType,
              startTime: event.timestamp,
              status: "running",
              toolCount: 0,
            })
            return next
          })
        } else if (event.type === "subagent-stop") {
          setActiveSubagents((prev) => {
            const next = new Map(prev)
            const existing = next.get(event.agentId)
            if (existing) {
              next.set(event.agentId, { ...existing, status: "completed" })
            }
            return next
          })
        } else if (event.type === "tool-complete") {
          setRecentTools((prev) => {
            const newTool: RecentToolCall = {
              id: event.toolUseId,
              toolName: event.toolName,
              timestamp: event.timestamp,
            }
            return [newTool, ...prev].slice(0, MAX_RECENT_TOOLS)
          })
          setAccumulatedSubagentTools((prev) => [
            ...prev,
            {
              id: event.toolUseId,
              toolName: event.toolName,
              category: getToolCategoryFromTools(event.toolName),
              state: "success" as const,
              timestamp: event.timestamp,
            },
          ])
          setActiveSubagents((prev) => {
            const next = new Map(prev)
            for (const [id, subagent] of next) {
              if (subagent.status === "running") {
                next.set(id, { ...subagent, toolCount: subagent.toolCount + 1 })
              }
            }
            return next
          })
        }
      }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, currentSessionId])

  // Delayed cleanup of completed subagents
  const SUBAGENT_LINGER_MS = 2500
  const scheduledCleanupRef = useRef<Set<string>>(new Set())
  const toolsCleanupScheduledRef = useRef<boolean>(false)

  useEffect(() => {
    if (!isStreaming) {
      const timeoutIds: ReturnType<typeof setTimeout>[] = []

      activeSubagents.forEach((subagent, id) => {
        if (subagent.status === "completed" && !scheduledCleanupRef.current.has(id)) {
          scheduledCleanupRef.current.add(id)
          const timeoutId = setTimeout(() => {
            scheduledCleanupRef.current.delete(id)
            setActiveSubagents((prev) => {
              const next = new Map(prev)
              next.delete(id)
              return next
            })
          }, SUBAGENT_LINGER_MS)
          timeoutIds.push(timeoutId)
        }
      })

      if (!toolsCleanupScheduledRef.current && recentTools.length > 0) {
        toolsCleanupScheduledRef.current = true
        const toolsTimeoutId = setTimeout(() => {
          toolsCleanupScheduledRef.current = false
          setRecentTools([])
        }, SUBAGENT_LINGER_MS)
        timeoutIds.push(toolsTimeoutId)
      }

      return () => {
        timeoutIds.forEach((id) => clearTimeout(id))
      }
    } else {
      scheduledCleanupRef.current.clear()
      toolsCleanupScheduledRef.current = false
    }
  }, [isStreaming, activeSubagents, recentTools.length])

  // Clear accumulated tools and sub-agent store when a new stream starts
  const prevIsStreamingRef = useRef(false)
  useEffect(() => {
    if (isStreaming && !prevIsStreamingRef.current) {
      setAccumulatedSubagentTools([])
      teamStore.clear()
    }
    prevIsStreamingRef.current = isStreaming
  }, [isStreaming])

  // Detect template_copy tool invocation and notify parent
  const prevActiveTemplateCopyRef = useRef<string | null>(null)
  useEffect(() => {
    if (!onActiveToolCall) return

    const latestMessage = messages[messages.length - 1]
    if (!latestMessage || latestMessage.role !== "assistant") {
      if (prevActiveTemplateCopyRef.current !== null) {
        onActiveToolCall(null)
        prevActiveTemplateCopyRef.current = null
      }
      return
    }

    const toolCalls = extractToolCalls(latestMessage)

    const activeTemplateCopy = toolCalls.find((tc) => {
      const normalizedName = tc.toolName.includes("__")
        ? tc.toolName.split("__").pop()
        : tc.toolName
      const isTemplateTool =
        normalizedName === "template_copy" || normalizedName === "template.copy"
      const isRunning = tc.state === "input-streaming" || tc.state === "input-available"
      return isTemplateTool && isRunning
    })

    if (activeTemplateCopy) {
      if (prevActiveTemplateCopyRef.current !== activeTemplateCopy.toolName) {
        onActiveToolCall(activeTemplateCopy.toolName)
        prevActiveTemplateCopyRef.current = activeTemplateCopy.toolName
      }
    } else if (prevActiveTemplateCopyRef.current !== null) {
      onActiveToolCall(null)
      prevActiveTemplateCopyRef.current = null
    }
  }, [messages, onActiveToolCall])

  // Effect 1: Load chat messages with stale-while-revalidate.
  // On tab activate: show cached messages instantly (if available), then fetch
  // fresh data from the API. Only update the display if the response differs.
  //
  // Fix E (from plan): skip the refetch entirely while streaming/sending so a
  // GET /messages request never gets queued behind the active streaming SSE.
  // That was causing the "stuck on skip: already loading" wedge.
  useEffect(() => {
    if (!isActive) return
    if (!currentSessionId) {
      setIsInitialLoadComplete(true)
      return
    }

    const hasCached = cachedMessagesRef.current && cachedMessagesRef.current.length > 0

    // Fix E.1: never kick off a /messages fetch while streaming — the streaming
    // response IS the authoritative source, and a queued GET stalls behind the
    // SSE, wedging isLoadingMessagesRef forever. Hydrate cache only; the
    // post-stream revalidate effect below will refetch once streaming ends.
    if (isStreamingRef.current || isSendingMessageRef.current) {
      // Only hydrate from cache when the live `messages` array is empty —
      // i.e. the panel just (re)mounted and has nothing to show yet. Never
      // overwrite a non-empty live `messages` with the cache: the AI SDK is
      // the authoritative source mid-stream, and reference-only inequality
      // (e.g. cache stale by one tick) would otherwise feed setMessages back
      // into the SDK every render, racing the streaming updates and risking
      // a "Maximum update depth exceeded" loop.
      if (
        hasCached &&
        messagesRef.current.length === 0 &&
        cachedMessagesRef.current!.length > 0 &&
        cachedMessagesRef.current !== messagesRef.current
      ) {
        setMessages(cachedMessagesRef.current!)
      }
      if (hasCached) setIsInitialLoadComplete(true)
      // Clear any zombie flag from a prior non-streaming attempt so we don't
      // stay stuck after streaming completes.
      if (isLoadingMessagesRef.current) {
        isLoadingMessagesRef.current = false
        if (isLoadingMessages) setIsLoadingMessages(false)
      }
      return
    }

    if (isLoadingMessagesRef.current) return

    // Fix E.2: skip redundant refetch if cache was refreshed <5s ago. Without
    // this, promoting the loading flag to state (so it can retrigger the
    // effect) would cause finally() → setIsLoadingMessages(false) → effect
    // re-runs → refetch loop. 5s is short enough to still revalidate on tab
    // switches after a delay, long enough to absorb the state round-trip.
    //
    // Critical: the bailout is keyed on the timestamp ALONE, not on `hasCached`.
    // Empty sessions have `hasCached === false` forever (the .then() below
    // early-returns on `loaded.length === 0` so `cachedMessagesRef.current` is
    // never assigned). If the bailout were gated on `hasCached`, every Effect 1
    // re-run would refetch /chat-messages and the resulting isInitialLoadComplete
    // false→true flip would re-fire useChat's resumeStream → /stream — exactly
    // the ~700ms /stream + /chat-messages spam users saw on a fresh chat.
    //
    // Equally critical: distinguish "no stamp at all" from "stamp at t=0".
    // `?? 0` collapses both into 0, which makes the bailout fire for the first
    // 5s after page navigation (when `performance.now() < 5000`) on every
    // hard refresh — setting isInitialLoadComplete=true (firing useChat's
    // resumeStream → orphan `[AgentChat] Stream reconnect ... snapshot=none`)
    // but never calling loadPage, leaving the chat blank.
    // See chat-load-decision.test.ts for the regression repro.
    const refreshedAt = cacheRefreshedAtRef.current.get(currentSessionId)
    if (refreshedAt !== undefined && performance.now() - refreshedAt < 5000) {
      if (hasCached && messagesRef.current !== cachedMessagesRef.current) {
        setMessages(cachedMessagesRef.current!)
      }
      setIsInitialLoadComplete(true)
      return
    }

    if (hasCached) {
      if (messagesRef.current !== cachedMessagesRef.current) {
        setMessages(cachedMessagesRef.current!)
      }
      setIsInitialLoadComplete(true)
    }

    isLoadingMessagesRef.current = true
    setIsLoadingMessages(true)
    if (!hasCached) setIsInitialLoadComplete(false)

    if (!sessionMessages) {
      isLoadingMessagesRef.current = false
      setIsLoadingMessages(false)
      setIsInitialLoadComplete(true)
      return
    }

    // Generation token: lets the async .then()/.finally() callbacks below
    // detect that a session switch / tab close happened mid-load and bail
    // without writing to stale state. Bumped on every Effect 1 run.
    const myGeneration = ++loadGenerationRef.current
    const loadSessionId = currentSessionId

    sessionMessages
      .loadPage(
        { sessionId: currentSessionId, agent: 'technical' },
        { limit: MESSAGE_PAGE_SIZE, offset: 0 },
      )
      .then((_result: any) => {
        if (myGeneration !== loadGenerationRef.current) return
        if (isStreamingRef.current || isSendingMessageRef.current) return

        const loaded = [...sessionMessages.all].sort(
          (a: any, b: any) => (a.createdAt || 0) - (b.createdAt || 0),
        )

        if (loaded.length === 0) return

        const aiMessages = loaded.map((msg: any) => {
          const baseMessage: any = {
            id: msg.id,
            role: msg.role as "user" | "assistant",
            content: msg.content,
          }
          if (msg.parts) {
            try {
              baseMessage.parts = JSON.parse(msg.parts)
            } catch (err) {
              console.warn("[ChatPanel] Failed to parse message parts:", err)
            }
          }
          return baseMessage
        })

        const cached = cachedMessagesRef.current
        const changed =
          !cached ||
          cached.length !== aiMessages.length ||
          cached[cached.length - 1]?.id !== aiMessages[aiMessages.length - 1]?.id

        if (changed) {
          cachedMessagesRef.current = aiMessages
          sessionMessageCache.set(loadSessionId, aiMessages)
          setMessages(aiMessages)
        } else {
          // Same shape as cache — still refresh the module cache entry so any
          // later in-flight mutations (status flips, etc.) don't drift.
          sessionMessageCache.set(loadSessionId, aiMessages)
        }
      })
      .catch((err: any) => console.error("[ChatPanel] Failed to load messages:", err))
      .finally(() => {
        // Stamp the cache freshness on every completion path (empty results,
        // populated results, and errors). Without this, an empty session would
        // skip the stamp via the `loaded.length === 0` early return above and
        // then loop: Effect 1 re-runs on the isLoadingMessages flip, the
        // `cacheAgeMs < 5000` bailout misses, a new fetch starts, and the
        // resulting isInitialLoadComplete flip used to fire `useChat`'s
        // resumeStream every cycle (visible as
        // `[AgentChat] Stream reconnect ... snapshot=none` spam plus a
        // flickering "Loading conversation..." indicator). Now that
        // `useChat({ resume: false })` no longer auto-attaches we still
        // need the stamp for the dedup-the-fetch reason.
        cacheRefreshedAtRef.current.set(loadSessionId, performance.now())
        if (myGeneration === loadGenerationRef.current) {
          isLoadingMessagesRef.current = false
          setIsLoadingMessages(false)
          setIsInitialLoadComplete(true)
        }

        // Now that the history is in place, ask the runtime if there's a
        // genuinely live, in-progress turn to attach to. The probe is
        // robust (every failure mode → 'unknown' → no attach) so this
        // block is fire-and-forget. Critical: only run for the live
        // generation — otherwise a tab switch mid-load would attach to
        // a stale session's stream and corrupt the active panel's
        // message list (the original "I see the same message twice"
        // shape, just from a different angle).
        if (myGeneration !== loadGenerationRef.current) return
        const turnUrl = buildChatTurnUrl(
          API_URL!,
          projectId,
          localAgentUrl,
          loadSessionId,
          chatWorkspaceId,
        )
        void probeChatTurnStatus({
          url: turnUrl,
          fetch: expoFetch,
          headers: nativeHeaders ? nativeHeaders() : undefined,
          credentials: Platform.OS === 'web' ? 'include' : undefined,
        }).then((turnStatus) => {
          if (myGeneration !== loadGenerationRef.current) return
          if (shouldAttachLiveStream(turnStatus)) {
            void resumeStream()
          }
        })
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isActive, currentSessionId, sessionMessages, setMessages, isLoadingMessages, isStreaming])

  // Post-stream settle: when streaming ends, the AI SDK messages ARE the
  // authoritative fresh state — `cachedMessagesRef.current` is already kept in
  // lockstep with `messages` on every active-panel render (see the block near
  // line 1593), and `sessionMessageCache` is updated there too. The only thing
  // we need to do here is mark the cache fresh so Effect 1 (which re-runs
  // because `isStreaming` is in its deps) takes the fast bail-out path and
  // skips the network refetch + setMessages cycle that used to cascade a
  // second re-render across every open tab. Zombie loading flags are also
  // cleared defensively.
  useEffect(() => {
    if (!isActive || !currentSessionId) {
      wasStreamingRef.current = isStreaming
      return
    }
    if (wasStreamingRef.current && !isStreaming) {
      cacheRefreshedAtRef.current.set(currentSessionId, performance.now())
      if (isLoadingMessagesRef.current) {
        isLoadingMessagesRef.current = false
        setIsLoadingMessages(false)
      }
    }
    wasStreamingRef.current = isStreaming
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isActive, isStreaming, currentSessionId])

  // Surface a system notification when a turn finishes streaming while the
  // user is not currently active in the app (desktop window unfocused,
  // browser tab hidden, or mobile app backgrounded). Platform-agnostic —
  // dispatches through the platform-split chat-notifier module.
  const chatSessionForNotify = currentSessionId
    ? (studioChat.chatSessionCollection.get(currentSessionId) as any)
    : null
  const notifyTitle =
    chatSessionForNotify?.inferredName ||
    chatSessionForNotify?.name ||
    featureName ||
    'Shogo'
  const notifyPreview = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m: any = messages[i]
      if (m?.role !== 'assistant') continue
      const parts = m?.parts as any[] | undefined
      if (!parts) continue
      const text = parts
        .filter((p: any) => p?.type === 'text' && typeof p.text === 'string')
        .map((p: any) => p.text as string)
        .join(' ')
        .trim()
      if (text) return text
      break
    }
    return 'Reply is ready.'
  }, [messages])
  useNotifyOnTurnComplete({
    isStreaming,
    isActiveTab: isActive,
    wasAborted: stoppedMessages !== null,
    sessionId: currentSessionId ?? null,
    projectId: projectId ?? null,
    title: notifyTitle,
    preview: notifyPreview,
  })

  // Load older messages when user scrolls to top.
  // isLoadingOlderRef stays true until onContentSizeChange adjusts scroll position,
  // preventing a cascade where the scroll-to-top handler re-triggers loading.
  const handleLoadOlderMessages = useCallback(async () => {
    if (
      !currentSessionId ||
      !sessionMessages ||
      isLoadingOlderRef.current ||
      !sessionMessages.hasMore ||
      sessionMessages.isLoadingMore ||
      isStreamingRef.current
    ) return

    isLoadingOlderRef.current = true

    const currentCount = sessionMessages.all.length

    try {
      await sessionMessages.loadPage(
        { sessionId: currentSessionId, agent: 'technical' },
        { limit: MESSAGE_PAGE_SIZE, offset: currentCount },
      )

      const allLoaded = [...sessionMessages.all].sort(
        (a: any, b: any) => (a.createdAt || 0) - (b.createdAt || 0),
      )

      const aiMessages = allLoaded.map((msg: any) => {
        const baseMessage: any = {
          id: msg.id,
          role: msg.role as "user" | "assistant",
          content: msg.content,
        }
        if (msg.parts) {
          try {
            baseMessage.parts = JSON.parse(msg.parts)
          } catch (err) {
            console.warn("[ChatPanel] Failed to parse message parts:", err)
          }
        }
        return baseMessage
      })

      setMessages(aiMessages)
      // NOTE: isLoadingOlderRef is intentionally NOT reset here.
      // It is reset in onContentSizeChange after scroll position is adjusted,
      // so the onScroll handler doesn't immediately re-trigger loading.
    } catch (err) {
      console.error("[ChatPanel] Failed to load older messages:", err)
      isLoadingOlderRef.current = false
    }
  }, [currentSessionId, sessionMessages, setMessages])

  /** Native: load older only when scroll settles near the top — not on every onScroll frame. */
  const tryLoadOlderNearTopOnScrollEnd = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      if (e.nativeEvent.contentOffset.y >= LOAD_OLDER_SCROLL_EDGE_PX) return
      handleLoadOlderMessages()
    },
    [handleLoadOlderMessages],
  )

  /**
   * Web: track bottom for follow-scroll + debounced load-older near top.
   * Native omits onScroll entirely here — stick-to-bottom uses drag/momentum end handlers.
   */
  const handleMessagesScrollWeb = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      if (Date.now() < programmaticScrollUntilRef.current) return

      const { layoutMeasurement, contentOffset, contentSize } = e.nativeEvent
      const isAtBottom =
        contentSize.height - contentOffset.y - layoutMeasurement.height <
        SCROLL_NEAR_BOTTOM_PX
      if (isAtBottom !== isUserAtBottomRef.current) {
        isUserAtBottomRef.current = isAtBottom
        setIsFollowing(isAtBottom)
      }

      if (contentOffset.y < LOAD_OLDER_SCROLL_EDGE_PX) {
        if (loadOlderWebDebounceRef.current) {
          clearTimeout(loadOlderWebDebounceRef.current)
        }
        loadOlderWebDebounceRef.current = setTimeout(() => {
          loadOlderWebDebounceRef.current = null
          handleLoadOlderMessages()
        }, LOAD_OLDER_WEB_DEBOUNCE_MS)
      } else if (loadOlderWebDebounceRef.current) {
        clearTimeout(loadOlderWebDebounceRef.current)
        loadOlderWebDebounceRef.current = null
      }
    },
    [handleLoadOlderMessages],
  )

  // Re-hydrate pendingPlan from persisted messages on session restore
  useEffect(() => {
    if (!isInitialLoadComplete || isStreaming || pendingPlan) return
    if (messages.length === 0) return
    const lastMsg = messages[messages.length - 1]
    if (lastMsg.role !== "assistant") return
    const parts = (lastMsg as any).parts as any[] | undefined
    if (!parts) return
    const planTool = parts.find(
      (p: any) =>
        (p.type === "tool-invocation" && p.toolInvocation?.toolName === "create_plan" && p.toolInvocation?.state === "result") ||
        (p.type === "dynamic-tool" && p.toolName === "create_plan" && (p.state === "output-available" || p.state === "result"))
    )
    if (!planTool) return
    const args =
      planTool.type === "tool-invocation"
        ? planTool.toolInvocation?.args
        : planTool.input ?? planTool.args
    if (!args) return
    const restoredPlan = normalizePlanData({
      name: args.name ?? "Plan",
      overview: args.overview ?? "",
      plan: args.plan ?? "",
      todos: args.todos ?? [],
      filepath: args.filepath,
      toolCallId: planTool.id ?? planTool.toolCallId,
    })
    pendingPlanRef.current = restoredPlan
    setPendingPlan(restoredPlan)
  }, [isInitialLoadComplete, messages.length]) // eslint-disable-line react-hooks/exhaustive-deps

  // (Removed) Effect 2: MobX → AI SDK setMessages sync.
  //
  // This effect existed as a "fallback for when messages appear in MobX
  // before Effect 1 finishes" (e.g. real-time sync from another device).
  // It was the second writer to the AI SDK `messages` array, racing
  // Effect 1's loadPage `.then()` and the streaming SDK itself. With
  // Option-2's "single writer" model, Effect 1 owns `messages` end to
  // end and the live-stream attach is gated behind the explicit /turn
  // probe, so this fallback is no longer needed and was a primary
  // suspect for the "I see the same message twice" duplication.
  //
  // If real-time sync from another device ever needs to push history
  // into the SDK again, do it through a single funnel that lives next
  // to Effect 1 (e.g. by observing the per-session MST collection
  // *inside* Effect 1) so there is still only one setMessages caller.

  useEffect(() => {
    onStreamingChange?.(isStreaming)
  }, [isStreaming, onStreamingChange])

  // Only the active panel (the one feeding onMessagesChange) drives the shared plan-stream context.
  // Background panels must not fight over setIsPlanStreaming.
  const isActivePanel = onMessagesChange != null

  // Read `planStream` from a ref inside the publishing effects below so that
  // changes to the context value's identity do NOT re-run the effects (and
  // therefore can't cascade back into setState on the same context). The
  // setters on the context value are stable `useState` setters, so reading
  // them through the ref is safe.
  const planStreamRef = useRef(planStream)
  planStreamRef.current = planStream

  useEffect(() => {
    if (!isActivePanel) return
    const next = isStreaming && interactionMode === "plan"
    const ctx = planStreamRef.current
    if (!ctx) return
    if (ctx.isPlanStreaming === next) return
    ctx.setIsPlanStreaming(next)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isStreaming, interactionMode, isActivePanel])

  // Track the last plan we published so we can return the SAME object
  // identity when nothing about the create_plan args has changed. Without
  // this, every streaming token rebuilt a fresh `normalizePlanData({...})`
  // object, which in turn forced `setStreamingPlan` to fire (new identity →
  // React doesn't bail out) and stormed every `usePlanStream()` consumer.
  const lastDerivedPlanRef = useRef<{
    sig: string
    plan: PlanData | null
  }>({ sig: "", plan: null })

  const derivedStreamingPlan = useMemo<PlanData | null>(() => {
    const computeFresh = (): PlanData | null => {
      if (!isStreaming) return null
      const lastMsg = messages[messages.length - 1]
      if (!lastMsg || lastMsg.role !== "assistant") return null
      const parts = (lastMsg as any).parts as any[] | undefined
      if (!parts) return null
      const planPart = parts.find(
        (p: any) =>
          (p.type === "tool-invocation" && p.toolInvocation?.toolName === "create_plan") ||
          (p.type === "dynamic-tool" && p.toolName === "create_plan"),
      )
      if (!planPart) return null
      const args =
        planPart.type === "tool-invocation"
          ? planPart.toolInvocation?.args
          : planPart.input ?? planPart.args
      if (!args?.name) return null
      return normalizePlanData({
        name: args.name,
        overview: args.overview ?? "",
        plan: args.plan ?? "",
        todos: args.todos ?? [],
        filepath: args.filepath,
        toolCallId: planPart.id ?? planPart.toolCallId,
      })
    }
    const fresh = computeFresh()
    // Cheap structural signature: avoid `JSON.stringify` on every chunk
    // (O(plan body × tokens) of main-thread work) and instead compare
    // the field sizes and identifiers that actually distinguish a
    // mid-stream plan snapshot from the previous one.
    //
    // Every read is type-guarded because partial-JSON parsing of the
    // streaming `create_plan` args can hand us transient shapes — e.g.
    // `todos: [{ id: "t1" }]` (no `content` yet) or `overview: {}`
    // mid-key — that would otherwise throw inside this memo and trip
    // the chat's error boundary.
    let sig = ""
    if (fresh) {
      const overviewLen = typeof fresh.overview === "string" ? fresh.overview.length : 0
      const planLen = typeof fresh.plan === "string" ? fresh.plan.length : 0
      const todosArr = Array.isArray(fresh.todos) ? fresh.todos : []
      const lastTodo = todosArr.length > 0 ? (todosArr[todosArr.length - 1] as any) : null
      const lastTodoLen =
        typeof lastTodo?.content === "string" ? lastTodo.content.length : 0
      sig =
        `${fresh.name}|${overviewLen}|${planLen}|` +
        `${todosArr.length}|${lastTodoLen}|${fresh.filepath ?? ""}|${fresh.toolCallId ?? ""}`
    }
    if (sig === lastDerivedPlanRef.current.sig) {
      return lastDerivedPlanRef.current.plan
    }
    lastDerivedPlanRef.current = { sig, plan: fresh }
    return fresh
  }, [isStreaming, messages])

  // Throttle the publish to the shared `PlanStreamContext` so a long
  // `create_plan` stream doesn't notify every `usePlanStream()` consumer
  // on every chunk. The context is consumed across the project layout —
  // each unthrottled publish was contributing to the per-chunk re-render
  // storm that triggers `Maximum update depth exceeded` in long chats.
  // We publish immediately when the plan transitions to/from null
  // (start, end) and coalesce the in-between updates.
  const PLAN_PUBLISH_THROTTLE_MS = 150
  const lastPlanPublishAtRef = useRef(0)
  const planPublishTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingPlanPublishRef = useRef<{
    plan: PlanData | null
    filepath: string | null
  } | null>(null)
  useEffect(() => {
    return () => {
      if (planPublishTimerRef.current) {
        clearTimeout(planPublishTimerRef.current)
        planPublishTimerRef.current = null
      }
    }
  }, [])
  useEffect(() => {
    const ctx = planStreamRef.current
    if (!ctx) return

    const nextFilepath = derivedStreamingPlan
      ? (derivedStreamingPlan.filepath ?? null)
      : !isStreaming
        ? null
        : ctx.streamingPlanFilepath

    const planChanged = ctx.streamingPlan !== derivedStreamingPlan
    const filepathChanged = ctx.streamingPlanFilepath !== nextFilepath
    if (!planChanged && !filepathChanged) return

    const publish = () => {
      const c = planStreamRef.current
      if (!c) return
      const pending = pendingPlanPublishRef.current
      if (!pending) return
      pendingPlanPublishRef.current = null
      lastPlanPublishAtRef.current = Date.now()
      if (c.streamingPlan !== pending.plan) c.setStreamingPlan(pending.plan)
      if (c.streamingPlanFilepath !== pending.filepath) {
        c.setStreamingPlanFilepath(pending.filepath)
      }
    }

    pendingPlanPublishRef.current = { plan: derivedStreamingPlan, filepath: nextFilepath }

    // Edge events (stream start where the plan first appears, and the
    // null-flip when it ends) bypass the throttle so the UI reacts
    // immediately to lifecycle transitions.
    const isEdge =
      derivedStreamingPlan === null ||
      ctx.streamingPlan === null
    if (isEdge) {
      if (planPublishTimerRef.current) {
        clearTimeout(planPublishTimerRef.current)
        planPublishTimerRef.current = null
      }
      publish()
      return
    }

    if (planPublishTimerRef.current) return
    const elapsed = Date.now() - lastPlanPublishAtRef.current
    const wait = elapsed >= PLAN_PUBLISH_THROTTLE_MS ? 0 : PLAN_PUBLISH_THROTTLE_MS - elapsed
    planPublishTimerRef.current = setTimeout(() => {
      planPublishTimerRef.current = null
      publish()
    }, wait)
    // `planStream` intentionally omitted: we read it via `planStreamRef` so
    // its identity churn (fixed independently in PlanStreamContext) cannot
    // cause this effect to re-run and re-publish the same value.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [derivedStreamingPlan, isStreaming])

  // Auto-scroll to bottom when messages change
  // On native, streaming follow is handled entirely by onContentSizeChange
  // so this effect only fires for discrete events (new message added, first load).
  // On web, messages ref changes are still used for follow (existing behaviour).
  const isFirstLoadRef = useRef(true)

  useEffect(() => {
    isFirstLoadRef.current = true
    isUserAtBottomRef.current = true
    stickToBottomRef.current = true
    setIsFollowing(true)
    prevDisplayLengthRef.current = 0
  }, [currentSessionId])

  useEffect(() => {
    if (displayMessages.length === 0) return

    const isNewMessage = displayMessages.length !== prevDisplayLengthRef.current
    prevDisplayLengthRef.current = displayMessages.length

    // On native, skip streaming-token updates — onContentSizeChange handles follow
    if (isNative && !isNewMessage && !isFirstLoadRef.current) {
      return
    }

    if (displayMessages.length === 1 && (isFirstLoadRef.current || shouldFollowBottom())) {
      markProgrammaticScroll()
      scrollViewRef.current?.scrollTo({ y: 0, animated: false })
      isFirstLoadRef.current = false
      return
    }

    const shouldScroll =
      displayMessages.length > 1 && (isFirstLoadRef.current || shouldFollowBottom())

    if (shouldScroll) {
      scrollToBottomIfFollowing(!isFirstLoadRef.current)
      isFirstLoadRef.current = false
    }
  }, [displayMessages.length, messages, currentSessionId, isNative, shouldFollowBottom, scrollToBottomIfFollowing, markProgrammaticScroll])

  // Detect a pending ask_user tool call in the last assistant message and
  // surface its tool data so the interactive question UI can be attached
  // above the chat input (instead of rendered inline in the stream).
  const pendingQuestion = useMemo(
    () => derivePendingQuestion(messages),
    [messages]
  )

  const hasPendingQuestion = pendingQuestion != null

  const extractMediaType = useCallback((dataUrl: string): string => {
    const match = dataUrl.match(/^data:([^;]+);/)
    return match?.[1] || "application/octet-stream"
  }, [])

  // Internal function that actually sends a message (used by queue processor)
  const sendMessageInternal = useCallback(
    async (content: string, files?: FileAttachment[], perMsgModel?: string) => {
      if (!currentSessionId) {
        console.warn("[ChatPanel] No session ID - message will be lost!")
        return
      }
      setStoppedMessages(null)
      setEmptyResponseError(null)
      setErrorDismissed(false)
      userInitiatedStopRef.current = false

      const fileArray = files || []

      if (!content.trim() && fileArray.length === 0) {
        return
      }

      // App Store 5.1.1(i)/5.1.2(i): on iOS, request explicit one-time consent
      // before transmitting the user's prompt to third-party AI providers.
      // Uses the native iOS alert primitive (same UI as camera/location
      // permissions) — no new screen, persisted in expo-secure-store.
      if (Platform.OS === "ios") {
        const alreadyAccepted = await hasAcceptedAiConsent().catch(() => false)
        if (!alreadyAccepted) {
          const providerNames = AI_PROVIDERS.map((p) => p.name).join(" or ")
          const accepted = await new Promise<boolean>((resolve) => {
            Alert.alert(
              "Share your message with the selected AI provider?",
              `To generate a response, your message and any attachments will be sent to the AI provider you\u2019ve selected (${providerNames}). We don\u2019t send your email, payment info, or device identifiers.`,
              [
                { text: "Don\u2019t allow", style: "cancel", onPress: () => resolve(false) },
                { text: "Allow", onPress: () => resolve(true) },
              ],
              { cancelable: false },
            )
          })
          if (!accepted) {
            await revokeAiConsent().catch(() => {})
            return
          }
          await acceptAiConsent().catch(() => {})
        }
      }

      const trimmedContent = content.trim()
      if (Platform.OS !== "web") {
        stickToBottomRef.current = true
      } else {
        isUserAtBottomRef.current = true
      }
      setIsFollowing(true)
      lastUserInputRef.current = { content: trimmedContent, files: fileArray }
      setOptimisticUserInput({ sessionId: currentSessionId, content: trimmedContent, files: fileArray })

      const parts: Array<
        { type: "text"; text: string } | { type: "file"; mediaType: string; url: string; name?: string }
      > = []

      if (trimmedContent) {
        parts.push({ type: "text", text: trimmedContent })
      }

      fileArray.forEach((file) => {
        parts.push({
          type: "file",
          mediaType: file.type || extractMediaType(file.dataUrl),
          url: file.dataUrl,
          ...(file.name ? { name: file.name } : {}),
        })
      })

      isSendingMessageRef.current = true

      // Let EZ Mode know a new turn is starting. This is what
      // triggers the overlay to arm its heartbeat / activity buffer.
      try {
        emitTurnStartRef.current?.()
      } catch (err) {
        console.warn("[ChatPanel] bridge.emitTurnStart threw", err)
      }

      actions
        .addMessage({
          sessionId: currentSessionId,
          role: "user",
          content: trimmedContent,
          imageData: fileArray.length > 0 ? fileArray[0].dataUrl : undefined,
          parts: parts.length > 0 ? JSON.stringify(parts) : undefined,
        })
        .catch((err) => console.warn("[ChatPanel] Failed to persist user message:", err))

      // Optimistically bump the chat session's lastActiveAt so the
      // history sidebar re-buckets this chat into "Today" immediately
      // instead of waiting for a session-list refetch. The server-side
      // chatMessageHooks.afterCreate hook performs the canonical
      // update; this MST mutation just keeps the local view in sync.
      try {
        const sessionInstance =
          studioChat.chatSessionCollection.get(currentSessionId) as
            | { update?: (changes: Record<string, unknown>) => void }
            | undefined
        sessionInstance?.update?.({ lastActiveAt: Date.now() })
      } catch (err) {
        console.warn("[ChatPanel] Failed to bump local session lastActiveAt:", err)
      }

      const messagePayload: {
        text: string
        files?: Array<{ type: "file"; mediaType: string; url: string; name?: string }>
      } = {
        text: trimmedContent,
      }

      if (fileArray.length > 0) {
        messagePayload.files = fileArray.map((file) => ({
          type: "file" as const,
          mediaType: file.type || extractMediaType(file.dataUrl),
          url: file.dataUrl,
          ...(file.name ? { name: file.name } : {}),
        }))
      }

      try {
        const bodyExtra: Record<string, unknown> = {
          featureId,
          phase,
          chatSessionId: currentSessionId,
          workspaceId,
          userId,
          projectId,
          agentMode: perMsgModel || selectedModel,
          interactionMode: interactionModeRef.current,
          dualPlan: dualPlanRef.current,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        }
        const planToSend = confirmedPlanRef.current
        if (planToSend) {
          bodyExtra.confirmedPlan = normalizePlanData(planToSend)
          bodyExtra.interactionMode = "agent"
          confirmedPlanRef.current = null
        }
        console.log("[ChatPanel][send] bodyExtra — interactionMode:", bodyExtra.interactionMode, "agentMode:", bodyExtra.agentMode, "hasConfirmedPlan:", !!bodyExtra.confirmedPlan, "text:", trimmedContent.slice(0, 80))
        await sendMessage(messagePayload, { body: bodyExtra })
      } catch (err) {
        console.error("[ChatPanel] Failed to send message:", err)
        throw err
      } finally {
        isSendingMessageRef.current = false
      }
    },
    [
      currentSessionId,
      studioChat,
      sendMessage,
      featureId,
      phase,
      extractMediaType,
      workspaceId,
      userId,
      projectId,
      selectedModel,
      actions,
    ]
  )

  // Register bridge endpoints so the EZ Mode overlay can send messages
  // and toggle interaction mode on our behalf. The registrar is a no-op
  // when no <ChatBridgeProvider> is mounted (e.g. tests), so it's safe to
  // call unconditionally.
  const bridgeSend = useCallback(
    (text: string) => {
      void sendMessageInternal(text)
    },
    [sendMessageInternal],
  )
  const bridgeSetMode = useCallback(
    (mode: InteractionMode) => {
      handleInteractionModeChange(mode)
    },
    [handleInteractionModeChange],
  )
  const {
    emitTurnStart: bridgeEmitTurnStart,
    emitToolActivity: bridgeEmitToolActivity,
    emitTurnEnd: bridgeEmitTurnEnd,
    setSubagentCards: bridgeSetSubagentCards,
  } = useChatBridgeRegistrar({
    send: bridgeSend,
    setMode: bridgeSetMode,
  })
  useEffect(() => {
    emitTurnStartRef.current = bridgeEmitTurnStart
    emitToolActivityRef.current = bridgeEmitToolActivity
    emitTurnEndRef.current = bridgeEmitTurnEnd
    setSubagentCardsRef.current = bridgeSetSubagentCards
    return () => {
      if (emitTurnStartRef.current === bridgeEmitTurnStart) emitTurnStartRef.current = null
      if (emitToolActivityRef.current === bridgeEmitToolActivity) emitToolActivityRef.current = null
      if (emitTurnEndRef.current === bridgeEmitTurnEnd) emitTurnEndRef.current = null
      if (setSubagentCardsRef.current === bridgeSetSubagentCards) setSubagentCardsRef.current = null
    }
  }, [bridgeEmitTurnStart, bridgeEmitToolActivity, bridgeEmitTurnEnd, bridgeSetSubagentCards])

  // Queue processor: processes messages one at a time
  const processMessageQueue = useCallback(async () => {
    if (isProcessingQueueRef.current) return
    if (isStreaming) return
    if (!currentSessionId) return
    if (messageQueue.length === 0) return

    isProcessingQueueRef.current = true

    const nextMessage = messageQueue[0]
    setMessageQueue((queue) => queue.slice(1))

    try {
      await sendMessageInternal(
        nextMessage.content,
        nextMessage.files,
        nextMessage.selectedModel
      )
    } catch (err) {
      console.error("[ChatPanel] Error processing queued message:", err)
      isProcessingQueueRef.current = false
    }
  }, [isStreaming, sendMessageInternal, currentSessionId, messageQueue])

  // Process queue when streaming completes
  const queueStreamingRef = useRef(false)
  useEffect(() => {
    const wasStreaming = queueStreamingRef.current
    queueStreamingRef.current = isStreaming

    if (wasStreaming && !isStreaming) {
      isProcessingQueueRef.current = false
      if (messageQueue.length > 0 && currentSessionId) {
        processMessageQueue()
      }
    }
  }, [isStreaming, messageQueue.length, processMessageQueue, currentSessionId])

  // Stall watchdog — break a wedged `submitted`/`streaming` status so the
  // queue-drain effect above gets its falling edge.
  //
  // The AI SDK's `AbstractChat.makeRequest` blocks on `reader.read()` until
  // the body closes; there's no internal timeout. When the upstream proxy
  // cuts mid-turn AND `auto-resuming-fetch` exhausts its resume budget
  // while still inside an open `data:` frame, the durable body can sit
  // pinned without enqueuing or closing. Without this effect, `status`
  // pins at `submitted`/`streaming` forever, `handleSendMessage` routes
  // every subsequent user send into `messageQueue`, and the user observes
  // "AI never replied". See `chat-panel-wedge.test.ts` for the contract.
  //
  // Forward-progress signal: any update to `messages` (text-delta, tool
  // events, etc.) timestamps the watchdog. A status entering `submitted`
  // / `streaming` also counts as fresh progress. The actual ref is
  // declared up-component near the transport so the auto-resuming-fetch
  // `onChunk` callback and `useChat({ onData })` can both bump it on
  // wire-level activity that doesn't reach `messages` (SSE comments,
  // `data-*` frames). When that timestamp goes stale past the
  // threshold for the current status, we call `stop()` — the SDK
  // aborts the active response and flips to `ready`.
  useEffect(() => {
    lastChatProgressAtRef.current = Date.now()
  }, [messages, status])

  useEffect(() => {
    if (!isStreaming) return
    const intervalMs = Math.min(DEFAULT_SUBMITTED_STALL_MS, DEFAULT_STREAMING_STALL_MS, 15_000)
    const timer = setInterval(() => {
      const now = Date.now()
      const lastProgressAt = lastChatProgressAtRef.current
      if (
        isChatStalled({
          status,
          lastProgressAt,
          now,
        })
      ) {
        const elapsedMs = now - lastProgressAt
        console.warn(
          `[ChatPanel] stall watchdog tripped — status=${status} pinned for ${elapsedMs}ms with no progress; calling stop() to recover`
        )
        // Surface in Sentry so this class of bug is visible in the
        // dashboard instead of having to be reconstructed from kube
        // logs. `captureMessage` (not `captureException`) because
        // there is no JS Error here — the AI SDK swallows the
        // AbortError from `stop()` as normal control flow, which is
        // exactly why production incidents in this code path have
        // been invisible historically. Severity is `warning`: the
        // watchdog *recovered* the wedged turn, so the user is not
        // blocked, but every trip is still a missed-progress signal
        // we want to investigate.
        try {
          Sentry.captureMessage("chat_stall_watchdog_tripped", {
            level: "warning",
            tags: {
              projectId: projectId ?? "(none)",
              chatSessionId: currentSessionId ?? "(none)",
              chatStatus: status,
            },
            extra: {
              elapsedMs,
              submittedThresholdMs: DEFAULT_SUBMITTED_STALL_MS,
              streamingThresholdMs: DEFAULT_STREAMING_STALL_MS,
              lastProgressAt,
              now,
            },
          })
        } catch (err) {
          // Sentry init can fail (DSN unset on dev builds, etc.) —
          // never let it break the recovery path.
          console.warn("[ChatPanel] Sentry.captureMessage threw:", err)
        }
        try {
          void stop()
        } catch (err) {
          console.warn("[ChatPanel] stall watchdog stop() threw:", err)
        }
      }
    }, intervalMs)
    return () => clearInterval(timer)
  }, [isStreaming, status, stop, projectId, currentSessionId])

  // Hydrate the queue for the active session from the per-session cache when
  // the session changes. Previously this effect *cleared* the queue on every
  // session switch, which also wiped queued messages the user had just typed
  // (and lost them on any navigation that remounts ChatPanel). The cache is
  // updated by the effect below whenever `messageQueue` changes, so switching
  // back to a session restores its pending queue.
  useEffect(() => {
    const cached = currentSessionId
      ? sessionQueueCache.get(currentSessionId) ?? []
      : []
    setMessageQueue(cached)
    isProcessingQueueRef.current = false
    setOptimisticUserInput(null)
    lastNonEmptyMessagesRef.current = []
  }, [currentSessionId])

  // Mirror the queue into the per-session cache so it survives remounts.
  useEffect(() => {
    if (!currentSessionId) return
    if (messageQueue.length === 0) {
      sessionQueueCache.delete(currentSessionId)
    } else {
      sessionQueueCache.set(currentSessionId, messageQueue)
    }
  }, [currentSessionId, messageQueue])

  const handleRemoveQueuedMessage = useCallback((messageId: string) => {
    setMessageQueue((queue) => queue.filter((m) => m.id !== messageId))
  }, [])

  const handleReorderQueuedMessage = useCallback(
    (messageId: string, direction: "up" | "down") => {
      setMessageQueue((queue) => {
        const index = queue.findIndex((m) => m.id === messageId)
        if (index === -1) return queue

        const newQueue = [...queue]
        if (direction === "up" && index > 0) {
          ;[newQueue[index - 1], newQueue[index]] = [newQueue[index], newQueue[index - 1]]
        } else if (direction === "down" && index < newQueue.length - 1) {
          ;[newQueue[index], newQueue[index + 1]] = [newQueue[index + 1], newQueue[index]]
        }
        return newQueue
      })
    },
    []
  )

  // Pull a queued message back into the input as a draft so the user can
  // tweak the text/attachments and re-send. We remove the original entry
  // immediately so re-submitting just appends a fresh queue item rather than
  // duplicating the in-flight one.
  const handleEditQueuedMessage = useCallback(
    (messageId: string) => {
      let target: QueuedMessage | undefined
      setMessageQueue((queue) => {
        target = queue.find((m) => m.id === messageId)
        if (!target) return queue
        return queue.filter((m) => m.id !== messageId)
      })
      if (!target) return
      setRestoreDraftRequest({
        nonce: Date.now(),
        content: target.content,
        files: target.files,
      })
    },
    []
  )

  // "Send now" — interrupt the current streaming turn and immediately drain
  // the chosen queued message. Implemented as "promote to front + stop" so we
  // re-use the existing falling-edge drain effect (see `processMessageQueue`
  // hookup ~line 3514) rather than introducing a parallel send-by-id path.
  // When no turn is streaming we drain directly: cached queues restored on
  // session switch can sit idle since the falling-edge effect only fires on
  // streaming->ready transitions.
  const handleSendQueuedMessageNow = useCallback(
    (messageId: string) => {
      let promoted = false
      setMessageQueue((queue) => {
        const idx = queue.findIndex((m) => m.id === messageId)
        if (idx === -1) return queue
        promoted = true
        if (idx === 0) return queue
        const target = queue[idx]
        const without = queue.filter((m) => m.id !== messageId)
        return [target, ...without]
      })
      if (!promoted) return
      if (isStreaming) {
        handleStop()
      } else {
        void processMessageQueue()
      }
    },
    [isStreaming, handleStop, processMessageQueue]
  )

  // Handle message submission
  const handleSendMessage = useCallback(
    async (content: string, files?: FileAttachment[], perMsgModel?: string) => {
      if (!currentSessionId) {
        console.warn("[ChatPanel] No session ID - message will be lost!")
        return
      }

      if (!content.trim() && (!files || files.length === 0)) {
        return
      }

      const trimmedContent = content.trim()

      if (isStreaming || isProcessingQueueRef.current || isSendingMessageRef.current) {
        setMessageQueue((queue) => [
          ...queue,
          {
            id: `queue-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
            content: trimmedContent,
            files,
            selectedModel: perMsgModel,
          },
        ])
        return
      }

      await sendMessageInternal(trimmedContent, files, perMsgModel)
    },
    [isStreaming, sendMessageInternal, currentSessionId]
  )

  // Handle form submit from ChatInput
  const handleInputSubmit = useCallback(
    (content: string, files?: FileAttachment[], perMsgModel?: string) => {
      handleSendMessage(content, files, perMsgModel)
    },
    [handleSendMessage]
  )

  // Plan confirmation: switch to Agent mode and execute.
  // Keep the PlanCard visible with confirmed state for a few seconds before dismissing.
  const confirmDismissTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const handleConfirmPlan = useCallback((plan?: PlanData | null) => {
    const selectedPlan = plan ?? pendingPlanRef.current
    if (!selectedPlan) return
    const planToBuild = normalizePlanData(selectedPlan)
    confirmedPlanRef.current = planToBuild
    setConfirmedPlan(planToBuild)
    pendingPlanRef.current = null
    setPendingPlan(null)
    console.log("[ChatPanel][confirm-plan] BEFORE mode change — stateMode:", interactionMode, "refMode:", interactionModeRef.current, "selectedModel:", selectedModel)
    handleInteractionModeChange("agent")
    console.log("[ChatPanel][confirm-plan] AFTER mode change — refMode:", interactionModeRef.current, "(state will update on next render)")
    handleSendMessage("Execute the confirmed plan.")
    if (confirmDismissTimerRef.current) clearTimeout(confirmDismissTimerRef.current)
    confirmDismissTimerRef.current = setTimeout(() => {
      setConfirmedPlan(null)
    }, 4000)
  }, [handleSendMessage, handleInteractionModeChange])

  // Build from Plans panel: execute a saved plan with selected model
  const lastBuildNonceRef = useRef<number>(0)
  useEffect(() => {
    if (!buildPlanRequest || buildPlanRequest.nonce === lastBuildNonceRef.current) return
    lastBuildNonceRef.current = buildPlanRequest.nonce
    const { plan, modelId: requestedMode } = buildPlanRequest
    const planToBuild = normalizePlanData(plan)
    confirmedPlanRef.current = planToBuild
    setConfirmedPlan(planToBuild)
    pendingPlanRef.current = null
    setPendingPlan(null)
    handleInteractionModeChange("agent")
    handleSendMessage("Execute the confirmed plan.", undefined, requestedMode)
    if (confirmDismissTimerRef.current) clearTimeout(confirmDismissTimerRef.current)
    confirmDismissTimerRef.current = setTimeout(() => {
      setConfirmedPlan(null)
    }, 4000)
    onBuildPlanConsumed?.(buildPlanRequest.nonce)
  }, [buildPlanRequest, handleInteractionModeChange, handleSendMessage, onBuildPlanConsumed])

  useEffect(() => {
    return () => {
      if (confirmDismissTimerRef.current) clearTimeout(confirmDismissTimerRef.current)
    }
  }, [])

  // Homepage transition warm-start: Inject initial message on mount (only for fresh sessions)
  useEffect(() => {
    if (!initialMessage || !currentSessionId || !isInitialLoadComplete) return
    if (hasInjectedInitialMessageRef.current) return

    if (messages.length > 0) {
      hasInjectedInitialMessageRef.current = true
      return
    }

    hasInjectedInitialMessageRef.current = true
    setPendingInitialMessage(initialMessage)
    handleSendMessage(initialMessage, initialFiles)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialMessage, initialFiles, currentSessionId, isInitialLoadComplete, handleSendMessage])

  // Programmatic message injection
  const lastInjectedRef = useRef<string | null>(null)
  useEffect(() => {
    if (
      injectMessage &&
      injectMessage.trim() &&
      currentSessionId &&
      injectMessage !== lastInjectedRef.current
    ) {
      lastInjectedRef.current = injectMessage
      const cleanMessage = injectMessage.replace(/\n\n\[nonce:\d+\]$/, "")
      handleSendMessage(cleanMessage)
    }
  }, [injectMessage, currentSessionId, handleSendMessage])

  // ─── "Fix with Shogo" from the IDE ──────────────────────────────────
  // agentFixProvider (inside the Monaco editor) dispatches a window-level
  // CustomEvent whenever the user clicks "✨ Fix with Shogo" inside an error
  // hover or quick-fix menu. Only the currently-active ChatPanel consumes it
  // so a single Fix click maps to exactly one message, no matter how many
  // chat tabs are mounted.
  useEffect(() => {
    if (Platform.OS !== "web") return
    if (!isActive) return
    if (!currentSessionId) return

    const onFix = (e: Event) => {
      const detail = (e as CustomEvent<FixInAgentPayload>).detail
      if (!detail || !detail.message) return
      const prompt = buildFixPrompt(detail)
      handleSendMessage(prompt)
    }

    window.addEventListener(FIX_IN_AGENT_EVENT, onFix as EventListener)
    return () => window.removeEventListener(FIX_IN_AGENT_EVENT, onFix as EventListener)
  }, [isActive, currentSessionId, handleSendMessage])

  // ─── Terminal context → Chat ─────────────────────────────────────────
  // Desktop-only: when the user right-clicks a failing command in the
  // terminal and picks "Debug with AI", the terminal bridge pushes a
  // pre-rendered markdown report via IPC. We listen for it here and
  // inject it as the next user message so the AI can help debug.
  useEffect(() => {
    if (Platform.OS !== "web") return
    const desktop = (globalThis as any).shogoDesktop
    if (!desktop?.onChatWithContext) return

    const unsub = desktop.onChatWithContext((data: { markdown: string }) => {
      if (!data?.markdown || !currentSessionId) return
      handleSendMessage(data.markdown)
    })
    return unsub
  }, [currentSessionId, handleSendMessage])

  // Collapse toggle — persist to AsyncStorage only when using internal state
  const handleToggleCollapse = useCallback(() => {
    const newCollapsed = !isCollapsed
    setIsCollapsed(newCollapsed)
    if (!onCollapsedChange) {
      setStoredCollapsed(newCollapsed)
    }
  }, [isCollapsed, setIsCollapsed, onCollapsedChange])

  // Error retry handler
  const handleRetry = useCallback(() => {
    if (messages.length > 0) {
      const lastUserMsg = [...messages].reverse().find((m) => m.role === "user")
      if (lastUserMsg) {
        const parts = ((lastUserMsg as any).parts ?? []) as any[]
        const textPart = parts.find((p: any) => p.type === "text")
        const content = textPart?.text || ""

        // Preserve file attachments on retry — previously dropped, so images/
        // PDFs/etc. were lost and the model got a text-only prompt.
        const fileParts = parts.filter((p: any) => p?.type === "file" && p?.url)
        const cachedFiles = lastUserInputRef.current?.files
        const filesFromParts: FileAttachment[] = fileParts.map((p: any) => ({
          dataUrl: p.url,
          name: p.name ?? p.filename ?? "file",
          type: p.mediaType ?? extractMediaType(p.url),
        }))
        const files: FileAttachment[] | undefined =
          cachedFiles && cachedFiles.length > 0
            ? cachedFiles
            : filesFromParts.length > 0
              ? filesFromParts
              : undefined

        if (content || (files && files.length > 0)) {
          const lastUserIdx = messages.lastIndexOf(lastUserMsg)
          setMessages(messages.slice(0, lastUserIdx))
          sendMessageInternal(content, files).catch((err) =>
            console.error("[ChatPanel] Retry failed:", err)
          )
        }
      }
    }
  }, [messages, sendMessageInternal, setMessages])

  const handleRetryRef = useRef<(() => void) | null>(null)
  handleRetryRef.current = handleRetry

  // ─── Edit / Retry from arbitrary user message ────────────────────────────
  //
  // Built on top of `sendMessageInternal` and the new server endpoint
  // `POST /api/chat-messages/:id/truncate-from`. The high-level shape
  // for both flows is identical to `handleRetry` above, with one extra
  // step at the front: delete the target message + everything after it
  // on the server so the DB doesn't grow stale orphan rows.
  //
  //   1. truncate-from on the server  -> deletes target + all after
  //      (also evicts those rows from the per-session MST cache so
  //       hydrators don't render ghosts)
  //   2. setMessages(messages.slice(0, idx)) -> in-memory truncation
  //   3. sendMessageInternal(newContent, files) -> recreates the user
  //      message via the normal pipeline (actions.addMessage + stream)
  //
  // Both Edit and Retry use the SAME primitive; the only difference is
  // whether the re-sent content is the original or the edited string.
  //
  // Guards:
  //   - Disabled while streaming (race with in-flight useChat request)
  //   - Disabled for messages with optimistic / temp ids — those rows
  //     are not yet on the server, so truncate-from has nothing to do.
  //     If the user wants to "edit" a not-yet-sent message they should
  //     use the queue's edit affordance in ChatInput.
  //
  // Note: reuses the existing `messagesRef` declared near the top of
  // the component (right after the `useChat` setup) so we don't
  // duplicate the ref-update side effect.
  const truncateAndResend = useCallback(
    async (
      messageId: string,
      newContent: string,
      newFiles: FileAttachment[] | undefined,
      options: MessageEditOptions | undefined,
    ) => {
      if (!sessionMessages) {
        console.warn("[ChatPanel] truncateAndResend without sessionMessages")
        return
      }
      const current = messagesRef.current
      const idx = current.findIndex((m) => m.id === messageId)
      if (idx === -1) {
        console.warn("[ChatPanel] truncateAndResend: message not found locally", messageId)
        return
      }

      // Step 1: chat truncation. This is the source of truth — if it
      // fails we abort the whole rewind. The local MST cache is
      // mirrored inside truncateMessagesFrom.
      try {
        await truncateMessagesFrom(sessionMessages, messageId)
      } catch (err) {
        console.error("[ChatPanel] truncate-from failed:", err)
        throw err
      }

      // Step 2: optional file rollback. Runs BETWEEN the chat
      // truncation and the resend so that:
      //   - The user sees their chat collapse to the edit point
      //     before the (potentially slow) git checkout runs.
      //   - A rollback failure leaves us in a coherent state — chat
      //     is at the new edit point, files are unchanged, no new
      //     send is fired. The error bubbles up to EditableUserMessage
      //     where it's logged + the bubble's busy state clears.
      //   - The server's pre-rollback auto-save still protects any
      //     uncommitted user changes in the workspace.
      if (options?.revertFiles && options.checkpoint) {
        try {
          await rollbackProjectToCheckpoint(sessionMessages, {
            projectId: options.checkpoint.projectId,
            checkpointId: options.checkpoint.id,
            checkpointCreatedAt: options.checkpoint.createdAt,
            // We don't surface the includeDatabase toggle in the chat
            // bubble dialog yet — power users still have the
            // CheckpointsPanel for that finer-grained call. Default
            // to false so we don't surprise users with DB rollbacks
            // triggered from a chat edit.
            includeDatabase: false,
          })
        } catch (err) {
          console.error("[ChatPanel] checkpoint rollback failed:", err)
          throw err
        }
      }

      setMessages(current.slice(0, idx))
      await sendMessageInternal(newContent, newFiles)
    },
    [sessionMessages, setMessages, sendMessageInternal],
  )

  const handleEditMessage = useCallback(
    async (
      messageId: string,
      newContent: string,
      newFiles: FileAttachment[] | undefined,
      options?: MessageEditOptions,
    ) => {
      // `newFiles` is the authoritative attachment set chosen by
      // the user in the in-place ChatInput (which is pre-filled
      // with the original message's files via `restoreDraftRequest`).
      // We do NOT fall back to the original message's file parts
      // here on purpose — a user who removed the original
      // screenshot before re-sending should get a clean resend
      // WITHOUT it. The "no-touch edit" case still round-trips the
      // originals because the ChatInput hands them back unchanged.
      await truncateAndResend(messageId, newContent, newFiles, options)
    },
    [truncateAndResend],
  )

  const handleRetryFromMessage = useCallback(
    async (messageId: string, options?: MessageEditOptions) => {
      const current = messagesRef.current
      const msg = current.find((m) => m.id === messageId)
      if (!msg) return
      const parts = ((msg as any).parts ?? []) as any[]
      const textPart = parts.find((p: any) => p?.type === "text")
      const content = textPart?.text || extractTextContent(msg) || ""
      const fileParts = parts.filter((p: any) => p?.type === "file" && p?.url)
      const files: FileAttachment[] | undefined =
        fileParts.length > 0
          ? fileParts.map((p: any) => ({
              dataUrl: p.url,
              name: p.name ?? p.filename ?? "file",
              type: p.mediaType ?? extractMediaType(p.url),
            }))
          : undefined
      if (!content && !files) return
      await truncateAndResend(messageId, content, files, options)
    },
    [truncateAndResend, extractMediaType],
  )

  // Used by the EditConfirmDialog to decide whether to render the
  // "Also revert project files" checkbox. We resolve through the
  // SDK env's HttpClient (via shared-app helper) so the remote-aware
  // interceptor proxies to the desktop instance when one is
  // connected — same code path as truncate-from.
  //
  // A null collection / null checkpoint short-circuits to "no
  // rollback available" so the bubble's lookup never blocks on
  // sessionMessages being ready.
  const handleGetPrecedingCheckpoint = useCallback(
    async (messageId: string): Promise<PrecedingCheckpointResult> => {
      if (!sessionMessages) {
        return { ok: true, checkpoint: null, reason: "no_checkpoint" }
      }
      return getPrecedingCheckpoint(sessionMessages, messageId)
    },
    [sessionMessages],
  )

  const countMessagesAfter = useCallback((messageId: string) => {
    const current = messagesRef.current
    const idx = current.findIndex((m) => m.id === messageId)
    if (idx === -1) return 0
    return Math.max(0, current.length - idx - 1)
  }, [])

  const canEditMessage = useCallback((message: UIMessage) => {
    if (message.role !== "user") return false
    const id = message.id
    if (!id) return false
    // Optimistic / not-yet-persisted ids — see buildOptimisticUserMessage
    // and the `temp-` prefix from chatMessageCollection.create.
    if (id.startsWith("temp-")) return false
    if (id.startsWith("optimistic-")) return false
    return true
  }, [])

  // Stable shape forwarded to the in-place ChatInput inside
  // EditableUserMessage. Mirrors the props the bottom composer
  // receives below for selectedModel/onModelChange/isPro/upgrade —
  // see `<ChatInput ... />` near the end of this file — so changes
  // made inside an edit-in-progress bubble keep the global model
  // selection in sync with the resend.
  const messageEditComposerProps = useMemo(
    () => ({
      selectedModel,
      onModelChange: handleModelChange,
      isPro: hasAdvancedModelAccess,
      onUpgradeClick: handleUpgradeClick,
    }),
    [selectedModel, handleModelChange, hasAdvancedModelAccess, handleUpgradeClick],
  )

  const messageEditValue = useMemo(
    () => ({
      editMessage: handleEditMessage,
      retryFromMessage: handleRetryFromMessage,
      countMessagesAfter,
      isStreaming,
      canEditMessage,
      getPrecedingCheckpoint: handleGetPrecedingCheckpoint,
      composerProps: messageEditComposerProps,
    }),
    [
      handleEditMessage,
      handleRetryFromMessage,
      countMessagesAfter,
      isStreaming,
      canEditMessage,
      handleGetPrecedingCheckpoint,
      messageEditComposerProps,
    ],
  )

  const resolvedAgentUrl = localAgentUrl || (projectId ? `${API_URL}/api/projects/${projectId}/agent-proxy` : null)

  // Generate a stakeholder summary for a plan that doesn't have one yet.
  // Mutates the local pending/streaming plan as soon as the summary comes
  // back so the in-chat PlanCard switches to its Summary tab without
  // waiting for a panel refetch.
  const handleGenerateSummary = useCallback(
    async (filepath: string): Promise<string> => {
      if (!resolvedAgentUrl) {
        throw new Error("Agent URL is not available")
      }
      const filename = filepath.split("/").pop()
      if (!filename || !filename.endsWith(".plan.md")) {
        throw new Error("Invalid plan filepath")
      }
      const previousPlan = pendingPlanRef.current
      if (previousPlan?.filepath === `.shogo/plans/${filename}`) {
        const pendingNext = normalizePlanData({
          ...previousPlan,
          summaryStatus: "pending",
          summary: undefined,
        })
        pendingPlanRef.current = pendingNext
        setPendingPlan(pendingNext)
        planStream?.setSummaryStatus("pending")
      }
      try {
        const client = new AgentClient({
          baseUrl: resolvedAgentUrl.replace(/\/$/, ""),
          fetch: agentFetch,
        })
        const result = await client.summarizePlan(filename)
        const summary = result.summary
        const refreshed = pendingPlanRef.current
        if (refreshed?.filepath === `.shogo/plans/${filename}`) {
          const readyNext = normalizePlanData({
            ...refreshed,
            summary,
            summaryStatus: "ready",
          })
          pendingPlanRef.current = readyNext
          setPendingPlan(readyNext)
          planStream?.setStreamingPlan(readyNext)
        }
        planStream?.setStreamingSummary(summary)
        planStream?.setSummaryStatus("ready")
        planStream?.notifyPlanCreated()
        return summary
      } catch (err) {
        const refreshed = pendingPlanRef.current
        if (refreshed?.filepath === `.shogo/plans/${filename}`) {
          const errNext = normalizePlanData({
            ...refreshed,
            summaryStatus: "error",
          })
          pendingPlanRef.current = errNext
          setPendingPlan(errNext)
        }
        planStream?.setSummaryStatus("error")
        throw err
      }
    },
    [resolvedAgentUrl, planStream]
  )

  const handleSaveToolOutput = useCallback(
    (params: { messageId: string; toolCallId: string; output: string }) => {
      const { messageId, toolCallId, output } = params

      setMessages((prev) =>
        prev.map((msg) => {
          if (msg.id !== messageId) return msg
          const parts = (msg as any).parts as any[] | undefined
          if (!parts) return msg
          return {
            ...msg,
            parts: parts.map((p: any) => {
              if (
                p.type === "dynamic-tool" &&
                p.toolCallId === toolCallId
              ) {
                return { ...p, output, state: "output-available" }
              }
              return p
            }),
          }
        })
      )

      const dbMsg = sessionMessages?.all.find((m: any) => m.id === messageId)
      if (dbMsg?.parts && sessionMessages) {
        try {
          const parsed = JSON.parse(dbMsg.parts)
          const updated = parsed.map((p: any) => {
            if (
              p.type === "dynamic-tool" &&
              p.toolCallId === toolCallId
            ) {
              return { ...p, output, state: "output-available" }
            }
            return p
          })
          sessionMessages
            .update(messageId, { parts: JSON.stringify(updated) })
            .catch((err: any) =>
              console.error("[ChatPanel] Failed to persist ask_user output:", err)
            )
        } catch (err) {
          console.error("[ChatPanel] Failed to parse parts for ask_user persist:", err)
        }
      }
    },
    [setMessages, sessionMessages]
  )

  // Submit handler for the input-attached question widget. Mirrors the
  // inline ask_user handler: send the formatted response as a user message
  // and persist the tool output so the part flips to answered (which also
  // clears `pendingQuestion`, unmounting the attached widget).
  const handleSubmitQuestionResponse = useCallback(
    (response: string) => {
      if (!pendingQuestion) return
      handleSendMessage(response)
      handleSaveToolOutput({
        messageId: pendingQuestion.messageId,
        toolCallId: pendingQuestion.tool.id,
        output: response,
      })
    },
    [pendingQuestion, handleSendMessage, handleSaveToolOutput]
  )

  // Stable session summary so a new object literal isn't allocated each
  // render even when the underlying session id/name haven't changed.
  const sessionSummary = useMemo(
    () =>
      currentSession
        ? { id: currentSession.id, name: currentSession.name }
        : null,
    [currentSession?.id, currentSession?.name],
  )

  // Wrap the AI SDK's addToolOutput so we hand a stable reference to
  // context consumers — without this every render produced a fresh
  // `(params) => addToolOutput(params as any)` closure.
  const stableAddToolOutput = useCallback(
    (params: { toolCallId: string; output: string }) =>
      addToolOutput(params as any),
    [addToolOutput],
  )

  const errorMessage = error?.message ?? null

  // Memoizing the context value is the single biggest win for streaming
  // re-renders. Previously this was a fresh object literal on every
  // ChatPanel commit, so every `useChatContext()` consumer re-rendered
  // on every token even when nothing they read had actually changed.
  //
  // Note: `messages` is intentionally NOT plumbed through the context
  // (we hand a stable empty array). A grep across the codebase shows no
  // consumer reads `chatContext.messages` — they read `sendMessage`,
  // `agentUrl`, `saveToolOutput`, `pendingPlan` etc. which are stable.
  // Including the live message list flipped the value's identity per
  // token (because `useChat`'s `messages` array is a new reference every
  // delta), defeating every downstream memo. Components that genuinely
  // need the message list receive it as a prop instead.
  const contextValue = useMemo<ChatContextValue>(
    () => ({
      currentSession: sessionSummary,
      messages: EMPTY_CONTEXT_MESSAGES,
      sendMessage: handleSendMessage,
      isLoading: isStreaming,
      isPolling,
      error: errorMessage,
      agentUrl: resolvedAgentUrl,
      addToolOutput: stableAddToolOutput,
      saveToolOutput: handleSaveToolOutput,
      focusPendingQuestion: jumpToLatest,
      buildPlan: pendingPlan ? handleConfirmPlan : null,
      confirmPlan: pendingPlan ? handleConfirmPlan : null,
      pendingPlan,
      confirmedPlan,
      openPlan: onOpenPlan,
      generateSummary: handleGenerateSummary,
    }),
    [
      sessionSummary,
      handleSendMessage,
      isStreaming,
      isPolling,
      errorMessage,
      resolvedAgentUrl,
      stableAddToolOutput,
      handleSaveToolOutput,
      jumpToLatest,
      pendingPlan,
      handleConfirmPlan,
      confirmedPlan,
      onOpenPlan,
      handleGenerateSummary,
    ],
  )

  const handleCompactSubmit = useCallback(
    (prompt: string, files?: FileAttachment[]) => {
      onCompactSubmit?.(prompt, files)
    },
    [onCompactSubmit]
  )

  const handleQuickActionClick = useCallback(
    (prompt: string) => handleSendMessage(prompt),
    [handleSendMessage],
  )

  // Render compact mode (homepage)
  if (mode === "compact") {
    return (
      <CompactChatInput
        onSubmit={handleCompactSubmit}
        isLoading={isStreaming}
        disabled={false}
        value={compactValue}
        onChange={onCompactValueChange}
        className={className}
      />
    )
  }

  // Render collapsed state
  if (isCollapsed) {
    return (
      <View className={cn("flex-row flex-1", className)}>
        {children && (
          <TodoStateStoreContext.Provider value={todoStateStore}>
            <ChatContextProvider value={contextValue}>
              <View className="flex-1 min-w-0 overflow-hidden">{children}</View>
            </ChatContextProvider>
          </TodoStateStoreContext.Provider>
        )}
        <ExpandTab onExpand={handleToggleCollapse} />
      </View>
    )
  }

  return (
    <TodoStateStoreContext.Provider value={todoStateStore}>
    <ChatContextProvider value={contextValue}>
      {/* Hosts the destructive-confirmation modal for in-place message
          edit and "retry from here". Rendered once per ChatPanel and
          accepts requests pushed from any nested EditableUserMessage
          via the module-level subscriber in EditConfirmDialog.tsx. */}
      <EditConfirmDialogHost />
      <View className={cn("flex-row flex-1", className)}>
        {/* Main content area */}
        {children && (
          <View className="flex-1 min-w-0 overflow-hidden">{children}</View>
        )}

        {/* Chat Panel — full width on mobile (no resize handle) */}
        <KeyboardAvoidingView
          behavior={Platform.OS === "ios" ? "padding" : "height"}
          className="flex-1 flex-col bg-background"
          keyboardVerticalOffset={Platform.OS === "ios" ? 90 : 50}
        >
          {/* Messages with Turn Grouping */}
          <View className="flex-1">
          <ScrollView
            ref={scrollViewRef}
            className="flex-1"
            style={chatMessagesScrollStyles.scroll}
            contentContainerClassName={cn(
              isNativePhoneLayout ? "px-2 pt-2 pb-36" : "p-2 pb-[40px]",
              "max-w-3xl w-full self-center",
            )}
            keyboardShouldPersistTaps="handled"
            onScroll={isNative ? undefined : handleMessagesScrollWeb}
            onScrollBeginDrag={() => {
              if (isNative) {
                stickToBottomRef.current = false
                setIsFollowing(false)
              }
            }}
            onScrollEndDrag={(e) => {
              if (isNative) {
                syncStickFromNativeEvent(e)
                tryLoadOlderNearTopOnScrollEnd(e)
              }
            }}
            onMomentumScrollEnd={(e) => {
              if (isNative) {
                syncStickFromNativeEvent(e)
                tryLoadOlderNearTopOnScrollEnd(e)
              }
            }}
            onContentSizeChange={(_w, h) => {
              if (isLoadingOlderRef.current) {
                const delta = h - contentHeightBeforeLoadRef.current
                if (delta > 0 && contentHeightBeforeLoadRef.current > 0) {
                  markProgrammaticScroll()
                  scrollViewRef.current?.scrollTo({ y: delta, animated: false })
                }
                // Reset after a frame so the scroll offset takes effect
                // before onScroll can re-trigger loading
                requestAnimationFrame(() => {
                  isLoadingOlderRef.current = false
                })
              } else if (isNative && stickToBottomRef.current && contentHeightBeforeLoadRef.current > 0) {
                // Only follow real growth. The height springs inside
                // ThinkingWidget / CollapsibleToolGroup fire
                // onContentSizeChange continuously during their 500ms
                // re-target (and on widget close, the chat *contracts*).
                // Without this gate every spring frame queued a fresh
                // throttledScrollToEnd, which was the "the whole screen
                // scrolls" symptom that accompanied widgets animating
                // open/closed. AUTOSCROLL_MIN_DELTA_PX is set just
                // above sub-pixel jitter (≤3px) but well below a single
                // line of new text (~16-20px) or a fresh tool widget
                // appearing, so token streaming still follows.
                const delta = h - contentHeightBeforeLoadRef.current
                if (delta >= AUTOSCROLL_MIN_DELTA_PX) {
                  setTimeout(() => throttledScrollToEnd(), 200)
                }
              }
              contentHeightBeforeLoadRef.current = h
            }}
            scrollEventThrottle={32}
          >
            {sessionMessages?.hasMore && (
              <Pressable
                onPress={handleLoadOlderMessages}
                disabled={sessionMessages.isLoadingMore}
                className="py-2 items-center"
              >
                {sessionMessages.isLoadingMore ? (
                  <ActivityIndicator size="small" />
                ) : (
                  <Text className="text-sm text-primary">Load earlier messages</Text>
                )}
              </Pressable>
            )}
            {displayMessages.length > 0 ? (
              <MessageEditProvider {...messageEditValue}>
                <TurnList
                  messages={displayMessages}
                  isStreaming={isStreaming}
                  phase={phase}
                  activeSubagents={activeSubagentsList}
                  recentTools={recentToolsList}
                  subagentToolCalls={accumulatedSubagentTools}
                />
              </MessageEditProvider>
            ) : !isStreaming && !isInitialLoadComplete && currentSessionId ? (
              <View className="flex-col items-center justify-center flex-1 gap-3">
                <View className="flex-row items-center gap-1">
                  <View className="w-2 h-2 rounded-full bg-muted-foreground opacity-50" />
                  <View className="w-2 h-2 rounded-full bg-muted-foreground opacity-50" />
                  <View className="w-2 h-2 rounded-full bg-muted-foreground opacity-50" />
                </View>
                <Text className="text-xs text-muted-foreground">Loading conversation...</Text>
              </View>
            ) : !isStreaming ? (
              <PhaseEmptyState phase={phase} onSuggestionClick={handleSendMessage} quickActions={quickActions} />
            ) : (
              <View className="gap-3">
                {activeSubagents.size > 0 && (
                  <SubagentPanel
                    subagents={activeSubagentsList}
                    recentTools={recentToolsList}
                    defaultExpanded
                  />
                )}
                <View className="flex-row items-center gap-1 p-2">
                  <View className="w-2 h-2 rounded-full bg-muted-foreground opacity-50" />
                  <View className="w-2 h-2 rounded-full bg-muted-foreground opacity-50" />
                  <View className="w-2 h-2 rounded-full bg-muted-foreground opacity-50" />
                </View>
              </View>
            )}

          </ScrollView>

          {/* "Jump to latest" pill — shown when the user has scrolled away
              from the bottom during streaming. Re-engages follow on press.
              Positioned at the bottom of the scroll area (just above the
              chat input). */}
          {!isFollowing && displayMessages.length > 0 && (
            <View
              pointerEvents="box-none"
              style={{ position: "absolute", left: 0, right: 0, bottom: 8 }}
              className="items-center"
            >
              <Pressable
                onPress={jumpToLatest}
                accessibilityRole="button"
                accessibilityLabel="Jump to latest message"
                className="flex-row items-center gap-1 rounded-full bg-primary px-3 py-1.5 shadow-md active:opacity-80"
              >
                <ChevronDown size={14} className="text-primary-foreground" />
                <Text className="text-xs font-medium text-primary-foreground">
                  Latest
                </Text>
              </Pressable>
            </View>
          )}
          </View>

          {/* Tool Error Banner */}
          {toolErrorBanner && (
            <View className="px-4 pb-2">
              <View className={cn(
                "flex-row items-start gap-2 rounded-lg p-3",
                toolErrorBanner.isAuthError
                  ? "border border-orange-400/50 bg-orange-50 dark:bg-orange-900/20"
                  : "border border-yellow-400/50 bg-yellow-50 dark:bg-yellow-900/20",
              )}>
                <AlertCircle
                  className={cn(
                    "shrink-0 mt-0.5",
                    toolErrorBanner.isAuthError
                      ? "text-orange-600 dark:text-orange-400"
                      : "text-yellow-600 dark:text-yellow-400",
                  )}
                  size={16}
                />
                <View className="flex-1 gap-1.5">
                  <View className="flex-row items-center justify-between">
                    <Text className={cn(
                      "text-sm font-medium",
                      toolErrorBanner.isAuthError
                        ? "text-orange-800 dark:text-orange-200"
                        : "text-yellow-800 dark:text-yellow-200",
                    )}>
                      {toolErrorBanner.isAuthError
                        ? `${toolErrorBanner.toolkitName} Connection Expired`
                        : `${toolErrorBanner.toolkitName} Error`}
                    </Text>
                    <Pressable
                      onPress={() => setToolErrorBanner(null)}
                      className="p-1 -mr-1 -mt-1 rounded active:bg-black/10"
                      hitSlop={8}
                    >
                      <X size={14} className={cn(
                        toolErrorBanner.isAuthError
                          ? "text-orange-600 dark:text-orange-400"
                          : "text-yellow-600 dark:text-yellow-400",
                      )} />
                    </Pressable>
                  </View>
                  <Text className={cn(
                    "text-xs",
                    toolErrorBanner.isAuthError
                      ? "text-orange-700 dark:text-orange-300"
                      : "text-yellow-700 dark:text-yellow-300",
                  )}>
                    {toolErrorBanner.error}
                  </Text>
                  {toolErrorBanner.isAuthError && projectId && (
                    <Pressable
                      onPress={async () => {
                        const toolkit = toolErrorBanner.toolkitName.toLowerCase()
                        setReconnecting(true)

                        const preWindow = Platform.OS === 'web' ? preCreateAuthWindow() : null
                        console.info('[ChatPanel] Reconnecting', toolkit)

                        try {
                          const http = createHttpClient()
                          const isNative = Platform.OS !== 'web'
                          let redirect: string | undefined
                          if (isNative) {
                            redirect = ExpoLinking.createURL('integrations-callback')
                          } else {
                            // Web (desktop browser, mobile web, Electron):
                            // always pass our own URL so the OAuth callback
                            // returns here instead of OS-routing through a
                            // `shogo://` protocol handler. See
                            // ConnectToolWidget.tsx for the full rationale.
                            const returnUrl = new URL(window.location.href)
                            returnUrl.searchParams.set('fromOAuth', '1')
                            redirect = returnUrl.toString()
                          }

                          const callbackUrl = redirect
                            ? `${API_URL}/api/integrations/callback?redirect=${encodeURIComponent(redirect)}`
                            : `${API_URL}/api/integrations/callback`
                          const data = await api.connectIntegration(http, toolkit, projectId, callbackUrl)
                          const redirectUrl = data.data?.redirectUrl
                          if (redirectUrl) {
                            await openAuthFlow(redirectUrl, { preCreatedWindow: preWindow })
                            setToolErrorBanner(null)
                          }
                        } catch (err) {
                          console.error('[ChatPanel] Reconnect error:', err)
                          // Connection attempt failed — banner stays visible
                        } finally {
                          setReconnecting(false)
                          try {
                            if (preWindow && !preWindow.closed) {
                              const loc = preWindow.location.href
                              if (loc === 'about:blank' || loc === '') preWindow.close()
                            }
                          } catch { /* COOP */ }
                        }
                      }}
                      disabled={reconnecting}
                      className={cn(
                        "self-start flex-row items-center gap-1.5 rounded-md border border-orange-400/50 bg-orange-100 dark:bg-orange-800/30 px-1 py-1.5 active:opacity-70",
                        reconnecting && "opacity-50",
                      )}
                    >
                      {reconnecting ? (
                        <ActivityIndicator size="small" />
                      ) : (
                        <RefreshCw size={12} className="text-orange-700 dark:text-orange-300" />
                      )}
                      <Text className="text-xs font-medium text-orange-700 dark:text-orange-300">
                        Reconnect
                      </Text>
                    </Pressable>
                  )}
                </View>
              </View>
            </View>
          )}

          {/* Error Alert — cap long messages so the sidebar layout stays usable */}
          {(error || emptyResponseError) && !errorDismissed && (
            <View className="px-4 pb-2 max-w-3xl w-full self-center">
              <View className={`flex-row items-start gap-1.5 rounded-md border px-3 py-2 ${
                isTunnelError
                  ? 'border-orange-400/50 bg-orange-50 dark:bg-orange-950/30'
                  : 'border-destructive/50 bg-destructive/10'
              }`}>
                <AlertCircle className={`h-3.5 w-3.5 shrink-0 mt-0.5 ${
                  isTunnelError ? 'text-orange-600 dark:text-orange-400' : 'text-destructive'
                }`} size={14} />
                <View className="flex-1 min-w-0 flex-row items-start justify-between gap-1.5">
                  <View className="flex-1 min-w-0 pr-1">
                    {errorBannerExpanded ? (
                      <ScrollView
                        nestedScrollEnabled
                        className="max-h-40"
                        showsVerticalScrollIndicator
                      >
                        <Text className={`text-xs ${isTunnelError ? 'text-orange-700 dark:text-orange-300' : 'text-destructive'}`} selectable>
                          {errorBannerText}
                        </Text>
                      </ScrollView>
                    ) : (
                      <Text
                        className={`text-xs ${isTunnelError ? 'text-orange-700 dark:text-orange-300' : 'text-destructive'}`}
                        numberOfLines={2}
                        selectable
                      >
                        {errorBannerText}
                      </Text>
                    )}
                    {errorBannerNeedsReadMore && (
                      <Pressable
                        onPress={() => setErrorBannerExpanded((e) => !e)}
                        className="mt-1 self-start py-0.5"
                        role="button"
                        accessibilityLabel={
                          errorBannerExpanded ? 'Show less error detail' : 'Read full error message'
                        }
                      >
                        <Text className={`text-[11px] font-semibold ${isTunnelError ? 'text-orange-700 dark:text-orange-300' : 'text-destructive'}`}>
                          {errorBannerExpanded ? 'Show less' : 'Read more'}
                        </Text>
                      </Pressable>
                    )}
                  </View>
                  {tunnelReconnecting ? (
                    <View className="shrink-0 rounded-md border border-orange-400/30 px-2 py-1 self-start">
                      <Text className="text-xs text-orange-600 dark:text-orange-400 font-medium">Reconnecting…</Text>
                    </View>
                  ) : (
                    <View className="shrink-0 flex-row items-center gap-1 self-start">
                      {isTunnelError && (
                        <Pressable
                          onPress={() => {
                            clearActiveInstance()
                            // Defer so the context update flushes and localAgentUrl
                            // becomes null before the retry fires — otherwise the
                            // retry would still hit the (now-offline) tunnel URL.
                            setTimeout(() => handleRetry(), 0)
                          }}
                          accessibilityRole="button"
                          accessibilityLabel="Continue this conversation in the cloud sandbox"
                          className="rounded-md border border-orange-400/30 px-2 py-1"
                        >
                          <Text className="text-xs font-medium text-orange-700 dark:text-orange-300">Continue in cloud</Text>
                        </Pressable>
                      )}
                      <Pressable
                        onPress={handleRetry}
                        className={`rounded-md border px-2 py-1 ${
                          isTunnelError
                            ? 'border-orange-400/30'
                            : 'border-destructive/30'
                        }`}
                      >
                        <Text className={`text-xs font-medium ${
                          isTunnelError ? 'text-orange-600 dark:text-orange-400' : 'text-destructive'
                        }`}>{isTunnelError ? 'Reconnect' : 'Retry'}</Text>
                      </Pressable>
                      <Pressable
                        onPress={() => {
                          setEmptyResponseError(null)
                          setErrorDismissed(true)
                        }}
                        accessibilityRole="button"
                        accessibilityLabel="Dismiss error"
                        hitSlop={8}
                        className="rounded-md p-1"
                      >
                        <X size={14} className={isTunnelError ? 'text-orange-600 dark:text-orange-400' : 'text-destructive'} />
                      </Pressable>
                    </View>
                  )}
                </View>
              </View>
            </View>
          )}

          {/* Permission Approval Dialog (Local Mode Security) */}
          {pendingPermissionRequest && (
            <PermissionApprovalDialog
              request={pendingPermissionRequest}
              onRespond={async (response) => {
                setPendingPermissionRequest(null)
                try {
                  if (projectId) {
                    const http = createHttpClient()
                    await api.sendPermissionResponse(http, projectId, response)
                  }
                } catch (err) {
                  console.error('[ChatPanel] Failed to send permission response:', err)
                }
              }}
            />
          )}

          {/* Input */}
          <View className="bg-transparent max-w-3xl w-full self-center mt-1">
            <ExecutionBadge />
            <ChatInput
              onSubmit={handleInputSubmit}
              disabled={!currentSessionId}
              placeholder={
                !featureId
                  ? "Select a feature to start chatting..."
                  : hasPendingQuestion
                    ? "Respond to the question below, or type a message..."
                    : interactionMode === "plan"
                      ? "Describe what you want to plan..."
                      : interactionMode === "ask"
                        ? "Ask a question..."
                        : "Ask Shogo..."
              }
              isStreaming={isStreaming}
              onStop={handleStop}
              selectedModel={selectedModel}
              onModelChange={handleModelChange}
              isPro={hasAdvancedModelAccess}
              onUpgradeClick={handleUpgradeClick}
              pendingQuestion={pendingQuestion}
              onSubmitQuestionResponse={handleSubmitQuestionResponse}
              queuedMessages={messageQueue}
              onRemoveQueuedMessage={handleRemoveQueuedMessage}
              onReorderQueuedMessage={handleReorderQueuedMessage}
              onEditQueuedMessage={handleEditQueuedMessage}
              onSendQueuedMessageNow={handleSendQueuedMessageNow}
              interactionMode={interactionMode}
              onInteractionModeChange={handleInteractionModeChange}
              dualPlan={dualPlan}
              onDualPlanChange={handleDualPlanChange}
              contextUsage={contextUsage}
              quickActions={quickActions}
              onQuickActionClick={handleQuickActionClick}
              restoreDraftRequest={restoreDraftRequest}
            />
          </View>
        </KeyboardAvoidingView>
      </View>
    </ChatContextProvider>
    </TodoStateStoreContext.Provider>
  )
})
