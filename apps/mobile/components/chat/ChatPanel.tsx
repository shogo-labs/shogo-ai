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

import {
  useState,
  useEffect,
  useLayoutEffect,
  useRef,
  useCallback,
  useMemo,
  useSyncExternalStore,
} from "react"
import * as Sentry from "@sentry/react-native"
import {
  Alert,
  AppState,
  Dimensions,
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
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from "react-native"
import { observer } from "mobx-react-lite"
import { useChat, type UIMessage } from "@ai-sdk/react"
import { useRouter } from "expo-router"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { LinearGradient } from "expo-linear-gradient"
import { DefaultChatTransport } from "ai"
import {
  appendQueuedUserMessage,
  appendQueuedUserMessages,
  canAttachQueuedTurn,
} from "./queued-user-message"
import {
  appendOptimisticEcho,
  buildOptimisticUserMessage,
  hasMatchingUserMessage,
  newestUserId,
  stampSendTime,
  type OptimisticEchoInput as OptimisticUserInput,
} from "./optimistic-echo"
import { usePersistedMessageIds } from "./use-persisted-message-ids"
import { usageLimitNoticeFor } from "./usage-limit-notice"
import { useMachineWorkspace } from "../instance/MachineWorkspaceBanner"
import AsyncStorage from "@react-native-async-storage/async-storage"
import {
  extractTextContent,
  formatErrorMessage,
  isTunnelDisconnectError,
  isClientNetworkFailure,
  formatToolName,
  getToolCategory,
  ERROR_CODE_MESSAGES,
  buildChatStreamErrorReport,
  isReactUpdateDepthError,
} from "@shogo/shared-app/chat"
import {
  useChatTransportConfig,
  buildChatTurnUrl,
  buildChatTasksUrl,
  truncateMessagesFrom,
  getPrecedingCheckpoint,
  rollbackProjectToCheckpoint,
  setMessageFeedback,
  clearMessageFeedback,
  getSessionFeedback,
  forkChatSession,
  type PrecedingCheckpointResult,
  type MessageFeedbackThumbs,
} from "@shogo/shared-app/chat"
import {
  useSDKDomains,
  useDomainActions,
  useChatMessageCollectionForSession,
  useProjectCollection,
  useSDKHttpOptional,
} from "@shogo/shared-app/domain"
import { decideMessagesPropagation } from "./messages-propagation"
import { resolveHistoryPaint, resolveLiveTurnAttach } from "./history-paint"
import {
  patchSessionFeedbackCache,
  readSessionFeedbackCache,
  readSessionMessageCache,
  writeSessionFeedbackCache,
  writeSessionMessageCache,
} from "../../lib/chat-panel-message-cache"
import {
  chatHistoryKey as buildChatHistoryKey,
  chatSessionHistoryKey,
  deltaSince,
  readChatHistory,
  removeChatHistory,
  writeChatHistory,
  type ChatHistoryEntry,
} from "../../lib/chat-history-store"
import { useResolvedTheme } from "../../contexts/theme"
import { useNotifyOnTurnComplete } from "./useNotifyOnTurnComplete"
import {
  isLiveTurnOtherThan,
  probeChatTurn,
  probeChatTurnStatus,
  type ChatTurnSnapshot,
  type ChatTurnStatus,
} from "./probe-turn-status"
import {
  externalPromptHasResponse,
  LATE_TURN_MAX_WAIT_MS,
  LATE_TURN_POLL_INTERVAL_MS,
  messageTurnStartedAt,
  pendingExternalPromptIndex,
  persistedTailAwaitsReply,
  persistedTailIsUnseen,
  persistedTailQuery,
  pollForLateTurn,
  taskWakeHasResponse,
  type PersistedTail,
} from "./late-turn-attach"
import {
  lastTurnStartedBackgroundWork,
  NOTIFY_WAKE_MAX_WAIT_MS,
  NOTIFY_WAKE_POLL_INTERVAL_MS,
  watchForNotifyWake,
} from "./notify-task-watch"
import {
  decideRetryAction,
  lastAssistantHasResumableWork,
} from "./retry-triage"
import {
  computeRecoveryBackoff,
  getStallRecoveryEffects,
  markStuckToolsInterrupted,
  shouldAutoRecoverStalledTurn,
} from "./stall-recovery"
import { recordAutoResumeAttempt } from "./auto-resume-circuit-breaker"
import { followNextTurn } from "./next-turn-follow"
import {
  runResumeStreamSingleFlight,
  type ResumeStreamFlightRef,
} from "./resume-stream-single-flight"
import { useServerMessageQueue } from "./useServerMessageQueue"
import {
  applyMessageSnapshot,
  dropUnfinishedAssistantTail,
  foldSnapshotContinuation,
  withResumeReplayReset,
} from "./resume-replay-transport"
import { markStoppedTail, mergeStoppedSnapshot } from "./stopped-turn"
import { cn } from "@shogo/shared-ui/primitives"
import { useBillingData } from "@shogo/shared-app/hooks"
import { API_URL, api, createHttpClient } from "../../lib/api"
import { workspaceHttp } from "../../lib/workspace-http"
import { agentProxyBase } from "../../lib/agent-proxy-base"
import {
  prepareOutgoingFiles,
  shouldUploadAttachmentFirst,
  type OutgoingFilePart,
} from "../../lib/chat-attachment-upload"
import { releasePreviewUrl } from "../../lib/composer-attachments"
import { transcriptKeyboardDismissMode } from "../../lib/composer-keyboard-dismiss"
import { usePlatformConfig } from "../../lib/platform-config"
import { workspaceProjectFilter } from "../../lib/project-load"
import {
  getActiveWorkspaceId,
  setActiveWorkspaceId,
} from "../../lib/workspace-store"
import { shouldRestoreChatWorkspace } from "../../lib/switch-workspace"
import {
  hasAcceptedAiConsent,
  acceptAiConsent,
  revokeAiConsent,
  AI_PROVIDERS,
} from "../../lib/ai-consent"
import { setActiveChatNotificationContext } from "../../lib/notifications/chat-notifier"
import { autoNameSession, isPlaceholderSessionName } from "./auto-name-session"

import {
  isPhoneLayout,
  nativePhoneComposerRestPad,
  useNativePhoneWindow,
} from "../../lib/native-phone-layout"
import { canvasViewerPayload } from "../../lib/canvas-viewer"
import {
  buildChatSendBody,
  generateClientTurnId,
  normalizePlanData,
} from "../../lib/chat-send-body"
import { chatColumnStyle } from "../../lib/chat-column"
import { NATIVE_COMPOSER_KEYBOARD_GAP } from "../../lib/native-composer-keyboard"
import { ProjectComposerDock } from "./composer/ProjectComposerDock"
import {
  useNativeComposerDockLift,
  useNativeComposerDockPad,
} from "../../lib/use-native-composer-keyboard"
import { authClient } from "../../lib/auth-client"
import { chatSessionEvents } from "../../lib/chat-session-events"
import { useActiveInstance } from "../../contexts/active-instance"
import { ChatHeader } from "./ChatHeader"
import { MessageList } from "./MessageList"
import type { ContextBreakdownData } from "./ContextBreakdownPanel"
import {
  ChatInput,
  DEFAULT_MODEL,
  type FileAttachment,
  type ChatReference,
  type ProjectMentionOption,
  type ChatMentionable,
  type RestoreDraftRequest,
} from "./ChatInput"
import { useChatInsertQueue } from "./useChatInsertQueue"
import type { AgentHistoryResult } from "@shogo-ai/sdk/agent"
import { useDualPlan } from "../../lib/dual-plan-preference"
import {
  isChatStalled,
  resolveProgressAfterVisibilityChange,
  emptyResponseErrorAfterFinish,
  STALL_TIMEOUT_USER_MESSAGE,
  EMPTY_AGENT_RESPONSE_MESSAGE,
  DEFAULT_SUBMITTED_STALL_MS,
  DEFAULT_STREAMING_STALL_MS,
} from "../../lib/chat-stall-watchdog"
import {
  createTodoStateStore,
  TodoStateStoreContext,
} from "../../lib/todo-state-store"
import {
  createFileChangeStore,
  FileChangeStoreContext,
} from "../../lib/file-change-store"
import {
  createChatDockStore,
  ChatDockStoreContext,
  useChatDockStore,
  type DockPanelDescriptor,
} from "../../lib/chat-dock-store"
import { useDockPanel } from "./dock/useDockPanel"
import { ChatDock } from "./dock/ChatDock"
import { PlanDockPanel } from "./dock/panels/PlanDockPanel"
import { PendingPlanComposerBar } from "./PendingPlanComposerBar"
import { ChecklistDockPanel } from "./dock/panels/ChecklistDockPanel"
import { RunningDockPanel, type TaskWaitState } from "./dock/panels/RunningDockPanel"
import { isFinishedProcess } from "./dock/finished-rows"
import { BrowserDockPanel } from "./dock/panels/BrowserDockPanel"
import { WorktreeDockPanel } from "./dock/panels/WorktreeDockPanel"
import { ChangesDockPanel } from "./dock/panels/ChangesDockPanel"
import {
  loadModelPreference,
  saveModelPreference,
} from "../../lib/agent-mode-preference"
import { useReconcileStaleModelSelection } from "../../lib/visible-models"
import { ExecutionBadge } from "./ExecutionBadge"
import { ExpandTab } from "./ExpandTab"
import { ToolCallDisplay, type ToolCallState } from "./ToolCallDisplay"
import {
  ChatContextProvider,
  type ChatContextValue,
  type ChatMessage,
  type OpenProjectPaneRequest,
  type OpenTaskHint,
} from "./ChatContext"
import { asTaskLink, type TaskOutputInfo } from "../../lib/task-link"
import { taskThreadPane } from "../../lib/task-thread-pane-store"
import {
  DESKTOP_ISLAND_WORKSPACE_AGENT_ID,
  registerDesktopIslandSession,
  updateDesktopIslandSession,
  type DesktopIslandSessionState,
  type IslandPendingRequest,
} from "../../lib/desktop-island"
import { normalizeWorkspaceMediaPath, resolveChatFilePath } from "./file-links"
import { useChatFileIndex } from "./useChatFileIndex"
import { useIdeBridge } from "./ideBridge"

import { TurnList } from "./turns"
import {
  MessageEditProvider,
  dispatchNativeInlineEditTap,
  type MessageEditOptions,
  type PendingEditDraft,
} from "./turns/MessageEditContext"
import { TurnFooterProvider } from "./turns/TurnFooterContext"
import { filesRevertedNote, formatRelativeTime } from "./turns/editResend"
import { PhaseEmptyState } from "./empty"
import {
  type SubagentProgress as SubagentProgressType,
  type RecentTool as RecentToolType,
} from "./subagent"
import { type RunningProcess } from "./ProcessPanel"
import {
  type ToolCallData,
  getToolCategory as getToolCategoryFromTools,
} from "./tools/types"
import { subagentStreamStore } from "../../lib/subagent-stream-store"
import { teamStore } from "../../lib/team-store"
import * as ExpoLinking from "expo-linking"
import {
  AlertCircle,
  RefreshCw,
  WifiOff,
  X,
  ChevronDown,
  Shield,
  KeyRound,
  MessageCircleQuestion,
} from "lucide-react-native"
import { type PlanData } from "./PlanCard"
import { usePlanStreamSafe } from "./PlanStreamContext"
import { AgentClient } from "@shogo-ai/sdk/agent"
import { agentFetch } from "../../lib/agent-fetch"
import { openAuthFlow, preCreateAuthWindow } from "@shogo/ui-kit/platform"
import { PermissionApprovalDialog } from "../security/PermissionApprovalDialog"
import { IntegrationConnectCard, type IntegrationAuthRequest } from "./IntegrationConnectCard"
import { buildStopRequest } from "../../lib/chat-stop"
import {
  isPlanStreamOwner,
  planToPublishToStream,
  shouldPublishPlanToStream,
} from "../../lib/plan-stream-publish"
import { configureSubagentStop } from "../../lib/subagent-stop"
import { useChatBridgeRegistrar } from "../voice-mode/ChatBridgeContext"
import { extractTaskToolsFromMessages } from "./turns/messageParts"
import {
  derivePendingQuestion,
  askUserQuestionPresentation,
} from "./turns/pendingQuestion"
import { AskUserQuestionWidget } from "./turns/AskUserQuestionWidget"
import {
  buildAskUserAnswerMessage,
  stripAskUserAnswerMarker,
} from "./turns/askUserAnswers"
import { NativeAskUserQuestionSheet } from "./NativeAskUserQuestionSheet"
import {
  ASK_IN_AGENT_EVENT,
  type AskInAgentPayload,
  FIX_IN_AGENT_EVENT,
  buildFixPrompt,
  type FixInAgentPayload,
} from "../project/panels/ide/agentFixProvider"
import {
  workspaceExperience,
  type WorkspaceExperienceComposer,
} from "@shogo/shared-app"

/** Full composer (model picker + interaction modes, no forced mode) — the default for team workspaces and any caller that doesn't pass `composer`. */
const DEFAULT_CHAT_COMPOSER: WorkspaceExperienceComposer =
  workspaceExperience("team").composer

// ============================================================
// Types
// ============================================================

// Stable empty array we hand to the chat context's `messages` field.
// See the long comment near `contextValue` below — we intentionally do
// not plumb the live message list through context, so this constant
// satisfies the type without flipping per token.
const EMPTY_CONTEXT_MESSAGES: ChatMessage[] = []

function messageTimestamp(value: unknown): number {
  if (value instanceof Date) return value.getTime()
  if (typeof value === "number") return value
  const parsed = Date.parse(String(value ?? ""))
  return Number.isNaN(parsed) ? 0 : parsed
}

type SubagentProgressEvent =
  | {
      type: "subagent-start"
      agentId: string
      agentType: string
      timestamp: number
    }
  | { type: "subagent-stop"; agentId: string; timestamp: number }
  | {
      type: "tool-complete"
      toolName: string
      toolUseId: string
      timestamp: number
    }

interface VirtualToolEvent {
  type: "virtual-tool-execute"
  toolUseId: string
  toolName: string
  args: Record<string, unknown>
  timestamp: number
}

export type QueuedMessage = {
  id: string
  content: string
  files?: FileAttachment[]
  selectedModel?: string
  references?: ChatReference[]
  status?: string
  error?: string
  /**
   * True when this entry is here because a send already failed on a client
   * network error (`isClientNetworkFailure`) — as opposed to the normal case
   * of a message typed while a turn was streaming. Drained the same way
   * (falling-edge / online-restored effects both call `processMessageQueue`)
   * but redelivered via `offlineRetry`'s exact payload instead of being
   * re-run through `sendMessageInternal` — the original call already
   * persisted the user message and set the optimistic bubble, so re-running
   * the full send path would duplicate both.
   */
  offline?: boolean
  /** Only set when `offline` is true: the exact wire payload to redeliver. */
  offlineRetry?: {
    messagePayload: {
      text: string
      files?: Array<{
        type: "file"
        mediaType: string
        url: string
        name?: string
      }>
    }
    bodyExtra: Record<string, unknown>
  }
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
  /**
   * `agent` keeps the existing chat behavior while using the quieter,
   * centred surface intended for the Workspace Agent shell. `studio`
   * preserves the dense project/IDE presentation.
   */
  presentation?: "agent" | "studio"
  featureId: string | null
  featureName?: string
  phase: string | null
  workspaceId?: string
  userId?: string
  projectId?: string
  /**
   * Workspace project to prioritize for the next agent turn. The API verifies
   * this belongs to the chat's attached project set before forwarding it.
   */
  focusedProjectId?: string | null
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
  /** Personal-shell composer prefill; stages text without sending it. */
  prefillRequest?: RestoreDraftRequest | null
  /**
   * Called once `prefillRequest` has actually been applied to the composer,
   * with the nonce that was consumed. Callers should clear their
   * `prefillRequest` state here (see `ChatInput`'s `onDraftRestored`) rather
   * than on a fixed-delay timer, which can race the composer's own restore
   * effect.
   */
  onPrefillConsumed?: (nonce: number) => void
  /**
   * Composer capability descriptor (`workspaceExperience(kind).composer`).
   * Defaults to the full team composer (model picker + interaction modes,
   * no forced mode). Pass `workspaceExperience('personal').composer` for
   * the companion shell rather than a bespoke boolean.
   */
  composer?: WorkspaceExperienceComposer
  onChatError?: (error: Error | null) => void
  injectMessage?: string | null
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
  /** Billing data; when omitted, ChatPanel loads it for `workspaceId` itself. */
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
  /**
   * Opens a file in the project that owns it. When omitted, ChatPanel
   * navigates to that project's IDE (or Files, on native) tab.
   */
  onOpenFile?: (projectId: string, relPath: string) => void
  /**
   * Opens a file by its raw workspace path, with no project lookup. Used by
   * chats whose files live in the workspace root (the workspace agent), so
   * the host can show its own file viewer. Takes precedence over `onOpenFile`.
   */
  onOpenFilePath?: (path: string) => void
  /**
   * Agent base URL for another project of this workspace, so a file the agent
   * wrote there with `project: "<name>"` can be shown as a chip (SHO-247).
   * Omit when this chat cannot reach other projects' runtimes.
   */
  projectAgentUrl?: (projectId: string) => string | null
  /**
   * Shows another project (or one of its chats) beside this chat. Only set by
   * hosts with room for a side pane; otherwise cards navigate to the project.
   */
  onOpenProjectPane?: (request: OpenProjectPaneRequest) => void
  /** Controlled model selection — when provided, ChatPanel uses this instead of its own state */
  selectedModel?: string
  onModelChange?: (modelId: string) => void
  /**
   * Reports this chat's last-used model (the most recent message that carries a
   * `model` value) so the parent can default the shared picker to it when this
   * chat becomes active. Fires with `null` when the chat has no model-stamped
   * message yet (brand-new/empty chat), letting the parent fall back to the
   * global last-used preference. Only invoked while the panel `isActive`.
   */
  onResolveSessionModel?: (modelId: string | null) => void
  /** When false, defers non-essential network requests (quick-actions, stream reconnect). Defaults to true. */
  isActive?: boolean
  /**
   * Marks this panel as the owner of the shared `PlanStreamContext` when the
   * host doesn't pass `onMessagesChange`. Only one mounted panel per
   * `PlanStreamProvider` should set this.
   */
  ownsPlanStream?: boolean
  /** Enables IDE-specific context bridge and compact composer affordances. */
  ideMode?: boolean
  /**
   * Optional message enrichment hook — called before each outgoing message
   * to prepend auto-collected workspace context (terminal output, git status,
   * diagnostics, active file). The returned string replaces messagePayload.text
   * while the original trimmedContent is still displayed in the chat bubble.
   *
   * Desktop provides this via ContextAggregator; mobile passes nothing (no-op).
   */
  enrichMessage?: (text: string) => Promise<string>
  /** When set, the composer is disabled and shows this text as its placeholder (e.g. read-only project access). */
  readOnlyReason?: string
  /**
   * Phone transcript top inset. `"chrome"` (default) reserves room for
   * `MobileWorkspaceShell`'s floating menu/bell buttons. `"floating-agent"`
   * reserves extra room for the Muse-style avatar/name/status overlay
   * (`PersonalAgentMobileHeader`) that floats above those same buttons.
   */
  phoneTranscriptTopPadding?: "chrome" | "floating-agent"
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
    .filter(
      (part) => part.type === "tool-invocation" || part.type === "dynamic-tool",
    )
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
            ? ((part as { errorText?: string }).errorText ?? part.error)
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
  return parts.some(
    (p) => p.type === "tool-invocation" || p.type === "dynamic-tool",
  )
}

function serializeParts(parts: any[] | undefined): string | undefined {
  if (!parts || !Array.isArray(parts)) return undefined

  const persistableParts = parts.filter(
    (p) =>
      p.type === "text" ||
      p.type === "tool-invocation" ||
      p.type === "dynamic-tool" ||
      p.type === "file",
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

  if (
    !["store_create", "store_update", "store_delete"].includes(
      normalizedToolName,
    )
  ) {
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

  return (
    normalizedToolName === "schema_set" || normalizedToolName === "schema_load"
  )
}

async function refreshCollections(
  domain: any,
  collectionNames: string[],
  domainName: string = "domain",
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
        console.warn(
          `[ChatPanel] Failed to refresh ${domainName}.${collectionName}:`,
          err,
        )
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
export { clearChatPanelMessageCache } from "../../lib/chat-panel-message-cache"

/** One `/chat-messages` row (page or delta) as the AI SDK message the panel renders. */
function messageRowToUIMessage(msg: any): any {
  const createdAt =
    typeof msg?.createdAt === "string"
      ? new Date(msg.createdAt).getTime()
      : (msg?.createdAt ?? 0)
  const baseMessage: any = {
    id: msg.id,
    role: msg.role as "user" | "assistant",
    content: msg.content,
    // Carried through so `extractTurnTiming`'s createdAt fallback and the
    // `TurnFooter` relative-time label have a real timestamp for historical
    // (pre-`data-turn-timing`) messages loaded from the server.
    createdAt,
  }
  if (msg.parts) {
    try {
      baseMessage.parts =
        typeof msg.parts === "string" ? JSON.parse(msg.parts) : msg.parts
    } catch (err) {
      console.warn("[ChatPanel] Failed to parse message parts:", err)
    }
  }
  return baseMessage
}

/** The MST snapshot for a row from the delta route (ISO dates → timestamps). */
function messageRowToSnapshot(msg: any): any {
  const createdAt =
    typeof msg?.createdAt === "string"
      ? new Date(msg.createdAt).getTime()
      : (msg?.createdAt ?? 0)
  // Only the fields the store model declares: a row spread whole carries newer
  // server columns (`updatedAt` in SHO-260) and the MST conversion throws,
  // which aborted the reopen's whole hydrate → delta → probe chain.
  return {
    id: msg?.id,
    sessionId: msg?.sessionId,
    role: msg?.role,
    content: msg?.content ?? "",
    imageData: msg?.imageData ?? "",
    parts: msg?.parts ?? "",
    createdAt,
    agent: msg?.agent ?? "technical",
    model: msg?.model ?? "",
    authorUserId: msg?.authorUserId ?? "",
  }
}

/** Shape of `GET /api/chat-messages/session/:id/changes` (see SHO-260). */
interface ChatChangesResult {
  ok?: boolean
  items?: any[]
  total?: number | null
  cursor?: string | null
  reset?: boolean
}

// Local fallback queue cache. Server-backed queue rows live in the generated
// SDK collection and survive reloads/devices; this cache is only used for
// direct-runtime and offline fallback sends.
const sessionQueueCache = new Map<string, QueuedMessage[]>()

/** Clear the in-memory per-session queued-message cache (e.g. on logout). */
export function clearChatPanelQueueCache(): void {
  sessionQueueCache.clear()
}

async function ensureAiConsentForMessage(): Promise<boolean> {
  if (Platform.OS !== "ios") return true
  const alreadyAccepted = await hasAcceptedAiConsent().catch(() => false)
  if (alreadyAccepted) return true

  const providerNames = AI_PROVIDERS.map((provider) => provider.name).join(
    " or ",
  )
  const accepted = await new Promise<boolean>((resolve) => {
    Alert.alert(
      "Share your message with the selected AI provider?",
      `To generate a response, your message and any attachments will be sent to the AI provider you\u2019ve selected (${providerNames}). We don\u2019t send your email, payment info, or device identifiers. Shogo also stores prompts and responses for up to 3 years to improve and train its models; workspace admins can turn this off in Settings.`,
      [
        {
          text: "Don\u2019t allow",
          style: "cancel",
          onPress: () => resolve(false),
        },
        { text: "Allow", onPress: () => resolve(true) },
      ],
      { cancelable: false },
    )
  })
  if (!accepted) {
    await revokeAiConsent().catch(() => {})
    return false
  }
  await acceptAiConsent().catch(() => {})
  return true
}

// ============================================================
// Component
// ============================================================

/**
 * A seed fetch replaces the dock list wholesale. If a row that was running is
 * simply missing from the answer (the runtime forgot it, or its registry was
 * recreated), keep it once as a finished row so it fades out instead of
 * blinking away — and so the "a task finished" probe still sees it drop.
 */
function keepDroppedAsFinished(
  prev: RunningProcess[],
  next: RunningProcess[],
): RunningProcess[] {
  if (prev.length === 0) return next
  const seen = new Set(next.map((p) => p.id ?? p.runId))
  const dropped = prev.filter(
    (p) =>
      !seen.has(p.id ?? p.runId) &&
      !p.stale &&
      (!p.status || p.status === "running"),
  )
  if (dropped.length === 0) return next
  const now = Date.now()
  return [
    ...next,
    ...dropped.map((p) => ({
      ...p,
      status: p.status === "running" ? "completed" : p.status,
      finishedAt: p.finishedAt ?? now,
    })),
  ]
}

const ChatPanelContent = observer(function ChatPanelContent({
  presentation = "studio",
  featureId,
  featureName,
  phase,
  workspaceId,
  userId,
  projectId,
  focusedProjectId,
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
  prefillRequest,
  onPrefillConsumed,
  composer: composerProp,
  onChatError,
  injectMessage,
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
  onOpenFile,
  onOpenFilePath,
  projectAgentUrl,
  onOpenProjectPane,
  selectedModel: controlledSelectedModel,
  onModelChange: controlledOnModelChange,
  onResolveSessionModel,
  isActive = true,
  ownsPlanStream = false,
  ideMode = false,
  enrichMessage,
  readOnlyReason,
  phoneTranscriptTopPadding = "chrome",
}: ChatPanelProps) {
  // A machine workspace cannot take a write while its Mac is asleep, so the
  // composer is refused from the same state the banner renders (SHO-185 AC4).
  // The banner's own line is the reason, so the input says why it is off.
  const { instance: machineInstance } = useActiveInstance()
  const machineView = useMachineWorkspace({ machineName: machineInstance?.name })
  const machineStop = machineView.composeDisabled ? machineView.banner ?? undefined : undefined
  const composer = composerProp ?? DEFAULT_CHAT_COMPOSER
  const chatDockStore = useChatDockStore()
  const {
    width: windowWidth,
    height: windowHeight,
    isPhone: isNativePhoneLayout,
  } = useNativePhoneWindow()
  const insets = useSafeAreaInsets()
  const isPhoneViewport = isPhoneLayout(windowWidth, windowHeight)
  const isDark = useResolvedTheme() === "dark"
  const ideBridge = useIdeBridge(ideMode)

  const { studioChat } = useSDKDomains()
  const actions = useDomainActions()

  // Workspace-scoped chat routes to `/api/workspaces/:workspaceId/chat`
  // instead of the per-project endpoint. Only set when this panel is
  // operating in workspace scope and we actually have a workspace id.
  const chatWorkspaceId =
    chatScope === "workspace" && workspaceId ? workspaceId : undefined

  // One base for every runtime call (tasks, cancel, output, quick actions).
  // The landing chat has a workspaceId but no projectId, and used to resolve
  // this to `null` — so its dock never seeded and lost every row on remount.
  const agentBaseUrl = agentProxyBase({
    localAgentUrl,
    projectId,
    workspaceId: chatWorkspaceId,
    apiUrl: API_URL,
  })

  // Sibling projects (same workspace, excluding the current one) for the
  // composer's "@" mention menu. Tagging one mounts it into the chat runtime
  // so the agent can read its files. AppSidebar already loads the collection
  // app-wide; we loadAll() defensively in case the panel mounts first.
  const projectCollection = useProjectCollection()
  // Routing insert point: a workspace-scoped request goes through the domain
  // client, so a paired desktop's own workspace gets its history from that
  // machine (the SDK interceptor rewrites the path and the workspace id).
  const domainHttp = useSDKHttpOptional()
  useEffect(() => {
    projectCollection
      .loadAll(workspaceProjectFilter(workspaceId))
      .catch(() => {})
  }, [projectCollection, workspaceId])
  // A turn recorded before a remote file result named its project only carries
  // the project's *name*, so the chat resolves it against this list (SHO-247).
  const resolveProjectRef = useCallback(
    (ref: string) => {
      const trimmed = ref.trim()
      if (!trimmed) return null
      const all = projectCollection.all as Array<{ id?: string; name?: string }>
      const byId = all.find((project) => project.id === trimmed)
      if (byId?.id) return byId.id
      const lowered = trimmed.toLowerCase()
      const byName = all.find(
        (project) => (project.name ?? "").trim().toLowerCase() === lowered,
      )
      return byName?.id ?? null
    },
    [projectCollection],
  )
  // The current project's workspace: prefer the workspace-scope prop, else
  // recover it from the loaded collection so we only offer true siblings.
  const currentWorkspaceId =
    workspaceId ??
    projectCollection.all.find((p: any) => p.id === projectId)?.workspaceId
  const projectMentionSignature = projectCollection.all
    .filter(
      (p: any) =>
        p.id !== projectId &&
        (!currentWorkspaceId || p.workspaceId === currentWorkspaceId),
    )
    .map((p: any) => `${p.id}:${p.name}`)
    .join("|")
  const projectMentionOptions = useMemo<ProjectMentionOption[]>(
    () =>
      projectCollection.all
        .filter(
          (p: any) =>
            p.id !== projectId &&
            (!currentWorkspaceId || p.workspaceId === currentWorkspaceId),
        )
        .map((p: any) => ({ id: p.id, name: p.name })),
    // Signature keeps the array referentially stable across token-by-token
    // streaming re-renders (matters because ChatInput is memoized).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [projectMentionSignature],
  )

  const platformFeatures = legacyDomains?.platformFeatures
  const componentBuilder = legacyDomains?.componentBuilder

  const router = useRouter()

  // Surfaces that don't pass `billingData` (workspace agent chat, project chat
  // view, side chat) would otherwise lock every non-economy model.
  const { features: platformFeatureFlags } = usePlatformConfig()
  const ownBillingData = useBillingData(
    !billingData && platformFeatureFlags.billing ? workspaceId : undefined,
  )
  const hasActiveSubscription = billingData
    ? billingData.hasActiveSubscription
    : platformFeatureFlags.billing
      ? ownBillingData.hasActiveSubscription
      : true
  const hasAdvancedModelAccess = billingData
    ? (billingData.hasAdvancedModelAccess ?? billingData.hasActiveSubscription)
    : platformFeatureFlags.billing
      ? ownBillingData.hasAdvancedModelAccess
      : true
  const refetchUsageWallet =
    billingData?.refetchUsageWallet ?? ownBillingData.refetchUsageWallet
  // A user who has never taken a trial should be offered it right where they
  // hit the limit, not sent to a pricing page to work it out.
  const trialEligible = Boolean(
    (billingData ? (billingData as any).trialEligible : (ownBillingData as any).trialEligible),
  )

  const handleUpgradeClick = useCallback(() => {
    router.push("/(app)/billing" as any)
  }, [router])

  const handleStartTrialClick = useCallback(() => {
    router.push("/(app)/billing?trial=business" as any)
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
    if (Platform.OS === "web") return undefined
    return (): Record<string, string> => {
      const cookie = authClient.getCookie()
      return cookie ? { Cookie: cookie } : {}
    }
  }, [])

  const expoFetch = useMemo(() => {
    if (Platform.OS === "web") return undefined
    return require("expo/fetch").fetch as typeof globalThis.fetch
  }, [])

  const workspaceHistorySearch = useCallback(
    async (query: string): Promise<AgentHistoryResult[]> => {
      if (!workspaceId) return []
      const search = {
        q: query,
        kind: "all",
        limit: "12",
        exclude: chatSessionId || "",
      }
      try {
        if (domainHttp) {
          const response = await domainHttp.get<{ results?: AgentHistoryResult[] }>(
            `/api/workspaces/${encodeURIComponent(workspaceId)}/history/search`,
            search,
          )
          return Array.isArray(response.data?.results) ? response.data.results : []
        }
        const fetchFn = expoFetch ?? globalThis.fetch
        const headers: Record<string, string> = nativeHeaders
          ? nativeHeaders()
          : {}
        const params = new URLSearchParams(search)
        const response = await fetchFn(
          `${API_URL}/api/workspaces/${encodeURIComponent(
            workspaceId,
          )}/history/search?${params}`,
          {
            headers,
            credentials: Platform.OS === "web" ? "include" : undefined,
          } as any,
        )
        if (!response.ok) return []
        const data = await response.json()
        return Array.isArray(data?.results) ? data.results : []
      } catch {
        return []
      }
    },
    [workspaceId, chatSessionId, nativeHeaders, expoFetch, domainHttp],
  )

  /**
   * Chats the user can hand this message to, from every workspace they belong
   * to. The server filters by access; this composer only excludes the chat we
   * are already in (tagging yourself is a no-op).
   */
  const chatMentionables = useCallback(
    async (query: string): Promise<ChatMentionable[]> => {
      try {
        const params: Record<string, string> = { q: query, limit: "8" }
        if (chatSessionId) params.exclude = chatSessionId
        const { data } = await workspaceHttp().get<{ chats?: ChatMentionable[] }>(
          "/api/chat-mentionables",
          params,
        )
        return Array.isArray(data?.chats) ? data.chats : []
      } catch {
        return []
      }
    },
    [chatSessionId],
  )

  // Quick actions state
  const [quickActions, setQuickActions] = useState<
    { label: string; prompt: string }[]
  >([])

  const fetchQuickActions = useCallback(async () => {
    const url = agentBaseUrl
    if (!url) return
    try {
      const fetchFn = expoFetch ?? globalThis.fetch
      const headers: Record<string, string> = nativeHeaders
        ? nativeHeaders()
        : {}
      const res = await fetchFn(`${url}/agent/quick-actions`, {
        headers,
        credentials: Platform.OS === "web" ? "include" : undefined,
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
  }, [agentBaseUrl, nativeHeaders, expoFetch])

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

  const maybeAutoNameSession = useCallback(
    (sessionId: string, userText: string) => {
      if (!userText.trim() || hasTriggeredNamingRef.current) return

      const session = studioChat.chatSessionCollection.get(sessionId)
      const sessionName =
        (session as any)?.inferredName || (session as any)?.name
      if (!isPlaceholderSessionName(sessionName)) return

      hasTriggeredNamingRef.current = true
      const http = workspaceHttp()
      void autoNameSession({
        sessionId,
        userText,
        workspaceId,
        projectId,
        getSession: (id) => studioChat.chatSessionCollection.get(id),
        loadSession: (id) => studioChat.chatSessionCollection.loadById(id),
        getProjectName: (id) =>
          projectCollection.all.find((p: any) => p.id === id)?.name,
        generateName: (text, currentWorkspaceId, currentProjectId) =>
          api.generateProjectName(
            http,
            text,
            currentWorkspaceId,
            currentProjectId,
          ),
        updateProject: (id, changes) => actions.updateProject(id, changes),
        updateSession: (id, changes) => actions.updateChatSession(id, changes),
        emitRefresh: ({
          projectId: currentProjectId,
          workspaceId: currentWorkspaceId,
          sessionId: currentSessionId,
        }) =>
          chatSessionEvents.emit({
            ...(currentProjectId ? { projectId: currentProjectId } : {}),
            ...(currentWorkspaceId ? { workspaceId: currentWorkspaceId } : {}),
            activeSessionId: currentSessionId,
            refresh: true,
          }),
      }).catch((err) => {
        console.warn("[ChatPanel] AI session naming failed:", err)
      })
    },
    [actions, projectCollection, projectId, studioChat, workspaceId],
  )

  // Auto-scroll refs
  const scrollViewRef = useRef<ScrollView>(null)
  const isUserAtBottomRef = useRef(true)
  /** Native only: true = follow new content; set false the instant the user drags */
  const stickToBottomRef = useRef(true)
  const isLoadingOlderRef = useRef(false)
  const contentHeightBeforeLoadRef = useRef(0)
  const prevDisplayLengthRef = useRef(0)
  /** Web only: debounce timer for near-top load-older (see LOAD_OLDER_WEB_DEBOUNCE_MS). */
  const loadOlderWebDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  )
  /**
   * Timestamp (ms) until which any onScroll events should be treated as
   * programmatic and NOT used to flip follow state. Our own scrollToEnd /
   * scrollTo calls fire onScroll on web; without this guard, streaming-token
   * auto-scrolls silently re-engage follow after the user scrolled away.
   */
  const programmaticScrollUntilRef = useRef(0)
  const MESSAGE_PAGE_SIZE = 50
  const isNative = Platform.OS !== "web"
  const nativeEditTapStartRef = useRef<{ x: number; y: number } | null>(null)
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
    programmaticScrollUntilRef.current =
      Date.now() + PROGRAMMATIC_SCROLL_GUARD_MS
  }, [])

  /** Mirrors stick/at-bottom into React so we can show the "Jump to latest"
   * pill. Source of truth for streaming follow remains the refs above. */
  const [isFollowing, setIsFollowing] = useState(true)
  const [hasScrollableTranscript, setHasScrollableTranscript] = useState(false)
  const [nativeInlineEditing, setNativeInlineEditing] = useState(false)
  // SHO-263: which past message is open in the in-place editor. Lives here so
  // only one editor can be open at a time and TurnList can dim what follows.
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null)
  // Whether the open editor's draft differs from the original message — set by
  // InlineMessageEditor so clicking Edit on another row can't discard it.
  const [inlineEditDirty, setInlineEditDirty] = useState(false)
  // SHO-263: the in-flight edit draft, hoisted out of the editor so a failed
  // truncate/rollback can re-open it with what the user typed (the optimistic
  // collapse unmounts the row that owned it).
  const [pendingEdit, setPendingEdit] = useState<PendingEditDraft | null>(null)
  // "Files reverted to the checkpoint from …" notes, keyed by message id so
  // the note travels with the resent message instead of a floating banner.
  const [revertedNotes, setRevertedNotes] = useState<Record<string, string>>({})
  const pendingRevertNoteRef = useRef<{ text: string; note: string } | null>(null)
  const [nativeKeyboardOpen, setNativeKeyboardOpen] = useState(false)
  // Phone chrome renders the bottom nav outside this chat surface and that
  // nav owns the home-indicator inset. Reserving it here too created an extra
  // blank row between the composer and nav on native, unlike mobile web.
  const restComposerPad = isPhoneViewport
    ? nativePhoneComposerRestPad(false)
    : Math.max(insets.bottom, NATIVE_COMPOSER_KEYBOARD_GAP)
  // Native phone chat uses the measured keyboard overlap below. Keeping the
  // KAV lift enabled here makes the composer depend on two independent layout
  // adjustments, which can leave it behind the keyboard in project chat.
  const iosComposerAvoiding = Platform.OS === "ios" && !isNativePhoneLayout
  // Whatever chrome sits under a chat (a safe-area inset, the bottom nav, a
  // full-screen shell) decides how far the keyboard overlaps it, so assuming
  // the inset left some chats flush on the keyboard and others far above it.
  // Every phone chat measures where its container really ends instead.
  const measureSurfaceBottom = isNativePhoneLayout && Platform.OS !== "web"
  const surfaceRef = useRef<View>(null)
  const [surfaceBottomOffset, setSurfaceBottomOffset] = useState<number | null>(null)
  const measureSurface = useCallback(() => {
    surfaceRef.current?.measureInWindow((_x, y, _width, height) => {
      const next = Math.round(Dimensions.get("window").height - (y + height))
      setSurfaceBottomOffset((prev) => (prev === next ? prev : next))
    })
  }, [])
  // iOS phones slide the dock on a native transform and let the transcript's
  // scroll view inset itself; nothing is laid out while the keyboard moves.
  const liftComposerWithKeyboard = Platform.OS === "ios" && isNativePhoneLayout
  const composerKeyboardLift = useNativeComposerDockLift({
    enabled: liftComposerWithKeyboard,
    restPad: restComposerPad,
    bottomOffset: surfaceBottomOffset,
    onOpenChange: setNativeKeyboardOpen,
  })
  const composerKeyboardPad = useNativeComposerDockPad({
    measuredBottomOffset: measureSurfaceBottom ? surfaceBottomOffset : null,
    // Native phone uses the RN `Keyboard` bridge; mobile web has no such
    // bridge but tracks the same overlap via `visualViewport` (see
    // `use-native-composer-keyboard.ts`), so enable this for narrow web too.
    enabled:
      !liftComposerWithKeyboard &&
      (isNativePhoneLayout || (Platform.OS === "web" && isPhoneViewport)),
    restPad: restComposerPad,
    safeAreaBottom: insets.bottom,
    iosKeyboardAvoiding: iosComposerAvoiding,
    onOpenChange: setNativeKeyboardOpen,
  })

  const shouldFollowBottom = useCallback(
    () => (isNative ? stickToBottomRef.current : isUserAtBottomRef.current),
    [isNative],
  )

  const scrollToBottomIfFollowing = useCallback(
    (animated = false) => {
      if (shouldFollowBottom()) {
        markProgrammaticScroll()
        scrollViewRef.current?.scrollToEnd({ animated })
      }
    },
    [shouldFollowBottom, markProgrammaticScroll],
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
    [isNative],
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
      if (loadOlderWebDebounceRef.current)
        clearTimeout(loadOlderWebDebounceRef.current)
      if (contextUsageTimerRef.current)
        clearTimeout(contextUsageTimerRef.current)
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
      if (e.key === "ArrowUp" || e.key === "PageUp" || e.key === "Home") {
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

  useEffect(() => {
    setHasScrollableTranscript(false)
  }, [currentSessionId])

  // Native push notifications are still useful when another project is open,
  // or when the app is backgrounded. Suppress only the notification for the
  // exact chat currently visible in the foreground.
  useEffect(() => {
    if (!isActive || !currentSessionId || !projectId) return
    setActiveChatNotificationContext({
      sessionId: currentSessionId,
      projectId,
    })
    return () => setActiveChatNotificationContext(null)
  }, [currentSessionId, isActive, projectId])

  const [isInitialLoadComplete, setIsInitialLoadComplete] = useState(false)
  const prevSessionIdRef = useRef<string | null>(currentSessionId)
  const [internalSelectedModel, setInternalSelectedModel] =
    useState<string>(DEFAULT_MODEL)
  const isModelControlled = controlledSelectedModel !== undefined
  // Gate reconciliation until the persisted preference has loaded, so the
  // reconciler never runs against the initial slug default (not a catalog UUID
  // id) and persist-clobbers the user's saved choice. See the home screen /
  // project layout for the same guard.
  const [modelPrefLoaded, setModelPrefLoaded] = useState(false)

  useEffect(() => {
    if (isModelControlled) return
    loadModelPreference(projectId).then((stored) => {
      if (stored) setInternalSelectedModel(stored)
      setModelPrefLoaded(true)
    })
  }, [isModelControlled, projectId])

  const selectedModel = isModelControlled
    ? controlledSelectedModel
    : internalSelectedModel

  const handleModelChange = useCallback(
    (modelId: string) => {
      if (controlledOnModelChange) {
        controlledOnModelChange(modelId)
      } else {
        setInternalSelectedModel(modelId)
        saveModelPreference(modelId, projectId)
      }
    },
    [controlledOnModelChange, projectId],
  )

  // Reset a pre-UUID stored selection (an old slug that's now only a server
  // alias, so the picker can't label it) to the tier default once the catalog
  // loads. Only when uncontrolled — a controlling parent owns and reconciles
  // its own selection.
  useReconcileStaleModelSelection(
    internalSelectedModel,
    DEFAULT_MODEL,
    handleModelChange,
    !isModelControlled && modelPrefLoaded,
  )

  // Dual Plan preference — singleton-backed hook so the Plans panel header and
  // user settings page stay in sync. Persistent per-device; the toggle stays
  // sticky across sessions. Default is ON.
  const [dualPlan] = useDualPlan()
  const dualPlanRef = useRef<boolean>(dualPlan)
  useEffect(() => {
    dualPlanRef.current = dualPlan
  }, [dualPlan])

  const [restoreDraftRequest, setRestoreDraftRequest] =
    useState<RestoreDraftRequest | null>(null)

  // Stable identity: an inline arrow here would be a new prop value on every
  // ChatPanel render, re-running ChatInput's restore effect (which depends on
  // `onDraftRestored`) every render rather than only when a request is
  // actually consumed.
  const handleDraftRestored = useCallback(
    (nonce: number) => {
      if (prefillRequest?.nonce === nonce) onPrefillConsumed?.(nonce)
      else if (restoreDraftRequest?.nonce === nonce)
        setRestoreDraftRequest(null)
    },
    [prefillRequest?.nonce, restoreDraftRequest?.nonce, onPrefillConsumed],
  )

  // Bridge for EZ Mode overlay (voice + text translator). The overlay
  // calls `send` / `setMode` to drive this panel, and subscribes to the
  // typed lifecycle event stream (turn-start / tool-activity / turn-end)
  // emitted below. We capture the emitters in refs so hooks declared
  // before the registrar runs can reach the latest implementations
  // without a closure dance.
  const emitTurnStartRef = useRef<(() => void) | null>(null)
  const emitToolActivityRef = useRef<
    | ((args: {
        toolName: string
        phase: "start" | "end"
        label: string
        ok?: boolean
      }) => void)
    | null
  >(null)
  const emitTurnEndRef = useRef<((text: string) => void) | null>(null)
  const setSubagentCardsRef = useRef<((cards: ToolCallData[]) => void) | null>(
    null,
  )
  const lastEmittedMessageIdRef = useRef<string | null>(null)
  /**
   * Per-tool-invocation state cache so the messages-watch effect only
   * emits `tool-activity` events when a part transitions to a new phase.
   * Keyed by a stable `${messageId}:${toolCallId||index}` string.
   */
  const toolActivityStateRef = useRef<Map<string, "start" | "end">>(new Map())

  const [confirmedPlan, setConfirmedPlan] = useState<PlanData | null>(null)
  const confirmedPlanRef = useRef<PlanData | null>(null)
  const [pendingPlan, setPendingPlan] = useState<PlanData | null>(null)
  const pendingPlanRef = useRef<PlanData | null>(null)

  const planStream = usePlanStreamSafe()
  const isActivePanel = isPlanStreamOwner({
    hasMessagesListener: onMessagesChange != null,
    ownsPlanStream,
  })
  const isActivePanelRef = useRef(isActivePanel)
  isActivePanelRef.current = isActivePanel

  // Per-panel TodoWrite store. Each open chat tab gets its own
  // instance so descendants (AssistantContent, TodoRow) read
  // and write isolated state — see todo-state-store.ts. Stable
  // for the panel's lifetime; the clear() below is a defensive
  // reset for the rare case where a panel switches sessions.
  const todoStateStore = useMemo(() => createTodoStateStore(), [])
  // Per-chat store for the files-changed dock panel — see file-change-store.ts.
  const fileChangeStore = useMemo(() => createFileChangeStore(), [])
  // The chat dock's panel registry (context breakdown, plan, checklist,
  // changed files, live browser, running tasks, queue, worktree, plus the
  // blocking permission/question/connectivity panels). One per ChatPanel —
  // see chat-dock-store.ts.
  useEffect(() => {
    pendingPlanRef.current = null
    setPendingPlan(null)
    setConfirmedPlan(null)
    confirmedPlanRef.current = null
    todoStateStore.clear()
    fileChangeStore.clear()
    chatDockStore.reset()
  }, [currentSessionId, todoStateStore, fileChangeStore, chatDockStore])

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
      .catch((err: any) =>
        console.warn("[ChatPanel] Failed to load session:", err),
      )
  }, [isActive, chatSessionId, studioChat])

  const currentSession = currentSessionId
    ? studioChat.chatSessionCollection.get(currentSessionId)
    : null

  // Per-session MST collection: isolated from sibling ChatPanels. Reads never
  // flip to 0 because another session's `loadPage` clobbered the singleton.
  const sessionMessages = useChatMessageCollectionForSession(currentSessionId)

  // Caller's own thumbs up/down reactions for this session, keyed by
  // messageId — powers the `TurnFooter` initial thumb state. Loaded
  // once per session (below) and updated optimistically by
  // `handleSetFeedback` / `handleClearFeedback`.
  const [feedbackMap, setFeedbackMap] = useState<
    Record<string, MessageFeedbackThumbs>
  >({})

  useEffect(() => {
    if (!currentSessionId) {
      setFeedbackMap({})
      return
    }
    // A session we've already loaded paints its thumbs straight from the
    // cache; the fetch below only runs on a genuine first visit.
    const cachedFeedback = readSessionFeedbackCache(currentSessionId)
    if (cachedFeedback) {
      setFeedbackMap(cachedFeedback)
      return
    }
    let cancelled = false
    setFeedbackMap({})
    getSessionFeedback(studioChat.chatSessionCollection, currentSessionId)
      .then((feedback) => {
        if (cancelled) return
        writeSessionFeedbackCache(currentSessionId, feedback)
        setFeedbackMap(feedback)
      })
      .catch((err) => {
        console.warn("[ChatPanel] Failed to load session feedback:", err)
      })
    return () => {
      cancelled = true
    }
  }, [currentSessionId, studioChat])

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
  // Session whose reply this panel just streamed or joined. Such a reply is on
  // screen before the API has written its row (it persists after the stream
  // EOFs), so a paint from history must not replace it (SHO-85).
  const liveReplySessionRef = useRef<string | null>(null)
  // Paints refused in a row while the server catches up; carried on the Sentry
  // event so a report shows how hard the reply was to keep on screen.
  const historyPaintAttemptRef = useRef(0)
  const cachedMessagesRef = useRef<any[] | null>(null)
  // Assigned once the device-history helpers further down are created. The
  // render-time write-through and `paintLoadedHistory` sit above them, so they
  // reach the store through this ref (SHO-260).
  const persistProjectHistoryRef = useRef<
    ((sessionId: string, messages: any[]) => void) | null
  >(null)
  const hasInjectedInitialMessageRef = useRef(false)
  const isSendingMessageRef = useRef(false)
  const lastUserInputRef = useRef<{
    content: string
    files?: FileAttachment[]
    /** When it was sent — the chat tag's delivery window is read off this (SHO-52). */
    sentAt?: number
  } | null>(null)
  const lastNonEmptyMessagesRef = useRef<UIMessage[]>([])

  // Reset stale state synchronously when the session changes so we never
  // render one frame of the previous session's messages before showing
  // the loading indicator for the new session.
  //
  // Hydrate from the module-level `sessionMessageCache` if we've seen this
  // session before — this is what makes re-visits render instantly instead
  // of briefly showing a loader while the stale-while-revalidate fetch runs.
  if (prevSessionIdRef.current !== currentSessionId) {
    const cachedForSession = currentSessionId
      ? (readSessionMessageCache(currentSessionId) ?? null)
      : null
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
      !currentSessionId ||
        (cachedForSession != null && cachedForSession.length > 0),
    )
  }

  const [messageQueue, setMessageQueue] = useState<QueuedMessage[]>(() =>
    currentSessionId ? (sessionQueueCache.get(currentSessionId) ?? []) : [],
  )
  const isProcessingQueueRef = useRef(false)

  const sessionContextUsage = (currentSession as any)?.contextUsageTokens
  const sessionContextWindow = (currentSession as any)?.contextWindowTokens
  useEffect(() => {
    if (sessionContextUsage > 0 && sessionContextWindow > 0) {
      setContextUsage({
        inputTokens: sessionContextUsage,
        contextWindowTokens: sessionContextWindow,
      })
    }
  }, [sessionContextUsage, sessionContextWindow])

  // Subagent progress tracking
  const [activeSubagents, setActiveSubagents] = useState<
    Map<string, SubagentProgress>
  >(new Map())
  const [recentTools, setRecentTools] = useState<RecentToolCall[]>([])
  const MAX_RECENT_TOOLS = 8
  const [accumulatedSubagentTools, setAccumulatedSubagentTools] = useState<
    ToolCallData[]
  >([])
  const processedProgressEventsRef = useRef<Set<string>>(new Set())

  // Background shell processes the agent has started in this thread that are
  // still running. Seeded from the runtime's process endpoint on load and kept
  // live by `data-process-update` SSE frames during a turn.
  const [runningProcesses, setRunningProcesses] = useState<RunningProcess[]>([])
  const [killingProcesses, setKillingProcesses] = useState<Set<string>>(
    new Set(),
  )

  const fetchRunningProcesses = useCallback(async (): Promise<RunningProcess[] | null> => {
    if (!currentSessionId) return null
    const tasksUrl = buildChatTasksUrl(
      API_URL!,
      projectId,
      localAgentUrl,
      currentSessionId,
      chatWorkspaceId,
    )
    if (!tasksUrl) return null
    try {
      const fetchFn = expoFetch ?? globalThis.fetch
      const headers: Record<string, string> = nativeHeaders
        ? nativeHeaders()
        : {}
      const init = {
        headers,
        credentials: Platform.OS === "web" ? "include" : undefined,
      } as any
      let res = await fetchFn(tasksUrl, init)
      // Runtimes that predate tasks only list shell processes.
      if (res.status === 404) {
        res = await fetchFn(tasksUrl.replace(/\/tasks$/, "/processes"), init)
      }
      if (!res.ok) return null
      const data = await res.json()
      const list = data?.tasks ?? data?.processes
      if (!Array.isArray(list)) return null
      setRunningProcesses((prev) =>
        keepDroppedAsFinished(prev, list as RunningProcess[]),
      )
      return list as RunningProcess[]
    } catch {
      // Non-critical — the panel just won't seed until the next live frame.
      return null
    }
  }, [
    localAgentUrl,
    projectId,
    chatWorkspaceId,
    currentSessionId,
    nativeHeaders,
    expoFetch,
  ])

  const handleKillProcess = useCallback(
    async (runId: string) => {
      const base = agentBaseUrl
      if (!base || !currentSessionId) return
      setKillingProcesses((prev) => new Set(prev).add(runId))
      try {
        const fetchFn = expoFetch ?? globalThis.fetch
        const headers: Record<string, string> = nativeHeaders
          ? nativeHeaders()
          : {}
        const init = {
          method: "POST",
          headers,
          credentials: Platform.OS === "web" ? "include" : undefined,
        } as any
        let res = await fetchFn(
          `${base}/agent/chat/${currentSessionId}/tasks/${encodeURIComponent(runId)}/cancel`,
          init,
        )
        if (res.status === 404) {
          res = await fetchFn(
            `${base}/agent/chat/${currentSessionId}/processes/${runId}/kill`,
            init,
          )
        }
        if (res.ok) {
          const data = await res.json()
          const list = data?.tasks ?? data?.processes
          // The runtime now answers with the dock list, in which a cancelled
          // task is a terminal row (Output still opens, no Kill). Trust it.
          if (Array.isArray(list))
            setRunningProcesses(list as RunningProcess[])
          else
            setRunningProcesses((prev) => prev.filter((p) => p.runId !== runId))
        }
      } catch {
        // Ignore — the live frame / next poll will reconcile.
      } finally {
        setKillingProcesses((prev) => {
          const next = new Set(prev)
          next.delete(runId)
          return next
        })
      }
    },
    [agentBaseUrl, currentSessionId, nativeHeaders, expoFetch],
  )

  const loadTaskOutput = useCallback(
    async (taskId: string): Promise<TaskOutputInfo | null> => {
      const base = agentBaseUrl
      if (!base || !currentSessionId) return null
      try {
        const fetchFn = expoFetch ?? globalThis.fetch
        const headers: Record<string, string> = nativeHeaders ? nativeHeaders() : {}
        const res = await fetchFn(
          `${base}/agent/chat/${currentSessionId}/tasks/${encodeURIComponent(taskId)}/output`,
          { headers, credentials: Platform.OS === "web" ? "include" : undefined } as any,
        )
        if (!res.ok) return null
        const data = await res.json()
        return {
          taskId: typeof data?.taskId === "string" ? data.taskId : taskId,
          source: typeof data?.source === "string" ? data.source : undefined,
          title: typeof data?.title === "string" ? data.title : undefined,
          status: typeof data?.status === "string" ? data.status : undefined,
          outputFile: typeof data?.outputFile === "string" ? data.outputFile : undefined,
          output: typeof data?.output === "string" ? data.output : "",
          link: asTaskLink(data?.link),
        }
      } catch {
        return null
      }
    },
    [agentBaseUrl, currentSessionId, nativeHeaders, expoFetch],
  )

  // Pressing a background task opens where its work is happening: the tagged
  // agent's thread, the card's thread, the callee project's chat, or its log.
  const openTaskThread = useCallback(
    async (taskId: string, hint?: OpenTaskHint) => {
      taskThreadPane.open({
        taskId,
        title: hint?.title,
        source: hint?.source,
        status: hint?.status,
        outputFile: hint?.outputFile,
        link: hint?.link ?? null,
        loading: true,
      })
      const out = await loadTaskOutput(taskId)
      taskThreadPane.patch(taskId, {
        loading: false,
        output: out?.output ?? undefined,
        outputFile: out?.outputFile ?? hint?.outputFile,
        title: out?.title ?? hint?.title,
        source: out?.source ?? hint?.source,
        status: out?.status ?? hint?.status,
        link: out?.link ?? hint?.link ?? null,
        ...(out ? {} : { error: "This task is no longer tracked." }),
      })
    },
    [loadTaskOutput],
  )

  // The agent blocked in `wait` (live `data-task-wait` frames during a turn).
  const [taskWait, setTaskWait] = useState<TaskWaitState | null>(null)

  // Seed the process list whenever the active thread changes.
  useEffect(() => {
    setTaskWait(null)
    if (!currentSessionId) {
      setRunningProcesses([])
      return
    }
    fetchRunningProcesses()
  }, [currentSessionId, fetchRunningProcesses])

  // Durable-turn lifecycle tracking. The runtime emits `data-turn-start`
  // exactly once per turn, periodic `data-turn-seq` heartbeats, and
  // `data-turn-complete` exactly once at clean termination. The fetch-level
  // auto-resume wrapper handles transparent reconnects on premature EOF;
  // these refs let the UI react to the higher-level lifecycle (e.g. show a
  // "stalled" indicator if we ever exhaust the resume budget).
  const currentTurnIdRef = useRef<string | null>(null)
  const turnCompletedRef = useRef<boolean>(false)
  const turnLastSeqRef = useRef<number>(0)
  // Auto-recovery bookkeeping: which turn we've already tried to auto-recover
  // (so a single stalled turn fires recovery exactly once), and a ref-held
  // recovery callback so the early falling-edge effect can invoke the
  // callback that's defined later in the component (same pattern as
  // `handleRetryRef`). `currentSessionIdRef` lets the async recovery loop
  // detect a session switch and bail before reattaching to a stale stream.
  const recoveredTurnIdRef = useRef<string | null>(null)
  const renderDepthErrorTurnIdRef = useRef<string | null>(null)
  const stallRecoveryRef = useRef<(() => void) | null>(null)
  const currentSessionIdRef = useRef<string | null>(null)
  currentSessionIdRef.current = currentSessionId

  const [toolErrorBanner, setToolErrorBanner] = useState<{
    toolkitName: string
    error: string
    isAuthError?: boolean
  } | null>(null)
  const [reconnecting, setReconnecting] = useState(false)
  const [contextUsage, setContextUsage] = useState<{
    inputTokens: number
    contextWindowTokens: number
  } | null>(null)
  const contextUsageThrottleRef = useRef<{
    inputTokens: number
    contextWindowTokens: number
  } | null>(null)
  const contextUsageTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  )
  // Per-turn category rollup from `data-prompt-breakdown` — powers the
  // context-usage popover opened by clicking the ContextTracker ring.
  // Not persisted; recomputed by the gateway every turn.
  const [contextBreakdown, setContextBreakdown] =
    useState<ContextBreakdownData | null>(null)

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
  // Last `data-*` frame from the runtime, transient or not. Transient
  // heartbeats (`data-turn-seq`, `data-tool-progress`) don't touch
  // `messages`, so the idle timeout reads this instead. Unlike
  // `lastChatProgressAtRef` it ignores the API's keep-alive comments.
  const lastRuntimeDataAtRef = useRef<number>(Date.now())

  // Turn idempotency id for the send currently in flight (or about to be).
  // Set in `sendMessageInternal` right before calling `sendMessage()`; the
  // transport's `getClientTurnId` reads it fresh on every POST. A retry of
  // the SAME logical send (the offline send queue re-POSTing after a
  // network failure) passes its previously-generated id back in via
  // `extraBody.clientTurnId` so this ref — and therefore the header the
  // server de-dupes on — stays stable across attempts.
  const pendingClientTurnIdRef = useRef<string | undefined>(undefined)

  // Flipped synchronously in `handleStop` so `onFinish` (which fires after
  // `stop()` finalises the in-flight assistant message) can distinguish a
  // user-initiated abort from a real "agent returned nothing" condition.
  // Without this we raise a scary "context corruption" banner every time
  // the user taps Stop before the model produced any text or tool calls.
  const userInitiatedStopRef = useRef(false)
  // Set just before the stall watchdog calls `stop()`, so `onFinish` can
  // keep a timeout banner instead of wiping error state (silent dropped turns).
  const stallWatchdogTrippedRef = useRef(false)
  // Set while the stream on screen came from `resumeStream()` rather than a
  // send. A joined turn can end and the next one start between the probe and
  // the reconnect, so the reply shown may belong to a different message; the
  // saved history replaces it once the turn is over (see `onFinish`).
  const joinedStreamRef = useRef(false)
  const refreshHistoryRef = useRef<() => void>(() => {})

  // Stable identity across renders: this is a dep of `useChatTransportConfig`'s
  // internal `useMemo`, so an inline arrow here would rebuild `transportConfig`
  // (and therefore `chatTransport`/`useChat`'s transport) on every ChatPanel
  // render instead of only when one of the other transport inputs changes.
  const getClientTurnId = useCallback(() => pendingClientTurnIdRef.current, [])

  const transportConfig = useChatTransportConfig({
    apiBaseUrl: API_URL!,
    projectId,
    workspaceId: chatWorkspaceId,
    localAgentUrl,
    credentials: Platform.OS === "web" ? "include" : "omit",
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
    getClientTurnId,
    // Reopening a live turn gets the message so far in one chunk instead of
    // the whole stream replayed; `withResumeReplayReset` applies it below.
    resumeSnapshot: true,
  })
  // Set once `useChat` has returned `setMessages`; see resume-replay-transport.ts.
  const beforeResumeReplayRef = useRef<() => void>(() => {})
  const applyResumeSnapshotRef = useRef<(message: UIMessage) => void>(() => {})
  // The installed snapshot's id; `displayMessages` folds the SDK's
  // continuation message into it (see `foldSnapshotContinuation`).
  const resumeSnapshotIdRef = useRef<string | null>(null)
  const chatTransport = useMemo(
    () =>
      transportConfig
        ? withResumeReplayReset(
            new DefaultChatTransport(transportConfig),
            () => beforeResumeReplayRef.current(),
            (message) => applyResumeSnapshotRef.current(message),
          )
        : undefined,
    [transportConfig],
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
    experimental_throttle: 50,
    onError: (err) => {
      // Stream failures are recoverable UI state: the retry affordance below
      // handles them. React Native treats console.error as a development
      // exception and opens LogBox over the conversation, so retain a visible
      // diagnostic without turning an ordinary retryable failure into a red
      // screen. Sentry still receives the full error immediately below.
      console.warn("[ChatPanel] Stream error:", err)

      // Surface the transport-failure class in Sentry. This path (network
      // resets → "Connection interrupted. Please tap Retry to continue.") used
      // to be console-only, so a very common source of user-facing pain never
      // appeared in the dashboard. `buildChatStreamErrorReport` returns null for
      // user-initiated aborts (Stop / new message / navigation), and tags the
      // event so the production_web noise filter keeps it despite the raw
      // "Failed to fetch"-style message. The stall watchdog already owns the
      // separate "stuck with no error" case (`chat_stall_watchdog_tripped`).
      if (isReactUpdateDepthError(err)) {
        renderDepthErrorTurnIdRef.current = currentTurnIdRef.current
      }
      try {
        const report = buildChatStreamErrorReport(err, {
          turnId: currentTurnIdRef.current,
          sessionId: currentSessionIdRef.current,
          projectId: projectId ?? null,
          lastSeq: turnLastSeqRef.current,
          userInitiatedStop: userInitiatedStopRef.current,
          phase: "stream",
        })
        if (report) {
          Sentry.captureException(err, {
            level: report.level,
            tags: report.tags,
            extra: report.extra,
            fingerprint: report.fingerprint,
          })
        }
      } catch (reportErr) {
        console.warn(
          "[ChatPanel] failed to report stream error to Sentry:",
          reportErr,
        )
      }

      setMessages((prev) => markStuckToolsInterrupted(prev))
    },
    onData: async (dataPart) => {
      const activePlanStream = isActivePanelRef.current ? planStream : null

      // Any `data-*` frame (including `data-turn-start`, `data-turn-seq`,
      // and `data-usage`) is wire-level forward progress. The AI SDK
      // doesn't flip `status` → `'streaming'` on these — only on the
      // first `text-delta` — so without this bump the watchdog can
      // still trip on a long pre-Anthropic warm-up even after we see
      // bytes. Cheap, safe, and orthogonal to message rendering.
      bumpChatProgress()
      lastRuntimeDataAtRef.current = Date.now()

      // `data-inference-retry` (a dropped model call the runtime re-issued)
      // stays in `message.parts`; `extractOrderedParts` hides the failed
      // attempt's text/reasoning at render time.

      // The runtime's fast inference-retry budget was exhausted on a still-
      // retryable failure and it couldn't reach the model's upstream health
      // endpoint — it's now "parked", polling connectivity with backoff
      // instead of failing the turn (see `packages/agent/src/connectivity.ts`).
      // Drive the "waiting for connection" banner from these heartbeats
      // rather than a client-side timer, since the runtime is the one that
      // actually knows whether it's still parked.
      if (dataPart.type === "data-connectivity-wait") {
        const d = (dataPart as any).data ?? {}
        if (d.state === "reconnected") {
          setConnectivityWait(null)
          // A provider backoff ends with the model already streaming output,
          // so there's no "back online" moment to announce.
          if (d.cause !== "provider") {
            setJustReconnected(true)
            setTimeout(() => setJustReconnected(false), 3000)
          }
        } else {
          setJustReconnected(false)
          setConnectivityWait({
            cause: d.cause === "provider" ? "provider" : "offline",
            reason: typeof d.reason === "string" ? d.reason : undefined,
            attempt: typeof d.attempt === "number" ? d.attempt : 0,
            elapsedMs: typeof d.elapsedMs === "number" ? d.elapsedMs : 0,
            nextProbeInMs:
              typeof d.nextProbeInMs === "number" ? d.nextProbeInMs : 0,
          })
        }
        return
      }

      if (dataPart.type === "data-usage-limit") {
        const d = (dataPart as any).data ?? {}
        setUsageLimitNotice({
          sessionId: currentSessionIdRef.current ?? null,
          resetsAt: typeof d.resetsAt === "string" ? d.resetsAt : undefined,
        })
        refetchUsageWallet()
        return
      }

      // Handle virtual tool events
      if (dataPart.type === "data-virtual-tool") {
        const event = (dataPart as any).data as VirtualToolEvent
        console.log(
          "[ChatPanel:VirtualTool] Received virtual tool event:",
          event,
        )

        if (event.toolName === "navigate_to_phase") {
          const targetPhase = event.args?.phase as string
          if (targetPhase && onNavigateToPhase) {
            console.log(
              "[ChatPanel:VirtualTool] Navigating to phase:",
              targetPhase,
            )
            onNavigateToPhase(targetPhase)
          }
        } else if (event.toolName === "open_panel") {
          const panelId =
            (event.args?.panelId as string) || `panel-${event.toolUseId}`
          const panelType =
            (event.args?.type as "code" | "schema" | "preview" | "docs") ||
            "preview"
          const panelTitle = (event.args?.title as string) || "Panel"
          const panelContent = event.args?.content as React.ReactNode

          if (onOpenPanel) {
            console.log(
              "[ChatPanel:VirtualTool] Opening panel:",
              panelId,
              panelType,
              panelTitle,
            )
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
            console.warn(
              "[ChatPanel:VirtualTool] show_schema called without schemaName",
            )
            return
          }

          console.log(
            "[ChatPanel:VirtualTool] Showing schema:",
            schemaName,
            "defaultTab:",
            defaultTab,
          )

          try {
            if (featureId && platformFeatures?.featureSessionCollection) {
              await platformFeatures.featureSessionCollection.updateOne(
                featureId,
                {
                  schemaName: schemaName,
                },
              )
            }

            if (componentBuilder?.compositionCollection) {
              const workspaceComposition =
                componentBuilder.compositionCollection.findByName?.("workspace")
              if (workspaceComposition) {
                const currentSlotContent =
                  workspaceComposition.slotContent || []
                const hasDesignSection = currentSlotContent.some?.(
                  (slot: any) =>
                    slot.component === "comp-design-container" ||
                    slot.sectionRef === "DesignContainerSection",
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
                    { slotContent: newSlotContent },
                  )
                } else {
                  const updatedSlotContent = currentSlotContent.map?.(
                    (slot: any) => {
                      if (
                        slot.component === "comp-design-container" ||
                        slot.sectionRef === "DesignContainerSection"
                      ) {
                        return {
                          ...slot,
                          config: { ...slot.config, defaultTab },
                        }
                      }
                      return slot
                    },
                  )
                  await componentBuilder.compositionCollection.updateOne(
                    workspaceComposition.id,
                    { slotContent: updatedSlotContent },
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
                await componentBuilder.compositionCollection.insertOne(
                  newComposition,
                )
              }
            }
          } catch (err) {
            console.error(
              "[ChatPanel:VirtualTool] Error handling show_schema:",
              err,
            )
          }
        } else if (event.toolName === "set_workspace") {
          console.log(
            "[ChatPanel:VirtualTool] Setting workspace state:",
            event.args,
          )

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
                await platformFeatures?.featureSessionCollection?.updateOne(
                  featureId,
                  {
                    schemaName: panel.config.schemaName as string,
                  },
                )
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
                  updates,
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
                await componentBuilder.compositionCollection.insertOne(
                  newComposition,
                )
              }
            }
          } catch (err) {
            console.error(
              "[ChatPanel:VirtualTool] Error handling set_workspace:",
              err,
            )
          }
        } else if (event.toolName === "execute") {
          console.log(
            "[ChatPanel:VirtualTool] Executing operations:",
            event.args,
          )

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
                console.warn(
                  `[ChatPanel:VirtualTool] Unknown domain: ${op.domain}`,
                )
                continue
              }

              const collectionName = `${op.model
                .charAt(0)
                .toLowerCase()}${op.model.slice(1)}Collection`
              const collection = store[collectionName]
              if (!collection) {
                console.warn(
                  `[ChatPanel:VirtualTool] Unknown collection: ${collectionName}`,
                )
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
                err,
              )
            }
          }
        } else {
          console.warn(
            "[ChatPanel:VirtualTool] Unknown virtual tool:",
            event.toolName,
          )
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
                next.set(id, {
                  ...subagent,
                  toolCount: subagent.toolCount + 1,
                })
              }
            }
            return next
          })
        }
      }

      // Live background-process list. The runtime emits the full running list
      // on every change, so we replace state wholesale (no reconciliation).
      if (dataPart.type === "data-task-update") {
        const tasks = (dataPart as any).data?.tasks
        if (Array.isArray(tasks)) {
          setRunningProcesses(tasks as RunningProcess[])
        }
      } else if (dataPart.type === "data-process-update") {
        const procs = (dataPart as any).data?.processes
        if (Array.isArray(procs)) {
          setRunningProcesses(procs as RunningProcess[])
        }
      }
      if (dataPart.type === "data-task-wait") {
        const d = (dataPart as any).data
        if (d?.active) {
          setTaskWait({
            taskIds: Array.isArray(d.taskIds) ? d.taskIds : [],
            until: typeof d.until === "string" ? d.until : undefined,
            timeoutMs: typeof d.timeoutMs === "number" ? d.timeoutMs : 30_000,
            startedAt: typeof d.startedAt === "number" ? d.startedAt : Date.now(),
          })
        } else {
          setTaskWait(null)
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
        // A fresh turn can't already be parked — clear any stale banner from
        // a previous turn (defensive; normally a `reconnected` frame already
        // cleared it before the turn completed).
        setConnectivityWait(null)
        setUsageLimitNotice(null)
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
        if (
          typeof d.lastSeq === "number" &&
          d.lastSeq > turnLastSeqRef.current
        ) {
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
        const { teamId, name, description, leaderId } =
          (dataPart as any).data ?? {}
        if (teamId) teamStore.initTeam(teamId, name, description, leaderId)
      }
      if (dataPart.type === "data-team-deleted") {
        const { teamId } = (dataPart as any).data ?? {}
        if (teamId) teamStore.deleteTeam(teamId)
      }
      if (dataPart.type === "data-team-activity") {
        const {
          event,
          agentId: aid,
          teamId: tid,
          reason,
        } = (dataPart as any).data ?? {}
        if (event === "idle") teamStore.updateMemberStatus(aid, tid, "idle")
        else if (event === "wake")
          teamStore.updateMemberStatus(aid, tid, "active")
        else if (event === "shutdown")
          teamStore.updateMemberStatus(aid, tid, "shutdown")
        else if (event === "member-joined") {
          const { name: mName, color } = (dataPart as any).data ?? {}
          teamStore.upsertMember(tid, {
            agentId: aid,
            teamId: tid,
            name: mName,
            color,
            status: "active",
            joinedAt: Date.now(),
          })
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
        const {
          agentId: aid,
          teamId: tid,
          phase,
          textId,
          delta,
        } = (dataPart as any).data ?? {}
        if (phase === "start") {
          teamStore.appendMemberStreamPart(aid, tid, {
            type: "text",
            text: "",
            id: textId,
          })
        } else if (phase === "delta" && delta) {
          teamStore.updateMemberStreamPart(aid, tid, textId, (p) =>
            p.type === "text" ? { ...p, text: p.text + delta } : p,
          )
        } else if (phase === "reasoning-start") {
          teamStore.appendMemberStreamPart(aid, tid, {
            type: "reasoning",
            text: "",
            isStreaming: true,
            id: textId,
          })
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
        const {
          agentId: aid,
          teamId: tid,
          toolCallId,
          toolName,
          phase,
          args,
          result,
          isError,
        } = (dataPart as any).data ?? {}
        if (phase === "start") {
          teamStore.appendMemberStreamPart(aid, tid, {
            type: "tool",
            id: toolCallId,
            tool: {
              id: toolCallId,
              toolName,
              args,
              state: "streaming" as any,
              category: "other" as any,
              timestamp: Date.now(),
            },
          })
        } else if (phase === "output") {
          teamStore.updateMemberStreamPart(aid, tid, toolCallId, (p) =>
            p.type === "tool"
              ? {
                  ...p,
                  tool: {
                    ...p.tool,
                    state: isError ? "error" : "success",
                    result,
                  },
                }
              : p,
          )
        }
      }
      if (dataPart.type === "data-agent-types") {
        const { types } = (dataPart as any).data ?? {}
        if (types) teamStore.setAgentTypes(types)
      }

      if (dataPart.type === "data-tool-error" && !toolErrorBanner) {
        const {
          toolkitName,
          error: errText,
          isAuthError: authErr,
        } = (dataPart as any).data ?? {}
        setToolErrorBanner({
          toolkitName: toolkitName || "Integration",
          error:
            typeof errText === "string"
              ? errText
              : JSON.stringify(errText ?? ""),
          isAuthError: !!authErr,
        })
      }

      if ((dataPart as any).type === "data-plan") {
        const planData = (dataPart as any).data
        if (planData) {
          // A fresh plan event always discards any stale summary belonging
          // to a previous plan; the runtime will re-emit
          // data-plan-summary-* if Dual Plan is enabled for this turn.
          activePlanStream?.resetSummary()
          const normalizedPlan = normalizePlanData({
            ...planData,
            isUpdate: false,
          })
          pendingPlanRef.current = normalizedPlan
          setPendingPlan(normalizedPlan)
          activePlanStream?.setStreamingPlan(normalizedPlan)
          if (normalizedPlan.filepath) {
            activePlanStream?.setStreamingPlanFilepath(normalizedPlan.filepath)
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
            isUpdate: true,
            summary: previousPlan?.summary,
            summaryStatus: previousPlan?.summaryStatus,
          })
          pendingPlanRef.current = normalizedPlan
          setPendingPlan(normalizedPlan)
          activePlanStream?.setStreamingPlan(normalizedPlan)
          if (normalizedPlan.filepath) {
            activePlanStream?.setStreamingPlanFilepath(normalizedPlan.filepath)
          }
        }
        planStream?.notifyPlanCreated()
      }

      // Dual Plan: stakeholder summary lifecycle. The runtime emits these
      // three events asynchronously after create_plan / update_plan so
      // the UI can show a "Summary" tab spinner immediately and then swap in
      // the summary markdown when it's ready.
      if ((dataPart as any).type === "data-plan-summary-start") {
        activePlanStream?.setSummaryStatus("pending")
        activePlanStream?.setStreamingSummary(null)
        activePlanStream?.setSummaryError(null)
        const previousPlan = pendingPlanRef.current
        if (previousPlan) {
          const next = normalizePlanData({
            ...previousPlan,
            summary: undefined,
            summaryStatus: "pending",
          })
          pendingPlanRef.current = next
          setPendingPlan(next)
          activePlanStream?.setStreamingPlan(next)
        }
      }

      if ((dataPart as any).type === "data-plan-summary") {
        const data = (dataPart as any).data
        const summary = typeof data?.summary === "string" ? data.summary : null
        if (summary) {
          activePlanStream?.setSummaryStatus("ready")
          activePlanStream?.setStreamingSummary(summary)
          activePlanStream?.setSummaryError(null)
          const previousPlan = pendingPlanRef.current
          if (previousPlan) {
            const next = normalizePlanData({
              ...previousPlan,
              summary,
              summaryStatus: "ready",
            })
            pendingPlanRef.current = next
            setPendingPlan(next)
            activePlanStream?.setStreamingPlan(next)
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
        activePlanStream?.setSummaryStatus("error")
        activePlanStream?.setSummaryError(message)
        const previousPlan = pendingPlanRef.current
        if (previousPlan) {
          const next = normalizePlanData({
            ...previousPlan,
            summaryStatus: "error",
          })
          pendingPlanRef.current = next
          setPendingPlan(next)
          activePlanStream?.setStreamingPlan(next)
        }
      }

      if ((dataPart as any).type === "data-integration-auth-required") {
        const d = (dataPart as any).data
        if (d && typeof d.provider === "string" && typeof d.connectUrl === "string") {
          setPendingIntegrationAuth({ provider: d.provider, connectUrl: d.connectUrl, message: d.message })
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
            reason: req.reason ?? "",
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
          setContextUsage({
            inputTokens: ctxTokens,
            contextWindowTokens: ctxWindow,
          })
          if (currentSessionId) {
            studioChat.chatSessionCollection
              .update(currentSessionId, {
                contextUsageTokens: ctxTokens,
                contextWindowTokens: ctxWindow,
              } as any)
              .catch((err: any) =>
                console.warn(
                  "[ChatPanel] Failed to persist context usage:",
                  err,
                ),
              )
          }
        }
      }

      if ((dataPart as any).type === "data-prompt-breakdown") {
        const bd = (dataPart as any).data
        if (bd?.categories) {
          setContextBreakdown(bd)
        }
      }
    },
    onFinish: async ({
      message,
      isAbort,
    }: {
      message: any
      isAbort?: boolean
    }) => {
      const contentLength =
        (message as any).content?.length ?? message.parts?.length ?? 0

      if (joinedStreamRef.current) {
        joinedStreamRef.current = false
        // The reply row is still being written when the stream ends.
        for (const delayMs of [600, 2500]) {
          setTimeout(() => refreshHistoryRef.current(), delayMs)
        }
      }

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
        (p: any) => p.type === "text" && p.text?.trim(),
      )
      const hasToolCallsInMessage = message.parts?.some(
        (p: any) => p.type === "tool-invocation" || p.type === "tool-result",
      )
      const hasContent = !!(
        hasTextContent ||
        hasToolCallsInMessage ||
        contentLength > 0
      )
      const nextError = emptyResponseErrorAfterFinish({
        isAbort: !!(isAbort || userInitiatedStopRef.current),
        userInitiatedStop: userInitiatedStopRef.current,
        stallWatchdogTripped: stallWatchdogTrippedRef.current,
        hasContent,
      })
      if (nextError === EMPTY_AGENT_RESPONSE_MESSAGE) {
        console.warn(
          "[ChatPanel] Agent returned empty response — possible context corruption",
        )
      }
      userInitiatedStopRef.current = false
      stallWatchdogTrippedRef.current = false
      setEmptyResponseError(nextError)

      if (currentSessionId) {
        // The chat's workspace is authoritative for this turn — unless the
        // person already moved this screen to another chat (a cross-workspace
        // chip press), in which case the switch they just made wins.
        if (
          workspaceId &&
          shouldRestoreChatWorkspace({
            chatWorkspaceId: workspaceId,
            activeWorkspaceId: getActiveWorkspaceId(),
            finishedSessionId: currentSessionId,
            liveSessionId: currentSessionIdRef.current,
          })
        ) {
          setActiveWorkspaceId(workspaceId, { reason: "automatic" })
        }
        refetchUsageWallet()

        // Read-only reconcile (no client writes). The assistant message is
        // persisted server-side by the streaming proxy (trackUsageFromStream),
        // which writes the canonical row only after the stream EOFs + billing
        // close (+ possible auto-resume) — frequently *after* onFinish fires.
        // The live turn is already on screen via useChat's in-memory messages;
        // this just warms the local cache so a reload reflects the server row.
        // We refetch with a short bounded retry until a new assistant row for
        // this session appears, and NEVER POST (the server is the sole writer).
        const sessionIdForReconcile = currentSessionId
        const assistantParts = Array.isArray(message.parts) ? message.parts : []
        const assistantText = assistantParts
          .filter((p: any) => p?.type === "text" && typeof p.text === "string")
          .map((p: any) => p.text)
          .join("")
          .trim()
        const assistantHasContent =
          assistantText.length > 0 ||
          assistantParts.some(
            (p: any) =>
              p?.type === "tool-invocation" ||
              p?.type === "tool-result" ||
              p?.type === "dynamic-tool" ||
              (typeof p?.type === "string" && p.type.startsWith("tool-")),
          )

        if (assistantHasContent) {
          const priorAssistantIds = new Set(
            (sessionMessages?.all ?? [])
              .filter(
                (m: any) =>
                  m.sessionId === sessionIdForReconcile &&
                  m.role === "assistant",
              )
              .map((m: any) => m.id),
          )
          void (async () => {
            const RECONCILE_ATTEMPTS = 5
            const RECONCILE_DELAY_MS = 400
            for (let attempt = 0; attempt < RECONCILE_ATTEMPTS; attempt++) {
              await new Promise((resolve) =>
                setTimeout(resolve, RECONCILE_DELAY_MS),
              )
              try {
                await sessionMessages?.loadPage(
                  { sessionId: sessionIdForReconcile, agent: "technical" },
                  { limit: MESSAGE_PAGE_SIZE, offset: 0 },
                )
              } catch (err) {
                console.warn(
                  "[ChatPanel] Assistant reconcile refresh failed:",
                  err,
                )
                continue
              }
              const appeared = (sessionMessages?.all ?? []).some(
                (m: any) =>
                  m.sessionId === sessionIdForReconcile &&
                  m.role === "assistant" &&
                  !priorAssistantIds.has(m.id),
              )
              if (appeared) {
                // Repaint once now that the row exists. Warming the cache is
                // not enough: a paint that ran while the row was still missing
                // dropped the reply from the screen, and this is what brings it
                // back — with the server's canonical id, exactly once (SHO-85).
                if (currentSessionIdRef.current === sessionIdForReconcile) {
                  paintLoadedHistoryRef.current(sessionIdForReconcile, {
                    requireReply: false,
                  })
                }
                return
              }
            }
            console.warn(
              "[ChatPanel] Assistant message not yet persisted after reconcile retries — relying on next full reload",
            )
          })()
        }

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
              "platformFeatures",
            ).catch((err) => {
              console.warn(
                "[ChatPanel] Smart refresh (platformFeatures) failed:",
                err,
              )
            })
          }
          if (componentBuilderCollections.length > 0) {
            refreshCollections(
              componentBuilder,
              componentBuilderCollections,
              "componentBuilder",
            ).catch((err) => {
              console.warn(
                "[ChatPanel] Smart refresh (componentBuilder) failed:",
                err,
              )
            })
          }

          if (onRefresh) {
            onRefresh().catch((err) => {
              console.warn("[ChatPanel] onRefresh callback failed:", err)
            })
          }
        }
      }

      fetchQuickActions()

      // Fallback for messages that bypass sendMessageInternal. Normal user
      // sends start naming immediately when the first message is submitted.
      if (currentSessionId && !hasTriggeredNamingRef.current) {
        const firstUserMsg = messages.find((m: any) => m.role === "user")
        const userText = firstUserMsg?.parts
          ?.filter((p: any) => p.type === "text")
          .map((p: any) => p.text)
          .join(" ")
          ?.trim()
        if (userText) {
          maybeAutoNameSession(currentSessionId, userText)
        }
      }
    },
  })
  beforeResumeReplayRef.current = () =>
    setMessages((prev) => dropUnfinishedAssistantTail(prev))
  applyResumeSnapshotRef.current = (message) => {
    resumeSnapshotIdRef.current = message.id
    setMessages((prev) => applyMessageSnapshot(prev, message))
  }

  // All resume paths share a single-flight guard. The history-load probe and
  // delegated-task reconciliation can finish at the same time when the app is
  // reopened, and the stall detector can overlap either of them. AI SDK's
  // Chat object only supports one active `resumeStream()` request per session;
  // concurrent calls race while cleaning up `activeResponse` and can throw
  // "Cannot read property 'state' of undefined" from its `onFinish` path.
  // User-initiated Retry remains outside the automatic circuit breaker, but it
  // reuses an already-running resume instead of starting a second one.
  const resumeStreamInFlightRef = useRef<ResumeStreamFlightRef<void>>({
    current: null,
  })
  const resumeStreamSingleFlight = useCallback(() => {
    return runResumeStreamSingleFlight(
      resumeStreamInFlightRef.current,
      currentSessionId,
      () => {
        joinedStreamRef.current = true
        return resumeStream()
      },
    )
  }, [currentSessionId, resumeStream])

  // Circuit breaker for the *automatic* resume paths (Effect 1's post-load
  // live-turn probe and `attemptStallRecovery`'s stall detector below).
  //
  // Both automatic paths are individually guarded against re-firing for the
  // *same* turn, but a real-world log showed a ~45min storm of `resumeStream()`
  // calls every ~8-10s, each replaying the AI SDK's default `/stream` resume
  // convention from `fromSeq=0` (the default has no way to carry our custom
  // seq cursor — see `buildChatTurnUrl` — so every automatic reattach re-reads
  // the *entire* buffered turn from the start). If the freshly-reattached
  // stream itself stalls quickly (e.g. because the client is offline, or the
  // reattach races a session-boundary edge case), each of these paths can
  // still legitimately re-fire on what looks like forward progress, and
  // nothing previously stopped that from repeating indefinitely.
  //
  // This tracks a rolling window of automatic-resume timestamps (see
  // `recordAutoResumeAttempt`) and trips once too many happen too quickly,
  // falling back to the static "tap Retry" banner instead of hammering the
  // runtime forever. Deliberately generous (a handful of legitimate
  // reattaches — e.g. flaky wifi during a long tool run — shouldn't trip it)
  // but tight enough to kill a tight reconnect loop.
  const autoResumeTimestampsRef = useRef<number[]>([])
  const autoResumeCircuitTrippedRef = useRef(false)
  // One reload per blocked attach: repainting history is what puts the missing
  // prompt on screen, and the reload's own probe attaches from there.
  const blockedAttachReloadAtRef = useRef(0)
  /** A probe found a live turn whose prompt the screen has not painted (SHO-147). */
  const reportLiveTurnAttachBlocked = useCallback(
    (context: string, reason: string) => {
      console.warn(
        `[ChatPanel] Refused to attach the live turn (${context}, reason=${reason}); reloading history first`,
      )
      try {
        Sentry.captureMessage("chat_live_turn_attach_blocked", {
          level: "warning",
          tags: { context, reason },
          extra: {
            sessionId: currentSessionIdRef.current,
            turnId: currentTurnIdRef.current,
            screenRows: cachedMessagesRef.current?.length ?? 0,
            historyRows: sessionMessages?.all?.length ?? 0,
          },
        })
      } catch (err) {
        console.warn("[ChatPanel] Sentry.captureMessage threw:", err)
      }
    },
    [sessionMessages],
  )
  const guardedAutoResumeStream = useCallback(
    (reason: "live-turn-probe" | "stall-recovery") => {
      if (autoResumeCircuitTrippedRef.current) {
        return
      }
      // A second probe can resolve before the first `resumeStream()` updates
      // the AI SDK status. Do not count or start that duplicate attempt.
      if (
        resumeStreamInFlightRef.current.current?.sessionId === currentSessionId
      ) {
        return
      }
      // Never attach to a turn whose prompt is not on screen (SHO-147). The
      // stream carries only the assistant reply, so with no user row between it
      // and the reply above, the one-assistant-per-turn grouping gives the new
      // reply the previous turn's bubble. Painting history is what puts the
      // missing prompt there — and that load's own probe attaches from there.
      const gate = resolveLiveTurnAttach({
        screen: cachedMessagesRef.current ?? [],
        history: sessionMessages?.all ?? [],
      })
      if (!gate.attach) {
        reportLiveTurnAttachBlocked(reason, gate.reason)
        if (Date.now() - blockedAttachReloadAtRef.current > 1000) {
          blockedAttachReloadAtRef.current = Date.now()
          reloadAndAttachLiveTurnRef.current({ settle: false })
        }
        return
      }
      const { timestamps, tripped } = recordAutoResumeAttempt(
        autoResumeTimestampsRef.current,
        Date.now(),
      )
      autoResumeTimestampsRef.current = timestamps
      if (tripped) {
        autoResumeCircuitTrippedRef.current = true
        console.error(
          `[ChatPanel] Auto-resume circuit breaker tripped (${timestamps.length} automatic reconnects in the last minute, reason=${reason}); ` +
            "giving up on auto-recovery and falling back to the manual Retry banner",
        )
        try {
          Sentry.captureMessage("chat_auto_resume_circuit_breaker_tripped", {
            level: "warning",
            tags: { reason },
            extra: {
              turnId: currentTurnIdRef.current,
              sessionId: currentSessionIdRef.current,
              projectId: projectId ?? null,
              lastSeq: turnLastSeqRef.current,
              attemptsInWindow: timestamps.length,
            },
          })
        } catch (reportErr) {
          console.warn(
            "[ChatPanel] failed to report circuit breaker trip to Sentry:",
            reportErr,
          )
        }
        return
      }
      void resumeStreamSingleFlight()
    },
    [currentSessionId, projectId, resumeStreamSingleFlight, reportLiveTurnAttachBlocked, sessionMessages],
  )
  // A session switch means the user navigated away from whatever was
  // looping — give the (new) session a clean breaker rather than carrying a
  // trip from an unrelated chat forever.
  useEffect(() => {
    autoResumeTimestampsRef.current = []
    autoResumeCircuitTrippedRef.current = false
  }, [currentSessionId])

  // The transcript as it stood when the user pressed Stop, with the stopped
  // reply stamped as finished (see stopped-turn.ts). Held on screen while the
  // SDK settles so the reply can't blink out between the abort and the next
  // render, and released — merged into the live array, never over it — as soon
  // as anything else needs the window.
  const [stoppedMessages, setStoppedMessages] = useState<UIMessage[] | null>(
    null,
  )
  const stoppedMessagesRef = useRef<UIMessage[] | null>(null)
  // The turn Stop cancelled. A send right after Stop must not wait behind it.
  const stoppedTurnIdRef = useRef<string | null>(null)
  const releaseStopSnapshot = useCallback(() => {
    const snapshot = stoppedMessagesRef.current
    stoppedMessagesRef.current = null
    setStoppedMessages(null)
    if (!snapshot) return
    setMessages((prev) => mergeStoppedSnapshot(prev, snapshot))
  }, [setMessages])
  // Stop state belongs to one chat: carrying a snapshot (or a cancelled turn
  // id) into another one would hold that chat's transcript still.
  useEffect(() => {
    stoppedMessagesRef.current = null
    stoppedTurnIdRef.current = null
    setStoppedMessages(null)
  }, [currentSessionId])
  // Keep the stop control visible while the transport is recovering a turn
  // whose server-side agent may still be running.
  const [streamAutoRecovering, setStreamAutoRecovering] = useState(false)
  const messagesRef = useRef(messages)
  messagesRef.current = messages

  // SHO-263: adopt the persisted `ChatMessage.id` for every bubble sent in
  // this page session (see `use-persisted-message-ids`). Without this the
  // transcript keeps useChat's nanoids, which no server route can resolve —
  // `truncate-from` 404s and the edit silently rolls back.
  const handleIdAdopted = useCallback((from: string, to: string) => {
    // The swap can land while an editor is already open on that bubble (the
    // POST resolves a beat after the send). Move the edit state onto the row
    // id instead of letting the editor vanish under the user.
    setEditingMessageId((prev) => (prev === from ? to : prev))
    setPendingEdit((prev) =>
      prev && prev.messageId === from ? { ...prev, messageId: to } : prev,
    )
    setRevertedNotes((prev) => {
      const note = prev[from]
      if (!note) return prev
      const next = { ...prev }
      delete next[from]
      next[to] = note
      return next
    })
  }, [])

  const { adopt: adoptPersistedUserId } = usePersistedMessageIds(
    messages,
    setMessages,
    handleIdAdopted,
  )


  if (isActive && messages.length > 0) {
    cachedMessagesRef.current = messages
    if (currentSessionId) {
      // Keep the module cache in sync with the latest UI state so a subsequent
      // session switch (or panel remount) can hydrate instantly. This runs on
      // every render while streaming, which is cheap (Map.set by reference).
      writeSessionMessageCache(currentSessionId, messages)
      persistProjectHistoryRef.current?.(currentSessionId, messages)
    }
  }
  if (messages.length > 0) {
    lastNonEmptyMessagesRef.current = messages
  }

  const isTransportStreaming =
    (status === "streaming" || status === "submitted") &&
    stoppedMessages === null
  const isStreaming =
    (isTransportStreaming || streamAutoRecovering) && stoppedMessages === null

  const reloadAndAttachLiveTurnRef = useRef<
    (opts?: { settle?: boolean }) => void
  >(() => {})
  const resumeQueuedTurn = useCallback(
    (queuedUserMessage?: UIMessage) => {
      // Whatever happens next, the transcript is live again: the stop
      // snapshot's reply is merged in rather than left frozen behind this turn.
      releaseStopSnapshot()
      if (!queuedUserMessage) {
        reloadAndAttachLiveTurnRef.current()
        return
      }
      const onScreen = messagesRef.current.some(
        (m) => m.id === queuedUserMessage.id,
      );
      // Queued messages are not in this list at all any more — only the dock
      // shows them — so a message already here came from the server's history
      // (a reload while its turn was running). If nothing landed after it,
      // this turn's reply belongs at the end and attaching directly is right;
      // if something did, the transcript has moved on and history is the truth.
      if (onScreen && !canAttachQueuedTurn(messagesRef.current, queuedUserMessage)) {
        reloadAndAttachLiveTurnRef.current()
        return
      }
      // The server saved the queued message and started its turn: append it at
      // the end and attach the reply under it, without reloading history. This
      // is the normal path — the bubble first appears here, when the turn it
      // belongs to starts.
      if (!onScreen) {
        setMessages((prev) => appendQueuedUserMessage(prev, queuedUserMessage))
      }
      void resumeStreamSingleFlight().catch((error) => {
        console.warn("[ChatPanel] Failed to attach to queued turn:", error)
      })
    },
    [releaseStopSnapshot, resumeStreamSingleFlight, setMessages],
  )
  const serverQueue = useServerMessageQueue({
    sessionId: currentSessionId,
    enabled: !!currentSessionId && !localAgentUrl,
    isStreaming,
    onTurnAvailable: resumeQueuedTurn,
  })

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
      const safeName = (toolName || "tool").replace(/_/g, " ")
      // Extract any obvious file / path hint from the args, but in a
      // humanised form (strip leading slashes, trim long paths).
      let target = ""
      if (args && typeof args === "object") {
        const a = args as Record<string, unknown>
        const candidate =
          (typeof a.path === "string" && a.path) ||
          (typeof a.file === "string" && a.file) ||
          (typeof a.filename === "string" && a.filename) ||
          (typeof a.target === "string" && a.target) ||
          (typeof a.name === "string" && a.name) ||
          (typeof a.query === "string" && a.query) ||
          ""
        if (candidate) {
          const basename =
            String(candidate).split(/[\\/]/).pop() || String(candidate)
          target = basename.length > 60 ? basename.slice(0, 60) + "…" : basename
        }
      }
      return target ? `${safeName}: ${target}` : safeName
    }

    for (const msg of messages) {
      if ((msg as any).role !== "assistant") continue
      const parts = (msg as any).parts as any[] | undefined
      if (!Array.isArray(parts)) continue
      parts.forEach((part, idx) => {
        if (part.type !== "tool-invocation" && part.type !== "dynamic-tool")
          return
        const inv = part.type === "tool-invocation" ? part.toolInvocation : part
        const toolName = (inv?.toolName ?? part.toolName ?? "tool") as string
        const toolCallId = (inv?.toolCallId ??
          part.toolCallId ??
          `${idx}`) as string
        const rawState = (inv?.state ?? part.state ?? "") as string
        const isEnd =
          rawState === "result" ||
          rawState === "output-available" ||
          rawState === "success" ||
          rawState === "error" ||
          rawState === "output-error"
        const isStart =
          rawState === "partial-call" ||
          rawState === "call" ||
          rawState === "input-streaming" ||
          rawState === "input-available"
        if (!isStart && !isEnd) return

        const key = `${(msg as any).id || "nomsg"}:${toolCallId}`
        const last = stateMap.get(key)
        if (isStart && last === undefined) {
          stateMap.set(key, "start")
          try {
            emit({
              toolName,
              phase: "start",
              label: labelForTool(
                toolName,
                inv?.args ?? part.input ?? part.args,
              ),
            })
          } catch (err) {
            console.warn(
              "[ChatPanel] bridge.emitToolActivity(start) threw",
              err,
            )
          }
        } else if (isEnd && last !== "end") {
          stateMap.set(key, "end")
          const ok = rawState !== "error" && rawState !== "output-error"
          try {
            emit({
              toolName,
              phase: "end",
              label: labelForTool(
                toolName,
                inv?.args ?? part.input ?? part.args,
              ),
              ok,
            })
          } catch (err) {
            console.warn("[ChatPanel] bridge.emitToolActivity(end) threw", err)
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
      console.warn("[ChatPanel] bridge.setSubagentCards threw", err)
    }
  }, [messages])

  // Abort any active stream when this panel unmounts (e.g. tab closed)
  const stopRef = useRef(stop)
  stopRef.current = stop
  useEffect(() => {
    return () => {
      stopRef.current()
    }
  }, [])

  // The SDK settled after Stop: hand the transcript back. Merging (not
  // replacing) keeps anything the window gained after the stop — the next
  // message's bubble and its reply — and the stop marker keeps the cancelled
  // reply classified as finished for the next replay.
  useEffect(() => {
    if (status !== "ready" || stoppedMessages === null) return
    releaseStopSnapshot()
  }, [status, stoppedMessages, releaseStopSnapshot])

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

  const [emptyResponseError, setEmptyResponseError] = useState<string | null>(
    null,
  )
  // Non-null while an attachment's bytes are going up, so a 200 MB file shows
  // movement instead of a frozen composer (the chips are cleared on submit).
  const [uploadStatus, setUploadStatus] = useState<{
    name: string
    fraction: number
  } | null>(null)
  const [errorBannerExpanded, setErrorBannerExpanded] = useState(false)
  const [errorDismissed, setErrorDismissed] = useState(false)
  const [tunnelReconnecting, setTunnelReconnecting] = useState(false)
  // Non-null while the runtime's agent loop is "parked" waiting for internet
  // connectivity to return (see `data-connectivity-wait` handling in
  // `onData` above). Distinct from `streamAutoRecovering`: that one is the
  // CLIENT reconnecting its display stream to a turn that's still running
  // server-side; this one is the SERVER's model call itself unable to reach
  // the internet. Both can't be true at once in practice (a parked turn
  // keeps sending heartbeats, so the client's own stream never goes stale),
  // but they're tracked separately since they have different causes and
  // different user-facing copy.
  const [connectivityWait, setConnectivityWait] = useState<{
    // "provider": the network is fine but the model provider is overloaded
    // or failing, and the runtime is backing off before re-issuing.
    cause: "offline" | "provider"
    reason?: string
    attempt: number
    elapsedMs: number
    nextProbeInMs: number
  } | null>(null)
  // Briefly true right after a park ends, to show "Back online, resuming…"
  // instead of just silently clearing the banner.
  const [justReconnected, setJustReconnected] = useState(false)
  // Set when the runtime ended a turn early because the workspace hit its
  // usage limit (`data-usage-limit`). Scoped to the session it came from.
  const [usageLimitNotice, setUsageLimitNotice] = useState<{
    sessionId: string | null
    resetsAt?: string
  } | null>(null)

  const isRemoteInstance = !!localAgentUrl
  const isTunnelError = !!(
    error &&
    isRemoteInstance &&
    isTunnelDisconnectError(error.message)
  )
  const { clearInstance: clearActiveInstance } = useActiveInstance()

  const errorBannerText = useMemo(() => {
    if (isTunnelError && tunnelReconnecting)
      return "Connection to desktop instance lost. Reconnecting\u2026"
    if (isTunnelError)
      return "Connection to desktop instance lost. Tap Reconnect to retry."
    if (streamAutoRecovering)
      return "Connection interrupted. Reconnecting\u2026"
    return (
      (error ? formatErrorMessage(error.message) : emptyResponseError) ?? ""
    )
  }, [
    error?.message,
    emptyResponseError,
    isTunnelError,
    tunnelReconnecting,
    streamAutoRecovering,
  ])
  useEffect(() => {
    setErrorBannerExpanded(false)
    // A new error message after a dismissal should re-surface the banner —
    // otherwise tapping X once would permanently mute future errors.
    setErrorDismissed(false)
  }, [errorBannerText])

  const usageLimitView = useMemo(
    () =>
      usageLimitNoticeFor({
        error: error?.message,
        errorDismissed,
        stoppedTurn: usageLimitNotice,
        currentSessionId,
        trialEligible,
      }),
    [error?.message, errorDismissed, usageLimitNotice, currentSessionId, trialEligible],
  )
  const usageLimitBlocked = usageLimitView?.variant === "blocked"
  useEffect(() => {
    if (usageLimitBlocked) refetchUsageWallet()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [usageLimitBlocked])

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
          const hdrs: Record<string, string> = nativeHeaders
            ? nativeHeaders()
            : {}
          const res = await fetchFn(`${localAgentUrl}/agent/health`, {
            headers: hdrs,
            credentials: Platform.OS === "web" ? "include" : undefined,
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
    return () => {
      cancelled = true
    }
  }, [isTunnelError, localAgentUrl])

  const errorBannerNeedsReadMore =
    errorBannerText.split(/\n/).length > 2 || errorBannerText.length > 140

  const connectivityWaitElapsedLabel = useMemo(() => {
    if (!connectivityWait) return ""
    const totalSec = Math.max(0, Math.floor(connectivityWait.elapsedMs / 1000))
    const mins = Math.floor(totalSec / 60)
    const secs = totalSec % 60
    return mins > 0 ? `${mins}m ${secs}s` : `${secs}s`
  }, [connectivityWait])

  const [pendingInitialMessage, setPendingInitialMessage] = useState<
    string | null
  >(null)
  const [optimisticUserInput, setOptimisticUserInput] =
    useState<OptimisticUserInput | null>(null)

  // The agent needs the person's own account on an integration.
  const [pendingIntegrationAuth, setPendingIntegrationAuth] = useState<IntegrationAuthRequest | null>(null)

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

  /**
   * The transcript plus the bubble of a dispatched head the panel has not
   * attached yet. Only used to tell whether the pre-send echo has been
   * superseded by the real message — still-queued rows are not in here (they
   * live in the dock), so queueing clears the echo explicitly.
   */
  const messagesWithQueued = useMemo(
    () => appendQueuedUserMessages(messages, serverQueue.pendingUserMessages),
    [messages, serverQueue.pendingUserMessages],
  )

  useEffect(() => {
    if (!optimisticUserInput) return
    if (optimisticUserInput.sessionId !== currentSessionId) {
      setOptimisticUserInput(null)
      return
    }
    if (hasMatchingUserMessage(messagesWithQueued, optimisticUserInput)) {
      setOptimisticUserInput(null)
    }
  }, [currentSessionId, messagesWithQueued, optimisticUserInput])

  // A big web pick paints its echo from a `blob:` object URL, and the real
  // message carries a workspace URL instead — so once this echo is replaced or
  // dropped, nothing can reach that blob again and it is released here. The
  // composer deliberately keeps its own copy alive through the send (see
  // `resetAttachments`), so the release belongs to the echo's lifetime.
  useEffect(() => {
    const files = optimisticUserInput?.files ?? []
    return () => {
      for (const file of files) releasePreviewUrl(file.previewUrl)
    }
  }, [optimisticUserInput])

  const displayMessages = useMemo((): UIMessage[] => {
    // While the stop snapshot is held, the window still shows it — merged with
    // the live array so a message sent after Stop appears under the reply it
    // followed, instead of being hidden behind the frozen transcript.
    const effectiveMessages = appendQueuedUserMessages(
      foldSnapshotContinuation(
        stoppedMessages ? mergeStoppedSnapshot(messages, stoppedMessages) : messages,
        resumeSnapshotIdRef.current,
      ),
      serverQueue.pendingUserMessages,
    )
    const currentOptimisticInput =
      optimisticUserInput?.sessionId === currentSessionId
        ? optimisticUserInput
        : null

    if (effectiveMessages.length > 0) {
      return stampSendTime(
        appendOptimisticEcho(effectiveMessages, currentOptimisticInput),
        lastUserInputRef.current,
      )
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
        lastInput?.content &&
        (!lastFallbackMsg || lastFallbackMsg.role !== "user")

      if (needsOptimisticUser) {
        return [...fallback, buildOptimisticUserMessage(lastInput)]
      }
      return fallback
    }

    const text = (
      pendingInitialMessage ??
      initialMessage ??
      initialMessageRef.current ??
      ""
    ).trim()
    if (text !== "") {
      return [
        {
          id: "initial-optimistic",
          role: "user",
          parts: [{ type: "text", text }],
        } as unknown as UIMessage,
      ]
    }
    // A brand-new chat has no other message to show, but the person's own
    // bubble is already known — paint it while the send is still in flight.
    if (currentOptimisticInput) {
      return appendOptimisticEcho([], currentOptimisticInput)
    }
    return []
  }, [
    currentSessionId,
    messages,
    serverQueue.pendingUserMessages,
    stoppedMessages,
    pendingInitialMessage,
    initialMessage,
    optimisticUserInput,
    isStreaming,
  ])

  /**
   * Paints the user's own bubble. `ChatInput` clears the composer synchronously
   * on submit, so anything awaited before this (the live-turn probe, the consent
   * modal) leaves the transcript frozen for that whole round trip.
   */
  const showOptimisticEcho = useCallback(
    (content: string, files?: FileAttachment[]) => {
      if (!currentSessionId) return
      const trimmedContent = content.trim()
      const fileArray = files ?? []
      if (!trimmedContent && fileArray.length === 0) return
      lastUserInputRef.current = { content: trimmedContent, files: fileArray, sentAt: Date.now() }
      const baselineUserId = newestUserId(messagesRef.current)
      setOptimisticUserInput((current) =>
        current &&
        current.sessionId === currentSessionId &&
        current.content === trimmedContent
          ? current
          : {
              sessionId: currentSessionId,
              content: trimmedContent,
              files: fileArray,
              baselineUserId,
              sentAt: lastUserInputRef.current?.sentAt,
            },
      )
    },
    [currentSessionId],
  )

  /** Drops the echo painted for a queued send that will not run as it was sent. */
  const clearOptimisticEcho = useCallback(
    (content: string) => {
      const trimmedContent = content.trim()
      setOptimisticUserInput((current) =>
        current &&
        current.sessionId === currentSessionId &&
        current.content === trimmedContent
          ? null
          : current,
      )
    },
    [currentSessionId],
  )

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
  const isTransportStreamingRef = useRef(false)
  isStreamingRef.current = isStreaming
  isTransportStreamingRef.current = isTransportStreaming

  const probeLiveTurn = useCallback(
    async (
      sessionId: string,
      opts: { retryDelaysMs?: readonly number[]; timeoutMs?: number } = {},
    ): Promise<ChatTurnSnapshot> => {
      const controller = new AbortController()
      const timer =
        opts.timeoutMs !== undefined
          ? setTimeout(() => controller.abort(), opts.timeoutMs)
          : undefined
      try {
        return await probeChatTurn({
          url: buildChatTurnUrl(
            API_URL!,
            projectId,
            localAgentUrl,
            sessionId,
            chatWorkspaceId,
          ),
          fetch: expoFetch,
          headers: nativeHeaders ? nativeHeaders() : undefined,
          credentials: Platform.OS === "web" ? "include" : undefined,
          retryDelaysMs: opts.retryDelaysMs,
          signal: controller.signal,
        })
      } finally {
        if (timer) clearTimeout(timer)
      }
    },
    [projectId, localAgentUrl, chatWorkspaceId, expoFetch, nativeHeaders],
  )

  /**
   * The newest saved row for this chat, one row wide. A refocus has to tell
   * "this chat is up to date" from "a turn was written while this window was
   * in the background" without pulling the transcript (SHO-53). The row is
   * read newest-first: the list route only orders when it is told to, and an
   * unordered `limit=1` hands back an arbitrary row — in local mode the oldest
   * one, which made every refocus reload the transcript (SHO-99).
   */
  const probePersistedTail = useCallback(
    async (sessionId: string): Promise<PersistedTail | null> => {
      if (!API_URL) return null
      const query = persistedTailQuery(sessionId)
      try {
        // Same insert point as the transcript itself (`/api/chat-messages` is
        // routed by the SDK interceptor): read the row from the same places the
        // messages come from, or a machine workspace would compare its
        // transcript against a cloud chat and think history moved.
        const body = domainHttp
          ? (await domainHttp.get<{ items?: any[] }>("/api/chat-messages", query)).data
          : await (expoFetch ?? globalThis.fetch)(
              `${API_URL}/api/chat-messages?${new URLSearchParams(query).toString()}`,
              {
                headers: nativeHeaders ? nativeHeaders() : {},
                credentials: Platform.OS === "web" ? "include" : undefined,
              } as any,
            )
              .then((response) => (response.ok ? response.json().catch(() => null) : null))
              .catch(() => null)
        const newest = Array.isArray(body?.items) ? body.items[0] : null
        if (!newest?.id) return null
        let parts: any = newest.parts
        if (typeof parts === "string") {
          try {
            parts = JSON.parse(parts)
          } catch {
            parts = []
          }
        }
        return {
          id: String(newest.id),
          role: typeof newest.role === "string" ? newest.role : null,
          content: typeof newest.content === "string" ? newest.content : null,
          turnStartedAt: messageTurnStartedAt({ parts }),
          contentLength:
            typeof newest.content === "string" ? newest.content.length : null,
        }
      } catch {
        // A failed read is not evidence of a missed turn: leave the panel be.
        return null
      }
    },
    [expoFetch, nativeHeaders, domainHttp],
  )

  // A turn this panel is not attached to (started in another window, by
  // another member, by a schedule, or dispatched from a queue another window
  // filled) streams to nobody here until something attaches to it. Nothing
  // pushes that to the panel, so check when the person comes back to the
  // window and right after a turn here ends (when a queued message starts).
  const lastLiveTurnCheckAtRef = useRef(0)
  // The live turn's stream carries only the assistant reply; attached on its
  // own it merges into the previous reply. Reload history first (it has the
  // turn's user message), which then probes and attaches (Effect 1).
  const [liveTurnReloadNonce, setLiveTurnReloadNonce] = useState(0)
  // Set while a reload is chasing a turn believed to be running. If that turn
  // ends before the reload's probe, the history may hold its reply mid-write,
  // so Effect 1 loads once more.
  const liveTurnExpectedRef = useRef(false)
  const liveTurnReloadNonceRef = useRef(0)
  // The nonce of a reload that only refreshes the history; Effect 1 skips its
  // probe so these never count against the auto-resume circuit breaker.
  const historyOnlyNonceRef = useRef(-1)
  const reloadAndAttachLiveTurn = useCallback(
    (opts?: { settle?: boolean }) => {
      const sessionId = currentSessionIdRef.current
      if (!sessionId) return
      liveTurnExpectedRef.current = opts?.settle !== false
      cacheRefreshedAtRef.current.delete(sessionId)
      setLiveTurnReloadNonce(++liveTurnReloadNonceRef.current)
    },
    [],
  )
  reloadAndAttachLiveTurnRef.current = reloadAndAttachLiveTurn
  refreshHistoryRef.current = () => {
    const sessionId = currentSessionIdRef.current
    if (!sessionId) return
    cacheRefreshedAtRef.current.delete(sessionId)
    historyOnlyNonceRef.current = ++liveTurnReloadNonceRef.current
    setLiveTurnReloadNonce(liveTurnReloadNonceRef.current)
  }
  /**
   * @returns true when a live turn was found and this window started attaching
   * to it. Callers that got `false` know nothing is running *yet*.
   */
  const attachToLiveTurnIfAny = useCallback(async (): Promise<boolean> => {
    const sessionId = currentSessionIdRef.current
    if (!sessionId || isStreamingRef.current || isSendingMessageRef.current) {
      return false
    }
    lastLiveTurnCheckAtRef.current = Date.now()
    const turn = await probeLiveTurn(sessionId)
    if (
      currentSessionIdRef.current !== sessionId ||
      isStreamingRef.current ||
      isSendingMessageRef.current
    ) {
      return false
    }
    // The turn Stop just cancelled can still read `active`: attaching to it
    // would rebuild the reply the user stopped and hide the one that follows.
    if (!isLiveTurnOtherThan(turn, stoppedTurnIdRef.current)) return false
    reloadAndAttachLiveTurn()
    return true
  }, [probeLiveTurn, reloadAndAttachLiveTurn])

  const attachToLiveTurnIfAnyRef = useRef(attachToLiveTurnIfAny)
  attachToLiveTurnIfAnyRef.current = attachToLiveTurnIfAny

  /**
   * A paint from history was refused because the reply on screen is newer than
   * anything the server has written (SHO-85). Reported once per paint, never on
   * the happy path: without it the next "my reply vanished" report has nothing
   * to look at.
   */
  const reportHistoryPaintKeptLiveTail = useCallback(
    (context: string, reason: string, history: readonly any[]) => {
      const historyTailRole = history[history.length - 1]?.role ?? "none"
      console.warn(
        `[ChatPanel] Kept the on-screen reply instead of painting history (${context}, reason=${reason}, ` +
          `historyTailRole=${historyTailRole}, historyRows=${history.length})`,
      )
      try {
        Sentry.captureMessage("chat_history_paint_dropped_reply", {
          level: "warning",
          tags: { context, reason },
          extra: {
            sessionId: currentSessionIdRef.current,
            turnId: currentTurnIdRef.current,
            historyTailRole,
            historyRows: history.length,
            screenRows: messagesRef.current.length,
            attempt: historyPaintAttemptRef.current,
          },
        })
      } catch (err) {
        console.warn("[ChatPanel] Sentry.captureMessage threw:", err)
      }
    },
    [],
  )

  /**
   * Paint the transcript from what the message store holds, unless that would
   * drop a reply the API has not written yet (SHO-85).
   */
  const paintLoadedHistory = useCallback(
    (sessionId: string, options: { requireReply?: boolean; keepsLiveTail?: boolean } = {}) => {
      if (!sessionMessages) return
      const loaded = [...sessionMessages.all].sort(
        (a: any, b: any) =>
          messageTimestamp(a.createdAt) - messageTimestamp(b.createdAt),
      )
      if (options.requireReply !== false) {
        const promptIndex = pendingExternalPromptIndex(loaded)
        if (promptIndex < 0 || !externalPromptHasResponse(loaded, promptIndex)) return
      }

      const aiMessages = loaded.map((message: any) => {
        const next: any = {
          id: message.id,
          role: message.role as "user" | "assistant",
          content: message.content ?? extractTextContent(message),
          createdAt: message.createdAt,
        }
        if (message.parts) {
          try {
            next.parts = JSON.parse(message.parts)
          } catch {
            // Keep the text content when an older message has malformed parts.
          }
        }
        return next
      })
      const cached = cachedMessagesRef.current
      const paint = resolveHistoryPaint({
        history: aiMessages,
        current: cached ?? [],
        keepsLiveTail:
          options.keepsLiveTail ?? liveReplySessionRef.current === sessionId,
      })
      if (paint.keptLiveTail) {
        historyPaintAttemptRef.current += 1
        reportHistoryPaintKeptLiveTail("paintLoadedHistory", paint.reason, aiMessages)
        return
      }
      // Paint the decision's transcript, not raw history: when history is ahead
      // of the screen it carries the reply that only exists on screen (SHO-147).
      const painted = paint.messages as any[]
      const unchanged =
        cached?.length === painted.length &&
        cached?.[painted.length - 1]?.id === painted[painted.length - 1]?.id &&
        cached?.[painted.length - 1]?.content === painted[painted.length - 1]?.content
      if (!unchanged) {
        cachedMessagesRef.current = painted
        setMessages(painted)
      }
      // History accounts for the screen again: the reply it was missing has been
      // written (or was never this panel's), so the next paint may go ahead
      // without the live-tail guard (SHO-85).
      if (!paint.carriedLiveReply) liveReplySessionRef.current = null
      writeSessionMessageCache(sessionId, painted)
      persistProjectHistoryRef.current?.(sessionId, painted)
    },
    [sessionMessages, setMessages, reportHistoryPaintKeptLiveTail],
  )
  const paintLoadedHistoryRef = useRef(paintLoadedHistory)
  paintLoadedHistoryRef.current = paintLoadedHistory

  // Repaint the transcript from saved history. A turn this window did not run
  // — a delegated task, a channel dispatch, a project call, or the wake a
  // finished background task produces — has its reply written by the server,
  // so reloading is the only way it lands here (SHO-31).
  const reloadPersistedResponse = useCallback(
    async (options: { requireReply?: boolean } = {}) => {
      if (!sessionMessages || isStreamingRef.current) return
      const sessionId = currentSessionIdRef.current
      if (!sessionId) return
      await sessionMessages.loadPage(
        { sessionId, agent: "technical" },
        { limit: MESSAGE_PAGE_SIZE, offset: 0 },
      )
      if (isStreamingRef.current || currentSessionIdRef.current !== sessionId) return

      paintLoadedHistory(sessionId, options)
    },
    [sessionMessages, paintLoadedHistory],
  )

  /**
   * Catch up after the window was not in front (SHO-53). The wake watch only
   * runs for an active panel, so a wake that ran while this chat sat behind
   * another chat tab, another browser tab or another app left nothing armed
   * here. By the time the person comes back the turn reads `completed`, which
   * the attach path sends to "history is enough" — but this window has never
   * seen that history. One row-wide read of the newest saved message decides
   * it, so a chat that is already up to date still costs a single `/turn`
   * probe and no transcript reload.
   */
  const repaintIfBehindPersistedTail = useCallback(async () => {
    const sessionId = currentSessionIdRef.current
    if (!sessionId || isStreamingRef.current || isSendingMessageRef.current) return
    const tail = await probePersistedTail(sessionId)
    if (currentSessionIdRef.current !== sessionId) return
    if (
      !persistedTailIsUnseen(tail, messagesRef.current, {
        // A reply this window streamed is on screen under the AI SDK's id
        // until a paint adopts the saved row (SHO-85/SHO-99).
        streamedHere: liveReplySessionRef.current === sessionId,
      })
    )
      return
    // A repaint that requires the reply keeps SHO-31's rule: another window's
    // ordinary turn is not this window's to overwrite. A tail that is still a
    // user row is a prompt answered elsewhere (the queue's `[Task update]`
    // wake), so paint it and let the late-turn probe fetch the reply.
    await reloadPersistedResponse({ requireReply: !persistedTailAwaitsReply(tail) })
  }, [probePersistedTail, reloadPersistedResponse])

  useEffect(() => {
    if (!isActive || !currentSessionId) return
    let cancelled = false
    const recheck = () => {
      // Focus fires on every click back into the window.
      if (Date.now() - lastLiveTurnCheckAtRef.current < 3000) return
      // Both halves are one-shot per focus event: a live turn is attached to,
      // and a turn that finished elsewhere is repainted from saved history.
      // Nothing here polls.
      void attachToLiveTurnIfAny().then((attached) => {
        if (attached || cancelled) return
        void repaintIfBehindPersistedTail()
      })
    }
    if (Platform.OS === "web") {
      if (typeof window === "undefined" || typeof document === "undefined") {
        return
      }
      const onVisibility = () => {
        if (document.visibilityState === "visible") recheck()
      }
      window.addEventListener("focus", recheck)
      document.addEventListener("visibilitychange", onVisibility)
      return () => {
        cancelled = true
        window.removeEventListener("focus", recheck)
        document.removeEventListener("visibilitychange", onVisibility)
      }
    }
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") recheck()
    })
    return () => {
      cancelled = true
      subscription.remove()
    }
  }, [isActive, currentSessionId, attachToLiveTurnIfAny, repaintIfBehindPersistedTail])

  const wasTransportStreamingRef = useRef(false)
  // A window that followed a turn must keep following: the next message in the
  // server queue starts once the API has seen this turn end, which can be a
  // dispatcher tick away, and a short queued turn can start *and* finish
  // between two probes. Two fixed probes therefore miss it (SHO-29: window A
  // showed none of the second queued reply), so keep looking for as long as the
  // dispatcher could take, then refresh the history on the way out — a turn
  // that ran while nothing here was attached still has to land on screen.
  useEffect(() => {
    const wasStreaming = wasTransportStreamingRef.current
    wasTransportStreamingRef.current = isTransportStreaming
    if (!wasStreaming || isTransportStreaming || !isActive) return
    let cancelled = false
    void followNextTurn({
      attachIfLive: attachToLiveTurnIfAnyRef.current,
      refreshHistory: () => refreshHistoryRef.current(),
      // A stream or a send starting is this window taking over again: the
      // stream's own end re-arms the follow, and reloading history mid-send
      // would drop the bubble just echoed.
      isCancelled: () =>
        cancelled || isStreamingRef.current || isSendingMessageRef.current,
    })
    return () => {
      cancelled = true
    }
  }, [isTransportStreaming, isActive])

  // A `wait` ends with its turn at the latest.
  useEffect(() => {
    if (!isStreaming) setTaskWait(null)
  }, [isStreaming])

  // Background work that will wake this chat when it finishes. The wake turn
  // is produced by the API's queue (a `[Task update]` row plus a turn this
  // window never posted), and the task list here is the only local signal that
  // such work exists — it is seeded once per session, i.e. before the turn
  // that starts the task, so nothing would notice it otherwise.
  // Only rows that are still running count: a finished row stays in the
  // runtime's list for ten minutes (and in the dock for a few seconds), so it
  // must not keep the "waiting for a wake" state alive.
  const notifyTaskIds = runningProcesses
    .filter((p) => p.notify && !p.stale && !isFinishedProcess(p))
    .map((p) => p.id ?? p.runId)
    .join("\0")
  const backgroundWorkExpected = useMemo(
    () => lastTurnStartedBackgroundWork(messages),
    [messages],
  )
  const wakeWatchArmed = Boolean(notifyTaskIds) || backgroundWorkExpected

  useEffect(() => {
    if (!wakeWatchArmed || !isActive || !currentSessionId || isStreaming) return

    let cancelled = false
    // The wake row and its reply both arrive after this arm, so an older
    // answered wake in history must not end the wait on the first tick.
    const wakeCountAtArm = messagesRef.current.length
    const settled = () =>
      messagesRef.current.length > wakeCountAtArm &&
      taskWakeHasResponse(messagesRef.current)

    void watchForNotifyWake({
      probeTasks: async () => {
        const list = await fetchRunningProcesses()
        // Unknown (runtime unreachable) is not the same as "nothing running":
        // hold the wait instead of probing turns for a wake that cannot come.
        if (!list) return null
        return list
          .filter((p) => p.notify && !p.stale && !isFinishedProcess(p))
          .map((p) => p.id ?? p.runId)
      },
      probeTurn: () => {
        const turnUrl = buildChatTurnUrl(
          API_URL!,
          projectId,
          localAgentUrl,
          currentSessionId,
          chatWorkspaceId,
        )
        return probeChatTurnStatus({
          url: turnUrl,
          fetch: expoFetch,
          headers: nativeHeaders ? nativeHeaders() : undefined,
          credentials: Platform.OS === "web" ? "include" : undefined,
        })
      },
      // Reload first: the live stream carries only the reply, and the wake's
      // `[Task update]` row has to be in place for it to attach to.
      attach: () => reloadAndAttachLiveTurn(),
      reload: () => reloadPersistedResponse({ requireReply: false }),
      isSettled: settled,
      isCancelled: () => cancelled || isStreamingRef.current,
      intervalMs: NOTIFY_WAKE_POLL_INTERVAL_MS,
      maxWaitMs: NOTIFY_WAKE_MAX_WAIT_MS,
      onError: (error) => {
        if (!cancelled) console.warn("[ChatPanel] wake watch failed", error)
      },
    })
    return () => {
      cancelled = true
    }
  }, [
    wakeWatchArmed,
    isActive,
    currentSessionId,
    isStreaming,
    projectId,
    localAgentUrl,
    chatWorkspaceId,
    expoFetch,
    nativeHeaders,
    fetchRunningProcesses,
    reloadAndAttachLiveTurn,
    reloadPersistedResponse,
  ])

  // A delegated task, a channel mention or a `[Task update]` wake starts its
  // turn outside this panel. The first history-load probe can therefore see
  // `unknown` while a slot or a cold runtime is still in the way. Keep probing
  // so the live reply shows up here instead of only after the session is
  // opened again.
  const externalPromptIndex = useMemo(
    () => pendingExternalPromptIndex(messages),
    [messages],
  )
  const externalPromptHasReply = useMemo(
    () => externalPromptHasResponse(messages, externalPromptIndex),
    [externalPromptIndex, messages],
  )

  useEffect(() => {
    if (
      !isActive ||
      !currentSessionId ||
      !sessionMessages ||
      externalPromptIndex < 0 ||
      externalPromptHasReply ||
      isStreaming
    )
      return

    let cancelled = false

    const refreshPersistedResponse = async () => {
      if (cancelled) return
      await reloadPersistedResponse()
    }

    void pollForLateTurn({
      probe: () => {
        const turnUrl = buildChatTurnUrl(
          API_URL!,
          projectId,
          localAgentUrl,
          currentSessionId,
          chatWorkspaceId,
        )
        return probeChatTurnStatus({
          url: turnUrl,
          fetch: expoFetch,
          headers: nativeHeaders ? nativeHeaders() : undefined,
          credentials: Platform.OS === "web" ? "include" : undefined,
        })
      },
      attach: () => guardedAutoResumeStream("live-turn-probe"),
      reload: refreshPersistedResponse,
      isCancelled: () => cancelled || isStreamingRef.current,
      intervalMs: LATE_TURN_POLL_INTERVAL_MS,
      maxWaitMs: LATE_TURN_MAX_WAIT_MS,
      onError: (error) => {
        if (!cancelled) console.warn("[ChatPanel] late turn probe failed", error)
      },
    })
    return () => {
      cancelled = true
    }
  }, [
    isActive,
    currentSessionId,
    sessionMessages,
    externalPromptIndex,
    externalPromptHasReply,
    isStreaming,
    projectId,
    localAgentUrl,
    chatWorkspaceId,
    expoFetch,
    nativeHeaders,
    guardedAutoResumeStream,
    reloadPersistedResponse,
  ])

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
      renderDepthErrorTurnIdRef.current = null
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

        // Auto-recover: the agent is likely still running and buffering frames
        // server-side. Rather than stranding the user on a static "tap Retry"
        // banner, kick off a bounded `/turn` probe that reattaches to the live
        // stream if it's still active. Skip when the user explicitly stopped
        // (that's an intentional terminal state, not a dropped connection),
        // and fire at most once per turn so we never loop.
        const stalledTurnId = currentTurnIdRef.current
        if (
          shouldAutoRecoverStalledTurn({
            stalledTurnId,
            recoveredTurnId: recoveredTurnIdRef.current,
            renderDepthErrorTurnId: renderDepthErrorTurnIdRef.current,
            userInitiatedStop: userInitiatedStopRef.current,
          })
        ) {
          recoveredTurnIdRef.current = stalledTurnId
          stallRecoveryRef.current?.()
        }
      }
    }
  }, [isStreaming])

  const handleStop = useCallback(() => {
    userInitiatedStopRef.current = true
    // Clear any pre-existing empty-response banner immediately so that a
    // stale banner from an earlier turn dismisses the moment the user taps
    // Stop — they shouldn't have to send a new message to get rid of it.
    setEmptyResponseError(null)
    setConnectivityWait(null)
    setJustReconnected(false)
    // Stop is terminal: keep the turn's id (a send right after Stop must not
    // queue behind it) and stamp the reply as finished so no later replay
    // deletes it (see stopped-turn.ts).
    stoppedTurnIdRef.current = currentTurnIdRef.current
    const snapshot = markStoppedTail(
      [...messagesRef.current],
      stoppedTurnIdRef.current,
    )
    stoppedMessagesRef.current = snapshot
    setStoppedMessages(snapshot)
    // The live array carries the marker too, so a replay that starts before
    // the snapshot is released keeps the stopped reply as well.
    setMessages(snapshot)
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
  }, [
    stop,
    projectId,
    chatWorkspaceId,
    localAgentUrl,
    expoFetch,
    currentSessionId,
    setMessages,
  ])

  /**
   * SHO-263: an edit/retry made while the agent is running must stop the run
   * first, then wait for the stream to settle before truncating — otherwise
   * the truncate races the in-flight turn and can leave an orphan reply.
   */
  const stopStreamingAndWait = useCallback(async () => {
    if (!isStreamingRef.current) return
    handleStop()
    await new Promise<void>((resolve) => {
      let waited = 0
      const tick = () => {
        // 20s covers a slow abort round-trip; the old 3s cap gave up while the
        // stream was still writing and let the truncate race the live turn.
        if (!isStreamingRef.current || waited >= 20_000) {
          resolve()
          return
        }
        waited += 50
        setTimeout(tick, 50)
      }
      setTimeout(tick, 50)
    })
  }, [handleStop])

  // Attach the "Files reverted…" note to the message the resend created, once
  // it shows up in the transcript (we don't know its id until then).
  useEffect(() => {
    const pendingNote = pendingRevertNoteRef.current
    if (!pendingNote) return
    const target = [...messages]
      .reverse()
      .find(
        (m) =>
          m.role === "user" &&
          extractTextContent(m).trim() === pendingNote.text.trim(),
      )
    if (!target) return
    pendingRevertNoteRef.current = null
    setRevertedNotes((prev) => ({ ...prev, [target.id]: pendingNote.note }))
  }, [messages])

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
    return () => {
      configureSubagentStop(null)
    }
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
  // Transient heartbeats don't swap `messages`, so when the timer fires it
  // re-arms for the remainder of the window if a runtime data frame arrived
  // since (`lastRuntimeDataAtRef`).
  const idleTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const IDLE_TIMEOUT_MS = 1_800_000

  useEffect(() => {
    if (idleTimeoutRef.current) {
      clearTimeout(idleTimeoutRef.current)
      idleTimeoutRef.current = null
    }

    if (!isStreaming) return

    const armedAt = Date.now()
    const arm = (delayMs: number) => {
      idleTimeoutRef.current = setTimeout(() => {
        const idleMs =
          Date.now() - Math.max(armedAt, lastRuntimeDataAtRef.current)
        if (idleMs < IDLE_TIMEOUT_MS) {
          arm(IDLE_TIMEOUT_MS - idleMs)
          return
        }
        console.warn("[ChatPanel] Stream idle timeout - forcing stop()")
        handleStop()
      }, delayMs)
    }
    arm(IDLE_TIMEOUT_MS)

    return () => {
      if (idleTimeoutRef.current) {
        clearTimeout(idleTimeoutRef.current)
        idleTimeoutRef.current = null
      }
    }
  }, [isStreaming, messages, handleStop])

  // Clear the tool-error banner at the start of each new turn.
  const prevStreamingForScanRef = useRef(false)
  useEffect(() => {
    const wasStreaming = prevStreamingForScanRef.current
    prevStreamingForScanRef.current = isStreaming

    if (isStreaming && !wasStreaming) {
      setToolErrorBanner(null)
    }
  }, [isStreaming])

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
                next.set(id, {
                  ...subagent,
                  toolCount: subagent.toolCount + 1,
                })
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
        if (
          subagent.status === "completed" &&
          !scheduledCleanupRef.current.has(id)
        ) {
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
      const isRunning =
        tc.state === "input-streaming" || tc.state === "input-available"
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

  // Post-stream settle: when streaming ends, the AI SDK messages ARE the
  // authoritative fresh state — `cachedMessagesRef.current` is already kept in
  // lockstep with `messages` on every active-panel render (see the block near
  // line 1593), and `sessionMessageCache` is updated there too. The only thing
  // we need to do here is mark the cache fresh so Effect 1 (which re-runs
  // because `isStreaming` is in its deps) takes the fast bail-out path and
  // skips the network refetch + setMessages cycle that used to cascade a
  // second re-render across every open tab. Zombie loading flags are also
  // cleared defensively.
  //
  // This MUST be a layout effect declared above Effect 1 (SHO-85). Effects run
  // in declaration order, so as a plain `useEffect` below it stamped the cache
  // *after* Effect 1 had already read a stale stamp on the same commit — the
  // one where `isStreaming` flips to false — and refetched. The assistant row
  // is written server-side after the stream EOFs, so that fetch came back
  // without the reply and painted it off the screen. Running first here makes
  // Effect 1 see the fresh stamp and keep the turn that just finished.
  useLayoutEffect(() => {
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

  // Remember which session's reply this panel is watching live, so a history
  // paint can tell "the server has not written this yet" from "this reply is
  // stale" (SHO-85). Cleared when a paint adopts the server's row.
  useEffect(() => {
    if (isStreaming && currentSessionId) {
      liveReplySessionRef.current = currentSessionId
    }
  }, [isStreaming, currentSessionId])

  // ── Device-held history (SHO-260) ─────────────────────────────────────
  //
  // A chat the device has seen is painted from the store the moment it is
  // opened — including after a reload, a new window or a desktop restart — and
  // the only request that follows is `GET …/session/:id/changes`, which returns
  // rows whose `updatedAt` moved since our cursor. The full first page is
  // downloaded only for a chat with no saved slice, or when the server says
  // the delta cannot be applied (`reset`, or a row count that does not add up
  // because something was deleted).
  const historyOrigin = String(machineInstance?.instanceId ?? API_URL ?? "local")
  const activeSessionIdRef = useRef(currentSessionId)
  activeSessionIdRef.current = currentSessionId
  const historyKeyFor = useCallback(
    (sessionId: string | null) =>
      sessionId && userId
        ? buildChatHistoryKey(
            userId,
            historyOrigin,
            chatSessionHistoryKey(sessionId),
          )
        : null,
    [userId, historyOrigin],
  )
  const historyStoreKey = historyKeyFor(currentSessionId)
  const historyStoreKeyRef = useRef<string | null>(historyStoreKey)
  historyStoreKeyRef.current = historyStoreKey
  /** sessionKey → the cursor and row count the saved slice is complete at. */
  const historyMetaRef = useRef<
    Map<string, { cursor: string | null; total: number | null }>
  >(new Map())
  const historyHydratedRef = useRef<Set<string>>(new Set())
  const historyHydrationPendingRef = useRef<Set<string>>(new Set())
  const [historyHydrationTick, setHistoryHydrationTick] = useState(0)

  /** The delta read. Same routing insert point as the transcript itself. */
  const fetchChatChanges = useCallback(
    async (sessionId: string, since: string): Promise<ChatChangesResult | null> => {
      if (!API_URL) return null
      const path = `/api/chat-messages/session/${encodeURIComponent(sessionId)}/changes`
      const query = { agent: "technical", since }
      try {
        const body = domainHttp
          ? (
              await domainHttp.get<ChatChangesResult>(path, query)
            ).data
          : await (expoFetch ?? globalThis.fetch)(
              `${API_URL}${path}?${new URLSearchParams(query).toString()}`,
              {
                headers: nativeHeaders ? nativeHeaders() : {},
                credentials: Platform.OS === "web" ? "include" : undefined,
              } as any,
            )
              .then((response) =>
                response.ok ? response.json().catch(() => null) : null,
              )
              .catch(() => null)
        return body && body.ok !== false ? body : null
      } catch {
        return null
      }
    },
    [domainHttp, expoFetch, nativeHeaders],
  )

  /** Keep the device copy in step with whatever the panel last painted. */
  const persistProjectHistory = useCallback(
    async (sessionId: string, messages: any[]) => {
      const key = historyKeyFor(sessionId)
      if (!key || !messages.length) return
      const meta = historyMetaRef.current.get(key)
      const entry: ChatHistoryEntry = {
        messages,
        cursor: meta?.cursor ?? null,
        total: meta?.total ?? null,
        hasMoreOlder: false,
        savedAt: Date.now(),
      }
      await writeChatHistory("project", key, entry)
    },
    [historyKeyFor],
  )

  // A streaming turn re-renders per token, and each render offers the whole
  // transcript to the durable store. Writing on every offer would push a
  // multi-hundred-KB record into IndexedDB hundreds of times a second, so the
  // device copy is throttled: write now if the last write is old enough,
  // otherwise let one trailing write land shortly after the burst.
  const HISTORY_WRITE_MIN_INTERVAL_MS = 2000
  const historyWriteThrottleRef = useRef<
    Map<string, { lastAt: number; timer: ReturnType<typeof setTimeout> | null }>
  >(new Map())

  persistProjectHistoryRef.current = (sessionId, messages) => {
    const key = historyKeyFor(sessionId)
    if (!key || !messages.length) return
    const state = historyWriteThrottleRef.current
    const entry = state.get(key) ?? { lastAt: 0, timer: null }
    state.set(key, entry)
    const flush = () => {
      entry.lastAt = Date.now()
      entry.timer = null
      void persistProjectHistory(sessionId, messages)
    }
    if (entry.timer) return
    const wait = entry.lastAt + HISTORY_WRITE_MIN_INTERVAL_MS - Date.now()
    if (wait <= 0) {
      flush()
      return
    }
    entry.timer = setTimeout(() => {
      entry.timer = null
      flush()
    }, wait)
  }

  /**
   * A cold first page carries no `updatedAt`, so ask the delta route once for
   * the newest few seconds of the chat. That is where the cursor comes from —
   * without it every subsequent open would have to download the page again.
   */
  const seedHistoryCursor = useCallback(
    async (sessionId: string, newest: any) => {
      const key = historyKeyFor(sessionId)
      if (!key || !newest) return
      const at =
        typeof newest.createdAt === "number"
          ? newest.createdAt
          : new Date(newest.createdAt).getTime()
      if (!Number.isFinite(at)) return
      const body = await fetchChatChanges(
        sessionId,
        new Date(at - 5000).toISOString(),
      )
      if (!body?.cursor) return
      historyMetaRef.current.set(key, {
        cursor: body.cursor,
        total: body.total ?? null,
      })
      const cached = cachedMessagesRef.current
      if (cached?.length) void persistProjectHistory(sessionId, cached)
    },
    [historyKeyFor, fetchChatChanges, persistProjectHistory],
  )

  /**
   * Merge a delta into the transcript. Returns false when the caller must fall
   * back to the full first page: no usable answer, `reset`, or a row count that
   * says rows were deleted while we were away.
   */
  const applyChatDelta = useCallback(
    async (
      sessionId: string,
      key: string,
      cursor: string,
      generation: number,
    ): Promise<boolean> => {
      const since = deltaSince(cursor)
      if (!since) return false
      const body = await fetchChatChanges(sessionId, since)
      if (generation !== loadGenerationRef.current) return true
      if (activeSessionIdRef.current !== sessionId) return true
      if (!body || body.reset) return false

      const items = Array.isArray(body.items) ? body.items : []
      const current = (cachedMessagesRef.current ?? []) as any[]
      const known = new Set(current.map((m) => String(m.id)))
      const newIds = items.filter((row) => row?.id && !known.has(String(row.id))).length
      const meta = historyMetaRef.current.get(key)
      // A row that vanished (truncate-from, an edit that re-sent the tail) only
      // shows up as a smaller total: the delta cannot carry a deletion.
      if (
        meta?.total != null &&
        body.total != null &&
        body.total !== meta.total + newIds
      ) {
        return false
      }

      const byId = new Map(current.map((m) => [String(m.id), m]))
      for (const row of items) {
        if (!row?.id) continue
        byId.set(String(row.id), messageRowToUIMessage(row))
        sessionMessages?.addItem(messageRowToSnapshot(row))
      }
      const history = Array.from(byId.values()).sort(
        (a: any, b: any) => (a.createdAt || 0) - (b.createdAt || 0),
      )

      const paint = resolveHistoryPaint({
        history,
        current: cachedMessagesRef.current ?? [],
        keepsLiveTail: liveReplySessionRef.current === sessionId,
      })
      if (paint.keptLiveTail) {
        historyPaintAttemptRef.current += 1
        reportHistoryPaintKeptLiveTail("delta", paint.reason, history)
        return true
      }
      const painted = paint.messages as any[]
      const before = cachedMessagesRef.current
      const changed =
        !before ||
        before.length !== painted.length ||
        before[before.length - 1]?.id !== painted[painted.length - 1]?.id ||
        (before[before.length - 1] as any)?.content !==
          (painted[painted.length - 1] as any)?.content
      if (changed) {
        cachedMessagesRef.current = painted
        lastNonEmptyMessagesRef.current = painted
        setMessages(painted)
      } else if (before) {
        cachedMessagesRef.current = painted
      }
      writeSessionMessageCache(sessionId, painted)
      if (!paint.carriedLiveReply) liveReplySessionRef.current = null
      historyMetaRef.current.set(key, {
        // A delta that carried nothing must not touch the floor: a server that
        // echoes `since` would walk it backwards 5 s per quiet reopen.
        cursor: items.length ? (body.cursor ?? cursor) : cursor,
        total: body.total ?? meta?.total ?? null,
      })
      cacheRefreshedAtRef.current.set(sessionId, performance.now())
      void persistProjectHistory(sessionId, painted)
      return true
    },
    [
      fetchChatChanges,
      persistProjectHistory,
      sessionMessages,
      setMessages,
    ],
  )

  // Paint from the device before the network is touched. Only the session's
  // first appearance in this JS session reads the store, and only when the
  // in-memory cache is empty (memory is always the fresher of the two).
  useEffect(() => {
    const key = historyStoreKey
    const sessionId = currentSessionId
    if (!isActive || !key || !sessionId) return
    if (historyHydratedRef.current.has(key)) return
    if (cachedMessagesRef.current && cachedMessagesRef.current.length > 0) {
      historyHydratedRef.current.add(key)
      return
    }
    historyHydratedRef.current.add(key)
    historyHydrationPendingRef.current.add(key)
    void readChatHistory("project", key)
      .then(async (entry) => {
        if (!entry?.messages.length) return
        historyMetaRef.current.set(key, {
          cursor: entry.cursor,
          total: entry.total,
        })
        if (activeSessionIdRef.current !== sessionId) return
        if (isStreamingRef.current || isSendingMessageRef.current) return
        const painted = entry.messages as any[]
        cachedMessagesRef.current = painted
        lastNonEmptyMessagesRef.current = painted
        setMessages(painted)
        setIsInitialLoadComplete(true)
        try {
          if (entry.cursor) {
            await applyChatDelta(sessionId, key, entry.cursor, loadGenerationRef.current)
          }
        } catch (err) {
          // A delta that fails (a store write, a row the model rejects) must
          // not cost the reopen its live-turn attach: the probe below is the
          // only thing that follows a running or queued reply.
          console.warn("[ChatPanel] chat delta failed:", err)
        }
        // History is in place: attach to a turn that is genuinely running, the
        // same guarantee the cold path gives (SHO-260).
        probeLiveTurnAfterHistory(sessionId, loadGenerationRef.current)
      })
      .catch((err) => console.warn("[ChatPanel] saved history failed to load:", err))
      .finally(() => {
        historyHydrationPendingRef.current.delete(key)
        setHistoryHydrationTick((tick) => tick + 1)
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isActive, historyStoreKey, currentSessionId])

  /**
   * Ask the runtime, once the history is in place, whether there is a genuinely
   * live turn to attach to (SHO-260). Every history path runs it — the cold
   * page load, the warm delta and the hydration effect — because a chat whose
   * turn started in another window (or from the queue's wake) used to attach
   * only via the cold path's probe; without it the panel paints its stale
   * slice and shows no streaming/Stop until a focus event or a send.
   *
   * The probe is robust (every failure mode → 'unknown' → no attach) so this is
   * fire-and-forget. Critical: only run for the live generation — otherwise a
   * tab switch mid-load would attach to a stale session's stream and corrupt
   * the active panel's message list.
   */
  const probeLiveTurnAfterHistory = useCallback(
    (loadSessionId: string, myGeneration: number) => {
      if (myGeneration !== loadGenerationRef.current) return
      if (liveTurnReloadNonceRef.current === historyOnlyNonceRef.current) return
      const turnUrl = buildChatTurnUrl(
        API_URL!,
        projectId,
        localAgentUrl,
        loadSessionId,
        chatWorkspaceId,
      )
      void probeChatTurn({
        url: turnUrl,
        fetch: expoFetch,
        headers: nativeHeaders ? nativeHeaders() : undefined,
        credentials: Platform.OS === "web" ? "include" : undefined,
        retryDelaysMs: [1000, 3000],
      }).then((turn) => {
        if (myGeneration !== loadGenerationRef.current) return
        lastLiveTurnCheckAtRef.current = Date.now()
        const expectedLive = liveTurnExpectedRef.current
        liveTurnExpectedRef.current = false
        // A turn this window stopped is not a turn to attach to, even while
        // the runtime still reports it (stop reaches it a beat later).
        const stopped = turn.turnId !== null && turn.turnId === stoppedTurnIdRef.current
        if (isLiveTurnOtherThan(turn, stoppedTurnIdRef.current)) {
          guardedAutoResumeStream("live-turn-probe")
        } else if (expectedLive && !stopped) {
          setTimeout(
            () => reloadAndAttachLiveTurnRef.current({ settle: false }),
            750,
          )
        }
      })
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [projectId, localAgentUrl, chatWorkspaceId, guardedAutoResumeStream],
  )

  /**
   * The cold path: download the newest page and paint it. Runs for a chat the
   * device has never seen, and as the fallback when a delta cannot be applied.
   */
  const loadFirstPage = useCallback(
    (loadSessionId: string, myGeneration: number, authoritative = false) => {
      if (!sessionMessages) return
        sessionMessages
          .loadPage(
            { sessionId: loadSessionId, agent: "technical" },
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
                // Carried through so `extractTurnTiming`'s createdAt fallback
                // and the `TurnFooter` relative-time label ("2m ago") have a
                // real timestamp for historical (pre-`data-turn-timing`)
                // messages loaded from the server.
                createdAt: msg.createdAt,
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
            // The server told this caller the chat changed shape (`reset`, or a
            // count that does not add up), so rows were deleted and this page —
            // not the screen — is the transcript. SHO-85's "never paint behind
            // the screen" rule is about a reply the server has not written yet;
            // with no live tail to protect, applying it here would keep the
            // deleted rows on screen forever (SHO-260).
            if (authoritative && liveReplySessionRef.current !== loadSessionId) {
              cachedMessagesRef.current = aiMessages
              lastNonEmptyMessagesRef.current = aiMessages
              setMessages(aiMessages)
              writeSessionMessageCache(loadSessionId, aiMessages)
              cacheRefreshedAtRef.current.set(loadSessionId, performance.now())
              // Adopt the page's own numbers. Without this the entry keeps the
              // `total` that sent us down the fallback, so the very next delta
              // mismatches again and the panel re-downloads the page in a loop.
              const key = historyKeyFor(loadSessionId)
              if (key) {
                const newest = aiMessages[aiMessages.length - 1]
                const rawAt = (newest as any)?.createdAt
                const at =
                  typeof rawAt === "number" ? rawAt : new Date(rawAt ?? NaN).getTime()
                historyMetaRef.current.set(key, {
                  cursor: Number.isFinite(at) ? new Date(at).toISOString() : null,
                  total: (sessionMessages as any).total ?? aiMessages.length,
                })
              }
              void persistProjectHistory(loadSessionId, aiMessages)
              return
            }
            // Never paint a transcript that is behind what is on screen: the reply
            // this panel just streamed is written server-side after the stream
            // EOFs, so history can legitimately be missing it (SHO-85).
            const paint = resolveHistoryPaint({
              history: aiMessages,
              current: cached ?? [],
              keepsLiveTail: liveReplySessionRef.current === loadSessionId,
            })
            if (paint.keptLiveTail) {
              historyPaintAttemptRef.current += 1
              reportHistoryPaintKeptLiveTail("effect-1", paint.reason, aiMessages)
              return
            }
            // Paint the decision's transcript rather than raw history: when history
            // is ahead of the screen it also carries the reply that only exists on
            // screen, spliced in front of the prompt that started the next turn
            // (SHO-147).
            const painted = paint.messages as any[]
            const textLength = (m: any): number => {
              const fromParts = (m?.parts ?? []).reduce(
                (n: number, p: any) =>
                  n + (p?.type === "text" && typeof p.text === "string" ? p.text.length : 0),
                0,
              )
              return fromParts || (typeof m?.content === "string" ? m.content.length : 0)
            }
            // A reply read while the server was still writing it keeps its id and
            // only grows, so compare its text too.
            const changed =
              !cached ||
              cached.length !== painted.length ||
              cached[cached.length - 1]?.id !==
                painted[painted.length - 1]?.id ||
              textLength(cached[cached.length - 1]) !==
                textLength(painted[painted.length - 1])

            if (changed) {
              cachedMessagesRef.current = painted
              writeSessionMessageCache(loadSessionId, painted)
              setMessages(painted)
              historyPaintAttemptRef.current = 0
            } else {
              // Same shape as cache — still refresh the module cache entry so any
              // later in-flight mutations (status flips, etc.) don't drift.
              writeSessionMessageCache(loadSessionId, painted)
            }
            // History accounts for the screen again: the reply it was missing has
            // been written (or was never this panel's), so the next paint may go
            // ahead without the live-tail guard (SHO-85).
            if (!paint.carriedLiveReply) liveReplySessionRef.current = null
            // Keep the device copy in step and learn the delta cursor from the
            // newest row this page carried (SHO-260).
            void persistProjectHistory(loadSessionId, painted)
            void seedHistoryCursor(loadSessionId, loaded[loaded.length - 1])
          })
          .catch((err: any) =>
            console.error("[ChatPanel] Failed to load messages:", err),
          )
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

            probeLiveTurnAfterHistory(loadSessionId, myGeneration)
          })
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sessionMessages],
  )

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

    // The device copy is being read for this session: let that paint (and its
    // delta) run before deciding anything here, or we would show the loader
    // and download the page we already have (SHO-260).
    //
    // The pending set is keyed by the store key (`userId:origin:session`), not
    // by the bare session id — checking `currentSessionId` here never matched,
    // so this never actually waited. And while `userId` is still resolving the
    // key is null: without this guard the first run after a reload downloads
    // the newest page before the device copy is even opened, which is the exact
    // cost this feature exists to remove.
    if (!historyStoreKey) return
    if (historyHydrationPendingRef.current.has(historyStoreKey)) return

    const hasCached =
      cachedMessagesRef.current && cachedMessagesRef.current.length > 0

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

    // SHO-260: with a saved cursor, ask only for what changed. The full page
    // below runs only when there is no cursor, or the delta says to reload.
    const warmKey = historyKeyFor(currentSessionId)
    const warmMeta = warmKey ? historyMetaRef.current.get(warmKey) : undefined
    if (hasCached && warmKey && warmMeta?.cursor && sessionMessages) {
      const myGeneration = ++loadGenerationRef.current
      const loadSessionId = currentSessionId
      void applyChatDelta(loadSessionId, warmKey, warmMeta.cursor, myGeneration).then(
        (applied) => {
          if (myGeneration !== loadGenerationRef.current) return
          if (applied) {
            // Carrying on from a saved slice still has to attach to a live
            // turn, the same guarantee the cold path gives (SHO-260).
            probeLiveTurnAfterHistory(loadSessionId, myGeneration)
            return
          }
          isLoadingMessagesRef.current = true
          setIsLoadingMessages(true)
          // `reset` / a count that does not add up: the page is authoritative.
          loadFirstPage(loadSessionId, ++loadGenerationRef.current, true)
        },
      )
      return
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

    void loadFirstPage(loadSessionId, myGeneration)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    isActive,
    currentSessionId,
    sessionMessages,
    setMessages,
    isLoadingMessages,
    isStreaming,
    liveTurnReloadNonce,
    historyHydrationTick,
  ])

  // This chat's last-used model: the most recent loaded message carrying a
  // `model` value (assistant rows are stamped server-side). MST `.all` is
  // observed here, so this recomputes when the session's messages settle.
  const lastSessionModel: string | null = (() => {
    const all = sessionMessages?.all as any[] | undefined
    if (!all || all.length === 0) return null
    let latest: { createdAt: number; model: string } | null = null
    for (const m of all) {
      const mdl = typeof m.model === "string" ? m.model.trim() : ""
      if (!mdl) continue
      const createdAt = (m.createdAt as number) || 0
      if (!latest || createdAt >= latest.createdAt)
        latest = { createdAt, model: mdl }
    }
    return latest ? latest.model : null
  })()

  // Report the active chat's last-used model up to the parent so it can default
  // the shared picker when switching chats. Fires `null` for empty chats so the
  // parent can fall back to the global preference. The effect re-runs (and thus
  // re-emits) when this panel becomes active, so switching back to a chat
  // restores its model even if the value itself is unchanged.
  useEffect(() => {
    if (!isActive || !isInitialLoadComplete || !onResolveSessionModel) return
    onResolveSessionModel(lastSessionModel)
  }, [
    isActive,
    isInitialLoadComplete,
    currentSessionId,
    lastSessionModel,
    onResolveSessionModel,
  ])

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
    "Shogo"
  const notifyPreview = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m: any = messages[i]
      if (m?.role !== "assistant") continue
      const parts = m?.parts as any[] | undefined
      if (!parts) continue
      const text = parts
        .filter((p: any) => p?.type === "text" && typeof p.text === "string")
        .map((p: any) => p.text as string)
        .join(" ")
        .trim()
      if (text) return text
      break
    }
    return "Reply is ready."
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
    )
      return

    isLoadingOlderRef.current = true

    const currentCount = sessionMessages.all.length

    try {
      await sessionMessages.loadPage(
        { sessionId: currentSessionId, agent: "technical" },
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
          createdAt: msg.createdAt,
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

      const paint = resolveHistoryPaint({
        history: aiMessages,
        current: cachedMessagesRef.current ?? [],
        keepsLiveTail: liveReplySessionRef.current === currentSessionId,
      })
      if (paint.keptLiveTail) {
        historyPaintAttemptRef.current += 1
        reportHistoryPaintKeptLiveTail("load-older", paint.reason, aiMessages)
        // Nothing was painted, so the scroll handler must be able to ask again.
        isLoadingOlderRef.current = false
        return
      }

      cachedMessagesRef.current = paint.messages as any[]
      writeSessionMessageCache(currentSessionId, paint.messages as any[])
      persistProjectHistoryRef.current?.(currentSessionId, paint.messages as any[])
      setMessages(paint.messages as any[])
      if (!paint.carriedLiveReply) liveReplySessionRef.current = null
      historyPaintAttemptRef.current = 0
      // NOTE: isLoadingOlderRef is intentionally NOT reset here.
      // It is reset in onContentSizeChange after scroll position is adjusted,
      // so the onScroll handler doesn't immediately re-trigger loading.
    } catch (err) {
      console.error("[ChatPanel] Failed to load older messages:", err)
      isLoadingOlderRef.current = false
    }
  }, [
    currentSessionId,
    sessionMessages,
    setMessages,
    reportHistoryPaintKeptLiveTail,
  ])

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
      const overflows = contentSize.height > layoutMeasurement.height + 1
      setHasScrollableTranscript((current) =>
        current === overflows ? current : overflows,
      )
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
        (p.type === "tool-invocation" &&
          p.toolInvocation?.toolName === "create_plan" &&
          p.toolInvocation?.state === "result") ||
        (p.type === "dynamic-tool" &&
          p.toolName === "create_plan" &&
          (p.state === "output-available" || p.state === "result")),
    )
    if (!planTool) return
    const args =
      planTool.type === "tool-invocation"
        ? planTool.toolInvocation?.args
        : (planTool.input ?? planTool.args)
    if (!args) return
    const restoredPlan = normalizePlanData({
      name: args.name ?? "Plan",
      overview: args.overview ?? "",
      plan: args.plan ?? "",
      todos: args.todos ?? [],
      filepath: args.filepath,
      toolCallId: planTool.id ?? planTool.toolCallId,
      isUpdate: false,
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

  // Read `planStream` from a ref inside the publishing effects below so that
  // changes to the context value's identity do NOT re-run the effects (and
  // therefore can't cascade back into setState on the same context). The
  // setters on the context value are stable `useState` setters, so reading
  // them through the ref is safe.
  const planStreamRef = useRef(planStream)
  planStreamRef.current = planStream

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
          (p.type === "tool-invocation" &&
            p.toolInvocation?.toolName === "create_plan") ||
          (p.type === "dynamic-tool" && p.toolName === "create_plan"),
      )
      if (!planPart) return null
      const args =
        planPart.type === "tool-invocation"
          ? planPart.toolInvocation?.args
          : (planPart.input ?? planPart.args)
      if (!args?.name) return null
      return normalizePlanData({
        name: args.name,
        overview: args.overview ?? "",
        plan: args.plan ?? "",
        todos: args.todos ?? [],
        filepath: args.filepath,
        toolCallId: planPart.id ?? planPart.toolCallId,
        isUpdate: false,
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
      const overviewLen =
        typeof fresh.overview === "string" ? fresh.overview.length : 0
      const planLen = typeof fresh.plan === "string" ? fresh.plan.length : 0
      const todosArr = Array.isArray(fresh.todos) ? fresh.todos : []
      const lastTodo =
        todosArr.length > 0 ? (todosArr[todosArr.length - 1] as any) : null
      const lastTodoLen =
        typeof lastTodo?.content === "string" ? lastTodo.content.length : 0
      sig =
        `${fresh.name}|${overviewLen}|${planLen}|` +
        `${todosArr.length}|${lastTodoLen}|${fresh.filepath ?? ""}|${
          fresh.toolCallId ?? ""
        }`
    }
    if (sig === lastDerivedPlanRef.current.sig) {
      return lastDerivedPlanRef.current.plan
    }
    lastDerivedPlanRef.current = { sig, plan: fresh }
    return fresh
  }, [isStreaming, messages])

  // A plan is "streaming" while a `create_plan` call is still arriving — that
  // is what lights the Plans panel's streaming row.
  useEffect(() => {
    if (!isActivePanel) return
    const next = derivedStreamingPlan != null
    const ctx = planStreamRef.current
    if (!ctx) return
    if (ctx.isPlanStreaming === next) return
    ctx.setIsPlanStreaming(next)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [derivedStreamingPlan, isActivePanel])

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
  const wasActivePanelRef = useRef(false)
  useEffect(() => {
    return () => {
      if (planPublishTimerRef.current) {
        clearTimeout(planPublishTimerRef.current)
        planPublishTimerRef.current = null
      }
      pendingPlanPublishRef.current = null
    }
  }, [])
  // While tokens stream, pendingPlan identity changes every chunk. Fold it
  // away so this effect only re-runs when the idle snapshot actually changes.
  const idlePlan = isStreaming ? null : (pendingPlan ?? confirmedPlan)
  useEffect(() => {
    if (!isActivePanel) {
      wasActivePanelRef.current = false
      pendingPlanPublishRef.current = null
      if (planPublishTimerRef.current) {
        clearTimeout(planPublishTimerRef.current)
        planPublishTimerRef.current = null
      }
      return
    }

    const activated = !wasActivePanelRef.current
    wasActivePanelRef.current = true
    const ctx = planStreamRef.current
    if (!ctx) return

    const planToPublish = planToPublishToStream({
      derivedStreamingPlan,
      isStreaming,
      pendingPlan: idlePlan,
      confirmedPlan: null,
    })
    const nextFilepath = planToPublish?.filepath ?? null

    if (
      !shouldPublishPlanToStream({
        isActivePanel,
        currentPlan: ctx.streamingPlan,
        nextPlan: planToPublish,
        currentFilepath: ctx.streamingPlanFilepath,
        nextFilepath,
      })
    ) {
      return
    }

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

    pendingPlanPublishRef.current = {
      plan: planToPublish,
      filepath: nextFilepath,
    }

    // Edge events (plan first appears, or the shared snapshot is cleared)
    // bypass the throttle so Plans/dock react immediately.
    const isEdge =
      activated || planToPublish === null || ctx.streamingPlan === null
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
    const wait =
      elapsed >= PLAN_PUBLISH_THROTTLE_MS
        ? 0
        : PLAN_PUBLISH_THROTTLE_MS - elapsed
    planPublishTimerRef.current = setTimeout(() => {
      planPublishTimerRef.current = null
      publish()
    }, wait)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [derivedStreamingPlan, isStreaming, idlePlan, isActivePanel])

  // The summary lifecycle is shared by all chat tabs, so restore the active
  // tab's summary when ownership moves between panels. Background panels keep
  // their own summary in pendingPlanRef until they become active.
  useEffect(() => {
    if (!isActivePanel) return
    const ctx = planStreamRef.current
    if (!ctx) return

    const plan = pendingPlanRef.current
    const summaryStatus =
      plan?.summaryStatus ?? (plan?.summary ? "ready" : "idle")
    if (summaryStatus === "idle") {
      ctx.resetSummary()
      return
    }

    ctx.setSummaryStatus(summaryStatus)
    ctx.setStreamingSummary(plan?.summary ?? null)
    ctx.setSummaryError(null)
  }, [isActivePanel])

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

    if (
      displayMessages.length === 1 &&
      (isFirstLoadRef.current || shouldFollowBottom())
    ) {
      markProgrammaticScroll()
      scrollViewRef.current?.scrollTo({ y: 0, animated: false })
      isFirstLoadRef.current = false
      return
    }

    const shouldScroll =
      displayMessages.length > 1 &&
      (isFirstLoadRef.current || shouldFollowBottom())

    if (shouldScroll) {
      scrollToBottomIfFollowing(!isFirstLoadRef.current)
      isFirstLoadRef.current = false
    }
  }, [
    displayMessages.length,
    messages,
    currentSessionId,
    isNative,
    shouldFollowBottom,
    scrollToBottomIfFollowing,
    markProgrammaticScroll,
  ])

  // Detect a pending ask_user tool call in the last assistant message and
  // surface its tool data so the interactive question UI can be attached
  // above the chat input (instead of rendered inline in the stream).
  const pendingQuestion = useMemo(
    () => derivePendingQuestion(messages),
    [messages],
  )

  const hasPendingQuestion = pendingQuestion != null
  const questionPresentation = askUserQuestionPresentation(isNativePhoneLayout)
  const [questionSheetOpen, setQuestionSheetOpen] = useState(false)

  useEffect(() => {
    if (questionPresentation !== "sheet") return
    if (!pendingQuestion) {
      setQuestionSheetOpen(false)
      return
    }
    setQuestionSheetOpen(true)
  }, [pendingQuestion?.tool.id, questionPresentation])

  const extractMediaType = useCallback((dataUrl: string): string => {
    const match = dataUrl.match(/^data:([^;]+);/)
    return match?.[1] || "application/octet-stream"
  }, [])
  // Internal function that actually sends a message (used by queue processor)
  // Isolated "actually put it on the wire" step, factored out of
  // `sendMessageInternal` so a network-class failure can be queued for
  // automatic retry WITHOUT re-running the persistence/optimistic-UI side
  // effects (`actions.addMessage`, `setOptimisticUserInput`) that already
  // ran before this is called — re-running those on retry would duplicate
  // the persisted user message. Non-network failures (auth, usage limit,
  // 5xx, etc. — the server DID respond) still propagate normally so the
  // existing error banner handles them.
  const deliverMessage = useCallback(
    async (
      messagePayload: {
        text: string
        files?: Array<{
          type: "file"
          mediaType: string
          url: string
          name?: string
        }>
      },
      bodyExtra: Record<string, unknown>,
      opts?: { queuedId?: string },
    ) => {
      const clientTurnId =
        typeof bodyExtra.clientTurnId === "string"
          ? bodyExtra.clientTurnId
          : undefined
      pendingClientTurnIdRef.current = clientTurnId
      joinedStreamRef.current = false
      try {
        await sendMessage(messagePayload, { body: bodyExtra })
      } catch (err) {
        if (!isClientNetworkFailure(err)) throw err

        console.warn(
          "[ChatPanel] Send failed on a network error — queueing for automatic retry once back online:",
          err,
        )
        const queuedFiles: FileAttachment[] | undefined =
          messagePayload.files?.map((f) => ({
            dataUrl: f.url,
            type: f.mediaType,
            name: f.name ?? "",
          }))
        const entry: QueuedMessage = {
          id:
            opts?.queuedId ??
            `offline-${clientTurnId ?? generateClientTurnId()}`,
          content: messagePayload.text,
          files: queuedFiles,
          selectedModel:
            typeof bodyExtra.agentMode === "string"
              ? bodyExtra.agentMode
              : undefined,
          references: Array.isArray(bodyExtra.references)
            ? (bodyExtra.references as ChatReference[])
            : undefined,
          offline: true,
          offlineRetry: { messagePayload, bodyExtra },
        }
        setMessageQueue((queue) => {
          const existingIdx = opts?.queuedId
            ? queue.findIndex((m) => m.id === opts.queuedId)
            : -1
          if (existingIdx !== -1) {
            const copy = [...queue]
            copy[existingIdx] = entry
            return copy
          }
          return [...queue, entry]
        })
        // Swallowed — the send is handled via the queue now, not a hard
        // failure. The persisted user message + optimistic bubble from
        // `sendMessageInternal` (or the original attempt, on a retry) stay
        // exactly as they are; the "N Queued" strip is the user-visible
        // signal that it hasn't actually gone out yet.
      }
    },
    [sendMessage],
  )

  const sendMessageInternal = useCallback(
    async (
      content: string,
      files?: FileAttachment[],
      perMsgModel?: string,
      extraBody?: Record<string, unknown>,
      references?: ChatReference[],
    ) => {
      if (!currentSessionId) {
        console.warn("[ChatPanel] No session ID - message will be lost!")
        return
      }
      // Hand the transcript back with the stopped reply still in it: the new
      // message is appended after it, not painted over it.
      releaseStopSnapshot()
      stoppedTurnIdRef.current = null
      setEmptyResponseError(null)
      setErrorDismissed(false)
      userInitiatedStopRef.current = false

      const fileArray = files || []

      if (
        !content.trim() &&
        fileArray.length === 0 &&
        (!references || references.length === 0)
      ) {
        return
      }

      if (!(await ensureAiConsentForMessage())) return

      const trimmedContent = content.trim()
      if (Platform.OS !== "web") {
        stickToBottomRef.current = true
      } else {
        isUserAtBottomRef.current = true
      }
      setIsFollowing(true)
      showOptimisticEcho(trimmedContent, fileArray)

      // The turn is in flight from here: the upload below is the first thing
      // that can take real time on a big attachment, and the composer must
      // already be locked and the transcript already painting the bubble
      // (QA round 1 on SHO-213: it looked frozen for the whole upload).
      isSendingMessageRef.current = true

      // Seed the progress row before the first byte moves: a transport that
      // reports no intermediate events (a small file, a fast link) would
      // otherwise leave the composer looking idle for the whole upload.
      const uploading = fileArray.find(
        (file) => !file.savedPath && shouldUploadAttachmentFirst(file),
      )
      if (uploading) setUploadStatus({ name: uploading.name, fraction: 0 })

      // Attachments go up BEFORE the turn. The bytes are PUT to the runtime's
      // streaming route and the message carries a reference part (`savedPath`),
      // so a large archive never becomes a base64 JSON body — that inflation,
      // repeated through the client, the API and the runtime, is what made big
      // attachments time out (SHO-213). Small images stay inline: vision needs
      // their bytes on this very request.
      let outgoingParts: OutgoingFilePart[] = []
      try {
        outgoingParts = await prepareOutgoingFiles(fileArray, {
          agentUrl: agentBaseUrl,
          headers: nativeHeaders ? nativeHeaders() : undefined,
          fetchImpl: expoFetch ?? undefined,
          onUploadProgress: (name, fraction) => setUploadStatus({ name, fraction }),
        })
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Could not upload the attachment."
        console.warn("[ChatPanel] Attachment upload failed:", err)
        isSendingMessageRef.current = false
        setEmptyResponseError(message)
        return
      } finally {
        setUploadStatus(null)
      }

      const parts: Array<
        | { type: "text"; text: string }
        | OutgoingFilePart
      > = []

      if (trimmedContent) {
        parts.push({ type: "text", text: trimmedContent })
      }

      parts.push(...outgoingParts)

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
          parts: parts.length > 0 ? JSON.stringify(parts) : undefined,
        })
        .then((row) => {
          // The row is the thing every server route addresses; hand its id to
          // the bubble so edit/retry/feedback don't have to guess (SHO-263).
          const rowId = (row as { id?: string } | undefined)?.id
          if (rowId) adoptPersistedUserId(rowId, trimmedContent)
        })
        .catch((err) =>
          console.warn("[ChatPanel] Failed to persist user message:", err),
        )

      // Start AI naming alongside the agent turn instead of waiting for the
      // assistant response to finish. The onFinish fallback above covers
      // messages that bypass this path.
      maybeAutoNameSession(currentSessionId, trimmedContent)

      // Optimistically bump the chat session's lastActiveAt so the
      // history sidebar re-buckets this chat into "Today" immediately
      // instead of waiting for a session-list refetch. The server-side
      // chatMessageHooks.afterCreate hook performs the canonical
      // update; this MST mutation just keeps the local view in sync.
      try {
        const sessionInstance = studioChat.chatSessionCollection.get(
          currentSessionId,
        ) as { update?: (changes: Record<string, unknown>) => void } | undefined
        sessionInstance?.update?.({ lastActiveAt: Date.now() })
      } catch (err) {
        console.warn(
          "[ChatPanel] Failed to bump local session lastActiveAt:",
          err,
        )
      }

      // The chat lists keep their own rows (they are not MST collections), so
      // the same bump has to reach them: this re-stamps just this row and
      // re-sorts it to "now" without a list re-fetch.
      chatSessionEvents.emit({
        touchedSessionId: currentSessionId,
        lastActiveAt: Date.now(),
      })

      const messagePayload: {
        text: string
        files?: Array<{
          type: "file"
          mediaType: string
          url: string
          name?: string
        }>
      } = {
        text: trimmedContent,
      }

      // Auto context injection: let the host enrich the message with
      // workspace context (terminal output, git status, diagnostics)
      // before sending to the LLM. The original trimmedContent is
      // already persisted and displayed; only the wire payload changes.
      if (enrichMessage) {
        try {
          messagePayload.text = await enrichMessage(trimmedContent)
        } catch (err) {
          console.warn(
            "[ChatPanel] enrichMessage failed, sending bare message:",
            err,
          )
        }
      }

      if (outgoingParts.length > 0) {
        messagePayload.files = outgoingParts
      }

      try {
        // Reuse the caller-supplied id when this is a retry of an already-
        // queued send (see the offline send queue's drain path); otherwise
        // mint a fresh one for this new logical send. Either way, stash it
        // in the ref the transport's `getClientTurnId` reads so the header
        // on THIS request matches what we record here.
        const clientTurnId =
          (typeof extraBody?.clientTurnId === "string" &&
            extraBody.clientTurnId) ||
          generateClientTurnId()
        pendingClientTurnIdRef.current = clientTurnId

        // Session list reloads replace the MST node for this id, so look it up
        // now rather than reading a render-time node that may be dead.
        const liveSession = studioChat.chatSessionCollection.get(
          currentSessionId,
        ) as { name?: string; inferredName?: string } | undefined
        const planToSend = confirmedPlanRef.current
        confirmedPlanRef.current = null
        const bodyExtra = buildChatSendBody({
          featureId,
          phase,
          chatSessionId: currentSessionId,
          chatSessionName: liveSession?.name || liveSession?.inferredName,
          workspaceId,
          userId,
          projectId,
          focusedProjectId,
          agentMode: perMsgModel || selectedModel,
          dualPlan: dualPlanRef.current,
          clientTurnId,
          // Live canvas preview size (phone vs desktop). The runtime
          // injects this as a layout hint; canvases stay responsive either way.
          viewer: canvasViewerPayload({
            isPhoneViewport,
            platform: Platform.OS,
            width: windowWidth,
          }),
          confirmedPlan: planToSend,
          ideContext:
            ideMode &&
            (ideBridge.context.activeFile ||
              ideBridge.context.workspaceFolders.length > 0)
              ? ideBridge.context
              : undefined,
          // The runtime resolves these into real context (file contents +
          // workspace summaries) before the model runs. Passed through the
          // API proxy untouched, so it also works in direct-to-runtime mode.
          references,
          extra: extraBody,
        })
        console.log(
          "[ChatPanel][send] bodyExtra — agentMode:",
          bodyExtra.agentMode,
          "hasConfirmedPlan:",
          !!bodyExtra.confirmedPlan,
          "text:",
          trimmedContent.slice(0, 80),
        )
        await deliverMessage(messagePayload, bodyExtra)
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
      deliverMessage,
      featureId,
      phase,
      agentBaseUrl,
      nativeHeaders,
      expoFetch,
      workspaceId,
      userId,
      projectId,
      focusedProjectId,
      selectedModel,
      actions,
      enrichMessage,
      ideMode,
      ideBridge.context,
      isPhoneViewport,
      windowWidth,
      maybeAutoNameSession,
      releaseStopSnapshot,
      showOptimisticEcho,
      adoptPersistedUserId,
    ],
  )

  // Register bridge endpoints so the EZ Mode overlay can send messages on our
  // behalf. The registrar is a no-op
  // when no <ChatBridgeProvider> is mounted (e.g. tests), so it's safe to
  // call unconditionally.
  const bridgeSend = useCallback(
    (text: string) => {
      void sendMessageInternal(text)
    },
    [sendMessageInternal],
  )
  const {
    emitTurnStart: bridgeEmitTurnStart,
    emitToolActivity: bridgeEmitToolActivity,
    emitTurnEnd: bridgeEmitTurnEnd,
    setSubagentCards: bridgeSetSubagentCards,
  } = useChatBridgeRegistrar({
    send: bridgeSend,
  })
  useEffect(() => {
    emitTurnStartRef.current = bridgeEmitTurnStart
    emitToolActivityRef.current = bridgeEmitToolActivity
    emitTurnEndRef.current = bridgeEmitTurnEnd
    setSubagentCardsRef.current = bridgeSetSubagentCards
    return () => {
      if (emitTurnStartRef.current === bridgeEmitTurnStart)
        emitTurnStartRef.current = null
      if (emitToolActivityRef.current === bridgeEmitToolActivity)
        emitToolActivityRef.current = null
      if (emitTurnEndRef.current === bridgeEmitTurnEnd)
        emitTurnEndRef.current = null
      if (setSubagentCardsRef.current === bridgeSetSubagentCards)
        setSubagentCardsRef.current = null
    }
  }, [
    bridgeEmitTurnStart,
    bridgeEmitToolActivity,
    bridgeEmitTurnEnd,
    bridgeSetSubagentCards,
  ])

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
      if (nextMessage.offline && nextMessage.offlineRetry) {
        // Redeliver the exact original payload rather than re-running
        // `sendMessageInternal` — that already persisted the user message
        // and set the optimistic bubble on the FIRST attempt; re-running it
        // here would duplicate both. `deliverMessage` re-queues (doesn't
        // throw) on a repeat network failure, so this "succeeds" either way.
        await deliverMessage(
          nextMessage.offlineRetry.messagePayload,
          nextMessage.offlineRetry.bodyExtra,
          { queuedId: nextMessage.id },
        )
        // An offline retry that fails again never starts a real stream, so
        // the `isStreaming` falling-edge effect below will never fire for
        // it — reset here so the next online-restored tick can pick the
        // queue back up instead of finding it wedged `true` forever.
        isProcessingQueueRef.current = false
      } else {
        await sendMessageInternal(
          nextMessage.content,
          nextMessage.files,
          nextMessage.selectedModel,
          undefined,
          nextMessage.references,
        )
      }
    } catch (err) {
      console.error("[ChatPanel] Error processing queued message:", err)
      isProcessingQueueRef.current = false
    }
  }, [
    isStreaming,
    sendMessageInternal,
    deliverMessage,
    currentSessionId,
    messageQueue,
  ])

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

  // Drain offline-queued sends once connectivity looks restored. Unlike the
  // falling-edge effect above (which only fires after a real stream ends),
  // an offline entry never starts a stream in the first place — nothing
  // will naturally trigger a retry unless we watch for connectivity
  // ourselves. `navigator.onLine`/the `online` event only report link
  // state (a captive portal or LAN-only wifi still fires `online`), so we
  // confirm with the same `/api/ai/upstream-health` probe the server-side
  // park tier uses before actually draining.
  const hasOfflineQueued = messageQueue.some((m) => m.offline)
  useEffect(() => {
    if (!hasOfflineQueued || !currentSessionId) return

    let cancelled = false
    const checkUpstreamReachable = async (): Promise<boolean> => {
      if (typeof navigator !== "undefined" && navigator.onLine === false)
        return false
      if (!API_URL) return true
      try {
        const fetchFn = expoFetch ?? globalThis.fetch
        const res = await fetchFn(`${API_URL}/api/ai/upstream-health`, {
          signal: AbortSignal.timeout(4000),
        } as any)
        if (!res.ok) return false
        const data = await res.json().catch(() => null)
        return !!data?.reachable
      } catch {
        return false
      }
    }

    const tryDrain = async () => {
      if (cancelled || isStreaming || isProcessingQueueRef.current) return
      const reachable = await checkUpstreamReachable()
      if (!cancelled && reachable) {
        processMessageQueue()
      }
    }

    const onOnline = () => {
      void tryDrain()
    }
    if (
      typeof window !== "undefined" &&
      typeof window.addEventListener === "function"
    ) {
      window.addEventListener("online", onOnline)
    }
    // Desktop sleep/wake: `online` doesn't reliably fire for a wake with
    // wifi already associated (the OS never dropped the link, it just
    // stopped scheduling timers), so a laptop that slept through an entire
    // outage would otherwise sit on the 10s poll below. `system-resume` is
    // Electron's `powerMonitor` forwarded via preload — see the effect
    // above and `apps/desktop/src/main.ts`. No-op on mobile/web.
    const bridge = (
      window as unknown as {
        shogoDesktop?: {
          onSystemResume?: (cb: () => void) => () => void
          // The desktop app respawns its local API in-process after it is
          // killed from userland (SHO-26); see `preload.ts`.
          onLocalServerRestarted?: (cb: () => void) => () => void
        }
      }
    ).shogoDesktop
    const unsubscribeResume = bridge?.onSystemResume?.(() => {
      void tryDrain()
    })
    // Same recovery when the desktop app had to respawn its local API after a
    // userland kill (SHO-26): requests failed while it was down, so probe and
    // flush as soon as it is healthy again.
    const unsubscribeLocalApiRestarted = bridge?.onLocalServerRestarted?.(() => {
      void tryDrain()
    })
    // Poll as a fallback for the remaining case neither event covers: a
    // captive portal / LAN with a link but no real internet — the
    // upstream-health probe is the actual source of truth.
    const interval = setInterval(() => {
      void tryDrain()
    }, 10_000)
    void tryDrain()

    return () => {
      cancelled = true
      if (
        typeof window !== "undefined" &&
        typeof window.removeEventListener === "function"
      ) {
        window.removeEventListener("online", onOnline)
      }
      unsubscribeResume?.()
      unsubscribeLocalApiRestarted?.()
      clearInterval(interval)
    }
  }, [
    hasOfflineQueued,
    isStreaming,
    currentSessionId,
    processMessageQueue,
    expoFetch,
  ])

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

  // Restart the stall window whenever the tab returns to the foreground. While
  // hidden, `setInterval` is throttled/suspended and `Date.now()` jumps, so a
  // long background stint would otherwise make the watchdog trip on the first
  // foreground tick — force-stopping a healthy turn and emitting a false
  // `chat_stall_watchdog_tripped` (Sentry REACT-38: ~half of trips had elapsed
  // ≫ threshold, up to ~2h). Resetting the progress mark on refocus gives the
  // turn a fresh threshold window to show progress / auto-resume reattach.
  useEffect(() => {
    if (typeof document === "undefined") return
    const onVisibility = () => {
      lastChatProgressAtRef.current = resolveProgressAfterVisibilityChange({
        isVisibleNow: document.visibilityState === "visible",
        now: Date.now(),
        lastProgressAt: lastChatProgressAtRef.current,
      })
    }
    document.addEventListener("visibilitychange", onVisibility)
    return () => document.removeEventListener("visibilitychange", onVisibility)
  }, [])

  // Desktop-only: same false-stall-trip problem as the tab-visibility case
  // above, but for a real OS sleep/wake (lid close, `pmset sleepnow`, etc.)
  // rather than a backgrounded tab — a nap can outlast the stall threshold
  // by hours. `window.shogoDesktop.onSystemResume` is wired from Electron's
  // `powerMonitor` in `apps/desktop/src/main.ts`; it's undefined on mobile
  // / web builds, where this is a no-op.
  useEffect(() => {
    const bridge = (
      window as unknown as {
        shogoDesktop?: {
          onSystemResume?: (cb: () => void) => () => void
          // The desktop app respawns its local API in-process after it is
          // killed from userland (SHO-26); see `preload.ts`.
          onLocalServerRestarted?: (cb: () => void) => () => void
        }
      }
    ).shogoDesktop
    if (!bridge?.onSystemResume) return
    const unsubscribe = bridge.onSystemResume(() => {
      console.log(
        "[ChatPanel] System resumed from sleep — resetting stall watchdog and re-checking connectivity",
      )
      lastChatProgressAtRef.current = Date.now()
    })
    // A respawned local API means the in-flight socket died with the old
    // process; give the turn a fresh stall window instead of letting the
    // watchdog trip on the gap (SHO-26).
    const unsubscribeLocalApiRestarted = bridge.onLocalServerRestarted?.(() => {
      console.log(
        "[ChatPanel] Desktop local API restarted — resetting stall watchdog",
      )
      lastChatProgressAtRef.current = Date.now()
    })
    return () => {
      unsubscribe()
      unsubscribeLocalApiRestarted?.()
    }
  }, [])

  useEffect(() => {
    if (!isStreaming) return
    const intervalMs = Math.min(
      DEFAULT_SUBMITTED_STALL_MS,
      DEFAULT_STREAMING_STALL_MS,
      15_000,
    )
    const timer = setInterval(() => {
      const now = Date.now()
      const lastProgressAt = lastChatProgressAtRef.current
      if (
        isChatStalled({
          status,
          lastProgressAt,
          now,
          documentHidden:
            typeof document !== "undefined" &&
            document.visibilityState === "hidden",
        })
      ) {
        const elapsedMs = now - lastProgressAt
        console.warn(
          `[ChatPanel] stall watchdog tripped — status=${status} pinned for ${elapsedMs}ms with no progress; calling stop() to recover`,
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
          stallWatchdogTrippedRef.current = true
          setEmptyResponseError(STALL_TIMEOUT_USER_MESSAGE)
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
      ? (sessionQueueCache.get(currentSessionId) ?? [])
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

  const handleRemoveQueuedMessage = useCallback(
    (messageId: string) => {
      const removed =
        messageQueue.find((m) => m.id === messageId) ??
        serverQueue.queuedMessages.find((m) => m.id === messageId)
      if (removed) clearOptimisticEcho(removed.content)
      if (serverQueue.isServerQueued(messageId)) {
        void serverQueue.remove(messageId).catch((error) => {
          console.warn(
            "[ChatPanel] Failed to remove server queued message:",
            error,
          )
        })
        return
      }
      setMessageQueue((queue) => queue.filter((m) => m.id !== messageId))
    },
    [clearOptimisticEcho, messageQueue, serverQueue],
  )

  const handleReorderQueuedMessage = useCallback(
    (messageId: string, direction: "up" | "down") => {
      if (serverQueue.isServerQueued(messageId)) {
        void serverQueue.reorder(messageId, direction).catch((error) => {
          console.warn(
            "[ChatPanel] Failed to reorder server queued message:",
            error,
          )
        })
        return
      }
      setMessageQueue((queue) => {
        const index = queue.findIndex((m) => m.id === messageId)
        if (index === -1) return queue

        const newQueue = [...queue]
        if (direction === "up" && index > 0) {
          ;[newQueue[index - 1], newQueue[index]] = [
            newQueue[index],
            newQueue[index - 1],
          ]
        } else if (direction === "down" && index < newQueue.length - 1) {
          ;[newQueue[index], newQueue[index + 1]] = [
            newQueue[index + 1],
            newQueue[index],
          ]
        }
        return newQueue
      })
    },
    [serverQueue],
  )

  // Pull a queued message back into the input as a draft so the user can
  // tweak the text/attachments and re-send. We remove the original entry
  // immediately so re-submitting just appends a fresh queue item rather than
  // duplicating the in-flight one.
  const handleEditQueuedMessage = useCallback(
    (messageId: string) => {
      const serverTarget = serverQueue.queuedMessages.find(
        (m) => m.id === messageId,
      )
      if (serverTarget) {
        clearOptimisticEcho(serverTarget.content)
        void serverQueue.remove(messageId).catch((error) => {
          console.warn(
            "[ChatPanel] Failed to edit server queued message:",
            error,
          )
        })
        setRestoreDraftRequest({
          nonce: Date.now(),
          content: serverTarget.content,
          files: serverTarget.files,
        })
        return
      }
      let target: QueuedMessage | undefined
      setMessageQueue((queue) => {
        target = queue.find((m) => m.id === messageId)
        if (!target) return queue
        return queue.filter((m) => m.id !== messageId)
      })
      if (!target) return
      clearOptimisticEcho(target.content)
      setRestoreDraftRequest({
        nonce: Date.now(),
        content: target.content,
        files: target.files,
      })
    },
    [clearOptimisticEcho, serverQueue],
  )

  /**
   * Local queue rows the person clicked "Send now" on while a turn was
   * streaming. The local queue is drained by this window, not the server: the
   * row leaves `messageQueue` only when the drain takes it on the falling edge
   * of the stop this click asks for, so the dock would keep showing a message
   * the person has already sent. Cleared when the row leaves the queue, and on
   * that falling edge — a row the drain did not take is still queued.
   */
  const [sentNowIds, setSentNowIds] = useState<Set<string>>(() => new Set())

  // "Send now" — interrupt the current streaming turn and immediately drain
  // the chosen queued message. Implemented as "promote to front + stop" so we
  // re-use the existing falling-edge drain effect (see `processMessageQueue`
  // hookup ~line 3514) rather than introducing a parallel send-by-id path.
  // When no turn is streaming we drain directly: cached queues restored on
  // session switch can sit idle since the falling-edge effect only fires on
  // streaming->ready transitions.
  const handleSendQueuedMessageNow = useCallback(
    (messageId: string) => {
      if (serverQueue.isServerQueued(messageId)) {
        void serverQueue.sendNow(messageId).catch((error) => {
          console.warn(
            "[ChatPanel] Failed to send server queued message now:",
            error,
          )
        })
        return
      }
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
        setSentNowIds((current) => {
          if (current.has(messageId)) return current
          const next = new Set(current)
          next.add(messageId)
          return next
        })
        handleStop()
      } else {
        void processMessageQueue()
      }
    },
    [isStreaming, handleStop, processMessageQueue, serverQueue],
  )

  // A hidden local row is gone from the queue (the drain took it) or the turn
  // came to rest without taking it (still queued, so it has to be visible).
  useEffect(() => {
    if (sentNowIds.size === 0) return
    if (!isStreaming) {
      setSentNowIds(new Set())
      return
    }
    const queued = new Set(messageQueue.map((m) => m.id))
    let stale = false
    for (const id of sentNowIds) if (!queued.has(id)) stale = true
    if (!stale) return
    setSentNowIds((current) => {
      const next = new Set(current)
      for (const id of current) if (!queued.has(id)) next.delete(id)
      return next
    })
  }, [isStreaming, messageQueue, sentNowIds])

  /**
   * The waiting chip's Resume: deliver the updates a paused session is holding.
   * The server un-pauses the wake; this window only needs to refresh the queue.
   */
  const handleResumeTaskWakes = useCallback(
    (messageId: string) => {
      void serverQueue.resumeTaskWake(messageId).catch((error) => {
        console.warn("[ChatPanel] Failed to resume waiting updates:", error)
      })
    },
    [serverQueue],
  )

  // A team-chat message queued behind this session's turn is its own queue row:
  // Send now and ✕ reach the agent-wake routes, never the session's own queue.
  // The promise goes back to the row so a refusal (409 not_pending, 403 viewer)
  // is shown where the person pressed, not just logged.
  const handleSendAgentWakeNow = useCallback(
    (wakeId: string) => serverQueue.sendWakeNow(wakeId),
    [serverQueue],
  )
  const handleRemoveAgentWake = useCallback(
    (wakeId: string) => serverQueue.removeWake(wakeId),
    [serverQueue],
  )

  const displayedQueue = useMemo(
    () =>
      [...serverQueue.queuedMessages, ...messageQueue].filter(
        (message) => !sentNowIds.has(message.id),
      ),
    [messageQueue, sentNowIds, serverQueue.queuedMessages],
  )

  const enqueueServerMessage = useCallback(
    async (
      content: string,
      files?: FileAttachment[],
      perMsgModel?: string,
      references?: ChatReference[],
    ) => {
      const trimmedContent = content.trim()
      if (!(await ensureAiConsentForMessage())) return
      let wireText = trimmedContent
      if (enrichMessage) {
        try {
          wireText = await enrichMessage(trimmedContent)
        } catch (error) {
          console.warn(
            "[ChatPanel] enrichMessage failed for queued message:",
            error,
          )
        }
      }

      const planToSend = confirmedPlanRef.current
      confirmedPlanRef.current = null
      const body = buildChatSendBody({
        featureId,
        phase,
        chatSessionId: currentSessionId,
        chatSessionName:
          (currentSession as any)?.name || (currentSession as any)?.inferredName,
        workspaceId,
        userId,
        projectId,
        focusedProjectId,
        agentMode: perMsgModel || selectedModel,
        dualPlan: dualPlanRef.current,
        viewer: canvasViewerPayload({
          isPhoneViewport,
          platform: Platform.OS,
          width: windowWidth,
        }),
        confirmedPlan: planToSend,
        ideContext:
          ideMode &&
          (ideBridge.context.activeFile ||
            ideBridge.context.workspaceFolders.length > 0)
            ? ideBridge.context
            : undefined,
        references,
        extra: { text: wireText },
      })

      await serverQueue.enqueue({
        content: trimmedContent,
        files,
        selectedModel: perMsgModel || selectedModel,
        references,
        body,
      })
      // The queued turn is the server's to run: until it takes the row there
      // is no user message in this session, so the message lives in the dock
      // only and the caller drops the pre-send echo. When the server
      // dispatches it, the hook hands over that turn's saved user message and
      // it appears in the transcript with its reply. Hand back any stopped
      // snapshot so that reply lands *below* the stop.
      releaseStopSnapshot()
    },
    [
      currentSession,
      currentSessionId,
      enrichMessage,
      featureId,
      focusedProjectId,
      ideBridge.context,
      ideMode,
      isPhoneViewport,
      phase,
      projectId,
      releaseStopSnapshot,
      selectedModel,
      serverQueue,
      userId,
      windowWidth,
      workspaceId,
    ],
  )

  // Handle message submission
  const handleSendMessage = useCallback(
    async (
      content: string,
      files?: FileAttachment[],
      perMsgModel?: string,
      references?: ChatReference[],
    ) => {
      if (!currentSessionId) {
        console.warn("[ChatPanel] No session ID - message will be lost!")
        return
      }

      if (
        !content.trim() &&
        (!files || files.length === 0) &&
        (!references || references.length === 0)
      ) {
        return
      }

      const trimmedContent = content.trim()

      // iOS shows a one-time consent prompt before the message leaves the
      // device; everywhere else this resolves on the next microtask, so the
      // echo below still paints before any request goes out.
      if (!(await ensureAiConsentForMessage())) return

      // Paint the user's own bubble before anything is awaited or sent: the
      // composer is already empty, and the live-turn probe below can take its
      // full budget before `sendMessageInternal` runs.
      showOptimisticEcho(trimmedContent, files)

      const queueMessage = async () => {
        // Anything that lands in `displayedQueue` (the dock) must not also sit
        // in the transcript: a queued message is not a turn yet, and its bubble
        // appears when the server dispatches it.
        const queueLocally = () => {
          clearOptimisticEcho(trimmedContent)
          setMessageQueue((queue) => [
            ...queue,
            {
              id: `queue-${Date.now()}-${Math.random()
                .toString(36)
                .substr(2, 9)}`,
              content: trimmedContent,
              files,
              selectedModel: perMsgModel,
              references,
            },
          ])
        }
        if (localAgentUrl) {
          queueLocally()
          return
        }
        try {
          await enqueueServerMessage(
            trimmedContent,
            files,
            perMsgModel,
            references,
          )
          clearOptimisticEcho(trimmedContent)
        } catch (error) {
          console.warn(
            "[ChatPanel] Server queue unavailable; retaining a local queued message:",
            error,
          )
          queueLocally()
        }
      }

      if (
        isStreaming ||
        isProcessingQueueRef.current ||
        isSendingMessageRef.current
      ) {
        await queueMessage()
        return
      }

      // The chat can be busy without this window knowing: a turn started in
      // another window, by another member, or by a schedule. Sending now
      // would start a second turn behind it with nothing on screen but Stop,
      // so queue the message behind the live turn and show that turn here.
      // Bounded: a cold runtime must not hold the message back. If the probe
      // gives up, the runtime still waits for any live turn before this one.
      //
      // The turn the user just stopped is not "busy": it can still read
      // `active` for a moment, and queueing behind it is what attached the new
      // reply to the old message (see stopped-turn.ts).
      const turn = await probeLiveTurn(currentSessionId, {
        timeoutMs: 1500,
      })
      if (
        isLiveTurnOtherThan(turn, stoppedTurnIdRef.current) &&
        currentSessionIdRef.current === currentSessionId
      ) {
        await queueMessage()
        if (!isStreamingRef.current) reloadAndAttachLiveTurn()
        return
      }

      await sendMessageInternal(
        trimmedContent,
        files,
        perMsgModel,
        undefined,
        references,
      )
    },
    [
      clearOptimisticEcho,
      enqueueServerMessage,
      isStreaming,
      localAgentUrl,
      sendMessageInternal,
      currentSessionId,
      probeLiveTurn,
      reloadAndAttachLiveTurn,
      showOptimisticEcho,
    ],
  )

  // Handle form submit from ChatInput
  const handleInputSubmit = useCallback(
    (
      content: string,
      files?: FileAttachment[],
      perMsgModel?: string,
      references?: ChatReference[],
    ) => {
      handleSendMessage(content, files, perMsgModel, references)
    },
    [handleSendMessage],
  )

  // Plan confirmation: execute the plan in this same chat.
  // Keep the PlanCard visible with confirmed state for a few seconds before dismissing.
  const confirmDismissTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  )
  const handleConfirmPlan = useCallback(
    (plan?: PlanData | null, modelId?: string) => {
      const selectedPlan = plan ?? pendingPlanRef.current
      if (!selectedPlan) return
      const planToBuild = normalizePlanData(selectedPlan)
      confirmedPlanRef.current = planToBuild
      setConfirmedPlan(planToBuild)
      pendingPlanRef.current = null
      setPendingPlan(null)
      handleSendMessage("Execute the confirmed plan.", undefined, modelId)
      if (confirmDismissTimerRef.current)
        clearTimeout(confirmDismissTimerRef.current)
      confirmDismissTimerRef.current = setTimeout(() => {
        setConfirmedPlan(null)
      }, 4000)
    },
    [handleSendMessage],
  )

  // Build from Plans panel: execute a saved plan with selected model
  const lastBuildNonceRef = useRef<number>(0)
  useEffect(() => {
    if (
      !buildPlanRequest ||
      buildPlanRequest.nonce === lastBuildNonceRef.current
    )
      return
    lastBuildNonceRef.current = buildPlanRequest.nonce
    const { plan, modelId } = buildPlanRequest
    const planToBuild = normalizePlanData(plan)
    confirmedPlanRef.current = planToBuild
    setConfirmedPlan(planToBuild)
    pendingPlanRef.current = null
    setPendingPlan(null)
    handleSendMessage("Execute the confirmed plan.", undefined, modelId)
    if (confirmDismissTimerRef.current)
      clearTimeout(confirmDismissTimerRef.current)
    confirmDismissTimerRef.current = setTimeout(() => {
      setConfirmedPlan(null)
    }, 4000)
    onBuildPlanConsumed?.(buildPlanRequest.nonce)
  }, [
    buildPlanRequest,
    handleSendMessage,
    onBuildPlanConsumed,
  ])

  useEffect(() => {
    return () => {
      if (confirmDismissTimerRef.current)
        clearTimeout(confirmDismissTimerRef.current)
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
  }, [
    initialMessage,
    initialFiles,
    currentSessionId,
    isInitialLoadComplete,
    handleSendMessage,
  ])

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

    // "Shogo: Explain / Improve / Write Tests for Selection" editor actions.
    const onAsk = (e: Event) => {
      const detail = (e as CustomEvent<AskInAgentPayload>).detail
      if (!detail?.prompt) return
      handleSendMessage(detail.prompt)
    }

    window.addEventListener(FIX_IN_AGENT_EVENT, onFix as EventListener)
    window.addEventListener(ASK_IN_AGENT_EVENT, onAsk as EventListener)
    return () => {
      window.removeEventListener(FIX_IN_AGENT_EVENT, onFix as EventListener)
      window.removeEventListener(ASK_IN_AGENT_EVENT, onAsk as EventListener)
    }
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

  // "Add to Chat" from the IDE tree/editor, the terminal (⌘L) and Shogo Code:
  // inserted at the caret, never replacing the draft; a collapsed chat expands.
  const { insertRequest, markApplied: handleInsertApplied } = useChatInsertQueue({
    isActive,
    expand: () => {
      if (!isCollapsed) return
      setIsCollapsed(false)
      if (!onCollapsedChange) setStoredCollapsed(false)
    },
  })

  // Error retry handler.
  //
  // Non-destructive triage (see retry-triage.ts). The old behavior truncated
  // the conversation (`setMessages(messages.slice(0, lastUserIdx))`) and
  // re-sent the original user message, throwing away the interrupted turn's
  // completed tool calls + partial answer. Instead we probe the runtime:
  //
  //   - turn still `active` (transport drop, agent still running) -> reconnect
  //     to the live buffered stream. No re-send, nothing truncated.
  //   - terminal but the last assistant turn has resumable work -> ask the
  //     server to continue from the preserved session context (continue:true).
  //   - nothing resumable -> re-send the original user message (last resort),
  //     still WITHOUT truncating any rendered work.
  const handleRetry = useCallback(() => {
    if (messages.length === 0) return

    const lastUserMsg = [...messages].reverse().find((m) => m.role === "user")
    // Extract the original content/files up front for the resend fallback.
    const parts = ((lastUserMsg as any)?.parts ?? []) as any[]
    const textPart = parts.find((p: any) => p.type === "text")
    const content = textPart?.text || ""
    const fileParts = parts.filter((p: any) => p?.type === "file" && p?.url)
    const cachedFiles = lastUserInputRef.current?.files
    const filesFromParts: FileAttachment[] = fileParts.map((p: any) => ({
      dataUrl: p.url,
      name: p.name ?? p.filename ?? "file",
      type: p.mediaType ?? extractMediaType(p.url),
      ...(typeof p.savedPath === "string" ? { savedPath: p.savedPath } : {}),
    }))
    const files: FileAttachment[] | undefined =
      cachedFiles && cachedFiles.length > 0
        ? cachedFiles
        : filesFromParts.length > 0
          ? filesFromParts
          : undefined

    void (async () => {
      // Probe whether the turn is still running on the server. Any failure mode
      // collapses to 'unknown' (never throws), so this is safe to await.
      let turnStatus: ChatTurnStatus = "unknown"
      if (currentSessionId && API_URL) {
        try {
          const turnUrl = buildChatTurnUrl(
            API_URL,
            projectId,
            localAgentUrl,
            currentSessionId,
            chatWorkspaceId,
          )
          turnStatus = await probeChatTurnStatus({
            url: turnUrl,
            fetch: expoFetch,
            headers: nativeHeaders ? nativeHeaders() : undefined,
            credentials: Platform.OS === "web" ? "include" : undefined,
          })
        } catch {
          turnStatus = "unknown"
        }
      }

      const action = decideRetryAction({
        turnStatus,
        hasResumableTurn: lastAssistantHasResumableWork(messages as any),
      })

      if (action === "reconnect") {
        // Agent is still running and buffering frames — reattach. The rendered
        // messages (including completed tool calls) stay exactly as they are.
        void resumeStreamSingleFlight()
        return
      }

      if (action === "continue") {
        // Continue from preserved server-side context. The `continue` flag
        // tells the runtime to craft a continuation instruction and reuse the
        // interrupted turn's persisted tool calls instead of restarting.
        sendMessageInternal("Continue", undefined, undefined, {
          continue: true,
        }).catch((err) =>
          console.error("[ChatPanel] Retry continue failed:", err),
        )
        return
      }

      // resend: nothing to resume/continue. Re-send the original message — but
      // do NOT truncate any already-rendered work.
      if (content || (files && files.length > 0)) {
        sendMessageInternal(content, files).catch((err) =>
          console.error("[ChatPanel] Retry resend failed:", err),
        )
      }
    })()
  }, [
    messages,
    sendMessageInternal,
    resumeStreamSingleFlight,
    currentSessionId,
    projectId,
    localAgentUrl,
    chatWorkspaceId,
    expoFetch,
    nativeHeaders,
    extractMediaType,
  ])

  const handleRetryRef = useRef<(() => void) | null>(null)
  handleRetryRef.current = handleRetry

  // Automatic stall recovery — invoked by the falling-edge effect the instant
  // a turn ends without `data-turn-complete`. This is the non-interactive twin
  // of `handleRetry`'s `reconnect` branch: it ONLY reattaches to a still-active
  // server turn (never re-sends or continues, which would surprise the user by
  // restarting work behind their back). A bounded poll absorbs the brief window
  // where the runtime hasn't re-published the buffer yet (warm-pool / pod
  // transition), and any session switch / new turn / user-stop cancels it.
  const attemptStallRecovery = useCallback(() => {
    if (!currentSessionId || !API_URL) return
    const recoverySessionId = currentSessionId
    const recoveryTurnId = currentTurnIdRef.current
    const fromSeqAtStall = turnLastSeqRef.current
    const MAX_ATTEMPTS = 4

    setStreamAutoRecovering(true)
    void (async () => {
      try {
        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
          // Bail if the user moved on (switched session), stopped, or a fresh
          // turn started — reconnecting now would graft onto the wrong panel.
          if (
            userInitiatedStopRef.current ||
            currentSessionIdRef.current !== recoverySessionId ||
            isTransportStreamingRef.current
          ) {
            return
          }

          let turnStatus: ChatTurnStatus = "unknown"
          try {
            const turnUrl = buildChatTurnUrl(
              API_URL,
              projectId,
              localAgentUrl,
              recoverySessionId,
              chatWorkspaceId,
            )
            turnStatus = await probeChatTurnStatus({
              url: turnUrl,
              fetch: expoFetch,
              headers: nativeHeaders ? nativeHeaders() : undefined,
              credentials: Platform.OS === "web" ? "include" : undefined,
            })
          } catch {
            turnStatus = "unknown"
          }

          // Re-check liveness after the await — the world may have changed.
          if (
            currentSessionIdRef.current !== recoverySessionId ||
            isTransportStreamingRef.current
          ) {
            return
          }

          const effects = getStallRecoveryEffects({
            turnStatus,
            attempt,
            maxAttempts: MAX_ATTEMPTS,
          })
          if (effects.action === "reconnect") {
            console.log(
              `[ChatPanel] auto-recovery: turn ${recoveryTurnId} still active — reattaching live stream (fromSeq=${fromSeqAtStall})`,
            )
            guardedAutoResumeStream("stall-recovery")
            return
          }
          if (effects.interruptStuckTools) {
            // Terminal or persistently-unknown: close the UI-side tool
            // invocations as interrupted. Previously the stream status fell
            // back to "ready" while these parts stayed input-available,
            // leaving permanent spinners with no Stop button.
            setMessages((prev) =>
              markStuckToolsInterrupted(prev, "Connection interrupted"),
            )
            // The stall watchdog reports its own trips; this give-up path
            // (stream ended without turn-complete and could not be
            // reattached) shows the same banner, so report it separately.
            try {
              Sentry.captureMessage("chat_stall_recovery_gave_up", {
                level: "warning",
                tags: {
                  projectId: projectId ?? "(none)",
                  chatSessionId: recoverySessionId,
                  turnStatus,
                },
                extra: {
                  attempt,
                  maxAttempts: MAX_ATTEMPTS,
                  turnId: recoveryTurnId,
                  fromSeq: fromSeqAtStall,
                  isLocalAgent: !!localAgentUrl,
                },
              })
            } catch (err) {
              console.warn("[ChatPanel] Sentry.captureMessage threw:", err)
            }
            if (effects.showRetryBanner) {
              setErrorDismissed(false)
              setEmptyResponseError(STALL_TIMEOUT_USER_MESSAGE)
            }
            return
          }
          // retry-later: brief backoff, then probe again.
          await new Promise<void>((r) =>
            setTimeout(r, computeRecoveryBackoff(attempt)),
          )
        }
      } finally {
        setStreamAutoRecovering(false)
      }
    })()
  }, [
    currentSessionId,
    projectId,
    localAgentUrl,
    chatWorkspaceId,
    expoFetch,
    nativeHeaders,
    guardedAutoResumeStream,
  ])
  stallRecoveryRef.current = attemptStallRecovery

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
  // A truncation is a deletion, so every copy a later delta or paint merges
  // from has to shrink with the transcript. Leaving the tail in the panel cache
  // and the device store lets the next delta paint the rows the server just
  // deleted straight back — a delta cannot carry a deletion, so the stored
  // cursor goes too and the next open reads the full page (SHO-260).
  const forgetTruncatedHistory = useCallback(
    (sessionId: string | null, keep: any[]) => {
      cachedMessagesRef.current = keep
      lastNonEmptyMessagesRef.current = keep
      if (!sessionId) return
      writeSessionMessageCache(sessionId, keep)
      const key = historyKeyFor(sessionId)
      if (!key) return
      historyMetaRef.current.delete(key)
      void removeChatHistory("project", key).catch(() => {})
    },
    [historyKeyFor],
  )

  const truncateAndResend = useCallback(
    async (
      messageId: string,
      newContent: string,
      newFiles: FileAttachment[] | undefined,
      options: MessageEditOptions | undefined,
    ) => {
      if (!sessionMessages) {
        throw new Error("This chat is still loading — try again in a moment.")
      }
      const current = messagesRef.current
      const idx = current.findIndex((m) => m.id === messageId)
      if (idx === -1) {
        throw new Error("That message is no longer in this chat.")
      }

      // Optimistic collapse: the turns that will be replaced disappear the
      // moment the user hits Send, and the normal working row takes over.
      // If the truncate itself fails nothing was deleted server-side, so the
      // whole transcript comes back and the editor reopens with the draft.
      const previous = current
      const kept = current.slice(0, idx)
      setMessages(kept)
      let truncated = false

      // Step 1: chat truncation. This is the source of truth — if it
      // fails we abort the whole rewind. The local MST cache is
      // mirrored inside truncateMessagesFrom.
      try {
        await truncateMessagesFrom(sessionMessages, messageId)
        truncated = true
        forgetTruncatedHistory(currentSessionIdRef.current ?? null, kept)
      } catch (err) {
        console.error("[ChatPanel] truncate-from failed:", err)
        setMessages(previous)
        throw err instanceof Error
          ? err
          : new Error("Could not remove the messages after this one.")
      }

      // Step 2: optional file rollback. Runs BETWEEN the chat
      // truncation and the resend so that:
      //   - The user sees their chat collapse to the edit point
      //     before the (potentially slow) git checkout runs.
      //   - A rollback failure leaves us in a coherent state — chat
      //     is at the new edit point, files are unchanged, no new
      //     send is fired. The error bubbles up to the editor where
      //     it is shown inline under the draft.
      //   - The server's pre-rollback auto-save still protects any
      //     uncommitted user changes in the workspace.
      if (options?.revertFiles && options.checkpoint) {
        try {
          await rollbackProjectToCheckpoint(sessionMessages, {
            projectId: options.checkpoint.projectId,
            checkpointId: options.checkpoint.id,
            checkpointCreatedAt: options.checkpoint.createdAt,
            // The database toggle is not offered from a chat edit — power
            // users still have the Checkpoints panel for that finer-grained
            // call. Default false so an edit never surprises anyone with a
            // DB rollback.
            includeDatabase: false,
          })
          // The note lands on the resent message as soon as the transcript
          // shows it (see the `messages` effect that drains this ref).
          pendingRevertNoteRef.current = {
            text: newContent,
            note: filesRevertedNote(
              formatRelativeTime(options.checkpoint.createdAt),
            ),
          }
        } catch (err) {
          console.error("[ChatPanel] checkpoint rollback failed:", err)
          if (!truncated) setMessages(previous)
          throw err instanceof Error
            ? err
            : new Error("Could not revert project files to the checkpoint.")
        }
      }

      await sendMessageInternal(newContent, newFiles)
    },
    [sessionMessages, setMessages, sendMessageInternal, forgetTruncatedHistory],
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
      const content = stripAskUserAnswerMarker(
        textPart?.text || extractTextContent(msg) || "",
      )
      const fileParts = parts.filter((p: any) => p?.type === "file" && p?.url)
      const files: FileAttachment[] | undefined =
        fileParts.length > 0
          ? fileParts.map((p: any) => ({
              dataUrl: p.url,
              name: p.name ?? p.filename ?? "file",
              type: p.mediaType ?? extractMediaType(p.url),
              ...(typeof p.savedPath === "string" ? { savedPath: p.savedPath } : {}),
            }))
          : undefined
      if (!content && !files) return
      await truncateAndResend(messageId, content, files, options)
    },
    [truncateAndResend, extractMediaType],
  )

  // Feeds the inline editor's "Revert files to before this message" checkbox.
  // We resolve through the SDK env's HttpClient (via shared-app helper) so the
  // remote-aware interceptor proxies to the desktop instance when one is
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
    [
      selectedModel,
      handleModelChange,
      hasAdvancedModelAccess,
      handleUpgradeClick,
    ],
  )

  const revertedNote = useCallback(
    (messageId: string) => revertedNotes[messageId] ?? null,
    [revertedNotes],
  )

  const messageEditValue = useMemo(
    () => ({
      editMessage: handleEditMessage,
      retryFromMessage: handleRetryFromMessage,
      countMessagesAfter,
      isStreaming,
      stopStreaming: stopStreamingAndWait,
      editingMessageId,
      setEditingMessageId,
      inlineEditDirty,
      setInlineEditDirty,
      canEditMessage,
      pendingEdit,
      setPendingEdit,
      revertedNote,
      getPrecedingCheckpoint: handleGetPrecedingCheckpoint,
      composerProps: messageEditComposerProps,
    }),
    [
      handleEditMessage,
      handleRetryFromMessage,
      countMessagesAfter,
      isStreaming,
      stopStreamingAndWait,
      editingMessageId,
      inlineEditDirty,
      canEditMessage,
      pendingEdit,
      revertedNote,
      handleGetPrecedingCheckpoint,
      messageEditComposerProps,
    ],
  )

  // Same optimistic-id guard as `canEditMessage` above — a message that
  // hasn't round-tripped to the server yet has no row for
  // `MessageFeedback`/`fork` to act on.
  const canActOnTurnMessage = useCallback((messageId: string) => {
    if (!messageId) return false
    if (messageId.startsWith("temp-")) return false
    if (messageId.startsWith("optimistic-")) return false
    return true
  }, [])

  const handleSetFeedback = useCallback(
    async (messageId: string, thumbs: MessageFeedbackThumbs) => {
      if (!sessionMessages) return
      const previous = feedbackMap[messageId]
      setFeedbackMap((prev) => ({ ...prev, [messageId]: thumbs }))
      if (currentSessionId) {
        patchSessionFeedbackCache(currentSessionId, messageId, thumbs)
      }
      try {
        await setMessageFeedback(sessionMessages, messageId, thumbs)
      } catch (err) {
        console.error("[ChatPanel] Failed to set message feedback:", err)
        setFeedbackMap((prev) => {
          const next = { ...prev }
          if (previous) next[messageId] = previous
          else delete next[messageId]
          return next
        })
        if (currentSessionId) {
          patchSessionFeedbackCache(currentSessionId, messageId, previous ?? null)
        }
        throw err
      }
    },
    [sessionMessages, feedbackMap, currentSessionId],
  )

  const handleClearFeedback = useCallback(
    async (messageId: string) => {
      if (!sessionMessages) return
      const previous = feedbackMap[messageId]
      setFeedbackMap((prev) => {
        const next = { ...prev }
        delete next[messageId]
        return next
      })
      if (currentSessionId) {
        patchSessionFeedbackCache(currentSessionId, messageId, null)
      }
      try {
        await clearMessageFeedback(sessionMessages, messageId)
      } catch (err) {
        console.error("[ChatPanel] Failed to clear message feedback:", err)
        if (previous) {
          setFeedbackMap((prev) => ({ ...prev, [messageId]: previous }))
          if (currentSessionId) {
            patchSessionFeedbackCache(currentSessionId, messageId, previous)
          }
        }
        throw err
      }
    },
    [sessionMessages, feedbackMap, currentSessionId],
  )

  // Fork the current session at `messageId` into a brand-new session, then
  // hand control to the parent (`onChatSessionChange`, e.g. the project
  // layout's tab state) and broadcast on `chatSessionEvents` so the
  // sidebar's chat list refreshes to include the new chat and any other
  // mounted listener (cross-tab, IDE embed) highlights it as active. See
  // `handleCreateNewSession` in the project layout for the same
  // emit-after-create pattern this mirrors.
  const handleForkFromMessage = useCallback(
    async (messageId: string) => {
      if (!currentSessionId) return
      const result = await forkChatSession(
        studioChat.chatSessionCollection,
        currentSessionId,
        messageId,
      )
      if (projectId) {
        chatSessionEvents.emit({
          projectId,
          activeSessionId: result.sessionId,
          refresh: true,
        })
      }
      onChatSessionChange?.(result.sessionId)
    },
    [currentSessionId, studioChat, projectId, onChatSessionChange],
  )

  const turnFooterValue = useMemo(
    () => ({
      feedback: feedbackMap,
      setFeedback: handleSetFeedback,
      clearFeedback: handleClearFeedback,
      forkFromMessage: handleForkFromMessage,
      canActOnMessage: canActOnTurnMessage,
    }),
    [
      feedbackMap,
      handleSetFeedback,
      handleClearFeedback,
      handleForkFromMessage,
      canActOnTurnMessage,
    ],
  )

  // Project-less workspace chats (the free personal-companion chat has no
  // Project row at all) fall back to the workspace-scoped agent-proxy
  // instead — `/api/projects/:id/agent-proxy` requires a projectId that
  // doesn't exist here. Without this, GenerateImageWidget/etc. built a
  // `null` agentUrl for personal companions and every generated image
  // silently failed to render (only the "Image generated" placeholder
  // showed, never the actual picture — see workspace-chat.ts's matching
  // `/workspaces/:workspaceId/agent-proxy/*` route).
  const resolvedAgentUrl = agentBaseUrl

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
        if (isActivePanelRef.current) {
          planStream?.setSummaryStatus("pending")
        }
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
          if (isActivePanelRef.current) {
            planStream?.setStreamingPlan(readyNext)
          }
        }
        if (isActivePanelRef.current) {
          planStream?.setStreamingSummary(summary)
          planStream?.setSummaryStatus("ready")
        }
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
        if (isActivePanelRef.current) {
          planStream?.setSummaryStatus("error")
        }
        throw err
      }
    },
    [resolvedAgentUrl, planStream],
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
              if (p.type === "dynamic-tool" && p.toolCallId === toolCallId) {
                return { ...p, output, state: "output-available" }
              }
              return p
            }),
          }
        }),
      )

      const dbMsg = sessionMessages?.all.find((m: any) => m.id === messageId)
      if (dbMsg?.parts && sessionMessages) {
        try {
          const parsed = JSON.parse(dbMsg.parts)
          const updated = parsed.map((p: any) => {
            if (p.type === "dynamic-tool" && p.toolCallId === toolCallId) {
              return { ...p, output, state: "output-available" }
            }
            return p
          })
          sessionMessages
            .update(messageId, { parts: JSON.stringify(updated) })
            .catch((err: any) =>
              console.error(
                "[ChatPanel] Failed to persist ask_user output:",
                err,
              ),
            )
        } catch (err) {
          console.error(
            "[ChatPanel] Failed to parse parts for ask_user persist:",
            err,
          )
        }
      }
    },
    [setMessages, sessionMessages],
  )

  // Submit handler for the input-attached question widget. Mirrors the
  // inline ask_user handler: send the formatted response as a user message
  // and persist the tool output so the part flips to answered (which also
  // clears `pendingQuestion`, unmounting the attached widget).
  const handleSubmitQuestionResponse = useCallback(
    (response: string) => {
      if (!pendingQuestion) return
      handleSendMessage(
        buildAskUserAnswerMessage(pendingQuestion.tool.id, response),
      )
      handleSaveToolOutput({
        messageId: pendingQuestion.messageId,
        toolCallId: pendingQuestion.tool.id,
        output: response,
      })
    },
    [pendingQuestion, handleSendMessage, handleSaveToolOutput],
  )

  const respondToPermission = useCallback(
    async (response: {
      id: string
      decision: "allow_once" | "always_allow" | "deny"
      pattern?: string
    }) => {
      setPendingPermissionRequest(null)
      try {
        if (projectId) {
          const http = workspaceHttp()
          await api.sendPermissionResponse(http, projectId, response)
        }
      } catch (err) {
        console.error(
          "[ChatPanel] Failed to send permission response:",
          err,
        )
      }
    },
    [projectId],
  )

  const islandPending = useMemo<IslandPendingRequest | undefined>(() => {
    const rawQuestionArgs =
      (pendingQuestion?.tool.args as Record<string, unknown> | undefined) ?? {}
    const questions = Array.isArray(rawQuestionArgs.questions)
      ? rawQuestionArgs.questions
      : []
    const firstQuestion =
      questions[0] && typeof questions[0] === "object"
        ? (questions[0] as Record<string, unknown>)
        : null
    const questionOptions = Array.isArray(firstQuestion?.options)
      ? firstQuestion.options
          .filter(
            (option): option is Record<string, unknown> =>
              !!option && typeof option === "object",
          )
          .map((option) => ({
            label: typeof option.label === "string" ? option.label : "",
            description:
              typeof option.description === "string"
                ? option.description
                : undefined,
          }))
          .filter((option) => option.label.length > 0)
      : []

    if (pendingPermissionRequest) {
      return {
        kind: "permission",
        request: pendingPermissionRequest,
      }
    }
    if (!pendingQuestion) return undefined
    return {
      kind: "question",
      request: {
        id: pendingQuestion.tool.id,
        prompt:
          typeof firstQuestion?.question === "string"
            ? firstQuestion.question
            : "Shogo needs your answer",
        options: questionOptions,
        // The island submits a bare option label, which only matches the
        // widget's response format for one single-select question.
        answerInApp:
          questions.length !== 1 ||
          firstQuestion?.multiSelect === true ||
          questionOptions.length === 0,
      },
    }
  }, [pendingPermissionRequest, pendingQuestion])

  const islandReplyPreview = useMemo(() => {
    for (let index = messages.length - 1; index >= 0; index--) {
      const message = messages[index]
      if (message.role !== "assistant") continue
      return message.parts
        .map((part) => (part.type === "text" ? part.text : ""))
        .join("")
    }
    return ""
  }, [messages])

  // `pendingPlan` changes identity on every streamed token; the island only
  // needs the settled plan.
  const islandPlan = useMemo(() => {
    if (isStreaming || !pendingPlan) return undefined
    return {
      name: pendingPlan.name,
      overview: pendingPlan.overview,
      plan: pendingPlan.plan,
      todos: pendingPlan.todos ?? [],
      ...(pendingPlan.filepath ? { filepath: pendingPlan.filepath } : {}),
      ...(pendingPlan.toolCallId ? { toolCallId: pendingPlan.toolCallId } : {}),
    }
  }, [isStreaming, pendingPlan])

  const islandState = useMemo<DesktopIslandSessionState>(
    () => ({
      projectName: featureName ?? "Project",
      title:
        currentSession?.name ||
        currentSession?.inferredName ||
        featureName ||
        "Untitled chat",
      status: isStreaming ? "running" : "idle",
      replyPreview: islandReplyPreview,
      pending: islandPending,
      pendingPlan: islandPlan,
      focused: isActivePanel,
    }),
    [
      currentSession?.name,
      currentSession?.inferredName,
      featureName,
      isStreaming,
      islandReplyPreview,
      islandPending,
      islandPlan,
      isActivePanel,
    ],
  )
  const islandStateRef = useRef(islandState)
  islandStateRef.current = islandState

  const islandSendRef = useRef<
    (text: string, files?: FileAttachment[]) => void | Promise<void>
  >(() => {})
  const islandPermissionRef = useRef<
    (
      requestId: string,
      decision: "allow_once" | "always_allow" | "deny",
      pattern?: string,
    ) => void | Promise<void>
  >(() => {})
  const islandQuestionRef = useRef<
    (requestId: string, response: string) => void | Promise<void>
  >(() => {})
  const islandStopRef = useRef<() => void>(() => {})
  const islandBuildPlanRef = useRef<(modelId?: string) => void>(() => {})
  const islandPlanFeedbackRef = useRef<(text: string) => void>(() => {})
  islandStopRef.current = handleStop
  islandBuildPlanRef.current = (modelId) => {
    if (pendingPlanRef.current) handleConfirmPlan(pendingPlanRef.current, modelId)
  }
  islandPlanFeedbackRef.current = (text) => {
    handleSendMessage(text)
  }
  islandSendRef.current = (text, files) => handleSendMessage(text, files)
  islandPermissionRef.current = (requestId, decision, pattern) =>
    respondToPermission({ id: requestId, decision, pattern })
  islandQuestionRef.current = (requestId, response) => {
    if (requestId === pendingQuestion?.tool.id) {
      handleSubmitQuestionResponse(response)
    }
  }

  // Register this chat with the desktop island. The registration is a no-op
  // on web/mobile, but on Electron it lets the overlay reuse the exact same
  // send, permission and ask-user paths as the in-window composer. Workspace
  // agent chats have no project, so they register under the agent's id.
  const islandProjectId =
    projectId ?? (chatScope === "workspace" && workspaceId ? DESKTOP_ISLAND_WORKSPACE_AGENT_ID : undefined)
  useEffect(() => {
    if (!islandProjectId || !currentSessionId) return
    return registerDesktopIslandSession({
      sessionId: currentSessionId,
      projectId: islandProjectId,
      ...islandStateRef.current,
      sendMessage: (text, files) => islandSendRef.current(text, files),
      respondPermission: (requestId, decision, pattern) =>
        islandPermissionRef.current(requestId, decision, pattern),
      respondQuestion: (requestId, response) =>
        islandQuestionRef.current(requestId, response),
      stop: () => islandStopRef.current(),
      buildPlan: (modelId) => islandBuildPlanRef.current(modelId),
      sendPlanFeedback: (text) => islandPlanFeedbackRef.current(text),
    })
  }, [currentSessionId, islandProjectId])

  // Streaming ticks and activity transitions update the existing
  // registration instead of re-registering the session.
  useEffect(() => {
    if (!islandProjectId || !currentSessionId) return
    updateDesktopIslandSession(islandProjectId, currentSessionId, islandState)
  }, [currentSessionId, islandProjectId, islandState])

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
  const nativePhoneColumnWidth = isPhoneViewport
    ? Math.max(0, windowWidth)
    : undefined

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
  const openPendingQuestion = useCallback(() => {
    if (questionPresentation === "sheet") setQuestionSheetOpen(true)
    jumpToLatest()
  }, [jumpToLatest, questionPresentation])

  const openFile = useCallback(
    (path: string) => {
      if (onOpenFilePath) {
        const raw = normalizeWorkspaceMediaPath(path)
        if (raw) onOpenFilePath(raw)
        return
      }
      const resolved = resolveChatFilePath(
        path,
        projectId ?? focusedProjectId ?? null,
      )
      if (!resolved?.projectId || !resolved.relPath) return
      if (onOpenFile) {
        onOpenFile(resolved.projectId, resolved.relPath)
        return
      }
      router.push({
        pathname: "/(app)/projects/[id]",
        params: {
          id: resolved.projectId,
          tab: Platform.OS === "web" ? "ide" : "files",
          file: resolved.relPath,
          tabNonce: String(Date.now()),
          ...(chatSessionId ? { chatSessionId, chatScope } : {}),
        },
      } as any)
    },
    [chatScope, chatSessionId, focusedProjectId, onOpenFile, onOpenFilePath, projectId, router],
  )
  const fileExists = useChatFileIndex(
    resolvedAgentUrl,
    projectId ?? focusedProjectId ?? null,
    isStreaming,
    { projectAgentUrl },
  )

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
      focusPendingQuestion: openPendingQuestion,
      buildPlan: pendingPlan ? handleConfirmPlan : null,
      confirmPlan: pendingPlan ? handleConfirmPlan : null,
      pendingPlan,
      confirmedPlan,
      openPlan: onOpenPlan,
      openFile,
      fileExists,
      resolveProjectRef,
      workspaceId: workspaceId ?? null,
      openProjectPane: onOpenProjectPane,
      openTaskThread,
      generateSummary: handleGenerateSummary,
      selectedModel,
      isPro: hasAdvancedModelAccess,
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
      openPendingQuestion,
      pendingPlan,
      handleConfirmPlan,
      confirmedPlan,
      onOpenPlan,
      openFile,
      fileExists,
      resolveProjectRef,
      workspaceId,
      onOpenProjectPane,
      openTaskThread,
      handleGenerateSummary,
      selectedModel,
      hasAdvancedModelAccess,
    ],
  )

  const handleQuickActionClick = useCallback(
    (prompt: string) => handleSendMessage(prompt),
    [handleSendMessage],
  )

  // Re-render when the dock's registered panels / expand state / measured
  // height change so `dockHeight` (used to pad the message list) and the
  // dock-height-dependent JSX below stay current.
  useSyncExternalStore(
    chatDockStore.subscribe,
    chatDockStore.getVersion,
    chatDockStore.getVersion,
  )
  const dockHeight = chatDockStore.getHeight()
  // Measured height of the scrollable message area, used to cap the dock's
  // status zone at ~45% of the space actually available above the composer.
  const [messagesAreaHeight, setMessagesAreaHeight] = useState(0)

  // ---------------------------------------------------------------------
  // Chat dock: blocking panels (permission approval / pending question /
  // connectivity wait) and status banners (tool error / general error).
  // These stay inline here — rather than as separate dock/panels files —
  // since they're tightly coupled to ChatPanel's own countdown, retry, and
  // dismiss state. The countdown/auto-deny inside `PermissionApprovalDialog`
  // and the auto-hide timers below are untouched; only *where* they render
  // (a dock panel instead of a fixed slot above the composer) changed.
  //
  // Every `useDockPanel` call below passes `chatDockStore` explicitly (see
  // `useDockPanel`'s doc comment): this component can't see its own
  // `<ChatDockStoreContext.Provider value={chatDockStore}>` further down in
  // its own returned JSX via `useContext` — only descendants can. Omitting
  // the override silently registers against the shared fallback store
  // instead, which `<ChatDock>` never reads from, so the panel never
  // actually appears above the composer.
  // ---------------------------------------------------------------------

  const permissionDockDescriptor = useMemo<DockPanelDescriptor | null>(() => {
    if (!pendingPermissionRequest) return null
    return {
      id: "permission",
      kind: "blocking",
      order: 0,
      title: "Permission required",
      icon: Shield,
      render: () => (
        <PermissionApprovalDialog
          request={pendingPermissionRequest}
          onRespond={respondToPermission}
        />
      ),
    }
  }, [pendingPermissionRequest, respondToPermission])
  useDockPanel(permissionDockDescriptor, chatDockStore)

  const integrationAuthDockDescriptor = useMemo<DockPanelDescriptor | null>(() => {
    if (!pendingIntegrationAuth) return null
    return {
      id: `integration-auth:${pendingIntegrationAuth.provider}`,
      kind: "blocking",
      order: 0,
      title: "Connect your account",
      icon: KeyRound,
      onDismiss: () => setPendingIntegrationAuth(null),
      render: () => (
        <IntegrationConnectCard
          request={pendingIntegrationAuth}
          onContinue={(label) => {
            setPendingIntegrationAuth(null)
            void sendMessageInternal(`I connected ${label}. Please go ahead.`)
          }}
        />
      ),
    }
  }, [pendingIntegrationAuth, sendMessageInternal])
  useDockPanel(integrationAuthDockDescriptor, chatDockStore)

  const questionDockDescriptor = useMemo<DockPanelDescriptor | null>(() => {
    if (!pendingQuestion) return null
    if (questionPresentation === "sheet") return null
    return {
      id: "question",
      kind: "blocking",
      collapsible: true,
      defaultExpanded: true,
      order: 1,
      title: "Question",
      icon: MessageCircleQuestion,
      render: ({ bodyMaxHeight }) => (
        <AskUserQuestionWidget
          tool={pendingQuestion.tool}
          onSubmitResponse={(response) =>
            handleSubmitQuestionResponse(response)
          }
          embedded
          bodyMaxHeight={bodyMaxHeight}
        />
      ),
    }
  }, [handleSubmitQuestionResponse, pendingQuestion, questionPresentation])
  useDockPanel(questionDockDescriptor, chatDockStore)

  const connectivityDockDescriptor = useMemo<DockPanelDescriptor | null>(() => {
    if (!((connectivityWait || justReconnected) && !errorDismissed)) return null
    const providerWait = !justReconnected && connectivityWait?.cause === "provider"
    const elapsedSuffix = connectivityWaitElapsedLabel
      ? ` (${connectivityWaitElapsedLabel})`
      : ""
    return {
      id: "connectivity",
      kind: "blocking",
      order: 2,
      title: justReconnected
        ? "Back online"
        : providerWait
          ? "Retrying model request"
          : "Waiting for connection",
      icon: providerWait || justReconnected ? RefreshCw : WifiOff,
      accent: "warning",
      headerActions: !justReconnected ? (
        <Pressable
          onPress={handleStop}
          accessibilityRole="button"
          accessibilityLabel={
            providerWait
              ? "Cancel and stop retrying the model request"
              : "Cancel and stop waiting for connection"
          }
          className="shrink-0 rounded-md border border-orange-400/30 px-2 py-1"
        >
          <Text className="text-xs font-medium text-orange-700 dark:text-orange-300">
            Cancel
          </Text>
        </Pressable>
      ) : undefined,
      render: () => (
        <View className="flex-row items-start gap-1.5">
          {justReconnected || providerWait ? (
            <RefreshCw
              size={14}
              className="h-3.5 w-3.5 shrink-0 mt-0.5 text-orange-600 dark:text-orange-400"
            />
          ) : (
            <WifiOff
              size={14}
              className="h-3.5 w-3.5 shrink-0 mt-0.5 text-orange-600 dark:text-orange-400"
            />
          )}
          <Text className="flex-1 text-xs text-orange-700 dark:text-orange-300">
            {justReconnected
              ? "Back online — resuming\u2026"
              : providerWait
                ? `${
                    connectivityWait?.reason === "overloaded"
                      ? "The model is overloaded right now."
                      : "The model provider isn't responding."
                  } Retrying automatically${elapsedSuffix}\u2026`
                : `No internet connection. Waiting to resume${elapsedSuffix}\u2026`}
          </Text>
        </View>
      ),
    }
  }, [
    connectivityWait,
    justReconnected,
    errorDismissed,
    connectivityWaitElapsedLabel,
    handleStop,
  ])
  useDockPanel(connectivityDockDescriptor, chatDockStore)

  const usageLimitDockDescriptor = useMemo<DockPanelDescriptor | null>(() => {
    if (!usageLimitView) return null
    const blocked = usageLimitView.variant === "blocked"
    return {
      id: "usage-limit",
      kind: "status",
      order: 3,
      title: usageLimitView.title,
      icon: AlertCircle,
      accent: "warning",
      defaultExpanded: true,
      onDismiss: () =>
        blocked ? setErrorDismissed(true) : setUsageLimitNotice(null),
      headerActions: (
        <View className="flex-row gap-1.5">
          <Pressable
            onPress={
              usageLimitView.primaryLabel === "Start free trial"
                ? handleStartTrialClick
                : handleUpgradeClick
            }
            accessibilityRole="button"
            accessibilityLabel={
              usageLimitView.primaryLabel === "Start free trial"
                ? "Start the 7-day free Business trial"
                : usageLimitView.primaryLabel === "Upgrade"
                  ? "Upgrade plan"
                  : "Open billing settings"
            }
            className="shrink-0 rounded-md border border-orange-400/30 px-2 py-1"
          >
            <Text className="text-xs font-medium text-orange-700 dark:text-orange-300">
              {usageLimitView.primaryLabel}
            </Text>
          </Pressable>
          <Pressable
            onPress={() => {
              if (blocked) {
                handleRetry()
                return
              }
              setUsageLimitNotice(null)
              void handleSendMessage("continue")
            }}
            accessibilityRole="button"
            accessibilityLabel={
              blocked ? "Retry sending the message" : "Continue the task"
            }
            className="shrink-0 rounded-md bg-orange-500/15 px-2 py-1"
          >
            <Text className="text-xs font-medium text-orange-700 dark:text-orange-300">
              {usageLimitView.secondaryLabel}
            </Text>
          </Pressable>
        </View>
      ),
      render: () => (
        <Text className="text-xs text-orange-700 dark:text-orange-300">
          {usageLimitView.body}
        </Text>
      ),
    }
  }, [usageLimitView, handleUpgradeClick, handleStartTrialClick, handleSendMessage, handleRetry])
  useDockPanel(usageLimitDockDescriptor, chatDockStore)

  const toolErrorDockDescriptor = useMemo<DockPanelDescriptor | null>(() => {
    if (!toolErrorBanner) return null
    return {
      id: "tool-error",
      kind: "status",
      order: 15,
      title: toolErrorBanner.isAuthError
        ? `${toolErrorBanner.toolkitName} connection expired`
        : `${toolErrorBanner.toolkitName} error`,
      icon: AlertCircle,
      accent: "warning",
      defaultExpanded: true,
      onDismiss: () => setToolErrorBanner(null),
      headerActions:
        toolErrorBanner.isAuthError && projectId ? (
          <Pressable
            onPress={async () => {
              const toolkit = toolErrorBanner.toolkitName.toLowerCase()
              setReconnecting(true)
              const preWindow =
                Platform.OS === "web" ? preCreateAuthWindow() : null
              console.info("[ChatPanel] Reconnecting", toolkit)
              try {
                const http = createHttpClient()
                const isNativePlatform = Platform.OS !== "web"
                let redirect: string | undefined
                if (isNativePlatform) {
                  redirect = ExpoLinking.createURL("integrations-callback")
                } else {
                  const returnUrl = new URL(window.location.href)
                  returnUrl.searchParams.set("fromOAuth", "1")
                  redirect = returnUrl.toString()
                }
                const callbackUrl = redirect
                  ? `${API_URL}/api/integrations/callback?redirect=${encodeURIComponent(
                      redirect,
                    )}`
                  : `${API_URL}/api/integrations/callback`
                const data = await api.connectIntegration(
                  http,
                  toolkit,
                  projectId,
                  callbackUrl,
                )
                const redirectUrl = data.data?.redirectUrl
                if (redirectUrl) {
                  await openAuthFlow(redirectUrl, {
                    preCreatedWindow: preWindow,
                  })
                  setToolErrorBanner(null)
                }
              } catch (err) {
                console.error("[ChatPanel] Reconnect error:", err)
              } finally {
                setReconnecting(false)
                try {
                  if (preWindow && !preWindow.closed) {
                    const loc = preWindow.location.href
                    if (loc === "about:blank" || loc === "") preWindow.close()
                  }
                } catch {
                  /* COOP */
                }
              }
            }}
            disabled={reconnecting}
            className={cn(
              "flex-row items-center gap-1.5 rounded-md border border-orange-400/50 bg-orange-100 dark:bg-orange-800/30 px-1.5 py-1 active:opacity-70",
              reconnecting && "opacity-50",
            )}
          >
            {reconnecting ? (
              <ActivityIndicator size="small" />
            ) : (
              <RefreshCw
                size={12}
                className="text-orange-700 dark:text-orange-300"
              />
            )}
            <Text className="text-xs font-medium text-orange-700 dark:text-orange-300">
              Reconnect
            </Text>
          </Pressable>
        ) : undefined,
      render: () => (
        <Text className="text-xs text-muted-foreground">
          {toolErrorBanner.error}
        </Text>
      ),
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toolErrorBanner, projectId, reconnecting])
  useDockPanel(toolErrorDockDescriptor, chatDockStore)

  const errorDockDescriptor = useMemo<DockPanelDescriptor | null>(() => {
    if (usageLimitView?.variant === "blocked") return null
    if (!(
      ((error || emptyResponseError) && !errorDismissed) ||
      streamAutoRecovering
    ))
      return null
    return {
      id: "error",
      kind: "status",
      order: 16,
      title: isTunnelError ? "Connection lost" : "Error",
      icon: AlertCircle,
      accent: "warning",
      defaultExpanded: true,
      onDismiss: () => {
        setEmptyResponseError(null)
        setErrorDismissed(true)
      },
      headerActions:
        tunnelReconnecting || streamAutoRecovering ? (
          <Text
            className={cn(
              "text-xs font-medium",
              isTunnelError
                ? "text-orange-600 dark:text-orange-400"
                : "text-destructive",
            )}
          >
            Reconnecting…
          </Text>
        ) : (
          <View className="flex-row items-center gap-1">
            {isTunnelError && (
              <Pressable
                onPress={() => {
                  clearActiveInstance()
                  setTimeout(() => handleRetry(), 0)
                }}
                accessibilityRole="button"
                accessibilityLabel="Continue this conversation in the cloud sandbox"
                className="rounded-md border border-orange-400/30 px-2 py-1"
              >
                <Text className="text-xs font-medium text-orange-700 dark:text-orange-300">
                  Continue in cloud
                </Text>
              </Pressable>
            )}
            <Pressable
              onPress={handleRetry}
              className={cn(
                "rounded-md border px-2 py-1",
                isTunnelError
                  ? "border-orange-400/30"
                  : "border-destructive/30",
              )}
            >
              <Text
                className={cn(
                  "text-xs font-medium",
                  isTunnelError
                    ? "text-orange-600 dark:text-orange-400"
                    : "text-destructive",
                )}
              >
                {isTunnelError ? "Reconnect" : "Retry"}
              </Text>
            </Pressable>
          </View>
        ),
      render: () => (
        <View>
          {errorBannerExpanded ? (
            <ScrollView
              nestedScrollEnabled
              className="max-h-40"
              showsVerticalScrollIndicator
            >
              <Text
                className={cn(
                  "text-xs",
                  isTunnelError
                    ? "text-orange-700 dark:text-orange-300"
                    : "text-destructive",
                )}
                selectable
                testID="chat-error-banner"
              >
                {errorBannerText}
              </Text>
            </ScrollView>
          ) : (
            <Text
              className={cn(
                "text-xs",
                isTunnelError
                  ? "text-orange-700 dark:text-orange-300"
                  : "text-destructive",
              )}
              numberOfLines={2}
              selectable
              testID="chat-error-banner"
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
                errorBannerExpanded
                  ? "Show less error detail"
                  : "Read full error message"
              }
            >
              <Text
                className={cn(
                  "text-[11px] font-semibold",
                  isTunnelError
                    ? "text-orange-700 dark:text-orange-300"
                    : "text-destructive",
                )}
              >
                {errorBannerExpanded ? "Show less" : "Read more"}
              </Text>
            </Pressable>
          )}
        </View>
      ),
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    error,
    emptyResponseError,
    errorDismissed,
    streamAutoRecovering,
    isTunnelError,
    tunnelReconnecting,
    errorBannerExpanded,
    errorBannerText,
    errorBannerNeedsReadMore,
    handleRetry,
    clearActiveInstance,
    usageLimitView,
  ])
  useDockPanel(errorDockDescriptor, chatDockStore)

  // Render collapsed state
  if (isCollapsed) {
    return (
      <View
        className={cn("flex-row flex-1", className)}
        style={{ flex: 1, minHeight: 0 }}
      >
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

  const ChatSurface = isNativePhoneLayout ? View : KeyboardAvoidingView

  return (
    <TodoStateStoreContext.Provider value={todoStateStore}>
      <FileChangeStoreContext.Provider value={fileChangeStore}>
        <ChatContextProvider value={contextValue}>
          {/* In-place message edit (SHO-263) has no modal host any more: the
          revert/keep choice lives inline in the editor footer. */}
          {/* Dock panels that don't need a fixed spot in the JSX tree — each
          is a no-render component that registers itself with
          `chatDockStore` (see chat-dock-store.ts) and unregisters when its
          data disappears. */}
          <PlanDockPanel
            pendingPlan={pendingPlan}
            confirmedPlan={confirmedPlan}
            onBuild={pendingPlan ? handleConfirmPlan : null}
            onOpenPlan={onOpenPlan}
            selectedModel={selectedModel}
            isPro={hasAdvancedModelAccess}
          />
          <ChecklistDockPanel />
          <RunningDockPanel
            processes={runningProcesses}
            onKillProcess={handleKillProcess}
            killingProcesses={killingProcesses}
            subagents={activeSubagentsList}
            recentTools={recentToolsList}
            waiting={taskWait}
            agentIdle={!isStreaming}
            loadOutput={loadTaskOutput}
            onOpenTask={(proc) =>
              void openTaskThread(proc.id ?? proc.runId, {
                title: proc.title ?? proc.command,
                source: proc.source,
                status: proc.status,
                outputFile: proc.outputFile,
                link: proc.link,
              })
            }
          />
          <BrowserDockPanel />
          <WorktreeDockPanel
            agentUrl={resolvedAgentUrl}
            chatSessionId={currentSessionId}
            isStreaming={isStreaming}
            onSendMessage={(text) => handleInputSubmit(text)}
          />
          <ChangesDockPanel />
          <View
            ref={surfaceRef}
            onLayout={measureSurfaceBottom ? measureSurface : undefined}
            className={cn(
              isNativePhoneLayout ? "flex-col flex-1" : "flex-row flex-1",
              presentation === "agent" && "agent-chat-surface",
              className,
            )}
            style={{ flex: 1, minHeight: 0 }}
          >
            {/* Main content area */}
            {children && (
              <View className="flex-1 min-w-0 overflow-hidden">{children}</View>
            )}

            {/* Chat Panel — full width on mobile (no resize handle) */}
            <ChatSurface
              behavior={Platform.OS === "ios" ? "padding" : "height"}
              className={cn(
                "flex-1 flex-col bg-background",
                presentation === "agent" && "bg-transparent",
              )}
              style={{ flex: 1, minHeight: 0 }}
              keyboardVerticalOffset={
                isNativePhoneLayout ? 0 : Platform.OS === "ios" ? 90 : 50
              }
            >
              {/* Messages with Turn Grouping */}
              <View
                className="flex-1"
                onLayout={(e) => {
                  const next = Math.round(e.nativeEvent.layout.height)
                  setMessagesAreaHeight((prev) => (prev === next ? prev : next))
                }}
              >
                <ScrollView
                  ref={scrollViewRef}
                  className="flex-1"
                  style={chatMessagesScrollStyles.scroll}
                  // Vertical padding only: width and side gutters come from
                  // the shared chat column (`chatColumnStyle`), the same
                  // source the header, dock and composer use.
                  contentContainerClassName={
                    isPhoneViewport
                      ? phoneTranscriptTopPadding === "floating-agent"
                        ? "pt-32 pb-36"
                        : "pt-16 pb-36"
                      : presentation === "agent"
                        ? "pt-8 pb-[48px]"
                        : "pt-2 pb-[40px]"
                  }
                  contentContainerStyle={chatColumnStyle({
                    presentation,
                    phone: isPhoneViewport,
                    measuredWidth: nativePhoneColumnWidth,
                  })}
                  keyboardShouldPersistTaps={
                    isNative && nativeInlineEditing ? "always" : "handled"
                  }
                  // Dragging the transcript closes the keyboard. `on-drag`, not
                  // `interactive`: the composer rides the keyboard's own show
                  // and hide animation, and iOS reports no frames while a
                  // finger drags the keyboard, so the composer would sit still
                  // and then jump. Bouncing even when the chat is short lets an
                  // empty or one-message chat be dragged too.
                  // Web opts out: react-native-web dismisses on every scroll
                  // event, including the auto-follow scroll of a streaming
                  // turn, which blurred the composer out from under the user
                  // (SHO-255).
                  keyboardDismissMode={transcriptKeyboardDismissMode()}
                  // The scroll view insets itself by however far the keyboard
                  // covers it, natively and in step with the keyboard, so the
                  // last message stays above the lifted composer.
                  automaticallyAdjustKeyboardInsets={liftComposerWithKeyboard}
                  alwaysBounceVertical={Platform.OS === "ios"}
                  onTouchStart={(e) => {
                    if (Platform.OS === "web") return
                    const { pageX, pageY } = e.nativeEvent
                    nativeEditTapStartRef.current = { x: pageX, y: pageY }
                  }}
                  onTouchEnd={(e) => {
                    if (Platform.OS === "web") return
                    const start = nativeEditTapStartRef.current
                    nativeEditTapStartRef.current = null
                    if (!start) return
                    const { pageX, pageY } = e.nativeEvent
                    if (Math.hypot(pageX - start.x, pageY - start.y) > 12)
                      return
                    dispatchNativeInlineEditTap(pageX, pageY)
                  }}
                  onTouchCancel={() => {
                    nativeEditTapStartRef.current = null
                  }}
                  onScroll={isNative ? undefined : handleMessagesScrollWeb}
                  onScrollBeginDrag={() => {
                    if (isNative) {
                      nativeEditTapStartRef.current = null
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
                    setHasScrollableTranscript(h > messagesAreaHeight + 1)
                    if (isLoadingOlderRef.current) {
                      const delta = h - contentHeightBeforeLoadRef.current
                      if (delta > 0 && contentHeightBeforeLoadRef.current > 0) {
                        markProgrammaticScroll()
                        scrollViewRef.current?.scrollTo({
                          y: delta,
                          animated: false,
                        })
                      }
                      // Reset after a frame so the scroll offset takes effect
                      // before onScroll can re-trigger loading
                      requestAnimationFrame(() => {
                        isLoadingOlderRef.current = false
                      })
                    } else if (
                      isNative &&
                      stickToBottomRef.current &&
                      contentHeightBeforeLoadRef.current > 0
                    ) {
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
                        <Text className="text-sm text-primary">
                          Load earlier messages
                        </Text>
                      )}
                    </Pressable>
                  )}
                  {displayMessages.length > 0 ? (
                    <MessageEditProvider
                      {...messageEditValue}
                      onInlineEditingChange={
                        Platform.OS === "web"
                          ? undefined
                          : setNativeInlineEditing
                      }
                    >
                      <TurnFooterProvider {...turnFooterValue}>
                        <TurnList
                          messages={displayMessages}
                          isStreaming={isStreaming}
                          phase={phase}
                          subagentToolCalls={accumulatedSubagentTools}
                        />
                      </TurnFooterProvider>
                    </MessageEditProvider>
                  ) : !isStreaming &&
                    !isInitialLoadComplete &&
                    currentSessionId ? (
                    <View className="flex-col items-center justify-center flex-1 gap-3">
                      <View className="flex-row items-center gap-1">
                        <View className="w-2 h-2 rounded-full bg-muted-foreground opacity-50" />
                        <View className="w-2 h-2 rounded-full bg-muted-foreground opacity-50" />
                        <View className="w-2 h-2 rounded-full bg-muted-foreground opacity-50" />
                      </View>
                      <Text className="text-xs text-muted-foreground">
                        Loading conversation...
                      </Text>
                    </View>
                  ) : !isStreaming ? (
                    <PhaseEmptyState
                      phase={phase}
                      presentation={presentation}
                      onSuggestionClick={handleSendMessage}
                      quickActions={quickActions}
                    />
                  ) : (
                    <View className="flex-row items-center gap-1 p-2">
                      <View className="w-2 h-2 rounded-full bg-muted-foreground opacity-50" />
                      <View className="w-2 h-2 rounded-full bg-muted-foreground opacity-50" />
                      <View className="w-2 h-2 rounded-full bg-muted-foreground opacity-50" />
                    </View>
                  )}

                  {/* Web overlay: ChatDock reports measured height so the
                transcript isn't covered. Native docks sit in the composer
                column and report 0, so this spacer stays unused. */}
                  {dockHeight > 0 && <View style={{ height: dockHeight }} />}
                </ScrollView>
                {presentation === "agent" &&
                phoneTranscriptTopPadding === "floating-agent" ? (
                  <LinearGradient
                    pointerEvents="none"
                    colors={
                      isDark
                        ? [
                            "rgba(16,16,16,0.76)",
                            "rgba(16,16,16,0.42)",
                            "rgba(16,16,16,0)",
                          ]
                        : [
                            "rgba(255,255,255,0.76)",
                            "rgba(255,255,255,0.42)",
                            "rgba(255,255,255,0)",
                          ]
                    }
                    locations={[0, 0.48, 1]}
                    style={{
                      position: "absolute",
                      top: 0,
                      left: 0,
                      right: 0,
                      height: 116,
                      zIndex: 5,
                    }}
                  />
                ) : null}

                {/* "Jump to latest" pill — shown when the user has scrolled away
              from the bottom during streaming. Re-engages follow on press.
              Positioned at the bottom of the scroll area (just above the
              chat input). */}
                {hasScrollableTranscript &&
                  !isFollowing &&
                  !nativeKeyboardOpen &&
                  displayMessages.length > 0 && (
                    <View
                      pointerEvents="box-none"
                      style={{
                        position: "absolute",
                        left: 0,
                        right: 0,
                        bottom: 8,
                      }}
                      className="items-center"
                    >
                      <Pressable
                        onPress={jumpToLatest}
                        accessibilityRole="button"
                        accessibilityLabel="Jump to latest message"
                        className="flex-row items-center gap-1 rounded-full bg-primary px-3 py-1.5 shadow-md active:opacity-80"
                      >
                        <ChevronDown
                          size={14}
                          className="text-primary-foreground"
                        />
                        <Text className="text-xs font-medium text-primary-foreground">
                          Latest
                        </Text>
                      </Pressable>
                    </View>
                  )}
              </View>

              {/* Input — hidden on native while a historical bubble is being
              edited so taps go to the transcript (cancel) instead of a
              second composer, matching ChatGPT. Web keeps both. */}
              {!(isNative && nativeInlineEditing) ? (
                <ProjectComposerDock
                  presentation={presentation}
                  columnWidth={nativePhoneColumnWidth}
                  keyboardPad={composerKeyboardPad}
                  keyboardLift={
                    liftComposerWithKeyboard ? composerKeyboardLift : undefined
                  }
                  keyboardOpen={nativeKeyboardOpen}
                  restPad={restComposerPad}
                  applyKeyboardPad={isPhoneViewport || isNativePhoneLayout}
                  native={isNative}
                  phoneViewport={isPhoneViewport}
                >
                  <ChatDock availableHeight={messagesAreaHeight} />
                  <PendingPlanComposerBar />
                  {questionPresentation === "sheet" && pendingQuestion ? (
                    <NativeAskUserQuestionSheet
                      visible={questionSheetOpen}
                      tool={pendingQuestion.tool}
                      onClose={() => setQuestionSheetOpen(false)}
                      onSubmitResponse={handleSubmitQuestionResponse}
                    />
                  ) : null}
                  <ExecutionBadge />
                  <ChatInput
                    onSubmit={handleInputSubmit}
                    uploadStatus={uploadStatus}
                    disabled={!currentSessionId || !!readOnlyReason || machineView.composeDisabled}
                    placeholder={
                      readOnlyReason ?? machineStop
                        ? (readOnlyReason ?? machineStop)!
                        : !featureId
                        ? "Message"
                        : hasPendingQuestion
                          ? questionPresentation === "sheet"
                            ? "Respond to the question, or type a message..."
                            : "Respond to the question below, or type a message..."
                          : "Ask Shogo..."
                    }
                    isStreaming={isStreaming}
                    onStop={handleStop}
                    selectedModel={selectedModel}
                    onModelChange={handleModelChange}
                    isPro={hasAdvancedModelAccess}
                    onUpgradeClick={handleUpgradeClick}
                    queuedMessages={displayedQueue}
                    onRemoveQueuedMessage={handleRemoveQueuedMessage}
                    onReorderQueuedMessage={handleReorderQueuedMessage}
                    onEditQueuedMessage={handleEditQueuedMessage}
                    onSendQueuedMessageNow={handleSendQueuedMessageNow}
                    onSendAgentWakeNow={handleSendAgentWakeNow}
                    onRemoveAgentWake={handleRemoveAgentWake}
                    onResumeTaskWakes={handleResumeTaskWakes}
                    contextUsage={contextUsage}
                    contextBreakdown={contextBreakdown}
                    quickActions={quickActions}
                    onQuickActionClick={handleQuickActionClick}
                    restoreDraftRequest={prefillRequest ?? restoreDraftRequest}
                    onDraftRestored={handleDraftRestored}
                    insertRequest={insertRequest}
                    onInsertApplied={handleInsertApplied}
                    composer={composer}
                    projectId={projectId}
                    projects={projectMentionOptions}
                    chatSessionId={currentSessionId}
                    chatWorkspaceId={chatWorkspaceId}
                    workspaceHistorySearch={workspaceHistorySearch}
                    chatMentionables={chatMentionables}
                    ideMode={ideMode}
                    ideContext={ideBridge.context}
                    ideFileSearch={ideBridge.listFiles}
                    onOpenIdeFile={ideBridge.openFile}
                    presentation={presentation}
                  />
                </ProjectComposerDock>
              ) : (
                <Pressable
                  onPress={() => dispatchNativeInlineEditTap(-1, -1)}
                  accessibilityLabel="Cancel editing"
                  style={
                    isPhoneViewport
                      ? {
                          paddingBottom: Math.max(
                            insets.bottom,
                            NATIVE_COMPOSER_KEYBOARD_GAP,
                          ),
                          minHeight: 28,
                        }
                      : { minHeight: 28 }
                  }
                />
              )}
            </ChatSurface>
          </View>
        </ChatContextProvider>
      </FileChangeStoreContext.Provider>
    </TodoStateStoreContext.Provider>
  )
})

export function ChatPanel(props: ChatPanelProps) {
  const chatDockStore = useMemo(() => createChatDockStore(), [])

  return (
    <ChatDockStoreContext.Provider value={chatDockStore}>
      <ChatPanelContent {...props} />
    </ChatDockStoreContext.Provider>
  )
}
