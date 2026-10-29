// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Gateway Tools
 *
 * Tool definitions available to the live gateway agent during agent turns.
 * Uses Pi Agent Core's AgentTool format with TypeBox parameter schemas.
 *
 * Tools are created via createGatewayTools(ctx) which closes over the
 * ToolContext, since Pi's execute() signature doesn't accept external context.
 */

import { getModelTier, resolveModelId, calculateDollarCost } from '@shogo/model-catalog'
import { existsSync, readFileSync, writeFileSync, readdirSync, mkdirSync, unlinkSync, statSync, copyFileSync } from 'fs'
import { join, resolve, extname, dirname, relative, sep } from 'path'
import { execSync } from '@shogo/shared-runtime/child-process'
import { fileURLToPath } from 'node:url'
import { isProtectedFile, PROTECTED_FILE_REJECTION } from './protected-files'
import type { SessionTodo, SessionTodosSnapshot } from './plan-continuation'
import { createProjectTools, resolveProjectRef } from './project-tools'
import {
  REMOTE_READONLY_TOOLS,
  REMOTE_TOOL_ALLOWLIST,
  RemoteToolError,
  callRemoteTool,
  currentRuntimeProjectId,
  isMetalRuntime,
  isRemotableTool,
  remoteProjectsGuidance,
} from './remote-tools'
import { TransferError, callRemoteImport, packPaths } from './project-transfer'
import { availableModelsHint, isAvailableModel } from './available-models'
import { createWorkspaceAgentTools } from './workspace-agent-tools'
import { createTriggerTools } from './trigger-tools'
import { createMeetingTools } from './meeting-tools'
import { createGenerateImageTool, createMediaTools } from './media-tools'
import { IMAGE_TOOL_NAMES, MUSIC_TOOL_NAMES, THREE_D_TOOL_NAMES } from './media-tool-names'
import { createAgentRunTools, createChannelTools } from './channel-tools'
import { createBoardTools } from './board-tools'
import { BOARD_ADMIN_TOOL_NAMES, BOARD_TOOL_NAMES, CHANNEL_TOOL_NAMES, PROBLEM_TOOL_NAMES } from './work-tool-names'
import { resolveRuntimeCapabilities } from './capability-status-prompt'
import {
  copyToProjectAvailable,
  isWorkspaceAgentRuntime,
  isWorkspaceRuntimeMode,
  otherProjectForPath,
  otherProjectPathMessage,
  resolveRuntimeIdentity,
  workspaceAttachedProjectIds,
} from './workspace-runtime-mode'
import { isSearchEnabled } from './search-flag'
import { isInQuietHours } from './quiet-hours'
import { PROFILE_TOOL_GROUPS, disabledToolNamesForProfile } from './capability-profiles'
import { survivorHint } from './process-tree'
import { Type, type Static } from '@sinclair/typebox'
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core'
import { sandboxExec, sandboxExecAsync, shouldSandbox, type CommandHandle, type ShellExitResult } from './sandbox-exec'
import { resolveProjectCredentialEnv } from './project-process-env'
import { getHomeWatch, homeNotPersistedNote } from './home-state-watch'
import { commandTargetsGateway, gatewayKillRefusal } from './gateway-self-protect'
import { consumeExecCwdMarker, execCwdDirFor, newExecCwdMarker } from './exec-cwd'
import { checkSelfDetach, selfDetachRefusal } from './exec-detach'
import { findPolledTasks, type PollMatch } from './exec-poll'
import { CommandRegistry, type CommandEntry } from './command-registry'
import type { TaskEntry } from './task-registry'
import { tailLines } from './task-output'
import {
  resolveRunDir as resolveScreenshotRunDir,
  nextScreenshotPath as nextScreenshotFilePath,
  sweepLooseScreenshots,
  trimOldRuns as trimOldScreenshotRuns,
} from './screenshot-manager'

// All `[screencast]` diagnostic logs are opt-in: set DEBUG_SCREENCAST=1 to
// enable. The CDP pipeline is stable; these logs are only useful when
// diagnosing connectivity or propagation problems.
function screencastDebugEnabled(): boolean {
  return process.env.DEBUG_SCREENCAST === '1' || process.env.DEBUG_SCREENCAST === 'true'
}
function scLog(...args: unknown[]): void {
  if (screencastDebugEnabled()) console.log(...args)
}
function scWarn(...args: unknown[]): void {
  if (screencastDebugEnabled()) console.warn(...args)
}
import {
  runSubagent,
  getBuiltinSubagentConfig,
  loadCustomAgents,
  type SubagentConfig,
  type SubagentResult,
  type SubagentStreamCallbacks,
  type CustomAgentDef,
} from './subagent'
import { ACCESSIBILITY_SNAPSHOT_SCRIPT } from './browser-snapshot-script'
import { getSharedBrowserPool, registerBrowserSessionCleanup, BrowserPoolTimeoutError, type BrowserLease } from './browser-pool'
import {
  findActualString,
  preserveQuoteStyle,
  stripTrailingWhitespace,
  applyEditToFile,
  readFileWithMetadata,
  writeWithMetadata,
  getStructuredPatch,
  resolveLineEndingPolicy,
  normalizeLineEndings,
  type LineEndingType,
} from './edit-file-utils'
import { MemorySearchEngine } from '@shogo-ai/sdk/memory'
import { IndexEngine, createDefaultConfig } from './index-engine'
import { HistoryIndex, type HistoryKind } from './history-index'
import { MCP_CATALOG, isPreinstalledMcpId, isMcpServerAllowed, getPreinstalledPackages, builtinCapabilityRefusal } from './mcp-catalog'
import {
  initComposioSession,
  isComposioEnabled,
  isComposioInitialized,
  searchComposioToolkits,
  findComposioToolkit,
  registerToolkitProxyTools,
  checkComposioAuth,
} from './composio'
import { loadAllSkills, loadBundledSkills, searchSkills } from './skills'
import { addQuickAction, validateQuickActions } from './quick-actions'
import { withActionRules, withPermissionGate, assertWithinWorkspace as assertWithinWorkspaceSecure, scratchPathForWrite, type PermissionEngine } from './permission-engine'
import { assertAllowedPath as assertAllowedPathRaw, getRuntimeTrust } from './runtime-trust'
import { isBinaryFilePath } from '@shogo/shared-runtime'
import { isShogoAgentEmail, withShogoPrFooter } from '@shogo/shared-runtime/agent-attribution'
import { missingCodePlanSections } from './plan-sections'

/**
 * Tool-layer wrapper for `assertAllowedPath` that returns a uniform
 * `{ ok, message }` shape suitable for short-circuiting an
 * `execute()`. Lives here (not in runtime-trust.ts) because the trust
 * layer doesn't know what an `AgentToolResult` looks like — we keep
 * the dependency direction "tools → trust", not the reverse.
 */
function assertAllowedPath(
  targetPath: string,
  mode: 'read' | 'write' | 'exec',
  workspaceDir?: string,
  opts?: { unrestricted?: boolean },
) {
  const result = assertAllowedPathRaw(targetPath, mode)
  if (result.ok || !workspaceDir || result.reason !== 'outside_allowed_roots') return result

  try {
    const resolved = assertWithinWorkspace(workspaceDir, targetPath, opts)
    return { ok: true, resolved }
  } catch {
    return result
  }
}

function loadWorkspaceEnvForAttribution(workspaceDir: string): Record<string, string> {
  const envPath = join(workspaceDir, '.env')
  if (!existsSync(envPath)) return {}
  try {
    const vars: Record<string, string> = {}
    for (const line of readFileSync(envPath, 'utf8').split('\n')) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const equals = trimmed.indexOf('=')
      if (equals < 0) continue
      const key = trimmed.slice(0, equals).trim()
      let value = trimmed.slice(equals + 1).trim()
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1)
      }
      // A project's `.env` is agent-writable, so it must never pick the
      // co-author: the identity is the canonical agent one, or nothing.
      if (key === 'SHOGO_AGENT_GIT_NAME') continue
      if (key === 'SHOGO_AGENT_GIT_EMAIL' && !isShogoAgentEmail(value)) continue
      if (key) vars[key] = value
    }
    return vars
  } catch {
    return {}
  }
}
import {
  deriveApiUrl,
  derivePublicApiUrl,
  getInternalHeaders,
  NO_API_URL_ERROR,
  listCheckpoints as apiListCheckpoints,
  getCheckpointDiff as apiGetCheckpointDiff,
  rollbackCheckpoint as apiRollbackCheckpoint,
  getPublishState as apiGetPublishState,
  publishProject as apiPublishProject,
  createSharedFileLink as apiCreateSharedFileLink,
  createWorkspaceSharedFileLink as apiCreateWorkspaceSharedFileLink,
  createGitHubPullRequest as apiCreateGitHubPullRequest,
  mergeGitHubPullRequest as apiMergeGitHubPullRequest,
  connectGitHubWithToken as apiConnectGitHubWithToken,
  getGitHubAuthorizeUrl as apiGetGitHubAuthorizeUrl,
  switchGitHubBranch as apiSwitchGitHubBranch,
  projectScopedId,
  postPlanMirror,
  configureProject as apiConfigureProject,
  getProjectConfig as apiGetProjectConfig,
  type CheckpointCallResult,
} from './internal-api'
import { clearGitHubCliEnvCache, githubCliEnvForProject } from './github-cli-credentials'
import { resolveShareFileLinkTarget } from './share-file-path'
import { approvalOutcomeResult, waitForCredentialApproval, withCredentialApproval } from './integration-credentials'
import { checkServerTsxDrift, healServerTsxDrift } from './server-tsx-drift'
import { getCanvasRuntimeErrors, clearCanvasRuntimeErrors } from './canvas-runtime-errors'
import { isMemoryFilePath, memoryShrinkGuard, snapshotMemoryFile } from './memory-history'
import { scanAndFixFile as scanFileForHardcodedPorts, type PortFix, type PortWarning } from './lint-hardcoded-ports'
import { FileStateCache } from './file-state-cache'
import { enforceImageSizeLimit, MAX_IMAGE_BASE64_BYTES } from './image-size-guard'
import { injectCommitTrailer } from './git-attribution'
import type { TeamManager } from './team-manager'
import type { TeammateLoopHandle } from './teammate-loop'
import { createChatHandoffTool } from './chat-handoff-tool'

export interface ToolContext {
  workspaceDir: string
  channels: Map<string, import('./types').ChannelAdapter>
  config: import('./gateway').GatewayConfig
  /**
   * Which surface `config` was resolved for. A workspace chat gets
   * `'workspace'` (toggles on `Workspace.settings`), a project chat
   * `'project'` (`Project.settings`). `capabilities_configure` defaults to
   * this scope; anything else that reads capability state must too.
   */
  capabilityScope?: 'workspace' | 'project'
  /**
   * Both surfaces' configs, so a tool can act on either scope correctly (a
   * workspace chat asking for `scope: "project"` must read the project's
   * toggles, not the workspace's). `config` is the turn's surface.
   */
  capabilityConfigs?: {
    workspace: import('./gateway').GatewayConfig
    project: import('./gateway').GatewayConfig
  }
  projectId: string
  /** Workspace scope for the live mount/list tools. */
  workspaceId?: string
  sessionId?: string
  sandbox?: Partial<import('./types').SandboxConfig>
  mainSessionIds?: string[]
  mcpClientManager?: import('./mcp-client').MCPClientManager
  /** Hot-connect a channel at runtime (called by channel_connect tool) */
  connectChannel?: (type: string, config: Record<string, string>) => Promise<void>
  disconnectChannel?: (type: string) => Promise<void>
  /** Unified index engine for search over workspace code and user files */
  indexEngine?: IndexEngine
  /** Workspace knowledge graph for structural analysis and blast radius */
  workspaceGraph?: import('./workspace-graph').WorkspaceGraph
  /** Authenticated user ID from the chat request (for per-user integrations like Composio) */
  userId?: string
  /** API-signed proof of who started this turn; forwarded when a tool acts as the requester. */
  requesterTicket?: string
  /** File watcher — notified when src/ files are written/edited/deleted to trigger rebuilds */
  canvasFileWatcher?: import('./canvas-file-watcher').CanvasFileWatcher
  /** Permission engine for local-mode security guardrails */
  permissionEngine?: PermissionEngine
  /** AI Proxy URL for image generation and other proxy-routed calls */
  aiProxyUrl?: string
  /** AI Proxy token for authenticating proxy calls */
  aiProxyToken?: string
  /** UI message writer for streaming events to the client (set during agent turns, not heartbeats) */
  uiWriter?: any
  /** Called after heartbeat_configure writes the schedule to the database (refreshes the cached status copy). */
  onHeartbeatConfigured?: () => void
  /** Called after capabilities_configure writes this project's toggles. Reloads config so the next turn sees them. */
  onCapabilitiesChanged?: () => void | Promise<void>
  /** Multi-language LSP manager for read_lints diagnostics */
  lspManager?: import('@shogo/shared-runtime').WorkspaceLSPManager
  /** Live LSP accessor — the manager starts asynchronously after a deferred
   *  warmup, so `lspManager` may be a stale undefined snapshot taken before
   *  startup. read_lints prefers this getter to resolve the current manager. */
  getLspManager?: () => import('@shogo/shared-runtime').WorkspaceLSPManager | null
  /** Tracks which files the agent has read, their mtimes, and line counts */
  fileStateCache?: FileStateCache
  /** Dynamic sub-agent registry and lifecycle manager */
  agentManager?: import('./agent-manager').AgentManager
  /** Skill server manager — exposed so tools can sync/query the skill server */
  skillServerManager?: import('./skill-server-manager').SkillServerManager
  /** Parent's fully rendered system prompt (for fork mode context sharing) */
  renderedSystemPrompt?: string
  /** Parent's current conversation history (for fork mode context sharing) */
  sessionMessages?: import('@mariozechner/pi-ai').Message[]
  /** Session persistence layer (for subagent transcript storage) */
  sessionPersistence?: import('./sqlite-session-persistence').SqliteSessionPersistence
  /** Team coordination manager (for teammate swarm features) */
  teamManager?: TeamManager
  /** Current team context (set when agent is part of a team) */
  teamContext?: { teamId: string; agentId: string; isLeader: boolean }
  /** Active teammate loop handles (for lifecycle management) */
  teammateHandles?: Map<string, TeammateLoopHandle>
  /** Effective model ID for this turn (accounts for session modelOverride + alias resolution) */
  effectiveModel?: string
  /** Provider the turn resolved for `effectiveModel`. DB-defined models are
   *  opaque UUIDs that infer as `custom`, so sub-agents inheriting the model
   *  must reuse this instead of re-inferring it. */
  effectiveProvider?: string
  /** When true, Auto mode is active — sub-agents should use the spawn-time model router */
  autoRouting?: boolean
  /** Admin-configured Auto-mode tier overrides (resolved model id + provider
   *  hint per tier), threaded to sub-agent spawn routing so it matches the
   *  main agent's Auto model selection. */
  autoTierOverride?: import('./model-router').AutoTierOverride
  /** When true, create_plan/update_plan additionally generate a stakeholder
   *  translation of the technical plan using the fast-tier model and emit it via
   *  the `data-plan-summary` stream event. Persistent per-user preference. */
  dualPlan?: boolean
  /** Persistent shell cwd state — survives across exec calls within a session */
  shellState?: {
    getCwd: () => string
    setCwd: (cwd: string) => void
    initialCwd?: string
  }
  /** Background tasks of this session (shell, subagents, remote tasks) — backs `wait` / `task_list` / `task_cancel`. */
  commandRegistry?: import('./task-registry').TaskRegistry
  /**
   * Steering state for the current turn (sleep polls already made, repeated
   * `wait` timeouts). Built per turn by the gateway, so a new turn steers
   * afresh; see `turnSteeringState`.
   */
  turnState?: TurnSteeringState
  /** On-demand guide registry populated by buildGuideRegistry() */
  guideRegistry?: Map<string, string>
  /**
   * This turn's tool-advertising profile (SHO-97). Filled by the gateway once
   * the tool set is assembled, so `read_guide({ tool })` can describe a
   * deferred tool and advertise it. Shared by reference with the tools created
   * earlier in the turn, so it may legitimately be empty when they run.
   */
  toolProfileRef?: { current?: import('./tool-profile').ToolProfile }
  /** Eval mock functions — propagated to subagents so mocked tools work in delegated calls */
  toolMockFns?: Map<string, (params: Record<string, any>) => any>
  /** When this tool runs inside a spawned subagent, the AgentManager instance id.
   *  Used e.g. to key the CDP screencast broadcaster so the mobile LiveBrowserView
   *  can subscribe to the right running subagent's browser viewport. */
  /**
   * Execute a command in the user's visible terminal (desktop only).
   * When provided, the terminal_exec tool routes commands through
   * the user's terminal instead of the sandboxed exec.
   */
  terminalExec?: (params: { command: string; cwd?: string; timeoutMs?: number; mode?: 'foreground' | 'background' }) => Promise<{
    exitCode: number | null
    output: string
    cwd: string | null
    durationMs: number | null
    timedOut: boolean
  }>
  /** Read recent output from the user's desktop IDE terminal. */
  terminalRead?: (params: { terminalId?: string; cwd?: string; maxChars?: number }) => Promise<{
    source: string
    terminalId: string | null
    cwd: string | null
    content: string
    sessions: Array<{
      id: string
      cwd: string | null
      shell: string | null
      createdAt: number | null
      updatedAt: number | null
      exitedAt: number | null
      bytes: number
      active: boolean
    }>
    truncated: boolean
    error?: string
    hint?: string
  }>
  /** Interrupt the currently running terminal command (sends SIGINT). */
  terminalInterrupt?: () => Promise<{ interrupted: boolean }>

  subagentInstanceId?: string
  /** BETA: per-chat git worktrees — status of all sibling chats' branches.
   *  Bound to the gateway so the worktree_list tool can surface cross-chat
   *  awareness without a direct gateway reference. */
  listWorktreeStatuses?: () => Promise<import('@shogo/shared-runtime').WorktreeStatus[]>
  /**
   * True once `PreviewManager.depsReady` (the `npm install`/dep-seed gate)
   * has resolved at least once — i.e. the workspace's `node_modules` is no
   * longer mid-install. `undefined` when there's no PreviewManager wired
   * (rare — some tool-context construction paths, e.g. certain eval/test
   * harnesses, never attach one).
   *
   * read_lints uses this to tell "`Cannot find module 'react'` because the
   * workspace hasn't finished installing yet" (environment noise — not a
   * model mistake) apart from "`Cannot find module 'totally-made-up-pkg'`
   * after deps are ready" (a genuine model diagnostic). See
   * `HOSHI_CODING_FINDINGS.md`'s "environment noise" tool-failure category.
   */
  depsReady?: boolean
}

/**
 * Desktop full_autonomy blocks nothing, including paths (SHO-209). The cloud pod
 * has no `SHOGO_LOCAL_MODE`, so its workspace boundary stays.
 */
function pathPolicy(ctx: ToolContext): { unrestricted: boolean } {
  return {
    unrestricted: process.env.SHOGO_LOCAL_MODE === 'true' && ctx.permissionEngine?.mode === 'full_autonomy',
  }
}

function assertWithinWorkspace(
  workspaceDir: string,
  filePath: string,
  opts?: { unrestricted?: boolean },
): string {
  return assertWithinWorkspaceSecure(workspaceDir, filePath, opts)
}

/**
 * Bogus path prefixes the model frequently hallucinates when it remembers
 * the project as "the project" or "the workspace" instead of the workspace
 * root being the CWD. Stripping these and pointing at the right path turns
 * a wasted tool call into a one-shot fix.
 */
const BOGUS_PATH_PREFIXES = ['project/', 'workspace/', 'app/', 'pod/', 'repo/'] as const

/**
 * If `filePath` starts with a known-bogus prefix and the corresponding
 * stripped path actually exists on disk, return a hint string the caller
 * can append to `File not found` errors. Otherwise return null.
 *
 * Example: `read_file({ path: 'project/src/App.tsx' })` against a workspace
 * that has `src/App.tsx` returns a hint pointing at `src/App.tsx`.
 */
function bogusPathPrefixHint(workspaceDir: string, filePath: string): string | null {
  for (const prefix of BOGUS_PATH_PREFIXES) {
    if (!filePath.startsWith(prefix)) continue
    const stripped = filePath.slice(prefix.length)
    if (!stripped) continue
    let strippedResolved: string
    try {
      strippedResolved = assertWithinWorkspace(workspaceDir, stripped)
    } catch {
      continue
    }
    if (existsSync(strippedResolved)) {
      return (
        `Hint: workspace root is your CWD. The path you gave starts with "${prefix}" ` +
        `but "${stripped}" exists. Drop the "${prefix}" prefix — try "${stripped}".`
      )
    }
  }
  return projectFolderHint(workspaceDir, filePath)
}

function withinOneEdit(a: string, b: string): boolean {
  if (a === b) return false
  const delta = a.length - b.length
  if (Math.abs(delta) > 1) return false
  if (delta === 0) {
    let mismatches = 0
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i] && ++mismatches > 1) return false
    }
    return mismatches === 1
  }
  const [shorter, longer] = a.length < b.length ? [a, b] : [b, a]
  let i = 0
  let j = 0
  let skipped = false
  while (i < shorter.length && j < longer.length) {
    if (shorter[i] === longer[j]) {
      i++
      j++
    } else if (skipped) {
      return false
    } else {
      skipped = true
      j++
    }
  }
  return true
}

function workspaceChildDirs(workspaceDir: string): string[] {
  try {
    return readdirSync(workspaceDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => entry.name)
  } catch {
    return []
  }
}

function pathExistsInWorkspace(workspaceDir: string, relativePath: string): boolean {
  try {
    return existsSync(assertWithinWorkspace(workspaceDir, relativePath))
  } catch {
    return false
  }
}

/**
 * A workspace mounts each project as `<projectId>/…`. When that prefix is
 * mistyped by one character, or omitted and only one project is mounted,
 * point at the path that actually exists.
 */
function projectFolderHint(workspaceDir: string, filePath: string): string | null {
  const normalized = filePath.replace(/\\/g, '/').replace(/^\.\//, '')
  const parts = normalized.split('/').filter(Boolean)
  if (parts.length === 0) return null
  const dirs = workspaceChildDirs(workspaceDir)
  if (dirs.length === 0) return null
  const prefix = parts[0]!
  const rest = parts.slice(1).join('/')
  if (!dirs.includes(prefix)) {
    const close = dirs.filter((name) => withinOneEdit(name, prefix))
    if (close.length === 1) {
      const candidate = rest ? `${close[0]}/${rest}` : close[0]!
      if (pathExistsInWorkspace(workspaceDir, candidate)) {
        return `Hint: did you mean "${candidate}"?`
      }
    }
  }
  if (dirs.length === 1 && !normalized.startsWith(`${dirs[0]}/`)) {
    const candidate = `${dirs[0]}/${normalized}`
    if (pathExistsInWorkspace(workspaceDir, candidate)) {
      return `Hint: that path exists under the only mounted project. Try "${candidate}".`
    }
  }
  return null
}

/**
 * Block mutations to Shogo-managed files when the project is in canvas-code
 * mode. In every other mode (chat, app, json-canvas, etc.) the gate is a
 * no-op — agents can edit any file freely. See protected-files.ts for the
 * full rationale and the canonical list of locked paths.
 *
 * Returns a rejection AgentToolResult to bail out of the calling tool, or
 * null if the write is allowed to proceed.
 */
function rejectIfProtected(ctx: ToolContext, resolved: string): AgentToolResult<any> | null {
  if (!isProtectedFile(ctx.workspaceDir, resolved)) return null
  return textResult({ error: PROTECTED_FILE_REJECTION })
}

const LINTABLE_EXTENSION_RE = /\.(ts|tsx|js|jsx|py)$/

/**
 * Mark a file as edited in the current turn if it has a lintable extension.
 * Used by write_file/edit_file so read_lints can auto-scope diagnostics.
 */
function markEditedIfLintable(ctx: ToolContext, filePath: string): void {
  if (!ctx.fileStateCache) return
  if (!LINTABLE_EXTENSION_RE.test(filePath)) return
  ctx.fileStateCache.markEditedThisTurn(filePath)
}

function applyPermissionGate(tool: AgentTool, category: import('./types').PermissionCategory, engine?: PermissionEngine): AgentTool {
  return engine ? withPermissionGate(tool, category, engine) : tool
}

export function textResult(data: any): AgentToolResult<any> {
  return {
    content: [
      {
        type: 'text',
        text: typeof data === 'string' ? data : JSON.stringify(data, null, 2),
      },
    ],
    details: data,
  }
}

/**
 * Resolve the current workspace id: prefer the runtime's `RuntimeIdentity`
 * (env-derived — `WORKSPACE_ID`, set by `buildWorkspaceEnv` server-side),
 * falling back to `ctx.workspaceId` for callers that construct
 * `ToolContext` directly (tests, and some internal call paths that don't
 * go through a full runtime boot). This was previously re-derived inline
 * as `process.env.WORKSPACE_ID || ctx.workspaceId` at every call site;
 * consolidated here — and in `resolveRuntimeIdentity()`
 * (`workspace-runtime-mode.ts`), the single source for "which runtime is
 * this" — so there is one place to change the precedence.
 */
function resolveWorkspaceId(ctx: ToolContext): string | undefined {
  return resolveRuntimeIdentity().workspaceId || ctx.workspaceId
}

/**
 * Whether the workspace profile/goal/schedule tools (`schedule_create`, …)
 * are registered. Prompts that mention them must use the same check.
 */
export function workspaceAgentToolsRegistered(ctx: Pick<ToolContext, 'workspaceId'>): boolean {
  return Boolean(resolveWorkspaceId(ctx as ToolContext))
}

function workspaceMetaToolEnabled(ctx: ToolContext): boolean {
  return resolveRuntimeIdentity().mode === 'workspace' && Boolean(resolveWorkspaceId(ctx))
}

/**
 * Mount/unmount may have to wait for a cold-booting workspace runtime: the API
 * keeps retrying for up to 150s, so the caller must outlast it.
 */
const WORKSPACE_MEMBER_TIMEOUT_MS = 180_000

/**
 * The internal preview route waits on the target's build (its own budget is
 * 75s), so the tool has to outlast that plus the round-trip.
 */
const PREVIEW_START_REQUEST_TIMEOUT_MS = 100_000

async function workspaceMetaFetch(
  ctx: ToolContext,
  path: string,
  init: RequestInit = {},
  timeoutMs = 30_000,
): Promise<any> {
  const apiUrl = deriveApiUrl()
  const workspaceId = resolveWorkspaceId(ctx)
  if (!apiUrl || !workspaceId) throw new Error('Workspace runtime API is not configured')
  const headers = new Headers(getInternalHeaders())
  headers.set('Content-Type', 'application/json')
  const body = init.body && typeof init.body === 'string' ? JSON.parse(init.body) : undefined
  if (body) {
    body.userId ??= ctx.userId
    body.sessionId ??= ctx.sessionId
  }
  const response = await fetch(`${apiUrl}${path}`, {
    ...init,
    headers,
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const text = await response.text().catch(() => '')
  let result: any = {}
  try {
    result = text ? JSON.parse(text) : {}
  } catch {
    // Non-JSON body: a proxy between us and the API answered.
  }
  if (!response.ok) {
    const detail = result?.error?.message || result?.error
    const snippet = text.trim().slice(0, 200)
    // Carry the status and the API's error code so the caller can say what is
    // actually wrong (project_not_attached vs target_not_ready vs auth) instead
    // of parsing a message (SHO-125).
    const failure = new Error(
      typeof detail === 'string' && detail.trim() && !detail.trim().startsWith('<')
        ? detail
        : // Cloudflare and other proxies answer 502 with an HTML page. Don't
          // hand that document to the agent; the status is the useful part.
          !snippet || snippet.startsWith('<')
          ? `Workspace API HTTP ${response.status}`
          : `Workspace API HTTP ${response.status}: ${snippet}`,
    ) as Error & { status?: number; code?: string }
    failure.status = response.status
    if (typeof result?.error?.code === 'string') failure.code = result.error.code
    throw failure
  }
  return result
}

/** Fast gateway failures and the caller's own timeout. Not 4xx. */
function isRetryableWorkspaceFailure(err: unknown): boolean {
  const name = err instanceof Error ? err.name : ''
  if (name === 'TimeoutError' || name === 'AbortError') return true
  const message = err instanceof Error ? err.message : String(err)
  return /Workspace API HTTP 50[234]\b/.test(message) || /timed out|operation timed out/i.test(message)
}

const MOUNT_RETRY_BACKOFF_MS = [200, 500]

async function mountWorkspaceProject(
  ctx: ToolContext,
  projectId: string,
  mode: 'readwrite' | 'readonly' = 'readwrite',
): Promise<any> {
  const workspaceId = resolveWorkspaceId(ctx)
  const path = `/api/internal/workspaces/${encodeURIComponent(workspaceId!)}/sessions/${encodeURIComponent(ctx.sessionId || '')}/members`
  const init: RequestInit = {
    method: 'POST',
    body: JSON.stringify({
      projectId,
      attachMode: mode === 'readonly' ? 'readonly' : 'readwrite',
      userId: ctx.userId,
      sessionId: ctx.sessionId,
    }),
  }
  let lastError: unknown
  for (let attempt = 0; attempt <= MOUNT_RETRY_BACKOFF_MS.length; attempt++) {
    try {
      return await workspaceMetaFetch(ctx, path, init, WORKSPACE_MEMBER_TIMEOUT_MS)
    } catch (err) {
      lastError = err
      const delay = MOUNT_RETRY_BACKOFF_MS[attempt]
      if (delay === undefined || !isRetryableWorkspaceFailure(err)) throw err
      await new Promise((resolve) => setTimeout(resolve, delay))
    }
  }
  throw lastError
}

function createListProjectsTool(ctx: ToolContext): AgentTool {
  const metal = isMetalRuntime()
  return {
    name: 'list_projects',
    label: 'List Projects',
    description: metal
      ? 'List the projects you can access in this Shogo workspace. Other projects are not mounted here; ' +
        'reach one with `connect_project` and the `project` parameter of the file and shell tools. ' +
        'Use this when the request names a project ambiguously or asks about project availability.'
      : 'List the projects you can access in this Shogo workspace and show which ones are currently mounted. ' +
        'Use this before mounting when the request names a project ambiguously or asks about project availability.',
    parameters: Type.Object({}),
    execute: async () => {
      if (!workspaceMetaToolEnabled(ctx))
        return textResult({
          error: 'This tool is only available in a workspace runtime.',
        })
      const workspaceId = resolveWorkspaceId(ctx)
      const qs = new URLSearchParams({
        ...(ctx.userId ? { userId: ctx.userId } : {}),
        ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}),
      })
      const result = await workspaceMetaFetch(ctx, `/api/internal/workspaces/${encodeURIComponent(workspaceId!)}/projects?${qs}`)
      if (!metal || !result || typeof result !== 'object' || Array.isArray(result)) return textResult(result)
      return textResult({ ...result, remoteAccess: remoteProjectsGuidance({ copyToProject: copyToProjectAvailable() }) })
    },
  }
}

function createMountProjectTool(ctx: ToolContext): AgentTool {
  const metal = isMetalRuntime()
  return {
    name: 'mount_project',
    label: 'Mount Project',
    description: metal
      ? 'Connect to another Shogo project of this workspace (same as connect_project). Projects are not mounted on this runtime; ' +
        'after connecting, pass `project` to the file and shell tools to work inside it.'
      : 'Mount one available Shogo project into the workspace runtime. Mount read-only when you only need to inspect it; use readwrite when the user asks for edits or commands.',
    parameters: Type.Object({
      projectId: Type.String({
        description: 'The exact project id returned by list_projects.',
      }),
      mode: Type.Optional(Type.Union([Type.Literal('readwrite'), Type.Literal('readonly')])),
    }),
    execute: async (_toolCallId, params: any) => {
      if (metal) return connectRemoteProject(ctx, String(params?.projectId ?? ''))
      if (!workspaceMetaToolEnabled(ctx))
        return textResult({
          error: 'This tool is only available in a workspace runtime.',
        })
      return textResult(
        await mountWorkspaceProject(ctx, params.projectId, params.mode === 'readonly' ? 'readonly' : 'readwrite'),
      )
    },
  }
}

function createUnmountProjectTool(ctx: ToolContext): AgentTool {
  const metal = isMetalRuntime()
  return {
    name: 'unmount_project',
    label: 'Unmount Project',
    description: metal
      ? 'No-op on this runtime: other projects are reached remotely with the `project` parameter, never mounted, so there is nothing to unmount.'
      : 'Unmount a project from the workspace runtime after work is complete or when switching away. Never unmount a project that is needed for the current follow-up.',
    parameters: Type.Object({
      projectId: Type.String({ description: 'The exact mounted project id.' }),
    }),
    execute: async (_toolCallId, params: any) => {
      if (metal) {
        return textResult({
          ok: true,
          projectId: params?.projectId,
          message: 'Nothing to unmount: other projects are reached remotely with the `project` parameter, not mounted here.',
        })
      }
      if (!workspaceMetaToolEnabled(ctx))
        return textResult({
          error: 'This tool is only available in a workspace runtime.',
        })
      const workspaceId = resolveWorkspaceId(ctx)
      return textResult(
        await workspaceMetaFetch(
          ctx,
          `/api/internal/workspaces/${encodeURIComponent(workspaceId!)}/sessions/${encodeURIComponent(ctx.sessionId || '')}/members/${encodeURIComponent(params.projectId)}`,
          {
            method: 'DELETE',
            body: JSON.stringify({
              userId: ctx.userId,
              sessionId: ctx.sessionId,
            }),
          },
          WORKSPACE_MEMBER_TIMEOUT_MS,
        ),
      )
    },
  }
}

// ---------------------------------------------------------------------------
// Remote tool channel (remote-tools.ts): `project` on the remotable tools
// ---------------------------------------------------------------------------

const REMOTE_PROJECT_PARAM_DESCRIPTION =
  'Run this tool in another project of this workspace (project id or name). Omit for the current project.'

type RemoteTarget = { local: true } | { local: false; id: string; name: string } | { error: string; code: string }

const REMOTE_TARGET_TTL_MS = 60_000
const remoteTargetCache = new Map<string, { target: RemoteTarget; expiresAt: number }>()

/** Test seam: forget resolved project references. */
export function resetRemoteTargetCache(): void {
  remoteTargetCache.clear()
}

/**
 * Where a `project` argument points: the current project (by id, or by name
 * once resolved through the workspace graph, the same lookup project_call
 * uses) runs locally; any other project goes over the remote channel.
 */
async function resolveRemoteTarget(ctx: ToolContext, ref: string): Promise<RemoteTarget> {
  const trimmed = ref.trim()
  const self = currentRuntimeProjectId(ctx.projectId)
  const isSelf = (id: string) => id === self || id === ctx.projectId
  if (!trimmed || isSelf(trimmed)) return { local: true }
  const key = `${resolveWorkspaceId(ctx) ?? ''}:${trimmed}`
  const hit = remoteTargetCache.get(key)
  if (hit && hit.expiresAt > Date.now()) return hit.target
  const resolved = await resolveProjectRef(ctx, trimmed)
  if ('error' in resolved) return resolved
  const target: RemoteTarget = isSelf(resolved.id) ? { local: true } : { local: false, id: resolved.id, name: resolved.name }
  remoteTargetCache.set(key, { target, expiresAt: Date.now() + REMOTE_TARGET_TTL_MS })
  return target
}

/**
 * One actionable message for every tool aimed at a project this runtime cannot
 * reach, instead of the raw `project_not_attached` code the API answers with.
 * Shared by all remoted file/shell tools so `read_file`, `write_file`,
 * `edit_file`, `delete_file`, `exec` and `search` say the same thing.
 */
export function projectNotAttachedMessage(projectId: string): string {
  return (
    `Project ${projectId} isn't attached to this runtime. ` +
    'Attach it with project_attach (readwrite to edit), or call its agent with project_call.'
  )
}

function remoteFailure(err: unknown, project: { id: string; name: string }): AgentToolResult<any> {
  const message = err instanceof Error ? err.message : String(err)
  const code = err instanceof RemoteToolError ? err.code : undefined
  const status = err instanceof RemoteToolError ? err.status : undefined
  const details = err instanceof RemoteToolError ? err.details : undefined
  if (code === 'project_not_attached' || /project_not_attached/.test(message)) {
    return textResult({
      error: projectNotAttachedMessage(project.id),
      code: 'project_not_attached',
      project,
    })
  }
  // A token mismatch between the caller and the target's runtime is a
  // configuration fault: no number of retries fixes it, and the raw 401 body
  // reads like a transient failure — which is exactly why it was retried into
  // a burst (SHO-125). `tokenScope`/`apiVerdict` are identity only, never token
  // material, so they can be shown to the agent.
  if (status === 401 || code === 'auth_mismatch') {
    const scope = typeof details?.tokenScope === 'string' ? details.tokenScope : undefined
    const verdict = typeof details?.apiVerdict === 'string' ? details.apiVerdict : undefined
    return textResult({
      error:
        `${project.name}'s runtime rejected the runtime token this call presented` +
        `${scope ? ` (token scope: ${scope})` : ''}${verdict ? `, API verdict: ${verdict}` : ''}. ` +
        'This is an authentication mismatch, not a transient failure — retrying will not help.',
      code: 'auth_mismatch',
      project,
      ...(scope ? { tokenScope: scope } : {}),
      ...(verdict ? { apiVerdict: verdict } : {}),
      hint: 'Tell the user this failed; do not retry it.',
    })
  }
  // The target resolved but was not accepting connections yet; the API already
  // retried the read-only tools once (SHO-125).
  if (code === 'target_not_ready') {
    const retryAfter =
      typeof (details?.error as Record<string, unknown> | undefined)?.retryAfterSeconds === 'number'
        ? (details!.error as { retryAfterSeconds: number }).retryAfterSeconds
        : undefined
    return textResult({
      error: message,
      code: 'target_not_ready',
      project,
      ...(retryAfter ? { retryAfterSeconds: retryAfter } : {}),
      hint: 'The project runtime was still starting. Retry once after the delay; do not retry a write blindly.',
    })
  }
  return textResult({
    error: message,
    ...(code ? { code } : {}),
    ...(status ? { status } : {}),
    project,
    ...(code === 'tool_not_remotable' || status === 403
      ? { hint: 'The requester may only have read access to that project, or the tool cannot run remotely.' }
      : {}),
  })
}

/**
 * Add the optional `project` parameter to a remotable tool. Without it the
 * tool runs exactly as before; with another project it runs in that
 * project's own runtime and returns that runtime's result.
 */
export function withRemoteProject(tool: AgentTool, ctx: ToolContext): AgentTool {
  if (!isRemotableTool(tool.name)) return tool
  const base = tool.parameters as unknown as { properties?: Record<string, any> }
  return {
    ...tool,
    parameters: Type.Object({
      ...(base.properties ?? {}),
      project: Type.Optional(Type.String({ description: REMOTE_PROJECT_PARAM_DESCRIPTION })),
    }),
    execute: async (toolCallId, params, signal, onUpdate) => {
      const project = (params as Record<string, unknown> | undefined)?.project
      if (project === undefined || project === null) return tool.execute(toolCallId, params, signal, onUpdate)
      const { project: _project, ...args } = params as Record<string, unknown>
      if (typeof project !== 'string') return textResult({ error: '`project` must be a project id or name.' })
      const target = await resolveRemoteTarget(ctx, project)
      if ('error' in target) return textResult({ error: target.error, code: target.code })
      if (target.local) return tool.execute(toolCallId, args as any, signal, onUpdate)
      try {
        const result = await callRemoteTool(target.id, tool.name, args, signal)
        return tool.name === 'exec' ? mirrorRemoteExecTask(ctx, target, args, result) : result
      } catch (err) {
        return remoteFailure(err, { id: target.id, name: target.name })
      }
    },
  }
}

/**
 * A remote `exec` that is still running becomes a local task whose status is
 * polled from the other project's runtime, so `wait`, `task_list`, the dock
 * and wake-ups treat it like any other background task.
 */
function mirrorRemoteExecTask(
  ctx: ToolContext,
  target: { id: string; name: string },
  args: Record<string, unknown>,
  result: AgentToolResult<any>,
): AgentToolResult<any> {
  const details = result.details as Record<string, any> | undefined
  const registry = ctx.commandRegistry
  const taskId = details?.task_id ?? details?.run_id
  if (!registry || details?.status !== 'running' || typeof taskId !== 'string') return result
  const pid = typeof details.pid === 'number' ? details.pid : undefined
  const client: import('./task-registry').RemoteTaskClient = {
    get: async (id, opts = {}) => {
      const res = await callRemoteTool(target.id, 'exec_wait', {
        run_id: id,
        timeout_ms: Math.max(0, opts.waitMs ?? 0),
        ...(opts.until ? { pattern: opts.until } : {}),
      })
      const d = (res.details ?? {}) as Record<string, any>
      const output = [d.stdout, d.stderr].filter((v) => typeof v === 'string' && v).join('\n')
      if (d.status === 'running') return { id, status: 'running', output }
      if (d.status === 'pattern_matched') return { id, status: 'running', output, matched: true }
      if (d.status === 'stale' || (d.error && d.exitCode === undefined)) {
        return { id, status: 'failed', output, result: { summary: String(d.error ?? 'remote task lost') } }
      }
      const exitCode = typeof d.exitCode === 'number' ? d.exitCode : 1
      return { id, status: exitCode === 0 ? 'completed' : 'failed', output, result: { exitCode, summary: `exit code ${exitCode}` } }
    },
    cancel: async () => {
      if (pid) await callRemoteTool(target.id, 'exec', { command: `kill ${pid}` })
    },
    consume: async () => {},
  }
  const entry = registry.registerRemote({
    id: taskId,
    source: 'shell',
    title: `[${target.name}] ${String(args.command ?? '')}`,
    client,
  })
  return textResult({
    ...details,
    task_id: entry.id,
    output_file: taskOutputPath(ctx, entry),
    hint: BACKGROUND_TASK_HINT,
  })
}

const REMOTE_WAKE_COMMAND = 'pwd && ls -la'

async function connectRemoteProject(ctx: ToolContext, ref: string, signal?: AbortSignal): Promise<AgentToolResult<any>> {
  if (!ref.trim()) return textResult({ error: 'project is required' })
  const target = await resolveRemoteTarget(ctx, ref)
  if ('error' in target) return textResult({ error: target.error, code: target.code })
  const toolList = REMOTE_TOOL_ALLOWLIST.join(', ')
  if (target.local) {
    return textResult({
      ok: true,
      current: true,
      message: 'That is the current project; its tools already run here, so omit `project`.',
    })
  }
  const project = { id: target.id, name: target.name }
  let readOnly = false
  let listing: string | undefined
  try {
    const result = await callRemoteTool(target.id, 'exec', { command: REMOTE_WAKE_COMMAND }, signal)
    const details = result.details as { stdout?: string } | undefined
    listing = typeof details?.stdout === 'string' ? details.stdout : undefined
  } catch (err) {
    if (!(err instanceof RemoteToolError) || err.status !== 403) return remoteFailure(err, project)
    // Read-only access: exec is refused, but a read-only tool still wakes it.
    try {
      await callRemoteTool(target.id, 'exec_list', {}, signal)
      readOnly = true
    } catch (inner) {
      return remoteFailure(inner, project)
    }
  }
  const tools = readOnly ? REMOTE_READONLY_TOOLS.join(', ') : toolList
  const text = [
    `Connected to project "${target.name}" (${target.id}); it is reachable${readOnly ? ' (read-only)' : ''}.`,
    `Pass \`project: "${target.id}"\` to ${tools} to run them inside it. Paths are relative to its root, and each remote exec starts at that root.`,
    ...(!readOnly && copyToProjectAvailable()
      ? [`To send it several files or any binary files, use \`copy_to_project\` with \`project: "${target.id}"\`.`]
      : []),
    ...(listing ? ['', listing] : []),
  ].join('\n')
  return {
    content: [{ type: 'text', text }],
    details: { ok: true, project, reachable: true, readOnly, tools: readOnly ? [...REMOTE_READONLY_TOOLS] : [...REMOTE_TOOL_ALLOWLIST] },
  }
}

function createConnectProjectTool(ctx: ToolContext): AgentTool {
  return {
    name: 'connect_project',
    label: 'Connect Project',
    description:
      'Connect to another project of this workspace so you can work in it. Wakes its runtime, checks that it is reachable, ' +
      `and lists the tools that accept a \`project\` parameter (${REMOTE_TOOL_ALLOWLIST.join(', ')}). ` +
      "Use project_call instead to hand a task to that project's agent.",
    parameters: Type.Object({
      project: Type.String({ description: 'Project id or exact name (see project_list / list_projects).' }),
    }),
    execute: async (_toolCallId, params: any, signal) => connectRemoteProject(ctx, String(params?.project ?? ''), signal),
  }
}

/** Manifest entries shown to the model; the counts always cover everything. */
const COPY_MANIFEST_PREVIEW = 100

function createCopyToProjectTool(ctx: ToolContext): AgentTool {
  return {
    name: 'copy_to_project',
    label: 'Copy To Project',
    description:
      'Copy files or folders from here into another project of this workspace, in one call. Use this for several files or any ' +
      'binary files (images, fonts, JSON packs, builds); never copy into a path named after another project, and never use ' +
      "share_file to move files between projects. Each path lands inside `dest` under its own name, like `cp -r`: copying " +
      '`site/public/cab2` with dest `public/assets` creates `public/assets/cab2/...` in the target. Symlinks, node_modules and ' +
      '.git are skipped. Existing files are refused unless overwrite is true. Returns every copied path with its size and sha256.',
    parameters: Type.Object({
      project: Type.String({ description: 'Target project id or exact name (see project_list / list_projects).' }),
      paths: Type.Array(Type.String(), {
        description: 'Files or folders to copy, relative to the workspace like read_file paths. "." copies everything.',
        minItems: 1,
      }),
      dest: Type.Optional(Type.String({ description: "Folder in the target, relative to its root (default: its root)." })),
      overwrite: Type.Optional(Type.Boolean({ description: 'Replace files that already exist in the target (default: false).' })),
    }),
    execute: async (_toolCallId, params: any, signal) => {
      const ref = typeof params?.project === 'string' ? params.project : ''
      if (!ref.trim()) return textResult({ error: 'project is required' })
      const paths: unknown = params?.paths
      if (!Array.isArray(paths) || paths.length === 0 || !paths.every((p) => typeof p === 'string')) {
        return textResult({ error: 'paths must be a non-empty array of file or folder paths' })
      }
      const target = await resolveRemoteTarget(ctx, ref)
      if ('error' in target) return textResult({ error: target.error, code: target.code })
      if (target.local) {
        return textResult({ error: 'That is the current project. Use exec (cp) or write_file to copy files within it.' })
      }
      const project = { id: target.id, name: target.name }

      let packed: Awaited<ReturnType<typeof packPaths>>
      try {
        packed = await packPaths(ctx.workspaceDir, paths as string[])
      } catch (err) {
        if (err instanceof TransferError) return textResult({ error: err.message, code: err.code, ...err.extra, project })
        throw err
      }
      try {
        const manifest = await callRemoteImport(
          target.id,
          {
            archive: packed.archive.toString('base64'),
            ...(typeof params?.dest === 'string' && params.dest.trim() ? { dest: params.dest } : {}),
            ...(params?.overwrite === true ? { overwrite: true } : {}),
          },
          signal,
        )
        return textResult({
          ok: true,
          project,
          dest: manifest.dest,
          fileCount: manifest.fileCount,
          totalBytes: manifest.totalBytes,
          files: manifest.files.slice(0, COPY_MANIFEST_PREVIEW),
          ...(manifest.files.length > COPY_MANIFEST_PREVIEW
            ? { filesTruncated: manifest.files.length - COPY_MANIFEST_PREVIEW }
            : {}),
          ...(packed.skipped.length > 0 ? { skipped: packed.skipped.slice(0, 50) } : {}),
          note: `Paths are relative to ${target.name}'s root. Verify there with read_file or exec and project: "${target.id}".`,
        })
      } catch (err) {
        const conflicts = (err as { conflicts?: string[] })?.conflicts
        const failure = remoteFailure(err, project)
        return conflicts ? textResult({ ...(failure.details as object), conflicts }) : failure
      }
    },
  }
}

/**
 * Metal-only preview: ask the API for the project's own runtime URL and start
 * its build there. The response is the contract the agent sees; every failure
 * becomes a code it can act on instead of the mount-era 410 (SHO-125).
 */
async function previewProjectViaApi(ctx: ToolContext, projectId: string): Promise<AgentToolResult<any>> {
  const workspaceId = resolveWorkspaceId(ctx)
  // One literal, not concatenation: `local-route-parity.test.ts` scans this
  // file for internal-API paths, and a `+` would stop it at the workspace
  // segment — hiding the rest of the route from the desktop 404 check.
  const path = `/api/internal/workspaces/${encodeURIComponent(workspaceId!)}/sessions/${encodeURIComponent(ctx.sessionId || '')}/projects/${encodeURIComponent(projectId)}/preview`
  try {
    const result = await workspaceMetaFetch(
      ctx,
      path,
      { method: 'POST', body: JSON.stringify({ userId: ctx.userId, sessionId: ctx.sessionId }) },
      PREVIEW_START_REQUEST_TIMEOUT_MS,
    )
    return textResult({
      projectId,
      url: result.url,
      mode: result.mode ?? 'metal',
      status: result.status ?? 'ready',
    })
  } catch (error: any) {
    const code = typeof error?.code === 'string' ? error.code : undefined
    if (code === 'project_not_attached') {
      return textResult({
        error: `Project ${projectId} is not part of this workspace, so it has no preview. Check the id with list_projects.`,
        code: 'project_not_attached',
      })
    }
    if (code === 'target_not_ready') {
      return textResult({
        error: `${error?.message ?? 'The project runtime is still starting.'} Retry in a couple of seconds.`,
        code: 'target_not_ready',
        retryAfterSeconds: 2,
        noFallbackUrl: true,
        guidance: 'There is no working localhost/fallback link. Retry this tool; do not construct a URL.',
      })
    }
    return textResult({
      error: error?.message || 'preview start failed',
      ...(code ? { code } : {}),
      noFallbackUrl: true,
      guidance:
        'There is no working localhost/fallback link. Tell the user this failed — do not construct or offer any other URL.',
    })
  }
}

/**
 * Builds (or reuses) a member project's static preview and returns the ONE
 * URL that's actually reachable — never this runtime's own control-plane
 * port (`process.env.PORT`), which only serves the chat/tool API and is
 * meaningless to open in a browser.
 *
 * Two substrates, two mechanisms:
 *
 *   - Merged-root (local / cloud): this runtime multiplexes every mounted
 *     project's `dist/` under `/p/<projectId>/` on its own HTTP port (see
 *     `workspace-runtime-mode.ts` + the `/p/:projectId/*` routes in
 *     `server.ts`); mounted members don't auto-build on mount, so this tool
 *     triggers that on-demand build via `POST /p/<projectId>/preview/start`.
 *   - Metal: each project has its OWN runtime and other projects are never
 *     mounted here, so the local route can only answer 410. The API resolves
 *     the project's runtime, starts its build and returns
 *     `<podUrl>/p/<projectId>/` (SHO-125).
 */
function createPreviewProjectTool(ctx: ToolContext): AgentTool {
  return {
    name: 'preview_project',
    label: 'Preview Project',
    description:
      "Build and serve a project's app so it can be opened in a browser, and return the one URL that is " +
      'actually reachable. Works for any project of this workspace: each project runs in its own runtime, ' +
      'and this tool starts that project\'s build (it never mounts the project here). ' +
      'Call this before sharing any "preview"/"running app" link — never construct or hand out ' +
      "a localhost/port link yourself (e.g. from this runtime's own base URL or an env var); only the URL this " +
      'tool returns is guaranteed to work. If this tool errors, there is NO working localhost fallback — report ' +
      'the error to the user and offer to retry or publish; do not suggest any other link, including this ' +
      "runtime's own base URL.",
    parameters: Type.Object({
      projectId: Type.String({
        description: "The project id to preview. Not needed when it is the project this runtime serves.",
      }),
    }),
    execute: async (_toolCallId, params: any) => {
      if (!workspaceMetaToolEnabled(ctx))
        return textResult({
          error: 'This tool is only available in a workspace runtime.',
        })
      const projectId = String(params?.projectId || '')
      if (!projectId) return textResult({ error: 'projectId is required' })

      // Metal: the project's own runtime serves its app; this runtime has no
      // route to it and never will (mounting was removed). Ask the API.
      if (isMetalRuntime() && projectId !== currentRuntimeProjectId()) {
        return previewProjectViaApi(ctx, projectId)
      }

      const port = process.env.PORT || '8080'
      const startPreview = () =>
        fetch(`http://localhost:${port}/p/${encodeURIComponent(projectId)}/preview/start`, {
          method: 'POST',
          signal: AbortSignal.timeout(60_000),
        })
      try {
        let response = await startPreview()
        let result = await response.json().catch(() => ({}))
        if (response.status === 404 && result?.error === 'project_not_attached') {
          await mountWorkspaceProject(ctx, projectId, 'readwrite')
          response = await startPreview()
          result = await response.json().catch(() => ({}))
        }
        if (!response.ok || result?.error) {
          return textResult({
            error: result?.error || result?.message || `preview start failed (HTTP ${response.status})`,
            noFallbackUrl: true,
            guidance: 'There is no working localhost/fallback link. Tell the user this failed — do not construct or offer any other URL.',
          })
        }
        let externalUrls: Record<string, string> = {}
        try {
          externalUrls = JSON.parse(process.env.WORKSPACE_PREVIEW_URLS || '{}')
        } catch {}
        const url = externalUrls[projectId] || `http://localhost:${port}/p/${projectId}/`
        return textResult({ ...result, url })
      } catch (error: any) {
        return textResult({
          error: error?.message || 'preview start failed',
          noFallbackUrl: true,
          guidance: 'There is no working localhost/fallback link. Tell the user this failed — do not construct or offer any other URL.',
        })
      }
    },
  }
}

const MAX_EXEC_OUTPUT_CHARS = 8000

function truncateExecOutput(text: string): string {
  if (!text || text.length <= MAX_EXEC_OUTPUT_CHARS) return text
  const headSize = Math.floor(MAX_EXEC_OUTPUT_CHARS * 0.75)
  const tailSize = MAX_EXEC_OUTPUT_CHARS - headSize
  const head = text.substring(0, headSize)
  const tail = text.substring(text.length - tailSize)
  return `${head}\n\n... [${text.length - MAX_EXEC_OUTPUT_CHARS} chars truncated — use head/tail/grep for more targeted output] ...\n\n${tail}`
}

// ---------------------------------------------------------------------------
// Path translation helpers for Docker sandbox ↔ host
// ---------------------------------------------------------------------------

export function hostToContainer(hostPath: string, workspaceDir: string): string {
  if (hostPath.startsWith(workspaceDir)) {
    return '/workspace' + hostPath.slice(workspaceDir.length)
  }
  return '/workspace'
}

export function containerToHost(containerPath: string, workspaceDir: string): string {
  if (containerPath.startsWith('/workspace')) {
    return workspaceDir + containerPath.slice('/workspace'.length)
  }
  return workspaceDir
}

// ---------------------------------------------------------------------------
// Tool Definitions (created via factory)
// ---------------------------------------------------------------------------

/** Default soft timeout for exec / exec_wait — after this we hand control back. */
const DEFAULT_EXEC_SOFT_TIMEOUT_MS = 30_000

/** Resolves with `value` once `signal` aborts (never, without one). */
function onAbort<T>(signal: AbortSignal | undefined, value: T): { promise: Promise<T>; dispose: () => void } {
  if (!signal) return { promise: new Promise<T>(() => {}), dispose: () => {} }
  if (signal.aborted) return { promise: Promise.resolve(value), dispose: () => {} }
  let listener: () => void = () => {}
  const promise = new Promise<T>((resolve) => {
    listener = () => resolve(value)
    signal.addEventListener('abort', listener, { once: true })
  })
  return { promise, dispose: () => signal.removeEventListener('abort', listener) }
}

interface ExecRunMetadata {
  cwdFileHost: string
  isSandboxed: boolean
  previousCwd: string
  cwdReset: boolean
  /**
   * Final cwd the trap reported, captured when the process exits — see the
   * `handle.done` handler where the meta is registered. Cached because the
   * marker file is gone by then.
   */
  resolvedCwd?: string
}

const execRunMetadata = new WeakMap<CommandHandle, ExecRunMetadata>()

/**
 * The run's final cwd: from the exit-time capture when we have it, otherwise
 * by reading (and removing) the marker now. Both routes unlink the marker, so
 * a run that exits without anyone draining its result leaves nothing behind.
 */
function resolveRunCwd(ctx: ToolContext, meta: ExecRunMetadata): string | undefined {
  if (meta.resolvedCwd) return meta.resolvedCwd
  const rawCwd = consumeExecCwdMarker(meta.cwdFileHost)
  if (!rawCwd) return undefined
  return meta.isSandboxed ? containerToHost(rawCwd, ctx.workspaceDir) : rawCwd
}

/** Apply the trap-written cwd to shellState. Idempotent on retry. */
function finalizeCwdAfterExec(ctx: ToolContext, meta: ExecRunMetadata): string {
  const newCwd = resolveRunCwd(ctx, meta) ?? meta.previousCwd
  ctx.shellState?.setCwd(newCwd)
  return newCwd
}

interface BuildExecResultOpts {
  ctx: ToolContext
  entry: CommandEntry
  finalResult: ShellExitResult
}

function buildCompletedExecResult({ ctx, entry, finalResult }: BuildExecResultOpts): AgentToolResult<any> {
  const meta = execRunMetadata.get(entry.handle)
  const newCwd = meta ? finalizeCwdAfterExec(ctx, meta) : ctx.shellState?.getCwd() || ctx.workspaceDir
  const durationMs = Date.now() - entry.handle.startedAt
  // Mirror the legacy sandboxExec contract: trim outer whitespace so callers
  // get `"hello"` not `"hello\n"`.
  const stdoutTrimmed = finalResult.stdout.trim()
  const stderrTrimmed = finalResult.stderr.trim()
  // The command may have rewritten files the agent already read (formatters,
  // generators). Re-stat them so the next edit is not rejected as stale.
  ctx.fileStateCache?.resyncMtimes()
  if (entry.backgrounded) ctx.commandRegistry?.markConsumed([entry.id])
  let homeNotPersisted: string | undefined
  if (!entry.handle.sandboxed) {
    try {
      const fresh = getHomeWatch(ctx.workspaceDir)?.checkNew() ?? []
      if (fresh.length) homeNotPersisted = homeNotPersistedNote(fresh)
    } catch {}
  }
  return textResult({
    cwd: newCwd,
    ...(finalResult.exitCodeReliable === false
      ? { exit_code_reliable: false, pipeline_status: finalResult.pipelineStatus ?? 'last-stage', status_note: `pipeline status unavailable — ${finalResult.shellLabel ?? 'this shell'} cannot report a pipeline's exit code` }
      : { exitCode: finalResult.exitCode }),
    stdout: truncateExecOutput(stdoutTrimmed),
    stderr: stderrTrimmed ? truncateExecOutput(stderrTrimmed) : undefined,
    durationMs,
    sandboxed: entry.handle.sandboxed || undefined,
    cwdReset: meta?.cwdReset || undefined,
    killed: finalResult.killed || undefined,
    killedReason: finalResult.killReason,
    run_id: entry.runId,
    ...(entry.backgrounded ? { task_id: entry.id, output_file: taskOutputPath(ctx, entry) } : {}),
    homeNotPersisted,
  })
}

/** Workspace-relative output file of a task, as shown to the model. */
function taskOutputPath(ctx: ToolContext, entry: { outputFile?: string }): string | undefined {
  return ctx.commandRegistry?.displayPath(entry.outputFile) ?? entry.outputFile
}

function buildSoftTimeoutResult(ctx: ToolContext, entry: CommandEntry, softTimeoutMs: number | null): AgentToolResult<any> {
  const elapsedMs = Date.now() - entry.handle.startedAt
  return textResult({
    status: 'running',
    task_id: entry.id,
    run_id: entry.runId,
    output_file: taskOutputPath(ctx, entry),
    pid: entry.handle.pid,
    sandboxed: entry.handle.sandboxed || undefined,
    container_name: entry.handle.containerName,
    elapsedMs,
    stdout: truncateExecOutput(entry.handle.stdout().trim()),
    stderr: truncateExecOutput(entry.handle.stderr().trim()),
    hint:
      (softTimeoutMs === null
        ? 'Started in the background. '
        : `Still running after ${Math.round(softTimeoutMs / 1000)}s; it keeps running in the background. `) +
      BACKGROUND_TASK_HINT,
  })
}

/** One rule for every async tool result. */
export const BACKGROUND_TASK_HINT =
  'Call wait({ task_ids: [task_id] }) to block on it, or end your turn and you will get a [Task update] when it finishes.'

/**
 * Per-turn steering state. A tool instance is built per turn, but a test (or a
 * subagent) may build several from one context, so the state lives on the
 * context: one turn shares it, the next turn starts empty.
 */
export interface TurnSteeringState {
  /** Running-task sets already sleep-polled this turn. */
  sleepPolls: Set<string>
  /** Consecutive `wait` timeouts per task-id set this turn. */
  waitTimeouts: Map<string, number>
}

export function turnSteeringState(ctx: ToolContext): TurnSteeringState {
  if (!ctx.turnState) ctx.turnState = { sleepPolls: new Set(), waitTimeouts: new Map() }
  return ctx.turnState
}

function waitCallFor(ids: string[], until?: string): string {
  const list = `[${ids.map((id) => `"${id}"`).join(', ')}]`
  return until ? `wait({ task_ids: ${list}, until: ${until} })` : `wait({ task_ids: ${list} })`
}

function waitInsteadOfPollHint(ids: string[], reason: PollMatch['reason']): string {
  const reads = reason === 'reads_task_output'
  return (
    `${waitCallFor(ids)} returns the moment the task finishes${reads ? ' and gives you the output you are about to read' : ' or its stdout matches'}; ` +
    'a sleep cannot — it always spends the whole delay and then only tells you to look again. ' +
    `To wait for a server to accept connections, use ${waitCallFor(ids, "'<ready line>'")}. ` +
    'If you would rather not block, end your turn: the [Task update] is guaranteed.'
  )
}

/** Merge a steering note into a tool result the model and the UI both read. */
function withSteering(result: AgentToolResult<any>, steering: Record<string, unknown>): AgentToolResult<any> {
  const details = result?.details
  if (!details || typeof details !== 'object' || Array.isArray(details)) return result
  return { ...result, ...textResult({ ...(details as Record<string, unknown>), steering }) }
}

/**
 * A sleep that waits on a running task cannot see that task finish early, so it
 * is a poll. Only a sleep tied to the task counts — one that reads its output or
 * does nothing but wait (see `findPolledTasks`); a sleep waiting on CI, a port or
 * a rebuild is left alone. The first poll still runs (it may be a real delay the
 * command needs) and carries the steering; a second identical one is refused,
 * naming the `wait` call that would have returned as soon as the task settled.
 */
function withSleepPollSteering(tool: AgentTool, ctx: ToolContext): AgentTool {
  const run = tool.execute
  return {
    ...tool,
    execute: async (toolCallId, params, signal) => {
      const { command = '', background = false } = params as { command?: string; background?: boolean }
      // `background: true` starts a new task; its sleep is that task's own delay.
      const running = background ? [] : (ctx.commandRegistry?.listRunning() ?? [])
      const match = findPolledTasks(command, running)
      if (!match) return run(toolCallId, params, signal)

      const ids = match.ids
      const key = [...ids].sort().join(',')
      const state = turnSteeringState(ctx)
      if (state.sleepPolls.has(key)) {
        return textResult({
          ok: false,
          code: 'use_wait_instead',
          running_tasks: ids,
          hint: waitInsteadOfPollHint(ids, match.reason),
        })
      }
      state.sleepPolls.add(key)
      const result = await run(toolCallId, params, signal)
      return withSteering(result, {
        code: 'wait_instead_of_poll',
        running_tasks: ids,
        hint: waitInsteadOfPollHint(ids, match.reason),
      })
    },
  }
}

function createExecTool(ctx: ToolContext): AgentTool {
  return withSleepPollSteering({
    name: 'exec',
    description: `Run a shell command. The shell remembers your working directory across calls — do NOT prepend cd to commands, the cwd from your last exec call is preserved automatically. The result includes the current cwd. Quote file paths containing spaces. Use && to chain dependent commands, ; for independent ones. Never use interactive flags (-i). Prefer read_file over cat/head/tail${isSearchEnabled() ? ', and the \`search\` tool over grep/rg for finding code' : '; use rg (ripgrep) to find code'}. Tokens saved to .env are auto-loaded. Long-running commands become background tasks: set \`background: true\` to start one immediately (never detach it yourself with \`&\` or \`nohup\`; those are refused), and any command still running after \`timeout\` ms (default ${DEFAULT_EXEC_SOFT_TIMEOUT_MS}) is handed back as \`{ status: "running", task_id, output_file }\` while it keeps running.`,
    label: 'Execute Command',
    parameters: Type.Object({
      command: Type.String({ description: 'Shell command to execute' }),
      timeout: Type.Optional(
        Type.Number({
          description:
            `Soft timeout in milliseconds (default: ${DEFAULT_EXEC_SOFT_TIMEOUT_MS}). ` +
            'If exceeded, the command keeps running as a background task.',
        }),
      ),
      background: Type.Optional(
        Type.Boolean({
          description: 'Start as a background task and return immediately with a task_id (servers, watchers, long builds/tests).',
        }),
      ),
    }),
    execute: async (_toolCallId, params, signal) => {
      const { command, timeout = DEFAULT_EXEC_SOFT_TIMEOUT_MS, background = false } = params as {
        command: string
        timeout?: number
        background?: boolean
      }
      const attributedCommand = injectCommitTrailer(command, {
        ...process.env,
        ...loadWorkspaceEnvForAttribution(ctx.workspaceDir),
      })

      // Workspace Trust gate. Restricted-mode projects (newly opened
      // external folders the user hasn't trusted) refuse all shell
      // commands. Matches VS Code's Restricted Mode behaviour: terminal
      // and task execution are disabled until trust is granted.
      const execTrust = assertAllowedPath(ctx.workspaceDir, 'exec', ctx.workspaceDir)
      if (!execTrust.ok) return textResult({ error: execTrust.message })

      // Stop the agent from killing the runtime that hosts its own tools. A
      // broad `pkill -f`/`killall` in the agent's shell otherwise reaches the
      // gateway process (same environment), SIGTERMs it, and takes the whole
      // session/VM down mid-task. Only commands that would actually signal the
      // gateway are refused — specific dev-server/port kills still work.
      const gatewayGuard = commandTargetsGateway(attributedCommand)
      if (gatewayGuard.blocked) {
        return textResult({
          error: gatewayKillRefusal(gatewayGuard.reason ?? 'kill targets the runtime'),
        })
      }

      const detach = checkSelfDetach(command)
      if (detach.detached) return textResult({ error: selfDetachRefusal(detach) })

      // Desktop auto-redirect: when the user asks the agent to run a
      // dev server / long-lived process, route through terminalExec
      // so it spawns a visible ∞ terminal tab (matching Cursor UX).
      // Only matches EXPLICIT dev server commands — not build/test/lint.
      if (ctx.terminalExec) {
        const lc = attributedCommand.toLowerCase().trim()
        const DEV_SERVER_PATTERNS = [
          /^npm\s+run\s+(dev|start|serve|preview)(?:\s|$)/,
          /^npx\s+(vite|expo|next|nuxt|astro|remix|webpack-dev-server|turbopack|metro)(?:\s|$)/,
          /^bun\s+(dev|start|serve|preview)(?:\s|$)/,
          /^yarn\s+(dev|start|serve|preview)(?:\s|$)/,
          /^pnpm\s+(dev|start|serve|preview)(?:\s|$)/,
          /^\.?\/node_modules\/\.bin\/(vite|expo|next|nuxt|astro)(?:\s|$)/,
          /^vite(?:\s|$)/,
          /^expo\s+start(?:\s|$)/,
          /^next\s+dev(?:\s|$)/,
          /^nuxt\s+dev(?:\s|$)/,
          /^astro\s+dev(?:\s|$)/,
          /^remix\s+dev(?:\s|$)/,
          /^webpack-dev-server(?:\s|$)/,
          /^turbo(?:\s|$)/,
          /^serve(?:\s|$)/,
          /^http-server(?:\s|$)/,
          /^live-server(?:\s|$)/,
          /^python3?\s+-m\s+(http\.server|SimpleHTTPServer|flask|django)(?:\s|$)/,
          /^docker\s+compose\s+up(?:\s|$)/,
          /^docker\s+run(?:\s|$)/,
          /^pm2\s+(start|serve)(?:\s|$)/,
          /^nodemon(?:\s|$)/,
          /^tailwindcss\s+-i(?:\s|$)/,
          /^concurrently(?:\s|$)/,
          /^foreman\s+start(?:\s|$)/,
          /^mux\s+start(?:\s|$)/,
          /^dnsmasq(?:\s|$)/,
        ]
        const isDevServer = DEV_SERVER_PATTERNS.some((p) => p.test(lc))
        if (isDevServer) {
          try {
            const result = await ctx.terminalExec({
              command: attributedCommand,
              timeoutMs: undefined,
              mode: 'background',
            })
            return textResult(result)
          } catch (err: any) {
            // Fallback: run in sandbox if terminalExec fails
          }
        }
      }

      let currentCwd = ctx.shellState?.getCwd() || ctx.workspaceDir
      // Defend against the persisted cwd having been deleted (e.g. agent did
      // `rm -rf game/` while inside it). Without this, the wrapping `cd` below
      // silently no-ops via `|| true` and the next command runs in the wrong
      // dir, producing confusing errors like `cd: can't cd to game`.
      let cwdReset = false
      if (!existsSync(currentCwd)) {
        currentCwd = ctx.shellState?.initialCwd && existsSync(ctx.shellState.initialCwd) ? ctx.shellState.initialCwd : ctx.workspaceDir
        cwdReset = true
        ctx.shellState?.setCwd(currentCwd)
      }
      // The cwd marker is a temp file with a lifetime, not workspace state, so
      // it goes under `.shogo/exec-cwd/` — already excluded from checkpoints,
      // exports and the managed git ignore block — instead of the workspace
      // root, where a folder-linked repo would show it as untracked junk.
      const cwdMarker = newExecCwdMarker()
      const cwdDirHost = execCwdDirFor(ctx.workspaceDir)
      const cwdFileHost = cwdDirHost ? join(cwdDirHost, cwdMarker) : join(ctx.workspaceDir, cwdMarker)

      const isSandboxed = shouldSandbox({
        command: attributedCommand,
        workspaceDir: ctx.workspaceDir,
        sandboxConfig: ctx.sandbox,
        sessionId: ctx.sessionId,
        mainSessionIds: ctx.mainSessionIds,
      })

      const cwdFileCmd = isSandboxed ? hostToContainer(cwdFileHost, ctx.workspaceDir) : cwdFileHost
      const cdTarget = isSandboxed ? hostToContainer(currentCwd, ctx.workspaceDir) : currentCwd

      const wrappedCommand = [
        `trap '/bin/pwd > "${cwdFileCmd}" 2>/dev/null' EXIT`,
        `cd "${cdTarget}" 2>/dev/null || true`,
        attributedCommand,
      ].join('\n')

      // Spawn the command via the async primitive so we can race it against
      // a soft timeout and hand the agent a run_id if it overruns.
      // GH_TOKEN is the App installation token when the project is connected,
      // so `gh` comments and git commits are the bot rather than a user PAT.
      //
      // On a workspace runtime the shell's cwd decides which project's
      // credentials it gets: `RUNTIME_AUTH_SECRET` is the *workspace* token
      // there, and anything the agent starts (an app server, a test script)
      // must hold the cwd project's own `rt_v1_` token instead, or none.
      const STOPPED = Symbol('stopped')
      const stoppedBeforeSpawn = onAbort(signal, STOPPED)
      const credentials = await Promise.race([
        resolveProjectCredentialEnv({ workspaceDir: ctx.workspaceDir, cwd: currentCwd }),
        stoppedBeforeSpawn.promise,
      ])
      if (credentials === STOPPED) return textResult({ error: 'Stopped before the command started.' })
      const githubEnv = await Promise.race([githubCliEnvForProject(ctx.projectId), stoppedBeforeSpawn.promise])
      stoppedBeforeSpawn.dispose()
      if (githubEnv === STOPPED) return textResult({ error: 'Stopped before the command started.' })
      const topLevelBefore = snapshotWorkspaceTopLevel(ctx.workspaceDir)
      // The baseline must predate the first command, or what it creates is never reported.
      if (!isSandboxed) {
        try {
          getHomeWatch(ctx.workspaceDir)?.prime()
        } catch {}
      }
      const handle = sandboxExecAsync({
        command: wrappedCommand,
        workspaceDir: ctx.workspaceDir,
        sandboxConfig: ctx.sandbox,
        sessionId: ctx.sessionId,
        mainSessionIds: ctx.mainSessionIds,
        extraEnv: { ...githubEnv, ...credentials.env },
        unsetEnv: credentials.unset,
      })

      const meta: ExecRunMetadata = {
        cwdFileHost,
        isSandboxed,
        previousCwd: currentCwd,
        cwdReset,
      }
      execRunMetadata.set(handle, meta)

      // Capture the trap's cwd the moment the process exits, not only when a
      // result is drained: `background: true`, a soft timeout, an abort and a
      // crash all hand back "running" and may never be waited on, and the
      // marker must not outlive the shell that wrote it.
      handle.done
        .then(() => {
          const resolved = resolveRunCwd(ctx, meta)
          if (resolved) meta.resolvedCwd = resolved
        })
        .catch(() => {
          consumeExecCwdMarker(cwdFileHost)
        })

      // Always register so a follow-up exec_wait can find this run, even if it
      // completes within the soft timeout (defensive against races where the
      // model decided to wait while we were already returning).
      const registry = ctx.commandRegistry ?? new CommandRegistry()
      const entry = registry.register(attributedCommand, handle, { cwd: currentCwd })
      // A shell task's thread is its own output file — the log the dock shows.
      entry.link = { kind: 'log', path: registry.displayPath(entry.outputFile) }

      if (background) {
        registry.markBackgrounded(entry.id)
        return buildSoftTimeoutResult(ctx, entry, null)
      }

      const softTimeoutMs = Math.max(0, timeout)
      const SOFT_TIMEOUT = Symbol('soft-timeout')
      let timer: ReturnType<typeof setTimeout> | undefined
      const timeoutPromise = new Promise<typeof SOFT_TIMEOUT>((resolve) => {
        timer = setTimeout(() => resolve(SOFT_TIMEOUT), softTimeoutMs)
        ;(timer as any)?.unref?.()
      })

      const stopped = onAbort(signal, STOPPED)
      const winner = await Promise.race([handle.done, timeoutPromise, stopped.promise])
      if (timer) clearTimeout(timer)
      stopped.dispose()

      if (winner === SOFT_TIMEOUT || winner === STOPPED) {
        registry.markBackgrounded(entry.runId)
        return buildSoftTimeoutResult(ctx, entry, winner === STOPPED ? null : softTimeoutMs)
      }

      return withOtherProjectFolderWarning(ctx.workspaceDir, topLevelBefore, buildCompletedExecResult({ ctx, entry, finalResult: winner }))
    },
  }, ctx)
}

/**
 * Metal workspace runtimes: top-level entries of the workspace root before a
 * command, so a folder it creates for another project (`cp -r x ../<id>/`)
 * can be reported. The path guard cannot see inside a shell command.
 */
function snapshotWorkspaceTopLevel(workspaceDir: string): Set<string> | null {
  if (!isWorkspaceRuntimeMode() || !isMetalRuntime()) return null
  try {
    return new Set(readdirSync(workspaceDir))
  } catch {
    return null
  }
}

function withOtherProjectFolderWarning(
  workspaceDir: string,
  before: Set<string> | null,
  result: AgentToolResult<any>,
): AgentToolResult<any> {
  if (!before) return result
  let created: string[]
  try {
    created = readdirSync(workspaceDir).filter(
      (name) => !before.has(name) && otherProjectForPath(workspaceDir, join(workspaceDir, name)) !== null,
    )
  } catch {
    return result
  }
  if (created.length === 0) return result
  const warning = created
    .map(
      (id) =>
        `This command created \`${id}/\` at the workspace root. ${otherProjectPathMessage(id)} ` +
        `Nothing in that folder reached the project: delete it and redo the work ${copyToProjectAvailable() ? 'with copy_to_project' : `with project: "${id}"`}.`,
    )
    .join('\n')
  const details = result.details && typeof result.details === 'object' ? result.details : { output: result.details }
  return textResult({ ...details, warning })
}

function currentGitHubRepository(workspaceDir: string): { owner: string; repo: string } | null {
  try {
    const remote = execSync('git remote get-url origin', {
      cwd: workspaceDir,
      encoding: 'utf8',
      stdio: 'pipe',
    }).trim()
    const match = remote.match(/github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?$/i)
    return match ? { owner: match[1]!, repo: match[2]! } : null
  } catch {
    return null
  }
}

function githubRunIdMarker(runId: string): string {
  return `<!-- shogo:runId=${runId} -->`
}

const REQUESTER_CREDENTIAL_CODES = new Set(['requester_auth_required', 'requester_unknown', 'denied'])

/** The project acts as the requester and they can't be acted as: no other account may be used instead. */
function isRequesterCredentialBlock(result: CheckpointCallResult<unknown>): boolean {
  return !!result.code && REQUESTER_CREDENTIAL_CODES.has(result.code)
}

function requesterCredentialBlockResult(result: CheckpointCallResult<unknown>) {
  return textResult({
    error: result.error,
    code: result.code,
    ...(result.connectUrl
      ? {
          connectUrl: result.connectUrl,
          next:
            'Do not retry with another account. Tell the person they need to connect their own GitHub account, and put the ' +
            'connectUrl in your reply exactly as given (they cannot see this tool result). Once they have, run this again.',
        }
      : { next: 'Do not retry with another account. Tell the person why it could not be done.' }),
  })
}

/**
 * The `gh` command that achieves the same thing, appended to every
 * `github_create_pr` failure so the tool never dead-ends. `gh` is not gated,
 * so this is always a working next step.
 */
function ghPrFallbackHint(repository: { owner: string; repo: string } | null, head: string): string {
  const repo = repository ? `${repository.owner}/${repository.repo}` : '<owner>/<repo>'
  const branch = head || '<branch>'
  return (
    'Open the PR with gh instead: ' +
    `exec({ command: 'gh pr create --repo ${repo} --base main --head ${branch} --title "..." --body-file .tmp/pr-body.md' }).`
  )
}

function createGitHubPullRequestTool(ctx: ToolContext): AgentTool {
  return {
    name: 'github_create_pr',
    label: 'Create GitHub Pull Request',
    description:
      'Create a GitHub pull request after the current branch has been pushed. With a project GitHub connection it is opened by the ' +
      'Shogo GitHub App, or by the connected user when the project is connected with an access token. ' +
      'The PR body always includes a Made with Shogo footer and an optional issue-pipeline runId marker. ' +
      'If the project has no GitHub connection, the tool falls back to the user GITHUB_TOKEN from workspace .env; ' +
      'with neither, use `gh pr create` in exec instead — that is the normal route and is never blocked.',
    parameters: Type.Object({
      title: Type.String({ description: 'Pull request title' }),
      head: Type.Optional(
        Type.String({
          description: 'Source branch; defaults to the current branch',
        }),
      ),
      base: Type.Optional(Type.String({ description: 'Target branch; defaults to main' })),
      body: Type.Optional(Type.String({ description: 'Pull request description' })),
      draft: Type.Optional(Type.Boolean({ description: 'Create as a draft pull request' })),
      runId: Type.Optional(
        Type.String({
          description: 'Issue-pipeline run id to embed in the body',
        }),
      ),
      workItem: Type.Optional(
        Type.String({
          description:
            'Card key to link this PR to (e.g. SHO-42). Omit and the server derives it from a KEY-12 in the ' +
            'head branch or the title; with no key the PR is simply unlinked.',
        }),
      ),
    }),
    execute: async (_toolCallId, params, signal) => {
      const input = params as {
        title: string
        head?: string
        base?: string
        body?: string
        draft?: boolean
        runId?: string
        workItem?: string
      }
      const title = input.title?.trim()
      const repository = currentGitHubRepository(ctx.workspaceDir)
      let head = input.head?.trim()
      if (!head) {
        try {
          head = execSync('git branch --show-current', {
            cwd: ctx.workspaceDir,
            encoding: 'utf8',
            stdio: 'pipe',
          }).trim()
        } catch {
          head = ''
        }
      }
      if (!title || !head) {
        return textResult({
          error: 'A title and a non-detached source branch are required.',
        })
      }
      if (input.runId && !/^[a-zA-Z0-9_-]+$/.test(input.runId)) {
        return textResult({ error: 'runId contains invalid characters.' })
      }

      const body = withShogoPrFooter(input.body ?? '')
      const markedBody = input.runId && !body.includes('<!-- shogo:runId=') ? `${body}\n\n${githubRunIdMarker(input.runId)}` : body
      const options = {
        title,
        head,
        base: input.base?.trim() || 'main',
        body: markedBody,
        draft: input.draft === true,
        ...(input.runId ? { runId: input.runId } : {}),
        ...(input.workItem?.trim() ? { workItem: input.workItem.trim() } : {}),
      }
      const githubPayload = {
        title: options.title,
        head: options.head,
        base: options.base,
        body: options.body,
        draft: options.draft,
      }

      let botResult = await apiCreateGitHubPullRequest(ctx.projectId, options)
      if (botResult.code === 'approval_pending' && botResult.approvalId) {
        const approvalId = botResult.approvalId
        const outcome = await waitForCredentialApproval(ctx.projectId, approvalId, botResult.expiresAt, signal)
        if (outcome !== 'approved') return approvalOutcomeResult('github', outcome)
        botResult = await withCredentialApproval(approvalId, () => apiCreateGitHubPullRequest(ctx.projectId, options))
      }
      if (botResult.ok && botResult.data) {
        return textResult({
          ok: true,
          mode: botResult.data.mode ?? 'github-app',
          author: botResult.data.author,
          number: botResult.data.number,
          url: botResult.data.url,
          ...(botResult.data.workItem ? { workItem: botResult.data.workItem } : {}),
          ...(botResult.data.credential ? { credential: botResult.data.credential } : {}),
        })
      }
      if (isRequesterCredentialBlock(botResult)) return requesterCredentialBlockResult(botResult)
      if (botResult.code !== 'github_app_not_installed' && botResult.status !== 409) {
        return textResult({
          error: `${botResult.error || 'Shogo GitHub App could not create the pull request.'} ${ghPrFallbackHint(repository, head)}`,
          status: botResult.status,
        })
      }

      if (!repository) {
        return textResult({
          error: `No GitHub App connection exists and the origin remote is not a GitHub repository. ${ghPrFallbackHint(repository, head)}`,
        })
      }
      const token = loadWorkspaceEnvForAttribution(ctx.workspaceDir).GITHUB_TOKEN || process.env.GITHUB_TOKEN
      if (!token) {
        return textResult({
          error: `No GitHub App connection exists. Save GITHUB_TOKEN in workspace .env to create a user-authored PR, or open it with gh. ${ghPrFallbackHint(repository, head)}`,
        })
      }

      try {
        const response = await fetch(
          `https://api.github.com/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}/pulls`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${token}`,
              Accept: 'application/vnd.github+json',
              'X-GitHub-Api-Version': '2022-11-28',
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(githubPayload),
          },
        )
        const result = (await response.json().catch(() => null)) as {
          number?: number
          html_url?: string
          user?: { login?: string }
          message?: string
        } | null
        if (!response.ok || typeof result?.number !== 'number' || typeof result.html_url !== 'string') {
          return textResult({
            error: result?.message || `GitHub returned HTTP ${response.status}`,
            status: response.status,
          })
        }
        return textResult({
          ok: true,
          mode: 'user-token',
          author: result.user?.login,
          number: result.number,
          url: result.html_url,
        })
      } catch (error: any) {
        return textResult({ error: error?.message ?? String(error) })
      }
    },
  }
}

/** `owner/name`, `github.com/owner/name`, or a clone URL → owner and repo. */
export function parseGitHubRepoRef(ref: string): { owner: string; repo: string } | null {
  const trimmed = ref.trim().replace(/\/+$/, '')
  const match =
    trimmed.match(/^(?:https?:\/\/)?(?:www\.)?github\.com[/:]([^/\s]+)\/([^/\s#?]+?)(?:\.git)?(?:[/#?].*)?$/i) ??
    trimmed.match(/^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?$/i) ??
    trimmed.match(/^([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?$/)
  return match ? { owner: match[1]!, repo: match[2]! } : null
}

/**
 * Connect a project to a GitHub repository. The user chooses how: authorize
 * the Shogo GitHub App (a link they open), or share an access token. Either
 * way the credential lands on the project's encrypted GitHub connection and
 * the repository is checked out in the project's own runtime, where the
 * preview runs — never cloned by hand with a token in the URL or `.env`.
 */
export function createGitHubConnectTool(ctx: ToolContext): AgentTool {
  return {
    name: 'github_connect',
    label: 'Connect GitHub Repository',
    description:
      'Clone / import a GitHub repository into a Shogo project, or switch the project to another branch of it. ' +
      'Connects the project to the repo so its files, preview, pushes, pulls, and pull requests use it. ' +
      'Call it without a token first: it returns a link for the user to authorize the Shogo GitHub App, and you should offer the user ' +
      'both options — open that link, or share a GitHub access token (fine-grained token with Contents and Pull requests read/write ' +
      'on the repo, or a classic token with `repo` scope). When the user shares a token, call this again with it. ' +
      'Pass `branch` to work on a branch other than the default ("clone X and switch to branch Y" is one call); on a project ' +
      'that is already connected, calling it with `branch` and no token just switches branches. ' +
      'The project\'s tech stack is detected from the repository and its preview restarts on it. ' +
      'This replaces cloning by hand: do not `git clone` a repository into a project. A token passed here is stored on the ' +
      'project\'s connection, so do not also write it to `.env`. `repo` is required: if the user pasted a token without naming ' +
      'a repository, ask which one (owner/name). A token for one-off `gh` work outside a project\'s repository goes in workspace ' +
      '`.env` as GITHUB_TOKEN instead.',
    parameters: Type.Object({
      repo: Type.String({ description: 'Repository as owner/name or a github.com URL' }),
      token: Type.Optional(Type.String({ description: 'GitHub access token the user shared, to connect with it' })),
      branch: Type.Optional(Type.String({ description: 'Existing branch to check out; defaults to the repository\'s default branch' })),
      projectId: Type.Optional(
        Type.String({ description: 'Project to connect; defaults to the current project' }),
      ),
    }),
    execute: async (_toolCallId, params) => {
      const input = params as { repo: string; token?: string; branch?: string; projectId?: string }
      const parsed = parseGitHubRepoRef(input.repo ?? '')
      if (!parsed) return textResult({ error: 'repo must be owner/name or a github.com repository URL.' })
      const projectId =
        projectScopedId(input.projectId?.trim() || ctx.projectId) ||
        projectScopedId(process.env.WORKSPACE_ANCHOR_PROJECT_ID)
      if (!projectId) {
        return textResult({ error: 'No project selected. Pass projectId for the project to connect.' })
      }
      const repoFullName = `${parsed.owner}/${parsed.repo}`
      const branch = input.branch?.trim() || undefined

      const token = input.token?.trim()
      if (!token && branch) {
        const switched = await apiSwitchGitHubBranch(projectId, { repoOwner: parsed.owner, repoName: parsed.repo, branch })
        if (switched.ok && switched.data) {
          return textResult({
            ok: true,
            connected: switched.data.repoFullName,
            branch: switched.data.branch,
            techStack: switched.data.techStackId,
            files: `checked out ${switched.data.branch}`,
          })
        }
        if (switched.status !== 409) {
          return textResult({ error: switched.error || `Could not switch to ${branch}.`, status: switched.status })
        }
      }
      if (token) {
        const result = await apiConnectGitHubWithToken(projectId, {
          repoOwner: parsed.owner,
          repoName: parsed.repo,
          token,
          ...(branch ? { branch } : {}),
        })
        if (!result.ok || !result.data) {
          return textResult({ error: result.error || 'GitHub rejected the connection.', status: result.status })
        }
        clearGitHubCliEnvCache()
        const workspace = result.data.workspace
        return textResult({
          ok: true,
          connected: result.data.repoFullName,
          as: result.data.login ?? undefined,
          branch: workspace?.ok ? workspace.branch ?? result.data.defaultBranch : result.data.defaultBranch,
          techStack: workspace?.techStackId,
          files: workspace?.ok === false
            ? `not updated: ${workspace.error}`
            : workspace?.connect === 'diverged'
              ? `not updated: ${workspace.error}`
              : workspace?.connect === 'adopted'
                ? `checked out ${workspace.branch ?? result.data.defaultBranch}` +
                  (workspace.backupBranch ? `; previous project files kept on branch ${workspace.backupBranch}` : '')
                : 'already up to date with the repository',
          ...(workspace?.ok === false
            ? {
                next:
                  'The token was accepted and the repository is connected; only copying its files into the project failed. ' +
                  'This is not a token problem, so don\'t ask for a new one. Call github_connect again with the same arguments; ' +
                  'if it fails again, tell the user the project runtime was unavailable and to retry in a minute.',
              }
            : {}),
        })
      }

      const link = await apiGetGitHubAuthorizeUrl(projectId, { repoOwner: parsed.owner, repoName: parsed.repo })
      const tokenOption =
        `Share a GitHub access token for ${repoFullName} (fine-grained: Contents and Pull requests read/write; ` +
        'classic: repo scope). It is stored encrypted on the project connection.'
      if (link.ok && link.data?.available && link.data.url) {
        ctx.uiWriter?.write({
          type: 'data-integration-auth-required',
          data: {
            provider: 'github_app',
            connectUrl: link.data.url,
            message: `Authorize the Shogo GitHub App so this project can use ${repoFullName}.`,
          },
        })
        return textResult({
          ok: true,
          connected: false,
          repo: repoFullName,
          options: [
            { option: 'authorize_app', label: 'Authorize the Shogo GitHub App', url: link.data.url },
            { option: 'share_token', label: tokenOption },
          ],
          next:
            'Offer the user both options, and put the authorize_app url in your reply exactly as given (the user cannot see this tool result). ' +
            'After they authorize, the connection completes on its own; if they share a token, call github_connect again with it.' +
            (branch ? ` The App connects the default branch: once they have authorized, call github_connect again with branch "${branch}".` : ''),
        })
      }
      return textResult({
        ok: true,
        connected: false,
        repo: repoFullName,
        options: [{ option: 'share_token', label: tokenOption }],
        next: 'Authorizing the GitHub App is not available on this server. Ask the user for a token and call github_connect again with it.',
      })
    },
  }
}

/**
 * Merge a pull request. Merging changes shared code, so the permission engine
 * asks a person first unless the project's action rules say otherwise
 * (`github_merge_pr` defaults to `ask`).
 */
export function createGitHubMergePullRequestTool(ctx: ToolContext): AgentTool {
  return {
    name: 'github_merge_pr',
    label: 'Merge GitHub Pull Request',
    description:
      'Merge a GitHub pull request by number. A person on the team is asked to approve before it runs, so call it only when the work ' +
      'is reviewed and ready. Use squash unless the project says otherwise. Prefer this tool over `gh pr merge` so the merge is attributed and approved.',
    parameters: Type.Object({
      number: Type.Number({ description: 'Pull request number' }),
      method: Type.Optional(
        Type.Union([Type.Literal('merge'), Type.Literal('squash'), Type.Literal('rebase')], {
          description: 'Merge method; defaults to squash',
        }),
      ),
      commitTitle: Type.Optional(Type.String({ description: 'Title for the merge or squash commit' })),
    }),
    execute: async (_toolCallId, params, signal) => {
      const input = params as { number: number; method?: 'merge' | 'squash' | 'rebase'; commitTitle?: string }
      const number = Math.trunc(Number(input.number))
      if (!Number.isFinite(number) || number <= 0) return textResult({ error: 'A pull request number is required.' })
      const method = input.method ?? 'squash'

      const merge = () => apiMergeGitHubPullRequest(ctx.projectId, number, { method, commitTitle: input.commitTitle })
      let botResult = await merge()
      if (botResult.code === 'approval_pending' && botResult.approvalId) {
        const approvalId = botResult.approvalId
        const outcome = await waitForCredentialApproval(ctx.projectId, approvalId, botResult.expiresAt, signal)
        if (outcome !== 'approved') return approvalOutcomeResult('github', outcome)
        botResult = await withCredentialApproval(approvalId, merge)
      }
      if (botResult.ok && botResult.data) {
        return textResult({
          ok: true,
          mode: 'github-app',
          merged: botResult.data.merged !== false,
          number,
          sha: botResult.data.sha,
          ...(botResult.data.credential ? { credential: botResult.data.credential } : {}),
        })
      }
      if (isRequesterCredentialBlock(botResult)) return requesterCredentialBlockResult(botResult)
      if (botResult.code !== 'github_app_not_installed' && botResult.status !== 409) {
        return textResult({
          error: botResult.error || 'Shogo GitHub App could not merge the pull request.',
          status: botResult.status,
        })
      }

      const repository = currentGitHubRepository(ctx.workspaceDir)
      if (!repository) {
        return textResult({ error: 'No GitHub App connection exists and the origin remote is not a GitHub repository.' })
      }
      const token = loadWorkspaceEnvForAttribution(ctx.workspaceDir).GITHUB_TOKEN || process.env.GITHUB_TOKEN
      if (!token) {
        return textResult({ error: 'No GitHub App connection exists. Save GITHUB_TOKEN in workspace .env to merge with a user token.' })
      }
      try {
        const response = await fetch(
          `https://api.github.com/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}/pulls/${number}/merge`,
          {
            method: 'PUT',
            headers: {
              Authorization: `Bearer ${token}`,
              Accept: 'application/vnd.github+json',
              'X-GitHub-Api-Version': '2022-11-28',
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ merge_method: method, ...(input.commitTitle ? { commit_title: input.commitTitle } : {}) }),
          },
        )
        const result = (await response.json().catch(() => null)) as { merged?: boolean; sha?: string; message?: string } | null
        if (!response.ok || result?.merged === false) {
          return textResult({ error: result?.message || `GitHub returned HTTP ${response.status}`, status: response.status })
        }
        return textResult({ ok: true, mode: 'user-token', merged: true, number, sha: result?.sha })
      } catch (error: any) {
        return textResult({ error: error?.message ?? String(error) })
      }
    },
  }
}

function stripAnsiForPattern(value: string): string {
  // Covers CSI color/control sequences (the common source of a readiness
  // token being invisible to a plain `/Ready/` pattern).
  return value.replace(/\u001B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '')
}

function createExecWaitTool(ctx: ToolContext): AgentTool {
  return {
    name: 'exec_wait',
    description: `Wait for a backgrounded shell command (one that returned \`status: "running"\` from a previous exec call). Soft-bounded: returns whatever has happened by \`timeout_ms\` (default ${DEFAULT_EXEC_SOFT_TIMEOUT_MS}). If the command is still running after the wait, you receive { status: "running", run_id, pid, ... } and can call again. If the command finished (or was killed via exec("kill <pid>")), you receive the final stdout/stderr/exitCode. Optional \`pattern\` returns { status: "pattern_matched", matched: <pattern>, ... } as soon as the regex matches recent combined output; this is distinct from a timeout.`,
    label: 'Wait for Command',
    parameters: Type.Object({
      run_id: Type.String({
        description: 'The run_id returned by a previous exec or exec_wait call',
      }),
      timeout_ms: Type.Optional(
        Type.Number({
          description: `Soft timeout in milliseconds (default: ${DEFAULT_EXEC_SOFT_TIMEOUT_MS}). Set to 0 for an immediate non-blocking status check.`,
        }),
      ),
      pattern: Type.Optional(
        Type.String({
          description:
            'Optional regex (JavaScript syntax). Resolves as soon as the regex matches ANSI-stripped recent combined stdout/stderr.',
        }),
      ),
    }),
    execute: async (_toolCallId, params, signal) => {
      const {
        run_id,
        timeout_ms = DEFAULT_EXEC_SOFT_TIMEOUT_MS,
        pattern,
      } = params as {
        run_id: string
        timeout_ms?: number
        pattern?: string
      }

      const registry = ctx.commandRegistry
      if (!registry) {
        return textResult({
          error: 'CommandRegistry not available — exec_wait requires a sessionId.',
        })
      }

      const found = registry.get(run_id)
      if (!found) {
        return textResult({
          error: `Unknown run_id: ${run_id}. It is not in this conversation's tasks, and no output file to recover it from.` + ' Call task_list for the tasks that are still here.',
        })
      }
      if (!found.handle) {
        return createWaitTool(ctx).execute(_toolCallId, { task_ids: [found.id], timeout_ms, until: pattern }, signal)
      }
      const entry = found as CommandEntry

      // Stale entries were restored from a persisted snapshot after a runtime
      // restart — the underlying OS child is gone and cannot be polled.
      if (entry.stale) {
        return textResult({
          status: 'stale',
          run_id,
          command: entry.command,
          error:
            'This process was started before the runtime restarted and can no longer be polled. ' +
            'It may still be running detached; use exec("kill <pid>") if you need to stop it, or exec_list to review.',
        })
      }

      // If already done, return final result immediately.
      if (entry.finalResult) {
        return buildCompletedExecResult({
          ctx,
          entry,
          finalResult: entry.finalResult,
        })
      }

      let regex: RegExp | undefined
      if (pattern) {
        try {
          regex = new RegExp(pattern, 'm')
        } catch (err: any) {
          return textResult({
            error: `Invalid pattern regex: ${err?.message || String(err)}`,
          })
        }
      }

      const softTimeoutMs = Math.max(0, timeout_ms)
      const SOFT_TIMEOUT = Symbol('soft-timeout')
      const PATTERN_HIT = Symbol('pattern-hit')

      let timer: ReturnType<typeof setTimeout> | undefined
      const timeoutPromise = new Promise<typeof SOFT_TIMEOUT>((resolve) => {
        if (softTimeoutMs === 0) {
          resolve(SOFT_TIMEOUT)
          return
        }
        timer = setTimeout(() => resolve(SOFT_TIMEOUT), softTimeoutMs)
        ;(timer as any)?.unref?.()
      })

      // Pattern polling: ~250ms tick. Cheap and avoids hooking into the
      // child stream from a different tool than the one that owns it.
      let patternTimer: ReturnType<typeof setTimeout> | undefined
      const patternPromise = regex
        ? new Promise<typeof PATTERN_HIT>((resolve) => {
            const tick = () => {
              if (entry.handle.exited()) return // `done` will win
              const stdout = stripAnsiForPattern(entry.handle.stdout())
              const stderr = stripAnsiForPattern(entry.handle.stderr())
              const recent = stripAnsiForPattern(entry.handle.recentOutput())
              const combined = `${stdout}\n${stderr}\n${recent}`
              if (regex!.test(stdout) || regex!.test(stderr) || regex!.test(recent) || regex!.test(combined)) {
                resolve(PATTERN_HIT)
                return
              }
              patternTimer = setTimeout(tick, 250)
              ;(patternTimer as any)?.unref?.()
            }
            tick()
          })
        : new Promise<never>(() => {}) // never resolves

      const endWait = registry.beginWait(run_id)
      const stopped = onAbort(signal, SOFT_TIMEOUT)
      let winner: { exitCode: number; stdout: string; stderr: string; killed: boolean } | typeof SOFT_TIMEOUT | typeof PATTERN_HIT
      try {
        winner = await Promise.race([entry.handle.done, timeoutPromise, patternPromise, stopped.promise])
      } finally {
        endWait()
        stopped.dispose()
      }
      if (timer) clearTimeout(timer)
      if (patternTimer) clearTimeout(patternTimer)

      if (winner === PATTERN_HIT) {
        return textResult({
          status: 'pattern_matched',
          run_id: entry.runId,
          pid: entry.handle.pid,
          sandboxed: entry.handle.sandboxed || undefined,
          container_name: entry.handle.containerName,
          matched: pattern,
          elapsedMs: Date.now() - entry.handle.startedAt,
          stdout: truncateExecOutput(entry.handle.stdout().trim()),
          stderr: truncateExecOutput(entry.handle.stderr().trim()),
          hint: 'Pattern matched while the command is still running. Call exec_wait without a pattern to wait for exit.',
        })
      }

      if (winner === SOFT_TIMEOUT) {
        // Re-check completion in case the process exited between the race
        // resolving and us building the result, so we always prefer the
        // final result when available.
        if (entry.finalResult) {
          return buildCompletedExecResult({
            ctx,
            entry,
            finalResult: entry.finalResult,
          })
        }
        return buildSoftTimeoutResult(ctx, entry, softTimeoutMs)
      }

      return buildCompletedExecResult({ ctx, entry, finalResult: winner })
    },
  }
}

function createExecListTool(ctx: ToolContext): AgentTool {
  return {
    name: 'exec_list',
    description:
      'List the shell commands still running in the background for this thread ' +
      '(those that returned `status: "running"` from a previous exec call and have ' +
      'not finished or been killed). Each entry has a run_id, the command, its pid, ' +
      'and how long it has been running. Use `exec_wait(run_id)` to poll one or ' +
      '`exec("kill <pid>")` to stop it. Entries flagged `stale: true` were started ' +
      'before the runtime restarted and can no longer be polled.',
    label: 'List Running Commands',
    parameters: Type.Object({}),
    execute: async () => {
      const registry = ctx.commandRegistry
      if (!registry) {
        return textResult({
          error: 'CommandRegistry not available — exec_list requires a sessionId.',
        })
      }
      return textResult({ processes: registry.listRunning() })
    },
  }
}

// ---------------------------------------------------------------------------
// Background tasks: wait / task_list / task_cancel
// ---------------------------------------------------------------------------

const DEFAULT_WAIT_TIMEOUT_MS = 30_000
const MAX_WAIT_TIMEOUT_MS = 10 * 60 * 1000

function taskView(ctx: ToolContext, entry: TaskEntry) {
  const registry = ctx.commandRegistry
  // Never hand the agent a log path the restart already deleted (SHO-141).
  const outputFile = registry?.displayExistingPath(entry.outputFile)
  return {
    task_id: entry.id,
    source: entry.source,
    title: entry.title,
    status: entry.status,
    elapsed_ms: (entry.finishedAt ?? Date.now()) - entry.startedAt,
    ...(outputFile
      ? { output_file: outputFile }
      : registry?.outputMissing(entry.outputFile)
        ? { output_missing: 'the runtime restart removed this task\'s log' }
        : {}),
    ...(entry.status === 'interrupted' ? { interrupted_reason: entry.result?.summary ?? 'runtime restarted' } : {}),
  }
}

/** Final result of a finished task, the same shape for every source. */
function finishedTaskResult(ctx: ToolContext, entry: TaskEntry): Record<string, unknown> {
  const registry = ctx.commandRegistry!
  const base: Record<string, unknown> = {
    ...taskView(ctx, entry),
    exit_code: entry.result?.exitCode,
    ...(entry.recovered ? { recovered: true } : {}),
  }
  // A pipeline the shell could not verify has no exit code to report: say so
  // instead of printing the last stage's number as the command's.
  if (entry.result?.exitCodeReliable === false) {
    delete base.exit_code
    base.exit_code_reliable = false
    base.pipeline_status = entry.result.pipelineStatus ?? 'last-stage'
    base.status_note = entry.result.summary
  }
  if (entry.handle && entry.finalResult) {
    const meta = execRunMetadata.get(entry.handle)
    if (meta) finalizeCwdAfterExec(ctx, meta)
    ctx.fileStateCache?.resyncMtimes()
    base.stdout = truncateExecOutput(entry.finalResult.stdout.trim())
    const stderr = entry.finalResult.stderr.trim()
    if (stderr) base.stderr = truncateExecOutput(stderr)
    if (entry.finalResult.killReason) base.killed_reason = entry.finalResult.killReason
  } else {
    base.output = truncateExecOutput(stripAnsiForPattern(registry.readOutput(entry)).trim())
  }
  return base
}

function createWaitTool(ctx: ToolContext): AgentTool {
  return {
    name: 'wait',
    description:
      'Wait for background tasks. Returns as soon as any task in `task_ids` finishes, `until` (a regex) matches its output, ' +
      `or \`timeout_ms\` elapses (default ${DEFAULT_WAIT_TIMEOUT_MS}). With no task_ids it waits on every running task in this conversation ` +
      '(returning at once with any that finished since you last heard), and only sleeps for timeout_ms when there are none. ' +
      'Every task writes its full output to output_file, which you can read_file or search.',
    label: 'Wait',
    parameters: Type.Object({
      task_ids: Type.Optional(Type.Array(Type.String(), { description: 'Task ids to wait on (default: every running task)' })),
      timeout_ms: Type.Optional(
        Type.Number({ description: `Max milliseconds to wait (default ${DEFAULT_WAIT_TIMEOUT_MS}, max ${MAX_WAIT_TIMEOUT_MS}). 0 = check without blocking.` }),
      ),
      until: Type.Optional(Type.String({ description: 'Regex; return early once a task\'s output matches (e.g. "ready on port")' })),
    }),
    execute: async (toolCallId, params, signal) => {
      const { timeout_ms = DEFAULT_WAIT_TIMEOUT_MS, until } = params as {
        task_ids?: string[]
        timeout_ms?: number
        until?: string
      }
      let task_ids = (params as { task_ids?: string[] }).task_ids ?? []
      if (task_ids.length === 0 && ctx.commandRegistry) {
        task_ids = [
          ...ctx.commandRegistry.peekNotifications().map((n) => n.taskId),
          ...ctx.commandRegistry.listRunning().map((t) => t.id),
        ]
      }
      const timeoutMs = Math.min(Math.max(0, timeout_ms), MAX_WAIT_TIMEOUT_MS)
      const startedAt = Date.now()

      let regex: RegExp | undefined
      if (until) {
        try {
          regex = new RegExp(until, 'm')
        } catch (err: any) {
          return textResult({ error: `Invalid until regex: ${err?.message || String(err)}` })
        }
      }

      if (task_ids.length === 0) {
        await new Promise<void>((resolve) => {
          if (timeoutMs === 0 || signal?.aborted) return resolve()
          const t = setTimeout(resolve, timeoutMs)
          signal?.addEventListener('abort', () => { clearTimeout(t); resolve() }, { once: true })
        })
        return textResult({ status: 'slept', elapsed_ms: Date.now() - startedAt })
      }

      const registry = ctx.commandRegistry
      if (!registry) return textResult({ error: 'Background tasks are not available in this context.' })

      // A result whose entry was evicted is still in its output file, so a late
      // `wait` recovers it instead of claiming the task never existed.
      const unknown: string[] = []
      for (const id of task_ids) {
        if (registry.get(id)) continue
        if (await registry.resolveFinished(id)) continue
        unknown.push(id)
      }
      if (unknown.length === task_ids.length) {
        const paths = unknown.map((id) => registry.outputPathFor(id)).filter((p): p is string => !!p)
        return textResult({
          error:
            `Unknown task id${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')} — not in this conversation's tasks, ` +
            `and no output file to recover a result from${paths.length ? ` (looked at ${paths.join(', ')})` : ''}. ` +
            'Call task_list for the tasks that are still here.',
          code: 'task_result_gone',
          ...(paths.length ? { output_file: paths.join(', ') } : {}),
          hint: 'Call task_list for the tasks that are still here.',
        })
      }

      const ids = task_ids.filter((id) => registry.get(id))

      // Waiting again on the same tasks after two full timeouts teaches nothing:
      // the [Task update] is already guaranteed, so the third call stops here —
      // unless something settled meanwhile, which the agent must still be told.
      const waitKey = [...ids].sort().join(',')
      const timeoutsSpent = turnSteeringState(ctx).waitTimeouts.get(waitKey) ?? 0
      if (timeoutMs > 0 && timeoutsSpent >= 2) {
        const settled = ids.map((id) => registry.get(id)!).find((e) => e.status !== 'running')
        if (settled) {
          turnSteeringState(ctx).waitTimeouts.delete(waitKey)
          registry.markConsumed([settled.id])
          return textResult({
            ...finishedTaskResult(ctx, settled),
            waited_ms: 0,
            ...(unknown.length ? { unknown_task_ids: unknown } : {}),
            still_running: ids
              .map((id) => registry.get(id)!)
              .filter((e) => e.id !== settled.id && e.status === 'running')
              .map((e) => e.id),
          })
        }
        return textResult({
          status: 'timeout',
          code: 'stop_waiting',
          repeated: timeoutsSpent,
          waited_ms: 0,
          tasks: ids.map((id) => taskView(ctx, registry.get(id)!)),
          hint:
            'Stop waiting — end your turn. The [Task update] is guaranteed when it finishes, and waiting again only ' +
            'spends another timeout.',
        })
      }

      const emitWait = (active: boolean) => {
        try {
          ctx.uiWriter?.write({
            type: 'data-task-wait',
            data: { toolCallId, taskIds: ids.map((id) => registry.get(id)!.id), until, timeoutMs, startedAt, active },
            transient: true,
          } as any)
        } catch { /* writer closed */ }
      }

      if (timeoutMs > 0) emitWait(true)
      let outcome: Awaited<ReturnType<typeof registry.wait>>
      try {
        outcome = await registry.wait(ids, { timeoutMs, until: regex, signal })
      } finally {
        if (timeoutMs > 0) emitWait(false)
      }

      if (outcome.kind === 'finished' && outcome.task) {
        turnSteeringState(ctx).waitTimeouts.delete(waitKey)
        return textResult({
          ...finishedTaskResult(ctx, outcome.task),
          ...(unknown.length ? { unknown_task_ids: unknown } : {}),
          still_running: ids
            .map((id) => registry.get(id)!)
            .filter((e) => e.id !== outcome.task!.id && e.status === 'running')
            .map((e) => e.id),
        })
      }

      if (outcome.kind === 'matched' && outcome.task) {
        turnSteeringState(ctx).waitTimeouts.delete(waitKey)
        return textResult({
          ...taskView(ctx, outcome.task),
          matched: outcome.matched,
          output: truncateExecOutput(tailLines(stripAnsiForPattern(registry.readOutput(outcome.task)), 60, 8000)),
        })
      }

      if (timeoutMs > 0) turnSteeringState(ctx).waitTimeouts.set(waitKey, timeoutsSpent + 1)
      return textResult({
        status: 'timeout',
        waited_ms: Date.now() - startedAt,
        tasks: ids.map((id) => taskView(ctx, registry.get(id)!)),
        ...(unknown.length ? { unknown_task_ids: unknown } : {}),
        hint: 'Still running. Wait again, or end your turn and you will get a [Task update] when it finishes.',
      })
    },
  }
}

function createTaskListTool(ctx: ToolContext): AgentTool {
  return {
    name: 'task_list',
    description: 'List the background tasks of this conversation (running and recently finished) with their status and output_file.',
    label: 'List Tasks',
    parameters: Type.Object({}),
    execute: async () => {
      const registry = ctx.commandRegistry
      if (!registry) return textResult({ tasks: [] })
      await registry.refreshRemote()
      return textResult({
        tasks: registry.listAll().map((t) => ({
          task_id: t.id,
          source: t.source,
          title: t.title,
          // A stale row is one the restart ended, not one we cannot name.
          status: t.stale ? 'interrupted (runtime restarted)' : t.status,
          elapsed_ms: t.elapsedMs,
          ...(registry.displayExistingPath(t.outputFile) ? { output_file: registry.displayExistingPath(t.outputFile) } : {}),
        })),
      })
    },
  }
}

function createTaskCancelTool(ctx: ToolContext): AgentTool {
  return {
    name: 'task_cancel',
    description: 'Cancel a background task you started (stops the command, subagent, or tracking). Reports the processes still running if the tree could not be emptied.',
    label: 'Cancel Task',
    parameters: Type.Object({
      task_id: Type.String({ description: 'Task id to cancel' }),
    }),
    execute: async (_id, params) => {
      const { task_id } = params as { task_id: string }
      const registry = ctx.commandRegistry
      const entry = registry?.get(task_id)
      if (!registry || !entry) return textResult({ error: `Unknown task id: ${task_id}` })
      // `cancelled` is a claim about the process tree, not about the signal we
      // sent: the registry waits for the kill to be verified and tells us what
      // is still running (SHO-144).
      const { survivors } = await registry.cancel(entry.id)
      const status = registry.get(entry.id)?.status ?? 'cancelled'
      if (survivors.length > 0) {
        return textResult({
          ok: false,
          task_id: entry.id,
          status: 'cancel_incomplete',
          survivors,
          hint: survivorHint(survivors),
        })
      }
      return textResult({ ok: true, task_id: entry.id, status, survivors: [] })
    },
  }
}

const IMAGE_READ_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif',
  '.heic': 'image/heic',
  '.ico': 'image/x-icon',
}
const MAX_IMAGE_READ_BYTES = 20 * 1024 * 1024

const BINARY_EXTENSION_LABELS: Record<string, { label: string; mediaType: string }> = {
  '.zip': { label: 'ZIP archive', mediaType: 'application/zip' },
  '.gz': { label: 'gzip archive', mediaType: 'application/gzip' },
  '.tgz': { label: 'gzip archive', mediaType: 'application/gzip' },
  '.tar': { label: 'tar archive', mediaType: 'application/x-tar' },
  '.bz2': { label: 'bzip2 archive', mediaType: 'application/x-bzip2' },
  '.xz': { label: 'xz archive', mediaType: 'application/x-xz' },
  '.7z': { label: '7-Zip archive', mediaType: 'application/x-7z-compressed' },
  '.rar': { label: 'RAR archive', mediaType: 'application/vnd.rar' },
  '.pdf': { label: 'PDF document', mediaType: 'application/pdf' },
  '.doc': { label: 'Word document', mediaType: 'application/msword' },
  '.docx': {
    label: 'Word document',
    mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  },
  '.xls': { label: 'Excel spreadsheet', mediaType: 'application/vnd.ms-excel' },
  '.xlsx': {
    label: 'Excel spreadsheet',
    mediaType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  },
  '.ppt': {
    label: 'PowerPoint presentation',
    mediaType: 'application/vnd.ms-powerpoint',
  },
  '.pptx': {
    label: 'PowerPoint presentation',
    mediaType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  },
  '.sqlite': { label: 'SQLite database', mediaType: 'application/vnd.sqlite3' },
  '.db': { label: 'database file', mediaType: 'application/octet-stream' },
  '.mp3': { label: 'MP3 audio', mediaType: 'audio/mpeg' },
  '.wav': { label: 'WAV audio', mediaType: 'audio/wav' },
  '.mp4': { label: 'MP4 video', mediaType: 'video/mp4' },
  '.mov': { label: 'QuickTime video', mediaType: 'video/quicktime' },
  '.exe': {
    label: 'Windows executable',
    mediaType: 'application/vnd.microsoft.portable-executable',
  },
  '.bin': { label: 'binary file', mediaType: 'application/octet-stream' },
  '.so': { label: 'shared object', mediaType: 'application/octet-stream' },
  '.dylib': { label: 'dynamic library', mediaType: 'application/octet-stream' },
  '.dll': {
    label: 'dynamic link library',
    mediaType: 'application/octet-stream',
  },
  '.class': { label: 'Java class', mediaType: 'application/java-vm' },
  '.jar': { label: 'Java archive', mediaType: 'application/java-archive' },
  '.wasm': { label: 'WebAssembly module', mediaType: 'application/wasm' },
}

/**
 * Heuristic: returns binary metadata when the file is clearly binary (NUL byte
 * in the first chunk, or known archive/binary magic bytes / extension).
 * Returns null for plain text — including UTF-8 with BOM and CRLF.
 */
function detectBinaryContent(buf: Buffer, absolutePath: string): { label: string; mediaType: string } | null {
  const ext = extname(absolutePath).toLowerCase()
  const known = BINARY_EXTENSION_LABELS[ext]
  if (known) return known

  if (buf.length === 0) return null

  // Quick magic-byte check for common archives even if extension is missing.
  if (buf.length >= 4) {
    if (buf[0] === 0x50 && buf[1] === 0x4b && (buf[2] === 0x03 || buf[2] === 0x05 || buf[2] === 0x07)) {
      return { label: 'ZIP archive', mediaType: 'application/zip' }
    }
    if (buf[0] === 0x1f && buf[1] === 0x8b) {
      return { label: 'gzip archive', mediaType: 'application/gzip' }
    }
    if (buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46) {
      return { label: 'PDF document', mediaType: 'application/pdf' }
    }
    if (buf[0] === 0x37 && buf[1] === 0x7a && buf[2] === 0xbc && buf[3] === 0xaf) {
      return {
        label: '7-Zip archive',
        mediaType: 'application/x-7z-compressed',
      }
    }
    if (buf[0] === 0x52 && buf[1] === 0x61 && buf[2] === 0x72 && buf[3] === 0x21) {
      return { label: 'RAR archive', mediaType: 'application/vnd.rar' }
    }
  }

  // Generic NUL-byte heuristic on the first 8 KB.
  const sampleLen = Math.min(buf.length, 8 * 1024)
  for (let i = 0; i < sampleLen; i++) {
    if (buf[i] === 0) {
      return { label: 'binary file', mediaType: 'application/octet-stream' }
    }
  }
  return null
}

/** A read without offset/limit stops at whichever of these comes first. */
const MAX_FULL_READ_LINES = 2000
const MAX_FULL_READ_CHARS = 60_000

function createReadFileTool(ctx: ToolContext): AgentTool {
  return {
    name: 'read_file',
    description:
      `Read a file from the agent workspace. Prefer this over \`exec\` with \`cat\`/\`head\`/\`tail\`. Supports partial reads via offset and limit to handle large files without consuming the full context window. \`offset\` is a 1-based line number (e.g. offset: 380) or a [start, end] tuple (e.g. offset: [380, 420]); \`limit\` is a line count (e.g. limit: 40). When using offset/limit, output includes line numbers in N|content format. For large files (500+ lines), prefer offset/limit, or ${isSearchEnabled() ? 'use the `search` tool' : 'run `rg -n` via `exec`'} to find the relevant section first. When called on an image file (.png, .jpg, .jpeg, .gif, .webp, .bmp, .avif, .heic, .ico), the image is returned as multimodal image content for vision-capable models to view or describe; offset/limit are ignored for images, and images larger than 20 MB are rejected.`,
    label: 'Read File',
    parameters: Type.Object({
      path: Type.String({ description: 'File path relative to workspace' }),
      // Tolerant union: weak models frequently send a stringified number
      // ("380") or an object ({ start, end } / { offset, limit }) instead of
      // the canonical number|number[]. Accept those shapes here so the input
      // validator doesn't reject the call; execute() normalizes them below.
      offset: Type.Optional(
        Type.Union([
          Type.Number({
            description: 'Line number to start reading from (1-based). Example: offset: 380',
          }),
          Type.Array(Type.Number(), {
            description: 'Tuple [start, end] line range. Example: offset: [380, 420]',
          }),
          Type.String({
            description: 'Stringified start line (coerced to a number), e.g. "380"',
          }),
          Type.Object(
            {
              start: Type.Optional(Type.Number()),
              end: Type.Optional(Type.Number()),
              offset: Type.Optional(Type.Number()),
              limit: Type.Optional(Type.Number()),
            },
            {
              description: 'Object range form, e.g. { start, end } or { offset, limit }',
            },
          ),
        ]),
      ),
      limit: Type.Optional(
        Type.Union([
          Type.Number({
            description: 'Number of lines to read. Example: limit: 40',
          }),
          Type.String({
            description: 'Stringified line count (coerced to a number), e.g. "40"',
          }),
        ]),
      ),
    }),
    execute: async (_toolCallId, params) => {
      const raw = params as {
        path: string
        offset?: number | number[] | string | Record<string, unknown>
        limit?: number | string
      }
      const filePath = raw.path
      // Normalize tolerant offset/limit shapes into numbers. Anything that
      // can't be coerced is dropped (treated as "not provided") rather than
      // erroring the call — this is the single largest production tool-error
      // class for weak models (malformed read_file offset).
      const coerceNum = (v: unknown): number | undefined => {
        if (typeof v === 'number') return Number.isFinite(v) ? v : undefined
        if (typeof v === 'string') {
          const n = Number(v.trim())
          return v.trim() !== '' && Number.isFinite(n) ? n : undefined
        }
        return undefined
      }
      let offset: number | undefined
      let limit: number | undefined = coerceNum(raw.limit)
      if (Array.isArray(raw.offset)) {
        const sorted = raw.offset
          .map(coerceNum)
          .filter((n): n is number => n !== undefined)
          .sort((a, b) => a - b)
        if (sorted.length > 0) {
          offset = sorted[0]
          if (limit === undefined && sorted.length > 1) limit = sorted[sorted.length - 1] - sorted[0]
        }
      } else if (raw.offset !== null && typeof raw.offset === 'object') {
        const o = raw.offset as Record<string, unknown>
        offset = coerceNum(o.start) ?? coerceNum(o.offset) ?? coerceNum(o.from)
        const end = coerceNum(o.end) ?? coerceNum(o.to)
        if (limit === undefined) {
          limit = coerceNum(o.limit) ?? (end !== undefined && offset !== undefined ? end - offset : undefined)
        }
      } else {
        offset = coerceNum(raw.offset)
      }
      const resolved = assertWithinWorkspace(ctx.workspaceDir, filePath, pathPolicy(ctx))
      const readTrust = assertAllowedPath(resolved, 'read', ctx.workspaceDir, pathPolicy(ctx))
      if (!readTrust.ok && readTrust.reason === 'other_project_path') return textResult({ error: readTrust.message })
      if (!existsSync(resolved)) {
        const hint = bogusPathPrefixHint(ctx.workspaceDir, filePath)
        return textResult({
          error: hint ? `File not found: ${filePath}\n${hint}` : `File not found: ${filePath}`,
        })
      }
      try {
        const stat = statSync(resolved)
        if (stat.isDirectory()) {
          const entries = readdirSync(resolved, { withFileTypes: true })
            .filter((e) => !e.name.startsWith('.') && e.name !== 'node_modules')
            .map((e) => {
              const absPath = join(resolved, e.name)
              const s = statSync(absPath)
              const relPath = absPath.slice(resolve(ctx.workspaceDir).length + 1)
              return e.isDirectory()
                ? { name: e.name, path: relPath, type: 'directory' as const }
                : {
                    name: e.name,
                    path: relPath,
                    type: 'file' as const,
                    size: s.size,
                  }
            })
          return textResult({
            note: `"${filePath}" is a directory, not a file. Listing its contents instead.`,
            path: filePath,
            entries,
            count: entries.length,
          })
        }
      } catch {
        /* proceed to read */
      }

      const imageExt = extname(resolved).toLowerCase()
      const imageMime = IMAGE_READ_MIME[imageExt]
      if (imageMime) {
        try {
          const imgStat = statSync(resolved)
          if (imgStat.size > MAX_IMAGE_READ_BYTES) {
            return textResult({
              error:
                `Image too large to read: ${filePath} (${imgStat.size} bytes, max ${MAX_IMAGE_READ_BYTES}). ` +
                'Downscale the image before reading.',
            })
          }
          const buf = readFileSync(resolved)
          const base64 = buf.toString('base64')
          if (base64.length > MAX_IMAGE_BASE64_BYTES) {
            const details = {
              path: filePath,
              bytes: buf.length,
              base64Bytes: base64.length,
              mimeType: imageMime,
              error:
                `Image too large to send to the model: ${filePath} ` +
                `(${buf.length} raw bytes / ${base64.length} base64 bytes, ` +
                `cap is ${MAX_IMAGE_BASE64_BYTES} base64 bytes). ` +
                'Downscale before reading, e.g. on macOS: ' +
                `\`sips -Z 1024 "${filePath}" --out "${filePath}.small.png"\`, ` +
                `or with ImageMagick: \`convert "${filePath}" -resize 1024x1024 "${filePath}.small.png"\`, ` +
                'then read the resized file.',
            }
            return textResult(details)
          }
          const initialContent = [
            { type: 'image' as const, data: base64, mimeType: imageMime },
            {
              type: 'text' as const,
              text: JSON.stringify({
                path: filePath,
                bytes: buf.length,
                mimeType: imageMime,
                ...(offset !== undefined || limit !== undefined ? { note: 'offset/limit are ignored for image files.' } : {}),
              }),
            },
          ]
          const safeContent = enforceImageSizeLimit(initialContent, {
            label: 'read_file',
            pathHint: filePath,
          })
          const details = {
            path: filePath,
            bytes: buf.length,
            mimeType: imageMime,
            ...(offset !== undefined || limit !== undefined ? { note: 'offset/limit are ignored for image files.' } : {}),
          }
          return { content: safeContent, details }
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err)
          return textResult({
            error: `Failed to read image file: ${filePath} — ${msg}`,
          })
        }
      }

      const rawBytes = readFileSync(resolved)
      const binaryInfo = detectBinaryContent(rawBytes, resolved)
      if (binaryInfo) {
        return textResult({
          path: filePath,
          bytes: rawBytes.length,
          mediaType: binaryInfo.mediaType,
          binary: true,
          error:
            `File "${filePath}" appears to be a ${binaryInfo.label} (${rawBytes.length} bytes). ` +
            'Binary content cannot be read as text. ' +
            'Use the shell `exec` tool with the appropriate command (e.g. `unzip`, `tar -xzf`, `pdftotext`, ' +
            '`file`) to inspect or extract it, or hand the path to a parser tool that understands this format.',
        })
      }
      const fullContent = rawBytes.toString('utf-8')

      const totalLineCount = fullContent.split('\n').length
      const mtime = statSync(resolved).mtimeMs

      if (offset !== undefined || limit !== undefined) {
        const lines = fullContent.split('\n')
        const startLine = Math.max(0, ((offset as number) ?? 1) - 1)
        const endLine = limit !== undefined ? startLine + limit : lines.length
        const sliced = lines.slice(startLine, endLine)
        const numberedLines = sliced.map((line, i) => `${startLine + i + 1}|${line}`)
        ctx.fileStateCache?.recordRead(
          filePath,
          mtime,
          totalLineCount,
          {
            offset: startLine + 1,
            limit: Math.min(endLine, lines.length) - startLine,
          },
          undefined,
        )
        return textResult({
          content: numberedLines.join('\n'),
          totalLines: lines.length,
          startLine: startLine + 1,
          endLine: Math.min(endLine, lines.length),
        })
      }

      if (totalLineCount > MAX_FULL_READ_LINES || fullContent.length > MAX_FULL_READ_CHARS) {
        const lines = fullContent.split('\n')
        const kept: string[] = []
        let chars = 0
        for (const line of lines) {
          const numbered = `${kept.length + 1}|${line}`
          if (kept.length >= MAX_FULL_READ_LINES || chars + numbered.length + 1 > MAX_FULL_READ_CHARS) break
          kept.push(numbered)
          chars += numbered.length + 1
        }
        if (kept.length === 0) kept.push(`1|${lines[0].slice(0, MAX_FULL_READ_CHARS - 2)}`)
        ctx.fileStateCache?.recordRead(filePath, mtime, totalLineCount, { offset: 1, limit: kept.length }, undefined)
        return textResult({
          content: kept.join('\n'),
          totalLines: totalLineCount,
          startLine: 1,
          endLine: kept.length,
          truncated: true,
          note:
            `File too large to read whole (${totalLineCount} lines, ${fullContent.length} chars); showing lines 1-${kept.length}. ` +
            `Continue with offset: ${kept.length + 1}, or use the \`search\` tool to find the section you need.`,
        })
      }

      ctx.fileStateCache?.recordRead(filePath, mtime, totalLineCount, undefined, fullContent)
      const result: Record<string, any> = {
        content: fullContent,
        bytes: fullContent.length,
      }
      if (totalLineCount > 500) {
        result.totalLines = totalLineCount
        result.note = `Large file (${totalLineCount} lines). Use offset/limit to read specific sections (e.g. offset: 380, limit: 40), or ${isSearchEnabled() ? 'the `search` tool' : '`rg -n` via `exec`'} to find the code you need. Reading the whole file wastes context.`
      }
      return textResult(result)
    },
  }
}

/**
 * If the workspace graph is available, append a brief impact note to the
 * tool result indicating how many files reference the changed file.
 */
function appendImpactHint(ctx: ToolContext, filePath: string, result: Record<string, unknown>): void {
  try {
    const graph = ctx.workspaceGraph
    if (!graph) return

    const impact = graph.getImpactRadius([filePath], 1, 20)
    if (impact.impactedFiles.length > 0) {
      result.impact_note =
        `This file is referenced by ${impact.impactedFiles.length} other file(s): ${impact.impactedFiles
          .slice(0, 5)
          .join(', ')}${impact.impactedFiles.length > 5 ? ` and ${impact.impactedFiles.length - 5} more` : ''}. ` +
        'For a full blast-radius analysis, delegate to the explore or code-reviewer subagent (they have impact_radius).'
    }
  } catch {
    /* best-effort — do not fail the write */
  }
}

/**
 * Best-effort lint feedback attached to write_file/edit_file results so weak
 * models get immediate diagnostics without having to remember `read_lints`.
 * Lightweight by design: only runs when the LSP is already up, queries a single
 * file, and is hard-capped on time — if diagnostics aren't ready it omits the
 * field silently. This is feedback, NOT a gate (the agent is free to ignore it).
 */
async function attachEditDiagnostics(ctx: ToolContext, filePath: string, resolved: string, base: Record<string, unknown>): Promise<void> {
  try {
    if (!LINTABLE_EXTENSION_RE.test(filePath)) return
    if (filePath.endsWith('.d.ts') || filePath.endsWith('.pyi')) return
    const lsp = ctx.getLspManager?.() ?? ctx.lspManager
    if (!lsp || !lsp.isRunning()) return

    const uri = `file://${resolved}`
    const TS_RETURN_OUTSIDE_FN = 1108
    // Small settle so the LSP recomputes after notifyFileChanged, hard-capped
    // so this never adds more than ~1.2s of latency to an edit.
    const diagsMap = await Promise.race([
      (async () => {
        await new Promise((r) => setTimeout(r, 300))
        return lsp.getDiagnosticsAsync(uri)
      })(),
      new Promise<null>((r) => setTimeout(() => r(null), 1200)),
    ])
    if (!diagsMap) return

    let diags = diagsMap.get(uri)
    if (!diags) {
      for (const [u, d] of diagsMap) {
        if (u === uri || u.endsWith(filePath)) {
          diags = d
          break
        }
      }
    }
    diags = diags ?? []

    const errors = diags
      .filter((d) => (d.severity ?? 1) === 1)
      .filter((d) => d.code !== TS_RETURN_OUTSIDE_FN)
      .map((d) => `Line ${d.range.start.line + 1}: ${d.message}`)

    if (errors.length === 0) {
      base.lint = { ok: true }
      return
    }
    base.lint = {
      ok: false,
      errorCount: errors.length,
      errors: errors.slice(0, 5),
      hint: 'This edit introduced type/lint errors (above). Fix them with edit_file — you do not need to call read_lints first.',
    }
  } catch {
    /* best-effort — never fail an edit because diagnostics couldn't be fetched */
  }
}

/**
 * Surface pending canvas/runtime errors (compile/render failures reported by
 * the live preview) directly on a write/edit result so the agent sees runtime
 * failures in-band, without having to remember to call read_lints (WS3). The
 * buffer is consume-once (same as read_lints), so a fixed error stops
 * re-appearing once the preview reloads cleanly.
 */
function attachCanvasRuntimeErrors(base: Record<string, unknown>): void {
  try {
    const entries = getCanvasRuntimeErrors()
    if (entries.length === 0) return
    base.runtimeErrors = entries.slice(-5).map((e) => `[${e.phase}] ${e.error}`)
    base.runtimeErrorHint =
      'The live preview reported the runtime error(s) above. Fix the underlying cause (the data shape / contract, not just the throwing line) and re-verify. If the same class of error appears in multiple places, fix them all in one pass.'
    clearCanvasRuntimeErrors()
  } catch {
    /* best-effort */
  }
}

function createWriteFileTool(ctx: ToolContext): AgentTool {
  return {
    name: 'write_file',
    description:
      'Create a NEW file in the agent workspace. Creates parent directories as needed. ' +
      'WARNING: Do NOT use write_file to modify existing files — use edit_file instead. ' +
      'write_file overwrites the entire file which risks losing code. Only use for creating brand-new files. ' +
      'For a binary file (PDF, image, STL, spreadsheet), pass encoding: "base64" and base64 content. ' +
      'Scratch files go in .tmp/ — a /tmp path is rewritten there.',
    label: 'Write File',
    parameters: Type.Object({
      path: Type.String({ description: 'File path relative to workspace. /tmp/... is rewritten to .tmp/...' }),
      content: Type.String({
        description: 'Content to write. UTF-8 text, or base64 when encoding is "base64". Pass "" for an empty file.',
        'x-empty-ok': true,
      }),
      append: Type.Optional(
        Type.Boolean({
          description: 'Append instead of overwrite (default: false). Ignored for base64 writes.',
        }),
      ),
      encoding: Type.Optional(
        Type.Union([Type.Literal('utf-8'), Type.Literal('base64')], {
          description: 'utf-8 (default) or base64. base64 is required for binary files.',
        }),
      ),
      overwrite: Type.Optional(
        Type.Boolean({
          description:
            'Only for memory files (MEMORY.md, AGENTS.md, TOOLS.md, HEARTBEAT.md, STACK.md, memory/*.md): ' +
            'allow replacing the file with less than half of its current content. Default: refuse (memory_shrink_guard).',
        }),
      ),
    }),
    execute: async (_toolCallId, params) => {
      const {
        path: requestedPath,
        content,
        append,
        encoding,
        overwrite,
      } = params as {
        path: string
        content: string
        append?: boolean
        encoding?: 'utf-8' | 'base64'
        overwrite?: boolean
      }
      const scratch = scratchPathForWrite(ctx.workspaceDir, requestedPath)
      const filePath = scratch.path
      const resolved = assertWithinWorkspace(ctx.workspaceDir, filePath, pathPolicy(ctx))
      const scratchFields = scratch.remappedFrom
        ? {
            remappedFrom: scratch.remappedFrom,
            note: `Wrote ${filePath} instead of ${scratch.remappedFrom}. /tmp is outside the workspace; scratch files go in .tmp/.`,
          }
        : {}
      // Workspace Trust gate for external (VS Code-style) projects.
      // For managed projects (the historical case) `assertAllowedPath`
      // returns ok=true because trustLevel is 'trusted' by default.
      const trustCheck = assertAllowedPath(resolved, 'write', ctx.workspaceDir, pathPolicy(ctx))
      if (!trustCheck.ok) return textResult({ error: trustCheck.message })
      const protectedRejection = rejectIfProtected(ctx, resolved)
      if (protectedRejection) return protectedRejection
      if (encoding === 'base64') {
        const compact = content.replace(/\s/g, '')
        if (!compact || compact.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(compact)) {
          return textResult({ error: 'content is not valid base64. Pass raw base64 with encoding: "base64".' })
        }
        const buf = Buffer.from(compact, 'base64')
        const dirForBinary = dirname(resolved)
        if (dirForBinary && dirForBinary !== resolved) mkdirSync(dirForBinary, { recursive: true })
        writeFileSync(resolved, buf)
        ctx.fileStateCache?.invalidate(filePath)
        return textResult({
          ok: true,
          path: filePath,
          bytes: buf.length,
          encoding: 'base64',
          ...scratchFields,
        })
      }
      if (isBinaryFilePath(filePath)) {
        return textResult({
          error: `Refusing to write binary file "${filePath}" as UTF-8 text. Call write_file again with encoding: "base64" and base64 content.`,
        })
      }
      const dir = dirname(resolved)
      if (dir && dir !== resolved) mkdirSync(dir, { recursive: true })

      // Memory-file protection (SHO-61). A whole-file write to MEMORY.md /
      // AGENTS.md / memory/*.md is one keystroke from erasing everything the
      // agent learned, so: refuse a >50 % shrink unless the caller says
      // `overwrite: true`, and keep a copy of the previous bytes either way.
      let memoryHistoryCopy: string | null = null
      if (isMemoryFilePath(filePath)) {
        const rejection = memoryShrinkGuard(ctx.workspaceDir, filePath, content, {
          overwrite,
          append,
        })
        if (rejection) return textResult({ ...rejection })
        memoryHistoryCopy = snapshotMemoryFile(ctx.workspaceDir, filePath)
      }

      // Resolve target line endings: honor an existing file's detected
      // ending (which itself honors .gitattributes via readFileWithMetadata),
      // otherwise honor .gitattributes for the new path, otherwise LF.
      const fileExists = existsSync(resolved)
      const target: LineEndingType = fileExists
        ? readFileWithMetadata(resolved).targetLineEndings
        : (resolveLineEndingPolicy(resolved) ?? 'LF')

      const payload = append ? (fileExists ? readFileSync(resolved, 'utf-8') : '') + content : content
      writeWithMetadata(resolved, payload, 'utf-8', target)
      // Record post-write read-state (instead of invalidating) so a follow-up
      // edit_file on this path doesn't trip the read-before-edit guard. Weak
      // models often write_file an existing file then edit_file it; invalidating
      // forced a spurious "File has not been read yet". payload is the final
      // on-disk content (already existing+content for append).
      try {
        const writeMtime = statSync(resolved).mtimeMs
        ctx.fileStateCache?.recordEdit(filePath, payload, writeMtime)
      } catch {
        ctx.fileStateCache?.invalidate(filePath)
      }
      markEditedIfLintable(ctx, filePath)
      ctx.canvasFileWatcher?.onFileChanged(filePath, resolved)

      if (ctx.lspManager && LINTABLE_EXTENSION_RE.test(filePath)) {
        const finalContent = append ? (existsSync(resolved) ? readFileSync(resolved, 'utf-8') : content) : content
        ctx.lspManager.notifyFileChanged(resolved, finalContent)
      }

      const base: Record<string, unknown> = {
        ok: true,
        path: filePath,
        bytes: content.length,
        ...scratchFields,
      }
      if (memoryHistoryCopy) {
        base.memoryHistory = memoryHistoryCopy
        base.memoryHistoryHint =
          'The previous version of this memory file is saved at memoryHistory (read it with read_file) if you need to restore anything.'
      }
      appendImpactHint(ctx, filePath, base)
      // Canvas-API contract hint: surfaced eagerly on every write so the
      // agent doesn't have to wait for an eval / runtime check to learn
      // that a fresh `fetch('/api/X')` references a non-existent route.
      // Use the final file content (post-append for append=true).
      const finalContentForLint = append ? (existsSync(resolved) ? readFileSync(resolved, 'utf-8') : content) : content
      appendCanvasApiContractHint(ctx, filePath, finalContentForLint, base)
      await attachEditDiagnostics(ctx, filePath, resolved, base)
      attachCanvasRuntimeErrors(base)
      const quickActionsResult = maybeValidateQuickActions(filePath, resolved, base)
      if (quickActionsResult) return textResult(quickActionsResult)
      const schemaResult = await maybeSchemaSync(ctx, filePath, resolved, base)
      return textResult(schemaResult ?? base)
    },
  }
}

/**
 * If the file is .shogo/server/schema.prisma, sync the skill server and
 * return an enriched result.  Otherwise returns null (caller uses default).
 */
/**
 * Static fetch-path regex shared between the workspace-wide scanner
 * (`findOrphanedFetches`) and the per-file content scanner
 * (`findOrphanedFetchesInContent`). Matches:
 *   - `fetch('/api/leads')`            (relative)
 *   - `fetch("http://localhost:3001/api/leads")` (absolute, dev only)
 * Capture group 1 is the **first** path segment after `/api/`. We exclude
 * `$` from the character class so a template-literal interpolation like
 * `` fetch(`/api/${id}`) `` doesn't get mis-parsed as the literal segment
 * `${id}`. Dynamic paths are deliberately treated as "always valid" —
 * static analysis can't tell what `${id}` resolves to, so flagging them
 * would be a false positive.
 */
const CANVAS_API_FETCH_PATTERN = /fetch\(\s*[`"'](?:https?:\/\/localhost:\d+)?\/api\/([^`"'/\s?$]+)/g

/**
 * Scan one file's content for static `/api/<seg>` fetches that don't
 * match any active server route. Used by the write-time canvas-API
 * contract hint in `createWriteFileTool` / `commitEdit` so the agent
 * sees the warning *the moment they introduce the bad fetch*, instead of
 * having to wait for the next eval / runtime check.
 */
function findOrphanedFetchesInContent(content: string, activeRoutes: string[]): string[] {
  // String.prototype.matchAll() takes a snapshot of the regex source/flags
  // and uses its own iterator state, so it's safe to call against the
  // shared `CANVAS_API_FETCH_PATTERN` constant even across concurrent
  // tool calls.
  const routeSet = new Set(activeRoutes.map((r) => r.toLowerCase()))
  const orphaned = new Set<string>()
  for (const m of content.matchAll(CANVAS_API_FETCH_PATTERN)) {
    if (!routeSet.has(m[1].toLowerCase())) {
      orphaned.add(`/api/${m[1]}`)
    }
  }
  return [...orphaned]
}

/**
 * First path segments of the routes registered in the project's
 * `custom-routes.ts` (mounted under `/api/`), so fetches to custom routes
 * aren't reported as orphaned. Comments are stripped first: the template
 * file documents example routes in comments that aren't actually mounted.
 */
function customRouteSegments(workspaceDir: string): string[] {
  const file = ['custom-routes.ts', 'custom-routes.tsx'].map((f) => join(workspaceDir, f)).find((f) => existsSync(f))
  if (!file) return []
  let source: string
  try {
    source = readFileSync(file, 'utf-8')
  } catch {
    return []
  }
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
  const segments = new Set<string>()
  for (const m of code.matchAll(/\.(?:get|post|put|patch|delete|all|route|use)\(\s*[`"']\/([^`"'/\s?:*$]+)/g)) {
    segments.add(m[1])
  }
  return [...segments]
}

/**
 * Path filter: should this file be checked for canvas-API contract
 * violations? Only `.ts(x)` / `.js(x)` files inside `src/` or `canvas/`
 * (not the generated CRUD output, which by definition matches the routes
 * it generates).
 */
function shouldLintCanvasApiContract(filePath: string): boolean {
  if (!/\.(tsx?|jsx?)$/.test(filePath)) return false
  const normalized = filePath.replace(/\\/g, '/')
  if (normalized.startsWith('src/generated/') || normalized.includes('/src/generated/')) return false
  return (
    normalized.startsWith('src/') || normalized.startsWith('canvas/') || normalized.includes('/src/') || normalized.includes('/canvas/')
  )
}

/**
 * Side-effecting helper: when the just-written/edited file fetches
 * `/api/<seg>` for a segment with no matching backend route, append a
 * `canvasApiContract` field to the tool result so the agent is reminded
 * to either add a Prisma model (auto-CRUD) or a custom Hono route.
 *
 * No-ops when:
 *   - The path isn't lint-eligible (see `shouldLintCanvasApiContract`).
 *   - There's no skill server (so we have no route list to compare to).
 *   - All fetches resolve to known routes.
 *
 * This complements the workspace-wide scan that runs after schema syncs
 * (`maybeSchemaSync`) — that catches drift across the project, while
 * this catches the specific fetch the agent just wrote.
 */
function appendCanvasApiContractHint(ctx: ToolContext, filePath: string, content: string, base: Record<string, unknown>): void {
  if (!ctx.skillServerManager) return
  if (!shouldLintCanvasApiContract(filePath)) return
  // Cheap pre-check using includes() so we don't pay for the regex / route
  // lookup on every tool call (the vast majority of writes won't have
  // any /api/ fetches at all).
  if (!content.includes('/api/')) return

  let activeRoutes: string[] = []
  try {
    activeRoutes = ctx.skillServerManager.getActiveRoutes()
  } catch {
    return
  }

  const orphaned = findOrphanedFetchesInContent(content, [...activeRoutes, ...customRouteSegments(ctx.workspaceDir)])
  if (orphaned.length === 0) return

  base.canvasApiContract = {
    orphanedFetches: orphaned,
    activeRoutes: activeRoutes.map((r) => `/api/${r}`),
    warning:
      `This file fetches ${orphaned.length} route(s) that don't exist on the server: ${orphaned.join(', ')}. ` +
      `Either add a matching Prisma model in prisma/schema.prisma (which gives you /api/{model-plural} CRUD ` +
      `automatically after \`shogo generate\`), or register a custom Hono route in custom-routes.ts, which is ` +
      `mounted under /api (e.g. \`app.get('${orphaned[0].replace(/^\/api/, '')}', async (c) => ...)\`). Do not add ` +
      `routes to server.tsx — it is regenerated. Otherwise the fetch will return a 404 at runtime.`,
  }
}

function findOrphanedFetches(workspaceDir: string, activeRoutes: string[]): { route: string; file: string }[] {
  const routeSet = new Set([...activeRoutes, ...customRouteSegments(workspaceDir)].map((r) => r.toLowerCase()))
  // Each call site needs its own RegExp instance because the global flag
  // makes the regex stateful (`lastIndex`) — sharing the constant across
  // concurrent scans would skip matches.
  const fetchPattern = new RegExp(CANVAS_API_FETCH_PATTERN.source, 'g')
  const orphaned: { route: string; file: string }[] = []

  const scanDir = (dir: string) => {
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name)
        if (entry.isDirectory() && entry.name !== 'node_modules' && entry.name !== 'generated' && entry.name !== '.shogo') {
          scanDir(full)
        } else if (entry.isFile() && /\.(tsx?|jsx?)$/.test(entry.name)) {
          try {
            const content = readFileSync(full, 'utf-8')
            for (const m of content.matchAll(fetchPattern)) {
              if (!routeSet.has(m[1].toLowerCase())) {
                const relPath = full.startsWith(workspaceDir) ? full.slice(workspaceDir.length + 1) : full
                orphaned.push({ route: `/api/${m[1]}`, file: relPath })
              }
            }
          } catch {}
        }
      }
    } catch {}
  }

  scanDir(join(workspaceDir, 'src'))
  const canvasDir = join(workspaceDir, 'canvas')
  if (existsSync(canvasDir)) scanDir(canvasDir)

  return orphaned
}

async function maybeSchemaSync(
  ctx: ToolContext,
  filePath: string,
  resolved: string,
  baseResult: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  if (!ctx.skillServerManager) return null

  const customRoutesResult = await maybeCustomRoutesSync(ctx, filePath, resolved, baseResult)
  if (customRoutesResult) return customRoutesResult

  // Watch the project's root Prisma schema. The legacy `.shogo/server/`
  // path is migrated into root paths on workspace boot — see
  // `migrations/skill-server-to-root.ts`.
  const isSchemaWrite =
    filePath === 'prisma/schema.prisma' || resolved.endsWith('/prisma/schema.prisma') || resolved.endsWith('\\prisma\\schema.prisma')
  if (!isSchemaWrite) return null

  const content = existsSync(resolved) ? readFileSync(resolved, 'utf-8') : ''
  if (!/^model\s+\w+/m.test(content)) return null

  try {
    const syncResult = await ctx.skillServerManager.sync()
    const routes = ctx.skillServerManager.getActiveRoutes()
    const activeRoutePaths = routes.map((r) => `/api/${r}`)

    const orphaned = findOrphanedFetches(ctx.workspaceDir, routes)

    const result: Record<string, unknown> = {
      ...baseResult,
      apiServer: {
        synced: syncResult.ok,
        phase: syncResult.phase,
        activeRoutes: activeRoutePaths,
        ...(syncResult.error ? { error: syncResult.error } : {}),
      },
    }

    if (orphaned.length > 0) {
      const unique = [...new Map(orphaned.map((o) => [`${o.route}::${o.file}`, o])).values()]
      ;(result.apiServer as Record<string, unknown>).orphanedFetches = unique
      ;(result.apiServer as Record<string, unknown>).warning =
        `Your schema is missing models for ${new Set(unique.map((o) => o.route)).size} route(s) that your UI code fetches. ` +
        `These fetch calls will fail at runtime. Either add the missing models to the schema or remove the fetch calls.`
    }

    return result
  } catch (err: any) {
    return {
      ...baseResult,
      apiServer: {
        synced: false,
        error: err.message,
        hint: 'Schema saved but regeneration failed. Check the schema for errors.',
      },
    }
  }
}

async function maybeCustomRoutesSync(
  ctx: ToolContext,
  filePath: string,
  _resolved: string,
  baseResult: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  // Custom non-CRUD routes live in `custom-routes.ts` at the project
  // root — `server.tsx` is auto-generated by the SDK from
  // `shogo.config.json` and the agent should not edit it. PreviewManager
  // also runs an async file watcher on `custom-routes.ts` as a safety
  // net (covers human edits in the editor); this synchronous fast path
  // exists so when the *agent* writes the file the tool response comes
  // back with `serverRestarted: true` already, instead of a stale
  // "server has stale routes" status while the watcher debounce ticks.
  const isCustomRoutesEdit =
    filePath === 'custom-routes.ts' ||
    filePath === 'custom-routes.tsx' ||
    filePath.endsWith('/custom-routes.ts') ||
    filePath.endsWith('/custom-routes.tsx')
  if (!isCustomRoutesEdit || !ctx.skillServerManager) return null

  // Drift heal: if `server.tsx` is on disk but missing the
  // `customRoutes` import/mount, the fast restart would just respawn
  // the same broken file (custom routes 404 → SPA catch-all returns
  // index.html with HTTP 200, silently masking the bug). Detect and
  // self-heal before restarting. See `server-tsx-drift.ts`.
  try {
    const drift = checkServerTsxDrift(ctx.workspaceDir)
    if (drift.drifted) {
      const heal = healServerTsxDrift(ctx.workspaceDir, drift)
      if (heal.mode === 'regenerate') {
        // SDK-generated stale file — full sync overwrites it via
        // `writeServerEntry()` in the project's `generate` script.
        const syncResult = await ctx.skillServerManager.sync()
        return {
          ...baseResult,
          apiServer: {
            serverRestarted: true,
            regenerated: true,
            phase: syncResult.phase,
            url: ctx.skillServerManager.url,
            hint:
              'server.tsx (SDK-generated) was stale and missing the custom-routes mount. ' +
              'Regenerated from shogo.config.json — your custom routes are now live under /api/.',
            ...(syncResult.error ? { error: syncResult.error } : {}),
          },
        }
      }
      if (heal.mode === 'patched') {
        // Hand-edited file — patched in place, all other edits
        // preserved. Just restart with the (now correct) server.tsx.
        await ctx.skillServerManager.restartApiServerOnly()
        return {
          ...baseResult,
          apiServer: {
            serverRestarted: true,
            patched: true,
            phase: ctx.skillServerManager.phase,
            url: ctx.skillServerManager.url,
            hint:
              'server.tsx was missing the custom-routes import/mount. Inserted the two ' +
              'required lines in place (other edits preserved). Restarted — routes are now live.',
          },
        }
      }
      if (heal.mode === 'failed') {
        return {
          ...baseResult,
          apiServer: {
            serverRestarted: false,
            error: `server.tsx is missing the custom-routes mount and self-heal failed: ${heal.reason}`,
            hint:
              `Add \`import customRoutes from '${drift.customRoutesPath}'\` to server.tsx and ` +
              `\`app.route('${drift.apiBasePath}', customRoutes)\` before the static catch-all, ` +
              'or run `bun x shogo generate` to regenerate server.tsx from shogo.config.json.',
          },
        }
      }
      // mode === 'noop' falls through to the fast restart below.
    }
  } catch (err: any) {
    // A failure to even check drift shouldn't block the restart —
    // log and continue to the fast path.
    console.warn(`[gateway-tools] custom-routes drift check failed (continuing to fast restart): ${err?.message ?? err}`)
  }

  try {
    // Fast path — no schema regeneration, no `prisma db push`. Custom
    // route changes don't affect the data model, so this typically
    // completes in well under a second.
    await ctx.skillServerManager.restartApiServerOnly()
    return {
      ...baseResult,
      apiServer: {
        serverRestarted: true,
        phase: ctx.skillServerManager.phase,
        url: ctx.skillServerManager.url,
        hint:
          'custom-routes.ts changes are live. CRUD routes mounted by createAllRoutes() keep working ' +
          'and your custom routes mount under /api/. Do NOT edit server.tsx — it is auto-generated.',
      },
    }
  } catch (err: any) {
    return {
      ...baseResult,
      apiServer: {
        serverRestarted: false,
        error: err.message,
        hint: 'custom-routes.ts saved but restart failed — check the file for syntax errors.',
      },
    }
  }
}

// ---------------------------------------------------------------------------
// Quick Actions file linter (post-write validation)
// ---------------------------------------------------------------------------

function maybeValidateQuickActions(
  filePath: string,
  resolved: string,
  baseResult: Record<string, unknown>,
): Record<string, unknown> | null {
  const isQuickActions = filePath === '.shogo/quick-actions.json' || resolved.endsWith('.shogo/quick-actions.json')
  if (!isQuickActions) return null

  const content = existsSync(resolved) ? readFileSync(resolved, 'utf-8') : ''
  const { valid, errors } = validateQuickActions(content)

  return {
    ...baseResult,
    quickActionsLint: valid ? { valid: true } : { valid: false, errors },
  }
}

// ---------------------------------------------------------------------------
// Server Sync Tool
// ---------------------------------------------------------------------------

function createServerSyncTool(ctx: ToolContext): AgentTool {
  return {
    name: 'server_sync',
    description:
      "Force the project's API server to regenerate routes from prisma/schema.prisma and restart. Use this when routes are returning 404 after a schema change, or to verify the server is healthy. Returns the current phase and list of active API routes.",
    label: 'Server Sync',
    parameters: Type.Object({}),
    execute: async () => {
      if (!ctx.skillServerManager) {
        return textResult({
          ok: false,
          error: 'API server provider not attached',
        })
      }

      try {
        const result = await ctx.skillServerManager.sync()
        const routes = ctx.skillServerManager.getActiveRoutes()
        const models = ctx.skillServerManager.getSchemaModels()
        return textResult({
          ok: result.ok,
          phase: result.phase,
          activeRoutes: routes.map((r) => `/api/${r}`),
          schemaModels: models,
          url: ctx.skillServerManager.url,
        })
      } catch (err: any) {
        return textResult({
          ok: false,
          error: err.message,
          phase: ctx.skillServerManager.phase,
        })
      }
    },
  }
}

// ---------------------------------------------------------------------------
// Edit File Tool (search_replace)
// ---------------------------------------------------------------------------

/**
 * Character-bigram multiset for `bigramDiceSimilarity` below. A `Map` (not a
 * `Set`) so repeated bigrams (e.g. "aa" inside "aaaa") count toward the
 * Sørensen-Dice intersection instead of collapsing to one.
 */
function bigramCounts(s: string): Map<string, number> {
  const counts = new Map<string, number>()
  for (let i = 0; i < s.length - 1; i++) {
    const bg = s.slice(i, i + 2)
    counts.set(bg, (counts.get(bg) ?? 0) + 1)
  }
  return counts
}

/**
 * Sørensen-Dice coefficient over character bigrams: 1.0 for identical
 * strings, 0.0 for strings sharing no adjacent-character pairs. Deliberately
 * O(len(a) + len(b)) — no edit-distance DP — so scoring every line-window in
 * a large file stays cheap. Robust to small typos/insertions/deletions
 * (a single changed character only costs ~2 bigrams), which is exactly the
 * "old_string is almost right" shape production `edit_file` failures take.
 */
export function bigramDiceSimilarity(a: string, b: string): number {
  if (a === b) return 1
  if (a.length < 2 || b.length < 2) return 0
  const countsA = bigramCounts(a)
  const countsB = bigramCounts(b)
  let intersection = 0
  for (const [bg, countA] of countsA) {
    const countB = countsB.get(bg)
    if (countB) intersection += Math.min(countA, countB)
  }
  return (2 * intersection) / (a.length - 1 + (b.length - 1))
}

/** Floor below which a "closest match" isn't worth showing — pure noise. */
const CLOSEST_MATCH_MIN_SIMILARITY = 0.35

/**
 * Last-resort diagnostic (never auto-applied) for when `old_string` matched
 * nothing at all, even after quote/whitespace normalization: slide a
 * same-line-count window across `content` and return whichever window is
 * most bigram-similar to `needle`, provided it clears
 * `CLOSEST_MATCH_MIN_SIMILARITY`. This replaces the old exact-substring
 * "does this line literally contain old_string's first line" search, which
 * produced "No similar content found" for the extremely common case of the
 * model's `old_string` being *almost* right (a stale variable name, a typo,
 * slightly different punctuation) — exactly the shape of the ~5,289/7d
 * "old_string not found" production failures this hint exists to help the
 * model self-correct from on its next attempt.
 */
export function findClosestMatch(
  content: string,
  needle: string,
): {
  text: string
  similarity: number
  startLine: number
  endLine: number
} | null {
  const needleLines = needle.split('\n')
  const n = needleLines.length
  const contentLines = content.split('\n')
  if (n === 0 || contentLines.length < n) return null
  const normNeedle = needleLines.map((l) => l.trim()).join('\n')

  let bestScore = -1
  let bestStart = -1
  for (let i = 0; i <= contentLines.length - n; i++) {
    const windowText = contentLines
      .slice(i, i + n)
      .map((l) => l.trim())
      .join('\n')
    const score = bigramDiceSimilarity(windowText, normNeedle)
    if (score > bestScore) {
      bestScore = score
      bestStart = i
    }
  }

  if (bestStart === -1 || bestScore < CLOSEST_MATCH_MIN_SIMILARITY) return null
  return {
    text: contentLines.slice(bestStart, bestStart + n).join('\n'),
    similarity: bestScore,
    startLine: bestStart + 1,
    endLine: bestStart + n,
  }
}

function fuzzyFindInContent(content: string, needle: string): { index: number; match: string } | null {
  // 1. Try exact match first
  const exactIdx = content.indexOf(needle)
  if (exactIdx !== -1) return { index: exactIdx, match: needle }

  // 2. Try unescaping JSON-escaped quotes (model sometimes emits \\\" instead of ")
  const unescaped = needle.replace(/\\"/g, '"').replace(/\\'/g, "'").replace(/\\\\/g, '\\')
  if (unescaped !== needle) {
    const unescIdx = content.indexOf(unescaped)
    if (unescIdx !== -1) return { index: unescIdx, match: unescaped }
  }

  // NOTE: A previous "step 3" did CRLF<->LF normalization here, but both
  // `content` and `needle` arrive pre-normalized to the same target line
  // ending from the caller (see edit_file: readFileWithMetadata then
  // normalizeLineEndings on old_string at gateway-tools.ts L1388-1393).
  // The IF branch was provably dead. Removed per coverage policy (no
  // // istanbul ignore allowed on this branch).

  // 3. Try stripping trailing whitespace per line
  const stripTrailing = (s: string) =>
    s
      .split('\n')
      .map((l) => l.trimEnd())
      .join('\n')
  const strippedNeedle = stripTrailing(needle)
  const strippedContent = stripTrailing(content)
  const stripIdx = strippedContent.indexOf(strippedNeedle)
  if (stripIdx !== -1) {
    const contentLines = content.split('\n')
    const needleLineCount = needle.split('\n').length
    const strippedLines = strippedContent.substring(0, stripIdx).split('\n')
    const startLineIdx = strippedLines.length - 1
    const startPos = content.split('\n').slice(0, startLineIdx).join('\n').length + (startLineIdx > 0 ? 1 : 0)
    const matchStr = contentLines.slice(startLineIdx, startLineIdx + needleLineCount).join('\n')
    return { index: startPos, match: matchStr }
  }

  // 5. Try whitespace-flexible matching (collapse runs of whitespace, trim lines)
  const collapseWS = (s: string) => s.replace(/[ \t]+/g, ' ').replace(/\r\n/g, '\n')
  const collapsedNeedle = collapseWS(needle)
  const collapsedContent = collapseWS(content)
  const wsIdx = collapsedContent.indexOf(collapsedNeedle)
  if (wsIdx !== -1) {
    const needleLines = needle.split('\n').map((l) => l.trim())
    const contentLines = content.split('\n')
    for (let i = 0; i <= contentLines.length - needleLines.length; i++) {
      let matched = true
      for (let j = 0; j < needleLines.length; j++) {
        if (contentLines[i + j].trim() !== needleLines[j]) {
          matched = false
          break
        }
      }
      if (matched) {
        const startPos = content.split('\n').slice(0, i).join('\n').length + (i > 0 ? 1 : 0)
        const matchStr = contentLines.slice(i, i + needleLines.length).join('\n')
        return { index: startPos, match: matchStr }
      }
    }
  }

  return null
}

const MAX_EDIT_FILE_SIZE = 1024 * 1024 * 1024 // 1 GiB

function createEditFileTool(ctx: ToolContext): AgentTool {
  return {
    name: 'edit_file',
    description: [
      'Performs exact string replacements in files.',
      '',
      'Usage:',
      '- Prefer reading the file with read_file first so old_string matches exactly; if you have not read it, this tool auto-reads it for you before editing.',
      '- When editing text from read_file output, preserve the exact indentation (tabs/spaces) as it appears in the file content.',
      '- ALWAYS prefer editing existing files. NEVER use write_file for existing files unless replacing the entire content.',
      '- The edit will FAIL if old_string is not unique. Provide more surrounding context to make it unique, or use replace_all.',
      '- Use replace_all for renaming a variable or string across the file.',
    ].join('\n'),
    label: 'Edit File',
    parameters: Type.Object({
      path: Type.String({ description: 'File path relative to workspace' }),
      old_string: Type.String({
        description:
          'Exact text to find in the file. Pass "" to create a file that does not exist yet.',
        'x-empty-ok': true,
      }),
      new_string: Type.String({
        description:
          'Replacement text (must differ from old_string). Pass "" to delete the matched text.',
        'x-empty-ok': true,
      }),
      replace_all: Type.Optional(
        Type.Boolean({
          description: 'Replace all occurrences (default: false)',
        }),
      ),
    }),
    execute: async (_toolCallId, params) => {
      const {
        path: requestedPath,
        old_string,
        new_string,
        replace_all = false,
      } = params as {
        path: string
        old_string: string
        new_string: string
        replace_all?: boolean
      }
      const filePath = scratchPathForWrite(ctx.workspaceDir, requestedPath).path
      if (old_string === new_string) {
        return textResult({ error: 'old_string and new_string must differ' })
      }
      const resolved = assertWithinWorkspace(ctx.workspaceDir, filePath, pathPolicy(ctx))
      const trustCheck = assertAllowedPath(resolved, 'write', ctx.workspaceDir, pathPolicy(ctx))
      if (!trustCheck.ok) return textResult({ error: trustCheck.message })
      const protectedRejection = rejectIfProtected(ctx, resolved)
      if (protectedRejection) return protectedRejection
      if (isBinaryFilePath(filePath)) {
        return textResult({
          error: `Refusing to edit binary file "${filePath}" as UTF-8 text. Use exec with a binary-safe tool instead.`,
        })
      }

      // Jupyter notebook redirect
      if (filePath.endsWith('.ipynb')) {
        return textResult({
          error: 'File is a Jupyter Notebook. Use the notebook_edit tool instead.',
        })
      }

      // Create file on edit: if file doesn't exist and old_string is empty,
      // create it with new_string as content (matches Claude Code behavior)
      if (!existsSync(resolved)) {
        if (old_string === '') {
          mkdirSync(dirname(resolved), { recursive: true })
          const target: LineEndingType = resolveLineEndingPolicy(resolved) ?? 'LF'
          const normalized = normalizeLineEndings(new_string, target)
          writeWithMetadata(resolved, normalized, 'utf-8', target)
          const newMtime = Math.floor(statSync(resolved).mtimeMs)
          ctx.fileStateCache?.recordEdit(filePath, normalized, newMtime)
          markEditedIfLintable(ctx, filePath)
          ctx.canvasFileWatcher?.onFileChanged(filePath, resolved)
          if (ctx.lspManager && LINTABLE_EXTENSION_RE.test(filePath)) {
            ctx.lspManager.notifyFileChanged(resolved, normalized)
            ctx.lspManager.notifyFileSaved?.(resolved)
          }
          const createdBase: Record<string, unknown> = {
            ok: true,
            path: filePath,
            created: true,
          }
          await attachEditDiagnostics(ctx, filePath, resolved, createdBase)
          return textResult(createdBase)
        }
        const hint = bogusPathPrefixHint(ctx.workspaceDir, filePath)
        return textResult({
          error: hint ? `File not found: ${filePath}\n${hint}` : `File not found: ${filePath}`,
        })
      }

      // File size guard
      const stats = statSync(resolved)
      if (stats.size > MAX_EDIT_FILE_SIZE) {
        return textResult({
          error: `File too large to edit (${(stats.size / 1024 / 1024).toFixed(0)} MB). Max: 1 GB.`,
        })
      }

      // Read-before-edit: rather than hard-erroring when the agent edits a file
      // it hasn't read this session (historically the #1 production tool error,
      // ~1.6k/wk), auto-read it into the cache and proceed. The exact-string
      // match pipeline below is itself the safety check — if the agent guessed
      // old_string wrong it still gets a precise "old_string not found" with
      // nearby context. This removes a pure round-trip ("read it first") that
      // weak models routinely tripped on, especially after a path-spelling
      // mismatch or a write_file.
      let readRecord = ctx.fileStateCache?.getRecord(filePath)
      if (ctx.fileStateCache && !readRecord) {
        try {
          const seedMtime = statSync(resolved).mtimeMs
          const seedContent = readFileSync(resolved, 'utf-8')
          ctx.fileStateCache.recordRead(filePath, seedMtime, seedContent.split('\n').length, undefined, seedContent)
          readRecord = ctx.fileStateCache.getRecord(filePath)
        } catch {
          // Couldn't auto-read (race/permission) — fall back to the original
          // guard rather than editing blind.
          return textResult({
            error: 'File has not been read yet. Read it first with read_file before editing.',
          })
        }
      }

      // Staleness detection. An identical re-read is safe. When the bytes
      // changed, still apply the edit if old_string matches once (or
      // replace_all is set) — that is the check the match pipeline below
      // already makes. Otherwise refresh the cache from disk and tell the
      // agent what the file looks like now.
      let fileChangedSinceRead = false
      if (readRecord && ctx.fileStateCache?.isStale(filePath, resolved)) {
        const currentContent = readFileSync(resolved, 'utf-8')
        const isFullRead = !readRecord.partial && readRecord.content != null
        if (isFullRead && currentContent === readRecord.content) {
          const freshMtime = Math.floor(statSync(resolved).mtimeMs)
          ctx.fileStateCache.recordRead(
            filePath,
            freshMtime,
            currentContent.split('\n').length,
            undefined,
            currentContent,
          )
        } else {
          fileChangedSinceRead = true
        }
      }

      // Read with encoding + line-ending detection + .gitattributes policy
      const meta = readFileWithMetadata(resolved)
      const { encoding } = meta
      const target: LineEndingType = meta.targetLineEndings
      // Normalize the on-disk content to the target so matching and
      // splicing happen in a single, consistent line-ending world. This
      // prevents stray CRLFs (in the file OR the model's payload) from
      // tipping detection or producing mixed output.
      const content = normalizeLineEndings(meta.content, target)
      const isMarkdown = /\.(md|mdx)$/i.test(filePath)
      const rawNewString = isMarkdown ? new_string : stripTrailingWhitespace(new_string)
      const cleanNewString = normalizeLineEndings(rawNewString, target)
      const normalizedOldString = normalizeLineEndings(old_string, target)

      // --- Match pipeline ---
      // 1. Exact match
      const exactOccurrences = content.split(normalizedOldString).length - 1
      const staleRecoverable = exactOccurrences === 1 || (exactOccurrences > 0 && replace_all)
      if (fileChangedSinceRead && !staleRecoverable) {
        const freshMtime = Math.floor(statSync(resolved).mtimeMs)
        const rawNow = readFileSync(resolved, 'utf-8')
        ctx.fileStateCache?.recordRead(
          filePath,
          freshMtime,
          rawNow.split('\n').length,
          undefined,
          rawNow,
        )
        return textResult({
          error: 'File has been modified since last read (by user, linter, or another process). Read it again before editing.',
          hint: staleEditHint(content, normalizedOldString),
        })
      }
      if (exactOccurrences === 1 || (exactOccurrences > 1 && replace_all)) {
        const updated = applyEditToFile(content, normalizedOldString, cleanNewString, replace_all)
        return commitEdit(ctx, filePath, resolved, content, updated, encoding, target, replace_all ? exactOccurrences : 1)
      }
      if (exactOccurrences > 1 && !replace_all) {
        return textResult({
          error:
            `old_string found ${exactOccurrences} times in ${filePath}. ` +
            'Provide more context to make it unique, or set replace_all: true.',
        })
      }

      // 2. Curly quote normalization
      if (!replace_all) {
        const actualString = findActualString(content, normalizedOldString)
        if (actualString && actualString !== normalizedOldString) {
          const adjustedNew = preserveQuoteStyle(normalizedOldString, actualString, cleanNewString)
          const updated = applyEditToFile(content, actualString, adjustedNew, false)
          return commitEdit(ctx, filePath, resolved, content, updated, encoding, target, 1, 'Matched with quote normalization')
        }
      }

      // 3. Fuzzy match (whitespace/line-ending normalization)
      if (!replace_all) {
        const fuzzy = fuzzyFindInContent(content, normalizedOldString)
        if (fuzzy) {
          const updated = content.substring(0, fuzzy.index) + cleanNewString + content.substring(fuzzy.index + fuzzy.match.length)
          return commitEdit(ctx, filePath, resolved, content, updated, encoding, target, 1, 'Matched with whitespace normalization')
        }
      }

      // No match — provide helpful context. Try an exact-substring "nearby
      // lines" search first (cheap, and still the clearest hint when the
      // model's old_string is a real line that just isn't unique-enough
      // context), then fall back to `findClosestMatch`'s bigram-similarity
      // scan, which also catches the far more common case of old_string
      // being *almost* right (typo, stale value, slightly different
      // punctuation) — the exact-substring search finds nothing there.
      const lines = content.split('\n')
      const needleFirst = old_string.split('\n')[0]?.trim()
      const nearbyLines: string[] = []
      if (needleFirst) {
        for (let i = 0; i < lines.length; i++) {
          if (lines[i]!.includes(needleFirst)) {
            const start = Math.max(0, i - 1)
            const end = Math.min(lines.length, i + 3)
            nearbyLines.push(`Lines ${start + 1}-${end}: ${lines.slice(start, end).join('\n')}`)
            if (nearbyLines.length >= 2) break
          }
        }
      }

      let hint: string
      if (nearbyLines.length > 0) {
        hint = `Similar content found near:\n${nearbyLines.join('\n---\n')}`
      } else {
        const closest = findClosestMatch(content, normalizedOldString)
        hint = closest
          ? `No exact substring match, but the closest content (${Math.round(closest.similarity * 100)}% similar) ` +
            `is at lines ${closest.startLine}-${closest.endLine}:\n${closest.text}\n` +
            'Re-read the file and copy old_string exactly from there.'
          : 'No similar content found. Try reading the file first to get the exact text.'
      }

      return textResult({ error: `old_string not found in ${filePath}`, hint })
    },
  }
}

function staleEditHint(content: string, oldString: string): string {
  const lines = content.split('\n')
  const needle = oldString.split('\n')[0]?.trim()
  if (needle) {
    const index = lines.findIndex((line) => line.includes(needle))
    if (index >= 0) {
      const start = Math.max(0, index - 1)
      const end = Math.min(lines.length, index + 3)
      return `Current contents around the closest line:\n${lines.slice(start, end).join('\n')}`
    }
  }
  return `Current file starts with:\n${lines.slice(0, 12).join('\n')}`
}

async function commitEdit(
  ctx: ToolContext,
  filePath: string,
  resolved: string,
  originalContent: string,
  updated: string,
  encoding: BufferEncoding,
  target: LineEndingType,
  replacements: number,
  note?: string,
): Promise<AgentToolResult<any>> {
  // Every edit to a memory file keeps the pre-edit bytes (SHO-61). `edit_file`
  // is exempt from the shrink guard — it is already a diff — but a careless
  // `old_string` that spans the lessons block would still be a wipe, and the
  // history copy is what makes it recoverable.
  const memoryHistoryCopy = isMemoryFilePath(filePath)
    ? snapshotMemoryFile(ctx.workspaceDir, filePath)
    : null

  writeWithMetadata(resolved, updated, encoding, target)

  // Post-edit state tracking (recordEdit instead of invalidate)
  const newMtime = Math.floor(statSync(resolved).mtimeMs)
  if (ctx.fileStateCache) {
    ctx.fileStateCache.recordEdit(filePath, updated, newMtime)
  }
  markEditedIfLintable(ctx, filePath)

  ctx.canvasFileWatcher?.onFileChanged(filePath, resolved)
  if (ctx.lspManager && LINTABLE_EXTENSION_RE.test(filePath)) {
    ctx.lspManager.notifyFileChanged(resolved, updated)
    ctx.lspManager.notifyFileSaved?.(resolved)
  }

  const patch = getStructuredPatch(filePath, originalContent, updated)
  const base: Record<string, any> = {
    ok: true,
    path: filePath,
    replacements,
    patch,
  }
  if (note) base.note = note
  if (memoryHistoryCopy) base.memoryHistory = memoryHistoryCopy
  appendImpactHint(ctx, filePath, base)
  // Mirror the write_file canvas-API contract hint so edits that
  // introduce a new `fetch('/api/X')` get the same eager warning.
  appendCanvasApiContractHint(ctx, filePath, updated, base)
  await attachEditDiagnostics(ctx, filePath, resolved, base)
  attachCanvasRuntimeErrors(base)
  const quickActionsResult = maybeValidateQuickActions(filePath, resolved, base)
  if (quickActionsResult) return textResult(quickActionsResult)
  const schemaResult = await maybeSchemaSync(ctx, filePath, resolved, base)
  return textResult(schemaResult ?? base)
}

// ---------------------------------------------------------------------------
// App Template Tools (template_list, template_copy) — DISABLED (app mode removed)
// See APP_MODE_DISABLED.md for re-enablement instructions.
// ---------------------------------------------------------------------------

/* APP_MODE_DISABLED: template tools commented out

const APP_TEMPLATE_METADATA: Array<{
  name: string
  description: string
  complexity: 'beginner' | 'intermediate' | 'advanced'
  models: string[]
}> = [
  { name: '_template', description: 'Blank starter — minimal scaffolding with no pre-built models. Use when no other template matches.', complexity: 'beginner', models: ['User'] },
  { name: 'todo-app', description: 'Simple task management with user auth', complexity: 'beginner', models: ['User', 'Todo'] },
  { name: 'kanban', description: 'Kanban board with drag-and-drop task management', complexity: 'intermediate', models: ['User', 'Board', 'Column', 'Card'] },
  { name: 'expense-tracker', description: 'Personal expense tracker with categories and budgets', complexity: 'intermediate', models: ['User', 'Category', 'Expense', 'Budget'] },
  { name: 'booking-app', description: 'Booking and reservation system with time slots', complexity: 'intermediate', models: ['User', 'Service', 'TimeSlot', 'Booking'] },
  { name: 'crm', description: 'CRM with contacts, companies, deals, tags, and notes', complexity: 'advanced', models: ['User', 'Contact', 'Company', 'Tag', 'ContactTag', 'Note', 'Deal'] },
  { name: 'inventory', description: 'Inventory management with products, categories, and stock tracking', complexity: 'intermediate', models: ['User', 'Category', 'Product', 'StockMovement'] },
  { name: 'feedback-form', description: 'Feedback and survey collection system', complexity: 'intermediate', models: ['User', 'Form', 'Question', 'Response', 'Answer'] },
  { name: 'form-builder', description: 'Dynamic form builder with drag-and-drop', complexity: 'advanced', models: ['User', 'Form', 'Field', 'Submission', 'FieldValue'] },
  { name: 'ai-chat', description: 'Full-featured AI chat interface with conversations, artifacts, and documents', complexity: 'advanced', models: ['User', 'Chat', 'Message', 'Vote', 'Document'] },
]

function createTemplateListTool(): AgentTool {
  return {
    name: 'template_list',
    description: 'List available app starter templates. Every new app MUST start from a template. Choose the closest match, or use "_template" (blank) if nothing fits. Call this BEFORE writing any code if no template has been selected yet.',
    label: 'List App Templates',
    parameters: Type.Object({}),
    execute: async () => {
      return textResult({
        templates: APP_TEMPLATE_METADATA,
        instructions: 'Pick the best match and call template_copy. Use "_template" for blank. NEVER scaffold from scratch.',
      })
    },
  }
}

function createTemplateCopyTool(ctx: ToolContext): AgentTool {
  return {
    name: 'template_copy',
    description: 'Scaffold a project from a starter template. Extracts the template into project/, sets up the database, installs dependencies, and restarts the preview server. After this, customize the scaffolded code — do NOT create files from scratch.',
    label: 'Copy App Template',
    parameters: Type.Object({
      template: Type.String({ description: 'Template name from template_list (e.g. "todo-app", "_template" for blank)' }),
      name: Type.Optional(Type.String({ description: 'App name (default: "my-app")' })),
    }),
    execute: async (_toolCallId, params) => {
      const { template, name = 'my-app' } = params as { template: string; name?: string }
      const port = process.env.PORT || '8080'
      try {
        const res = await fetch(`http://localhost:${port}/templates/copy`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ template, name }),
        })
        const data = await res.json() as Record<string, any>
        if (!res.ok) {
          const errMsg = data.error || `Template copy failed (${res.status})`
          return textResult({
            error: errMsg,
            hint: 'Call template_list to see available templates. Use "_template" for a blank starter.',
          })
        }
        return textResult({
          ok: true,
          template,
          name,
          message: data.message || 'Template extracted and preview restarted.',
          nextSteps: 'Read project/src/ to understand the scaffolded code, then make customizations.',
        })
      } catch (err: any) {
        return textResult({
          error: `template_copy failed: ${err.message}`,
          hint: 'Call template_list to see available templates. Use "_template" for a blank starter.',
        })
      }
    },
  }
}

END APP_MODE_DISABLED */

// ---------------------------------------------------------------------------
// TodoWrite Tool (session task checklist)
// ---------------------------------------------------------------------------

const todoStores = new Map<string, SessionTodo[]>()
/** When each list was last written, so a stale plan cannot restart a turn. */
const todoUpdatedAt = new Map<string, number>()

/**
 * The session's todo list, as the plan-continuation loop sees it (SHO-121).
 * `updatedAt` is the last `todo_write` for that session: a turn only continues
 * on a list written during the turn that is ending.
 */
export function getSessionTodos(sessionId: string): SessionTodosSnapshot | null {
  const todos = todoStores.get(sessionId)
  if (!todos) return null
  return { todos: todos.map((todo) => ({ ...todo })), updatedAt: todoUpdatedAt.get(sessionId) ?? 0 }
}

/** Drop a session's list (cleared history, or a test's workspace teardown). */
export function clearSessionTodos(sessionId: string): void {
  todoStores.delete(sessionId)
  todoUpdatedAt.delete(sessionId)
}

function createTodoWriteTool(ctx: ToolContext): AgentTool {
  return {
    name: 'todo_write',
    description: 'Manage a session task checklist. Each call replaces the full todo list. Use to track progress on multi-step tasks.',
    label: 'Todo Write',
    parameters: Type.Object({
      todos: Type.Array(
        Type.Object({
          id: Type.String({ description: 'Unique task identifier' }),
          content: Type.String({ description: 'Task description' }),
          status: Type.Union([Type.Literal('pending'), Type.Literal('in_progress'), Type.Literal('completed')], {
            description: 'Task status',
          }),
        }),
      ),
    }),
    execute: async (_toolCallId, params) => {
      const { todos } = params as {
        todos: Array<{ id: string; content: string; status: string }>
      }
      const key = ctx.sessionId || ctx.projectId
      todoStores.set(key, todos)
      todoUpdatedAt.set(key, Date.now())
      return textResult({ ok: true, todos, count: todos.length })
    },
  }
}

// ---------------------------------------------------------------------------
// AskUser Tool (structured multiple-choice questions)
// ---------------------------------------------------------------------------

function createAskUserTool(_ctx: ToolContext): AgentTool {
  return {
    name: 'ask_user',
    description: [
      'Ask the user structured multiple-choice questions ONLY when you are blocked on a decision that genuinely requires their input: a true requirement ambiguity, an irreversible/destructive choice, or missing information you cannot obtain yourself (e.g. which of two products to build, a credential the user must provide).',
      'Do NOT use ask_user to ask permission to continue work that was already requested, to confirm an obvious next step, or as a progress checkpoint — just keep going and complete the task, then summarize. This tool ENDS your turn and forces the user to reply, so every unnecessary call stalls the task and makes the user type "continue".',
      "The UI will render interactive option selectors. Do not call any other tools after this — wait for the user's response.",
      'If you just generated one or more images with generate_image (e.g. avatar candidates) and are now asking the user to pick one, set each option\'s imagePath to that image\'s workspace path (the `path` field returned by generate_image, e.g. "images/generated-123.png") so the user can see a thumbnail of each choice instead of guessing from text alone.',
    ].join(' '),
    label: 'Ask User',
    parameters: Type.Object({
      questions: Type.Array(
        Type.Object({
          header: Type.String({
            description: 'Short label/title for the question (e.g. "Deployment Region")',
          }),
          question: Type.String({
            description: 'The full question text to display to the user',
          }),
          options: Type.Array(
            Type.Object({
              label: Type.String({
                description: 'Display text for this option',
              }),
              description: Type.String({
                description: 'Brief explanation of what this option means',
              }),
              imagePath: Type.Optional(
                Type.String({
                  description:
                    'Workspace-relative path to an image to show as a thumbnail for this option (e.g. "images/generated-123.png", from a prior generate_image call). Use this when the choice is between visual candidates like avatars.',
                }),
              ),
            }),
          ),
          multiSelect: Type.Optional(
            Type.Boolean({
              description: 'Allow selecting multiple options (default: false)',
            }),
          ),
        }),
      ),
    }),
    // execute returns a minimal acknowledgment. The gateway suppresses tool-output-available
    // for ask_user so the UI keeps the widget in interactive (input-available) state until
    // the user submits their answer as a new user message.
    execute: async () => textResult({ acknowledged: true }),
  }
}

// ---------------------------------------------------------------------------
// Checkpoint Tool (WS4) — list / diff / rollback project snapshots
// ---------------------------------------------------------------------------

/** Surface a checkpoint API failure to the model, handling "not our repo" 409s gracefully. */
function checkpointError(res: CheckpointCallResult<unknown>): AgentToolResult<any> {
  if (res.code === 'checkpoints_disabled_in_external_mode') {
    return textResult({
      error: res.error,
      external_mode: true,
      hint: 'This is a folder-linked project — Shogo does not manage its git. Do NOT claim there is no history; tell the user to revert with their own git (e.g. `git reflog` / `git checkout`).',
    })
  }
  if (res.code === 'checkpoints_disabled_foreign_repo') {
    return textResult({
      error: res.error,
      foreign_repo: true,
      hint: "This project's folder is a checkout of another git repository, so Shogo never commits into it. Do NOT claim there is no history; tell the user to use their own git (e.g. `git reflog` / `git checkout`) in that folder.",
    })
  }
  return textResult({
    error: res.error ?? 'Checkpoint operation failed',
    status: res.status,
  })
}

function createCheckpointTool(ctx: ToolContext): AgentTool {
  return {
    name: 'checkpoint',
    description: [
      'Inspect and restore the project\'s automatic checkpoints (snapshots taken after each turn). Use this whenever the user wants to undo / "go back" / revert / restore an earlier state — the project HAS a checkpoint history even if `git log` in the sandbox looks empty, so NEVER tell the user "there is no git history".',
      'Actions:',
      '- list: show recent checkpoints (id, message, time). Start here to find the target.',
      '- diff: show what changed between a checkpoint and now (requires checkpoint_id).',
      '- rollback: restore the project to a checkpoint (requires checkpoint_id). This creates a new checkpoint first, so it is reversible.',
      'Always `list` first, confirm the right target with the user when ambiguous, then `rollback`.',
    ].join('\n'),
    label: 'Checkpoints',
    parameters: Type.Object({
      action: Type.Union([Type.Literal('list'), Type.Literal('diff'), Type.Literal('rollback')], { description: 'list | diff | rollback' }),
      checkpoint_id: Type.Optional(
        Type.String({
          description: 'Target checkpoint id (required for diff/rollback)',
        }),
      ),
      to_checkpoint_id: Type.Optional(
        Type.String({
          description: 'For diff: compare against this checkpoint instead of current state',
        }),
      ),
      include_database: Type.Optional(
        Type.Boolean({
          description: 'For rollback: also restore the database snapshot (default false)',
        }),
      ),
    }),
    execute: async (_toolCallId, params) => {
      const { action, checkpoint_id, to_checkpoint_id, include_database } = params as {
        action: 'list' | 'diff' | 'rollback'
        checkpoint_id?: string
        to_checkpoint_id?: string
        include_database?: boolean
      }
      const projectId = ctx.projectId
      if (!projectId) {
        return textResult({
          error: 'No project context is available, so checkpoints cannot be accessed.',
        })
      }

      if (action === 'list') {
        const res = await apiListCheckpoints(projectId, 20)
        if (!res.ok) return checkpointError(res)
        const checkpoints = (res.data ?? []).map((cp) => ({
          id: cp.id,
          message: cp.name || cp.message || '(no message)',
          createdAt: cp.createdAt,
          automatic: cp.isAutomatic ?? true,
          filesChanged: cp.filesChanged,
        }))
        return textResult({
          checkpoints,
          count: checkpoints.length,
          hint:
            checkpoints.length === 0
              ? 'No checkpoints recorded yet for this project.'
              : 'To revert, call checkpoint with action="rollback" and the chosen checkpoint_id.',
        })
      }

      if (action === 'diff') {
        if (!checkpoint_id) return textResult({ error: 'checkpoint_id is required for diff' })
        const res = await apiGetCheckpointDiff(projectId, checkpoint_id, to_checkpoint_id)
        if (!res.ok) return checkpointError(res)
        return textResult({ diff: res.data })
      }

      // rollback
      if (!checkpoint_id) return textResult({ error: 'checkpoint_id is required for rollback' })
      const res = await apiRollbackCheckpoint(projectId, checkpoint_id, include_database)
      if (!res.ok) return checkpointError(res)
      return textResult({
        ok: true,
        rolledBack: true,
        result: res.data,
        note: 'Restored to the requested checkpoint. A new checkpoint was created first, so this is reversible. Re-verify the app still works.',
      })
    },
  }
}

// ---------------------------------------------------------------------------
// Publish Tool — deploy the app to {subdomain}.shogo.one (gated, internal-api)
// ---------------------------------------------------------------------------

interface PublishVerification {
  reachable: boolean
  /** Same-origin scripts/stylesheets the page references that don't load. */
  brokenAssets: Array<{ url: string; problem: string }>
}

const MAX_VERIFIED_ASSETS = 10

/** Same-origin `<script src>` and stylesheet/modulepreload `<link href>` URLs. */
export function extractPageAssetUrls(html: string, pageUrl: string): string[] {
  const origin = new URL(pageUrl).origin
  const urls = new Set<string>()
  const add = (raw: string | undefined) => {
    if (!raw || raw.startsWith('data:')) return
    try {
      const resolved = new URL(raw, pageUrl)
      if (resolved.origin === origin) urls.add(resolved.href)
    } catch {
      /* unparseable reference — the browser would skip it too */
    }
  }
  for (const m of html.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)) add(m[1])
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = m[0]
    if (!/\brel\s*=\s*["'](?:stylesheet|modulepreload)["']/i.test(tag)) continue
    add(tag.match(/\bhref\s*=\s*["']([^"']+)["']/i)?.[1])
  }
  return [...urls].slice(0, MAX_VERIFIED_ASSETS)
}

async function assetProblem(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { method: 'GET', redirect: 'follow', signal: AbortSignal.timeout(10_000) })
    if (!res.ok) return `HTTP ${res.status}`
    // A missing asset under an SPA fallback comes back 200 as index.html; the
    // browser then refuses it as a script/stylesheet and the page renders blank.
    if ((res.headers.get('content-type') ?? '').includes('text/html')) return 'served HTML instead of the asset'
    return null
  } catch (err: any) {
    return err?.name === 'TimeoutError' ? 'timed out' : 'request failed'
  }
}

/**
 * GET the published URL a few times to confirm it serves (cold start), then
 * confirm the scripts/stylesheets its HTML references actually load — a 200
 * page whose bundle 404s (wrong asset base path) renders blank for the user.
 */
async function verifyPublishedSite(url: string): Promise<PublishVerification> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'GET',
        redirect: 'follow',
        signal: AbortSignal.timeout(15_000),
      })
      // 401/403 means the site IS live but gated (password/private) — that's a
      // successful publish, so treat any non-5xx, non-404 as reachable. Gated
      // pages don't expose the app's HTML, so there is nothing to check further.
      if (res.status < 500 && res.status !== 404) {
        if (!res.ok || !(res.headers.get('content-type') ?? '').includes('text/html')) {
          return { reachable: true, brokenAssets: [] }
        }
        const assets = extractPageAssetUrls(await res.text(), res.url || url)
        let broken = await checkAssets(assets)
        if (broken.length > 0) {
          // One retry for assets still propagating to the edge.
          await new Promise((r) => setTimeout(r, 2000))
          broken = await checkAssets(broken.map((b) => b.url))
        }
        return { reachable: true, brokenAssets: broken }
      }
    } catch {
      /* retry */
    }
    if (attempt < 2) await new Promise((r) => setTimeout(r, 2000))
  }
  return { reachable: false, brokenAssets: [] }
}

async function checkAssets(urls: string[]): Promise<Array<{ url: string; problem: string }>> {
  const results = await Promise.all(urls.map(async (u) => ({ url: u, problem: await assetProblem(u) })))
  return results.filter((r): r is { url: string; problem: string } => r.problem !== null)
}

/**
 * The project a project-scoped internal call acts on. Workspace runtimes
 * often have `PROJECT_ID = ws:<workspaceId>`, which the API cannot map to a
 * project and rejects with 401. Try, in order: an explicit id, the current
 * project, the workspace anchor, then the only attached project.
 */
function resolveTargetProjectId(ctx: ToolContext, requested?: string): string | undefined {
  const explicit = projectScopedId(requested?.trim())
  if (explicit) return explicit
  const current = projectScopedId(ctx.projectId)
  if (current) return current
  const anchor = projectScopedId(process.env.WORKSPACE_ANCHOR_PROJECT_ID)
  if (anchor) return anchor
  const attached = workspaceAttachedProjectIds().filter((id) => projectScopedId(id))
  return attached.length === 1 ? attached[0] : undefined
}

function createPublishTool(ctx: ToolContext): AgentTool {
  return {
    name: 'publish',
    description: [
      'Publish the web app to a public, persistent URL at `{subdomain}.shogo.one`. Use this for hosting or permanently sharing the web app. For a single generated file, use `share_file` instead — never use publish to deliver a PDF, DOCX, ZIP, EXE, or other artifact.',
      'First publish to a subdomain requires the Pro plan or higher. If the user may be on Free/Basic, tell them about this BEFORE starting deploy work so they are not surprised after you have already done the work — do not just attempt the tool call and hope. If the tool nonetheless returns `plan_not_allowed`, point the user to Settings > Billing to upgrade.',
      'First publish: a subdomain is required. If the user already named a subdomain (e.g. "publish to foo" / "host it at foo.shogo.one"), HONOR IT VERBATIM — pass exactly what they asked for (only lowercased), do not rename, prettify, or substitute your own. Only when the user has NOT specified one should you propose a name (e.g. derived from the app/project name) and CONFIRM it before publishing, since this creates a publicly reachable site. If the tool returns `needs_subdomain`, ask the user to confirm a subdomain, then call again with it.',
      'Re-publish (already published): omit `subdomain` to redeploy the latest build to the existing live subdomain. Existing access-level/password settings are preserved unless you pass new ones.',
      'On success this returns the live `https://{subdomain}.shogo.one` URL after verifying it responds and that the scripts/stylesheets it references load — share THAT URL with the user. If it returns `brokenAssets`, the site renders blank: fix the asset paths and republish before telling the user it works.',
      'The runtime auto-recovers from stale bundles on its own (self-healing reload + no-store HTML), so never tell the user to hard-refresh or clear their cache. Distinguish the stable preview URL from the published URL first; if the published site is still stale after ~30s, republish instead of asking the user to refresh.',
      'In a workspace runtime, pass `project_id` for the mounted project to publish. It defaults to the current project, the workspace anchor, or the only attached project.',
    ].join('\n'),
    label: 'Publish',
    parameters: Type.Object({
      subdomain: Type.Optional(
        Type.String({
          description:
            'Subdomain for {subdomain}.shogo.one. Required on first publish; omit to republish the existing one. When the user names a subdomain, use it EXACTLY as given (only lowercased) — never substitute your own. Rules: 3-63 chars, lowercase letters/numbers/hyphens, no consecutive hyphens.',
        }),
      ),
      access_level: Type.Optional(
        Type.Union([Type.Literal('anyone'), Type.Literal('authenticated'), Type.Literal('private'), Type.Literal('password')], {
          description: 'Who can view the site. Defaults to the existing setting (or "anyone" on first publish).',
        }),
      ),
      password: Type.Optional(
        Type.String({
          description: 'Shared site password — only when access_level is "password".',
        }),
      ),
      site_title: Type.Optional(Type.String({ description: 'Optional site title (meta).' })),
      site_description: Type.Optional(Type.String({ description: 'Optional site description (meta).' })),
      project_id: Type.Optional(
        Type.String({
          description:
            'Project to publish. Required in a workspace runtime when more than one project is attached and none is the current or anchor project.',
        }),
      ),
    }),
    execute: async (_toolCallId, params) => {
      const { subdomain, access_level, password, site_title, site_description, project_id } = params as {
        subdomain?: string
        access_level?: 'anyone' | 'authenticated' | 'private' | 'password'
        password?: string
        site_title?: string
        site_description?: string
        project_id?: string
      }
      const projectId = resolveTargetProjectId(ctx, project_id)
      if (!projectId) {
        return textResult({
          error: 'No project context is available, so the app cannot be published. Pass project_id for the project to publish.',
        })
      }

      // Resolve first-publish vs republish from the current state.
      const state = await apiGetPublishState(projectId)
      const currentSubdomain = state.ok ? (state.data?.subdomain ?? null) : null

      const requested = (subdomain ?? '').trim().toLowerCase()
      const targetSubdomain = requested || currentSubdomain

      if (!targetSubdomain) {
        return textResult({
          needs_subdomain: true,
          hint: 'This project has not been published yet. Publishing creates a PUBLIC site, so confirm the subdomain with the user first. Propose one (3-63 chars, lowercase letters/numbers/hyphens, no consecutive hyphens) and, once they confirm, call publish again with `subdomain`.',
        })
      }

      const res = await apiPublishProject(projectId, {
        subdomain: targetSubdomain,
        accessLevel: access_level,
        password,
        siteTitle: site_title,
        siteDescription: site_description,
      })

      if (!res.ok) {
        if (res.code === 'subdomain_taken') {
          return textResult({
            error: `The subdomain "${targetSubdomain}" is already in use. Ask the user to choose a different one, then publish again.`,
            code: res.code,
          })
        }
        if (res.code === 'invalid_subdomain') {
          return textResult({
            error: `"${targetSubdomain}" is not a valid subdomain (${res.error}). Ask the user for a valid one (3-63 chars, lowercase letters/numbers/hyphens, no consecutive hyphens).`,
            code: res.code,
          })
        }
        if (res.code === 'plan_not_allowed') {
          return textResult({
            error: 'Publishing to a subdomain requires a Pro (or higher) plan. The chat now shows the user an Upgrade button. Tell them their work is saved and they can publish again once they upgrade; meanwhile they can use the preview URL.',
            code: res.code,
          })
        }
        return textResult({
          error: res.error ?? 'Publish failed',
          code: res.code,
          status: res.status,
        })
      }

      const url = res.data?.url ?? `https://${targetSubdomain}.shogo.one`
      const verification = await verifyPublishedSite(url)
      const wasRepublish = currentSubdomain != null && currentSubdomain === targetSubdomain

      if (verification.brokenAssets.length > 0) {
        const list = verification.brokenAssets.map((a) => `${a.url} (${a.problem})`).join('; ')
        return textResult({
          ok: true,
          published: true,
          url,
          subdomain: res.data?.subdomain ?? targetSubdomain,
          republished: wasRepublish,
          verified: false,
          brokenAssets: verification.brokenAssets,
          note: `Publish deployed to ${url}, but the page will render BLANK: its HTML loads while ${verification.brokenAssets.length} script/stylesheet file(s) it references do not — ${list}. Do NOT tell the user the site is working. This almost always means the build's asset base path does not match the published site root (check \`base\` in vite.config, and any hardcoded \`/p/<id>/\` or absolute asset URLs). Fix it, rebuild, publish again, and only share the URL once publish returns verified: true.`,
        })
      }

      const verified = verification.reachable
      return textResult({
        ok: true,
        published: true,
        url,
        subdomain: res.data?.subdomain ?? targetSubdomain,
        republished: wasRepublish,
        verified,
        note: verified
          ? `The app is live at ${url}. Share this URL with the user. Static assets use cache-safe headers and the runtime self-heals stale bundles automatically — do not tell the user to hard-refresh or clear their cache.`
          : `Publish completed and the app is live at ${url}, but it did not respond to a verification fetch yet (a freshly published site can take a short while to propagate / cold-start). Share ${url} with the user and note it may take a moment to load. If they still see an old version after ~30s, distinguish preview from published URL and republish rather than asking them to hard-refresh or clear their cache — the runtime already self-heals stale bundles.`,
      })
    },
  }
}

// ---------------------------------------------------------------------------
// Share File Tool — create a short-lived download link for a workspace file
// ---------------------------------------------------------------------------

function createShareFileTool(ctx: ToolContext): AgentTool {
  return {
    name: 'share_file',
    description: [
      'Create a short-lived download link for one file in the workspace.',
      'Use this whenever the user asks to download, receive, get, or send a generated file such as a PDF, DOCX, ZIP, EXE, image, or other artifact.',
      'This is for individual files, not web apps. Do not invent a localhost or preview URL, and do not use the publish tool for a file download.',
      'Never upload the file to a third-party host (filebin, file.io, transfer.sh, tmpfiles, 0x0.st, or similar) with curl or any other tool; this is the only supported way to hand a user a file.',
      'After this succeeds, paste the returned URL verbatim and tell the user when it expires. Do not delete or overwrite the shared file before the user downloads it.',
      'In a workspace runtime the file decides where the link points: a file inside a mounted project gets a project link, anything else gets a workspace link. `project_id` only picks the project when the path alone is ambiguous.',
    ].join(' '),
    label: 'Share file',
    parameters: Type.Object({
      path: Type.String({
        description:
          'Workspace-relative path of the file to share (the same path read_file uses). In a workspace runtime a mounted project\'s files are at `<projectId>/…`; the link is minted under whichever project actually owns the file.',
      }),
      expires_in_days: Type.Optional(Type.Number({
        description: 'How many days the link should work, from 1 to 7. Defaults to 7.',
      })),
      project_id: Type.Optional(
        Type.String({
          description:
            'Optional tiebreaker. The project that owns the file is taken from the path itself (a file under `<projectId>/…` belongs to that project); pass this only when the path sits at the workspace root and you want a particular project named, or to be explicit. A value that contradicts where the file actually lives is ignored and reported in the result.',
        }),
      ),
    }),
    execute: async (_toolCallId, params) => {
      const input = params as { path: string; expires_in_days?: number; project_id?: string }
      const path = input.path.trim().replace(/\\/g, '/').replace(/^\.\/+/, '')
      if (!path || path.startsWith('/') || path.split('/').some((segment) => !segment || segment === '.' || segment === '..')) {
        return textResult({ error: 'path must be a relative workspace path without ".."' })
      }

      let resolved: string
      try {
        resolved = assertWithinWorkspace(ctx.workspaceDir, path)
      } catch {
        return textResult({ error: `Path is outside the workspace: ${path}` })
      }
      let fileSize: number
      try {
        const file = statSync(resolved)
        if (!file.isFile()) {
          return textResult({ error: `Not a regular file: ${path}` })
        }
        fileSize = file.size
      } catch {
        const hint = bogusPathPrefixHint(ctx.workspaceDir, path)
        return textResult({
          error: `File not found: ${path}`,
          ...(hint ? { hint } : {}),
        })
      }

      const requestedProjectId = resolveTargetProjectId(ctx, input.project_id)
      const workspaceId = isWorkspaceRuntimeMode()
        ? ctx.workspaceId || resolveRuntimeIdentity().workspaceId
        : null

      // The file's real location decides the scope and the signed path: a
      // project link is resolved against the project root, which is
      // `<workspaceDir>/<projectId>/…`, not against the workspace root.
      const target = resolveShareFileLinkTarget({
        workspaceDir: ctx.workspaceDir,
        resolvedPath: resolved,
        path,
        requestedProjectId,
        mountedProjectIds: workspaceAttachedProjectIds(),
        anchorProjectId: projectScopedId(process.env.WORKSPACE_ANCHOR_PROJECT_ID),
        workspaceRuntime: isWorkspaceRuntimeMode(),
      })
      const projectId = target.projectId
      if (!projectId && !workspaceId) {
        return textResult({
          error: 'No project selected. Pass project_id for the project that owns this file.',
        })
      }
      const linkOptions = { path: target.linkPath, expiresInDays: input.expires_in_days }
      // With no single owning project, the link is served by this workspace
      // runtime, which is where the file was just found.
      const result = projectId
        ? await apiCreateSharedFileLink(projectId, linkOptions)
        : await apiCreateWorkspaceSharedFileLink(workspaceId!, linkOptions)
      if (!result.ok || !result.data) {
        return textResult({
          error: result.error ?? 'Failed to create a download link',
          code: result.code,
          status: result.status,
        })
      }

      const filename = target.linkPath.split('/').pop() || target.linkPath
      return textResult({
        ok: true,
        url: result.data.url,
        filename,
        size: fileSize,
        expiresAt: result.data.expiresAt,
        path: target.linkPath,
        linkPath: target.linkPath,
        ...(projectId ? { projectId } : {}),
        ...(target.ignoredProjectId
          ? {
              note: projectId
                ? `The file lives in project ${projectId}, so the link was minted there instead of ${target.ignoredProjectId}. Path signed: ${target.linkPath}`
                : `The file is not inside any mounted project, so the link was minted as a workspace link instead of under ${target.ignoredProjectId}. Path signed: ${target.linkPath}`,
            }
          : {}),
      })
    },
  }
}

const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const WEB_FETCH_TIMEOUT_MS = 30_000

function cleanPlainText(text: string): string {
  return text
    .replace(/[\u200B-\u200F\u2028\u2029\uFEFF]/g, '')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/[^\S\n]*\n/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim()
}

function stripHtmlRegex(html: string): string {
  let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    .replace(/<header[\s\S]*?<\/header>/gi, '')
    .replace(/<aside[\s\S]*?<\/aside>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?(p|div|h[1-6]|li|tr|blockquote)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
  return cleanPlainText(text)
}

async function stripHtmlToText(html: string): Promise<string> {
  try {
    const { Readability } = await import('@mozilla/readability')
    const { parseHTML } = await import('linkedom')
    const { document } = parseHTML(html)
    const reader = new Readability(document as any)
    const article = reader.parse()
    if (article?.textContent) {
      return cleanPlainText(article.textContent)
    }
  } catch {}
  return stripHtmlRegex(html)
}

// ---------------------------------------------------------------------------
// Wikipedia: Parsoid HTML → Markdown via Turndown
// ---------------------------------------------------------------------------

const WIKIPEDIA_URL_RE = /^https?:\/\/([a-z]{2,})\.wikipedia\.org\/wiki\/(.+)/i

function parseWikipediaUrl(url: string): { lang: string; title: string } | null {
  const m = url.match(WIKIPEDIA_URL_RE)
  if (!m) return null
  const rawTitle = m[2].split('#')[0].split('?')[0]
  return { lang: m[1], title: decodeURIComponent(rawTitle) }
}

async function fetchWikipediaAsMarkdown(lang: string, title: string, maxChars: number): Promise<string> {
  const TurndownService = (await import('turndown')).default
  const { gfm } = (await import('turndown-plugin-gfm')) as {
    gfm: (s: any) => void
  }

  const apiTitle = encodeURIComponent(title.replace(/ /g, '_'))
  const apiUrl = `https://${lang}.wikipedia.org/api/rest_v1/page/html/${apiTitle}`

  const resp = await fetch(apiUrl, {
    headers: {
      Accept: 'text/html; charset=utf-8; profile="https://www.mediawiki.org/wiki/Specs/HTML/2.8.0"',
      'User-Agent': 'ShogoAgent/1.0 (https://shogo.dev; russell@shogo.dev)',
    },
    signal: AbortSignal.timeout(WEB_FETCH_TIMEOUT_MS),
    redirect: 'follow',
  })

  if (!resp.ok) return ''

  const html = await resp.text()

  const { parseHTML } = await import('linkedom')
  const { document } = parseHTML(html)

  const removeSelectors = [
    'style',
    'link[rel="stylesheet"]',
    '.mw-ref',
    'sup.reference',
    '.navbox',
    '.sisternav',
    '.portal',
    '.mw-editsection',
    '.mw-empty-elt',
    '.noprint',
    '.mw-authority-control',
    '.ambox',
    '.tmbox',
    '.ombox',
    '.cmbox',
    '.fmbox', // maintenance/warning boxes
    '.hatnote', // disambiguation notes
    '.mw-indicators', // page status indicators
    '.catlinks', // category links footer
    'figure[typeof*="mw:File"]', // images (drop entirely for text focus)
    'img', // stray images
  ]
  for (const sel of removeSelectors) {
    document.querySelectorAll(sel).forEach((el: any) => el.remove())
  }

  // Convert internal wiki links to plain text (remove href noise)
  document.querySelectorAll('a[rel="mw:WikiLink"]').forEach((el: any) => {
    const span = document.createElement('span')
    span.textContent = el.textContent
    el.replaceWith(span)
  })

  const turndown = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
  })
  turndown.use(gfm)
  turndown.remove('style')
  turndown.remove('img')

  let markdown = turndown.turndown(document.toString())

  // Clean up excessive whitespace
  markdown = markdown
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\s+$/gm, '')
    .trim()

  if (markdown.length > maxChars) {
    markdown = markdown.substring(0, maxChars) + `\n\n[Truncated at ${maxChars} chars]`
  }

  return markdown
}

// ---------------------------------------------------------------------------
// Serper.dev Web Search
// ---------------------------------------------------------------------------

const SERPER_ENDPOINTS: Record<string, string> = {
  search: 'https://google.serper.dev/search',
  news: 'https://google.serper.dev/news',
  images: 'https://google.serper.dev/images',
  places: 'https://google.serper.dev/places',
  maps: 'https://google.serper.dev/maps',
  shopping: 'https://google.serper.dev/shopping',
}

interface SerperOrganicResult {
  title?: string
  link?: string
  snippet?: string
  position?: number
  date?: string
  sitelinks?: Array<{ title: string; link: string }>
}

interface SerperResponse {
  searchParameters?: Record<string, unknown>
  knowledgeGraph?: {
    title?: string
    description?: string
    type?: string
    website?: string
    attributes?: Record<string, string>
  }
  answerBox?: {
    answer?: string
    snippet?: string
    snippetHighlighted?: string[]
  }
  organic?: SerperOrganicResult[]
  peopleAlsoAsk?: Array<{ question: string; snippet?: string; link?: string }>
  relatedSearches?: Array<{ query: string }>
  news?: Array<{
    title?: string
    link?: string
    snippet?: string
    date?: string
    source?: string
  }>
  places?: Array<{
    title?: string
    address?: string
    rating?: number
    ratingCount?: number
  }>
  images?: Array<{ title?: string; imageUrl?: string; link?: string }>
  shopping?: Array<{
    title?: string
    price?: string
    link?: string
    source?: string
  }>
  credits?: number
}

function formatSerperResults(raw: SerperResponse, searchType: string): string {
  const parts: string[] = []

  if (raw.answerBox) {
    const ab = raw.answerBox
    const answer = [ab.answer, ab.snippet].filter(Boolean).join(' — ')
    if (answer) parts.push(`**Answer:** ${answer}`)
  }

  if (raw.knowledgeGraph) {
    const kg = raw.knowledgeGraph
    const kgParts = [`**${kg.title || 'Knowledge Graph'}**`]
    if (kg.type) kgParts.push(`Type: ${kg.type}`)
    if (kg.description) kgParts.push(kg.description)
    if (kg.website) kgParts.push(`Website: ${kg.website}`)
    if (kg.attributes) {
      for (const [k, v] of Object.entries(kg.attributes)) {
        kgParts.push(`${k}: ${v}`)
      }
    }
    parts.push(kgParts.join('\n'))
  }

  if ((searchType === 'search' || searchType === 'maps') && raw.organic?.length) {
    parts.push('**Search Results:**')
    for (const r of raw.organic.slice(0, 10)) {
      const entry = [`${r.position ?? ''}. **${r.title}**`, r.link, r.snippet].filter(Boolean).join('\n   ')
      parts.push(entry)
    }
  }

  if (searchType === 'news' && raw.news?.length) {
    parts.push('**News Results:**')
    for (const n of raw.news.slice(0, 10)) {
      parts.push([`- **${n.title}**`, n.source ? `(${n.source})` : '', n.date || '', n.link, n.snippet].filter(Boolean).join(' '))
    }
  }

  if ((searchType === 'places' || searchType === 'maps') && raw.places?.length) {
    parts.push('**Places:**')
    for (const p of raw.places.slice(0, 10)) {
      parts.push(`- **${p.title}** — ${p.address || 'N/A'} (${p.rating ?? '?'}/5, ${p.ratingCount ?? 0} reviews)`)
    }
  }

  if (searchType === 'shopping' && raw.shopping?.length) {
    parts.push('**Shopping Results:**')
    for (const s of raw.shopping.slice(0, 10)) {
      parts.push(`- **${s.title}** — ${s.price || 'N/A'} (${s.source || ''}) ${s.link || ''}`)
    }
  }

  if (raw.peopleAlsoAsk?.length) {
    parts.push('**People Also Ask:**')
    for (const q of raw.peopleAlsoAsk.slice(0, 5)) {
      parts.push(`- ${q.question}${q.snippet ? ` — ${q.snippet}` : ''}`)
    }
  }

  if (raw.relatedSearches?.length) {
    parts.push('**Related Searches:** ' + raw.relatedSearches.map((r) => r.query).join(', '))
  }

  return parts.join('\n\n') || 'No results found.'
}

// ---------------------------------------------------------------------------
// Google URL → Serper routing
// ---------------------------------------------------------------------------

interface GoogleUrlRoute {
  query: string
  searchType: string
}

export interface GoogleDriveUrlRoute {
  id: string
  kind: 'file' | 'document' | 'spreadsheet' | 'presentation'
  downloadUrl: string
  extension: string
}

/**
 * Convert public Drive/Docs URLs into a direct export/download request.
 * Drive share pages require browser cookies and otherwise return login or
 * virus-scan HTML, so they must not go through the generic text fetcher.
 */
export function detectGoogleDriveUrl(url: string): GoogleDriveUrlRoute | null {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return null
  }

  const host = u.hostname.replace(/^www\./, '')
  if (host === 'drive.google.com') {
    const pathId = u.pathname.match(/^\/file\/d\/([^/]+)/)?.[1]
    const id = pathId || u.searchParams.get('id')
    if (!id) return null
    return {
      id,
      kind: 'file',
      extension: '',
      downloadUrl: `https://drive.google.com/uc?export=download&id=${encodeURIComponent(id)}&confirm=t`,
    }
  }

  if (host !== 'docs.google.com') return null
  const match = u.pathname.match(/^\/(document|spreadsheets|presentation)\/d\/([^/]+)/)
  if (!match) return null
  const kind = match[1] === 'document' ? 'document' : match[1] === 'spreadsheets' ? 'spreadsheet' : 'presentation'
  const format = kind === 'document' ? 'txt' : kind === 'spreadsheet' ? 'xlsx' : 'pptx'
  return {
    id: match[2],
    kind,
    extension: `.${format}`,
    downloadUrl: `https://docs.google.com/${match[1]}/d/${encodeURIComponent(match[2])}/export?format=${format}`,
  }
}

function driveFilename(route: GoogleDriveUrlRoute, response: Response): string {
  const disposition = response.headers.get('content-disposition') || ''
  const match = disposition.match(/filename\*?=(?:UTF-8''|"?)([^";]+)"?/i)
  const fromHeader = match?.[1] ? decodeURIComponent(match[1]).trim() : ''
  const fallback = `google-drive-${route.id}${route.extension || '.bin'}`
  return (fromHeader || fallback).replace(/[^a-zA-Z0-9._-]/g, '_')
}

async function fetchGoogleDriveFile(url: string, route: GoogleDriveUrlRoute, workspaceDir: string): Promise<AgentToolResult<any>> {
  try {
    const response = await fetch(route.downloadUrl, {
      headers: {
        'User-Agent': BROWSER_USER_AGENT,
        Accept: '*/*',
      },
      signal: AbortSignal.timeout(WEB_FETCH_TIMEOUT_MS),
      redirect: 'follow',
    })
    if (!response.ok) {
      return textResult({
        error: `Google Drive download failed: HTTP ${response.status}`,
        url,
        suggestion: 'Connect Google Drive with connect("googledrive"), or make the file accessible to anyone with the link.',
      })
    }

    const bytes = Buffer.from(await response.arrayBuffer())
    const contentType = response.headers.get('content-type') || ''
    const sample = bytes.subarray(0, 512).toString('utf-8').toLowerCase()
    if (contentType.includes('text/html') || /<html|google\.com\/accounts|virus scan/.test(sample)) {
      return textResult({
        error: 'Google Drive returned a login or download-confirmation page instead of the file.',
        url,
        suggestion: 'Connect Google Drive with connect("googledrive"), or make the file accessible to anyone with the link.',
      })
    }

    const filename = driveFilename(route, response)
    const filesDir = join(workspaceDir, 'files')
    mkdirSync(filesDir, { recursive: true })
    const absolutePath = join(filesDir, filename)
    writeFileSync(absolutePath, bytes)
    const savedPath = `files/${filename}`
    return textResult({
      ok: true,
      url,
      downloadedPath: savedPath,
      bytes: bytes.length,
      contentType: contentType || 'application/octet-stream',
      message: `Downloaded Google Drive file to ${savedPath}`,
    })
  } catch (err: any) {
    return textResult({
      error: `Google Drive download failed: ${err?.message || String(err)}`,
      url,
      suggestion: 'Connect Google Drive with connect("googledrive"), or make the file accessible to anyone with the link.',
    })
  }
}

/**
 * Detects Google property URLs that won't return useful content via raw HTTP
 * fetch (Maps, Flights, Shopping) and converts them into Serper API queries.
 */
function detectGoogleUrl(url: string): GoogleUrlRoute | null {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return null
  }

  const host = u.hostname.replace('www.', '')
  if (host !== 'google.com' && !host.endsWith('.google.com')) return null

  const path = u.pathname

  // Maps directions: /maps/dir/ORIGIN/DESTINATION
  const dirMatch = path.match(/^\/maps\/dir\/([^/]+)\/([^/]+)/)
  if (dirMatch) {
    const origin = decodeURIComponent(dirMatch[1]).replace(/\+/g, ' ')
    const dest = decodeURIComponent(dirMatch[2]).replace(/\+/g, ' ')
    return {
      query: `directions from ${origin} to ${dest}`,
      searchType: 'search',
    }
  }

  // Maps place: /maps/place/PLACE
  const placeMatch = path.match(/^\/maps\/place\/([^/@]+)/)
  if (placeMatch) {
    return {
      query: decodeURIComponent(placeMatch[1]).replace(/\+/g, ' '),
      searchType: 'places',
    }
  }

  // Maps search: /maps/search/QUERY
  const mapSearchMatch = path.match(/^\/maps\/search\/([^/@]+)/)
  if (mapSearchMatch) {
    return {
      query: decodeURIComponent(mapSearchMatch[1]).replace(/\+/g, ' '),
      searchType: 'places',
    }
  }

  // Maps with ?q= parameter
  if (path.startsWith('/maps') && u.searchParams.get('q')) {
    return { query: u.searchParams.get('q')!, searchType: 'places' }
  }

  // Flights: /travel/flights
  if (path.startsWith('/travel/flights')) {
    const q = u.searchParams.get('q')
    if (q) return { query: q, searchType: 'search' }
    const tfs = u.searchParams.get('tfs')
    return { query: tfs ? `flights ${tfs}` : 'flights', searchType: 'search' }
  }

  // Shopping: /shopping
  if (path.startsWith('/shopping')) {
    const q = u.searchParams.get('q') || 'shopping'
    return { query: q, searchType: 'shopping' }
  }

  return null
}

const MIN_USEFUL_CONTENT_LENGTH = 200

// ---------------------------------------------------------------------------
// Web response cache (Redis-backed, enabled by WEB_CACHE_REDIS_URL env var)
// ---------------------------------------------------------------------------

type Redis = import('ioredis').default

const WEB_CACHE_TTL = 60 * 60 * 24 * 30 // 30 days

let _webCacheRedis: Redis | null = null
let _webCacheRedisFailed = false
function getWebCacheRedis(): Redis | null {
  // Read env at call time so tests can flip it; production behavior is
  // unchanged (env vars don't change after process start).
  const WEB_CACHE_REDIS_URL = process.env.WEB_CACHE_REDIS_URL
  if (!WEB_CACHE_REDIS_URL || _webCacheRedisFailed) return null
  if (!_webCacheRedis) {
    const Redis = require('ioredis').default as new (...args: any[]) => Redis
    _webCacheRedis = new Redis(WEB_CACHE_REDIS_URL, {
      maxRetriesPerRequest: 1,
      connectTimeout: 3000,
      lazyConnect: true,
      retryStrategy(times: number) {
        if (times > 3) return null // stop retrying after 3 attempts
        return Math.min(times * 500, 2000)
      },
    })
    _webCacheRedis.on('error', () => {})
    _webCacheRedis.on('end', () => {
      _webCacheRedisFailed = true
      _webCacheRedis = null
    })
    _webCacheRedis.connect().catch(() => {
      _webCacheRedisFailed = true
      _webCacheRedis = null
    })
  }
  return _webCacheRedis
}

function webCacheKey(prefix: string, input: string): string | null {
  if (!process.env.WEB_CACHE_REDIS_URL) return null
  const hash = Bun.hash(input).toString(36)
  return `web-cache:${prefix}:${hash}`
}

async function webCacheGet<T>(key: string | null): Promise<T | null> {
  if (!key) return null
  try {
    const redis = getWebCacheRedis()
    if (!redis) return null
    const raw = await redis.get(key)
    if (raw) return JSON.parse(raw)
  } catch {}
  return null
}

async function webCachePut(key: string | null, value: unknown, ttlSeconds = WEB_CACHE_TTL): Promise<void> {
  if (!key) return
  try {
    const redis = getWebCacheRedis()
    if (!redis) return
    await redis.set(key, JSON.stringify(value), 'EX', ttlSeconds)
  } catch {}
}

// ---------------------------------------------------------------------------
// Unified Web Tool (fetch + search + smart Google routing)
// ---------------------------------------------------------------------------

async function serperSearch(
  query: string,
  searchType: string,
  opts: { num?: number; gl?: string; hl?: string } = {},
): Promise<AgentToolResult<any>> {
  const { num = 10, gl = 'us', hl = 'en' } = opts

  const cacheKey = webCacheKey('search', JSON.stringify({ query, searchType, num, gl, hl }))
  const cached = await webCacheGet<AgentToolResult<any>>(cacheKey)
  if (cached) return cached

  const directKey = process.env.SERPER_API_KEY
  const proxyUrl = process.env.TOOLS_PROXY_URL
  const proxyToken = process.env.AI_PROXY_TOKEN

  const apiKey = directKey || proxyToken
  if (!apiKey) {
    return textResult({
      error: 'SERPER_API_KEY not configured and no proxy available. Web search is unavailable.',
      suggestion: 'Set SERPER_API_KEY or configure TOOLS_PROXY_URL + AI_PROXY_TOKEN.',
    })
  }

  const endpoint = directKey ? SERPER_ENDPOINTS[searchType] || SERPER_ENDPOINTS.search : `${proxyUrl}/serper/${searchType || 'search'}`

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'X-API-KEY': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ q: query, num, gl, hl }),
      signal: AbortSignal.timeout(15000),
    })

    if (!response.ok) {
      const errorText = await response.text().catch(() => '')
      return textResult({
        error: `Serper API error: HTTP ${response.status}`,
        details: errorText,
        query,
      })
    }

    const data = (await response.json()) as SerperResponse
    const formatted = formatSerperResults(data, searchType)

    const result = textResult({
      results: formatted,
      raw: data,
      query,
      searchType,
      creditsUsed: data.credits,
    })
    await webCachePut(cacheKey, result)
    return result
  } catch (err: any) {
    return textResult({ error: `Web search failed: ${err.message}`, query })
  }
}

async function rawFetch(url: string, maxChars: number): Promise<AgentToolResult<any>> {
  const cacheKey = webCacheKey('fetch', JSON.stringify({ url, maxChars }))
  const cached = await webCacheGet<AgentToolResult<any>>(cacheKey)
  if (cached) return cached

  // Wikipedia: use Parsoid REST API → Markdown for much better structured content
  const wiki = parseWikipediaUrl(url)
  if (wiki) {
    try {
      const markdown = await fetchWikipediaAsMarkdown(wiki.lang, wiki.title, maxChars)
      if (markdown.length > 100) {
        const result = textResult({
          content: markdown,
          status: 200,
          bytes: markdown.length,
          url,
          type: 'wikipedia-markdown',
        })
        await webCachePut(cacheKey, result)
        return result
      }
    } catch {}
    // Fall through to normal fetch if Wikipedia API fails
  }

  const headers: Record<string, string> = {
    'User-Agent': BROWSER_USER_AGENT,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,application/json,text/plain;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
  }

  const MAX_ATTEMPTS = 2

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const response = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(WEB_FETCH_TIMEOUT_MS),
        redirect: 'follow',
      })

      if (response.status === 403 || response.status === 429) {
        if (attempt < MAX_ATTEMPTS) {
          await new Promise((r) => setTimeout(r, 1000))
          continue
        }
        return textResult({
          error: `HTTP ${response.status}: Access denied or rate limited. The site may block automated requests.`,
          url,
          suggestion: 'Try again with a query instead of a URL, or try a different source.',
        })
      }

      if (!response.ok) {
        return textResult({
          error: `HTTP ${response.status}: ${response.statusText}`,
          url,
        })
      }

      const contentType = response.headers.get('content-type') || ''

      if (contentType.includes('application/pdf') || url.endsWith('.pdf')) {
        try {
          const { extractText, getDocumentProxy } = await import('unpdf')
          const arrayBuf = await response.arrayBuffer()
          const pdf = await getDocumentProxy(new Uint8Array(arrayBuf))
          const { text: pdfText } = await extractText(pdf, {
            mergePages: true,
          })
          const cleaned = cleanPlainText(pdfText)
          const truncated = cleaned.length > maxChars ? cleaned.substring(0, maxChars) + `\n\n[Truncated at ${maxChars} chars]` : cleaned
          const result = textResult({
            content: truncated,
            status: response.status,
            bytes: truncated.length,
            url,
            type: 'pdf',
          })
          await webCachePut(cacheKey, result)
          return result
        } catch (pdfErr: any) {
          return textResult({
            error: `Failed to extract text from PDF: ${pdfErr.message}`,
            url,
          })
        }
      }

      let text = await response.text()

      if (contentType.includes('text/html') || contentType.includes('application/xhtml')) {
        text = await stripHtmlToText(text)
      }

      if (text.length > maxChars) {
        text = text.substring(0, maxChars) + `\n\n[Truncated at ${maxChars} chars]`
      }

      const result = textResult({
        content: text,
        status: response.status,
        bytes: text.length,
        url,
      })
      await webCachePut(cacheKey, result)
      return result
    } catch (err: any) {
      if (attempt < MAX_ATTEMPTS && (err.name === 'TimeoutError' || err.code === 'ECONNRESET')) {
        await new Promise((r) => setTimeout(r, 500))
        continue
      }
      return textResult({ error: err.message, url })
    }
  }

  return textResult({ error: 'All fetch attempts failed', url })
}

function createWebTool(ctx: ToolContext): AgentTool {
  return {
    name: 'web',
    description:
      'Unified web tool: fetch a URL or search the web via Google (Serper API). Provide `url` to fetch a page, or `query` to search. Google property URLs (Maps, Flights, Shopping) are automatically routed through the search API for rich results. Search types: "search" (default), "news", "images", "places", "maps", "shopping".',
    label: 'Web',
    parameters: Type.Object({
      url: Type.Optional(
        Type.String({
          description: 'URL to fetch. Google URLs (Maps, Flights, Shopping) are auto-routed to search API.',
        }),
      ),
      query: Type.Optional(
        Type.String({
          description: 'Search query (e.g., "best restaurants in Bali", "directions from LAX to SFO")',
        }),
      ),
      searchType: Type.Optional(
        Type.String({
          description: 'Type of search: "search" (default), "news", "images", "places", "maps", "shopping"',
        }),
      ),
      num: Type.Optional(
        Type.Number({
          description: 'Number of search results (default: 10, max: 100)',
        }),
      ),
      gl: Type.Optional(
        Type.String({
          description: 'Country code for localized results (e.g., "us", "uk", "id")',
        }),
      ),
      hl: Type.Optional(Type.String({ description: 'Language code (e.g., "en", "id", "fr")' })),
      maxChars: Type.Optional(
        Type.Number({
          description: 'Maximum characters for URL fetch (default: 50000)',
        }),
      ),
    }),
    execute: async (_toolCallId, params) => {
      const {
        url,
        query,
        searchType = 'search',
        num = 10,
        gl = 'us',
        hl = 'en',
        maxChars = 50000,
      } = params as {
        url?: string
        query?: string
        searchType?: string
        num?: number
        gl?: string
        hl?: string
        maxChars?: number
      }

      if (!url && !query) {
        return textResult({
          error: 'Provide either `url` (to fetch a page) or `query` (to search the web).',
        })
      }

      // If a URL is provided, check for Google property routing first
      if (url) {
        const driveRoute = detectGoogleDriveUrl(url)
        if (driveRoute) {
          return fetchGoogleDriveFile(url, driveRoute, ctx.workspaceDir)
        }
        const googleRoute = detectGoogleUrl(url)
        if (googleRoute) {
          return serperSearch(googleRoute.query, googleRoute.searchType, {
            num,
            gl,
            hl,
          })
        }

        // Raw fetch for non-Google URLs
        const result = await rawFetch(url, maxChars)
        const details = result.details

        // If the page returned very little useful content, fallback to Serper
        if (
          !details?.error &&
          typeof details?.content === 'string' &&
          details.content.trim().length < MIN_USEFUL_CONTENT_LENGTH &&
          (process.env.SERPER_API_KEY || (process.env.TOOLS_PROXY_URL && process.env.AI_PROXY_TOKEN))
        ) {
          const fallbackQuery = query || url
          const fallback = await serperSearch(fallbackQuery, searchType, {
            num,
            gl,
            hl,
          })
          fallback.details._note = `Raw fetch returned minimal content (${details.content.trim().length} chars); fell back to search.`
          fallback.details._originalUrl = url
          return fallback
        }

        return result
      }

      // Pure search path
      return serperSearch(query!, searchType, { num, gl, hl })
    },
  }
}

function createMemoryReadTool(ctx: ToolContext): AgentTool {
  return {
    name: 'memory_read',
    description: 'Read agent memory. Use "MEMORY.md" for long-lived facts or a date like "2026-02-18" for daily logs.',
    label: 'Read Memory',
    parameters: Type.Object({
      file: Type.String({
        description: '"MEMORY.md" or a date string (YYYY-MM-DD)',
      }),
    }),
    execute: async (_toolCallId, params) => {
      const { file } = params as { file: string }
      const filePath = file === 'MEMORY.md' ? join(ctx.workspaceDir, 'MEMORY.md') : join(ctx.workspaceDir, 'memory', `${file}.md`)

      if (!existsSync(filePath)) {
        return textResult({ content: '', exists: false })
      }
      return textResult({
        content: readFileSync(filePath, 'utf-8'),
        exists: true,
      })
    },
  }
}

function createMemorySearchTool(ctx: ToolContext): AgentTool {
  let engine: MemorySearchEngine | null = null

  function getEngine(): MemorySearchEngine {
    if (!engine) {
      engine = new MemorySearchEngine(ctx.workspaceDir)
    }
    return engine
  }

  return {
    name: 'memory_search',
    description:
      'Search across all agent memory (MEMORY.md and daily logs) using hybrid keyword + semantic matching. Returns the most relevant memory chunks ranked by relevance.',
    label: 'Search Memory',
    parameters: Type.Object({
      query: Type.String({ description: 'Natural language search query' }),
      limit: Type.Optional(Type.Number({ description: 'Max results to return (default: 8)' })),
    }),
    execute: async (_toolCallId, params) => {
      const { query, limit = 8 } = params as { query: string; limit?: number }

      try {
        const results = getEngine().search(query, limit)
        return textResult({
          query,
          results: results.map((r) => ({
            file: r.file,
            lines: `${r.lineStart}-${r.lineEnd}`,
            score: Math.round(r.score * 100) / 100,
            matchType: r.matchType,
            content: r.chunk,
          })),
          totalMatches: results.length,
        })
      } catch (err: any) {
        return textResult({
          error: `Memory search failed: ${err.message}`,
          query,
        })
      }
    },
  }
}

function createSearchHistoryTool(ctx: ToolContext): AgentTool {
  let index: HistoryIndex | null = null
  const local = () => (index ??= new HistoryIndex(ctx.workspaceDir))
  return {
    name: 'search_history',
    description:
      'Search previous Shogo chats and plans for earlier decisions, conversations, and implementation plans. ' +
      'Use workspace scope in a multi-project workspace.',
    label: 'Search Chat History',
    parameters: Type.Object({
      query: Type.String({
        description: 'Words or a natural-language phrase to search for',
      }),
      kind: Type.Optional(Type.Union([Type.Literal('chat'), Type.Literal('plan'), Type.Literal('all')])),
      scope: Type.Optional(Type.Union([Type.Literal('project'), Type.Literal('workspace')])),
      limit: Type.Optional(Type.Number()),
    }),
    execute: async (_id, raw) => {
      const params = raw as {
        query: string
        kind?: HistoryKind | 'all'
        scope?: 'project' | 'workspace'
        limit?: number
      }
      const scope = params.scope ?? (workspaceMetaToolEnabled(ctx) ? 'workspace' : 'project')
      if (scope === 'workspace' && workspaceMetaToolEnabled(ctx)) {
        try {
          const workspaceId = resolveWorkspaceId(ctx)
          const qs = new URLSearchParams({
            query: params.query,
            kind: params.kind || 'all',
            limit: String(params.limit || 8),
            ...(ctx.userId ? { userId: ctx.userId } : {}),
            ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}),
          })
          return textResult({
            scope,
            ...(await workspaceMetaFetch(ctx, `/api/internal/workspaces/${encodeURIComponent(workspaceId!)}/history/search?${qs}`)),
          })
        } catch (error: any) {
          const results = local().search(params.query, {
            kind: params.kind,
            limit: params.limit,
            excludeRefId: ctx.sessionId,
          })
          return textResult({
            scope: 'project',
            fallback: true,
            warning: error?.message || String(error),
            results,
            totalMatches: results.length,
          })
        }
      }
      const results = local().search(params.query, {
        kind: params.kind,
        limit: params.limit,
        excludeRefId: ctx.sessionId,
      })
      return textResult({
        scope: 'project',
        results,
        totalMatches: results.length,
      })
    },
  }
}

function createReadHistoryTool(ctx: ToolContext): AgentTool {
  let index: HistoryIndex | null = null
  const local = () => (index ??= new HistoryIndex(ctx.workspaceDir))
  return {
    name: 'read_history',
    description:
      'Read a previous chat transcript or plan returned by search_history, or a chat the person tagged with @.',
    label: 'Read Chat History',
    parameters: Type.Object({
      kind: Type.Union([Type.Literal('chat'), Type.Literal('plan')]),
      id: Type.String(),
      scope: Type.Optional(Type.Union([Type.Literal('project'), Type.Literal('workspace')])),
      projectId: Type.Optional(Type.String()),
      fromSeq: Type.Optional(Type.Number()),
      limit: Type.Optional(Type.Number()),
    }),
    execute: async (_id, raw) => {
      const params = raw as {
        kind: 'chat' | 'plan'
        id: string
        scope?: 'project' | 'workspace'
        projectId?: string
        fromSeq?: number
        limit?: number
      }
      const scope = params.scope ?? (workspaceMetaToolEnabled(ctx) ? 'workspace' : 'project')
      if (scope === 'workspace' && workspaceMetaToolEnabled(ctx)) {
        try {
          const workspaceId = resolveWorkspaceId(ctx)
          const qs = new URLSearchParams({
            kind: params.kind,
            id: params.id,
            ...(params.projectId ? { projectId: params.projectId } : {}),
            ...(params.fromSeq != null ? { from: String(params.fromSeq) } : {}),
            ...(params.limit != null ? { limit: String(params.limit) } : {}),
          })
          return textResult({
            scope,
            ...(await workspaceMetaFetch(ctx, `/api/internal/workspaces/${encodeURIComponent(workspaceId!)}/history/read?${qs}`)),
          })
        } catch (error: any) {
          return textResult({
            error: error?.message || String(error),
            kind: params.kind,
            id: params.id,
          })
        }
      }
      const result =
        params.kind === 'chat'
          ? local().readChat(params.id, {
              fromSeq: params.fromSeq,
              limit: params.limit,
            })
          : local().readPlan(params.id)
      return textResult({
        scope: 'project',
        kind: params.kind,
        id: params.id,
        result,
      })
    },
  }
}

function spawnCDPRelay(token: string): Promise<{ cdpEndpoint: string; kill: () => void }> {
  const { spawn } = require('@shogo/shared-runtime/child-process') as typeof import('@shogo/shared-runtime/child-process')
  // Use fileURLToPath so this works on Windows. `new URL(import.meta.url).pathname`
  // returns a `/C:/...` path that breaks existsSync / spawn on win32.
  const srcDir = dirname(fileURLToPath(import.meta.url))
  const relayScript = existsSync(join(srcDir, 'browser-relay.cjs'))
    ? join(srcDir, 'browser-relay.cjs')
    : join(srcDir, '..', 'src', 'browser-relay.cjs')
  const channel = process.env.BROWSER_CHANNEL || 'chrome'
  const execPath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || ''
  const timeout = '90000'

  return new Promise((resolve, reject) => {
    const child = spawn('node', [relayScript, channel, execPath, timeout], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PLAYWRIGHT_MCP_EXTENSION_TOKEN: token },
    })

    let stderr = ''
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString() })

    child.on('error', (err: Error) => reject(new Error(`Failed to start relay: ${err.message}`)))
    child.on('exit', (code: number | null) => {
      if (code !== null && code !== 0) reject(new Error(`Relay exited with code ${code}: ${stderr}`))
    })

    let buffer = ''
    child.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString()
      const lines = buffer.split('\n')
      buffer = lines.pop()!
      for (const line of lines) {
        if (!line.trim()) continue
        try {
          const msg = JSON.parse(line)
          if (msg.type === 'error') {
            child.kill()
            reject(new Error(msg.message))
          } else if (msg.type === 'connected' && (child as any).__cdpEndpoint) {
            resolve({
              cdpEndpoint: (child as any).__cdpEndpoint,
              kill: () => child.kill(),
            })
          } else if (msg.type === 'ready') {
            ;(child as any).__cdpEndpoint = msg.cdpEndpoint
          }
        } catch {}
      }
    })

    setTimeout(() => {
      child.kill()
      reject(
        new Error('Relay connection timed out (90s). Make sure the Playwright MCP Bridge extension is installed and the token is correct.'),
      )
    }, 95000)
  })
}

/**
 * Optional capture tap for the `browser` tool. When SHOGO_MOCK_CAPTURE_DIR
 * is set the runtime writes every browser-action call (params + response,
 * plus PNG bytes for screenshots) into that directory so the demo
 * fixture loader can replay them later.
 *
 * Format on disk:
 *   <dir>/manifest.json                    — ordered step list
 *   <dir>/step-001.json                    — { idx, action, params, response, screenshotFile? }
 *   <dir>/screenshots/step-001.png         — full screenshot bytes (only for screenshot)
 *
 * The replay loader (loadBrowserFixturesFromDir, see tool-mocks-demo.ts)
 * keys each call by JSON-stringified params so the replay survives
 * agent re-runs as long as the agent makes the same calls in the same
 * order. If the agent diverges we fall back to the closest action match
 * inside the loader.
 */
function captureBrowserCall(
  dir: string,
  entry: {
    idx: number
    action: string
    params: Record<string, any>
    response: any
    screenshotBuffer?: Buffer
  },
): void {
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const idxPad = String(entry.idx).padStart(3, '0')
    let screenshotFile: string | undefined
    if (entry.screenshotBuffer) {
      const screenshotsDir = join(dir, 'screenshots')
      if (!existsSync(screenshotsDir)) mkdirSync(screenshotsDir, { recursive: true })
      screenshotFile = `screenshots/step-${idxPad}.png`
      writeFileSync(join(dir, screenshotFile), entry.screenshotBuffer)
    }
    const stepFile = join(dir, `step-${idxPad}.json`)
    writeFileSync(
      stepFile,
      JSON.stringify(
        {
          idx: entry.idx,
          action: entry.action,
          params: entry.params,
          response: entry.response,
          screenshotFile,
          ts: Date.now(),
        },
        null,
        2,
      ),
    )
    // Maintain manifest.json so the loader doesn't have to scandir.
    const manifestPath = join(dir, 'manifest.json')
    let manifest: {
      steps: Array<{ idx: number; action: string; file: string }>
    } = { steps: [] }
    if (existsSync(manifestPath)) {
      try {
        manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'))
      } catch {}
    }
    manifest.steps.push({
      idx: entry.idx,
      action: entry.action,
      file: `step-${idxPad}.json`,
    })
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))
  } catch (err) {
    // Capture is best-effort; never break the tool call if capture I/O fails.
    console.warn(`[browser-capture] failed to write step ${entry.idx}: ${(err as any)?.message}`)
  }
}

const BROWSER_TOOL_IDLE_RELEASE_MS = 5 * 60 * 1000

const browserToolDisposers = new WeakMap<AgentTool, () => Promise<void>>()

/** Release the browser resources held by a tool from createBrowserTool (no-op otherwise). */
export async function disposeBrowserTool(tool: AgentTool | undefined): Promise<void> {
  const dispose = tool ? browserToolDisposers.get(tool) : undefined
  if (dispose) await dispose()
}

// Errors meaning the page/context/browser is gone, as opposed to an ordinary
// action failure where the page (and the user's state in it) is still usable.
const DEAD_BROWSER_ERROR_RE =
  /target (page, context or browser )?(has been )?closed|browser has been closed|browser has disconnected|browser closed|context closed|page (has been )?closed|page crashed|target crashed|connection closed/i

export function isDeadBrowserError(message: string | undefined): boolean {
  return !!message && DEAD_BROWSER_ERROR_RE.test(message)
}

export const BROWSER_VIEWPORT_PRESETS = {
  mobile: { width: 390, height: 844 },
  tablet: { width: 768, height: 1024 },
  desktop: { width: 1440, height: 900 },
} as const

const BROWSER_LOG_LIMIT = 200
const BROWSER_LOG_TEXT_LIMIT = 1000

interface BrowserLogEntry {
  kind: 'console' | 'pageerror' | 'network'
  level: 'error' | 'warning' | 'info'
  text: string
  source?: string
  ts: string
}

// Chromium evaluates a string as an expression, so agent code written as a
// function body (top-level `return` / `await`) fails to parse before running.
const EVALUATE_STATEMENT_SYNTAX_RE = /Illegal return statement|await is only valid|Unexpected reserved word/i

export function createBrowserTool(ctx: ToolContext): AgentTool {
  let browser: any = null
  let lease: BrowserLease | null = null
  let unregisterSessionCleanup: (() => void) | null = null
  let ensurePromise: Promise<any> | null = null
  let idleReleaseTimer: ReturnType<typeof setTimeout> | null = null
  let inFlightCalls = 0
  let page: any = null
  let isExtensionMode = false
  let killRelay: (() => void) | null = null
  let cdpSession: any = null
  let screencastStarted = false
  let screencastPageKey: any = null
  let frameCount = 0
  // Per-tool-instance counter so screenshot files sort chronologically inside
  // a run folder (`step-01.png`, `step-02.png`, ...). See screenshot-manager.
  let screenshotCount = 0
  let screenshotHousekeepingDone = false
  let viewportSize: { width: number; height: number } | null = null
  let logEntries: BrowserLogEntry[] = []
  let droppedLogEntries = 0
  const pagesWithLogListeners = new WeakSet<object>()

  scLog(`[screencast] createBrowserTool instanceId=${ctx.subagentInstanceId ?? '<none>'}`)

  function pushLog(entry: Omit<BrowserLogEntry, 'ts'>) {
    const text = entry.text.length > BROWSER_LOG_TEXT_LIMIT ? `${entry.text.slice(0, BROWSER_LOG_TEXT_LIMIT)}…` : entry.text
    logEntries.push({ ...entry, text, ts: new Date().toISOString() })
    if (logEntries.length > BROWSER_LOG_LIMIT) {
      droppedLogEntries += logEntries.length - BROWSER_LOG_LIMIT
      logEntries = logEntries.slice(-BROWSER_LOG_LIMIT)
    }
  }

  function attachLogListeners(p: any) {
    if (!p?.on || pagesWithLogListeners.has(p)) return
    pagesWithLogListeners.add(p)
    p.on('console', (msg: any) => {
      try {
        const type = String(msg.type?.() ?? 'log')
        const loc = msg.location?.() ?? {}
        pushLog({
          kind: 'console',
          level: type === 'error' ? 'error' : type === 'warning' ? 'warning' : 'info',
          text: String(msg.text?.() ?? ''),
          source: loc.url ? `${loc.url}${loc.lineNumber !== undefined ? `:${loc.lineNumber}` : ''}` : undefined,
        })
      } catch {}
    })
    p.on('pageerror', (err: any) => {
      pushLog({ kind: 'pageerror', level: 'error', text: String(err?.message ?? err) })
    })
    p.on('requestfailed', (req: any) => {
      try {
        const reason = req.failure?.()?.errorText ?? 'failed'
        pushLog({ kind: 'network', level: 'error', text: `${req.method?.() ?? 'GET'} ${req.url?.()} ${reason}` })
      } catch {}
    })
    p.on('response', (res: any) => {
      try {
        const status = Number(res.status?.())
        if (!(status >= 400)) return
        pushLog({
          kind: 'network',
          level: status >= 500 ? 'error' : 'warning',
          text: `${status} ${res.request?.()?.method?.() ?? 'GET'} ${res.url?.()}`,
        })
      } catch {}
    })
  }

  async function preparePage(p: any) {
    attachLogListeners(p)
    if (viewportSize && p?.setViewportSize) await p.setViewportSize(viewportSize)
  }

  async function ensureScreencast() {
    // Only broadcast when this tool is running inside a spawned subagent
    // (so the mobile LiveBrowserView can subscribe by instance id). Skip
    // extension mode — we don't own the browser there, and attaching CDP
    // to a user's real Chrome would be invasive.
    const instanceId = ctx.subagentInstanceId
    if (!instanceId) {
      scLog('[screencast] ensureScreencast bail: no subagentInstanceId on ctx')
      return
    }
    if (isExtensionMode) {
      scLog(`[screencast] ensureScreencast bail: extension mode instanceId=${instanceId}`)
      return
    }
    if (!page) {
      scLog(`[screencast] ensureScreencast bail: no page yet instanceId=${instanceId}`)
      return
    }
    // If the page changed (rare — we don't swap pages today), tear down + redo.
    if (screencastStarted && screencastPageKey === page) return
    if (screencastStarted && screencastPageKey !== page) {
      scLog(`[screencast] ensureScreencast page changed; restarting instanceId=${instanceId}`)
      try {
        if (cdpSession) await cdpSession.send('Page.stopScreencast')
      } catch {}
      try {
        if (cdpSession) await cdpSession.detach()
      } catch {}
      cdpSession = null
      screencastStarted = false
    }
    try {
      const { publish } = await import('./screencast-broadcaster')
      cdpSession = await page.context().newCDPSession(page)
      scLog(`[screencast] CDP session attached instanceId=${instanceId}`)
      cdpSession.on('Page.screencastFrame', async (e: any) => {
        frameCount++
        if (frameCount === 1 || frameCount % 60 === 0) {
          scLog(
            `[screencast] CDP frame#${frameCount} instanceId=${instanceId} ` +
              `size=${e?.metadata?.deviceWidth ?? '?'}x${e?.metadata?.deviceHeight ?? '?'} ` +
              `dataLen=${(e?.data as string | undefined)?.length ?? 0}`,
          )
        }
        try {
          publish(instanceId, {
            jpegBase64: e.data,
            ts: Date.now(),
            width: e?.metadata?.deviceWidth ?? 0,
            height: e?.metadata?.deviceHeight ?? 0,
          })
        } catch (err: any) {
          scWarn(`[screencast] publish threw instanceId=${instanceId}: ${err?.message ?? err}`)
        }
        try {
          await cdpSession.send('Page.screencastFrameAck', {
            sessionId: e.sessionId,
          })
        } catch {}
      })
      await cdpSession.send('Page.startScreencast', {
        format: 'jpeg',
        quality: 60,
        everyNthFrame: 2,
        maxWidth: 1280,
        maxHeight: 720,
      })
      screencastStarted = true
      screencastPageKey = page
      scLog(`[screencast] Page.startScreencast OK instanceId=${instanceId}`)
    } catch (err: any) {
      // Screencast is best-effort — if CDP isn't available, the browser tool still works.
      scWarn(`[screencast] ensureScreencast failed instanceId=${instanceId}: ${err?.message ?? err}`)
      try {
        if (cdpSession) await cdpSession.detach()
      } catch {}
      cdpSession = null
      screencastStarted = false
    }
  }

  async function ensureBrowser() {
    if (page && (isExtensionMode ? browser : lease)) {
      if (!isExtensionMode && page.isClosed?.()) {
        await cleanup()
      } else {
        await ensureScreencast()
        return page
      }
    }
    // Parallel calls on one tool instance must not each acquire a context.
    if (!ensurePromise) {
      ensurePromise = openBrowser().finally(() => {
        ensurePromise = null
      })
    }
    return ensurePromise
  }

  async function openBrowser() {
    try {
      const pw = await import('playwright-core')

      const extensionToken = process.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN
      if (extensionToken) {
        const directCdpEndpoint = process.env.BROWSER_CDP_ENDPOINT
        if (directCdpEndpoint) {
          browser = await pw.chromium.connectOverCDP(directCdpEndpoint)
        } else {
          const relay = await spawnCDPRelay(extensionToken)
          killRelay = relay.kill
          browser = await pw.chromium.connectOverCDP(relay.cdpEndpoint, {
            isLocal: true,
          })
        }

        const browserCtx = browser.contexts()[0]
        page = browserCtx?.pages()[0] || (await browser.newPage())
        isExtensionMode = true
      } else {
        const acquired = await getSharedBrowserPool().acquire()
        try {
          page = await acquired.context.newPage()
        } catch (err) {
          await acquired.release()
          throw err
        }
        lease = acquired
        if (ctx.sessionId) {
          unregisterSessionCleanup = registerBrowserSessionCleanup(ctx.sessionId, () => cleanup())
        }
      }
      await preparePage(page)
      await ensureScreencast()
      return page
    } catch (err: any) {
      cleanupRelay()
      if (err instanceof BrowserPoolTimeoutError) throw err
      if (process.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN) {
        throw new Error(
          `Failed to connect to browser via extension: ${err.message}. ` +
            'Make sure Chrome is running with the "Playwright MCP Bridge" extension installed, ' +
            'and the extension token matches.',
        )
      }
      const execPath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || '(not set)'
      throw new Error(
        `Browser launch failed: ${err.message}. ` +
          `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=${execPath}. ` +
          'If running locally, try: bun x playwright install chromium',
      )
    }
  }

  function cleanupRelay() {
    if (killRelay) {
      try {
        killRelay()
      } catch {}
      killRelay = null
    }
  }

  function clearIdleRelease() {
    if (idleReleaseTimer) {
      clearTimeout(idleReleaseTimer)
      idleReleaseTimer = null
    }
  }

  function scheduleIdleRelease() {
    clearIdleRelease()
    if (!lease) return
    idleReleaseTimer = setTimeout(() => {
      idleReleaseTimer = null
      void cleanup()
    }, BROWSER_TOOL_IDLE_RELEASE_MS)
    ;(idleReleaseTimer as any).unref?.()
  }

  async function cleanup() {
    clearIdleRelease()
    if (unregisterSessionCleanup) {
      unregisterSessionCleanup()
      unregisterSessionCleanup = null
    }
    if (screencastStarted && cdpSession) {
      try {
        await cdpSession.send('Page.stopScreencast')
      } catch {}
      try {
        await cdpSession.detach()
      } catch {}
    }
    cdpSession = null
    screencastStarted = false
    screencastPageKey = null
    if (ctx.subagentInstanceId) {
      try {
        const { dropChannel } = await import('./screencast-broadcaster')
        dropChannel(ctx.subagentInstanceId)
      } catch {}
    }
    const currentPage = page
    const currentLease = lease
    const currentBrowser = browser
    const wasExtensionMode = isExtensionMode
    logEntries = []
    droppedLogEntries = 0
    page = null
    lease = null
    browser = null
    isExtensionMode = false
    if (wasExtensionMode) {
      try {
        if (currentBrowser) await currentBrowser.close()
      } catch {}
    } else {
      try {
        if (currentPage) await currentPage.close()
      } catch {}
      if (currentLease) await currentLease.release()
    }
    cleanupRelay()
  }

  function resolveLocator(p: any, ref?: number, selector?: string): any {
    if (ref !== undefined) return p.locator(`[data-shogo-ref="${ref}"]`)
    if (selector) return p.locator(selector)
    return null
  }

  // Stale refs are the dominant interactive-browser failure: an earlier action
  // mutated the DOM, so the ref numbers from the previous snapshot no longer
  // resolve. Return an actionable, recovery-oriented message instead of a raw
  // Playwright timeout so the agent re-snapshots and retries rather than giving up.
  function staleTargetHint(action: string, ref?: number, selector?: string): string {
    const target = ref !== undefined ? `ref=${ref}` : selector ? `selector="${selector}"` : '(no target)'
    return `${action} target not found (${target}). The page likely changed since your last snapshot, so ref numbers are stale. Call browser({ action: "snapshot" }) again to get fresh refs, then retry the ${action}.`
  }

  // Capture mode: when SHOGO_MOCK_CAPTURE_DIR is set, every browser
  // tool call is dumped to disk for later replay by the demo mock
  // system. The wrapper at the bottom of this function (before the
  // final `return tool`) intercepts execute() and writes step files.
  const captureDir = process.env.SHOGO_MOCK_CAPTURE_DIR || ''
  let browserCaptureCounter = 0

  const tool: AgentTool = {
    name: 'browser',
    description:
      'Control a browser. MUST snapshot before any interaction to get element refs. Actions: navigate, snapshot, click, fill, select, extract, text, screenshot, evaluate, scroll, wait_for, viewport, console, close. Workflow: navigate → snapshot → use ref numbers → snapshot again after changes. viewport resizes the page (device: mobile 390x844, tablet 768x1024, desktop 1440x900, or width/height) — use it for mobile checks. console returns console messages, uncaught page errors and failed/4xx/5xx network requests since the last call. Use read_guide("browser") for details.',
    label: 'Browser',
    parameters: Type.Object({
      action: Type.Union(
        [
          Type.Literal('navigate'),
          Type.Literal('snapshot'),
          Type.Literal('click'),
          Type.Literal('fill'),
          Type.Literal('extract'),
          Type.Literal('text'),
          Type.Literal('screenshot'),
          Type.Literal('evaluate'),
          Type.Literal('select'),
          Type.Literal('scroll'),
          Type.Literal('wait_for'),
          Type.Literal('viewport'),
          Type.Literal('console'),
          Type.Literal('close'),
        ],
        { description: 'Browser action to perform' },
      ),
      device: Type.Optional(
        Type.Union([Type.Literal('mobile'), Type.Literal('tablet'), Type.Literal('desktop')], {
          description: 'Viewport preset (for viewport action)',
        }),
      ),
      width: Type.Optional(Type.Number({ description: 'Viewport width in px (for viewport action, overrides device)' })),
      height: Type.Optional(Type.Number({ description: 'Viewport height in px (for viewport action, overrides device)' })),
      level: Type.Optional(
        Type.Union([Type.Literal('all'), Type.Literal('error')], {
          description: 'For console action: "error" returns only errors (default: all)',
        }),
      ),
      url: Type.Optional(
        Type.String({
          description: 'URL to navigate to (for navigate action)',
        }),
      ),
      ref: Type.Optional(
        Type.Number({
          description: 'Element ref number from snapshot (for click/fill/select — preferred over selector)',
        }),
      ),
      selector: Type.Optional(
        Type.String({
          description: 'CSS selector (fallback for click/fill/extract/select/scroll/wait_for)',
        }),
      ),
      value: Type.Optional(
        Type.String({
          description: 'Text to type (fill), JS to run (evaluate), option value (select), or scroll distance in px (scroll)',
        }),
      ),
      waitMs: Type.Optional(
        Type.Number({
          description: 'Wait time in ms after action (default: 1000)',
        }),
      ),
    }),
    execute: async (_toolCallId, params) => {
      const {
        action,
        url,
        ref,
        selector,
        value,
        waitMs = 1000,
        device,
        width,
        height,
        level,
      } = params as {
        action: string
        url?: string
        ref?: number
        selector?: string
        value?: string
        waitMs?: number
        device?: keyof typeof BROWSER_VIEWPORT_PRESETS
        width?: number
        height?: number
        level?: 'all' | 'error'
      }

      clearIdleRelease()
      inFlightCalls++
      try {
        if (action === 'close') {
          await cleanup()
          return textResult({ ok: true, action: 'close' })
        }

        let requestedViewport: { width: number; height: number } | null = null
        if (action === 'viewport') {
          const preset = device ? BROWSER_VIEWPORT_PRESETS[device] : undefined
          const w = width ?? preset?.width
          const h = height ?? preset?.height
          if (!w || !h || w < 200 || h < 200 || w > 3840 || h > 2160) {
            return textResult({
              error: 'viewport needs device ("mobile" | "tablet" | "desktop") or width and height between 200 and 3840x2160',
            })
          }
          requestedViewport = { width: Math.round(w), height: Math.round(h) }
        }

        const p = await ensureBrowser()

        switch (action) {
          case 'navigate': {
            if (!url) return textResult({ error: 'url is required for navigate' })
            try {
              await p.goto(url, {
                timeout: 30000,
                waitUntil: 'domcontentloaded',
              })
            } catch (navErr: any) {
              // Slow or JS-heavy pages can exceed the domcontentloaded budget
              // while still being perfectly usable. Only hard-fail when no
              // document loaded at all; otherwise continue with the page we got.
              const landed = (() => {
                try {
                  return p.url()
                } catch {
                  return ''
                }
              })()
              if (!landed || landed === 'about:blank') throw navErr
              console.warn(`[browser] navigate soft-timeout for ${url}: ${navErr?.message} — continuing with loaded page ${landed}`)
            }
            // Give SPA/client-rendered content a moment to settle so the first
            // snapshot sees real, ref-able elements instead of an empty shell.
            try {
              await p.waitForLoadState('networkidle', { timeout: 5000 })
            } catch {}
            if (waitMs > 0) await p.waitForTimeout(Math.min(waitMs, 5000))
            const title = await p.title()
            const pageUrl = p.url()
            return textResult({ ok: true, title, url: pageUrl })
          }
          case 'snapshot': {
            const snapshot = (await p.evaluate(ACCESSIBILITY_SNAPSHOT_SCRIPT)) as { text: string; refCount: number }
            return textResult({
              snapshot: snapshot.text,
              url: p.url(),
              title: await p.title(),
              refCount: snapshot.refCount,
            })
          }
          case 'click': {
            const locator = resolveLocator(p, ref, selector)
            if (!locator)
              return textResult({
                error: 'ref or selector is required for click',
              })
            try {
              await locator.scrollIntoViewIfNeeded({ timeout: 3000 })
            } catch {}
            try {
              await locator.click({ timeout: 10000 })
            } catch (clickErr: any) {
              const found = await locator.count().catch(() => 0)
              if (found === 0)
                return textResult({
                  error: staleTargetHint('click', ref, selector),
                  action: 'click',
                })
              throw clickErr
            }
            if (waitMs > 0) await p.waitForTimeout(Math.min(waitMs, 3000))
            return textResult({ ok: true, action: 'click', ref, selector })
          }
          case 'fill': {
            const locator = resolveLocator(p, ref, selector)
            if (!locator)
              return textResult({
                error: 'ref or selector is required for fill',
              })
            if (value === undefined) return textResult({ error: 'value is required for fill' })
            try {
              await locator.scrollIntoViewIfNeeded({ timeout: 3000 })
            } catch {}
            try {
              await locator.fill(value, { timeout: 10000 })
            } catch (fillErr: any) {
              const found = await locator.count().catch(() => 0)
              if (found === 0)
                return textResult({
                  error: staleTargetHint('fill', ref, selector),
                  action: 'fill',
                })
              throw fillErr
            }
            return textResult({ ok: true, action: 'fill', ref, selector })
          }
          case 'extract': {
            if (!selector) return textResult({ error: 'selector is required for extract' })
            const elements = await p.$$eval(selector, (els: Element[]) =>
              els.map((el) => ({
                text: el.textContent?.trim(),
                html: el.outerHTML.substring(0, 500),
              })),
            )
            return textResult({
              elements: elements.slice(0, 50),
              count: elements.length,
              url: p.url(),
            })
          }
          case 'text': {
            const rawText = await p.evaluate(() => document.body.innerText)
            const cleaned = typeof rawText === 'string' ? cleanPlainText(rawText) : rawText
            const truncated =
              typeof cleaned === 'string' && cleaned.length > 50000 ? cleaned.substring(0, 50000) + '\n[Truncated]' : cleaned
            return textResult({
              content: truncated,
              url: p.url(),
              title: await p.title(),
            })
          }
          case 'screenshot': {
            // One-time housekeeping per tool instance: sweep any legacy loose
            // `screenshot-*.png` files at the workspace root into
            // `.shogo/screenshots/legacy/`, and trim retention so we don't
            // accumulate unbounded run folders.
            if (!screenshotHousekeepingDone) {
              screenshotHousekeepingDone = true
              try {
                sweepLooseScreenshots(ctx.workspaceDir)
              } catch {}
              try {
                trimOldScreenshotRuns(ctx.workspaceDir)
              } catch {}
            }
            screenshotCount += 1
            const runDir = resolveScreenshotRunDir(ctx.workspaceDir, ctx.subagentInstanceId)
            const screenshotPath = nextScreenshotFilePath(runDir, screenshotCount)
            const buffer = await p.screenshot({
              path: screenshotPath,
              fullPage: false,
            })
            // Expose the path as workspace-relative so canvas data + markdown
            // reports can reference it portably.
            const relPath = relative(ctx.workspaceDir, screenshotPath)
            const base64 = Buffer.from(buffer).toString('base64')
            const rawContent = [
              { type: 'image' as const, data: base64, mimeType: 'image/png' },
              {
                type: 'text' as const,
                text: JSON.stringify({ ok: true, path: relPath, url: p.url() }),
              },
            ]
            const safeContent = enforceImageSizeLimit(rawContent, {
              label: 'browser:screenshot',
              pathHint: relPath,
            })
            return {
              content: safeContent,
              details: { ok: true, path: relPath, url: p.url() },
            }
          }
          case 'evaluate': {
            if (!value)
              return textResult({
                error: 'value (JS code) is required for evaluate',
              })
            let result: unknown
            try {
              result = await p.evaluate(value)
            } catch (evalErr: any) {
              if (!EVALUATE_STATEMENT_SYNTAX_RE.test(evalErr?.message ?? '')) throw evalErr
              // The syntax error means nothing ran, so retrying is safe.
              const asBody = `(async () => {\n${value}\n})()`
              if (/(^|[;{}\n])\s*return\b/.test(value)) {
                result = await p.evaluate(asBody)
              } else {
                try {
                  result = await p.evaluate(`(async () => { return (\n${value}\n) })()`)
                } catch (exprErr: any) {
                  if (!/SyntaxError/i.test(exprErr?.message ?? '')) throw exprErr
                  result = await p.evaluate(asBody)
                }
              }
            }
            return textResult({ result, url: p.url() })
          }
          case 'viewport': {
            viewportSize = requestedViewport
            await p.setViewportSize(viewportSize)
            return textResult({ ok: true, action: 'viewport', viewport: viewportSize, url: p.url() })
          }
          case 'console': {
            const entries = level === 'error' ? logEntries.filter((e) => e.level === 'error') : logEntries
            const counts = { console: 0, pageerror: 0, network: 0 }
            for (const e of entries) counts[e.kind]++
            const dropped = droppedLogEntries
            logEntries = []
            droppedLogEntries = 0
            return textResult({ entries, counts, ...(dropped ? { dropped } : {}), url: p.url() })
          }
          case 'select': {
            const locator = resolveLocator(p, ref, selector)
            if (!locator)
              return textResult({
                error: 'ref or selector is required for select',
              })
            if (value === undefined) return textResult({ error: 'value is required for select' })
            try {
              await locator.scrollIntoViewIfNeeded({ timeout: 3000 })
            } catch {}
            try {
              await locator.selectOption(value, { timeout: 10000 })
            } catch (selectErr: any) {
              const found = await locator.count().catch(() => 0)
              if (found === 0)
                return textResult({
                  error: staleTargetHint('select', ref, selector),
                  action: 'select',
                })
              throw selectErr
            }
            return textResult({
              ok: true,
              action: 'select',
              ref,
              selector,
              value,
            })
          }
          case 'scroll': {
            if (ref !== undefined || selector) {
              const locator = resolveLocator(p, ref, selector)
              if (locator) await locator.scrollIntoViewIfNeeded({ timeout: 5000 })
            } else {
              const distance = parseInt(value || '500', 10)
              await p.evaluate((d: number) => window.scrollBy(0, d), distance)
            }
            return textResult({ ok: true, action: 'scroll' })
          }
          case 'wait_for': {
            if (!selector) return textResult({ error: 'selector is required for wait_for' })
            await p.waitForSelector(selector, { timeout: waitMs || 10000 })
            return textResult({ ok: true, action: 'wait_for', selector })
          }
          default:
            return textResult({ error: `Unknown browser action: ${action}` })
        }
      } catch (err: any) {
        if (lease && (isDeadBrowserError(err?.message) || page?.isClosed?.())) {
          await cleanup()
        }
        return textResult({ error: `Browser error: ${err.message}`, action })
      } finally {
        inFlightCalls--
        if (inFlightCalls === 0) scheduleIdleRelease()
      }
    },
  }
  browserToolDisposers.set(tool, cleanup)

  if (captureDir) {
    const innerExecute = tool.execute
    tool.execute = async (toolCallId: string, params: any, signal?: any, onUpdate?: any) => {
      const result: any = await innerExecute(toolCallId, params, signal, onUpdate)
      const idx = ++browserCaptureCounter
      const action = String(params?.action ?? 'unknown')
      // For screenshots the response envelope embeds base64 PNG data we
      // can strip out and write as raw bytes — replay then loads the
      // PNG, base64-encodes it, and resurfaces the same multipart shape
      // (see loadBrowserFixturesFromDir in tool-mocks-demo.ts).
      let screenshotBuffer: Buffer | undefined
      let responseToWrite: any = result
      if (action === 'screenshot' && result && Array.isArray(result.content)) {
        const img = result.content.find((c: any) => c?.type === 'image' && typeof c?.data === 'string')
        if (img) {
          try {
            screenshotBuffer = Buffer.from(img.data, 'base64')
          } catch {}
          // Trim the inline base64 from what we serialize to JSON; replay
          // will rehydrate from screenshotFile so JSON stays small.
          responseToWrite = {
            ...result,
            content: result.content.map((c: any) => (c?.type === 'image' ? { type: 'image', mimeType: c.mimeType, dataInFile: true } : c)),
          }
        }
      }
      captureBrowserCall(captureDir, {
        idx,
        action,
        params,
        response: responseToWrite,
        screenshotBuffer,
      })
      return result
    }
  }

  return tool
}

function createSendMessageTool(ctx: ToolContext): AgentTool {
  return {
    name: 'send_message',
    description: 'Send a message through a connected messaging channel (telegram, discord, slack, whatsapp, email).',
    label: 'Send Message',
    parameters: Type.Object({
      channel: Type.String({
        description: 'Channel type (e.g. "telegram", "discord")',
      }),
      channelId: Type.String({ description: 'Target chat/channel ID' }),
      message: Type.String({ description: 'Message text to send' }),
    }),
    execute: async (_toolCallId, params) => {
      const {
        channel: channelType,
        channelId,
        message,
      } = params as {
        channel: string
        channelId: string
        message: string
      }

      const adapter = ctx.channels.get(channelType)
      if (!adapter) {
        return textResult({ error: `Channel not connected: ${channelType}` })
      }

      const status = adapter.getStatus()
      if (!status.connected) {
        return textResult({ error: `Channel ${channelType} is not connected` })
      }

      try {
        await adapter.sendMessage(channelId, message)
        return textResult({ ok: true, channel: channelType, channelId })
      } catch (err: any) {
        return textResult({ error: `Failed to send: ${err.message}` })
      }
    },
  }
}

/**
 * Boundary capability: deliver an in-app notification (and, when it is newly
 * created, an OS push) to the current user. This is the server-backed "reach
 * the user" primitive the reminder-manage skill uses on a heartbeat instead of
 * pretending a chat reply / channel message is a push.
 *
 * Writes go through the same `/api/internal` bridge as the workspace meta
 * tools (`workspaceMetaFetch`), so auth, the derived API URL and the injected
 * `userId` are shared. Firing is suppressed during the workspace's configured
 * quiet hours (mirrors the heartbeat scheduler).
 */
function createNotifyUserTool(ctx: ToolContext): AgentTool {
  return {
    name: 'notify_user',
    label: 'Notify User',
    description:
      'Send the user an app notification (and a device push) about something that needs ' +
      'their attention, e.g. a due reminder. Only available in a workspace runtime. Does ' +
      'nothing during the configured quiet hours.',
    parameters: Type.Object({
      title: Type.String({ description: 'Short notification title' }),
      body: Type.String({ description: 'Notification body / reminder text' }),
      actionUrl: Type.Optional(
        Type.String({ description: 'In-app deep link to open on tap, e.g. "/activity"' }),
      ),
      dedupeKey: Type.Optional(
        Type.String({
          description:
            'Stable key so re-firing the same notification does not create a duplicate inbox row',
        }),
      ),
      type: Type.Optional(
        Type.String({
          description:
            'Notification type (must be an existing NotificationType member). Defaults to "workspace_updated".',
        }),
      ),
    }),
    execute: async (_toolCallId, params) => {
      const { title, body, actionUrl, dedupeKey, type } = params as {
        title: string
        body: string
        actionUrl?: string
        dedupeKey?: string
        type?: string
      }

      if (!workspaceMetaToolEnabled(ctx)) {
        return textResult({ error: 'This tool is only available in a workspace runtime.' })
      }

      // Respect quiet hours: a due reminder is deferred, not dropped — the
      // agent keeps it in memory and re-attempts on a later heartbeat.
      // Quiet hours live in the database (the project's agent config). A
      // failed lookup is treated as no quiet hours rather than blocking.
      let quietHours: { start?: string | null; end?: string | null; timezone?: string | null } | undefined
      try {
        const hbProjectId = resolveHeartbeatProjectId(ctx)
        if (hbProjectId) {
          const cfg = await apiGetProjectConfig(hbProjectId)
          const a = cfg.ok ? cfg.data?.agent : null
          if (a) quietHours = { start: a.quietHoursStart, end: a.quietHoursEnd, timezone: a.quietHoursTimezone }
        }
      } catch {
        // Lookup failed → treat as no quiet hours.
      }
      if (isInQuietHours(quietHours?.start ?? null, quietHours?.end ?? null, quietHours?.timezone ?? null)) {
        return textResult({
          ok: false,
          skipped: 'quiet_hours',
          message: 'Suppressed by quiet hours — retry after the quiet window ends.',
        })
      }

      const workspaceId = resolveWorkspaceId(ctx)
      // A workspace runtime's PROJECT_ID is often `ws:<id>`. Sending that as
      // projectId fails the API's project-membership check. Omit it: a
      // workspace token is enough when no real project id is available.
      const scopedProjectId = projectScopedId(ctx.projectId)
      try {
        const result = await workspaceMetaFetch(ctx, '/api/internal/reminders/notify', {
          method: 'POST',
          body: JSON.stringify({
            workspaceId,
            ...(scopedProjectId ? { projectId: scopedProjectId } : {}),
            title,
            body,
            ...(actionUrl ? { actionUrl } : {}),
            ...(dedupeKey ? { dedupeKey } : {}),
            ...(type ? { type } : {}),
            // Distinct push payload type so the delivered push is
            // distinguishable; the Android channel stays the default
            // `chat-complete` (already registered on the device) since this
            // change does not touch the mobile app.
            pushType: 'reminder-due',
          }),
        })
        return textResult(result)
      } catch (err: any) {
        return textResult({ error: `Failed to notify user: ${err?.message ?? err}` })
      }
    },
  }
}

function createChannelDisconnectTool(ctx: ToolContext): AgentTool {
  return {
    name: 'channel_disconnect',
    description: 'Disconnect a messaging channel and remove it from config.',
    label: 'Disconnect Channel',
    parameters: Type.Object({
      type: Type.String({
        description: 'Channel type to disconnect (e.g. "discord")',
      }),
    }),
    execute: async (_toolCallId, params) => {
      const { type } = params as { type: string }

      if (!ctx.disconnectChannel) {
        return textResult({
          error: 'Channel disconnect not available in this context',
        })
      }

      try {
        await ctx.disconnectChannel(type)

        const configPath = join(ctx.workspaceDir, 'config.json')
        if (existsSync(configPath)) {
          try {
            const fileConfig = JSON.parse(readFileSync(configPath, 'utf-8'))
            fileConfig.channels = (fileConfig.channels || []).filter((ch: any) => ch.type !== type)
            writeFileSync(configPath, JSON.stringify(fileConfig, null, 2), 'utf-8')
          } catch {
            /* config corrupted, skip */
          }
        }

        return textResult({
          ok: true,
          type,
          message: `${type} channel disconnected`,
        })
      } catch (err: any) {
        return textResult({
          error: `Failed to disconnect ${type}: ${err.message}`,
        })
      }
    },
  }
}

function createChannelListTool(ctx: ToolContext): AgentTool {
  return {
    name: 'channel_list',
    description: 'List all configured messaging channels and their connection status.',
    label: 'List Channels',
    parameters: Type.Object({}),
    execute: async () => {
      const configPath = join(ctx.workspaceDir, 'config.json')
      let channelConfigs: Array<{ type: string; model?: string }> = []
      let configured: string[] = []
      if (existsSync(configPath)) {
        try {
          const fileConfig = JSON.parse(readFileSync(configPath, 'utf-8'))
          channelConfigs = fileConfig.channels || []
          configured = channelConfigs.map((ch: any) => ch.type)
        } catch {
          /* ignore */
        }
      }

      const statuses = []
      for (const [type, adapter] of ctx.channels) {
        const status = adapter.getStatus()
        const chConf = channelConfigs.find((c) => c.type === type)
        if (chConf?.model) {
          status.model = chConf.model
        }
        statuses.push(status)
      }

      return textResult({
        connected: statuses,
        configured,
      })
    },
  }
}

// ---------------------------------------------------------------------------
// Integration Discovery Tools (unified search / connect / disconnect)
// ---------------------------------------------------------------------------

/**
 * Unified search across managed OAuth integrations (Composio), bundled
 * skills, and MCP server catalog. Each result carries a `source` tag so
 * the model knows which path `connect` will take. Pass `source` to
 * restrict results to a single backend.
 */
function createSearchIntegrationsTool(ctx: ToolContext): AgentTool {
  return {
    name: 'search_integrations',
    description:
      'Search for integrations by keyword. Returns managed OAuth integrations (Google, Slack, GitHub, etc.), bundled skills, and MCP protocol servers in one tagged list. Each result has a `source` tag (managed | skill | mcp). Pass `source` to filter to one backend.\n\n' +
      'When results are empty: do NOT give up after one query. Retry with a different keyword first — try the integration\'s common name ("google calendar"), the underlying capability ("calendar", "events", "scheduling"), or a sibling provider ("gcal", "outlook"). Only conclude an integration does not exist after at least 2 different searches return empty.',
    label: 'Search Integrations',
    parameters: Type.Object({
      query: Type.String({
        description:
          'Search query describing the capability you need (e.g. "google calendar", "postgres database", "seo audit", "github ops", "slack mentions")',
      }),
      limit: Type.Optional(Type.Number({ description: 'Max results to return (default: 5)' })),
      source: Type.Optional(
        Type.Union([Type.Literal('managed'), Type.Literal('skill'), Type.Literal('mcp')], {
          description:
            'Restrict to a single source (managed = Composio OAuth, skill = bundled skills, mcp = MCP protocol servers). Omit to search all three.',
        }),
      ),
    }),
    execute: async (_id: string, params: any) => {
      const query = params.query as string
      const limit = Math.min(params.limit || 5, 10)
      const source = params.source as 'managed' | 'skill' | 'mcp' | undefined

      const results: Array<Record<string, any>> = []

      if (!source || source === 'managed') {
        if (isComposioEnabled()) {
          try {
            const composioToolkits = await searchComposioToolkits(query)
            for (const tk of composioToolkits.slice(0, limit)) {
              results.push({
                name: tk.name,
                id: tk.slug,
                description: `${tk.name} — managed OAuth integration. No API keys or credentials needed.`,
                installCommand: `connect({ name: "${tk.slug}" })`,
                source: 'managed',
                logo: tk.logo,
              })
            }
          } catch {
            /* Composio API unavailable */
          }
        }
      }

      if (!source || source === 'skill') {
        try {
          const installed = loadAllSkills(ctx.workspaceDir)
          const bundled = loadBundledSkills(new Set(installed.map((s) => s.name)))
          const skillResults = searchSkills(query, installed, bundled, limit)
          for (const skill of skillResults) {
            results.push({
              name: skill.name,
              id: `skill:${skill.name}`,
              description: skill.description || `Skill: ${skill.name}`,
              source: 'skill',
              installed: skill.installed,
              installCommand: skill.installed
                ? `Already installed. Read with: read_file({ path: "skills/${skill.name}.md" })`
                : `connect({ name: "skill:${skill.name}" })`,
              trigger: skill.trigger,
            })
          }
        } catch {
          /* skill search failed, continue */
        }
      }

      if (!source || source === 'mcp') {
        const queryLower = query.toLowerCase()
        const queryWords = queryLower.split(/\s+/).filter((w) => w.length > 2)
        const scored: Array<{ entry: (typeof MCP_CATALOG)[0]; score: number }> = []
        for (const entry of MCP_CATALOG) {
          const haystack = `${entry.id} ${entry.name} ${entry.description} ${entry.category} ${entry.providedTools.join(' ')}`.toLowerCase()
          const idName = `${entry.id} ${entry.name}`.toLowerCase()
          let score = 0
          if (haystack.includes(queryLower)) score += 10
          if (idName.includes(queryLower)) score += 20
          for (const w of queryWords) {
            if (idName.includes(w)) score += 5
            else if (haystack.includes(w)) score += 1
          }
          if (score > 0) scored.push({ entry, score })
        }
        scored.sort((a, b) => b.score - a.score)
        for (const { entry } of scored.slice(0, limit)) {
          results.push({
            name: entry.name,
            id: entry.id,
            description: entry.description,
            category: entry.category,
            installCommand: `connect({ name: "${entry.id}", source: "mcp" })`,
            source: 'mcp',
          })
        }
      }

      if (results.length === 0) {
        return textResult({
          query,
          results: [],
          message: 'No integrations found. Try a different search term.',
        })
      }

      const managedCount = results.filter((r) => r.source === 'managed').length
      const skillCount = results.filter((r) => r.source === 'skill').length
      const mcpCount = results.filter((r) => r.source === 'mcp').length
      const parts: string[] = []
      if (managedCount > 0) parts.push(`${managedCount} managed OAuth integration(s) (no credentials needed)`)
      if (skillCount > 0) parts.push(`${skillCount} skill(s)`)
      if (mcpCount > 0) parts.push(`${mcpCount} MCP server(s)`)
      const message = `Found ${results.length} result(s)${parts.length ? `: ${parts.join(', ')}` : ''}. Use connect to add one.`

      return textResult({ query, results, message })
    },
  }
}

/**
 * Snippet appended to every successful `connect` message so the
 * model has a concrete code shape to copy when the user asks for a
 * dashboard or any other in-app use of the integration. Without this
 * the model tends to invent provider env vars (`*_API_TOKEN`) and
 * hand-roll bearer-token fetches in `custom-routes.ts`, which has no
 * working credentials in the pod.
 */
const SDK_USAGE_FOOTER = [
  '',
  "To use these tools from the user's app, import from @shogo-ai/sdk/tools.",
  '',
  'The SDK auto-parses tool result `data` (the runtime always JSON.stringifies',
  'tool responses; @shogo-ai/sdk/tools >=1.3 parses them back). Index `data`',
  'as a plain object — `me.data?.accountId` works. Do NOT write a',
  '`JSON.parse(result.data)` helper; that double-parses and breaks. Pass a',
  'generic to `execute<T>()` for typed access.',
  '',
  'DASHBOARDS / list views / "my X" pages → ALWAYS server-side in custom-routes.ts:',
  '',
  "  import { getServerToolsClient } from '@shogo-ai/sdk/tools'",
  "  app.get('/jira/my-issues', async (c) => {",
  '    const tools = getServerToolsClient()',
  "    const me = await tools.execute<{ accountId: string }>('JIRA_GET_CURRENT_USER', {})",
  '    if (!me.ok || !me.data?.accountId) {',
  "      return c.json({ error: me.error ?? 'not authenticated' }, 401)",
  '    }',
  "    const issues = await tools.execute<{ issues: unknown[] }>('JIRA_SEARCH_ISSUES', {",
  '      jql: `assignee = "${me.data.accountId}"`,',
  '    })',
  "    if (!issues.ok) return c.json({ error: issues.error ?? 'search failed' }, 502)",
  '    return c.json({ issues: issues.data?.issues ?? [] })',
  '  })',
  '',
  "  // In the browser — surface the server's actual error to the UI:",
  "  const res = await fetch('/api/jira/my-issues')",
  '  const body = await res.json().catch(() => ({}))',
  '  if (!res.ok) setError(body.error ?? `HTTP ${res.status}`)',
  '  else setIssues(body.issues ?? [])',
  '',
  'AD-HOC interactive actions (button clicks, form submits) → useTools() in the component:',
  '',
  "  import { useTools } from '@shogo-ai/sdk/tools'",
  '  const { execute } = useTools()',
  "  await execute('GMAIL_SEND_EMAIL', { to, subject, body })",
  '',
  'NEVER read provider tokens from env (no *_API_TOKEN, *_API_KEY) for managed',
  'integrations — there are no provider env vars in the pod. NEVER call the',
  "provider's REST API directly with fetch(). Always go through the SDK.",
  "NEVER hardcode the agent operator's identity (your accountId, member id,",
  "userId) into the user's app — derive it per request inside the route via",
  '<TOOLKIT>_GET_CURRENT_USER.',
  "NEVER throw `new Error('Failed to load X')` from a client fetch handler.",
  "Parse the JSON body's `error` field and surface it to the UI — generic",
  'messages strand the user with no path to debug.',
  'AFTER writing a route, hit it: `curl -s -w "\\nHTTP %{http_code}\\n"',
  'http://localhost:$RUNTIME_PORT/api/<your-route>`. A green build proves the',
  'file compiled, not that the endpoint works.',
].join('\n')

/**
 * Renders the "you can call these tools yourself, in this turn, by name"
 * preamble. Without this, the model tends to reach for the wrong
 * indirection (`skill: invoke` or `agent_spawn({type:'integration'})`)
 * to *call* an integration tool. Both fail: the integration subagent
 * doesn't have provider tools bound, and `skill` doesn't know about
 * managed integrations.
 */
function renderAgentDirectUsageBlock(toolkitName: string, toolNames: string[]): string {
  const sample = toolNames[0] ?? `${toolkitName.toUpperCase()}_<TOOL>`
  const namedExamples = toolNames.slice(0, 5).join(', ')
  const exampleSuffix = toolNames.length > 5 ? ', ...' : ''
  const namesHint = namedExamples ? ` (e.g. ${namedExamples}${exampleSuffix})` : ''
  return [
    `These ${toolNames.length || 'newly installed'} tools${namesHint} are now bound to YOU.`,
    `Call them directly in this turn by name:`,
    ``,
    `    ${sample}({})`,
    ``,
    `Do NOT spawn an \`integration\` subagent to call these — it does not have`,
    `them bound. Do NOT use the \`skill\` tool — these are managed integration`,
    `tools, not skills.`,
    ``,
    `Each tool returns { ok: boolean, data: <result>, error?: string }. For`,
    `list-style endpoints, items often live under \`data.values\` (Jira) or`,
    `\`data.items\` (Google) or similar — index in once and check the shape.`,
    ``,
    `Only call tool names from the bound \`tools\` list returned by this`,
    `connect — do NOT invent or guess slugs (a made-up slug fails with`,
    `"tool not found"). Pass real resource ids/handles for id parameters;`,
    `never pass an OAuth token or API key where an id is expected.`,
  ].join('\n')
}

export function formatToolInstallMessage(toolkitName: string, toolNames: string[], auth: { status: string; authUrl?: string }): string {
  const toolCount = toolNames.length
  const base = `"${toolkitName}" installed with ${toolCount} tool(s).`
  const directUsage = renderAgentDirectUsageBlock(toolkitName, toolNames)
  if (auth.status !== 'needs_auth') {
    return `${base} Auth is active. No manual credentials needed.\n\n${directUsage}\n${SDK_USAGE_FOOTER}`
  }
  if (auth.authUrl) {
    return `${base} User needs to authorize — a Connect button is displayed in the chat for them to click. Do NOT include the auth URL in your response; the UI button handles the OAuth popup flow automatically. Tell the user to click the Connect button below.\n\nOnce the user confirms they've connected, you'll be able to call these tools.\n\n${directUsage}\n${SDK_USAGE_FOOTER}`
  }
  return `${base} Auth status: needs_auth. The user may need to authorize via the Tools panel.\n\n${directUsage}\n${SDK_USAGE_FOOTER}`
}

/**
 * Install (connect) a Composio toolkit and bind its proxy tools. Shared
 * between the auto-routed and explicit-`source: 'managed'` paths of
 * `connect`, so we only ship one Composio install code path.
 */
async function connectViaComposio(
  ctx: ToolContext,
  name: string,
  composioToolkit: { slug: string; name: string },
): Promise<AgentToolResult<any>> {
  if (!ctx.mcpClientManager) {
    return textResult({ error: 'MCP client manager not available' })
  }
  if (!isComposioInitialized()) {
    const userId = ctx.userId || process.env.USER_ID || 'default'
    const workspaceId = resolveWorkspaceId(ctx) || 'default'
    const scopeEnv = process.env.COMPOSIO_USER_SCOPE
    const scope: 'workspace' | 'project' = scopeEnv === 'workspace' || scopeEnv === 'project' ? scopeEnv : 'workspace'
    const initialized = await initComposioSession(userId, workspaceId, ctx.projectId, scope)
    if (!initialized) {
      return textResult({
        error: `Failed to connect "${composioToolkit.name}" via Composio. The integration may not be available.`,
      })
    }
  }
  const proxy = await registerToolkitProxyTools(ctx.mcpClientManager, composioToolkit.slug)
  const auth = await checkComposioAuth(composioToolkit.slug)
  return textResult({
    ok: true,
    source: 'managed',
    server: 'composio',
    integration: composioToolkit.slug,
    toolCount: proxy.toolCount,
    tools: proxy.toolNames,
    authStatus: auth.status,
    ...(auth.authUrl ? { authUrl: auth.authUrl } : {}),
    message: formatToolInstallMessage(composioToolkit.name, proxy.toolNames, auth),
  })
}

/**
 * Install a bundled skill into the workspace. Returns a result tagged
 * with `source: 'skill'`. Triggered when `connect` is called with a
 * `skill:<name>` argument.
 */
async function connectSkill(ctx: ToolContext, skillName: string): Promise<AgentToolResult<any>> {
  const installed = loadAllSkills(ctx.workspaceDir)
  const bundled = loadBundledSkills(new Set(installed.map((s) => s.name)))
  const bundledSkill = bundled.find((s) => s.name === skillName)
  if (!bundledSkill) {
    const destDir = join(ctx.workspaceDir, '.shogo', 'skills', skillName)
    if (existsSync(destDir)) {
      return textResult({
        error: `Skill "${skillName}" is already installed`,
        path: `.shogo/skills/${skillName}/SKILL.md`,
      })
    }
    return textResult({
      error: `Bundled skill "${skillName}" not found. Use search_integrations to find available skills.`,
    })
  }
  const destDir = join(ctx.workspaceDir, '.shogo', 'skills', skillName)
  mkdirSync(destDir, { recursive: true })
  const srcDir = bundledSkill.skillDir
  for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
    const srcPath = join(srcDir, entry.name)
    const destPath = join(destDir, entry.name)
    if (entry.isDirectory()) {
      const { cpSync } = require('fs')
      cpSync(srcPath, destPath, { recursive: true })
    } else {
      writeFileSync(destPath, readFileSync(srcPath))
    }
  }
  return textResult({
    ok: true,
    source: 'skill',
    type: 'skill',
    name: skillName,
    path: `.shogo/skills/${skillName}/SKILL.md`,
    message: `Skill "${skillName}" installed. It will be active on the next message. Read it with read_file({ path: ".shogo/skills/${skillName}/SKILL.md" }) to see its instructions.`,
  })
}

/**
 * Install (connect) an MCP server — either from the local catalog or a
 * remote URL. Shared between the auto-routed (Composio miss) and
 * explicit-`source: 'mcp'` paths of `connect`.
 */
async function connectViaMcp(
  ctx: ToolContext,
  name: string,
  opts: {
    env?: Record<string, string>
    url?: string
    headers?: Record<string, string>
  },
): Promise<AgentToolResult<any>> {
  if (!ctx.mcpClientManager) {
    return textResult({ error: 'MCP client manager not available' })
  }
  const { env, url, headers } = opts

  if (url) {
    if (ctx.mcpClientManager.isRunning(name)) {
      const info = ctx.mcpClientManager.getServerInfo().find((s) => s.name === name)
      return textResult({
        error: `Server "${name}" is already running with ${info?.toolCount || 0} tools`,
        tools: info?.toolNames,
      })
    }
    const tools = await ctx.mcpClientManager.hotAddRemoteServer(name, {
      url,
      headers,
    })
    return textResult({
      ok: true,
      source: 'mcp',
      server: name,
      type: 'remote',
      toolCount: tools.length,
      tools: tools.map((t) => ({ name: t.name, description: t.description })),
      message: `Connected to remote MCP server "${name}" at ${url} with ${tools.length} tool(s).`,
    })
  }

  if (ctx.mcpClientManager.isRunning(name)) {
    const info = ctx.mcpClientManager.getServerInfo().find((s) => s.name === name)
    return textResult({
      error: `Server "${name}" is already running with ${info?.toolCount || 0} tools`,
      tools: info?.toolNames,
    })
  }

  const catalogEntry = MCP_CATALOG.find((e) => e.id === name)
  if (!isMcpServerAllowed(name) || !catalogEntry) {
    const builtin = builtinCapabilityRefusal(name)
    if (builtin) return textResult({ error: builtin })
    const catalogIds = MCP_CATALOG.map((e) => e.id).join(', ')
    return textResult({
      error: `"${name}" is not in the MCP catalog. Available servers: ${catalogIds}. For remote servers, provide a "url" parameter.`,
    })
  }

  let config: {
    command: string
    args?: string[]
    env?: Record<string, string>
  }
  if (isPreinstalledMcpId(name)) {
    config = {
      command: 'npx',
      args: [catalogEntry.package, ...catalogEntry.defaultArgs],
      env,
    }
  } else {
    config = await ctx.mcpClientManager.installPackageLocally(catalogEntry.package, catalogEntry.defaultArgs, env)
    if (env) config.env = { ...config.env, ...env }
  }

  const tools = await ctx.mcpClientManager.hotAddServer(name, config)
  return textResult({
    ok: true,
    source: 'mcp',
    server: name,
    toolCount: tools.length,
    tools: tools.map((t) => ({ name: t.name, description: t.description })),
    message: `Installed MCP server "${name}" with ${tools.length} tool(s). They are now available for use.`,
  })
}

/**
 * Unified install tool. Routes by `source` if explicit; otherwise
 * tries Composio first (managed OAuth has zero-config auth), falls
 * through to the MCP catalog, then to a remote URL if provided.
 * Skill installs are auto-detected by the `skill:` prefix on `name`.
 *
 * Each result is tagged with `source: 'managed' | 'skill' | 'mcp'`
 * so the model and the UI know which path was taken.
 */
function createConnectTool(ctx: ToolContext): AgentTool {
  return {
    name: 'connect',
    description:
      'Install (connect) an integration so its tools become available. Auto-routes by name: tries Composio managed OAuth first (Google, Slack, GitHub, etc. — no credentials needed), falls back to the MCP catalog (postgres, etc.), then to a remote URL if provided. Files and shell commands are built in (read_file, write_file, edit_file, exec) — do not connect filesystem or computer-use. Use `source: "mcp"` to skip Composio. Use `skill:<name>` to install a bundled skill. Pair with search_integrations to discover names.\n\n' +
      'When to call connect vs. when not to: only call connect when the user has asked for an ACTION you can\'t perform without that integration (send a calendar invite, post to Slack, query a Postgres database, etc.). Do NOT call connect when the user is asking to "show", "list", "compare", "describe", or "preview" data you can already produce with `web`, `read_file`, or in-context information — installing an integration the user did not ask for forces them through an OAuth dance for no reason and is one of the most disliked agent behaviors. If you\'re unsure whether the user wants the action or just an explanation, ask one clarifying question via `ask_user` before calling connect.\n\n' +
      'GitHub issues, pull requests, Actions, releases, and repo metadata: do NOT call connect. Use the pre-installed `gh` CLI via exec (`gh issue list`, `gh issue create`, `gh pr list`, `gh pr create --repo <owner>/<repo> --base main --head <branch> --title "..." --body-file .tmp/pr-body.md`, `gh run list`). Opening a PR is normally `gh pr create` in exec after pushing the source branch; the `github_create_pr` tool is an optional alternative that opens the PR as the Shogo GitHub App and adds the standard footer. Either way end the body with the standard Made with Shogo footer and a `Card: <KEY>` line. To bring a repository into a project, use `github_connect`. If gh is not authenticated: for a project\'s repository, use `github_connect` (pass the user\'s token if they shared one); only for one-off work outside a project\'s repository, save the PAT to workspace `.env` as GITHUB_TOKEN and retry. Only connect({ name: "github" }) if the user explicitly asks for the Composio GitHub OAuth integration.',
    label: 'Connect Integration',
    parameters: Type.Object({
      name: Type.String({
        description:
          'Integration name. Examples: "googlecalendar", "gmail", "slack" (managed); "postgres" (mcp catalog); "skill:github-ops" (bundled skill); any custom name when providing url. Do not pass "filesystem" or "computer-use" — those capabilities are built in.',
      }),
      source: Type.Optional(
        Type.Union([Type.Literal('managed'), Type.Literal('mcp')], {
          description: 'Force a specific backend. Omit for auto-routing (Composio first, then MCP).',
        }),
      ),
      env: Type.Optional(
        Type.Any({
          description: 'MCP-only: environment variables for the server process (API keys, connection strings).',
        }),
      ),
      url: Type.Optional(
        Type.String({
          description:
            'MCP-only: remote MCP server URL (HTTP/StreamableHTTP). When provided, connects to the remote server instead of installing from the catalog.',
        }),
      ),
      headers: Type.Optional(
        Type.Any({
          description: 'MCP-only: HTTP headers for remote MCP server authentication.',
        }),
      ),
    }),
    execute: async (_id: string, params: any) => {
      const { name, source, env, url, headers } = params as {
        name: string
        source?: 'managed' | 'mcp'
        env?: Record<string, string>
        url?: string
        headers?: Record<string, string>
      }

      try {
        if (name.startsWith('skill:')) {
          return await connectSkill(ctx, name.slice(6))
        }

        if (!ctx.mcpClientManager) {
          return textResult({ error: 'MCP client manager not available' })
        }

        if (source === 'mcp') {
          return await connectViaMcp(ctx, name, { env, url, headers })
        }

        if (source !== 'managed' && url) {
          return await connectViaMcp(ctx, name, { env, url, headers })
        }

        if (isComposioEnabled()) {
          const composioToolkit = await findComposioToolkit(name)
          if (composioToolkit) {
            return await connectViaComposio(ctx, name, composioToolkit)
          }
          if (source === 'managed') {
            return textResult({
              error: `"${name}" is not a managed Composio integration. Use search_integrations to find available integrations, or omit \`source\` to fall through to MCP.`,
            })
          }
        } else if (source === 'managed') {
          return textResult({
            error: `Composio is not configured (set COMPOSIO_API_KEY). Cannot install "${name}" as a managed integration.`,
          })
        }

        return await connectViaMcp(ctx, name, { env, url, headers })
      } catch (err: any) {
        console.error(`[connect] Unhandled error installing "${params?.name}":`, err)
        return textResult({
          error: `Failed to install "${params?.name}": ${err.message}`,
        })
      }
    },
  }
}

/**
 * Unified uninstall tool. Auto-detects whether the running entry is a
 * remote MCP server vs. local server vs. Composio proxy via
 * `mcpClientManager.getServerInfo()` and calls the right
 * `hotRemove*` method.
 */
function createDisconnectTool(ctx: ToolContext): AgentTool {
  return {
    name: 'disconnect',
    description:
      'Stop and remove an installed integration (managed OAuth, MCP server, or skill binding). Its tools will no longer be available. Auto-detects which backend owns the name.',
    label: 'Disconnect Integration',
    parameters: Type.Object({
      name: Type.String({
        description: 'Integration name to remove (use search_integrations to find names of currently installed entries)',
      }),
    }),
    execute: async (_id: string, params: any) => {
      const name = params.name as string

      if (!ctx.mcpClientManager) {
        return textResult({ error: 'MCP client manager not available' })
      }

      try {
        if (!ctx.mcpClientManager.isRunning(name)) {
          return textResult({
            error: `Integration "${name}" is not running`,
            installed: ctx.mcpClientManager.getServerNames(),
          })
        }

        const info = ctx.mcpClientManager.getServerInfo().find((s) => s.name === name)
        if (info?.config.command === 'remote') {
          await ctx.mcpClientManager.hotRemoveRemoteServer(name)
        } else {
          await ctx.mcpClientManager.hotRemoveServer(name)
        }
        return textResult({
          ok: true,
          removed: name,
          message: `Removed integration "${name}" and all its tools.`,
        })
      } catch (err: any) {
        console.error(`[disconnect] Unhandled error removing "${name}":`, err)
        return textResult({
          error: `Failed to remove "${name}": ${err.message}`,
        })
      }
    },
  }
}

// ---------------------------------------------------------------------------
// Agent Orchestration Tools (agent_create, agent_spawn, agent_status, etc.)
// ---------------------------------------------------------------------------

import { AgentManager } from './agent-manager'
import type { ModelTierName, ForkContext } from './subagent'
import { isInForkChild, buildForkDirective } from './subagent-prompts'

function createAgentCreateTool(ctx: ToolContext): AgentTool {
  return {
    name: 'agent_create',
    description:
      'Register a new sub-agent type at runtime. Define its system prompt, allowed tools, and model tier. Use the same name to update an existing type. Set persist: true to save across sessions.',
    label: 'Create Agent',
    parameters: Type.Object({
      name: Type.String({
        description: 'Unique agent type name (e.g. "test-writer", "pr-reviewer")',
      }),
      description: Type.String({
        description: 'Short description of what this agent does',
      }),
      system_prompt: Type.String({
        description: 'System prompt for the agent (max 4000 chars)',
      }),
      tools: Type.Optional(
        Type.Array(Type.String(), {
          description: 'Tool names this agent can use. Omit for all tools.',
        }),
      ),
      model_tier: Type.Optional(Type.String({ description: 'Model tier: fast, default, or capable' })),
      max_turns: Type.Optional(Type.Number({ description: 'Max agentic turns (default: 10)' })),
      readonly: Type.Optional(
        Type.Boolean({
          description: 'If true, only read-only tools are available',
        }),
      ),
      persist: Type.Optional(
        Type.Boolean({
          description: 'If true, save to .shogo/agents/ for future sessions',
        }),
      ),
    }),
    execute: async (_id, params) => {
      const {
        name,
        description,
        system_prompt,
        tools,
        model_tier,
        max_turns,
        readonly: ro,
        persist,
      } = params as {
        name: string
        description: string
        system_prompt: string
        tools?: string[]
        model_tier?: string
        max_turns?: number
        readonly?: boolean
        persist?: boolean
      }
      const am = ctx.agentManager
      if (!am) return textResult({ error: 'AgentManager not available' })

      const config: SubagentConfig = {
        name,
        description,
        systemPrompt: system_prompt,
        toolNames: tools,
        modelTier: (model_tier as ModelTierName) || 'default',
        maxTurns: max_turns || 10,
        readonly: ro,
      }

      const result = am.register(config, persist)
      if (!result.ok) return textResult({ error: result.error })

      const types = am.listTypes()
      ctx.uiWriter?.write({ type: 'data-agent-types', data: { types } })

      return textResult({ ok: true, name, description, persisted: !!persist })
    },
  }
}

function createAgentSpawnTool(ctx: ToolContext, allToolsGetter: () => AgentTool[]): AgentTool {
  return {
    name: 'agent_spawn',
    description:
      'Launch an instance of a registered or built-in agent type. Waits for its report, or with background: true runs it as a background task. Built-in types: explore, general-purpose, code-reviewer, integration, channel, media, browser, browser_qa. IMPORTANT: `integration` is for discovery / install / uninstall ONLY. Once a tool is installed, it is bound to YOU — call it directly by name (e.g. JIRA_LIST_BOARDS({})). Do NOT spawn the integration subagent to execute installed tools; it does not have them bound. Omit type to use fork mode (inherits your full context — ideal for context-heavy tasks).',
    label: 'Spawn Agent',
    parameters: Type.Object({
      type: Type.Optional(
        Type.String({
          description: 'Agent type name (built-in or created with agent_create). Omit for fork mode (inherits full context).',
        }),
      ),
      prompt: Type.String({ description: 'Task prompt for the agent' }),
      model_tier: Type.Optional(
        Type.String({
          description: 'Model tier: fast (cheap), default (parent), capable (best)',
        }),
      ),
      max_turns: Type.Optional(
        Type.Number({
          description: 'Max agentic turns (default: 10, fork: 200)',
        }),
      ),
      readonly: Type.Optional(
        Type.Boolean({
          description: 'If true, only read-only tools are available',
        }),
      ),
      background: Type.Optional(
        Type.Boolean({
          description: 'If true, run asynchronously (default: false — blocks until done)',
        }),
      ),
      resume: Type.Optional(
        Type.String({
          description: 'Instance ID to resume (sends follow-up to existing agent). type may be omitted; the instance keeps its own type.',
        }),
      ),
    }),
    execute: async (toolCallId, params) => {
      const {
        prompt,
        model_tier,
        max_turns,
        readonly: readonlyMode,
        background,
        resume,
      } = params as {
        type?: string
        prompt: string
        model_tier?: string
        max_turns?: number
        readonly?: boolean
        background?: boolean
        resume?: string
      }
      let type = (params as { type?: string }).type

      // Resuming an instance without restating its type continues that
      // instance; it must not fall through to fork mode.
      if (!type && resume) {
        const existing = ctx.agentManager?.getInstance(resume)
        if (!existing) {
          return textResult({
            error: `Cannot resume "${resume}": no agent instance with that ID exists in this session. Pass the instance_id returned by a previous agent_spawn call, or omit resume to start a new agent.`,
          })
        }
        type = existing.type
      }

      // --- Fork mode: type is omitted ---
      if (!type) {
        if (!ctx.renderedSystemPrompt || !ctx.sessionMessages) {
          return textResult({
            error: 'Fork mode requires parent context (renderedSystemPrompt + sessionMessages). Not available in this context.',
          })
        }

        // Recursive fork guard
        if (isInForkChild(ctx.sessionMessages)) {
          return textResult({
            error: 'Cannot fork from within a fork. Execute the task directly instead.',
          })
        }

        const forkConfig: SubagentConfig = {
          name: 'fork',
          description: 'Context-aware forked worker',
          systemPrompt: '', // overridden by forkContext
          maxTurns: max_turns || 200,
        }
        if (model_tier && (model_tier === 'fast' || model_tier === 'default' || model_tier === 'capable')) {
          forkConfig.modelTier = model_tier as ModelTierName
        }

        const forkContext: import('./subagent').ForkContext = {
          systemPrompt: ctx.renderedSystemPrompt,
          parentMessages: ctx.sessionMessages,
          parentTools: allToolsGetter(),
          thinkingLevel: 'medium',
        }

        const w = ctx.uiWriter
        const spawn = buildSpawnCallbacks(w, toolCallId)
        const forkDirective = buildForkDirective(prompt)
        const result = await runSubagent(forkConfig, forkDirective, ctx, allToolsGetter(), spawn?.callbacks, { forkContext })

        const subModel = result.effectiveModelId || ctx.effectiveModel || ctx.config.model.name
        if (w && (result.inputTokens > 0 || result.outputTokens > 0)) {
          w.write({
            type: 'data-usage',
            data: {
              inputTokens: result.inputTokens,
              outputTokens: result.outputTokens,
              cacheReadTokens: result.cacheReadTokens,
              cacheWriteTokens: result.cacheWriteTokens,
              iterations: result.iterations,
              toolCallCount: result.toolCalls,
              subagent: 'fork',
              model: subModel,
              dollarCost: calculateDollarCost(
                subModel,
                result.inputTokens,
                result.outputTokens,
                result.cacheReadTokens,
                result.cacheWriteTokens,
              ),
            },
          })
        }

        const accumulated = spawn?.getAccumulatedOutput()
        return subagentToolResult({
          mode: 'fork',
          agent_id: result.agentId,
          toolCalls: result.toolCalls,
          iterations: result.iterations,
          tokens: { input: result.inputTokens, output: result.outputTokens },
          parts: accumulated?.parts,
          model: accumulated?.model || subModel,
        }, result.responseText)
      }

      // --- Normal mode: type is specified ---
      const am = ctx.agentManager
      if (!am) return textResult({ error: 'AgentManager not available' })

      const history = resume ? (am.getInstanceMessages(resume) ?? undefined) : undefined

      // Apply optional overrides before spawn
      if (model_tier || max_turns || readonlyMode) {
        const config = am.getConfig(type) || getBuiltinSubagentConfig(type, ctx, allToolsGetter())
        if (config) {
          if (model_tier && (model_tier === 'fast' || model_tier === 'default' || model_tier === 'capable')) {
            config.modelTier = model_tier as ModelTierName
          }
          if (max_turns) config.maxTurns = max_turns
          if (readonlyMode) config.readonly = true
        }
      }

      const w = ctx.uiWriter
      const spawn = buildSpawnCallbacks(w, toolCallId)

      let instanceRef: string | undefined
      const task = background && ctx.commandRegistry
        ? ctx.commandRegistry.registerTask({
            source: 'subagent',
            title: `${type}: ${prompt.replace(/\s+/g, ' ').trim().slice(0, 80)}`,
            backgrounded: true,
            cancel: () => { if (instanceRef) am.cancel(instanceRef) },
            // While it streams, the dock opens the agent's live view; after that
            // it falls back to this task's log.
            link: {
              kind: 'subagent',
              toolCallId,
              projectId: ctx.projectId ?? undefined,
              chatSessionId: ctx.sessionId ?? undefined,
            },
          })
        : undefined
      const callbacks = task ? withTaskOutput(spawn?.callbacks, task) : spawn?.callbacks

      const spawnResult = am.spawn(type, prompt, ctx, allToolsGetter(), callbacks, { history })
      if (!spawnResult.ok) {
        if (task) {
          task.entry.consumed = true
          task.finish('failed', { summary: spawnResult.error })
        }
        return textResult({ error: spawnResult.error })
      }

      const instanceId = spawnResult.instanceId
      instanceRef = instanceId
      scLog(`[screencast] agent_spawn -> instanceId=${instanceId} type=${type}`)
      spawn?.setInstanceId(instanceId)

      if (background) {
        const inst = am.getInstance(instanceId)
        if (task && inst) {
          ctx.commandRegistry!.addAlias(instanceId, task.entry.id)
          void inst.promise.then((result) => {
            // A failed background run must finish with its cause: the [Task
            // update] is the only thing the parent sees.
            const report = result.error?.message?.trim()
              || result.responseText?.trim()
              || '(Subagent completed but returned no output.)'
            task.append(`\n\n=== Final report ===\n${report}\n`)
            const status = inst.status === 'cancelled'
              ? 'cancelled'
              : inst.status === 'failed' || result.responseEmpty ? 'failed' : 'completed'
            task.finish(status, { summary: report.slice(0, 200) })
          })
        }
        return textResult({
          status: 'running',
          ...(task ? { task_id: task.entry.id, output_file: taskOutputPath(ctx, task.entry) } : {}),
          instance_id: instanceId,
          hint: task ? `Started in the background. ${BACKGROUND_TASK_HINT}` : 'Running in the background.',
        })
      }

      // Synchronous: wait for completion
      const inst = am.getInstance(instanceId)
      if (!inst) return textResult({ error: 'Instance lost' })
      const result = await inst.promise

      if (w && (result.inputTokens > 0 || result.outputTokens > 0)) {
        const subModel = result.effectiveModelId || ctx.effectiveModel || ctx.config.model.name
        w.write({
          type: 'data-usage',
          data: {
            inputTokens: result.inputTokens,
            outputTokens: result.outputTokens,
            cacheReadTokens: result.cacheReadTokens,
            cacheWriteTokens: result.cacheWriteTokens,
            iterations: result.iterations,
            toolCallCount: result.toolCalls,
            subagent: type,
            model: subModel,
            dollarCost: calculateDollarCost(
              subModel,
              result.inputTokens,
              result.outputTokens,
              result.cacheReadTokens,
              result.cacheWriteTokens,
            ),
          },
        })
      }

      const accumulated = spawn?.getAccumulatedOutput()
      const failed = inst.status === 'failed' || result.responseEmpty === true
      return subagentToolResult({
        instance_id: instanceId,
        agent_id: result.agentId,
        status: inst.status,
        toolCalls: result.toolCalls,
        iterations: result.iterations,
        tokens: { input: result.inputTokens, output: result.outputTokens },
        parts: accumulated?.parts,
        model: accumulated?.model || result.effectiveModelId || inst.model,
        ...(result.responseEmpty ? { responseEmpty: true } : {}),
        // A spawn that dies at setup used to reach the parent as a placeholder;
        // the reason and where it got to are what make it actionable.
        ...(result.error ? { error: result.error } : {}),
        ...(failed && (inst.recentActivity?.length ?? 0) > 0
          ? { activity: inst.recentActivity!.slice(-5).map((a) => a.summary) }
          : {}),
      }, result.responseText)
    },
  }
}

/** Mirror a background subagent's text and tool calls into its task output file. */
function withTaskOutput(
  callbacks: SubagentStreamCallbacks | undefined,
  task: import('./task-registry').TaskHandle,
): SubagentStreamCallbacks {
  return {
    ...callbacks,
    onTextDelta: (delta: string) => {
      task.append(delta)
      callbacks?.onTextDelta?.(delta)
    },
    onBeforeToolCall: async (toolName: string, args: any, toolCallId: string) => {
      let input = ''
      try { input = JSON.stringify(args).slice(0, 200) } catch { /* non-serializable */ }
      task.append(`\n[tool] ${toolName} ${input}\n`)
      await callbacks?.onBeforeToolCall?.(toolName, args, toolCallId)
    },
  }
}

const MAX_SUBAGENT_RESPONSE_CHARS = 8000

export function capSubagentResponse(text: string): string {
  if (text.length <= MAX_SUBAGENT_RESPONSE_CHARS) return text
  const headSize = Math.floor(MAX_SUBAGENT_RESPONSE_CHARS * 0.75)
  const tailSize = MAX_SUBAGENT_RESPONSE_CHARS - headSize
  return (
    `${text.substring(0, headSize)}\n\n... [${text.length - MAX_SUBAGENT_RESPONSE_CHARS} chars of the subagent report truncated] ...\n\n` +
    text.substring(text.length - tailSize)
  )
}

/**
 * Result of a completed subagent: `details` (the UI payload, including the
 * streamed `parts` transcript) is kept whole, but the model only sees the
 * capped final report and a per-tool call count. Re-sending the subagent's
 * full transcript to the parent defeats the point of delegating.
 *
 * A failed run answers with its cause. A placeholder ("returned no output")
 * reads as a successful run of a silent agent, so it is kept only for a run
 * that genuinely completed without text.
 */
export function subagentToolResult(
  details: Record<string, any>,
  responseText: string | undefined,
): AgentToolResult<any> {
  const { parts, ...rest } = details
  const toolCounts: Record<string, number> = {}
  for (const p of (parts ?? []) as any[]) {
    if (p?.type === 'tool' && p.tool?.toolName) toolCounts[p.tool.toolName] = (toolCounts[p.tool.toolName] ?? 0) + 1
  }
  const error = rest.error as { code?: string; message: string } | undefined
  const failed = rest.status === 'failed' || !!error || rest.responseEmpty === true
  const response = error?.message
    ? error.message
    : responseText?.trim() || (failed ? '(Subagent failed without a message.)' : '(Subagent completed but returned no output.)')
  const modelFacing = {
    ...rest,
    response: capSubagentResponse(response),
    ...(failed ? { reason: error?.code ?? 'no_output' } : {}),
    ...(Object.keys(toolCounts).length > 0 ? { tools_used: toolCounts } : {}),
  }
  return {
    content: [{ type: 'text', text: JSON.stringify(modelFacing, null, 2) }],
    details,
  }
}

/**
 * Build sub-agent stream callbacks that accumulate content into an internal
 * parts[] array and periodically emit it as a preliminary tool output.
 *
 * Uses the AI SDK's preliminary tool results pattern: the sub-agent's content
 * lives INSIDE the agent_spawn tool's output (tool-output-available with
 * preliminary: true), keeping it completely separate from the parent's
 * text/tool events. Each sub-agent is scoped to its own spawnToolCallId,
 * so multiple concurrent sub-agents work correctly.
 */
export function buildSpawnCallbacks(
  w: any,
  spawnToolCallId: string,
):
  | {
      callbacks: SubagentStreamCallbacks
      getAccumulatedOutput: () => {
        agentId: string | null
        parts: any[]
        model: string | null
      }
      setInstanceId: (id: string) => void
    }
  | undefined {
  if (!w) return undefined

  const parts: any[] = []
  let agentId: string | null = null
  let instanceId: string | null = null
  let model: string | null = null
  let lastEmitTime = 0
  let pendingEmit: ReturnType<typeof setTimeout> | null = null
  const THROTTLE_MS = 150

  function emitPreliminary(force?: boolean) {
    const now = Date.now()
    if (!force && now - lastEmitTime < THROTTLE_MS) {
      if (!pendingEmit) {
        pendingEmit = setTimeout(
          () => {
            pendingEmit = null
            emitPreliminary(true)
          },
          THROTTLE_MS - (now - lastEmitTime),
        )
      }
      return
    }
    if (pendingEmit) {
      clearTimeout(pendingEmit)
      pendingEmit = null
    }
    lastEmitTime = now
    w.write({
      type: 'tool-output-available',
      toolCallId: spawnToolCallId,
      output: { agentId, instance_id: instanceId, model, parts: [...parts] },
      dynamic: true,
      preliminary: true,
    })
  }

  const callbacks: SubagentStreamCallbacks = {
    onStart: (_name: string, _desc: string, id: string) => {
      agentId = id
    },
    onModelResolved: (m: string) => {
      model = m
      emitPreliminary(true)
    },
    onEnd: (_name: string) => {
      // Flush any pending throttled emit so the last snapshot arrives
      if (pendingEmit) {
        clearTimeout(pendingEmit)
        pendingEmit = null
      }
      emitPreliminary(true)
    },
    onTextDelta: (delta: string) => {
      const last = parts[parts.length - 1]
      if (last?.type === 'text') {
        last.text += delta
      } else {
        parts.push({
          type: 'text',
          text: delta,
          id: `sa-text-${parts.length}`,
        })
      }
      emitPreliminary()
    },
    onThinkingStart: () => {
      parts.push({
        type: 'reasoning',
        text: '',
        isStreaming: true,
        id: `sa-reason-${parts.length}`,
      })
      emitPreliminary()
    },
    onThinkingDelta: (delta: string) => {
      const last = parts[parts.length - 1]
      if (last?.type === 'reasoning') last.text += delta
    },
    onThinkingEnd: () => {
      const last = parts[parts.length - 1]
      if (last?.type === 'reasoning') last.isStreaming = false
      emitPreliminary(true)
    },
    onToolCallStart: (toolName: string, toolCallId: string) => {
      parts.push({
        type: 'tool',
        id: toolCallId,
        tool: {
          id: toolCallId,
          toolName,
          state: 'streaming',
          args: undefined,
          result: undefined,
        },
      })
      emitPreliminary()
    },
    onToolCallDelta: (_toolName: string, _delta: string, _toolCallId: string) => {
      // streaming args — we'll set final args in onBeforeToolCall
    },
    onToolCallEnd: (_toolName: string, _toolCallId: string) => {},
    onBeforeToolCall: async (toolName: string, args: any, toolCallId: string) => {
      let p = parts.find((p: any) => p.type === 'tool' && p.id === toolCallId)
      if (!p) {
        p = {
          type: 'tool',
          id: toolCallId,
          tool: {
            id: toolCallId,
            toolName,
            state: 'streaming',
            args,
            result: undefined,
          },
        }
        parts.push(p)
      } else {
        p.tool.args = args
      }
      emitPreliminary(true)
    },
    onAfterToolCall: async (_toolName: string, _args: any, result: any, isError: boolean, toolCallId: string) => {
      const parsed =
        typeof result === 'string'
          ? (() => {
              try {
                return JSON.parse(result)
              } catch {
                return result
              }
            })()
          : result
      const p = parts.find((p: any) => p.type === 'tool' && p.id === toolCallId)
      if (p) {
        p.tool.result = isError
          ? {
              error: typeof parsed === 'string' ? parsed : JSON.stringify(parsed),
            }
          : (parsed ?? { success: true })
        p.tool.state = isError ? 'error' : 'success'
      }
      emitPreliminary(true)
    },
  }

  return {
    callbacks,
    getAccumulatedOutput: () => ({ agentId, parts: [...parts], model }),
    setInstanceId: (id: string) => {
      instanceId = id
      scLog(`[screencast] buildSpawnCallbacks.setInstanceId toolCallId=${spawnToolCallId} ` + `instanceId=${id}`)
      // Re-emit so subscribers learn the instance id ASAP (they need it to
      // open the live screencast stream for the running subagent).
      emitPreliminary(true)
    },
  }
}

function createAgentStatusTool(ctx: ToolContext): AgentTool {
  return {
    name: 'agent_status',
    description: 'Check the status of agent instances. Omit instance_id to see all.',
    label: 'Agent Status',
    parameters: Type.Object({
      instance_id: Type.Optional(Type.String({ description: 'Specific instance ID to check' })),
    }),
    execute: async (_id, params) => {
      const { instance_id } = params as { instance_id?: string }
      const am = ctx.agentManager
      if (!am) return textResult({ error: 'AgentManager not available' })

      if (instance_id) {
        const inst = am.getInstance(instance_id)
        if (!inst) return textResult({ error: `Unknown instance: ${instance_id}` })
        return textResult({
          id: inst.id,
          type: inst.type,
          status: inst.status,
          elapsed_ms: Date.now() - inst.startedAt,
          ...(inst.result
            ? {
                toolCalls: inst.result.toolCalls,
                iterations: inst.result.iterations,
              }
            : {}),
        })
      }

      return textResult({ instances: am.listInstances() })
    },
  }
}

function createAgentCancelTool(ctx: ToolContext): AgentTool {
  return {
    name: 'agent_cancel',
    description: 'Cancel a running agent instance.',
    label: 'Cancel Agent',
    parameters: Type.Object({
      instance_id: Type.String({ description: 'Instance ID to cancel' }),
    }),
    execute: async (_id, params) => {
      const { instance_id } = params as { instance_id: string }
      const am = ctx.agentManager
      if (!am) return textResult({ error: 'AgentManager not available' })

      const cancelled = am.cancel(instance_id)
      return textResult({ ok: cancelled, instance_id })
    },
  }
}

function createAgentResultTool(ctx: ToolContext): AgentTool {
  return {
    name: 'agent_result',
    description:
      'Wait for and retrieve the result of an agent instance. Blocks until the agent completes by default (up to 2 min). Set timeout_ms to 0 for an immediate non-blocking check.',
    label: 'Agent Result',
    parameters: Type.Object({
      instance_id: Type.String({
        description: 'Instance ID to retrieve result for',
      }),
      timeout_ms: Type.Optional(
        Type.Number({
          description: 'Max milliseconds to wait for completion. Defaults to 120000 (2 min). Set to 0 for immediate (non-blocking) check.',
          default: 120_000,
        }),
      ),
    }),
    execute: async (_id, params) => {
      const { instance_id, timeout_ms = 120_000 } = params as {
        instance_id: string
        timeout_ms?: number
      }
      const am = ctx.agentManager
      if (!am) return textResult({ error: 'AgentManager not available' })

      const inst = am.getInstance(instance_id)
      if (!inst) return textResult({ error: `Unknown instance: ${instance_id}` })

      if (inst.status === 'running' && timeout_ms > 0) {
        const timeout = new Promise<null>((r) => setTimeout(() => r(null), timeout_ms))
        const winner = await Promise.race([inst.promise.then((r) => r), timeout])
        if (!winner) {
          const elapsed = Date.now() - inst.startedAt
          return textResult({
            status: 'running',
            elapsed_ms: elapsed,
            recent_activity: inst.recentActivity.slice(-5).map((a) => `${a.tool}: ${a.summary}`),
            hint: `Agent still running after ${Math.round(elapsed / 1000)}s. Call again to keep waiting.`,
          })
        }
      } else if (inst.status === 'running') {
        return textResult({
          status: 'running',
          recent_activity: inst.recentActivity.slice(-5).map((a) => `${a.tool}: ${a.summary}`),
          hint: 'Agent is still running. Call again with timeout_ms > 0 to wait.',
        })
      }

      const r = inst.result
      ctx.commandRegistry?.markConsumed([inst.id])

      const w = ctx.uiWriter
      if (w && r && (r.inputTokens > 0 || r.outputTokens > 0)) {
        const subModel = ctx.effectiveModel || ctx.config.model.name
        w.write({
          type: 'data-usage',
          data: {
            inputTokens: r.inputTokens,
            outputTokens: r.outputTokens,
            cacheReadTokens: r.cacheReadTokens,
            cacheWriteTokens: r.cacheWriteTokens,
            iterations: r.iterations,
            toolCallCount: r.toolCalls,
            subagent: inst.type,
            model: subModel,
            dollarCost: calculateDollarCost(subModel, r.inputTokens, r.outputTokens, r.cacheReadTokens, r.cacheWriteTokens),
          },
        })
      }

      const responseText = r?.responseText || '(Subagent completed but returned no output.)'
      return textResult({
        instance_id: inst.id,
        type: inst.type,
        status: inst.status,
        response: capSubagentResponse(responseText),
        toolCalls: r?.toolCalls ?? 0,
        // Rolling window (see MAX_RECENT_ACTIVITY) of the tools this
        // instance actually called, in order — lets the caller (and eval
        // graders reconstructing what a delegated subagent did) see more
        // than a bare count. Previously only surfaced on the "still
        // running" polling responses above; completed instances returned
        // nothing beyond the count, which made e.g. "did the subagent
        // write to reports/x.md" unanswerable from this tool's output.
        tool_activity: (inst.recentActivity ?? []).map((a) => ({
          tool: a.tool,
          input: a.input,
          summary: a.summary,
        })),
        iterations: r?.iterations ?? 0,
        tokens: r ? { input: r.inputTokens, output: r.outputTokens } : undefined,
      })
    },
  }
}

function createAgentListTool(ctx: ToolContext, allToolsGetter: () => AgentTool[]): AgentTool {
  return {
    name: 'agent_list',
    description: 'List all registered agent types (built-in and custom) with performance metrics.',
    label: 'List Agents',
    parameters: Type.Object({}),
    execute: async () => {
      const am = ctx.agentManager
      if (!am) return textResult({ error: 'AgentManager not available' })

      const types = am.listTypes(ctx, allToolsGetter())
      const instances = am.listInstances()

      ctx.uiWriter?.write({ type: 'data-agent-types', data: { types } })

      return textResult({
        types,
        active_instances: instances.filter((i) => i.status === 'running').length,
        total_instances: instances.length,
      })
    },
  }
}

function ensureTeamContext(ctx: ToolContext): { teamId: string; agentId: string; isLeader: boolean } | null {
  if (ctx.teamContext) return ctx.teamContext
  const tm = ctx.teamManager
  if (!tm || !ctx.sessionId) return null
  const teams = tm.listTeams(ctx.sessionId)
  if (teams.length === 0) return null
  const team = teams[0]!
  ctx.teamContext = {
    teamId: team.id,
    agentId: team.leaderAgentId,
    isLeader: true,
  }
  if (!ctx.teammateHandles) ctx.teammateHandles = new Map()
  return ctx.teamContext
}

function createTeamCreateTool(ctx: ToolContext): AgentTool {
  return {
    name: 'team_create',
    description:
      'Create a team of long-lived agent teammates for complex multi-step projects. Teammates persist across turns, communicate via messages, and claim tasks from a shared queue.',
    label: 'Create Team',
    parameters: Type.Object({
      team_name: Type.String({
        description: 'Slug name for the team (e.g. "frontend-refactor")',
      }),
      description: Type.Optional(Type.String({ description: "Brief description of the team's purpose" })),
    }),
    execute: async (_id, params) => {
      const { team_name, description } = params as {
        team_name: string
        description?: string
      }
      const tm = ctx.teamManager
      if (!tm) return textResult({ error: 'Team coordination not available' })
      if (!ctx.sessionId) return textResult({ error: 'Session ID required for team creation' })

      const existing = tm.getTeam(team_name)
      if (existing) return textResult({ error: `Team "${team_name}" already exists` })

      const leaderAgentId = `team-lead@${team_name}`
      const team = tm.createTeam(team_name, ctx.sessionId, leaderAgentId, {
        description,
      })

      ctx.teamContext = {
        teamId: team_name,
        agentId: leaderAgentId,
        isLeader: true,
      }
      if (!ctx.teammateHandles) ctx.teammateHandles = new Map()

      ctx.uiWriter?.write({
        type: 'data-team-created',
        data: {
          teamId: team.id,
          name: team.name,
          description,
          leaderId: leaderAgentId,
        },
      })

      return textResult({
        ok: true,
        team_id: team.id,
        name: team.name,
        leader: leaderAgentId,
        hint: 'Use agent_spawn to add teammates, task_create to define work, send_team_message to communicate.',
      })
    },
  }
}

function createTeamDeleteTool(ctx: ToolContext): AgentTool {
  return {
    name: 'team_delete',
    description: 'Delete a team and kill all running teammates. Cascading delete removes all tasks and messages.',
    label: 'Delete Team',
    parameters: Type.Object({
      team_id: Type.String({ description: 'Team ID to delete' }),
    }),
    execute: async (_id, params) => {
      const { team_id } = params as { team_id: string }
      const tm = ctx.teamManager
      if (!tm) return textResult({ error: 'Team coordination not available' })

      if (ctx.teammateHandles) {
        for (const [id, handle] of ctx.teammateHandles) {
          if (handle.teamId === team_id) {
            handle.kill()
            ctx.teammateHandles.delete(id)
          }
        }
      }

      tm.deleteTeam(team_id)
      if (ctx.teamContext?.teamId === team_id) ctx.teamContext = undefined

      ctx.uiWriter?.write({
        type: 'data-team-deleted',
        data: { teamId: team_id },
      })

      return textResult({ ok: true, deleted: team_id })
    },
  }
}

function createTeamTaskCreateTool(ctx: ToolContext): AgentTool {
  return {
    name: 'team_task_create',
    description: "Create a task in the team's shared task queue. Teammates will automatically claim available tasks when idle.",
    label: 'Create Task',
    parameters: Type.Object({
      subject: Type.String({ description: 'Brief title of the task' }),
      description: Type.String({
        description: 'Detailed description of what needs to be done',
      }),
      blocked_by: Type.Optional(
        Type.Array(Type.Number(), {
          description: 'Task IDs that must complete before this task can start',
        }),
      ),
    }),
    execute: async (_id, params) => {
      const { subject, description, blocked_by } = params as {
        subject: string
        description: string
        blocked_by?: number[]
      }
      const tm = ctx.teamManager
      const tc = ensureTeamContext(ctx)
      if (!tm || !tc)
        return textResult({
          error: 'Not in a team context. Use team_create first.',
        })

      const task = tm.createTask(tc.teamId, { subject, description })

      if (blocked_by?.length) {
        for (const depId of blocked_by) {
          tm.blockTask(depId, task.id)
        }
      }

      const finalTask = blocked_by?.length ? (tm.getTask(task.id) ?? task) : task
      ctx.uiWriter?.write({
        type: 'data-team-task',
        data: {
          teamId: tc.teamId,
          task: {
            id: finalTask.id,
            subject: finalTask.subject,
            description: finalTask.description,
            status: finalTask.status,
            owner: finalTask.owner,
            blockedBy: finalTask.blockedBy,
          },
        },
      })

      return textResult({
        ok: true,
        task_id: task.id,
        subject: task.subject,
        status: task.status,
      })
    },
  }
}

function createTeamTaskGetTool(ctx: ToolContext): AgentTool {
  return {
    name: 'team_task_get',
    description: 'Get detailed information about a specific task including its dependencies.',
    label: 'Get Task',
    parameters: Type.Object({
      task_id: Type.Number({ description: 'Task ID to retrieve' }),
    }),
    execute: async (_id, params) => {
      const { task_id } = params as { task_id: number }
      const tm = ctx.teamManager
      if (!tm) return textResult({ error: 'Team coordination not available' })
      const task = tm.getTask(task_id)
      if (!task) return textResult({ error: `Task ${task_id} not found` })
      return textResult(task)
    },
  }
}

function createTeamTaskListTool(ctx: ToolContext): AgentTool {
  return {
    name: 'team_task_list',
    description: "List all tasks in the team's queue with their status, owner, and dependencies.",
    label: 'List Tasks',
    parameters: Type.Object({}),
    execute: async (_id, _params) => {
      const tm = ctx.teamManager
      const tc = ensureTeamContext(ctx)
      if (!tm || !tc) return textResult({ error: 'Not in a team context.' })
      const tasks = tm.listTasks(tc.teamId)
      return textResult({
        tasks: tasks.map((t) => ({
          id: t.id,
          subject: t.subject,
          status: t.status,
          owner: t.owner,
          blockedBy: t.blockedBy,
        })),
      })
    },
  }
}

function createTeamTaskUpdateTool(ctx: ToolContext): AgentTool {
  return {
    name: 'team_task_update',
    description: "Update a task's status, description, owner, or dependencies. Use to mark tasks in_progress or completed.",
    label: 'Update Task',
    parameters: Type.Object({
      task_id: Type.Number({ description: 'Task ID to update' }),
      status: Type.Optional(
        Type.String({
          description: 'New status: pending, in_progress, completed, deleted',
        }),
      ),
      subject: Type.Optional(Type.String({ description: 'Updated subject' })),
      description: Type.Optional(Type.String({ description: 'Updated description' })),
      owner: Type.Optional(Type.String({ description: 'Agent ID to assign as owner' })),
      add_blocks: Type.Optional(
        Type.Array(Type.Number(), {
          description: 'Task IDs that this task blocks',
        }),
      ),
      add_blocked_by: Type.Optional(
        Type.Array(Type.Number(), {
          description: 'Task IDs that block this task',
        }),
      ),
    }),
    execute: async (_id, params) => {
      const { task_id, ...updates } = params as any
      const tm = ctx.teamManager
      const tc = ensureTeamContext(ctx)
      if (!tm) return textResult({ error: 'Team coordination not available' })

      if (updates.status === 'in_progress' && !updates.owner && tc) {
        updates.owner = tc.agentId
      }

      const task = tm.updateTask(task_id, {
        status: updates.status,
        subject: updates.subject,
        description: updates.description,
        owner: updates.owner,
        addBlocks: updates.add_blocks,
        addBlockedBy: updates.add_blocked_by,
      })

      if (!task) return textResult({ error: `Task ${task_id} not found` })

      if (updates.owner && tc) {
        tm.writeMessage(tc.teamId, updates.owner, tc.agentId, {
          type: 'task_assignment',
          message: JSON.stringify({
            taskId: task.id,
            subject: task.subject,
            description: task.description,
          }),
          summary: `Assigned: ${task.subject}`,
        })
      }

      ctx.uiWriter?.write({
        type: 'data-team-task',
        data: {
          teamId: task.teamId,
          task: {
            id: task.id,
            subject: task.subject,
            description: task.description,
            status: task.status,
            owner: task.owner,
            blockedBy: task.blockedBy,
          },
        },
      })

      return textResult({
        ok: true,
        task_id: task.id,
        status: task.status,
        owner: task.owner,
      })
    },
  }
}

function createSendTeamMessageTool(ctx: ToolContext): AgentTool {
  return {
    name: 'send_team_message',
    description:
      'Send a message to a teammate, the team lead, or broadcast to all team members. Use structured message types for shutdown negotiation.',
    label: 'Send Team Message',
    parameters: Type.Object({
      to: Type.String({
        description: 'Recipient: teammate name, "team-lead", or "*" for broadcast',
      }),
      message: Type.String({
        description: 'Message text or JSON for structured messages',
      }),
      summary: Type.Optional(Type.String({ description: 'Brief summary of the message' })),
      message_type: Type.Optional(
        Type.String({
          description: 'Message type: text, shutdown_request, shutdown_response (default: text)',
        }),
      ),
    }),
    execute: async (_id, params) => {
      const { to, message, summary, message_type } = params as {
        to: string
        message: string
        summary?: string
        message_type?: string
      }
      const tm = ctx.teamManager
      const tc = ensureTeamContext(ctx)
      if (!tm || !tc) return textResult({ error: 'Not in a team context.' })

      let toAgent = to
      if (to === 'team-lead') {
        toAgent = `team-lead@${tc.teamId}`
      } else if (to !== '*' && !to.includes('@')) {
        toAgent = `${to}@${tc.teamId}`
      }

      const msgType = (message_type || 'text') as any

      tm.writeMessage(tc.teamId, toAgent, tc.agentId, {
        type: msgType,
        message,
        summary,
      })

      ctx.uiWriter?.write({
        type: 'data-team-message',
        data: {
          teamId: tc.teamId,
          from: tc.agentId,
          to: toAgent,
          messageType: msgType,
          message,
          summary,
        },
      })

      // Handle shutdown response (approved) — kill the teammate
      if (msgType === 'shutdown_response') {
        try {
          const parsed = JSON.parse(message)
          if (parsed.approve && ctx.teammateHandles) {
            const handle = ctx.teammateHandles.get(tc.agentId)
            if (handle) {
              handle.kill()
              ctx.teammateHandles.delete(tc.agentId)
            }
          }
        } catch {
          /* not JSON, ignore */
        }
      }

      return textResult({ ok: true, sent_to: toAgent, type: msgType })
    },
  }
}

// ---------------------------------------------------------------------------
// Quick Action Tool
// ---------------------------------------------------------------------------

function createQuickActionTool(ctx: ToolContext): AgentTool {
  return {
    name: 'quick_action',
    description:
      "Register a quick action — a one-click prompt shortcut shown in the user's chat UI. Use this when you notice a user sending a repeatable workflow prompt (commits, tests, deploys, etc.).",
    label: 'Register Quick Action',
    parameters: Type.Object({
      label: Type.String({
        description: 'Short display name (1-2 words, max 20 chars). Must be unique.',
      }),
      prompt: Type.String({
        description: 'The full message to send when clicked. Faithful to what the user would type.',
      }),
    }),
    execute: async (_toolCallId, params) => {
      const { label, prompt } = params as { label: string; prompt: string }
      const result = addQuickAction(ctx.workspaceDir, {
        label: label.trim(),
        prompt: prompt.trim(),
      })
      if (!result.ok) {
        return textResult({ ok: false, errors: result.errors })
      }
      return textResult({
        ok: true,
        registered: { label: label.trim(), prompt: prompt.trim() },
        totalActions: result.actions.length,
      })
    },
  }
}

export function createReadGuideTool(ctx: ToolContext): AgentTool {
  return {
    name: 'read_guide',
    description:
      'Read a capability guide by name (see the Capabilities Index in your system prompt), or load one deferred ' +
      "tool's full description and JSON schema with `tool` (see the Deferred Tools catalog).",
    label: 'Read Guide',
    parameters: Type.Object({
      name: Type.Optional(
        Type.String({
          description: 'Guide name from the Capabilities Index',
        }),
      ),
      tool: Type.Optional(
        Type.String({
          description:
            'Name of a deferred tool: returns its description and complete JSON schema, and advertises it for the rest of the session',
        }),
      ),
    }),
    execute: async (_toolCallId, params) => {
      const { name: guideName, tool: toolName } = params as { name?: string; tool?: string }
      const profile = ctx.toolProfileRef?.current

      if (toolName) {
        const described = profile?.describe(toolName)
        if (described) {
          profile!.advertise(toolName)
          return textResult(described)
        }
        const deferred = profile?.deferredNames() ?? []
        return textResult({
          error: profile
            ? `Unknown tool "${toolName}". Readable tools: ${deferred.length > 0 ? deferred.join(', ') : '(none deferred)'}`
            : `No deferred tools in this session — "${toolName}" is either already advertised or not registered.`,
        })
      }

      if (!guideName) {
        return textResult({
          error: 'Pass `name` for a capability guide, or `tool` for a deferred tool definition.',
        })
      }
      const registry = ctx.guideRegistry
      if (!registry) return textResult('Guide registry not available.')
      const content = registry.get(guideName)
      if (content) return textResult(content)
      return textResult(`Unknown guide "${guideName}". Available: ${[...registry.keys()].join(', ')}`)
    },
  }
}

// ---------------------------------------------------------------------------
// Terminal Read Tool — reads saved terminal output from disk
// ---------------------------------------------------------------------------

function createTerminalReadTool(ctx: ToolContext): AgentTool {
  return {
    name: 'terminal_read',
    label: 'Read Terminal Output',
    description: `Read recent terminal output from the user's IDE terminal.
Use this to answer questions like "what did I just do?" or "what commands did I run?"
by reading the desktop terminal context bridge when available, with saved terminal
files as a fallback.

If no terminal ID is specified, reads the most relevant active terminal for the
current workspace, falling back to the most recent terminal.
Returns the serialized terminal commands + output for the agent to analyze.`,
    parameters: Type.Object({
      terminalId: Type.Optional(
        Type.String({
          description: 'Terminal ID to read (default: most recent)',
        }),
      ),
      cwd: Type.Optional(
        Type.String({
          description: 'Workspace directory containing .shogo/terminals/',
        }),
      ),
    }),
    execute: async (_toolCallId: string, params: unknown) => {
      const { terminalId, cwd } = params as {
        terminalId?: string
        cwd?: string
      }

      let bridgeFallback: unknown = null
      if (ctx.terminalRead) {
        try {
          const result = await ctx.terminalRead({
            terminalId,
            cwd: cwd ?? ctx.workspaceDir,
            maxChars: 24_000,
          })
          if (result.content) {
            return textResult(result)
          }
          bridgeFallback = result
        } catch (err: any) {
          bridgeFallback = {
            error: err?.message ?? String(err),
            hint: 'Live desktop terminal bridge failed; falling back to saved terminal files.',
          }
        }
      }

      const baseDir = cwd ? `${cwd}/.shogo/terminals` : ctx.workspaceDir ? `${ctx.workspaceDir}/.shogo/terminals` : '.shogo/terminals'

      try {
        const { readdir, readFile, stat } = await import('node:fs/promises')
        const { join } = await import('node:path')

        const files = await readdir(baseDir).catch(() => [] as string[])
        const txtFiles = files.filter((f) => f.endsWith('.txt'))

        if (txtFiles.length === 0) {
          if (bridgeFallback) return textResult(bridgeFallback)
          return textResult({
            error: 'No saved terminal files found.',
            hint: ctx.terminalRead
              ? 'No live desktop terminal context or saved terminal files were available. Open the IDE Terminal tab and run a command first.'
              : 'Terminal output is saved when a terminal session closes. Try running some commands in the terminal first.',
          })
        }

        let targetFile: string
        if (terminalId) {
          const match = txtFiles.find((f) => f === `${terminalId}.txt`)
          if (!match) {
            return textResult({
              error: `Terminal "${terminalId}" not found.`,
              available: txtFiles.map((f) => f.replace('.txt', '')),
            })
          }
          targetFile = match
        } else {
          // Find most recent file by mtime
          let newest = txtFiles[0]!
          let newestMtime = 0
          for (const f of txtFiles) {
            try {
              const s = await stat(join(baseDir, f))
              if (s.mtimeMs > newestMtime) {
                newestMtime = s.mtimeMs
                newest = f
              }
            } catch {
              /* skip */
            }
          }
          targetFile = newest
        }

        const content = await readFile(join(baseDir, targetFile), 'utf-8')
        return textResult({
          file: targetFile,
          terminalId: targetFile.replace('.txt', ''),
          content,
        })
      } catch (err: any) {
        return textResult({
          error: err?.message ?? String(err),
          hint: 'Could not read terminal files. Ensure .shogo/terminals/ exists.',
        })
      }
    },
  }
}

// ---------------------------------------------------------------------------
// Terminal Exec Tool — runs commands in the user's visible terminal (desktop)
// ---------------------------------------------------------------------------

function createTerminalExecTool(ctx: ToolContext): AgentTool {
  return {
    name: 'terminal_exec',
    label: 'Execute in Terminal',
    description: `Execute a shell command in the user's visible terminal (desktop app only).
Unlike exec (which runs in a sandbox), this sends the command to the user's terminal,
waits for completion, and returns the output.

For SHORT one-shot commands (echo, ls, git status, etc.): runs in the user's existing
terminal, captures output, returns result in chat.

For LONG-running commands (dev servers, watchers, etc.): creates a new agent terminal
tab named "Shogo" with an infinity icon. The user can see it running. Returns a
"background task started" message with the terminal ID.

Returns: { exitCode, output, cwd, durationMs, timedOut, mode, sessionId? }.

If the desktop terminal is not available (web/mobile), falls back to the sandboxed exec.`,
    parameters: Type.Object({
      command: Type.Optional(Type.String({ description: 'The shell command to execute' })),
      action: Type.Optional(
        Type.String({
          description: '"run" (default), "interrupt" to send SIGINT',
          enum: ['run', 'interrupt'],
        }),
      ),
      mode: Type.Optional(
        Type.String({
          description: '"foreground" (default, auto-detected) or "background" to force agent terminal tab',
          enum: ['foreground', 'background'],
        }),
      ),
      cwd: Type.Optional(Type.String({ description: 'Working directory (defaults to current)' })),
      timeoutMs: Type.Optional(
        Type.Number({
          description: 'Max wait time in ms (default: 120000 for foreground, no limit for background)',
        }),
      ),
    }),
    execute: async (_toolCallId: string, params: unknown) => {
      const { command, cwd, timeoutMs, action, mode } = params as {
        command?: string
        cwd?: string
        timeoutMs?: number
        action?: string
        mode?: string
      }

      if (!ctx.terminalExec) {
        return textResult({
          error: 'Desktop terminal not available. Use exec tool instead.',
          hint: 'This command can only run on the desktop app.',
        })
      }

      if (action === 'interrupt') {
        if (!ctx.terminalInterrupt) {
          return textResult({ error: 'Terminal interrupt not available.' })
        }
        try {
          const result = await ctx.terminalInterrupt()
          return textResult(result)
        } catch (err: any) {
          return textResult({ error: err?.message ?? String(err) })
        }
      }

      if (!command) {
        return textResult({
          error: 'command parameter is required for run action.',
        })
      }

      // terminal_exec runs in the user's REAL login shell with their full
      // environment — strictly more dangerous than the sandboxed `exec` tool.
      // Apply the same guards exec uses so prompt-injection can't bypass them:
      //   1. Workspace Trust (restricted-mode projects refuse shell commands)
      //   2. Gateway self-protect (don't let the agent kill its own runtime)
      // The PermissionEngine ask/allow/deny gate is applied by the `g(..., 'shell')`
      // wrapper in createTools().
      const execTrust = assertAllowedPath(ctx.workspaceDir, 'exec', ctx.workspaceDir)
      if (!execTrust.ok) return textResult({ error: execTrust.message })

      // Constrain an explicit cwd to the trusted workspace — the agent must not
      // be able to `cd` the user's shell to arbitrary locations.
      if (cwd) {
        const cwdTrust = assertAllowedPath(cwd, 'exec', ctx.workspaceDir)
        if (!cwdTrust.ok) return textResult({ error: cwdTrust.message })
      }

      const gatewayGuard = commandTargetsGateway(command)
      if (gatewayGuard.blocked) {
        return textResult({
          error: gatewayKillRefusal(gatewayGuard.reason ?? 'kill targets the runtime'),
        })
      }

      try {
        // Auto-detect long-running commands when mode is not explicitly set
        let effectiveMode: 'foreground' | 'background' = (mode ?? 'foreground') as 'foreground' | 'background'
        if (!mode) {
          const lc = command.toLowerCase().trim()
          const longPatterns = [
            /\bdev\b/,
            /\bstart\b/,
            /\bserve\b/,
            /\bwatch\b/,
            /\bvite\b/,
            /\bexpo\b/,
            /\bmetro\b/,
            /\bwebpack\b/,
            /\bnpm\s+run\s+(dev|start|serve|preview)\b/,
            /\bbun\s+run\b/,
            /\byarn\s+(dev|start|serve)\b/,
            /\bdocker-compose\s+up\b/,
            /\bdocker\s+compose\s+up\b/,
            /\bdocker\s+run\b/,
            /\bpm2\s+(start|serve)\b/,
            /\bnohup\b/,
            /\bforever\b/,
            /\bsupervisor\b/,
            /\bpython\s+-m\s+http\.server\b/,
            /\buvicorn\b/,
            /\bgunicorn\b/,
            /\s*&\s*$/,
          ]
          for (const p of longPatterns) {
            if (p.test(lc)) {
              effectiveMode = 'background' as const
              break
            }
          }
        }
        const result = await ctx.terminalExec({
          command,
          cwd,
          timeoutMs: effectiveMode === 'background' ? undefined : (timeoutMs ?? 120_000),
          mode: effectiveMode,
        })
        return textResult(result)
      } catch (err: any) {
        return textResult({
          error: err?.message ?? String(err),
          command,
        })
      }
    },
  }
}

export function createExposePortTool(ctx: ToolContext): AgentTool {
  return {
    name: 'expose_port',
    label: 'Expose Port',
    description:
      'Expose a TCP port this project is listening on so Studio can reach it. ' +
      'A new port is tunnel-only (project members). Set visibility to "preview" to make an http port public; ' +
      'that asks the user to approve before it happens. Use this when `docker compose ps` shows the app on a port ' +
      'that is not already in the Exposed ports list.',
    parameters: Type.Object({
      port: Type.Number({ description: 'Port number between 1024 and 65535' }),
      protocol: Type.Union([Type.Literal('http'), Type.Literal('tcp')], { description: 'http for a web app, tcp for a database or other raw protocol' }),
      label: Type.Optional(Type.String({ description: 'Short name, such as "vite" or "api"' })),
      visibility: Type.Optional(Type.Union([Type.Literal('tunnel'), Type.Literal('preview')])),
    }),
    execute: async (toolCallId, params) => {
      const input = params as { port: number; protocol: 'http' | 'tcp'; label?: string; visibility?: 'tunnel' | 'preview' }
      const projectId = projectScopedId(ctx.projectId) || projectScopedId(process.env.WORKSPACE_ANCHOR_PROJECT_ID)
      if (!projectId) return textResult({ error: 'No project selected.' })
      const visibility = input.visibility === 'preview' ? 'preview' : 'tunnel'
      if (visibility === 'preview') {
        if (input.protocol !== 'http') {
          return textResult({ error: 'Only an http port can be made public. Use protocol "http", or leave visibility as tunnel.' })
        }
        const engine = ctx.permissionEngine
        if (engine) {
          const approved = await engine.requestApproval(
            toolCallId,
            'expose_port',
            'network',
            input,
            `Make port ${input.port} publicly reachable at its preview URL, with no login.`,
          )
          if (!approved) {
            return textResult({
              error: 'The user declined making this port public.',
              instruction: 'Do not ask again in chat. The port was not exposed.',
            })
          }
        }
      }
      const apiUrl = deriveApiUrl()
      if (!apiUrl) return textResult({ error: 'The project API is not configured.' })
      const response = await fetch(`${apiUrl}/api/internal/projects/${projectId}/ports`, {
        method: 'POST',
        headers: getInternalHeaders(),
        body: JSON.stringify({
          port: input.port,
          protocol: input.protocol,
          label: input.label,
          visibility,
        }),
      })
      const body = await response.json().catch(() => ({}))
      if (!response.ok) {
        return textResult({ error: (body as any)?.error || `Could not expose port ${input.port}.`, status: response.status })
      }
      const listed = Array.isArray((body as any).ports) ? (body as any).ports : []
      const mine = listed.find((p: any) => p.port === input.port)
      return textResult({
        ok: true,
        port: input.port,
        visibility: mine?.visibility ?? visibility,
        previewUrl: mine?.previewUrl,
      })
    },
  }
}

const SOCIAL_CACHE_TTL_SECONDS = 10 * 60

export type SocialPlatformName = 'instagram' | 'tiktok'

/**
 * Whether `social_media` exists at all: public lookups and account management
 * are separate opt-ins, and a workspace may want either without the other.
 */
export function socialMediaToolEnabled(config: import('./gateway').GatewayConfig): boolean {
  return config.socialMediaEnabled === true || config.socialManagementEnabled === true
}

/** Platforms the `social_media` tool may call. Empty when lookups are off. */
export function enabledSocialPlatforms(config: import('./gateway').GatewayConfig): SocialPlatformName[] {
  if (config.socialMediaEnabled !== true) return []
  const platforms: SocialPlatformName[] = []
  if (config.socialInstagramEnabled !== false) platforms.push('instagram')
  if (config.socialTiktokEnabled !== false) platforms.push('tiktok')
  return platforms
}

function socialPlatformSchema(platforms: SocialPlatformName[]) {
  if (platforms.length === 1) return Type.Literal(platforms[0])
  const listed = platforms.length > 0 ? platforms : (['instagram', 'tiktok'] as SocialPlatformName[])
  return Type.Union(listed.map((platform) => Type.Literal(platform)))
}

/**
 * Call the internal social routes — the same handlers the desktop composer and
 * the UI use, so a tool action cannot drift from what a person sees.
 */
async function socialInternalCall(
  ctx: ToolContext,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  body?: Record<string, unknown>,
): Promise<{ ok: true; data: any } | { ok: false; error: string; code?: string; suggestion?: string }> {
  const workspaceId = ctx.workspaceId
  if (!workspaceId) {
    return { ok: false, error: 'No workspace in scope for social inbox calls.' }
  }
  const apiUrl = deriveApiUrl()
  if (!apiUrl) return { ok: false, error: NO_API_URL_ERROR }
  try {
    const response = await fetch(
      `${apiUrl.replace(/\/$/, '')}/api/internal/workspaces/${encodeURIComponent(workspaceId)}${path}`,
      {
        method,
        headers: getInternalHeaders(),
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(20_000),
      },
    )
    const data = await response.json().catch(() => ({}))
    if (!response.ok) {
      const rawCode = (data as any)?.error?.code
      const code = typeof rawCode === 'string' ? rawCode : undefined
      return {
        ok: false,
        error: (data as any)?.error?.message ?? (data as any)?.error ?? `HTTP ${response.status}`,
        code,
        suggestion:
          code === 'social_relay_unavailable'
            ? 'Sign in to Shogo Cloud in Settings, then retry.'
            : code === 'social_profile_missing'
              ? 'Run action "connect" for that platform first — the connect creates the workspace’s profile.'
              : code === 'social_profile_unresolved'
                ? 'The social provider did not return a profile id. Retry once, then report it if it keeps happening.'
                : code === 'social_not_configured'
                  ? 'Social is not configured on the server: the workspace owner has to set the provider key.'
                  : code === 'account_out_of_scope' || code === 'profile_out_of_scope'
                    ? 'That resource belongs to another workspace. Connect this workspace’s own account.'
                    : code === 'account_owned_elsewhere'
                      ? 'Disconnect that account from the other workspace first, then connect it here.'
                      : response.status === 409
                        ? 'Connect the account, then run action "inbox" with kind "dms" or "comments" to sync first.'
                        : undefined,
      }
    }
    return { ok: true, data }
  } catch (err: any) {
    return { ok: false, error: `Social inbox request failed: ${err?.message ?? err}` }
  }
}

/**
 * Platforms a person can connect from the app / with the agent. Zernio serves
 * the OAuth for each of them; the list is here so a typo is refused with the
 * accepted values instead of a provider 404.
 */
const SOCIAL_CONNECT_PLATFORMS = [
  'instagram',
  'tiktok',
  'facebook',
  'x',
  'linkedin',
  'youtube',
  'threads',
  'pinterest',
  'reddit',
  'bluesky',
  'googlebusiness',
]

const SOCIAL_PLATFORM_LABELS: Record<string, string> = {
  instagram: 'Instagram',
  tiktok: 'TikTok',
  facebook: 'Facebook',
  x: 'X',
  linkedin: 'LinkedIn',
  youtube: 'YouTube',
  threads: 'Threads',
  pinterest: 'Pinterest',
  reddit: 'Reddit',
  bluesky: 'Bluesky',
  googlebusiness: 'Google Business Profile',
}

function platformLabel(platform: string): string {
  return SOCIAL_PLATFORM_LABELS[platform] ?? platform
}

/** A password-shaped argument, or null. Nothing in this tool ever needs one. */
function credentialShapedParams(rawParams: unknown): string | null {
  if (!rawParams || typeof rawParams !== 'object') return null
  const blocked = ['password', 'passwd', 'pass', 'credentials', 'credential', 'otp', 'two_factor_code']
  for (const key of Object.keys(rawParams as Record<string, unknown>)) {
    if (!blocked.includes(key.toLowerCase())) continue
    const value = (rawParams as Record<string, unknown>)[key]
    if (typeof value === 'string' && value.trim()) return key
  }
  return null
}

/** A JSON object passed as a string (models do this) or already an object. */
function parseJsonObject(raw: unknown): Record<string, any> | undefined {
  if (!raw) return undefined
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, any>
  if (typeof raw !== 'string' || !raw.trim()) return undefined
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, any>)
      : undefined
  } catch {
    return undefined
  }
}

/**
 * The MIME type Zernio's presign accepts for a file, from its extension. A file
 * whose type cannot be named is refused rather than uploaded as
 * `application/octet-stream`, which the provider rejects.
 */
const SOCIAL_MEDIA_CONTENT_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  m4v: 'video/x-m4v',
  webm: 'video/webm',
  mpeg: 'video/mpeg',
  mpg: 'video/mpeg',
  avi: 'video/x-msvideo',
  pdf: 'application/pdf',
  mp3: 'audio/mpeg',
  m4a: 'audio/x-m4a',
  wav: 'audio/wav',
  aac: 'audio/aac',
  ogg: 'audio/ogg',
  srt: 'application/x-subrip',
  vtt: 'text/vtt',
}

function socialContentTypeFor(filename: string): string | undefined {
  const match = /\.([A-Za-z0-9]+)$/.exec(filename)
  return match ? SOCIAL_MEDIA_CONTENT_TYPES[match[1]!.toLowerCase()] : undefined
}

const MAX_SOCIAL_UPLOAD_BYTES = 5 * 1024 * 1024 * 1024

/**
 * Turn post media into URLs Zernio can publish.
 *
 * A public https URL is used as-is. A workspace path is minted an upload slot,
 * the bytes are PUT to it from here — so a 200 MB MP4 never travels through the
 * API — and the slot's `publicUrl` is what the post names. Paths outside the
 * workspace are refused, the same guard the other file tools apply.
 */
async function resolveSocialMedia(
  ctx: ToolContext,
  entries: string[],
): Promise<{ ok: true; urls: string[] } | { ok: false; error: string }> {
  const urls: string[] = []
  for (const entry of entries) {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(entry)) {
      if (!entry.startsWith('https://')) {
        return { ok: false, error: `Media URLs must be https, so the platform can fetch them: ${entry}` }
      }
      urls.push(entry)
      continue
    }

    const path = entry.replace(/\\/g, '/').replace(/^\.\//, '')
    let resolved: string
    try {
      resolved = assertWithinWorkspaceSecure(ctx.workspaceDir, path, pathPolicy(ctx))
    } catch {
      return { ok: false, error: `Media path is outside the workspace: ${entry}` }
    }

    let bytes: Uint8Array
    try {
      const stat = statSync(resolved)
      if (!stat.isFile()) return { ok: false, error: `Not a file: ${entry}` }
      if (stat.size > MAX_SOCIAL_UPLOAD_BYTES) {
        return { ok: false, error: `${entry} is larger than the 5 GB Zernio accepts.` }
      }
      bytes = new Uint8Array(readFileSync(resolved))
    } catch {
      return { ok: false, error: `Media file not found: ${entry}` }
    }

    const filename = path.split('/').pop() ?? path
    const contentType = socialContentTypeFor(filename)
    if (!contentType) {
      return {
        ok: false,
        error: `Cannot tell the media type of ${filename}. Supported: png, jpg, gif, webp, mp4, mov, m4v, webm, mpeg, avi, pdf, mp3, m4a, wav.`,
      }
    }

    const slot = await socialInternalCall(ctx, 'POST', '/social/media/presign', {
      filename,
      contentType,
      size: bytes.byteLength,
    })
    if (!slot.ok) return { ok: false, error: slot.error }
    const uploadUrl = typeof slot.data?.uploadUrl === 'string' ? slot.data.uploadUrl : ''
    const publicUrl = typeof slot.data?.publicUrl === 'string' ? slot.data.publicUrl : ''
    if (!uploadUrl || !publicUrl) {
      return { ok: false, error: 'The media upload slot came back incomplete.' }
    }

    try {
      // A presigned storage URL carries its own credential; the runtime's own
      // token must never ride along with it.
      const put = await fetch(uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': contentType },
        body: bytes as unknown as BodyInit,
        signal: AbortSignal.timeout(120_000),
      })
      if (!put.ok) {
        return { ok: false, error: `Uploading ${filename} failed (HTTP ${put.status}).` }
      }
    } catch (err: any) {
      return { ok: false, error: `Uploading ${filename} failed: ${err?.message ?? err}` }
    }
    urls.push(publicUrl)
  }
  return { ok: true, urls }
}

/** A post, in the shape an agent (or a person reading chat) can act on. */
function summarizeSocialPost(post: any) {
  if (!post || typeof post !== 'object') return null
  return {
    post_id: post.id,
    status: post.status,
    content: post.content,
    scheduled_for: post.scheduledFor ?? null,
    published_at: post.publishedAt ?? null,
    targets: (Array.isArray(post.targets) ? post.targets : []).map((target: any) => ({
      account_id: target.accountId,
      platform: target.platform,
      username: target.account?.username ?? null,
      status: target.status,
      url: target.platformPostUrl ?? null,
      error: target.error ?? null,
    })),
  }
}

/**
 * Public Instagram/TikTok profile and recent-post lookup, plus the connected
 * accounts' own inbox: threads and comments, and answering them.
 *
 * The lookup calls `POST ${TOOLS_PROXY_URL}/social/...` (the EnsembleData token
 * stays on the API server); the inbox actions call the internal social routes,
 * which are the same handlers the UI uses.
 */
function createSocialMediaTool(ctx: ToolContext): AgentTool {
  const platforms = enabledSocialPlatforms(ctx.config)
  const platformList = platforms.join(', ') || 'none'
  return {
    name: 'social_media',
    description:
      `Look up a public social profile or its recent posts (views, likes, comments, shares), ` +
      `or work a workspace's connected accounts: connect one, publish and schedule posts, ` +
      `read the calendar and analytics, and run the inbox. ` +
      `Enabled lookup platforms: ${platformList}. ` +
      `Actions: "profile" and "recent_posts" take a handle; ` +
      `"connect" takes a platform and returns a sign-in LINK to give the person — never ask for or accept a username, password or 2FA code; ` +
      `"accounts" lists the connected accounts and their ids; ` +
      `"post" publishes or schedules one post to one or more accounts (content, account_ids, media, scheduled_for/publish_now/draft); ` +
      `"posts" lists posts, "calendar" the schedule and "analytics" the numbers; ` +
      `"inbox" lists DM threads (kind "dms") or comments (kind "comments"); ` +
      `"reply" takes conversation_id + text; "comment_reply" takes comment_id + text; ` +
      `"automate" manages comment→DM automations (automation_action create/list/pause/resume/delete). ` +
      `Media for a post is a public https URL or a workspace file path, which is uploaded for you. ` +
      `Instagram and TikTok refuse a post with no image or video; TikTok defaults to an inbox draft unless direct-post settings are given. ` +
      `Lookups spend paid API units — prefer one call with a sufficient limit over several small ones. ` +
      `Inbox replies are public/sent as the connected account: quote the user's own words when unsure.`,
    label: 'Social Media',
    parameters: Type.Object({
      action: Type.Union(
        [
          Type.Literal('profile'),
          Type.Literal('recent_posts'),
          Type.Literal('inbox'),
          Type.Literal('reply'),
          Type.Literal('comment_reply'),
          Type.Literal('automate'),
          Type.Literal('connect'),
          Type.Literal('accounts'),
          Type.Literal('post'),
          Type.Literal('posts'),
          Type.Literal('calendar'),
          Type.Literal('analytics'),
        ],
        {
          description:
            'profile | recent_posts | inbox | reply | comment_reply | automate | connect | accounts | post | posts | calendar | analytics',
        },
      ),
      platform: Type.Optional(socialPlatformSchema(platforms)),
      handle: Type.Optional(Type.String({ description: 'Account handle, with or without a leading @. Required for profile/recent_posts.' })),
      limit: Type.Optional(Type.Number({
        description: 'How many posts or inbox rows to return (1-50, default 20).',
      })),
      kind: Type.Optional(Type.Union([Type.Literal('dms'), Type.Literal('comments')], {
        description: 'For action "inbox": which half of the inbox to list.',
      })),
      unread_only: Type.Optional(Type.Boolean({ description: 'For action "inbox": only threads with unread messages.' })),
      conversation_id: Type.Optional(Type.String({ description: 'For action "reply": the inbox thread id.' })),
      comment_id: Type.Optional(Type.String({ description: 'For action "comment_reply": the comment id.' })),
      text: Type.Optional(Type.String({ description: 'For "reply" / "comment_reply": what to send.' })),
      automation_action: Type.Optional(
        Type.Union(
          [
            Type.Literal('create'),
            Type.Literal('list'),
            Type.Literal('pause'),
            Type.Literal('resume'),
            Type.Literal('delete'),
          ],
          { description: 'For action "automate": what to do with the workspace comment automations.' },
        ),
      ),
      automation_kind: Type.Optional(
        Type.Union(
          [Type.Literal('comment_dm'), Type.Literal('keyword_reply'), Type.Literal('sequence')],
          { description: 'comment_dm (DM the commenter), keyword_reply (public reply only) or sequence (a comment-triggered DM graph).' },
        ),
      ),
      automation_id: Type.Optional(Type.String({ description: 'For automate pause/resume/delete: the automation id from automate list.' })),
      account_id: Type.Optional(Type.String({ description: 'For automate create: the connected account id to run it on.' })),
      name: Type.Optional(Type.String({ description: 'For automate create: a label for the automation.' })),
      keywords: Type.Optional(Type.String({ description: 'For automate create: comma-separated trigger keywords, e.g. "merge,link".' })),
      dm_message: Type.Optional(Type.String({ description: 'For automate create: the DM to send the commenter.' })),
      comment_reply: Type.Optional(Type.String({ description: 'For automate create: a public reply under the comment (required on reply-only platforms).' })),
      messages: Type.Optional(Type.String({ description: 'For a sequence: comma-separated DM messages sent in order, 1-3.' })),
      content: Type.Optional(
        Type.String({ description: 'For action "post": the caption or text of the post.' }),
      ),
      account_ids: Type.Optional(
        Type.Array(Type.String(), {
          description:
            'For action "post": the connected account ids to publish to, from action "accounts". One post fans out to all of them.',
        }),
      ),
      media: Type.Optional(
        Type.Array(Type.String(), {
          description:
            'For action "post": images or videos. Each entry is either a public https URL or a workspace-relative file path (e.g. "renders/hero.png"), which is uploaded through the media presign flow first. Instagram and TikTok require at least one.',
        }),
      ),
      variants: Type.Optional(
        Type.String({
          description:
            'For action "post": JSON object keyed by account id with per-target overrides, e.g. {"<account_id>": {"content": "different caption", "media": ["renders/alt.mp4"], "platform_specific_data": {"title": "..."}}}.',
        }),
      ),
      scheduled_for: Type.Optional(
        Type.String({
          description:
            'For action "post": ISO timestamp to schedule the post for (omit, with no publish_now and no draft, to publish now).',
        }),
      ),
      publish_now: Type.Optional(
        Type.Boolean({ description: 'For action "post": publish immediately instead of scheduling.' }),
      ),
      draft: Type.Optional(
        Type.Boolean({ description: 'For action "post": save as a draft and publish nothing.' }),
      ),
      tiktok: Type.Optional(
        Type.String({
          description:
            'For action "post": JSON TikTok settings, e.g. {"privacyLevel":"PUBLIC_TO_EVERYONE","contentPreviewConfirmed":true,"expressConsentGiven":true} for a direct post. Omit it and the video goes to the creator\'s TikTok inbox as a draft (the safe default).',
        }),
      ),
      expected_username: Type.Optional(
        Type.String({
          description:
            'For action "connect": the handle the person says they are connecting. A sign-in that lands on a different account is refused instead of connected.',
        }),
      ),
      force_reauth: Type.Optional(
        Type.Boolean({
          description:
            'For action "connect": Instagram only. Show Instagram\'s own login page instead of reusing whichever account is already signed in on the device.',
        }),
      ),
      status: Type.Optional(
        Type.String({ description: 'For action "posts": only posts in this status (draft, scheduled, published, partial, failed).' }),
      ),
      from: Type.Optional(
        Type.String({ description: 'For "posts" / "calendar" / "analytics": start of the window, ISO date. Defaults to 7 days ago (calendar) or 30 days (analytics).' }),
      ),
      to: Type.Optional(
        Type.String({ description: 'For "posts" / "calendar" / "analytics": end of the window, ISO date.' }),
      ),
    }),
    execute: async (_toolCallId, rawParams) => {
      // The platform enum is built from the enabled set, so TypeBox cannot
      // infer the parameter object. Read the fields explicitly.
      const params = rawParams as {
        action?: unknown
        platform?: unknown
        handle?: unknown
        limit?: unknown
        kind?: unknown
        unread_only?: unknown
        conversation_id?: unknown
        comment_id?: unknown
        text?: unknown
        automation_action?: unknown
        automation_kind?: unknown
        automation_id?: unknown
        account_id?: unknown
        name?: unknown
        keywords?: unknown
        dm_message?: unknown
        comment_reply?: unknown
        messages?: unknown
        content?: unknown
        account_ids?: unknown
        media?: unknown
        variants?: unknown
        scheduled_for?: unknown
        publish_now?: unknown
        draft?: unknown
        tiktok?: unknown
        expected_username?: unknown
        force_reauth?: unknown
        status?: unknown
        from?: unknown
        to?: unknown
      }
      const action = String(params.action ?? '')
      const allowed = enabledSocialPlatforms(ctx.config)
      const limit = typeof params.limit === 'number' && Number.isFinite(params.limit)
        ? Math.min(50, Math.max(1, Math.floor(params.limit)))
        : 20

      // Two opt-ins, checked per action: lookups spend paid lookup units, and
      // managing the connected accounts does not. Turning one on must not turn
      // the other on, so neither may be read as the other's gate. The lookup
      // path keeps its own platform check further down.
      const managementActions = new Set([
        'inbox',
        'reply',
        'comment_reply',
        'automate',
        'connect',
        'accounts',
        'post',
        'posts',
        'calendar',
        'analytics',
      ])
      if (managementActions.has(action) && ctx.config.socialManagementEnabled !== true) {
        return textResult({
          error:
            'Social management is off for this project: connecting accounts, posting and the inbox are disabled. Turn on the Social management capability to use them.',
        })
      }

      if (action === 'connect') {
        // A connect is a link plus a person's own sign-in. Credentials typed into
        // this tool are a bug in the conversation, so they are refused rather
        // than passed anywhere — nothing here ever needs them.
        const credentials = credentialShapedParams(rawParams)
        if (credentials) {
          return textResult({
            refused: true,
            error: `Never accept a ${credentials} — not to connect an account, not to sign in. Give the person the sign-in link instead and ask them to change that password now.`,
          })
        }
        const platform = String(params.platform ?? '').trim().toLowerCase()
        if (!SOCIAL_CONNECT_PLATFORMS.includes(platform)) {
          return textResult({
            error: `platform must be one of: ${SOCIAL_CONNECT_PLATFORMS.join(', ')}.`,
          })
        }
        const expected = String(params.expected_username ?? '').trim().replace(/^@+/, '')
        const result = await socialInternalCall(ctx, 'POST', '/social/connect', {
          platform,
          ...(expected ? { expectedUsername: expected } : {}),
          ...(params.force_reauth === true ? { forceReauth: true } : {}),
        })
        if (!result.ok) {
          return textResult({ error: result.error, code: result.code, suggestion: result.suggestion })
        }
        const url = typeof result.data?.url === 'string' ? result.data.url : ''
        if (!url) return textResult({ error: 'No sign-in link was returned.' })
        return textResult({
          platform,
          url,
          instructions:
            `Give the person this link and ask them to open it in a browser and sign in on ${platformLabel(platform)}'s own page. ` +
            `When they finish they land on a page saying the account is connected; run action "accounts" to see it. ` +
            (platform === 'instagram'
              ? 'Instagram needs a professional (Business or Creator) account to publish — Instagram converts a personal one during sign-in.'
              : ''),
          never:
            'Never ask for, accept or store a username, password or 2FA code: Shogo never sees them, and this flow never needs them.',
        })
      }

      if (action === 'accounts') {
        // Sync first: a connect that just finished in a browser wrote nothing
        // locally, and the person expects the account to be there now.
        const result = await socialInternalCall(ctx, 'POST', '/social/accounts/sync')
        if (!result.ok) {
          return textResult({ error: result.error, code: result.code, suggestion: result.suggestion })
        }
        const accounts = Array.isArray(result.data?.accounts) ? result.data.accounts : []
        return textResult({
          count: accounts.length,
          accounts: accounts.map((account: any) => ({
            account_id: account.id,
            platform: account.platform,
            username: account.username,
            active: account.isActive !== false,
            needs_reconnect: account.needsReconnect === true,
          })),
        })
      }

      if (action === 'post') {
        const content = String(params.content ?? '').trim()
        const isDraft = params.draft === true
        const targetIds = Array.isArray(params.account_ids)
          ? params.account_ids.map((id) => String(id).trim()).filter(Boolean)
          : []
        if (!isDraft && targetIds.length === 0) {
          return textResult({
            error: 'account_ids is required: run action "accounts" first and pass the account_id values to publish to.',
          })
        }
        const mediaEntries = Array.isArray(params.media)
          ? params.media.map((entry) => String(entry).trim()).filter(Boolean)
          : []

        const accountsResult = await socialInternalCall(ctx, 'GET', '/social/accounts')
        if (!accountsResult.ok) {
          return textResult({ error: accountsResult.error, suggestion: accountsResult.suggestion })
        }
        const known = new Map<string, any>(
          (Array.isArray(accountsResult.data?.accounts) ? accountsResult.data.accounts : []).map(
            (account: any) => [String(account.id), account],
          ),
        )
        const unknown = targetIds.filter((id) => !known.has(id))
        if (unknown.length) {
          return textResult({
            error: `Unknown account id(s): ${unknown.join(', ')}.`,
            suggestion: 'Run action "accounts" to list the connected accounts and their ids.',
          })
        }
        // Instagram and TikTok refuse a post without media, so the refusal
        // happens here — before an upload slot is minted or a post is created.
        const needingMedia = targetIds
          .map((id) => known.get(id))
          .filter((account: any) => account?.platform === 'instagram' || account?.platform === 'tiktok')
        if (needingMedia.length && mediaEntries.length === 0) {
          return textResult({
            error: `${needingMedia.map((account: any) => `@${account.username} (${account.platform})`).join(', ')} need at least one image or video: pass it in "media".`,
          })
        }

        const media = mediaEntries.length
          ? await resolveSocialMedia(ctx, mediaEntries)
          : ({ ok: true, urls: [] } as const)
        if (!media.ok) return textResult({ error: media.error })

        const variantInput = parseJsonObject(params.variants)
        const variants: Record<string, unknown> = {}
        for (const [accountId, raw] of Object.entries(variantInput ?? {})) {
          if (!raw || typeof raw !== 'object') continue
          const entry = raw as Record<string, unknown>
          const entryMedia = Array.isArray(entry.media)
            ? entry.media.map((item) => String(item).trim()).filter(Boolean)
            : []
          const resolvedEntry = entryMedia.length
            ? await resolveSocialMedia(ctx, entryMedia)
            : ({ ok: true, urls: [] } as const)
          if (!resolvedEntry.ok) return textResult({ error: resolvedEntry.error })
          variants[accountId] = {
            ...(typeof entry.content === 'string' ? { content: entry.content } : {}),
            ...(resolvedEntry.urls.length ? { mediaUrls: resolvedEntry.urls } : {}),
            ...(entry.platform_specific_data && typeof entry.platform_specific_data === 'object'
              ? { platformSpecificData: entry.platform_specific_data }
              : {}),
          }
        }

        const scheduledFor = String(params.scheduled_for ?? '').trim()
        const tiktok = parseJsonObject(params.tiktok)
        const created = await socialInternalCall(ctx, 'POST', '/social/posts', {
          content,
          accountIds: targetIds,
          ...(media.urls.length ? { mediaUrls: media.urls } : {}),
          ...(Object.keys(variants).length ? { variants } : {}),
          ...(scheduledFor ? { scheduledFor } : {}),
          ...(params.publish_now === true ? { publishNow: true } : {}),
          ...(isDraft ? { draft: true } : {}),
          ...(tiktok ? { tiktok } : {}),
        })
        if (!created.ok) return textResult({ error: created.error, suggestion: created.suggestion })
        return textResult({
          post: summarizeSocialPost(created.data?.post),
          media_uploaded: media.urls.length,
          note: isDraft
            ? 'Saved as a draft: nothing is published until it is scheduled or sent.'
            : scheduledFor
              ? `Scheduled for ${scheduledFor}.`
              : 'Publishing now: check each target below for its own result.',
        })
      }

      if (action === 'posts') {
        const status = String(params.status ?? '').trim()
        const query = new URLSearchParams({ limit: String(limit) })
        if (status) query.set('status', status)
        const result = await socialInternalCall(ctx, 'GET', `/social/posts?${query.toString()}`)
        if (!result.ok) return textResult({ error: result.error, suggestion: result.suggestion })
        const posts = Array.isArray(result.data?.posts) ? result.data.posts : []
        return textResult({ count: posts.length, posts: posts.map(summarizeSocialPost) })
      }

      if (action === 'calendar') {
        const query = new URLSearchParams()
        for (const key of ['from', 'to'] as const) {
          const value = String(params[key] ?? '').trim()
          if (value) query.set(key, value)
        }
        const result = await socialInternalCall(
          ctx,
          'GET',
          `/social/calendar${query.toString() ? `?${query.toString()}` : ''}`,
        )
        if (!result.ok) return textResult({ error: result.error, suggestion: result.suggestion })
        const posts = Array.isArray(result.data?.posts) ? result.data.posts : []
        return textResult({
          from: result.data?.from ?? null,
          to: result.data?.to ?? null,
          count: posts.length,
          posts: posts.map(summarizeSocialPost),
        })
      }

      if (action === 'analytics') {
        const query = new URLSearchParams()
        for (const key of ['from', 'to'] as const) {
          const value = String(params[key] ?? '').trim()
          if (value) query.set(key, value)
        }
        const result = await socialInternalCall(
          ctx,
          'GET',
          `/social/analytics${query.toString() ? `?${query.toString()}` : ''}`,
        )
        if (!result.ok) return textResult({ error: result.error, suggestion: result.suggestion })
        return textResult(result.data)
      }

      if (action === 'automate') {
        const step = String(params.automation_action ?? 'list')
        if (step === 'list') {
          const result = await socialInternalCall(ctx, 'GET', `/social/automations?limit=${limit}`)
          if (!result.ok) return textResult({ error: result.error, suggestion: result.suggestion })
          const automations = Array.isArray(result.data?.automations) ? result.data.automations : []
          return textResult({
            count: automations.length,
            automations: automations.map((automation: any) => ({
              automation_id: automation.id,
              name: automation.name,
              kind: automation.kind,
              platform: automation.platform,
              status: automation.status,
              keywords: automation.keywords,
              runs: automation.runCount,
            })),
          })
        }

        const automationId = String(params.automation_id ?? '').trim()
        if (step === 'pause' || step === 'resume' || step === 'delete') {
          if (!automationId) {
            return textResult({
              error: 'automation_id is required: run action "automate" with automation_action "list" first.',
            })
          }
          const path = `/social/automations/${encodeURIComponent(automationId)}`
          const result =
            step === 'delete'
              ? await socialInternalCall(ctx, 'DELETE', path)
              : await socialInternalCall(ctx, 'PATCH', path, {
                  status: step === 'pause' ? 'paused' : 'active',
                })
          if (!result.ok) return textResult({ error: result.error, suggestion: result.suggestion })
          return textResult({
            ok: true,
            automation_id: automationId,
            status: step === 'delete' ? 'deleted' : step === 'pause' ? 'paused' : 'active',
          })
        }

        if (step !== 'create') {
          return textResult({ error: 'automation_action must be create, list, pause, resume or delete.' })
        }

        const accountId = String(params.account_id ?? '').trim()
        if (!accountId) {
          return textResult({
            error: 'account_id is required: list the connected accounts first to get one.',
          })
        }
        const splitList = (value: unknown) =>
          String(value ?? '')
            .split(',')
            .map((entry) => entry.trim())
            .filter(Boolean)
        const messages = splitList(params.messages).map((entry) => ({ text: entry }))
        const body: Record<string, unknown> = {
          accountId,
          name: String(params.name ?? '').trim() || 'Comment automation',
          kind: params.automation_kind ?? 'comment_dm',
          keywords: splitList(params.keywords),
        }
        if (typeof params.dm_message === 'string' && params.dm_message.trim()) {
          body.dmMessage = params.dm_message.trim()
        }
        if (typeof params.comment_reply === 'string' && params.comment_reply.trim()) {
          body.commentReply = params.comment_reply.trim()
        }
        if (messages.length) body.messages = messages

        const result = await socialInternalCall(ctx, 'POST', '/social/automations', body)
        if (!result.ok) return textResult({ error: result.error, suggestion: result.suggestion })
        return textResult({ created: true, ...result.data?.automation })
      }

      if (action === 'inbox' || action === 'reply' || action === 'comment_reply') {
        if (action === 'inbox') {
          const kind = params.kind === 'comments' ? 'comments' : 'dms'
          if (kind === 'comments') {
            const result = await socialInternalCall(ctx, 'GET', `/social/comments?limit=${limit}`)
            if (!result.ok) return textResult({ error: result.error, suggestion: result.suggestion })
            const comments = Array.isArray(result.data?.comments) ? result.data.comments : []
            return textResult({
              kind,
              count: comments.length,
              comments: comments.map((comment: any) => ({
                comment_id: comment.id,
                platform: comment.platform,
                author: comment.authorUsername ?? comment.authorName ?? null,
                text: comment.text,
                status: comment.status,
                occurred_at: comment.occurredAt,
                replied_at: comment.repliedAt,
              })),
            })
          }
          const unread = params.unread_only === true ? '&unread=true' : ''
          const result = await socialInternalCall(ctx, 'GET', `/social/inbox?limit=${limit}${unread}`)
          if (!result.ok) return textResult({ error: result.error, suggestion: result.suggestion })
          const conversations = Array.isArray(result.data?.conversations) ? result.data.conversations : []
          return textResult({
            kind,
            count: conversations.length,
            unread: result.data?.unread ?? 0,
            conversations: conversations.map((conversation: any) => ({
              conversation_id: conversation.id,
              platform: conversation.platform,
              participant: conversation.participantName ?? conversation.participantId ?? null,
              unread: conversation.unreadCount,
              last_message_at: conversation.lastMessageAt,
              preview: conversation.lastMessagePreview,
            })),
          })
        }

        const text = String(params.text ?? '').trim()
        if (!text) return textResult({ error: 'text is required to reply.' })
        if (action === 'reply') {
          const conversationId = String(params.conversation_id ?? '').trim()
          if (!conversationId) return textResult({ error: 'conversation_id is required for action "reply".' })
          const result = await socialInternalCall(
            ctx,
            'POST',
            `/social/inbox/conversations/${encodeURIComponent(conversationId)}/messages`,
            { text },
          )
          if (!result.ok) return textResult({ error: result.error, suggestion: result.suggestion })
          return textResult({ sent: true, ...result.data?.reply })
        }
        const commentId = String(params.comment_id ?? '').trim()
        if (!commentId) return textResult({ error: 'comment_id is required for action "comment_reply".' })
        const result = await socialInternalCall(
          ctx,
          'POST',
          `/social/comments/${encodeURIComponent(commentId)}/reply`,
          { text },
        )
        if (!result.ok) return textResult({ error: result.error, suggestion: result.suggestion })
        return textResult({ sent: true, ...result.data?.reply })
      }

      const platform = String(params.platform ?? '')
      if (!allowed.includes(platform as SocialPlatformName)) {
        return textResult({
          error: `Platform "${platform || 'unknown'}" is not enabled. Enabled platforms: ${allowed.join(', ') || 'none'}.`,
        })
      }
      if (action !== 'profile' && action !== 'recent_posts') {
        return textResult({
          error:
            'action must be profile, recent_posts, connect, accounts, post, posts, calendar, analytics, inbox, reply, comment_reply or automate.',
        })
      }
      const handle = String(params.handle ?? '').trim().replace(/^@+/, '')
      if (!handle) return textResult({ error: 'handle is required.' })

      const proxyUrl = process.env.TOOLS_PROXY_URL
      const proxyToken = process.env.AI_PROXY_TOKEN
      if (!proxyUrl || !proxyToken) {
        return textResult({
          error: 'Social media lookup is unavailable.',
          suggestion: 'Configure TOOLS_PROXY_URL and AI_PROXY_TOKEN.',
        })
      }

      const op = action === 'profile' ? 'profile' : 'posts'
      const cacheKey = webCacheKey('social', JSON.stringify({ platform, action, handle: handle.toLowerCase(), limit }))
      const cached = await webCacheGet<AgentToolResult<any>>(cacheKey)
      if (cached) return cached

      try {
        const response = await fetch(`${proxyUrl.replace(/\/$/, '')}/social/${platform}/${op}`, {
          method: 'POST',
          headers: {
            'x-api-key': proxyToken,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ handle, limit }),
          signal: AbortSignal.timeout(20_000),
        })
        const data = await response.json().catch(() => ({}))
        if (!response.ok) {
          return textResult({
            error: (data as any)?.error || `Social lookup failed: HTTP ${response.status}`,
            code: (data as any)?.code,
            platform,
            handle,
          })
        }
        const result = textResult(data)
        await webCachePut(cacheKey, result, SOCIAL_CACHE_TTL_SECONDS)
        return result
      } catch (err: any) {
        return textResult({ error: `Social lookup failed: ${err?.message ?? err}`, platform, handle })
      }
    },
  }
}

/** All gateway tools (unified set). Includes base tools + agent_* orchestration tools. */
export function createTools(ctx: ToolContext, extraTools?: AgentTool[]): AgentTool[] {
  const pe = ctx.permissionEngine
  const g = (tool: AgentTool, cat: import('./types').PermissionCategory) => applyPermissionGate(tool, cat, pe)
  // Inside the gate, so this runtime's permission rules also cover calls it
  // sends to another project.
  const r = (tool: AgentTool) => withRemoteProject(tool, ctx)

  const tools: AgentTool[] = [
    g(r(createExecTool(ctx)), 'shell'),
    g(r(createExecWaitTool(ctx)), 'shell'),
    g(r(createExecListTool(ctx)), 'shell'),
    createWaitTool(ctx),
    createTaskListTool(ctx),
    createTaskCancelTool(ctx),
    g(createGitHubPullRequestTool(ctx), 'network'),
    g(createGitHubMergePullRequestTool(ctx), 'network'),
    g(createGitHubConnectTool(ctx), 'network'),
    createExposePortTool(ctx),
    g(r(createReadFileTool(ctx)), 'file_read'),
    g(r(createWriteFileTool(ctx)), 'file_write'),
    g(r(createEditFileTool(ctx)), 'file_write'),
    g(r(createDeleteFileTool(ctx)), 'file_delete'),
    // search is disabled while local indexing is off (reindex-on-query hangs).
    // Re-enable with SHOGO_SEARCH_ENABLED=1 (also pre-warms the index — see gateway.ts start()).
    // isSearchEnabled() is the same gate every prompt/guide uses to decide
    // whether to advertise `search`, so the prompt surface matches registration.
    ...(isSearchEnabled() ? [g(r(createSearchTool(ctx)), 'file_read')] : []),
    g(createImpactRadiusTool(ctx), 'file_read'),
    g(createDetectChangesTool(ctx), 'file_read'),
    g(createReviewContextTool(ctx), 'file_read'),
    g(createWebTool(ctx), 'network'),
    g(createBrowserTool(ctx), 'network'),
    g(createSocialMediaTool(ctx), 'network'),
    createMemoryReadTool(ctx),
    createMemorySearchTool(ctx),
    createSearchHistoryTool(ctx),
    createReadHistoryTool(ctx),
    createTodoWriteTool(ctx),
    createAskUserTool(ctx),
    createCheckpointTool(ctx),
    createPublishTool(ctx),
    createShareFileTool(ctx),
    createSendMessageTool(ctx),
    createChannelConnectTool(ctx),
    createChannelDisconnectTool(ctx),
    createChannelListTool(ctx),
    createReadLintsTool(ctx),
    createServerSyncTool(ctx),
    createSearchIntegrationsTool(ctx),
    createConnectTool(ctx),
    createDisconnectTool(ctx),
    g(createGenerateImageTool(ctx), 'network'),
    ...createMediaTools(ctx).map((t) => g(t, 'network')),
    g(createTranscribeAudioTool(ctx), 'network'),
    createHeartbeatConfigureTool(ctx),
    createHeartbeatStatusTool(ctx),
    createCreatePlanTool(ctx),
    createUpdatePlanTool(ctx),
    createQuickActionTool(ctx),
    // terminal_exec drives the desktop app's visible terminal; it can only
    // work when the desktop bridge is wired (TERMINAL_EXEC_URL → ctx.terminalExec).
    ...(ctx.terminalExec ? [g(createTerminalExecTool(ctx), 'shell')] : []),
    createTerminalReadTool(ctx),
    createReadGuideTool(ctx),
  ]

  // Subagents and orchestration tools draw their parent tool set from here.
  // Filter out capability-disabled tools so a delegated subagent (media,
  // channel, integration, …) cannot reach a tool the project has
  // turned off — matching how the main agent's tool list is gated.
  const allToolsGetter = () => filterDisabledCapabilityTools(tools, ctx.config)
  tools.push(createSkillTool(ctx, allToolsGetter))

  // Agent orchestration tools
  tools.push(createAgentCreateTool(ctx))
  tools.push(createAgentSpawnTool(ctx, allToolsGetter))
  tools.push(createAgentStatusTool(ctx))
  tools.push(createAgentCancelTool(ctx))
  tools.push(createAgentResultTool(ctx))
  tools.push(createAgentListTool(ctx, allToolsGetter))

  // Team coordination tools
  tools.push(createTeamCreateTool(ctx))
  tools.push(createTeamDeleteTool(ctx))
  tools.push(createTeamTaskCreateTool(ctx))
  tools.push(createTeamTaskGetTool(ctx))
  tools.push(createTeamTaskListTool(ctx))
  tools.push(createTeamTaskUpdateTool(ctx))
  tools.push(createSendTeamMessageTool(ctx))

  // BETA: per-chat git worktrees — cross-chat awareness tool
  tools.push(createWorktreeListTool(ctx))

  // Hand work to another chat (any workspace the person can open).
  tools.push(createChatHandoffTool(ctx))

  // Project lifecycle: compose multi-project systems (project-tools.ts).
  // Creating/attaching/calling projects is a `project`-category mutation —
  // NOT `system` (that category is PermissionEngine's unconditional,
  // all-modes hard-block for OS-level actions; see types.ts's doc comment
  // on `PermissionCategory`).
  {
    const projectTools = createProjectTools(ctx)
    tools.push(...projectTools.readonly)
    for (const t of projectTools.mutating) tools.push(g(t, 'project'))
    tools.push(createConnectProjectTool(ctx))
    if (copyToProjectAvailable()) tools.push(g(createCopyToProjectTool(ctx), 'file_write'))
  }

  // Workspace runtimes expose universal profile/goal primitives. Project
  // runtimes omit them so the existing builder tool contract is unchanged.
  if (workspaceAgentToolsRegistered(ctx)) {
    tools.push(...createWorkspaceAgentTools(ctx))
    tools.push(...createTriggerTools(ctx))
    // Meetings are private to the personal workspace; the API rejects team workspaces.
    if (ctx.config.capabilityProfile === 'personal') tools.push(...createMeetingTools(ctx))
    else {
      tools.push(...createChannelTools(ctx))
      // A project-anchored runtime speaks as that project's agent, not the workspace agent.
      if (!process.env.WORKSPACE_ANCHOR_PROJECT_ID) tools.push(...createAgentRunTools(ctx))
      tools.push(...createBoardTools(ctx))
    }
  }

  if (process.env.WORKSPACE_RUNTIME === 'true') {
    tools.push(createListProjectsTool(ctx))
    // A project-anchored runtime serves project chats, which have no
    // workspace session to mount into; the API rejects every call.
    if (!process.env.WORKSPACE_ANCHOR_PROJECT_ID) {
      tools.push(createMountProjectTool(ctx))
      tools.push(createUnmountProjectTool(ctx))
    }
    tools.push(createPreviewProjectTool(ctx))
    // Reach-the-user boundary: the reminder-manage skill's notify path.
    // Workspace runtimes only (personal agents), same bridge as the meta tools.
    tools.push(createNotifyUserTool(ctx))
  }

  if (extraTools) {
    tools.push(...extraTools)
  }

  // Every tool honours its per-tool action rule (run, ask first, block), even
  // those without a permission category. In place, so the subagent tool
  // getter above sees the gated tools.
  if (pe) {
    for (let i = 0; i < tools.length; i++) tools[i] = withActionRules(tools[i], pe)
  }

  for (const tool of tools) {
    if (HIDDEN_LEGACY_TOOLS.has(tool.name)) markHiddenTool(tool)
  }

  return tools
}

/**
 * Superseded by `wait` / `task_list` / `task_cancel`. Still executable so old
 * transcripts and remote callers keep working, but never advertised to the model.
 */
export const HIDDEN_LEGACY_TOOLS: ReadonlySet<string> = new Set(['exec_wait', 'exec_list', 'agent_status', 'agent_result'])

/** Keep a tool executable but leave it out of the tool list sent to the model. */
export function markHiddenTool<T extends AgentTool>(tool: T): T {
  ;(tool as T & { hidden?: boolean }).hidden = true
  return tool
}

// ---------------------------------------------------------------------------
// Git Worktree Awareness Tool (BETA)
// ---------------------------------------------------------------------------

/**
 * Lets an agent see the worktrees/branches of sibling chats in the same
 * project so parallel agents can coordinate and anticipate merge conflicts.
 * Only useful (and registered) when the per-chat worktrees feature is on.
 */
function createWorktreeListTool(ctx: ToolContext): AgentTool {
  return {
    name: 'worktree_list',
    label: 'List Chat Worktrees',
    description:
      'List the git worktrees/branches of the other chats in this project (per-chat worktrees mode). ' +
      'Use this to understand what parallel agents are working on, which files they have touched, and how ' +
      'far ahead/behind the default branch each chat is — so you can avoid stepping on their changes and ' +
      'anticipate merge conflicts before merging back into main.',
    parameters: Type.Object({}),
    execute: async () => {
      if (!ctx.listWorktreeStatuses) {
        return textResult({
          error: 'Per-chat git worktrees are not enabled for this project.',
        })
      }
      try {
        const all = await ctx.listWorktreeStatuses()
        const current = ctx.sessionId
        const worktrees = all.map((w) => ({
          chatSessionId: w.chatSessionId,
          branch: w.branch,
          isCurrentChat: w.chatSessionId === current,
          commitsAheadOfMain: w.ahead,
          commitsBehindMain: w.behind,
          uncommittedFiles: w.dirtyFiles,
          changedFiles: w.changedFiles,
        }))
        return textResult({ count: worktrees.length, worktrees })
      } catch (err: any) {
        return textResult({
          error: `Failed to list worktrees: ${err?.message ?? err}`,
        })
      }
    },
  }
}

// ---------------------------------------------------------------------------
// Skill Tool (unified .shogo/skills/ format)
// ---------------------------------------------------------------------------

import type { Skill } from './skills'

let loadedSkillsList: Skill[] | null = null

export function setLoadedSkills(skills: Skill[]): void {
  loadedSkillsList = skills
}

export function getLoadedSkills(): Skill[] {
  return loadedSkillsList || []
}

/** @deprecated Use setLoadedSkills instead */
export function setLoadedClaudeSkills(skills: Skill[]): void {
  setLoadedSkills(skills)
}

/** @deprecated Use getLoadedSkills instead */
export function getLoadedClaudeSkills(): Skill[] {
  return getLoadedSkills()
}

/** @deprecated Use Skill from ./skills instead */
export type LoadedSkillEntry = Skill

function inferRuntime(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase()
  const map: Record<string, string> = {
    py: 'python3',
    js: 'node',
    ts: 'bun',
    mjs: 'node',
    cjs: 'node',
    sh: 'bash',
  }
  return map[ext || ''] || 'bash'
}

/**
 * If the requested skill name matches an installed managed-integration
 * toolkit (e.g. user typed `skill: invoke` with skill="jira" after
 * `connect("jira")`), return a remediation hint pointing them at
 * the bound tools. Otherwise return null so the caller falls back to
 * the generic "Skill not found" message.
 *
 * Composio proxy tools follow a `<TOOLKIT>_<ACTION>` uppercase naming
 * convention (JIRA_LIST_BOARDS, GMAIL_SEND_EMAIL, etc.).
 */
function getIntegrationOverlapHint(skillName: string, allTools: AgentTool[]): string | null {
  const prefix = `${skillName.toUpperCase().replace(/[^A-Z0-9]/g, '')}_`
  const matches = allTools.map((t) => t.name).filter((n) => n.startsWith(prefix))
  if (matches.length === 0) return null
  const sample = matches.slice(0, 3).join(', ')
  const more = matches.length > 3 ? `, ...` : ''
  return `Note: "${skillName}" is a managed integration, not a skill. Its tools (${sample}${more}) are already bound to you — call them directly by name (e.g. \`${matches[0]}({})\`).`
}

function createSkillTool(ctx: ToolContext, allToolsGetter: () => AgentTool[]): AgentTool {
  return {
    name: 'skill',
    description:
      'Installed skills in this workspace, and how to use them. The "## Available Skills" section of your instructions lists skills installed here — call skill({ action: "invoke", skill: "<name>" }) to load one and follow its instructions. Actions: invoke (default), search (installed skills first, then the external registry), install, run_script. A skill is instructions you invoke, not an integration tool. See read_guide("skill-matching") for details.',
    label: 'Skill',
    parameters: Type.Object({
      action: Type.Optional(
        Type.String({
          description: 'Action: "invoke" (default), "search", "install", or "run_script"',
        }),
      ),
      skill: Type.Optional(
        Type.String({
          description: 'Skill name (for invoke/run_script action)',
        }),
      ),
      args: Type.Optional(
        Type.String({
          description: 'Arguments to pass to the skill or script',
        }),
      ),
      script: Type.Optional(
        Type.String({
          description: 'Script filename to execute (for run_script action, e.g. "score.py")',
        }),
      ),
      query: Type.Optional(Type.String({ description: 'Search query (for search action)' })),
      source: Type.Optional(
        Type.String({
          description: 'Source id (for install action, from search results)',
        }),
      ),
      dir_name: Type.Optional(
        Type.String({
          description: 'Directory name (for install action, from search results)',
        }),
      ),
    }),
    execute: async (_toolCallId, params, context) => {
      const {
        action = 'invoke',
        skill: skillName,
        args,
        script,
        query,
        source,
        dir_name: dirName,
      } = params as {
        action?: string
        skill?: string
        args?: string
        script?: string
        query?: string
        source?: string
        dir_name?: string
      }

      // --- Search: installed skills first, then bundled and registry skills ---
      if (action === 'search') {
        const { loadSkillRegistryManifest, loadBundledSkills, searchSkills } =
          require('./skills') as typeof import('./skills')
        const LIMIT = 20
        const installed = getLoadedSkills()
        const manifest = loadSkillRegistryManifest()

        const installedRow = (skill: Skill) => ({
          name: skill.name,
          description: skill.description,
          installed: true,
          source: 'installed',
          // Present but not callable by the model: list it, do not advertise invoke.
          action: skill.disableModelInvocation ? undefined : 'invoke',
          ...(skill.trigger ? { trigger: skill.trigger } : {}),
          ...(skill.disableModelInvocation
            ? { note: 'disable-model-invocation: not invocable by the model — read it directly with read_file or run_script' }
            : {}),
        })

        const registryRow = (entry: { name: string; description: string; source: string; sourceDescription: string; dirName: string }) => ({
          name: entry.name,
          description: entry.description,
          installed: false,
          source: entry.source,
          sourceType: 'registry',
          sourceDescription: entry.sourceDescription,
          dir_name: entry.dirName,
          dirName: entry.dirName,
          action: 'install',
        })

        const bundledRow = (skill: Skill) => ({
          name: skill.name,
          description: skill.description,
          installed: false,
          source: 'bundled',
          sourceType: 'bundled',
          action: 'install',
          installWith: `connect({ name: "skill:${skill.name}" })`,
        })

        if (!query) {
          if (installed.length > 0) {
            return textResult({
              total: installed.length,
              results: installed.slice(0, LIMIT).map(installedRow),
              message:
                installed.length > LIMIT
                  ? `${installed.length} installed skills in this workspace; showing ${LIMIT}. Call skill({ action: "invoke", skill: "<name>" }) to use one, or provide a query to filter.`
                  : `${installed.length} installed skills in this workspace. Call skill({ action: "invoke", skill: "<name>" }) to use one, or provide a query to filter.`,
            })
          }
          if (manifest.length === 0) {
            return textResult({
              results: [],
              message: 'No external skills available in the registry.',
            })
          }
          return textResult({
            total: manifest.length,
            results: manifest.slice(0, LIMIT).map(registryRow),
            message: `${manifest.length} skills available. Provide a query to filter.`,
          })
        }

        const q = query.toLowerCase()
        const registryMatches = manifest.filter(
          (s) =>
            s.name.toLowerCase().includes(q) ||
            s.description.toLowerCase().includes(q) ||
            s.source.toLowerCase().includes(q) ||
            s.sourceDescription.toLowerCase().includes(q),
        )

        // Nothing installed to search: the registry is all there is, so keep
        // answering exactly as before rather than claiming a search we did not do.
        if (installed.length === 0) {
          if (manifest.length === 0) {
            return textResult({
              results: [],
              message: 'No external skills available in the registry.',
            })
          }
          return textResult({
            query,
            total: registryMatches.length,
            results: registryMatches.slice(0, LIMIT).map(registryRow),
            message: registryMatches.length > LIMIT ? `Showing ${LIMIT} of ${registryMatches.length} matches. Refine your query.` : undefined,
          })
        }

        const bundled = loadBundledSkills(new Set(installed.map((s) => s.name)))
        const installedHits = searchSkills(query, installed, [], LIMIT)
        const bundledHits = searchSkills(query, [], bundled, LIMIT)
        const seen = new Set([...installedHits, ...bundledHits].map((s) => s.name))
        const registryRows = registryMatches.filter((s) => !seen.has(s.name)).map(registryRow)

        const rows = [...installedHits.map(installedRow), ...bundledHits.map(bundledRow), ...registryRows]
        const total = rows.length

        const message =
          total === 0
            ? `${installed.length} installed skills searched; nothing matched "${query}". Call skill({ action: "search" }) with no query to list them, or refine the query.`
            : total > LIMIT
              ? `${installed.length} installed skills; ${total} matches. Showing ${LIMIT} of ${total}. Refine your query.`
              : `${installed.length} installed skills; ${total} match${total === 1 ? '' : 'es'}.`

        return textResult({
          query,
          total,
          installedSearched: installed.length,
          results: rows.slice(0, LIMIT),
          message,
        })
      }

      // --- Install: install a registry skill into the workspace ---
      if (action === 'install') {
        if (!source || !dirName) {
          return textResult({
            error: 'source and dir_name are required (from search results).',
          })
        }

        const { loadBundledClaudeCodeSkill } = require('./skills') as typeof import('./skills')
        const skill = loadBundledClaudeCodeSkill(source, dirName)
        if (!skill) {
          return textResult({
            error: `Skill "${dirName}" not found in source "${source}".`,
          })
        }

        const destDir = join(ctx.workspaceDir, '.shogo', 'skills', skill.name)
        mkdirSync(destDir, { recursive: true })
        const srcDir = skill.skillDir
        for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
          const srcPath = join(srcDir, entry.name)
          const destPath = join(destDir, entry.name)
          if (entry.isDirectory()) {
            const { cpSync } = require('fs')
            cpSync(srcPath, destPath, { recursive: true })
          } else {
            writeFileSync(destPath, readFileSync(srcPath))
          }
        }

        return textResult({
          installed: skill.name,
          source,
          description: skill.description,
          message: `Skill "${skill.name}" installed. Use skill({ skill: "${skill.name}" }) to invoke it.`,
        })
      }

      // --- Run Script: execute a script from a skill's scripts/ directory ---
      if (action === 'run_script') {
        if (!skillName || !script) {
          return textResult({
            error: 'skill and script parameters are required for run_script action.',
          })
        }

        if (script.includes('..') || script.includes('/')) {
          return textResult({ error: 'Invalid script filename.' })
        }

        const skills = getLoadedSkills()
        const found = skills.find((s) => s.name === skillName)
        if (!found) {
          const overlapHint = getIntegrationOverlapHint(skillName, allToolsGetter())
          const baseMsg = `Skill not found: ${skillName}`
          return textResult({
            error: overlapHint ? `${baseMsg}. ${overlapHint}` : baseMsg,
          })
        }

        const scriptPath = join(found.skillDir, 'scripts', script)
        if (!existsSync(scriptPath)) {
          return textResult({
            error: `Script "${script}" not found in skill "${skillName}".`,
            available: found.scripts || [],
          })
        }

        const runtime = found.runtime || inferRuntime(script)
        const command = args ? `${runtime} ${scriptPath} ${args}` : `${runtime} ${scriptPath}`

        try {
          const { sandboxExec } = require('./sandbox-exec') as typeof import('./sandbox-exec')
          const result = sandboxExec({
            command,
            workspaceDir: ctx.workspaceDir,
            timeout: 30000,
            sandboxConfig: ctx.sandbox,
            sessionId: ctx.sessionId,
            mainSessionIds: ctx.mainSessionIds,
          })

          const clip = (s: string | undefined, max: number): string => {
            const v = s || ''
            if (v.length <= max) return v
            // Signpost the cut instead of silently dropping the tail.
            return `${v.substring(0, max)}\n... [${v.length - max} chars truncated — re-run filtering output (head/tail/grep) to see the rest]`
          }
          return textResult({
            skill: skillName,
            script,
            runtime,
            exitCode: result.exitCode,
            stdout: clip(result.stdout, 8000),
            stderr: clip(result.stderr, 4000),
          })
        } catch (err: any) {
          return textResult({
            error: `Script execution failed: ${err.message}`,
          })
        }
      }

      // --- Invoke (default): run a skill by name ---
      if (!skillName) {
        return textResult({
          error: 'skill name is required for invoke action.',
        })
      }

      const skills = getLoadedSkills()
      const found = skills.find((s) => s.name === skillName)
      if (!found) {
        const overlapHint = getIntegrationOverlapHint(skillName, allToolsGetter())
        const baseError = `Skill not found: ${skillName}. Available: ${skills.map((s) => s.name).join(', ')}`
        return textResult({
          error: overlapHint ? `${baseError}\n\n${overlapHint}` : baseError,
          hint: overlapHint
            ? 'Call the integration tool directly by name (do not use `skill` or `agent_spawn({type:"integration"})`).'
            : 'Use skill({ action: "search", query: "..." }) to find an installed skill (it searches the skills installed in this workspace first), or to find a new one to install.',
        })
      }

      // Run setup on first invoke if configured
      if (found.setup && !existsSync(join(found.skillDir, '.setup-done'))) {
        try {
          const { sandboxExec } = require('./sandbox-exec') as typeof import('./sandbox-exec')
          const setupResult = sandboxExec({
            command: found.setup,
            workspaceDir: found.skillDir,
            timeout: 60000,
            sandboxConfig: ctx.sandbox,
            sessionId: ctx.sessionId,
            mainSessionIds: ctx.mainSessionIds,
          })
          if (setupResult.exitCode === 0) {
            writeFileSync(join(found.skillDir, '.setup-done'), new Date().toISOString(), 'utf-8')
          }
        } catch {
          /* setup is best-effort */
        }
      }

      let content = found.content

      // $ARGUMENTS substitution
      if (args) {
        const argParts = args.split(/\s+/)
        content = content.replace(/\$ARGUMENTS\[(\d+)\]/g, (_, idx) => argParts[parseInt(idx)] || '')
        content = content.replace(/\$(\d+)/g, (_, idx) => argParts[parseInt(idx)] || '')
        content = content.replace(/\$ARGUMENTS/g, args)
      } else {
        content = content.replace(/\$ARGUMENTS\[\d+\]/g, '')
        content = content.replace(/\$\d+/g, '')
        content = content.replace(/\$ARGUMENTS/g, '')
      }

      // ${CLAUDE_SKILL_DIR} and ${SKILL_DIR} substitution
      content = content.replace(/\$\{CLAUDE_SKILL_DIR\}/g, found.skillDir)
      content = content.replace(/\$\{SKILL_DIR\}/g, found.skillDir)

      // If context: fork, run in a subagent
      if (found.context === 'fork') {
        const agentType = found.agent || 'general-purpose'
        const subConfig: SubagentConfig = {
          name: `skill-${skillName}`,
          description: `Executing skill: ${found.description}`,
          systemPrompt: content,
          model: undefined,
          disallowedTools: ['task'],
        }

        const builtIn = getBuiltinSubagentConfig(agentType, ctx, allToolsGetter())
        if (builtIn) {
          subConfig.toolNames = builtIn.toolNames
          subConfig.model = builtIn.model
        }

        const result = await runSubagent(subConfig, content, ctx, allToolsGetter())
        return textResult({
          skill: skillName,
          mode: 'fork',
          agent: agentType,
          toolCalls: result.toolCalls,
          iterations: result.iterations,
        })
      }

      // Inline mode: return content for the agent to use as context
      return textResult({
        skill: skillName,
        mode: 'inline',
        content,
        instruction: 'Follow the skill instructions above to complete the task.',
      })
    },
  }
}

// ---------------------------------------------------------------------------
// Tool Group Mapping
// ---------------------------------------------------------------------------

/**
 * Maps group names (used in skill frontmatter) to individual gateway tool names.
 * Skills can reference either group names or individual tool names.
 */
/**
 * Tools the agent MUST be able to call in agent (edit) mode. The filesystem
 * trio is unconditional; `exec` is core only when the shell capability is on
 * (untrusted/restricted workspaces legitimately disable it). Used both to
 * defensively re-add core tools if a registration/MCP-merge race ever drops
 * them (the WS7 prod signature: `exec`/`edit_file`/`write_file` reported
 * "not found" in agent mode) and as the contract the WS7 eval asserts.
 */
export function expectedCoreToolsForAgentMode(config: import('./gateway').GatewayConfig): string[] {
  const core = ['read_file', 'write_file', 'edit_file']
  if (config.shellEnabled !== false) core.push('exec')
  return core
}

export type RestrictedMode = 'coordinator'

/**
 * Build a dispatch-only stub for a tool that exists normally but was filtered
 * out by coordinator mode. The agent loop resolves tools by name via
 * `tools.find()`; without a stub a hallucinated call to a filtered tool
 * surfaces an opaque "Tool X not found". This returns a coordinator-specific
 * error instead so the model self-corrects (delegate) rather than looping.
 * Stubs are NOT advertised (kept out of the iterated/mapped tool list), so they
 * don't reintroduce the tool coordinator mode intentionally hides.
 */
export function createModeUnavailableTool(name: string, mode: RestrictedMode): AgentTool {
  return {
    name,
    description: `(${name} is unavailable in coordinator mode)`,
    label: name,
    parameters: Type.Object({}, { additionalProperties: true }),
    execute: async () =>
      textResult({
        error: `The "${name}" tool is not available in coordinator mode. This coordinator session is read-only — delegate the action to a worker agent instead of calling the tool directly.`,
        toolUnavailableInMode: mode,
      }),
  }
}

/**
 * Feature-flag tool groups (web/shell/heartbeat/messaging/integrations
 * toggles in `filterDisabledCapabilityTools` below). Every name here must
 * stay a subset of `ALL_TOOL_NAMES` (skills may reference these names/groups
 * as tool dependencies — see `resolveToolNames` and `skills.ts`).
 *
 * This is deliberately NOT the same map as capability-profiles.ts's
 * `PROFILE_TOOL_GROUPS`, which also covers privileged/internal tools
 * (`checkpoint`, `agent_spawn`, `system_apply`, ...) that must NOT be
 * individually resolvable via a skill's declared tool list.
 */
export const TOOL_GROUP_MAP: Record<string, string[]> = {
  shell: ['exec', 'exec_wait', 'wait', 'task_list', 'task_cancel', 'terminal_exec', 'terminal_read'],
  filesystem: ['read_file', 'write_file', 'edit_file', 'read_lints'],
  files: ['delete_file', 'search', 'read_file', 'write_file', 'edit_file', 'read_lints', 'share_file'],
  search: ['search', 'impact_radius'],
  code_analysis: ['impact_radius'],
  planning: ['todo_write'],
  web: ['web'],
  web_fetch: ['web'],
  web_search: ['web'],
  browser: ['browser', 'web'],
  social: ['social_media'],
  memory: ['memory_read', 'memory_search'],
  messaging: ['send_message', 'channel_connect', 'channel_disconnect', 'channel_list'],
  heartbeat: ['heartbeat_configure', 'heartbeat_status'],
  integrations: ['search_integrations', 'connect', 'disconnect'],
  audio: ['transcribe_audio'],
}

/**
 * Tools behind the work capabilities. Kept out of `TOOL_GROUP_MAP` so a
 * skill's declared tool list cannot pull them in by group name.
 */
export const WORK_TOOL_GROUPS = {
  team_chat: [...CHANNEL_TOOL_NAMES],
  boards: [...BOARD_TOOL_NAMES],
  board_admin: [...BOARD_ADMIN_TOOL_NAMES],
  triggers: ['trigger_create', 'trigger_update', 'trigger_delete', 'trigger_test'],
  problems: [...PROBLEM_TOOL_NAMES],
} as const

export const ALL_TOOL_NAMES = [
  'exec',
  'exec_wait',
  'wait',
  'task_list',
  'task_cancel',
  'read_file',
  'write_file',
  'edit_file',
  'web',
  'browser',
  'social_media',
  'delete_file',
  'search',
  'impact_radius',
  'detect_changes',
  'review_context',
  'todo_write',
  'ask_user',
  'skill',
  'memory_read',
  'memory_search',
  'send_message',
  'notify_user',
  'channel_connect',
  'channel_disconnect',
  'channel_list',
  'heartbeat_configure',
  'heartbeat_status',
  'terminal_exec',
  'terminal_read',
  'read_lints',
  'server_sync',
  'search_integrations',
  'connect',
  'disconnect',
  'github_create_pr',
  'github_merge_pr',
  'github_connect',
  'share_file',
  'transcribe_audio',
  'quick_action',
] as const

/**
 * Resolve a list of tool references (group names or individual names)
 * to a deduplicated list of individual gateway tool names.
 */
export function resolveToolNames(refs: string[]): string[] {
  const resolved = new Set<string>()
  for (const ref of refs) {
    const group = TOOL_GROUP_MAP[ref]
    if (group) {
      for (const name of group) resolved.add(name)
    } else if ((ALL_TOOL_NAMES as readonly string[]).includes(ref)) {
      resolved.add(ref)
    } else if (ref.startsWith('mcp_')) {
      resolved.add(ref)
    }
  }
  return [...resolved]
}

/**
 * Remove tools whose owning capability is disabled in `config`.
 *
 * This is the single source of truth for capability-based tool gating. It is
 * applied to BOTH the main agent's tool list AND the parent tool set handed to
 * subagents (via `allToolsGetter`), so a disabled capability — image
 * generation, heartbeat, channels, managed integrations, etc. — is truly
 * unreachable rather than merely dropped from the main agent's prompt. Without
 * this, a delegated subagent (media / channel / integration) would
 * still receive the tool because subagents draw from the unfiltered set.
 *
 * Capability flags default to enabled, so only an explicit `=== false`
 * disables a tool group. `gitWorktreesEnabled` and `socialMediaEnabled`
 * are the exceptions: they are opt-in, and the social tool is also hidden
 * when every platform under it is off.
 */
export function filterDisabledCapabilityTools(tools: AgentTool[], config: import('./gateway').GatewayConfig): AgentTool[] {
  const disabled = new Set<string>()
  if (config.capabilityProfile === 'personal') {
    for (const name of disabledToolNamesForProfile('personal')) disabled.add(name)
  }
  if (isWorkspaceAgentRuntime()) for (const n of PROFILE_TOOL_GROUPS.orchestration) disabled.add(n)
  if (config.webEnabled === false) for (const n of TOOL_GROUP_MAP.web) disabled.add(n)
  if (config.browserEnabled === false) disabled.add('browser')
  if (config.shellEnabled === false) for (const n of TOOL_GROUP_MAP.shell) disabled.add(n)
  if (config.heartbeatToolsEnabled === false) for (const n of TOOL_GROUP_MAP.heartbeat) disabled.add(n)
  if (config.imageGenEnabled === false) for (const n of IMAGE_TOOL_NAMES) disabled.add(n)
  if (config.videoGenEnabled !== true) disabled.add('generate_video')
  if (config.musicGenEnabled !== true) for (const n of MUSIC_TOOL_NAMES) disabled.add(n)
  if (config.threeDGenEnabled !== true) for (const n of THREE_D_TOOL_NAMES) disabled.add(n)
  // The listing stays available while ANY generation capability is on, so a
  // 3D-only (or video-only) project can still price a model before spending.
  const anyGenerationOn =
    config.imageGenEnabled !== false ||
    config.videoGenEnabled === true ||
    config.musicGenEnabled === true ||
    config.threeDGenEnabled === true
  if (!anyGenerationOn) disabled.add('list_media_models')
  if (config.quickActionsEnabled === false) disabled.add('quick_action')
  if (config.channelsEnabled === false) for (const n of TOOL_GROUP_MAP.messaging) disabled.add(n)
  if (config.integrationsEnabled === false) for (const n of TOOL_GROUP_MAP.integrations) disabled.add(n)
  const work = resolveRuntimeCapabilities(config as unknown as Record<string, unknown>)
  if (!work.teamChatEnabled) for (const n of WORK_TOOL_GROUPS.team_chat) disabled.add(n)
  if (!work.boardsEnabled) for (const n of [...WORK_TOOL_GROUPS.boards, ...WORK_TOOL_GROUPS.board_admin, ...WORK_TOOL_GROUPS.problems]) disabled.add(n)
  if (!work.boardAdminEnabled) for (const n of WORK_TOOL_GROUPS.board_admin) disabled.add(n)
  if (!work.workTriggersEnabled) for (const n of WORK_TOOL_GROUPS.triggers) disabled.add(n)
  if (!work.problemsEnabled) for (const n of WORK_TOOL_GROUPS.problems) disabled.add(n)
  // BETA: worktree awareness tool only exists when per-chat worktrees are on (off by default).
  if (config.gitWorktreesEnabled !== true) disabled.add('worktree_list')
  // Social lookups are opt-in, and a platform that is off must not be callable.
  // Management is a separate opt-in, so the tool survives on either — but a
  // workspace with lookups on and every platform off has nothing to look up.
  const lookupsUsable = enabledSocialPlatforms(config).length > 0
  if (!lookupsUsable && config.socialManagementEnabled !== true) disabled.add('social_media')

  const memoryOff = config.memoryEnabled === false
  if (disabled.size === 0 && !memoryOff) return tools
  const kept = tools.filter((t) => {
    if (disabled.has(t.name)) return false
    if (memoryOff && t.name.startsWith('memory_')) return false
    return true
  })
  return kept.length === tools.length ? tools : kept
}

/**
 * Tools delegated to dedicated subagents — removed from the main agent's tool
 * list to reduce per-request token cost. The main agent is expected to reach
 * them via `agent_spawn({ type: "browser", ... })`.
 *
 * `server_sync` is deliberately NOT here (SHO-184): it repairs the agent's own
 * project server, so it must be callable directly on every profile — personal
 * workspaces and the workspace agent have no subagents to delegate to.
 *
 * Media tools are deliberately NOT here: the project's own agent calls
 * `generate_image` and friends directly. Their gate is the capability itself
 * (`imageGenEnabled` / `videoGenEnabled` / `threeDGenEnabled`), applied by
 * `filterDisabledCapabilityTools` above.
 */
export const SUBAGENT_ONLY_TOOLS = new Set([
  'browser', // -> browser subagent
])

/**
 * No subagents or teams: personal workspaces, and the workspace agent, which
 * hands work to projects (`project_call`) instead of spawning agents.
 */
export function subagentOrchestrationDisabled(
  config: Pick<import('./gateway').GatewayConfig, 'capabilityProfile'>,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return config.capabilityProfile === 'personal' || isWorkspaceAgentRuntime(env)
}

/**
 * Remove `SUBAGENT_ONLY_TOOLS` from the main agent's tool list. Today that is
 * `browser` only, on every profile — including personal
 * workspaces and the workspace agent, which have no subagents to delegate to.
 *
 * Media tools are intentionally not part of the set: the main agent calls
 * them directly, and `filterDisabledCapabilityTools` is what removes them
 * when their capability is off. The `config` parameter is kept because the
 * filtering chokepoint is shared with the profile logic above and callers
 * should not have to change if a future tool needs a profile carve-out.
 */
export function filterSubagentOnlyTools(tools: AgentTool[], _config: import('./gateway').GatewayConfig): AgentTool[] {
  return tools.filter((t) => !SUBAGENT_ONLY_TOOLS.has(t.name))
}

// ---------------------------------------------------------------------------
// File Management Tools (files/ directory with RAG search)
// ---------------------------------------------------------------------------

function getOrCreateIndex(ctx: ToolContext): IndexEngine {
  if (!ctx.indexEngine) {
    ctx.indexEngine = new IndexEngine(createDefaultConfig(ctx.workspaceDir))
  }
  return ctx.indexEngine
}

function createDeleteFileTool(ctx: ToolContext): AgentTool {
  return {
    name: 'delete_file',
    description: 'Delete a file from the workspace files/ directory.',
    label: 'Delete File',
    parameters: Type.Object({
      path: Type.String({ description: 'File path relative to files/' }),
    }),
    execute: async (_toolCallId, params) => {
      const { path: filePath } = params as { path: string }
      const filesDir = join(ctx.workspaceDir, 'files')
      const resolved = resolve(filesDir, filePath)

      if (!resolved.startsWith(resolve(filesDir))) {
        return textResult({ error: 'Path outside files directory' })
      }
      const protectedRejection = rejectIfProtected(ctx, resolved)
      if (protectedRejection) return protectedRejection
      if (!existsSync(resolved)) {
        const hint = bogusPathPrefixHint(ctx.workspaceDir, filePath)
        return textResult({
          error: hint ? `File not found: ${filePath}\n${hint}` : `File not found: ${filePath}`,
        })
      }

      unlinkSync(resolved)
      ctx.fileStateCache?.invalidate(filePath)
      ctx.fileStateCache?.invalidate(`files/${filePath}`)
      ctx.canvasFileWatcher?.onFileDeleted(filePath)
      return textResult({ ok: true, deleted: filePath })
    },
  }
}

const SEARCH_TIMEOUT_MS = 10_000

function createSearchTool(ctx: ToolContext): AgentTool {
  return {
    name: 'search',
    description:
      'Semantic search across the workspace by meaning. Searches code and uploaded files. Returns ranked chunks with file paths and line numbers. Use source="code" for code only, source="files" for uploaded files only.',
    label: 'Search',
    parameters: Type.Object({
      query: Type.String({ description: 'Natural language search query' }),
      source: Type.Optional(
        Type.Union([Type.Literal('all'), Type.Literal('code'), Type.Literal('files')], {
          description: 'Which index to search: "all" (default), "code", or "files"',
        }),
      ),
      limit: Type.Optional(Type.Number({ description: 'Max results (default: 10)' })),
      path_filter: Type.Optional(
        Type.String({
          description: 'Restrict to files matching this substring (e.g. "test", "src/rules", "files/")',
        }),
      ),
      file_extensions: Type.Optional(
        Type.Array(Type.String(), {
          description: 'Restrict to these extensions (e.g. [".py", ".ts", ".csv"])',
        }),
      ),
    }),
    execute: async (_toolCallId, params) => {
      const {
        query,
        source,
        limit = 10,
        path_filter,
        file_extensions,
      } = params as {
        query: string
        source?: 'all' | 'code' | 'files'
        limit?: number
        path_filter?: string
        file_extensions?: string[]
      }
      const engine = getOrCreateIndex(ctx)
      const searchSource = source === 'all' || !source ? undefined : source
      // The first query triggers a lazy full reindex (see IndexEngine.search),
      // which on a large/cold workspace can run for minutes. Cap it so the tool
      // fails fast with a clear message instead of hanging the turn.
      let results: Awaited<ReturnType<typeof engine.search>>
      try {
        results = await Promise.race([
          engine.search(query, {
            source: searchSource,
            limit,
            pathFilter: path_filter,
            extensions: file_extensions,
          }),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error('SEARCH_TIMEOUT')), SEARCH_TIMEOUT_MS)),
        ])
      } catch (err) {
        if (err instanceof Error && err.message === 'SEARCH_TIMEOUT') {
          return textResult({
            error: `Search timed out after ${SEARCH_TIMEOUT_MS / 1000}s. The workspace index may be cold or still building — try again shortly or narrow the query with path_filter/file_extensions.`,
            query,
            source: source ?? 'all',
          })
        }
        throw err
      }
      return textResult({
        query,
        source: source ?? 'all',
        results: results.map((r) => ({
          path: r.path,
          chunk: r.chunk,
          score: Math.round(r.score * 1000) / 1000,
          lines: `${r.lineStart}-${r.lineEnd}`,
          matchType: r.matchType,
        })),
        count: results.length,
        stats: engine.getStats(searchSource),
      })
    },
  }
}

// ---------------------------------------------------------------------------
// Impact Radius Tool (knowledge graph blast-radius analysis)
// ---------------------------------------------------------------------------

async function getOrCreateGraph(ctx: ToolContext): Promise<import('./workspace-graph').WorkspaceGraph | null> {
  if (ctx.workspaceGraph) return ctx.workspaceGraph

  try {
    const engine = getOrCreateIndex(ctx)
    const { WorkspaceGraph } = require('./workspace-graph')
    const { createDefaultExtractors } = require('./graph-extractors')
    const graph = new WorkspaceGraph(engine)
    for (const ext of createDefaultExtractors()) graph.registerExtractor(ext)
    await graph.buildGraph()
    engine.setGraph(graph)
    ctx.workspaceGraph = graph
    return graph
  } catch {
    return null
  }
}

function createImpactRadiusTool(ctx: ToolContext): AgentTool {
  return {
    name: 'impact_radius',
    description:
      'Find all files and symbols affected by changes to given files. Shows blast radius: callers, dependents, importers, and related documents. Useful before making changes to understand what else might break or need updating.',
    label: 'Impact Radius',
    parameters: Type.Object({
      files: Type.Array(Type.String(), {
        description: 'File paths to check (relative to workspace root)',
      }),
      max_depth: Type.Optional(Type.Number({ description: 'BFS traversal depth (default: 2)' })),
    }),
    execute: async (_toolCallId, params) => {
      const { files, max_depth = 2 } = params as {
        files: string[]
        max_depth?: number
      }

      const graph = await getOrCreateGraph(ctx)
      if (!graph) {
        return textResult({
          error: 'Knowledge graph not available. The workspace graph could not be initialized.',
        })
      }

      const result = graph.getImpactRadius(files, max_depth)

      return textResult({
        analyzed_files: files,
        depth: max_depth,
        changed_nodes: result.changedNodes.map((n) => ({
          kind: n.kind,
          name: n.name,
          file: n.filePath,
        })),
        impacted_files: result.impactedFiles,
        impacted_nodes: result.impactedNodes.slice(0, 50).map((n) => ({
          kind: n.kind,
          name: n.name,
          file: n.filePath,
        })),
        edges: result.edges.slice(0, 100).map((e) => ({
          kind: e.kind,
          from: e.sourceQualified.split('::').pop(),
          to: e.targetQualified.split('::').pop(),
        })),
        total_impacted: result.totalImpacted,
        truncated: result.truncated,
        graph_stats: graph.getStats(),
      })
    },
  }
}

// ---------------------------------------------------------------------------
// Detect Changes Tool
// ---------------------------------------------------------------------------

function createDetectChangesTool(ctx: ToolContext): AgentTool {
  return {
    name: 'detect_changes',
    description:
      'Analyze git changes and map them to code graph nodes. Shows which functions/classes changed, their risk scores, affected execution flows, and test gaps. Use before code review to understand change impact.',
    label: 'Detect Changes',
    parameters: Type.Object({
      base: Type.Optional(
        Type.String({
          description: 'Git ref to diff against (default: "HEAD~1")',
        }),
      ),
      changed_files: Type.Optional(
        Type.Array(Type.String(), {
          description: 'Explicit file list (skips git diff if provided)',
        }),
      ),
      include_source: Type.Optional(
        Type.Boolean({
          description: 'Include source snippets for changed nodes (default: false)',
        }),
      ),
    }),
    execute: async (_toolCallId, params) => {
      const {
        base = 'HEAD~1',
        changed_files,
        include_source = false,
      } = params as {
        base?: string
        changed_files?: string[]
        include_source?: boolean
      }

      const graph = await getOrCreateGraph(ctx)
      if (!graph) {
        return textResult({ error: 'Knowledge graph not available.' })
      }

      const { execSync } = require('@shogo/shared-runtime/child-process')
      const { readFileSync } = require('fs')
      const cwd = ctx.workspaceDir

      let changedFilePaths: string[]
      if (changed_files && changed_files.length > 0) {
        changedFilePaths = changed_files
      } else {
        try {
          const out = execSync(`git diff --name-only ${base}`, {
            cwd,
            encoding: 'utf-8',
          }).trim()
          changedFilePaths = out ? out.split('\n').filter(Boolean) : []
        } catch {
          return textResult({
            error: `Failed to run git diff against ${base}. Is this a git repo?`,
          })
        }
      }

      if (changedFilePaths.length === 0) {
        return textResult({
          summary: 'No changes detected',
          changed_files: [],
          risk_score: 0,
        })
      }

      // Parse line ranges from unified diff
      let lineRanges: Map<string, Array<{ start: number; end: number }>> = new Map()
      try {
        const diffOut = execSync(`git diff --unified=0 ${base}`, {
          cwd,
          encoding: 'utf-8',
        })
        let currentFile = ''
        for (const line of diffOut.split('\n')) {
          if (line.startsWith('+++ b/')) {
            currentFile = line.slice(6)
          } else if (line.startsWith('@@')) {
            const match = line.match(/@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/)
            if (match && currentFile) {
              const start = parseInt(match[1], 10)
              const count = parseInt(match[2] || '1', 10)
              if (!lineRanges.has(currentFile)) lineRanges.set(currentFile, [])
              lineRanges.get(currentFile)!.push({ start, end: start + count - 1 })
            }
          }
        }
      } catch {
        /* non-fatal */
      }

      // Map line ranges to graph nodes
      const changedFunctions: any[] = []
      const { computeRiskScore } = require('./risk-scorer')
      const { getAffectedFlows } = require('./flow-detector')

      for (const fp of changedFilePaths) {
        const fileNodes = graph.getNodesByFile(fp)
        const ranges = lineRanges.get(fp) || []

        for (const node of fileNodes) {
          if (node.kind === 'File') continue

          const overlaps =
            ranges.length === 0 ||
            ranges.some((r) => node.lineStart != null && node.lineEnd != null && node.lineStart <= r.end && node.lineEnd >= r.start)

          if (overlaps) {
            const risk = computeRiskScore(graph, node)
            const testedBy = graph.getEdgesBySource(node.qualifiedName, 'TESTED_BY')
            const entry: any = {
              kind: node.kind,
              name: node.name,
              file: node.filePath,
              lines: node.lineStart && node.lineEnd ? `${node.lineStart}-${node.lineEnd}` : null,
              risk: Math.round(risk * 1000) / 1000,
              tested: testedBy.length > 0,
              test_count: testedBy.length,
            }
            if (include_source && node.lineStart && node.lineEnd) {
              try {
                const { join } = require('path')
                const absPath = join(cwd, fp)
                const lines = readFileSync(absPath, 'utf-8').split('\n')
                const start = Math.max(0, node.lineStart - 1)
                const end = Math.min(lines.length, node.lineEnd)
                entry.source = lines.slice(start, end).join('\n').substring(0, 2000)
              } catch {
                /* non-fatal */
              }
            }
            changedFunctions.push(entry)
          }
        }
      }

      // Aggregate risk
      const { computeFileSetRisk } = require('./risk-scorer')
      const riskInfo = computeFileSetRisk(graph, changedFilePaths)

      // Affected flows
      const affectedFlows = getAffectedFlows(graph, changedFilePaths)

      // Test gaps: changed non-test nodes without TESTED_BY
      const testGaps = changedFunctions.filter((f) => !f.tested && f.kind !== 'Test')

      return textResult({
        summary: `${changedFilePaths.length} files changed, ${changedFunctions.length} functions affected`,
        risk_score: riskInfo.maxRisk,
        avg_risk: riskInfo.avgRisk,
        changed_files: changedFilePaths,
        changed_functions: changedFunctions.slice(0, 100),
        affected_flows: affectedFlows.slice(0, 20).map((f: any) => ({
          name: f.name,
          criticality: f.criticality,
          node_count: f.node_count,
        })),
        test_gaps: testGaps.slice(0, 50).map((f: any) => ({
          name: f.name,
          file: f.file,
          risk: f.risk,
        })),
        review_priorities: changedFunctions
          .sort((a: any, b: any) => b.risk - a.risk)
          .slice(0, 10)
          .map((f: any) => ({
            name: f.name,
            file: f.file,
            risk: f.risk,
            tested: f.tested,
          })),
      })
    },
  }
}

// ---------------------------------------------------------------------------
// Review Context Tool
// ---------------------------------------------------------------------------

function createReviewContextTool(ctx: ToolContext): AgentTool {
  return {
    name: 'review_context',
    description:
      'Get a comprehensive, token-optimized review bundle for changed files. Includes structural subgraph, risk scores, affected flows, test gaps, truncated source hunks around affected nodes, and review guidance. Use this when reviewing a PR or set of changes.',
    label: 'Review Context',
    parameters: Type.Object({
      changed_files: Type.Optional(
        Type.Array(Type.String(), {
          description: 'Explicit file list (skips git diff if provided)',
        }),
      ),
      base: Type.Optional(
        Type.String({
          description: 'Git ref to diff against (default: "HEAD~1")',
        }),
      ),
      max_depth: Type.Optional(Type.Number({ description: 'Impact radius BFS depth (default: 2)' })),
      include_source: Type.Optional(Type.Boolean({ description: 'Include source hunks (default: true)' })),
      max_lines_per_file: Type.Optional(
        Type.Number({
          description: 'Max source lines per file (default: 200)',
        }),
      ),
    }),
    execute: async (_toolCallId, params) => {
      const {
        changed_files,
        base = 'HEAD~1',
        max_depth = 2,
        include_source = true,
        max_lines_per_file = 200,
      } = params as {
        changed_files?: string[]
        base?: string
        max_depth?: number
        include_source?: boolean
        max_lines_per_file?: number
      }

      const graph = await getOrCreateGraph(ctx)
      if (!graph) {
        return textResult({ error: 'Knowledge graph not available.' })
      }

      const { execSync } = require('@shogo/shared-runtime/child-process')
      const { readFileSync, existsSync } = require('fs')
      const { join } = require('path')
      const cwd = ctx.workspaceDir

      // Step 1: Get changed files
      let filePaths: string[]
      if (changed_files && changed_files.length > 0) {
        filePaths = changed_files
      } else {
        try {
          const out = execSync(`git diff --name-only ${base}`, {
            cwd,
            encoding: 'utf-8',
          }).trim()
          filePaths = out ? out.split('\n').filter(Boolean) : []
        } catch {
          return textResult({
            error: `Failed to run git diff against ${base}.`,
          })
        }
      }

      if (filePaths.length === 0) {
        return textResult({ summary: 'No changes detected' })
      }

      // Step 2: Impact radius
      const impact = graph.getImpactRadius(filePaths, max_depth)

      // Step 3: Risk + flows + test gaps
      const { computeRiskScore, computeFileSetRisk } = require('./risk-scorer')
      const { getAffectedFlows } = require('./flow-detector')

      const riskInfo = computeFileSetRisk(graph, filePaths)
      const affectedFlows = getAffectedFlows(graph, filePaths)

      // Build per-node risk + test info for changed nodes
      const changedNodeDetails: any[] = []
      for (const node of impact.changedNodes) {
        if (node.kind === 'File') continue
        const risk = computeRiskScore(graph, node)
        const testedBy = graph.getEdgesBySource(node.qualifiedName, 'TESTED_BY')
        changedNodeDetails.push({
          kind: node.kind,
          name: node.name,
          file: node.filePath,
          lines: node.lineStart && node.lineEnd ? `${node.lineStart}-${node.lineEnd}` : null,
          risk: Math.round(risk * 1000) / 1000,
          tested: testedBy.length > 0,
        })
      }

      // Step 4: Source hunks
      const sourceHunks: any[] = []
      if (include_source) {
        for (const fp of filePaths) {
          const absPath = join(cwd, fp)
          if (!existsSync(absPath)) continue
          try {
            const content = readFileSync(absPath, 'utf-8')
            const lines = content.split('\n')
            const fileNodes = graph.getNodesByFile(fp).filter((n: any) => n.kind !== 'File')

            if (fileNodes.length === 0) {
              const truncated = lines.slice(0, max_lines_per_file).join('\n')
              sourceHunks.push({
                file: fp,
                lines: `1-${Math.min(lines.length, max_lines_per_file)}`,
                content: truncated,
              })
              continue
            }

            // Build merged ranges around affected nodes (+-2 lines context)
            const ranges: Array<{ start: number; end: number }> = []
            for (const node of fileNodes) {
              if (node.lineStart == null || node.lineEnd == null) continue
              ranges.push({
                start: Math.max(1, node.lineStart - 2),
                end: Math.min(lines.length, node.lineEnd + 2),
              })
            }
            ranges.sort((a, b) => a.start - b.start)

            // Merge overlapping ranges
            const merged: typeof ranges = []
            for (const r of ranges) {
              if (merged.length > 0 && r.start <= merged[merged.length - 1].end + 1) {
                merged[merged.length - 1].end = Math.max(merged[merged.length - 1].end, r.end)
              } else {
                merged.push({ ...r })
              }
            }

            let totalLines = 0
            for (const r of merged) {
              if (totalLines >= max_lines_per_file) break
              const chunk = lines.slice(r.start - 1, r.end).join('\n')
              sourceHunks.push({
                file: fp,
                lines: `${r.start}-${r.end}`,
                content: chunk,
              })
              totalLines += r.end - r.start + 1
            }
          } catch {
            /* non-fatal */
          }
        }
      }

      // Step 5: Review guidance
      const guidance: string[] = []
      const untestedFns = changedNodeDetails.filter((n) => !n.tested && n.kind === 'Function')
      if (untestedFns.length > 0) {
        guidance.push(`${untestedFns.length} changed function(s) have no test coverage: ${untestedFns.map((n) => n.name).join(', ')}`)
      }
      if (impact.impactedFiles.length > 5) {
        guidance.push(`Wide blast radius: ${impact.impactedFiles.length} files impacted — consider incremental deployment`)
      }
      const inheritanceEdges = impact.edges.filter((e) => e.kind === 'INHERITS')
      if (inheritanceEdges.length > 0) {
        guidance.push(`Inheritance chain affected — verify subclass contract compatibility`)
      }
      if (riskInfo.maxRisk > 0.7) {
        guidance.push(`High risk score (${riskInfo.maxRisk}) — pay extra attention to security-sensitive functions`)
      }
      if (affectedFlows.length > 3) {
        guidance.push(`${affectedFlows.length} execution flows affected — consider integration testing`)
      }

      return textResult({
        changed_files: filePaths,
        risk_score: riskInfo.maxRisk,
        avg_risk: riskInfo.avgRisk,
        changed_nodes: changedNodeDetails.slice(0, 50),
        impacted_files: impact.impactedFiles.slice(0, 30),
        impacted_nodes: impact.impactedNodes.slice(0, 30).map((n) => ({
          kind: n.kind,
          name: n.name,
          file: n.filePath,
        })),
        edges: impact.edges.slice(0, 60).map((e) => ({
          kind: e.kind,
          from: e.sourceQualified.split('::').pop(),
          to: e.targetQualified.split('::').pop(),
        })),
        source_hunks: sourceHunks.slice(0, 30),
        affected_flows: affectedFlows.slice(0, 15).map((f: any) => ({
          name: f.name,
          criticality: f.criticality,
          node_count: f.node_count,
          file_count: f.file_count,
        })),
        test_gaps: changedNodeDetails
          .filter((n) => !n.tested && n.kind !== 'Test')
          .slice(0, 30)
          .map((n) => ({
            name: n.name,
            file: n.file,
            risk: n.risk,
          })),
        review_guidance: guidance,
        total_impacted: impact.totalImpacted,
        truncated: impact.truncated,
      })
    },
  }
}

// ---------------------------------------------------------------------------
// Channel Connect Tool
// ---------------------------------------------------------------------------

const CHANNEL_SETUP_GUIDES: Record<string, { requiredKeys: string[]; guide: string }> = {
  telegram: {
    requiredKeys: ['botToken'],
    guide: [
      '## Telegram Setup',
      '1. Open Telegram and message @BotFather',
      '2. Send /newbot and follow the prompts to create a bot',
      '3. Copy the bot token (looks like 123456:ABC-DEF...)',
      '4. Connect: channel_connect({ type: "telegram", config: { botToken: "YOUR_TOKEN" } })',
    ].join('\n'),
  },
  discord: {
    requiredKeys: ['botToken', 'guildId'],
    guide: [
      '## Discord Setup',
      '1. Go to https://discord.com/developers/applications and create a New Application',
      '2. Go to Bot tab → click "Add Bot" → copy the bot token',
      '3. Go to Bot tab → enable "Message Content Intent" under Privileged Gateway Intents',
      '4. Go to OAuth2 → URL Generator → select "bot" scope + "Send Messages" + "Read Messages" permissions',
      '5. Open the generated URL to invite the bot to your server',
      '6. Get the guild (server) ID: enable Developer Mode in Discord settings, right-click the server → Copy Server ID',
      '7. Connect: channel_connect({ type: "discord", config: { botToken: "YOUR_TOKEN", guildId: "SERVER_ID" } })',
    ].join('\n'),
  },
  slack: {
    requiredKeys: ['botToken', 'appToken'],
    guide: [
      '## Slack Setup',
      '1. Go to https://api.slack.com/apps and click "Create New App" → "From scratch"',
      '2. Under OAuth & Permissions, add these Bot Token Scopes: chat:write, channels:history, channels:read, groups:history, im:history, mpim:history',
      '3. Install the app to your workspace → copy the Bot User OAuth Token (xoxb-...)',
      '4. Under Basic Information → App-Level Tokens → "Generate Token" with connections:write scope → copy the token (xapp-...)',
      '5. Under Socket Mode → enable Socket Mode',
      '6. Under Event Subscriptions → enable events → subscribe to: message.channels, message.groups, message.im, message.mpim',
      '7. Connect: channel_connect({ type: "slack", config: { botToken: "xoxb-...", appToken: "xapp-..." } })',
    ].join('\n'),
  },
  email: {
    requiredKeys: ['imapHost', 'smtpHost', 'username', 'password'],
    guide: [
      '## Email Setup',
      '1. Get IMAP and SMTP credentials from your email provider',
      '   - Gmail: use imap.gmail.com / smtp.gmail.com, enable "App Passwords" in Google Account settings',
      '   - Outlook: use outlook.office365.com for both IMAP and SMTP',
      "   - Custom: check your provider's IMAP/SMTP settings",
      '2. Connect: channel_connect({ type: "email", config: { imapHost: "imap.gmail.com", smtpHost: "smtp.gmail.com", username: "you@gmail.com", password: "YOUR_APP_PASSWORD" } })',
    ].join('\n'),
  },
  whatsapp: {
    requiredKeys: ['accessToken', 'phoneNumberId', 'verifyToken'],
    guide: [
      '## WhatsApp Setup',
      '1. Go to https://developers.facebook.com and create or select an app',
      '2. Add the WhatsApp product to your app',
      '3. Under WhatsApp → API Setup → copy the Temporary Access Token and Phone Number ID',
      "4. Choose a verify token (any string you make up) — you'll use it to verify the webhook",
      '5. Connect: channel_connect({ type: "whatsapp", config: { accessToken: "YOUR_TOKEN", phoneNumberId: "YOUR_PHONE_ID", verifyToken: "YOUR_VERIFY_TOKEN" } })',
      '6. After connecting, configure the webhook URL in Meta Developer Portal → WhatsApp → Configuration → Callback URL',
    ].join('\n'),
  },
  webhook: {
    requiredKeys: [],
    guide: [
      '## Webhook / HTTP Setup',
      'No external accounts needed. Optionally provide a shared secret for authentication.',
      '',
      'Connect: channel_connect({ type: "webhook", config: { secret: "your-shared-secret" } })',
      '',
      'Once connected, external services can POST to /agent/channels/webhook/incoming with:',
      '  - Header: Authorization: Bearer your-shared-secret',
      '  - Body: { "message": "...", "channelId": "default", "mode": "sync" }',
      '',
      'Works with Zapier, Make, n8n, or any HTTP-capable service.',
    ].join('\n'),
  },
  teams: {
    requiredKeys: ['appId', 'appPassword'],
    guide: [
      '## Microsoft Teams Setup',
      '1. Go to Azure Portal → Azure Bot Service → create a new Bot resource',
      '2. Note the Microsoft App ID and create a client secret (App Password)',
      '3. Set the messaging endpoint to: <agent-url>/agent/channels/teams/messages',
      '4. Connect: channel_connect({ type: "teams", config: { appId: "YOUR_APP_ID", appPassword: "YOUR_SECRET", botName: "My Agent" } })',
      '5. Install the bot in Teams via the Teams Admin Center or a Teams App manifest',
    ].join('\n'),
  },
  webchat: {
    requiredKeys: [],
    guide: [
      '## WebChat Widget Setup',
      'No external accounts needed. All config fields are optional.',
      '',
      'Connect: channel_connect({ type: "webchat", config: { title: "Chat with us", welcomeMessage: "Hi! How can I help?", primaryColor: "#6366f1", position: "bottom-right" } })',
      'Or with no config: channel_connect({ type: "webchat", config: {} })',
      '',
      'After connecting, give the user the embed snippet to paste on their website.',
      'The widget appears as a chat bubble — visitors can chat with the agent directly.',
      'Optional config: title, subtitle, welcomeMessage, primaryColor (hex), position ("bottom-right" or "bottom-left"), avatarUrl, allowedOrigins.',
    ].join('\n'),
  },
}

function createChannelConnectTool(ctx: ToolContext): AgentTool {
  return {
    name: 'channel_connect',
    description:
      'Connect a messaging channel. Supported: telegram, discord, email, slack, whatsapp, webhook, teams, webchat. Saves config and hot-connects immediately.',
    label: 'Connect Channel',
    parameters: Type.Object({
      type: Type.String({
        description: 'Channel type: telegram, discord, email, slack, whatsapp, webhook, teams, or webchat',
      }),
      config: Type.Record(Type.String(), Type.String(), {
        description: 'Channel-specific config keys. The tool returns setup instructions if required keys are missing.',
      }),
      model: Type.Optional(
        Type.String({
          description: `AI model for this channel. Defaults to "auto". ${availableModelsHint()} Economy-tier models work on all plans; standard/premium require Pro.`,
        }),
      ),
    }),
    execute: async (_toolCallId, params) => {
      const {
        type,
        config: channelConfig,
        model,
      } = params as {
        type: string
        config: Record<string, string>
        model?: string
      }

      if (model && !isAvailableModel(model)) {
        return textResult({ error: `Model "${model}" is not available in this workspace. ${availableModelsHint()}` })
      }
      const channelModel = model || 'auto'
      const resolvedChannelModel = resolveModelId(channelModel)
      const channelTier = getModelTier(resolvedChannelModel)

      if (channelTier !== 'economy') {
        const proxyUrl = ctx.aiProxyUrl || process.env.AI_PROXY_URL
        const proxyToken = ctx.aiProxyToken || process.env.AI_PROXY_TOKEN
        if (proxyUrl && proxyToken) {
          try {
            const accessRes = await fetch(`${proxyUrl.replace(/\/chat\/completions$/, '').replace(/\/v1$/, '/v1')}/access`, {
              headers: { Authorization: `Bearer ${proxyToken}` },
              signal: AbortSignal.timeout(5000),
            })
            if (accessRes.ok) {
              const access = (await accessRes.json()) as {
                hasAdvancedModelAccess?: boolean
              }
              if (!access.hasAdvancedModelAccess) {
                return textResult({
                  error: `Model '${channelModel}' requires a Pro or higher subscription. Please use an economy-tier model or upgrade your plan.`,
                })
              }
            }
          } catch {
            /* If check fails, allow and let proxy enforce at runtime */
          }
        }
      }

      const validTypes = ['telegram', 'discord', 'email', 'slack', 'whatsapp', 'webhook', 'teams', 'webchat']
      if (!validTypes.includes(type)) {
        return textResult({
          error: `Invalid channel type: ${type}. Must be one of: ${validTypes.join(', ')}`,
        })
      }

      const channelGuide = CHANNEL_SETUP_GUIDES[type]
      if (channelGuide) {
        const missingKeys = channelGuide.requiredKeys.filter((k) => !channelConfig[k])
        if (missingKeys.length > 0) {
          return textResult({
            error: `Missing required config: ${missingKeys.join(', ')}`,
            setup_guide: channelGuide.guide,
          })
        }
      }

      if (type === 'webchat' && !channelConfig.widgetSecret) {
        const { randomUUID } = await import('crypto')
        channelConfig.widgetSecret = randomUUID()
      }

      try {
        const { existsSync, readFileSync, writeFileSync } = await import('fs')
        const { join } = await import('path')
        const configPath = join(ctx.workspaceDir, 'config.json')
        let savedConfig: Record<string, any> = {}
        if (existsSync(configPath)) {
          savedConfig = JSON.parse(readFileSync(configPath, 'utf-8'))
        }
        savedConfig.channels = savedConfig.channels || []
        const existing = savedConfig.channels.findIndex((c: any) => c.type === type)
        const channelEntry = {
          type,
          config: channelConfig,
          model: channelModel,
        }
        if (existing >= 0) {
          savedConfig.channels[existing] = channelEntry
        } else {
          savedConfig.channels.push(channelEntry)
        }
        writeFileSync(configPath, JSON.stringify(savedConfig, null, 2), 'utf-8')
      } catch (err: any) {
        return textResult({ error: `Failed to save config: ${err.message}` })
      }

      if (ctx.connectChannel) {
        try {
          await ctx.connectChannel(type, channelConfig)

          if (type === 'webchat') {
            const widgetKey = encodeURIComponent(channelConfig.widgetSecret || '')
            const widgetPath = `/agent/channels/webchat/widget.js?widgetKey=${widgetKey}`
            let widgetUrl: string
            if (process.env.KUBERNETES_SERVICE_HOST) {
              const apiUrl = derivePublicApiUrl()
              widgetUrl = `${apiUrl}/api/projects/${ctx.projectId}/agent-proxy${widgetPath}`
            } else {
              widgetUrl = `http://localhost:${process.env.PORT || '8080'}${widgetPath}`
            }
            return textResult({
              ok: true,
              message: [
                'WebChat channel connected and live!',
                '',
                'Tell the user to add this single script tag before the closing </body> tag on their website:',
                '',
                `<script src="${widgetUrl}"></script>`,
                '',
                'A chat bubble will appear on their page. Visitors can click it to chat with the agent. No other setup needed.',
                'The user can also find the embed snippet in the Channels panel.',
              ].join('\n'),
              embedSnippet: `<script src="${widgetUrl}"></script>`,
            })
          }

          return textResult({
            ok: true,
            message:
              `${type} channel connected and live. ` +
              (type === 'webhook'
                ? 'External services can now POST to /agent/channels/webhook/incoming'
                : `The ${type} adapter is now receiving messages.`),
          })
        } catch (err: any) {
          return textResult({
            ok: true,
            message: `${type} channel saved to config but failed to hot-connect: ${err.message}. Restart the agent to connect.`,
            setup_guide: channelGuide?.guide,
          })
        }
      }

      return textResult({
        ok: true,
        message: `${type} channel configured. Restart the agent to connect.`,
        setup_guide: channelGuide?.guide,
      })
    },
  }
}

// ---------------------------------------------------------------------------
// Audio Transcription Tool (OpenAI Whisper)
// ---------------------------------------------------------------------------

function createTranscribeAudioTool(ctx: ToolContext): AgentTool {
  return {
    name: 'transcribe_audio',
    description:
      'Transcribe an audio file to text using OpenAI Whisper. Supports mp3, mp4, mpeg, mpga, m4a, wav, and webm formats. Provide a path to an audio file in the workspace.',
    label: 'Transcribe Audio',
    parameters: Type.Object({
      path: Type.String({
        description: 'Path to the audio file in the workspace (e.g. "recording.mp3")',
      }),
      language: Type.Optional(
        Type.String({
          description: 'ISO-639-1 language code (e.g. "en", "es", "fr"). Auto-detected if omitted.',
        }),
      ),
    }),
    execute: async (_toolCallId, params) => {
      const { path: filePath, language } = params as {
        path: string
        language?: string
      }

      const resolved = assertWithinWorkspace(ctx.workspaceDir, filePath, pathPolicy(ctx))
      if (!existsSync(resolved)) {
        return textResult({ error: `Audio file not found: ${filePath}` })
      }

      const proxyUrl = ctx.aiProxyUrl || process.env.AI_PROXY_URL
      const proxyToken = ctx.aiProxyToken || process.env.AI_PROXY_TOKEN
      const directKey = process.env.OPENAI_API_KEY

      // AI_PROXY_URL is `${apiBase}/api/ai/v1`; stripping the trailing `/v1`
      // and re-appending it below lands on `.../api/ai/v1/audio/transcriptions`
      // — the proxy's own transcription route (apps/api/src/routes/ai-proxy.ts)
      // — rather than calling OpenAI directly with the proxy token.
      const apiBase = proxyUrl ? proxyUrl.replace(/\/v1$/, '') : 'https://api.openai.com'
      const apiKey = proxyToken || directKey
      if (!apiKey) {
        return textResult({
          error: 'Audio transcription not available: no OpenAI API key configured.',
        })
      }

      try {
        const audioBuffer = readFileSync(resolved)
        const ext = extname(resolved).toLowerCase()
        const mimeMap: Record<string, string> = {
          '.mp3': 'audio/mpeg',
          '.mp4': 'audio/mp4',
          '.mpeg': 'audio/mpeg',
          '.mpga': 'audio/mpeg',
          '.m4a': 'audio/mp4',
          '.wav': 'audio/wav',
          '.webm': 'audio/webm',
          '.ogg': 'audio/ogg',
        }
        const mimeType = mimeMap[ext] || 'audio/mpeg'

        const formData = new FormData()
        formData.append('file', new Blob([audioBuffer], { type: mimeType }), `audio${ext || '.mp3'}`)
        formData.append('model', 'whisper-1')
        formData.append('response_format', 'verbose_json')
        if (language) formData.append('language', language)

        const response = await fetch(`${apiBase}/v1/audio/transcriptions`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}` },
          body: formData,
          signal: AbortSignal.timeout(120_000),
        })

        if (!response.ok) {
          const errBody = await response.text().catch(() => '')
          return textResult({
            error: `Whisper API error (${response.status}): ${errBody.slice(0, 500)}`,
          })
        }

        const result = (await response.json()) as {
          text: string
          language?: string
          duration?: number
          segments?: Array<{ start: number; end: number; text: string }>
        }

        return textResult({
          text: result.text,
          language: result.language,
          duration_seconds: result.duration,
          segments: result.segments?.map((s) => ({
            start: s.start,
            end: s.end,
            text: s.text,
          })),
        })
      } catch (err: any) {
        return textResult({
          error: `Audio transcription failed: ${err.message}`,
        })
      }
    },
  }
}

// ---------------------------------------------------------------------------
// Heartbeat Tools
// ---------------------------------------------------------------------------

/**
 * The project a heartbeat tool acts on: an explicit `projectId`, else the
 * current project, else the workspace anchor. `ws:<workspaceId>` runtime keys
 * are not projects and are skipped.
 */
function resolveHeartbeatProjectId(ctx: ToolContext, requested?: string): string | undefined {
  return (
    projectScopedId(requested) ??
    projectScopedId(ctx.projectId) ??
    projectScopedId(process.env.WORKSPACE_ANCHOR_PROJECT_ID)
  )
}

export function createHeartbeatConfigureTool(ctx: ToolContext): AgentTool {
  return {
    name: 'heartbeat_configure',
    description:
      'Configure the heartbeat system: enable/disable, set interval, and quiet hours. The heartbeat is a periodic sweep (HEARTBEAT.md) for things nothing else reports, such as inboxes and stale cards; work an agent hands off or starts reports back through [Task update], so never shorten the interval to follow it. The schedule is stored in the central scheduler database (not config.json). Heartbeats require a paid plan; on a free plan this returns a paywall error. Defaults to the current project.',
    label: 'Configure Heartbeat',
    parameters: Type.Object({
      enabled: Type.Optional(Type.Boolean({ description: 'Enable or disable heartbeat' })),
      interval: Type.Optional(
        Type.Number({
          description: 'Heartbeat interval in seconds (minimum 60, default 1800)',
        }),
      ),
      quietHoursStart: Type.Optional(
        Type.String({
          description: 'Quiet hours start time (HH:MM, e.g. "23:00")',
        }),
      ),
      quietHoursEnd: Type.Optional(
        Type.String({
          description: 'Quiet hours end time (HH:MM, e.g. "07:00")',
        }),
      ),
      timezone: Type.Optional(
        Type.String({
          description: 'IANA timezone for quiet hours (e.g. "America/Los_Angeles")',
        }),
      ),
      projectId: Type.Optional(
        Type.String({
          description: 'Project id to configure (default: the current project). Must be a project in this workspace.',
        }),
      ),
    }),
    execute: async (_toolCallId, params) => {
      const { enabled, interval, quietHoursStart, quietHoursEnd, timezone, projectId: requestedId } = params as {
        enabled?: boolean
        interval?: number
        quietHoursStart?: string
        quietHoursEnd?: string
        timezone?: string
        projectId?: string
      }

      if (interval !== undefined && interval < 60) {
        return textResult({ error: 'Interval must be at least 60 seconds' })
      }

      const projectId = resolveHeartbeatProjectId(ctx, requestedId)
      if (!projectId) {
        return textResult({ error: 'No project to configure heartbeat for. Pass projectId.' })
      }

      const agent: Record<string, unknown> = {}
      if (enabled !== undefined) agent.heartbeatEnabled = enabled
      if (interval !== undefined) agent.heartbeatInterval = interval
      if (quietHoursStart !== undefined) agent.quietHoursStart = quietHoursStart
      if (quietHoursEnd !== undefined) agent.quietHoursEnd = quietHoursEnd
      if (timezone !== undefined) agent.quietHoursTimezone = timezone

      const res =
        Object.keys(agent).length > 0
          ? await apiConfigureProject(projectId, { agent: agent as any })
          : await apiGetProjectConfig(projectId)
      if (!res.ok || !res.data) {
        return textResult({
          error: `Failed to configure heartbeat: ${res.error ?? 'request failed'}`,
          code: res.code,
        })
      }
      if (res.data.heartbeatError) {
        return textResult({ error: res.data.heartbeatError.message, code: res.data.heartbeatError.code })
      }

      ctx.onHeartbeatConfigured?.()
      const a = res.data.agent
      return textResult({
        ok: true,
        projectId,
        enabled: a?.heartbeatEnabled ?? false,
        interval: a?.heartbeatInterval ?? 1800,
        quietHours: a?.quietHoursStart || a?.quietHoursEnd
          ? { start: a?.quietHoursStart ?? null, end: a?.quietHoursEnd ?? null, timezone: a?.quietHoursTimezone ?? null }
          : null,
        nextHeartbeatAt: a?.nextHeartbeatAt ?? null,
      })
    },
  }
}

export function createHeartbeatStatusTool(ctx: ToolContext): AgentTool {
  return {
    name: 'heartbeat_status',
    description:
      'Get the current heartbeat schedule (enabled, interval, quiet hours, next and last run) and a preview of the project\'s HEARTBEAT.md checklist. Defaults to the current project.',
    label: 'Heartbeat Status',
    parameters: Type.Object({
      projectId: Type.Optional(
        Type.String({ description: 'Project id (default: the current project).' }),
      ),
    }),
    execute: async (_toolCallId, params) => {
      const { existsSync, readFileSync } = await import('fs')
      const { join } = await import('path')

      const { projectId: requestedId } = (params ?? {}) as { projectId?: string }
      const projectId = resolveHeartbeatProjectId(ctx, requestedId)
      if (!projectId) {
        return textResult({ error: 'No project to report heartbeat status for. Pass projectId.' })
      }

      const res = await apiGetProjectConfig(projectId)
      if (!res.ok || !res.data) {
        return textResult({ error: `Failed to read heartbeat status: ${res.error ?? 'request failed'}`, code: res.code })
      }
      const a = res.data.agent

      // A workspace runtime keeps each project's files in its own subfolder
      // of the merged root; a single-project runtime serves the root itself.
      const projectDir = isWorkspaceRuntimeMode() ? join(ctx.workspaceDir, projectId) : ctx.workspaceDir
      const heartbeatPath = join(projectDir, 'HEARTBEAT.md')
      const heartbeatContent = existsSync(heartbeatPath) ? readFileSync(heartbeatPath, 'utf-8') : ''

      return textResult({
        projectId,
        enabled: a?.heartbeatEnabled ?? false,
        interval: a?.heartbeatInterval ?? 1800,
        quietHours: a?.quietHoursStart || a?.quietHoursEnd
          ? { start: a?.quietHoursStart ?? null, end: a?.quietHoursEnd ?? null, timezone: a?.quietHoursTimezone ?? null }
          : null,
        nextHeartbeatAt: a?.nextHeartbeatAt ?? null,
        lastHeartbeatAt: a?.lastHeartbeatAt ?? null,
        checklistLength: heartbeatContent.trim().length,
        checklistPreview: heartbeatContent.substring(0, 500),
      })
    },
  }
}

// ---------------------------------------------------------------------------
// Factory Functions
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Plan Mode: create_plan tool
// ---------------------------------------------------------------------------

function normalizePlanFilepath(filepath: string): string | null {
  const normalized = filepath.replace(/^\/+/, '').replace(/\\/g, '/')
  const filename = normalized.split('/').pop() ?? ''
  if (!/^[a-zA-Z0-9._-]+\.plan\.md$/.test(filename)) return null
  return `.shogo/plans/${filename}`
}

function parsePlanTodosFromFrontmatter(fm: string): Array<{ id: string; content: string }> {
  const todos: Array<{ id: string; content: string }> = []
  const todoBlocks = fm.split(/\n  - id: /).slice(1)
  for (const block of todoBlocks) {
    const idMatch = block.match(/^(\S+)/)
    const contentMatch = block.match(/content:\s*"?([^"\n]*)"?/)
    if (idMatch && contentMatch) {
      todos.push({ id: idMatch[1], content: contentMatch[1] })
    }
  }
  return todos
}

// ---------------------------------------------------------------------------
// Plan Mode: stakeholder summary (Dual Plan)
//
// When ctx.dualPlan is true, every successful create_plan / update_plan call
// kicks off a background summary pass via the fast-tier model. The pass:
//   1. Emits `data-plan-summary-start` so the UI can render a spinner.
//   2. Calls summarizePlan() (one-shot tool-less runAgentLoop).
//   3. Rewrites the .plan.md file in place, appending/replacing the summary
//      section delimited by SUMMARY_SECTION_START/END.
//   4. Emits `data-plan-summary` with the markdown, or
//      `data-plan-summary-error` with a message on failure.
//
// The work is fired-and-forgotten with respect to the tool's return value —
// the create_plan tool result fires immediately so the model can continue
// reasoning, and the UI receives the summary asynchronously via the
// stream.
// ---------------------------------------------------------------------------

interface PlanSummaryJob {
  filepath: string
  relativePath: string
  name: string
  overview: string
  planMarkdown: string
  toolCallId: string
}

function runPlanSummary(ctx: ToolContext, job: PlanSummaryJob): void {
  const writer = ctx.uiWriter
  writer?.write({
    type: 'data-plan-summary-start',
    data: { filepath: job.relativePath, toolCallId: job.toolCallId },
  })

  void (async () => {
    try {
      const { summarizePlan, upsertSummarySection } = await import('./plan-translation')
      const summary = await summarizePlan({
        name: job.name,
        overview: job.overview,
        planMarkdown: job.planMarkdown,
        parentModel: ctx.effectiveModel,
      })

      try {
        if (existsSync(job.filepath)) {
          const current = readFileSync(job.filepath, 'utf-8')
          const next = upsertSummarySection(current, summary)
          writeFileSync(job.filepath, next, 'utf-8')
        }
      } catch (writeErr) {
        console.error(`[create_plan][dual-plan] failed to persist summary section for ${job.relativePath}:`, writeErr)
      }

      writer?.write({
        type: 'data-plan-summary',
        data: {
          filepath: job.relativePath,
          summary,
          toolCallId: job.toolCallId,
        },
      })
    } catch (err: any) {
      const message = err?.message || String(err)
      console.error(`[create_plan][dual-plan] summary generation failed for ${job.relativePath}:`, message)
      writer?.write({
        type: 'data-plan-summary-error',
        data: {
          filepath: job.relativePath,
          message,
          toolCallId: job.toolCallId,
        },
      })
    }
  })()
}

function createCreatePlanTool(ctx: ToolContext): AgentTool {
  return {
    name: 'create_plan',
    description:
      'Create a structured plan for the user to review and confirm before execution. The plan is saved to .shogo/plans/ as a markdown file and presented to the user for approval.',
    label: 'Create Plan',
    parameters: Type.Object({
      name: Type.String({ description: 'Short 3-5 word name for the plan' }),
      overview: Type.String({
        description: '1-2 sentence summary of what the plan accomplishes',
      }),
      plan: Type.String({
        description: 'Detailed plan in markdown format. Include specific file paths, code snippets, and implementation steps. For plans that change code, use the sections ## Problem, ## Root cause (each claim cites path:line), ## Options considered, ## Changes, ## Tests, ## Verification, ## Risks.',
      }),
      todos: Type.Array(
        Type.Object({
          id: Type.String({
            description: 'Unique task identifier (kebab-case)',
          }),
          content: Type.String({ description: 'Task description' }),
        }),
        { description: 'Implementation tasks in execution order' },
      ),
    }),
    execute: async (_id: string, rawParams: unknown) => {
      const params = rawParams as {
        name: string
        overview: string
        plan: string
        todos: Array<{ id: string; content: string }>
      }
      const slug = params.name
        .toLowerCase()
        .replace(/\s+/g, '-')
        .replace(/[^a-z0-9-]/g, '')
        .substring(0, 50)
      const hash = Math.random().toString(36).substring(2, 10)
      const filename = `${slug}_${hash}.plan.md`

      const todosYaml = params.todos
        .map((t) => `  - id: ${t.id}\n    content: ${JSON.stringify(t.content)}\n    status: pending`)
        .join('\n')

      const content = [
        '---',
        `name: ${JSON.stringify(params.name)}`,
        `overview: ${JSON.stringify(params.overview)}`,
        `createdAt: ${JSON.stringify(new Date().toISOString())}`,
        'status: pending',
        'todos:',
        todosYaml,
        '---',
        '',
        `# ${params.name}`,
        '',
        params.plan,
      ].join('\n')

      const plansDir = join(ctx.workspaceDir, '.shogo', 'plans')
      mkdirSync(plansDir, { recursive: true })
      const filepath = join(plansDir, filename)
      writeFileSync(filepath, content, 'utf-8')
      void postPlanMirror({
        filename,
        name: params.name,
        overview: params.overview,
        status: 'pending',
        content,
        chatSessionId: ctx.sessionId,
      })

      if (ctx.uiWriter) {
        ctx.uiWriter.write({
          type: 'data-plan',
          data: {
            name: params.name,
            overview: params.overview,
            plan: params.plan,
            todos: params.todos,
            filepath: `.shogo/plans/${filename}`,
            toolCallId: _id,
          },
        })
      }

      if (ctx.dualPlan) {
        const relPath = `.shogo/plans/${filename}`
        runPlanSummary(ctx, {
          filepath: filepath,
          relativePath: relPath,
          name: params.name,
          overview: params.overview,
          planMarkdown: params.plan,
          toolCallId: _id,
        })
      }

      const missing = missingCodePlanSections(params.plan)
      const missingNote = missing.length > 0
        ? `\nThis plan changes code but has no ${missing.map((s) => `"## ${s}"`).join(' or ')} section. Add ${missing.length > 1 ? 'them' : 'it'} with update_plan before handing the plan to the user.`
        : ''
      return textResult(`Plan "${params.name}" created and saved to .shogo/plans/${filename}${missingNote}`)
    },
  }
}

// ---------------------------------------------------------------------------
// Plan Mode: update_plan tool
// ---------------------------------------------------------------------------

function createUpdatePlanTool(ctx: ToolContext): AgentTool {
  return {
    name: 'update_plan',
    description:
      'Update an existing plan file in .shogo/plans/. Provide only the fields you want to change — omitted fields are preserved. Use this instead of create_plan when the user asks to modify, refine, or extend an existing plan.',
    label: 'Update Plan',
    parameters: Type.Object({
      filepath: Type.String({
        description: 'Relative path to the plan file (e.g. .shogo/plans/my-plan_abc123.plan.md)',
      }),
      name: Type.Optional(Type.String({ description: 'Updated short name for the plan' })),
      overview: Type.Optional(Type.String({ description: 'Updated 1-2 sentence summary' })),
      plan: Type.Optional(
        Type.String({
          description: 'Updated detailed plan in markdown format',
        }),
      ),
      todos: Type.Optional(
        Type.Array(
          Type.Object({
            id: Type.String({
              description: 'Unique task identifier (kebab-case)',
            }),
            content: Type.String({ description: 'Task description' }),
          }),
          { description: 'Full replacement todo list in execution order' },
        ),
      ),
    }),
    execute: async (_id: string, rawParams: unknown) => {
      const params = rawParams as {
        filepath: string
        name?: string
        overview?: string
        plan?: string
        todos?: Array<{ id: string; content: string }>
      }
      const planFilepath = normalizePlanFilepath(params.filepath)
      if (!planFilepath) {
        return textResult(`Error: Invalid plan filepath ${params.filepath}`)
      }
      const plansDir = resolve(ctx.workspaceDir, '.shogo', 'plans')
      const resolved = resolve(ctx.workspaceDir, planFilepath)
      if (!resolved.startsWith(`${plansDir}${sep}`) && resolved !== plansDir) {
        return textResult(`Error: Plan filepath must stay within .shogo/plans/`)
      }
      if (!existsSync(resolved)) {
        return textResult(`Error: Plan file not found at ${planFilepath}`)
      }

      const existing = readFileSync(resolved, 'utf-8')
      const fmMatch = existing.match(/^---\n([\s\S]*?)\n---/)
      if (!fmMatch) {
        return textResult(`Error: Could not parse frontmatter in ${planFilepath}`)
      }

      const fm = fmMatch[1]
      const existingName = fm.match(/name:\s*"?([^"\n]*)"?/)?.[1] ?? ''
      const existingOverview = fm.match(/overview:\s*"?([^"\n]*)"?/)?.[1] ?? ''
      const existingBody = existing.substring(existing.indexOf('---', 4) + 3).trim()
      const existingCreatedAt = fm.match(/createdAt:\s*"?([^"\n]*)"?/)?.[1] ?? new Date().toISOString()
      const existingStatus = fm.match(/status:\s*(\S+)/)?.[1] ?? 'pending'

      const updatedName = params.name ?? existingName
      const updatedOverview = params.overview ?? existingOverview
      const updatedBody = params.plan ?? existingBody.replace(/^#[^\n]*\n*/, '')

      let todosYaml: string
      if (params.todos) {
        todosYaml = params.todos.map((t) => `  - id: ${t.id}\n    content: ${JSON.stringify(t.content)}\n    status: pending`).join('\n')
      } else {
        const todosMatch = fm.match(/todos:\n([\s\S]*)$/)
        todosYaml = todosMatch?.[1]?.trimEnd() ?? ''
      }

      const content = [
        '---',
        `name: ${JSON.stringify(updatedName)}`,
        `overview: ${JSON.stringify(updatedOverview)}`,
        `createdAt: ${JSON.stringify(existingCreatedAt)}`,
        `status: ${existingStatus}`,
        'todos:',
        todosYaml,
        '---',
        '',
        `# ${updatedName}`,
        '',
        updatedBody,
      ].join('\n')

      writeFileSync(resolved, content, 'utf-8')
      void postPlanMirror({
        filename: planFilepath.split('/').pop()!,
        name: updatedName,
        overview: updatedOverview,
        status: existingStatus,
        content,
        createdAt: existingCreatedAt,
        chatSessionId: ctx.sessionId,
      })

      if (ctx.uiWriter) {
        ctx.uiWriter.write({
          type: 'data-plan-update',
          data: {
            filepath: planFilepath,
            name: updatedName,
            overview: updatedOverview,
            plan: updatedBody,
            todos: params.todos ?? parsePlanTodosFromFrontmatter(fm),
            toolCallId: _id,
          },
        })
      }

      const bodyChanged = params.plan !== undefined && params.plan !== existingBody.replace(/^#[^\n]*\n*/, '')
      const nameOrOverviewChanged =
        (params.name !== undefined && params.name !== existingName) ||
        (params.overview !== undefined && params.overview !== existingOverview)
      if (ctx.dualPlan && (bodyChanged || nameOrOverviewChanged)) {
        runPlanSummary(ctx, {
          filepath: resolved,
          relativePath: planFilepath,
          name: updatedName,
          overview: updatedOverview,
          planMarkdown: updatedBody,
          toolCallId: _id,
        })
      }

      return textResult(`Plan "${updatedName}" updated at ${planFilepath}`)
    },
  }
}

// ---------------------------------------------------------------------------
// Read Lints Tool (LSP-backed diagnostics for any TypeScript file)
// ---------------------------------------------------------------------------

/**
 * Cause bucket for a single read_lints error line. Additive metadata only —
 * consumed by evals/production telemetry, never shown to the agent (the
 * plain-text `Line N: message` list it reads stays exactly as before).
 *
 *   - `missing_deps`      — `Cannot find module '<bare-package>'` while the
 *                            workspace's own `node_modules` install hasn't
 *                            finished yet. Environment noise, not a model
 *                            mistake — see HOSHI_CODING_FINDINGS.md.
 *   - `model_diagnostic`  — everything else from the language server: type
 *                           errors, undefined names/properties, bad imports
 *                           once deps *are* ready, etc. The default bucket;
 *                           this is "the model wrote something wrong."
 *   - `runtime`           — canvas compile/render failures caught live by
 *                           the preview (`canvas-runtime-errors.ts`), not a
 *                           static LSP diagnostic.
 *   - `environment`       — the tool itself couldn't produce diagnostics at
 *                           all (LSP not up yet) — see the early-return
 *                           branches below.
 */
export type LintErrorCause = 'missing_deps' | 'model_diagnostic' | 'runtime' | 'environment'

const BARE_MODULE_IMPORT_RE = /Cannot find module ['"]([^'"]+)['"]/

/**
 * Classify one LSP diagnostic's message into a `LintErrorCause`. `depsReady`
 * is `ToolContext.depsReady` — `undefined`/`false` means "don't know / not
 * finished yet," so a bare-package resolution failure is treated as
 * environment noise rather than blamed on the model. Once deps are known
 * ready, the exact same message means the model imported something that
 * genuinely isn't available.
 */
export function classifyLintErrorCause(message: string, depsReady: boolean | undefined): LintErrorCause {
  const moduleMatch = message.match(BARE_MODULE_IMPORT_RE)
  if (moduleMatch) {
    const spec = moduleMatch[1]
    // Relative/workspace-local imports (./foo, ../foo, @/foo) failing to
    // resolve are a real path mistake regardless of install state — deps
    // readiness has nothing to do with those.
    const isBarePackageImport = !spec.startsWith('.') && !spec.startsWith('/') && !spec.startsWith('@/')
    if (isBarePackageImport && depsReady !== true) {
      return 'missing_deps'
    }
  }
  return 'model_diagnostic'
}

function createReadLintsTool(ctx: ToolContext): AgentTool {
  return {
    name: 'read_lints',
    description:
      'Check files for errors (TypeScript type errors, Python type errors, undefined references, syntax issues) and canvas runtime errors (compile/render failures from the live preview). Returns diagnostics from language servers plus any recent canvas runtime errors. Supports .ts, .tsx, .js, .jsx, and .py files. Use after writing or editing code files to catch mistakes. Omit `path` to auto-lint the files you edited this turn (falls back to all tracked files if you have not edited anything yet).',
    label: 'Read Lints',
    parameters: Type.Object({
      path: Type.Optional(
        Type.String({
          description:
            'File to check (e.g. src/App.tsx or scripts/main.py). Rarely needed — omit to auto-lint the files you just edited this turn.',
        }),
      ),
    }),
    execute: async (_toolCallId, params) => {
      // The LSP starts asynchronously (deferred warmup + node_modules wait),
      // so an early read_lints call used to fail-fast with "not available"
      // even though the server was seconds from ready. Resolve the live
      // manager and poll briefly for readiness before giving up.
      const resolveLsp = () => ctx.getLspManager?.() ?? ctx.lspManager ?? null
      const LSP_READY_TIMEOUT_MS = Number(process.env.SHOGO_READ_LINTS_WAIT_MS) || 10_000
      const deadline = Date.now() + LSP_READY_TIMEOUT_MS
      let lsp = resolveLsp()
      while ((!lsp || !lsp.isRunning()) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 250))
        lsp = resolveLsp()
      }
      if (!lsp || !lsp.isRunning()) {
        const runtimeErrors = getCanvasRuntimeErrors()
        if (runtimeErrors.length > 0) {
          const errors = runtimeErrors.map((e) => `[${e.phase}] ${e.error}`)
          clearCanvasRuntimeErrors()
          return textResult({
            ok: false,
            error: 'Language server not available.',
            runtimeErrors: errors,
            causeBreakdown: { runtime: errors.length },
          })
        }
        // The tool itself couldn't produce diagnostics — that's an
        // infra/environment condition, not evidence about the model's code.
        return textResult({
          ok: false,
          error:
            'Language server still starting after waiting; type-checking unavailable this turn. Verify with `exec` running `bunx tsc --noEmit` (or the project build) instead, then retry read_lints shortly.',
          causeBreakdown: { environment: 1 },
        })
      }

      const { path: filePath } = params as { path?: string }

      // Determine auto-scope: if no explicit path, and the agent has edited
      // lintable files this turn, focus diagnostics on those files only.
      const editedThisTurn = filePath ? [] : (ctx.fileStateCache?.getEditedThisTurn() ?? [])
      const autoScopedPaths = editedThisTurn.length > 0 ? editedThisTurn : null

      const workspacePrefix = `file://${ctx.workspaceDir}/`
      const targetUri = filePath ? `file://${assertWithinWorkspace(ctx.workspaceDir, filePath, pathPolicy(ctx))}` : undefined

      await new Promise((resolve) => setTimeout(resolve, 1500))

      let allDiags: Map<string, import('@shogo/shared-runtime').LSPDiagnostic[]>
      if (autoScopedPaths) {
        // Query each edited file individually so we don't pay for unrelated open files.
        allDiags = new Map()
        for (const rel of autoScopedPaths) {
          const uri = `file://${assertWithinWorkspace(ctx.workspaceDir, rel)}`
          const perFile = await lsp.getDiagnosticsAsync(uri)
          for (const [u, diags] of perFile) {
            allDiags.set(u, diags)
          }
          if (!allDiags.has(uri)) {
            // Ensure the file shows up even when it has zero diagnostics,
            // so the agent sees an explicit "ok" for files it just edited.
            allDiags.set(uri, [])
          }
        }
      } else {
        allDiags = await lsp.getDiagnosticsAsync(targetUri)
      }

      // -----------------------------------------------------------------
      // Hardcoded-port scan: rewrites known runtime-port URLs to
      // `${process.env.<VAR>}` interpolations, errors on `.py` hits,
      // warns on any other localhost:<port>. Runs on the same URIs the
      // tool was already considering this turn.
      // -----------------------------------------------------------------
      const urisToScan = new Set<string>(allDiags.keys())
      if (targetUri) urisToScan.add(targetUri)
      if (autoScopedPaths) {
        for (const rel of autoScopedPaths) {
          urisToScan.add(`file://${assertWithinWorkspace(ctx.workspaceDir, rel)}`)
        }
      }

      const portFixesByFile: Array<{ path: string; fixes: PortFix[] }> = []
      const portWarningsByFile: Array<{
        path: string
        warnings: PortWarning[]
      }> = []
      const portErrorsByFile = new Map<string, string[]>()

      for (const uri of urisToScan) {
        if (!uri.startsWith('file://')) continue
        const absPath = uri.slice('file://'.length)
        // Normalize to forward slashes so the relative-path comparison works
        // regardless of which separator the URI was built with (the existing
        // URI plumbing isn't strict about separators on Windows).
        let relPath: string
        try {
          relPath = relative(ctx.workspaceDir, absPath).replace(/\\/g, '/')
        } catch {
          continue
        }
        if (!relPath || relPath.startsWith('..')) continue
        if (!LINTABLE_EXTENSION_RE.test(relPath)) continue
        if (relPath.endsWith('.d.ts') || relPath.endsWith('.pyi')) continue

        let content: string
        try {
          content = readFileSync(absPath, 'utf-8')
        } catch {
          continue
        }

        const scan = scanFileForHardcodedPorts(relPath, content)
        if (scan.newContent !== undefined) {
          try {
            writeFileSync(absPath, scan.newContent, 'utf-8')
            ctx.lspManager?.notifyFileChanged(absPath, scan.newContent)
          } catch {
            // Best-effort; still report the fixes we computed.
          }
          portFixesByFile.push({ path: relPath, fixes: scan.fixes })
        }
        if (scan.warnings.length > 0) {
          portWarningsByFile.push({ path: relPath, warnings: scan.warnings })
        }
        if (scan.errors.length > 0) {
          portErrorsByFile.set(
            relPath,
            scan.errors.map((e) => `Line ${e.line}: hardcoded runtime port — ${e.reason}`),
          )
        }
      }

      // Collect canvas runtime errors (compile/render failures from the live preview)
      const runtimeErrorEntries = getCanvasRuntimeErrors()
      const runtimeErrors = runtimeErrorEntries.length > 0 ? runtimeErrorEntries.map((e) => `[${e.phase}] ${e.error}`) : undefined
      if (runtimeErrorEntries.length > 0) clearCanvasRuntimeErrors()

      const scopeMeta = autoScopedPaths ? { auto_scoped: true as const, scoped_to: autoScopedPaths } : {}

      const portMeta = {
        ...(portFixesByFile.length > 0 ? { port_fixes: portFixesByFile } : {}),
        ...(portWarningsByFile.length > 0 ? { port_warnings: portWarningsByFile } : {}),
      }
      const fixesHint =
        portFixesByFile.length > 0
          ? (() => {
              const n = portFixesByFile.reduce((acc, f) => acc + f.fixes.length, 0)
              return `Rewrote ${n} hardcoded runtime-port URL(s) to \`\${process.env.<VAR>}\` interpolations. Verify the change looks correct.`
            })()
          : null

      if (allDiags.size === 0 && portErrorsByFile.size === 0) {
        if (runtimeErrors) {
          return textResult({
            ok: false,
            ...scopeMeta,
            ...portMeta,
            runtimeErrors,
            hint: 'Canvas runtime errors detected. Check your canvas code for the issues above.',
            causeBreakdown: { runtime: runtimeErrors.length },
          })
        }
        return textResult({
          ok: true,
          ...scopeMeta,
          ...portMeta,
          ...(fixesHint ? { hint: fixesHint } : {}),
          message: filePath
            ? `No errors in ${filePath}`
            : autoScopedPaths
              ? `No errors in files you edited this turn (${autoScopedPaths.join(', ')}).`
              : 'No errors found.',
        })
      }

      const TS_RETURN_OUTSIDE_FN = 1108
      let totalErrors = 0
      const files: Array<{
        path: string
        ok: boolean
        errors: string[]
        causes: LintErrorCause[]
      }> = []
      // Aggregate cause counts across every file, surfaced as `causeBreakdown`
      // on the final result — the single field evals/production telemetry
      // read to tell "environment noise" apart from "the model's mistake"
      // without re-parsing message strings themselves.
      const causeCounts: Partial<Record<LintErrorCause, number>> = {}
      const tallyCause = (cause: LintErrorCause, count = 1) => {
        causeCounts[cause] = (causeCounts[cause] ?? 0) + count
      }

      for (const [uri, diags] of allDiags) {
        // Use the same separator-tolerant relativization as the port scan so
        // entries always agree when merging LSP + port diagnostics.
        let relPath: string
        if (uri.startsWith('file://')) {
          const absFromUri = uri.slice('file://'.length)
          try {
            const rel = relative(ctx.workspaceDir, absFromUri).replace(/\\/g, '/')
            relPath = !rel || rel.startsWith('..') ? uri : rel
          } catch {
            relPath = uri
          }
        } else {
          relPath = uri.startsWith(workspacePrefix) ? uri.slice(workspacePrefix.length) : uri
        }
        if (relPath.endsWith('.d.ts') || relPath.endsWith('.pyi')) continue

        const filteredDiags = diags.filter((d) => (d.severity ?? 1) === 1).filter((d) => d.code !== TS_RETURN_OUTSIDE_FN)
        const errors = filteredDiags.map((d) => `Line ${d.range.start.line + 1}: ${d.message}`)
        const errorCauses = filteredDiags.map((d) => classifyLintErrorCause(d.message, ctx.depsReady))

        const portErrors = portErrorsByFile.get(relPath) ?? []
        // Hardcoded-port issues are always something the model wrote —
        // never environment noise.
        const portErrorCauses: LintErrorCause[] = portErrors.map(() => 'model_diagnostic')

        const combined = [...errors, ...portErrors]
        const combinedCauses = [...errorCauses, ...portErrorCauses]
        if (combined.length === 0) continue
        totalErrors += combined.length
        for (const cause of combinedCauses) tallyCause(cause)
        files.push({
          path: relPath,
          ok: false,
          errors: combined,
          causes: combinedCauses,
        })
        portErrorsByFile.delete(relPath)
      }
      // Files that only had port errors (no LSP diags at all) still need to land.
      for (const [relPath, portErrors] of portErrorsByFile) {
        totalErrors += portErrors.length
        const causes: LintErrorCause[] = portErrors.map(() => 'model_diagnostic')
        for (const cause of causes) tallyCause(cause)
        files.push({ path: relPath, ok: false, errors: portErrors, causes })
      }

      if (files.length === 0) {
        if (runtimeErrors) {
          return textResult({
            ok: false,
            ...scopeMeta,
            ...portMeta,
            runtimeErrors,
            hint: 'Canvas runtime errors detected. Check your canvas code for the issues above.',
            causeBreakdown: { runtime: runtimeErrors.length },
          })
        }
        return textResult({
          ok: true,
          ...scopeMeta,
          ...portMeta,
          ...(fixesHint ? { hint: fixesHint } : {}),
          message: filePath
            ? `No errors in ${filePath}`
            : autoScopedPaths
              ? `No errors in files you edited this turn (${autoScopedPaths.join(', ')}).`
              : 'No errors found.',
        })
      }

      if (runtimeErrors) tallyCause('runtime', runtimeErrors.length)

      const allOk = totalErrors === 0 && !runtimeErrors
      const baseHint = allOk ? null : 'Fix the errors above using edit_file, then run read_lints again to verify.'
      const hint = [fixesHint, baseHint].filter(Boolean).join(' ') || undefined
      return textResult({
        ok: allOk,
        ...scopeMeta,
        ...portMeta,
        files,
        ...(Object.keys(causeCounts).length > 0 ? { causeBreakdown: causeCounts } : {}),
        ...(runtimeErrors ? { runtimeErrors } : {}),
        ...(hint ? { hint } : {}),
      })
    },
  }
}
