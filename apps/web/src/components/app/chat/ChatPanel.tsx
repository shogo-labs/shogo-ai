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
 * - Records tool calls via studioChat.recordToolCall
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
import { useDomains } from "@/contexts/DomainProvider"
import { cn } from "@/lib/utils"
import { ChatHeader } from "./ChatHeader"
import { MessageList } from "./MessageList"
import { ChatInput } from "./ChatInput"
import { ExpandTab } from "./ExpandTab"
import { ToolCallDisplay, type ToolCallState } from "./ToolCallDisplay"
import { ChatContextProvider, type ChatContextValue } from "./ChatContext"
// Chat Panel UX Redesign - New component imports (task-chat-008)
import { TurnList } from "./turns"
import { PhaseEmptyState } from "./empty"
import type { SubagentProgress as SubagentProgressType, RecentTool as RecentToolType } from "./subagent"
import { type ToolCallData, getToolCategory as getToolCategoryFromTools } from "./tools/types"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { AlertCircle } from "lucide-react"

// ============================================================
// Types
// ============================================================

// Progress event types from server (task-subagent-progress-streaming)
type SubagentProgressEvent =
  | { type: 'subagent-start'; agentId: string; agentType: string; timestamp: number }
  | { type: 'subagent-stop'; agentId: string; timestamp: number }
  | { type: 'tool-complete'; toolName: string; toolUseId: string; timestamp: number }

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

export interface ChatPanelProps {
  /** Feature session ID to link chat with */
  featureId: string | null
  /** Feature session name for display */
  featureName?: string
  /** Current phase from WorkspaceLayout navigation (task-cpbi-004) */
  phase: string | null
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
}

// ============================================================
// Constants
// ============================================================

const DEFAULT_WIDTH = 400
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
    .filter((part) => part.type === "tool-invocation")
    .map((part) => {
      const invocation = part.toolInvocation
      return {
        toolName: invocation?.toolName || "unknown",
        state: mapToolCallState(invocation?.state),
        args: invocation?.args,
        result: invocation?.result,
        error: invocation?.error,
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
      return "output-available"
    case "error":
      return "output-error"
    default:
      return "input-streaming"
  }
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
const MODEL_TO_COLLECTION_MAP: Record<string, string> = {
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
 * Determines which collections to refresh based on a tool call.
 * Returns collection names that should be refreshed via query().toArray().
 *
 * @param toolCall - Extracted tool call from AI message
 * @returns Array of collection names to refresh
 */
function getCollectionsToRefresh(toolCall: ExtractedToolCall): string[] {
  const { toolName, args } = toolCall
  const collections: string[] = []

  // Handle MCP tool naming: "mcp__wavesmith__store_create" -> "store_create"
  const normalizedToolName = toolName.includes("__")
    ? toolName.split("__").pop() || toolName
    : toolName

  switch (normalizedToolName) {
    case "store_create": {
      // store.create with model -> refresh that collection
      const model = args?.model as string | undefined
      if (model && MODEL_TO_COLLECTION_MAP[model]) {
        collections.push(MODEL_TO_COLLECTION_MAP[model])
      }
      break
    }

    case "store_update": {
      // store.update with model -> refresh that collection
      const model = args?.model as string | undefined
      if (model && MODEL_TO_COLLECTION_MAP[model]) {
        collections.push(MODEL_TO_COLLECTION_MAP[model])
      }
      break
    }

    case "store_delete": {
      // store.delete with model -> refresh that collection
      const model = args?.model as string | undefined
      if (model && MODEL_TO_COLLECTION_MAP[model]) {
        collections.push(MODEL_TO_COLLECTION_MAP[model])
      }
      break
    }

    // Note: schema_set and schema_load are handled separately via onSchemaRefresh callback
    default:
      break
  }

  return collections
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
 * Triggers collection refreshes for the given collection names.
 * Uses same query().toArray() pattern as useFeaturePolling for consistency.
 */
async function refreshCollections(
  platformFeatures: any,
  collectionNames: string[]
): Promise<void> {
  if (!platformFeatures || collectionNames.length === 0) {
    return
  }

  // Deduplicate collection names
  const uniqueCollections = [...new Set(collectionNames)]

  // Refresh all collections in parallel
  const refreshPromises = uniqueCollections.map(async (collectionName) => {
    const collection = platformFeatures[collectionName]
    if (collection?.query && typeof collection.query === "function") {
      try {
        await collection.query().toArray()
      } catch (err) {
        console.warn(`[ChatPanel] Failed to refresh ${collectionName}:`, err)
      }
    }
  })

  await Promise.all(refreshPromises)
}

// ============================================================
// Component
// ============================================================

export const ChatPanel = observer(function ChatPanel({
  featureId,
  featureName,
  phase,
  children,
  className,
  onSchemaRefresh,
  onRefresh,
  onStreamingChange,
  isPolling,
}: ChatPanelProps) {
  // Access domains for chat persistence and smart refresh
  const { studioChat, platformFeatures } = useDomains<{
    studioChat: any
    platformFeatures: any
  }>()

  // Panel state
  const [isCollapsed, setIsCollapsed] = useState(() => getStoredCollapsed())
  const [width, setWidth] = useState(() => getStoredWidth())
  const [isResizing, setIsResizing] = useState(false)
  const resizeRef = useRef<{ startX: number; startWidth: number } | null>(null)

  // Chat session state
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null)

  // Claude Code session ID for continuity (task-cc-chatpanel-integration)
  // Initialized from existing session's claudeCodeSessionId on load
  const [ccSessionId, setCcSessionId] = useState<string | undefined>(undefined)

  // chat-session-sync-fix: Ref for latest ccSessionId value in callbacks
  // State updates are async, ref provides immediate access for append() calls
  const ccSessionIdRef = useRef<string | undefined>(undefined)

  // Find or create chat session for feature and phase (task-cpbi-005)
  // Session is uniquely identified by (featureId, phase) tuple
  useEffect(() => {
    if (!featureId) {
      setCurrentSessionId(null)
      return
    }

    // Use async IIFE for await support in useEffect
    const loadOrCreateSession = async () => {
      // Find existing session for this feature AND phase
      const existingSession = studioChat.chatSessionCollection.findByFeatureAndPhase?.(featureId, phase)
      if (existingSession) {
        setCurrentSessionId(existingSession.id)
      } else if (phase) {
        // Auto-create session with phase (async per task-cpbi-002)
        const newSession = await studioChat.createChatSession({
          inferredName: `${featureName || featureId} - ${phase}`,
          contextType: "feature",
          contextId: featureId,
          phase: phase,
        })
        setCurrentSessionId(newSession.id)
      } else {
        // No phase provided, create session without phase
        const newSession = await studioChat.createChatSession({
          inferredName: featureName || `Chat for ${featureId}`,
          contextType: "feature",
          contextId: featureId,
        })
        setCurrentSessionId(newSession.id)
      }
    }

    loadOrCreateSession()
  }, [featureId, featureName, phase, studioChat])

  // Get current session
  const currentSession = currentSessionId
    ? studioChat.chatSessionCollection.get(currentSessionId)
    : null

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

  // chat-session-sync-fix: v3 API requires DefaultChatTransport for proper metadata handling
  // The transport must be memoized to prevent re-creation on every render
  const chatTransport = useMemo(
    () => new DefaultChatTransport({ api: "/api/chat" }),
    []
  )

  // AI SDK useChat hook (v3 API - chat-session-sync-fix)
  const {
    messages,
    sendMessage,  // v3 API: sendMessage() replaces append()
    isLoading,
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
    onFinish: async ({ message }) => {
      // chat-session-sync-fix: v3 API callback receives { message, messages, isAbort, ... } options object
      // Must destructure message from options - NOT receive message directly like v1/v2
      const contentLength = message.content?.length ?? message.parts?.length ?? 0
      // Debug: Log message metadata to verify session ID capture
      console.log("[ChatPanel] onFinish called - stream complete", {
        contentLength,
        hasMetadata: !!(message as any).metadata,
        ccSessionId: (message as any).metadata?.ccSessionId,
      })

      // chat-session-sync-fix: v3 API - Session ID from message.metadata
      // Server's messageMetadata callback sends ccSessionId via SSE message-metadata event
      const newCcSessionId = (message as any).metadata?.ccSessionId as string | undefined

      // chat-session-sync-fix: Update ref IMMEDIATELY to prevent race condition
      // React state updates are async, but the ref must be current for the next
      // sendMessage() call. Without this, rapid user input (e.g., "yes" right after
      // first response) would use stale/undefined ccSessionId, creating a new
      // Claude Code session instead of resuming the existing one.
      if (newCcSessionId && currentSessionId) {
        console.log("[ChatPanel] Persisting CC session ID:", newCcSessionId)
        // CRITICAL: Update ref BEFORE async operations to prevent race condition
        ccSessionIdRef.current = newCcSessionId
        try {
          await studioChat.chatSessionCollection.updateOne(currentSessionId, {
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
        studioChat.addMessage({
          sessionId: currentSessionId,
          role: "assistant",
          content: extractTextContent(message),
        }).catch((err) => {
          console.warn("[ChatPanel] Failed to persist assistant message:", err)
        })

        // Record tool calls from the message (fire-and-forget)
        const toolCalls = extractToolCalls(message)
        for (const toolCall of toolCalls) {
          studioChat.recordToolCall({
            sessionId: currentSessionId,
            toolName: toolCall.toolName,
            status: toolCall.state === "output-available" ? "complete" :
                    toolCall.state === "output-error" ? "error" : "executing",
            args: toolCall.args || {},
            result: toolCall.result,
          }).catch((err) => {
            console.warn("[ChatPanel] Failed to record tool call:", err)
          })
        }

        // Smart Query Triggers (task-3-1-004)
        // After streaming completes, detect tool calls and trigger targeted data refreshes
        if (toolCalls.length > 0) {
          // Collect all collections that need refreshing
          const collectionsToRefresh: string[] = []
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

            // Collect collections to refresh
            const collections = getCollectionsToRefresh(toolCall)
            collectionsToRefresh.push(...collections)
          }

          // Trigger schema refresh if needed (via callback prop)
          if (needsSchemaRefresh && onSchemaRefresh) {
            onSchemaRefresh()
          }

          // Trigger collection refreshes in parallel (fire-and-forget)
          // NOTE: No await to prevent onFinish from hanging if collection queries
          // take too long. Smart refresh is background data sync.
          if (collectionsToRefresh.length > 0) {
            refreshCollections(platformFeatures, collectionsToRefresh).catch((err) => {
              console.warn("[ChatPanel] Smart refresh failed:", err)
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
        }
      }
    },
  })

  // Idle timeout to force-complete hung streams
  // When Claude Code invokes skills/tools, the stream can hang indefinitely
  // because onFinish never fires. This detects idle state and calls stop().
  const idleTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastMessageContentRef = useRef<string>("")
  const IDLE_TIMEOUT_MS = 90000 // 90 seconds of no new content = consider complete

  useEffect(() => {
    // Get current content to track changes
    const currentContent = messages.map(m => m.content).join("")

    if (isLoading) {
      // Clear existing timeout
      if (idleTimeoutRef.current) {
        clearTimeout(idleTimeoutRef.current)
      }

      // Check if content changed
      if (currentContent !== lastMessageContentRef.current) {
        lastMessageContentRef.current = currentContent
        console.log("[ChatPanel] Stream activity detected, resetting idle timer")
      }

      // Set new timeout
      idleTimeoutRef.current = setTimeout(() => {
        if (isLoading) {
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
  }, [isLoading, messages, stop])

  // Process progress events from message parts (task-subagent-progress-streaming)
  useEffect(() => {
    const latestMessage = messages[messages.length - 1]
    if (!latestMessage || latestMessage.role !== 'assistant') return

    const parts = (latestMessage as any).parts as any[] | undefined
    if (!parts) {
      console.log('[ChatPanel:Progress] No parts array in latest message')
      return
    }

    // Log all part types for debugging
    const partTypes = parts.map((p: any) => p.type)
    console.log('[ChatPanel:Progress] Processing message parts:', {
      messageId: latestMessage.id,
      partTypes,
      totalParts: parts.length,
    })

    // Find data-progress parts
    const progressParts = parts.filter((part: any) => part.type === 'data-progress')
    if (progressParts.length > 0) {
      console.log('[ChatPanel:Progress] Found data-progress parts:', progressParts.length)
    }

    parts.forEach((part) => {
      // Handle session ID from server (SDK workaround - session ID comes via custom event, not metadata)
      if (part.type === 'data-session') {
        const sessionData = part.data as { ccSessionId: string }
        console.log('[ChatPanel:Session] 📨 Received data-session event:', sessionData)
        if (sessionData.ccSessionId && !ccSessionIdRef.current) {
          console.log('[ChatPanel:Session] ✅ Capturing session ID from server:', sessionData.ccSessionId)
          ccSessionIdRef.current = sessionData.ccSessionId
          setCcSessionId(sessionData.ccSessionId)
          // Persist to session if available
          if (currentSessionId) {
            studioChat.chatSessionCollection.updateOne({
              id: currentSessionId,
              claudeCodeSessionId: sessionData.ccSessionId,
            }).catch((error) => {
              console.error('[ChatPanel:Session] Failed to persist session ID:', error)
            })
          }
        }
      }

      if (part.type === 'data-progress') {
        const event = part.data as SubagentProgressEvent
        console.log('[ChatPanel:Progress] 📥 Received data-progress event:', event)

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
          // These persist even after streaming ends for display in ToolTimeline
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
  }, [messages, currentSessionId, studioChat.chatSessionCollection])

  // Linger duration for completed subagents (ms) - keeps panel visible after completion
  const SUBAGENT_LINGER_MS = 2500

  // Delayed cleanup of completed subagents after stream ends (task-subagent-progress-streaming)
  // Instead of clearing immediately, we keep completed subagents visible for a few seconds
  // so users can see the final state before the panel disappears
  useEffect(() => {
    if (!isLoading) {
      console.log('[ChatPanel:Progress] Stream ended, scheduling delayed cleanup for completed subagents')

      // Set timeouts for each completed subagent
      const timeoutIds: ReturnType<typeof setTimeout>[] = []

      activeSubagents.forEach((subagent, id) => {
        if (subagent.status === 'completed') {
          const timeoutId = setTimeout(() => {
            console.log('[ChatPanel:Progress] Delayed cleanup: removing subagent', id)
            setActiveSubagents((prev) => {
              const next = new Map(prev)
              next.delete(id)
              return next
            })
          }, SUBAGENT_LINGER_MS)
          timeoutIds.push(timeoutId)
        }
      })

      // Delay clearing recent tools to match subagent visibility
      const toolsTimeoutId = setTimeout(() => {
        console.log('[ChatPanel:Progress] Delayed cleanup: clearing recent tools')
        setRecentTools([])
      }, SUBAGENT_LINGER_MS)
      timeoutIds.push(toolsTimeoutId)

      // Cleanup timeouts if component unmounts or isLoading changes
      return () => {
        timeoutIds.forEach((id) => clearTimeout(id))
      }
    }
  }, [isLoading, activeSubagents])

  // Debug: Log whenever activeSubagents changes
  useEffect(() => {
    console.log('[ChatPanel:Progress] 📊 activeSubagents state changed:', {
      size: activeSubagents.size,
      agents: Array.from(activeSubagents.values()).map(a => ({ id: a.agentId, type: a.agentType, status: a.status })),
    })
  }, [activeSubagents])

  // Clear accumulated tools when a new stream starts (task-chat-ux-fix)
  // We use a ref to track the previous isLoading state to detect stream start
  const prevIsLoadingRef = useRef(false)
  useEffect(() => {
    // Detect stream start: isLoading transitions from false to true
    if (isLoading && !prevIsLoadingRef.current) {
      console.log('[ChatPanel:Progress] New stream started, clearing accumulated tools')
      setAccumulatedSubagentTools([])
    }
    prevIsLoadingRef.current = isLoading
  }, [isLoading])

  // Load persisted messages when session changes
  useEffect(() => {
    if (currentSessionId) {
      const persistedMessages = studioChat.chatMessageCollection.findBySession?.(currentSessionId) ?? []
      if (persistedMessages.length > 0) {
        const aiMessages = persistedMessages.map((msg: any) => ({
          id: msg.id,
          role: msg.role as "user" | "assistant",
          content: msg.content,
        }))
        setMessages(aiMessages)
      } else {
        setMessages([])
      }
    } else {
      setMessages([])
    }
  }, [currentSessionId, studioChat.chatMessageCollection, setMessages])

  // Notify parent of streaming state changes (task-3-1-007)
  // This allows WorkspaceLayout to pause polling during active streaming
  useEffect(() => {
    onStreamingChange?.(isLoading)
  }, [isLoading, onStreamingChange])

  // chat-session-sync-fix: Handle message submission using v3 sendMessage() API
  // v3 uses sendMessage({ text }) instead of the old append-with-role pattern
  const handleSendMessage = useCallback(
    async (content: string) => {
      console.log("[ChatPanel] handleSendMessage called", {
        content: content?.slice(0, 50),
        currentSessionId,
        hasContent: !!content?.trim()
      })

      if (!currentSessionId) {
        console.warn("[ChatPanel] No session ID - message will be lost!", { content: content?.slice(0, 50) })
        return
      }

      if (!content.trim()) {
        console.warn("[ChatPanel] Empty content - ignoring")
        return
      }

      const trimmedContent = content.trim()

      // Persist user message to local store (fire-and-forget)
      studioChat.addMessage({
        sessionId: currentSessionId,
        role: "user",
        content: trimmedContent,
      }).catch((err) => console.warn("[ChatPanel] Failed to persist user message:", err))

      // chat-session-sync-fix: Send via v3 sendMessage() API
      // - First arg: { text } object (not { role, content })
      // - Second arg: options with body for server-side data
      // - ccSessionIdRef.current ensures fresh session ID value
      console.log("[ChatPanel] Calling sendMessage()", {
        contentLength: trimmedContent.length,
        ccSessionId: ccSessionIdRef.current,
      })
      try {
        await sendMessage(
          { text: trimmedContent },
          {
            body: {
              featureId,
              phase,
              ccSessionId: ccSessionIdRef.current,
            },
          }
        )
        console.log("[ChatPanel] sendMessage() completed successfully")
      } catch (err) {
        console.error("[ChatPanel] Failed to send message:", err)
      }
    },
    [currentSessionId, studioChat, sendMessage, featureId, phase]
  )

  // Handle form submit from ChatInput
  const handleInputSubmit = useCallback(
    (content: string) => {
      handleSendMessage(content)
    },
    [handleSendMessage]
  )

  // Collapse toggle
  const handleToggleCollapse = useCallback(() => {
    const newCollapsed = !isCollapsed
    setIsCollapsed(newCollapsed)
    setStoredCollapsed(newCollapsed)
  }, [isCollapsed])

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
      }

      const handleMouseUp = () => {
        setIsResizing(false)
        if (resizeRef.current) {
          const delta = resizeRef.current.startX - (window as any).lastMouseX || 0
          const finalWidth = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, resizeRef.current.startWidth + delta))
          setStoredWidth(finalWidth)
        }
        resizeRef.current = null
        document.removeEventListener("mousemove", handleMouseMove)
        document.removeEventListener("mouseup", handleMouseUp)
      }

      // Track last mouse X for final width calculation
      const trackMouseMove = (moveEvent: MouseEvent) => {
        ;(window as any).lastMouseX = moveEvent.clientX
        handleMouseMove(moveEvent)
      }

      document.addEventListener("mousemove", trackMouseMove)
      document.addEventListener("mouseup", handleMouseUp)
    },
    [width]
  )

  // Error retry handler
  const handleRetry = useCallback(() => {
    reload()
  }, [reload])

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
    isLoading,
    isPolling, // task-3-1-008: Pass polling state to context for LoadingOverlay
    error: error?.message ?? null,
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
    <div className={cn("flex h-full", className)}>
      {/* Main content with ChatContextProvider */}
      {children && (
        <ChatContextProvider value={contextValue}>
          <div className="flex-1 min-w-0 overflow-hidden">{children}</div>
        </ChatContextProvider>
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
        <ChatHeader
          sessionName={currentSession?.name || featureName || "Chat"}
          isLoading={isLoading}
          isCollapsed={isCollapsed}
          onToggleCollapse={handleToggleCollapse}
        />

        {/* Messages with Turn Grouping (task-chat-008) */}
        <div className="flex-1 overflow-y-auto p-4">
          {messages.length > 0 ? (
            <TurnList
              messages={messages}
              isStreaming={isLoading}
              phase={phase}
              activeSubagents={Array.from(activeSubagents.values()) as SubagentProgressType[]}
              recentTools={recentTools as RecentToolType[]}
              subagentToolCalls={accumulatedSubagentTools}
            />
          ) : !isLoading ? (
            /* Phase-contextual empty state (task-chat-008) */
            <PhaseEmptyState
              phase={phase}
              onSuggestionClick={handleSendMessage}
            />
          ) : (
            /* Loading indicator when no messages yet */
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
          )}
        </div>

        {/* Error Alert */}
        {error && (
          <div className="px-4 pb-2">
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription className="flex items-center justify-between gap-2">
                <span className="text-sm">{error.message}</span>
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
        <ChatInput
          onSubmit={handleInputSubmit}
          disabled={isLoading || !currentSessionId}
          placeholder={!featureId ? "Select a feature to start chatting..." : "Type a message..."}
        />
      </div>
    </div>
  )
})
