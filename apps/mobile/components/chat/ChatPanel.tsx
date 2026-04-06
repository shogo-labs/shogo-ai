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
  formatToolName,
  getToolCategory,
  ERROR_CODE_MESSAGES,
} from "@shogo/shared-app/chat"
import { useChatTransportConfig } from "@shogo/shared-app/chat"
import { useSDKDomains, useDomainActions } from "@shogo/shared-app/domain"
import { cn } from "@shogo/shared-ui/primitives"
import { API_URL, api, createHttpClient } from "../../lib/api"
import { agentFetch } from "../../lib/agent-fetch"
import { isNativePhoneIntegrationsLayout } from "../../lib/native-phone-layout"
import { authClient } from "../../lib/auth-client"
import { ChatHeader } from "./ChatHeader"
import { MessageList } from "./MessageList"
import {
  ChatInput,
  type AgentMode,
  type InteractionMode,
  type FileAttachment,
} from "./ChatInput"
import {
  loadInteractionModePreference,
  saveInteractionModePreference,
} from "../../lib/interaction-mode-preference"
import {
  loadAgentModePreference,
  saveAgentModePreference,
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
import { openAuthFlow, preCreateAuthWindow, isMobileWeb } from "@shogo/ui-kit/platform"
import { PermissionApprovalDialog } from "../security/PermissionApprovalDialog"
import { buildStopRequest } from "../../lib/chat-stop"


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
  buildPlanRequest?: { plan: PlanData; agentMode: AgentMode; nonce: number } | null
  /** Called when a new plan is created (so the Plans panel can refresh) */
  onPlanCreated?: () => void
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
  onPlanCreated,
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

  // Quick actions state
  const [quickActions, setQuickActions] = useState<{ label: string; prompt: string }[]>([])

  const fetchQuickActions = useCallback(async () => {
    const url = localAgentUrl || (projectId ? `${API_URL}/api/projects/${projectId}/agent-proxy` : null)
    if (!url) return
    try {
      const res = await agentFetch(`${url}/agent/quick-actions`)
      if (res.ok) {
        const data = await res.json()
        if (Array.isArray(data?.actions)) {
          setQuickActions(data.actions)
        }
      }
    } catch {
      // Silently ignore — quick actions are non-critical
    }
  }, [localAgentUrl, projectId])

  useEffect(() => {
    fetchQuickActions()

    // Retry after a delay — the agent runtime may not be ready on first mount
    const retryTimer = setTimeout(() => fetchQuickActions(), 3000)
    return () => clearTimeout(retryTimer)
  }, [fetchQuickActions, chatSessionId])

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
    }
  }, [])

  // Chat session state
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(chatSessionId ?? null)
  const [isInitialLoadComplete, setIsInitialLoadComplete] = useState(false)
  const [agentMode, setAgentMode] = useState<AgentMode>("basic")

  useEffect(() => {
    loadAgentModePreference().then((stored) => {
      if (stored) {
        setAgentMode(stored)
      } else if (hasAdvancedModelAccess) {
        setAgentMode("advanced")
      }
    })
  }, [hasAdvancedModelAccess])

  const handleAgentModeChange = useCallback((mode: AgentMode) => {
    setAgentMode(mode)
    saveAgentModePreference(mode)
  }, [])

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

  const handleInteractionModeChange = useCallback((mode: InteractionMode) => {
    setInteractionMode(mode)
    void saveInteractionModePreference(mode)
  }, [])

  const [confirmedPlan, setConfirmedPlan] = useState<PlanData | null>(null)
  const confirmedPlanRef = useRef<PlanData | null>(null)
  const [pendingPlan, setPendingPlan] = useState<PlanData | null>(null)

  const [ccSessionId, setCcSessionId] = useState<string | undefined>(undefined)
  const ccSessionIdRef = useRef<string | undefined>(undefined)
  const sessionCreationInProgressRef = useRef<string | null>(null)

  // Find or create chat session for feature and phase
  useEffect(() => {
    if (chatSessionId !== undefined) {
      setCurrentSessionId(chatSessionId)
      if (chatSessionId && !studioChat.chatSessionCollection.get(chatSessionId)) {
        console.log("[ChatPanel] Loading session from API:", chatSessionId)
        studioChat.chatSessionCollection
          .loadAll({ id: chatSessionId })
          .catch((err: any) => console.warn("[ChatPanel] Failed to load session:", err))
      }
      return
    }

    if (!featureId) {
      setCurrentSessionId(null)
      return
    }

    const sessionKey = `${featureId}:${phase ?? "null"}`

    if (sessionCreationInProgressRef.current === sessionKey) {
      return
    }

    const loadOrCreateSession = async () => {
      try {
        await studioChat.chatSessionCollection.loadAll({ contextId: featureId })
      } catch (err) {
        console.warn("[ChatPanel] Failed to load sessions for feature:", err)
      }

      const existingSession = studioChat.chatSessionCollection.all.find(
        (s: any) =>
          s.contextType === "feature" &&
          s.contextId === featureId &&
          (phase == null ? s.phase == null : s.phase === phase)
      )
      if (existingSession) {
        setCurrentSessionId(existingSession.id)
        onChatSessionChange?.(existingSession.id)
        return
      }

      sessionCreationInProgressRef.current = sessionKey

      try {
        if (phase) {
          const newSession = await actions.createChatSession({
            inferredName: 'Untitled',
            contextType: "feature",
            contextId: featureId,
            phase: phase,
          })
          setCurrentSessionId(newSession.id)
          onChatSessionChange?.(newSession.id)
        } else {
          const newSession = await actions.createChatSession({
            inferredName: 'Untitled',
            contextType: "feature",
            contextId: featureId,
          })
          setCurrentSessionId(newSession.id)
          onChatSessionChange?.(newSession.id)
        }
      } finally {
        sessionCreationInProgressRef.current = null
      }
    }

    loadOrCreateSession()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [featureId, featureName, phase, chatSessionId])

  const currentSession = currentSessionId
    ? studioChat.chatSessionCollection.get(currentSessionId)
    : null

  const persistedMessagesFromMobX = currentSessionId
    ? studioChat.chatMessageCollection.all
        .filter((msg: any) => msg.sessionId === currentSessionId)
        .sort((a: any, b: any) => (a.createdAt || 0) - (b.createdAt || 0))
    : []

  const isLoadingMessagesRef = useRef(false)
  const hasInjectedInitialMessageRef = useRef(false)
  const isSendingMessageRef = useRef(false)
  const lastUserInputRef = useRef<{ content: string; files?: FileAttachment[] } | null>(null)

  type QueuedMessage = {
    id: string
    content: string
    files?: FileAttachment[]
    selectedAgentMode?: AgentMode
  }
  const [messageQueue, setMessageQueue] = useState<QueuedMessage[]>([])
  const isProcessingQueueRef = useRef(false)

  useEffect(() => {
    if (currentSession?.claudeCodeSessionId) {
      setCcSessionId(currentSession.claudeCodeSessionId)
      ccSessionIdRef.current = currentSession.claudeCodeSessionId
    } else {
      setCcSessionId(undefined)
      ccSessionIdRef.current = undefined
    }
  }, [currentSession?.claudeCodeSessionId])

  useEffect(() => {
    ccSessionIdRef.current = ccSessionId
  }, [ccSessionId])

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

  useEffect(() => {
    if (!toolErrorBanner) return
    if (toolErrorBanner.isAuthError) return
    const timer = setTimeout(() => setToolErrorBanner(null), 10000)
    return () => clearTimeout(timer)
  }, [toolErrorBanner])

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
      console.log("[ChatPanel:onData] Received data part:", dataPart.type, dataPart)

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
          onPlanCreated?.()
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
          setContextUsage({
            inputTokens: ctx.inputTokens,
            contextWindowTokens: ctx.contextWindowTokens,
          })
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

      const newCcSessionId = (message as any).metadata?.ccSessionId as string | undefined

      if (newCcSessionId && currentSessionId) {
        ccSessionIdRef.current = newCcSessionId
        try {
          await studioChat.chatSessionCollection.update(currentSessionId, {
            claudeCodeSessionId: newCcSessionId,
          })
          setCcSessionId(newCcSessionId)
        } catch (err) {
          ccSessionIdRef.current = ccSessionId
          console.error("[ChatPanel] CRITICAL: CC session ID persistence failed:", err)
        }
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

  const isStreaming = status === "streaming" || status === "submitted"
  const filesChangedFiredRef = useRef(false)

  useEffect(() => {
    onMessagesChange?.(messages)
  }, [messages, onMessagesChange])

  useEffect(() => {
    onChatError?.(error ?? null)
  }, [error, onChatError])

  const [emptyResponseError, setEmptyResponseError] = useState<string | null>(null)
  const [errorBannerExpanded, setErrorBannerExpanded] = useState(false)
  const errorBannerText = useMemo(
    () => (error ? formatErrorMessage(error.message) : emptyResponseError) ?? '',
    [error?.message, emptyResponseError]
  )
  useEffect(() => {
    setErrorBannerExpanded(false)
  }, [errorBannerText])

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
    if (messages.length > 0) return messages
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
  }, [messages, pendingInitialMessage, initialMessage])

  const isStreamingRef = useRef(false)
  isStreamingRef.current = isStreaming

  const handleStop = useCallback(() => {
    stop()

    const req = buildStopRequest({
      localAgentUrl,
      projectId,
      apiBaseUrl: API_URL!,
      platform: Platform.OS,
      getCookie: () => authClient.getCookie(),
    })
    if (req) {
      const fetchFn = expoFetch || fetch
      fetchFn(req.url, req.init).catch((err) => {
        console.warn("[ChatPanel] Failed to send stop signal to backend:", err)
      })
    }
  }, [stop, projectId, localAgentUrl, expoFetch])

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
      if (part.type === "data-session") {
        const sessionData = part.data as { ccSessionId: string }
        if (sessionData.ccSessionId && !ccSessionIdRef.current) {
          ccSessionIdRef.current = sessionData.ccSessionId
          setCcSessionId(sessionData.ccSessionId)
          if (currentSessionId) {
            studioChat.chatSessionCollection
              .update(currentSessionId, {
                claudeCodeSessionId: sessionData.ccSessionId,
              })
              .catch((error: any) => {
                console.error("[ChatPanel:Session] Failed to persist session ID:", error)
              })
          }
        }
      }

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

  // Effect 1: Trigger data loading for chat messages from API (paginated, newest first)
  useEffect(() => {
    if (currentSessionId && !isLoadingMessagesRef.current) {
      isLoadingMessagesRef.current = true
      setIsInitialLoadComplete(false)
      console.log("[ChatPanel] Loading messages for session:", currentSessionId)
      studioChat.chatMessageCollection
        .loadPage(
          { sessionId: currentSessionId },
          { limit: MESSAGE_PAGE_SIZE, offset: 0 },
        )
        .then((result: any) => {
          const count = Array.isArray(result) ? result.length : 0
          console.log("[ChatPanel] Loaded", count, "messages for session:", currentSessionId)

          if (count > 0 && !isStreamingRef.current && !isSendingMessageRef.current) {
            const loaded = studioChat.chatMessageCollection.all
              .filter((msg: any) => msg.sessionId === currentSessionId)
              .sort((a: any, b: any) => (a.createdAt || 0) - (b.createdAt || 0))

            if (loaded.length > 0) {
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
              console.log(
                "[ChatPanel] Direct sync: setting",
                aiMessages.length,
                "messages to AI SDK"
              )
              setMessages(aiMessages)
            }
          }
        })
        .catch((err: any) => console.error("[ChatPanel] Failed to load messages:", err))
        .finally(() => {
          isLoadingMessagesRef.current = false
          setIsInitialLoadComplete(true)
        })
    } else if (!currentSessionId) {
      setIsInitialLoadComplete(true)
    }
  }, [currentSessionId, studioChat, setMessages])

  // Load older messages when user scrolls to top
  const handleLoadOlderMessages = useCallback(async () => {
    if (
      !currentSessionId ||
      isLoadingOlderRef.current ||
      !studioChat.chatMessageCollection.hasMore ||
      isStreamingRef.current
    ) return

    isLoadingOlderRef.current = true

    const currentMsgs = studioChat.chatMessageCollection.all
      .filter((msg: any) => msg.sessionId === currentSessionId)
    const currentCount = currentMsgs.length

    try {
      await studioChat.chatMessageCollection.loadPage(
        { sessionId: currentSessionId },
        { limit: MESSAGE_PAGE_SIZE, offset: currentCount },
      )

      const allLoaded = studioChat.chatMessageCollection.all
        .filter((msg: any) => msg.sessionId === currentSessionId)
        .sort((a: any, b: any) => (a.createdAt || 0) - (b.createdAt || 0))

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
    } catch (err) {
      console.error("[ChatPanel] Failed to load older messages:", err)
    } finally {
      isLoadingOlderRef.current = false
    }
  }, [currentSessionId, studioChat, setMessages])

  const hasReceivedPartsRef = useRef(false)

  useEffect(() => {
    const hasParts = messages.some(
      (msg: any) => Array.isArray(msg.parts) && msg.parts.length > 0
    )
    if (hasParts) {
      hasReceivedPartsRef.current = true
    }
  }, [messages])

  useEffect(() => {
    hasReceivedPartsRef.current = false
    isLoadingMessagesRef.current = false
    processedProgressEventsRef.current.clear()
    subagentStreamStore.clear()
    setIsInitialLoadComplete(false)
    setPendingPlan(null)
  }, [currentSessionId])

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

  // Effect 2: Sync MobX → AI SDK state when data arrives
  useEffect(() => {
    if (persistedMessagesFromMobX.length > 0) {
      if (isStreamingRef.current) {
        return
      }

      if (isSendingMessageRef.current) {
        return
      }

      if (messages.length > 0) {
        return
      }

      const persistedHaveParts = persistedMessagesFromMobX.some((msg: any) => msg.parts)
      if (hasReceivedPartsRef.current && !persistedHaveParts) {
        return
      }
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
      setMessages(aiMessages)
    } else if (currentSessionId) {
      if (initialMessageRef.current?.trim()) {
        return
      }
      setMessages([])
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentSessionId, persistedMessagesFromMobX.length, setMessages])

  useEffect(() => {
    onStreamingChange?.(isStreaming)
  }, [isStreaming, onStreamingChange])

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
    async (content: string, files?: FileAttachment[], selectedAgentMode?: AgentMode) => {
      if (!currentSessionId) {
        console.warn("[ChatPanel] No session ID - message will be lost!")
        return
      }

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
          ccSessionId: ccSessionIdRef.current,
          chatSessionId: currentSessionId,
          workspaceId,
          userId,
          projectId,
          agentMode: selectedAgentMode || agentMode,
          interactionMode,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        }
        const planToSend = confirmedPlanRef.current
        if (planToSend) {
          bodyExtra.confirmedPlan = planToSend
          confirmedPlanRef.current = null
          setConfirmedPlan(null)
        }
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
      agentMode,
      interactionMode,
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
        nextMessage.selectedAgentMode
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
    async (content: string, files?: FileAttachment[], selectedAgentMode?: AgentMode) => {
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
            selectedAgentMode,
          },
        ])
        return
      }

      await sendMessageInternal(trimmedContent, files, selectedAgentMode)
    },
    [isStreaming, sendMessageInternal, currentSessionId]
  )

  // Handle form submit from ChatInput
  const handleInputSubmit = useCallback(
    (content: string, files?: FileAttachment[], selectedAgentMode?: AgentMode) => {
      handleSendMessage(content, files, selectedAgentMode)
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
    handleInteractionModeChange("agent")
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
    const { plan, agentMode: requestedMode } = buildPlanRequest
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
        const textPart = (lastUserMsg as any).parts?.find((p: any) => p.type === "text")
        const content = textPart?.text || ""
        if (content) {
          const lastUserIdx = messages.lastIndexOf(lastUserMsg)
          setMessages(messages.slice(0, lastUserIdx))
          sendMessageInternal(content).catch((err) =>
            console.error("[ChatPanel] Retry failed:", err)
          )
        }
      }
    }
  }, [messages, sendMessageInternal, setMessages])

  const messageListMessages = messages.map((msg) => ({
    id: msg.id,
    role: msg.role as "user" | "assistant",
    content:
      (msg as any).content ||
      msg.parts?.map((p: any) => p.text || "").join("") ||
      "",
  }))

  const resolvedAgentUrl = localAgentUrl || (projectId ? `${API_URL}/api/projects/${projectId}/agent-proxy` : null)

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
            style={Platform.OS === "web" ? { scrollbarWidth: "thin", scrollbarColor: "rgba(150,150,150,0.3) transparent" } as any : undefined}
            contentContainerClassName={cn(
              isNativePhoneLayout ? "px-2 pt-2 pb-36" : "p-2 pb-[40px]",
              "max-w-3xl w-full self-center",
            )}
            keyboardShouldPersistTaps="handled"
            onScroll={(e) => {
              const { layoutMeasurement, contentOffset, contentSize } = e.nativeEvent

              if (!isNative) {
                const isAtBottom =
                  contentSize.height - contentOffset.y - layoutMeasurement.height < 100
                isUserAtBottomRef.current = isAtBottom
              }

              if (contentOffset.y < 50 && !isLoadingOlderRef.current) {
                handleLoadOlderMessages()
              }
            }}
            onScrollBeginDrag={() => {
              if (isNative) {
                stickToBottomRef.current = false
              }
            }}
            onScrollEndDrag={(e) => {
              if (isNative) {
                syncStickFromNativeEvent(e)
              }
            }}
            onMomentumScrollEnd={(e) => {
              if (isNative) {
                syncStickFromNativeEvent(e)
              }
            }}
            onContentSizeChange={(_w, h) => {
              if (isLoadingOlderRef.current || studioChat.chatMessageCollection.isLoadingMore) {
                const delta = h - contentHeightBeforeLoadRef.current
                if (delta > 0 && contentHeightBeforeLoadRef.current > 0) {
                  scrollViewRef.current?.scrollTo({ y: delta, animated: false })
                }
              } else if (isNative && stickToBottomRef.current && contentHeightBeforeLoadRef.current > 0) {
                setTimeout(() => throttledScrollToEnd(), 200)
              }
              contentHeightBeforeLoadRef.current = h
            }}
            scrollEventThrottle={16}
          >
            {studioChat.chatMessageCollection.hasMore && (
              <Pressable
                onPress={handleLoadOlderMessages}
                disabled={studioChat.chatMessageCollection.isLoadingMore}
                className="py-2 items-center"
              >
                {studioChat.chatMessageCollection.isLoadingMore ? (
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
                activeSubagents={
                  Array.from(activeSubagents.values()) as SubagentProgressType[]
                }
                recentTools={recentTools as RecentToolType[]}
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
                    subagents={
                      Array.from(activeSubagents.values()) as SubagentProgressType[]
                    }
                    recentTools={recentTools as RecentToolType[]}
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
              <View className="flex-row items-start gap-2 rounded-lg border border-destructive/50 bg-destructive/10 p-3">
                <AlertCircle className="h-4 w-4 text-destructive shrink-0 mt-0.5" size={16} />
                <View className="flex-1 min-w-0 flex-row items-start justify-between gap-2">
                  <View className="flex-1 min-w-0 pr-1">
                    {errorBannerExpanded ? (
                      <ScrollView
                        nestedScrollEnabled
                        className="max-h-48"
                        showsVerticalScrollIndicator
                      >
                        <Text className="text-sm text-destructive" selectable>
                          {errorBannerText}
                        </Text>
                      </ScrollView>
                    ) : (
                      <Text
                        className="text-sm text-destructive"
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
                        <Text className="text-xs font-semibold text-destructive">
                          {errorBannerExpanded ? 'Show less' : 'Read more'}
                        </Text>
                      </Pressable>
                    )}
                  </View>
                  <Pressable
                    onPress={handleRetry}
                    className="shrink-0 rounded-md border border-destructive/30 px-1 py-1.5 self-start"
                  >
                    <Text className="text-sm text-destructive font-medium">Retry</Text>
                  </Pressable>
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
              agentMode={agentMode}
              onAgentModeChange={handleAgentModeChange}
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
