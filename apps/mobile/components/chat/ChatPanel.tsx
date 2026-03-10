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
import { View, Text, Pressable, ScrollView, Platform, ActivityIndicator, KeyboardAvoidingView } from "react-native"
import * as SecureStore from "expo-secure-store"
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
import { API_URL } from "../../lib/api"
import { authClient } from "../../lib/auth-client"
import { ChatHeader } from "./ChatHeader"
import { MessageList } from "./MessageList"
import { ChatInput, type AgentMode } from "./ChatInput"
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
import { AlertCircle } from "lucide-react-native"

// ============================================================
// Agent Mode Persistence
// ============================================================

const AGENT_MODE_KEY = "agent-mode-preference"

async function loadAgentMode(): Promise<AgentMode | null> {
  try {
    if (Platform.OS === "web") {
      const stored = typeof localStorage !== "undefined" ? localStorage.getItem(AGENT_MODE_KEY) : null
      if (stored === "basic" || stored === "advanced") return stored
      return null
    }
    const stored = await SecureStore.getItemAsync(AGENT_MODE_KEY)
    if (stored === "basic" || stored === "advanced") return stored
    return null
  } catch {
    return null
  }
}

async function saveAgentMode(value: AgentMode): Promise<void> {
  try {
    if (Platform.OS === "web") {
      if (typeof localStorage !== "undefined") {
        localStorage.setItem(AGENT_MODE_KEY, value)
      }
      return
    }
    await SecureStore.setItemAsync(AGENT_MODE_KEY, value)
  } catch {
    // Silently fail
  }
}

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
  initialImageData?: string[]
  onCompactSubmit?: (prompt: string, imageData?: string[]) => void
  compactValue?: string
  onCompactValueChange?: (value: string) => void
  onChatError?: (error: Error | null) => void
  injectMessage?: string | null
  onFilesChanged?: (paths: string[]) => void
  onActiveToolCall?: (toolName: string | null) => void
  selectedThemeId?: string
  onSelectTheme?: (themeId: string) => void
  onCreateTheme?: () => void
  projectType?: "APP" | "AGENT"
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
    refetchCreditLedger: () => void
  }
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
  initialImageData,
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
}: ChatPanelProps) {
  const { studioChat } = useSDKDomains()
  const actions = useDomainActions()

  const platformFeatures = legacyDomains?.platformFeatures
  const componentBuilder = legacyDomains?.componentBuilder

  const router = useRouter()

  const hasActiveSubscription = billingData?.hasActiveSubscription ?? false
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

  // Auto-scroll refs
  const scrollViewRef = useRef<ScrollView>(null)
  const isUserAtBottomRef = useRef(true)
  const isLoadingOlderRef = useRef(false)
  const contentHeightBeforeLoadRef = useRef(0)
  const MESSAGE_PAGE_SIZE = 10

  // Chat session state
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(chatSessionId ?? null)
  const [isInitialLoadComplete, setIsInitialLoadComplete] = useState(false)
  const [agentMode, setAgentMode] = useState<AgentMode>("basic")

  useEffect(() => {
    loadAgentMode().then((stored) => {
      if (stored) {
        setAgentMode(stored)
      } else if (hasActiveSubscription) {
        setAgentMode("advanced")
      }
    })
  }, [hasActiveSubscription])

  const handleAgentModeChange = useCallback((mode: AgentMode) => {
    setAgentMode(mode)
    saveAgentMode(mode)
  }, [])

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
            inferredName: `${featureName || featureId} - ${phase}`,
            contextType: "feature",
            contextId: featureId,
            phase: phase,
          })
          setCurrentSessionId(newSession.id)
          onChatSessionChange?.(newSession.id)
        } else {
          const newSession = await actions.createChatSession({
            inferredName: featureName || `Chat for ${featureId}`,
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
  const lastUserInputRef = useRef<{ content: string; imageData?: string[] } | null>(null)

  type QueuedMessage = {
    id: string
    content: string
    imageData?: string[]
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

  // Subagent progress tracking
  const [activeSubagents, setActiveSubagents] = useState<Map<string, SubagentProgress>>(new Map())
  const [recentTools, setRecentTools] = useState<RecentToolCall[]>([])
  const MAX_RECENT_TOOLS = 8
  const [accumulatedSubagentTools, setAccumulatedSubagentTools] = useState<ToolCallData[]>([])
  const processedProgressEventsRef = useRef<Set<string>>(new Set())

  const isAgent = projectType === "AGENT"

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
  const { messages, sendMessage, status, error, setMessages, stop } = useChat({
    transport: chatTransport,
    id: currentSessionId || undefined,
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

      if (dataPart.type === "data-canvas-preview") {
        const { surfaceId, components } = (dataPart as any).data
        onCanvasPreview?.(surfaceId, components)
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
    },
  })

  const isStreaming = status === "streaming" || status === "submitted"
  const filesChangedFiredRef = useRef(false)

  useEffect(() => {
    onChatError?.(error ?? null)
  }, [error, onChatError])

  const [emptyResponseError, setEmptyResponseError] = useState<string | null>(null)
  const [pendingInitialMessage, setPendingInitialMessage] = useState<string | null>(null)

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

  // Enhanced stop handler
  const handleStop = useCallback(() => {
    stop()

    const stopUrl = isAgent
      ? null
      : localAgentUrl
        ? `${localAgentUrl}/agent/chat/stop`
        : projectId
          ? `${API_URL}/api/projects/${projectId}/chat/stop`
          : null
    if (stopUrl) {
      fetch(stopUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      }).catch((err) => {
        console.warn("[ChatPanel] Failed to send stop signal to backend:", err)
      })
    }
  }, [stop, projectId, isAgent, localAgentUrl])

  // Idle timeout to force-complete hung streams
  const idleTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastMessageContentRef = useRef<string>("")
  const IDLE_TIMEOUT_MS = 180000

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

  // Clear accumulated tools when a new stream starts
  const prevIsStreamingRef = useRef(false)
  useEffect(() => {
    if (isStreaming && !prevIsStreamingRef.current) {
      setAccumulatedSubagentTools([])
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
              setTimeout(() => {
                scrollViewRef.current?.scrollToEnd({ animated: false })
              }, 50)
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
    processedProgressEventsRef.current.clear()
    setIsInitialLoadComplete(false)
  }, [currentSessionId])

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
      setTimeout(() => {
        scrollViewRef.current?.scrollToEnd({ animated: false })
      }, 50)
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

  // Auto-scroll to bottom when messages change or streaming updates
  const isFirstLoadRef = useRef(true)

  useEffect(() => {
    isFirstLoadRef.current = true
    isUserAtBottomRef.current = true
  }, [currentSessionId])

  useEffect(() => {
    if (displayMessages.length === 0) return

    if (displayMessages.length === 1 && (isFirstLoadRef.current || isUserAtBottomRef.current)) {
      // First message: scroll to top
      scrollViewRef.current?.scrollTo({ y: 0, animated: false })
      isFirstLoadRef.current = false
      return
    }

    const shouldScrollToBottom =
      displayMessages.length > 1 && (isFirstLoadRef.current || isUserAtBottomRef.current)

    if (shouldScrollToBottom) {
      const animated = !isFirstLoadRef.current
      scrollViewRef.current?.scrollToEnd({ animated })
      isFirstLoadRef.current = false
    }
  }, [displayMessages.length, messages, currentSessionId])

  // Detect pending AskUserQuestion in messages
  const hasPendingQuestion = useMemo(() => {
    let lastAskUserQuestionIndex = -1

    for (let i = 0; i < messages.length; i++) {
      const message = messages[i]
      if (message.role !== "assistant") continue

      const parts = (message as any).parts as any[] | undefined
      if (!parts) continue

      for (const part of parts) {
        const toolName = part.toolInvocation?.toolName || part.toolName
        if (toolName === "AskUserQuestion") {
          lastAskUserQuestionIndex = i
          break
        }
      }
    }

    if (lastAskUserQuestionIndex === -1) return false

    for (let i = lastAskUserQuestionIndex + 1; i < messages.length; i++) {
      if (messages[i].role === "user") {
        return false
      }
    }

    return true
  }, [messages])

  const extractMediaType = useCallback((dataUrl: string): string => {
    const match = dataUrl.match(/^data:([^;]+);/)
    return match?.[1] || "image/png"
  }, [])

  // Internal function that actually sends a message (used by queue processor)
  const sendMessageInternal = useCallback(
    async (content: string, imageData?: string[], selectedAgentMode?: AgentMode) => {
      if (!currentSessionId) {
        console.warn("[ChatPanel] No session ID - message will be lost!")
        return
      }

      const imageArray = imageData || []

      if (!content.trim() && imageArray.length === 0) {
        return
      }

      const trimmedContent = content.trim()
      lastUserInputRef.current = { content: trimmedContent, imageData: imageArray }

      const parts: Array<
        { type: "text"; text: string } | { type: "file"; mediaType: string; url: string }
      > = []

      if (trimmedContent) {
        parts.push({ type: "text", text: trimmedContent })
      }

      imageArray.forEach((dataUrl) => {
        parts.push({
          type: "file",
          mediaType: extractMediaType(dataUrl),
          url: dataUrl,
        })
      })

      isSendingMessageRef.current = true

      actions
        .addMessage({
          sessionId: currentSessionId,
          role: "user",
          content: trimmedContent,
          imageData: imageArray.length > 0 ? imageArray[0] : undefined,
          parts: parts.length > 0 ? JSON.stringify(parts) : undefined,
        })
        .catch((err) => console.warn("[ChatPanel] Failed to persist user message:", err))

      const messagePayload: {
        text: string
        files?: Array<{ type: "file"; mediaType: string; url: string }>
      } = {
        text: trimmedContent,
      }

      if (imageArray.length > 0) {
        messagePayload.files = imageArray.map((dataUrl) => ({
          type: "file" as const,
          mediaType: extractMediaType(dataUrl),
          url: dataUrl,
        }))
      }

      try {
        await sendMessage(messagePayload, {
          body: {
            featureId,
            phase,
            ccSessionId: ccSessionIdRef.current,
            chatSessionId: currentSessionId,
            workspaceId,
            userId,
            projectId,
            agentMode: selectedAgentMode || agentMode,
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          },
        })
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
        nextMessage.imageData,
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
    async (content: string, imageData?: string[], selectedAgentMode?: AgentMode) => {
      if (!currentSessionId) {
        console.warn("[ChatPanel] No session ID - message will be lost!")
        return
      }

      const imageArray = imageData || []

      if (!content.trim() && imageArray.length === 0) {
        return
      }

      const trimmedContent = content.trim()

      if (isStreaming || isProcessingQueueRef.current || isSendingMessageRef.current) {
        setMessageQueue((queue) => [
          ...queue,
          {
            id: `queue-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
            content: trimmedContent,
            imageData: imageArray,
            selectedAgentMode,
          },
        ])
        return
      }

      await sendMessageInternal(trimmedContent, imageArray, selectedAgentMode)
    },
    [isStreaming, sendMessageInternal, currentSessionId]
  )

  // Handle form submit from ChatInput
  const handleInputSubmit = useCallback(
    (content: string, imageData?: string | string[], selectedAgentMode?: AgentMode) => {
      const normalizedImageData = imageData
        ? Array.isArray(imageData)
          ? imageData
          : [imageData]
        : undefined
      handleSendMessage(content, normalizedImageData, selectedAgentMode)
    },
    [handleSendMessage]
  )

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
    handleSendMessage(initialMessage, initialImageData)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialMessage, initialImageData, currentSessionId, isInitialLoadComplete, handleSendMessage])

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
          sendMessage({ text: content })
        }
      }
    }
  }, [messages, sendMessage, setMessages])

  const messageListMessages = messages.map((msg) => ({
    id: msg.id,
    role: msg.role as "user" | "assistant",
    content:
      (msg as any).content ||
      msg.parts?.map((p: any) => p.text || "").join("") ||
      "",
  }))

  const contextValue: ChatContextValue = {
    currentSession: currentSession
      ? { id: currentSession.id, name: currentSession.name }
      : null,
    messages: messageListMessages,
    sendMessage: handleSendMessage,
    isLoading: isStreaming,
    isPolling,
    error: error?.message ?? null,
  }

  const handleCompactSubmit = useCallback(
    (prompt: string, imageData?: string[]) => {
      onCompactSubmit?.(prompt, imageData)
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
          behavior={Platform.OS === "ios" ? "padding" : undefined}
          className="flex-1 flex-col bg-background"
          keyboardVerticalOffset={Platform.OS === "ios" ? 90 : 0}
        >
          {/* Messages with Turn Grouping */}
          <ScrollView
            ref={scrollViewRef}
            className="flex-1 p-4"
            keyboardShouldPersistTaps="handled"
            onScroll={(e) => {
              const { layoutMeasurement, contentOffset, contentSize } = e.nativeEvent
              const isAtBottom =
                contentSize.height - contentOffset.y - layoutMeasurement.height < 100
              isUserAtBottomRef.current = isAtBottom

              if (contentOffset.y < 50 && !isLoadingOlderRef.current) {
                handleLoadOlderMessages()
              }
            }}
            onContentSizeChange={(_w, h) => {
              if (isLoadingOlderRef.current || studioChat.chatMessageCollection.isLoadingMore) {
                const delta = h - contentHeightBeforeLoadRef.current
                if (delta > 0 && contentHeightBeforeLoadRef.current > 0) {
                  scrollViewRef.current?.scrollTo({ y: delta, animated: false })
                }
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
              <PhaseEmptyState phase={phase} onSuggestionClick={handleSendMessage} />
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

          {/* Error Alert */}
          {(error || emptyResponseError) && (
            <View className="px-4 pb-2">
              <View className="flex-row items-start gap-2 rounded-lg border border-destructive/50 bg-destructive/10 p-3">
                <AlertCircle className="h-4 w-4 text-destructive shrink-0 mt-0.5" size={16} />
                <View className="flex-1 flex-row items-center justify-between gap-2">
                  <Text className="text-sm text-destructive flex-1">
                    {error ? formatErrorMessage(error.message) : emptyResponseError}
                  </Text>
                  <Pressable
                    onPress={handleRetry}
                    className="shrink-0 rounded-md border border-destructive/30 px-3 py-1.5"
                  >
                    <Text className="text-sm text-destructive font-medium">Retry</Text>
                  </Pressable>
                </View>
              </View>
            </View>
          )}

          {/* Input */}
          <View className="bg-transparent">
            <ChatInput
              onSubmit={handleInputSubmit}
              disabled={!currentSessionId}
              placeholder={
                !featureId
                  ? "Select a feature to start chatting..."
                  : hasPendingQuestion
                    ? "Respond to the question above, or type a message..."
                    : "Ask Shogo..."
              }
              isStreaming={isStreaming}
              onStop={handleStop}
              agentMode={agentMode}
              onAgentModeChange={handleAgentModeChange}
              isPro={hasActiveSubscription}
              onUpgradeClick={handleUpgradeClick}
              queuedMessages={messageQueue}
              onRemoveQueuedMessage={handleRemoveQueuedMessage}
              onReorderQueuedMessage={handleReorderQueuedMessage}
            />
          </View>
        </KeyboardAvoidingView>
      </View>
    </ChatContextProvider>
  )
})
