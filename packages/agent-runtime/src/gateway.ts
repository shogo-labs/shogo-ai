// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Agent Gateway
 *
 * The core runtime loop that makes an agent "alive." Manages:
 * - Heartbeat timer (periodic agent turns reading HEARTBEAT.md)
 * - Channel adapters (Telegram, Discord, etc.)
 * - Session management (per-channel message queuing with multi-turn history)
 * - Skill loading and trigger matching
 * - Memory persistence
 * - Hook event system
 * - Slash command handling
 * - BOOT.md startup execution
 * - Webhook event queue
 *
 * Uses Pi Agent Core for the agentic tool-call loop, supporting
 * multi-provider LLMs (Anthropic, OpenAI, Google, xAI, Groq, etc.).
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, rmSync } from 'fs'
import { join, dirname, resolve } from 'path'
import { fileURLToPath } from 'url'
import type { Message, ImageContent } from '@mariozechner/pi-ai'
import type { StreamFn, AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core'
import { Type } from '@sinclair/typebox'
import type { ChannelAdapter, IncomingMessage, AgentStatus, ChannelStatus, StreamChunkConfig, SandboxConfig } from './types'
import { loadAllSkills, migrateFromLegacySkills, matchSkill, buildSkillsPromptSection, buildSkillMatchPrompt, type Skill } from './skills'
import { loadQuickActions, buildQuickActionsPromptSection, type QuickAction } from './quick-actions'
import { SkillServerManager } from './skill-server-manager'
import { setLoadedSkills } from './gateway-tools'
import { TEAM_CHAT_GUIDE, teamChatToolsAvailable } from './channel-tools'
import { TRIGGERS_GUIDE, triggerToolsAvailable } from './trigger-tools'
import { runAgentLoop, classifyRetryability, RetryWaker, type LoopDetectorConfig, type PerCallUsage, type AgentLoopResult } from './agent-loop'
import { LONG_RETRY_MS, recordRetryEpisode, recordRetryLong, recordRetryNoProgress, recordRetryNow } from './retry-telemetry'
import { recordCompaction, recordTurnBoundary, isPrefixOf } from './context-telemetry'
import { summariseTurn, lastTurnStart } from './turn-boundary'
import { renderTranscriptForSummary } from './compaction-transcript'
import type { ToolContext } from './gateway-tools'
import { createTools, textResult, filterDisabledCapabilityTools, filterSubagentOnlyTools, subagentOrchestrationDisabled, expectedCoreToolsForAgentMode, createModeUnavailableTool, workspaceAgentToolsRegistered, type RestrictedMode } from './gateway-tools'
import { DEFAULT_CLOUD_SECURITY_PREFERENCE, PermissionEngine, parseSecurityPolicy } from './permission-engine'
import { buildExposedPortsPrompt } from './exposed-ports-prompt'
import { buildConcurrentChatsPrompt, concurrentChatLabel, type ConcurrentChat } from './concurrent-chats-prompt'
import { HookEmitter, loadAllHooks, workspaceHooksSignature } from './hooks'
import { parseSlashCommand, type SlashCommandContext } from './slash-commands'
import { SessionManager, type SessionManagerConfig, applyToolResultBudget, snipConsumedResults } from './session-manager'
import { microcompact } from './microcompact'
import {
  type ContentReplacementState,
  createContentReplacementState,
  resolveInLoopContextBudgetTokens,
  stableTransformContext,
} from './stable-compaction'
import { MIDTURN_KEEP_RECENT_MESSAGES, MidTurnAutocompactor } from './midturn-autocompact'
import { scrubInvalidImages } from './image-size-guard'
import {
  CACHE_BOUNDARY,
  fingerprintMessages,
  fingerprintSystem,
  fingerprintTools,
  formatPositions,
} from './prefix-fingerprint'
import { SqliteSessionPersistence } from './sqlite-session-persistence'
import { BlockChunker } from './block-chunker'
import { canvasModeStableGuides } from './canvas-v2-prompt'
import { buildCapabilityStatusSection, resolveCapabilitiesForScope, resolveRuntimeCapabilities } from './capability-status-prompt'
import { buildWakeStatusSection } from './wake-status-prompt'
import { BOARDS_GUIDE, COMPANY_OPS_GUIDE } from './board-tools'
import { TASK_WAKE_RETRY_MS } from './remote-tasks'
import { buildViewerContextPrompt, parseCanvasViewer } from './viewer-context'
import { buildAccountContextPrompt, sanitizeModelDisplayName, type AccountContext } from './account-context'
import { CanvasFileWatcher } from './canvas-file-watcher'
import { CanvasBuildManager } from './canvas-build-manager'
import { CanvasTypecheckGate } from './canvas-typecheck'
import {
  inferProviderFromModel as catalogInferProvider,
  resolveModelId,
  getContextWindowTokens,
  getModelEntry,
  AGENT_MODE_DEFAULTS,
  setAgentModeOverrides,
  isAutoModel,
  AUTO_MODEL_ID,
  parseDynamicModelsEnv,
  registerDynamicModels,
  rememberProviderHint,
} from '@shogo/model-catalog'
import {
  selectModelForSpawn,
  buildAutoTierMap,
  formatRoutingLog,
  autoTierIds,
  autoTierProviderHints,
  type SpawnClassificationInput,
  type AutoTierOverride,
} from './model-router'
import { buildCodeAgentGeneralGuide, OUTPUT_CONTRACT_GUIDE } from './code-agent-prompt'
import { isSearchEnabled } from './search-flag'
import { smartTruncateJson } from './response-transforms'
import { getShogoSdkGuide } from './shogo-sdk-prompt'
import { refreshAvailableModels, getAvailableModels } from './available-models'
import { mergeAgentModelIntoConfig, type AgentModelSnapshot } from './agent-model-config'
import { UI_UX_DESIGN_GUIDE } from './ui-ux-guide-prompt'
import { MCPClientManager, type MCPServerConfig, type RemoteMCPServerConfig } from './mcp-client'
import { WorkspaceLSPManager, resolveBin, WorktreeManager } from '@shogo/shared-runtime'
import type { MergeResult as WorktreeMergeResult, WorktreeStatus } from '@shogo/shared-runtime'
import {
  isForeignWorkspaceDir,
  isWorkspaceRuntimeMode,
  workspaceAttachedProjectIds,
  workspaceAvailableProjectsManifest,
  workspaceExternalProjectIds,
  workspaceProjectsManifest,
} from './workspace-runtime-mode'
import { initComposioSession, resetComposioSession, isComposioEnabled, isComposioInitialized } from './composio'
import { createIntegrationCredentialWrapper } from './integration-credentials'
import { deriveApiUrl, fetchReachableChats, fetchWorkspacePause, getInternalHeaders, getProjectConfig, getProjectToolUsage, getSessionWakeState, getWorkspaceConfig, hasInternalApiCredentials, notifyTaskCompletions, postCostMetric, projectScopedId, runtimeServesProjectId, type SessionWakeState, type WorkspaceAgentsPause } from './internal-api'
import {
  createToolProfile,
  deferredToolsEnabled,
  resolveLearnedToolOrder,
  withActivationOnCall,
  type ToolProfile,
} from './tool-profile'
import { mergeCapabilitySettingsIntoConfig, parseWorkspaceSettings } from '@shogo/shared-runtime/capability-settings'
import { getRuntimeTrust } from './runtime-trust'
import { refreshTrust } from './trust-resolver'
import type { FilePart } from './file-attachment-utils'
import { parseFileAttachments, transcribeAudioParts } from './file-attachment-utils'
import {
  SELF_EVOLUTION_GUIDE,
  BROWSER_TOOL_GUIDE,
} from './optimized-prompts'
import { resolveWorkspaceConfigFilePath } from './workspace-defaults'
import { defaultShellCwd, resolveRuntimeIdentity, workspaceKind } from './workspace-runtime-mode'
import { applyCapabilityProfile, CAPABILITY_PROFILES, type CapabilityProfileName } from './capability-profiles'
import { FileStateCache } from './file-state-cache'
import { buildMemorySection } from './memory-section'
import { SUBAGENT_GUIDE, WORKTREE_GUIDE } from './subagent-prompts'
import { BACKGROUND_TASKS_GUIDE } from './background-tasks-guide'
import { buildGuideRegistry, buildCapabilitiesIndex } from './guide-registry'
import { AgentManager } from './agent-manager'
import { loadWorkspaceCustomAgents } from './subagent'
import { TaskRegistry, formatTaskNotification, type TaskLink, type TaskSource, type TaskStatus } from './task-registry'
import { cleanupTaskOutputs, listTaskOutputRows, taskOutputBody, taskOutputDir, taskOutputRoot } from './task-output'
import { createApiTaskClient } from './remote-tasks'
import { releaseSessionBrowsers, reapOrphanChromium } from './browser-pool'
import { TeamManager } from './team-manager'
import {
  RUNTIME_LOG_SUBDIR,
  BUILD_LOG_BASENAME,
  CONSOLE_LOG_BASENAME,
  previewBuildLogPath,
  previewConsoleLogPath,
} from './runtime-log-paths'
import { shouldInjectPreviewUrl, buildPreviewUrlBlock } from './preview-url-context'
import { detectLocalMode } from './preview-manager'
import { LocalhostLinkRewriter, rewriteLocalhostLinks } from './preview-link-rewrite'
import { extractShareLinkTokens, repairShareLinks } from './share-link-repair'

const QUICK_ACTION_GUIDE = `## Quick Actions

You can register quick actions that appear as one-click prompt shortcuts in the user's chat UI.
They are stored in \`.shogo/quick-actions.json\`.

When you notice a user sending a prompt that looks like a repeatable workflow (committing code, running tests, deploying, generating reports, etc.), proactively offer to save it as a quick action using the \`quick_action\` tool.

Example: if a user says "review all my pending changes and commit them", register:
- label: "Commit" (1-2 words, max 20 chars)
- prompt: "Please review all pending changes and commit them" (faithful to what the user said)

Constraints: max 10 quick actions, labels must be unique. To view or edit existing actions, read/edit \`.shogo/quick-actions.json\` directly.`

const PERSONAL_COMPANION_GUIDE = `## Personal Companion Mode

This is a personal, chat-first workspace. The conversation is the interface:
use the profile and goal tools to keep the companion identity and long-running
work visible, and communicate in concise user-facing language.

- Do not use shell, builder, canvas, code-analysis, team, or subagent tools.
- For a real software artifact, create a goal, then use \`project_create\` and
  \`project_call\` to delegate it. Personal-workspace builder projects are
  hidden from the user's project list.
- When delegation returns a preview or published URL, save it as a goal
  deliverable and share the URL with the user.
- Do not expose internal project ids or builder mechanics unless the user asks.
`

function isComposioTool(name: string): boolean {
  return /^[A-Z]+_/.test(name)
}

function extractToolkitName(name: string): string {
  const p = name.split('_')[0]
  return p ? p.charAt(0).toUpperCase() + p.slice(1).toLowerCase() : name
}

function hasErrorInResult(result: unknown): boolean {
  if (!result || typeof result !== 'object') return false
  return 'error' in (result as any)
}

/**
 * Infer the LLM provider from a model ID string. Delegates to the
 * shared model catalog which handles aliases and prefix matching.
 */
function inferProviderFromModel(modelId: string, configProvider: string): string {
  return catalogInferProvider(modelId, configProvider)
}

/**
 * Parse the admin-injected `AGENT_AUTO_TIER_MAP` env var into an
 * `AutoTierOverride`. The API server resolves each configured tier id
 * (including public aliases like `hoshi-1.0`) to a runtime-resolvable model id
 * plus an optional provider hint before serializing this JSON. Returns
 * undefined when unset or malformed so Auto falls back to the hardcoded
 * defaults in `buildAutoTierMap()`.
 */
function parseAutoTierOverride(raw: string | undefined): AutoTierOverride | undefined {
  if (!raw) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (!parsed || typeof parsed !== 'object') return undefined
  const src = parsed as Record<string, unknown>
  const out: AutoTierOverride = {}
  for (const tier of ['economy', 'standard', 'premium'] as const) {
    const entry = src[tier]
    if (!entry || typeof entry !== 'object') continue
    const e = entry as Record<string, unknown>
    const id = typeof e.id === 'string' ? e.id.trim() : ''
    if (!id) continue
    const provider = typeof e.provider === 'string' && e.provider.trim() ? e.provider.trim() : undefined
    const upstream = typeof e.upstream === 'string' && e.upstream.trim() ? e.upstream.trim() : undefined
    out[tier] = { id, provider, upstream }
  }
  return Object.keys(out).length > 0 ? out : undefined
}

const FALLBACK_SUMMARIZER_MODEL = { id: 'claude-haiku-4-5', provider: 'anthropic' }

/**
 * True when the agent loop ended because the user pressed Stop. Such a turn
 * can legitimately have no text (e.g. stopped during a tool call) and must not
 * get the "unable to generate a response" fallback.
 */
export function isUserStoppedTurn(result: { abortReason?: string }): boolean {
  return result.abortReason === 'external'
}

/**
 * True when a loop ended with nothing to show and no error worth surfacing:
 * either a clean empty stop or the loop's implicit "no output" error. Real
 * provider errors were already classified and retried inside the loop.
 */
export function isEmptyTurnResult(result: {
  text?: string
  toolCalls: unknown[]
  error?: Error
  usageLimit?: unknown
  loopBreak?: unknown
  abortReason?: string
}): boolean {
  if (result.text?.trim() || result.toolCalls.length > 0) return false
  if (result.usageLimit || result.loopBreak || result.abortReason) return false
  return !result.error || result.error.message === 'Agent produced no output — possible provider error'
}

/**
 * Parse the admin-injected `AGENT_SUMMARIZER_MODEL` env var (`{ id, provider }`
 * JSON, resolved by the API server from the `summarizer.model` setting).
 * Falls back to Haiku on Anthropic when unset or malformed — e.g. a desktop
 * connected to a cloud that predates the setting.
 */
export function resolveSummarizerModel(raw: string | undefined): { id: string; provider: string } {
  if (!raw) return FALLBACK_SUMMARIZER_MODEL
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const id = typeof parsed?.id === 'string' ? parsed.id.trim() : ''
    if (!id) return FALLBACK_SUMMARIZER_MODEL
    const provider = typeof parsed.provider === 'string' && parsed.provider.trim()
      ? parsed.provider.trim()
      : inferProviderFromModel(id, 'anthropic')
    return { id, provider }
  } catch {
    return FALLBACK_SUMMARIZER_MODEL
  }
}

type AutoTierCeiling = 'economy' | 'standard' | 'premium'

const AUTO_TIER_ORDER: AutoTierCeiling[] = ['economy', 'standard', 'premium']
// Re-probe the configured ceiling periodically so a plan upgrade or a
// transient cloud configuration error can recover without requiring a new
// chat session.
const AUTO_TIER_CEILING_TTL_MS = 5 * 60 * 1000
/** How often a turn re-reads the DB-owned model into `config.json` (SHO-145). */
const CONFIG_MODEL_SYNC_MS = 30_000
/** Finished tasks arriving this close together wake an idle session once. */
const TASK_WAKE_COALESCE_MS = 2_000
/**
 * A wake the API did not accept is retried on these delays (shared with the
 * task-create retry, so one table governs both). The note stays unreported
 * until a flush succeeds, so a refused notify cannot silently end the
 * session's wake.
 */
/** How often an idle session polls tasks mirrored from another project's runtime. */
const REMOTE_TASK_POLL_MS = 10_000
/** How often a running turn refreshes remote tasks so their results can be injected mid-turn. */
const TURN_REMOTE_REFRESH_MS = 10_000

function lowerAutoTier(tier: AutoTierCeiling): AutoTierCeiling | null {
  const index = AUTO_TIER_ORDER.indexOf(tier)
  return index > 0 ? AUTO_TIER_ORDER[index - 1] : null
}

export function resolveAutoDowngrade(
  currentModel: string,
  selectedTier: AutoTierCeiling,
  autoTiers: Record<AutoTierCeiling, string>,
  reason: string,
): { tier: AutoTierCeiling; model: string } | null {
  if (reason !== 'billing' && reason !== 'auth') return null

  let fallbackTier = lowerAutoTier(selectedTier)
  while (fallbackTier) {
    const fallbackModel = autoTiers[fallbackTier]
    // Multiple configured tiers may intentionally point at the same model.
    // Do not retry that rejected model under a different tier; keep looking
    // for the next distinct lower-tier model instead.
    if (fallbackModel && fallbackModel !== currentModel) {
      return { tier: fallbackTier, model: fallbackModel }
    }
    fallbackTier = lowerAutoTier(fallbackTier)
  }
  return null
}

/**
 * Resolve UI-facing model aliases (basic/advanced) to concrete model IDs
 * so pi-ai can find them in its model registry and pick the correct API.
 */
function resolveModelAlias(modelId: string): string {
  return resolveModelId(modelId)
}

/**
 * Resolve the thinking/reasoning level for a turn.
 *
 * Precedence:
 *   1. `basic` agent mode → its dedicated env override (haiku benefits from
 *      medium reasoning effort).
 *   2. The selected model's admin-configured `reasoningEffort`, threaded
 *      through `config.model.thinkingLevel` by the picker.
 *   3. The `AGENT_THINKING_LEVEL` env default, then `medium`.
 */
export function resolveThinkingLevel(
  modelOverride?: string,
  configThinkingLevel?: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh',
): 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' {
  // Ollama models such as qwen2.5:3b do not accept provider reasoning
  // parameters. Local development must send a plain completion request even
  // when the shared Auto-mode defaults would normally choose medium thinking.
  if (process.env.LOCAL_LLM_BASE_URL) return 'off'
  const envLevel = process.env.AGENT_THINKING_LEVEL as any
  if (modelOverride === 'basic') {
    return (process.env.AGENT_BASIC_THINKING_LEVEL as any) || 'medium'
  }
  if (configThinkingLevel) return configThinkingLevel
  return envLevel || 'medium'
}

const AUTH_ERROR_PATTERNS = [
  'unauthorized', 'forbidden', 'not_authed', 'invalid_auth',
  'token expired', 'refresh token', 'invalid_grant', 'expired',
  'revoked', 'auth_expired', 'authexpired', 'credentials',
  'oauth', 'access denied', 'authentication failed',
]

function isAuthError(raw: string): boolean {
  const l = raw.toLowerCase()
  return AUTH_ERROR_PATTERNS.some(p => l.includes(p))
}

function formatUploadedFileSize(size: number): string {
  if (size < 1024) return `${size}B`
  if (size < 1024 * 1024) return `${Math.round(size / 1024)}KB`
  return `${(size / (1024 * 1024)).toFixed(1)}MB`
}

function toUserMessage(toolkit: string, raw: string): string {
  const l = raw.toLowerCase()
  if (l.includes('tool') && l.includes('not found'))
    return `${toolkit} integration tools failed to load. Try reconnecting ${toolkit} from the Capabilities tab.`
  if (l.includes('not found') || l.includes('404'))
    return `${toolkit} could not access the requested resource — it may be private or require additional permissions. Check your org's third-party access settings.`
  if (isAuthError(raw))
    return `${toolkit} authorization failed or connection expired. Please reconnect from the Capabilities tab.`
  if (l.includes('rate limit') || l.includes('429'))
    return `${toolkit} rate limit reached. Please wait a moment and try again.`
  return `${toolkit} encountered an issue: ${raw.length > 120 ? raw.slice(0, 120) + '...' : raw}`
}

/**
 * Map a failed turn's raw error to a clean, user-facing message.
 *
 * The raw text is an INTERNAL wrapper (e.g. `Provider error: Connection error.`)
 * or a raw upstream body — neither should ever reach the client. We classify it
 * with the SAME `classifyRetryability` the agent loop used when it retried the
 * call (to exhaustion), so the surfaced message matches the real cause, and we
 * NEVER echo the raw text (the detail stays in the server logs only).
 *
 * `Connection error.` is the OpenAI SDK's APIConnectionError message, surfaced
 * when the runtime cannot reach the AI proxy — the class of failure behind the
 * 2026-07 metal provider-connection incidents. It classifies as `network`, so
 * we ask the user to retry (NOT to switch models — a network fault is
 * provider-independent) instead of leaking `Provider error: Connection error.`.
 */
export function describeTurnFailure(
  rawMessage: string | undefined | null,
  // Shown only when the cause can't be classified. Defaults to a plain retry;
  // the hard-exception path passes a "start a new conversation" hedge since an
  // uncaught throw may indicate a corrupt turn rather than a transient fault.
  unknownFallback = 'I encountered an issue processing your message. Please try again.',
): string {
  const raw = (rawMessage && String(rawMessage)) || 'An unexpected error occurred'

  // A Shogo agent-loop concept, not a provider failure — decide before
  // classification so it isn't mistaken for an "unknown" provider error.
  if (/maximum iteration limit/i.test(raw)) {
    return 'This task is taking more steps than a single run allows — I kept going as far as I could. Reply "continue" if you\'d like me to pick up where I left off.'
  }

  // classifyRetryability reads the proxy's `[shogo:retryable=...]` marker (if
  // present) before falling back to text heuristics, so pass the raw message.
  const { reason } = classifyRetryability({ message: raw })
  switch (reason) {
    case 'billing':
      // `classifyRetryability` only buckets by coarse reason, not the specific
      // `UsageBlockReason` billing.service returns — but `parseProviderError`
      // (agent-loop.ts) preserves the JSON body's `error.message` verbatim, so
      // the specific text billing.service's `usageLimitErrorPayload` chose
      // survives into `raw`. Sniff for it here rather than threading the
      // structured code through the whole retry-classifier pipeline. Without
      // this, a user with on-demand usage ON but an expired entitlement (or
      // one who's genuinely hit their configured spend cap) sees the same
      // "enable usage-based pricing" text as someone who never turned it on
      // at all — see the 2026-09-02 on-demand-usage incident.
      if (/entitlement.*expired|reactivate your (subscription|license)/i.test(raw)) {
        return 'Your on-demand billing entitlement has expired. Reactivate your subscription or license key to continue using on-demand usage.'
      }
      if (/spending cap/i.test(raw)) {
        return "You've reached your on-demand spending cap for this period. Raise your cap in Billing settings to continue."
      }
      return 'Usage limit reached. Enable usage-based pricing, upgrade your plan, or check your AI provider settings.'
    case 'network':
      return "I couldn't reach the model just now — the connection dropped. Please try again in a moment."
    case 'timeout':
    case 'idle_timeout':
      return 'The model took too long to respond. Please try again in a moment.'
    case 'truncated':
      return 'The response was cut off before it finished. Please try again.'
    case 'overloaded':
    case 'server_5xx':
    case 'upstream_error':
      return 'Model unavailable. Please try again shortly, or switch to a different model.'
    case 'auth':
      return 'The model provider rejected the request. Please check your AI provider settings.'
    case 'content_policy':
      return "This request was blocked by the model provider's content filter. Please rephrase and try again."
    case 'invalid_request':
    case 'unknown':
    default:
      // Never surface the raw internal/upstream text to the client.
      return unknownFallback
  }
}

export type VisualMode = 'canvas' | 'app' | 'none'

/**
 * Which surface a chat turn belongs to. A workspace runtime serves both: the
 * workspace agent (meta-agent) gets `workspace`, a project's own chat gets
 * `project`. Capability toggles, the prompt block and `capabilities_configure`
 * all resolve against the surface, so a workspace toggle can never gate a
 * project chat or vice versa.
 */
export type ChatContext = 'workspace' | 'project'
/** Separator between two prompt sections in the system prompt. */
const SECTION_SEPARATOR = '\n\n---\n\n'

/**
 * Append a section to the *stable* (cached) zone of an already-built system
 * prompt, just before `<|CACHE_BOUNDARY|>`.
 *
 * Some prompt content can only be rendered after the tool set is assembled —
 * the deferred-tools catalog (SHO-97) is the first of those — and the prompt is
 * built before the tools are. Inserting before the boundary keeps that content
 * in the cached prefix instead of re-billing it on every request.
 */
function insertStablePromptSection(prompt: string, section: string): string {
  if (!section) return prompt
  const idx = prompt.indexOf(CACHE_BOUNDARY)
  if (idx === -1) return `${prompt}${SECTION_SEPARATOR}${section}`
  return `${prompt.slice(0, idx)}${SECTION_SEPARATOR}${section}${prompt.slice(idx)}`
}

/**
 * The prompt-cache prefix a turn was sent with, as short hashes.
 *
 * Cache layout is the only lever we have on providers that cache implicitly
 * (DeepSeek behind `hoshi`) — there is no breakpoint to set. Comparing two
 * turns: `stableHash` changing is pure waste (the cached prefix was thrown
 * away); `dynamicHash` changing is expected; `toolsHash` changing invalidates
 * everything on every provider; `historyHash` shows whether the message list
 * grew from the front (a compaction) instead of from the end.
 */
export interface CachePrefix {
  /** 1-based user turn on this session. */
  turn: number
  /** Hash of the system-prompt bytes before `<|CACHE_BOUNDARY|>` — the cached zone. */
  stableHash: string
  /** Hash of the per-turn zone after the boundary. Expected to change each turn. */
  dynamicHash: string
  /** Hash of the ordered tool definitions (name + description + JSON schema). */
  toolsHash: string
  /** Hash of the outgoing message list at turn start. */
  historyHash: string
  stableChars: number
  dynamicChars: number
  toolCount: number
  messageCount: number
}

/** One probe of the prompt-cache prefix, taken without calling a model. */
export interface CachePrefixProbe {
  sessionId: string
  /** True when two consecutive builds produced byte-identical stable zones. */
  identical: boolean
  /** The stable-zone section whose content drifted between the two builds, when it did. */
  drift: { label: string; chars: number } | null
  builds: Array<{
    stableHash: string
    dynamicHash: string
    stableChars: number
    dynamicChars: number
    toolsHash: string
    toolCount: number
  }>
  sections: Array<{ label: string; zone: 'stable' | 'dynamic'; chars: number; estTokens: number }>
}

/** What the dock's output route answers with: the text plus where the task lives. */
export interface SessionTaskOutput {
  taskId: string
  source: TaskSource
  title: string
  status: TaskStatus
  outputFile?: string
  output: string
  link?: TaskLink
}

export interface GatewayConfig {
  /**
   * Runtime capability profile; personal removes builder/shell tools.
   * Undefined behaves like `'team'` (see `capability-profiles.ts`).
   */
  capabilityProfile?: CapabilityProfileName
  /**
   * Whether the heartbeat tools (`heartbeat_configure`, `heartbeat_status`) and
   * the devops guide are available to the agent. This is a capability toggle,
   * NOT the schedule: whether heartbeats actually run (enabled, interval,
   * quiet hours) lives in the `agent_configs` table and is read/written through
   * the project config API. Default: on. The legacy `heartbeatEnabled` key in
   * config.json is read as a fallback for projects that predate this field.
   */
  heartbeatToolsEnabled?: boolean
  /**
   * Advertise a core tool set plus this agent's most-used tools, and defer the
   * rest behind the Deferred Tools catalog (SHO-97). Same default on both
   * tracks: on, unless a config or `SHOGO_DEFERRED_TOOLS=0` turns it off.
   */
  deferredToolsEnabled?: boolean
  channels: Array<{ type: string; config: Record<string, string>; model?: string }>
  /** Model configuration: provider + name (e.g. { provider: 'anthropic', name: 'auto' }).
   *  `thinkingLevel` is the admin-configured reasoning effort for the selected
   *  model (set by the client when picking a model); it overrides the env
   *  default in `resolveThinkingLevel`. */
  model: { provider: string; name: string; thinkingLevel?: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' }
  maxSessionMessages?: number
  /** Session management configuration */
  session?: Partial<SessionManagerConfig>
  /** Loop detection configuration (false to disable) */
  loopDetection?: Partial<LoopDetectorConfig> | false
  /** Streaming chunk configuration for progressive channel responses */
  streamChunk?: Partial<StreamChunkConfig>
  /** Docker sandbox configuration for exec tool isolation */
  sandbox?: Partial<SandboxConfig>
  /** Main session IDs that bypass sandbox (direct owner chats) */
  mainSessionIds?: string[]
  /** MCP servers to spawn on gateway start — tools from these become available to the agent */
  mcpServers?: Record<string, MCPServerConfig>
  /** Remote MCP servers (HTTP/StreamableHTTP) to connect on gateway start */
  remoteMcpServers?: Record<string, RemoteMCPServerConfig>
  /** Active visual mode: canvas, app, or none (default: 'canvas') */
  activeMode?: VisualMode
  /** Modes this project is allowed to use (default: all modes for paid, ['canvas','none'] for basic) */
  allowedModes?: VisualMode[]
  /** Whether web search tool is enabled (default: true) */
  webEnabled?: boolean
  /** Whether browser automation tool is enabled (default: true) */
  browserEnabled?: boolean
  /** Playwright browser extension token for CDP connect mode */
  browserExtensionToken?: string
  /** Whether shell/exec tool is enabled (default: true) */
  shellEnabled?: boolean
  // heartbeat tools are gated by heartbeatToolsEnabled (above)
  /** Whether image generation tool is enabled (default: true) */
  imageGenEnabled?: boolean
  /** Whether the generate_video tool is enabled (default: false — opt-in, billed per second) */
  videoGenEnabled?: boolean
  /** Whether the generate_3d_model tool is enabled (default: false — opt-in, billed per task) */
  threeDGenEnabled?: boolean
  /** Whether memory tools are enabled (default: true) */
  memoryEnabled?: boolean
  /** Whether quick action registration is enabled (default: true) */
  quickActionsEnabled?: boolean
  /** Whether the Shogo SDK guide section is included in the system prompt (default: true) */
  sdkGuideEnabled?: boolean
  /** Whether managed-integration / MCP discovery is available — gates the integration tools (search_integrations / connect / disconnect) AND the prompt guidance (default: true) */
  integrationsEnabled?: boolean
  /** Whether channel connection / messaging is available — gates the channel tools (channel_connect / channel_list / send_message, …) AND the prompt guidance (default: true) */
  channelsEnabled?: boolean
  /** Whether canvas tools are enabled (default: true). Automatically set false when switching to app/none mode. */
  canvasEnabled?: boolean
  /** Prompt profile: 'full' = all sections (default), 'swe' = minimal coding-only profile for SWE evals, 'general' = workspace + tools + skills (no personality/canvas) */
  promptProfile?: 'full' | 'swe' | 'general'
  /** Enable coordinator mode (leader only delegates, never does work directly) */
  coordinatorMode?: boolean
  /**
   * BETA: per-chat git worktrees. When true, each chat session operates on
   * its own branch (`shogo/chat/<sessionId>`) checked out in an isolated
   * worktree; `main` only changes via the merge-on-done flow. Default off.
   * Opt-in: anything other than `true` leaves it off.
   */
  gitWorktreesEnabled?: boolean
  /**
   * Instagram/TikTok lookups (`social_media`). Opt-in: anything other than
   * `true` leaves the tool off. Each call spends paid EnsembleData units.
   */
  socialMediaEnabled?: boolean
  /**
   * The management half of `social_media` (inbox, replies, comment replies and
   * comment→DM automations). Separate opt-in so a workspace can manage its
   * connected accounts without paying for public lookups.
   */
  socialManagementEnabled?: boolean
  /** When the master switch is on, Instagram lookups stay available unless this is `false`. */
  socialInstagramEnabled?: boolean
  /** When the master switch is on, TikTok lookups stay available unless this is `false`. */
  socialTiktokEnabled?: boolean
  /** Team chat tools (`team_chat_*`, `team_directory`, `member_activity`, `fetch_chat_files`). Default on. */
  teamChatEnabled?: boolean
  /** Working cards on boards (`board_list/summary/health`, `work_item_*`). Default on. */
  boardsEnabled?: boolean
  /** Board structure (`board_create/update/archive/reorder`, `column_*`). Opt-in. */
  boardAdminEnabled?: boolean
  /** Creating and changing triggers (`trigger_create/update/delete/test`). Default on. */
  workTriggersEnabled?: boolean
  /** Board sweeps, digests and escalation on heartbeat (company-ops skill). Opt-in. */
  companyOpsEnabled?: boolean
  /** Problem tools (`problem_occurrences`, `problem_report`). Opt-in. */
  problemsEnabled?: boolean
}

/**
 * Run a tool mock and convert its return value into the agent-tool
 * result envelope.
 *
 * Mocks are awaited (they may sleep for the demo latency model). When
 * the resolved value carries the `__multipart: true` marker we strip
 * the marker and return the raw `{ content, details? }` envelope so
 * tools like `browser screenshot` can return inline images directly
 * (otherwise textResult() would JSON-stringify the base64). All other
 * shapes go through textResult() as before. Sentinel `__passthrough`
 * is preserved for the dispatch site to fall through to the real impl.
 *
 * Used by demo recordings so canned screenshots show as actual images
 * in the chat panel.
 */
async function runMockAndUnwrap(
  mockFn: (params: Record<string, any>) => any | Promise<any>,
  params: Record<string, any>,
  integrationToolName?: string,
): Promise<any> {
  const result = await mockFn(params)
  if (result === '__passthrough') return result
  if (result && typeof result === 'object' && (result as any).__multipart === true) {
    const { __multipart: _m, ...rest } = result as any
    return rest
  }
  if (integrationToolName) return capIntegrationMockResult(integrationToolName, result)
  return textResult(result)
}

/** Composio action slugs, e.g. `GMAIL_SEND_EMAIL`. */
const COMPOSIO_SLUG_RE = /^[A-Z][A-Z0-9]*_[A-Z0-9_]+$/

/**
 * Apply the real Composio result-size cap (see the execute path in
 * composio.ts) to a mocked integration result, so eval mocks can't hand the
 * model a payload the production path would never return. Keep the limit and
 * annotation in sync with composio.ts.
 */
export function capIntegrationMockResult(toolName: string, data: unknown): AgentToolResult<any> {
  const maxChars = Math.max(4000, Number(process.env.COMPOSIO_MAX_RESULT_CHARS) || 25000)
  const { result: raw, truncated } = smartTruncateJson(data, maxChars)
  if (!truncated) return textResult(data)
  const slug = toolName.toUpperCase()
  const isGoogleDoc = slug.includes('GOOGLEDOCS') || slug.includes('GOOGLE_DOCS')
  const docHint = isGoogleDoc
    ? ` This is a Google Doc: to read the COMPLETE document (including its ending/conclusion), export it via GOOGLEDRIVE_DOWNLOAD_FILE or GOOGLEDRIVE_EXPORT_FILE using the same document id — that returns the full body. Do NOT summarize the document's decision or conclusion from this truncated copy.`
    : ''
  const annotation = `\n\n[⚠️ TRUNCATED — this response was cut from ${JSON.stringify(data).length} to ${raw.length} chars and is INCOMPLETE. Do not treat it as the whole result or answer as if you have seen the end. To get the full value, re-fetch the source directly: page through with a smaller range, or export/download the underlying file.${docHint} For large datasets, use the skill server pattern: create a Prisma schema in .shogo/server/schema.prisma, ingest the data via a script, then query and display with canvas code.]`
  return textResult(raw + annotation)
}

export class AgentGateway {
  private workspaceDir: string
  /**
   * Value passed to the constructor. In pool mode this is a snapshot of
   * `state.currentProjectId` taken when `startGateway()` ran — which can be
   * (or can have been) the warm-pool placeholder (`__POOL__`) if the
   * gateway was constructed around a pool-assign race. See the `projectId`
   * getter below: it never uses this directly.
   */
  private _constructedProjectId: string
  private config: GatewayConfig
  private currentUserId: string | undefined
  private channels: Map<string, ChannelAdapter> = new Map()
  private skills: Skill[] = []
  private quickActions: QuickAction[] = []
  private configSkills: Array<{ name: string; trigger?: string; description?: string }> = []
  private running = false
  private lastHeartbeatTick: Date | null = null
  private hookEmitter: HookEmitter = new HookEmitter()
  private pendingEvents: string[] = []
  private sessionManager: SessionManager
  private sessionPersistence: SqliteSessionPersistence | null = null
  private mcpClientManager: MCPClientManager = new MCPClientManager()
  /** Optional custom stream function, injected for testing */
  private _streamFn?: StreamFn
  /** Optional log callback for forwarding gateway events to the UI Logs tab */
  private _onLog?: (line: string) => void
  /** Per-section prompt overrides set by DSPy optimization via POST /agent/prompt-override */
  private promptOverrides = new Map<string, string>()
  /**
   * This turn's API-side facts, read once before the prompt is built and dropped
   * at the next turn: the chats the acting person can actually open, and the
   * workspace agent pause in force (SHO-118). Absent means "render as before".
   */
  private turnReachable = new Map<string, string[]>()
  private turnPause = new Map<string, WorkspaceAgentsPause | null>()
  /** Current guide registry built during loadBootstrapContext, consumed by tool context */
  private currentGuideRegistry?: Map<string, string>
  /** Per-section prompt breakdown from the last loadBootstrapContext() call */
  lastPromptBreakdown?: Array<{ label: string; zone: 'stable' | 'dynamic'; chars: number; estTokens: number }>
  /**
   * Advertised tool sets, one per session (SHO-97). Computed once and reused so
   * the tools block stays byte-identical across the API calls of a turn; a
   * changed registration (an MCP server connected mid-session) rebuilds it and
   * re-applies whatever the model had activated.
   */
  private toolProfiles = new Map<string, { signature: string; toolCount: number; profile: ToolProfile; activated: Set<string> }>()
  /** Tool execute overrides for eval mocking (tool name -> mock fn) */
  private toolMocks = new Map<string, (params: Record<string, any>) => any>()
  /** Synthetic tool definitions for mocked MCP tools that don't exist in the base tool set */
  private syntheticTools = new Map<string, { description: string; paramKeys: string[]; parameters?: unknown }>()
  /** Tools that have mock responses but should not appear until promoted via connect */
  private hiddenMockTools = new Set<string>()
  /** Hidden mocks promoted to visible after connect is called during a turn */
  private promotedMockTools: AgentTool[] = []
  /** User's IANA timezone, set from chat requests. Falls back to server timezone. */
  private userTimezone: string | null = null
  /** Last Studio viewer (phone vs desktop) from the chat body. */
  private viewerContextPrompt: string | null = null
  /**
   * Request-scoped half of the Account prompt block: the workspace plan gates
   * that come from the API. Deliberately does NOT hold a model name — one
   * runtime serves several chats and a turn can start with no `/agent/chat`
   * request at all, so the model line is resolved per turn instead (SHO-145).
   */
  private accountContext: AccountContext = {}
  /** Last successful (or attempted) DB model pull into `config.json` (SHO-145). */
  private lastConfigModelSyncAt = 0
  /** Permission engine for local-mode security guardrails */
  private permissionEngine: PermissionEngine | null = null
  /** Callback to push permission-related SSE events to the connected client */
  private _permissionSseCallback?: (event: Record<string, any>) => void
  /**
   * Sessions with a pending *manual* summarize request (the context dock's
   * button) whose turn is still live. Consumed by the next `transformContext`
   * call in that turn.
   */
  private manualCompactionRequests = new Set<string>()
  /** Usage from the most recent agentTurn (consumed by server.ts for the finish event) */
  private _lastTurnUsage: {
    inputTokens: number
    outputTokens: number
    cacheReadTokens: number
    cacheWriteTokens: number
    iterations: number
    toolCallCount: number
    contextWindowTokens: number
    estimatedContextTokens: number
    model: string
    success: boolean
    hitMaxTurns: boolean
    loopDetected: boolean
    /** The loop detector's description when `loopDetected` is true. */
    loopPattern?: string
    escalated: boolean
    responseEmpty: boolean
    /**
     * Per-model-call breakdown (one entry per tool-use iteration), so a cache
     * rewrite inside a turn is visible instead of only the turn's totals.
     */
    perCallUsage: PerCallUsage[]
    /** The prompt-cache prefix this turn was sent with (see `CachePrefix`). */
    prefix: CachePrefix
    /**
     * True when the turn ended via a user-initiated stop (Stop button).
     * server.ts uses this to tag the trailing `data-turn-complete` frame
     * with `status: 'aborted'` so project-chat bills the partial usage
     * instead of treating the EOF as an upstream cut.
     */
    wasAborted: boolean
  } | null = null
  /** Optional label for eval tracing — included in log prefix when set */
  private evalLabel: string | null = null
  /** Manages the per-workspace skill server process (.shogo/server/) */
  private skillServerManager: SkillServerManager
  /** Multi-language LSP manager for read_lints diagnostics */
  private lspManager: WorkspaceLSPManager | null = null
  /**
   * Getter for the runtime's "workspace deps ready" promise. Set via
   * `setWorkspaceDepsReady` so the LSP start can wait for the background cold
   * install instead of racing it (which surfaces spurious "cannot find module"
   * diagnostics). Optional — when unset (e.g. tests) the LSP starts without
   * waiting.
   */
  private workspaceDepsReady?: () => Promise<void>
  /** Tracks files the agent has read across turns for cache-aware compaction */
  private fileStateCache = new FileStateCache()
  /**
   * Snapshot of the built `## Memory` prompt section, keyed by `MEMORY.md`'s
   * `mtimeMs:size` (SHO-78). The memory block now lives in the cached stable
   * prefix, so rebuilding it on every turn would invalidate that prefix every
   * turn. Rebuilding when the file actually changes is correct — and costs one
   * cache write instead of one per turn.
   */
  private memorySectionCache: { key: string; content: string } | null = null
  /**
   * Per-session compaction-decision state for the per-API-call transformContext.
   *
   * pi-agent-core's agent loop re-reads `agent.state.messages` before every LLM
   * request. Without this state, re-running the three cheap compaction layers
   * (budget / microcompact / snip) produces different bytes for the same
   * historical tool_result on each call, which invalidates the prompt cache
   * prefix and forces a full re-write every request (observed ~3.5x cache-write
   * amplification in a 6-call turn).
   *
   * The state is write-once per tool_call_id, guaranteeing byte-identical
   * output for any id once it's been "decided". See stable-compaction.ts for
   * the invariant proof. Reset whenever sessionManager.compact() rewrites the
   * prefix (the surviving tool_use_ids are a subset, but the summary message
   * changes the wire prefix upstream of them anyway, so keeping stale state
   * gains nothing and prune on reset is simpler).
   */
  private contentReplacementStates = new Map<string, ContentReplacementState>()
  /**
   * The workspace agent's own capability toggles (`Workspace.settings`), held
   * separately from `this.config` (which caches the anchor project's
   * `Project.settings`). A workspace runtime serves both surfaces, so one flat
   * set of keys cannot answer for both. Mirrored into `config.json` under
   * `workspaceCapabilities` as a last-known cache; the DB is the source of
   * truth (see `syncCapabilitiesFromApi`).
   */
  private workspaceCapabilitySettings: Record<string, unknown> = {}
  /**
   * Surface each chat session belongs to. The message payload normally says
   * (`chatContext`), but prompt builders and tools also ask per session, and
   * a turn that did not say must not silently inherit the other surface.
   */
  private sessionChatContexts = new Map<string, ChatContext>()
  /**
   * Per-session user-turn counter, incremented once on entry to `runTurn` and
   * reported as `prefix.turn` so a turn's cache numbers can be lined up with
   * the `[cache-prefix]` log line and the previous turn's hashes.
   * Not consulted for correctness; safe to clear or leave stale.
   */
  private turnCounters = new Map<string, number>()
  /**
   * Per-position prefix tags of the last turn's starting history. The next
   * turn's start should begin with them; when it does not, the compaction that
   * ran between the turns rewrote bytes the provider had already cached
   * (`context_turn_boundary.prefixStable`, SHO-122).
   */
  private turnPrefixes = new Map<string, string[]>()
  /** Shared index engine for workspace-wide search (code + files) */
  private indexEngine: import('./index-engine').IndexEngine | null = null
  /** Workspace knowledge graph for structural analysis */
  private workspaceGraph: import('./workspace-graph').WorkspaceGraph | null = null
  /** Canvas v2 file watcher — shared singleton from CanvasFileWatcher.getInstance() */
  private get canvasFileWatcher(): CanvasFileWatcher {
    return CanvasFileWatcher.getInstance(this.workspaceDir)
  }
  /** Canvas build manager — runs per-workspace Vite builds */
  private canvasBuildManager: CanvasBuildManager | null = null
  private workspaceRebuild: ((projectId: string) => void) | null = null
  /**
   * Post-build `tsc --noEmit` gate. Vite/Expo transpile without
   * type-checking, so type errors (missing imports, boolean-as-component,
   * wrong props) compile clean and crash at render time. This gate runs
   * after each successful build and surfaces those errors into build.log +
   * the in-band canvas-error buffer so they can't slip past a green build.
   */
  private canvasTypecheckGate: CanvasTypecheckGate | null = null
  /**
   * Direct handle on the runtime's PreviewManager (set by
   * `attachApiServer`). Held in addition to the `skillServerManager`
   * shim because we need to surface its `depsReady` deferred to the
   * canvas build manager — going through the shim would require
   * forwarding the promise through a layer whose contract is
   * "skill-server-like API server", not "preview lifecycle".
   *
   * `null` is tolerated by `CanvasBuildManager`: missing waitForDeps
   * just means the build proceeds without the gate (e.g. tests, or
   * cloud paths where deps are guaranteed-installed before boot).
   */
  private previewManager: import('./preview-manager').PreviewManager | null = null
  /** Tracks the current high-level task description for remote status */
  private _currentTask: string | null = null
  /** Tracks the last tool name invoked for remote status */
  private _lastTool: string | null = null
  /** Dynamic sub-agent registry and lifecycle manager */
  public agentManager = new AgentManager()
  /** Signature of the last `.shogo/agents/` set registered, to log only on change. */
  private customAgentsSignature = ''
  private teamManager?: TeamManager
  /** Per-session shell cwd tracking — persists cd across exec calls */
  private shellCwd = new Map<string, string>()
  /**
   * Per-session background-wake state, refreshed at turn start. The prompt is
   * built synchronously, so the API's answer is cached here rather than fetched
   * mid-build (see `wake-status-prompt.ts`).
   */
  private wakeStates = new Map<string, SessionWakeState | null>()
  /** Per-session backgrounded command registry — soft-timed-out exec runs */
  private commandRegistries = new Map<string, TaskRegistry>()
  /**
   * Admin-configured Auto-mode tier overrides, parsed once from the injected
   * `AGENT_AUTO_TIER_MAP` env var. Undefined keeps the hardcoded defaults.
   */
  private autoTierOverride?: AutoTierOverride

  // ── BETA: per-chat git worktrees ──────────────────────────────────────────
  /** Lazily-created worktree manager (null until first use when enabled). */
  private worktreeManager: WorktreeManager | null = null
  /** Resolved worktree working-directory path per chat session. */
  private sessionWorktreePaths = new Map<string, string>()
  /**
   * Best-effort hook to persist the durable `.git` (with all branch refs) to
   * object storage after a worktree commit/merge. Wired by server.ts to the
   * git_only durability path; a no-op in environments without one.
   */
  private repoPersistHook: (() => Promise<void> | void) | null = null

  /**
   * Live project identity. `_constructedProjectId` is a one-time snapshot
   * taken when the gateway object was built — in pool mode that can be, or
   * can have been, the `__POOL__` placeholder if construction raced a
   * `/pool/assign` in flight. `process.env.PROJECT_ID` is kept current by
   * `/pool/assign` and `/pool/refresh-env` (server-framework.ts) for the
   * life of the process, so prefer it whenever it's set — this is the same
   * pattern already used by checkpoint recording (server.ts reads
   * `process.env.PROJECT_ID` fresh rather than a captured field) and by
   * `getInternalHeaders()`'s `RUNTIME_AUTH_SECRET` lookup (internal-api.ts).
   *
   * Without this, every outbound call that self-identifies via this field
   * — `updateHeartbeatConfig`'s heartbeat-config PUT, the webchat widget
   * embed URL, Composio session init — stays pinned to whatever value was
   * captured at construction, forever, even after the runtime is correctly
   * (re)assigned. The API then HMAC-verifies the (correctly refreshed)
   * runtime token, decodes the real project id from it, compares it to the
   * stale path segment built from this field, and rejects with
   * `runtime_token_project_mismatch tokenProject=<real> projectId=__POOL__`
   * — see apps/api/src/routes/internal.ts's `authenticate()`. Reproduced in
   * `__tests__/gateway-stale-pool-projectid.test.ts`.
   */
  private get projectId(): string {
    return process.env.PROJECT_ID || this._constructedProjectId
  }

  constructor(workspaceDir: string, projectId: string) {
    this.workspaceDir = workspaceDir
    this._constructedProjectId = projectId
    this.config = this.loadConfig()
    this.workspaceCapabilitySettings = this.loadWorkspaceCapabilitySettings()
    this.sessionManager = new SessionManager(this.config.session)
    this.fileStateCache.setWorkspaceDir(workspaceDir)
    this.mcpClientManager.setWorkspaceDir(workspaceDir)
    this.skillServerManager = new SkillServerManager({ workspaceDir })

    // Apply admin-configured agent model overrides from injected env vars
    const envOverrides: Record<string, string> = {}
    if (process.env.AGENT_BASIC_MODEL) envOverrides.basic = process.env.AGENT_BASIC_MODEL
    if (process.env.AGENT_ADVANCED_MODEL) envOverrides.advanced = process.env.AGENT_ADVANCED_MODEL
    if (Object.keys(envOverrides).length > 0) {
      setAgentModeOverrides(envOverrides)
    }

    // Parse admin-configured Auto-mode tier overrides (resolved model id +
    // provider hint per tier) so the spawn router can route Auto to models
    // like Hoshi that the hardcoded default map omits.
    this.autoTierOverride = parseAutoTierOverride(process.env.AGENT_AUTO_TIER_MAP)
    if (this.autoTierOverride) {
      console.log(`[AgentGateway] Auto tier override active: ${JSON.stringify(this.autoTierOverride)}`)
    }

    // DB-defined models (UUID ids) the API resolved for us. Every provider
    // inference path (subagents, forks, channels, heartbeats, fallbacks)
    // consults this, so Anthropic-backed ones keep native prompt caching.
    const dynamicModels = parseDynamicModelsEnv(process.env.AGENT_MODEL_REGISTRY)
    for (const entry of Object.values(this.autoTierOverride ?? {})) {
      if (entry?.provider) dynamicModels.push({ id: entry.id, provider: entry.provider })
    }
    registerDynamicModels(dynamicModels)
    if (dynamicModels.length > 0) {
      console.log(`[AgentGateway] Registered ${dynamicModels.length} dynamic model entries`)
    }

    // Initialize permission engine. Local mode enforces the full mode-based
    // policy; cloud runtimes enforce only per-tool action rules (for example
    // "ask before merging a pull request"), so nothing else changes for them.
    if (process.env.SHOGO_LOCAL_MODE === 'true') {
      // A `shogo worker` hosts cloud workspace projects on someone's machine; the people
      // chatting are teammates in the cloud, so nothing prompts unless a rule was configured.
      const cloudScope = process.env.SHOGO_PERMISSION_SCOPE === 'cloud'
      const pref = parseSecurityPolicy(process.env.SECURITY_POLICY, cloudScope ? DEFAULT_CLOUD_SECURITY_PREFERENCE : undefined)
      this.permissionEngine = new PermissionEngine({
        preference: pref,
        workspaceDir,
        noDefaultActionRules: cloudScope,
      })
      console.log(`[AgentGateway] Permission engine initialized: mode=${pref.mode}`)
      // Enforce the user's "computer use" setting on the computer-use MCP server.
      const engine = this.permissionEngine
      this.mcpClientManager.setToolGuard((serverName) => {
        const check = engine.checkMcpTool(serverName)
        return check.allowed ? null : { reason: check.reason ?? 'Blocked', guidance: check.guidance }
      })
    } else {
      this.permissionEngine = new PermissionEngine({
        preference: parseSecurityPolicy(process.env.SECURITY_POLICY, DEFAULT_CLOUD_SECURITY_PREFERENCE),
        workspaceDir,
        actionsOnly: true,
      })
    }

  }

  /** Inject a custom streamFn (used in tests to mock the LLM) */
  setStreamFn(fn: StreamFn): void {
    this._streamFn = fn
  }

  /**
   * This session's advertised tool set (SHO-97). Reused while the registration
   * is unchanged — that is what keeps the tools block byte-identical across the
   * API calls of a turn — and rebuilt (with the model's activations re-applied)
   * when a tool is added or removed mid-session.
   */
  private toolProfileFor(sessionId: string, tools: AgentTool[], learned: readonly string[]): ToolProfile {
    const signature = tools.map(t => t.name).sort().join(',')
    const cached = this.toolProfiles.get(sessionId)
    if (cached && cached.signature === signature) return cached.profile

    const activated = cached?.activated ?? new Set<string>()
    const base = createToolProfile(tools, { learned })
    for (const name of activated) base.advertise(name)

    const profile: ToolProfile = {
      ...base,
      advertise: (name: string) => {
        const wasDeferred = base.advertise(name)
        if (wasDeferred) activated.add(name)
        return wasDeferred
      },
      isAdvertised: (name: string) => base.isAdvertised(name),
      isDeferred: (name: string) => base.isDeferred(name),
      describe: (name: string) => base.describe(name),
      deferredNames: () => base.deferredNames(),
      advertisedNames: () => base.advertisedNames(),
    }

    if (!this.toolProfiles.has(sessionId) && this.toolProfiles.size >= 200) {
      const oldest = this.toolProfiles.keys().next().value
      if (oldest !== undefined) this.toolProfiles.delete(oldest)
    }
    this.toolProfiles.set(sessionId, { signature, toolCount: tools.length, profile, activated })
    return profile
  }

  /** Set a log callback for forwarding gateway events to the UI Logs tab */
  setLogCallback(fn: (line: string) => void): void {
    this._onLog = fn
  }

  /**
   * Provide a getter for the runtime's "workspace deps ready" promise so the
   * LSP start can gate on the background install instead of blocking the whole
   * gateway start. See the `startLSP` deferral in `start()` for how this is
   * consumed.
   */
  setWorkspaceDepsReady(fn: () => Promise<void>): void {
    this.workspaceDepsReady = fn
  }

  /**
   * Workspace runtimes: route buildable edits under a member folder to that
   * member's own preview. The root CanvasBuildManager is rooted at the
   * merged root, which has no package.json, so it can never build them.
   */
  setWorkspaceRebuild(memberIds: () => readonly string[], rebuild: (projectId: string) => void): void {
    this.workspaceRebuild = rebuild
    this.canvasFileWatcher.setWorkspaceMembers(memberIds)
  }

  setUserTimezone(tz: string): void {
    this.userTimezone = tz
  }

  /** Live canvas preview size from the Studio client (iPhone vs desktop).
   *  The gateway is a process singleton — call this on every chat request,
   *  including with `undefined`, so a missing payload clears the last hint. */
  setViewerContext(raw: unknown): void {
    const viewer = parseCanvasViewer(raw)
    this.viewerContextPrompt = viewer ? buildViewerContextPrompt(viewer) : null
  }

  /** Replaced on every chat request, like setViewerContext. Only the plan half
   *  is kept: the model name a request carries describes THAT request, and a
   *  heartbeat/schedule/pipeline turn has no request to read it from, so the
   *  model line is rendered per turn (see `loadBootstrapContext`). */
  setAccountContext(ctx: AccountContext): void {
    this.accountContext = {
      ...(ctx.planId ? { planId: ctx.planId } : {}),
      ...(typeof ctx.canPublishSubdomain === 'boolean'
        ? { canPublishSubdomain: ctx.canPublishSubdomain }
        : {}),
    }
  }

  /** Set an eval label for log tracing (used by eval runner) */
  setEvalLabel(label: string | null): void {
    this.evalLabel = label
  }

  /** Log prefix — includes eval label when set for traceability */
  private get logPrefix(): string {
    return this.evalLabel ? `[AgentGateway][${this.evalLabel}]` : '[AgentGateway]'
  }

  /** Set the SSE writer callback so the permission engine can push approval requests to the UI */
  setPermissionSseCallback(cb: (event: Record<string, any>) => void): void {
    this._permissionSseCallback = cb
    if (this.permissionEngine) {
      this.permissionEngine.setSseCallback(cb)
    }
  }

  /** Get the permission engine (used by server.ts for the approval response endpoint) */
  getPermissionEngine(): PermissionEngine | null {
    return this.permissionEngine
  }

  /**
   * Install tool-level execute overrides (for eval mocking + demo
   * recordings). Preserves tool schema. Mock functions may be sync or
   * async; the dispatch sites await the result either way. Async fns
   * power the demo latency model (sleep before resolving) so demo
   * recordings don't return in 0ms.
   */
  setToolMocks(
    mocks: Record<string, (params: Record<string, any>) => any | Promise<any>>,
    syntheticDefs?: Record<string, { description: string; paramKeys: string[]; parameters?: unknown }>,
    hiddenTools?: Set<string>,
  ): void {
    this.toolMocks.clear()
    this.syntheticTools.clear()
    this.hiddenMockTools.clear()
    this.promotedMockTools = []
    for (const [name, fn] of Object.entries(mocks)) {
      this.toolMocks.set(name, fn)
    }
    if (syntheticDefs) {
      for (const [name, def] of Object.entries(syntheticDefs)) {
        this.syntheticTools.set(name, def)
      }
    }
    if (hiddenTools) {
      for (const name of hiddenTools) {
        this.hiddenMockTools.add(name)
      }
    }
  }

  clearToolMocks(): void {
    this.toolMocks.clear()
    this.syntheticTools.clear()
    this.hiddenMockTools.clear()
    this.promotedMockTools = []
  }

  /** After mock connect returns, promote hidden mock tools listed in the response */
  _promoteHiddenMocksFromInstall(result: any): void {
    const tools = result?.tools
    if (!Array.isArray(tools)) return
    for (const entry of tools) {
      const toolName = typeof entry === 'string' ? entry : entry?.name
      if (!toolName) continue
      if (!this.hiddenMockTools.has(toolName)) continue
      if (this.promotedMockTools.some(t => t.name === toolName)) continue
      const mockFn = this.toolMocks.get(toolName)
      if (!mockFn) continue
      const synDef = this.syntheticTools.get(toolName)
      const paramProps: Record<string, any> = {}
      if (synDef?.paramKeys) {
        for (const key of synDef.paramKeys) {
          paramProps[key] = Type.Optional(Type.String({ description: key }))
        }
      }
      paramProps['input'] = Type.Optional(Type.String({ description: 'Input data or query' }))
      this.promotedMockTools.push({
        name: toolName,
        description: synDef?.description || `External integration tool: ${toolName}`,
        label: toolName.replace(/__/g, ' > ').replace(/_/g, ' '),
        parameters: Type.Object(paramProps),
        execute: async (_id: string, params: any) => runMockAndUnwrap(mockFn, params, toolName),
      })
      this.hiddenMockTools.delete(toolName)
    }
  }

  /** Consume usage data from the most recent agent turn (returns null if none available) */
  consumeLastTurnUsage() {
    const usage = this._lastTurnUsage
    this._lastTurnUsage = null
    return usage
  }

  /**
   * Force one compaction pass on a session, the way autocompact/post-turn
   * compaction would. Eval-harness hook only (`POST /agent/tool-mocks/compact`):
   * it exists so the `cache-compaction-recovery` test can prove a rewritten
   * prefix recovers its cache instead of resetting it for the rest of the chat.
   */
  async forceCompaction(sessionId: string): Promise<{ messagesBefore: number; messagesAfter: number } | null> {
    // Keep only the last two messages so a short (3-turn) eval session still
    // compacts; the default keep-window is far larger than any eval's history.
    const result = await this.sessionManager.compact(sessionId, undefined, 2)
    if (!result) return null
    // Compaction rewrote the prefix — the same reset the autocompact paths do.
    this.contentReplacementStates.delete(sessionId)
    return { messagesBefore: result.messagesBefore, messagesAfter: result.messagesAfter }
  }

  /**
   * Sample the prompt-cache prefix without calling a model.
   *
   * Builds the real system prompt twice with a tick between the builds (so any
   * clock- or log-derived section moves, which is exactly what a per-turn
   * builder would produce) and hashes both, plus a freshly assembled tool list.
   * This is what makes the two structural `cache-efficiency` tests free: a
   * volatile byte in the cached zone is a bug whether or not tokens were paid
   * to discover it.
   */
  async sampleCachePrefix(sessionId = 'chat'): Promise<CachePrefixProbe> {
    const build = () => {
      const system = this.loadBootstrapContext(sessionId)
      return { system, sections: this.lastPromptBreakdown ?? [] }
    }
    const first = build()
    await new Promise((resolve) => setTimeout(resolve, 5))
    const second = build()
    const toolsPrint = fingerprintTools(this.buildProbeTools())
    const print = (system: string) => {
      const p = fingerprintSystem(system)
      return {
        stableHash: p.stableHash,
        dynamicHash: p.dynamicHash,
        stableChars: p.stableChars,
        dynamicChars: p.dynamicChars,
        toolsHash: toolsPrint.hash,
        toolCount: toolsPrint.count,
      }
    }
    const builds = [print(first.system), print(second.system)]
    const stableOf = (system: string) => {
      const idx = system.indexOf(CACHE_BOUNDARY)
      return idx >= 0 ? system.slice(0, idx) : system
    }
    const stableA = stableOf(first.system)
    const stableB = stableOf(second.system)
    let drift: CachePrefixProbe['drift'] = null
    if (stableA !== stableB) {
      let at = 0
      while (at < stableA.length && at < stableB.length && stableA[at] === stableB[at]) at++
      let offset = 0
      for (const section of first.sections) {
        if (section.zone !== 'stable') continue
        if (at < offset + section.chars) {
          drift = { label: section.label, chars: section.chars }
          break
        }
        offset += section.chars + SECTION_SEPARATOR.length
      }
      drift ??= { label: 'unmapped', chars: Math.max(stableA.length, stableB.length) }
    }
    return {
      sessionId,
      identical: stableA === stableB,
      drift,
      builds,
      sections: first.sections,
    }
  }

  /** Replace prompt sections at runtime (used by DSPy optimization pipeline) */
  setPromptOverrides(overrides: Record<string, string>): void {
    this.promptOverrides.clear()
    for (const [key, value] of Object.entries(overrides)) {
      this.promptOverrides.set(key, value)
    }
  }

  private emitLog(line: string): void {
    const ts = new Date().toISOString()
    const formatted = `[${ts}] ${line}`
    this._onLog?.(formatted)
  }

  private loggedSkillsTruncation = new Set<string>()

  /**
   * Report a truncated `## Available Skills` section. The prompt builders run
   * every turn, so log each distinct (included, omitted) pair only once — the
   * point is that the omission is visible at all, not that it repeats.
   */
  private reportSkillsTruncation(info: { included: number; omitted: number; omittedNames: string[] }): void {
    const key = `${info.included}:${info.omitted}`
    if (this.loggedSkillsTruncation.has(key)) return
    this.loggedSkillsTruncation.add(key)

    const sample = info.omittedNames.slice(0, 10).join(', ') + (info.omittedNames.length > 10 ? ', …' : '')
    const line = `[Skills] prompt budget: ${info.included} skills listed, ${info.omitted} omitted (${sample})`
    console.warn(line)
    this.emitLog(line)
  }

  private loadConfig(): GatewayConfig {
    const profileName: CapabilityProfileName = workspaceKind() === 'personal' ? 'personal' : 'team'
    const teamDefaults = CAPABILITY_PROFILES.team
    const defaults: GatewayConfig = applyCapabilityProfile(
      {
        capabilityProfile: undefined,
        heartbeatToolsEnabled: undefined,
        channels: [],
        model: { provider: 'anthropic', name: 'auto' },
        maxSessionMessages: 30,
        activeMode: teamDefaults.activeMode,
        allowedModes: teamDefaults.allowedModes,
        shellEnabled: undefined,
        mainSessionIds: ['chat'],
      },
      profileName,
    )
    const configPath = resolveWorkspaceConfigFilePath(this.workspaceDir, 'config.json')
    if (configPath) {
      try {
        const raw = JSON.parse(readFileSync(configPath, 'utf-8'))
        // Workspace kind is API-issued runtime state, not user-editable
        // config. `applyCapabilityProfile` re-forces the profile's
        // mode/shell policy AFTER the config.json merge, so personal
        // workspaces can never regain builder tools by patching config.json.
        return applyCapabilityProfile(
          {
            ...defaults,
            ...raw,
            capabilityProfile: raw.capabilityProfile,
            activeMode: raw.activeMode ?? defaults.activeMode,
            allowedModes: raw.allowedModes ?? defaults.allowedModes,
            shellEnabled: raw.shellEnabled,
            // Capability toggle only; the schedule lives in the database.
            // `heartbeatEnabled` is the pre-split name of this flag.
            heartbeatToolsEnabled: raw.heartbeatToolsEnabled ?? raw.heartbeatEnabled ?? undefined,
            channels: Array.isArray(raw.channels) ? raw.channels : [],
          },
          profileName,
        )
      } catch (error: any) {
        console.error('[AgentGateway] Failed to parse config.json:', error.message)
      }
    }
    return defaults
  }

  /**
   * Read the raw `config.json` object (empty when absent or unparseable).
   * Shared by `loadConfig()` and the workspace-capabilities cache.
   */
  private readConfigFile(): Record<string, unknown> {
    const configPath = resolveWorkspaceConfigFilePath(this.workspaceDir, 'config.json')
    if (!configPath) return {}
    try {
      const parsed = JSON.parse(readFileSync(configPath, 'utf-8'))
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
    } catch {
      return {}
    }
  }

  /**
   * Load the cached copy of the workspace agent's own settings. The DB
   * (`Workspace.settings`) is the source of truth; this is the last-known
   * cache, exactly like `config.json`'s capability keys for a project.
   */
  private loadWorkspaceCapabilitySettings(): Record<string, unknown> {
    const raw = this.readConfigFile()
    return parseWorkspaceSettings(raw.workspaceCapabilities)
  }

  /**
   * Which surface this turn belongs to. Explicit `chatContext` wins; then the
   * surface recorded for the session when it last ran; then the boot mode.
   *
   * Only a runtime with NO anchor project is unambiguously the workspace agent.
   * A pinned runtime (`ws:proj:<anchor>`) serves both surfaces, so an
   * unlabelled turn there (a channel message, a heartbeat) is treated as a
   * project chat — the pre-split behaviour, and the safer default, because a
   * project chat must never be gated by workspace toggles.
   */
  resolveChatContext(sessionId?: string, chatContext?: ChatContext): ChatContext {
    const explicit = chatContext ?? (sessionId ? this.sessionChatContexts.get(sessionId) : undefined)
    if (explicit) return explicit
    return isWorkspaceRuntimeMode() && !process.env.WORKSPACE_ANCHOR_PROJECT_ID ? 'workspace' : 'project'
  }

  /** Record which surface a session runs in (the runtime told us per message). */
  rememberChatContext(sessionId: string, chatContext: ChatContext): void {
    if (sessionId) this.sessionChatContexts.set(sessionId, chatContext)
  }

  /**
   * Capability config for a turn's surface. `project` uses `this.config`
   * (cached from the anchor/own project's `Project.settings`); `workspace`
   * overlays the workspace agent's own toggles, with the workspace-scope
   * defaults applied for keys it has never stored.
   *
   * Everything else in the returned config is the runtime's: model, sandbox,
   * mode. Only capability decisions differ per surface.
   */
  configForTurn(sessionId?: string, chatContext?: ChatContext): GatewayConfig {
    if (this.resolveChatContext(sessionId, chatContext) !== 'workspace') return this.config
    const caps = resolveCapabilitiesForScope(
      {
        ...this.workspaceCapabilitySettings,
        capabilityProfile: this.config.capabilityProfile,
        activeMode: this.config.activeMode,
      },
      'workspace',
    )
    return { ...this.config, ...caps }
  }

  /** Name of a project in this runtime's catalog, for prompt titles. */
  private projectDisplayName(projectId: string | undefined): string | undefined {
    if (!projectId) return undefined
    const entry = [...workspaceProjectsManifest(), ...workspaceAvailableProjectsManifest()].find((p) => p.id === projectId)
    return entry?.name
  }

  /**
   * Register `.shogo/agents/*.md` types from the workspace root and, in a
   * workspace runtime, from every attached project. Idempotent; cheap enough
   * to run per turn.
   */
  syncCustomAgents(): void {
    try {
      const memberIds = isWorkspaceRuntimeMode() ? workspaceAttachedProjectIds() : []
      const customAgents = loadWorkspaceCustomAgents(this.workspaceDir, memberIds)
      const failed: string[] = []
      for (const def of customAgents) {
        const result = this.agentManager.register({
          name: def.name,
          description: def.description,
          systemPrompt: def.systemPrompt,
          toolNames: def.tools,
          disallowedTools: def.disallowedTools,
          model: def.model,
          maxTurns: def.maxTurns,
        })
        if (!result.ok) failed.push(`${def.name}: ${result.error}`)
      }
      const signature = customAgents.map((a) => a.name).join(',') + '|' + failed.join(',')
      if (signature === this.customAgentsSignature) return
      this.customAgentsSignature = signature
      for (const f of failed) console.warn(`[AgentGateway] Failed to register custom agent type ${f}`)
      if (customAgents.length > 0) {
        console.log(`[AgentGateway] Loaded ${customAgents.length} custom agent type(s) from .shogo/agents/: ${customAgents.map(a => a.name).join(', ')}`)
      }
    } catch (err: any) {
      console.warn(`[AgentGateway] Failed to load custom agent types: ${err?.message ?? err}`)
    }
  }

  async start(): Promise<void> {
    if (this.running) {
      console.warn('[AgentGateway] start() called but gateway is already running — skipping')
      return
    }
    console.log('[AgentGateway] Starting...')
    this.running = true

    // The database is the source of truth for capability toggles — the
    // project's `Project.settings`, and in a workspace runtime the workspace
    // agent's `Workspace.settings` too. Pull them before the first turn so a
    // stale config.json cannot override it. A failed pull keeps the last-known
    // cache; opt-in tools stay off when there is no cache yet.
    try {
      await this.syncCapabilitiesFromApi()
    } catch (err: any) {
      console.warn(`[AgentGateway] capability sync failed: ${err?.message ?? err}`)
    }

    try {
      cleanupTaskOutputs(taskOutputRoot(this.workspaceDir))
    } catch { /* best effort */ }

    migrateFromLegacySkills(this.workspaceDir)
    this.skills = loadAllSkills(this.workspaceDir)
    this.quickActions = loadQuickActions(this.workspaceDir)
    this.configSkills = this.loadConfigSkills()
    setLoadedSkills(this.skills)
    console.log(`[AgentGateway] Loaded ${this.skills.length} skills, ${this.configSkills.length} config skills, ${this.quickActions.length} quick actions`)

    await this.refreshHooks(true)

    // Connect channels
    for (const channelConfig of this.config.channels) {
      try {
        await this.connectChannel(channelConfig.type, channelConfig.config)
      } catch (error: any) {
        console.error(
          `[AgentGateway] Failed to connect ${channelConfig.type}:`,
          error.message
        )
      }
    }

    // Heartbeats are scheduled externally from the database; load a copy for
    // the status output (non-blocking, best effort).
    void this.refreshHeartbeatSnapshot()

    // Start configured MCP servers (stdio + remote)
    if (this.config.mcpServers && Object.keys(this.config.mcpServers).length > 0) {
      try {
        await this.mcpClientManager.startAll(this.config.mcpServers)
      } catch (error: any) {
        console.error('[AgentGateway] MCP server startup error:', error.message)
      }
    }

    if (this.config.remoteMcpServers && Object.keys(this.config.remoteMcpServers).length > 0) {
      try {
        await this.mcpClientManager.startAllRemote(this.config.remoteMcpServers)
      } catch (error: any) {
        console.error('[AgentGateway] Remote MCP server startup error:', error.message)
      }
    }

    // The API server (root server.tsx) is owned by PreviewManager — see
    // server.ts. The shim below just exposes its status to tools/prompts.
    try {
      const { started, port } = await this.skillServerManager.start()
      if (started) {
        console.log(`[AgentGateway] API server already running on port ${port}`)
      }
    } catch (error: any) {
      console.error('[AgentGateway] API server status check error:', error.message)
    }

    // Composio session init is deferred to per-request (processChatMessageStream)
    // so it uses the real authenticated user ID, not a static default.
    if (isComposioEnabled()) {
      console.log('[AgentGateway] Composio enabled — session will init on first chat request with user context')
    }

    // Initialize session persistence and restore sessions
    this.sessionPersistence = new SqliteSessionPersistence(this.workspaceDir)
    this.sessionManager.setPersistence(this.sessionPersistence)
    await this.sessionManager.restoreSessions()

    if (this.sessionPersistence) {
      this.agentManager.attachPersistence(this.sessionPersistence)
      this.teamManager = new TeamManager(this.sessionPersistence)
    }

    // Auto-register custom subagent types from `.shogo/agents/<name>.md` so
    // `agent_spawn({ type: "<name>" })` resolves them without the coordinator
    // having to fall back to `general-purpose` or manually re-declare them via
    // `agent_create` on every session. This was previously dead wiring —
    // `loadCustomAgents()` existed and `.shogo/agents/*.md` files were the
    // documented source of truth (see subagent.ts's own header comment), but
    // nothing ever called it at startup, so every project relying on custom
    // `.shogo/agents/` types (e.g. the issue-pipeline-solo template) silently
    // got "Unknown agent type" for every one of them.
    //
    // MUST run after `attachPersistence()` above, not in the constructor:
    // `attachPersistence()` does `this.registry.clear()` then hydrates from
    // the DB, so anything registered before it (e.g. in the constructor) gets
    // silently wiped the moment `start()` reaches this point. `persist=false`:
    // these come from disk and should reflect the current file content on
    // every boot, not fork into a separate DB-persisted copy that can drift
    // from it.
    this.syncCustomAgents()

    // Phase 2.1 — forward sub-agent cost metrics (with quality signals) to the
    // API server. Without this wiring the AgentManager's emitCostMetric()
    // callback is dangling and AgentCostMetric rows never get written for any
    // sub-agent runs, only main-chat. We also send the multi-signal fields so
    // the recommendation gate can compute real success rates.
    this.agentManager.onCostMetric((data) => {
      const workspaceId = process.env.WORKSPACE_ID || null
      if (!workspaceId) return // local-only test runs without a workspace
      const pipelineRunId = this.currentPipelineRunId()
      void postCostMetric({
        workspaceId,
        projectId: projectScopedId(this.projectId),
        ...(pipelineRunId ? { metadata: { pipelineRunId } } : {}),
        agentRunId: data.agentRunId,
        agentType: data.agentType,
        model: data.model,
        inputTokens: data.inputTokens,
        outputTokens: data.outputTokens,
        cachedInputTokens: data.cachedInputTokens,
        cacheWriteTokens: data.cacheWriteTokens,
        toolCalls: data.toolCalls,
        creditCost: data.creditCost,
        wallTimeMs: data.wallTimeMs,
        success: data.success,
        hitMaxTurns: data.hitMaxTurns,
        loopDetected: data.loopDetected,
        escalated: data.escalated,
        responseEmpty: data.responseEmpty,
      })
    })

    // Wire up LLM-powered summarization for context compaction. The model is
    // the admin-selected summarizer (Hoshi 2.0 by default) and must run on its
    // own provider, never the session's: the proxy routes by provider, so a
    // mismatched pair sends the model to the wrong upstream.
    const summarizerModel = resolveSummarizerModel(process.env.AGENT_SUMMARIZER_MODEL)
    console.log(`[AgentGateway] Summarizer model: ${summarizerModel.id} (provider=${summarizerModel.provider})`)
    this.sessionManager.setSummarizeFn(async (messages, previousSummary) => {
      const { resolveModel: rm, resolveApiKey: rak } = await import('./pi-adapter')
      const { runAgentLoop: summarizeLoop } = await import('./agent-loop')
      const provider = summarizerModel.provider
      const apiKey = rak(rm(provider, summarizerModel.id).provider)
      if (!apiKey) throw new Error('No API key for summarization')

      // No truncation: the caller chunks the head at `summarizeChunkTokens`
      // so each excerpt is already bounded. The old 500-char-per-message /
      // 12k-char-prompt caps threw away ~99% of a long turn — including the
      // decisions the summary exists to preserve (SHO-96).
      //
      // Every toolCall is rendered, with its arguments, as `→ tool: name(args)`
      // (compaction-transcript.ts). Without that line the summarizer can only
      // write narration, and a model acting on narration invents a tool name
      // — `str_replace` was called eight times that way (SHO-122).
      const messageTexts = renderTranscriptForSummary(messages)

      // Fold: when this excerpt follows an earlier chunk, the model must carry
      // the running summary forward instead of replacing it.
      const contract =
        'Output these sections, in this order, and nothing else:\n' +
        '## Decisions\n' +
        '## Files touched\n' +
        '## Current state\n' +
        '  (what is done, what is in progress, the next step)\n' +
        '## Tools used\n' +
        '  (exact names as `name` ×count)\n' +
        'Use only tool names that appear in the transcript — never invent one.'
      const system = previousSummary
        ? `You maintain a running summary of a long agent turn. You receive the running summary so far and a new excerpt of the conversation. Merge the excerpt into the running summary. Preserve: key decisions, files edited, errors encountered, and current task state. Drop only redundant detail.\n\n${contract}`
        : `Summarize the following conversation excerpt concisely. Preserve: key decisions, files edited, errors encountered, and current task state. Be factual and specific.\n\n${contract}`

      const prompt = previousSummary
        ? `Running summary so far:\n${previousSummary}\n\nNew excerpt:\n${messageTexts}`
        : messageTexts

      const result = await summarizeLoop({
        provider,
        model: summarizerModel.id,
        system,
        history: [],
        prompt,
        tools: [],
        maxIterations: 1,
        loopDetection: false,
        thinkingLevel: 'off',
      })
      return result.text || '(summary unavailable)'
    })

    // Start session pruning
    this.sessionManager.startPruning()

    // Run BOOT.md if it exists
    await this.runBootMd()

    // Emit gateway:startup hook
    await this.hookEmitter.emit(
      HookEmitter.createEvent('gateway', 'startup', 'system', {
        workspaceDir: this.workspaceDir,
        projectId: this.projectId,
      })
    )

    // Start LSP for canvas code diagnostics — deferred by 2s after gateway
    // start so the agent-runtime's /health endpoint is responsive first.
    // On Windows the typescript-language-server spawn + initialise handshake
    // alone keeps the event loop busy for ~5 s of subprocess setup and
    // JSON-RPC parsing; running it eagerly during gateway.start() pushed
    // the first responsive /health past the RuntimeManager's 30 s budget.
    // LSP is only needed once the user begins editing — the 2 s delay is
    // invisible in practice. Tunable via `SHOGO_LSP_START_DELAY_MS`.
    const lspDelayMs = parseInt(process.env.SHOGO_LSP_START_DELAY_MS ?? '2000', 10)
    setTimeout(() => {
      // Gate the LSP start on workspace deps being ready. Cold boot now
      // installs node_modules in the background (so the first chat message
      // streams immediately); starting tsserver before deps land would surface
      // a burst of spurious "cannot find module" diagnostics. We still start
      // within a bounded window so a stalled or missing install can't disable
      // the LSP forever — tsserver re-resolves once node_modules appears via
      // the chokidar -> didChangeWatchedFiles bridge. Tunable via
      // SHOGO_LSP_DEPS_WAIT_MS.
      const depsWaitMs = parseInt(process.env.SHOGO_LSP_DEPS_WAIT_MS ?? '60000', 10)
      const depsReady = this.workspaceDepsReady?.() ?? Promise.resolve()
      const cap = new Promise<void>(resolve => setTimeout(resolve, Math.max(0, depsWaitMs)))
      Promise.race([depsReady, cap])
        .then(() => this.startLSP())
        .catch(err => {
          console.warn(`${this.logPrefix} LSP startup failed (non-fatal):`, err.message)
        })
    }, Math.max(0, lspDelayMs))

    // Start canvas build manager for Vite builds (fire-and-forget)
    {
      // Self-heal: ensure src/main.tsx matches the canonical slim version.
      // Older workspaces baked the iframe bridge (toast / theme / SSE / error
      // forwarding) into main.tsx; that's now served live from
      // /agent/canvas/bridge.js, so the user-bundled file should only render
      // <App />. If it has drifted, rewrite it before kicking off the build.
      let needsRebuild = false
      try {
        const { migrateRuntimeTemplate } = require('./canvas-bridge-migration')
        const result = migrateRuntimeTemplate(this.workspaceDir)
        if (result.rewrote) needsRebuild = true
      } catch (err) {
        console.warn(`${this.logPrefix} Canvas bridge migration failed (non-fatal):`, (err as Error).message)
      }

      const watcher = this.canvasFileWatcher
      const pm = this.previewManager
      // Post-build type-check gate. Runs `tsc --noEmit` after each
      // successful build to catch the type errors Vite/esbuild transpiles
      // through (missing imports, boolean-as-component, wrong props) — the
      // dominant source of "Debug: runtime error" chats. Self-disables for
      // non-TS / tsc-less workspaces (see CanvasTypecheckGate.isApplicable).
      const typecheckGate = new CanvasTypecheckGate(this.workspaceDir)
      this.canvasTypecheckGate = typecheckGate
      // For Vite stacks, PreviewManager's `vite build --watch` is now
      // the only builder (see canvas-build-manager.ts file docstring on
      // the Windows EPERM race). Route the reload-toast signal through
      // it instead of CanvasBuildManager, which self-disables for vite
      // stacks. For Expo stacks vite-watch never starts and this
      // callback stays silent; CanvasBuildManager fires the reload as
      // before. Both paths also kick the type-check gate.
      pm?.setOnBuildComplete((info) => {
        if (info?.outputChanged !== false) watcher.broadcastReload()
        typecheckGate.trigger()
      })
      this.canvasBuildManager = new CanvasBuildManager(this.workspaceDir, {
        onBuildComplete: () => {
          watcher.broadcastReload()
          typecheckGate.trigger()
        },
        onBuildError: (err) => console.error(`${this.logPrefix} Canvas build error:`, err),
        // Block the first canvas build (and every subsequent one until
        // deps settle) on the preview manager's in-flight install. See
        // PreviewManager.depsReady for the full rationale; tl;dr this
        // is what stops VM-isolated macOS sessions from hitting
        // `Cannot find module @rollup/rollup-linux-arm64-gnu` when
        // host-installed node_modules is 9p-mounted into the guest.
        waitForDeps: pm ? () => pm.depsReady : undefined,
      })
      watcher.setOnRebuild((target) => {
        if (target.projectId) this.workspaceRebuild?.(target.projectId)
        else this.canvasBuildManager?.triggerRebuild()
      })
      this.canvasBuildManager.start().then(() => {
        // If the migration rewrote main.tsx, queue a rebuild so the slim
        // version replaces the stale dist/ output.
        if (needsRebuild) this.canvasBuildManager?.triggerRebuild()
      }).catch(err => {
        console.warn(`${this.logPrefix} Canvas build manager startup failed (non-fatal):`, err.message)
      })
    }

    // Index engine + workspace graph: previously pre-warmed in the
    // background on every gateway start. That meant every boot did a
    // full `readdir + stat` sweep of the workspace and a tree-sitter
    // parse of every code file — even when nothing had changed since
    // the last boot — which on a large polyglot workspace (e.g. a 9k-
    // file vendored C++/Python tree) held the JS main thread at ~95%
    // CPU for several minutes and made the chat proxy and /health
    // unresponsive for that whole window.
    //
    // The eager pre-warm is now gated off by default. The instances
    // are still constructed in `initIndexEngine()` (cheap — just
    // opens SQLite), so the lazy paths in `IndexEngine.search()` and
    // `getOrCreateGraph()` (gateway-tools.ts) still work and trigger
    // a scan on first use. Set `SHOGO_INDEX_PREWARM=1` to restore
    // the old behavior. The proper fix — incremental updates fed
    // from CanvasFileWatcher events plus a persisted "last scan"
    // timestamp so subsequent boots skip the full re-walk — is
    // tracked separately.
    // Pre-warm when explicitly requested, or whenever the search tool is
    // enabled — otherwise the first `search` call would trigger a multi-minute
    // lazy reindex and (now) hit the 10s tool timeout instead of returning hits.
    const prewarm =
      (process.env.SHOGO_INDEX_PREWARM ?? '').trim() === '1' ||
      (process.env.SHOGO_SEARCH_ENABLED ?? '').trim() === '1'
    const indexDelayMs = parseInt(process.env.SHOGO_INDEX_START_DELAY_MS ?? '3000', 10)
    if (prewarm) {
      setTimeout(() => this.initIndexEngine({ prewarm: true }), Math.max(0, indexDelayMs))
    } else {
      // Still construct the engine + graph so the lazy paths have
      // something to attach to; just skip the reindex/buildGraph work.
      setTimeout(() => this.initIndexEngine({ prewarm: false }), Math.max(0, indexDelayMs))
    }
    console.log('[AgentGateway] Started successfully')
    this.emitLog('Agent gateway started')
  }

  /**
   * Construct (and optionally pre-warm) the index engine + workspace
   * graph. Pre-warm is opt-in via `SHOGO_INDEX_PREWARM=1` — see the
   * call site in `start()` for the rationale. When `prewarm` is
   * false, this just wires up the instances so lazy callers
   * (`IndexEngine.search()`, `getOrCreateGraph()` in
   * gateway-tools.ts) have something to attach to; no scanning,
   * stat-ing, or tree-sitter parsing happens here.
   */
  private initIndexEngine(opts: { prewarm: boolean } = { prewarm: false }): void {
    try {
      const { IndexEngine, createDefaultConfig } = require('./index-engine')
      const engine = new IndexEngine(createDefaultConfig(this.workspaceDir))
      this.indexEngine = engine
      if (opts.prewarm) {
        engine.reindexBackground()
      } else {
        console.log(`${this.logPrefix} Index engine constructed (pre-warm disabled; first search will scan lazily)`)
      }

      try {
        const { WorkspaceGraph } = require('./workspace-graph')
        const { createDefaultExtractors } = require('./graph-extractors')
        const { CodeExtractor } = require('./code-extractor')
        const graph = new WorkspaceGraph(engine)
        const extractors = createDefaultExtractors()
        for (const ext of extractors) graph.registerExtractor(ext)
        engine.setGraph(graph)
        this.workspaceGraph = graph

        if (!opts.prewarm) {
          // Skip tree-sitter preload + graph build. The lazy
          // `getOrCreateGraph()` path in gateway-tools.ts will run
          // both on first tool call that needs them.
          return
        }

        const codeExt = extractors.find((e: any) => e instanceof CodeExtractor)
        const preloadPromise = codeExt?.preload?.() ?? Promise.resolve()
        preloadPromise.then(() => {
          setTimeout(async () => {
            try {
              await graph.buildGraph()
              try {
                const { traceFlows, storeFlows } = require('./flow-detector')
                const flows = traceFlows(graph)
                storeFlows(graph, flows)
              } catch (e: any) {
                console.warn(`${this.logPrefix} Flow detection failed (non-fatal):`, e.message)
              }
            } catch (e: any) {
              console.warn(`${this.logPrefix} Graph build failed (non-fatal):`, e.message)
            }
          }, 5000)
        }).catch((e: any) => {
          console.warn(`${this.logPrefix} Tree-sitter preload failed (non-fatal):`, e.message)
        })
      } catch (err: any) {
        console.warn(`${this.logPrefix} Workspace graph init failed (non-fatal):`, err.message)
      }
    } catch (err: any) {
      console.warn(`${this.logPrefix} Index engine pre-warm failed (non-fatal):`, err.message)
    }
  }

  private async startLSP(): Promise<void> {
    try {
      const thisDir = dirname(fileURLToPath(import.meta.url))
      const pkgDir = join(thisDir, '..')
      const searchDirs = [pkgDir, thisDir, this.workspaceDir]

      const tsResult = resolveBin('typescript-language-server', searchDirs, 'lib/cli.mjs')
      const pyResult = resolveBin('pyright', searchDirs)

      // Workspace runtime: the LSP root is the merged-tree parent, which has
      // no tsconfig of its own. tsserver still resolves each file's nearest
      // tsconfig per project, but the watch-exclusion patch must be applied
      // to each attached project's tsconfig so program loads skip
      // node_modules/dist. Single-project runtimes leave this empty.
      // Folder-linked members are skipped: their tsconfig is the user's own
      // file, which Shogo must not rewrite (external mode never did).
      const externalIds = workspaceExternalProjectIds()
      const tsconfigDirs = isWorkspaceRuntimeMode()
        ? workspaceAttachedProjectIds()
            .filter((id) => !externalIds.has(id))
            .map((id) => join(this.workspaceDir, id))
        : []

      this.lspManager = new WorkspaceLSPManager({
        projectDir: this.workspaceDir,
        tsServerBin: tsResult?.resolved,
        pyrightBin: pyResult?.resolved,
        tsconfigDirs,
      })
      await this.lspManager.startAll()
      // Bridge chokidar events into tsserver as
      // `workspace/didChangeWatchedFiles`. With the bridge in place
      // tsserver delegates all watching to chokidar (which the agent
      // runtime already runs) — without it tsserver falls back to
      // native inotify and burns ~44k watches per pod, saturating the
      // per-uid kernel quota. The bridge filter inside the LSP manager
      // restricts to TS-relevant paths; the per-glob filter inside
      // TSLanguageServer further restricts to paths the server
      // actually registered.
      const lspManagerRef = this.lspManager
      this.canvasFileWatcher.setLspBridge((absPath, kind) => {
        lspManagerRef.notifyWatchedFileEvent(absPath, kind)
      })
      console.log(`${this.logPrefix} LSP ready for workspace: ${this.workspaceDir}`)
    } catch (err: any) {
      console.warn(`${this.logPrefix} LSP init failed:`, err.message)
      this.lspManager = null
    }
  }

  async stop(): Promise<void> {
    console.log('[AgentGateway] Stopping...')
    this.running = false

    // Detach the bridge BEFORE stopping the LSP manager so a late
    // chokidar event during teardown doesn't try to write to a stopped
    // server (which would throw "Language server not running").
    this.canvasFileWatcher.setLspBridge(null)
    this.lspManager?.stop()
    this.lspManager = null

    // Kill every backgrounded shell command across all sessions. Exec no
    // longer has a hard-timeout SIGKILL ceiling, so this shutdown sweep is the
    // backstop that prevents long-running children from being orphaned when
    // the gateway goes away.
    for (const reg of this.commandRegistries.values()) {
      try { reg.killAll() } catch { /* already gone */ }
    }
    this.commandRegistries.clear()
    for (const timer of this.taskWakeTimers.values()) clearTimeout(timer)
    this.taskWakeTimers.clear()
    for (const poller of this.remoteTaskPollers.values()) clearInterval(poller)
    this.remoteTaskPollers.clear()

    this.sessionManager.destroy()
    this.sessionPersistence?.close()
    await this.skillServerManager.stop()
    this.canvasBuildManager?.stop()
    this.canvasTypecheckGate?.stop()
    // Without this, the `vite build --watch` child PreviewManager
    // spawned in `startBuildWatch()` survives the agent-runtime's
    // `process.exit(0)` in `gracefulShutdown` — it gets reparented to
    // launchd (PPID 1) and keeps rebuilding on every file change
    // forever. One orphan per restart cycle compounds quickly: a
    // single workspace was seen accumulating 20 vite watchers (oldest
    // ~36h old) before manual cleanup. The PreviewManager handle is
    // wired in via `attachApiServer()` (see below) and `stop()` is
    // synchronous + idempotent + safe to call when nothing is
    // running — same shape as `canvasBuildManager?.stop()` above.
    this.previewManager?.stop()
    await this.mcpClientManager.stopAll()

    this.workspaceGraph = null
    try { this.indexEngine?.close() } catch { /* best-effort */ }
    this.indexEngine = null

    for (const [name, adapter] of this.channels) {
      try {
        await adapter.disconnect()
        console.log(`[AgentGateway] Disconnected ${name}`)
      } catch (error: any) {
        console.error(`[AgentGateway] Error disconnecting ${name}:`, error.message)
      }
    }
    this.channels.clear()

    await this.hookEmitter.emit(
      HookEmitter.createEvent('gateway', 'shutdown', 'system', {
        workspaceDir: this.workspaceDir,
      })
    )

    console.log('[AgentGateway] Stopped')
  }

  // ---------------------------------------------------------------------------
  // BOOT.md
  // ---------------------------------------------------------------------------

  private async runBootMd(): Promise<void> {
    const bootPath = join(this.workspaceDir, 'BOOT.md')
    if (!existsSync(bootPath)) return

    const bootContent = readFileSync(bootPath, 'utf-8').trim()
    if (!bootContent) return

    console.log('[AgentGateway] Running BOOT.md...')
    try {
      const response = await this.agentTurn(
        `[BOOT]\nYou are starting up. Execute the following startup instructions:\n\n${bootContent}`,
        'boot'
      )
      console.log('[AgentGateway] BOOT.md result:', response.substring(0, 200))
    } catch (error: any) {
      console.error('[AgentGateway] BOOT.md execution failed:', error.message)
    }
  }

  // ---------------------------------------------------------------------------
  // Heartbeat
  // ---------------------------------------------------------------------------


  /**
   * Cached copy of this project's schedule from the database, for the status
   * output only. The scheduler (not the runtime) decides when heartbeats run.
   */
  private heartbeatSnapshot: {
    enabled: boolean
    intervalSeconds: number
    quietHours: { start: string; end: string; timezone: string }
  } = {
    enabled: false,
    intervalSeconds: 1800,
    quietHours: { start: '', end: '', timezone: 'UTC' },
  }

  /** Reload the cached schedule from the project config API (best effort). */
  async refreshHeartbeatSnapshot(): Promise<void> {
    const projectId = projectScopedId(this.projectId) ?? projectScopedId(process.env.WORKSPACE_ANCHOR_PROJECT_ID)
    if (!projectId) return
    try {
      const res = await getProjectConfig(projectId)
      const agent = res.ok ? res.data?.agent : null
      if (!agent) return
      this.heartbeatSnapshot = {
        enabled: agent.heartbeatEnabled,
        intervalSeconds: agent.heartbeatInterval,
        quietHours: {
          start: agent.quietHoursStart ?? '',
          end: agent.quietHoursEnd ?? '',
          timezone: agent.quietHoursTimezone ?? 'UTC',
        },
      }
    } catch {
      /* status falls back to defaults */
    }
  }

  /**
   * Run one heartbeat. Quiet hours are enforced by the API scheduler (the
   * schedule lives in the database), so a tick that reaches here always runs.
   *
   * A workspace runtime serves several attached projects, so the caller says
   * which one is due: `projectDir` is where its `HEARTBEAT.md` lives and
   * `projectId` tells the agent which project the checklist belongs to.
   * Defaults to the gateway's own workspace dir (single-project runtimes).
   */
  async heartbeatTick(opts: { projectId?: string; projectDir?: string } = {}): Promise<string> {
    this.lastHeartbeatTick = new Date()

    const projectDir = opts.projectDir ?? this.workspaceDir
    const heartbeatPath = resolveWorkspaceConfigFilePath(projectDir, 'HEARTBEAT.md')
    if (!heartbeatPath) {
      return 'HEARTBEAT_OK'
    }

    const checklist = readFileSync(heartbeatPath, 'utf-8').trim()
    if (!checklist) {
      return 'HEARTBEAT_OK'
    }

    console.log('[AgentGateway] Running heartbeat...')
    this.emitLog('Running heartbeat...')

    let pendingSection = ''
    if (this.pendingEvents.length > 0) {
      pendingSection = `\n\n[Pending Events]\n${this.pendingEvents.join('\n')}`
      this.pendingEvents = []
    }

    // In a workspace runtime the checklist belongs to one attached project,
    // whose files live in a subfolder of the merged root.
    const projectLine =
      opts.projectId && projectDir !== this.workspaceDir
        ? ` for project ${opts.projectId} (its files are under \`${opts.projectId}/\`)`
        : ''

    const response = await this.agentTurn(
      `[HEARTBEAT]\nYou are performing a scheduled heartbeat check${projectLine}. Review the following checklist and take action as needed. If everything is fine, respond with exactly "HEARTBEAT_OK". If something needs attention, describe the issue and any actions taken.\n\n${checklist}${pendingSection}`,
      'heartbeat',
      true
    )

    await this.hookEmitter.emit(
      HookEmitter.createEvent('heartbeat', 'tick', 'heartbeat', {
        workspaceDir: projectDir,
        response,
        hadAlert: response !== 'HEARTBEAT_OK',
      })
    )

    if (response !== 'HEARTBEAT_OK') {
      console.log('[AgentGateway] Heartbeat alert:', response.substring(0, 200))
      this.emitLog(`Heartbeat alert: ${response.substring(0, 200)}`)
      await this.deliverAlert(response)

      await this.hookEmitter.emit(
        HookEmitter.createEvent('heartbeat', 'alert', 'heartbeat', {
          workspaceDir: projectDir,
          alertText: response,
        })
      )
    } else {
      console.log('[AgentGateway] Heartbeat OK')
      this.emitLog('Heartbeat OK')
    }

    const heartbeatSummary = response === 'HEARTBEAT_OK' ? 'Routine check — all clear' : response.substring(0, 300)
    this.appendDailyMemory(`Heartbeat: ${response === 'HEARTBEAT_OK' ? 'All clear' : response.substring(0, 200)}`)
    this.appendHeartbeatLog(heartbeatSummary, projectDir)

    return response
  }

  async triggerHeartbeat(opts: { projectId?: string; projectDir?: string } = {}): Promise<string> {
    return this.heartbeatTick(opts)
  }

  queuePendingEvent(text: string): void {
    this.pendingEvents.push(text)
  }

  // ---------------------------------------------------------------------------
  // Message Processing
  // ---------------------------------------------------------------------------

  async processMessage(input: IncomingMessage): Promise<void> {
    this.emitLog(`Channel message from ${input.channelType || 'unknown'}: "${(input.text || '').substring(0, 100)}"`)
    const sessionId = input.channelId || 'default'
    const qs = this.getQueueState(sessionId)
    // Same load-on-miss rule as the chat path: a channel turn on a cold pod
    // must read the stored conversation, not create an empty one (SHO-137).
    await this.sessionManager.getOrCreateAsync(sessionId)

    await this.hookEmitter.emit(
      HookEmitter.createEvent('message', 'received', sessionId, {
        workspaceDir: this.workspaceDir,
        from: input.senderId,
        content: input.text,
        channelId: input.channelId,
        channelType: input.channelType,
      })
    )

    qs.queue.push(input)

    if (!qs.processing) {
      await this.processQueue(sessionId, qs)
    }
  }

  private queueState: Map<string, { queue: IncomingMessage[]; processing: boolean }> = new Map()

  private getQueueState(sessionId: string) {
    let state = this.queueState.get(sessionId)
    if (!state) {
      state = { queue: [], processing: false }
      this.queueState.set(sessionId, state)
    }
    return state
  }

  private async processQueue(
    sessionId: string,
    qs: { queue: IncomingMessage[]; processing: boolean }
  ): Promise<void> {
    qs.processing = true
    const session = this.sessionManager.getOrCreate(sessionId)
    session.stopRequested = false

    while (qs.queue.length > 0 && !session.stopRequested) {
      const message = qs.queue.shift()!

      // Apply channel-configured model (defaults to 'basic' for safe billing).
      // Only accept known values to prevent config.json tampering from bypassing tiers.
      if (message.channelType) {
        const channelDef = this.config.channels.find(c => c.type === message.channelType)
        const model = channelDef?.model
        session.modelOverride = (model === 'basic' || model === 'advanced') ? model : 'basic'
        // Channel models carry no provider hint; clear any stale one so the
        // provider is inferred from this id.
        session.modelProvider = undefined
        session.modelDisplayName = undefined
      }

      try {
        const cmdResult = parseSlashCommand(message.text, this.buildSlashContext(sessionId))
        if (cmdResult.handled) {
          const response = cmdResult.response || ''

          if (cmdResult.hookEvent) {
            await this.hookEmitter.emit(
              HookEmitter.createEvent(
                cmdResult.hookEvent.type,
                cmdResult.hookEvent.action,
                sessionId,
                {
                  ...cmdResult.hookEvent.context,
                  senderId: message.senderId,
                  channelType: message.channelType,
                }
              )
            )
          }

          if (cmdResult.hookEvent?.action === 'stop') {
            session.stopRequested = true
          }

          if (response && message.channelId && this.channels.has(message.channelType || '')) {
            const adapter = this.channels.get(message.channelType!)
            await adapter?.sendMessage(message.channelId, response)
          }

          continue
        }

        const matchedSkill = matchSkill(this.skills, message.text)
        let prompt = message.text
        let activeSkill: { name: string } | undefined

        if (matchedSkill) {
          prompt = buildSkillMatchPrompt(matchedSkill, message.text)
          activeSkill = { name: matchedSkill.name }
        }

        const adapter = (message.channelId && this.channels.has(message.channelType || ''))
          ? this.channels.get(message.channelType!)
          : undefined
        const streamTarget = adapter && message.channelId
          ? { adapter, channelId: message.channelId }
          : undefined

        const response = await this.agentTurn(prompt, sessionId, false, streamTarget, undefined, activeSkill)

        if (adapter && message.channelId && !this.config.streamChunk) {
          await adapter.sendMessage(message.channelId, response)
        }

        await this.hookEmitter.emit(
          HookEmitter.createEvent('message', 'sent', sessionId, {
            workspaceDir: this.workspaceDir,
            to: message.channelId,
            content: response,
            channelType: message.channelType,
          })
        )

        this.appendDailyMemory(
          `${message.channelType || 'test'}: "${message.text.substring(0, 100)}" -> "${response.substring(0, 100)}"`
        )
      } catch (error: any) {
        console.error('[AgentGateway] Message processing error:', error.message)
      }
    }

    qs.processing = false
  }

  private isUnconfigured(): boolean {
    if (this.skills.length > 0 || this.configSkills.length > 0) return false
    const agentsPath = resolveWorkspaceConfigFilePath(this.workspaceDir, 'AGENTS.md')
    if (!agentsPath) return true
    const content = readFileSync(agentsPath, 'utf-8')
    return content.includes('Respond concisely and helpfully') && content.includes('# Agent Instructions')
  }

  private buildSetupPrompt(userText: string): string {
    return `[Agent Setup — First Message]\nThis is a brand new agent that has not been configured yet. The user's message below describes what they want the agent to do. Use your tools to set up the agent:\n\n1. Write AGENTS.md with all sections: # Identity (name, emoji, tagline), # Personality (tone, boundaries), # User (preferences), and # Operating Instructions (specific to this use case — IMPORTANT: replace the default content)\n2. Write HEARTBEAT.md with a relevant checklist only if the agent has wall-clock work (daily digests, inbox sweeps) or needs a stall safety net\n3. Create any relevant skills in the skills/ directory\n4. Update config.json if heartbeat should be enabled. Work the agent starts or hands off reports back through task updates, so it never needs a heartbeat to follow it\n\nAfter setting up, give the user a brief summary of what you configured.\n\n[User Message]\n${userText}`
  }

  private buildChatPrompt(text: string): { prompt: string; activeSkill?: { name: string } } {
    const matchedSkill = matchSkill(this.skills, text)
    if (matchedSkill) {
      this.emitLog(`Matched skill: ${matchedSkill.name}`)
      const prompt = buildSkillMatchPrompt(matchedSkill, text)
      return { prompt, activeSkill: { name: matchedSkill.name } }
    }
    return { prompt: `[Chat — User Message]\nThis is a direct message from a user, NOT a heartbeat trigger. Respond conversationally and helpfully. Do NOT respond with HEARTBEAT_OK.\n\n${text}` }
  }

  async processChatMessage(text: string): Promise<string> {
    this.emitLog(`Chat message received: "${text.substring(0, 100)}"`)

    let prompt: string
    let activeSkill: { name: string } | undefined
    if (this.isUnconfigured()) {
      prompt = this.buildSetupPrompt(text)
      this.emitLog('Agent is not configured — running setup from user message')
    } else {
      const result = this.buildChatPrompt(text)
      prompt = result.prompt
      activeSkill = result.activeSkill
    }

    const response = await this.agentTurn(prompt, 'chat', false, undefined, undefined, activeSkill)
    this.emitLog(`Chat response: "${response.substring(0, 100)}"`)

    this.appendDailyMemory(`chat: "${text.substring(0, 100)}" -> "${response.substring(0, 100)}"`)

    return response
  }

  /**
   * Streaming variant of processChatMessage that pipes text deltas and
   * tool call events to a UI message stream writer (AI SDK protocol).
   */
  async processChatMessageStream(
    text: string,
    writer: { write(chunk: Record<string, any>): void },
    options?: {
      modelOverride?: string
      /** Native provider hint from the API server (resolved from the model
       *  registry), paired with `modelOverride`. Lets a DB model addressed by
       *  an opaque UUID route to its real provider (e.g. `anthropic`) instead
       *  of being inferred as `custom`. Absent → id-based inference. */
      modelProvider?: string
      /** The product name of the model `modelOverride` names (e.g. "Hoshi
       *  2.0"), stamped by the same request. Used for the per-turn Account
       *  line so it never quotes a different turn's model (SHO-145). */
      modelDisplayName?: string
      fileParts?: FilePart[]
      userId?: string
      /** API-signed proof of who sent this message (see integration-credentials.ts). */
      requesterTicket?: string
      interactionMode?: 'agent' | 'plan' | 'ask'
      confirmedPlan?: { name: string; overview: string; plan: string; todos?: Array<{ id: string; content: string }>; filepath?: string }
      dualPlan?: boolean
      chatSessionId?: string
      /** Surface this chat belongs to (workspace agent vs a project's own chat). */
      chatContext?: ChatContext
    },
  ): Promise<void> {
    // chatSessionId is REQUIRED. The runtime's HTTP layer enforces this
    // at the edge, but the gateway is also reachable through in-process
    // entry points (tests, evals, future internal channels), so guard
    // here too. Falling back to a literal `'chat'` here used to collapse
    // every no-id call into a single shared SessionManager bucket per
    // project pod, leaking conversation history across chats. See the
    // regression test at
    // `packages/agent-runtime/src/__tests__/chat-session-fallback-leak.test.ts`.
    if (!options?.chatSessionId || typeof options.chatSessionId !== 'string' || options.chatSessionId.trim() === '') {
      throw new Error('processChatMessageStream: chatSessionId is required')
    }
    const sessionId = options.chatSessionId
    // A turn must never start from a fabricated empty session. In-process
    // callers (channels, evals, project_call) reach the gateway directly, so
    // the load-on-miss guarantee has to hold here too, not only at the HTTP
    // edge: on a cold pod `getOrCreate` would create an empty session and the
    // next persist would overwrite the conversation on disk (SHO-137).
    await this.sessionManager.getOrCreateAsync(sessionId)
    if (options?.modelOverride) {
      const session = this.sessionManager.getOrCreate(sessionId)
      session.modelOverride = options.modelOverride
      // Keep the provider hint paired with the override. Assigned even when
      // undefined so a previously-hinted model can't leave a stale provider
      // behind once the selection changes.
      session.modelProvider = options.modelProvider
      // The display name is paired with the same override — it names the model
      // that selection resolves to, so the Account line can quote it without
      // trusting any other request's stamp (SHO-145).
      session.modelDisplayName = options.modelDisplayName
      // Remember the hint beyond this session so subagents, forks and
      // channel turns that run the same model infer the same provider.
      rememberProviderHint(resolveModelId(options.modelOverride), options.modelProvider)
    }

    if (options?.userId) {
      this.currentUserId = options.userId
      if (isComposioEnabled()) {
        const workspaceId = process.env.WORKSPACE_ID || 'default'
        const scopeEnv = process.env.COMPOSIO_USER_SCOPE
        const scope: 'workspace' | 'project' =
          scopeEnv === 'workspace' || scopeEnv === 'project' ? scopeEnv : 'workspace'
        await initComposioSession(options.userId, workspaceId, this.projectId, scope)
      }
    }

    this.emitLog(`Chat message received (stream): "${text.substring(0, 100)}"`)

    let images: ImageContent[] | undefined
    let effectiveText = text
    if (options?.fileParts && options.fileParts.length > 0) {
      const parsed = parseFileAttachments(options.fileParts)
      if (parsed.images.length > 0) {
        images = parsed.images
        this.emitLog(`Attached ${parsed.images.length} image(s) for vision`)
      }
      let textContext = parsed.textContext
      if (parsed.audioParts.length > 0) {
        // No model reachable from this loop accepts native audio content
        // blocks (pi-ai's `Model.input` type only allows `"text" | "image"`),
        // so every audio attachment is auto-transcribed via Whisper and
        // injected as text context, regardless of which model is selected.
        this.emitLog(`Transcribing ${parsed.audioParts.length} audio attachment(s)...`)
        const audioTranscripts = await transcribeAudioParts(parsed.audioParts)
        textContext = [textContext, audioTranscripts].filter(Boolean).join('\n\n')
      }
      if (textContext) {
        effectiveText = text
          ? `${text}\n\n${textContext}`
          : textContext
      }
    }

    // If a confirmed plan is present, prepend it as context to the user's message
    if (options?.confirmedPlan) {
      const cp = options.confirmedPlan
      const todoList = (cp.todos ?? []).map(t => `- [ ] ${t.content}`).join('\n')
      const planContext = [
        'The user has confirmed the following plan. Execute it step by step:',
        '',
        `## ${cp.name}`,
        cp.overview,
        cp.filepath ? `Saved plan: ${cp.filepath}` : '',
        '',
        cp.plan,
        '',
        '## Tasks',
        todoList,
        '',
        'Proceed with execution now.',
      ].join('\n')
      effectiveText = effectiveText
        ? `${planContext}\n\n---\n\nUser message: ${effectiveText}`
        : planContext
    }

    let prompt: string
    let activeSkill: { name: string } | undefined
    if (this.isUnconfigured()) {
      prompt = this.buildSetupPrompt(effectiveText)
      this.emitLog('Agent is not configured — running setup from user message')
    } else {
      const result = this.buildChatPrompt(effectiveText)
      prompt = result.prompt
      activeSkill = result.activeSkill
    }

    const interactionMode = options?.confirmedPlan ? 'agent' : (options?.interactionMode || 'agent')
    const dualPlan = options?.dualPlan === true
    console.log(`[Gateway][processChatMessageStream] resolved interactionMode: ${interactionMode} (options had: ${options?.interactionMode ?? '(undefined)'}), dualPlan: ${dualPlan}, sessionId: ${sessionId}, activeSkill: ${activeSkill ?? '(none)'}`)
    const response = await this.agentTurn(prompt, sessionId, false, undefined, writer, activeSkill, images, interactionMode, dualPlan, options?.requesterTicket, options?.chatContext)
    this.emitLog(`Chat response (stream): "${response.substring(0, 100)}"`)

    this.appendDailyMemory(`chat: "${text.substring(0, 100)}" -> "${response.substring(0, 100)}"`)
  }

  async processWebhookMessage(text: string): Promise<string> {
    return this.agentTurn(text, 'webhook')
  }

  /**
   * Pipeline runs currently executing in this gateway, keyed by session.
   * `project_call` threads a `runId` across project hops; while a run's turn
   * is in flight every sub-agent cost metric emitted here is stamped with
   * `metadata.pipelineRunId` so an issue can be traced across projects.
   */
  private activePipelineRuns = new Map<string, string>()

  /**
   * The pipeline run to stamp on a cost metric emitted right now. Cost
   * metrics carry no session id, so this is unambiguous only when a single
   * run is active; with concurrent runs we skip the stamp rather than guess.
   */
  private currentPipelineRunId(): string | undefined {
    if (this.activePipelineRuns.size !== 1) return undefined
    return this.activePipelineRuns.values().next().value
  }

  /**
   * Run one agent turn on behalf of another project (`project_call`).
   * Each run gets its own session (`run:<runId>`) so the callee's transcript
   * for that run is isolated and replayable.
   */
  async processPipelineCall(opts: {
    message: string
    runId?: string
    sessionId?: string
    callerProjectId?: string
    /** The calling turn's person, handed off by the API for this project. */
    requesterTicket?: string
    /** Streams the turn so a chat open on this session can watch it live. */
    writer?: { write(chunk: Record<string, any>): void }
  }): Promise<{ reply: string; sessionId: string; runId?: string }> {
    const runId = opts.runId?.trim() || undefined
    const sessionId = opts.sessionId?.trim() || (runId ? `run:${runId}` : 'pipeline')
    const header = [
      runId ? `[pipeline runId=${runId}]` : null,
      opts.callerProjectId ? `[from project ${opts.callerProjectId}]` : null,
    ].filter(Boolean).join(' ')
    const prompt = header ? `${header}\n${opts.message}` : opts.message

    if (runId) this.activePipelineRuns.set(sessionId, runId)
    this.unattendedSessions.add(sessionId)
    try {
      const reply = await this.agentTurn(
        prompt, sessionId, false, undefined, opts.writer, undefined, undefined, 'agent', false, opts.requesterTicket,
      )
      return { reply, sessionId, runId }
    } finally {
      this.activePipelineRuns.delete(sessionId)
      this.unattendedSessions.delete(sessionId)
    }
  }

  /**
   * Sessions whose turn nobody started from a chat (pipeline calls). Their
   * turn may stream to a watcher, but permission asks still fail closed:
   * no one is there to answer them.
   */
  private unattendedSessions = new Set<string>()

  private buildSlashContext(sessionId: string): SlashCommandContext {
    const session = this.sessionManager.getOrCreate(sessionId)
    return {
      sessionKey: sessionId,
      workspaceDir: this.workspaceDir,
      clearHistory: () => this.clearSessionHistory(sessionId),
      getMessages: () => [...session.messages],
      reloadConfig: () => this.reloadConfig(),
      setModelOverride: (model: string) => {
        session.modelOverride = model
        // Slash-command/programmatic override carries no provider hint; clear
        // any stale one so the provider is inferred from this id.
        session.modelProvider = undefined
        session.modelDisplayName = undefined
      },
      getStatus: () => this.getStatus(),
    }
  }

  // ---------------------------------------------------------------------------
  // Backgrounded shell command bookkeeping (per-session)
  // ---------------------------------------------------------------------------

  private getOrCreateCommandRegistry(sessionId: string): TaskRegistry {
    let reg = this.commandRegistries.get(sessionId)
    if (!reg) {
      const outputDir = taskOutputDir(this.workspaceDir, sessionId)
      const registry = new TaskRegistry({
        outputDir,
        workspaceDir: this.workspaceDir,
        remote: hasInternalApiCredentials() ? createApiTaskClient() : undefined,
        // A late `wait` on a task whose entry was evicted reads the result back
        // from its log instead of reporting the task as unknown.
        resolveOutputRow: (id) => listTaskOutputRows(outputDir).find((row) => row.taskId === id) ?? null,
      })
      reg = registry

      // Re-seed from the persisted snapshot so a thread reopened after a
      // runtime restart still shows its tasks. Local ones are stale (the OS
      // children belonged to the dead gateway); API-tracked ones stay live.
      const persisted = this.sessionManager.get(sessionId)?.metadata?.runningProcesses
      if (Array.isArray(persisted) && persisted.length > 0) {
        registry.restoreStale(persisted)
      }

      // Persist the running list on every change so it survives reconnect and
      // restart via .shogo/sessions.db (synced to S3). Task start/exit is
      // rare relative to message volume, so this write is cheap.
      registry.onChange(() => {
        this.sessionManager.setSessionMetadata(sessionId, { runningProcesses: registry.snapshot() })
      })
      registry.onNotification(() => this.scheduleTaskWake(sessionId))

      this.commandRegistries.set(sessionId, registry)
      // `sessionManager.get()` is memory-only: on a cold process the session is
      // not loaded yet, so the seed above sees nothing. Load it once and retry,
      // then fall back to the per-task logs when no snapshot survived.
      this.hydrateCommandRegistry(sessionId, registry).catch(() => {})
    }
    return reg
  }

  private hydratingRegistries = new Map<string, Promise<void>>()

  /**
   * Seed a cold registry from the loaded session (or, failing that, the
   * per-task logs). Returns the in-flight promise so callers that answer a
   * request can wait for it: `sessionManager.get()` is memory-only, and a
   * client that receives an empty dock never asks again.
   */
  private hydrateCommandRegistry(sessionId: string, registry: TaskRegistry): Promise<void> {
    const inflight = this.hydratingRegistries.get(sessionId)
    if (inflight) return inflight
    const pending = (async () => {
      try {
        const session = await this.sessionManager.getOrCreateAsync(sessionId)
        // Another caller already re-seeded this registry from the loaded session.
        if (registry.listDock().length > 0) return
        const persisted = session.metadata?.runningProcesses
        if (Array.isArray(persisted) && persisted.length > 0) {
          registry.restoreStale(persisted)
          return
        }
        const rows = listTaskOutputRows(taskOutputDir(this.workspaceDir, sessionId))
        if (rows.length > 0) registry.restoreFromOutputRows(rows)
      } catch {
        // Best effort: a dock that starts empty beats a failed first request.
      } finally {
        this.hydratingRegistries.delete(sessionId)
      }
    })()
    this.hydratingRegistries.set(sessionId, pending)
    return pending
  }

  // ---------------------------------------------------------------------------
  // Idle wake: a task finished while no turn is running
  // ---------------------------------------------------------------------------

  private taskWakeTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private taskWakeRetries = new Map<string, { attempts: number; timer: ReturnType<typeof setTimeout> }>()
  private remoteTaskPollers = new Map<string, ReturnType<typeof setInterval>>()

  /**
   * Coalesce finished-task notes for an idle session and hand them to the API,
   * which queues one wake message per task. While a turn runs, notes are
   * injected into it instead (takeInjectedMessages) and the turn's end
   * re-schedules this.
   * API-tracked tasks are skipped: the API wakes the session for those itself.
   */
  private scheduleTaskWake(sessionId: string): void {
    if (this.turnAbortControllers.has(sessionId) || this.taskWakeTimers.has(sessionId)) return
    const timer = setTimeout(() => {
      this.taskWakeTimers.delete(sessionId)
      void this.flushTaskWake(sessionId)
    }, TASK_WAKE_COALESCE_MS)
    ;(timer as any).unref?.()
    this.taskWakeTimers.set(sessionId, timer)
  }

  private async flushTaskWake(sessionId: string): Promise<void> {
    const reg = this.commandRegistries.get(sessionId)
    if (!reg || this.turnAbortControllers.has(sessionId)) return
    const notes = reg.peekNotifications().filter((n) => !reg.get(n.taskId)?.apiTracked && !reg.get(n.taskId)?.reported)
    if (notes.length === 0) {
      this.clearTaskWakeRetry(sessionId)
      return
    }
    if (!hasInternalApiCredentials()) {
      this.scheduleTaskWakeRetry(sessionId)
      return
    }
    const res = await notifyTaskCompletions(sessionId, notes.map((n) => ({
      id: n.taskId,
      source: n.source,
      title: n.title,
      status: n.status,
      text: formatTaskNotification(n),
    })))
    if (res.ok) {
      reg.markReported(notes.map((n) => n.taskId))
      this.clearTaskWakeRetry(sessionId)
    } else {
      console.warn(`${this.logPrefix} Task wake for ${sessionId} failed: ${res.error ?? res.status}`)
      this.scheduleTaskWakeRetry(sessionId)
    }
  }

  /** Retry a wake the API refused; the note is still unreported, so one more flush delivers it. */
  private scheduleTaskWakeRetry(sessionId: string): void {
    const existing = this.taskWakeRetries.get(sessionId)
    if (existing) clearTimeout(existing.timer)
    const attempts = existing?.attempts ?? 0
    const delay = TASK_WAKE_RETRY_MS[Math.min(attempts, TASK_WAKE_RETRY_MS.length - 1)]!
    const timer = setTimeout(() => {
      if (this.taskWakeRetries.get(sessionId)?.timer !== timer) return
      void this.flushTaskWake(sessionId)
    }, delay)
    ;(timer as any).unref?.()
    this.taskWakeRetries.set(sessionId, { attempts: attempts + 1, timer })
  }

  private clearTaskWakeRetry(sessionId: string): void {
    const existing = this.taskWakeRetries.get(sessionId)
    if (!existing) return
    clearTimeout(existing.timer)
    this.taskWakeRetries.delete(sessionId)
  }

  /**
   * Tasks mirrored from another project's runtime have no API row to wake the
   * session, so while idle the gateway polls them itself.
   */
  private ensureRemoteTaskPoller(sessionId: string): void {
    const reg = this.commandRegistries.get(sessionId)
    const needsPolling = (e: { apiTracked?: boolean }) => !e.apiTracked
    if (!reg || this.remoteTaskPollers.has(sessionId) || !reg.hasRunningRemote(needsPolling)) return
    const poller = setInterval(() => {
      if (!reg.hasRunningRemote(needsPolling)) {
        clearInterval(poller)
        this.remoteTaskPollers.delete(sessionId)
        return
      }
      if (this.turnAbortControllers.has(sessionId)) return
      void reg.refreshWhere(needsPolling)
    }, REMOTE_TASK_POLL_MS)
    ;(poller as any).unref?.()
    this.remoteTaskPollers.set(sessionId, poller)
  }

  /**
   * A queued wake message is starting a turn: its text already carries these
   * tasks' results, so they must not be injected again.
   */
  acknowledgeTaskNotification(sessionId: string, taskIds: string[]): void {
    const reg = this.commandRegistries.get(sessionId)
    if (reg && taskIds.length > 0) reg.markConsumed(taskIds)
  }

  /**
   * Read what the session is waiting to be told, so this turn's prompt can say
   * so. Called at turn start (before the turn is buffered) because the prompt
   * is assembled synchronously; a failure keeps the last known state.
   */
  async refreshWakeState(sessionId: string): Promise<void> {
    if (!hasInternalApiCredentials()) return
    // Bounded: a slow API must not hold the turn's first token back. A miss
    // (null) keeps the last known state rather than claiming the pause is over.
    const timeout = new Promise<null>((resolve) => {
      const timer = setTimeout(() => resolve(null), 1_500)
      ;(timer as any).unref?.()
    })
    const state = await Promise.race([getSessionWakeState(sessionId).catch(() => null), timeout])
    if (state) this.wakeStates.set(sessionId, state)
  }

  /** The cached wake state, for the prompt and for tests. */
  wakeStateFor(sessionId: string): SessionWakeState | null {
    return this.wakeStates.get(sessionId) ?? null
  }

  /** List the tasks still running for a chat thread. */
  listSessionProcesses(sessionId: string): import('./command-registry').RunningProcess[] {
    return this.getOrCreateCommandRegistry(sessionId).listVisible()
  }

  /** Tasks for the dock (running + recently finished), remote ones refreshed first. */
  async listSessionTasks(sessionId: string): Promise<import('./task-registry').RunningProcess[]> {
    const reg = this.getOrCreateCommandRegistry(sessionId)
    // A cold registry is seeded asynchronously; answer from the hydrated list.
    // The client only polls the seed route while it already has rows, so an
    // empty first response would never be retried.
    await this.hydratingRegistries.get(sessionId)
    if (reg.hasRunningRemote()) await reg.refreshRemote()
    // A paused session's tasks are finished but not yet delivered: show them as
    // waiting, so the dock does not read "completed" for something the agent was
    // never told.
    const waiting = new Set((this.wakeStates.get(sessionId)?.waiting ?? []).map((task) => task.taskId))
    return reg.listDock().map((proc) => (waiting.has(proc.id) ? { ...proc, waiting: true } : proc))
  }

  /**
   * Last part of a task's output, for the dock's output viewer. Remote tasks
   * are refreshed first: the API is where their text lands, and a reader that
   * skips the refresh sees an empty local log. The task's destination (`link`)
   * comes back with it, so the client can open the agent's thread instead.
   */
  async readSessionTaskOutput(sessionId: string, taskId: string): Promise<SessionTaskOutput | null> {
    const reg = this.getOrCreateCommandRegistry(sessionId)
    let entry = reg.get(taskId)
    if (!entry) {
      // A cold registry is seeded asynchronously; the task may still arrive.
      await this.hydratingRegistries.get(sessionId)
      entry = reg.get(taskId)
    }
    if (!entry) return null
    if (entry.remote && entry.status === 'running') {
      await reg.refreshWhere((e) => e.id === entry!.id)
    }
    const local = taskOutputBody(reg.readOutput(entry)).trim()
    const body = local || (entry.result?.summary ?? '').trim() || (entry.remoteNote ?? '').trim()
    // A task the runtime died under often produced no output at all, and the
    // viewer strips the log's front matter — so opening its log showed an
    // explanation of the *wake*, never the verdict the report was about. State
    // it as the first line of what the reader sees: the same `status:` the log's
    // footer carries, and no exit code, because the command never exited
    // (SHO-141). Settled rows keep the body-only view.
    const output =
      entry.status === 'interrupted' ? [`status: interrupted`, body].filter(Boolean).join('\n\n') : body
    return {
      taskId: entry.id,
      source: entry.source,
      title: entry.title,
      status: entry.status,
      outputFile: reg.displayPath(entry.outputFile),
      output: output.length > 64_000 ? output.slice(-64_000) : output,
      link: entry.link ?? (entry.outputFile ? { kind: 'log', path: reg.displayPath(entry.outputFile) } : undefined),
    }
  }

  /** Stop: running tasks keep going but no longer wake the agent. */
  muteSessionTasks(sessionId: string): void {
    this.commandRegistries.get(sessionId)?.muteRunning()
    const timer = this.taskWakeTimers.get(sessionId)
    if (timer) {
      clearTimeout(timer)
      this.taskWakeTimers.delete(sessionId)
    }
    this.clearTaskWakeRetry(sessionId)
  }

  /**
   * Kill (or dismiss, if stale) one tracked background process for a thread.
   * Returns true if a matching run_id existed.
   */
  killSessionProcess(sessionId: string, runId: string): boolean {
    return this.getOrCreateCommandRegistry(sessionId).kill(runId)
  }

  /** Wipe a session's history and everything tied to it, including its background tasks. */
  clearSessionHistory(sessionId: string): void {
    this.sessionManager.clearHistory(sessionId)
    // History wipe = prefix rewrite. Drop per-session compaction state
    // so fresh decisions are taken against the new (empty) history.
    this.contentReplacementStates.delete(sessionId)
    this.turnCounters.delete(sessionId)
    this.turnPrefixes.delete(sessionId)
    this.shellCwd.delete(sessionId)
    this.disposeSessionState(sessionId)
  }

  /** Tear down per-session bookkeeping. Kills any backgrounded shell runs and releases browsers. */
  private disposeSessionState(sessionId: string): void {
    const reg = this.commandRegistries.get(sessionId)
    if (reg) {
      // `clear`: the session is being wiped, so its rows go with it. Hydration
      // falls back to the per-task logs when no snapshot survives, so those have
      // to go too — a footer-less log now restores as `interrupted` (SHO-141),
      // which would otherwise bring a cleared session's tasks back to life.
      reg.killAll({ clear: true })
      try { rmSync(taskOutputDir(this.workspaceDir, sessionId), { recursive: true, force: true }) } catch { /* best effort */ }
      this.commandRegistries.delete(sessionId)
    }
    const wake = this.taskWakeTimers.get(sessionId)
    if (wake) clearTimeout(wake)
    this.taskWakeTimers.delete(sessionId)
    const poller = this.remoteTaskPollers.get(sessionId)
    if (poller) clearInterval(poller)
    this.remoteTaskPollers.delete(sessionId)
    void releaseSessionBrowsers(sessionId)
  }

  // ---------------------------------------------------------------------------
  // Agent Turn (Pi Agent Core)
  // ---------------------------------------------------------------------------

  private async agentTurn(
    prompt: string,
    sessionId: string = 'default',
    isHeartbeat: boolean = false,
    streamTarget?: { adapter: ChannelAdapter; channelId: string },
    uiWriter?: { write(chunk: Record<string, any>): void },
    activeSkill?: { name: string },
    images?: ImageContent[],
    interactionMode: 'agent' | 'plan' | 'ask' = 'agent',
    dualPlan: boolean = false,
    /** Only chat turns a person started carry one; see integration-credentials.ts. */
    requesterTicket?: string,
    /** Surface this turn belongs to (workspace agent vs a project's own chat). */
    chatContext?: ChatContext,
  ): Promise<string> {
    // Wait for any in-flight turn on this session to finish so the new turn
    // reads a fully-updated session history (important for "continue" after a
    // clean turn-end). On user-initiated abort the lock is dropped eagerly in
    // `abortCurrentTurn`, so a new message right after Stop won't queue behind
    // the aborted turn's cleanup.
    const prevTurn = this.turnLocks.get(sessionId)
    if (prevTurn) {
      await prevTurn.catch(() => {})
    }

    this._currentTask = isHeartbeat ? 'heartbeat' : prompt.slice(0, 120)
    const turnPromise = this._agentTurnInner(prompt, sessionId, isHeartbeat, streamTarget, uiWriter, activeSkill, images, interactionMode, dualPlan, requesterTicket, chatContext)
    this.turnLocks.set(sessionId, turnPromise)
    try {
      return await turnPromise
    } finally {
      this._currentTask = null
      if (this.turnLocks.get(sessionId) === turnPromise) {
        this.turnLocks.delete(sessionId)
      }
      reapOrphanChromium()
    }
  }

  private async _agentTurnInner(
    prompt: string,
    sessionId: string = 'default',
    isHeartbeat: boolean = false,
    streamTarget?: { adapter: ChannelAdapter; channelId: string },
    uiWriter?: { write(chunk: Record<string, any>): void },
    activeSkill?: { name: string },
    images?: ImageContent[],
    interactionMode: 'agent' | 'plan' | 'ask' = 'agent',
    dualPlan: boolean = false,
    requesterTicket?: string,
    chatContext?: ChatContext,
  ): Promise<string> {
    // Resolve the surface up front and remember it for the session, so every
    // capability decision this turn makes — tools, prompt block, the
    // capabilities_configure tool — reads the same config.
    const resolvedChatContext = this.resolveChatContext(sessionId, chatContext)
    this.rememberChatContext(sessionId, resolvedChatContext)
    let turnConfig = this.configForTurn(sessionId, resolvedChatContext)

    // Reload skills and quick actions from disk so any files created/edited/deleted by file tools are picked up
    this.skills = loadAllSkills(this.workspaceDir)
    this.quickActions = loadQuickActions(this.workspaceDir)
    setLoadedSkills(this.skills)

    // Start the skill server if it was just created (no-op if already running)
    if (!this.skillServerManager.isRunning) {
      this.skillServerManager.start().catch(() => {})
    }

    // Per-turn trust refresh. Reconciles the runtime's view of
    // `trustLevel` with the DB at the boundary of every chat turn so
    // a user clicking "Trust folder" between messages is reflected in
    // both the system prompt and `assertAllowedPath()` checks of the
    // tool calls that follow. Best-effort: on transient failure the
    // resolver keeps its last-known value rather than flapping.
    await refreshTrust()

    // BETA: per-chat git worktrees. Ensure this session has its own worktree
    // so the agent's file/exec tools operate on an isolated branch. Skills,
    // memory, plans, and other `.shogo/` config continue to load from the
    // canonical workspace (gitignored, shared) below. Best-effort: on failure
    // we fall back to the shared working tree.
    let sessionWorkspaceDir = this.workspaceDir
    if (this.isWorktreeEligibleSession(sessionId, isHeartbeat)) {
      const wt = await this.ensureSessionWorktree(sessionId)
      if (wt) sessionWorkspaceDir = wt
    }

    await this.primeTurnFacts(sessionId)

    // The model is resolved BEFORE the system prompt is built so the Account
    // block can name the model this turn actually sends (SHO-145). Turns with
    // no session override take their model from `config.json`, which only the
    // API owns — refresh it here (throttled) so a change made from the project
    // settings or another project's agent lands on this turn, not after a
    // restart.
    const session = this.sessionManager.getOrCreate(sessionId)
    if (!session.modelOverride && (await this.refreshConfigModelIfStale())) {
      // The refresh replaced `this.config` with a freshly read object, so the
      // surface config captured above is one revision behind — re-derive it so
      // the rest of this turn reads the same values.
      turnConfig = this.configForTurn(sessionId, resolvedChatContext)
    }
    // Tool descriptions and the Account line both quote the workspace's models,
    // so load the list before either is built (cached for a few minutes; a
    // no-op without AI_PROXY_URL).
    await refreshAvailableModels()
    const modelAlias = session.modelOverride || this.config.model.name
    const autoRouting = isAutoModel(modelAlias)

    let provider: string
    let modelId: string
    let routingDecision: ReturnType<typeof selectModelForSpawn> | undefined
    let autoTiers: ReturnType<typeof buildAutoTierMap> | undefined
    let autoProviderHints: Record<string, string> = {}
    let autoSelectedTier: AutoTierCeiling | undefined

    if (autoRouting) {
      autoTiers = buildAutoTierMap(autoTierIds(this.autoTierOverride))
      autoProviderHints = autoTierProviderHints(this.autoTierOverride)
      const estimatedTokens = this.sessionManager.estimateTokens(session)
      const classInput: SpawnClassificationInput = {
        prompt,
        subagentType: 'main-agent',
        toolNames: [],
        contextTokens: estimatedTokens,
      }
      const ceilingIsFresh =
        session.autoTierCeiling &&
        typeof session.autoTierCeilingUpdatedAt === 'number' &&
        Date.now() - session.autoTierCeilingUpdatedAt < AUTO_TIER_CEILING_TTL_MS
      const ceilingTier = ceilingIsFresh ? session.autoTierCeiling! : 'premium'
      routingDecision = selectModelForSpawn(classInput, {
        ceilingModel: autoTiers[ceilingTier],
        availableModels: autoTiers,
      })
      modelId = routingDecision.selectedModel
      autoSelectedTier =
        routingDecision.selectedModel === autoTiers.premium
          ? 'premium'
          : routingDecision.selectedModel === autoTiers.standard
            ? 'standard'
            : 'economy'
      // Prefer the admin-supplied provider hint for the routed model (set when
      // the tier resolves to a DB/custom-backed model whose provider can't be
      // inferred from the id, e.g. Hoshi); otherwise infer from the id.
      provider = autoProviderHints[modelId] ?? inferProviderFromModel(modelId, this.config.model.provider)
      console.log(`${this.logPrefix} ${formatRoutingLog(routingDecision, prompt)}`)
      if (uiWriter) {
        uiWriter.write({ type: 'data-routing-decision', data: routingDecision })
      }
    } else {
      const effectiveAlias = modelAlias
      // Resolve the alias to a concrete model id BEFORE inferring its
      // provider. `inferProviderFromModel` special-cases the literal
      // strings 'basic'/'advanced' to 'anthropic' (its historical default
      // for those UI-facing aliases) — but `effectiveAlias` here can BE one
      // of those literals whenever the caller left `session.modelOverride`
      // unresolved (every heartbeat/channel/webhook-driven turn: see
      // "Apply channel-configured model" above, which sets modelOverride to
      // 'basic' and clears modelProvider). Inferring from the raw alias
      // then ignores whatever admin-configured model 'basic' actually
      // resolves to — if that's a non-Anthropic model (e.g. Hoshi 2.0,
      // provider 'custom'/deepseek), every such turn 404s with "model:
      // deepseek-flash" against the Anthropic endpoint. Found live running
      // the issue-pipeline harness's webhook-channel turn after pinning the
      // whole pipeline to Hoshi 2.0. Honor the API server's native provider
      // hint when present; otherwise infer from the RESOLVED id.
      modelId = resolveModelAlias(effectiveAlias)
      provider = session.modelProvider ?? inferProviderFromModel(modelId, this.config.model.provider)
      console.log(`${this.logPrefix} LLM turn: model=${modelId} (alias=${modelAlias}) provider=${provider}${session.modelProvider ? ' (hint)' : ''} baseUrl=${process.env[provider === 'openai' ? 'OPENAI_BASE_URL' : 'ANTHROPIC_BASE_URL'] || '(not set)'}`)
    }

    const turnModelDisplayName = this.turnModelDisplayName(modelId, session, autoRouting)

    let systemPrompt = this.loadBootstrapContext(
      sessionId,
      turnConfig,
      resolvedChatContext,
      turnModelDisplayName,
    )

    console.log(`[Gateway][_agentTurnInner] building system prompt — interactionMode: ${interactionMode}, sessionId: ${sessionId}`)
    // Interaction mode system prompt injection
    if (interactionMode === 'plan') {
      const planModePrompt = [
        '## PLAN MODE ACTIVE',
        '',
        'Plan mode is active. You MUST NOT edit source files, run mutating commands, or otherwise change the workspace before the user clicks Build. This supersedes all other instructions.',
        'Exception: you may create or update the plan artifact using create_plan/update_plan; those tools only write under .shogo/plans/ for user review.',
        '',
        'Your job:',
        `1. Research the user's request using read-only tools (read_file, ${isSearchEnabled() ? 'search, ' : ''}web, etc.)`,
        '2. If you need more information, ask clarifying questions using ask_user',
        '3. If the request is too broad, ask 1-2 narrowing questions using ask_user',
        '4. If there are multiple valid approaches, ask the user which they prefer',
        '5. When you have enough context, call create_plan with a structured plan',
        '6. If the user asks to modify, refine, or extend an existing plan, use update_plan with the plan\'s filepath instead of creating a new one',
        '7. The plan should be concise, specific, and actionable — cite file paths and code snippets',
        '8. Do NOT make any changes until the user confirms the plan',
      ].join('\n')
      systemPrompt = planModePrompt + '\n\n---\n\n' + systemPrompt
    } else if (interactionMode === 'ask') {
      const askModePrompt = [
        '## ASK MODE ACTIVE',
        '',
        'Ask mode is active. You are in a read-only conversational mode. Answer the user\'s questions directly using your knowledge and conversation context. You have no tools available. Do not attempt to make changes, run commands, or take any actions. Just provide helpful, informative answers.',
      ].join('\n')
      systemPrompt = askModePrompt + '\n\n---\n\n' + systemPrompt
    }

    if (this.config.coordinatorMode) {
      const { COORDINATOR_SYSTEM_PROMPT } = await import('./coordinator-prompt')
      systemPrompt += '\n\n' + COORDINATOR_SYSTEM_PROMPT
    }

    // Reset per-turn state and wire/clear the SSE writer for permission requests.
    // When there's no uiWriter (heartbeat, channel, webhook turns),
    // clear the callback so "ask" decisions fail closed instead of writing
    // to a stale stream from a previous UI turn.
    if (this.permissionEngine) {
      this.permissionEngine.resetTurn()
      this.permissionEngine.setSseCallback(
        uiWriter && !this.unattendedSessions.has(sessionId) ? (event) => uiWriter.write(event) : undefined
      )
    }

    if (this.config.browserExtensionToken) {
      process.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN = this.config.browserExtensionToken
    } else {
      delete process.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN
    }

    const commandRegistry = sessionId ? this.getOrCreateCommandRegistry(sessionId) : undefined
    const persistedProgressMessages = new Set<Message>()
    const toolContext: ToolContext = {
      workspaceDir: sessionWorkspaceDir,
      channels: this.channels,
      // The surface's config: a workspace chat reads the workspace agent's own
      // toggles, a project chat its project's. `capabilities_configure` writes
      // to whichever scope this names.
      config: turnConfig,
      capabilityScope: resolvedChatContext === 'workspace' ? 'workspace' : 'project',
      capabilityConfigs: {
        workspace: this.configForTurn(sessionId, 'workspace'),
        project: this.config,
      },
      projectId: this.projectId,
      workspaceId: process.env.WORKSPACE_ID,
      sessionId,
      sandbox: this.config.sandbox,
      mainSessionIds: this.config.mainSessionIds,
      mcpClientManager: this.mcpClientManager,
      connectChannel: (type, config) => this.connectChannel(type, config),
      disconnectChannel: (type) => this.disconnectChannel(type),
      permissionEngine: this.permissionEngine ?? undefined,
      userId: this.currentUserId,
      requesterTicket,
      aiProxyUrl: process.env.AI_PROXY_URL,
      aiProxyToken: process.env.AI_PROXY_TOKEN,
      uiWriter,
      // Always provide the watcher so live file events (file.changed /
      // file.deleted) are broadcast to SSE subscribers (e.g. the IDE tab
      // for Cursor-style live editing). The watcher is a cheap per-
      // workspace singleton; no downside to making it always-on.
      canvasFileWatcher: this.canvasFileWatcher,
      lspManager: this.lspManager ?? undefined,
      getLspManager: () => this.lspManager,
      // read_lints' missing-deps-vs-model-mistake classification (see
      // `ToolContext.depsReady`'s docstring). `depsSettled` is a sync,
      // already-resolved-or-not snapshot — safe to read on every tool call
      // without awaiting the `depsReady` promise itself.
      depsReady: this.previewManager?.depsSettled,
      fileStateCache: this.fileStateCache,
      agentManager: this.agentManager,
      skillServerManager: this.skillServerManager,
      sessionPersistence: this.sessionPersistence ?? undefined,
      teamManager: this.teamManager,
      indexEngine: this.indexEngine ?? undefined,
      workspaceGraph: this.workspaceGraph ?? undefined,
      effectiveModel: modelId,
      effectiveProvider: provider,
      autoRouting,
      autoTierOverride: this.autoTierOverride,
      dualPlan,
      shellState: sessionId ? {
        getCwd: () => this.shellCwd.get(sessionId!) || this.initialShellCwd(sessionWorkspaceDir),
        setCwd: (cwd: string) => this.shellCwd.set(sessionId!, cwd),
        initialCwd: this.initialShellCwd(sessionWorkspaceDir),
      } : undefined,
      commandRegistry,
      guideRegistry: this.currentGuideRegistry,
      listWorktreeStatuses: this.isWorktreesEnabled() ? () => this.listWorktreeStatuses() : undefined,
      toolMockFns: this.toolMocks.size > 0 ? this.toolMocks : undefined,
      // heartbeat_configure writes the schedule to the database through the
      // project config API; refresh the cached copy the status output shows.
      onHeartbeatConfigured: () => { void this.refreshHeartbeatSnapshot() },
      onCapabilitiesChanged: async () => {
        const synced = await this.syncCapabilitiesFromApi()
        if (!synced) this.reloadConfig()
      },

    }

    // Terminal exec callback — routes commands to the user's visible terminal
    // when running on the desktop. The Electron main process starts a tiny
    // HTTP handler and passes its URL via TERMINAL_EXEC_URL env var.
    const terminalExecUrl = process.env.TERMINAL_EXEC_URL
    if (terminalExecUrl) {
      // The bridge requires a per-process token (set by the Electron main
      // process alongside TERMINAL_EXEC_URL). Without it the server returns 401.
      const terminalExecToken = process.env.TERMINAL_EXEC_TOKEN ?? ''
      const bridgeHeaders = (): Record<string, string> => ({
        'Content-Type': 'application/json',
        ...(terminalExecToken ? { 'x-shogo-bridge-token': terminalExecToken } : {}),
      })
      toolContext.terminalExec = async ({ command, cwd, timeoutMs, mode }) => {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), timeoutMs ?? 130_000)
        try {
          const res = await fetch(`${terminalExecUrl}/terminal/exec`, {
            method: 'POST',
            headers: bridgeHeaders(),
            body: JSON.stringify({ command, cwd, timeoutMs, mode }),
            signal: controller.signal,
          })
          if (!res.ok) {
            const body = await res.text().catch(() => '')
            throw new Error(`Terminal exec failed (HTTP ${res.status}): ${body}`)
          }
          return await res.json()
        } finally {
          clearTimeout(timer)
        }
      }
      toolContext.terminalRead = async ({ terminalId, cwd, maxChars }) => {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), 10_000)
        try {
          const res = await fetch(`${terminalExecUrl}/terminal/context`, {
            method: 'POST',
            headers: bridgeHeaders(),
            body: JSON.stringify({ terminalId, cwd, maxChars }),
            signal: controller.signal,
          })
          if (!res.ok) {
            const body = await res.text().catch(() => '')
            throw new Error(`Terminal context read failed (HTTP ${res.status}): ${body}`)
          }
          return await res.json()
        } finally {
          clearTimeout(timer)
        }
      }
      toolContext.terminalInterrupt = async () => {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), 10_000)
        try {
          const res = await fetch(`${terminalExecUrl}/terminal/interrupt`, {
            method: 'POST',
            headers: bridgeHeaders(),
            body: '{}',
            signal: controller.signal,
          })
          if (!res.ok) {
            const body = await res.text().catch(() => '')
            throw new Error(`Terminal interrupt failed (HTTP ${res.status}): ${body}`)
          }
          return await res.json()
        } finally {
          clearTimeout(timer)
        }
      }
    }
    const baseTools = createTools(toolContext)

    const mcpTools = this.mcpClientManager.getTools()
    let assembledTools = mcpTools.length > 0 ? [...baseTools, ...mcpTools] : baseTools

    // Suppress MCP Playwright tools — built-in browser tool has feature parity
    assembledTools = assembledTools.filter(t => !t.name.startsWith('mcp_playwright_'))

    // Capability toggles (independent of mode). Shared with the subagent
    // parent-tool path (allToolsGetter) so disabling a capability removes its
    // tools everywhere, not just from the main agent.
    assembledTools = filterDisabledCapabilityTools(assembledTools, turnConfig)
    // Code analysis tools are only available via subagents (code-reviewer, explore)
    const CODE_REVIEW_ONLY_TOOLS = new Set(['detect_changes', 'review_context', 'impact_radius'])
    assembledTools = assembledTools.filter(t => !CODE_REVIEW_ONLY_TOOLS.has(t.name))

    // Tools delegated to dedicated subagents — removed from the main agent to
    // reduce per-request token cost. Keep small/action-oriented integration,
    // channel, and heartbeat tools available to the main agent as well:
    // Haiku reliably used them directly in the persona/agentic pipelines, but
    // often fails to infer that a subagent should be spawned for simple "connect
    // my email" or "set up a reminder" requests.
    // (Media tools are not delegated: the project's own agent calls them, gated
    // by imageGenEnabled / videoGenEnabled / threeDGenEnabled.)
    assembledTools = filterSubagentOnlyTools(assembledTools, turnConfig)

    // Snapshot the full agent-mode tool set BEFORE any read-only mode
    // restriction. Used to (a) guarantee core tools survive in agent mode and
    // (b) build mode-aware dispatch stubs for tools a restricted mode removes.
    const agentModeToolNames = new Set(assembledTools.map(t => t.name))

    // Interaction mode tool restrictions
    let restrictedMode: RestrictedMode | null = null
    if (interactionMode === 'ask') {
      restrictedMode = 'ask'
      assembledTools = []
    } else if (interactionMode === 'plan') {
      restrictedMode = 'plan'
      const PLAN_MODE_ALLOWED = new Set([
        'read_file', ...(isSearchEnabled() ? ['search'] : []),
        'web',
        'memory_read', 'memory_search', 'search_history', 'read_history',
        'ask_user', 'todo_write', 'create_plan', 'update_plan',
        'skill',
      ])
      assembledTools = assembledTools.filter(t => PLAN_MODE_ALLOWED.has(t.name))
    }

    if (this.config.coordinatorMode) {
      restrictedMode = restrictedMode ?? 'coordinator'
      const { COORDINATOR_READONLY_TOOLS } = await import('./coordinator-prompt')
      assembledTools = assembledTools.filter(t => COORDINATOR_READONLY_TOOLS.has(t.name))
    }

    // WS7: in agent (edit) mode, guarantee the core tools are always callable.
    // A registration/MCP-merge race or an unexpected filter previously dropped
    // exec/edit_file/write_file, surfacing as "Tool not found" mid-session.
    if (!restrictedMode) {
      const present = new Set(assembledTools.map(t => t.name))
      for (const name of expectedCoreToolsForAgentMode(turnConfig)) {
        if (present.has(name)) continue
        const recovered = baseTools.find(t => t.name === name)
        if (recovered) {
          console.warn(`${this.logPrefix} Core tool "${name}" was missing from the agent-mode tool set; re-adding it.`)
          assembledTools.push(recovered)
          present.add(name)
        }
      }
    }

    // WS7: dispatch-only stubs so a hallucinated call to a tool a restricted
    // mode removed returns a mode-aware error instead of "Tool not found".
    // Not advertised — injected only into the Proxy's `find` path below.
    const modeFilteredStubs: AgentTool[] = []
    if (restrictedMode) {
      const activeNames = new Set(assembledTools.map(t => t.name))
      for (const name of agentModeToolNames) {
        if (!activeNames.has(name)) modeFilteredStubs.push(createModeUnavailableTool(name, restrictedMode))
      }
    }

    // Deferred tool definitions (SHO-97). Advertise a core set plus this
    // agent's learned top tools; everything else keeps a one-line catalog entry
    // in the system prompt and no schema in the request. Applied here — after
    // capability, subagent-only, mode and permission filtering — so nothing a
    // filter removed can sneak back in. Both the filter and this step read
    // `turnConfig`, i.e. the capabilities RESOLVED for this turn's surface
    // (workspace agent vs project, SHO-77), never the raw config: a deferred
    // tool must not become reachable because the workspace scope defaults a
    // toggle the project had explicitly off. Computed once per session: the
    // tools block is the first segment of the provider cache prefix, so
    // re-deriving it per turn would invalidate every cache hit.
    let isAdvertisedTool: ((tool: AgentTool) => boolean) | undefined
    if (deferredToolsEnabled(turnConfig) && assembledTools.some(t => t.name === 'read_guide')) {
      const learned = await resolveLearnedToolOrder({
        projectId: projectScopedId(this.projectId),
        load: async (id) => {
          const usage = await getProjectToolUsage(id)
          return usage ? { order: usage.order, totalCalls: usage.totalCalls } : null
        },
      })
      const profile = this.toolProfileFor(sessionId, assembledTools, learned)
      // read_guide was created from this same object, so it sees the profile.
      toolContext.toolProfileRef = { current: profile }
      assembledTools = assembledTools.map(t =>
        profile.isDeferred(t.name) ? withActivationOnCall(t, profile) : t,
      )
      isAdvertisedTool = (tool) => profile.isAdvertised(tool.name)
      if (profile.catalog) {
        systemPrompt = insertStablePromptSection(systemPrompt, profile.catalog)
        this.lastPromptBreakdown?.push({
          label: 'deferred-tools-catalog',
          zone: 'stable',
          chars: profile.catalog.length,
          estTokens: Math.ceil(profile.catalog.length / 4),
        })
      }
    }

    let staticTools = assembledTools
    if (this.toolMocks.size > 0) {
      const existingNames = new Set(assembledTools.map(t => t.name))
      const gateway = this

      // Drop native tools that the eval harness marked hidden. Previously
      // `hiddenMockTools` only suppressed synthetic-tool injection, leaving
      // native built-ins (read_file/write_file/edit_file/exec/send_message/
      // …) visible even when the eval explicitly hid them via
      // `{ hidden: true }`. That let models bypass an integration flow by
      // calling, e.g., `send_message` for an email task instead of going
      // through Composio Gmail. Filtering native tools here makes
      // `hidden: true` behave consistently for both kinds.
      const visibleAssembled = assembledTools.filter(t => !this.hiddenMockTools.has(t.name))

      // Wrap existing tools with mock interceptors
      staticTools = visibleAssembled.map(tool => {
        const mockFn = this.toolMocks.get(tool.name)
        if (!mockFn) return tool

        // Special handling for connect: promote hidden mocks listed in the response
        if (tool.name === 'connect') {
          return {
            ...tool,
            execute: async (_id: string, params: any) => {
              const result = await mockFn(params)
              gateway._promoteHiddenMocksFromInstall(result)
              if (result && typeof result === 'object' && (result as any).__multipart === true) {
                const { __multipart: _m, ...rest } = result as any
                return rest
              }
              return textResult(result)
            },
          }
        }

        const realExecute = tool.execute
        return {
          ...tool,
          execute: async (_id: string, params: any, signal?: AbortSignal, onUpdate?: any) => {
            const result = await mockFn(params)
            if (result === '__passthrough') return realExecute(_id, params, signal, onUpdate)
            if (result && typeof result === 'object' && (result as any).__multipart === true) {
              const { __multipart: _m, ...rest } = result as any
              return rest
            }
            if (COMPOSIO_SLUG_RE.test(tool.name)) return capIntegrationMockResult(tool.name, result)
            return textResult(result)
          },
        }
      })

      // Inject synthetic tool definitions for mocked tools not in the base set
      // Skip hidden tools — they become available only after connect promotes them
      for (const [name, mockFn] of this.toolMocks) {
        if (existingNames.has(name)) continue
        if (this.hiddenMockTools.has(name)) continue
        const synDef = this.syntheticTools.get(name)
        const paramProps: Record<string, any> = {}
        if (synDef?.paramKeys) {
          for (const key of synDef.paramKeys) {
            paramProps[key] = Type.Optional(Type.String({ description: key }))
          }
        }
        paramProps['input'] = Type.Optional(Type.String({ description: 'Input data or query' }))
        const syntheticTool: AgentTool = {
          name,
          description: synDef?.description || `External integration tool: ${name}`,
          label: name.replace(/__/g, ' > ').replace(/_/g, ' '),
          parameters: (synDef?.parameters as any) ?? Type.Object(paramProps),
          execute: async (_id: string, params: any) => runMockAndUnwrap(mockFn, params, name),
        }
        staticTools.push(syntheticTool)
      }
    }

    // Dynamic tools proxy: pi-agent-core uses tools.find() and iterates tools.
    // When connect hot-adds servers mid-turn, their tools must be visible
    // immediately. This proxy merges staticTools with live MCP tools on access.
    // Also includes promotedMockTools (hidden mocks promoted via mock connect).
    const mcpMgr = this.mcpClientManager
    const promoted = this.promotedMockTools
    const staticNames = new Set(staticTools.map(t => t.name))
    // Every call runs in a credential scope: whose integration account it uses.
    const withCredentials = createIntegrationCredentialWrapper({
      projectId: this.projectId,
      requesterTicket,
      uiWriter,
    })
    const credentialedStatic = staticTools.map(withCredentials)
    const tools = new Proxy(credentialedStatic, {
      get(target, prop, receiver) {
        if (prop === 'find' || prop === 'filter' || prop === 'map' ||
            prop === 'forEach' || prop === 'some' || prop === 'every' ||
            prop === Symbol.iterator || prop === 'length' ||
            prop === 'slice' || prop === 'concat' || prop === 'includes') {
          const liveMcpTools = mcpMgr.getTools().filter(t => !staticNames.has(t.name))
          const promotedNew = promoted.filter(t => !staticNames.has(t.name))
          const extras = [...liveMcpTools, ...promotedNew].map(withCredentials)
          const merged = extras.length > 0 ? [...target, ...extras] : target
          if (prop === 'length') return merged.length
          if (prop === Symbol.iterator) return merged[Symbol.iterator].bind(merged)
          // Dispatch (`find`) also matches the mode-aware stubs so a call to a
          // mode-filtered tool yields a helpful error, not "Tool not found".
          // The stubs are deliberately excluded from advertising surfaces
          // (map/forEach/length/iterator/filter) so the mode still hides them.
          if (prop === 'find' && modeFilteredStubs.length > 0) {
            return (predicate: any, thisArg?: any) => {
              const hit = merged.find(predicate, thisArg)
              if (hit !== undefined) return hit
              return modeFilteredStubs.find(predicate, thisArg)
            }
          }
          return (merged as any)[prop].bind(merged)
        }
        return Reflect.get(target, prop, receiver)
      },
    }) as AgentTool[]

    // Multi-layer context compaction pipeline (Layers 1-4)
    //
    // One cap, in one place: the resolved model's real window minus the
    // output/buffer reserve, capped at AGENT_AUTOCOMPACT_TOKENS (200k). Until
    // SHO-96 nothing ever set the window, so a 1M-window haiku/opus turn was
    // budgeted at 200k while the provider accepted 400k, and summarization —
    // which could only run at a turn boundary anyway — never fired mid-turn.
    const modelContextWindow = getContextWindowTokens(modelId)
    // The catalog is only the *default* source: a window the caller set
    // explicitly (config, or a test pinning a 2k window to force compaction)
    // always wins, and overriding it silently changed what the cap derived from.
    if (!this.config.session?.contextWindowTokens) {
      this.sessionManager.setContextWindowTokens(modelContextWindow)
    }
    const autoCompactTokens = this.sessionManager.autocompactThreshold
    const contextBudgetChars = autoCompactTokens * 4
    const inLoopBudgetTokens = resolveInLoopContextBudgetTokens(autoCompactTokens)
    let history = this.sessionManager.buildHistory(sessionId)
    history = applyToolResultBudget(history, contextBudgetChars)
    // Turn-scoped telemetry state: the first call's usage, and whether a
    // compaction ran at this boundary (SHO-122).
    let turnFirstCallUsage: PerCallUsage | undefined
    let turnCompaction: { before: number; after: number } | null = null
    const mc = microcompact(history)
    history = mc.messages
    history = snipConsumedResults(history)

    if (mc.tokensSaved > 0) {
      console.log(`${this.logPrefix} Microcompact saved ~${mc.tokensSaved} tokens for session ${sessionId}`)
    }

    // Layer 4: LLM autocompact if still over threshold after cheap layers
    if (this.sessionManager.estimateTokens(session) > this.sessionManager.autocompactThreshold) {
      const fileStateSummary = this.fileStateCache.size > 0
        ? this.fileStateCache.getSummary(this.workspaceDir)
        : undefined
      const preCompactResult = await this.sessionManager.compact(sessionId, fileStateSummary)
      if (preCompactResult) {
        turnCompaction = { before: preCompactResult.messagesBefore, after: preCompactResult.messagesAfter }
        recordCompaction({
          sessionId,
          trigger: 'pre-turn',
          messagesBefore: preCompactResult.messagesBefore,
          messagesAfter: preCompactResult.messagesAfter,
          summaryChars: preCompactResult.summary.length,
          filesTouched: preCompactResult.filesTouched ?? [],
          toolsUsed: preCompactResult.toolsUsed ?? [],
          foldedRounds: preCompactResult.foldedRounds ?? 0,
        })
        console.log(
          `${this.logPrefix} Pre-turn autocompact: ${preCompactResult.messagesBefore} -> ${preCompactResult.messagesAfter} messages`
        )
        // Autocompact rewrites the prefix — drop stable-compaction state so
        // the new transformContext decisions are taken against the new history.
        this.contentReplacementStates.delete(sessionId)
        history = this.sessionManager.buildHistory(sessionId)
        history = applyToolResultBudget(history, contextBudgetChars)
        history = microcompact(history).messages
        history = snipConsumedResults(history)
      }
    }

    // Populate fork-mode context so subagent tools can access the parent's state
    toolContext.renderedSystemPrompt = systemPrompt
    toolContext.sessionMessages = history

    // Emit team snapshot + agent registry for UI hydration on reload
    if (uiWriter && this.teamManager) {
      try {
        const teams = this.teamManager.listTeams(sessionId)
        for (const team of teams) {
          uiWriter.write({
            type: 'data-team-snapshot',
            data: {
              team,
              members: this.teamManager.listMembers(team.id),
              tasks: this.teamManager.listTasks(team.id),
              messages: this.teamManager.getRecentMessages(team.id, 50),
            },
          })
        }
      } catch (err: any) {
        console.warn(`${this.logPrefix} Failed to emit team snapshot:`, err.message)
      }
    }
    // Pick up `.shogo/agents/` edits and newly mounted projects without a restart.
    this.syncCustomAgents()
    if (uiWriter && this.agentManager) {
      try {
        const types = this.agentManager.listTypes()
        uiWriter.write({ type: 'data-agent-types', data: { types } })
      } catch { /* ignore */ }
    }

    // Typing indicator: send once before the turn and periodically
    let typingInterval: ReturnType<typeof setInterval> | undefined
    if (streamTarget?.adapter.sendTyping) {
      streamTarget.adapter.sendTyping(streamTarget.channelId).catch(() => {})
      typingInterval = setInterval(() => {
        streamTarget.adapter.sendTyping?.(streamTarget.channelId).catch(() => {})
      }, 4000)
    }

    // Streaming: set up block chunker only if streamChunk config is enabled
    let chunker: BlockChunker | undefined
    const streamedChunks: string[] = []
    if (streamTarget && this.config.streamChunk) {
      chunker = new BlockChunker(
        (chunk) => {
          streamedChunks.push(chunk)
          streamTarget.adapter.sendMessage(streamTarget.channelId, chunk).catch((err) => {
            console.error('[AgentGateway] Stream chunk send failed:', err.message)
          })
        },
        this.config.streamChunk,
      )
    }

    // UI stream writer: track current text/reasoning blocks for delta streaming
    let uiTextId: string | null = null
    let uiReasoningId: string | null = null
    let pendingToolkitError: string | null = null

    // Localhost -> public preview link rewriting (defense-in-depth). Active only
    // in cloud (a public preview URL exists); a pass-through on a developer
    // machine so local streaming is unchanged. The same rewrite is re-applied to
    // the persisted/returned text after the loop so history + channel replies
    // also never carry a localhost link the user can't open.
    const previewPublicUrl = (this.previewManager?.isLocalMode ?? detectLocalMode())
      ? ''
      : (process.env.PUBLIC_PREVIEW_URL ?? '')
    const shareLinkTokens = this.shareLinkTokensFor(sessionId)
    let linkRewriter = new LocalhostLinkRewriter(previewPublicUrl, shareLinkTokens)

    // Forward streamed assistant text (post-rewrite) to the chunker + UI,
    // opening a UI text block lazily on first non-empty content.
    const emitAssistantText = (text: string) => {
      if (!text) return
      if (chunker) chunker.push(text)
      if (uiWriter) {
        if (!uiTextId) {
          uiTextId = `text-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
          uiWriter.write({ type: 'text-start', id: uiTextId })
        }
        uiWriter.write({ type: 'text-delta', id: uiTextId, delta: text })
      }
    }
    // Drain any text the rewriter is holding (a trailing partial token) before a
    // text block is closed (tool call / retry / end of turn) so nothing is lost
    // or reordered across the boundary.
    const flushAssistantText = () => {
      emitAssistantText(linkRewriter.flush())
    }

    // A dropped model call is being re-issued. Close any in-progress
    // text/reasoning block so the client can drop the failed step's partial
    // deltas, then emit an explicit marker the client + the API-side
    // accumulator key on to reset (avoids concatenating the discarded partial
    // with the regenerated output).
    const discardFailedStep = (retry: { attempt: number; maxAttempts?: number; reason: string; delayMs: number }) => {
      // Drop any text the rewriter was holding from the failed attempt and
      // reset its scanner state so the regenerated output starts clean.
      linkRewriter = new LocalhostLinkRewriter(previewPublicUrl, shareLinkTokens)
      if (uiWriter && uiTextId) {
        uiWriter.write({ type: 'text-end', id: uiTextId })
        uiTextId = null
      }
      if (uiWriter && uiReasoningId) {
        uiWriter.write({ type: 'reasoning-end', id: uiReasoningId })
        uiReasoningId = null
      }
      if (uiWriter) {
        uiWriter.write({ type: 'data-inference-retry', data: retry } as any)
      }
    }

    // True between a provider-backoff heartbeat and the re-issued call's first
    // output, so the client's "retrying" banner clears as soon as the model
    // is producing again.
    let providerBackoffActive = false
    // Telemetry flags, reset per retry episode.
    let longRetryReported = false
    let noProgressReported = false
    const retryCtx = () => ({ sessionId, model: modelId, provider })
    const endProviderBackoff = () => {
      if (!providerBackoffActive) return
      providerBackoffActive = false
      if (uiWriter) {
        uiWriter.write({
          type: 'data-connectivity-wait',
          data: { state: 'reconnected', cause: 'provider' },
          transient: true,
        } as any)
      }
    }

    // Gate map: onBeforeToolCall stores a promise per toolCallId that
    // resolves once the tool-input-start SSE events have had time to
    // flush to the client.  onAfterToolCall awaits this promise before
    // writing tool-output events, preventing React from batching all
    // tool events into a single render that skips the loading state.
    const toolFlushGates = new Map<string, Promise<void>>()
    const toolHeartbeatTimers = new Map<string, ReturnType<typeof setInterval>>()

    const streamedToolCalls = new Set<string>()

    const turnAbort = new AbortController()
    this.turnAbortControllers.set(sessionId, turnAbort)
    const retryWaker = new RetryWaker()
    this.retryWakers.set(sessionId, retryWaker)

    // Stream live process-list updates to the UI for the duration of this turn.
    // The registry persists across turns; this subscription is per-turn so it
    // is torn down when the stream closes.
    //
    // Status frames below (process list, context usage, connectivity wait,
    // tool progress) are `transient`: the client consumes them in `onData`,
    // and the AI SDK would otherwise append each one to `message.parts`.
    let unsubscribeProcesses: (() => void) | undefined
    let remoteRefreshTimer: ReturnType<typeof setInterval> | undefined
    if (sessionId) {
      const wake = this.taskWakeTimers.get(sessionId)
      if (wake) {
        clearTimeout(wake)
        this.taskWakeTimers.delete(sessionId)
      }
      const reg = this.getOrCreateCommandRegistry(sessionId)
      // Remote tasks finish on the API's side; refresh them so the loop can
      // inject their results mid-turn like any local task.
      if (reg.hasRunningRemote()) void reg.refreshRemote()
      remoteRefreshTimer = setInterval(() => {
        if (reg.hasRunningRemote()) void reg.refreshRemote()
      }, TURN_REMOTE_REFRESH_MS)
      ;(remoteRefreshTimer as any).unref?.()
    }
    if (uiWriter && sessionId) {
      const reg = this.getOrCreateCommandRegistry(sessionId)
      const visibleKey = (tasks: readonly { runId: string; status: string }[]) =>
        tasks.map((task) => `${task.runId}:${task.status}`).join('\0')
      const writeTasks = (tasks: ReturnType<typeof reg.listDock>) => {
        uiWriter.write({ type: 'data-task-update', data: { tasks }, transient: true } as any)
        uiWriter.write({ type: 'data-process-update', data: { processes: tasks }, transient: true } as any)
      }
      // Push the current list immediately so a reconnecting client re-syncs.
      // `listDock` keeps a settled task as a terminal row, so a row that
      // finishes during the turn updates in place instead of vanishing.
      const initialTasks = reg.listDock()
      let lastVisibleKey = visibleKey(initialTasks)
      try {
        writeTasks(initialTasks)
      } catch { /* writer may already be closed */ }
      unsubscribeProcesses = reg.onChange(() => {
        const tasks = reg.listDock()
        const nextKey = visibleKey(tasks)
        if (nextKey === lastVisibleKey) return
        lastVisibleKey = nextKey
        try {
          writeTasks(tasks)
        } catch { /* writer closed — onChange teardown happens in finally */ }
      })
    }

    try {
      const hookEmitter = this.hookEmitter
      let runningContextEstimate = this.sessionManager.estimateTokens(session)
      const contextWindowTokens = this.sessionManager.contextWindowTokens

      // Throttle data-context-usage emissions — at most once per 5s during
      // long-running agent turns with many tool calls. Without this, every
      // tool execution emits an update, flooding the client SSE stream.
      let lastContextUsageEmitMs = 0
      const CONTEXT_USAGE_THROTTLE_MS = 5_000
      const emitContextUsage = () => {
        const now = Date.now()
        if (uiWriter && now - lastContextUsageEmitMs >= CONTEXT_USAGE_THROTTLE_MS) {
          lastContextUsageEmitMs = now
          uiWriter.write({
            type: 'data-context-usage',
            data: { inputTokens: runningContextEstimate, contextWindowTokens },
            transient: true,
          } as any)
        }
      }

      // Always emit the initial estimate immediately
      if (uiWriter) {
        lastContextUsageEmitMs = Date.now()
        uiWriter.write({
          type: 'data-context-usage',
          data: { inputTokens: runningContextEstimate, contextWindowTokens },
          transient: true,
        } as any)
      }

      // Prompt breakdown: compute tool schema size and emit per-section breakdown
      if (this.lastPromptBreakdown) {
        // ---- 1) Per-tool schema sizing ----
        // Only the advertised set is sent (SHO-97). Deferred tools are counted,
        // not sized: their cost per request is zero, which is the whole point.
        const advertisedTools = isAdvertisedTool ? tools.filter(t => isAdvertisedTool(t)) : [...tools]
        const deferredToolCount = tools.length - advertisedTools.length
        const toolSizes = advertisedTools.map(t => {
          const schema = JSON.stringify({ name: t.name, description: t.description, input_schema: t.parameters })
          return { name: t.name, chars: schema.length }
        })
        const toolSchemaChars = toolSizes.reduce((s, t) => s + t.chars, 0)
        const toolSchemaEstTokens = Math.ceil(toolSchemaChars / 4)
        const toolSchemasPerTool = toolSizes
          .map(t => ({ name: t.name, chars: t.chars, estTokens: Math.ceil(t.chars / 4) }))
          .sort((a, b) => b.chars - a.chars || a.name.localeCompare(b.name))

        // ---- 2) Chat-context (history + prompt) sizing ----
        // Walks `history` and aggregates char counts per category, with per-tool
        // sub-buckets for assistant tool_use blocks and toolResult messages.
        // Mirrors the sizing approach used in prefix-fingerprint.approxMessageChars.
        const compactedSummaryChars = session.compactedSummary?.length ?? 0
        let userMessagesChars = 0
        let userMessagesCount = 0
        let assistantTextChars = 0
        let assistantTextCount = 0
        let assistantThinkingChars = 0
        let assistantToolCallsChars = 0
        let assistantToolCallsCount = 0
        let toolResultsChars = 0
        let toolResultsCount = 0
        const perToolUse = new Map<string, { chars: number; count: number }>()
        const perToolResult = new Map<string, { chars: number; count: number }>()

        // The synthesized "[Previous conversation summary]" user message and its
        // assistant ack inserted by SessionManager.buildHistory get counted under
        // `compacted-summary` instead of user/assistant categories so the source
        // summary length isn't reported twice.
        const SUMMARY_USER_PREFIX = '[Previous conversation summary]'
        const SUMMARY_ACK_PREFIX = 'Understood, I have the context'

        for (const msg of history) {
          if (msg.role === 'user') {
            const content = (msg as any).content
            if (typeof content === 'string') {
              if (content.startsWith(SUMMARY_USER_PREFIX)) continue
              userMessagesChars += content.length
              userMessagesCount++
            } else if (Array.isArray(content)) {
              let chars = 0
              let isSummary = false
              for (const block of content) {
                if (block?.type === 'text') {
                  const t: string = block.text ?? ''
                  if (t.startsWith(SUMMARY_USER_PREFIX)) { isSummary = true; break }
                  chars += t.length
                }
              }
              if (isSummary) continue
              userMessagesChars += chars
              userMessagesCount++
            }
            continue
          }
          if (msg.role === 'assistant') {
            const content = ((msg as any).content as any[]) || []
            let isSummaryAck = false
            let textChars = 0
            let toolCallChars = 0
            let toolCallsHere = 0
            let thinkingChars = 0
            const localToolUse: Array<{ name: string; chars: number }> = []
            for (const block of content) {
              if (block?.type === 'text') {
                const t: string = block.text ?? ''
                if (t.startsWith(SUMMARY_ACK_PREFIX)) { isSummaryAck = true; break }
                textChars += t.length
              } else if (block?.type === 'toolCall') {
                const argsStr = JSON.stringify(block.arguments ?? {})
                const c = argsStr.length
                toolCallChars += c
                toolCallsHere++
                const name: string = block.name ?? '<unknown>'
                localToolUse.push({ name, chars: c })
              } else if (block?.type === 'thinking') {
                thinkingChars += ((block as any).thinking ?? '').length
              }
            }
            if (isSummaryAck) continue
            assistantTextChars += textChars
            assistantThinkingChars += thinkingChars
            assistantToolCallsChars += toolCallChars
            assistantToolCallsCount += toolCallsHere
            if (textChars > 0) assistantTextCount++
            for (const t of localToolUse) {
              const cur = perToolUse.get(t.name) ?? { chars: 0, count: 0 }
              cur.chars += t.chars
              cur.count += 1
              perToolUse.set(t.name, cur)
            }
            continue
          }
          if (msg.role === 'toolResult') {
            const tr = msg as any
            const content = (tr.content as any[]) || []
            let chars = 0
            for (const c of content) {
              if (c?.type === 'text') chars += (c.text?.length ?? 0)
            }
            toolResultsChars += chars
            toolResultsCount++
            const name: string = tr.toolName ?? '<unknown>'
            const cur = perToolResult.get(name) ?? { chars: 0, count: 0 }
            cur.chars += chars
            cur.count += 1
            perToolResult.set(name, cur)
            continue
          }
        }

        const currentPromptChars = prompt.length
        const chatContextChars = compactedSummaryChars
          + userMessagesChars
          + assistantTextChars
          + assistantThinkingChars
          + assistantToolCallsChars
          + toolResultsChars
          + currentPromptChars
        const chatContextEstTokens = Math.ceil(chatContextChars / 4)

        // ---- 3) System prompt totals (existing) ----
        const breakdown = this.lastPromptBreakdown
        const totalChars = breakdown.reduce((s, sec) => s + sec.chars, 0)
        const totalEstTokens = breakdown.reduce((s, sec) => s + sec.estTokens, 0)
        const grandEstTokens = totalEstTokens + toolSchemaEstTokens + chatContextEstTokens

        // ---- 4) Render log lines ----
        // Keep the colon column fixed across hierarchy levels so columns align.
        // Parent labels live at 2-space indent (`  label    :`), children at 4-space
        // (`    label    :`), sub-children at 6-space (`      label    :`).
        const candidateLabels = [
          ...breakdown.map(s => s.label.length),
          'tool-schemas (XX)'.length,
          `Tool schemas (${advertisedTools.length})`.length,
          `deferred (${deferredToolCount} tools, not sent)`.length + 2,
          `Chat context (${history.length} msgs)`.length,
          'assistant-tool-calls (XXX)'.length + 2, // children sit 2 chars deeper
          'compacted-summary'.length + 2,
        ]
        // Also factor in the longest top-tool name (top 10) so child rows don't overflow
        for (const t of toolSchemasPerTool.slice(0, 10)) {
          candidateLabels.push(t.name.length + 2)
        }
        for (const [name, v] of perToolUse) {
          candidateLabels.push(`${name} (${v.count})`.length + 4)
        }
        for (const [name, v] of perToolResult) {
          candidateLabels.push(`${name} (${v.count})`.length + 4)
        }
        const maxLabel = Math.max(...candidateLabels)
        const childLabelWidth = maxLabel - 2
        const subChildLabelWidth = maxLabel - 4

        const lines = ['[AgentGateway] Prompt breakdown:']
        for (const sec of breakdown) {
          const tag = sec.zone === 'stable' ? 'S' : 'D'
          lines.push(`  ${sec.label.padEnd(maxLabel)} [${tag}]: ${sec.chars.toLocaleString().padStart(7)} chars ~${sec.estTokens.toLocaleString().padStart(6)} tok`)
        }
        lines.push(`  ${''.padEnd(maxLabel + 30, '─')}`)
        lines.push(`  ${'System prompt total'.padEnd(maxLabel)}    : ${totalChars.toLocaleString().padStart(7)} chars ~${totalEstTokens.toLocaleString().padStart(6)} tok`)

        const fmtParent = (label: string, chars: number, estTokens: number) =>
          `  ${label.padEnd(maxLabel)}    : ${chars.toLocaleString().padStart(7)} chars ~${estTokens.toLocaleString().padStart(6)} tok`
        const fmtChild = (label: string, chars: number) =>
          `    ${label.padEnd(childLabelWidth)}    : ${chars.toLocaleString().padStart(7)} chars ~${Math.ceil(chars / 4).toLocaleString().padStart(6)} tok`
        const fmtSubChild = (label: string, chars: number) =>
          `      ${label.padEnd(subChildLabelWidth)}    : ${chars.toLocaleString().padStart(7)} chars ~${Math.ceil(chars / 4).toLocaleString().padStart(6)} tok`

        // Tool schemas: parent (advertised) + per-tool top 10 + other + deferred
        lines.push(fmtParent(`Tool schemas (${advertisedTools.length})`, toolSchemaChars, toolSchemaEstTokens))
        const TOP_SCHEMAS = 10
        const topSchemas = toolSchemasPerTool.slice(0, TOP_SCHEMAS)
        const restSchemas = toolSchemasPerTool.slice(TOP_SCHEMAS)
        for (const t of topSchemas) {
          lines.push(fmtChild(t.name, t.chars))
        }
        if (restSchemas.length > 0) {
          const rChars = restSchemas.reduce((s, t) => s + t.chars, 0)
          lines.push(fmtChild(`other (${restSchemas.length} tools)`, rChars))
        }
        if (deferredToolCount > 0) {
          lines.push(fmtChild(`deferred (${deferredToolCount} tools, not sent)`, 0))
        }

        // Chat context: parent + per-category children, with per-tool sub-children
        lines.push(fmtParent(`Chat context (${history.length} msgs)`, chatContextChars, chatContextEstTokens))
        if (compactedSummaryChars > 0) lines.push(fmtChild('compacted-summary', compactedSummaryChars))
        if (userMessagesCount > 0) lines.push(fmtChild(`user-messages (${userMessagesCount})`, userMessagesChars))
        if (assistantTextCount > 0) lines.push(fmtChild(`assistant-text (${assistantTextCount})`, assistantTextChars))
        if (assistantThinkingChars > 0) lines.push(fmtChild('assistant-thinking', assistantThinkingChars))
        const TOP_PER_TOOL = 5
        if (assistantToolCallsCount > 0) {
          lines.push(fmtChild(`assistant-tool-calls (${assistantToolCallsCount})`, assistantToolCallsChars))
          const sortedUse = [...perToolUse.entries()]
            .map(([name, v]) => ({ name, ...v }))
            .sort((a, b) => b.chars - a.chars || a.name.localeCompare(b.name))
          const topUse = sortedUse.slice(0, TOP_PER_TOOL)
          const restUse = sortedUse.slice(TOP_PER_TOOL)
          for (const t of topUse) lines.push(fmtSubChild(`${t.name} (${t.count})`, t.chars))
          if (restUse.length > 0) {
            const rChars = restUse.reduce((s, t) => s + t.chars, 0)
            lines.push(fmtSubChild(`other (${restUse.length} tools)`, rChars))
          }
        }
        if (toolResultsCount > 0) {
          lines.push(fmtChild(`tool-results (${toolResultsCount})`, toolResultsChars))
          const sortedTr = [...perToolResult.entries()]
            .map(([name, v]) => ({ name, ...v }))
            .sort((a, b) => b.chars - a.chars || a.name.localeCompare(b.name))
          const topTr = sortedTr.slice(0, TOP_PER_TOOL)
          const restTr = sortedTr.slice(TOP_PER_TOOL)
          for (const t of topTr) lines.push(fmtSubChild(`${t.name} (${t.count})`, t.chars))
          if (restTr.length > 0) {
            const rChars = restTr.reduce((s, t) => s + t.chars, 0)
            lines.push(fmtSubChild(`other (${restTr.length} tools)`, rChars))
          }
        }
        if (currentPromptChars > 0) lines.push(fmtChild('current-prompt', currentPromptChars))

        lines.push(`  ${''.padEnd(maxLabel + 30, '─')}`)
        lines.push(`  ${'Grand total'.padEnd(maxLabel)}    :                ~${grandEstTokens.toLocaleString().padStart(6)} tok`)
        console.log(lines.join('\n'))

        const sortedToolUseEntries = [...perToolUse.entries()]
          .map(([name, v]) => ({ name, count: v.count, chars: v.chars, estTokens: Math.ceil(v.chars / 4) }))
          .sort((a, b) => b.chars - a.chars || a.name.localeCompare(b.name))
        const sortedToolResultEntries = [...perToolResult.entries()]
          .map(([name, v]) => ({ name, count: v.count, chars: v.chars, estTokens: Math.ceil(v.chars / 4) }))
          .sort((a, b) => b.chars - a.chars || a.name.localeCompare(b.name))

        const chatContextCategories: Array<{
          key: string
          count?: number
          chars: number
          estTokens: number
          perTool?: Array<{ name: string; count: number; chars: number; estTokens: number }>
        }> = []
        if (compactedSummaryChars > 0) chatContextCategories.push({ key: 'compacted-summary', chars: compactedSummaryChars, estTokens: Math.ceil(compactedSummaryChars / 4) })
        if (userMessagesCount > 0) chatContextCategories.push({ key: 'user-messages', count: userMessagesCount, chars: userMessagesChars, estTokens: Math.ceil(userMessagesChars / 4) })
        if (assistantTextCount > 0) chatContextCategories.push({ key: 'assistant-text', count: assistantTextCount, chars: assistantTextChars, estTokens: Math.ceil(assistantTextChars / 4) })
        if (assistantThinkingChars > 0) chatContextCategories.push({ key: 'assistant-thinking', chars: assistantThinkingChars, estTokens: Math.ceil(assistantThinkingChars / 4) })
        if (assistantToolCallsCount > 0) chatContextCategories.push({
          key: 'assistant-tool-calls',
          count: assistantToolCallsCount,
          chars: assistantToolCallsChars,
          estTokens: Math.ceil(assistantToolCallsChars / 4),
          perTool: sortedToolUseEntries,
        })
        if (toolResultsCount > 0) chatContextCategories.push({
          key: 'tool-results',
          count: toolResultsCount,
          chars: toolResultsChars,
          estTokens: Math.ceil(toolResultsChars / 4),
          perTool: sortedToolResultEntries,
        })

        // ---- 5) UI-facing category rollup ----
        // Collapses the detailed breakdown above into the 6 buckets the
        // client's context-usage popover renders (mirrors Cursor's own
        // "Context Usage" popup): System prompt, Tool definitions, Skills,
        // MCP & dynamic tools, Subagent definitions, Conversation. Additive
        // to the payload — every field above stays as-is so the evals
        // runner (which reads `sections`/`grandEstTokens` etc.) is unaffected.
        const SKILL_SECTION_LABELS = new Set(['skills', 'skill-server'])
        const SUBAGENT_TOOL_NAMES = new Set(['agent_create', 'agent_spawn', 'agent_status', 'agent_cancel', 'agent_result'])

        let systemPromptCatTokens = 0
        let skillsCatTokens = 0
        let dynamicOtherCatTokens = 0
        for (const sec of breakdown) {
          if (sec.zone === 'stable') systemPromptCatTokens += sec.estTokens
          else if (SKILL_SECTION_LABELS.has(sec.label)) skillsCatTokens += sec.estTokens
          else dynamicOtherCatTokens += sec.estTokens
        }

        let toolDefCatTokens = 0
        let mcpToolCatTokens = 0
        let subagentToolCatTokens = 0
        for (const t of toolSchemasPerTool) {
          if (t.name.startsWith('mcp_')) mcpToolCatTokens += t.estTokens
          else if (SUBAGENT_TOOL_NAMES.has(t.name)) subagentToolCatTokens += t.estTokens
          else toolDefCatTokens += t.estTokens
        }

        const categories = [
          { key: 'system-prompt', label: 'System prompt', estTokens: systemPromptCatTokens },
          { key: 'tool-definitions', label: 'Tool definitions', estTokens: toolDefCatTokens },
          { key: 'skills', label: 'Skills', estTokens: skillsCatTokens },
          { key: 'mcp-dynamic-tools', label: 'MCP & dynamic tools', estTokens: mcpToolCatTokens + dynamicOtherCatTokens },
          { key: 'subagent-definitions', label: 'Subagent definitions', estTokens: subagentToolCatTokens },
          { key: 'conversation', label: 'Conversation', estTokens: chatContextEstTokens },
        ]

        const breakdownPayload = {
          sections: breakdown,
          totalChars,
          totalEstTokens,
          toolSchemaChars,
          toolSchemaEstTokens,
          toolCount: advertisedTools.length,
          registeredToolCount: tools.length,
          deferredToolCount,
          toolSchemasPerTool,
          chatContext: {
            totalChars: chatContextChars,
            totalEstTokens: chatContextEstTokens,
            messageCount: history.length,
            categories: chatContextCategories,
            currentPromptChars,
            currentPromptEstTokens: Math.ceil(currentPromptChars / 4),
          },
          categories,
          grandEstTokens,
        }

        if (uiWriter) {
          uiWriter.write({ type: 'data-prompt-breakdown', data: breakdownPayload } as any)
        }
      }

      const maxIterations = parseInt(process.env.AGENT_MAX_ITERATIONS || '200', 10)
      // Notes that settled before this turn began already have (or will get)
      // their own queued wake, whose message carries the task. Injecting them
      // here would mark them consumed and the dispatcher would drop that wake
      // as already seen — so only notes that finish *during* the turn are
      // injected. A runtime with no internal API credentials can never queue
      // that wake, so there the turn sweeps every pending note instead; see
      // takeInjectedMessages below.
      const turnStartedAt = Date.now()
      const canQueueTaskWake = hasInternalApiCredentials()

      // --- Prefix-cache snapshot ---------------------------------------------
      // Everything a provider keys its prompt cache on, as short hashes:
      // (tools, system split stable/dynamic, message list). Anthropic keys on
      // those three exactly; DeepSeek (which backs `hoshi`) matches complete
      // persisted prefix units of the same three and gives us no breakpoint to
      // set, so layout stability is the only lever. One line per turn makes
      // "did this turn waste the cache?" answerable, and the same object rides
      // the `data-usage` frame so an eval can assert a ratio against the exact
      // prefix it was measured on. Silenced with SHOGO_PREFIX_LOG=0.
      const turnNum = (this.turnCounters.get(sessionId) ?? 0) + 1
      this.turnCounters.set(sessionId, turnNum)
      const systemPrint = fingerprintSystem(systemPrompt)
      const toolsPrint = fingerprintTools(tools)
      const historyPrint = fingerprintMessages(history)
      const prefix: CachePrefix = {
        turn: turnNum,
        stableHash: systemPrint.stableHash,
        dynamicHash: systemPrint.dynamicHash,
        toolsHash: toolsPrint.hash,
        historyHash: historyPrint.aggregate,
        stableChars: systemPrint.stableChars,
        dynamicChars: systemPrint.dynamicChars,
        toolCount: toolsPrint.count,
        messageCount: historyPrint.count,
      }
      if (process.env.SHOGO_PREFIX_LOG !== '0') {
        console.log(
          `${this.logPrefix} [cache-prefix] turn=${turnNum} stable=${prefix.stableHash}(${prefix.stableChars}c) ` +
          `dynamic=${prefix.dynamicHash}(${prefix.dynamicChars}c) tools=${prefix.toolsHash}(${prefix.toolCount}) ` +
          `history=${prefix.historyHash}(${prefix.messageCount} msgs)`,
        )
      }

      // --- Turn-boundary telemetry (SHO-122) ---------------------------------
      // The previous turn, as the model will actually see it on this turn's
      // first request: every message, every tool call by name, and how much of
      // it is already a placeholder. `prefixStable` is the cache-relevant
      // invariant — this turn's prefix still begins with the previous turn's.
      const knownPrefix = this.turnPrefixes.get(sessionId)
      const prefixStable = knownPrefix ? isPrefixOf(knownPrefix, historyPrint.positions) : null
      this.turnPrefixes.set(sessionId, historyPrint.positions)
      const previousTurn = summariseTurn(history, lastTurnStart(history))

      // Reset per-turn edit tracking so read_lints auto-scope starts clean.
      this.fileStateCache.resetTurn()

      // Stamp every outbound ai-proxy call with the chat session id so the
      // API-side billing session is keyed by (projectId, chatSessionId) and
      // concurrent chat panels on the same project bill independently. The
      // 'chat' / 'default' / 'webhook' sentinel ids that internal flows use
      // aren't real ChatSession rows; skip the header so the API falls back
      // to the legacy projectId-only key for those callers.
      const isRealChatSession = !!sessionId &&
        sessionId !== 'chat' &&
        sessionId !== 'default' &&
        sessionId !== 'webhook'
      const extraHeaders: Record<string, string> | undefined = isRealChatSession
        ? { 'x-chat-session-id': sessionId }
        : undefined

      // Mid-turn summarization (SHO-96). pi-agent-core drives the tool loop, so
      // `transformContext` is the only point we control between tool calls —
      // that is where this fires. One instance per turn: a new turn starts
      // fresh, which is what makes "one summary per turn" and the mid-turn
      // manual request both meaningful.
      const promptOverheadTokens =
        Math.ceil(systemPrompt.length / 4) +
        tools.reduce((sum, t) => {
          const schema = JSON.stringify({ name: t.name, description: t.description, input_schema: t.parameters })
          return sum + Math.ceil(schema.length / 4)
        }, 0)
      // Per-call prefix fingerprints for this turn, paired with the provider's
      // reported cache writes at turn end (`SHOGO_PREFIX_LOG=0` silences it).
      const callFingerprints: Array<{
        hash: string
        msgs: number
        chars: number
        compacted: 'auto' | 'manual' | null
      }> = []
      const midTurnCompactor = new MidTurnAutocompactor({
        autoCompactTokens,
        // Aggressive tail: the head is what blew past the cap, and the split
        // already lands on a `user` boundary, so the recent turn survives.
        keepRecentMessages: MIDTURN_KEEP_RECENT_MESSAGES,
        // A count of messages is not a size: production turns carry single tool
        // results of hundreds of thousands of tokens, so the kept tail is
        // bounded in tokens too and the post-compaction request lands at ~40%
        // of the cap rather than back at it.
        tailBudgetTokens: this.sessionManager.compactionTailBudgetTokens,
        minKeepMessages: 1,
        promptOverheadTokens,
        summarize: (head, previousSummary) => this.sessionManager.summarizeHead(head, previousSummary),
        apply: (summary, splitIndex, opts) => {
          // Session-relative index: the loop's array may include a head that a
          // previous compaction already folded away.
          this.sessionManager.applyCompaction(sessionId, {
            summary,
            splitIndex,
            replaceSummary: opts.replaceSummary,
            extraContext: this.fileStateCache.size > 0
              ? this.fileStateCache.getSummary(this.workspaceDir)
              : undefined,
          })
        },
      })

      const loopOptions: Parameters<typeof runAgentLoop>[0] = {
        provider,
        model: modelId,
        system: systemPrompt,
        history,
        prompt,
        images,
        tools,
        maxIterations,
        // Deferred tool schemas stay out of every provider request until the
        // model asks for them by name (SHO-97). Read per API call by the loop.
        isAdvertisedTool,
        loopDetection: this.config.loopDetection,
        streamFn: this._streamFn,
        thinkingLevel: resolveThinkingLevel(
          autoRouting ? undefined : session.modelOverride,
          autoRouting ? undefined : this.config.model.thinkingLevel,
        ),
        signal: turnAbort.signal,
        inferenceRetry: { waker: retryWaker },
        onRetryEpisodeEnd: (summary) => {
          longRetryReported = false
          noProgressReported = false
          recordRetryEpisode(retryCtx(), summary)
        },
        extraHeaders,
        // Stage 1 of the image-400 repair ladder: drop only the blocks that
        // provably cannot decode, instead of every image in history.
        scrubInvalidImages,
        onContextOverflow: async () => {
          console.warn(`${this.logPrefix} Layer 5: Reactive compaction for session ${sessionId}`)
          const fileStateSummary = this.fileStateCache.size > 0
            ? this.fileStateCache.getSummary(this.workspaceDir)
            : undefined
          const r = await this.sessionManager.compact(sessionId, fileStateSummary, 4)
          if (!r) return null
          turnCompaction = { before: r.messagesBefore, after: r.messagesAfter }
          recordCompaction({
            sessionId,
            trigger: 'reactive',
            messagesBefore: r.messagesBefore,
            messagesAfter: r.messagesAfter,
            summaryChars: r.summary.length,
            filesTouched: r.filesTouched ?? [],
            toolsUsed: r.toolsUsed ?? [],
            foldedRounds: r.foldedRounds ?? 0,
          })
          console.log(`${this.logPrefix} Reactive compaction: ${r.messagesBefore} -> ${r.messagesAfter} messages`)
          // LLM autocompact rewrites the prefix — drop per-session replacement
          // decisions so fresh ones are taken against the new history. Keeping
          // stale entries is correctness-safe (inert) but wastes memory and
          // can mis-freeze an id that survived into the summary.
          this.contentReplacementStates.delete(sessionId)
          let h = this.sessionManager.buildHistory(sessionId)
          h = applyToolResultBudget(h, contextBudgetChars)
          h = microcompact(h).messages
          h = snipConsumedResults(h)
          return h
        },
        // Per-API-call transform. This runs before EVERY LLM request inside
        // the agent loop (every tool-use iteration). The stable wrapper makes
        // compaction decisions monotone and write-once per tool_call_id so
        // the prompt-cache prefix stays byte-identical across calls for any
        // id that's already been decided. See stable-compaction.ts.
        //
        // After the three cheap layers: if the request that is about to go on
        // the wire is still over the cap, summarize between tool calls (SHO-96).
        transformContext: async (messages) => {
          if (this.manualCompactionRequests.delete(sessionId)) {
            midTurnCompactor.requestManual()
          }
          let state = this.contentReplacementStates.get(sessionId)
          if (!state) {
            state = createContentReplacementState()
            this.contentReplacementStates.set(sessionId, state)
          }
          const result = stableTransformContext(messages, state, contextBudgetChars, {
            budgetTokens: inLoopBudgetTokens,
          })
          if (result.stats.checkpointCleared > 0) {
            console.log(
              `${this.logPrefix} In-loop checkpoint: cleared ${result.stats.checkpointCleared} older tool results ` +
              `(budget ${inLoopBudgetTokens} tokens) for session ${sessionId}`,
            )
          }
          // Final guard: self-heal any image block in history that no provider
          // can accept — corrupt/truncated bytes, an unsupported format, or an
          // oversized payload — before it reaches the wire. Deterministic, so it
          // does not disturb the stable-compaction byte-identical prefix
          // invariant.
          const wire = scrubInvalidImages(result.messages)
          const compacted = await midTurnCompactor.transform(wire)
          const event = compacted.event
          if (event) {
            // The prefix was rewritten: drop per-session replacement decisions so
            // fresh ones are taken against the new history (same rule as the
            // turn-boundary and reactive paths).
            this.contentReplacementStates.delete(sessionId)
            runningContextEstimate = event.tokensAfter
            recordCompaction({
              sessionId,
              trigger: 'mid-turn',
              messagesBefore: event.messagesBefore,
              messagesAfter: event.messagesAfter,
              summaryChars: event.summaryChars,
              filesTouched: [],
              toolsUsed: [],
            })
            console.log(
              `${this.logPrefix} Mid-turn summarization (${event.trigger}): ` +
              `${event.tokensBefore} -> ${event.tokensAfter} tokens, ` +
              `${event.messagesBefore} -> ${event.messagesAfter} messages ` +
              `(cap ${autoCompactTokens}, window ${contextWindowTokens}) for session ${sessionId}`,
            )
            // Cache-break attribution: the prefix fingerprint changes exactly
            // once per compaction and is stable afterwards (prefix-fingerprint
            // had no caller until SHO-96).
            try {
              const before = fingerprintMessages(wire)
              const after = fingerprintMessages(compacted.messages)
              console.log(
                `${this.logPrefix} Prefix fingerprint: ${before.aggregate} (${before.totalChars} chars, ` +
                `${before.count} msgs) -> ${after.aggregate} (${after.totalChars} chars, ${after.count} msgs)`,
              )
            } catch { /* diagnostics only */ }
            // Not transient: this frame IS a transcript row. The AI SDK appends
            // it to `parts` live, and the API persists the same shape, so the
            // divider survives a reload (SHO-96 acceptance 4).
            try {
              uiWriter?.write({
                type: 'data-context-summarized',
                data: {
                  trigger: event.trigger,
                  tokensBefore: event.tokensBefore,
                  tokensAfter: event.tokensAfter,
                  messagesBefore: event.messagesBefore,
                  messagesAfter: event.messagesAfter,
                  summaryChars: event.summaryChars,
                  contextWindowTokens,
                },
              })
            } catch { /* client disconnected mid-turn — the row still persists API-side */ }
            emitContextUsage()
          }
          if (process.env.SHOGO_PREFIX_LOG !== '0') {
            // Per-call attribution (SHO-96 criterion 10): the fingerprint of the
            // exact bytes about to be sent, paired at turn end with the cache
            // writes the provider reports for that call. Without this pairing a
            // cache write cannot be told apart from a genuine prefix rewrite —
            // production shows 11.8k written tokens per opus call, more than the
            // new content each call carries.
            try {
              const print = fingerprintMessages(compacted.messages)
              callFingerprints.push({
                hash: print.aggregate,
                msgs: print.count,
                chars: print.totalChars,
                compacted: event ? event.trigger : null,
              })
            } catch { /* diagnostics only */ }
          }
          return compacted.messages
        },
        onToolCall: (name, input) => {
          console.log(`${this.logPrefix} Tool call: ${name}`, JSON.stringify(input).substring(0, 20))
        },
        // First call of the turn carries the cache numbers `context_turn_boundary`
        // reports: input/cacheRead/cacheWrite as the provider billed them.
        onIteration: (iteration, info) => {
          if (iteration === 1 && info?.usage) {
            const usage = info.usage
            turnFirstCallUsage = {
              iteration: 1,
              input: usage.input ?? 0,
              output: usage.output ?? 0,
              cacheRead: usage.cacheRead ?? 0,
              cacheWrite: usage.cacheWrite ?? 0,
            }
          }
        },
        takeInjectedMessages: () => {
          // One message per finished task: the agent acts on each result as its
          // own note, not on a batch joined into one message.
          //
          // Without credentials the API cannot queue a wake for a note that
          // settled before this turn, so filtering by finishedAt would mean the
          // finished task's result is never delivered to anyone: take every
          // pending note there (its own message each, as before SHO-33).
          const notes = commandRegistry?.consumeCompletionNotes(
            canQueueTaskWake ? (note) => (note.finishedAt ?? 0) >= turnStartedAt : undefined,
          ) ?? []
          return notes.map((text) => ({
            role: 'user',
            content: text,
            timestamp: Date.now(),
            __shogoBackgroundNote: true,
          } as unknown as Message))
        },
        onProgress: (progressMessages) => {
          const durableMessages = progressMessages.filter((message) => {
            const tagged = (message as Message & { __shogoBackgroundNote?: boolean }).__shogoBackgroundNote
            return !tagged && !persistedProgressMessages.has(message)
          })
          if (durableMessages.length > 0) {
            this.sessionManager.addMessages(sessionId, ...durableMessages)
            for (const message of durableMessages) persistedProgressMessages.add(message)
          }
        },
        onThinkingStart: () => {
          endProviderBackoff()
          if (uiWriter) {
            uiReasoningId = `reasoning-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
            uiWriter.write({ type: 'reasoning-start', id: uiReasoningId })
          }
        },
        onThinkingDelta: (delta) => {
          if (uiWriter && uiReasoningId) {
            uiWriter.write({ type: 'reasoning-delta', id: uiReasoningId, delta })
          }
        },
        onThinkingEnd: () => {
          if (uiWriter && uiReasoningId) {
            uiWriter.write({ type: 'reasoning-end', id: uiReasoningId })
            uiReasoningId = null
          }
        },
        onTextDelta: (delta) => {
          endProviderBackoff()
          runningContextEstimate += Math.ceil(delta.length / 4)
          emitAssistantText(linkRewriter.push(delta))
        },
        onInferenceRetry: (info) => {
          discardFailedStep({
            attempt: info.attempt,
            maxAttempts: info.maxAttempts,
            reason: info.reason,
            delayMs: info.delayMs,
          })
          console.warn(
            `${this.logPrefix} Inference retry ${info.attempt}/${info.maxAttempts} ` +
              `(reason=${info.reason}, delay=${info.delayMs}ms) for session ${sessionId}`,
          )
        },
        // Layer 7: connectivity park. Fires when the fast inference-retry
        // budget above is exhausted but the failure is still classified
        // retryable and a probe URL resolved (desktop injects
        // AI_UPSTREAM_HEALTH_URL). Ticks at least every 15s while parked —
        // comfortably under both the client's 180s stall-watchdog threshold
        // (apps/mobile/lib/chat-stall-watchdog.ts) and the stream buffer's
        // grace window, so these heartbeats keep a long-parked turn's SSE
        // connection (and the buffer replay a reconnecting client resumes
        // into) alive instead of looking dead.
        onConnectivityWait: (info) => {
          if (info.elapsedMs >= LONG_RETRY_MS && !longRetryReported) {
            longRetryReported = true
            recordRetryLong(retryCtx(), { layer: 'connectivity_park', reason: 'network', attempt: info.attempt, elapsedMs: info.elapsedMs })
          }
          if (uiWriter) {
            uiWriter.write({
              type: 'data-connectivity-wait',
              data: {
                state: 'waiting',
                cause: 'offline',
                attempt: info.attempt,
                elapsedMs: info.elapsedMs,
                nextProbeInMs: info.nextProbeInMs,
              },
              transient: true,
            } as any)
          }
          console.warn(
            `${this.logPrefix} Connectivity park: attempt ${info.attempt}, ` +
              `elapsed ${Math.round(info.elapsedMs / 1000)}s, next probe in ${Math.round(info.nextProbeInMs / 1000)}s ` +
              `for session ${sessionId}`,
          )
        },
        // Fires once, right before the loop resumes generation after a
        // successful park. A terminal frame with a distinct `state` so the
        // client can clear its "waiting for connection" banner immediately
        // rather than waiting for the next content event.
        onConnectivityReconnected: () => {
          if (uiWriter) {
            uiWriter.write({
              type: 'data-connectivity-wait',
              data: { state: 'reconnected' },
              transient: true,
            } as any)
          }
          console.warn(`${this.logPrefix} Connectivity restored — resuming turn for session ${sessionId}`)
        },
        // Layer 8: provider backoff. The network is up but the provider keeps
        // failing; the loop is waiting `delayMs` before re-issuing. Each tick is
        // at most 30s apart, which also keeps the stream alive while waiting.
        onProviderBackoff: (info) => {
          discardFailedStep({
            attempt: info.attempt,
            reason: info.reason,
            delayMs: info.delayMs,
          })
          providerBackoffActive = true
          if (info.elapsedMs >= LONG_RETRY_MS && !longRetryReported) {
            longRetryReported = true
            recordRetryLong(retryCtx(), {
              layer: 'provider_backoff',
              reason: info.reason,
              attempt: info.attempt,
              elapsedMs: info.elapsedMs,
              error: info.error,
            })
          }
          if (info.suspectedDeterministic && !noProgressReported) {
            noProgressReported = true
            recordRetryNoProgress(retryCtx(), {
              reason: info.reason,
              attempt: info.attempt,
              elapsedMs: info.elapsedMs,
              error: info.error,
            })
          }
          if (uiWriter) {
            uiWriter.write({
              type: 'data-connectivity-wait',
              data: {
                state: 'waiting',
                cause: 'provider',
                reason: info.reason,
                attempt: info.attempt,
                elapsedMs: info.elapsedMs,
                nextProbeInMs: info.delayMs,
                suspectedDeterministic: info.suspectedDeterministic,
              },
              transient: true,
            } as any)
          }
          console.warn(
            `${this.logPrefix} Provider backoff ${info.attempt} (reason=${info.reason}, ` +
              `elapsed ${Math.round(info.elapsedMs / 1000)}s, retry in ${Math.round(info.delayMs / 1000)}s) for session ${sessionId}`,
          )
        },
        onToolCallStart: (toolName, toolCallId) => {
          endProviderBackoff()
          this._lastTool = toolName
          flushAssistantText()
          if (uiWriter && uiTextId) {
            uiWriter.write({ type: 'text-end', id: uiTextId })
            uiTextId = null
          }
          if (uiWriter) {
            uiWriter.write({ type: 'tool-input-start', toolCallId, toolName, dynamic: true })
            streamedToolCalls.add(toolCallId)
          }
        },
        onToolCallDelta: (toolName, delta, toolCallId) => {
          if (uiWriter) {
            uiWriter.write({ type: 'tool-input-delta', toolCallId, inputTextDelta: delta })
          }
        },
        onToolCallEnd: (_toolName, toolCallId) => {
        },
        onBeforeToolCall: async (toolName, args, toolCallId) => {
          flushAssistantText()
          if (uiWriter && uiTextId) {
            uiWriter.write({ type: 'text-end', id: uiTextId })
            uiTextId = null
          }
          if (uiWriter && !streamedToolCalls.has(toolCallId)) {
            uiWriter.write({ type: 'tool-input-start', toolCallId, toolName, dynamic: true })
            uiWriter.write({ type: 'tool-input-delta', toolCallId, inputTextDelta: JSON.stringify(args) })
          }
          if (uiWriter && !toolHeartbeatTimers.has(toolCallId)) {
            const startedAt = Date.now()
            const timer = setInterval(() => {
              try {
                uiWriter.write({
                  type: 'data-tool-progress',
                  data: {
                    toolCallId,
                    toolName,
                    elapsedMs: Date.now() - startedAt,
                    status: 'running',
                  },
                  transient: true,
                } as any)
              } catch {
                clearInterval(timer)
                toolHeartbeatTimers.delete(toolCallId)
              }
            }, 15_000)
            toolHeartbeatTimers.set(toolCallId, timer)
          }
          streamedToolCalls.delete(toolCallId)
          // Store a flush gate that resolves after a short delay, giving
          // the HTTP layer time to deliver the tool-input-start chunk to
          // the client before tool-output-available arrives.
          // NOTE: the pi-agent-core event system does NOT await this
          // callback before firing tool_execution_end, so onAfterToolCall
          // must explicitly await this gate.
          toolFlushGates.set(
            toolCallId,
            new Promise(resolve => setTimeout(resolve, 30)),
          )
          await hookEmitter.emit(
            HookEmitter.createEvent('tool', 'before', sessionId, {
              toolName, args, toolCallId, workspaceDir: this.workspaceDir,
            })
          )
        },
        onAfterToolCall: async (toolName, args, result, isError, toolCallId) => {
          const timer = toolHeartbeatTimers.get(toolCallId)
          if (timer) {
            clearInterval(timer)
            toolHeartbeatTimers.delete(toolCallId)
          }
          if (isError) {
            console.error(`${this.logPrefix} Tool error: ${toolName}`, JSON.stringify(result).substring(0, 500))
          } else {
            console.log(`${this.logPrefix} Tool result: ${toolName}`, JSON.stringify(result).substring(0, 20))
          }
          if (toolName === 'share_file' && !isError) {
            const resultText = typeof result === 'string' ? result : JSON.stringify(result ?? '')
            for (const token of extractShareLinkTokens([resultText])) shareLinkTokens.add(token)
          }
          // Wait for onBeforeToolCall's flush gate so the client receives
          // tool-input-start in a separate HTTP chunk before we send the output.
          const gate = toolFlushGates.get(toolCallId)
          if (gate) {
            await gate
            toolFlushGates.delete(toolCallId)
          }
          if (uiWriter) {
            uiWriter.write({ type: 'tool-input-available', toolCallId, toolName, input: args, dynamic: true })
            // ask_user is a UI-driven tool: suppress tool-output-available so the widget
            // stays in interactive (input-available) state until the user submits their
            // answer as the next user message.
            if (toolName === 'ask_user') return
            uiWriter.write({
              type: 'tool-output-available',
              toolCallId,
              output: isError ? { error: typeof result === 'string' ? result : JSON.stringify(result) } : (result ?? { success: true }),
            })

            if (isComposioTool(toolName) && !pendingToolkitError) {
              if (isError || hasErrorInResult(result)) {
                const toolkit = extractToolkitName(toolName)
                const rawStr = typeof result === 'string' ? result : JSON.stringify(result ?? '')
                let cleanError = rawStr
                try { const p = JSON.parse(rawStr); if (p?.error) cleanError = String(p.error) } catch {}
                pendingToolkitError = toolkit
                const authError = isAuthError(cleanError)
                uiWriter.write({
                  type: 'data-tool-error',
                  id: `tool-err-${toolCallId}`,
                  data: { toolkitName: toolkit, error: toUserMessage(toolkit, cleanError), isAuthError: authError },
                } as any)
              }
            }
          }
          const argsStr = typeof args === 'string' ? args : JSON.stringify(args ?? '')
          const resultStr = typeof result === 'string' ? result : JSON.stringify(result ?? '')
          runningContextEstimate += Math.ceil((argsStr.length + resultStr.length) / 4)
          emitContextUsage()

          await hookEmitter.emit(
            HookEmitter.createEvent('tool', 'after', sessionId, {
              toolName, args, result, isError, toolCallId, workspaceDir: this.workspaceDir,
            })
          )
        },
        onAgentEnd: async (loopResult) => {
          await hookEmitter.emit(
            HookEmitter.createEvent('agent', 'end', sessionId, {
              iterations: loopResult.iterations,
              toolCallCount: loopResult.toolCalls.length,
              inputTokens: loopResult.inputTokens,
              outputTokens: loopResult.outputTokens,
              loopDetected: !!loopResult.loopBreak,
              workspaceDir: this.workspaceDir,
            })
          )
        },
      }

      let result = await runAgentLoop(loopOptions)

      // A turn that produced nothing (no text, no tools) is usually a transient
      // model or provider hiccup that a manual resend fixes, so resend once
      // ourselves. Only the prompt and the empty reply were saved so far; drop
      // them so the retry doesn't record the user's message twice.
      if (!isHeartbeat && isEmptyTurnResult(result) && !turnAbort.signal.aborted) {
        this.sessionManager.removeMessages(sessionId, persistedProgressMessages)
        persistedProgressMessages.clear()
        console.warn(
          `${this.logPrefix} Empty model response for session ${sessionId} ` +
            `(model: ${modelId}, provider: ${provider}, outputTokens: ${result.outputTokens}` +
            `${result.error ? `, error: ${result.error.message}` : ''}) — retrying once`,
        )
        discardFailedStep({ attempt: 1, maxAttempts: 1, reason: 'empty_response', delayMs: 0 })
        const emptyResult = result
        result = await runAgentLoop(loopOptions)
        result.inputTokens += emptyResult.inputTokens
        result.outputTokens += emptyResult.outputTokens
        result.cacheReadTokens += emptyResult.cacheReadTokens
        result.cacheWriteTokens += emptyResult.cacheWriteTokens
        result.iterations += emptyResult.iterations
      }

      // Defense in depth for stale cloud configuration or a plan change that
      // happens after a runtime was spawned. Auto must not retry the same
      // forbidden model forever: lower the session ceiling once and re-issue
      // the turn on the next accessible tier.
      if (autoRouting && routingDecision && autoTiers && result.error) {
        const failure = classifyRetryability({ message: result.error.message })
        if (failure.reason === 'billing' || failure.reason === 'auth') {
          const configuredCeiling = session.autoTierCeiling ?? 'premium'
          const fallback = resolveAutoDowngrade(
            modelId,
            autoSelectedTier ?? configuredCeiling,
            autoTiers,
            failure.reason,
          )

          if (fallback) {
            this.sessionManager.setAutoTierCeiling(sessionId, fallback.tier)
            const fallbackProvider =
              autoProviderHints[fallback.model] ??
              inferProviderFromModel(fallback.model, this.config.model.provider)
            console.warn(
              `${this.logPrefix} Auto model rejected (${failure.reason}); ` +
              `downgrading ${modelId} -> ${fallback.model} for session ${sessionId}`,
            )
            if (uiWriter) {
              uiWriter.write({
                type: 'data-routing-fallback',
                data: {
                  fromModel: modelId,
                  toModel: fallback.model,
                  reason: failure.reason,
                },
              } as any)
            }

            const failedResult = result
            result = await runAgentLoop({
              ...loopOptions,
              provider: fallbackProvider,
              model: fallback.model,
            })
            // Keep subsequent bounded continuations on the accessible model
            // instead of accidentally reusing the rejected model from the
            // original loop options.
            provider = fallbackProvider
            modelId = fallback.model
            loopOptions.provider = fallbackProvider
            loopOptions.model = fallback.model
            // Preserve usage from the rejected call for billing/reporting,
            // while keeping only the successful retry's messages in history.
            result.inputTokens += failedResult.inputTokens
            result.outputTokens += failedResult.outputTokens
            result.cacheReadTokens += failedResult.cacheReadTokens
            result.cacheWriteTokens += failedResult.cacheWriteTokens
            result.iterations += failedResult.iterations
            result.toolCalls = [...failedResult.toolCalls, ...result.toolCalls]
          }
        }
      }

      // Auto-continue across the iteration ceiling (ported from teammate-loop's
      // MAX_TEAMMATE_CONTINUATIONS). A long task that exhausts maxIterations
      // should keep going a bounded number of times and end with a real model
      // summary, instead of stalling on a blank/boilerplate "ran out of steps"
      // turn. Synthetic continuation prompts accumulate into history so message
      // alternation stays valid; usage is folded forward for accurate billing.
      const maxAutoContinuations = parseInt(process.env.AGENT_MAX_AUTO_CONTINUATIONS || '3', 10)
      let autoContinuations = 0
      const accumulatedNewMessages = [...result.newMessages]
      while (
        result.maxIterationsExhausted &&
        !result.loopBreak &&
        !result.error &&
        !result.usageLimit &&
        !turnAbort.signal.aborted &&
        autoContinuations < maxAutoContinuations
      ) {
        autoContinuations++
        console.warn(
          `${this.logPrefix} Auto-continuing after iteration ceiling (pass ${autoContinuations}/${maxAutoContinuations}) for session ${sessionId}`,
        )
        const contHistory = [...history, ...accumulatedNewMessages]
        const contPrompt =
          'Continue — you ran out of steps before finishing. Pick up exactly where you left off and complete the remaining work. ' +
          'When everything is done, end with a short summary of what you changed; if you are still not finished, say what remains.'
        const contResult = await runAgentLoop({
          ...loopOptions,
          history: contHistory,
          prompt: contPrompt,
          images: undefined,
        })
        accumulatedNewMessages.push(...contResult.newMessages)
        // Fold prior usage/iterations/tool calls forward so the whole turn is billed.
        contResult.inputTokens += result.inputTokens
        contResult.outputTokens += result.outputTokens
        contResult.cacheReadTokens += result.cacheReadTokens
        contResult.cacheWriteTokens += result.cacheWriteTokens
        contResult.iterations += result.iterations
        contResult.toolCalls = [...result.toolCalls, ...contResult.toolCalls]
        result = contResult
      }
      if (result.usageLimit && uiWriter) {
        uiWriter.write({
          type: 'data-usage-limit',
          data: {
            resetsAt: result.usageLimit.resetsAt,
            window: result.usageLimit.window,
            toolCallCount: result.toolCalls.length,
          },
        } as any)
      }
      result.newMessages = accumulatedNewMessages.filter((message) => {
        const tagged = (message as Message & { __shogoBackgroundNote?: boolean }).__shogoBackgroundNote
        return !tagged && !persistedProgressMessages.has(message)
      })

      // Defense-in-depth: rewrite any localhost link the model emitted into the
      // public preview URL in the persisted history + returned text too (the
      // live UI stream is handled by linkRewriter above). No-op locally. Skips
      // code spans/fences and `curl` lines — see preview-link-rewrite.ts.
      // Mistyped share_file tokens are repaired the same way.
      if (previewPublicUrl || shareLinkTokens.size > 0) {
        const rewriteText = (text: string) =>
          repairShareLinks(rewriteLocalhostLinks(text, previewPublicUrl), shareLinkTokens)
        for (const msg of result.newMessages) {
          if (msg.role !== 'assistant' || !Array.isArray(msg.content)) continue
          for (const block of msg.content as any[]) {
            if (block?.type === 'text' && typeof block.text === 'string') {
              block.text = rewriteText(block.text)
            }
          }
        }
        if (typeof result.text === 'string') {
          result.text = rewriteText(result.text)
        }
      }

      // Persist messages to session FIRST — before any uiWriter calls that
      // could throw due to client disconnect.  This ensures "continue" after
      // stop always has the interrupted turn's context.
      this.sessionManager.addMessages(sessionId, ...result.newMessages)

      // Turn-boundary telemetry (SHO-122): what this turn started with, what the
      // previous turn actually contained at that moment, and the cache numbers
      // of its first model call. Emitted before any post-turn compaction, so
      // `compactedHere` describes the boundary itself.
      recordTurnBoundary({
        sessionId,
        model: modelId,
        boundaryIndex: turnNum,
        messagesAtStart: historyPrint.count,
        previousTurn,
        compactedHere: turnCompaction !== null,
        compactedBefore: turnCompaction?.before ?? null,
        compactedAfter: turnCompaction?.after ?? null,
        prefixStable,
        inputTokens: turnFirstCallUsage?.input ?? null,
        cacheReadTokens: turnFirstCallUsage?.cacheRead ?? null,
        cacheWriteTokens: turnFirstCallUsage?.cacheWrite ?? null,
      })

      if (this.sessionManager.needsCompaction(session)) {
        const fileStateSummary = this.fileStateCache.size > 0
          ? this.fileStateCache.getSummary(this.workspaceDir)
          : undefined
        const tokensBeforePostTurn = this.sessionManager.estimateTokens(session)
        const compactResult = await this.sessionManager.compact(sessionId, fileStateSummary)
        if (compactResult) {
          recordCompaction({
            sessionId,
            trigger: 'post-turn',
            messagesBefore: compactResult.messagesBefore,
            messagesAfter: compactResult.messagesAfter,
            summaryChars: compactResult.summary.length,
            filesTouched: compactResult.filesTouched ?? [],
            toolsUsed: compactResult.toolsUsed ?? [],
            foldedRounds: compactResult.foldedRounds ?? 0,
          })
          console.log(
            `${this.logPrefix} Post-turn compaction: ${compactResult.messagesBefore} -> ${compactResult.messagesAfter} messages`
          )
          // Prefix rewritten — drop stable-compaction state. Next turn's
          // transformContext takes fresh decisions against the new history.
          this.contentReplacementStates.delete(sessionId)
          runningContextEstimate = this.sessionManager.estimateTokens(session)
          // Same transcript row as a mid-turn summarization: every compaction
          // shows up in history exactly once, whichever layer ran it (SHO-96).
          if (uiWriter) {
            try {
              uiWriter.write({
                type: 'data-context-summarized',
                data: {
                  trigger: 'auto',
                  tokensBefore: tokensBeforePostTurn,
                  tokensAfter: runningContextEstimate,
                  messagesBefore: compactResult.messagesBefore,
                  messagesAfter: compactResult.messagesAfter,
                  summaryChars: compactResult.summary.length,
                  contextWindowTokens,
                },
              } as any)
            } catch { /* client gone — the row still persists via the API */ }
          }
        }
      }

      this.sessionManager.touch(sessionId)

      // Emit final context usage so the client always gets the most up-to-date value
      // even if the throttle timer hasn't fired recently.
      if (uiWriter) {
        uiWriter.write({
          type: 'data-context-usage',
          data: { inputTokens: runningContextEstimate, contextWindowTokens },
          transient: true,
        } as any)
      }

      // Store usage for callers (server.ts includes it in the `finish` event)
      const estimatedContextTokens = this.sessionManager.estimateTokens(session)
      const effectiveModel = result.effectiveModelId || modelId
      const responseEmpty = !result.text || result.text.trim().length === 0
      this._lastTurnUsage = {
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        cacheReadTokens: result.cacheReadTokens,
        cacheWriteTokens: result.cacheWriteTokens,
        iterations: result.iterations,
        toolCallCount: result.toolCalls.length,
        contextWindowTokens: this.sessionManager.contextWindowTokens,
        estimatedContextTokens,
        model: effectiveModel,
        success: !result.error && !result.maxIterationsExhausted && !result.loopBreak && !responseEmpty,
        hitMaxTurns: !!result.maxIterationsExhausted,
        loopDetected: !!result.loopBreak,
        ...(result.loopBreak?.pattern ? { loopPattern: result.loopBreak.pattern } : {}),
        escalated: false,
        responseEmpty,
        perCallUsage: result.perCallUsage ?? [],
        prefix,
        wasAborted: result.abortReason === 'external',
      }

      // One line per model call: the prefix fingerprint sent, and the cache
      // read/write the provider reported for it. A call that writes while its
      // hash is unchanged from the previous call is a genuine cache opportunity
      // missed; a write whose hash did change is a real prefix change.
      if (process.env.SHOGO_PREFIX_LOG !== '0' && callFingerprints.length > 0) {
        const perCall = result.perCallUsage ?? []
        const lines = callFingerprints.map((c, i) => {
          const usage = perCall[i]
          const mark = c.compacted ? ` compacted=${c.compacted}` : ''
          return (
            `  #${i + 1} ${c.hash} (${c.msgs} msgs, ${c.chars}c)${mark}` +
            (usage ? ` read=${usage.cacheRead} write=${usage.cacheWrite} in=${usage.input} out=${usage.output}` : '')
          )
        })
        console.log(`${this.logPrefix} [cache-attrib] turn=${prefix.turn} calls=${callFingerprints.length}\n${lines.join('\n')}`)
      }

      // UI notifications below may throw if the client disconnected (stop).
      // Wrap in try/catch so session persistence above is never affected.
      try {
        // Drain any assistant text the link rewriter is still holding before
        // the streams close.
        flushAssistantText()
        chunker?.flush()
        chunker?.dispose()

        if (uiWriter && uiTextId) {
          uiWriter.write({ type: 'text-end', id: uiTextId })
          uiTextId = null
        }

        if (result.loopBreak) {
          console.warn(
            `${this.logPrefix} Loop detected in session ${sessionId}: ${result.loopBreak.pattern}`
          )
          // The loop abort ends the turn without an error, so without this
          // notice the turn looks finished even though the work was cut off.
          if (uiWriter) {
            const noticeId = `text-${Date.now()}-loop-break`
            uiWriter.write({ type: 'text-start', id: noticeId })
            uiWriter.write({
              type: 'text-delta',
              id: noticeId,
              delta: `\n\nI stopped this turn early because I seemed to be stuck (${result.loopBreak.pattern}). The task may be incomplete — reply to continue.`,
            })
            uiWriter.write({ type: 'text-end', id: noticeId })
          }
        }

        const totalInput = result.inputTokens + result.cacheReadTokens + result.cacheWriteTokens
        if (result.toolCalls.length > 0) {
          console.log(
            `${this.logPrefix} Agent turn: ${result.iterations} iterations, ${result.toolCalls.length} tool calls, ${totalInput}+${result.outputTokens} tokens (${result.cacheReadTokens} cached)`
          )
        }

        if (result.error) {
          const msg = result.error.message || 'An unexpected error occurred'
          console.error(
            `${this.logPrefix} Agent error for session ${sessionId}: ${msg} (${result.toolCalls.length} tool calls, ${result.outputTokens} output tokens)`
          )
          chunker?.dispose()
          if (uiWriter) {
            // Classify by cause and surface a clean, actionable message. Never
            // echo the raw wrapper/upstream text (e.g. "Provider error:
            // Connection error." or a WAF block page) — it stays in the server
            // logs above. See describeTurnFailure.
            uiWriter.write({ type: 'error', errorText: describeTurnFailure(msg) } as any)
          }
        } else if (result.outputTokens === 0 && result.toolCalls.length === 0 && !result.usageLimit && !isHeartbeat && !isUserStoppedTurn(result)) {
          console.error(
            `${this.logPrefix} Agent returned 0 tokens for session ${sessionId} — possible context corruption (${session.compactionCount} compactions, ${session.messages.length} messages, model: ${modelId}, provider: ${provider})`
          )
          if (uiWriter) {
            uiWriter.write({
              type: 'error',
              errorText: 'I encountered an issue processing your message. Please try starting a new conversation.',
            } as any)
          }
        }
      } catch (uiErr: any) {
        console.warn(`${this.logPrefix} Post-loop UI write failed (session messages already persisted): ${uiErr.message}`)
        chunker?.dispose()
      }

      if (result.text) return result.text
      if (isHeartbeat) return 'HEARTBEAT_OK'
      // The user pressed Stop before any text was produced. That is not a
      // model failure, so don't tell them the model failed to respond.
      if (isUserStoppedTurn(result)) return ''
      console.warn(`${this.logPrefix} Empty model response for session ${sessionId} (${result.iterations} iterations, ${result.toolCalls.length} tool calls, ${result.outputTokens} output tokens)`)
      const emptyFallback = 'Sorry, I was unable to generate a response. Please try again.'
      // Stream the fallback so clients (and eval bridges) never receive a
      // completely silent turn when nothing was emitted and no error fired.
      try {
        if (uiWriter && !uiTextId && !result.error) {
          const fbId = `text-${Date.now()}-fallback`
          uiWriter.write({ type: 'text-start', id: fbId })
          uiWriter.write({ type: 'text-delta', id: fbId, delta: emptyFallback })
          uiWriter.write({ type: 'text-end', id: fbId })
        }
      } catch { /* writer may be dead — ignore */ }
      return emptyFallback
    } catch (error: any) {
      console.error(`${this.logPrefix} Agent turn failed:`, error.message, error.stack?.split('\n').slice(0, 3).join('\n'))
      chunker?.dispose()
      try {
        if (uiWriter) {
          // Classify by cause; never surface raw provider bodies (e.g. WAF
          // block pages) — they stay in the server logs above. An uncaught
          // throw may indicate a corrupt turn, so unrecognized causes hedge
          // toward starting a new conversation.
          uiWriter.write({
            type: 'error',
            errorText: describeTurnFailure(
              error.message,
              'I encountered an issue processing your message. Please try starting a new conversation.',
            ),
          } as any)
        }
      } catch { /* writer may be dead — ignore */ }
      if (isHeartbeat) return 'HEARTBEAT_OK'
      return `Sorry, I encountered an error processing your message. Please try again.`
    } finally {
      this.turnAbortControllers.delete(sessionId)
      if (this.retryWakers.get(sessionId) === retryWaker) this.retryWakers.delete(sessionId)
      if (typingInterval) clearInterval(typingInterval)
      for (const timer of toolHeartbeatTimers.values()) {
        clearInterval(timer)
      }
      toolHeartbeatTimers.clear()
      unsubscribeProcesses?.()
      if (remoteRefreshTimer) clearInterval(remoteRefreshTimer)
      if (sessionId && this.commandRegistries.has(sessionId)) {
        // Notes that arrived after the loop's last iteration wake the session instead.
        if (this.commandRegistries.get(sessionId)!.hasPendingNotifications()) this.scheduleTaskWake(sessionId)
        this.ensureRemoteTaskPoller(sessionId)
      }
    }
  }

  private buildShellNavLines(): string[] {
    const lines = [
      '',
      '### Shell Navigation',
      'Shell state is persistent — `cd` in one exec call carries over to the next.',
    ]
    if (this.permissionEngine && !this.permissionEngine.isActionsOnly) {
      switch (this.permissionEngine.mode) {
        case 'strict':
          lines.push('You may only run commands within the workspace directory. Do not navigate outside it.')
          break
        case 'balanced':
          lines.push('You may navigate within the workspace directory tree. Navigation outside the workspace requires user approval.')
          break
        case 'full_autonomy':
          lines.push('You may navigate to any directory on the system.')
          break
      }
    }
    return lines
  }

  /**
   * Where a session's shell starts: the anchor project's mount in a
   * merged-root runtime. A per-chat worktree keeps its own root.
   */
  private initialShellCwd(sessionWorkspaceDir: string): string {
    return sessionWorkspaceDir === this.workspaceDir ? defaultShellCwd(this.workspaceDir) : sessionWorkspaceDir
  }

  /**
   * File tools resolve relative paths from the workspace root while exec runs
   * in the session's shell cwd; say so whenever the two differ.
   */
  private workingDirectoryLines(currentCwd: string): string[] {
    if (currentCwd === this.workspaceDir) {
      return [`- Working directory: \`${currentCwd}\``, '', 'All file paths are relative to the working directory.']
    }
    return [
      `- Shell working directory: \`${currentCwd}\``,
      `- Workspace root: \`${this.workspaceDir}\``,
      '',
      'File tool paths (read_file, write_file, edit_file, ...) are relative to the workspace root; shell commands run in the shell working directory.',
    ]
  }

  private buildSWEPrompt(
    sessionId?: string,
    cfg: GatewayConfig = this.config,
    // Production always passes the turn's surface; the default is `project` so
    // a direct call cannot silently pick up a boot-env workspace mode.
    chatContext: ChatContext = 'project',
  ): string {
    const parts: string[] = []
    const currentCwd = (sessionId && this.shellCwd.get(sessionId)) || this.initialShellCwd(this.workspaceDir)

    const now = new Date()
    parts.push([
      '## Current Context',
      `- Today: ${now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}`,
      `- Year: ${now.getFullYear()}`,
      `- Timezone: ${this.userTimezone || Intl.DateTimeFormat().resolvedOptions().timeZone}`,
      ...this.workingDirectoryLines(currentCwd),
      'Do NOT assume paths like `/workspace`, `/home/user`, or `/repo` — use the directories above.',
      ...this.buildShellNavLines(),
    ].join('\n'))

    if (process.env.TERMINAL_EXEC_URL) {
      parts.push([
        '## Desktop Terminal Context',
        'When the user asks about terminal state, recent commands, command output, or "what did I just do?", call `terminal_read` before answering.',
        'Use `terminal_exec` only when you need to run a new command in the user-visible desktop terminal.',
      ].join('\n'))
    }

    const workspaceTree = this.buildWorkspaceTreeContext()
    if (workspaceTree) {
      parts.push(workspaceTree)
    }

    parts.push(buildCodeAgentGeneralGuide())
    if (cfg.capabilityProfile === 'personal') parts.push(PERSONAL_COMPANION_GUIDE)
    parts.push(buildCapabilityStatusSection(cfg, {
      scope: chatContext === 'workspace' ? 'workspace' : 'project',
      projectName: chatContext === 'workspace' ? undefined : this.projectDisplayName(this.projectId),
      anchorProjectName: chatContext === 'workspace' ? this.projectDisplayName(process.env.WORKSPACE_ANCHOR_PROJECT_ID) : undefined,
    }))
    parts.push(OUTPUT_CONTRACT_GUIDE)
    if (cfg.browserEnabled !== false) {
      parts.push(BROWSER_TOOL_GUIDE)
    }
    parts.push(BACKGROUND_TASKS_GUIDE)
    if (!subagentOrchestrationDisabled(this.config)) parts.push(SUBAGENT_GUIDE)
    if (cfg.gitWorktreesEnabled) parts.push(WORKTREE_GUIDE)

    if (sessionId) {
      const teamCtx = this.buildTeamContext(sessionId)
      if (teamCtx) parts.push(teamCtx)
    }

    const workspacePaused = this.buildWorkspacePausedContext(sessionId)
    if (workspacePaused) parts.push(workspacePaused)

    const concurrentChats = this.buildConcurrentChatsContext(sessionId)
    if (concurrentChats) parts.push(concurrentChats)

    return parts.join('\n\n---\n\n')
  }

  /**
   * General prompt profile for non-SWE benchmarks (GAIA, WebArena, Terminal-Bench).
   * Includes workspace context, coding guide, and skills — but skips personality,
   * canvas, templates, memory, and other Shogo-specific sections.
   */
  private buildGeneralPrompt(
    sessionId?: string,
    cfg: GatewayConfig = this.config,
    chatContext: ChatContext = 'project',
  ): string {
    const parts: string[] = []
    const currentCwd = (sessionId && this.shellCwd.get(sessionId)) || this.initialShellCwd(this.workspaceDir)

    const now = new Date()
    parts.push([
      '## Current Context',
      `- Today: ${now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}`,
      `- Year: ${now.getFullYear()}`,
      `- Timezone: ${this.userTimezone || Intl.DateTimeFormat().resolvedOptions().timeZone}`,
      ...this.workingDirectoryLines(currentCwd),
      'Do NOT assume paths like `/workspace`, `/home/user`, or `/repo` — use the directories above.',
      ...this.buildShellNavLines(),
    ].join('\n'))

    const workspaceTree = this.buildWorkspaceTreeContext()
    if (workspaceTree) {
      parts.push(workspaceTree)
    }

    parts.push(buildCodeAgentGeneralGuide())
    if (cfg.capabilityProfile === 'personal') parts.push(PERSONAL_COMPANION_GUIDE)
    parts.push(buildCapabilityStatusSection(cfg, {
      scope: chatContext === 'workspace' ? 'workspace' : 'project',
      projectName: chatContext === 'workspace' ? undefined : this.projectDisplayName(this.projectId),
      anchorProjectName: chatContext === 'workspace' ? this.projectDisplayName(process.env.WORKSPACE_ANCHOR_PROJECT_ID) : undefined,
    }))
    if (cfg.browserEnabled !== false) {
      parts.push(BROWSER_TOOL_GUIDE)
    }
    parts.push(SELF_EVOLUTION_GUIDE)

    if (this.skills.length > 0) {
      const skillsSection = buildSkillsPromptSection(this.skills, undefined, (info) => this.reportSkillsTruncation(info))
      if (skillsSection) {
        parts.push(skillsSection)
      }
    }

    if (cfg.quickActionsEnabled !== false) {
      parts.push(QUICK_ACTION_GUIDE)
      if (this.quickActions.length > 0) {
        const qaSection = buildQuickActionsPromptSection(this.quickActions)
        if (qaSection) parts.push(qaSection)
      }
    }

    parts.push(BACKGROUND_TASKS_GUIDE)
    if (!subagentOrchestrationDisabled(this.config)) parts.push(SUBAGENT_GUIDE)
    if (cfg.gitWorktreesEnabled) parts.push(WORKTREE_GUIDE)

    if (sessionId) {
      const teamCtx = this.buildTeamContext(sessionId)
      if (teamCtx) parts.push(teamCtx)
    }

    const workspacePaused = this.buildWorkspacePausedContext(sessionId)
    if (workspacePaused) parts.push(workspacePaused)

    const concurrentChats = this.buildConcurrentChatsContext(sessionId)
    if (concurrentChats) parts.push(concurrentChats)

    return parts.join('\n\n---\n\n')
  }

  /**
   * The product name of the model this turn actually sends, for the Account
   * line. Never a name from another turn: the session's stamped name is only
   * used when this session's own override drove the turn, and everything else
   * is looked up from the id that is about to be sent.
   *
   * Returns undefined when no name can be established — better to say nothing
   * than to name the wrong model (SHO-145).
   */
  private turnModelDisplayName(
    modelId: string,
    session: { modelOverride?: string; modelDisplayName?: string },
    autoRouting: boolean,
  ): string | undefined {
    // An Auto turn names the tier model it routed to, not "Auto".
    if (!autoRouting && session.modelOverride && session.modelDisplayName) {
      return sanitizeModelDisplayName(session.modelDisplayName)
    }
    const listed = getAvailableModels().find((m) => m.id === modelId)?.displayName
    if (listed) return sanitizeModelDisplayName(listed)
    // `getModelDisplayName` falls back to the raw id, which is not a product
    // name — only use it when the catalog actually knows the model.
    const known = getModelEntry(modelId)?.displayName
    return known ? sanitizeModelDisplayName(known) : undefined
  }

  /**
   * Build the system prompt for one turn. `cfg` is the turn's surface config
   * (`configForTurn`), so capability guidance and gates match the surface the
   * turn runs in; it defaults to the runtime's project config for callers with
   * no turn context.
   */
  private loadBootstrapContext(
    sessionId?: string,
    cfg: GatewayConfig = this.config,
    chatContext: ChatContext = this.resolveChatContext(sessionId),
    modelDisplayName?: string,
  ): string {
    if (cfg.promptProfile === 'swe') {
      return this.buildSWEPrompt(sessionId, cfg, chatContext)
    }
    if (cfg.promptProfile === 'general') {
      return this.buildGeneralPrompt(sessionId, cfg, chatContext)
    }

    // =========================================================================
    // Prompt cache optimization: sections are ordered by stability so that
    // Anthropic's prompt cache can reuse the prefix across turns. Most-stable
    // content (tool guides, coding guide, canvas guides) comes first; per-turn
    // dynamic content (date, workspace tree, installed tools) comes last.
    // The PROMPT_CACHE_STABLE_BOUNDARY marker below separates the two zones —
    // everything before it is expected to stay identical across turns.
    // =========================================================================

    const stableParts: string[] = []
    const dynamicParts: string[] = []
    const sections: Array<{ label: string; zone: 'stable' | 'dynamic'; chars: number; estTokens: number }> = []

    const pushStable = (label: string, content: string) => {
      stableParts.push(content)
      sections.push({ label, zone: 'stable', chars: content.length, estTokens: Math.ceil(content.length / 4) })
    }
    const pushDynamic = (label: string, content: string) => {
      dynamicParts.push(content)
      sections.push({ label, zone: 'dynamic', chars: content.length, estTokens: Math.ceil(content.length / 4) })
    }

    // ---- STABLE ZONE: rarely changes within a session ----

    // 0. External (VS Code-style) project context. When the user has
    // opened folders from their machine (workingMode='external'), tell
    // the agent which roots are in scope and whether the workspace is
    // trusted. Reads from the live trust-resolver (refreshed once per
    // turn in `_agentTurnInner` just before this runs) — NOT from the
    // legacy TRUST_LEVEL env var, which was a spawn-time snapshot that
    // never reflected user trust toggles. The folder set is genuinely
    // immutable for a runtime instance, so we still take it from the
    // same resolver snapshot.
    const runtimeTrust = getRuntimeTrust()
    if (runtimeTrust.workingMode === 'external') {
      const linkedFolders = runtimeTrust.linkedFolders
      const trustLevel = runtimeTrust.trustLevel
      const lines = [
        '## Project Mode: External (VS Code-style)',
        '',
        `This project is linked to one or more folders on the user's machine.`,
        `Trust level: \`${trustLevel}\`.`,
        '',
        '### Allowed roots',
        ...linkedFolders.map((p, i) => `  ${i + 1}. \`${p}\``),
        ...(linkedFolders.length === 0
          ? [`  1. \`${this.workspaceDir}\``]
          : []),
        '',
        '### Rules',
        '- File / shell tools may operate on absolute paths anywhere inside the allowed roots above.',
        '- Paths outside those roots will be rejected by the runtime — do not invent extra paths.',
        ...(trustLevel === 'restricted'
          ? [
              '- The workspace is **restricted**. Read tools work; **write_file**, **edit_file**, and **exec / shell** are disabled until the user clicks "Trust folder" in the UI.',
              '- If the user asks you to make changes, explain that trust is required and offer to summarise the plan.',
            ]
          : [
              '- The workspace is **trusted** — edits and shell commands are allowed.',
              '- Shogo does NOT manage git here. Do not run `git commit` or create checkpoints — the user owns their git workflow.',
            ]),
        '',
      ]
      pushStable('external-mode-context', lines.join('\n'))
    }

    // 1. Mode-specific canvas/tool guides (changes only on mode switch)
    const activeMode = cfg.activeMode || 'canvas'
    if (cfg.canvasEnabled !== false) {
      for (const [id, text] of canvasModeStableGuides(activeMode)) {
        pushStable(id, text)
      }
    }

    // 2. General coding guide (always the same)
    pushStable('code-agent-guide', buildCodeAgentGeneralGuide())
    pushStable('background-tasks-guide', BACKGROUND_TASKS_GUIDE)
    if (cfg.capabilityProfile === 'personal') {
      pushStable('personal-companion-mode', PERSONAL_COMPANION_GUIDE)
    }

    // 2b. Shogo SDK guide — when/how to reach for @shogo-ai/sdk in user apps.
    // Toggleable so projects that don't ship a Shogo app (pure-chat agents,
    // SWE benches, etc.) can drop ~2k tokens from the cached prefix.
    if (cfg.sdkGuideEnabled !== false) {
      pushStable('shogo-sdk-guide', getShogoSdkGuide())
    }

    // 3. Capabilities Index — compact pointers to on-demand guides served by read_guide tool.
    // Full guide content lives in guide-registry.ts and is returned by the read_guide tool,
    // saving ~4,600 tokens per turn compared to inlining all guides.
    // Shogo-platform surfaces — gated so code-only agents can drop messaging,
    // integration, and heartbeat guidance from the cached prefix.
    const integrationsGuideOn = cfg.integrationsEnabled !== false
    const channelsGuideOn = cfg.channelsEnabled !== false
    const imageGuideOn = cfg.imageGenEnabled !== false
    const videoGuideOn = cfg.videoGenEnabled === true
    const threeDGuideOn = cfg.threeDGenEnabled === true
    const devopsGuideOn = cfg.heartbeatToolsEnabled !== false

    this.currentGuideRegistry = buildGuideRegistry(this.promptOverrides)
    pushStable('capability-status', buildCapabilityStatusSection(cfg, {
      scope: chatContext === 'workspace' ? 'workspace' : 'project',
      // Only the surface's own name: the anchor project's toggles are a
      // separate, labelled pointer inside a workspace block, never the title.
      projectName: chatContext === 'workspace' ? undefined : this.projectDisplayName(this.projectId),
      anchorProjectName: chatContext === 'workspace' ? this.projectDisplayName(process.env.WORKSPACE_ANCHOR_PROJECT_ID) : undefined,
    }))
    pushStable('capabilities-index', buildCapabilitiesIndex({
      integrations: integrationsGuideOn,
      channels: channelsGuideOn,
      media: imageGuideOn,
      video: videoGuideOn,
      threeD: threeDGuideOn,
      // Personal workspaces and the workspace agent have no subagent
      // orchestration at all; the media tools are direct on every profile.
      subagents: !subagentOrchestrationDisabled(this.config),
      devops: devopsGuideOn,
    }))

    // Action Tools guide — only worth including when at least one of its
    // action surfaces (channels, managed integrations, heartbeat) is enabled.
    if (channelsGuideOn || integrationsGuideOn || devopsGuideOn) {
      const actionVerbs = [
        integrationsGuideOn ? 'connect an integration' : null,
        channelsGuideOn ? 'configure a channel' : null,
        devopsGuideOn ? 'set up a scheduled reminder' : null,
      ].filter((v): v is string => v !== null)
      const actionVerbPhrase =
        actionVerbs.length === 1
          ? actionVerbs[0]
          : `${actionVerbs.slice(0, -1).join(', ')}, or ${actionVerbs[actionVerbs.length - 1]}`

      const actionLines: string[] = [
        '## Action Tools',
        '',
        `When the user asks you to ${actionVerbPhrase}, use the relevant tool immediately instead of only describing what you would do.`,
      ]
      if (channelsGuideOn) {
        actionLines.push('- Credentials or hostnames in the user message are permission to call `channel_connect` for email, Slack, Discord, Telegram, etc.')
      }
      if (integrationsGuideOn) {
        actionLines.push('- For managed integrations (Google, Slack, GitHub, etc.) and MCP servers alike, call `search_integrations` then `connect`. The result\'s `source` tag (`managed` | `mcp` | `skill`) tells you which path was taken.')
      }
      if (devopsGuideOn) {
        if (workspaceAgentToolsRegistered({ workspaceId: process.env.WORKSPACE_ID })) {
          actionLines.push(
            '- For work tied to the clock (a reminder at 9am, a Monday digest, a daily inbox sweep), create a named goal schedule with `schedule_create`; use `heartbeat_configure` only for the general heartbeat sweep.',
            '- To follow work that is already running (a card you handed to an agent, a background command or agent, a project call), do not schedule check-ins: watch its task and act on the `[Task update]` the moment it finishes, as in Background Tasks. When the user asks you to "loop", "keep an eye on it" or "check back at each phase", that is what they mean; tell them you will react as soon as each piece finishes. If a schedule you made earlier follows such work (an hourly loop over handed-off cards), turn it off and say so; do not keep it as a backstop.',
          )
        } else {
          actionLines.push('- For recurring reminders, digests, check-ins, or autonomous routines, use `heartbeat_configure`.')
        }
      }
      actionLines.push(
        '- If you need a missing detail such as timezone or channel name, call `ask_user` instead of asking only in prose.',
        '- A successful final response should summarize what you configured, not ask whether to start.',
      )
      pushStable('action-tools-guide', actionLines.join('\n'))
    }

    if (process.env.TERMINAL_EXEC_URL) {
      pushStable('desktop-terminal-context', [
        '## Desktop Terminal Context',
        '',
        'The desktop IDE terminal is available through `terminal_read` and `terminal_exec`.',
        '- When the user asks about terminal state, recent commands, command output, or "what did I just do?", call `terminal_read` before answering.',
        '- Use `terminal_exec` only when you need to run a new command in the user-visible desktop terminal.',
      ].join('\n'))
    }

    if (cfg.quickActionsEnabled !== false) {
      pushStable('quick-action-guide', QUICK_ACTION_GUIDE)
    }

    const workCaps = resolveCapabilitiesForScope(cfg as unknown as Record<string, unknown>, chatContext === 'workspace' ? 'workspace' : 'project')
    if (teamChatToolsAvailable(cfg.capabilityProfile)) {
      if (workCaps.teamChatEnabled) pushStable('team-chat-guide', TEAM_CHAT_GUIDE)
      if (workCaps.boardsEnabled) pushStable('boards-guide', BOARDS_GUIDE)
      if (workCaps.companyOpsEnabled && workCaps.boardsEnabled && workCaps.heartbeatToolsEnabled) {
        pushStable('company-ops-guide', COMPANY_OPS_GUIDE)
      }
    }

    if (triggerToolsAvailable()) {
      pushStable('triggers-guide', TRIGGERS_GUIDE)
    }

    // 4. Security permissions guide (stable once mode is set)
    if (this.permissionEngine && !this.permissionEngine.isActionsOnly) {
      pushStable('security-permissions', [
        '## Security Permissions',
        '',
        'This agent runs with a security permission system. Some tool calls may be blocked or require user approval through a UI dialog (not through chat).',
        '- If a tool result says "Permission denied", the action is permanently blocked. Tell the user it is not available. Do NOT ask them to approve it.',
        '- If a tool result says the user "declined" an action, they already decided via the security dialog. Acknowledge it briefly and move on. Do NOT ask again or request confirmation in chat.',
        '- Never try to work around permission denials by re-running the same tool or asking the user to confirm in text.',
      ].join('\n'))
    }

    // The `<|CACHE_BOUNDARY|>` separator (imported from prefix-fingerprint so
    // the builder, the fingerprint and `sampleCachePrefix` share one
    // definition) tells the AI proxy to split the system prompt into two
    // blocks: the stable prefix is the cached zone, the dynamic suffix is not.

    // ---- DYNAMIC ZONE: changes between turns or sessions ----

    // 6. Project identity files (change when user edits them)
    // SOUL.md, USER.md, IDENTITY.md were consolidated into AGENTS.md but are
    // still read here for backwards compatibility with existing workspaces.
    const files = ['AGENTS.md', 'SOUL.md', 'USER.md', 'IDENTITY.md', 'TOOLS.md']
    for (const filename of files) {
      const filepath = resolveWorkspaceConfigFilePath(this.workspaceDir, filename)
      if (filepath) {
        const content = readFileSync(filepath, 'utf-8').trim()
        if (content) {
          pushDynamic(filename.toLowerCase().replace('.md', ''), content)
        }
      }
    }

    // 6a. Attached-projects manifest (multi-project workspace runtimes only).
    // WORKSPACE.md is written at the merged-root only when this runtime serves
    // several attached projects (see workspace-runtime-mode.ts). Surfacing it
    // here is what makes the agent aware of its sibling projects — without it
    // the agent sees only bare UUID folders in the file tree and tends to
    // refuse them as "other users' projects". Gated on file presence so
    // single-project runtimes (which never write WORKSPACE.md) are unaffected.
    const workspaceManifestPath = resolveWorkspaceConfigFilePath(this.workspaceDir, 'WORKSPACE.md')
    if (workspaceManifestPath) {
      const manifest = readFileSync(workspaceManifestPath, 'utf-8').trim()
      if (manifest) {
        pushDynamic('attached-projects', [
          manifest,
          '',
          "**Every project listed above belongs to the current user and is part of this workspace — you have been granted access to all of them.** Treat each top-level folder as a sibling repository under one root: you may read and edit files in any of them unless it is explicitly marked read-only. Do NOT describe them as other users' projects, do NOT refuse to access them on privacy or isolation grounds, and do NOT claim you can only see a single project. When the user asks which projects or folders you can see, list the projects above.",
        ].join('\n'))
      }
    }

    // 6b. STACK.md — preview-truncated to save tokens. The full file is
    // available to the agent via read_file when it needs the complete reference.
    const STACK_PREVIEW_WORDS = 200
    const stackPath = resolveWorkspaceConfigFilePath(this.workspaceDir, 'STACK.md')
    if (stackPath) {
      const fullStack = readFileSync(stackPath, 'utf-8').trim()
      if (fullStack) {
        const words = fullStack.split(/\s+/)
        if (words.length <= STACK_PREVIEW_WORDS) {
          pushDynamic('stack', fullStack)
        } else {
          const preview = words.slice(0, STACK_PREVIEW_WORDS).join(' ')
          const relativePath = stackPath.startsWith(this.workspaceDir)
            ? stackPath.slice(this.workspaceDir.length + 1)
            : stackPath
          pushDynamic('stack', [
            preview,
            '',
            `(Truncated — ${words.length} words total. Full reference: \`read_file({ path: "${relativePath}" })\`)`,
          ].join('\n'))
        }
      }
    }

    // 7. Memory — budgeted, and deliberately in the STABLE zone (SHO-78).
    // Unlike STACK.md above (a 200-word preview), MEMORY.md is capped by
    // MEMORY_BUDGET_TOKENS — default 1,500 tokens, clamped to 400..8000 — and
    // the block lands before CACHE_BOUNDARY so it joins the cached prefix
    // instead of being re-billed on every request. Nothing is lost: the file on
    // disk is untouched and the overflow notice points at memory_search for
    // what is not loaded. See memory-section.ts.
    const memoryPath = resolveWorkspaceConfigFilePath(this.workspaceDir, 'MEMORY.md')
    if (memoryPath) {
      const memorySection = this.buildMemoryPromptSection(memoryPath)
      if (memorySection) {
        pushStable('memory', memorySection)
      }
    }

    // 7b. Recent heartbeat activity (lets agent answer questions about autonomous work)
    const heartbeatLogPath = join(this.workspaceDir, 'HEARTBEAT_LOG.md')
    if (existsSync(heartbeatLogPath)) {
      const heartbeatLog = readFileSync(heartbeatLogPath, 'utf-8').trim()
      if (heartbeatLog) {
        pushDynamic('heartbeat-log', `## Recent Autonomous Activity\nThese are your recent heartbeat check results. Reference them when users ask about your autonomous activity.\n\n${heartbeatLog}`)
      }
    }

    // APP_MODE_DISABLED: app template context injection removed (was reading .app-template)

    // 7c. Preview URL — inject whenever the runtime can serve the app, so the
    // agent always has the real public URL (not just in canvas mode). See
    // shouldInjectPreviewUrl(); this closes the "shared a localhost URL" gap.
    if (shouldInjectPreviewUrl(activeMode)) {
      const previewUrl = this.buildPreviewUrlContext()
      if (previewUrl) {
        pushDynamic('preview-url', previewUrl)
      }
    }

    if (process.env.SHOGO_EXPOSED_PORTS) {
      const exposed = buildExposedPortsPrompt(process.env)
      if (exposed) pushDynamic('exposed-ports', exposed)
    }

    // Runtime build + console log tails (canvas mode only — Vite preview pipeline)
    if (activeMode === 'canvas') {
      const runtimeLogs = this.buildRuntimeLogsContext()
      if (runtimeLogs) {
        pushDynamic('runtime-logs', runtimeLogs)
      }
    }

    // 8. Agent template context (stable per-project, but read from disk)
    const agentTemplatePath = join(this.workspaceDir, '.template')
    if (existsSync(agentTemplatePath)) {
      const agentTemplate = readFileSync(agentTemplatePath, 'utf-8').trim()
      if (agentTemplate) {
        const humanName = agentTemplate.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
        pushDynamic('agent-template', [
          '## Agent Template Context',
          '',
          `This agent was created from the **${humanName}** template (\`${agentTemplate}\`).`,
          'Your configuration files (AGENTS.md, HEARTBEAT.md, skills/) are already',
          'set up with template-specific instructions. Follow the instructions in AGENTS.md.',
          '',
        ].join('\n'))
      }
    }

    // 9. Current date/time context (changes every turn)
    const now = new Date()
    const currentCwd = (sessionId && this.shellCwd.get(sessionId)) || this.initialShellCwd(this.workspaceDir)
    pushDynamic('current-context', [
      '## Current Context',
      `- Today: ${now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}`,
      `- Year: ${now.getFullYear()}`,
      `- Timezone: ${this.userTimezone || Intl.DateTimeFormat().resolvedOptions().timeZone}`,
      ...this.workingDirectoryLines(currentCwd),
      'When users mention dates without a year, default to the current or next occurrence (never a past date).',
      ...this.buildShellNavLines(),
    ].join('\n'))

    const workspacePaused = this.buildWorkspacePausedContext(sessionId)
    if (workspacePaused) pushDynamic('workspace-paused', workspacePaused)

    const concurrentChats = this.buildConcurrentChatsContext(sessionId)
    if (concurrentChats) pushDynamic('concurrent-chats', concurrentChats)

    const modeLabel = activeMode === 'none' ? 'chat' : activeMode
    pushDynamic('current-mode', `\n## Current Mode\nActive visual mode: **${modeLabel}**.\n`)
    if (this.viewerContextPrompt) {
      pushDynamic('viewer-context', this.viewerContextPrompt)
    }
    // The model line comes from the turn (`modelDisplayName`), never from a
    // process-wide value: this runtime serves several chats, and pipeline /
    // heartbeat / schedule turns start without a chat request of their own.
    const accountPrompt = buildAccountContextPrompt({
      ...this.accountContext,
      ...(modelDisplayName ? { modelDisplayName } : {}),
    })
    if (accountPrompt) {
      pushDynamic('account-context', accountPrompt)
    }

    // 10. Dynamic workspace context (changes as files are added/removed)
    const installedToolsContext = this.buildInstalledToolsContext()
    if (installedToolsContext) {
      pushDynamic('installed-tools', installedToolsContext)
    }

    const uploadedFilesContext = this.buildUploadedFilesContext()
    if (uploadedFilesContext) {
      pushDynamic('uploaded-files', uploadedFilesContext)
    }

    const workspaceTree = this.buildWorkspaceTreeContext()
    if (workspaceTree) {
      pushDynamic('workspace-tree', workspaceTree)
    }

    // 11. Skills and skill server (can change when skills are installed)
    if (this.skills.length > 0) {
      const skillsSection = buildSkillsPromptSection(this.skills, undefined, (info) => this.reportSkillsTruncation(info))
      if (skillsSection) {
        pushDynamic('skills', skillsSection)
      }
    }

    // 11b. Quick actions (can change when agent registers new ones)
    if (cfg.quickActionsEnabled !== false && this.quickActions.length > 0) {
      const qaSection = buildQuickActionsPromptSection(this.quickActions)
      if (qaSection) {
        pushDynamic('quick-actions', qaSection)
      }
    }

    const skillServerSection = this.buildSkillServerPromptSection()
    if (skillServerSection) {
      pushDynamic('skill-server', skillServerSection)
    }

    // 12. Active team context (persisted in SQLite, survives session resets)
    if (sessionId) {
      const teamCtx = this.buildTeamContext(sessionId)
      if (teamCtx) pushDynamic('team-context', teamCtx)
    }

    // 12b. Background updates this session is holding. After the cache
    // boundary on purpose: a pause comes and goes, and putting it in the cached
    // prefix would invalidate the prompt every time it changed (SHO-82).
    if (sessionId) {
      const wake = buildWakeStatusSection(this.wakeStates.get(sessionId))
      if (wake) pushDynamic('wake-status', wake)
    }

    this.lastPromptBreakdown = sections

    const stableText = stableParts.join(SECTION_SEPARATOR)
    const dynamicText = dynamicParts.join(SECTION_SEPARATOR)
    return dynamicText ? stableText + CACHE_BOUNDARY + dynamicText : stableText
  }

  /**
   * The budgeted `## Memory` prompt section for `MEMORY.md` (SHO-78), memoised
   * on `mtimeMs:size`.
   *
   * Returns `null` when the file is missing, unreadable or empty, so the prompt
   * simply has no memory block — same as before.
   */
  private buildMemoryPromptSection(memoryPath: string): string | null {
    let key: string
    try {
      const stat = statSync(memoryPath)
      key = `${stat.mtimeMs}:${stat.size}`
    } catch {
      this.memorySectionCache = null
      return null
    }

    if (this.memorySectionCache?.key === key) {
      return this.memorySectionCache.content || null
    }

    let markdown: string
    try {
      markdown = readFileSync(memoryPath, 'utf-8')
    } catch {
      this.memorySectionCache = null
      return null
    }

    const content = buildMemorySection({ markdown }).content
    this.memorySectionCache = content ? { key, content } : null
    return content || null
  }

  /**
   * URL block describing where the running preview app is reachable.
   *
   * This exists because the QA subagent contract requires a URL, and the main
   * agent previously had no reliable way to discover one (it was inventing
   * paths under .shogo/ and reading `vite.config.ts`, where the template
   * hardcodes port 5173 — a value that is always overridden at runtime by
   * whichever launcher spawned the process).
   *
   * Two ways this block gets a URL, in priority order:
   *   1. `PUBLIC_PREVIEW_URL` env var — set by the launcher (knative API or
   *      local RuntimeManager). This is the authoritative URL the user /
   *      browser sees. Trust it unconditionally when present.
   *   2. A built `dist/index.html` under the workspace — indicates the
   *      standalone agent-runtime is self-serving the app on its own port
   *      (`process.env.PORT`). Fall back to localhost in that case.
   *
   * Intentionally positive-only: do NOT name the hallucinated paths / ports
   * this replaces. Naming "don't use X" still puts X in the model's working
   * set.
   *
   * Returns null only when neither signal is present — no point telling the
   * agent about a URL that won't load.
   */
  private buildPreviewUrlContext(): string | null {
    // dist/ may live at either workspaceDir/project/dist (k8s layout, where
    // the project lives in a /project subdir) or workspaceDir/dist (local
    // RuntimeManager layout, where workspaceDir === projectDir).
    const hasDist =
      existsSync(join(this.workspaceDir, 'project', 'dist', 'index.html')) ||
      existsSync(join(this.workspaceDir, 'dist', 'index.html'))

    return buildPreviewUrlBlock({
      publicUrl: process.env.PUBLIC_PREVIEW_URL,
      runtimePort: parseInt(process.env.PORT || '8080', 10),
      hasDist,
      // Local dev can hand out localhost (the user opens it); a cloud pod never
      // can. This is what stops localhost reaching the user-facing slot.
      isLocal: this.previewManager?.isLocalMode ?? detectLocalMode(),
    })
  }

  /**
   * Last lines of `.shogo/logs/build.log` and `.shogo/logs/console.log`
   * (Vite/API preview + runtime console). Used only when canvas mode is
   * active; returns null if both files are missing or empty.
   */
  private buildRuntimeLogsContext(): string | null {
    const LINE_LIMIT = 30
    const MAX_BLOCK_CHARS = 3000
    const buildPath = previewBuildLogPath(this.workspaceDir)
    const consolePath = previewConsoleLogPath(this.workspaceDir)

    let buildTail = ''
    if (existsSync(buildPath)) {
      try {
        const raw = readFileSync(buildPath, 'utf-8')
        const joined = raw.split(/\r?\n/).slice(-LINE_LIMIT).join('\n').trimEnd()
        buildTail =
          joined.length > MAX_BLOCK_CHARS ? joined.slice(-MAX_BLOCK_CHARS) : joined
      } catch {
        buildTail = ''
      }
    }

    let consoleTail = ''
    if (existsSync(consolePath)) {
      try {
        const raw = readFileSync(consolePath, 'utf-8')
        const joined = raw.split(/\r?\n/).slice(-LINE_LIMIT).join('\n').trimEnd()
        consoleTail =
          joined.length > MAX_BLOCK_CHARS ? joined.slice(-MAX_BLOCK_CHARS) : joined
      } catch {
        consoleTail = ''
      }
    }

    if (!buildTail && !consoleTail) {
      return null
    }

    const buildLogRelative = `${RUNTIME_LOG_SUBDIR.replace(/\\/g, '/')}/${BUILD_LOG_BASENAME}`
    const consoleLogRelative = `${RUNTIME_LOG_SUBDIR.replace(/\\/g, '/')}/${CONSOLE_LOG_BASENAME}`
    const buildLogAbsolute = buildPath
    const consoleLogAbsolute = consolePath

    const lines: string[] = [
      '## Runtime Logs (auto-injected, last ~30 lines each)',
      '',
      [
        'These tails are refreshed every turn. Both logs live under the workspace\'s **`.shogo/logs/`** directory (the `.shogo/` tree is excluded from the bundler\'s file watcher so writes here never trigger a rebuild loop).',
        `**Build:** \`${buildLogRelative}\` — full path \`${buildLogAbsolute}\`.`,
        `**Console:** \`${consoleLogRelative}\` — full path \`${consoleLogAbsolute}\`.`,
        `Use \`read_file\` with paths relative to the workspace root (e.g. \`read_file({ path: '${buildLogRelative}' })\` and \`read_file({ path: '${consoleLogRelative}' })\`).`,
        'Shell `exec` depends on cwd — prefer absolute paths or `cd` into the workspace first.',
        'The console file is cleared when the preview **starts** or **restarts** (fresh build session).',
      ].join(' '),
      '',
      `### Build log (\`${buildLogRelative}\`)`,
      `On disk: \`${buildLogAbsolute}\`. Written by the preview pipeline (Vite/Expo bundler + template API stdout/stderr). Lines use prefixes such as \`[stdout]\`, \`[stderr]\`, \`[api-stdout]\`. If the last lines show an error, fix it before claiming work is done.`,
      '',
      '```',
      buildTail || '(empty)',
      '```',
      '',
      `### Console log (\`${consoleLogRelative}\`)`,
      [
        `On disk: \`${consoleLogAbsolute}\`. Lines include forwarded preview/bundler output and gateway lifecycle events (\`emitLog\`) — same lines the user sees in the mobile app "Logs" tab.`,
      ].join(' '),
      '',
      '```',
      consoleTail || '(empty)',
      '```',
    ]

    return lines.join('\n')
  }

  /**
   * Build a system prompt section describing active teams, their members,
   * and task state.  Queried from the persistent SQLite TeamManager so
   * the agent retains awareness across conversation / pipeline resets.
   */
  private buildTeamContext(sessionId: string): string | null {
    if (!this.teamManager) return null

    const teams = this.teamManager.listTeams(sessionId)
    if (teams.length === 0) return null

    const sections: string[] = ['## Active Team Context']

    for (const team of teams) {
      const members = this.teamManager.listMembers(team.id)
      const tasks = this.teamManager.listTasks(team.id)

      sections.push(`### Team: ${team.name} (id: \`${team.id}\`)`)
      if (team.description) sections.push(team.description)

      if (members.length > 0) {
        sections.push('**Members:**')
        for (const m of members) {
          const status = m.isActive ? 'active' : 'inactive'
          sections.push(`- \`${m.name}\` (agent: \`${m.agentId}\`, ${status})`)
        }
      }

      if (tasks.length > 0) {
        sections.push('**Tasks:**')
        for (const t of tasks) {
          const deps = t.blockedBy.length > 0 ? ` [blocked by: ${t.blockedBy.join(', ')}]` : ''
          const owner = t.owner ? ` (owner: ${t.owner})` : ''
          sections.push(`- #${t.id} ${t.subject} — **${t.status}**${owner}${deps}`)
        }
      }
    }

    sections.push(
      '',
      'Use `send_team_message`, `team_task_create`, `team_task_update`, `team_task_list`, `team_delete` and other team tools to interact with this team.',
    )

    return sections.join('\n')
  }

  /**
   * The other chats live in this workspace, as rows the prompt renders. Excludes
   * the calling session; `[]` when this chat has the workspace to itself.
   */
  private concurrentChatsFor(sessionId?: string): ConcurrentChat[] {
    const others = this.sessionManager
      .listChatSessions(20 * 60_000)
      .filter((chat) => chat.id !== sessionId)
    if (others.length === 0) return []
    const now = Date.now()
    return others.map((chat) => ({
      id: chat.id,
      label: concurrentChatLabel({ id: chat.id, title: chat.title, firstUserText: chat.firstUserText }),
      running: this.turnLocks.has(chat.id),
      idleSeconds: Math.max(0, Math.floor((now - chat.lastActivityAt) / 1000)),
    }))
  }

  /**
   * Build a system prompt section listing the other chats live in this
   * workspace: several chats share one pod, so their turns overlap and their
   * edits, builds and DB pushes land mid-turn. Excludes the calling session,
   * and returns null when this chat has the workspace to itself.
   *
   * `turnReachable` is this turn's `chat-reachable` answer (primed before the
   * prompt is built). Without it the list renders unlabelled — the prompt never
   * waits on the API.
   */
  private buildConcurrentChatsContext(sessionId?: string): string | null {
    const chats = this.concurrentChatsFor(sessionId)
    if (chats.length === 0) return null
    const reachable = sessionId ? this.turnReachable.get(sessionId) : undefined
    return buildConcurrentChatsPrompt(chats, {
      isolatedEdits: this.isWorktreesEnabled(),
      ...(reachable ? { reachable } : {}),
    })
  }

  /**
   * Tell a woken agent the workspace is paused, so it reports and stops instead
   * of starting work. `agent_run_stop({ scope: "workspace" })` is what a person
   * uses to set and lift it (SHO-118).
   */
  private buildWorkspacePausedContext(sessionId?: string): string | null {
    const pause = sessionId ? this.turnPause.get(sessionId) : null
    if (!pause) return null
    const since = (() => {
      const at = new Date(pause.at)
      return Number.isNaN(at.getTime()) ? pause.at : at.toISOString()
    })()
    const lines = [
      '## Workspace paused (agent lanes)',
      `Every automatic agent start in this workspace is paused since ${since}${pause.by ? ` by ${pause.by}` : ''}.`,
    ]
    if (pause.reason) lines.push(`Reason: ${pause.reason}`)
    lines.push(
      '- Do not start new work, hand off cards, create cards or message other agents. Finish nothing that is not already in flight: report what you stopped and stop.',
      '- A person\'s own message still runs; this pause holds automatic starts (task updates, schedules, triggers, card hand-offs, team-chat tags).',
      '- The person lifts it with `agent_run_stop({ scope: "workspace", resume: true })` — do not lift it yourself unless that person asks you to.',
    )
    return lines.join('\n')
  }

  /**
   * Read this turn's two API-side facts once, before the prompt is built: which
   * of the listed chats the person can actually open, and whether the workspace
   * is paused. Both fail open (an error, a missing API or a slow answer renders
   * exactly what the prompt showed before), and both are skipped unless there is
   * something worth asking: reachability only when another chat is listed, and
   * the pause only in a workspace runtime.
   */
  private async primeTurnFacts(sessionId?: string): Promise<void> {
    if (!sessionId) return
    const workspaceId = resolveRuntimeIdentity().workspaceId || undefined
    this.turnPause.delete(sessionId)
    this.turnReachable.delete(sessionId)
    if (!workspaceId || !hasInternalApiCredentials()) return
    const chatIds = this.concurrentChatsFor(sessionId).map((chat) => chat.id)
    const [reachable, pause] = await Promise.all([
      chatIds.length ? fetchReachableChats(workspaceId, chatIds).catch(() => null) : null,
      fetchWorkspacePause(workspaceId).catch(() => null),
    ])
    if (reachable?.ok && reachable.data) this.turnReachable.set(sessionId, reachable.data.reachable)
    if (pause?.ok && pause.data) this.turnPause.set(sessionId, pause.data.paused)
  }

  /**
   * Build a system prompt section describing the project's API server
   * (root `server.tsx`). If the server is healthy, tells the agent the
   * base URL and active routes; otherwise gives instructions for adding
   * models and tools to bring it up to date.
   */
  private buildSkillServerPromptSection(): string | null {
    if (this.config.shellEnabled === false) return null

    const phase = this.skillServerManager.phase
    const genError = this.skillServerManager.lastGenerateError
    const activeRoutes = this.skillServerManager.getActiveRoutes()
    const schemaModels = this.skillServerManager.getSchemaModels()
    const url = this.skillServerManager.url

    const regenGuide = [
      '### How schema regeneration works',
      '',
      'When you edit `prisma/schema.prisma` using `write_file` or `edit_file`,',
      'the tool **automatically** runs the full pipeline before returning:',
      '1. Runs `bun run generate` — refreshes routes, types, hooks, the API client, and the Prisma client',
      '2. Runs `prisma db push` — applies the schema additively to `prisma/dev.db`',
      '3. Restarts `server.tsx` so it loads the new routes',
      '4. Returns the list of **active routes** in the tool response',
      '',
      '**The tool response tells you exactly which routes are live.** Use those exact paths in your code.',
      '',
      '**Important:** ALWAYS read the existing `prisma/schema.prisma` first and APPEND your new models. Do not replace the file or remove existing models.',
      '',
      '`server.tsx` is **auto-generated** by the SDK from `shogo.config.json` —',
      'do NOT edit it. For custom non-CRUD routes (proxies, aggregations,',
      'webhooks, auth flows), edit `custom-routes.ts` at the project root.',
      'Saving that file triggers a fast restart (no regenerate, no db push)',
      'so changes are live in under a second.',
      '',
      ...(subagentOrchestrationDisabled(this.config)
        ? []
        : [
            'If you ever see a route 404 or need to force a refresh, delegate to the `devops` subagent, which has the `server_sync` tool:',
            '```',
            'agent_spawn({ type: "devops", prompt: "Run server_sync and report the phase, active routes, and schema models" })',
            '```',
            'It reports the current phase, active routes, and schema models.',
            '',
          ]),
      '**Do NOT** manually run `prisma generate`, `shogo generate`, or `npm run db:generate` — it is all automatic.',
    ].join('\n')

    if (this.skillServerManager.isRunning) {
      const lines = [
        '## Project Server',
        '',
        `Your project\'s backend (\`server.tsx\` at the project root) is running at **${url}** (status: **healthy**).`,
        '',
        'This is a Hono API backed by SQLite via Prisma. Each model in `prisma/schema.prisma` gets CRUD routes at',
        '`/api/{model-name-plural}` (GET list, GET /:id, POST, PATCH /:id, DELETE /:id).',
      ]

      if (activeRoutes.length > 0) {
        lines.push('')
        lines.push('**Currently active routes:**')
        for (const r of activeRoutes) {
          lines.push(`- \`${url}/api/${r}\``)
        }
      }

      const pendingModels = schemaModels.filter(m => {
        const kebab = m.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase()
        let expected: string
        if (kebab.endsWith('y')) expected = kebab.slice(0, -1) + 'ies'
        else if (kebab.endsWith('s') || kebab.endsWith('x') || kebab.endsWith('ch') || kebab.endsWith('sh')) expected = kebab + 'es'
        else expected = kebab + 's'
        return !activeRoutes.includes(expected)
      })

      if (pendingModels.length > 0) {
        lines.push('')
        lines.push(`**Schema models without routes yet (regeneration pending):** ${pendingModels.join(', ')}`)
        lines.push('These routes will appear after the regeneration pipeline finishes.')
      }

      lines.push('')
      lines.push(`Use the \`web\` tool with the full URL (e.g. \`web({ url: "${url}/api/${activeRoutes[0] || 'leads'}" })\`) to interact with it from agent tools.`)
      lines.push('')
      lines.push('To add new models, **append** them to `prisma/schema.prisma` (do not replace the file).')
      lines.push('To add custom business logic for a model (validation, side-effects), create or edit `src/lib/hooks/{model}.ts`.')
      lines.push('For custom API routes beyond CRUD (external proxies, aggregation, webhooks), edit `custom-routes.ts` at the project root — it exports a Hono `app` mounted under `/api/`. Do NOT edit `server.tsx`; it is auto-generated by the SDK and overwritten on regenerate.')
      lines.push('')
      lines.push(regenGuide)

      return lines.join('\n')
    }

    if (phase === 'generating' || phase === 'restarting') {
      const lines = [
        `## Project Server (${phase === 'generating' ? 'Generating...' : 'Restarting...'})`,
        '',
        `The API server is currently ${phase}. It will be available shortly at \`${url}\`.`,
      ]

      if (activeRoutes.length > 0) {
        lines.push('')
        lines.push('**Routes from last generation:**')
        for (const r of activeRoutes) lines.push(`- \`/api/${r}\``)
        lines.push('')
        lines.push('These may 404 until the restart completes. Wait a few seconds and retry.')
      }

      if (schemaModels.length > 0) {
        lines.push('')
        lines.push(`**Schema models:** ${schemaModels.join(', ')}`)
      }

      lines.push('')
      lines.push(regenGuide)
      return lines.join('\n')
    }

    if (phase === 'crashed' && genError) {
      return [
        '## Project Server (Error)',
        '',
        'The last code generation failed:',
        '```',
        genError,
        '```',
        'Fix the issue in `prisma/schema.prisma` (or `custom-routes.ts`) and save — the runtime will retry automatically. Do not edit `server.tsx`; it is regenerated from `shogo.config.json`.',
        '',
        regenGuide,
      ].join('\n')
    }

    return [
      '## Project Server (Available)',
      '',
      'Your project ships with its own backend (Hono + Prisma + SQLite). Edit `prisma/schema.prisma` to add models — the runtime regenerates routes and restarts the server automatically.',
      '',
      'To add a model, append it to `prisma/schema.prisma`:',
      '```prisma',
      'model Lead {',
      '  id        String   @id @default(cuid())',
      '  name      String',
      '  email     String',
      '  status    String   @default("new")',
      '  createdAt DateTime @default(now())',
      '  updatedAt DateTime @updatedAt',
      '}',
      '```',
      '',
      'That\'s it — **everything else is automatic**: code generation, database migration,',
      `and server restart on \`${url}\`.`,
      'Each model gets full CRUD at `/api/{model-name-plural}`.',
      '',
      'For custom API routes beyond CRUD (proxies, aggregation, webhooks), edit `custom-routes.ts` at the project root. `server.tsx` is auto-generated — do not edit it.',
      '',
      regenGuide,
    ].join('\n')
  }

  /**
   * Build a context section listing currently installed tool integrations.
   * Included in the system prompt so the agent knows what's available
   * and can use installed tools directly without needing to discover them.
   */
  private buildInstalledToolsContext(): string | null {
    const servers = this.mcpClientManager.getServerInfo()
    if (servers.length === 0) return null

    const lines = [
      '## Installed Tools',
      '',
      'The following tool integrations are currently installed and available:',
      '',
    ]

    for (const server of servers) {
      const toolList = server.toolNames.length <= 8
        ? server.toolNames.join(', ')
        : server.toolNames.slice(0, 8).join(', ') + `, ... (+${server.toolNames.length - 8} more)`
      lines.push(`- **${server.name}** (${server.toolCount} tools): ${toolList}`)
    }

    lines.push('')
    lines.push('Use these tools directly — no need to search or install them. Use `disconnect` to remove any you no longer need.')
    lines.push('')
    lines.push('**From canvas code:** These tools are also callable from React code via `import { useTools } from \'@shogo-ai/sdk/tools\'`. Use `const { execute } = useTools()` then `await execute(\'TOOL_NAME\', { ...args })`. This is the preferred pattern when building apps that need ongoing access to integration data.')

    return lines.join('\n')
  }

  /**
   * Build a context section listing files the user has uploaded.
   *
   * Most uploads land in `files/` and are searchable via the index engine.
   * Zip archives are placed directly at the workspace root so the agent can
   * `unzip` them in place, so we surface those separately here — otherwise
   * the agent wouldn't know they exist and would `ls files/` to nothing.
   */
  private buildUploadedFilesContext(): string | null {
    const filesDir = join(this.workspaceDir, 'files')
    const fileEntries = existsSync(filesDir)
      ? this.walkUploadedFiles(filesDir, '')
      : []

    let rootZips: Array<{ path: string; size: number }> = []
    try {
      for (const entry of readdirSync(this.workspaceDir, { withFileTypes: true })) {
        if (!entry.isFile()) continue
        if (!entry.name.toLowerCase().endsWith('.zip')) continue
        if (entry.name.startsWith('.')) continue
        try {
          const stat = statSync(join(this.workspaceDir, entry.name))
          rootZips.push({ path: entry.name, size: stat.size })
        } catch {
          // Ignore stat errors for individual entries
        }
      }
    } catch {
      // Workspace dir unreadable — treat as no archives
      rootZips = []
    }

    if (fileEntries.length === 0 && rootZips.length === 0) return null

    const lines: string[] = ['## Workspace Uploaded Files', '']

    if (fileEntries.length > 0) {
      lines.push(
        'The user has uploaded the following files to the workspace `files/` directory.',
        isSearchEnabled()
          ? 'Use `search` to search content, or `read_file` with path `files/<name>` to read them.'
          : 'Use `read_file` with path `files/<name>` to read them, or `exec` with `rg -n "<text>" files` to search their content.',
        '',
      )
      for (const entry of fileEntries.slice(0, 50)) {
        lines.push(`- \`files/${entry.path}\` (${formatUploadedFileSize(entry.size)})`)
      }
      if (fileEntries.length > 50) {
        lines.push(`- ... and ${fileEntries.length - 50} more files`)
      }
    }

    if (rootZips.length > 0) {
      if (fileEntries.length > 0) lines.push('')
      lines.push(
        'The user has uploaded the following zip archive(s) to the workspace root.',
        'Use the shell `exec` tool with `unzip <name>.zip` to extract them in place.',
        '',
      )
      for (const entry of rootZips.slice(0, 50)) {
        lines.push(`- \`${entry.path}\` (${formatUploadedFileSize(entry.size)})`)
      }
      if (rootZips.length > 50) {
        lines.push(`- ... and ${rootZips.length - 50} more archives`)
      }
    }

    return lines.join('\n')
  }

  private walkUploadedFiles(
    dir: string,
    prefix: string,
  ): Array<{ path: string; size: number }> {
    const results: Array<{ path: string; size: number }> = []
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith('.')) continue
        const absPath = join(dir, entry.name)
        const relPath = prefix ? `${prefix}/${entry.name}` : entry.name
        if (entry.isDirectory()) {
          results.push(...this.walkUploadedFiles(absPath, relPath))
        } else {
          const stat = statSync(absPath)
          results.push({ path: relPath, size: stat.size })
        }
      }
    } catch {
      // Ignore permission or other errors
    }
    return results
  }

  /**
   * Build a concise workspace file tree so the agent knows what files already
   * exist before deciding to create vs edit. Focuses on user-visible files —
   * skips .shogo internals, node_modules, etc.
   */
  private buildWorkspaceTreeContext(): string | null {
    try {
      const lines: string[] = []
      const SKIP = new Set(['.shogo', 'node_modules', '.git', '.cache', '.next', 'dist', 'build', 'files'])
      const MAX_FILES = 80

      // In a multi-project workspace runtime the top-level entries are the
      // workspace's attached projects (symlinks on host, real dirs in cloud).
      // Map id -> name so the tree labels each one ("(attached project: X)")
      // instead of showing a bare UUID the agent might mistake for an
      // unrelated or other-user folder. Empty for single-project runtimes.
      const projectNameById = new Map<string, string>()
      for (const p of workspaceProjectsManifest()) projectNameById.set(p.id, p.name)

      const walk = (dir: string, prefix: string, depth: number) => {
        if (depth > 4 || lines.length >= MAX_FILES) return
        let entries: import('fs').Dirent[]
        try {
          entries = readdirSync(dir, { withFileTypes: true })
        } catch { return }

        entries.sort((a, b) => {
          if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1
          return a.name.localeCompare(b.name)
        })

        for (const entry of entries) {
          if (lines.length >= MAX_FILES) break
          if (entry.name.startsWith('.') && depth === 0 && entry.name !== '.shogo') continue
          if (SKIP.has(entry.name)) continue

          const relPath = prefix ? `${prefix}/${entry.name}` : entry.name

          // Top-level attached project folder: label it and stop here. Its
          // contents are listed only when the agent opens that project, which
          // keeps the merged-root tree concise (the symlink targets can be
          // large) while making ownership unambiguous.
          const attachedName = depth === 0 ? projectNameById.get(entry.name) : undefined
          if (attachedName) {
            lines.push(`${relPath}/  (attached project: ${attachedName})`)
            continue
          }

          if (entry.isDirectory()) {
            lines.push(`${relPath}/`)
            walk(join(dir, entry.name), relPath, depth + 1)
          } else {
            lines.push(relPath)
          }
        }
      }

      walk(this.workspaceDir, '', 0)
      if (lines.length === 0) return null

      return [
        '## Workspace Files',
        '',
        'Current files in the workspace (use `read_file` before editing existing files):',
        '```',
        ...lines,
        '```',
      ].join('\n')
    } catch {
      return null
    }
  }

  // ---------------------------------------------------------------------------
  // Channel Management
  // ---------------------------------------------------------------------------

  async connectChannel(
    type: string,
    config: Record<string, string>
  ): Promise<void> {
    let adapter: ChannelAdapter

    switch (type) {
      case 'telegram': {
        const { TelegramAdapter } = await import('./channels/telegram')
        adapter = new TelegramAdapter(config)
        break
      }
      case 'discord': {
        const { DiscordAdapter } = await import('./channels/discord')
        adapter = new DiscordAdapter(config)
        break
      }
      case 'email': {
        const { EmailAdapter } = await import('./channels/email')
        adapter = new EmailAdapter()
        break
      }
      case 'slack': {
        const { SlackAdapter } = await import('./channels/slack')
        adapter = new SlackAdapter(config)
        break
      }
      case 'slack-agent': {
        const { SlackAgentAdapter } = await import('./channels/slack-agent')
        adapter = new SlackAgentAdapter(config)
        break
      }
      case 'whatsapp': {
        const { WhatsAppAdapter } = await import('./channels/whatsapp')
        adapter = new WhatsAppAdapter(config)
        break
      }
      case 'webhook': {
        const { WebhookAdapter } = await import('./channels/webhook')
        adapter = new WebhookAdapter()
        break
      }
      case 'teams': {
        const { TeamsAdapter } = await import('./channels/teams')
        adapter = new TeamsAdapter(config)
        break
      }
      case 'webchat': {
        const { WebChatAdapter } = await import('./channels/webchat')
        adapter = new WebChatAdapter()
        break
      }
      default:
        throw new Error(`Unknown channel type: ${type}`)
    }

    adapter.onMessage((msg) => this.processMessage(msg))
    await adapter.connect(config)
    this.channels.set(type, adapter)
    console.log(`[AgentGateway] Connected channel: ${type}`)
  }

  getChannel(type: string): ChannelAdapter | undefined {
    return this.channels.get(type)
  }

  /**
   * Wire the runtime's `PreviewManager` (owner of the API server) into
   * the gateway's prompt builder + tools. Called from server.ts after
   * both have been constructed.
   *
   * Once we finish the refactor, the gateway should hold a
   * `PreviewManager` reference directly and the `SkillServerManager`
   * shim can be deleted entirely.
   */
  attachApiServer(pm: import('./preview-manager').PreviewManager): void {
    this.skillServerManager.attach(pm)
    // Keep a direct handle so `start()` can pass `pm.depsReady` into
    // CanvasBuildManager. The order matters: `server.ts` calls
    // `attachApiServer()` BEFORE `start()`, so the handle is always
    // populated by the time we wire it.
    this.previewManager = pm
  }

  getSkillServerPort(): number | null {
    // Return the configured port regardless of running state. The shim's
    // `.port` already falls back to the resolved `API_SERVER_PORT` /
    // `SKILL_SERVER_PORT` / 3001 chain when the manager hasn't attached
    // yet, so callers (eg. the runtime-checks endpoint) probe the right
    // port even while the API server is still booting. Returning `null`
    // here used to short-circuit a stale `?? 4100` fallback that targeted
    // the retired skill server's port — no longer correct now that the
    // port is dynamic per-project.
    return this.skillServerManager.port
  }

  getSkillServerPhase(): string {
    return this.skillServerManager.phase
  }

  getSkillServerActiveRoutes(): string[] {
    return this.skillServerManager.getActiveRoutes()
  }

  getSkillServerSchemaModels(): string[] {
    return this.skillServerManager.getSchemaModels()
  }

  async syncSkillServer(): Promise<{ ok: boolean; phase: string }> {
    return this.skillServerManager.sync()
  }

  getMcpClientManager(): MCPClientManager {
    return this.mcpClientManager
  }

  private remoteTools: { config: GatewayConfig; tools: ReturnType<typeof createTools> } | null = null
  private remoteCommandRegistry = new TaskRegistry()

  /** Tool context for a session-less tool set (remote calls, cache probes). */
  private sessionlessToolContext(): ToolContext {
    return {
      workspaceDir: defaultShellCwd(this.workspaceDir),
      channels: this.channels,
      config: this.config,
      capabilityScope: 'project',
      projectId: process.env.WORKSPACE_ANCHOR_PROJECT_ID || this.projectId,
      workspaceId: process.env.WORKSPACE_ID,
      sandbox: this.config.sandbox,
      mainSessionIds: this.config.mainSessionIds,
      permissionEngine: this.permissionEngine ?? undefined,
      indexEngine: this.indexEngine ?? undefined,
      commandRegistry: this.remoteCommandRegistry,
    }
  }

  /**
   * Tools for `/agent/remote/tool`: another project's runtime running one of
   * this project's tools. Rooted at this project's own folder (the anchor in
   * a workspace runtime), with no session, UI stream or file-read cache. One
   * command registry spans all remote calls so exec_wait finds earlier runs.
   */
  getRemoteTools(): ReturnType<typeof createTools> {
    if (this.remoteTools?.config === this.config) return this.remoteTools.tools
    const tools = filterDisabledCapabilityTools(createTools(this.sessionlessToolContext()), this.config)
    this.remoteTools = { config: this.config, tools }
    return tools
  }

  /**
   * Rebuild the tool list from scratch. `fingerprintTools` over this is the
   * "did the tool block change?" signal for the cache-efficiency eval suite —
   * a cached `getRemoteTools()` would make that comparison trivially true.
   */
  private buildProbeTools(): AgentTool[] {
    return filterDisabledCapabilityTools(createTools(this.sessionlessToolContext()), this.config)
  }

  async disconnectChannel(type: string): Promise<void> {
    const adapter = this.channels.get(type)
    if (adapter) {
      await adapter.disconnect()
      this.channels.delete(type)
      console.log(`[AgentGateway] Disconnected channel: ${type}`)
    }
  }

  private async deliverAlert(alertText: string): Promise<void> {
    for (const [type, adapter] of this.channels) {
      try {
        const status = adapter.getStatus()
        if (status.connected) {
          await adapter.sendMessage('default', `[HEARTBEAT ALERT]\n${alertText}`)
        }
      } catch (err: any) {
        console.error(`[AgentGateway] Failed to deliver alert via ${type}:`, err.message)
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Memory
  // ---------------------------------------------------------------------------

  private appendHeartbeatLog(summary: string, dir: string = this.workspaceDir): void {
    const logPath = join(dir, 'HEARTBEAT_LOG.md')
    const timestamp = new Date().toISOString()
    const entry = `- [${timestamp}] ${summary}\n`
    const MAX_ENTRIES = 20

    try {
      let content = ''
      if (existsSync(logPath)) {
        content = readFileSync(logPath, 'utf-8')
      }

      const lines = content.split('\n').filter(l => l.startsWith('- ['))
      lines.push(entry.trim())
      const recent = lines.slice(-MAX_ENTRIES)

      writeFileSync(logPath, `# Recent Heartbeat Activity\n\n${recent.join('\n')}\n`, 'utf-8')
    } catch (error: any) {
      console.error('[AgentGateway] Failed to write heartbeat log:', error.message)
    }
  }

  private appendDailyMemory(entry: string): void {
    const date = new Date().toISOString().split('T')[0]
    const memoryDir = join(this.workspaceDir, 'memory')
    mkdirSync(memoryDir, { recursive: true })

    const filepath = join(memoryDir, `${date}.md`)
    const timestamp = new Date().toISOString().split('T')[1].split('.')[0]
    const line = `- [${timestamp}] ${entry}\n`

    try {
      if (existsSync(filepath)) {
        const existing = readFileSync(filepath, 'utf-8')
        writeFileSync(filepath, existing + line, 'utf-8')
      } else {
        writeFileSync(filepath, `# ${date}\n\n${line}`, 'utf-8')
      }
    } catch (error: any) {
      console.error('[AgentGateway] Failed to write daily memory:', error.message)
    }
  }

  // ---------------------------------------------------------------------------
  // Status
  // ---------------------------------------------------------------------------

  /**
   * Returns the live workspace LSP manager (or null if not started yet).
   * Exposed so the runtime HTTP layer can serve Monaco IDE traffic from
   * the same warmed-up tsserver instance the agent already uses for
   * read_lints diagnostics — no second process, no duplicate state.
   */
  getLspManager(): WorkspaceLSPManager | null {
    return this.lspManager
  }

  getStatus(): AgentStatus {
    // Hot-reload config so the UI always reflects the latest config.json
    this.reloadConfig()

    const channelStatuses: ChannelStatus[] = []
    for (const [type, adapter] of this.channels) {
      const status = adapter.getStatus()
      const channelDef = this.config.channels.find(c => c.type === type)
      if (channelDef?.model) {
        status.model = channelDef.model
      }
      channelStatuses.push(status)
    }

    // Merge skills from filesystem with skills declared in config.json
    const fsSkills = this.skills.map((s) => ({
      name: s.name,
      trigger: s.trigger || '',
      description: s.description,
    }))
    const fsSkillNames = new Set(fsSkills.map((s) => s.name))
    const configSkills = (this.configSkills ?? [])
      .filter((s: any) => s.name && !fsSkillNames.has(s.name))
      .map((s: any) => ({
        name: s.name,
        trigger: s.trigger || '',
        description: s.description || '',
      }))

    // Compute memory/context file stats
    const memoryFiles = ['AGENTS.md', 'TOOLS.md', 'STACK.md', 'HEARTBEAT.md', 'MEMORY.md']
    let memoryFileCount = 0
    let memoryTotalSize = 0
    let memoryLastModified: Date | null = null

    for (const filename of memoryFiles) {
      const filepath = resolveWorkspaceConfigFilePath(this.workspaceDir, filename)
      if (filepath) {
        try {
          const st = statSync(filepath)
          if (st.size > 0) {
            memoryFileCount++
            memoryTotalSize += st.size
            if (!memoryLastModified || st.mtime > memoryLastModified) {
              memoryLastModified = st.mtime
            }
          }
        } catch { /* skip */ }
      }
    }

    const memoryDir = join(this.workspaceDir, 'memory')
    if (existsSync(memoryDir)) {
      try {
        for (const entry of readdirSync(memoryDir)) {
          if (!entry.endsWith('.md')) continue
          const fp = join(memoryDir, entry)
          const st = statSync(fp)
          if (st.isFile() && st.size > 0) {
            memoryFileCount++
            memoryTotalSize += st.size
            if (!memoryLastModified || st.mtime > memoryLastModified) {
              memoryLastModified = st.mtime
            }
          }
        }
      } catch { /* skip */ }
    }

    const activeTurnCount = this.turnLocks.size

    return {
      running: this.running,
      status: activeTurnCount > 0 ? 'active' : this.running ? 'idle' : 'stopped',
      currentTask: this._currentTask,
      lastTool: this._lastTool,
      heartbeat: {
        enabled: this.heartbeatSnapshot.enabled,
        intervalSeconds: this.heartbeatSnapshot.intervalSeconds,
        lastTick: this.lastHeartbeatTick?.toISOString() ?? null,
        quietHours: this.heartbeatSnapshot.quietHours,
      },
      channels: channelStatuses,
      skills: [...fsSkills, ...configSkills],
      model: this.config.model,
      sessions: this.sessionManager.getAllStats(),
      memory: {
        fileCount: memoryFileCount,
        totalSizeBytes: memoryTotalSize,
        lastModified: memoryLastModified?.toISOString() ?? null,
      },
    }
  }

  reloadConfig(): void {
    this.config = this.loadConfig()
    this.workspaceCapabilitySettings = this.loadWorkspaceCapabilitySettings()
    this.skills = loadAllSkills(this.workspaceDir)
    this.quickActions = loadQuickActions(this.workspaceDir)
    setLoadedSkills(this.skills)
    this.configSkills = this.loadConfigSkills()

  }

  /**
   * Pull the DB-owned model into `config.json` at most once every
   * `CONFIG_MODEL_SYNC_MS`, for turns that take their model from `config.json`
   * rather than from a session override: pipeline (`project_call`), heartbeat,
   * schedule and webhook turns.
   *
   * `PATCH /api/internal/projects/:id/config` writes the model to the database,
   * and there is no API→runtime push for a change made from another project's
   * agent, so without this a model change only landed after a restart. A failed
   * sync keeps the last-known config: naming a stale model for one more turn is
   * better than refusing to run.
   *
   * Returns true when the config was reloaded (the caller's surface config is
   * then one revision behind and should be re-derived).
   */
  private async refreshConfigModelIfStale(): Promise<boolean> {
    if (Date.now() - this.lastConfigModelSyncAt < CONFIG_MODEL_SYNC_MS) return false
    this.lastConfigModelSyncAt = Date.now()
    try {
      return await this.syncCapabilitiesFromApi()
    } catch (err: any) {
      console.warn(`[AgentGateway] model sync failed; keeping the last-known config: ${err?.message ?? err}`)
      return false
    }
  }

  /**
   * Pull capability toggles from the database into `config.json`: the
   * project's `Project.settings` (flat, as before) and, in a workspace
   * runtime, the workspace agent's own `Workspace.settings` (under
   * `workspaceCapabilities`). The database wins over a stale cache; when the
   * API can't be reached the file is left as-is.
   *
   * Both pulls are independent: a workspace runtime with no anchor project
   * (`ws:<workspaceId>`, no `PROJECT_ID`) still syncs the workspace agent's
   * toggles, which is the whole point — its capabilities are the workspace's,
   * not a project's. Processes without internal-API credentials skip the pull.
   * Tests pass `fetchConfig` / `fetchWorkspaceConfig` to skip the credential
   * check and the network.
   *
   * Outside an explicit fetcher, each pull is also scoped to what this process
   * actually serves: the project config only for the project this gateway was
   * built for (`PROJECT_ID` / `WORKSPACE_ANCHOR_PROJECT_ID` must not name
   * someone else), the workspace config only when `workspaceDir` is this
   * runtime's own `WORKSPACE_DIR`. Otherwise a test fixture — or a gateway left
   * over from another project — writes a stranger's settings into its
   * `config.json` (SHO-102).
   *
   * Returns true when at least one database read was applied.
   */
  async syncCapabilitiesFromApi(
    fetchConfig?: (projectId: string) => Promise<{ ok: boolean; data?: { settings?: unknown; agent?: AgentModelSnapshot | null } | null }>,
    fetchWorkspaceConfig?: (workspaceId: string) => Promise<{ ok: boolean; data?: { settings?: unknown } | null }>,
  ): Promise<boolean> {
    if (!fetchConfig && !fetchWorkspaceConfig && !hasInternalApiCredentials()) return false

    const projectId = projectScopedId(this.projectId)
    const workspaceId = isWorkspaceRuntimeMode() ? (process.env.WORKSPACE_ID || null) : null
    if (!projectId && !workspaceId) return false

    // `config.json` belongs to this gateway's workspaceDir, so the pull has to
    // match the identity the gateway was built with, not just the live env id.
    // The `projectId` getter prefers `process.env.PROJECT_ID` (pool
    // re-assignment), which would otherwise fetch the env project's settings
    // into any directory — including a test's scratch dir. A pool placeholder
    // names no project, so it keeps following the live env id.
    const ownedProjectId = projectScopedId(this._constructedProjectId) ?? projectId
    const servesThisRuntime = runtimeServesProjectId(ownedProjectId)
    const projectSyncAllowed = !!fetchConfig || servesThisRuntime
    // The workspace overlay IS this runtime's own settings (it is read by
    // `WORKSPACE_ID`), so only the directory it lands in can be foreign. A
    // gateway serving one of this runtime's own projects belongs to the
    // runtime, and keeps caching the overlay next to its project config.
    const workspaceSyncAllowed = !!fetchWorkspaceConfig
      || !isForeignWorkspaceDir(this.workspaceDir)
      || servesThisRuntime

    const configPath = resolveWorkspaceConfigFilePath(this.workspaceDir, 'config.json')
      ?? join(this.workspaceDir, 'config.json')
    const fileConfig = this.readConfigFile()
    let next: Record<string, unknown> = { ...fileConfig }
    let applied = false

    if (projectId && !projectSyncAllowed) {
      const declared = [...new Set([process.env.PROJECT_ID, process.env.WORKSPACE_ANCHOR_PROJECT_ID])]
        .filter(Boolean)
        .join(', ')
      console.warn(
        `[AgentGateway] capability sync skipped: this runtime serves "${declared}", gateway project is "${ownedProjectId}"`,
      )
    }

    if (projectId && projectSyncAllowed) {
      let result: { ok: boolean; data?: { settings?: unknown; agent?: AgentModelSnapshot | null } | null } | undefined
      try {
        result = fetchConfig ? await fetchConfig(projectId) : await getProjectConfig(projectId, 3_000)
      } catch (err: any) {
        console.warn(`[AgentGateway] capability sync failed: ${err?.message ?? err}`)
      }
      if (result?.ok && result.data) {
        next = mergeCapabilitySettingsIntoConfig(next, result.data.settings).config
        // The model is DB-owned exactly like the toggles: `PATCH …/config`
        // writes `AgentConfig.modelName`, and the runtime caches it in
        // `config.json` for the turns that don't go through the channel
        // dispatcher. Merging it here is what makes a model change land on the
        // next pipeline/heartbeat/schedule turn instead of after a restart
        // (SHO-145).
        next = mergeAgentModelIntoConfig(next, result.data.agent).config
        applied = true
      } else if (result) {
        console.warn('[AgentGateway] capability sync skipped; keeping the last-known config.json')
      }
    }

    if (workspaceId && !workspaceSyncAllowed) {
      console.warn(
        `[AgentGateway] workspace capability sync skipped: workspaceDir "${this.workspaceDir}" is not this runtime's WORKSPACE_DIR "${process.env.WORKSPACE_DIR}"`,
      )
    }

    if (workspaceId && workspaceSyncAllowed) {
      let result: { ok: boolean; data?: { settings?: unknown } | null } | undefined
      try {
        result = fetchWorkspaceConfig
          ? await fetchWorkspaceConfig(workspaceId)
          : await getWorkspaceConfig(workspaceId, 3_000)
      } catch (err: any) {
        console.warn(`[AgentGateway] workspace capability sync failed: ${err?.message ?? err}`)
      }
      if (result?.ok && result.data) {
        next = { ...next, workspaceCapabilities: parseWorkspaceSettings(result.data.settings) }
        applied = true
      } else if (result) {
        console.warn('[AgentGateway] workspace capability sync skipped; keeping the last-known config.json')
      }
    }

    if (applied && JSON.stringify(next) !== JSON.stringify(fileConfig)) {
      writeFileSync(configPath, JSON.stringify(next, null, 2), 'utf-8')
    }
    if (applied) this.reloadConfig()
    return applied
  }

  // ── BETA: per-chat git worktrees ──────────────────────────────────────────

  /** Wire the durable-repo persist hook (server.ts owns the git_only path). */
  setRepoPersistHook(fn: () => Promise<void> | void): void {
    this.repoPersistHook = fn
  }

  /** Whether the per-chat worktree feature is active for this project. */
  isWorktreesEnabled(): boolean {
    return this.config.gitWorktreesEnabled === true
  }

  /** Lazily build the worktree manager when the feature is enabled. */
  getWorktreeManager(): WorktreeManager | null {
    if (!this.isWorktreesEnabled()) return null
    if (!this.worktreeManager) {
      this.worktreeManager = new WorktreeManager({ mainRepoDir: this.workspaceDir })
    }
    return this.worktreeManager
  }

  /**
   * Sessions that should run in an isolated worktree. Excludes heartbeat and
   * the configured "main" sessions (which operate on the canonical tree), and
   * requires a path/branch-safe session id.
   */
  private isWorktreeEligibleSession(sessionId?: string, isHeartbeat?: boolean): boolean {
    if (!this.isWorktreesEnabled()) return false
    if (!sessionId || isHeartbeat) return false
    if ((this.config.mainSessionIds ?? []).includes(sessionId)) return false
    return /^[A-Za-z0-9._-]+$/.test(sessionId)
  }

  /** Whether a worktree has already been created for this session. */
  isWorktreeSession(sessionId?: string): boolean {
    if (!sessionId) return false
    const p = this.sessionWorktreePaths.get(sessionId)
    return !!(p && existsSync(p))
  }

  /**
   * Ensure (lazily create / re-attach) the worktree for a chat session and
   * cache its working-directory path. Returns null on failure or when the
   * feature is off, so callers fall back to the canonical workspace.
   */
  async ensureSessionWorktree(sessionId: string): Promise<string | null> {
    const mgr = this.getWorktreeManager()
    if (!mgr) return null
    const cached = this.sessionWorktreePaths.get(sessionId)
    if (cached && existsSync(cached)) return cached
    try {
      const info = await mgr.ensureWorktree(sessionId)
      this.sessionWorktreePaths.set(sessionId, info.path)
      return info.path
    } catch (err: any) {
      console.error(`${this.logPrefix} ensureSessionWorktree failed for ${sessionId}:`, err?.message ?? err)
      return null
    }
  }

  /** The working dir a session's tools should operate in (worktree or main). */
  resolveSessionWorkspaceDir(sessionId?: string): string {
    if (sessionId) {
      const p = this.sessionWorktreePaths.get(sessionId)
      if (p && existsSync(p)) return p
    }
    return this.workspaceDir
  }

  private async persistDurableRepoIfHooked(): Promise<void> {
    if (!this.repoPersistHook) return
    try {
      await this.repoPersistHook()
    } catch (err: any) {
      console.warn(`${this.logPrefix} durable repo persist hook threw:`, err?.message ?? err)
    }
  }

  /**
   * Commit the session's worktree at the turn-complete boundary so its branch
   * accumulates the agent's edits, then persist the durable `.git` (branches
   * are refs in the shared object store). Best-effort and fire-and-forget from
   * the caller's perspective.
   */
  async commitAndPersistSessionWorktree(sessionId?: string): Promise<void> {
    if (!sessionId || !this.isWorktreeSession(sessionId)) return
    const mgr = this.getWorktreeManager()
    if (!mgr) return
    try {
      await mgr.commitWorktree(sessionId, `chat ${sessionId}: ${new Date().toISOString()}`)
      await this.persistDurableRepoIfHooked()
    } catch (err: any) {
      console.warn(`${this.logPrefix} commitAndPersistSessionWorktree threw:`, err?.message ?? err)
    }
  }

  /**
   * Recreate worktree working directories for all in-flight chat branches.
   * Called on cold start so isolated trees survive a pod restart (branches are
   * durable in the persisted `.git`; only the working dirs need replaying).
   */
  async recreateActiveWorktrees(): Promise<void> {
    const mgr = this.getWorktreeManager()
    if (!mgr) return
    try {
      const infos = await mgr.recreateWorktrees()
      for (const info of infos) {
        if (info.exists) this.sessionWorktreePaths.set(info.chatSessionId, info.path)
      }
      if (infos.length > 0) {
        console.log(`${this.logPrefix} recreated ${infos.length} chat worktree(s) on boot`)
      }
    } catch (err: any) {
      console.warn(`${this.logPrefix} recreateActiveWorktrees threw:`, err?.message ?? err)
    }
  }

  /** Current status of all Shogo-managed worktrees, for UI/awareness. */
  async listWorktreeStatuses(): Promise<WorktreeStatus[]> {
    const mgr = this.getWorktreeManager()
    if (!mgr) return []
    const infos = await mgr.listWorktrees()
    const out: WorktreeStatus[] = []
    for (const info of infos) {
      const s = await mgr.status(info.chatSessionId)
      if (s) out.push(s)
    }
    return out
  }

  /**
   * Project-level merge serialization. Only one chat may merge into the
   * default branch at a time so two parallel "Mark done" actions can't race
   * the shared `.git`. One gateway owns a project, so a gateway-level mutex is
   * project-wide.
   */
  private mergeChain: Promise<unknown> = Promise.resolve()

  async withMergeLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.mergeChain.then(fn, fn)
    // Keep the chain alive regardless of this op's success/failure.
    this.mergeChain = run.then(() => undefined, () => undefined)
    return run
  }

  /** Whether the session's worktree has a merge in progress (mid-conflict). */
  async isWorktreeMergePending(sessionId: string): Promise<boolean> {
    const mgr = this.getWorktreeManager()
    if (!mgr) return false
    try {
      return await mgr.isMergeInProgress(sessionId)
    } catch {
      return false
    }
  }

  /**
   * Attempt the clean merge-on-done path for a session's worktree into the
   * default branch. Returns the merge result; on conflict the caller drives an
   * agent turn to resolve and then calls {@link completeWorktreeMerge}.
   */
  async mergeSessionWorktree(sessionId: string): Promise<WorktreeMergeResult> {
    const mgr = this.getWorktreeManager()
    if (!mgr) return { outcome: 'noop', conflictedFiles: [], message: 'worktrees disabled' }
    return this.withMergeLock(async () => {
      const result = await mgr.mergeBranchIntoMain(sessionId)
      if (result.outcome === 'clean') {
        await this.persistDurableRepoIfHooked()
      }
      return result
    })
  }

  /** Finish a conflicted merge after the agent resolved files in the worktree. */
  async completeWorktreeMerge(sessionId: string): Promise<WorktreeMergeResult> {
    const mgr = this.getWorktreeManager()
    if (!mgr) return { outcome: 'noop', conflictedFiles: [], message: 'worktrees disabled' }
    return this.withMergeLock(async () => {
      const result = await mgr.completeConflictedMerge(sessionId)
      if (result.outcome === 'clean') {
        await this.persistDurableRepoIfHooked()
      }
      return result
    })
  }

  /** Tear down a session's worktree (after a successful merge). */
  async removeSessionWorktree(sessionId: string, opts?: { deleteBranch?: boolean }): Promise<void> {
    const mgr = this.getWorktreeManager()
    if (!mgr) return
    try {
      await mgr.removeWorktree(sessionId, opts)
      this.sessionWorktreePaths.delete(sessionId)
      await this.persistDurableRepoIfHooked()
    } catch (err: any) {
      console.warn(`${this.logPrefix} removeSessionWorktree threw:`, err?.message ?? err)
    }
  }

  private loadConfigSkills(): Array<{ name: string; trigger?: string; description?: string }> {
    const configPath = resolveWorkspaceConfigFilePath(this.workspaceDir, 'config.json')
    if (!configPath) return []
    try {
      const raw = JSON.parse(readFileSync(configPath, 'utf-8'))
      return Array.isArray(raw.skills) ? raw.skills : []
    } catch {
      return []
    }
  }

  getHookEmitter(): HookEmitter {
    return this.hookEmitter
  }

  private hooksSignature: string | null = null

  /** (Re)load hooks when `hooks/` changed since the last load, e.g. the agent just wrote one. */
  async refreshHooks(force = false): Promise<void> {
    const signature = workspaceHooksSignature(this.workspaceDir)
    if (!force && signature === this.hooksSignature) return
    try {
      const hooks = await loadAllHooks(this.workspaceDir)
      this.hookEmitter.register(hooks)
      this.hooksSignature = signature
      console.log(`[AgentGateway] Loaded ${hooks.length} hooks`)
    } catch (error: any) {
      console.error('[AgentGateway] Failed to load hooks:', error.message)
    }
  }

  getSessionManager(): SessionManager {
    return this.sessionManager
  }

  /**
   * Manually summarize a session's context — the context-usage dock's button
   * (SHO-96).
   *
   * - live turn: queue it; the next `transformContext` call (i.e. the next
   *   tool step) consumes the flag and emits the transcript row.
   * - idle session: summarize now and report the real before/after.
   * - nothing foldable: say so instead of faking a success.
   */
  async compactSession(sessionId: string): Promise<{
    status: 'compacted' | 'queued' | 'nothing-to-compact' | 'unknown-session'
    reason?: string
    tokensBefore?: number
    tokensAfter?: number
    messagesBefore?: number
    messagesAfter?: number
    summaryChars?: number
  }> {
    const detail = this.sessionManager.getDetail(sessionId)
    if (!detail) return { status: 'unknown-session', reason: 'session not found' }

    if (this.turnAbortControllers.has(sessionId)) {
      this.manualCompactionRequests.add(sessionId)
      return { status: 'queued', reason: 'will summarize at the next step' }
    }

    const tokensBefore = detail.estimatedTokens
    const result = await this.sessionManager.compact(sessionId)
    if (!result) {
      return {
        status: 'nothing-to-compact',
        reason: 'nothing to compact',
        tokensBefore,
        tokensAfter: tokensBefore,
      }
    }
    // The prefix was rewritten — drop stable-compaction decisions, exactly as
    // every other compaction path does.
    this.contentReplacementStates.delete(sessionId)
    // Keep the durable copy: the API stores the summary on the ChatSession so
    // losing sessions.db cannot lose it (SHO-137 round 3, R4). Best-effort.
    if (result.summary) {
      const { postContextSummary } = await import('./internal-api')
      void postContextSummary(sessionId, result.summary).catch(() => {})
    }
    const after = this.sessionManager.getDetail(sessionId)
    return {
      status: 'compacted',
      tokensBefore,
      tokensAfter: after?.estimatedTokens ?? tokensBefore,
      messagesBefore: result.messagesBefore,
      messagesAfter: result.messagesAfter,
      summaryChars: result.summary.length,
    }
  }

  getMCPClientManager(): MCPClientManager {
    return this.mcpClientManager
  }

  /**
   * Reconnect the index engine and workspace graph database handles.
   * Call after the .shogo/ directory has been deleted and recreated
   * (e.g. between eval runs).
   */
  reconnectIndex(): void {
    if (this.indexEngine) {
      this.indexEngine.reconnect()
      if (this.workspaceGraph) {
        this.workspaceGraph.reconnect()
      }
    }
  }

  getActiveMode(): VisualMode {
    return this.config.activeMode || 'canvas'
  }

  setActiveMode(mode: VisualMode): void {
    this.config.activeMode = mode
  }

  getAllowedModes(): VisualMode[] {
    return this.config.allowedModes || ['canvas', 'none']
  }

  /** Map of sessionId -> AbortController for cancelling in-progress agent turns */
  private turnAbortControllers = new Map<string, AbortController>()

  /** Per-session turn lock: ensures sequential turn execution so a "continue"
   *  after stop always sees the interrupted turn's messages in the session.
   *  On abort, the lock is released eagerly (see `abortCurrentTurn`) so the
   *  next user message doesn't have to wait for the aborted turn's loop /
   *  in-flight tool calls to finish unwinding. The aborted turn's late
   *  message additions land in the SessionManager whenever they finish and
   *  become visible to subsequent turns; we accept a small chance the next
   *  turn's prompt is built before the abortee's last few messages settle.
   */
  private turnLocks = new Map<string, Promise<unknown>>()

  /** Per-session waker for the active turn's retry backoff ("Retry now"). */
  private retryWakers = new Map<string, RetryWaker>()

  /**
   * Per-session tokens of every link `share_file` minted, so a token the model
   * mistypes when quoting it (now or in a later turn) can be repaired.
   */
  private shareLinkTokens = new Map<string, Set<string>>()

  private shareLinkTokensFor(sessionId: string): Set<string> {
    let tokens = this.shareLinkTokens.get(sessionId)
    if (!tokens) {
      tokens = new Set()
      this.shareLinkTokens.set(sessionId, tokens)
    }
    return tokens
  }

  /**
   * Cut the active turn's retry backoff short so the dropped model call is
   * re-issued now. Returns false when no turn is running for the session.
   */
  wakeRetry(sessionId: string): boolean {
    const waker = this.retryWakers.get(sessionId)
    waker?.wake()
    recordRetryNow({ sessionId, model: this.config.model.name }, !!waker)
    return !!waker
  }

  /**
   * Work that means this runtime is not idle: agent turns running now (chat,
   * schedule, heartbeat, channel), every task still running in a session's
   * registry (not just the ones that will notify), and their live child
   * processes. Hosts read this before evicting the runtime, so it must count
   * work that does NOT wake the agent — a long foreground `exec` whose turn
   * already returned, a `wait`-tracked task, a child process still running
   * after a gateway restart — or the host kills that work (SHO-143).
   */
  getActiveWork(): { turns: number; tasks: number; children: number } {
    let tasks = 0
    let children = 0
    for (const reg of this.commandRegistries.values()) {
      const counts = reg.activeWorkCounts()
      tasks += counts.tasks
      children += counts.children
    }
    return { turns: this.turnLocks.size, tasks, children }
  }

  abortCurrentTurn(sessionId: string): boolean {
    // Release the lock so a new user message on this session can start
    // immediately instead of queueing behind the aborted turn's
    // post-abort cleanup (which can take minutes when in-flight tool
    // calls or the iterative loop's wind-down don't honor the signal
    // synchronously).
    this.turnLocks.delete(sessionId)
    const controller = this.turnAbortControllers.get(sessionId)
    if (controller) {
      controller.abort()
      this.turnAbortControllers.delete(sessionId)
      return true
    }
    return false
  }
}
