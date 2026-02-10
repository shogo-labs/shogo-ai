/**
 * ChatPanel - Smart component that integrates useChat hook with studio-chat domain
 * Tasks: task-2-4-004, task-3-1-004, task-cpbi-004, task-cpbi-005
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
 * - Collapse/expand with manual resize
 * - localStorage persistence for collapse state and width
 * - Error display with Retry button
 * - Smart query triggers: Detects tool calls in onFinish and triggers targeted data refreshes (task-3-1-004)
 */

import { useState, useEffect, useRef, useCallback, useMemo } from "react"
import { observer } from "mobx-react-lite"
import { useChat, type Message } from "@ai-sdk/react"
import { DefaultChatTransport } from "ai"
import { useNavigate } from "react-router-dom"
import { useDomains, useSDKDomains } from "@/contexts/DomainProvider"
import { useDomainActions } from "@/generated/domain-actions"
import { useBillingData } from "@/hooks/useBillingData"
import { cn } from "@/lib/utils"
import { ChatHeader } from "./ChatHeader"
import { MessageList } from "./MessageList"
import { ChatInput, type AgentMode } from "./ChatInput"
import { CompactChatInput } from "./CompactChatInput"
import { ExpandTab } from "./ExpandTab"
import { ToolCallDisplay, type ToolCallState } from "./ToolCallDisplay"
import { ChatContextProvider, type ChatContextValue } from "./ChatContext"
// Chat Panel UX Redesign - New component imports (task-chat-008)
import { TurnList } from "./turns"
import { PhaseEmptyState } from "./empty"
import { SubagentPanel, type SubagentProgress as SubagentProgressType, type RecentTool as RecentToolType } from "./subagent"
import { type ToolCallData, getToolCategory as getToolCategoryFromTools } from "./tools/types"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { AlertCircle } from "lucide-react"
import { getThemePromptContext } from "@/hooks/useProjectTheme"

// ============================================================
// Types
// ============================================================

// Progress event types from server (task-subagent-progress-streaming)
type SubagentProgressEvent =
  | { type: 'subagent-start'; agentId: string; agentType: string; timestamp: number }
  | { type: 'subagent-stop'; agentId: string; timestamp: number }
  | { type: 'tool-complete'; toolName: string; toolUseId: string; timestamp: number }

// Virtual tool event type from server (virtual-tools-domain Phase 0 PoC)
interface VirtualToolEvent {
  type: 'virtual-tool-execute'
  toolUseId: string
  toolName: string
  args: Record<string, unknown>
  timestamp: number
}

interface SubagentProgress {
  agentId: string
  agentType: string
  startTime: number
  status: 'running' | 'completed'
  toolCount: number
}

// Recent tool activity for display
interface RecentToolCall {
  id: string
  toolName: string
  timestamp: number
}

// ============================================================
// Virtual Tool v2 Mappings
// ============================================================

// Note: SECTION_TO_COMPONENT map removed - now using direct section names
// in slotContent.section field. The toSlotSpecs() view handles resolution.

// Map layout names to layout template IDs
const LAYOUT_TO_TEMPLATE: Record<string, string> = {
  'single': 'layout-workspace-flexible',
  'split-h': 'layout-workspace-split-h',
  'split-v': 'layout-workspace-split-v',
}

// Helper to format tool names for display
function formatToolName(name: string): string {
  // Handle MCP tool names: mcp__wavesmith__store_query -> wavesmith.store_query
  if (name.startsWith('mcp__')) {
    const parts = name.replace('mcp__', '').split('__')
    return parts.join('.')
  }
  return name
}

// Helper to get tool category for styling
function getToolCategory(name: string): 'mcp' | 'file' | 'skill' | 'other' {
  if (name.startsWith('mcp__')) return 'mcp'
  if (['Read', 'Write', 'Edit', 'Glob', 'Grep'].includes(name)) return 'file'
  if (['Skill', 'Task'].includes(name)) return 'skill'
  return 'other'
}

// Friendly error code mapping for chat errors
const ERROR_CODE_MESSAGES: Record<string, string> = {
  pod_unavailable: "We're having trouble starting your project environment. Please try again in a moment.",
  rate_limit_exceeded: "You're sending messages too quickly. Please wait a moment and try again.",
  insufficient_credits: "You've run out of credits. Please upgrade your plan to continue.",
  session_expired: "Your session has expired. Please refresh the page.",
  internal_error: "Something went wrong on our end. Please try again.",
}

// Parse potentially JSON error messages into user-friendly text
function formatErrorMessage(rawMessage: string): string {
  try {
    const parsed = JSON.parse(rawMessage)
    // Handle { error: { code, message } } format
    if (parsed?.error?.code && ERROR_CODE_MESSAGES[parsed.error.code]) {
      return ERROR_CODE_MESSAGES[parsed.error.code]
    }
    if (parsed?.error?.message) {
      return parsed.error.message
    }
    // Handle { message } format
    if (parsed?.message) {
      return parsed.message
    }
  } catch {
    // Not JSON, use as-is
  }
  return rawMessage
}

// Re-export WorkspacePanelData from advanced-chat for workspace integration (task-testbed-chat-integration)
import type { WorkspacePanelData } from "../advanced-chat/WorkspacePanel"
export type { WorkspacePanelData }

export interface ChatPanelProps {
  /** Display mode: 'compact' for homepage, 'full' for project sidebar */
  mode?: 'compact' | 'full'
  /** Feature session ID to link chat with */
  featureId: string | null
  /** Feature session name for display */
  featureName?: string
  /** Current phase from WorkspaceLayout navigation (task-cpbi-004) */
  phase: string | null
  /** Current workspace ID for billing/credit tracking */
  workspaceId?: string
  /** Current user ID for billing/credit tracking */
  userId?: string
  /** Project ID for Claude Code working directory context */
  projectId?: string
  /** Children to render inside ChatContextProvider */
  children?: React.ReactNode
  /** Optional class name */
  className?: string
  /** Callback to trigger schema data refetch (for schema.set/schema.load tool calls) */
  onSchemaRefresh?: () => void
  /** Callback to manually trigger a data refresh (from useFeaturePolling) - task-3-1-007 */
  onRefresh?: () => Promise<void>
  /** Callback to notify parent when streaming state changes - task-3-1-007 */
  onStreamingChange?: (isStreaming: boolean) => void
  /** Whether data is being refreshed via polling - task-3-1-008 */
  isPolling?: boolean
  /** Callback to navigate to a different phase (virtual-tools-domain Phase 0 PoC) */
  onNavigateToPhase?: (phase: string) => void
  /** Callback to open a panel in workspace (task-testbed-chat-integration) */
  onOpenPanel?: (panel: WorkspacePanelData) => void
  /** Optional explicit chat session ID (for session picker integration) */
  chatSessionId?: string | null
  /** Callback when chat session changes (for session picker integration) */
  onChatSessionChange?: (sessionId: string) => void
  /** Optional controlled collapse state (for parent layout control) */
  isCollapsed?: boolean
  /** Callback when collapse state changes (for parent layout control) */
  onCollapsedChange?: (collapsed: boolean) => void
  /** Callback when width changes (for parent layout control) */
  onWidthChange?: (width: number) => void
  /** Initial message to send on mount (for homepage transition warm-start) */
  initialMessage?: string
  /** Callback when submit happens in compact mode (before session exists) */
  onCompactSubmit?: (prompt: string) => void
  /** Ref to expose the input container for transition animation measurement */
  inputContainerRef?: React.RefObject<HTMLDivElement>
  /** Ref to expose the message container for transition animation measurement (targets first message area) */
  messageContainerRef?: React.RefObject<HTMLDivElement>
  /** Controlled value for compact mode input */
  compactValue?: string
  /** Callback when compact mode input value changes */
  onCompactValueChange?: (value: string) => void
  /** Callback when chat encounters an error (for RuntimePreviewPanel to stop loading) */
  onChatError?: (error: Error | null) => void
  /** Callback when agent modifies files (Write, Edit, StrReplace tools) - for code panel refresh */
  onFilesChanged?: (paths: string[]) => void
  /** Callback when a tool call becomes active/inactive - for preview overlay during template_copy */
  onActiveToolCall?: (toolName: string | null) => void
  /** Currently selected theme ID (for compact mode) */
  selectedThemeId?: string
  /** Callback when theme is selected (for compact mode) */
  onSelectTheme?: (themeId: string) => void
  /** Callback when "Create new theme" is clicked (for compact mode) */
  onCreateTheme?: () => void
}

// ============================================================
// Constants
// ============================================================

const DEFAULT_WIDTH = 480
const MIN_WIDTH = 280
const MAX_WIDTH = 800
const STORAGE_KEY_COLLAPSED = "chat-panel-collapsed"
const STORAGE_KEY_WIDTH = "chat-panel-width"

// ============================================================
// Local Storage Helpers
// ============================================================

function getStoredCollapsed(): boolean {
  if (typeof localStorage === "undefined") return false
  const stored = localStorage.getItem(STORAGE_KEY_COLLAPSED)
  return stored === "true"
}

function setStoredCollapsed(collapsed: boolean): void {
  if (typeof localStorage === "undefined") return
  localStorage.setItem(STORAGE_KEY_COLLAPSED, String(collapsed))
}

function getStoredWidth(): number {
  if (typeof localStorage === "undefined") return DEFAULT_WIDTH
  const stored = localStorage.getItem(STORAGE_KEY_WIDTH)
  if (!stored) return DEFAULT_WIDTH
  const parsed = parseInt(stored, 10)
  return isNaN(parsed) ? DEFAULT_WIDTH : Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, parsed))
}

function setStoredWidth(width: number): void {
  if (typeof localStorage === "undefined") return
  localStorage.setItem(STORAGE_KEY_WIDTH, String(width))
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

function extractToolCalls(message: Message): ExtractedToolCall[] {
  // AI SDK 4.2+ uses message.parts for tool invocations
  if (!("parts" in message) || !Array.isArray((message as any).parts)) {
    return []
  }

  return ((message as any).parts as any[])
    .filter((part) => part.type === "tool-invocation" || part.type === "dynamic-tool")
    .map((part) => {
      // Handle both standard tool-invocation and Claude Code's dynamic-tool format
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
        // dynamic-tool: data is directly on the part; for output-error, error is in errorText
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

/**
 * Extract text content from a message.
 * chat-session-sync-fix: v3 API uses parts array instead of content string.
 * This helper handles both formats for backward compatibility.
 */
function extractTextContent(message: Message): string {
  // If message has content string (legacy or fallback), use it
  if (typeof message.content === "string" && message.content) {
    return message.content
  }

  // v3 API: Extract text from parts array
  if ("parts" in message && Array.isArray((message as any).parts)) {
    return ((message as any).parts as any[])
      .filter((part) => part.type === "text")
      .map((part) => part.text || "")
      .join("")
  }

  return ""
}

function mapToolCallState(state: string | undefined): ToolCallState {
  switch (state) {
    case "partial-call":
      return "input-streaming"
    case "call":
      return "input-available"
    case "result":
    case "output-available": // dynamic-tool format
    case "success": // alternative dynamic-tool state
      return "output-available"
    case "error":
    case "output-error": // dynamic-tool format
      return "output-error"
    default:
      return "input-streaming"
  }
}

// ============================================================
// Parts Serialization Helpers (for tool call rendering on reload)
// ============================================================

/**
 * Check if a message has tool calls worth persisting.
 */
function hasToolCalls(message: Message): boolean {
  const parts = (message as any).parts as any[] | undefined
  if (!parts || !Array.isArray(parts)) return false
  return parts.some(
    (p) => p.type === "tool-invocation" || p.type === "dynamic-tool"
  )
}

/**
 * Serialize message parts for persistence.
 * Filters to only relevant part types and truncates large results.
 */
function serializeParts(parts: any[] | undefined): string | undefined {
  if (!parts || !Array.isArray(parts)) return undefined

  // Filter to persistable parts (skip data-* and other transient types)
  const persistableParts = parts.filter(
    (p) =>
      p.type === "text" ||
      p.type === "tool-invocation" ||
      p.type === "dynamic-tool" ||
      (p.type === "file" && p.mediaType?.startsWith("image/"))
  )

  if (persistableParts.length === 0) return undefined

  // Truncate large tool results to prevent storage bloat (>50KB)
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
// CC Session ID is now extracted from X-CC-Session-Id response header
// (chat-session-sync-fix: removed marker extraction in favor of header approach)
// ============================================================

// ============================================================
// Smart Query Trigger Mapping (task-3-1-004)
// ============================================================

/**
 * Maps model names from store.create tool calls to collection names for refresh.
 * Per design-3-1-003: store.create with specific models triggers that collection refresh.
 */
const PLATFORM_FEATURES_MODEL_MAP: Record<string, string> = {
  // Core feature entities
  Requirement: "requirementCollection",
  AnalysisFinding: "analysisFindingCollection",
  DesignDecision: "designDecisionCollection",
  ImplementationTask: "implementationTaskCollection",
  TestSpecification: "testSpecificationCollection",
  // Implementation phase entities
  ImplementationRun: "implementationRunCollection",
  TaskExecution: "taskExecutionCollection",
  // Feature session
  FeatureSession: "featureSessionCollection",
}

/**
 * Maps component-builder model names to collection names.
 * Used for smart refresh when AI updates UI bindings/components.
 */
const COMPONENT_BUILDER_MODEL_MAP: Record<string, string> = {
  ComponentDefinition: "componentDefinitionCollection",
  Registry: "registryCollection",
  RendererBinding: "rendererBindingCollection",
  LayoutTemplate: "layoutTemplateCollection",
  Composition: "compositionCollection",
  ComponentSpec: "componentSpecCollection",
}

/**
 * Result of getCollectionsToRefresh - includes schema for routing.
 */
interface RefreshTarget {
  schema: "platform-features" | "component-builder"
  collections: string[]
}

/**
 * Determines which collections to refresh based on a tool call.
 * Returns schema and collection names for targeted refresh.
 *
 * @param toolCall - Extracted tool call from AI message
 * @returns RefreshTarget with schema and collections, or null if no refresh needed
 */
function getRefreshTarget(toolCall: ExtractedToolCall): RefreshTarget | null {
  const { toolName, args } = toolCall

  // Handle MCP tool naming: "mcp__wavesmith__store_create" -> "store_create"
  const normalizedToolName = toolName.includes("__")
    ? toolName.split("__").pop() || toolName
    : toolName

  // Only handle store operations
  if (!["store_create", "store_update", "store_delete"].includes(normalizedToolName)) {
    return null
  }

  const model = args?.model as string | undefined
  const schema = args?.schema as string | undefined

  if (!model) return null

  // Route based on schema arg
  if (schema === "component-builder") {
    const collection = COMPONENT_BUILDER_MODEL_MAP[model]
    if (collection) {
      return { schema: "component-builder", collections: [collection] }
    }
  } else {
    // Default to platform-features (handles "platform-features" and undefined)
    const collection = PLATFORM_FEATURES_MODEL_MAP[model]
    if (collection) {
      return { schema: "platform-features", collections: [collection] }
    }
  }

  return null
}

/**
 * Checks if a tool call requires schema refresh.
 * Schema operations (schema.set, schema.load) need to trigger useSchemaData refetch.
 */
function requiresSchemaRefresh(toolCall: ExtractedToolCall): boolean {
  const { toolName } = toolCall

  // Handle MCP tool naming
  const normalizedToolName = toolName.includes("__")
    ? toolName.split("__").pop() || toolName
    : toolName

  return normalizedToolName === "schema_set" || normalizedToolName === "schema_load"
}

/**
 * File operation tool names that modify files in the project.
 * These tools require the code panel to refresh.
 */
const FILE_OPERATION_TOOLS = new Set([
  'Write',
  'Edit', 
  'StrReplace',
  'Delete',
  // MCP template tools
  'template_copy',
  'template.copy',
])

/**
 * Extracts file paths from tool calls that modify files.
 * Returns array of file paths that were modified.
 */
function getModifiedFilePaths(toolCalls: ExtractedToolCall[]): string[] {
  const paths: string[] = []
  
  for (const toolCall of toolCalls) {
    // Only process successful tool calls
    if (toolCall.state !== "output-available") {
      continue
    }
    
    // Handle MCP tool naming: "mcp__wavesmith__template_copy" -> "template_copy"
    const normalizedToolName = toolCall.toolName.includes("__")
      ? toolCall.toolName.split("__").pop() || toolCall.toolName
      : toolCall.toolName
    
    // Check if this is a file operation tool
    if (!FILE_OPERATION_TOOLS.has(normalizedToolName)) {
      continue
    }
    
    // Extract path from args
    const args = toolCall.args as Record<string, unknown> | undefined
    if (args?.path && typeof args.path === 'string') {
      paths.push(args.path)
    }
    
    // For template.copy, mark as "all files changed" with special marker
    if (normalizedToolName === 'template_copy' || normalizedToolName === 'template.copy') {
      paths.push('*') // Special marker meaning "refresh all files"
    }
  }
  
  return [...new Set(paths)] // Deduplicate
}

/**
 * Triggers collection refreshes for the given collection names on a domain.
 * Uses same query().toArray() pattern as useFeaturePolling for consistency.
 */
async function refreshCollections(
  domain: any,
  collectionNames: string[],
  domainName: string = "domain"
): Promise<void> {
  if (!domain || collectionNames.length === 0) {
    return
  }

  // Deduplicate collection names
  const uniqueCollections = [...new Set(collectionNames)]

  // Refresh all collections in parallel
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
  mode = 'full',
  featureId,
  featureName,
  phase,
  workspaceId,
  userId,
  projectId,
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
  onWidthChange,
  initialMessage,
  onCompactSubmit,
  inputContainerRef,
  messageContainerRef,
  compactValue,
  onCompactValueChange,
  onChatError,
  onFilesChanged,
  onActiveToolCall,
  selectedThemeId,
  onSelectTheme,
  onCreateTheme,
}: ChatPanelProps) {
  // Access SDK domains for chat persistence (SDK-generated stores)
  const { studioChat } = useSDKDomains()
  
  // Access domain actions for creating sessions, messages, etc.
  const actions = useDomainActions()
  
  // Access legacy domains for features and composition (not yet migrated to SDK)
  const { platformFeatures, componentBuilder } = useDomains<{
    platformFeatures: any
    componentBuilder: any
  }>()

  // Navigation for upgrade flow
  const navigate = useNavigate()

  // Billing data for Pro subscription check and credit refresh after messages
  const { hasActiveSubscription, refetchCreditLedger } = useBillingData(workspaceId)

  // Handle upgrade click - navigate to billing settings
  const handleUpgradeClick = useCallback(() => {
    if (projectId) {
      navigate(`/projects/${projectId}/settings?tab=billing`)
    }
  }, [navigate, projectId])

  // Panel state - use controlled prop if provided, otherwise internal state
  const [internalIsCollapsed, setInternalIsCollapsed] = useState(() => getStoredCollapsed())
  const isCollapsed = controlledIsCollapsed ?? internalIsCollapsed
  const setIsCollapsed = onCollapsedChange ?? setInternalIsCollapsed
  const [width, setWidth] = useState(() => getStoredWidth())
  const [isResizing, setIsResizing] = useState(false)
  const resizeRef = useRef<{ startX: number; startWidth: number } | null>(null)

  // Auto-scroll refs for messages container
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const isUserAtBottomRef = useRef(true)

  // Chat session state - initialize from prop to avoid null→valid transition on reload
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(chatSessionId ?? null)

  // Track whether we've finished the initial message load from the API
  // Prevents showing "Start Discovery" empty state while messages are loading
  const [isInitialLoadComplete, setIsInitialLoadComplete] = useState(false)

  // Agent mode state for switching between basic (Haiku) and advanced (Sonnet) models
  const [agentMode, setAgentMode] = useState<AgentMode>("advanced")

  // Claude Code session ID for continuity (task-cc-chatpanel-integration)
  // Initialized from existing session's claudeCodeSessionId on load
  const [ccSessionId, setCcSessionId] = useState<string | undefined>(undefined)

  // chat-session-sync-fix: Ref for latest ccSessionId value in callbacks
  // State updates are async, ref provides immediate access for append() calls
  const ccSessionIdRef = useRef<string | undefined>(undefined)

  // Guard ref to prevent duplicate session creation (fixes race condition)
  const sessionCreationInProgressRef = useRef<string | null>(null)

  // Sync initial width to parent on mount (fixes width desync between parent and ChatPanel)
  useEffect(() => {
    onWidthChange?.(width)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []) // Only on mount - width from localStorage needs to sync to parent

  // Find or create chat session for feature and phase (task-cpbi-005)
  // Session is uniquely identified by (featureId, phase) tuple
  // If chatSessionId prop is provided, use it directly (for session picker integration)
  // fix-chat-history: Also load session data from API when chatSessionId is provided
  useEffect(() => {
    // If explicit chatSessionId is provided, use it directly and load from API
    if (chatSessionId !== undefined) {
      setCurrentSessionId(chatSessionId)
      // Load the session data from API if not already in MST
      // This ensures session metadata is available for display
      if (chatSessionId && !studioChat.chatSessionCollection.get(chatSessionId)) {
        console.log('[ChatPanel] Loading session from API:', chatSessionId)
        studioChat.chatSessionCollection.loadAll({ id: chatSessionId })
          .catch((err: any) => console.warn('[ChatPanel] Failed to load session:', err))
      }
      return
    }

    if (!featureId) {
      setCurrentSessionId(null)
      return
    }

    // Create a key for this feature+phase combo to track creation in progress
    const sessionKey = `${featureId}:${phase ?? 'null'}`

    // Guard: if we're already creating a session for this key, skip
    if (sessionCreationInProgressRef.current === sessionKey) {
      return
    }

    // Use async IIFE for await support in useEffect
    const loadOrCreateSession = async () => {
      // First, try to load sessions from API to ensure we have fresh data
      // This handles the case where session exists in DB but not in MST
      try {
        await studioChat.chatSessionCollection.loadAll({ contextId: featureId })
      } catch (err) {
        console.warn('[ChatPanel] Failed to load sessions for feature:', err)
      }

      // Find existing session for this feature AND phase (now checking fresh data)
      // SDK collection uses .all property with filter
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

      // Mark creation in progress BEFORE async operation
      sessionCreationInProgressRef.current = sessionKey

      try {
        if (phase) {
          // Auto-create session with phase (async per task-cpbi-002)
          const newSession = await actions.createChatSession({
            inferredName: `${featureName || featureId} - ${phase}`,
            contextType: "feature",
            contextId: featureId,
            phase: phase,
          })
          setCurrentSessionId(newSession.id)
          onChatSessionChange?.(newSession.id)
        } else {
          // No phase provided, create session without phase
          const newSession = await actions.createChatSession({
            inferredName: featureName || `Chat for ${featureId}`,
            contextType: "feature",
            contextId: featureId,
          })
          setCurrentSessionId(newSession.id)
          onChatSessionChange?.(newSession.id)
        }
      } finally {
        // Clear the guard after creation completes
        sessionCreationInProgressRef.current = null
      }
    }

    loadOrCreateSession()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [featureId, featureName, phase, chatSessionId])

  // Get current session
  const currentSession = currentSessionId
    ? studioChat.chatSessionCollection.get(currentSessionId)
    : null

  // Derive messages from MobX view (reactive due to observer)
  // This is read during render, so MobX tracks it and triggers re-render when data changes
  // Used for syncing persisted messages to AI SDK state
  const persistedMessagesFromMobX = currentSessionId
    ? studioChat.chatMessageCollection.all
        .filter((msg: any) => msg.sessionId === currentSessionId)
        .sort((a: any, b: any) => (a.createdAt || 0) - (b.createdAt || 0))
    : []

  // Loading guard ref to prevent duplicate message queries
  const isLoadingMessagesRef = useRef(false)

  // Guard to prevent double-injection of initial message (homepage transition warm-start)
  const hasInjectedInitialMessageRef = useRef(false)

  // Guard to prevent sync effect from running while sending a message
  // This prevents duplicate messages when persisting optimistically before AI SDK adds its own
  const isSendingMessageRef = useRef(false)

  // Store last user input for retry functionality (task-chat-retry-fix)
  // This allows retry to work even if AI SDK's reload() fails
  const lastUserInputRef = useRef<{ content: string; imageData?: string[] } | null>(null)

  // Message queue for sequential processing (like Cursor)
  // Messages are queued and processed one at a time, waiting for each to complete
  type QueuedMessage = {
    id: string
    content: string
    imageData?: string[]
    selectedAgentMode?: AgentMode
  }
  const [messageQueue, setMessageQueue] = useState<QueuedMessage[]>([])
  const isProcessingQueueRef = useRef(false)

  // Initialize ccSessionId from existing session (task-cc-chatpanel-integration)
  // This ensures session continuity when reloading the page or switching sessions
  useEffect(() => {
    if (currentSession?.claudeCodeSessionId) {
      setCcSessionId(currentSession.claudeCodeSessionId)
      ccSessionIdRef.current = currentSession.claudeCodeSessionId
    } else {
      // Clear ccSessionId when switching to a new session without one
      setCcSessionId(undefined)
      ccSessionIdRef.current = undefined
    }
  }, [currentSession?.claudeCodeSessionId])

  // chat-session-sync-fix: Keep ref in sync with state changes
  useEffect(() => {
    ccSessionIdRef.current = ccSessionId
  }, [ccSessionId])

  // Subagent progress tracking (task-subagent-progress-streaming)
  const [activeSubagents, setActiveSubagents] = useState<Map<string, SubagentProgress>>(new Map())
  const [recentTools, setRecentTools] = useState<RecentToolCall[]>([])
  const MAX_RECENT_TOOLS = 8 // Keep last N tool calls for display

  // Accumulated subagent tool calls for timeline persistence (task-chat-ux-fix)
  // These persist even after streaming ends, unlike recentTools which are for live display
  const [accumulatedSubagentTools, setAccumulatedSubagentTools] = useState<ToolCallData[]>([])

  // Track processed progress event IDs to prevent duplicate handling
  // Events can be processed by both onData callback and useEffect (from message.parts)
  // This ref ensures each event is only handled once, preventing infinite loops
  const processedProgressEventsRef = useRef<Set<string>>(new Set())

  // chat-session-sync-fix: v3 API requires DefaultChatTransport for proper metadata handling
  // The transport must be memoized to prevent re-creation on every render
  // pod-per-project: Use project-specific endpoint when projectId is available
  // This routes chat requests to the dedicated project pod via Knative
  const chatTransport = useMemo(
    () => new DefaultChatTransport({ 
      api: projectId ? `/api/projects/${projectId}/chat` : "/api/chat" 
    }),
    [projectId]
  )

  // AI SDK useChat hook (v3 API - chat-session-sync-fix)
  const {
    messages,
    sendMessage,  // v3 API: sendMessage() replaces append()
    status,       // v3 API: 'submitted' | 'streaming' | 'ready' | 'error'
    error,
    setMessages,
    reload,
    stop,  // Used by idle timeout to force-complete hung streams
  } = useChat({
    transport: chatTransport,
    id: currentSessionId || undefined,
    // chat-session-sync-fix: v3 with transport enables proper message.metadata handling
    // Server's messageMetadata callback sends ccSessionId, which becomes message.metadata.ccSessionId
    onError: (err) => {
      // Critical: Handle errors to ensure isLoading gets cleared
      // Without this handler, errors leave isLoading=true indefinitely
      console.error("[ChatPanel] Stream error:", err)
    },
    // Handle transient data parts via AI SDK 6.x data-{name} format
    // Server sends: { type: 'data-progress', id: string, data: SubagentProgressEvent }
    // Server sends: { type: 'data-virtual-tool', id: string, data: VirtualToolEvent }
    // Session ID comes via message-metadata (handled in onFinish)
    // See: https://ai-sdk.dev/docs/ai-sdk-ui/streaming-data
    onData: async (dataPart) => {
      console.log('[ChatPanel:onData] Received data part:', dataPart.type, dataPart)

      // Handle virtual tool events (virtual-tools-domain Phase 0 PoC)
      // These are tools executed client-side rather than via MCP
      if (dataPart.type === 'data-virtual-tool') {
        const event = (dataPart as any).data as VirtualToolEvent
        console.log('[ChatPanel:VirtualTool] 🎯 Received virtual tool event:', event)

        // Execute the virtual tool based on toolName
        if (event.toolName === 'navigate_to_phase') {
          const targetPhase = event.args?.phase as string
          if (targetPhase && onNavigateToPhase) {
            console.log('[ChatPanel:VirtualTool] 🚀 Navigating to phase:', targetPhase)
            onNavigateToPhase(targetPhase)
          } else if (targetPhase) {
            // Fallback: Update URL directly if no callback provided
            console.log('[ChatPanel:VirtualTool] 🚀 Navigating via URL to phase:', targetPhase)
            const url = new URL(window.location.href)
            url.searchParams.set('phase', targetPhase)
            window.history.pushState({}, '', url.toString())
            // Dispatch popstate to trigger re-render (WorkspaceLayout listens to URL)
            window.dispatchEvent(new PopStateEvent('popstate'))
          }
        } else if (event.toolName === 'open_panel') {
          // task-testbed-chat-integration: Handle open_panel virtual tool
          const panelId = event.args?.panelId as string || `panel-${event.toolUseId}`
          const panelType = event.args?.type as string || 'preview'
          const panelTitle = event.args?.title as string || 'Panel'
          const panelContent = event.args?.content as unknown

          if (onOpenPanel) {
            console.log('[ChatPanel:VirtualTool] 📋 Opening panel:', panelId, panelType, panelTitle)
            onOpenPanel({
              id: panelId,
              type: panelType,
              title: panelTitle,
              content: panelContent,
            })
          } else {
            console.warn('[ChatPanel:VirtualTool] ⚠️ open_panel called but no onOpenPanel callback provided')
          }
        } else if (event.toolName === 'show_schema') {
          // req-wpp-show-schema-tool: Handle show_schema virtual tool
          // Updates workspace Composition to display DesignContainerSection with the requested schema
          const schemaName = event.args?.schemaName as string
          const defaultTab = event.args?.defaultTab as string || 'schema'

          if (!schemaName) {
            console.warn('[ChatPanel:VirtualTool] ⚠️ show_schema called without schemaName')
            return
          }

          console.log('[ChatPanel:VirtualTool] 📊 Showing schema:', schemaName, 'defaultTab:', defaultTab)

          try {
            // 1. Update the feature session's schemaName (DesignContainerSection reads from feature.schemaName)
            // MST requires updates through collection methods, not direct property mutation
            if (featureId && platformFeatures?.featureSessionCollection) {
              await platformFeatures.featureSessionCollection.updateOne(featureId, {
                schemaName: schemaName
              })
              console.log('[ChatPanel:VirtualTool] ✅ Updated session schemaName:', schemaName)
            }

            // 2. Update or create workspace Composition's slotContent to include DesignContainerSection
            // This replaces the blank state with the schema display section
            if (componentBuilder?.compositionCollection) {
              const workspaceComposition = componentBuilder.compositionCollection.findByName?.('workspace')
              if (workspaceComposition) {
                // Check if DesignContainerSection is already in slotContent (by component ref)
                const currentSlotContent = workspaceComposition.slotContent || []
                const hasDesignSection = currentSlotContent.some?.(
                  (slot: any) => slot.component === 'comp-design-container' ||
                    slot.sectionRef === 'DesignContainerSection'
                )

                if (!hasDesignSection) {
                  // Replace all current content (including blank state) with DesignContainerSection
                  // Using component reference format to match seed data pattern
                  const newSlotContent = [
                    {
                      slot: 'main',
                      component: 'comp-design-container',
                      config: { defaultTab, expandGraph: true }
                    }
                  ]
                  // MST requires updates through collection.updateOne, not direct property mutation
                  await componentBuilder.compositionCollection.updateOne(workspaceComposition.id, {
                    slotContent: newSlotContent
                  })
                  console.log('[ChatPanel:VirtualTool] ✅ Replaced workspace content with DesignContainerSection')
                } else {
                  // Update existing section's config
                  const updatedSlotContent = currentSlotContent.map?.((slot: any) => {
                    if (slot.component === 'comp-design-container' ||
                      slot.sectionRef === 'DesignContainerSection') {
                      return { ...slot, config: { ...slot.config, defaultTab } }
                    }
                    return slot
                  })
                  await componentBuilder.compositionCollection.updateOne(workspaceComposition.id, {
                    slotContent: updatedSlotContent
                  })
                  console.log('[ChatPanel:VirtualTool] ✅ Updated DesignContainerSection config')
                }
              } else {
                // Create the workspace composition if it doesn't exist
                const newSlotContent = [
                  {
                    slot: 'main',
                    component: 'comp-design-container',
                    config: { defaultTab, expandGraph: true }
                  }
                ]
                const newComposition = {
                  id: `composition-workspace-${Date.now()}`,
                  name: 'workspace',
                  layout: 'layout-workspace-flexible',
                  slotContent: newSlotContent,
                  dataContext: { context: 'workspace' },
                  providerWrapper: 'WorkspaceProvider',
                }
                await componentBuilder.compositionCollection.insertOne(newComposition)
                console.log('[ChatPanel:VirtualTool] ✅ Created workspace Composition via show_schema')
              }
            }
          } catch (err) {
            console.error('[ChatPanel:VirtualTool] ❌ Error handling show_schema:', err)
          }
        } else if (event.toolName === 'set_workspace') {
          // v2 architecture: Declarative workspace state
          // Sets workspace Composition to desired state based on panels array
          console.log('[ChatPanel:VirtualTool] 🏗️ Setting workspace state:', event.args)

          const args = event.args as {
            layout?: string
            panels?: Array<{ slot: string; section: string; config?: Record<string, unknown> }>
          }

          try {
            // Handle schemaName in config - DesignContainerSection reads from FeatureSession
            // This maintains compatibility with existing section components
            for (const panel of args.panels ?? []) {
              if (panel.config?.schemaName && featureId) {
                await platformFeatures?.featureSessionCollection?.updateOne(featureId, {
                  schemaName: panel.config.schemaName as string
                })
                console.log('[ChatPanel:VirtualTool] ✅ Updated session schemaName:', panel.config.schemaName)
              }
            }

            // Build slotContent from panels - use section field directly
            const slotContent = (args.panels ?? []).map(panel => ({
              slot: panel.slot,
              section: panel.section, // Direct section name (toSlotSpecs handles resolution)
              config: panel.config ?? {},
            }))

            // Update or create composition
            if (componentBuilder?.compositionCollection) {
              const workspaceComposition = componentBuilder.compositionCollection.findByName?.('workspace')
              if (workspaceComposition) {
                const updates: Record<string, unknown> = { slotContent }
                if (args.layout && LAYOUT_TO_TEMPLATE[args.layout]) {
                  updates.layout = LAYOUT_TO_TEMPLATE[args.layout]
                }
                await componentBuilder.compositionCollection.updateOne(workspaceComposition.id, updates)
                console.log('[ChatPanel:VirtualTool] ✅ Workspace updated via set_workspace')
              } else {
                // Create the workspace composition if it doesn't exist
                // This allows new projects to have workspace layouts set up by the AI
                const layoutTemplate = args.layout && LAYOUT_TO_TEMPLATE[args.layout]
                  ? LAYOUT_TO_TEMPLATE[args.layout]
                  : 'layout-workspace-flexible'
                const newComposition = {
                  id: `composition-workspace-${Date.now()}`,
                  name: 'workspace',
                  layout: layoutTemplate,
                  slotContent,
                  dataContext: { context: 'workspace' },
                  providerWrapper: 'WorkspaceProvider',
                }
                await componentBuilder.compositionCollection.insertOne(newComposition)
                console.log('[ChatPanel:VirtualTool] ✅ Created workspace Composition via set_workspace')
              }
            }
          } catch (err) {
            console.error('[ChatPanel:VirtualTool] ❌ Error handling set_workspace:', err)
          }
        } else if (event.toolName === 'execute') {
          // v2 architecture: Generic domain operations
          // Executes state operations across domain stores
          console.log('[ChatPanel:VirtualTool] ⚡ Executing operations:', event.args)

          const args = event.args as {
            operations?: Array<{
              domain: string
              action: 'create' | 'update' | 'delete' | 'load'
              model: string
              id?: string
              data?: Record<string, unknown>
            }>
          }

          const domains: Record<string, any> = {
            'component-builder': componentBuilder,
            'studio-chat': studioChat,
            'platform-features': platformFeatures,
          }

          for (const op of args.operations ?? []) {
            try {
              const store = domains[op.domain]
              if (!store) {
                console.warn(`[ChatPanel:VirtualTool] ⚠️ Unknown domain: ${op.domain}`)
                continue
              }

              // Get collection by model name (e.g., "Composition" -> compositionCollection)
              const collectionName = `${op.model.charAt(0).toLowerCase()}${op.model.slice(1)}Collection`
              const collection = store[collectionName]
              if (!collection) {
                console.warn(`[ChatPanel:VirtualTool] ⚠️ Unknown collection: ${collectionName}`)
                continue
              }

              switch (op.action) {
                case 'create':
                  await collection.insertOne(op.data)
                  console.log(`[ChatPanel:VirtualTool] ✅ Created: ${op.domain}.${op.model}`)
                  break
                case 'update':
                  if (op.id) {
                    await collection.updateOne(op.id, op.data)
                    console.log(`[ChatPanel:VirtualTool] ✅ Updated: ${op.domain}.${op.model} id=${op.id}`)
                  }
                  break
                case 'delete':
                  if (op.id) {
                    await collection.deleteOne(op.id)
                    console.log(`[ChatPanel:VirtualTool] ✅ Deleted: ${op.domain}.${op.model} id=${op.id}`)
                  }
                  break
                case 'load':
                  // Load collection data via query() into client store
                  if (collection.query) {
                    const results = await collection.query().toArray()
                    console.log(`[ChatPanel:VirtualTool] ✅ Loaded: ${op.domain}.${op.model} (${results?.length ?? 0} items)`)
                  } else {
                    console.warn(`[ChatPanel:VirtualTool] ⚠️ Collection ${collectionName} doesn't support query`)
                  }
                  break
              }
            } catch (err) {
              console.error(`[ChatPanel:VirtualTool] ❌ Error executing ${op.action} on ${op.domain}.${op.model}:`, err)
            }
          }
        } else {
          console.warn('[ChatPanel:VirtualTool] ⚠️ Unknown virtual tool:', event.toolName)
        }
      }

      // Handle subagent progress events (task-subagent-progress-streaming)
      // AI SDK 6.x uses data-{name} format: { type: 'data-progress', id, data }
      if (dataPart.type === 'data-progress') {
        const event = (dataPart as any).data as SubagentProgressEvent

        // Create unique event ID for deduplication
        // Events can arrive via onData and also appear in message.parts (processed by useEffect)
        const eventId = event.type === 'tool-complete'
          ? `tool:${event.toolUseId}`
          : `${event.type}:${event.agentId}`

        // Skip if already processed (prevents infinite loops from duplicate handlers)
        if (processedProgressEventsRef.current.has(eventId)) {
          return
        }
        processedProgressEventsRef.current.add(eventId)

        console.log('[ChatPanel:Progress] 📥 Received progress event:', event)

        if (event.type === 'subagent-start') {
          setActiveSubagents((prev) => {
            const next = new Map(prev)
            console.log('[ChatPanel:Progress] 🚀 Adding subagent to active map:', event.agentId, event.agentType)
            next.set(event.agentId, {
              agentId: event.agentId,
              agentType: event.agentType,
              startTime: event.timestamp,
              status: 'running',
              toolCount: 0,
            })
            console.log('[ChatPanel:Progress] 📊 Active subagents count:', next.size)
            return next
          })
        } else if (event.type === 'subagent-stop') {
          setActiveSubagents((prev) => {
            const next = new Map(prev)
            const existing = next.get(event.agentId)
            console.log('[ChatPanel:Progress] 🛑 Stopping subagent:', event.agentId, 'existing:', !!existing)
            if (existing) {
              next.set(event.agentId, { ...existing, status: 'completed' })
            }
            console.log('[ChatPanel:Progress] 📊 Active subagents count:', next.size)
            return next
          })
        } else if (event.type === 'tool-complete') {
          console.log('[ChatPanel:Progress] 🔧 Tool complete:', event.toolName)
          // Add to recent tools list (for live display in SubagentPanel)
          setRecentTools((prev) => {
            const newTool: RecentToolCall = {
              id: event.toolUseId,
              toolName: event.toolName,
              timestamp: event.timestamp,
            }
            const updated = [newTool, ...prev].slice(0, MAX_RECENT_TOOLS)
            return updated
          })
          // Accumulate for timeline persistence (task-chat-ux-fix)
          setAccumulatedSubagentTools((prev) => {
            return [
              ...prev,
              {
                id: event.toolUseId,
                toolName: event.toolName,
                category: getToolCategoryFromTools(event.toolName),
                state: "success" as const,
                timestamp: event.timestamp,
              },
            ]
          })
          // Increment tool count on all running subagents
          setActiveSubagents((prev) => {
            const next = new Map(prev)
            for (const [id, subagent] of next) {
              if (subagent.status === 'running') {
                next.set(id, { ...subagent, toolCount: subagent.toolCount + 1 })
              }
            }
            return next
          })
        }
      }
    },
    onFinish: async ({ message }) => {
      // chat-session-sync-fix: v3 API callback receives { message, messages, isAbort, ... } options object
      // Must destructure message from options - NOT receive message directly like v1/v2
      
      const contentLength = message.content?.length ?? message.parts?.length ?? 0

      // chat-session-sync-fix: v3 API - Session ID from message.metadata
      // Server's messageMetadata callback sends ccSessionId via SSE message-metadata event
      const newCcSessionId = (message as any).metadata?.ccSessionId as string | undefined

      // chat-session-sync-fix: Update ref IMMEDIATELY to prevent race condition
      // React state updates are async, but the ref must be current for the next
      // sendMessage() call. Without this, rapid user input (e.g., "yes" right after
      // first response) would use stale/undefined ccSessionId, creating a new
      // Claude Code session instead of resuming the existing one.
      if (newCcSessionId && currentSessionId) {
        // CRITICAL: Update ref BEFORE async operations to prevent race condition
        ccSessionIdRef.current = newCcSessionId
        try {
          await studioChat.chatSessionCollection.update(currentSessionId, {
            claudeCodeSessionId: newCcSessionId,
          })
          // Update state after successful persistence (for React re-render)
          setCcSessionId(newCcSessionId)
        } catch (err) {
          // Persistence failed - revert ref to prevent broken resume attempts
          ccSessionIdRef.current = ccSessionId
          console.error("[ChatPanel] CRITICAL: CC session ID persistence failed:", err)
        }
      }

      // Persist assistant message in onFinish callback
      // NOTE: All persistence operations are fire-and-forget to prevent hanging
      // if backend is slow. The UI already shows the message, persistence is just logging.
      if (currentSessionId) {
        // Fire-and-forget: persist assistant message
        // chat-session-sync-fix: Use extractTextContent for v3 API compatibility
        // feat-toolcall-rendering-on-reload: Serialize parts for tool call rendering on reload
        const partsJson = hasToolCalls(message)
          ? serializeParts((message as any).parts)
          : undefined
        actions.addMessage({
          sessionId: currentSessionId,
          role: "assistant",
          content: extractTextContent(message),
          parts: partsJson,
        }).catch((err) => {
          console.warn("[ChatPanel] Failed to persist assistant message:", err)
        })

        // Refresh credit balance after every message (credits are deducted server-side)
        // Fire-and-forget: this updates the MobX store which reactively updates
        // WorkspaceSwitcher, ProjectNameDropdown, and other credit displays
        refetchCreditLedger()

        // Smart Query Triggers (task-3-1-004)
        // After streaming completes, detect tool calls and trigger targeted data refreshes
        const toolCalls = extractToolCalls(message)
        if (toolCalls.length > 0) {
          // Collect refresh targets by schema
          const platformFeaturesCollections: string[] = []
          const componentBuilderCollections: string[] = []
          let needsSchemaRefresh = false

          for (const toolCall of toolCalls) {
            // Only process successful tool calls
            if (toolCall.state !== "output-available") {
              continue
            }

            // Check for schema refresh needs
            if (requiresSchemaRefresh(toolCall)) {
              needsSchemaRefresh = true
            }

            // Get refresh target with schema routing
            const target = getRefreshTarget(toolCall)
            if (target) {
              if (target.schema === "component-builder") {
                componentBuilderCollections.push(...target.collections)
              } else {
                platformFeaturesCollections.push(...target.collections)
              }
            }
          }

          // Trigger schema refresh if needed (via callback prop)
          if (needsSchemaRefresh && onSchemaRefresh) {
            onSchemaRefresh()
          }

          // Trigger collection refreshes in parallel (fire-and-forget)
          // NOTE: No await to prevent onFinish from hanging if collection queries
          // take too long. Smart refresh is background data sync.
          if (platformFeaturesCollections.length > 0) {
            refreshCollections(platformFeatures, platformFeaturesCollections, "platformFeatures").catch((err) => {
              console.warn("[ChatPanel] Smart refresh (platformFeatures) failed:", err)
            })
          }
          if (componentBuilderCollections.length > 0) {
            refreshCollections(componentBuilder, componentBuilderCollections, "componentBuilder").catch((err) => {
              console.warn("[ChatPanel] Smart refresh (componentBuilder) failed:", err)
            })
          }

          // Also trigger full refresh via onRefresh callback (task-3-1-007)
          // This ensures all collections are refreshed after tool calls complete
          // NOTE: Fire-and-forget (no await) to prevent onFinish from hanging
          // if collection queries take too long. The refresh is just a background
          // data sync and shouldn't block the streaming completion.
          if (onRefresh) {
            onRefresh().catch((err) => {
              console.warn("[ChatPanel] onRefresh callback failed:", err)
            })
          }

          // Notify code panel of file changes (for auto-refresh)
          // Detects Write, Edit, StrReplace, template.copy and notifies parent
          if (onFilesChanged) {
            const modifiedPaths = getModifiedFilePaths(toolCalls)
            if (modifiedPaths.length > 0) {
              console.log("[ChatPanel] 📁 Files modified by agent:", modifiedPaths)
              onFilesChanged(modifiedPaths)
            }
          }
        }
      }
    },
  })

  // Derive isStreaming from v3 status for backward compatibility
  const isStreaming = status === 'streaming' || status === 'submitted'

  // Notify parent when chat error changes (for RuntimePreviewPanel to stop loading)
  useEffect(() => {
    onChatError?.(error ?? null)
  }, [error, onChatError])

  // Optimistic first message for homepage transition: show user message before useChat adds it
  const [pendingInitialMessage, setPendingInitialMessage] = useState<string | null>(null)

  // Persist initialMessage in a ref so we never lose it for display (survives re-renders/prop changes)
  const initialMessageRef = useRef<string | undefined>(undefined)
  if (initialMessage != null && initialMessage.trim() !== '') {
    initialMessageRef.current = initialMessage
  }

  // Clear pending once real messages arrive (avoids duplicate and keeps list in sync)
  useEffect(() => {
    if (messages.length > 0 && pendingInitialMessage !== null) {
      setPendingInitialMessage(null)
    }
  }, [messages.length, pendingInitialMessage])

  // Display messages: use real messages, or single optimistic user message when transitioning from homepage
  // Prefer ref so the first message stays visible even if parent stops passing initialMessage
  const displayMessages = useMemo((): Message[] => {
    if (messages.length > 0) return messages
    const text = (pendingInitialMessage ?? initialMessage ?? initialMessageRef.current ?? '').trim()
    if (text !== '') {
      return [
        {
          id: 'initial-optimistic',
          role: 'user',
          content: text,
        } as Message,
      ]
    }
    return []
  }, [messages, pendingInitialMessage, initialMessage])

  // Ref to track streaming status for effects that shouldn't re-run on streaming changes
  // but need to check current streaming state (e.g., message sync guard)
  const isStreamingRef = useRef(false)
  isStreamingRef.current = isStreaming

  // Idle timeout to force-complete hung streams
  // When Claude Code invokes skills/tools, the stream can hang indefinitely
  // because onFinish never fires. This detects idle state and calls stop().
  const idleTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastMessageContentRef = useRef<string>("")
  const IDLE_TIMEOUT_MS = 180000 // 3 minutes of no new content = consider complete (increased for template_copy)

  useEffect(() => {
    // Get current content to track changes
    const currentContent = messages.map(m => m.content).join("")

    if (isStreaming) {
      // Clear existing timeout
      if (idleTimeoutRef.current) {
        clearTimeout(idleTimeoutRef.current)
      }

      // Check if content changed
      if (currentContent !== lastMessageContentRef.current) {
        lastMessageContentRef.current = currentContent
      }

      // Set new timeout
      idleTimeoutRef.current = setTimeout(() => {
        if (isStreaming) {
          console.warn("[ChatPanel] Stream idle timeout - forcing stop()")
          stop()
        }
      }, IDLE_TIMEOUT_MS)
    } else {
      // Not loading - clear timeout
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
  }, [isStreaming, messages, stop])

  // Process progress events from message parts (task-subagent-progress-streaming)
  useEffect(() => {
    const latestMessage = messages[messages.length - 1]
    if (!latestMessage || latestMessage.role !== 'assistant') return

    const parts = (latestMessage as any).parts as any[] | undefined
    if (!parts) {
      return
    }

    parts.forEach((part) => {
      // Handle session ID from server (SDK workaround - session ID comes via custom event, not metadata)
      if (part.type === 'data-session') {
        const sessionData = part.data as { ccSessionId: string }
        if (sessionData.ccSessionId && !ccSessionIdRef.current) {
          ccSessionIdRef.current = sessionData.ccSessionId
          setCcSessionId(sessionData.ccSessionId)
          // Persist to session if available
          if (currentSessionId) {
            studioChat.chatSessionCollection.update(currentSessionId, {
              claudeCodeSessionId: sessionData.ccSessionId,
            }).catch((error) => {
              console.error('[ChatPanel:Session] Failed to persist session ID:', error)
            })
          }
        }
      }

      if (part.type === 'data-progress') {
        const event = part.data as SubagentProgressEvent

        // Create unique event ID for deduplication (same logic as onData handler)
        const eventId = event.type === 'tool-complete'
          ? `tool:${event.toolUseId}`
          : `${event.type}:${event.agentId}`

        // Skip if already processed by onData handler (prevents infinite loops)
        if (processedProgressEventsRef.current.has(eventId)) {
          return
        }
        processedProgressEventsRef.current.add(eventId)

        if (event.type === 'subagent-start') {
          setActiveSubagents((prev) => {
            const next = new Map(prev)
            next.set(event.agentId, {
              agentId: event.agentId,
              agentType: event.agentType,
              startTime: event.timestamp,
              status: 'running',
              toolCount: 0,
            })
            return next
          })
        } else if (event.type === 'subagent-stop') {
          setActiveSubagents((prev) => {
            const next = new Map(prev)
            const existing = next.get(event.agentId)
            if (existing) {
              next.set(event.agentId, { ...existing, status: 'completed' })
            }
            return next
          })
        } else if (event.type === 'tool-complete') {
          // Add to recent tools list (for live display in SubagentPanel)
          setRecentTools((prev) => {
            const newTool: RecentToolCall = {
              id: event.toolUseId,
              toolName: event.toolName,
              timestamp: event.timestamp,
            }
            const updated = [newTool, ...prev].slice(0, MAX_RECENT_TOOLS)
            return updated
          })
          // Accumulate for timeline persistence (task-chat-ux-fix)
          setAccumulatedSubagentTools((prev) => {
            return [
              ...prev,
              {
                id: event.toolUseId,
                toolName: event.toolName,
                category: getToolCategoryFromTools(event.toolName),
                state: "success" as const,
                timestamp: event.timestamp,
              },
            ]
          })
          // Increment tool count on all running subagents
          setActiveSubagents((prev) => {
            const next = new Map(prev)
            for (const [id, subagent] of next) {
              if (subagent.status === 'running') {
                next.set(id, { ...subagent, toolCount: subagent.toolCount + 1 })
              }
            }
            return next
          })
        }
      }
    })
    // PERF FIX: Removed studioChat.chatSessionCollection from deps - it's a MobX observable
    // object reference that changes on every store update, causing an infinite re-render loop.
    // We only need messages and currentSessionId to process progress events.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, currentSessionId])

  // Linger duration for completed subagents (ms) - keeps panel visible after completion
  const SUBAGENT_LINGER_MS = 2500

  // PERF FIX: Track which subagent IDs have scheduled cleanup to prevent duplicate timeouts
  // Without this, the effect would re-run when activeSubagents changes (from timeout callbacks),
  // creating new timeouts for the same subagents and causing memory leaks.
  const scheduledCleanupRef = useRef<Set<string>>(new Set())
  const toolsCleanupScheduledRef = useRef<boolean>(false)

  // Delayed cleanup of completed subagents after stream ends (task-subagent-progress-streaming)
  // Instead of clearing immediately, we keep completed subagents visible for a few seconds
  // so users can see the final state before the panel disappears
  useEffect(() => {
    if (!isStreaming) {
      // Set timeouts for each completed subagent (only if not already scheduled)
      const timeoutIds: ReturnType<typeof setTimeout>[] = []

      activeSubagents.forEach((subagent, id) => {
        if (subagent.status === 'completed' && !scheduledCleanupRef.current.has(id)) {
          // Mark as scheduled BEFORE creating timeout to prevent duplicates
          scheduledCleanupRef.current.add(id)
          const timeoutId = setTimeout(() => {
            scheduledCleanupRef.current.delete(id) // Allow re-scheduling if needed
            setActiveSubagents((prev) => {
              const next = new Map(prev)
              next.delete(id)
              return next
            })
          }, SUBAGENT_LINGER_MS)
          timeoutIds.push(timeoutId)
        }
      })

      // Delay clearing recent tools to match subagent visibility (only once per stream end)
      if (!toolsCleanupScheduledRef.current && recentTools.length > 0) {
        toolsCleanupScheduledRef.current = true
        const toolsTimeoutId = setTimeout(() => {
          toolsCleanupScheduledRef.current = false
          setRecentTools([])
        }, SUBAGENT_LINGER_MS)
        timeoutIds.push(toolsTimeoutId)
      }

      // Cleanup timeouts if component unmounts or isStreaming changes
      return () => {
        timeoutIds.forEach((id) => clearTimeout(id))
      }
    } else {
      // Stream started - reset scheduled cleanup tracking
      scheduledCleanupRef.current.clear()
      toolsCleanupScheduledRef.current = false
    }
  }, [isStreaming, activeSubagents, recentTools.length])

  // Clear accumulated tools when a new stream starts (task-chat-ux-fix)
  // We use a ref to track the previous isStreaming state to detect stream start
  const prevIsStreamingRef = useRef(false)
  useEffect(() => {
    // Detect stream start: isStreaming transitions from false to true
    if (isStreaming && !prevIsStreamingRef.current) {
      setAccumulatedSubagentTools([])
    }
    prevIsStreamingRef.current = isStreaming
  }, [isStreaming])

  // Detect template_copy tool invocation and notify parent for preview overlay
  // This provides UX feedback during the template copy process
  const prevActiveTemplateCopyRef = useRef<string | null>(null)
  useEffect(() => {
    if (!onActiveToolCall) return
    
    // Look for template_copy tool in the latest assistant message
    const latestMessage = messages[messages.length - 1]
    if (!latestMessage || latestMessage.role !== 'assistant') {
      // No assistant message - clear any active tool
      if (prevActiveTemplateCopyRef.current !== null) {
        onActiveToolCall(null)
        prevActiveTemplateCopyRef.current = null
      }
      return
    }
    
    // Extract tool calls from the message
    const toolCalls = extractToolCalls(latestMessage)
    
    // Find any template_copy that is actively running (not yet completed)
    const activeTemplateCopy = toolCalls.find(tc => {
      const normalizedName = tc.toolName.includes('__') 
        ? tc.toolName.split('__').pop() 
        : tc.toolName
      const isTemplateTool = normalizedName === 'template_copy' || normalizedName === 'template.copy'
      const isRunning = tc.state === 'input-streaming' || tc.state === 'input-available'
      return isTemplateTool && isRunning
    })
    
    if (activeTemplateCopy) {
      // Template copy is running
      if (prevActiveTemplateCopyRef.current !== activeTemplateCopy.toolName) {
        console.log('[ChatPanel] 📦 Template copy started:', activeTemplateCopy.toolName)
        onActiveToolCall(activeTemplateCopy.toolName)
        prevActiveTemplateCopyRef.current = activeTemplateCopy.toolName
      }
    } else if (prevActiveTemplateCopyRef.current !== null) {
      // Template copy finished or no longer active
      console.log('[ChatPanel] 📦 Template copy completed')
      onActiveToolCall(null)
      prevActiveTemplateCopyRef.current = null
    }
  }, [messages, onActiveToolCall])

  // Effect 1: Trigger data loading for chat messages from API
  // loadAll() calls APIPersistence which fetches from REST API with sessionId filter
  // fix-chat-history-reload: After loading, directly sync to AI SDK to avoid
  // relying on the reactive MobX chain which has many guards that can prevent sync.
  useEffect(() => {
    if (currentSessionId && !isLoadingMessagesRef.current) {
      isLoadingMessagesRef.current = true
      setIsInitialLoadComplete(false)
      console.log('[ChatPanel] Loading messages for session:', currentSessionId)
      studioChat.chatMessageCollection.loadAll({ sessionId: currentSessionId })
        .then((result: any) => {
          // SDK collection returns array directly
          const count = Array.isArray(result) ? result.length : 0
          console.log('[ChatPanel] Loaded', count, 'messages for session:', currentSessionId)

          // fix-chat-history-reload: Directly sync loaded messages to AI SDK
          // This is more reliable than depending on the reactive MobX → Effect 2 chain
          // which has guards (isStreaming, isSending, messages.length > 0) that can block sync.
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
              console.log('[ChatPanel] Direct sync: setting', aiMessages.length, 'messages to AI SDK')
              setMessages(aiMessages)
              // Scroll to bottom after messages load
              setTimeout(() => {
                messagesEndRef.current?.scrollIntoView({ behavior: 'instant', block: 'end' })
              }, 50)
            }
          }
        })
        .catch((err: any) => console.error('[ChatPanel] Failed to load messages:', err))
        .finally(() => {
          isLoadingMessagesRef.current = false
          setIsInitialLoadComplete(true)
        })
    } else if (!currentSessionId) {
      // No session yet - mark load as complete so we show empty state
      setIsInitialLoadComplete(true)
    }
  }, [currentSessionId, studioChat, setMessages])

  // feat-chat-tool-interleaving: Track if we've received messages with parts (tool calls)
  // Once we have parts from streaming, we shouldn't overwrite with persisted data
  const hasReceivedPartsRef = useRef(false)

  // Update the ref when messages change - check if any have parts
  useEffect(() => {
    const hasParts = messages.some((msg: any) =>
      Array.isArray(msg.parts) && msg.parts.length > 0
    )
    if (hasParts) {
      hasReceivedPartsRef.current = true
    }
  }, [messages])

  // Reset refs when session changes
  useEffect(() => {
    hasReceivedPartsRef.current = false
    processedProgressEventsRef.current.clear()
    // Reset loading state so we show loading indicator for new session
    setIsInitialLoadComplete(false)
  }, [currentSessionId])

  // Effect 2: Sync MobX → AI SDK state when data arrives
  // persistedMessagesFromMobX is derived from MobX (reactive due to observer)
  // Using length as a stable primitive dep to detect when data changes
  //
  // feat-chat-tool-interleaving: Guard against overwriting messages that have parts
  // During/after streaming, useChat messages have a `parts` array with tool-invocations.
  // Persisted messages only have `content` (no parts). If we blindly overwrite,
  // tool calls disappear because parts are lost.
  useEffect(() => {
    if (persistedMessagesFromMobX.length > 0) {
      // Don't overwrite during active streaming - calling setMessages while AI SDK
      // is streaming causes "Maximum update depth exceeded" as our state update
      // conflicts with the SDK's internal replaceMessage calls
      if (isStreamingRef.current) {
        return
      }

      // Fix for duplicate message bug: Skip sync while sending a message
      // When sending from homepage, we persist optimistically before AI SDK adds its own message
      // This prevents the sync effect from adding the MobX message while AI SDK is adding its own
      if (isSendingMessageRef.current) {
        return
      }

      // Fix for duplicate message bug: Only sync on initial load when AI SDK has no messages
      // During active session, AI SDK already has messages from sendMessage()
      // This prevents duplicate messages from ID mismatch between MobX (ID-A) and AI SDK (ID-B)
      if (messages.length > 0) {
        console.log('[ChatPanel] Skipping message sync - AI SDK already has messages (active session)')
        return
      }

      // Don't overwrite if we've received streaming parts - they contain live tool invocations
      // that would be lost. But DO allow if persisted messages have parts (reload scenario).
      // feat-toolcall-rendering-on-reload: Check if persisted messages have parts
      const persistedHaveParts = persistedMessagesFromMobX.some((msg: any) => msg.parts)
      if (hasReceivedPartsRef.current && !persistedHaveParts) {
        console.log('[ChatPanel] Skipping message sync - streaming parts would be overwritten')
        return
      }
      // Reset the ref if we're loading persisted parts (reload scenario)
      if (persistedHaveParts) {
        hasReceivedPartsRef.current = false
      }

      // feat-toolcall-rendering-on-reload: Reconstruct parts array from persisted JSON
      const aiMessages = persistedMessagesFromMobX.map((msg: any) => {
        const baseMessage: any = {
          id: msg.id,
          role: msg.role as "user" | "assistant",
          content: msg.content,
        }

        // Reconstruct parts array if persisted (enables tool rendering on reload)
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
      // Scroll to bottom after messages load - use setTimeout to ensure DOM has rendered
      setTimeout(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'instant', block: 'end' })
      }, 50)
    } else if (currentSessionId) {
      // Don't clear during homepage transition: we show an optimistic first message from initialMessage.
      // Clearing here would leave messages=[], and we'd rely on displayMessages; avoid the clear so we don't trigger flicker.
      if (initialMessageRef.current?.trim()) {
        return
      }
      setMessages([])
    }
    // Note: persistedMessagesFromMobX.length used as stable primitive dep
    // currentSessionId ensures effect runs on session switch even with same count
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentSessionId, persistedMessagesFromMobX.length, setMessages])

  // Notify parent of streaming state changes (task-3-1-007)
  // This allows WorkspaceLayout to pause polling during active streaming
  useEffect(() => {
    onStreamingChange?.(isStreaming)
  }, [isStreaming, onStreamingChange])

  // Auto-scroll to bottom when messages change or streaming updates
  // Uses smooth scrolling during streaming, instant on first load
  // Respects user scroll intent - won't auto-scroll if user scrolled up
  const isFirstLoadRef = useRef(true)

  // Reset first load flag when session changes to ensure scroll to bottom
  useEffect(() => {
    isFirstLoadRef.current = true
    isUserAtBottomRef.current = true
  }, [currentSessionId])

  // Track scroll position to detect user scroll intent
  useEffect(() => {
    const container = scrollContainerRef.current
    if (!container) return

    const handleScroll = () => {
      const { scrollTop, scrollHeight, clientHeight } = container
      // Consider "at bottom" if within 100px of bottom
      isUserAtBottomRef.current = scrollHeight - scrollTop - clientHeight < 100
    }

    container.addEventListener('scroll', handleScroll)
    return () => container.removeEventListener('scroll', handleScroll)
  }, [])

  // Auto-scroll effect - respects user position
  // First message at top: when only one message, scroll to top so first message is at top and agent builds below
  // When 2+ messages (e.g. first response arrived), scroll to bottom so response is visible
  // If user has scrolled up (isUserAtBottomRef=false), we do NOT force-scroll back down
  useEffect(() => {
    const container = scrollContainerRef.current
    if (!container) return

    if (displayMessages.length === 1 && (isFirstLoadRef.current || isUserAtBottomRef.current)) {
      requestAnimationFrame(() => {
        container.scrollTop = 0
        isFirstLoadRef.current = false
      })
      return
    }

    const shouldScrollToBottom =
      displayMessages.length > 1 &&
      (isFirstLoadRef.current || isUserAtBottomRef.current)

    if (messagesEndRef.current && shouldScrollToBottom) {
      requestAnimationFrame(() => {
        const behavior = isFirstLoadRef.current ? 'instant' : 'smooth'
        messagesEndRef.current?.scrollIntoView({ behavior, block: 'end' })
        isFirstLoadRef.current = false
      })
    }
  }, [displayMessages.length, messages, currentSessionId])

  // Detect if there's a pending AskUserQuestion in the messages
  // Used to show a hint in the chat input
  // A question is "pending" if it exists AND no user message has been sent after it
  const hasPendingQuestion = useMemo(() => {
    let lastAskUserQuestionIndex = -1

    // Find the last assistant message containing an AskUserQuestion
    for (let i = 0; i < messages.length; i++) {
      const message = messages[i]
      if (message.role !== 'assistant') continue

      const parts = (message as any).parts as any[] | undefined
      if (!parts) continue

      for (const part of parts) {
        const toolName = part.toolInvocation?.toolName || part.toolName
        if (toolName === 'AskUserQuestion') {
          lastAskUserQuestionIndex = i
          break
        }
      }
    }

    // No AskUserQuestion found
    if (lastAskUserQuestionIndex === -1) return false

    // Check if there's a user message AFTER the AskUserQuestion
    // If so, the user has already responded (question is no longer pending)
    for (let i = lastAskUserQuestionIndex + 1; i < messages.length; i++) {
      if (messages[i].role === 'user') {
        return false // User has responded
      }
    }

    // AskUserQuestion exists with no user response after it
    return true
  }, [messages])

  /**
   * Extract mediaType from a data URL.
   * Example: "data:image/png;base64,..." -> "image/png"
   */
  const extractMediaType = useCallback((dataUrl: string): string => {
    const match = dataUrl.match(/^data:([^;]+);/)
    return match?.[1] || "image/png" // Default to PNG if parsing fails
  }, [])

  // Internal function that actually sends a message (used by queue processor)
  // This is extracted from handleSendMessage to allow queue processing
  const sendMessageInternal = useCallback(
    async (content: string, imageData?: string[], selectedAgentMode?: AgentMode) => {
      if (!currentSessionId) {
        console.warn("[ChatPanel] No session ID - message will be lost!")
        return
      }

      // Normalize imageData to array for processing (backward compatibility)
      const imageArray = imageData || []

      if (!content.trim() && imageArray.length === 0) {
        return
      }

      const trimmedContent = content.trim()

      // task-chat-retry-fix: Store input for potential retry
      lastUserInputRef.current = { content: trimmedContent, imageData: imageArray }

      // Build parts array for user message to preserve all images on reload
      // Parts array format: [{ type: "text", text: "..." }, { type: "file", mediaType: "...", url: "..." }]
      const parts: Array<{ type: "text"; text: string } | { type: "file"; mediaType: string; url: string }> = []
      
      // Add text part if content exists
      if (trimmedContent) {
        parts.push({ type: "text", text: trimmedContent })
      }
      
      // Add file parts for all images
      imageArray.forEach((dataUrl) => {
        parts.push({
          type: "file",
          mediaType: extractMediaType(dataUrl),
          url: dataUrl,
        })
      })

      // Fix for duplicate message bug: Set flag to prevent sync effect from running
      // while we're sending a message. This prevents the sync effect from adding the
      // MobX message while AI SDK is adding its own message.
      isSendingMessageRef.current = true

      // Persist user message to local store (fire-and-forget)
      // task-chatpanel-sendmessage: Include imageData and parts array
      // Store first image for backward compatibility with single imageData field
      // Store parts array as JSON string to preserve all images on reload
      actions.addMessage({
        sessionId: currentSessionId,
        role: "user",
        content: trimmedContent,
        imageData: imageArray.length > 0 ? imageArray[0] : undefined,
        parts: parts.length > 0 ? JSON.stringify(parts) : undefined,
      }).catch((err) => console.warn("[ChatPanel] Failed to persist user message:", err))

      // Build the sendMessage options
      // task-chatpanel-sendmessage: Construct FileUIPart when image is attached
      // Support multiple images by creating files array
      const messagePayload: { text: string; files?: Array<{ type: "file"; mediaType: string; url: string }> } = {
        text: trimmedContent,
      }

      if (imageArray.length > 0) {
        messagePayload.files = imageArray.map((dataUrl) => ({
          type: "file" as const,
          mediaType: extractMediaType(dataUrl),
          url: dataUrl,
        }))
      }

      // chat-session-sync-fix: Send via v3 sendMessage() API
      // - First arg: { text, files? } object
      // - Second arg: options with body for server-side data
      // - ccSessionIdRef.current ensures fresh session ID value
      // credit-tracking: Include workspaceId and userId for credit deduction
      // theme-integration: Include theme context for AI-aware styling
      // agent-mode: Include agentMode for model selection (basic=haiku, advanced=sonnet)
      try {
        // Get current theme context for AI-aware code generation
        const themeContext = getThemePromptContext()
        
        await sendMessage(
          messagePayload,
          {
            body: {
              featureId,
              phase,
              ccSessionId: ccSessionIdRef.current,
              workspaceId,
              userId,
              projectId,
              themeContext,
              agentMode: selectedAgentMode || agentMode,
            },
          }
        )
      } catch (err) {
        console.error("[ChatPanel] Failed to send message:", err)
        throw err // Re-throw to allow queue processor to handle errors
      } finally {
        // Clear the flag after sendMessage completes (AI SDK has added the message)
        // Since we await sendMessage, the AI SDK should have already added the message
        // The existing guard (messages.length > 0) will prevent sync if messages exist
        isSendingMessageRef.current = false
      }
    },
    [currentSessionId, studioChat, sendMessage, featureId, phase, extractMediaType, workspaceId, userId, projectId, agentMode, actions]
  )

  // Queue processor: processes messages one at a time, waiting for each to complete
  // This ensures messages are sent sequentially like in Cursor
  // IMPORTANT: sendMessageInternal must be called OUTSIDE setState updaters because
  // React StrictMode calls updater functions twice, which would duplicate sends.
  const processMessageQueue = useCallback(async () => {
    // Prevent concurrent processing
    if (isProcessingQueueRef.current) {
      return
    }

    // Wait for current streaming to complete
    if (isStreaming) {
      return
    }

    // Validate session exists before processing
    if (!currentSessionId) {
      return
    }

    // Nothing to process
    if (messageQueue.length === 0) {
      return
    }

    // Mark as processing to prevent re-entrant calls
    isProcessingQueueRef.current = true

    // Read the first message from the current state
    const nextMessage = messageQueue[0]

    // Remove it from the queue (pure updater — no side effects)
    setMessageQueue((queue) => queue.slice(1))

    // Send the message OUTSIDE the updater to avoid StrictMode double-invocation
    try {
      await sendMessageInternal(
        nextMessage.content,
        nextMessage.imageData,
        nextMessage.selectedAgentMode
      )
    } catch (err) {
      console.error("[ChatPanel] Error processing queued message:", err)
      // On error, clear processing flag so queue can continue
      isProcessingQueueRef.current = false
    }
  }, [isStreaming, sendMessageInternal, currentSessionId, messageQueue])

  // Process queue when streaming completes (status transitions from true → false)
  // This ensures we wait for the full response before processing the next message
  const queueStreamingRef = useRef(false)
  useEffect(() => {
    const wasStreaming = queueStreamingRef.current
    queueStreamingRef.current = isStreaming

    // Only act on a true → false transition (stream just finished)
    if (wasStreaming && !isStreaming) {
      isProcessingQueueRef.current = false
      if (messageQueue.length > 0 && currentSessionId) {
        processMessageQueue()
      }
    }
  }, [isStreaming, messageQueue.length, processMessageQueue, currentSessionId])

  // Clear queue when session changes to prevent sending to wrong session
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
    (messageId: string, direction: 'up' | 'down') => {
      setMessageQueue((queue) => {
        const index = queue.findIndex((m) => m.id === messageId)
        if (index === -1) return queue

        const newQueue = [...queue]
        if (direction === 'up' && index > 0) {
          ;[newQueue[index - 1], newQueue[index]] = [newQueue[index], newQueue[index - 1]]
        } else if (direction === 'down' && index < newQueue.length - 1) {
          ;[newQueue[index], newQueue[index + 1]] = [newQueue[index + 1], newQueue[index]]
        }
        return newQueue
      })
    },
    []
  )

  // chat-session-sync-fix: Handle message submission using v3 sendMessage() API
  // v3 uses sendMessage({ text }) instead of the old append-with-role pattern
  // task-chatpanel-sendmessage: Extended to support imageData parameter
  // Support multiple images: imageData is always an array (or undefined)
  // agent-mode: Extended to support agentMode parameter for model selection
  // message-queue: Messages are now queued and processed sequentially
  const handleSendMessage = useCallback(
    async (content: string, imageData?: string[], selectedAgentMode?: AgentMode) => {
      // Validate session exists
      if (!currentSessionId) {
        console.warn("[ChatPanel] No session ID - message will be lost!")
        return
      }

      // Normalize imageData to array for processing (backward compatibility)
      const imageArray = imageData || []

      if (!content.trim() && imageArray.length === 0) {
        return
      }

      const trimmedContent = content.trim()

      // If currently streaming or sending, add to queue
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

      // If not streaming, send immediately
      await sendMessageInternal(trimmedContent, imageArray, selectedAgentMode)
    },
    [isStreaming, sendMessageInternal, currentSessionId]
  )

  // Handle form submit from ChatInput
  // task-chatpanel-sendmessage: Extended to support imageData parameter
  // imageData is always an array (or undefined) for consistency
  // agent-mode: Extended to support agentMode parameter for model selection
  const handleInputSubmit = useCallback(
    (content: string, imageData?: string | string[], selectedAgentMode?: AgentMode) => {
      // Normalize to array format (backward compatibility with old single string format)
      const normalizedImageData = imageData 
        ? (Array.isArray(imageData) ? imageData : [imageData])
        : undefined
      handleSendMessage(content, normalizedImageData, selectedAgentMode)
    },
    [handleSendMessage]
  )

  // Homepage transition warm-start: Inject initial message on mount
  // Inject as soon as we have session (no wait for status === 'ready') to reduce lag
  // Show optimistic message immediately via pendingInitialMessage so first message is visible when overlay fades
  useEffect(() => {
    if (
      initialMessage &&
      currentSessionId &&
      !hasInjectedInitialMessageRef.current
    ) {
      hasInjectedInitialMessageRef.current = true
      setPendingInitialMessage(initialMessage)
      console.log('[ChatPanel] Injecting initial message from homepage transition:', initialMessage.slice(0, 50))
      handleSendMessage(initialMessage)
    }
  }, [initialMessage, currentSessionId, handleSendMessage])

  // Collapse toggle - persist to localStorage only when using internal state
  const handleToggleCollapse = useCallback(() => {
    const newCollapsed = !isCollapsed
    setIsCollapsed(newCollapsed)
    // Only persist to localStorage if using internal state (not controlled)
    if (!onCollapsedChange) {
      setStoredCollapsed(newCollapsed)
    }
  }, [isCollapsed, setIsCollapsed, onCollapsedChange])

  // Resize handlers using mousedown/mousemove/mouseup pattern
  const handleResizeMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      setIsResizing(true)
      resizeRef.current = {
        startX: e.clientX,
        startWidth: width,
      }

      const handleMouseMove = (moveEvent: MouseEvent) => {
        if (!resizeRef.current) return
        const delta = resizeRef.current.startX - moveEvent.clientX
        const newWidth = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, resizeRef.current.startWidth + delta))
        setWidth(newWidth)
        onWidthChange?.(newWidth)
      }

      const handleMouseUp = () => {
        setIsResizing(false)
        if (resizeRef.current) {
          const delta = resizeRef.current.startX - (window as any).lastMouseX || 0
          const finalWidth = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, resizeRef.current.startWidth + delta))
          setStoredWidth(finalWidth)
          onWidthChange?.(finalWidth)
        }
        resizeRef.current = null
        document.removeEventListener("mousemove", handleMouseMove)
        document.removeEventListener("mouseup", handleMouseUp)
      }

      // Track last mouse X for final width calculation
      const trackMouseMove = (moveEvent: MouseEvent) => {
        ; (window as any).lastMouseX = moveEvent.clientX
        handleMouseMove(moveEvent)
      }

      document.addEventListener("mousemove", trackMouseMove)
      document.addEventListener("mouseup", handleMouseUp)
    },
    [width, onWidthChange]
  )

  // Error retry handler (task-chat-retry-fix)
  // AI SDK v3: reload() regenerates the last assistant message
  // Only use reload() to avoid duplicating user messages
  const handleRetry = useCallback(() => {
    if (typeof reload === 'function' && messages.length > 0) {
      reload()
    } else {
      // Don't resend via handleSendMessage as it duplicates the user message.
      // Instead, suggest refreshing.
      console.warn('[ChatPanel] Cannot retry via reload. Please refresh the page.')
    }
  }, [reload, messages.length])

  // Convert messages for MessageList
  const messageListMessages = messages.map((msg) => ({
    id: msg.id,
    role: msg.role as "user" | "assistant",
    content: msg.content,
  }))

  // Context value for ChatContextProvider
  const contextValue: ChatContextValue = {
    currentSession: currentSession
      ? { id: currentSession.id, name: currentSession.name }
      : null,
    messages: messageListMessages,
    sendMessage: handleSendMessage,
    isLoading: isStreaming,
    isPolling, // task-3-1-008: Pass polling state to context for LoadingOverlay
    error: error?.message ?? null,
  }

  // Handle compact mode submit - delegates to parent since no session exists yet
  const handleCompactSubmit = useCallback((prompt: string, imageData?: string[]) => {
    // For now, only pass prompt to maintain backward compatibility
    // Image data handling can be added to onCompactSubmit interface if needed
    onCompactSubmit?.(prompt)
  }, [onCompactSubmit])

  // Render compact mode (homepage)
  if (mode === 'compact') {
    return (
      <CompactChatInput
        ref={inputContainerRef}
        onSubmit={handleCompactSubmit}
        isLoading={isStreaming}
        disabled={false}
        value={compactValue}
        onChange={onCompactValueChange}
        className={className}
        selectedThemeId={selectedThemeId}
        onSelectTheme={onSelectTheme}
        onCreateTheme={onCreateTheme}
      />
    )
  }

  // Render collapsed state
  if (isCollapsed) {
    return (
      <div className={cn("flex h-full", className)}>
        {/* Children take remaining space when collapsed */}
        {children && (
          <ChatContextProvider value={contextValue}>
            <div className="flex-1 min-w-0 overflow-hidden">{children}</div>
          </ChatContextProvider>
        )}
        <ExpandTab onExpand={handleToggleCollapse} />
      </div>
    )
  }

  // Note: Tool call extraction now handled by TurnList/useTurnGrouping (task-chat-008)

  return (
    <ChatContextProvider value={contextValue}>
      <div className={cn("flex h-full", className)}>
        {/* Main content area */}
        {children && (
          <div className="flex-1 min-w-0 overflow-hidden">{children}</div>
        )}

        {/* Chat Panel - shrink-0 prevents flexbox from shrinking below specified width */}
        <div
          className="flex flex-col border-l border-border bg-background relative shrink-0"
          style={{ width: `${width}px` }}
        >
        {/* Resize Handle */}
        <div
          className={cn(
            "absolute left-0 top-0 bottom-0 w-1 cursor-ew-resize hover:bg-primary/50 transition-colors",
            isResizing && "bg-primary/50"
          )}
          onMouseDown={handleResizeMouseDown}
        />

        {/* Header */}
        {/* <ChatHeader
          sessionName={currentSession?.name || featureName || "Chat"}
          isLoading={isStreaming}
          isCollapsed={isCollapsed}
          onToggleCollapse={handleToggleCollapse}
        /> */}

        {/* Messages with Turn Grouping (task-chat-008) */}
        {/* Use displayMessages so optimistic first message shows immediately on homepage transition */}
        <div ref={(el) => {
          // Callback ref to set both internal scrollContainerRef and external messageContainerRef
          (scrollContainerRef as React.MutableRefObject<HTMLDivElement | null>).current = el
          if (messageContainerRef) {
            (messageContainerRef as React.MutableRefObject<HTMLDivElement | null>).current = el
          }
        }} className="flex-1 overflow-y-auto p-4">
          {displayMessages.length > 0 ? (
            <>
              <TurnList
                messages={displayMessages}
                isStreaming={isStreaming}
                phase={phase}
                activeSubagents={Array.from(activeSubagents.values()) as SubagentProgressType[]}
                recentTools={recentTools as RecentToolType[]}
                subagentToolCalls={accumulatedSubagentTools}
              />
              {/* Scroll anchor - invisible element at bottom for auto-scroll */}
              <div ref={messagesEndRef} />
            </>
          ) : !isStreaming && !isInitialLoadComplete && currentSessionId ? (
            /* fix-chat-history-reload: Show loading indicator while fetching messages from API
               This prevents flashing "Start Discovery" before messages arrive on page reload */
            <div className="flex flex-col items-center justify-center h-full gap-3 text-muted-foreground">
              <div className="flex items-center gap-1">
                <span className="w-2 h-2 rounded-full bg-muted-foreground animate-pulse" />
                <span className="w-2 h-2 rounded-full bg-muted-foreground animate-pulse [animation-delay:0.2s]" />
                <span className="w-2 h-2 rounded-full bg-muted-foreground animate-pulse [animation-delay:0.4s]" />
              </div>
              <span className="text-xs">Loading conversation...</span>
            </div>
          ) : !isStreaming ? (
            /* Phase-contextual empty state (task-chat-008) */
            <PhaseEmptyState
              phase={phase}
              onSuggestionClick={handleSendMessage}
            />
          ) : (
            /* Loading state when no messages yet - show SubagentPanel if subagents active */
            <div className="space-y-3">
              {/* Subagent panel during initial loading (before first message arrives) */}
              {activeSubagents.size > 0 && (
                <SubagentPanel
                  subagents={Array.from(activeSubagents.values()) as SubagentProgressType[]}
                  recentTools={recentTools as RecentToolType[]}
                  defaultExpanded
                />
              )}
              {/* Loading indicator */}
              <div
                data-testid="loading-indicator"
                aria-label="Loading response"
                aria-busy="true"
                className="flex items-center gap-1 p-2"
              >
                <span className="w-2 h-2 rounded-full bg-muted-foreground animate-pulse" />
                <span className="w-2 h-2 rounded-full bg-muted-foreground animate-pulse [animation-delay:0.2s]" />
                <span className="w-2 h-2 rounded-full bg-muted-foreground animate-pulse [animation-delay:0.4s]" />
              </div>
              {/* Scroll anchor for loading state too */}
              <div ref={messagesEndRef} />
            </div>
          )}
        </div>

        {/* Error Alert */}
        {error && (
          <div className="px-4 pb-2">
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription className="flex items-center justify-between gap-2">
                <span className="text-sm">{formatErrorMessage(error.message)}</span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleRetry}
                  className="shrink-0"
                >
                  Retry
                </Button>
              </AlertDescription>
            </Alert>
          </div>
        )}

        {/* Input */}
        <div ref={inputContainerRef} className="border-t border-border/40">
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
            onStop={stop}
            agentMode={agentMode}
            onAgentModeChange={setAgentMode}
            isPro={hasActiveSubscription}
            onUpgradeClick={handleUpgradeClick}
            queuedMessages={messageQueue}
            onRemoveQueuedMessage={handleRemoveQueuedMessage}
            onReorderQueuedMessage={handleReorderQueuedMessage}
          />
        </div>
      </div>
      </div>
    </ChatContextProvider>
  )
})
