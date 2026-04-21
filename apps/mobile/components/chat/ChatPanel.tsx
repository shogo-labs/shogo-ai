// SPDX-License-Identifier: AGPL-3.0-or-later
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
import {
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
import { useChatTransportConfig } from "@shogo/shared-app/chat"
import { useSDKDomains, useDomainActions, useChatMessageCollectionForSession } from "@shogo/shared-app/domain"
import { decideMessagesPropagation } from "./messages-propagation"
import { cn } from "@shogo/shared-ui/primitives"
import { API_URL, api, createHttpClient } from "../../lib/api"

import { isNativePhoneIntegrationsLayout } from "../../lib/native-phone-layout"
import { authClient } from "../../lib/auth-client"
import { ChatHeader } from "./ChatHeader"
import { MessageList } from "./MessageList"
import {
  ChatInput,
  DEFAULT_MODEL_PRO,
  DEFAULT_MODEL_FREE,
  type InteractionMode,
  type FileAttachment,
} from "./ChatInput"
import {
  loadInteractionModePreference,
  saveInteractionModePreference,
} from "../../lib/interaction-mode-preference"
import {
  loadModelPreference,
  saveModelPreference,
} from "../../lib/agent-mode-preference"
import { CompactChatInput } from "./CompactChatInput"
import { ExpandTab } from "./ExpandTab"
import { ToolCallDisplay, type ToolCallState } from "./ToolCallDisplay"
import { ChatContextProvider, type ChatContextValue } from "./ChatContext"
import { TurnList } from "./turns"
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
import { AlertCircle, RefreshCw, X } from "lucide-react-native"
import { type PlanData } from "./PlanCard"
import { usePlanStreamSafe } from "./PlanStreamContext"
import { openAuthFlow, preCreateAuthWindow, isMobileWeb } from "@shogo/ui-kit/platform"
import { PermissionApprovalDialog } from "../security/PermissionApprovalDialog"
import { buildStopRequest } from "../../lib/chat-stop"
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
  /** Called with canvas preview components streamed through the chat channel */
  onCanvasPreview?: (surfaceId: string, components: any[]) => void
  /** Legacy domain stores (platformFeatures, componentBuilder) — optional on mobile */
  legacyDomains?: {
    platformFeatures?: any
    componentBuilder?: any
  }
  /** Billing data — optional on mobile; if not provided, defaults to basic mode */
  billingData?: {
    hasActiveSubscription: boolean
    hasAdvancedModelAccess?: boolean
    refetchCreditLedger: () => void
  }
  /** Called whenever the streaming messages array changes (for TerminalPanel etc.) */
  onMessagesChange?: (messages: any[]) => void
  /** Triggered from the Plans panel Build button — executes a saved plan */
  buildPlanRequest?: { plan: PlanData; modelId: string; nonce: number } | null
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
  onCanvasPreview,
  legacyDomains,
  billingData,
  onMessagesChange,
  buildPlanRequest,
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
  const refetchCreditLedger = billingData?.refetchCreditLedger ?? (() => {})

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
  const MESSAGE_PAGE_SIZE = 10
  const isNative = Platform.OS !== "web"
  const STICK_BOTTOM_PX = 16
  const pendingScrollRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastScrollTimeRef = useRef(0)
  const SCROLL_THROTTLE_MS = 300

  const shouldFollowBottom = useCallback(
    () => (isNative ? stickToBottomRef.current : isUserAtBottomRef.current),
    [isNative]
  )

  const scrollToBottomIfFollowing = useCallback(
    (animated = false) => {
      if (shouldFollowBottom()) {
        scrollViewRef.current?.scrollToEnd({ animated })
      }
    },
    [shouldFollowBottom]
  )

  const throttledScrollToEnd = useCallback(() => {
    const now = Date.now()
    const elapsed = now - lastScrollTimeRef.current
    if (elapsed >= SCROLL_THROTTLE_MS) {
      scrollViewRef.current?.scrollToEnd({ animated: true })
      lastScrollTimeRef.current = now
    } else if (!pendingScrollRef.current) {
      pendingScrollRef.current = setTimeout(() => {
        scrollViewRef.current?.scrollToEnd({ animated: true })
        lastScrollTimeRef.current = Date.now()
        pendingScrollRef.current = null
      }, SCROLL_THROTTLE_MS - elapsed)
    }
  }, [])

  const syncStickFromNativeEvent = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      if (!isNative) return
      const { layoutMeasurement, contentOffset, contentSize } = e.nativeEvent
      const fromBottom =
        contentSize.height - contentOffset.y - layoutMeasurement.height
      stickToBottomRef.current = fromBottom <= STICK_BOTTOM_PX
    },
    [isNative]
  )

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

  const [confirmedPlan, setConfirmedPlan] = useState<PlanData | null>(null)
  const confirmedPlanRef = useRef<PlanData | null>(null)
  const [pendingPlan, setPendingPlan] = useState<PlanData | null>(null)

  const planStream = usePlanStreamSafe()

  // Load session metadata from API if not already cached
  useEffect(() => {
    if (chatSessionId && !studioChat.chatSessionCollection.get(chatSessionId)) {
      console.log("[ChatPanel] Loading session from API:", chatSessionId)
      studioChat.chatSessionCollection
        .loadAll({ id: chatSessionId })
        .catch((err: any) => console.warn("[ChatPanel] Failed to load session:", err))
    }
  }, [chatSessionId, studioChat])

  const currentSession = currentSessionId
    ? studioChat.chatSessionCollection.get(currentSessionId)
    : null

  // Per-session MST collection: isolated from sibling ChatPanels. Reads never
  // flip to 0 because another session's `loadPage` clobbered the singleton.
  const sessionMessages = useChatMessageCollectionForSession(currentSessionId)

  // Fix D small win: memoize the sorted persisted messages so we don't create
  // a new array on every ChatPanel render. Without this, any consumer that
  // depends on the array identity (Effect 2 etc.) would see a fresh ref every
  // render even when the underlying MobX collection didn't change.
  // Keyed on length since MobX's observable array triggers re-read on mutation.
  const persistedMessagesFromMobX = useMemo(
    () =>
      sessionMessages
        ? [...sessionMessages.all].sort(
            (a: any, b: any) => (a.createdAt || 0) - (b.createdAt || 0),
          )
        : [],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sessionMessages, sessionMessages?.all.length],
  )

  // Loading state for Effect 1. Kept as *both* a ref (for synchronous reads
  // elsewhere) AND state (so changes to it can retrigger Effect 1 via deps,
  // which is what unsticks the "skip: already loading" wedge when a prior
  // fetch was stalled behind a streaming SSE request).
  const [isLoadingMessages, setIsLoadingMessages] = useState(false)
  const isLoadingMessagesRef = useRef(false)
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

  type QueuedMessage = {
    id: string
    content: string
    files?: FileAttachment[]
    selectedModel?: string
  }
  const [messageQueue, setMessageQueue] = useState<QueuedMessage[]>([])
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



  const transportConfig = useChatTransportConfig({
    apiBaseUrl: API_URL!,
    projectId,
    localAgentUrl,
    credentials: Platform.OS === 'web' ? 'include' : 'omit',
    headers: nativeHeaders,
    fetch: expoFetch,
  })
  const chatTransport = useMemo(
    () => (transportConfig ? new DefaultChatTransport(transportConfig) : undefined),
    [transportConfig]
  )

  // AI SDK useChat hook
  const { messages, sendMessage, addToolOutput, status, error, setMessages, stop } = useChat({
    transport: chatTransport,
    id: currentSessionId || undefined,
    resume: isInitialLoadComplete,
    experimental_throttle: 50,
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

      if (dataPart.type === "data-canvas-preview") {
        const { surfaceId, components } = (dataPart as any).data
        onCanvasPreview?.(surfaceId, components)
      }

      if ((dataPart as any).type === "data-plan") {
        const planData = (dataPart as any).data
        if (planData) {
          setPendingPlan(planData)
          if (planData.filepath) {
            planStream?.setStreamingPlanFilepath(planData.filepath)
          }
          planStream?.notifyPlanCreated()
        }
      }

      if ((dataPart as any).type === "data-plan-update") {
        planStream?.notifyPlanCreated()
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
    onFinish: async ({ message }) => {
      const contentLength = (message as any).content?.length ?? message.parts?.length ?? 0

      const hasTextContent = message.parts?.some(
        (p: any) => p.type === "text" && p.text?.trim()
      )
      const hasToolCallsInMessage = message.parts?.some(
        (p: any) => p.type === "tool-invocation" || p.type === "tool-result"
      )
      if (!hasTextContent && !hasToolCallsInMessage && contentLength === 0) {
        console.warn("[ChatPanel] Agent returned empty response — possible context corruption")
        setEmptyResponseError("The agent returned an empty response. Try starting a new chat session.")
      } else {
        setEmptyResponseError(null)
      }

      if (currentSessionId) {
        refetchCreditLedger()

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
            api.generateProjectName(http, userText, workspaceId).then(({ name }) => {
              if (name) {
                actions.updateChatSession(currentSessionId, { inferredName: name })
              }
            }).catch(() => {})
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
  const [tunnelReconnecting, setTunnelReconnecting] = useState(false)

  const isRemoteInstance = !!localAgentUrl
  const isTunnelError = !!(error && isRemoteInstance && isTunnelDisconnectError(error.message))

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
    errorBannerText.split(/\n/).length > 4 || errorBannerText.length > 220

  const [pendingInitialMessage, setPendingInitialMessage] = useState<string | null>(null)

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

  const displayMessages = useMemo((): UIMessage[] => {
    const effectiveMessages = stoppedMessages ?? messages
    if (effectiveMessages.length > 0) {
      return effectiveMessages
    }

    if (isStreaming || isSendingMessageRef.current) {
      // While streaming/sending, show the last known messages (plus an optimistic
      // user bubble) so the conversation doesn't vanish during the brief gap
      // before the AI SDK populates its internal state.
      const fallback = lastNonEmptyMessagesRef.current
      const lastInput = lastUserInputRef.current
      const lastFallbackMsg = fallback[fallback.length - 1]
      const needsOptimisticUser =
        lastInput?.content && (!lastFallbackMsg || lastFallbackMsg.role !== "user")

      if (needsOptimisticUser) {
        return [
          ...fallback,
          {
            id: "optimistic-user-pending",
            role: "user",
            parts: [{ type: "text", text: lastInput!.content }],
          } as unknown as UIMessage,
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
  }, [messages, stoppedMessages, pendingInitialMessage, initialMessage, isStreaming])

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

  const handleStop = useCallback(() => {
    setStoppedMessages([...messagesRef.current])
    stop()

    const req = buildStopRequest({
      localAgentUrl,
      projectId,
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
  }, [stop, projectId, localAgentUrl, expoFetch, currentSessionId])

  // Idle timeout to force-complete hung streams
  const idleTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastMessageContentRef = useRef<string>("")
  const IDLE_TIMEOUT_MS = 600_000

  useEffect(() => {
    const currentContent = messages
      .map((m) => (m as any).content || m.parts?.map((p: any) => p.text || "").join(""))
      .join("")

    if (isStreaming) {
      if (idleTimeoutRef.current) {
        clearTimeout(idleTimeoutRef.current)
      }

      if (currentContent !== lastMessageContentRef.current) {
        lastMessageContentRef.current = currentContent
      }

      idleTimeoutRef.current = setTimeout(() => {
        if (isStreaming) {
          console.warn("[ChatPanel] Stream idle timeout - forcing stop()")
          handleStop()
        }
      }, IDLE_TIMEOUT_MS)
    } else {
      if (idleTimeoutRef.current) {
        clearTimeout(idleTimeoutRef.current)
        idleTimeoutRef.current = null
      }
      lastMessageContentRef.current = ""
    }

    return () => {
      if (idleTimeoutRef.current) {
        clearTimeout(idleTimeoutRef.current)
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
      if (hasCached && messagesRef.current !== cachedMessagesRef.current) {
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
    const refreshedAt = cacheRefreshedAtRef.current.get(currentSessionId) ?? 0
    const cacheAgeMs = performance.now() - refreshedAt
    if (hasCached && cacheAgeMs < 5000) {
      if (messagesRef.current !== cachedMessagesRef.current) {
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

    sessionMessages
      .loadPage(
        { sessionId: currentSessionId },
        { limit: MESSAGE_PAGE_SIZE, offset: 0 },
      )
      .then((_result: any) => {
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
          sessionMessageCache.set(currentSessionId, aiMessages)
          setMessages(aiMessages)
        } else {
          // Same shape as cache — still refresh the module cache entry so any
          // later in-flight mutations (status flips, etc.) don't drift.
          sessionMessageCache.set(currentSessionId, aiMessages)
        }
        cacheRefreshedAtRef.current.set(currentSessionId, performance.now())
      })
      .catch((err: any) => console.error("[ChatPanel] Failed to load messages:", err))
      .finally(() => {
        isLoadingMessagesRef.current = false
        setIsLoadingMessages(false)
        setIsInitialLoadComplete(true)
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
        { sessionId: currentSessionId },
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
      const { layoutMeasurement, contentOffset, contentSize } = e.nativeEvent
      const isAtBottom =
        contentSize.height - contentOffset.y - layoutMeasurement.height <
        SCROLL_NEAR_BOTTOM_PX
      isUserAtBottomRef.current = isAtBottom

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

  const hasReceivedPartsRef = useRef(false)

  useEffect(() => {
    const hasParts = messages.some(
      (msg: any) => Array.isArray(msg.parts) && msg.parts.length > 0
    )
    if (hasParts) {
      hasReceivedPartsRef.current = true
    }
  }, [messages])

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
    setPendingPlan({
      name: args.name ?? "Plan",
      overview: args.overview ?? "",
      plan: args.plan ?? "",
      todos: args.todos ?? [],
      filepath: args.filepath,
    })
  }, [isInitialLoadComplete, messages.length]) // eslint-disable-line react-hooks/exhaustive-deps

  // Effect 2: Sync MobX → AI SDK state when data arrives.
  // This is a fallback for when messages appear in MobX before Effect 1 finishes,
  // e.g. from a real-time sync. It must NOT race with Effect 1's load cycle.
  useEffect(() => {
    if (persistedMessagesFromMobX.length > 0) {
      if (isStreamingRef.current) return
      if (isSendingMessageRef.current) return
      if (messages.length > 0) return

      const persistedHaveParts = persistedMessagesFromMobX.some((msg: any) => msg.parts)
      if (hasReceivedPartsRef.current && !persistedHaveParts) return
      if (persistedHaveParts) {
        hasReceivedPartsRef.current = false
      }

      const aiMessages = persistedMessagesFromMobX.map((msg: any) => {
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
      if (currentSessionId) {
        sessionMessageCache.set(currentSessionId, aiMessages as UIMessage[])
      }
      setMessages(aiMessages)
    } else if (currentSessionId) {
      if (initialMessageRef.current?.trim()) return
      // Don't clear messages while Effect 1 is still loading — that would
      // cause a flicker (messages → empty → loading → messages).
      if (isLoadingMessagesRef.current) return
      // The MobX collection is shared across ChatPanel instances and only holds
      // one session's messages at a time. When a sibling panel loads its session,
      // our filtered view drops to 0 even though our AI SDK state is still valid.
      // Never clobber non-empty AI SDK state from the MobX-empty signal.
      if (messages.length > 0) return
      setMessages([])
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentSessionId, persistedMessagesFromMobX.length, setMessages])

  useEffect(() => {
    onStreamingChange?.(isStreaming)
  }, [isStreaming, onStreamingChange])

  // Only the active panel (the one feeding onMessagesChange) drives the shared plan-stream context.
  // Background panels must not fight over setIsPlanStreaming.
  const isActivePanel = onMessagesChange != null
  useEffect(() => {
    if (!isActivePanel) return
    planStream?.setIsPlanStreaming(isStreaming && interactionMode === "plan")
  }, [isStreaming, interactionMode, planStream, isActivePanel])

  const derivedStreamingPlan = useMemo<PlanData | null>(() => {
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
    return {
      name: args.name,
      overview: args.overview ?? "",
      plan: args.plan ?? "",
      todos: args.todos ?? [],
    }
  }, [isStreaming, messages])

  useEffect(() => {
    planStream?.setStreamingPlan(derivedStreamingPlan)
    if (derivedStreamingPlan) {
      planStream?.setStreamingPlanFilepath(null)
    }
  }, [derivedStreamingPlan, planStream])

  // Auto-scroll to bottom when messages change
  // On native, streaming follow is handled entirely by onContentSizeChange
  // so this effect only fires for discrete events (new message added, first load).
  // On web, messages ref changes are still used for follow (existing behaviour).
  const isFirstLoadRef = useRef(true)

  useEffect(() => {
    isFirstLoadRef.current = true
    isUserAtBottomRef.current = true
    stickToBottomRef.current = true
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
  }, [displayMessages.length, messages, currentSessionId, isNative, shouldFollowBottom, scrollToBottomIfFollowing])

  // Detect a pending ask_user tool call in the last assistant message
  const hasPendingQuestion = useMemo(() => {
    const lastMsg = messages[messages.length - 1]
    if (!lastMsg || lastMsg.role !== "assistant") return false
    const parts = (lastMsg as any).parts as any[] | undefined
    if (!parts) return false
    return parts.some(
      (p: any) =>
        p.type === "dynamic-tool" &&
        p.toolName === "ask_user" &&
        (p.state === "input-available" || p.state === "input-streaming")
    )
  }, [messages])

  const extractMediaType = useCallback((dataUrl: string): string => {
    const match = dataUrl.match(/^data:([^;]+);/)
    return match?.[1] || "image/png"
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

      const fileArray = files || []

      if (!content.trim() && fileArray.length === 0) {
        return
      }

      const trimmedContent = content.trim()
      if (Platform.OS !== "web") {
        stickToBottomRef.current = true
      }
      lastUserInputRef.current = { content: trimmedContent, files: fileArray }

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

      actions
        .addMessage({
          sessionId: currentSessionId,
          role: "user",
          content: trimmedContent,
          imageData: fileArray.length > 0 ? fileArray[0].dataUrl : undefined,
          parts: parts.length > 0 ? JSON.stringify(parts) : undefined,
        })
        .catch((err) => console.warn("[ChatPanel] Failed to persist user message:", err))

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
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        }
        const planToSend = confirmedPlanRef.current
        if (planToSend) {
          bodyExtra.confirmedPlan = planToSend
          confirmedPlanRef.current = null
          setConfirmedPlan(null)
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

  useEffect(() => {
    if (messageQueue.length > 0) {
      setMessageQueue([])
      isProcessingQueueRef.current = false
    }
    lastNonEmptyMessagesRef.current = []
  }, [currentSessionId])

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
  const handleConfirmPlan = useCallback(() => {
    if (!pendingPlan) return
    confirmedPlanRef.current = pendingPlan
    setConfirmedPlan(pendingPlan)
    setPendingPlan(null)
    console.log("[ChatPanel][confirm-plan] BEFORE mode change — stateMode:", interactionMode, "refMode:", interactionModeRef.current, "selectedModel:", selectedModel)
    handleInteractionModeChange("agent")
    console.log("[ChatPanel][confirm-plan] AFTER mode change — refMode:", interactionModeRef.current, "(state will update on next render)")
    handleSendMessage("Execute the confirmed plan.")
    if (confirmDismissTimerRef.current) clearTimeout(confirmDismissTimerRef.current)
    confirmDismissTimerRef.current = setTimeout(() => {
      setConfirmedPlan(null)
    }, 4000)
  }, [pendingPlan, handleSendMessage, handleInteractionModeChange])

  // Build from Plans panel: execute a saved plan with selected model
  const lastBuildNonceRef = useRef<number>(0)
  useEffect(() => {
    if (!buildPlanRequest || buildPlanRequest.nonce === lastBuildNonceRef.current) return
    lastBuildNonceRef.current = buildPlanRequest.nonce
    const { plan, modelId: requestedMode } = buildPlanRequest
    confirmedPlanRef.current = plan
    setConfirmedPlan(plan)
    setPendingPlan(null)
    handleInteractionModeChange("agent")
    handleSendMessage("Execute the confirmed plan.", undefined, requestedMode)
    if (confirmDismissTimerRef.current) clearTimeout(confirmDismissTimerRef.current)
    confirmDismissTimerRef.current = setTimeout(() => {
      setConfirmedPlan(null)
    }, 4000)
  }, [buildPlanRequest, handleInteractionModeChange, handleSendMessage])

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

  const messageListMessages = messages.map((msg) => ({
    id: msg.id,
    role: msg.role as "user" | "assistant",
    content:
      (msg as any).content ||
      msg.parts?.map((p: any) => p.text || "").join("") ||
      "",
  }))

  const resolvedAgentUrl = localAgentUrl || (projectId ? `${API_URL}/api/projects/${projectId}/agent-proxy` : null)

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

  const contextValue: ChatContextValue = {
    currentSession: currentSession
      ? { id: currentSession.id, name: currentSession.name }
      : null,
    messages: messageListMessages,
    sendMessage: handleSendMessage,
    isLoading: isStreaming,
    isPolling,
    error: error?.message ?? null,
    agentUrl: resolvedAgentUrl,
    addToolOutput: (params) => addToolOutput(params as any),
    saveToolOutput: handleSaveToolOutput,
    confirmPlan: pendingPlan ? handleConfirmPlan : null,
  }

  const handleCompactSubmit = useCallback(
    (prompt: string, files?: FileAttachment[]) => {
      onCompactSubmit?.(prompt, files)
    },
    [onCompactSubmit]
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
          <ChatContextProvider value={contextValue}>
            <View className="flex-1 min-w-0 overflow-hidden">{children}</View>
          </ChatContextProvider>
        )}
        <ExpandTab onExpand={handleToggleCollapse} />
      </View>
    )
  }

  return (
    <ChatContextProvider value={contextValue}>
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
                  scrollViewRef.current?.scrollTo({ y: delta, animated: false })
                }
                // Reset after a frame so the scroll offset takes effect
                // before onScroll can re-trigger loading
                requestAnimationFrame(() => {
                  isLoadingOlderRef.current = false
                })
              } else if (isNative && stickToBottomRef.current && contentHeightBeforeLoadRef.current > 0) {
                setTimeout(() => throttledScrollToEnd(), 200)
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
              <TurnList
                messages={displayMessages}
                isStreaming={isStreaming}
                phase={phase}
                activeSubagents={activeSubagentsList}
                recentTools={recentToolsList}
                subagentToolCalls={accumulatedSubagentTools}
              />
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
                          } else if (isMobileWeb()) {
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
          {(error || emptyResponseError) && (
            <View className="px-4 pb-2 max-w-3xl w-full self-center">
              <View className={`flex-row items-start gap-2 rounded-lg border p-3 ${
                isTunnelError
                  ? 'border-orange-400/50 bg-orange-50 dark:bg-orange-950/30'
                  : 'border-destructive/50 bg-destructive/10'
              }`}>
                <AlertCircle className={`h-4 w-4 shrink-0 mt-0.5 ${
                  isTunnelError ? 'text-orange-600 dark:text-orange-400' : 'text-destructive'
                }`} size={16} />
                <View className="flex-1 min-w-0 flex-row items-start justify-between gap-2">
                  <View className="flex-1 min-w-0 pr-1">
                    {errorBannerExpanded ? (
                      <ScrollView
                        nestedScrollEnabled
                        className="max-h-48"
                        showsVerticalScrollIndicator
                      >
                        <Text className={`text-sm ${isTunnelError ? 'text-orange-700 dark:text-orange-300' : 'text-destructive'}`} selectable>
                          {errorBannerText}
                        </Text>
                      </ScrollView>
                    ) : (
                      <Text
                        className={`text-sm ${isTunnelError ? 'text-orange-700 dark:text-orange-300' : 'text-destructive'}`}
                        numberOfLines={4}
                        selectable
                      >
                        {errorBannerText}
                      </Text>
                    )}
                    {errorBannerNeedsReadMore && (
                      <Pressable
                        onPress={() => setErrorBannerExpanded((e) => !e)}
                        className="mt-1.5 self-start py-0.5"
                        role="button"
                        accessibilityLabel={
                          errorBannerExpanded ? 'Show less error detail' : 'Read full error message'
                        }
                      >
                        <Text className={`text-xs font-semibold ${isTunnelError ? 'text-orange-700 dark:text-orange-300' : 'text-destructive'}`}>
                          {errorBannerExpanded ? 'Show less' : 'Read more'}
                        </Text>
                      </Pressable>
                    )}
                  </View>
                  {tunnelReconnecting ? (
                    <View className="shrink-0 rounded-md border border-orange-400/30 px-2 py-1.5 self-start">
                      <Text className="text-sm text-orange-600 dark:text-orange-400 font-medium">Reconnecting…</Text>
                    </View>
                  ) : (
                    <Pressable
                      onPress={handleRetry}
                      className={`shrink-0 rounded-md border px-1 py-1.5 self-start ${
                        isTunnelError
                          ? 'border-orange-400/30'
                          : 'border-destructive/30'
                      }`}
                    >
                      <Text className={`text-sm font-medium ${
                        isTunnelError ? 'text-orange-600 dark:text-orange-400' : 'text-destructive'
                      }`}>{isTunnelError ? 'Reconnect' : 'Retry'}</Text>
                    </Pressable>
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
            <ChatInput
              onSubmit={handleInputSubmit}
              disabled={!currentSessionId}
              placeholder={
                !featureId
                  ? "Select a feature to start chatting..."
                  : hasPendingQuestion
                    ? "Respond to the question above, or type a message..."
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
              queuedMessages={messageQueue}
              onRemoveQueuedMessage={handleRemoveQueuedMessage}
              onReorderQueuedMessage={handleReorderQueuedMessage}
              interactionMode={interactionMode}
              onInteractionModeChange={handleInteractionModeChange}
              contextUsage={contextUsage}
              quickActions={quickActions}
              onQuickActionClick={(prompt) => handleSendMessage(prompt)}
            />
          </View>
        </KeyboardAvoidingView>
      </View>
    </ChatContextProvider>
  )
})
