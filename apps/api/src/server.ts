// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { csrf } from 'hono/csrf'
import { secureHeaders } from 'hono/secure-headers'
import { bodyLimit } from 'hono/body-limit'
import Stripe from 'stripe'
import { generateText, createUIMessageStream, createUIMessageStreamResponse, type ModelMessage } from 'ai'
import { z } from 'zod'
import { EventEmitter } from 'events'
import type { SubagentProgressEvent, VirtualToolEvent } from './types/progress'
// isVirtualTool kept in types/progress.ts for client-side use (ChatPanel handler)
import type { SubagentStartHookInput, SubagentStopHookInput, PostToolUseHookInput, PreToolUseHookInput, CanUseTool, SDKSession, SDKMessage, SDKSessionOptions, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { createSdkMcpServer, tool as sdkTool, unstable_v2_createSession, unstable_v2_resumeSession } from '@anthropic-ai/claude-agent-sdk'
import { createAnthropic } from '@ai-sdk/anthropic'
import { resolve, join, isAbsolute } from 'path'
import { fileURLToPath } from 'url'
import { readdir, stat, mkdir, appendFile } from 'fs/promises'
import { existsSync, mkdirSync, cpSync, rmSync, writeFileSync } from 'fs'
import { auth } from './auth'
import { getPriceId } from './config/stripe-prices'
import { getCurrencyForCountry, formatPrice, SUPPORTED_CURRENCIES } from './config/currencies'
import { getExchangeRates, convertPrice } from './services/exchange-rate.service'
// processInterleavedStream no longer needed — V2 SDK handles streaming natively
import * as billingService from './services/billing.service'
import {
  sendPlanUpgradedEmail, sendPaymentReceiptEmail, sendPaymentFailedEmail,
  sendInvitationEmail, sendProjectInviteEmail, sendInviteAcceptedEmail,
  sendMemberJoinedEmail, sendMemberRemovedEmail, sendAccountDeletedEmail,
} from './services/email.service'
import * as workspaceService from './services/workspace.service'
import { publishRoutes } from './routes/publish'
import { runtimeRoutes } from './routes/runtime'
import { filesRoutes } from './routes/files'
import { projectChatRoutes } from './routes/project-chat'
import { projectAdminRoutes } from './routes/project-admin'
import { terminalRoutes } from './routes/terminal'
import { testsRoutes } from './routes/tests'
import { securityRoutes } from './routes/security'
import { databaseRoutes, stopAllPrismaStudios } from './routes/database'
import { checkpointRoutes } from './routes/checkpoints'
import { thumbnailRoutes } from './routes/thumbnail'
import { githubRoutes } from './routes/github'
import { aiProxyRoutes } from './routes/ai-proxy'
import { toolsProxyRoutes } from './routes/tools-proxy'
import { calculateCreditCost } from './lib/credit-cost'
import { openSession as openBillingSession, closeSession as closeBillingSession } from './lib/proxy-billing-session'
import { adminRoutes, userAttributionRoute } from './routes/admin'
import { scopedAnalyticsRoutes } from './routes/scoped-analytics'
import { integrationRoutes } from './routes/integrations'
import { agentTemplateRoutes } from './routes/agent-templates'
import { evalOutputRoutes } from './routes/eval-outputs'
import { evalAdminRoutes, evalInternalRoutes } from './routes/eval-admin'
import { apiKeyRoutes } from './routes/api-keys'
import { instanceRoutes, authenticateInstanceWs, handleInstanceWsOpen, handleInstanceWsMessage, handleInstanceWsClose, startTunnelHeartbeat } from './routes/instances'
import internalRoutes from './routes/internal'
import { requireSuperAdmin } from './middleware/super-admin'
// Generated admin CRUD routes (unrestricted, middleware-protected)
import { createAdminRoutes } from './generated/admin-routes'
// Note: Manual routes (workspaces, projects, folders, starred) removed in favor of generated v2 routes
import { createRuntimeManager, type IRuntimeManager } from './lib/runtime'
// Generated routes (v2 API)
import { createGeneratedRoutes } from './generated/routes'
import { routeHooks } from './generated/hooks'
import { prisma } from './lib/prisma'
// Auth middleware for generated routes
import { authMiddleware, requireAuth, requireProjectAccess } from './middleware/auth'
import { tracingMiddleware } from './middleware/tracing'
import { rateLimiter } from './middleware/rate-limit'

// Runtime manager singleton for project Vite runtimes
let runtimeManager: IRuntimeManager | null = null

// Environment detection - check if running in Kubernetes
const isKubernetes = () => !!process.env.KUBERNETES_SERVICE_HOST

// Namespace for project runtime pods (configurable for staging/production)
const PROJECT_NAMESPACE = process.env.PROJECT_NAMESPACE || 'shogo-workspaces'

// Active proxy connection tracking for graceful shutdown draining
let activeProxyConnections = 0
let isShuttingDown = false


/**
 * Extract the authenticated user from the request via Better Auth session.
 * Returns the userId or null if unauthenticated.
 * Retries once on transient failures (DB hiccup, connection pool exhaustion).
 */
async function getAuthUserId(c: any): Promise<string | null> {
  // Check middleware-resolved auth first (works for both API keys and sessions)
  const middlewareAuth = c.get('auth')
  if (middlewareAuth?.isAuthenticated && middlewareAuth.userId) {
    return middlewareAuth.userId
  }

  // Fall back to Better Auth session lookup
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const session = await auth.api.getSession({ headers: c.req.raw.headers })
      if (!session?.user?.id) {
        const hasCookie = c.req.header('cookie')?.includes('better-auth.session_token')
        if (hasCookie) {
          console.warn('[Auth] Session cookie present but session invalid/expired')
        }
        return null
      }
      return session.user.id
    } catch (err: any) {
      if (attempt === 0) {
        console.warn(`[Auth] getAuthUserId transient failure, retrying: ${err.message}`)
        await new Promise(r => setTimeout(r, 200))
        continue
      }
      console.error(`[Auth] getAuthUserId failed after retry: ${err.message}`)
      return null
    }
  }
  return null
}

/**
 * Verify that the authenticated user is a member of the given workspace.
 * Returns the userId on success, or null if not a member / not authenticated.
 */
async function verifyWorkspaceMembership(c: any, workspaceId: string): Promise<string | null> {
  const auth = c.get('auth') as any
  const userId = auth?.userId
  if (!userId) return null
  const member = await prisma.member.findFirst({
    where: { userId, workspaceId },
  })
  return member ? userId : null
}

/**
 * Verify that a user has access to a project via workspace membership.
 * Returns the project's workspaceId if access is granted, null otherwise.
 */
async function verifyProjectAccess(userId: string, projectId: string): Promise<string | null> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { workspaceId: true },
  })
  if (!project) {
    console.warn(`[Auth] verifyProjectAccess: project ${projectId} not found`)
    return null
  }

  const member = await prisma.member.findFirst({
    where: { userId, workspaceId: project.workspaceId },
  })
  if (!member) {
    console.warn(`[Auth] verifyProjectAccess: user ${userId} not a member of workspace ${project.workspaceId} (project ${projectId})`)
  }
  return member ? project.workspaceId : null
}

/**
 * Get or create the RuntimeManager singleton.
 *
 * Configurable via environment variables:
 * - RUNTIME_MAX_COUNT: Maximum concurrent runtimes (default: 10)
 * - RUNTIME_DOMAIN_SUFFIX: Domain suffix for URLs (default: localhost)
 * - WORKSPACES_DIR: Directory containing project workspaces (default: PROJECT_ROOT/workspaces)
 */
function getRuntimeManager(): IRuntimeManager {
  if (!runtimeManager) {
    const workspacesDir = process.env.WORKSPACES_DIR || resolve(PROJECT_ROOT, 'workspaces')
    runtimeManager = createRuntimeManager({
      maxRuntimes: parseInt(process.env.RUNTIME_MAX_COUNT || '10', 10),
      domainSuffix: process.env.RUNTIME_DOMAIN_SUFFIX || 'localhost',
      workspacesDir,
      templateDir: '_template',
    })
    console.log('[Runtime] RuntimeManager initialized:', {
      portRange: '37100-37900 (random)',
      maxRuntimes: process.env.RUNTIME_MAX_COUNT || '10',
      domainSuffix: process.env.RUNTIME_DOMAIN_SUFFIX || 'localhost',
      workspacesDir,
    })
  }
  return runtimeManager
}

/**
 * Parse a data URL to extract mediaType and base64 data.
 * Example: "data:image/png;base64,iVBORw0..." -> { mediaType: "image/png", base64Data: "iVBORw0..." }
 *
 * task-api-convert-images: Helper for image part conversion
 */
function parseDataUrl(dataUrl: string): { mimeType: string; base64Data: string } | null {
  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/)
  if (!match) return null
  return { mimeType: match[1], base64Data: match[2] }
}

/**
 * Convert UIMessage format (from @ai-sdk/react v3) to ModelMessage format (for streamText).
 *
 * UIMessage uses `parts` array: { parts: [{ type: "text", text: "..." }], role, id }
 * ModelMessage uses `content` string or array: { role, content: "..." | Array<TextPart | ImagePart> }
 *
 * chat-session-sync-fix: Required because v3 sendMessage() sends UIMessage format,
 * but streamText() expects ModelMessage format.
 *
 * task-api-convert-images: Extended to handle file parts with image mediaTypes.
 * File parts with image/* mediaType are converted to ImagePart format for Claude API.
 */
function convertUIMessagesToModelMessages(messages: any[]): ModelMessage[] {
  return messages.map((msg) => {
    // If message already has content string (ModelMessage format), pass through
    if (typeof msg.content === 'string') {
      return { role: msg.role, content: msg.content }
    }

    // If message has parts array (UIMessage format), process all part types
    if (Array.isArray(msg.parts)) {
      const contentParts: Array<
        | { type: 'text'; text: string }
        | { type: 'image'; image: string; mimeType: string }
        | { type: 'file'; data: string; mimeType: string }
      > = []

      for (const part of msg.parts) {
        if (part.type === 'text' && part.text) {
          contentParts.push({ type: 'text', text: part.text })
        } else if (part.type === 'file' && part.url) {
          const parsed = parseDataUrl(part.url)
          if (!parsed) continue

          if (part.mediaType?.startsWith('image/')) {
            contentParts.push({
              type: 'image',
              image: parsed.base64Data,
              mimeType: parsed.mimeType,
            })
          } else {
            contentParts.push({
              type: 'file',
              data: parsed.base64Data,
              mimeType: parsed.mimeType,
            })
          }
        }
      }

      // If we only have text parts, return as simple string (backward compatible)
      if (contentParts.length === 1 && contentParts[0].type === 'text') {
        return { role: msg.role, content: contentParts[0].text }
      }

      // If we have mixed content (text + images/files), return as array
      if (contentParts.length > 0) {
        return { role: msg.role, content: contentParts }
      }

      // Fallback: empty content
      return { role: msg.role, content: '' }
    }

    // Fallback: return as-is (may fail validation, but better than silent data loss)
    return { role: msg.role, content: msg.content ?? '' }
  })
}

// Port configuration from environment (supports multi-worktree isolation)
const API_PORT = parseInt(process.env.API_PORT || '8002', 10)
const VITE_PORT = parseInt(process.env.VITE_PORT || '3000', 10)

// Get the frontend URL for redirects (Stripe checkout, etc.)
// Priority: APP_URL > first ALLOWED_ORIGINS > localhost fallback
const getFrontendUrl = (): string => {
  if (process.env.APP_URL) {
    return process.env.APP_URL
  }
  const allowedOrigins = process.env.ALLOWED_ORIGINS
  if (allowedOrigins) {
    const firstOrigin = allowedOrigins.split(',')[0]?.trim()
    if (firstOrigin) {
      return firstOrigin
    }
  }
  return `http://localhost:${VITE_PORT}`
}

// Compute project root from this file's location
// This file is at: apps/api/src/server.ts
// Project root is 3 levels up
const __filename = fileURLToPath(import.meta.url)
const PROJECT_ROOT = resolve(__filename, '../../../../')

// Progress event emitter for streaming subagent updates (task-subagent-progress-streaming)
const progressEvents = new EventEmitter()

// Virtual tool event emitter for streaming client-side execution instructions
// (virtual-tools-domain Phase 0 PoC)
const virtualToolEvents = new EventEmitter()

// streamCompletionEvents removed — V2 SDK session.stream() naturally completes per turn

// Debug logging prefix for subagent progress
const LOG_PREFIX = '[SubagentProgress]'
const VT_LOG_PREFIX = '[VirtualTool]'

// Create SDK MCP server for virtual tools (in-process, call-site defined)
// These tools execute in our API server process and emit events for client-side effects
const virtualToolsServer = createSdkMcpServer({
  name: 'virtual-tools',
  version: '1.0.0',
  tools: [
    // set_workspace: Declaratively set workspace state (v2 architecture)
    // Client handler updates workspace Composition entity based on desired state
    // NOTE: Using z.any() for complex nested types to avoid SDK schema validation issues
    sdkTool(
      'set_workspace',
      'Set the workspace to a desired state. Describe what panels should be visible and how configured. Use for showing schemas, splitting layouts, or any workspace changes. Each panel has: slot (string: "main", "left", "right", "sidebar"), section (string: "DesignContainerSection", "WorkspaceBlankStateSection"), and optional config object (e.g., { schemaName: "platform-features" }).',
      {
        layout: z.enum(['single', 'split-h', 'split-v']).optional()
          .describe('Layout mode for the workspace'),
        panels: z.array(z.any())
          .describe('Array of panel objects with slot, section, and optional config'),
      },
      async (args) => {
        console.log(`${VT_LOG_PREFIX} 🎯 SDK tool handler executing set_workspace:`, args)

        const event: VirtualToolEvent = {
          type: 'virtual-tool-execute',
          toolUseId: `vt-${Date.now()}`,
          toolName: 'set_workspace',
          args: args as Record<string, unknown>,
          timestamp: Date.now(),
        }
        virtualToolEvents.emit('virtual-tool', event)
        console.log(`${VT_LOG_PREFIX} ✅ Emitted set_workspace virtual tool event`)

        return {
          content: [{
            type: 'text',
            text: `Workspace updated with ${args.panels?.length ?? 0} panel(s)`
          }]
        }
      }
    ),
    // execute: Generic domain operations (v2 architecture)
    // For schema operations, calls MCP directly and returns real result
    // For other operations, emits events for client-side execution
    // NOTE: Using z.any() for complex nested types to avoid SDK schema validation issues
    sdkTool(
      'execute',
      'Execute state operations on the client. Use for creating/updating/deleting entities across domains. Each operation has: domain ("component-builder"|"studio-chat"), action ("create"|"update"|"delete"), model (string like "Composition", "ChatSession"), optional id (required for update/delete), and data object.',
      {
        operations: z.array(z.any())
          .describe('Array of operation objects with domain, action, model, optional id, and data'),
      },
      async (args) => {
        console.log(`${VT_LOG_PREFIX} 🎯 SDK tool handler executing execute:`, args)

        const clientOps = args.operations ?? []

        // Emit event for client-side operations (if any)
        if (clientOps.length > 0) {
          const event: VirtualToolEvent = {
            type: 'virtual-tool-execute',
            toolUseId: `vt-${Date.now()}`,
            toolName: 'execute',
            args: { operations: clientOps } as Record<string, unknown>,
            timestamp: Date.now(),
          }
          virtualToolEvents.emit('virtual-tool', event)
          console.log(`${VT_LOG_PREFIX} ✅ Emitted execute virtual tool event for ${clientOps.length} client ops`)
        }

        return {
          content: [{
            type: 'text',
            text: `Executed ${args.operations?.length ?? 0} operation(s)${clientOps.length > 0 ? ` (${clientOps.length} sent to client)` : ''}`
          }]
        }
      }
    ),
  ]
})

// Get workspaces directory for project-scoped operations
const WORKSPACES_DIR = process.env.WORKSPACES_DIR || resolve(PROJECT_ROOT, 'workspaces')

// CanUseTool type is imported from @anthropic-ai/claude-agent-sdk

/**
 * Create a canUseTool callback that restricts file operations to projectDir.
 * This prevents the agent from accessing files outside the project workspace,
 * ensuring proper filesystem isolation for user projects.
 *
 * @param projectDir - The absolute path to the project workspace directory
 * @returns A canUseTool callback function for use with createClaudeCode
 */
function createProjectPathRestrictor(projectDir: string): CanUseTool {
  // Tools that operate on filesystem paths
  const FILE_TOOLS = ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'LS']
  // Normalize project directory (ensure no trailing slash for consistent comparison)
  const normalizedProjectDir = projectDir.endsWith('/') ? projectDir.slice(0, -1) : projectDir

  return async (toolName, input, _options) => {
    console.log(`[canUseTool] *** CALLBACK INVOKED for tool: ${toolName}, input: ${JSON.stringify(input).slice(0, 200)}`)
    // Only check file operation tools
    if (!FILE_TOOLS.includes(toolName)) {
      console.log(`[canUseTool] Tool ${toolName} is not a file tool, allowing`)
      return { behavior: 'allow' }
    }

    // Extract path from tool input (different tools use different field names)
    const inputPath = (input.file_path || input.path || input.directory) as string | undefined

    if (!inputPath) {
      // No path = allow (tool will handle missing params)
      return { behavior: 'allow' }
    }

    // Determine the absolute path to check
    let absolutePath: string
    if (isAbsolute(inputPath)) {
      // Absolute path - use directly (don't resolve against projectDir)
      absolutePath = inputPath
    } else {
      // Relative path - resolve against projectDir
      absolutePath = resolve(normalizedProjectDir, inputPath)
    }

    // Normalize the absolute path (resolve .. and .)
    absolutePath = resolve(absolutePath)

    // Check if path is within project directory
    // Path is valid if it equals projectDir or starts with projectDir/
    const isWithinProject =
      absolutePath === normalizedProjectDir ||
      absolutePath.startsWith(`${normalizedProjectDir}/`)

    if (!isWithinProject) {
      console.warn(`[ClaudeCode] Blocked ${toolName} access outside project: ${inputPath} -> ${absolutePath}`)
      return {
        behavior: 'deny',
        message: `Access denied: Cannot access files outside the project workspace. Path "${inputPath}" resolves to "${absolutePath}" which is outside "${normalizedProjectDir}". Use relative paths within the project directory.`
      }
    }

    return { behavior: 'allow' }
  }
}

/**
 * Create Claude Code provider with optional project-scoped working directory.
 * When projectId is provided, cwd is set to the project's workspace directory.
 * This enables the code agent to read/write files in the correct project.
 *
 * For project-scoped sessions, file operations are restricted to the project
 * workspace via canUseTool callback. This prevents the agent from accessing
 * files outside the project directory (e.g., the Shogo platform codebase).
 */
// =============================================================================
// V2 Agent SDK Session Management
// =============================================================================
// Uses the V2 session-based API from @anthropic-ai/claude-agent-sdk.
// Sessions persist across HTTP requests, keeping the CLI subprocess alive.
// This eliminates the 7-12s cold start overhead per message.
//
// Architecture:
//   createSession() → session.send(msg) → session.stream() → convert to UIMessageStream
//   Session persists between requests (no subprocess respawn)
//
// The V2 SDKSessionOptions type is incomplete (preview API), but the runtime
// accepts all V1 QueryOptions properties. We extend the type to include them.

/** V1 QueryOptions fields that V2 runtime accepts but aren't yet typed */
interface ExtendedSessionOptions extends SDKSessionOptions {
  cwd?: string
  mcpServers?: Record<string, any>
  settingSources?: string[]
  allowDangerouslySkipPermissions?: boolean
  includePartialMessages?: boolean
  persistSession?: boolean
}

// Shared allowedTools list for all sessions
const ALLOWED_TOOLS = [
  // Virtual tools (SDK MCP server - uses mcp__servername__toolname format)
  'mcp__virtual-tools__set_workspace',
  'mcp__virtual-tools__execute',
  // File operations
  'Read', 'Write', 'Edit', 'Glob', 'Grep', 'LS',
  // Skill and agent tools
  'Skill', 'Task', 'Bash', 'TodoWrite',
]

// Shared hooks for all sessions (emit to module-level EventEmitters)
const SESSION_HOOKS = {
  SubagentStart: [{
    hooks: [async (rawInput: unknown) => {
      const input = rawInput as SubagentStartHookInput
      console.log(`${LOG_PREFIX} 🚀 HOOK SubagentStart fired:`, {
        agentId: input.agent_id,
        agentType: input.agent_type,
      })
      progressEvents.emit('progress', {
        type: 'subagent-start',
        agentId: input.agent_id,
        agentType: input.agent_type,
        timestamp: Date.now(),
      } satisfies SubagentProgressEvent)
      return { continue: true }
    }]
  }],
  SubagentStop: [{
    hooks: [async (rawInput: unknown) => {
      const input = rawInput as SubagentStopHookInput
      console.log(`${LOG_PREFIX} 🛑 HOOK SubagentStop fired:`, { agentId: input.agent_id })
      progressEvents.emit('progress', {
        type: 'subagent-stop',
        agentId: input.agent_id,
        timestamp: Date.now(),
      } satisfies SubagentProgressEvent)
      return { continue: true }
    }]
  }],
  PostToolUse: [{
    hooks: [async (rawInput: unknown) => {
      const input = rawInput as PostToolUseHookInput
      if (input.tool_name.includes('mcp__') || input.tool_name === 'Skill' || input.tool_name === 'Task') {
        console.log(`${LOG_PREFIX} 🔧 HOOK PostToolUse:`, { toolName: input.tool_name })
      }
      progressEvents.emit('progress', {
        type: 'tool-complete',
        toolName: input.tool_name,
        toolUseId: input.tool_use_id,
        timestamp: Date.now(),
      } satisfies SubagentProgressEvent)

      return { continue: true }
    }]
  }],
}

/**
 * Build V2 session options for a given scope.
 * Includes all V1 QueryOptions needed for MCP servers, permissions, and hooks.
 */
function buildSessionOptions(projectId?: string): ExtendedSessionOptions {
  let cwd = PROJECT_ROOT
  let projectDir: string | null = null

  if (projectId) {
    const resolvedProjectDir = resolve(WORKSPACES_DIR, projectId)
    try {
      if (!existsSync(resolvedProjectDir)) {
        console.log(`[ClaudeCode] Creating workspace directory: ${resolvedProjectDir}`)
        mkdirSync(resolvedProjectDir, { recursive: true })
      }
      cwd = resolvedProjectDir
      projectDir = resolvedProjectDir
      console.log(`[ClaudeCode] Using project workspace: ${resolvedProjectDir}`)
    } catch (e) {
      console.error(`[ClaudeCode] Error creating/checking project workspace: ${e}`)
      console.warn(`[ClaudeCode] Falling back to project root (no path restriction)`)
    }
  }

  const pathRestrictor = projectDir ? createProjectPathRestrictor(projectDir) : undefined
  console.log(`[ClaudeCode] Building session options: cwd=${cwd}, pathRestricted=${!!pathRestrictor}`)

  return {
    model: 'claude-opus-4-20250514',
    cwd,
    canUseTool: pathRestrictor,
    settingSources: ['project', 'local'],
    // Include partial messages so we get streaming text deltas
    includePartialMessages: true,
    // MCP servers
    mcpServers: {
      'virtual-tools': virtualToolsServer,
    },
    // PERF: Keep this list minimal — each tool adds ~550-850 tokens of context
    allowedTools: ALLOWED_TOOLS,
    permissionMode: pathRestrictor ? 'default' : 'bypassPermissions',
    allowDangerouslySkipPermissions: !pathRestrictor,
    hooks: SESSION_HOOKS,
  } as ExtendedSessionOptions
}

// Session cache: persistent V2 sessions keyed by scope (projectId or '__platform__')
const sessionCache = new Map<string, SDKSession>()

/**
 * Get or create a persistent V2 session for the given scope.
 * Sessions persist across HTTP requests — the CLI subprocess stays alive,
 * eliminating the 7-12s cold start per message.
 */
// Track which sessions are actively handling a chat message
const activeSessions = new Set<string>()

function getOrCreateSession(scopeKey: string, projectId?: string): SDKSession {
  const existing = sessionCache.get(scopeKey)
  if (existing) {
    // Check if session is still alive (V2 session has a 'closed' property)
    if (!(existing as any).closed) {
      return existing
    }
    console.log(`[ClaudeCode] Session ${scopeKey} was closed, creating new one`)
    sessionCache.delete(scopeKey)
    activeSessions.delete(scopeKey)
  }

  const options = buildSessionOptions(projectId)
  const session = unstable_v2_createSession(options as any)
  sessionCache.set(scopeKey, session)
  console.log(`[ClaudeCode] Created V2 session for: ${scopeKey}`)
  return session
}

// =============================================================================
// Pre-warm: Create a V2 session and send a ping to initialize the CLI
// =============================================================================
// The first send() spawns the CLI subprocess, loads MCP servers, and establishes
// a session. By sending a lightweight ping at startup, we shift that cost
// from the user's first message to server boot time.
async function prewarmClaudeCode() {
  const scopeKey = '__platform__'
  const startTime = performance.now()

  // Skip prewarm if a chat is already using this session (race condition guard)
  if (activeSessions.has(scopeKey)) {
    console.log(`[ClaudeCode] ⏭️ Pre-warm skipped — session ${scopeKey} is already active`)
    return
  }

  console.log(`[ClaudeCode] 🔥 Pre-warming V2 session (platform)...`)
  try {
    const session = getOrCreateSession(scopeKey)

    // Double-check after session creation — a chat request might have arrived
    if (activeSessions.has(scopeKey)) {
      console.log(`[ClaudeCode] ⏭️ Pre-warm aborted — session ${scopeKey} became active`)
      return
    }

    activeSessions.add(scopeKey) // Mark as active during prewarm
    await session.send('ping')

    // Consume stream to completion (triggers CLI startup)
    let firstToken = false
    for await (const msg of session.stream()) {
      if (!firstToken && (msg.type === 'stream_event' || msg.type === 'assistant')) {
        const ttft = performance.now() - startTime
        console.log(`[ClaudeCode] 🔥 Pre-warm first response in ${(ttft / 1000).toFixed(2)}s`)
        firstToken = true
      }
      if (msg.type === 'result') break
    }
    activeSessions.delete(scopeKey) // Release after prewarm completes

    const elapsed = performance.now() - startTime
    console.log(`[ClaudeCode] ✅ Pre-warm complete in ${(elapsed / 1000).toFixed(2)}s — session is hot (id: ${session.sessionId})`)
  } catch (error: any) {
    activeSessions.delete(scopeKey) // Release on error too
    const elapsed = performance.now() - startTime
    console.error(`[ClaudeCode] ⚠️ Pre-warm failed after ${(elapsed / 1000).toFixed(2)}s:`, error.message)
    // Non-fatal — first real request will cold-start as before
  }
}

const app = new Hono()

// OpenTelemetry tracing — must be first middleware so all requests get spans
app.use('*', tracingMiddleware)

// Canvas HTML is loaded in an iframe from a different port — strip framing
// restrictions. Registered before secureHeaders so it wraps it and can remove
// headers on the way back out of the middleware onion.
app.use('/api/projects/:projectId/agent-proxy/canvas/*', async (c, next) => {
  await next()
  c.res.headers.delete('X-Frame-Options')
  c.res.headers.delete('Cross-Origin-Opener-Policy')
})

// Security headers — X-Content-Type-Options, X-Frame-Options, etc.
app.use('*', secureHeaders({
  xFrameOptions: 'SAMEORIGIN',
  xContentTypeOptions: 'nosniff',
  referrerPolicy: 'strict-origin-when-cross-origin',
  crossOriginOpenerPolicy: 'same-origin-allow-popups',
  crossOriginResourcePolicy: 'cross-origin',
}))

// Global request body size limit (10 MB default)
app.use('*', bodyLimit({ maxSize: 10 * 1024 * 1024 }))

// =============================================================================
// Global Error Handling
// =============================================================================
// Hono-level error handler: catches unhandled errors in route handlers and
// returns a structured JSON response instead of crashing the Bun process.
app.onError((err, c) => {
  console.error(`[API] Unhandled route error on ${c.req.method} ${c.req.path}:`, err.message)
  // Don't expose internal error details in production
  const isProduction = process.env.NODE_ENV === 'production'
  return c.json({
    error: {
      code: 'internal_error',
      message: isProduction ? 'An internal error occurred' : err.message,
    },
  }, 500)
})

// Process-level handlers: catch unhandled promise rejections and uncaught
// exceptions that escape Hono's error boundary. Log them instead of crashing.
process.on('unhandledRejection', (reason: any) => {
  // AbortSignal.timeout() DOMExceptions are noisy and expected during cold
  // starts / retries — log a single line instead of the full object.
  if (reason?.name === 'TimeoutError' || reason?.name === 'AbortError') {
    console.warn('[API] Suppressed timeout rejection:', reason.message)
    return
  }
  console.error('[API] Unhandled promise rejection:', reason?.message || reason)
  if (reason?.stack) {
    console.error('[API] Stack:', reason.stack)
  }
})

process.on('uncaughtException', (err: Error) => {
  console.error('[API] Uncaught exception:', err.message)
  if (err.stack) {
    console.error('[API] Stack:', err.stack)
  }
  // For truly fatal errors (OOM, etc.), still crash — but DB/network errors should not kill the process
})

// CORS origins from environment - supports comma-separated list
// Defaults to localhost for development
const getAllowedOrigins = (): string[] => {
  const envOrigins = process.env.ALLOWED_ORIGINS
  if (envOrigins) {
    return envOrigins.split(',').map(o => o.trim())
  }
  // Default: localhost on any port (dev mode) - allows playwright and vite
  return [`http://localhost:${VITE_PORT}`, 'http://localhost:*']
}

// Enable CORS for development and production
const allowedOrigins = getAllowedOrigins()
app.use('/*', cors({
  origin: (origin, c) => {
    // Webchat widget requests come from external websites — allow any origin
    const reqPath = new URL(c.req.url).pathname
    if (/\/api\/projects\/[^/]+\/agent-proxy\/agent\/channels\/webchat\//.test(reqPath)) {
      return origin || '*'
    }
    // Allow requests with no origin (mobile apps, curl, React Native on Android/iOS)
    if (!origin) return `http://localhost:${VITE_PORT}`
    const isDevOrLocal = process.env.NODE_ENV !== 'production' || process.env.SHOGO_LOCAL_MODE === 'true'
    // In dev/local mode, allow any localhost origin, custom protocols, and null origins (Electron custom scheme)
    if (isDevOrLocal && (origin === 'null' || origin?.startsWith('http://localhost:') || origin?.startsWith('shogo://'))) {
      return origin
    }
    // Allow local network origins in dev/local (React Native on physical devices)
    if (isDevOrLocal && /^http:\/\/192\.168\.\d+\.\d+/.test(origin)) {
      return origin
    }
    // Check if origin is in allowed list
    return allowedOrigins.includes(origin) ? origin : allowedOrigins[0]
  },
  credentials: true,
}))

// CSRF protection — validates Origin header on state-changing requests (POST/PUT/PATCH/DELETE).
// Skips webhook and internal endpoints that use their own auth (signatures, tokens).
app.use('/api/*', csrf({
  origin: (origin, c) => {
    // Webchat widget POST requests come from external websites
    const csrfPath = new URL(c.req.url).pathname
    if (/\/api\/projects\/[^/]+\/agent-proxy\/agent\/channels\/webchat\//.test(csrfPath)) {
      return true
    }
    // Allow requests with no origin (server-to-server, mobile apps, curl)
    if (!origin) return true
    const isDevOrLocal = process.env.NODE_ENV !== 'production' || process.env.SHOGO_LOCAL_MODE === 'true'
    if (isDevOrLocal && (origin === 'null' || origin.startsWith('http://localhost:') || origin.startsWith('shogo://'))) {
      return true
    }
    if (isDevOrLocal && /^http:\/\/192\.168\.\d+\.\d+/.test(origin)) {
      return true
    }
    return allowedOrigins.includes(origin)
  },
}))

// Rate limiting — applied per-route group for different thresholds.
// Defaults can be overridden via RATE_LIMIT_*_MAX and RATE_LIMIT_*_WINDOW_MS env vars.
app.use('/api/auth/*', rateLimiter('auth', { max: Number(process.env.RATE_LIMIT_AUTH_MAX) || 60, windowMs: Number(process.env.RATE_LIMIT_AUTH_WINDOW_MS) || 60_000 }))
app.use('/api/webhooks/*', rateLimiter('webhooks', { max: Number(process.env.RATE_LIMIT_WEBHOOKS_MAX) || 90, windowMs: Number(process.env.RATE_LIMIT_WEBHOOKS_WINDOW_MS) || 60_000 }))
app.use('/api/*', rateLimiter('global', {
  max: Number(process.env.RATE_LIMIT_GLOBAL_MAX) || 600,
  windowMs: Number(process.env.RATE_LIMIT_GLOBAL_WINDOW_MS) || 60_000,
  skipPrefixes: ['/api/ai/', '/api/internal/', '/api/health', '/api/warm-pool/status'],
}))

function isWebchatProxyPath(path: string): boolean {
  return /^\/api\/projects\/[^/]+\/agent-proxy\/agent\/channels\/webchat\//.test(path)
}

function isAllowedUnauthWebchatProxyPath(path: string): boolean {
  if (!isWebchatProxyPath(path)) return false
  const match = path.match(/^\/api\/projects\/[^/]+\/agent-proxy(\/agent\/channels\/webchat\/.*)$/)
  const relative = match?.[1] || ''
  return relative === '/agent/channels/webchat/widget.js' ||
    relative === '/agent/channels/webchat/health' ||
    relative === '/agent/channels/webchat/config' ||
    relative === '/agent/channels/webchat/session' ||
    relative === '/agent/channels/webchat/message' ||
    relative.startsWith('/agent/channels/webchat/events/')
}

// Auth middleware — extract session for ALL /api/* routes so c.get('auth') is
// always populated, then require authentication except for known public paths.
app.use('/api/*', authMiddleware)

app.use(
  '/api/*',
  async (c, next) => {
    const path = new URL(c.req.url).pathname
    const publicPrefixes = [
      '/api/auth/',
      '/api/health',
      '/api/version',
      '/api/config',
      '/api/webhooks/',
      '/api/integrations/',
      '/api/invite-links/',
      '/api/internal/',
      '/api/local/',
      '/api/ai/',
      '/api/tools/',
      '/api/api-keys/validate',
    ]
    if (publicPrefixes.some((p) => path.startsWith(p))) return next()
    if (isAllowedUnauthWebchatProxyPath(path)) return next()
    // Heartbeat sync is called by the runtime with x-runtime-token auth
    if (path.endsWith('/heartbeat/sync')) return next()
    return requireAuth(c, next)
  }
)
app.use('/api/projects/:projectId/*', async (c, next) => {
  const path = new URL(c.req.url).pathname
  if (isAllowedUnauthWebchatProxyPath(path)) {
    return next()
  }
  // Heartbeat sync uses runtime-token auth (called by the agent runtime)
  if (path.endsWith('/heartbeat/sync')) {
    return next()
  }
  return requireProjectAccess(c, next)
})

// Better Auth handler - mounted BEFORE other /api/* routes
// Handles all authentication endpoints: sign-up, sign-in, sign-out, session, OAuth callbacks, etc.
app.on(['GET', 'POST'], '/api/auth/*', (c) => auth.handler(c.req.raw))

// Health check
app.get('/api/health', (c) => c.json({ ok: true }))
app.get('/health', (c) => c.json({ ok: true }))

// Version endpoint for frontend update detection
app.get('/api/version', (c) => c.json({
  version: process.env.APP_VERSION || '0.0.0',
  buildHash: process.env.BUILD_HASH || 'dev',
}))

// OAuth callback for Composio integrations — registered before auth middleware
// so the page is always reachable (the browser has no session cookie).
app.get('/api/integrations/callback', (c) => {
  const callbackStatus = c.req.query('status') || 'success'
  const redirectParam = c.req.query('redirect')
  const ok = callbackStatus === 'success'

  console.info('[OAuth callback]', { status: callbackStatus, redirect: redirectParam ? '(present)' : '(none)' })

  // --- Determine redirect strategy ---
  // Custom schemes (shogo://, exp://) must use a JavaScript redirect so that
  // openAuthSessionAsync can intercept the navigation within the Custom Tab.
  // A 302 causes the OS to open the app via intent, bypassing the auth session.
  const isNativeRedirect = redirectParam
    && (redirectParam.startsWith('shogo://') || redirectParam.startsWith('exp://'))

  // Web redirect: validate same-origin to prevent open-redirect attacks.
  // Allowed origins: BETTER_AUTH_URL / API_URL / APP_URL env vars.
  let isWebRedirect = false
  if (redirectParam && !isNativeRedirect && (redirectParam.startsWith('http://') || redirectParam.startsWith('https://'))) {
    try {
      const redirectOrigin = new URL(redirectParam).origin
      const allowedOrigins = [
        process.env.BETTER_AUTH_URL,
        process.env.API_URL,
        process.env.APP_URL,
        process.env.EXPO_PUBLIC_API_URL,
      ]
        .filter(Boolean)
        .map((u) => { try { return new URL(u!).origin } catch { return null } })
        .filter(Boolean)
      // In production, API and app share the same origin (nginx proxy).
      // Also allow the request's own origin as a fallback.
      const requestOrigin = `${c.req.header('x-forwarded-proto') || 'https'}://${c.req.header('host')}`
      allowedOrigins.push(requestOrigin)
      isWebRedirect = allowedOrigins.includes(redirectOrigin)
      if (!isWebRedirect) {
        console.warn('[OAuth callback] Rejected web redirect to untrusted origin:', redirectOrigin)
      }
    } catch {
      console.warn('[OAuth callback] Invalid redirect URL:', redirectParam)
    }
  }

  const isAllowedRedirect = isNativeRedirect || isWebRedirect

  // For web redirects, use HTTP 302 (works in all browsers, no JS required).
  // For native redirects, use JS so openAuthSessionAsync can intercept.
  if (ok && isWebRedirect) {
    return c.redirect(redirectParam!, 302)
  }

  const redirectScript = ok && isNativeRedirect
    ? `window.location.href = ${JSON.stringify(redirectParam)};`
    : ''

  const successMessage = ok && isAllowedRedirect
    ? `<p>Redirecting back to Shogo...</p>
       <p style="margin-top:1rem"><a href="${redirectParam}" style="color:#4F46E5;text-decoration:underline">Tap here if you are not redirected</a></p>`
    : `<p>${ok ? 'You can close this window.' : 'Please close this window and try again.'}</p>`

  const html = `<!DOCTYPE html>
<html><head><style>
  body { font-family: -apple-system, system-ui, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; background: #fafafa; color: #333; }
  .card { text-align: center; padding: 2rem; }
  .icon { font-size: 3rem; margin-bottom: 0.5rem; }
  p { font-size: 0.9rem; color: #666; }
  a { color: #4F46E5; text-decoration: underline; }
</style></head><body>
  <div class="card">
    <div class="icon">${ok ? '✅' : '❌'}</div>
    <h3>${ok ? 'Connected!' : 'Connection failed'}</h3>
    ${successMessage}
  </div>
  <script>${redirectScript}${ok && !redirectScript ? 'setTimeout(function(){ window.close(); }, 1500);' : ''}</script>
</body></html>`
  return c.html(html)
})

// Platform config (tells frontend about local mode, enabled features, etc.)
app.get('/api/config', async (c) => {
  const localMode = process.env.SHOGO_LOCAL_MODE === 'true'
  let needsSetup = false
  const hasShogоApiKey = !!process.env.SHOGO_API_KEY
  if (localMode) {
    const userCount = await prisma.user.count()
    const hasAnthropicKey = !!process.env.ANTHROPIC_API_KEY
    const hasLocalLlm = !!process.env.LOCAL_LLM_BASE_URL
    needsSetup = userCount === 0 || (!hasAnthropicKey && !hasLocalLlm && !hasShogоApiKey)
  }
  return c.json({
    localMode,
    needsSetup,
    shogoKeyConnected: hasShogоApiKey,
    features: {
      billing: !localMode,
      admin: !localMode,
      oauth: !localMode,
      analytics: !localMode,
      publishing: !localMode,
    },
  })
})

// ── Local mode: auto-sign-in + API key management ───────────────────────────
if (process.env.SHOGO_LOCAL_MODE === 'true') {
  const localDb = prisma as any

  // Auto-sign-in: creates a session for the single local user without credentials.
  // Not gated by authMiddleware — this IS the auth mechanism for local mode.
  app.post('/api/local/auto-sign-in', async (c) => {
    try {
      const user = await prisma.user.findFirst()
      if (!user) {
        return c.json({ ok: false, error: 'No local user found. Server may still be initializing.' }, 503)
      }
      const storedPw = await localDb.localConfig.findUnique({ where: { key: 'local_user_password' } })
      if (!storedPw) {
        return c.json({ ok: false, error: 'Local user password not found in config.' }, 500)
      }
      const response = await auth.api.signInEmail({
        body: { email: user.email, password: storedPw.value },
        headers: c.req.raw.headers,
        asResponse: true,
      })
      return response
    } catch (err: any) {
      console.error('[LocalMode] Auto-sign-in failed:', err)
      return c.json({ ok: false, error: err?.message || String(err) }, 500)
    }
  })

  const API_KEY_NAMES = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GOOGLE_API_KEY'] as const

  app.get('/api/local/api-keys', async (c) => {
    try {
      const rows = await localDb.localConfig.findMany({
        where: { key: { in: [...API_KEY_NAMES] } },
      })
      const keys: Record<string, string> = {}
      for (const row of rows) {
        keys[row.key] = row.value.slice(0, 8) + '...' + row.value.slice(-4)
      }
      return c.json({ ok: true, keys })
    } catch {
      return c.json({ ok: true, keys: {} })
    }
  })

  app.put('/api/local/api-keys', async (c) => {
    const body = await c.req.json<{ anthropicApiKey?: string; openaiApiKey?: string; googleApiKey?: string }>()

    const keyMap: Array<[string | undefined, string]> = [
      [body.anthropicApiKey, 'ANTHROPIC_API_KEY'],
      [body.openaiApiKey, 'OPENAI_API_KEY'],
      [body.googleApiKey, 'GOOGLE_API_KEY'],
    ]

    const upserts: Promise<any>[] = []
    for (const [value, envKey] of keyMap) {
      if (value === undefined) continue
      if (value) {
        upserts.push(
          localDb.localConfig.upsert({
            where: { key: envKey },
            update: { value },
            create: { key: envKey, value },
          })
        )
        process.env[envKey] = value
      } else {
        upserts.push(localDb.localConfig.deleteMany({ where: { key: envKey } }))
        delete process.env[envKey]
      }
    }
    await Promise.all(upserts)

    return c.json({ ok: true })
  })

  // ── Local mode: LLM provider configuration ──────────────────────────────
  const LLM_CONFIG_KEYS = [
    'AI_MODE',
    'LOCAL_LLM_BASE_URL',
    'LOCAL_LLM_BASIC_MODEL',
    'LOCAL_LLM_ADVANCED_MODEL',
    'LOCAL_EMBEDDING_MODEL',
    'LOCAL_EMBEDDING_DIMENSIONS',
    'IMAGE_GEN_PROVIDER',
    'LOCAL_IMAGE_GEN_BASE_URL',
    'LOCAL_IMAGE_GEN_MODEL',
  ]

  app.get('/api/local/llm-config', async (c) => {
    try {
      const rows = await localDb.localConfig.findMany({
        where: { key: { in: LLM_CONFIG_KEYS } },
      })
      const config: Record<string, string> = {}
      for (const row of rows) config[row.key] = row.value
      return c.json({ ok: true, config })
    } catch {
      return c.json({ ok: true, config: {} })
    }
  })

  app.put('/api/local/llm-config', async (c) => {
    const body = await c.req.json<Record<string, string | null>>()
    const ops: Promise<any>[] = []
    for (const [key, value] of Object.entries(body)) {
      if (!LLM_CONFIG_KEYS.includes(key)) continue
      if (value) {
        ops.push(
          localDb.localConfig.upsert({
            where: { key },
            update: { value },
            create: { key, value },
          })
        )
        process.env[key] = value
      } else {
        ops.push(localDb.localConfig.deleteMany({ where: { key } }))
        delete process.env[key]
      }
    }
    await Promise.all(ops)
    return c.json({ ok: true })
  })

  // ── Local mode: model discovery ────────────────────────────────────────
  app.get('/api/local/models', async (c) => {
    const baseUrl = process.env.LOCAL_LLM_BASE_URL
    if (!baseUrl) {
      return c.json({ ok: false, error: 'No LLM base URL configured. Set LOCAL_LLM_BASE_URL first.', models: [] })
    }
    try {
      const res = await fetch(`${baseUrl.replace(/\/$/, '')}/v1/models`, {
        signal: AbortSignal.timeout(5000),
      })
      if (!res.ok) {
        return c.json({ ok: false, error: `LLM server returned ${res.status}`, models: [] })
      }
      const data = await res.json() as { data?: Array<{ id: string; object?: string }> }
      const models = (data.data || []).map((m) => ({ id: m.id, name: m.id }))
      return c.json({ ok: true, models })
    } catch (err: any) {
      return c.json({ ok: false, error: `Cannot reach LLM server: ${err.message}`, models: [] })
    }
  })

  // -------------------------------------------------------------------------
  // Security Preferences (local mode only)
  // -------------------------------------------------------------------------

  app.get('/api/local/security-prefs', async (c) => {
    try {
      const row = await localDb.localConfig.findUnique({ where: { key: 'SECURITY_PREFS' } })
      if (!row) {
        return c.json({ mode: 'full_autonomy', approvalTimeoutSeconds: 60 })
      }
      return c.json(JSON.parse(row.value))
    } catch (err: any) {
      return c.json({ error: err.message }, 500)
    }
  })

  app.post('/api/local/security-prefs', async (c) => {
    try {
      const body = await c.req.json<{
        mode?: string
        overrides?: Record<string, any>
        approvalTimeoutSeconds?: number
      }>()

      const validModes = ['strict', 'balanced', 'full_autonomy']
      if (body.mode && !validModes.includes(body.mode)) {
        return c.json({ error: `Invalid mode. Must be one of: ${validModes.join(', ')}` }, 400)
      }

      const value = JSON.stringify(body)
      await localDb.localConfig.upsert({
        where: { key: 'SECURITY_PREFS' },
        update: { value },
        create: { key: 'SECURITY_PREFS', value },
      })

      return c.json({ ok: true })
    } catch (err: any) {
      return c.json({ error: err.message }, 500)
    }
  })

  // ── Local mode: Shogo Cloud API key ──────────────────────────────────────
  const SHOGO_CLOUD_URL_DEFAULT = 'https://studio.shogo.ai'

  app.get('/api/local/shogo-key', async (c) => {
    try {
      const row = await localDb.localConfig.findUnique({ where: { key: 'SHOGO_API_KEY' } })
      const urlRow = await localDb.localConfig.findUnique({ where: { key: 'SHOGO_CLOUD_URL' } })
      const infoRow = await localDb.localConfig.findUnique({ where: { key: 'SHOGO_KEY_INFO' } })
      if (!row) {
        return c.json({ connected: false })
      }
      const keyMask = row.value.slice(0, 17) + '...' + row.value.slice(-4)
      let info: any = null
      try { info = infoRow ? JSON.parse(infoRow.value) : null } catch {}
      return c.json({
        connected: true,
        keyMask,
        cloudUrl: urlRow?.value || SHOGO_CLOUD_URL_DEFAULT,
        workspace: info?.workspace || null,
      })
    } catch {
      return c.json({ connected: false })
    }
  })

  app.put('/api/local/shogo-key', async (c) => {
    const body = await c.req.json<{ key: string; cloudUrl?: string }>()
    if (!body.key || !body.key.startsWith('shogo_sk_')) {
      return c.json({ ok: false, error: 'Invalid key format. Keys start with shogo_sk_' }, 400)
    }

    const storedCloudUrl = await localDb.localConfig.findUnique({ where: { key: 'SHOGO_CLOUD_URL' } }).then((r: any) => r?.value).catch(() => null)
    const cloudUrl = (body.cloudUrl || process.env.SHOGO_CLOUD_URL || storedCloudUrl || SHOGO_CLOUD_URL_DEFAULT).replace(/\/$/, '')
    const validateUrl = `${cloudUrl}/api/api-keys/validate`

    try {
      console.log(`[ShogoKey] Validating key against cloud: ${validateUrl}`)
      const validateRes = await fetch(validateUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: body.key }),
        signal: AbortSignal.timeout(10000),
      })
      let validateData: { valid: boolean; workspace?: any; error?: string }
      try {
        validateData = await validateRes.json()
      } catch {
        console.error(`[ShogoKey] Cloud returned non-JSON (HTTP ${validateRes.status})`)
        return c.json({ ok: false, error: `Shogo Cloud (${cloudUrl}) returned an unexpected response (HTTP ${validateRes.status})`, cloudUrl }, 502)
      }
      if (!validateData.valid) {
        console.error(`[ShogoKey] Cloud at ${cloudUrl} rejected key: ${validateData.error}`)
        return c.json({ ok: false, error: `${validateData.error || 'Key validation failed'} (validated against ${cloudUrl})`, cloudUrl }, 400)
      }

      await Promise.all([
        localDb.localConfig.upsert({
          where: { key: 'SHOGO_API_KEY' },
          update: { value: body.key },
          create: { key: 'SHOGO_API_KEY', value: body.key },
        }),
        localDb.localConfig.upsert({
          where: { key: 'SHOGO_CLOUD_URL' },
          update: { value: cloudUrl },
          create: { key: 'SHOGO_CLOUD_URL', value: cloudUrl },
        }),
        localDb.localConfig.upsert({
          where: { key: 'SHOGO_KEY_INFO' },
          update: { value: JSON.stringify({ workspace: validateData.workspace }) },
          create: { key: 'SHOGO_KEY_INFO', value: JSON.stringify({ workspace: validateData.workspace }) },
        }),
      ])

      process.env.SHOGO_API_KEY = body.key
      process.env.SHOGO_CLOUD_URL = cloudUrl

      // (Re)start instance tunnel with the new key
      import('./lib/instance-tunnel').then(({ stopInstanceTunnel, startInstanceTunnel }) => {
        stopInstanceTunnel()
        startInstanceTunnel()
      }).catch(() => {})

      return c.json({ ok: true, workspace: validateData.workspace })
    } catch (err: any) {
      console.error(`[ShogoKey] Failed to reach cloud at ${validateUrl}:`, err.message)
      return c.json({ ok: false, error: `Cannot reach Shogo Cloud at ${cloudUrl}: ${err.message}`, cloudUrl }, 502)
    }
  })

  app.delete('/api/local/shogo-key', async (c) => {
    try {
      await Promise.all([
        localDb.localConfig.deleteMany({ where: { key: 'SHOGO_API_KEY' } }),
        localDb.localConfig.deleteMany({ where: { key: 'SHOGO_CLOUD_URL' } }),
        localDb.localConfig.deleteMany({ where: { key: 'SHOGO_KEY_INFO' } }),
      ])
      delete process.env.SHOGO_API_KEY
      delete process.env.SHOGO_CLOUD_URL

      import('./lib/instance-tunnel').then(({ stopInstanceTunnel }) => {
        stopInstanceTunnel()
      }).catch(() => {})

      return c.json({ ok: true })
    } catch (err: any) {
      return c.json({ ok: false, error: err.message }, 500)
    }
  })

  // ── Local mode: Instance info (how this machine is registered to cloud) ──

  app.get('/api/local/instance-info', async (c) => {
    const { hostname: osHostname, platform: osPlatform, arch: osArch } = await import('os')
    let tunnelConnected = false
    try {
      const { isTunnelConnected } = await import('./lib/instance-tunnel')
      tunnelConnected = isTunnelConnected()
    } catch {}

    const nameRow = await localDb.localConfig.findUnique({ where: { key: 'SHOGO_INSTANCE_NAME' } }).catch(() => null)
    const infoRow = await localDb.localConfig.findUnique({ where: { key: 'SHOGO_KEY_INFO' } }).catch(() => null)
    const urlRow = await localDb.localConfig.findUnique({ where: { key: 'SHOGO_CLOUD_URL' } }).catch(() => null)

    let workspaceName: string | null = null
    try { workspaceName = infoRow ? JSON.parse(infoRow.value)?.workspace?.name : null } catch {}

    return c.json({
      name: nameRow?.value || process.env.SHOGO_INSTANCE_NAME || osHostname(),
      hostname: osHostname(),
      os: osPlatform(),
      arch: osArch(),
      tunnelConnected,
      cloudUrl: urlRow?.value || process.env.SHOGO_CLOUD_URL || 'https://studio.shogo.ai',
      workspaceName,
    })
  })

  app.put('/api/local/instance-name', async (c) => {
    const body = await c.req.json<{ name: string }>()
    if (!body.name?.trim()) {
      return c.json({ ok: false, error: 'Name is required' }, 400)
    }

    const name = body.name.trim()
    await localDb.localConfig.upsert({
      where: { key: 'SHOGO_INSTANCE_NAME' },
      update: { value: name },
      create: { key: 'SHOGO_INSTANCE_NAME', value: name },
    })
    process.env.SHOGO_INSTANCE_NAME = name

    try {
      const { stopInstanceTunnel, startInstanceTunnel } = await import('./lib/instance-tunnel')
      stopInstanceTunnel()
      startInstanceTunnel()
    } catch {}

    return c.json({ ok: true, name })
  })
}

// Agent template catalog — public, no auth required
app.route('/api', agentTemplateRoutes())

// Eval output listing + import — for local dev/testing
app.route('/api', evalOutputRoutes())

// Eval admin — run management, results viewer, trigger (super-admin only)
app.route('/api/admin/evals', evalAdminRoutes())

// Eval internal callbacks — progress/complete/fail from run-eval.ts (secret-authenticated)
app.use('/api/internal/evals/*', bodyLimit({ maxSize: 50 * 1024 * 1024 }))
app.route('/api/internal', evalInternalRoutes())

// API key management (for Shogo Local → Cloud authentication)
app.route('/api', apiKeyRoutes())

// Remote Control — Instance registry and tunnel proxy
app.route('/api', instanceRoutes())
startTunnelHeartbeat()

// Warm pool + cluster capacity status (for operational dashboards and load testing)
app.get('/api/warm-pool/status', async (c) => {
  try {
    const { getWarmPoolController } = await import('./lib/warm-pool-controller')
    const controller = getWarmPoolController()
    const status = await controller.getExtendedStatus()
    return c.json(status)
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

// =============================================================================
// Templates API - Serve SDK example templates
// =============================================================================

/**
 * Template metadata structure from template.json files
 */
interface TemplateMetadata {
  name: string
  description: string
  complexity: 'beginner' | 'intermediate' | 'advanced'
  features: string[]
  models: string[]
  tags: string[]
  useCases: string[]
  techStack: {
    database: string
    orm: string
    frontend: string
    router: string
    sdk: string
    [key: string]: string
  }
}

/**
 * Hardcoded fallback templates for environments where the SDK examples
 * directory is not available (e.g., Kubernetes deployments).
 */
const FALLBACK_TEMPLATES: TemplateMetadata[] = [
  {
    name: 'todo-app',
    description: 'Simple task management app with user authentication',
    complexity: 'beginner',
    features: ['prisma', 'user-auth', 'crud', 'one-to-many'],
    models: ['User', 'Todo'],
    tags: ['tasks', 'todo', 'checklist', 'productivity', 'simple', 'agent'],
    useCases: ['task list', 'todo app', 'checklist', 'simple crud app', 'getting started'],
    techStack: { database: 'postgresql', orm: 'prisma', frontend: 'react', router: 'hono', backend: 'hono', sdk: '@shogo-ai/sdk' },
  },
  {
    name: 'crm',
    description: 'Customer relationship management with contacts, companies, deals, tags, and activity notes',
    complexity: 'advanced',
    features: ['prisma', 'user-auth', 'crud', 'one-to-many', 'many-to-many', 'pipeline-stages'],
    models: ['User', 'Contact', 'Company', 'Tag', 'ContactTag', 'Note', 'Deal'],
    tags: ['crm', 'sales', 'contacts', 'customers', 'leads', 'deals', 'pipeline', 'agent'],
    useCases: ['crm', 'customer management', 'sales pipeline', 'contact management', 'lead tracking'],
    techStack: { database: 'postgresql', orm: 'prisma', frontend: 'react', router: 'hono', backend: 'hono', sdk: '@shogo-ai/sdk' },
  },
  {
    name: 'kanban',
    description: 'Kanban board with drag-and-drop task management',
    complexity: 'intermediate',
    features: ['prisma', 'user-auth', 'crud', 'one-to-many'],
    models: ['User', 'Board', 'Column', 'Card'],
    tags: ['kanban', 'project-management', 'board', 'tasks', 'agile', 'agent'],
    useCases: ['kanban board', 'project management', 'task board', 'agile board'],
    techStack: { database: 'postgresql', orm: 'prisma', frontend: 'react', router: 'hono', backend: 'hono', sdk: '@shogo-ai/sdk' },
  },
  {
    name: 'expense-tracker',
    description: 'Personal expense tracker with categories and budgets',
    complexity: 'intermediate',
    features: ['prisma', 'user-auth', 'crud', 'one-to-many', 'aggregations'],
    models: ['User', 'Category', 'Expense', 'Budget'],
    tags: ['finance', 'expenses', 'budget', 'money', 'tracker', 'agent'],
    useCases: ['expense tracking', 'budget management', 'personal finance', 'money tracker'],
    techStack: { database: 'postgresql', orm: 'prisma', frontend: 'react', router: 'hono', backend: 'hono', sdk: '@shogo-ai/sdk' },
  },
  {
    name: 'booking-app',
    description: 'Booking and reservation system with time slots and availability',
    complexity: 'intermediate',
    features: ['prisma', 'user-auth', 'crud', 'one-to-many'],
    models: ['User', 'Service', 'TimeSlot', 'Booking'],
    tags: ['booking', 'reservation', 'scheduling', 'appointments', 'agent'],
    useCases: ['booking system', 'reservation app', 'appointment scheduler', 'scheduling tool'],
    techStack: { database: 'postgresql', orm: 'prisma', frontend: 'react', router: 'hono', backend: 'hono', sdk: '@shogo-ai/sdk' },
  },
]

/**
 * Load all available templates from SDK examples directory
 */
async function loadTemplates(): Promise<TemplateMetadata[]> {
  const templatesDir = resolve(PROJECT_ROOT, 'packages/sdk/examples')
  const templates: TemplateMetadata[] = []

  try {
    const entries = await readdir(templatesDir, { withFileTypes: true })

    for (const entry of entries) {
      if (!entry.isDirectory()) continue

      const templateJsonPath = join(templatesDir, entry.name, 'template.json')
      try {
        const content = await Bun.file(templateJsonPath).text()
        const metadata: TemplateMetadata = JSON.parse(content)
        templates.push(metadata)
      } catch {
        // Skip if no template.json or invalid JSON
      }
    }
  } catch (err) {
    console.warn('[Templates] Could not read templates directory:', (err as Error).message)
  }

  if (templates.length === 0) {
    console.warn(`[Templates] No templates found at ${templatesDir}, using fallback list (${FALLBACK_TEMPLATES.length} templates)`)
    return FALLBACK_TEMPLATES
  }

  return templates
}

/**
 * GET /api/templates - List all available SDK templates
 * APP_MODE_DISABLED: Returns empty array while app mode is disabled.
 */
app.get('/api/templates', async (c) => {
  return c.json({ templates: [] }, 200)
})

/**
 * POST /api/projects/:projectId/apply-template
 * APP_MODE_DISABLED: App template application is disabled.
 * See APP_MODE_DISABLED.md for the original implementation.
 */
app.post('/api/projects/:projectId/apply-template', async (c) => {
  return c.json({ ok: false, error: 'App mode is currently disabled' }, 404)
})

// =============================================================================
// Publish routes - Project publishing to subdomain.shogo.one
// =============================================================================

// Check subdomain availability
app.get('/api/subdomains/:subdomain/check', async (c) => {
  const router = publishRoutes()
  // Forward with properly constructed URL
  const url = new URL(c.req.url)
  url.pathname = `/subdomains/${c.req.param('subdomain')}/check`
  const newReq = new Request(url.toString(), { method: 'GET' })
  return router.fetch(newReq)
})

// Publish a project
app.post('/api/projects/:projectId/publish', async (c) => {
  const router = publishRoutes()
  const url = new URL(c.req.url)
  url.pathname = `/projects/${c.req.param('projectId')}/publish`
  const newReq = new Request(url.toString(), {
    method: 'POST',
    headers: c.req.raw.headers,
    body: c.req.raw.body,
  })
  return router.fetch(newReq)
})

// Update publish settings
app.patch('/api/projects/:projectId/publish', async (c) => {
  const router = publishRoutes()
  const url = new URL(c.req.url)
  url.pathname = `/projects/${c.req.param('projectId')}/publish`
  const newReq = new Request(url.toString(), {
    method: 'PATCH',
    headers: c.req.raw.headers,
    body: c.req.raw.body,
  })
  return router.fetch(newReq)
})

// Unpublish a project
app.post('/api/projects/:projectId/unpublish', async (c) => {
  const router = publishRoutes()
  const url = new URL(c.req.url)
  url.pathname = `/projects/${c.req.param('projectId')}/unpublish`
  const newReq = new Request(url.toString(), {
    method: 'POST',
    headers: c.req.raw.headers,
    body: c.req.raw.body,
  })
  return router.fetch(newReq)
})

// =============================================================================
// Thumbnail routes
// =============================================================================

app.post('/api/projects/:projectId/thumbnail', async (c) => {
  const router = thumbnailRoutes()
  const url = new URL(c.req.url)
  url.pathname = `/projects/${c.req.param('projectId')}/thumbnail`
  const newReq = new Request(url.toString(), {
    method: c.req.method,
    headers: c.req.raw.headers,
    body: c.req.raw.body,
  })
  return router.fetch(newReq)
})

app.post('/api/projects/:projectId/thumbnail/capture', async (c) => {
  const router = thumbnailRoutes()
  const url = new URL(c.req.url)
  url.pathname = `/projects/${c.req.param('projectId')}/thumbnail/capture`
  const newReq = new Request(url.toString(), {
    method: c.req.method,
    headers: c.req.raw.headers,
    body: c.req.raw.body,
  })
  return router.fetch(newReq)
})

app.get('/api/projects/:projectId/thumbnail', async (c) => {
  const router = thumbnailRoutes()
  const url = new URL(c.req.url)
  url.pathname = `/projects/${c.req.param('projectId')}/thumbnail`
  const newReq = new Request(url.toString(), {
    method: c.req.method,
    headers: c.req.raw.headers,
  })
  return router.fetch(newReq)
})

// =============================================================================
// Runtime routes - Project Vite runtime management
// =============================================================================

// Start project runtime
app.post('/api/projects/:projectId/runtime/start', async (c) => {
  const projectId = c.req.param('projectId')

  if (isKubernetes()) {
    try {
      const { getKnativeProjectManager } = await import('./lib/knative-project-manager')
      const knativeManager = getKnativeProjectManager()
      await knativeManager.createProject(projectId)
      const podUrl = await knativeManager.resolveProjectPodUrl(projectId)
      return c.json({
        success: true,
        projectId,
        status: 'running',
        url: podUrl,
      })
    } catch (err: any) {
      console.error(`[Runtime] Failed to start project ${projectId} in K8s:`, err.message)
      return c.json({ error: `Failed to start runtime: ${err.message}` }, 500)
    }
  }

  const manager = getRuntimeManager()
  const router = runtimeRoutes({ runtimeManager: manager, workspacesDir: WORKSPACES_DIR })
  const url = new URL(c.req.url)
  url.pathname = `/projects/${projectId}/runtime/start`
  const newReq = new Request(url.toString(), { method: 'POST' })
  return router.fetch(newReq)
})

// Stop project runtime
app.post('/api/projects/:projectId/runtime/stop', async (c) => {
  const projectId = c.req.param('projectId')
  
  if (isKubernetes()) {
    // In Kubernetes: Scale the project to 0 (or just return success since Knative auto-scales)
    // Note: We don't actually stop the pod - Knative handles scaling to zero automatically
    // This endpoint exists for compatibility with the frontend cleanup
    try {
      // Just return success - Knative will scale to zero automatically after idle timeout
      return c.json({
        success: true,
        projectId,
        status: 'scaling_down',
        message: 'Project will scale to zero after idle timeout',
      })
    } catch (error: any) {
      console.error('[Runtime] Stop error:', error)
      return c.json(
        { error: { code: 'stop_failed', message: error.message || 'Failed to stop runtime' } },
        500
      )
    }
  } else {
    // Local development: Use RuntimeManager
    const manager = getRuntimeManager()
    const router = runtimeRoutes({ runtimeManager: manager, workspacesDir: WORKSPACES_DIR })
    const url = new URL(c.req.url)
    url.pathname = `/projects/${projectId}/runtime/stop`
    const newReq = new Request(url.toString(), { method: 'POST' })
    return router.fetch(newReq)
  }
})

// Restart project runtime (useful after template copy or file changes)
// In Kubernetes, this triggers a rebuild in the runtime pod
app.post('/api/projects/:projectId/runtime/restart', async (c) => {
  const projectId = c.req.param('projectId')
  
  if (isKubernetes()) {
    // In Kubernetes: Proxy to runtime pod's /preview/restart endpoint
    // This triggers a rebuild (vite build) and restarts the preview server
    try {
      const { getProjectPodUrl } = await import('./lib/knative-project-manager')
      const podUrl = await getProjectPodUrl(projectId)
      
      console.log(`[Runtime Restart] Proxying to runtime pod: ${podUrl}/preview/restart`)
      
      const response = await fetch(`${podUrl}/preview/restart`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
      })
      
      if (!response.ok) {
        const errorText = await response.text()
        console.error(`[Runtime Restart] Pod returned error:`, errorText)
        return c.json({
          error: { code: 'restart_failed', message: `Rebuild failed (HTTP ${response.status}): ${errorText}` },
        }, response.status as any)
      }
      
      const result = await response.json()
      return c.json({
        success: true,
        projectId,
        ...result,
      })
    } catch (err: any) {
      console.error('[Runtime Restart] Error:', err)
      return c.json({
        error: { code: 'restart_failed', message: err.message || `Failed to restart runtime for project ${projectId}` },
      }, 500)
    }
  }
  
  // Local development: use RuntimeManager
  const manager = getRuntimeManager()
  const router = runtimeRoutes({ runtimeManager: manager, workspacesDir: WORKSPACES_DIR })
  const url = new URL(c.req.url)
  url.pathname = `/projects/${projectId}/runtime/restart`
  const newReq = new Request(url.toString(), { method: 'POST' })
  return router.fetch(newReq)
})

/**
 * Sanitize raw Knative/Kubernetes status messages for end-user display.
 * Technical messages (e.g. "Configuration ... does not have any ready Revision")
 * are replaced with friendly text. Raw messages are still logged server-side.
 */
function friendlyRuntimeMessage(raw: string | undefined, fallback: string): string {
  if (!raw) return fallback
  // Knative revision not ready yet — most common during cold start
  if (raw.includes('does not have any ready Revision')) return 'Your project is starting up — this usually takes a few seconds...'
  // Container still being created
  if (raw.includes('ContainerCreating') || raw.includes('PodInitializing')) return 'Setting up your project environment...'
  // Image pull in progress
  if (raw.includes('ImagePull') || raw.includes('Pulling image')) return 'Preparing your project environment...'
  // Catch-all for other Knative internals (Revision, Configuration, namespace references)
  if (raw.includes('Revision') || raw.includes('Configuration "')) return fallback
  // Message looks safe for users — pass it through
  return raw
}

// Get project runtime status
// This is a lightweight endpoint that doesn't create or wait for pods.
// Frontend should poll this to check if the pod is ready before making other requests.
app.get('/api/projects/:projectId/runtime/status', async (c) => {
  const projectId = c.req.param('projectId')
  
  if (isKubernetes()) {
    // In Kubernetes: Get Knative service status AND verify with active health check
    try {
      const { getKnativeProjectManager } = await import('./lib/knative-project-manager')
      const manager = getKnativeProjectManager()
      const status = await manager.getStatus(projectId)
      
      if (!status.exists) {
        // Pod doesn't exist yet - return "not_found" (frontend should trigger creation)
        return c.json({
          projectId,
          status: 'not_found',
          message: 'Project runtime not created yet',
          ready: false,
        })
      } else if (!status.ready) {
        // Pod exists but Knative says it's not ready
        // Log raw Knative message for debugging, send friendly message to user
        if (status.message) {
          console.log(`[Runtime] Raw Knative status for ${projectId}: ${status.message}`)
        }
        return c.json({
          projectId,
          status: 'starting',
          message: friendlyRuntimeMessage(status.message, 'Project runtime is starting...'),
          ready: false,
          replicas: status.replicas,
        })
      } else {
        // Knative says ready - but verify with active health check
        // This ensures the pod is actually responding before we tell frontend to load iframe
        const healthy = await manager.healthCheck(projectId)
        
        if (healthy) {
          return c.json({
            projectId,
            status: 'running',
            message: 'Project runtime is ready',
            ready: true,
            replicas: status.replicas,
            url: status.url,
          })
        } else {
          // Knative says ready but health check failed - pod is still warming up
          return c.json({
            projectId,
            status: 'starting',
            message: 'Project runtime is warming up...',
            ready: false,
            replicas: status.replicas,
          })
        }
      }
    } catch (error: any) {
      console.error('[Runtime] Failed to get project status:', error)
      return c.json({
        projectId,
        status: 'error',
        message: friendlyRuntimeMessage(error.message, 'Failed to check project status'),
        ready: false,
      }, 500)
    }
  } else {
    // Local development: Use RuntimeManager
    const manager = getRuntimeManager()
    const router = runtimeRoutes({ runtimeManager: manager, workspacesDir: WORKSPACES_DIR })
    const url = new URL(c.req.url)
    url.pathname = `/projects/${c.req.param('projectId')}/runtime/status`
    const newReq = new Request(url.toString(), { method: 'GET' })
    return router.fetch(newReq)
  }
})

// Get project sandbox URL for iframe embedding
// Query params:
//   ?wait=true  - Wait for pod to be ready (default: true for backwards compatibility)
//   ?wait=false - Return immediately with status, don't wait
//   ?mode=subdomain - Return subdomain-based preview URL (new, recommended)
//   ?mode=proxy - Return proxy-based preview URL (legacy, default for backwards compat)
app.get('/api/projects/:projectId/sandbox/url', async (c) => {
  const projectId = c.req.param('projectId')

  const userId = await getAuthUserId(c)
  if (!userId) {
    return c.json({ error: { code: 'unauthorized', message: 'Authentication required' } }, 401)
  }
  const wsId = await verifyProjectAccess(userId, projectId)
  if (!wsId) {
    return c.json({ error: { code: 'forbidden', message: 'No access to this project' } }, 403)
  }

  const shouldWait = c.req.query('wait') !== 'false' // Default to waiting for backwards compat
  const previewMode = c.req.query('mode') || 'subdomain' // Default to subdomain mode
  
  if (isKubernetes()) {
    // In Kubernetes: Return preview URL based on mode
    const { getProjectPodUrl, getKnativeProjectManager, getPreviewUrl } = await import('./lib/knative-project-manager')
    const { generatePreviewToken } = await import('./lib/preview-token')
    
    // First check current status
    const manager = getKnativeProjectManager()
    const status = await manager.getStatus(projectId)

    // All unified projects have an agent URL
    
    // Build the preview URL based on mode
    const host = c.req.header('x-original-host') || c.req.header('host') || 'localhost'
    const protocol = 'https'
    
    // Generate preview token (valid for 1 hour)
    const previewToken = await generatePreviewToken(projectId)
    
    let previewUrl: string
    let legacyProxyUrl: string
    
    if (previewMode === 'subdomain') {
      // New subdomain-based preview (recommended)
      // Format: https://preview--{projectId}--{env}.{domain}/?__preview_token=...
      const subdomainBaseUrl = getPreviewUrl(projectId)
      console.log(`[sandbox/url] getPreviewUrl(${projectId}) = ${subdomainBaseUrl}`)
      previewUrl = `${subdomainBaseUrl}/?__preview_token=${previewToken}`
      legacyProxyUrl = `${protocol}://${host}/api/projects/${projectId}/preview/`
    } else {
      // Legacy proxy-based preview (fallback)
      previewUrl = `${protocol}://${host}/api/projects/${projectId}/preview/`
      legacyProxyUrl = previewUrl
    }
    
    console.log(`[sandbox/url] projectId=${projectId} mode=${previewMode} host=${host}`)
    console.log(`[sandbox/url] previewUrl=${previewUrl}`)
    console.log(`[sandbox/url] legacyProxyUrl=${legacyProxyUrl}`)
    console.log(`[sandbox/url] status: exists=${status.exists} ready=${status.ready}`)
    
    // Agent URL for chat (proxied through API to avoid CORS issues)
    const agentUrl = `${protocol}://${host}/api/projects/${projectId}/agent-proxy`

    // Canvas iframe loads directly from the runtime (not through the proxy)
    // so fetch('/api/...') resolves same-origin to the skill server.
    // In production this is the preview subdomain; locally it's the direct runtime port.
    const canvasBaseUrl = previewMode === 'subdomain'
      ? getPreviewUrl(projectId)
      : `${protocol}://${host}/api/projects/${projectId}/agent-proxy`

    // If pod is already running, return immediately
    if (status.exists && status.ready) {
      console.log(`[sandbox/url] Returning ready response with url=${previewUrl}`)

      // Auto-capture thumbnail if missing (fire-and-forget)
      prisma.project.findUnique({ where: { id: projectId }, select: { thumbnailUrl: true } })
        .then((proj) => {
          if (proj && !proj.thumbnailUrl) {
            const captureUrl = agentUrl || previewUrl
            setTimeout(() => {
              fetch(`${protocol}://${host}/api/projects/${projectId}/thumbnail/capture`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ url: captureUrl }),
              }).catch(() => {})
            }, 3000)
          }
        })
        .catch(() => {})

      const resolvedDirectUrl = await manager.resolveProjectPodUrl(projectId)
      return c.json({
        url: previewUrl,
        proxyUrl: legacyProxyUrl, // Backwards compat - legacy proxy URL
        directUrl: resolvedDirectUrl,
        ...(agentUrl && { agentUrl }),
        ...(canvasBaseUrl && { canvasBaseUrl }),
        sandbox: 'allow-scripts allow-same-origin allow-forms allow-popups',
        status: 'running',
        ready: true,
        mode: previewMode,
      }, 200)
    }
    
    const resolvedDirectUrl = await manager.resolveProjectPodUrl(projectId)

    // Pod doesn't exist or isn't ready
    if (!shouldWait) {
      // Caller requested non-blocking - return current status
      // This triggers pod creation in the background if needed
      if (!status.exists) {
        getProjectPodUrl(projectId).catch(err => {
          console.error(`[Runtime] Background pod creation failed for ${projectId}:`, err)
        })
      }
      
      console.log(`[sandbox/url] Returning non-blocking response (wait=false) with url=${previewUrl}`)
      return c.json({
        url: previewUrl,
        proxyUrl: legacyProxyUrl,
        directUrl: resolvedDirectUrl,
        ...(agentUrl && { agentUrl }),
        ...(canvasBaseUrl && { canvasBaseUrl }),
        sandbox: 'allow-scripts allow-same-origin allow-forms allow-popups',
        status: status.exists ? 'starting' : 'creating',
        ready: false,
        mode: previewMode,
        message: status.exists 
          ? 'Project runtime is starting, please poll /runtime/status until ready'
          : 'Project runtime is being created, please poll /runtime/status until ready',
      }, 202)
    }
    
    // Wait for pod — cap at 60s to stay well under Cloudflare's 100s timeout.
    // If the pod isn't ready in time, return 202 so the client can poll.
    const SANDBOX_WAIT_MS = 60_000
    try {
      await Promise.race([
        getProjectPodUrl(projectId),
        new Promise((_, reject) => setTimeout(() => reject(new Error('sandbox_wait_timeout')), SANDBOX_WAIT_MS)),
      ])
      
      console.log(`[sandbox/url] Returning waited response with url=${previewUrl}`)
      return c.json({
        url: previewUrl,
        proxyUrl: legacyProxyUrl,
        directUrl: resolvedDirectUrl,
        ...(agentUrl && { agentUrl }),
        ...(canvasBaseUrl && { canvasBaseUrl }),
        sandbox: 'allow-scripts allow-same-origin allow-forms allow-popups',
        status: 'running',
        ready: true,
        mode: previewMode,
      }, 200)
    } catch (error: any) {
      if (error.message === 'sandbox_wait_timeout') {
        console.log(`[sandbox/url] Wait timed out after ${SANDBOX_WAIT_MS}ms, returning 202 for client retry`)
        return c.json({
          url: previewUrl,
          proxyUrl: legacyProxyUrl,
          directUrl: resolvedDirectUrl,
          ...(agentUrl && { agentUrl }),
        ...(canvasBaseUrl && { canvasBaseUrl }),
          sandbox: 'allow-scripts allow-same-origin allow-forms allow-popups',
          status: 'starting',
          ready: false,
          mode: previewMode,
          message: 'Runtime is still starting. Please retry this request.',
        }, 202)
      }
      console.error('[Runtime] Failed to get project pod URL:', error)
      console.log(`[sandbox/url] Returning error response with url=${previewUrl}`)
      return c.json({
        url: previewUrl,
        proxyUrl: legacyProxyUrl,
        status: 'error',
        ready: false,
        mode: previewMode,
        error: { code: 'pod_unavailable', message: error.message || 'Failed to start project runtime' }
      }, 503)
    }
  } else {
    // Local development: Use RuntimeManager
    const manager = getRuntimeManager()
    const router = runtimeRoutes({ runtimeManager: manager, workspacesDir: WORKSPACES_DIR })
    const url = new URL(c.req.url)
    url.pathname = `/projects/${projectId}/sandbox/url`
    const newReq = new Request(url.toString(), {
      method: 'GET',
      headers: { host: c.req.header('host') || `localhost:${process.env.API_PORT || process.env.PORT || '8002'}` },
    })
    return router.fetch(newReq)
  }
})

// =============================================================================
// Preview Proxy - Proxies preview requests to project runtime pods (Kubernetes only)
// =============================================================================

// Preview proxy for project runtime (all methods, all paths)
// Routes to the /preview/ endpoint on the runtime server which proxies to Vite
app.all('/api/projects/:projectId/preview/*', async (c) => {
  const projectId = c.req.param('projectId')
  
  if (!isKubernetes()) {
    // In local dev, redirect to the local Vite dev server directly
    const manager = getRuntimeManager()
    const runtime = manager.status(projectId)
    if (runtime?.url) {
      const path = c.req.path.replace(`/api/projects/${projectId}/preview`, '') || '/'
      return c.redirect(`${runtime.url}${path}`)
    }
    return c.json({ error: { code: 'not_running', message: 'Project runtime not running' } }, 404)
  }
  
  try {
    const { getProjectPodUrl } = await import('./lib/knative-project-manager')
    const podUrl = await getProjectPodUrl(projectId)
    
    // Extract the path after /preview/ and route to /preview/ on the runtime
    // The runtime server proxies /preview/* to the Vite dev server on port 5173
    const path = c.req.path.replace(`/api/projects/${projectId}/preview`, '') || '/'
    const targetUrl = `${podUrl}/preview${path}`
    
    // Tell runtime the external base path for URL rewriting in HTML
    const externalBasePath = `/api/projects/${projectId}/preview/`
    
    console.log(`[PreviewProxy] Proxying ${c.req.method} ${path} to ${targetUrl} (external base: ${externalBasePath})`)
    
    // Forward the request to the project pod's preview proxy
    const headers = new Headers()
    
    // Pass the external base path for HTML rewriting
    headers.set('X-Proxy-Base-Path', externalBasePath)
    
    // Copy relevant headers
    const contentType = c.req.header('content-type')
    if (contentType) headers.set('content-type', contentType)
    const accept = c.req.header('accept')
    if (accept) headers.set('accept', accept)
    const acceptEncoding = c.req.header('accept-encoding')
    if (acceptEncoding) headers.set('accept-encoding', acceptEncoding)
    
    // Handle WebSocket upgrade for HMR
    const upgrade = c.req.header('upgrade')
    if (upgrade) {
      headers.set('upgrade', upgrade)
      headers.set('connection', 'upgrade')
      const wsKey = c.req.header('sec-websocket-key')
      if (wsKey) headers.set('sec-websocket-key', wsKey)
      const wsVersion = c.req.header('sec-websocket-version')
      if (wsVersion) headers.set('sec-websocket-version', wsVersion)
    }
    
    const requestInit: RequestInit = {
      method: c.req.method,
      headers,
    }
    
    // Include body for non-GET requests
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
      requestInit.body = await c.req.arrayBuffer()
    }
    
    const response = await fetch(targetUrl, requestInit)
    
    // Copy response headers
    const responseHeaders = new Headers()
    response.headers.forEach((value, key) => {
      // Skip certain headers
      if (!['transfer-encoding', 'connection'].includes(key.toLowerCase())) {
        responseHeaders.set(key, value)
      }
    })
    
    // Add CORS headers for preview
    responseHeaders.set('access-control-allow-origin', '*')
    responseHeaders.set('access-control-allow-methods', 'GET, POST, PUT, DELETE, OPTIONS')
    responseHeaders.set('access-control-allow-headers', '*')
    
    return new Response(response.body, {
      status: response.status,
      headers: responseHeaders,
    })
  } catch (error: any) {
    console.error('[PreviewProxy] Error:', error)
    return c.json({
      error: { code: 'proxy_error', message: error.message || 'Failed to proxy request' }
    }, 502)
  }
})

// Handle the base preview path without trailing content
app.all('/api/projects/:projectId/preview', async (c) => {
  // Redirect to the path with trailing slash
  const projectId = c.req.param('projectId')
  return c.redirect(`/api/projects/${projectId}/preview/`)
})

// Agent proxy - forwards requests directly to agent-runtime pod without /preview prefix
// Includes retry logic for cold-start scenarios where the pod may be scaling up.
app.all('/api/projects/:projectId/agent-proxy/*', async (c) => {
  if (isShuttingDown) {
    return c.json({ error: { code: 'shutting_down', message: 'Server is shutting down, please retry' } }, 503)
  }

  const projectId = c.req.param('projectId')
  const path = c.req.path.replace(`/api/projects/${projectId}/agent-proxy`, '') || '/'
  const qs = new URL(c.req.url).search

  const isWebchatPath =
    path === '/agent/channels/webchat/widget.js' ||
    path === '/agent/channels/webchat/health' ||
    path === '/agent/channels/webchat/config' ||
    path === '/agent/channels/webchat/session' ||
    path === '/agent/channels/webchat/message' ||
    path.startsWith('/agent/channels/webchat/events/')
  if (!isWebchatPath) {
    const userId = await getAuthUserId(c)
    if (!userId) {
      return c.json({ error: { code: 'unauthorized', message: 'Authentication required' } }, 401)
    }
    const workspaceId = await verifyProjectAccess(userId, projectId)
    if (!workspaceId) {
      return c.json({ error: { code: 'forbidden', message: 'No access to this project' } }, 403)
    }
  }

  let podUrl: string

  if (isKubernetes()) {
    try {
      const { getProjectPodUrl } = await import('./lib/knative-project-manager')
      podUrl = await getProjectPodUrl(projectId)
    } catch (error: any) {
      console.error('[AgentProxy] K8s pod resolution error:', error)
      return c.json({ error: { code: 'proxy_error', message: error.message || 'Failed to resolve agent pod' } }, 502)
    }
  } else {
    const manager = getRuntimeManager()
    let runtime = manager.status(projectId)
    if (!runtime || !runtime.agentPort) {
      try {
        runtime = await manager.start(projectId)
      } catch (error: any) {
        console.error(`[AgentProxy] Failed to auto-start runtime for ${projectId}:`, error)
        return c.json({ error: { code: 'agent_start_failed', message: error.message || 'Failed to start agent runtime' } }, 503)
      }
    }
    podUrl = `http://localhost:${runtime.agentPort}`
  }

  const targetUrl = `${podUrl}${path}${qs}`

  const headers = new Headers()
  const contentType = c.req.header('content-type')
  if (contentType) headers.set('content-type', contentType)
  const accept = c.req.header('accept')
  if (accept) headers.set('accept', accept)
  if (isWebchatPath) {
    const fwdHeaders = ['origin', 'x-webchat-widget-key', 'x-webchat-session-token', 'x-webchat-session'] as const
    for (const h of fwdHeaders) {
      const v = c.req.header(h)
      if (v) headers.set(h, v)
    }
  }
  const { deriveRuntimeToken } = await import('./lib/runtime-token')
  headers.set('x-runtime-token', deriveRuntimeToken(projectId))

  let requestBody: ArrayBuffer | undefined
  if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
    requestBody = await c.req.arrayBuffer()
  }

  // Retry with exponential backoff for cold-start transient errors.
  // Knative pods can take 60-90s to cold start (S3 restore + deps install).
  const MAX_RETRIES = 24
  const BASE_DELAY_MS = 500
  const MAX_DELAY_MS = 5000
  const FETCH_TIMEOUT_MS = 1_800_000
  let lastError: Error | null = null

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(targetUrl, {
        method: c.req.method,
        headers,
        body: requestBody,
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      })

      if (!response.ok && response.status >= 500 && attempt < MAX_RETRIES) {
        const delay = Math.min(BASE_DELAY_MS * Math.pow(2, attempt - 1), MAX_DELAY_MS)
        if (attempt === 1) {
          console.log(`[AgentProxy] ${c.req.method} ${path} → ${response.status}, retrying (cold start?)...`)
        }
        await new Promise(resolve => setTimeout(resolve, delay))
        continue
      }

      const responseHeaders = new Headers()
      response.headers.forEach((value, key) => {
        if (!['transfer-encoding', 'connection'].includes(key.toLowerCase())) {
          responseHeaders.set(key, value)
        }
      })
      const reqOrigin = c.req.header('origin')
      responseHeaders.set('access-control-allow-origin', reqOrigin || '*')
      responseHeaders.set('access-control-allow-methods', 'GET, POST, PUT, DELETE, OPTIONS')
      responseHeaders.set('access-control-allow-headers', '*')
      if (reqOrigin) responseHeaders.set('access-control-allow-credentials', 'true')
      responseHeaders.set('cross-origin-resource-policy', 'cross-origin')

      const responseContentType = response.headers.get('content-type') || ''
      if (responseContentType.includes('text/event-stream') || responseContentType.includes('text/plain')) {
        responseHeaders.set('X-Accel-Buffering', 'no')
        responseHeaders.set('Cache-Control', 'no-cache, no-transform')
      }

      if (attempt > 1) {
        console.log(`[AgentProxy] ${c.req.method} ${path} succeeded after ${attempt} attempts`)
      }

      const isStreaming = responseContentType.includes('text/event-stream') ||
        (response.body && responseContentType.includes('text/plain'))
      if (isStreaming && response.body) {
        activeProxyConnections++
        const trackedBody = response.body.pipeThrough(new TransformStream({
          flush() { activeProxyConnections-- },
        }))
        c.req.raw.signal.addEventListener('abort', () => { activeProxyConnections = Math.max(0, activeProxyConnections - 1) })
        return new Response(trackedBody, { status: response.status, headers: responseHeaders })
      }

      return new Response(response.body, { status: response.status, headers: responseHeaders })
    } catch (fetchError: any) {
      lastError = fetchError

      const isTransient =
        fetchError.code === 'ECONNREFUSED' ||
        fetchError.code === 'ECONNRESET' ||
        fetchError.code === 'ETIMEDOUT' ||
        fetchError.cause?.code === 'ECONNREFUSED' ||
        fetchError.cause?.code === 'ECONNRESET' ||
        fetchError.cause?.code === 'ETIMEDOUT' ||
        fetchError.message?.includes('ECONNREFUSED') ||
        fetchError.message?.includes('connection refused')

      const isTimeout = fetchError.name === 'TimeoutError' || fetchError.name === 'AbortError'

      if ((isTransient || isTimeout) && attempt < MAX_RETRIES) {
        const delay = Math.min(BASE_DELAY_MS * Math.pow(2, attempt - 1), MAX_DELAY_MS)
        if (attempt <= 2) {
          console.log(`[AgentProxy] ${c.req.method} ${path} ${isTimeout ? 'timeout' : 'connection failed'}, retrying in ${delay}ms (attempt ${attempt}/${MAX_RETRIES})`)
        }
        await new Promise(resolve => setTimeout(resolve, delay))
        continue
      }

      break
    }
  }

  console.error(`[AgentProxy] ${c.req.method} ${path} failed after ${MAX_RETRIES} attempts:`, lastError?.message)
  return c.json(
    { error: { code: 'proxy_error', message: lastError?.message || 'Agent runtime unavailable after retries', retryable: true } },
    502,
  )
})

// =============================================================================
// Files routes - Project file listing and reading
// In Kubernetes mode, proxies to runtime pod's /files endpoint
// =============================================================================

// List project files
app.get('/api/projects/:projectId/files', async (c) => {
  const projectId = c.req.param('projectId')
  
  if (isKubernetes()) {
    // In Kubernetes: Proxy to runtime pod
    try {
      const { getProjectPodUrl } = await import('./lib/knative-project-manager')
      const podUrl = await getProjectPodUrl(projectId)
      const targetUrl = `${podUrl}/files`
      
      console.log(`[FilesProxy] Proxying file list to ${targetUrl}`)
      
      const response = await fetch(targetUrl)
      const responseHeaders = new Headers()
      response.headers.forEach((value, key) => {
        if (!['transfer-encoding', 'connection'].includes(key.toLowerCase())) {
          responseHeaders.set(key, value)
        }
      })
      
      return new Response(response.body, {
        status: response.status,
        headers: responseHeaders,
      })
    } catch (error: any) {
      console.error('[FilesProxy] Error:', error)
      return c.json({
        error: { code: 'proxy_error', message: error.message || 'Failed to list files' }
      }, 502)
    }
  }
  
  // Local development: Use local filesystem
  const workspacesDir = process.env.WORKSPACES_DIR || resolve(PROJECT_ROOT, 'workspaces')
  const router = filesRoutes({ workspacesDir })
  const url = new URL(c.req.url)
  url.pathname = `/projects/${projectId}/files`
  const newReq = new Request(url.toString(), { method: 'GET' })
  return router.fetch(newReq)
})

// Get file content
app.get('/api/projects/:projectId/files/*', async (c) => {
  const projectId = c.req.param('projectId')
  const filePath = c.req.path.replace(`/api/projects/${projectId}/files/`, '')
  
  if (isKubernetes()) {
    // In Kubernetes: Proxy to runtime pod
    try {
      const { getProjectPodUrl } = await import('./lib/knative-project-manager')
      const podUrl = await getProjectPodUrl(projectId)
      const targetUrl = `${podUrl}/files/${filePath}`
      
      console.log(`[FilesProxy] Proxying file read to ${targetUrl}`)
      
      const response = await fetch(targetUrl)
      const responseHeaders = new Headers()
      response.headers.forEach((value, key) => {
        if (!['transfer-encoding', 'connection'].includes(key.toLowerCase())) {
          responseHeaders.set(key, value)
        }
      })
      
      return new Response(response.body, {
        status: response.status,
        headers: responseHeaders,
      })
    } catch (error: any) {
      console.error('[FilesProxy] Error:', error)
      return c.json({
        error: { code: 'proxy_error', message: error.message || 'Failed to read file' }
      }, 502)
    }
  }
  
  // Local development: Use local filesystem
  const workspacesDir = process.env.WORKSPACES_DIR || resolve(PROJECT_ROOT, 'workspaces')
  const router = filesRoutes({ workspacesDir })
  const url = new URL(c.req.url)
  url.pathname = `/projects/${projectId}/files/${filePath}`
  const newReq = new Request(url.toString(), { method: 'GET' })
  return router.fetch(newReq)
})

// Write file content
app.put('/api/projects/:projectId/files/*', async (c) => {
  const projectId = c.req.param('projectId')
  const filePath = c.req.path.replace(`/api/projects/${projectId}/files/`, '')
  
  if (isKubernetes()) {
    // In Kubernetes: Proxy to runtime pod
    try {
      const { getProjectPodUrl } = await import('./lib/knative-project-manager')
      const podUrl = await getProjectPodUrl(projectId)
      const targetUrl = `${podUrl}/files/${filePath}`
      
      console.log(`[FilesProxy] Proxying file write to ${targetUrl}`)
      
      // Clone the body for proxying
      const body = await c.req.text()
      
      const response = await fetch(targetUrl, {
        method: 'PUT',
        headers: {
          'Content-Type': c.req.header('Content-Type') || 'application/json',
        },
        body: body,
      })
      
      const responseHeaders = new Headers()
      response.headers.forEach((value, key) => {
        if (!['transfer-encoding', 'connection'].includes(key.toLowerCase())) {
          responseHeaders.set(key, value)
        }
      })
      
      return new Response(response.body, {
        status: response.status,
        headers: responseHeaders,
      })
    } catch (error: any) {
      console.error('[FilesProxy] Error writing file:', error)
      return c.json({
        error: { code: 'proxy_error', message: error.message || 'Failed to write file' }
      }, 502)
    }
  }
  
  // Local development: Use local filesystem
  const workspacesDir = process.env.WORKSPACES_DIR || resolve(PROJECT_ROOT, 'workspaces')
  const router = filesRoutes({ workspacesDir })
  const url = new URL(c.req.url)
  url.pathname = `/projects/${projectId}/files/${filePath}`
  const newReq = new Request(url.toString(), {
    method: 'PUT',
    headers: c.req.raw.headers,
    body: c.req.raw.body,
  })
  return router.fetch(newReq)
})

// Download project source code as tar.gz archive
app.get('/api/projects/:projectId/download', async (c) => {
  const projectId = c.req.param('projectId')
  
  if (isKubernetes()) {
    // In Kubernetes: Proxy to runtime pod
    try {
      const { getProjectPodUrl } = await import('./lib/knative-project-manager')
      const podUrl = await getProjectPodUrl(projectId)
      const targetUrl = `${podUrl}/download`
      
      console.log(`[FilesProxy] Proxying download to ${targetUrl}`)
      
      const response = await fetch(targetUrl)
      const responseHeaders = new Headers()
      response.headers.forEach((value, key) => {
        if (!['transfer-encoding', 'connection'].includes(key.toLowerCase())) {
          responseHeaders.set(key, value)
        }
      })
      
      return new Response(response.body, {
        status: response.status,
        headers: responseHeaders,
      })
    } catch (error: any) {
      console.error('[FilesProxy] Download error:', error)
      return c.json({
        error: { code: 'proxy_error', message: error.message || 'Failed to download project' }
      }, 502)
    }
  }
  
  // Local development: Create tar.gz from workspace directory
  const workspacesDir = process.env.WORKSPACES_DIR || resolve(PROJECT_ROOT, 'workspaces')
  const projectDir = resolve(workspacesDir, projectId)
  
  if (!existsSync(projectDir)) {
    return c.json({
      error: { code: 'not_found', message: 'Project directory not found' }
    }, 404)
  }
  
  try {
    const excludes = [
      'node_modules', '.git', '.next', 'dist', 'build', '.cache',
      '.output', '.nuxt', '.bun', '.vite'
    ]
    const excludeArgs = excludes.flatMap((dir: string) => ['--exclude', dir])
    
    const result = Bun.spawnSync(
      ['tar', '-czf', '-', ...excludeArgs, '-C', projectDir, '.'],
      { stdout: 'pipe', stderr: 'pipe' }
    )
    
    if (result.exitCode !== 0) {
      return c.json({
        error: { code: 'archive_error', message: 'Failed to create archive' }
      }, 500)
    }
    
    const archiveBuffer = result.stdout
    return new Response(new Uint8Array(archiveBuffer) as any, {
      status: 200,
      headers: {
        'Content-Type': 'application/gzip',
        'Content-Disposition': `attachment; filename="${projectId}.tar.gz"`,
        'Content-Length': String(archiveBuffer.byteLength),
      },
    })
  } catch (error: any) {
    console.error('[FilesProxy] Download archive error:', error)
    return c.json({
      error: { code: 'download_error', message: error.message || 'Failed to create download' }
    }, 500)
  }
})

// =============================================================================
// S3 Files routes - Project file listing and access via S3 pre-signed URLs
// =============================================================================

// List project files from S3
app.get('/api/projects/:projectId/s3/files', async (c) => {
  const workspacesDir = process.env.WORKSPACES_DIR || resolve(PROJECT_ROOT, 'workspaces')
  const router = filesRoutes({ workspacesDir })
  const url = new URL(c.req.url)
  url.pathname = `/projects/${c.req.param('projectId')}/s3/files`
  const newReq = new Request(url.toString(), { method: 'GET' })
  return router.fetch(newReq)
})

// Get pre-signed URLs for S3 file read/write
app.post('/api/projects/:projectId/s3/presign', async (c) => {
  const workspacesDir = process.env.WORKSPACES_DIR || resolve(PROJECT_ROOT, 'workspaces')
  const router = filesRoutes({ workspacesDir })
  const url = new URL(c.req.url)
  url.pathname = `/projects/${c.req.param('projectId')}/s3/presign`
  const newReq = new Request(url.toString(), {
    method: 'POST',
    headers: c.req.raw.headers,
    body: c.req.raw.body,
  })
  return router.fetch(newReq)
})

// =============================================================================
// Terminal routes - Execute preset shell commands on project workspaces
// =============================================================================

// List available terminal commands
app.get('/api/projects/:projectId/terminal/commands', async (c) => {
  const projectId = c.req.param('projectId')
  
  if (isKubernetes()) {
    // In Kubernetes: Proxy to runtime pod
    try {
      const { getProjectPodUrl } = await import('./lib/knative-project-manager')
      const podUrl = await getProjectPodUrl(projectId)
      const targetUrl = `${podUrl}/terminal/commands`
      
      console.log(`[TerminalProxy] Proxying commands list to ${targetUrl}`)
      
      const response = await fetch(targetUrl)
      
      // Handle non-OK responses with proper JSON errors
      if (!response.ok) {
        const contentType = response.headers.get('content-type') || ''
        
        // If response is JSON, pass it through
        if (contentType.includes('application/json')) {
          const responseHeaders = new Headers()
          response.headers.forEach((value, key) => {
            if (!['transfer-encoding', 'connection'].includes(key.toLowerCase())) {
              responseHeaders.set(key, value)
            }
          })
          return new Response(response.body, { status: response.status, headers: responseHeaders })
        }
        
        // Non-JSON error (like Knative 503) - return proper JSON
        const errorCode = response.status === 503 ? 'service_starting' 
          : response.status === 502 ? 'service_unavailable' : 'upstream_error'
        
        // Only log non-503 errors (503 is expected during pod startup)
        if (response.status !== 503) {
          console.error(`[TerminalProxy] Upstream error ${response.status}`)
        }
        
        const headers = new Headers({ 'Content-Type': 'application/json' })
        if (response.status === 503) {
          headers.set('Retry-After', '5') // Tell clients to retry after 5 seconds
        }
        
        return c.json({
          error: { code: errorCode, message: `Terminal service unavailable (${response.status})` }
        }, response.status as any)
      }
      
      const responseHeaders = new Headers()
      response.headers.forEach((value, key) => {
        if (!['transfer-encoding', 'connection'].includes(key.toLowerCase())) {
          responseHeaders.set(key, value)
        }
      })
      
      return new Response(response.body, {
        status: response.status,
        headers: responseHeaders,
      })
    } catch (error: any) {
      // Check if error is pod not ready vs actual failure
      const isPodNotReady = error.message?.includes('not ready') || 
        error.message?.includes('not found') ||
        error.message?.includes('starting')
      
      if (isPodNotReady) {
        return c.json({
          error: { code: 'service_starting', message: 'Project runtime is starting...' }
        }, 503)
      }
      
      console.error('[TerminalProxy] Error:', error)
      return c.json({
        error: { code: 'proxy_error', message: error.message || 'Failed to get terminal commands' }
      }, 502)
    }
  }
  
  // Local development: Use local filesystem
  const workspacesDir = process.env.WORKSPACES_DIR || resolve(PROJECT_ROOT, 'workspaces')
  const router = terminalRoutes({ workspacesDir })
  const url = new URL(c.req.url)
  url.pathname = `/projects/${projectId}/terminal/commands`
  const newReq = new Request(url.toString(), { method: 'GET' })
  return router.fetch(newReq)
})

// Execute a preset command
app.post('/api/projects/:projectId/terminal/exec', async (c) => {
  const projectId = c.req.param('projectId')
  
  if (isKubernetes()) {
    // In Kubernetes: Proxy to runtime pod
    try {
      const { getProjectPodUrl } = await import('./lib/knative-project-manager')
      const podUrl = await getProjectPodUrl(projectId)
      const targetUrl = `${podUrl}/terminal/exec`
      
      console.log(`[TerminalProxy] Proxying exec to ${targetUrl}`)
      
      // Read and forward only the necessary headers and body
      const body = await c.req.text()
      
      const response = await fetch(targetUrl, {
        method: 'POST',
        headers: {
          'Content-Type': c.req.header('Content-Type') || 'application/json',
        },
        body,
      })
      
      console.log(`[TerminalProxy] Response status: ${response.status}`)
      
      const responseHeaders = new Headers()
      response.headers.forEach((value, key) => {
        if (!['transfer-encoding', 'connection'].includes(key.toLowerCase())) {
          responseHeaders.set(key, value)
        }
      })
      
      return new Response(response.body, {
        status: response.status,
        headers: responseHeaders,
      })
    } catch (error: any) {
      console.error('[TerminalProxy] Error:', error)
      return c.json({
        error: { code: 'proxy_error', message: error.message || 'Failed to execute command' }
      }, 502)
    }
  }
  
  // Local development: Use local filesystem
  const workspacesDir = process.env.WORKSPACES_DIR || resolve(PROJECT_ROOT, 'workspaces')
  const router = terminalRoutes({ workspacesDir })
  const url = new URL(c.req.url)
  url.pathname = `/projects/${projectId}/terminal/exec`
  const newReq = new Request(url.toString(), {
    method: 'POST',
    headers: c.req.raw.headers,
    body: c.req.raw.body,
  })
  return router.fetch(newReq)
})

// =============================================================================
// TypeScript Types Proxy - Proxy type definitions for Monaco ATA (avoids CORS)
// =============================================================================

/**
 * Proxy requests to external CDNs to avoid CORS issues.
 * Monaco's Automatic Type Acquisition (ATA) needs to fetch @types packages.
 * 
 * Usage: GET /api/types-proxy?url=<encoded-url>
 * Example: /api/types-proxy?url=https%3A%2F%2Fcdn.jsdelivr.net%2Fnpm%2F%40types%2Freact%2Findex.d.ts
 */
app.get('/api/types-proxy', async (c) => {
  const targetUrl = c.req.query('url')
  
  if (!targetUrl) {
    return c.json({ error: { code: 'missing_url', message: 'URL query parameter is required' } }, 400)
  }
  
  // Validate URL is from allowed CDNs
  const allowedHosts = ['cdn.jsdelivr.net', 'unpkg.com', 'esm.sh']
  let parsedUrl: URL
  try {
    parsedUrl = new URL(targetUrl)
  } catch {
    return c.json({ error: { code: 'invalid_url', message: 'Invalid URL format' } }, 400)
  }
  
  if (!allowedHosts.includes(parsedUrl.hostname)) {
    return c.json({ error: { code: 'forbidden_host', message: `Host ${parsedUrl.hostname} is not allowed` } }, 403)
  }
  
  console.log(`[TypesProxy] Proxying: ${targetUrl}`)
  
  try {
    const response = await fetch(targetUrl, {
      headers: {
        'User-Agent': 'Shogo-Studio-TypesProxy/1.0',
      },
      signal: AbortSignal.timeout(10000), // 10 second timeout
    })
    
    if (response.ok) {
      const content = await response.text()
      const contentType = response.headers.get('content-type') || 'text/plain'
      
      return c.text(content, 200, {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=86400', // Cache for 24 hours
      })
    }
    
    return c.json({ 
      error: { code: 'upstream_error', message: `Upstream returned ${response.status}` } 
    }, response.status as any)
  } catch (err: any) {
    console.error(`[TypesProxy] Error fetching ${targetUrl}:`, err.message)
    return c.json({ 
      error: { code: 'fetch_error', message: err.message || 'Failed to fetch from CDN' } 
    }, 502)
  }
})

// =============================================================================
// Tests routes - E2E test management and execution
// =============================================================================

// List test files
app.get('/api/projects/:projectId/tests/list', async (c) => {
  const projectId = c.req.param('projectId')
  
  if (isKubernetes()) {
    // In Kubernetes: Proxy to runtime pod
    try {
      const { getProjectPodUrl } = await import('./lib/knative-project-manager')
      const podUrl = await getProjectPodUrl(projectId)
      const targetUrl = `${podUrl}/tests/list`
      
      console.log(`[TestsProxy] Proxying tests list to ${targetUrl}`)
      
      const response = await fetch(targetUrl)
      
      // Handle non-OK responses with proper JSON errors
      if (!response.ok) {
        const contentType = response.headers.get('content-type') || ''
        
        // If response is JSON, pass it through
        if (contentType.includes('application/json')) {
          const responseHeaders = new Headers()
          response.headers.forEach((value, key) => {
            if (!['transfer-encoding', 'connection'].includes(key.toLowerCase())) {
              responseHeaders.set(key, value)
            }
          })
          return new Response(response.body, { status: response.status, headers: responseHeaders })
        }
        
        // Non-JSON error (like Knative 503) - return proper JSON
        const errorCode = response.status === 503 ? 'service_starting' 
          : response.status === 502 ? 'service_unavailable' : 'upstream_error'
        
        // Only log non-503 errors (503 is expected during pod startup)
        if (response.status !== 503) {
          console.error(`[TestsProxy] Upstream error ${response.status}`)
        }
        
        const headers = new Headers({ 'Content-Type': 'application/json' })
        if (response.status === 503) {
          headers.set('Retry-After', '5') // Tell clients to retry after 5 seconds
        }
        
        return c.json({
          error: { code: errorCode, message: `Tests service unavailable (${response.status})` }
        }, response.status as any)
      }
      
      const responseHeaders = new Headers()
      response.headers.forEach((value, key) => {
        if (!['transfer-encoding', 'connection'].includes(key.toLowerCase())) {
          responseHeaders.set(key, value)
        }
      })
      return new Response(response.body, {
        status: response.status,
        headers: responseHeaders,
      })
    } catch (error: any) {
      // Check if error is pod not ready vs actual failure
      const isPodNotReady = error.message?.includes('not ready') || 
        error.message?.includes('not found') ||
        error.message?.includes('starting')
      
      if (isPodNotReady) {
        return c.json({
          error: { code: 'service_starting', message: 'Project runtime is starting...' }
        }, 503)
      }
      
      console.error(`[TestsProxy] Error proxying tests list:`, error)
      return c.json({
        error: { code: 'proxy_error', message: error.message || 'Failed to proxy to project runtime' }
      }, 502)
    }
  }
  
  // Local/development mode: use local filesystem
  const workspacesDir = process.env.WORKSPACES_DIR || resolve(PROJECT_ROOT, 'workspaces')
  const router = testsRoutes({ workspacesDir })
  const url = new URL(c.req.url)
  url.pathname = `/projects/${c.req.param('projectId')}/tests/list`
  const newReq = new Request(url.toString(), { method: 'GET' })
  return router.fetch(newReq)
})

// Run tests with options
app.post('/api/projects/:projectId/tests/run', async (c) => {
  const projectId = c.req.param('projectId')
  
  if (isKubernetes()) {
    // In Kubernetes: Proxy to runtime pod
    try {
      const { getProjectPodUrl } = await import('./lib/knative-project-manager')
      const podUrl = await getProjectPodUrl(projectId)
      const targetUrl = `${podUrl}/tests/run`
      
      console.log(`[TestsProxy] Proxying tests run to ${targetUrl}`)
      
      // Read body first to avoid streaming issues
      const body = await c.req.text()
      
      const response = await fetch(targetUrl, {
        method: 'POST',
        headers: {
          'Content-Type': c.req.header('Content-Type') || 'application/json',
        },
        body,
      })
      
      console.log(`[TestsProxy] Response status: ${response.status}`)
      
      // Return streaming response
      const responseHeaders = new Headers()
      response.headers.forEach((value, key) => {
        if (!['transfer-encoding', 'connection'].includes(key.toLowerCase())) {
          responseHeaders.set(key, value)
        }
      })
      return new Response(response.body, {
        status: response.status,
        headers: responseHeaders,
      })
    } catch (error: any) {
      console.error(`[TestsProxy] Error proxying tests run:`, error)
      return c.json({
        error: { code: 'proxy_error', message: error.message || 'Failed to proxy to project runtime' }
      }, 502)
    }
  }
  
  // Local/development mode: use local filesystem
  const workspacesDir = process.env.WORKSPACES_DIR || resolve(PROJECT_ROOT, 'workspaces')
  const router = testsRoutes({ workspacesDir })
  const url = new URL(c.req.url)
  url.pathname = `/projects/${c.req.param('projectId')}/tests/run`
  const newReq = new Request(url.toString(), {
    method: 'POST',
    headers: c.req.raw.headers,
    body: c.req.raw.body,
  })
  return router.fetch(newReq)
})

// List test traces
app.get('/api/projects/:projectId/tests/traces', async (c) => {
  const projectId = c.req.param('projectId')
  
  if (isKubernetes()) {
    // In Kubernetes: Proxy to runtime pod
    try {
      const { getProjectPodUrl } = await import('./lib/knative-project-manager')
      const podUrl = await getProjectPodUrl(projectId)
      const targetUrl = `${podUrl}/tests/traces`
      
      console.log(`[TestsProxy] Proxying traces list to ${targetUrl}`)
      
      const response = await fetch(targetUrl)
      const responseHeaders = new Headers()
      response.headers.forEach((value, key) => {
        if (!['transfer-encoding', 'connection'].includes(key.toLowerCase())) {
          responseHeaders.set(key, value)
        }
      })
      
      return new Response(response.body, {
        status: response.status,
        headers: responseHeaders,
      })
    } catch (error: any) {
      console.error(`[TestsProxy] Error proxying traces list:`, error)
      return c.json({
        error: { code: 'proxy_error', message: error.message || 'Failed to proxy to project runtime' }
      }, 502)
    }
  }
  
  // Local development: Return empty for now
  return c.json({ traces: [] })
})

// CORS headers for trace viewer (trace.playwright.dev)
const traceViewerCorsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Range',
  'Access-Control-Expose-Headers': 'Content-Length, Content-Range',
}

// Handle CORS preflight for trace files
app.options('/api/projects/:projectId/tests/traces/*', (c) => {
  return new Response(null, {
    status: 204,
    headers: traceViewerCorsHeaders,
  })
})

// Download a specific trace file
app.get('/api/projects/:projectId/tests/traces/*', async (c) => {
  const projectId = c.req.param('projectId')
  // Get the trace path from the URL (everything after /tests/traces/)
  const tracePath = c.req.path.replace(`/api/projects/${projectId}/tests/traces/`, '')
  
  if (isKubernetes()) {
    // In Kubernetes: Proxy to runtime pod
    try {
      const { getProjectPodUrl } = await import('./lib/knative-project-manager')
      const podUrl = await getProjectPodUrl(projectId)
      const targetUrl = `${podUrl}/tests/traces/${tracePath}`
      
      console.log(`[TestsProxy] Proxying trace download to ${targetUrl}`)
      
      const response = await fetch(targetUrl)
      const responseHeaders = new Headers()
      // Pass through all headers from runtime
      response.headers.forEach((value, key) => {
        if (!['transfer-encoding', 'connection'].includes(key.toLowerCase())) {
          responseHeaders.set(key, value)
        }
      })
      // Ensure CORS headers are set
      Object.entries(traceViewerCorsHeaders).forEach(([key, value]) => {
        responseHeaders.set(key, value)
      })
      
      return new Response(response.body, {
        status: response.status,
        headers: responseHeaders,
      })
    } catch (error: any) {
      console.error(`[TestsProxy] Error proxying trace download:`, error)
      return c.json({
        error: { code: 'proxy_error', message: error.message || 'Failed to proxy to project runtime' }
      }, 502)
    }
  }
  
  // Local development: Not implemented
  return c.json({ error: 'Not implemented' }, 501)
})

// Clear all traces
app.delete('/api/projects/:projectId/tests/traces', async (c) => {
  const projectId = c.req.param('projectId')
  
  if (isKubernetes()) {
    // In Kubernetes: Proxy to runtime pod
    try {
      const { getProjectPodUrl } = await import('./lib/knative-project-manager')
      const podUrl = await getProjectPodUrl(projectId)
      const targetUrl = `${podUrl}/tests/traces`
      
      console.log(`[TestsProxy] Proxying traces clear to ${targetUrl}`)
      
      const response = await fetch(targetUrl, { method: 'DELETE' })
      const responseHeaders = new Headers()
      response.headers.forEach((value, key) => {
        if (!['transfer-encoding', 'connection'].includes(key.toLowerCase())) {
          responseHeaders.set(key, value)
        }
      })
      
      return new Response(response.body, {
        status: response.status,
        headers: responseHeaders,
      })
    } catch (error: any) {
      console.error(`[TestsProxy] Error proxying traces clear:`, error)
      return c.json({
        error: { code: 'proxy_error', message: error.message || 'Failed to proxy to project runtime' }
      }, 502)
    }
  }
  
  // Local development: Not implemented
  return c.json({ ok: true, message: 'Not implemented in local mode' })
})

// =============================================================================
// Security scanning routes - Automated security analysis
// =============================================================================

// Rate limiting: one scan at a time, 10s cooldown (protects LLM spend)
let _scanInProgress = false
let _lastScanTimestamp = 0
const SCAN_COOLDOWN = 10_000

app.post('/api/projects/:projectId/security/scan', async (c) => {
  const projectId = c.req.param('projectId')

  // In local mode: enforce rate limiting (K8s pods handle their own)
  if (!isKubernetes()) {
    if (_scanInProgress) {
      return c.json({ ok: false, error: { code: 'scan_in_progress', message: 'A security scan is already running.' } }, 429)
    }
    const now = Date.now()
    if (now - _lastScanTimestamp < SCAN_COOLDOWN) {
      const wait = Math.ceil((SCAN_COOLDOWN - (now - _lastScanTimestamp)) / 1000)
      return c.json({ ok: false, error: { code: 'rate_limited', message: `Please wait ${wait}s before re-scanning.` } }, 429)
    }
  }

  if (isKubernetes()) {
    // In Kubernetes: Proxy to runtime pod
    try {
      const { getProjectPodUrl } = await import('./lib/knative-project-manager')
      const podUrl = await getProjectPodUrl(projectId)
      const targetUrl = `${podUrl}/security/scan`
      
      console.log(`[SecurityProxy] Proxying security scan to ${targetUrl}`)
      
      const response = await fetch(targetUrl, { method: 'POST' })
      
      // Handle non-OK responses
      if (!response.ok) {
        const contentType = response.headers.get('content-type') || ''
        if (contentType.includes('application/json')) {
          const responseHeaders = new Headers()
          response.headers.forEach((value, key) => {
            if (!['transfer-encoding', 'connection'].includes(key.toLowerCase())) {
              responseHeaders.set(key, value)
            }
          })
          return new Response(response.body, { status: response.status, headers: responseHeaders })
        }
        
        return c.json({
          error: { code: 'upstream_error', message: `Security scan service unavailable (${response.status})` }
        }, response.status as any)
      }
      
      const responseHeaders = new Headers()
      response.headers.forEach((value, key) => {
        if (!['transfer-encoding', 'connection'].includes(key.toLowerCase())) {
          responseHeaders.set(key, value)
        }
      })
      return new Response(response.body, {
        status: response.status,
        headers: responseHeaders,
      })
    } catch (error: any) {
      const isPodNotReady = error.message?.includes('not ready') || 
        error.message?.includes('not found') ||
        error.message?.includes('starting')
      
      if (isPodNotReady) {
        return c.json({
          error: { code: 'service_starting', message: 'Project runtime is starting...' }
        }, 503)
      }
      
      console.error(`[SecurityProxy] Error proxying security scan:`, error)
      return c.json({
        error: { code: 'proxy_error', message: error.message || 'Failed to proxy to project runtime' }
      }, 502)
    }
  }
  
  // Local/development mode: use local filesystem
  _scanInProgress = true
  try {
    const workspacesDir = process.env.WORKSPACES_DIR || resolve(PROJECT_ROOT, 'workspaces')
    const router = securityRoutes({ workspacesDir })
    const url = new URL(c.req.url)
    url.pathname = `/projects/${projectId}/security/scan`
    const newReq = new Request(url.toString(), { method: 'POST' })
    const result = await router.fetch(newReq)
    _lastScanTimestamp = Date.now()
    return result
  } finally {
    _scanInProgress = false
  }
})


// =============================================================================
// Database routes - Prisma Studio management for project workspaces
// =============================================================================

// Start Prisma Studio
app.post('/api/projects/:projectId/database/start', async (c) => {
  const projectId = c.req.param('projectId')
  
  if (isKubernetes()) {
    // In Kubernetes: Proxy to runtime pod
    try {
      const { getProjectPodUrl } = await import('./lib/knative-project-manager')
      const podUrl = await getProjectPodUrl(projectId)
      const targetUrl = `${podUrl}/database/start`
      
      console.log(`[DatabaseProxy] Proxying start to ${targetUrl}`)
      
      const response = await fetch(targetUrl, { method: 'POST' })
      
      // Handle non-OK responses with proper JSON errors
      if (!response.ok) {
        const contentType = response.headers.get('content-type') || ''
        
        // If response is JSON, pass it through
        if (contentType.includes('application/json')) {
          const responseHeaders = new Headers()
          response.headers.forEach((value, key) => {
            if (!['transfer-encoding', 'connection'].includes(key.toLowerCase())) {
              responseHeaders.set(key, value)
            }
          })
          return new Response(response.body, { status: response.status, headers: responseHeaders })
        }
        
        // Non-JSON error (like Knative 503) - return proper JSON
        const errorCode = response.status === 503 ? 'pod_starting' 
          : response.status === 502 ? 'pod_unavailable' : 'upstream_error'
        
        return c.json({
          error: { code: errorCode, message: `Database service unavailable (${response.status})` }
        }, response.status as any)
      }
      
      const responseHeaders = new Headers()
      response.headers.forEach((value, key) => {
        if (!['transfer-encoding', 'connection'].includes(key.toLowerCase())) {
          responseHeaders.set(key, value)
        }
      })
      
      return new Response(response.body, {
        status: response.status,
        headers: responseHeaders,
      })
    } catch (error: any) {
      console.error('[DatabaseProxy] Error:', error)
      return c.json({
        error: { code: 'proxy_error', message: error.message || 'Failed to start database' }
      }, 502)
    }
  }
  
  // Local development: Use local filesystem
  const workspacesDir = process.env.WORKSPACES_DIR || resolve(PROJECT_ROOT, 'workspaces')
  const router = databaseRoutes({ workspacesDir })
  const url = new URL(c.req.url)
  url.pathname = `/projects/${projectId}/database/start`
  const newReq = new Request(url.toString(), { method: 'POST' })
  return router.fetch(newReq)
})

// Stop Prisma Studio
app.post('/api/projects/:projectId/database/stop', async (c) => {
  const projectId = c.req.param('projectId')
  
  if (isKubernetes()) {
    // In Kubernetes: Proxy to runtime pod
    try {
      const { getProjectPodUrl } = await import('./lib/knative-project-manager')
      const podUrl = await getProjectPodUrl(projectId)
      const targetUrl = `${podUrl}/database/stop`
      
      console.log(`[DatabaseProxy] Proxying stop to ${targetUrl}`)
      
      const response = await fetch(targetUrl, { method: 'POST' })
      
      // Handle non-OK responses with proper JSON errors
      if (!response.ok) {
        const contentType = response.headers.get('content-type') || ''
        
        // If response is JSON, pass it through
        if (contentType.includes('application/json')) {
          const responseHeaders = new Headers()
          response.headers.forEach((value, key) => {
            if (!['transfer-encoding', 'connection'].includes(key.toLowerCase())) {
              responseHeaders.set(key, value)
            }
          })
          return new Response(response.body, { status: response.status, headers: responseHeaders })
        }
        
        // Non-JSON error (like Knative 503) - return proper JSON
        const errorCode = response.status === 503 ? 'pod_starting' 
          : response.status === 502 ? 'pod_unavailable' : 'upstream_error'
        
        return c.json({
          error: { code: errorCode, message: `Database service unavailable (${response.status})` }
        }, response.status as any)
      }
      
      const responseHeaders = new Headers()
      response.headers.forEach((value, key) => {
        if (!['transfer-encoding', 'connection'].includes(key.toLowerCase())) {
          responseHeaders.set(key, value)
        }
      })
      
      return new Response(response.body, {
        status: response.status,
        headers: responseHeaders,
      })
    } catch (error: any) {
      console.error('[DatabaseProxy] Error:', error)
      return c.json({
        error: { code: 'proxy_error', message: error.message || 'Failed to stop database' }
      }, 502)
    }
  }
  
  // Local development: Use local filesystem
  const workspacesDir = process.env.WORKSPACES_DIR || resolve(PROJECT_ROOT, 'workspaces')
  const router = databaseRoutes({ workspacesDir })
  const url = new URL(c.req.url)
  url.pathname = `/projects/${projectId}/database/stop`
  const newReq = new Request(url.toString(), { method: 'POST' })
  return router.fetch(newReq)
})

// Get Prisma Studio status
app.get('/api/projects/:projectId/database/status', async (c) => {
  const projectId = c.req.param('projectId')
  
  if (isKubernetes()) {
    // In Kubernetes: Proxy to runtime pod
    try {
      const { getProjectPodUrl } = await import('./lib/knative-project-manager')
      const podUrl = await getProjectPodUrl(projectId)
      const targetUrl = `${podUrl}/database/status`
      
      console.log(`[DatabaseProxy] Proxying status to ${targetUrl}`)
      
      const response = await fetch(targetUrl)
      
      // Handle non-OK responses with proper JSON errors
      if (!response.ok) {
        const contentType = response.headers.get('content-type') || ''
        
        // If response is JSON, pass it through
        if (contentType.includes('application/json')) {
          const responseHeaders = new Headers()
          response.headers.forEach((value, key) => {
            if (!['transfer-encoding', 'connection'].includes(key.toLowerCase())) {
              responseHeaders.set(key, value)
            }
          })
          return new Response(response.body, { status: response.status, headers: responseHeaders })
        }
        
        // Non-JSON error (like Knative 503) - return proper JSON
        const errorCode = response.status === 503 ? 'pod_starting' 
          : response.status === 502 ? 'pod_unavailable' : 'upstream_error'
        
        return c.json({
          status: 'error',
          error: { code: errorCode, message: `Database service unavailable (${response.status})` }
        }, response.status as any)
      }
      
      const responseHeaders = new Headers()
      response.headers.forEach((value, key) => {
        if (!['transfer-encoding', 'connection'].includes(key.toLowerCase())) {
          responseHeaders.set(key, value)
        }
      })
      
      return new Response(response.body, {
        status: response.status,
        headers: responseHeaders,
      })
    } catch (error: any) {
      console.error('[DatabaseProxy] Error:', error)
      return c.json({
        error: { code: 'proxy_error', message: error.message || 'Failed to get database status' }
      }, 502)
    }
  }
  
  // Local development: Use local filesystem
  const workspacesDir = process.env.WORKSPACES_DIR || resolve(PROJECT_ROOT, 'workspaces')
  const router = databaseRoutes({ workspacesDir })
  const url = new URL(c.req.url)
  url.pathname = `/projects/${projectId}/database/status`
  const newReq = new Request(url.toString(), { method: 'GET' })
  return router.fetch(newReq)
})

// Get Prisma Studio URL (starts if needed)
app.get('/api/projects/:projectId/database/url', async (c) => {
  const projectId = c.req.param('projectId')
  
  if (isKubernetes()) {
    // In Kubernetes: Proxy to runtime pod
    try {
      const { getProjectPodUrl } = await import('./lib/knative-project-manager')
      const podUrl = await getProjectPodUrl(projectId)
      const targetUrl = `${podUrl}/database/url`
      
      console.log(`[DatabaseProxy] Proxying URL request to ${targetUrl}`)
      
      const response = await fetch(targetUrl)
      
      // Handle non-OK responses before trying to parse JSON
      // Knative returns 503 with HTML/text when pod is starting
      if (!response.ok) {
        const contentType = response.headers.get('content-type') || ''
        
        // Try to parse JSON error response from runtime
        if (contentType.includes('application/json')) {
          try {
            const errorData = await response.json()
            return c.json(errorData, response.status as any)
          } catch {
            // Fall through to text handling
          }
        }
        
        // Non-JSON error response (like Knative 503)
        let errorMessage = `Upstream returned ${response.status}`
        try {
          const errorText = await response.text()
          // Truncate long HTML error pages
          errorMessage = errorText.slice(0, 200) || errorMessage
        } catch {
          // Ignore text read errors
        }
        
        // Map common status codes to appropriate error codes
        const errorCode = response.status === 503 ? 'pod_starting' 
          : response.status === 502 ? 'pod_unavailable'
          : response.status === 504 ? 'pod_timeout'
          : 'upstream_error'
        
        // Only log non-503 errors (503 is expected during pod startup)
        if (response.status !== 503) {
          console.error(`[DatabaseProxy] Upstream error ${response.status}: ${errorMessage}`)
        }
        
        return c.json({
          status: 'error',
          url: null,
          error: { code: errorCode, message: errorMessage }
        }, response.status as any)
      }
      
      // Verify response is JSON before parsing
      const contentType = response.headers.get('content-type') || ''
      if (!contentType.includes('application/json')) {
        console.error(`[DatabaseProxy] Unexpected content-type: ${contentType}`)
        return c.json({
          status: 'error',
          url: null,
          error: { code: 'invalid_response', message: `Unexpected content-type: ${contentType}` }
        }, 502)
      }
      
      const data = await response.json()
      
      // Transform 'proxy' URL to actual proxy path through API
      if (data.url === 'proxy') {
        data.url = `/api/projects/${projectId}/database/proxy/`
      }
      
      return c.json(data, response.status as any)
    } catch (error: any) {
      console.error('[DatabaseProxy] Error:', error)
      return c.json({
        status: 'error',
        url: null,
        error: { code: 'proxy_error', message: error.message || 'Failed to get database URL' }
      }, 502)
    }
  }
  
  // Local development: Use local filesystem
  const workspacesDir = process.env.WORKSPACES_DIR || resolve(PROJECT_ROOT, 'workspaces')
  const router = databaseRoutes({ workspacesDir })
  const url = new URL(c.req.url)
  url.pathname = `/projects/${projectId}/database/url`
  const newReq = new Request(url.toString(), { method: 'GET' })
  return router.fetch(newReq)
})

// Proxy requests to Prisma Studio running on project pod
app.all('/api/projects/:projectId/database/proxy', async (c) => {
  const projectId = c.req.param('projectId')
  
  if (!isKubernetes()) {
    // Local development not supported for proxy yet
    return c.json({ error: 'Database proxy not available in local development' }, 501)
  }
  
  try {
    const { getProjectPodUrl } = await import('./lib/knative-project-manager')
    const podUrl = await getProjectPodUrl(projectId)
    const targetUrl = `${podUrl}/database/proxy`
    
    // Tell runtime the external base path for URL rewriting
    const externalBasePath = `/api/projects/${projectId}/database/proxy/`
    
    console.log(`[DatabaseProxy] Proxying to ${targetUrl} (external base: ${externalBasePath})`)
    
    const reqHeaders: Record<string, string> = {
      'Accept': c.req.header('Accept') || '*/*',
      'X-Proxy-Base-Path': externalBasePath,
    }
    const contentType = c.req.header('Content-Type')
    if (contentType) {
      reqHeaders['Content-Type'] = contentType
    }
    
    const response = await fetch(targetUrl, {
      method: c.req.method,
      headers: reqHeaders,
      body: ['POST', 'PUT', 'PATCH'].includes(c.req.method) ? await c.req.arrayBuffer() : undefined,
    })
    
    const responseHeaders = new Headers()
    response.headers.forEach((value, key) => {
      if (!['transfer-encoding', 'connection', 'content-encoding'].includes(key.toLowerCase())) {
        responseHeaders.set(key, value)
      }
    })
    
    return new Response(response.body, {
      status: response.status,
      headers: responseHeaders,
    })
  } catch (error: any) {
    console.error('[DatabaseProxy] Error:', error)
    return c.json({ error: 'Failed to proxy to Prisma Studio' }, 502)
  }
})

app.all('/api/projects/:projectId/database/proxy/*', async (c) => {
  const projectId = c.req.param('projectId')
  
  if (!isKubernetes()) {
    return c.json({ error: 'Database proxy not available in local development' }, 501)
  }
  
  try {
    const { getProjectPodUrl } = await import('./lib/knative-project-manager')
    const podUrl = await getProjectPodUrl(projectId)
    
    // Get the path after /database/proxy
    const fullPath = c.req.path
    const proxyPath = fullPath.replace(`/api/projects/${projectId}/database/proxy`, '') || '/'
    const query = c.req.url.includes('?') ? '?' + c.req.url.split('?')[1] : ''
    const targetUrl = `${podUrl}/database/proxy${proxyPath}${query}`
    
    // Tell runtime the external base path for URL rewriting
    const externalBasePath = `/api/projects/${projectId}/database/proxy/`
    
    console.log(`[DatabaseProxy] Proxying to ${targetUrl}`)
    
    const reqHeaders: Record<string, string> = {
      'Accept': c.req.header('Accept') || '*/*',
      'X-Proxy-Base-Path': externalBasePath,
    }
    const contentType = c.req.header('Content-Type')
    if (contentType) {
      reqHeaders['Content-Type'] = contentType
    }
    
    const response = await fetch(targetUrl, {
      method: c.req.method,
      headers: reqHeaders,
      body: ['POST', 'PUT', 'PATCH'].includes(c.req.method) ? await c.req.arrayBuffer() : undefined,
    })
    
    const responseHeaders = new Headers()
    response.headers.forEach((value, key) => {
      if (!['transfer-encoding', 'connection', 'content-encoding'].includes(key.toLowerCase())) {
        responseHeaders.set(key, value)
      }
    })
    
    return new Response(response.body, {
      status: response.status,
      headers: responseHeaders,
    })
  } catch (error: any) {
    console.error('[DatabaseProxy] Error:', error)
    return c.json({ error: 'Failed to proxy to Prisma Studio' }, 502)
  }
})

// =============================================================================
// Checkpoint Routes (version control for projects)
// =============================================================================

const workspacesDirResolved = process.env.WORKSPACES_DIR || resolve(PROJECT_ROOT, 'workspaces')

// Mount checkpoint routes
const checkpointRouter = checkpointRoutes({ workspacesDir: workspacesDirResolved })
app.route('/api', checkpointRouter)

// Mount GitHub routes
const githubRouter = githubRoutes({ workspacesDir: workspacesDirResolved })
app.route('/api', githubRouter)

// =============================================================================
// Project Chat Proxy Routes (pod-per-project architecture)
// =============================================================================

// Auth guard shared by all chat proxy routes
async function requireProjectAuth(c: any): Promise<{ error: Response } | { projectId: string }> {
  const projectId = c.req.param('projectId')
  const userId = await getAuthUserId(c)
  if (!userId) {
    return { error: c.json({ error: { code: 'unauthorized', message: 'Authentication required' } }, 401) }
  }
  const wsId = await verifyProjectAccess(userId, projectId)
  if (!wsId) {
    return { error: c.json({ error: { code: 'forbidden', message: 'No access to this project' } }, 403) }
  }
  return { projectId }
}

// =============================================================================
// Heartbeat Config Routes (session-authenticated, for the mobile/web UI)
// =============================================================================

app.get('/api/projects/:projectId/heartbeat', async (c) => {
  const authResult = await requireProjectAuth(c)
  if ('error' in authResult) return authResult.error

  const isLocal = process.env.SHOGO_LOCAL_MODE === 'true'
  const select: Record<string, boolean> = {
    heartbeatEnabled: true,
    heartbeatInterval: true,
    nextHeartbeatAt: true,
    modelName: true,
  }
  if (!isLocal) {
    select.lastHeartbeatAt = true
    select.quietHoursStart = true
    select.quietHoursEnd = true
    select.quietHoursTimezone = true
  }

  const config = await prisma.agentConfig.findUnique({
    where: { projectId: authResult.projectId },
    select,
  })

  if (!config) {
    return c.json({ error: 'Agent config not found' }, 404)
  }

  return c.json(config)
})

app.patch('/api/projects/:projectId/heartbeat', async (c) => {
  const authResult = await requireProjectAuth(c)
  if ('error' in authResult) return authResult.error

  const body = await c.req.json()
  const data: Record<string, any> = {}

  if (typeof body.heartbeatEnabled === 'boolean') {
    data.heartbeatEnabled = body.heartbeatEnabled
  }
  if (typeof body.heartbeatInterval === 'number' && body.heartbeatInterval >= 60) {
    data.heartbeatInterval = body.heartbeatInterval
  }
  if (process.env.SHOGO_LOCAL_MODE !== 'true') {
    if (body.quietHoursStart !== undefined) data.quietHoursStart = body.quietHoursStart || null
    if (body.quietHoursEnd !== undefined) data.quietHoursEnd = body.quietHoursEnd || null
    if (body.quietHoursTimezone !== undefined) data.quietHoursTimezone = body.quietHoursTimezone || null
  }

  const existing = await prisma.agentConfig.findUnique({
    where: { projectId: authResult.projectId },
    include: { project: { select: { workspaceId: true } } },
  })
  if (!existing) {
    return c.json({ error: 'Agent config not found' }, 404)
  }

  const enabled = data.heartbeatEnabled ?? existing.heartbeatEnabled
  const interval = data.heartbeatInterval ?? existing.heartbeatInterval

  if (enabled && existing.project?.workspaceId) {
    const isPaid = await billingService.hasPaidSubscription(existing.project.workspaceId)
    if (!isPaid) {
      return c.json(
        { error: { code: 'paywall', message: 'Heartbeats require a paid plan. Please upgrade to enable scheduled heartbeats.' } },
        402
      )
    }
  }

  if (enabled) {
    const jitter = Math.floor(Math.random() * interval * 0.1) * 1000
    data.nextHeartbeatAt = new Date(Date.now() + interval * 1000 + jitter)
  } else {
    data.nextHeartbeatAt = null
  }

  const isLocal = process.env.SHOGO_LOCAL_MODE === 'true'
  const updateSelect: Record<string, boolean> = {
    heartbeatEnabled: true,
    heartbeatInterval: true,
    nextHeartbeatAt: true,
    modelName: true,
  }
  if (!isLocal) {
    updateSelect.lastHeartbeatAt = true
    updateSelect.quietHoursStart = true
    updateSelect.quietHoursEnd = true
    updateSelect.quietHoursTimezone = true
  }

  const updated = await prisma.agentConfig.update({
    where: { projectId: authResult.projectId },
    data,
    select: updateSelect,
  })

  return c.json(updated)
})

// Sync heartbeat config from runtime config.json to DB (local mode).
// Authenticated via x-runtime-token so the agent runtime can call it.
app.put('/api/projects/:projectId/heartbeat/sync', async (c) => {
  const projectId = c.req.param('projectId')
  const token = c.req.header('x-runtime-token')

  const { deriveRuntimeToken } = await import('./lib/runtime-token')
  if (!token || token !== deriveRuntimeToken(projectId)) {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  const body = await c.req.json()
  const data: Record<string, any> = {}

  if (typeof body.heartbeatEnabled === 'boolean') {
    data.heartbeatEnabled = body.heartbeatEnabled
  }
  if (typeof body.heartbeatInterval === 'number' && body.heartbeatInterval >= 60) {
    data.heartbeatInterval = body.heartbeatInterval
  }

  const existing = await prisma.agentConfig.findUnique({ where: { projectId } })
  const enabled = data.heartbeatEnabled ?? existing?.heartbeatEnabled ?? false
  const interval = data.heartbeatInterval ?? existing?.heartbeatInterval ?? 1800

  if (enabled) {
    const jitter = Math.floor(Math.random() * interval * 0.1) * 1000
    data.nextHeartbeatAt = new Date(Date.now() + interval * 1000 + jitter)
  } else {
    data.nextHeartbeatAt = null
  }

  await prisma.agentConfig.upsert({
    where: { projectId },
    update: data,
    create: {
      projectId,
      heartbeatEnabled: enabled,
      heartbeatInterval: interval,
      nextHeartbeatAt: data.nextHeartbeatAt,
      channels: [],
    },
  })

  return c.json({ ok: true })
})

// POST /api/projects/:projectId/chat - Proxy chat to project pod
app.post('/api/projects/:projectId/chat', async (c) => {
  if (isShuttingDown) {
    return c.json({ error: { code: 'shutting_down', message: 'Server is shutting down, please retry' } }, 503)
  }

  const authResult = await requireProjectAuth(c)
  if ('error' in authResult) return authResult.error

  activeProxyConnections++
  const manager = getRuntimeManager()
  const router = projectChatRoutes({ runtimeManager: manager })
  const url = new URL(c.req.url)
  url.pathname = `/projects/${c.req.param('projectId')}/chat`
  const newReq = new Request(url.toString(), {
    method: 'POST',
    headers: c.req.raw.headers,
    body: c.req.raw.body,
  })
  try {
    const resp = await router.fetch(newReq)
    if (resp.body) {
      const trackedBody = resp.body.pipeThrough(new TransformStream({
        flush() { activeProxyConnections-- },
      }))
      c.req.raw.signal.addEventListener('abort', () => { activeProxyConnections = Math.max(0, activeProxyConnections - 1) })
      return new Response(trackedBody, { status: resp.status, headers: resp.headers })
    }
    activeProxyConnections--
    return resp
  } catch (err) {
    activeProxyConnections--
    throw err
  }
})

// GET /api/projects/:projectId/chat/status - Check project runtime status
app.get('/api/projects/:projectId/chat/status', async (c) => {
  const authResult = await requireProjectAuth(c)
  if ('error' in authResult) return authResult.error

  const manager = getRuntimeManager()
  const router = projectChatRoutes({ runtimeManager: manager })
  const url = new URL(c.req.url)
  url.pathname = `/projects/${c.req.param('projectId')}/chat/status`
  const newReq = new Request(url.toString(), { method: 'GET' })
  return router.fetch(newReq)
})

// POST /api/projects/:projectId/chat/stop - Stop/interrupt active generation
app.post('/api/projects/:projectId/chat/stop', async (c) => {
  const authResult = await requireProjectAuth(c)
  if ('error' in authResult) return authResult.error

  const manager = getRuntimeManager()
  const router = projectChatRoutes({ runtimeManager: manager })
  const url = new URL(c.req.url)
  url.pathname = `/projects/${c.req.param('projectId')}/chat/stop`
  const newReq = new Request(url.toString(), {
    method: 'POST',
    headers: c.req.raw.headers,
    body: c.req.raw.body,
  })
  return router.fetch(newReq)
})

// POST /api/projects/:projectId/chat/wake - Wake up a scaled-to-zero pod
app.post('/api/projects/:projectId/chat/wake', async (c) => {
  const authResult = await requireProjectAuth(c)
  if ('error' in authResult) return authResult.error

  const manager = getRuntimeManager()
  const router = projectChatRoutes({ runtimeManager: manager })
  const url = new URL(c.req.url)
  url.pathname = `/projects/${c.req.param('projectId')}/chat/wake`
  const newReq = new Request(url.toString(), { method: 'POST' })
  return router.fetch(newReq)
})

// POST /api/projects/:projectId/permission-response - Proxy permission approval to agent runtime
app.post('/api/projects/:projectId/permission-response', async (c) => {
  const authResult = await requireProjectAuth(c)
  if ('error' in authResult) return authResult.error

  const manager = getRuntimeManager()
  const router = projectChatRoutes({ runtimeManager: manager })
  const url = new URL(c.req.url)
  url.pathname = `/projects/${c.req.param('projectId')}/permission-response`
  const newReq = new Request(url.toString(), {
    method: 'POST',
    headers: c.req.raw.headers,
    body: c.req.raw.body,
  })
  return router.fetch(newReq)
})

// =============================================================================
// Project Admin Routes (Kubernetes pod management)
// Require super_admin role for all project admin endpoints
// =============================================================================

app.use('/api/admin/pods/*', authMiddleware, requireAuth, requireSuperAdmin)
app.use('/api/admin/pods', authMiddleware, requireAuth, requireSuperAdmin)
app.use('/api/admin/pod-stats', authMiddleware, requireAuth, requireSuperAdmin)
app.use('/api/admin/warm-pool', authMiddleware, requireAuth, requireSuperAdmin)
app.use('/api/admin/warm-pool/*', authMiddleware, requireAuth, requireSuperAdmin)
app.use('/api/admin/settings/*', authMiddleware, requireAuth, requireSuperAdmin)
app.use('/api/admin/regions', authMiddleware, requireAuth, requireSuperAdmin)
app.use('/api/admin/regions/*', authMiddleware, requireAuth, requireSuperAdmin)

// GET /api/admin/pods - List all project pods
app.get('/api/admin/pods', async (c) => {
  const router = projectAdminRoutes()
  const url = new URL(c.req.url)
  url.pathname = '/admin/pods'
  const newReq = new Request(url.toString(), { method: 'GET' })
  return router.fetch(newReq)
})

// GET /api/admin/pod-stats - Get aggregate pod stats
app.get('/api/admin/pod-stats', async (c) => {
  const router = projectAdminRoutes()
  const url = new URL(c.req.url)
  url.pathname = '/admin/pod-stats'
  const newReq = new Request(url.toString(), { method: 'GET' })
  return router.fetch(newReq)
})

// GET /api/admin/pods/:projectId - Get project pod status
app.get('/api/admin/pods/:projectId', async (c) => {
  const router = projectAdminRoutes()
  const url = new URL(c.req.url)
  url.pathname = `/admin/pods/${c.req.param('projectId')}`
  const newReq = new Request(url.toString(), { method: 'GET' })
  return router.fetch(newReq)
})

// POST /api/admin/pods/:projectId/scale - Scale project pod
app.post('/api/admin/pods/:projectId/scale', async (c) => {
  const router = projectAdminRoutes()
  const url = new URL(c.req.url)
  url.pathname = `/admin/pods/${c.req.param('projectId')}/scale`
  const newReq = new Request(url.toString(), {
    method: 'POST',
    headers: c.req.raw.headers,
    body: c.req.raw.body,
  })
  return router.fetch(newReq)
})

// POST /api/admin/pods/:projectId/warmup - Warm up a project pod
app.post('/api/admin/pods/:projectId/warmup', async (c) => {
  const router = projectAdminRoutes()
  const url = new URL(c.req.url)
  url.pathname = `/admin/pods/${c.req.param('projectId')}/warmup`
  const newReq = new Request(url.toString(), { method: 'POST' })
  return router.fetch(newReq)
})

// =============================================================================
// Region Management Routes
// =============================================================================

const REGION_ID = process.env.REGION_ID || 'unknown'
const REGION_LABEL = process.env.REGION_LABEL || REGION_ID
const REGION_PEERS: Array<{ id: string; label: string; url: string }> = (() => {
  try {
    return JSON.parse(process.env.REGION_PEERS || '[]')
  } catch {
    return []
  }
})()
const HOST_HEADER_FOR_PEERS = process.env.HOST_HEADER_FOR_PEERS || 'studio.shogo.ai'

app.get('/api/admin/regions', (c) => {
  return c.json({
    current: { id: REGION_ID, label: REGION_LABEL },
    peers: REGION_PEERS.map(({ id, label }) => ({ id, label })),
  })
})

app.all('/api/admin/regions/:regionId/*', async (c) => {
  const targetRegionId = c.req.param('regionId')
  const peer = REGION_PEERS.find((p) => p.id === targetRegionId)

  if (!peer) {
    return c.json({ error: `Unknown region: ${targetRegionId}` }, 404)
  }

  const originalUrl = new URL(c.req.url)
  const proxyPath = originalUrl.pathname.replace(`/api/admin/regions/${targetRegionId}`, '')
  const targetUrl = new URL(proxyPath || '/', peer.url)
  targetUrl.search = originalUrl.search

  const headers = new Headers()
  headers.set('Content-Type', c.req.header('Content-Type') || 'application/json')
  headers.set('Host', HOST_HEADER_FOR_PEERS)
  headers.set('Origin', `https://${HOST_HEADER_FOR_PEERS}`)
  const cookie = c.req.header('Cookie')
  if (cookie) headers.set('Cookie', cookie)
  const authorization = c.req.header('Authorization')
  if (authorization) headers.set('Authorization', authorization)

  try {
    const body = (c.req.method !== 'GET' && c.req.method !== 'HEAD')
      ? await c.req.text()
      : undefined

    const resp = await fetch(targetUrl.toString(), {
      method: c.req.method,
      headers,
      body,
      ...(typeof Bun !== 'undefined' ? { tls: { rejectUnauthorized: false } } : {}),
    } as any)

    const respBody = await resp.text()
    return new Response(respBody, {
      status: resp.status,
      headers: { 'Content-Type': resp.headers.get('Content-Type') || 'application/json' },
    })
  } catch (err: any) {
    return c.json({ error: `Proxy to ${peer.label} failed: ${err.message}` }, 502)
  }
})

// GET /api/admin/warm-pool - Extended warm pool status with promoted pods and GC stats
app.get('/api/admin/warm-pool', async (c) => {
  try {
    const { getWarmPoolController } = await import('./lib/warm-pool-controller')
    const controller = getWarmPoolController()
    const extended = await controller.getExtendedStatus()

    // Enrich promoted pods with project names from DB
    const promotedPods = controller.getPromotedPods()
    let enrichedPods = promotedPods.map((p) => ({
      ...p,
      projectName: null as string | null,
      idleSeconds: null as number | null,
    }))

    try {
      const { prisma } = await import('./lib/prisma')
      const projectIds = [...new Set(promotedPods.map((p) => p.projectId).filter(Boolean))]
      if (projectIds.length > 0) {
        const projects = await prisma.project.findMany({
          where: { id: { in: projectIds } },
          select: { id: true, name: true },
        })
        const nameMap = new Map(projects.map((p) => [p.id, p.name]))
        enrichedPods = enrichedPods.map((p) => ({
          ...p,
          projectName: nameMap.get(p.projectId) ?? null,
        }))
      }
    } catch { /* non-fatal */ }

    // Probe promoted pods for activity (parallel, 3s timeout)
    const probeResults = await Promise.allSettled(
      enrichedPods.map(async (pod) => {
        try {
          const resp = await fetch(`${pod.url}/pool/activity`, {
            signal: AbortSignal.timeout(3000),
          })
          if (resp.ok) {
            const data = await resp.json() as { idleSeconds: number }
            return { serviceName: pod.serviceName, idleSeconds: data.idleSeconds }
          }
        } catch { /* pod unreachable */ }
        return { serviceName: pod.serviceName, idleSeconds: null }
      })
    )
    const idleMap = new Map<string, number | null>()
    for (const result of probeResults) {
      if (result.status === 'fulfilled') {
        idleMap.set(result.value.serviceName, result.value.idleSeconds)
      }
    }
    enrichedPods = enrichedPods.map((p) => ({
      ...p,
      idleSeconds: idleMap.get(p.serviceName) ?? null,
    }))

    return c.json({
      pool: {
        enabled: extended.enabled,
        available: extended.available,
        assigned: extended.assigned,
        targetSize: extended.targetSize,
      },
      cluster: extended.cluster,
      promotedPods: enrichedPods,
      gcStats: extended.gcStats,
    })
  } catch (err: any) {
    return c.json({ enabled: false, error: err.message })
  }
})

// POST /api/admin/warm-pool/gc - Manually trigger promoted pod GC
app.post('/api/admin/warm-pool/gc', async (c) => {
  try {
    const { getWarmPoolController } = await import('./lib/warm-pool-controller')
    const controller = getWarmPoolController()
    const result = await controller.gcPromotedPods()
    return c.json({ ok: true, ...result })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

// POST /api/admin/warm-pool/evict/:projectId - Evict project from its current pod
// The next request for this project will claim a fresh warm pod.
app.post('/api/admin/warm-pool/evict/:projectId', async (c) => {
  const projectId = c.req.param('projectId')
  try {
    const { getWarmPoolController } = await import('./lib/warm-pool-controller')
    const controller = getWarmPoolController()
    const result = await controller.evictProject(projectId)
    return c.json({ ok: true, projectId, ...result })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

// POST /api/admin/warm-pool/evict-all - Evict all projects from old pods
// Useful after deploys to force all projects onto fresh pods.
app.post('/api/admin/warm-pool/evict-all', async (c) => {
  try {
    const { getWarmPoolController } = await import('./lib/warm-pool-controller')
    const controller = getWarmPoolController()
    const { prisma } = await import('./lib/prisma')

    const projects = await prisma.project.findMany({
      where: { knativeServiceName: { not: null } },
      select: { id: true, knativeServiceName: true },
    })

    const results: Array<{ projectId: string; oldService: string | null; evicted: boolean }> = []
    for (const project of projects) {
      const result = await controller.evictProject(project.id)
      results.push({
        projectId: project.id,
        oldService: project.knativeServiceName,
        evicted: result.evicted,
      })
    }

    return c.json({ ok: true, evicted: results.length, results })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

// =============================================================================
// Infrastructure Settings (runtime-configurable, persisted to DB)
// =============================================================================

const INFRA_SETTINGS_KEYS = [
  'warmPoolMinPods',
  'reconcileIntervalMs',
  'maxPodAgeMs',
  'promotedPodIdleTimeoutMs',
  'promotedPodGcEnabled',
] as const

// GET /api/admin/settings/infrastructure - Read current infra config
app.get('/api/admin/settings/infrastructure', async (c) => {
  try {
    const { getWarmPoolController } = await import('./lib/warm-pool-controller')
    const controller = getWarmPoolController()
    return c.json(controller.getConfig())
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

// PATCH /api/admin/settings/infrastructure - Update infra config at runtime
app.patch('/api/admin/settings/infrastructure', async (c) => {
  try {
    const body = await c.req.json()

    // Validate: only allow known keys, with type checks
    const patch: Record<string, any> = {}
    for (const key of INFRA_SETTINGS_KEYS) {
      if (body[key] === undefined) continue
      if (key === 'promotedPodGcEnabled') {
        if (typeof body[key] !== 'boolean') {
          return c.json({ error: `${key} must be a boolean` }, 400)
        }
        patch[key] = body[key]
      } else {
        const val = Number(body[key])
        if (!Number.isFinite(val) || val < 0) {
          return c.json({ error: `${key} must be a non-negative number` }, 400)
        }
        patch[key] = Math.round(val)
      }
    }

    if (Object.keys(patch).length === 0) {
      return c.json({ error: 'No valid settings provided' }, 400)
    }

    // Apply to controller
    const { getWarmPoolController } = await import('./lib/warm-pool-controller')
    const controller = getWarmPoolController()
    controller.updateConfig(patch)

    // Persist each setting to DB
    const { prisma } = await import('./lib/prisma')
    const auth = c.get('auth') as any
    const userId = auth?.user?.id || 'unknown'

    for (const [key, value] of Object.entries(patch)) {
      await prisma.platformSetting.upsert({
        where: { key: `infra.${key}` },
        create: { key: `infra.${key}`, value: String(value), updatedBy: userId },
        update: { value: String(value), updatedBy: userId },
      })
    }

    return c.json({ ok: true, applied: patch, config: controller.getConfig() })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

// DELETE /api/admin/pods/:projectId - Delete project pod
app.delete('/api/admin/pods/:projectId', async (c) => {
  const router = projectAdminRoutes()
  const url = new URL(c.req.url)
  url.pathname = `/admin/pods/${c.req.param('projectId')}`
  const newReq = new Request(url.toString(), { method: 'DELETE' })
  return router.fetch(newReq)
})

/**
 * Generate a project name from a user prompt using a small language model.
 * This endpoint provides a fast, lightweight way to generate meaningful project names
 * without the overhead of the full chat interface.
 * 
 * Request body:
 * - prompt: string - The user's description of what they want to build
 * 
 * Response:
 * - name: string - A short, descriptive project name (2-4 words)
 */
/**
 * Fallback function for generating project names when AI is unavailable.
 * Extracts meaningful words from the prompt.
 */
function fallbackGenerateProjectName(prompt: string): string {
  const fillerWords = new Set([
    // articles & pronouns
    "a", "an", "the", "to", "for", "with", "that", "this", "is", "are",
    "my", "me", "its", "it", "our", "your", "their",
    // verbs (action words from prompts)
    "create", "build", "make", "design", "develop", "implement", "add", "include",
    "show", "showing", "display", "have", "has", "using", "use",
    // polite / conversational
    "please", "can", "you", "i", "want", "need", "would", "like",
    // generic tech words
    "simple", "basic", "web", "app", "application", "website", "page",
    // conjunctions & prepositions that slip through
    "where", "when", "how", "what", "which", "each", "every", "some",
    "and", "but", "also", "then", "from", "into", "about", "just",
    "nice", "good", "new", "should", "could",
  ])

  const words = prompt.toLowerCase()
    .replace(/[^\w\s]/g, "")
    .split(/\s+/)
    .filter(word => word.length > 2 && !fillerWords.has(word))

  const nameWords = words.slice(0, 3)

  if (nameWords.length === 0) {
    return "New Project"
  }

  return nameWords
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ")
}

app.post('/api/generate-project-name', async (c) => {
  try {
    const authCtx = c.get('auth') as any
    const authUserId = authCtx?.userId
    const { prompt, workspaceId, projectId } = await c.req.json()

    if (!prompt || typeof prompt !== 'string') {
      return c.json({ error: 'Prompt is required' }, 400)
    }

    if (projectId && authUserId) {
      const access = await verifyProjectAccess(authUserId, projectId)
      if (!access) {
        return c.json({ error: { code: 'forbidden', message: 'Access denied to this project' } }, 403)
      }
    }

    if (workspaceId && !await verifyWorkspaceMembership(c, workspaceId)) {
      return c.json({ error: { code: 'forbidden', message: 'Access denied to this workspace' } }, 403)
    }

    // Check if ANTHROPIC_API_KEY is available
    if (!process.env.ANTHROPIC_API_KEY) {
      console.log('[/api/generate-project-name] ANTHROPIC_API_KEY not set, using fallback')
      const name = fallbackGenerateProjectName(prompt)
      return c.json({ name, description: '' })
    }

    const anthropic = createAnthropic()

    const result = await generateText({
      model: anthropic('claude-haiku-4-5-20251001'),
      system: `You are a project naming assistant. Given a user's description of what they want to build, generate a short project name and a one-sentence description.

You MUST respond with valid JSON only, no other text. Use this exact format:
{"title": "Project Name", "description": "A one-sentence description of the project."}

Rules for the title:
- Use 2-4 words maximum
- Make it descriptive but concise
- Use Title Case (capitalize each word)
- Do NOT include words like "App", "Application", "Project", "System" unless essential
- Focus on the core functionality or domain

Rules for the description:
- One sentence, under 100 characters
- Describe what the project does, not how

Examples:
- "create a todo app" → {"title": "Task Tracker", "description": "Organize and track daily tasks and to-dos."}
- "build a recipe manager" → {"title": "Recipe Book", "description": "Store and browse your favorite recipes."}
- "make a chat application with video calls" → {"title": "Video Chat", "description": "Real-time messaging with video call support."}
- "build a dashboard for monitoring servers" → {"title": "Server Monitor", "description": "Monitor server health and performance metrics."}`,
      prompt: prompt.trim(),
    })

    let name = 'New Project'
    let description = ''
    try {
      // Strip markdown code fences if present (e.g. ```json ... ```)
      let jsonText = result.text.trim()
      jsonText = jsonText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()
      const parsed = JSON.parse(jsonText)
      name = (parsed.title || '').replace(/['"]/g, '').trim() || 'New Project'
      description = (parsed.description || '').trim()
    } catch {
      name = result.text.trim().replace(/['"]/g, '').replace(/```(?:json)?/gi, '').trim() || 'New Project'
    }

    // Track credit usage (fire-and-forget, small cost for Haiku)
    if (workspaceId) {
      const usage = result.usage as any
      const inTok = usage?.inputTokens || usage?.promptTokens || 0
      const outTok = usage?.outputTokens || usage?.completionTokens || 0
      if (inTok + outTok > 0) {
        const creditCost = calculateCreditCost(inTok, outTok, 'haiku')
        billingService.consumeCredits(workspaceId, null, authUserId || 'system', 'project_name_generation', creditCost, { inputTokens: inTok, outputTokens: outTok, totalTokens: inTok + outTok }).catch(() => {})
      }
    }

    // When projectId is provided, persist the generated name and description
    if (projectId) {
      try {
        await prisma.project.update({
          where: { id: projectId },
          data: { name, description },
        })
        console.log(`[/api/generate-project-name] Updated project ${projectId}: "${name}"`)
      } catch (dbErr) {
        console.error('[/api/generate-project-name] Failed to update project:', dbErr)
      }
    }

    return c.json({ name, description })
  } catch (error: any) {
    console.error('[/api/generate-project-name] Error:', error)
    const body = await c.req.json().catch(() => ({ prompt: '' }))
    const name = fallbackGenerateProjectName(body.prompt || '')
    return c.json({ name, description: '' })
  }
})

// Credit cost calculation imported from ./lib/credit-cost

/**
 * AI Chat endpoint using Vercel AI SDK with Claude Code provider
 * Streams Claude responses back to the client
 * Uses existing Claude Pro/Max subscription via Claude Code CLI
 * Scoped to project with access to local MCP server (shogo)
 *
 * Session Resume (task-cc-api-endpoint):
 * - Accepts optional `ccSessionId` in request body
 * - When provided, passes it as `resume` parameter to Claude Code
 * - This allows continuing previous Claude Code conversations
 * 
 * Credit Charging (after completion):
 * - Credits are charged AFTER the response completes
 * - Cost is based on total tokens (input + output)
 * - Rate: token-based pricing per model tier, minimum 0.2 credits per message
 */
app.post('/api/chat', async (c) => {
  try {
    const authCtx = c.get('auth') as any
    const userId = authCtx?.userId
    let { messages, ccSessionId, chatSessionId, workspaceId, projectId, agentMode } = await c.req.json()

    // Derive workspaceId from the project if not provided, and verify access
    if (projectId && userId) {
      const verifiedWsId = await verifyProjectAccess(userId, projectId)
      if (!verifiedWsId) {
        return c.json({ error: { code: 'forbidden', message: 'Access denied to this project' } }, 403)
      }
      if (!workspaceId) workspaceId = verifiedWsId
    }

    // Enforce basic agent mode for free/basic-plan workspaces (server-side guard)
    if (workspaceId && agentMode && agentMode !== 'basic') {
      const hasAdvanced = await billingService.hasAdvancedModelAccess(workspaceId)
      if (!hasAdvanced) {
        agentMode = 'basic'
      }
    }

    // credit-limit-enforcement: Pre-check credits BEFORE calling AI
    if (workspaceId) {
      const sufficient = await billingService.hasCredits(workspaceId, 0.5)
      if (!sufficient) {
        return c.json({
          error: 'Insufficient credits',
          message: 'You have run out of credits. Daily credits reset at midnight UTC.',
          creditsRemaining: 0,
        }, 402)
      }
    }

    // Open a billing session so the AI proxy accumulates tokens across
    // all API calls in the agentic loop instead of charging per-call.
    if (projectId && workspaceId) {
      openBillingSession(projectId, workspaceId, userId || 'system')
    }

    // Get or create a persistent V2 session for this scope.
    // The session keeps the CLI subprocess alive across requests — no more cold starts.
    const scopeKey = projectId || '__platform__'
    const session = getOrCreateSession(scopeKey, projectId)
    activeSessions.add(scopeKey) // Mark session as active to prevent prewarm interference

    // Extract the last user message from the full message array.
    // V2 sessions maintain conversation history internally, so we only need the latest turn.
    const lastUserMessage = [...messages].reverse().find((m: any) => m.role === 'user')
    if (!lastUserMessage) {
      return c.json({ error: { message: 'No user message found', code: 'NO_USER_MESSAGE' } }, 400)
    }

    // Build message for V2 session.send() — supports text, images, and documents (PDFs)
    let userText = ''
    const fileParts: Array<{ mimeType: string; base64Data: string }> = []

    if (typeof lastUserMessage.content === 'string') {
      userText = lastUserMessage.content
    } else if (Array.isArray(lastUserMessage.parts)) {
      const textParts: string[] = []
      for (const part of lastUserMessage.parts) {
        if (part.type === 'text' && part.text) {
          textParts.push(part.text)
        } else if (part.type === 'file' && part.url) {
          const parsed = parseDataUrl(part.url)
          if (parsed) fileParts.push(parsed)
        }
      }
      userText = textParts.join('\n')
    } else {
      userText = String(lastUserMessage.content ?? '')
    }

    // Build the session message — multimodal when files are attached
    let sessionMessage: string | SDKUserMessage = userText
    if (fileParts.length > 0) {
      const contentBlocks: any[] = []
      if (userText) {
        contentBlocks.push({ type: 'text', text: userText })
      }
      for (const file of fileParts) {
        if (file.mimeType.startsWith('image/')) {
          contentBlocks.push({
            type: 'image',
            source: { type: 'base64', media_type: file.mimeType, data: file.base64Data },
          })
        } else if (file.mimeType === 'application/pdf') {
          contentBlocks.push({
            type: 'document',
            source: { type: 'base64', media_type: file.mimeType, data: file.base64Data },
          })
        } else {
          try {
            const decoded = Buffer.from(file.base64Data, 'base64').toString('utf-8')
            contentBlocks.push({ type: 'text', text: `[File content (${file.mimeType})]\n${decoded}` })
          } catch {
            contentBlocks.push({ type: 'text', text: `[Attached file: ${file.mimeType}]` })
          }
        }
      }
      try {
        sessionMessage = {
          type: 'user',
          message: { role: 'user', content: contentBlocks },
          parent_tool_use_id: null,
          session_id: session.sessionId,
        } as SDKUserMessage
      } catch {
        // sessionId unavailable on fresh sessions — fall back to text only
        console.warn('[/api/chat] session.sessionId not ready, sending text-only for file message')
        sessionMessage = userText
      }
    }

    // Event buffering for progress/virtual-tool events (same pattern as before)
    const eventBuffer: SubagentProgressEvent[] = []
    const virtualToolBuffer: VirtualToolEvent[] = []
    let streamWriter: { write: (data: any) => void } | null = null

    const onProgress = (event: SubagentProgressEvent) => {
      if (streamWriter) {
        streamWriter.write({ type: 'data-progress', id: `progress-${Date.now()}`, data: event })
      } else {
        eventBuffer.push(event)
      }
    }
    const onVirtualTool = (event: VirtualToolEvent) => {
      if (streamWriter) {
        streamWriter.write({ type: 'data-virtual-tool', id: `vt-${Date.now()}`, data: event })
      } else {
        virtualToolBuffer.push(event)
      }
    }
    // Attach listeners BEFORE sending message
    progressEvents.on('progress', onProgress)
    virtualToolEvents.on('virtual-tool', onVirtualTool)

    // Send the user message to the persistent V2 session
    await session.send(sessionMessage)

    // Create UIMessageStream that converts V2 SDK messages to UIMessageChunks
    console.log(`${LOG_PREFIX} 📡 V2 session streaming for: ${scopeKey}`)
    const stream = createUIMessageStream({
      execute: async ({ writer }) => {
        streamWriter = writer

        // Flush buffered events
        for (const ev of eventBuffer) {
          writer.write({ type: 'data-progress', id: `progress-${Date.now()}`, data: ev })
        }
        eventBuffer.length = 0
        for (const ev of virtualToolBuffer) {
          writer.write({ type: 'data-virtual-tool', id: `vt-${Date.now()}`, data: ev })
        }
        virtualToolBuffer.length = 0

        // State for converting raw stream events to UIMessageChunks
        let currentTextId: string | null = null
        let currentToolId: string | null = null
        let currentToolName: string | null = null
        let currentToolInput = ''
        let currentThinkingId: string | null = null
        // Track tool IDs already emitted via stream_event to avoid duplicates
        const streamedToolIds = new Set<string>()
        let resultUsage: any = null
        let resultSessionId: string | undefined

        // server-side-persistence: Accumulate content for DB persistence.
        // orderedParts preserves the natural interleaving of text and tool calls
        // so that on page refresh the parts array faithfully reproduces the original order.
        let accumulatedText = ''
        const toolCallDetails: { toolCallId: string; toolName: string; input: any }[] = []
        const orderedParts: any[] = []
        let currentTextPart: { type: 'text'; text: string } | null = null
        // Track whether we're receiving incremental stream_events.
        // When streaming, the 'assistant' message is redundant (it's the complete
        // version of what was already streamed incrementally).
        let receivedStreamEvents = false
        // Track tool calls that are pending execution by the SDK.
        // When the next turn starts, we know all pending tools completed.
        const pendingToolResults = new Map<string, string>() // toolCallId → toolName

        try {
          writer.write({ type: 'start' })
          writer.write({ type: 'start-step' })

          for await (const msg of session.stream()) {
            const msgAny = msg as any

            // -----------------------------------------------------------------
            // SDKPartialAssistantMessage — incremental streaming (preferred)
            // These arrive before the complete 'assistant' message and provide
            // real-time text and tool call deltas for the UI.
            // -----------------------------------------------------------------
            if (msg.type === 'stream_event') {
              receivedStreamEvents = true
              const event = msgAny.event as any
              resultSessionId = msg.session_id

              switch (event.type) {
                case 'message_start': {
                  // New turn beginning — all previously pending tools have completed
                  for (const [tcId, tcName] of pendingToolResults) {
                    writer.write({
                      type: 'tool-output-available',
                      toolCallId: tcId,
                      output: { success: true },
                    })
                  }
                  pendingToolResults.clear()
                  break
                }
                case 'content_block_start': {
                  const block = event.content_block
                  if (block?.type === 'thinking') {
                    currentThinkingId = `reasoning-${Date.now()}-${event.index}`
                    writer.write({ type: 'reasoning-start', id: currentThinkingId })
                  } else if (block?.type === 'text') {
                    if (currentThinkingId) {
                      writer.write({ type: 'reasoning-end', id: currentThinkingId })
                      currentThinkingId = null
                    }
                    currentTextId = `text-${Date.now()}-${event.index}`
                    writer.write({ type: 'text-start', id: currentTextId })
                  } else if (block?.type === 'tool_use') {
                    if (currentThinkingId) {
                      writer.write({ type: 'reasoning-end', id: currentThinkingId })
                      currentThinkingId = null
                    }
                    if (currentTextId) {
                      writer.write({ type: 'text-end', id: currentTextId })
                      currentTextId = null
                    }
                    currentToolId = block.id
                    currentToolName = block.name
                    currentToolInput = ''
                    // Mark as streamed immediately so the assistant handler skips it
                    streamedToolIds.add(block.id)
                    writer.write({
                      type: 'tool-input-start',
                      toolCallId: block.id,
                      toolName: block.name,
                      dynamic: true,
                    })
                  }
                  break
                }
                case 'content_block_delta': {
                  const delta = event.delta
                  if (delta?.type === 'thinking_delta' && delta.thinking) {
                    if (currentThinkingId) {
                      writer.write({ type: 'reasoning-delta', id: currentThinkingId, delta: delta.thinking })
                    }
                  } else if (delta?.type === 'text_delta' && delta.text) {
                    if (!currentTextId) {
                      currentTextId = `text-${Date.now()}-${event.index}`
                      writer.write({ type: 'text-start', id: currentTextId })
                    }
                    writer.write({ type: 'text-delta', id: currentTextId, delta: delta.text })
                    // server-side-persistence: accumulate text for DB persistence
                    accumulatedText += delta.text
                    if (!currentTextPart) {
                      currentTextPart = { type: 'text', text: '' }
                      orderedParts.push(currentTextPart)
                    }
                    currentTextPart.text += delta.text
                  } else if (delta?.type === 'input_json_delta' && delta.partial_json) {
                    currentToolInput += delta.partial_json
                    writer.write({
                      type: 'tool-input-delta',
                      toolCallId: currentToolId || `tool-${event.index}`,
                      inputTextDelta: delta.partial_json,
                    })
                  }
                  break
                }
                case 'content_block_stop': {
                  if (currentThinkingId) {
                    writer.write({ type: 'reasoning-end', id: currentThinkingId })
                    currentThinkingId = null
                  }
                  if (currentTextId) {
                    writer.write({ type: 'text-end', id: currentTextId })
                    currentTextId = null
                  }
                  if (currentToolId) {
                    // Finalize tool input — emit tool-input-available so UI shows it as "executing"
                    let parsedInput: any = {}
                    try { parsedInput = JSON.parse(currentToolInput || '{}') } catch {}
                    writer.write({
                      type: 'tool-input-available',
                      toolCallId: currentToolId,
                      toolName: currentToolName || 'unknown',
                      input: parsedInput,
                      dynamic: true,
                    })
                    // server-side-persistence: capture tool call details for message parts
                    const toolDetail = {
                      toolCallId: currentToolId,
                      toolName: currentToolName || 'unknown',
                      input: parsedInput,
                    }
                    toolCallDetails.push(toolDetail)
                    currentTextPart = null
                    orderedParts.push({
                      type: 'dynamic-tool',
                      toolCallId: toolDetail.toolCallId,
                      toolName: toolDetail.toolName,
                      input: toolDetail.input,
                      output: { success: true },
                      state: 'output-available',
                    })
                    // Track for result emission when next turn starts
                    pendingToolResults.set(currentToolId, currentToolName || 'unknown')
                    currentToolId = null
                    currentToolName = null
                    currentToolInput = ''
                  }
                  break
                }
                case 'message_stop': {
                  if (currentThinkingId) {
                    writer.write({ type: 'reasoning-end', id: currentThinkingId })
                    currentThinkingId = null
                  }
                  if (currentTextId) {
                    writer.write({ type: 'text-end', id: currentTextId })
                    currentTextId = null
                  }
                  currentToolId = null
                  currentToolName = null
                  currentToolInput = ''

                  writer.write({ type: 'finish-step' })
                  writer.write({ type: 'start-step' })
                  break
                }
              }
            }

            // -----------------------------------------------------------------
            // SDKAssistantMessage — complete assistant response per turn
            // When streaming is active, this is a duplicate of the already-
            // streamed content and should be skipped for text/tool output.
            // When streaming is NOT active (fallback), emit content from here.
            // -----------------------------------------------------------------
            else if (msg.type === 'assistant') {
              resultSessionId = msgAny.session_id
              const content = msgAny.message?.content as Array<any> | undefined

              // Resolve any pending tool results from the previous turn
              for (const [tcId] of pendingToolResults) {
                writer.write({
                  type: 'tool-output-available',
                  toolCallId: tcId,
                  output: { success: true },
                })
              }
              pendingToolResults.clear()

              // The V2 SDK handles tools internally and may NOT stream tool_use
              // blocks via stream_event. The assistant message is the only reliable
              // source of tool call information. We always extract tool_use blocks,
              // but skip text when it was already streamed.
              const toolBlocks = content?.filter((b: any) => b.type === 'tool_use') || []

              if (receivedStreamEvents) {
                // Text was already streamed. Only emit tool calls that weren't
                // already emitted via stream_event (avoid duplicates).
                for (const block of toolBlocks) {
                  if (streamedToolIds.has(block.id)) continue // Already emitted
                  writer.write({
                    type: 'tool-input-start',
                    toolCallId: block.id,
                    toolName: block.name,
                    dynamic: true,
                  })
                  if (block.input) {
                    writer.write({
                      type: 'tool-input-delta',
                      toolCallId: block.id,
                      inputTextDelta: JSON.stringify(block.input),
                    })
                  }
                  writer.write({
                    type: 'tool-input-available',
                    toolCallId: block.id,
                    toolName: block.name,
                    input: block.input || {},
                    dynamic: true,
                  })
                  // server-side-persistence: capture non-streamed tool calls
                  const nonStreamedTool = {
                    toolCallId: block.id,
                    toolName: block.name,
                    input: block.input || {},
                  }
                  toolCallDetails.push(nonStreamedTool)
                  currentTextPart = null
                  orderedParts.push({
                    type: 'dynamic-tool',
                    toolCallId: nonStreamedTool.toolCallId,
                    toolName: nonStreamedTool.toolName,
                    input: nonStreamedTool.input,
                    output: { success: true },
                    state: 'output-available',
                  })
                  pendingToolResults.set(block.id, block.name)
                }
                // Don't emit finish-step/start-step — message_stop already did
              } else {
                // No streaming — emit everything from the complete message
                if (content && Array.isArray(content)) {
                  for (const block of content) {
                    if (block.type === 'thinking' && block.thinking) {
                      const thinkId = `reasoning-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
                      writer.write({ type: 'reasoning-start', id: thinkId })
                      writer.write({ type: 'reasoning-delta', id: thinkId, delta: block.thinking })
                      writer.write({ type: 'reasoning-end', id: thinkId })
                    } else if (block.type === 'text' && block.text) {
                      const textId = `text-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
                      writer.write({ type: 'text-start', id: textId })
                      writer.write({ type: 'text-delta', id: textId, delta: block.text })
                      writer.write({ type: 'text-end', id: textId })
                      // server-side-persistence: accumulate text for non-streaming path
                      accumulatedText += block.text
                      currentTextPart = { type: 'text', text: block.text }
                      orderedParts.push(currentTextPart)
                    } else if (block.type === 'tool_use') {
                      writer.write({
                        type: 'tool-input-start',
                        toolCallId: block.id,
                        toolName: block.name,
                        dynamic: true,
                      })
                      if (block.input) {
                        writer.write({
                          type: 'tool-input-delta',
                          toolCallId: block.id,
                          inputTextDelta: JSON.stringify(block.input),
                        })
                      }
                      writer.write({
                        type: 'tool-input-available',
                        toolCallId: block.id,
                        toolName: block.name,
                        input: block.input || {},
                        dynamic: true,
                      })
                      // server-side-persistence: capture tool call for non-streaming path
                      const fallbackTool = {
                        toolCallId: block.id,
                        toolName: block.name,
                        input: block.input || {},
                      }
                      toolCallDetails.push(fallbackTool)
                      currentTextPart = null
                      orderedParts.push({
                        type: 'dynamic-tool',
                        toolCallId: fallbackTool.toolCallId,
                        toolName: fallbackTool.toolName,
                        input: fallbackTool.input,
                        output: { success: true },
                        state: 'output-available',
                      })
                      pendingToolResults.set(block.id, block.name)
                    }
                  }
                }
                writer.write({ type: 'finish-step' })
                writer.write({ type: 'start-step' })
              }

              // Reset streaming flag for the next turn
              // (each turn may or may not have stream_events)
              receivedStreamEvents = false
            }

            // -----------------------------------------------------------------
            // SDKSystemMessage — session init with metadata
            // -----------------------------------------------------------------
            else if (msg.type === 'system' && msgAny.subtype === 'init') {
              resultSessionId = msgAny.session_id
              console.log(`${LOG_PREFIX} Session init: ${resultSessionId}`)
            }

            // -----------------------------------------------------------------
            // SDKResultMessage — turn complete with usage data
            // -----------------------------------------------------------------
            else if (msg.type === 'result') {
              const result = msg as any
              resultUsage = result.usage
              resultSessionId = result.session_id
              console.log(`${LOG_PREFIX} Result: ${result.subtype}, tokens: ${JSON.stringify(resultUsage)}`)

              // Finalize any open text
              if (currentTextId) {
                writer.write({ type: 'text-end', id: currentTextId })
                currentTextId = null
              }

              // Resolve any remaining pending tool results
              for (const [tcId] of pendingToolResults) {
                writer.write({
                  type: 'tool-output-available',
                  toolCallId: tcId,
                  output: { success: true },
                })
              }
              pendingToolResults.clear()

              // Write session metadata
              if (resultSessionId) {
                writer.write({
                  type: 'message-metadata',
                  messageMetadata: { ccSessionId: resultSessionId },
                })
              }

              // Emit finish
              writer.write({
                type: 'finish',
                finishReason: result.subtype === 'success' ? 'stop' : 'error',
              })
              break // Turn is complete
            }
          }
        } finally {
          // Release active session lock
          activeSessions.delete(scopeKey)

          // Cleanup listeners
          progressEvents.off('progress', onProgress)
          virtualToolEvents.off('virtual-tool', onVirtualTool)
          streamWriter = null

          // server-side-persistence: Persist assistant message to database (fire-and-forget)
          // This ensures messages survive page refreshes and client disconnects.
          if (chatSessionId && (accumulatedText || toolCallDetails.length > 0)) {
            (async () => {
              try {
                const session = await prisma.chatSession.findUnique({ where: { id: chatSessionId } })
                if (session) {
                  // Use orderedParts which preserves the natural interleaving of
                  // text and tool calls as they appeared in the stream.
                  // Filter out empty text parts that can accumulate from keepalive pings.
                  const parts = orderedParts.filter(
                    (p: any) => !(p.type === 'text' && (!p.text || !p.text.trim()))
                  )

                  await prisma.chatMessage.create({
                    data: {
                      sessionId: chatSessionId,
                      role: 'assistant',
                      content: accumulatedText,
                      parts: parts.length > 0 ? JSON.stringify(parts) : undefined,
                    },
                  })
                  console.log(`[/api/chat] 💾 Persisted assistant message (${accumulatedText.length} chars, ${toolCallDetails.length} tool calls) for session ${chatSessionId}`)
                }
              } catch (persistError: any) {
                console.error(`[/api/chat] ⚠️ Failed to persist assistant message:`, persistError.message)
              }
            })()
          }

          // Close the billing session — the AI proxy accumulated tokens
          // across all API calls, and this triggers the single charge.
          if (projectId) {
            closeBillingSession(projectId).then(({ creditCost }) => {
              if (creditCost > 0) {
                console.log(`[/api/chat] 💰 Billing session closed — charged ${creditCost} credits`)
              }
            }).catch((err) => {
              console.error(`[/api/chat] ⚠️ Failed to close billing session:`, err)
            })
          }
        }
      },
      onError: (error) => {
        activeSessions.delete(scopeKey)
        console.error('[/api/chat] Stream error:', error)
        progressEvents.off('progress', onProgress)
        virtualToolEvents.off('virtual-tool', onVirtualTool)
        streamWriter = null
        return 'An error occurred during streaming'
      },
    })

    return createUIMessageStreamResponse({ stream })
  } catch (error: any) {
    console.error('[/api/chat] Error:', error)
    return c.json({
      error: {
        message: error.message || 'Chat request failed',
        code: error.code || 'CHAT_ERROR',
      }
    }, 500)
  }
})

// =============================================================================
// Billing routes (simplified - accepts workspaceId in body)
// =============================================================================
// Only initialize Stripe if the API key is set
const stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY)
  : null

app.post('/api/billing/checkout', async (c) => {
  try {
    if (!stripe) {
      return c.json({ error: { code: 'stripe_not_configured', message: 'Stripe is not configured' } }, 503)
    }

    const body = await c.req.json()
    const { workspaceId, planId, billingInterval, userEmail, referralId, successUrl: clientSuccessUrl, cancelUrl: clientCancelUrl } = body

    if (!workspaceId || !planId || !billingInterval) {
      return c.json({ error: { code: 'invalid_request', message: 'Missing required fields' } }, 400)
    }

    if (!await verifyWorkspaceMembership(c, workspaceId)) {
      return c.json({ error: { code: 'forbidden', message: 'Access denied to this workspace' } }, 403)
    }

    // Get price ID from config (supports tiered pricing: pro, pro_200, business_1200, etc.)
    const priceId = getPriceId(planId, billingInterval as 'monthly' | 'annual')

    if (!priceId) {
      return c.json({ error: { code: 'invalid_plan', message: `No price found for ${planId} ${billingInterval}` } }, 400)
    }

    // Build metadata
    const metadata: Record<string, string> = {
      workspaceId,
      planId,
      billingInterval,
    }

    // Use client-provided URLs (native apps pass deep link URLs), fall back to web URLs
    const frontendUrl = getFrontendUrl()
    const successUrl = clientSuccessUrl
      || `${frontendUrl}/?workspace=${workspaceId}&checkout=success&session_id={CHECKOUT_SESSION_ID}`
    const cancelUrl = clientCancelUrl
      || `${frontendUrl}/?workspace=${workspaceId}&checkout=canceled`

    // Create Stripe checkout session (no payment_method_types — let Stripe
    // determine available methods, required for Adaptive Pricing)
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: successUrl,
      cancel_url: cancelUrl,
      metadata,
      ...(userEmail && { customer_email: userEmail }),
      ...(referralId && { client_reference_id: referralId }),
    })

    return c.json({ sessionId: session.id, url: session.url }, 200)
  } catch (error: any) {
    console.error('[Billing] Checkout error:', error)
    return c.json({ error: { code: 'stripe_error', message: error.message } }, 500)
  }
})

app.get('/api/billing/workspace-plan', async (c) => {
  try {
    const auth = c.get('auth') as any
    const userId = auth?.userId
    const url = new URL(c.req.url)
    const workspaceId = url.searchParams.get('workspaceId')
    const workspaceIds = url.searchParams.get('workspaceIds')

    if (workspaceIds) {
      const ids = workspaceIds.split(',').filter(Boolean)
      // Filter to only workspaces the user is a member of
      const memberships = userId
        ? await prisma.member.findMany({ where: { userId, workspaceId: { in: ids } }, select: { workspaceId: true } })
        : []
      const allowedIds = new Set(memberships.map((m: any) => m.workspaceId))
      const plans: Record<string, { planId: string; status: string | null }> = {}
      await Promise.all(ids.filter(id => allowedIds.has(id)).map(async (id) => {
        const sub = await billingService.getSubscription(id)
        plans[id] = { planId: sub?.planId ?? 'free', status: sub?.status ?? null }
      }))
      return c.json({ ok: true, plans })
    }

    if (!workspaceId) return c.json({ error: 'missing workspaceId or workspaceIds' }, 400)

    if (!await verifyWorkspaceMembership(c, workspaceId)) {
      return c.json({ error: { code: 'forbidden', message: 'Access denied to this workspace' } }, 403)
    }
    const sub = await billingService.getSubscription(workspaceId)
    const ledger = await billingService.getCreditLedger(workspaceId)
    return c.json({
      ok: true,
      planId: sub?.planId ?? 'free',
      status: sub?.status ?? null,
      billingInterval: sub?.billingInterval ?? null,
      monthlyCredits: ledger?.monthlyCredits ?? 0,
      dailyCredits: ledger?.dailyCredits ?? 0,
    })
  } catch (error: any) {
    return c.json({ error: { code: 'plan_query_failed', message: error.message } }, 500)
  }
})

app.post('/api/billing/workspace-checkout', async (c) => {
  try {
    if (!stripe) {
      return c.json({ error: { code: 'stripe_not_configured', message: 'Stripe is not configured' } }, 503)
    }

    const authCtx = c.get('auth') as any
    const userId = authCtx?.userId
    if (!userId) {
      return c.json({ error: { code: 'unauthorized', message: 'Authentication required' } }, 401)
    }

    const body = await c.req.json()
    const { workspaceName, planId, billingInterval, userEmail, referralId, successUrl: clientSuccessUrl, cancelUrl: clientCancelUrl } = body

    if (!workspaceName || !planId || !billingInterval) {
      return c.json({ error: { code: 'invalid_request', message: 'Missing required fields: workspaceName, planId, billingInterval' } }, 400)
    }

    const priceId = getPriceId(planId, billingInterval as 'monthly' | 'annual')
    if (!priceId) {
      return c.json({ error: { code: 'invalid_plan', message: `No price found for ${planId} ${billingInterval}` } }, 400)
    }

    // Create workspace + owner membership immediately (bypasses hook limit)
    const wsResult = await workspaceService.createPaidWorkspace(userId, workspaceName)
    const newWorkspaceId = wsResult.workspace.id
    console.log('[Billing] Created paid workspace:', newWorkspaceId, 'for user:', userId)

    // Allocate free credits so the workspace is usable while subscription provisions
    await billingService.allocateFreeCredits(newWorkspaceId)

    const metadata: Record<string, string> = {
      workspaceId: newWorkspaceId,
      planId,
      billingInterval,
    }

    // Use client-provided URLs (native apps pass deep link URLs), fall back to web URLs
    // For workspace checkout, replace placeholder workspace ID in client URLs with the newly created one
    const frontendUrl = getFrontendUrl()
    const successUrl = clientSuccessUrl
      ? clientSuccessUrl.replace('{WORKSPACE_ID}', newWorkspaceId)
      : `${frontendUrl}/?workspace=${newWorkspaceId}&checkout=workspace_created&session_id={CHECKOUT_SESSION_ID}`
    const cancelUrl = clientCancelUrl
      ? clientCancelUrl.replace('{WORKSPACE_ID}', newWorkspaceId)
      : `${frontendUrl}/?workspace=${newWorkspaceId}&checkout=canceled`

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: successUrl,
      cancel_url: cancelUrl,
      metadata,
      ...(userEmail && { customer_email: userEmail }),
      ...(referralId && { client_reference_id: referralId }),
    })

    return c.json({ sessionId: session.id, url: session.url, workspaceId: newWorkspaceId }, 200)
  } catch (error: any) {
    console.error('[Billing] Workspace checkout error:', error)
    return c.json({ error: { code: 'stripe_error', message: error.message } }, 500)
  }
})

app.post('/api/billing/verify-checkout', async (c) => {
  try {
    if (!stripe) {
      return c.json({ error: { code: 'stripe_not_configured', message: 'Stripe is not configured' } }, 503)
    }

    const body = await c.req.json()
    const { sessionId } = body
    if (!sessionId) {
      return c.json({ error: { code: 'invalid_request', message: 'Missing sessionId' } }, 400)
    }

    const session = await stripe.checkout.sessions.retrieve(sessionId)
    if (session.payment_status !== 'paid') {
      return c.json({ error: { code: 'not_paid', message: 'Checkout session not paid' } }, 400)
    }

    const { workspaceId, planId, billingInterval } = session.metadata || {}
    if (!workspaceId || !planId || !billingInterval || !session.subscription || !session.customer) {
      return c.json({ error: { code: 'invalid_session', message: 'Missing metadata in session' } }, 400)
    }

    if (!await verifyWorkspaceMembership(c, workspaceId)) {
      return c.json({ error: { code: 'forbidden', message: 'Access denied to this workspace' } }, 403)
    }

    const existing = await billingService.getSubscription(workspaceId)
    if (existing?.stripeSubscriptionId === (session.subscription as string)) {
      return c.json({ ok: true, workspaceId, planId, alreadyProvisioned: true }, 200)
    }

    const stripeSubscription = await stripe.subscriptions.retrieve(session.subscription as string) as Stripe.Subscription & {
      current_period_start?: number
      current_period_end?: number
    }

    const now = Date.now()
    const currentPeriodStart = stripeSubscription.current_period_start
      ? stripeSubscription.current_period_start * 1000
      : (stripeSubscription.billing_cycle_anchor || stripeSubscription.start_date) * 1000 || now
    const currentPeriodEnd = stripeSubscription.current_period_end
      ? stripeSubscription.current_period_end * 1000
      : now + (30 * 24 * 60 * 60 * 1000)

    const basePlanId = planId.split('_')[0] as 'basic' | 'pro' | 'business' | 'enterprise'

    await billingService.syncFromStripe({
      stripeSubscriptionId: stripeSubscription.id,
      stripeCustomerId: session.customer as string,
      workspaceId,
      planId: basePlanId,
      status: stripeSubscription.status as 'active' | 'past_due' | 'canceled' | 'trialing' | 'paused',
      billingInterval: billingInterval as 'monthly' | 'annual',
      currentPeriodStart: new Date(currentPeriodStart),
      currentPeriodEnd: new Date(currentPeriodEnd),
      cancelAtPeriodEnd: stripeSubscription.cancel_at_period_end ?? false,
    })

    await billingService.allocateMonthlyCredits(workspaceId, planId)
    console.log('[Billing] Verify-checkout: subscription provisioned for workspace:', workspaceId, 'plan:', planId)

    return c.json({ ok: true, workspaceId, planId }, 200)
  } catch (error: any) {
    console.error('[Billing] Verify-checkout error:', error)
    return c.json({ error: { code: 'verify_error', message: error.message } }, 500)
  }
})

app.post('/api/billing/portal', async (c) => {
  try {
    if (!stripe) {
      return c.json({ error: { code: 'stripe_not_configured', message: 'Stripe is not configured' } }, 503)
    }

    const url = new URL(c.req.url)
    const workspaceId = url.searchParams.get('workspaceId')

    if (!workspaceId) {
      return c.json({ error: { code: 'invalid_request', message: 'Missing workspaceId' } }, 400)
    }

    if (!await verifyWorkspaceMembership(c, workspaceId)) {
      return c.json({ error: { code: 'forbidden', message: 'Access denied to this workspace' } }, 403)
    }

    // Get return URL from request body if provided
    let returnUrl = `${getFrontendUrl()}/app/billing`
    try {
      const body = await c.req.json<{ returnUrl?: string }>()
      if (body?.returnUrl) {
        returnUrl = body.returnUrl
      }
    } catch {
      // Body parsing failed, use default return URL
    }

    // Look up Stripe customer ID from the subscription record in our database
    const subscription = await billingService.getSubscription(workspaceId)
    if (!subscription?.stripeCustomerId) {
      return c.json({ 
        error: { 
          code: 'customer_not_found', 
          message: 'No billing subscription found for this workspace. Please subscribe first.' 
        } 
      }, 404)
    }

    // Create Stripe billing portal session
    const session = await stripe.billingPortal.sessions.create({
      customer: subscription.stripeCustomerId,
      return_url: returnUrl,
    })

    return c.json({ url: session.url }, 200)
  } catch (error: any) {
    console.error('[Billing] Portal error:', error)
    return c.json({ error: { code: 'stripe_error', message: error.message } }, 500)
  }
})

// Regional pricing endpoint (public, no auth required)
app.get('/api/billing/regional-pricing', async (c) => {
  try {
    const country = (
      c.req.header('cf-ipcountry') ||
      c.req.header('x-forwarded-country') ||
      new URL(c.req.url).searchParams.get('country') ||
      'US'
    ).toUpperCase()

    const currency = getCurrencyForCountry(country)
    const rates = await getExchangeRates()
    const rate = rates[currency.code] ?? 1

    const convert = (usd: number) => {
      const converted = usd * rate
      return currency.decimalPlaces === 0 ? Math.round(converted) : Math.round(converted * 100) / 100
    }

    const plans = {
      free: { monthly: 0, annual: 0 },
      basic: { monthly: convert(8), annual: convert(80) },
      pro_100: { monthly: convert(12), annual: convert(120) },
      pro_200: { monthly: convert(25), annual: convert(250) },
      pro_400: { monthly: convert(50), annual: convert(500) },
      pro_800: { monthly: convert(98), annual: convert(980) },
      pro_1600: { monthly: convert(190), annual: convert(1900) },
      pro_2400: { monthly: convert(280), annual: convert(2800) },
      pro_4000: { monthly: convert(460), annual: convert(4600) },
      pro_6000: { monthly: convert(680), annual: convert(6800) },
      pro_10000: { monthly: convert(1100), annual: convert(11000) },
      pro_15000: { monthly: convert(1650), annual: convert(16500) },
      pro_20000: { monthly: convert(2200), annual: convert(22000) },
      business_200: { monthly: convert(40), annual: convert(400) },
      business_400: { monthly: convert(65), annual: convert(650) },
      business_800: { monthly: convert(130), annual: convert(1300) },
      business_1600: { monthly: convert(250), annual: convert(2500) },
      business_2400: { monthly: convert(365), annual: convert(3650) },
      business_4000: { monthly: convert(600), annual: convert(6000) },
      business_6000: { monthly: convert(885), annual: convert(8850) },
      business_10000: { monthly: convert(1430), annual: convert(14300) },
      business_15000: { monthly: convert(2145), annual: convert(21450) },
      business_20000: { monthly: convert(2860), annual: convert(28600) },
    }

    return c.json({
      country,
      currency: {
        code: currency.code,
        symbol: currency.symbol,
        name: currency.name,
        symbolPosition: currency.symbolPosition,
        decimalPlaces: currency.decimalPlaces,
      },
      rate,
      plans,
    })
  } catch (error: any) {
    console.error('[Billing] Regional pricing error:', error)
    return c.json({ error: { code: 'internal_error', message: 'Failed to get regional pricing' } }, 500)
  }
})

// Stripe webhook endpoint
app.post('/api/webhooks/stripe', async (c) => {
  try {
    if (!stripe) {
      return c.json({ error: 'Stripe is not configured' }, 503)
    }

    const payload = await c.req.text()
    const signature = c.req.header('stripe-signature') || ''
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET
    if (!webhookSecret) {
      console.error('[Stripe] STRIPE_WEBHOOK_SECRET is not configured')
      return c.json({ error: 'Webhook verification not configured' }, 500)
    }

    let event: Stripe.Event
    try {
      // Use async version for Bun/SubtleCrypto compatibility
      event = await stripe.webhooks.constructEventAsync(payload, signature, webhookSecret)
    } catch (err: any) {
      console.error('[Webhook] Signature verification failed:', err.message)
      return c.json({ error: 'Invalid signature' }, 400)
    }

    console.log('[Webhook] Received event:', event.type)

    // Handle subscription events
    switch (event.type) {
      case 'customer.subscription.created':
      case 'customer.subscription.updated': {
        const subscription = event.data.object as Stripe.Subscription
        console.log('[Webhook] Subscription event:', {
          type: event.type,
          subscriptionId: subscription.id,
          status: subscription.status,
          customerId: subscription.customer,
          metadata: subscription.metadata,
        })
        break
      }
      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session
        console.log('[Webhook] Checkout completed:', {
          sessionId: session.id,
          subscriptionId: session.subscription,
          customerId: session.customer,
          metadata: session.metadata,
        })

        // Workspace is already created by the checkout endpoint; webhook only provisions the subscription
        const { workspaceId, planId, billingInterval } = session.metadata || {}
        if (workspaceId && planId && billingInterval && session.subscription && session.customer) {
          try {
            const stripeSubscription = await stripe!.subscriptions.retrieve(session.subscription as string) as Stripe.Subscription & {
              current_period_start?: number
              current_period_end?: number
            }

            const now = Date.now()
            const currentPeriodStart = stripeSubscription.current_period_start
              ? stripeSubscription.current_period_start * 1000
              : (stripeSubscription.billing_cycle_anchor || stripeSubscription.start_date) * 1000 || now
            const currentPeriodEnd = stripeSubscription.current_period_end
              ? stripeSubscription.current_period_end * 1000
              : now + (30 * 24 * 60 * 60 * 1000)

            const basePlanId = planId.split('_')[0] as 'basic' | 'pro' | 'business' | 'enterprise'

            await billingService.syncFromStripe({
              stripeSubscriptionId: stripeSubscription.id,
              stripeCustomerId: session.customer as string,
              workspaceId,
              planId: basePlanId,
              status: stripeSubscription.status as 'active' | 'past_due' | 'canceled' | 'trialing' | 'paused',
              billingInterval: billingInterval as 'monthly' | 'annual',
              currentPeriodStart: new Date(currentPeriodStart),
              currentPeriodEnd: new Date(currentPeriodEnd),
              cancelAtPeriodEnd: stripeSubscription.cancel_at_period_end ?? false,
            })

            await billingService.allocateMonthlyCredits(workspaceId, planId)
            console.log('[Webhook] Subscription created + credits allocated for workspace:', workspaceId, 'plan:', planId)

            // Send plan-upgraded email to workspace owner
            try {
              const workspace = await prisma.workspace.findUnique({
                where: { id: workspaceId },
                include: { members: { where: { role: 'owner' }, include: { user: { select: { email: true } } } } },
              })
              const ownerEmail = workspace?.members?.[0]?.user?.email
              if (ownerEmail) {
                const planLabel = planId.charAt(0).toUpperCase() + planId.slice(1)
                const baseUrl = process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3001'
                sendPlanUpgradedEmail({
                  to: ownerEmail,
                  workspaceName: workspace!.name,
                  planName: planLabel,
                  billingInterval: billingInterval === 'annual' ? 'Annual' : 'Monthly',
                  dashboardUrl: `${baseUrl}/billing`,
                }).catch((err) => console.error('[Webhook] plan-upgraded email failed:', err))
              }
            } catch (emailErr: any) {
              console.error('[Webhook] plan-upgraded email lookup failed:', emailErr.message)
            }
          } catch (err: any) {
            console.error('[Webhook] Failed to create subscription:', err.message)
          }
        }
        break
      }
      case 'invoice.payment_succeeded': {
        const invoice = event.data.object as Stripe.Invoice & { subscription?: string | null }
        const customerId = typeof invoice.customer === 'string' ? invoice.customer : (invoice.customer as any)?.id
        if (customerId && invoice.subscription) {
          try {
            const sub = await stripe!.subscriptions.retrieve(invoice.subscription)
            const wsId = sub.metadata?.workspaceId
            if (wsId) {
              const workspace = await prisma.workspace.findUnique({ where: { id: wsId }, include: { members: { where: { role: 'owner' }, include: { user: { select: { email: true } } } } } })
              const ownerEmail = workspace?.members?.[0]?.user?.email
              if (ownerEmail) {
                const planLabel = (sub.metadata?.planId || 'Pro').charAt(0).toUpperCase() + (sub.metadata?.planId || 'pro').slice(1)
                const baseUrl = process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3001'
                sendPaymentReceiptEmail({
                  to: ownerEmail,
                  workspaceName: workspace!.name,
                  planName: planLabel,
                  amount: ((invoice.amount_paid || 0) / 100).toFixed(2),
                  currency: (invoice.currency || 'usd') === 'usd' ? '$' : invoice.currency?.toUpperCase() || '$',
                  invoiceDate: new Date((invoice.created || 0) * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
                  ...(invoice.hosted_invoice_url ? { invoiceUrl: invoice.hosted_invoice_url } : {}),
                }).catch((err) => console.error('[Webhook] payment-receipt email failed:', err))
              }
            }
          } catch (err: any) {
            console.error('[Webhook] payment-receipt lookup failed:', err.message)
          }
        }
        break
      }
      case 'invoice.payment_failed': {
        const invoice = event.data.object as Stripe.Invoice & { subscription?: string | null }
        const customerId = typeof invoice.customer === 'string' ? invoice.customer : (invoice.customer as any)?.id
        if (customerId && invoice.subscription) {
          try {
            const sub = await stripe!.subscriptions.retrieve(invoice.subscription)
            const wsId = sub.metadata?.workspaceId
            if (wsId) {
              const workspace = await prisma.workspace.findUnique({ where: { id: wsId }, include: { members: { where: { role: 'owner' }, include: { user: { select: { email: true } } } } } })
              const ownerEmail = workspace?.members?.[0]?.user?.email
              if (ownerEmail) {
                const planLabel = (sub.metadata?.planId || 'Pro').charAt(0).toUpperCase() + (sub.metadata?.planId || 'pro').slice(1)
                const baseUrl = process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3001'
                sendPaymentFailedEmail({
                  to: ownerEmail,
                  workspaceName: workspace!.name,
                  planName: planLabel,
                  amount: ((invoice.amount_due || 0) / 100).toFixed(2),
                  currency: (invoice.currency || 'usd') === 'usd' ? '$' : invoice.currency?.toUpperCase() || '$',
                  retryUrl: `${baseUrl}/billing`,
                }).catch((err) => console.error('[Webhook] payment-failed email failed:', err))
              }
            }
          } catch (err: any) {
            console.error('[Webhook] payment-failed lookup failed:', err.message)
          }
        }
        break
      }
      default:
        console.log('[Webhook] Unhandled event type:', event.type)
    }

    return c.json({ received: true }, 200)
  } catch (error: any) {
    console.error('[Webhook] Error:', error)
    return c.json({ error: 'Webhook error' }, 500)
  }
})

// =============================================================================
// AI Model Proxy Routes (OpenAI-compatible, project-scoped token auth)
// =============================================================================

// Mount AI proxy routes BEFORE the general auth middleware.
// The proxy uses its own project-scoped token authentication.
const aiProxy = aiProxyRoutes()
app.route('/api', aiProxy)

// Tools passthrough proxy (Composio, Serper, OpenAI embeddings).
// Uses the same JWT auth as the AI proxy — no raw API keys in agent pods.
const toolsProxy = toolsProxyRoutes()
app.route('/api', toolsProxy)

// =============================================================================
// Domain API routes - For APIPersistence layer
// =============================================================================

// Note: Domain routes are now served via generated Prisma CRUD routes at /api

// =============================================================================
// Super Admin Routes (self-contained auth middleware)
// =============================================================================

// Guard: block admin user deletion when the user owns a workspace with an active subscription
app.delete('/api/admin/users/:id', authMiddleware, requireAuth, requireSuperAdmin, async (c) => {
  const id = c.req.param('id')
  const workspacesWithSubs = await prisma.workspace.findMany({
    where: {
      members: { some: { userId: id, role: 'owner' } },
      subscriptions: { some: { status: { in: ['active', 'past_due', 'trialing'] } } },
    },
    select: { name: true, subscriptions: { where: { status: { in: ['active', 'past_due', 'trialing'] } }, select: { planId: true } } },
  })
  if (workspacesWithSubs.length > 0) {
    const ws = workspacesWithSubs[0]
    return c.json({
      error: {
        code: 'active_subscription',
        message: `Cannot delete user while workspace "${ws.name}" has an active subscription (${ws.subscriptions[0]?.planId}). Cancel the subscription first.`,
      },
    }, 400)
  }
  const userToDelete = await prisma.user.findUnique({ where: { id }, select: { email: true, name: true } })
  await prisma.user.delete({ where: { id } })

  if (userToDelete?.email) {
    await sendAccountDeletedEmail({ to: userToDelete.email, name: userToDelete.name || undefined })
  }

  return c.json({ ok: true })
})

// Generated admin CRUD routes - full model CRUD with pagination/search/sorting
// Protected by auth + requireSuperAdmin middleware stack
app.route('/api/admin', createAdminRoutes({
  prisma,
  middleware: [authMiddleware, requireAuth, requireSuperAdmin],
}))

// Hand-written admin routes for custom analytics endpoints
app.route('/api/admin', adminRoutes())

// User attribution endpoint (authenticated users, not admin-only)
app.route('/api', userAttributionRoute())

// Scoped analytics routes handle their own auth (workspace/project membership checks)
app.route('/api', scopedAnalyticsRoutes())

// Composio integration routes for managed OAuth (connect/disconnect/status)
app.route('/api', integrationRoutes())

// Internal routes for cluster-internal pod communication (not exposed externally)
app.route('/api/internal', internalRoutes)

// =============================================================================
// Current User Route (/api/me) - Returns user profile with role
// =============================================================================

app.get('/api/me', authMiddleware, requireAuth, async (c) => {
  const authCtx = c.get('auth')
  if (!authCtx?.userId) {
    return c.json({ error: { code: 'unauthorized', message: 'Not authenticated' } }, 401)
  }
  const user = await prisma.user.findUnique({
    where: { id: authCtx.userId },
    select: {
      id: true,
      name: true,
      email: true,
      emailVerified: true,
      image: true,
      role: true,
      onboardingCompleted: true,
      createdAt: true,
      updatedAt: true,
    },
  })
  if (!user) {
    return c.json({ error: { code: 'not_found', message: 'User not found' } }, 404)
  }
  return c.json({ ok: true, data: user })
})

// =============================================================================
// Onboarding complete (/api/onboarding/complete)
// =============================================================================

app.post('/api/onboarding/complete', authMiddleware, requireAuth, async (c) => {
  const authCtx = c.get('auth')
  if (!authCtx?.userId) {
    return c.json({ error: { code: 'unauthorized', message: 'Not authenticated' } }, 401)
  }
  await prisma.user.update({
    where: { id: authCtx.userId },
    data: { onboardingCompleted: true },
  })
  return c.json({ ok: true })
})

// =============================================================================
// Current User Activity (/api/me/activity) - Message stats for account page
// =============================================================================

app.get('/api/me/activity', authMiddleware, requireAuth, async (c) => {
  const authCtx = c.get('auth')
  if (!authCtx?.userId) {
    return c.json({ error: { code: 'unauthorized', message: 'Not authenticated' } }, 401)
  }

  try {
    const userId = authCtx.userId
    const oneYearAgo = new Date()
    oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1)
    oneYearAgo.setHours(0, 0, 0, 0)

    const memberships = await prisma.member.findMany({
      where: { userId },
      select: { workspaceId: true },
    })
    const workspaceIds = memberships.map((m: any) => m.workspaceId)

    if (workspaceIds.length === 0) {
      return c.json({
        ok: true,
        data: { totalMessages: 0, dailyAverage: 0, daysActive: 0, daysInPeriod: 365, currentStreak: 0, dailyCounts: {} },
      })
    }

    const messages = await prisma.chatMessage.findMany({
      where: {
        role: 'user',
        createdAt: { gte: oneYearAgo },
        session: {
          project: { workspaceId: { in: workspaceIds } },
        },
      },
      select: { createdAt: true },
      orderBy: { createdAt: 'asc' },
    })

    const dailyCounts: Record<string, number> = {}
    for (const msg of messages) {
      const day = msg.createdAt.toISOString().slice(0, 10)
      dailyCounts[day] = (dailyCounts[day] || 0) + 1
    }

    const totalMessages = messages.length
    const now = new Date()
    const diffMs = now.getTime() - oneYearAgo.getTime()
    const daysInPeriod = Math.max(1, Math.ceil(diffMs / 86400000))
    const dailyAverage = Math.round((totalMessages / daysInPeriod) * 10) / 10
    const daysActive = Object.keys(dailyCounts).length

    let currentStreak = 0
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    const cursor = new Date(today)
    while (true) {
      const key = cursor.toISOString().slice(0, 10)
      if (dailyCounts[key]) {
        currentStreak++
        cursor.setDate(cursor.getDate() - 1)
      } else if (currentStreak === 0) {
        cursor.setDate(cursor.getDate() - 1)
        const yesterdayKey = cursor.toISOString().slice(0, 10)
        if (dailyCounts[yesterdayKey]) {
          currentStreak++
          cursor.setDate(cursor.getDate() - 1)
        } else {
          break
        }
      } else {
        break
      }
    }

    return c.json({
      ok: true,
      data: { totalMessages, dailyAverage, daysActive, daysInPeriod, currentStreak, dailyCounts },
    })
  } catch (error: any) {
    console.error('[Activity] Failed to fetch activity:', error)
    return c.json({ error: { code: 'activity_failed', message: error.message } }, 500)
  }
})

// =============================================================================
// Generated API Routes - Auto-generated from Prisma schema with hooks
// =============================================================================

// =============================================================================
// Leave Workspace - Removes the current user's membership from a workspace
// =============================================================================

app.post('/api/workspaces/:id/leave', async (c) => {
  const auth = c.get('auth') as any
  const userId = auth?.userId
  if (!userId) return c.json({ error: 'Unauthorized' }, 401)

  const workspaceId = c.req.param('id')

  const memberships = await prisma.member.findMany({
    where: { userId, workspaceId },
  })

  if (memberships.length === 0) {
    return c.json({ error: { code: 'not_found', message: 'You are not a member of this workspace.' } }, 404)
  }

  const wsMembership = memberships.find((m: any) => !m.projectId) || memberships[0]

  if (wsMembership.role === 'owner') {
    const allWsOwners = await prisma.member.findMany({
      where: { workspaceId, role: 'owner' },
      select: { id: true, userId: true, projectId: true },
    })
    const otherOwners = allWsOwners.filter((m: any) => m.userId !== userId && !m.projectId)
    if (otherOwners.length === 0) {
      return c.json({ error: { code: 'last_owner', message: 'You are the only owner. Transfer ownership to another member before leaving.' } }, 400)
    }
  }

  await prisma.member.deleteMany({ where: { userId, workspaceId } })

  const [leavingUser, workspace] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId }, select: { email: true } }),
    prisma.workspace.findUnique({ where: { id: workspaceId }, select: { name: true } }),
  ])
  if (leavingUser?.email) {
    await sendMemberRemovedEmail({
      to: leavingUser.email,
      workspaceName: workspace?.name || 'the workspace',
    })
  }

  return c.json({ ok: true })
})

// =============================================================================
// Invite Link Routes (custom, not auto-generated)
// =============================================================================

// Create invite link for a project or workspace
app.post('/api/invite-links', async (c) => {
  const auth = c.get('auth') as any
  const userId = auth?.userId
  if (!userId) return c.json({ error: 'Unauthorized' }, 401)

  const body = await c.req.json()
  const { projectId, workspaceId, role = 'member' } = body

  if (!projectId && !workspaceId) {
    return c.json({ error: 'projectId or workspaceId required' }, 400)
  }

  // Resolve workspaceId from project if needed
  let resolvedWorkspaceId = workspaceId
  if (projectId && !workspaceId) {
    const project = await prisma.project.findUnique({ where: { id: projectId }, select: { workspaceId: true } })
    if (!project) return c.json({ error: 'Project not found' }, 404)
    resolvedWorkspaceId = project.workspaceId
  }

  // Verify admin access
  const membership = await prisma.member.findFirst({
    where: { userId, workspaceId: resolvedWorkspaceId },
  })
  if (!membership || (membership.role !== 'owner' && membership.role !== 'admin')) {
    return c.json({ error: 'Only admins and owners can create invite links' }, 403)
  }

  const link = await prisma.inviteLink.create({
    data: { projectId, workspaceId: resolvedWorkspaceId, role, createdBy: userId },
  })

  const inviteeEmail = body.email as string | undefined
  if (inviteeEmail) {
    const baseUrl = process.env.BETTER_AUTH_URL || process.env.APP_URL || ''
    const acceptUrl = `${baseUrl}/invite/${link.token}`
    const [inviter, workspace] = await Promise.all([
      prisma.user.findUnique({ where: { id: userId }, select: { name: true } }),
      prisma.workspace.findUnique({ where: { id: resolvedWorkspaceId }, select: { name: true } }),
    ])
    const inviterName = inviter?.name || 'A teammate'
    const workspaceName = workspace?.name || 'your workspace'

    if (projectId) {
      const project = await prisma.project.findUnique({ where: { id: projectId }, select: { name: true } })
      await sendProjectInviteEmail({
        to: inviteeEmail,
        inviterName,
        projectName: project?.name || 'a project',
        workspaceName,
        role,
        acceptUrl,
      })
    } else {
      await sendInvitationEmail({
        to: inviteeEmail,
        inviterName,
        workspaceName,
        role,
        acceptUrl,
      })
    }
  }

  return c.json({ ok: true, data: link })
})

// List invite links
app.get('/api/invite-links', async (c) => {
  const auth = c.get('auth') as any
  const userId = auth?.userId
  if (!userId) return c.json({ error: 'Unauthorized' }, 401)

  const projectId = c.req.query('projectId')
  const workspaceId = c.req.query('workspaceId')

  const where: any = {}
  if (projectId) where.projectId = projectId
  else if (workspaceId) where.workspaceId = workspaceId
  else return c.json({ ok: true, items: [] })

  const links = await prisma.inviteLink.findMany({ where, orderBy: { createdAt: 'desc' } })
  return c.json({ ok: true, items: links })
})

// Toggle invite link (owner must be the creator or workspace admin)
app.patch('/api/invite-links/:id', async (c) => {
  const auth = c.get('auth') as any
  const userId = auth?.userId
  if (!userId) return c.json({ error: 'Unauthorized' }, 401)

  const id = c.req.param('id')
  const existing = await prisma.inviteLink.findUnique({ where: { id } })
  if (!existing) return c.json({ error: 'Not found' }, 404)

  // Only the creator or a workspace admin can modify
  if (existing.createdBy !== userId) {
    const wsId = existing.workspaceId
    if (wsId) {
      const member = await prisma.member.findFirst({ where: { userId, workspaceId: wsId } })
      if (!member || (member.role !== 'owner' && member.role !== 'admin')) {
        return c.json({ error: 'Forbidden' }, 403)
      }
    } else {
      return c.json({ error: 'Forbidden' }, 403)
    }
  }

  const body = await c.req.json()
  const link = await prisma.inviteLink.update({ where: { id }, data: { enabled: body.enabled } })
  return c.json({ ok: true, data: link })
})

app.delete('/api/invite-links/:id', async (c) => {
  const auth = c.get('auth') as any
  const userId = auth?.userId
  if (!userId) return c.json({ error: 'Unauthorized' }, 401)

  const existing = await prisma.inviteLink.findUnique({ where: { id: c.req.param('id') } })
  if (!existing) return c.json({ error: 'Not found' }, 404)

  if (existing.createdBy !== userId) {
    const wsId = existing.workspaceId
    if (wsId) {
      const member = await prisma.member.findFirst({ where: { userId, workspaceId: wsId } })
      if (!member || (member.role !== 'owner' && member.role !== 'admin')) {
        return c.json({ error: 'Forbidden' }, 403)
      }
    } else {
      return c.json({ error: 'Forbidden' }, 403)
    }
  }

  await prisma.inviteLink.delete({ where: { id: existing.id } })
  return c.json({ ok: true })
})

// Accept invite link (public-ish - requires auth but not membership)
app.post('/api/invite-links/:token/accept', async (c) => {
  const auth = c.get('auth') as any
  const userId = auth?.userId
  if (!userId) return c.json({ error: 'Unauthorized' }, 401)

  const token = c.req.param('token')
  const link = await prisma.inviteLink.findUnique({ where: { token } })

  if (!link || !link.enabled) {
    return c.json({ error: 'Invite link not found or disabled' }, 404)
  }
  if (link.expiresAt && new Date(link.expiresAt) < new Date()) {
    return c.json({ error: 'Invite link has expired' }, 410)
  }

  // Check if already a member
  const existingMember = await prisma.member.findFirst({
    where: {
      userId,
      ...(link.projectId ? { projectId: link.projectId } : { workspaceId: link.workspaceId }),
    },
  })
  if (existingMember) {
    return c.json({ ok: true, data: existingMember, alreadyMember: true })
  }

  // Create membership
  const memberData: any = { userId, role: link.role }
  if (link.projectId) {
    memberData.projectId = link.projectId
    // Also resolve workspace for the member record
    const project = await prisma.project.findUnique({ where: { id: link.projectId }, select: { workspaceId: true } })
    if (project) memberData.workspaceId = project.workspaceId
  } else {
    memberData.workspaceId = link.workspaceId
  }

  const member = await prisma.member.create({ data: memberData })

  // Increment use count
  await prisma.inviteLink.update({ where: { id: link.id }, data: { useCount: { increment: 1 } } })

  // Send notification emails (non-blocking — errors are logged internally)
  const baseUrl = process.env.BETTER_AUTH_URL || process.env.APP_URL || ''
  const resolvedWorkspaceId = memberData.workspaceId
  const [acceptingUser, workspace, project] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId }, select: { name: true, email: true } }),
    resolvedWorkspaceId ? prisma.workspace.findUnique({ where: { id: resolvedWorkspaceId }, select: { name: true } }) : null,
    link.projectId ? prisma.project.findUnique({ where: { id: link.projectId }, select: { name: true } }) : null,
  ])
  const acceptingName = acceptingUser?.name || acceptingUser?.email || 'Someone'
  const acceptingEmail = acceptingUser?.email || ''
  const resourceName = project?.name || workspace?.name || 'your workspace'
  const resourceType = link.projectId ? 'project' : 'workspace'
  const workspaceName = workspace?.name || 'your workspace'

  if (link.createdBy) {
    const creator = await prisma.user.findUnique({ where: { id: link.createdBy }, select: { email: true } })
    if (creator?.email) {
      await sendInviteAcceptedEmail({
        to: creator.email,
        inviteeName: acceptingName,
        inviteeEmail: acceptingEmail,
        resourceName,
        resourceType,
        dashboardUrl: baseUrl,
      })
    }
  }

  if (resolvedWorkspaceId) {
    const owners = await prisma.member.findMany({
      where: { workspaceId: resolvedWorkspaceId, role: 'owner', userId: { not: userId } },
      include: { user: { select: { email: true } } },
    })
    for (const owner of owners) {
      if (owner.user?.email) {
        await sendMemberJoinedEmail({
          to: owner.user.email,
          memberName: acceptingName,
          memberEmail: acceptingEmail,
          workspaceName,
          role: link.role,
          dashboardUrl: baseUrl,
        })
      }
    }
  }

  return c.json({ ok: true, data: member })
})

// Get invite link info (for accept page - minimal auth)
app.get('/api/invite-links/:token/info', async (c) => {
  const token = c.req.param('token')
  const link = await prisma.inviteLink.findUnique({
    where: { token },
    include: {
      project: { select: { id: true, name: true } },
      workspace: { select: { id: true, name: true } },
    },
  })

  if (!link || !link.enabled) {
    return c.json({ error: 'Invite link not found or disabled' }, 404)
  }

  return c.json({
    ok: true,
    data: {
      role: link.role,
      projectName: link.project?.name,
      workspaceName: link.workspace?.name,
      expired: link.expiresAt ? new Date(link.expiresAt) < new Date() : false,
    },
  })
})

// Mount generated routes at /api
const generatedRoutes = createGeneratedRoutes({
  prisma,
  hooks: routeHooks,
})
app.route('/api', generatedRoutes)

// =============================================================================
// Graceful shutdown handling
// =============================================================================

const DRAIN_TIMEOUT_MS = 600_000
const DRAIN_POLL_MS = 1_000

async function gracefulShutdown(signal: string) {
  if (isShuttingDown) return
  isShuttingDown = true
  console.log(`[Server] Received ${signal}, starting graceful shutdown...`)

  // Stop warm pool reconciliation so GC doesn't delete services during drain
  if (isKubernetes()) {
    try {
      const { getWarmPoolController } = await import('./lib/warm-pool-controller')
      const controller = getWarmPoolController()
      await controller.stop()
      console.log('[Server] Warm pool controller stopped')
    } catch (_) { /* may not be initialized */ }
  }

  // In local dev mode, stop child-process runtimes. In K8s mode the
  // project runtimes are independent Knative services and must NOT be killed.
  if (!isKubernetes() && runtimeManager) {
    console.log('[Server] Stopping local project runtimes...')
    try {
      await runtimeManager.stopAll()
      console.log('[Server] All local runtimes stopped')
    } catch (err: any) {
      console.error('[Server] Error stopping runtimes:', err.message)
    }
  }

  // Drain active proxy connections (SSE streams, chat)
  if (activeProxyConnections > 0) {
    console.log(`[Server] Draining ${activeProxyConnections} active proxy connection(s)...`)
    const deadline = Date.now() + DRAIN_TIMEOUT_MS
    while (activeProxyConnections > 0 && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, DRAIN_POLL_MS))
    }
    if (activeProxyConnections > 0) {
      console.log(`[Server] Drain timeout reached with ${activeProxyConnections} connection(s) remaining`)
    } else {
      console.log('[Server] All proxy connections drained')
    }
  }

  stopAllPrismaStudios()

  try {
    const { shutdownTracing } = await import('./instrumentation')
    await shutdownTracing()
  } catch (_) { /* instrumentation may not be loaded */ }

  console.log('[Server] Shutdown complete')
  process.exit(0)
}

// Register shutdown handlers
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'))
process.on('SIGINT', () => gracefulShutdown('SIGINT'))

// Start server
console.log(`🚀 API server running on http://localhost:${API_PORT}`)
console.log(`   Chat endpoint: POST http://localhost:${API_PORT}/api/chat`)
console.log(`   Runtime endpoints: POST/GET http://localhost:${API_PORT}/api/projects/:id/runtime/*`)
console.log(`   AI Proxy: POST http://localhost:${API_PORT}/api/ai/v1/chat/completions`)
console.log(`   AI Proxy: POST http://localhost:${API_PORT}/api/ai/v1/responses`)
console.log(`   AI Models: GET  http://localhost:${API_PORT}/api/ai/v1/models`)
console.log(`   AI Proxy Health: GET  http://localhost:${API_PORT}/api/ai/proxy/health`)
console.log(`   CORS origin: http://localhost:${VITE_PORT}`)
console.log(`   AI Providers: Anthropic=${!!process.env.ANTHROPIC_API_KEY}, OpenAI=${!!process.env.OPENAI_API_KEY}, Google=${!!process.env.GOOGLE_API_KEY}`)

// Local mode: restore saved API keys and auto-seed default user on startup
if (process.env.SHOGO_LOCAL_MODE === 'true') {
  setTimeout(async () => {
    try {
      const savedConfig = await (prisma as any).localConfig.findMany({})
      for (const row of savedConfig) {
        if (!process.env[row.key]) {
          process.env[row.key] = row.value
          console.log(`[LocalMode] Restored ${row.key} from local config`)
        }
      }
    } catch (err: any) {
      console.log('[LocalMode] Could not restore API keys (table may not exist yet):', err.message)
    }

    // Auto-seed the single local user if none exists
    try {
      const userCount = await prisma.user.count()
      if (userCount === 0) {
        const crypto = require('crypto') as typeof import('crypto')
        const password = crypto.randomBytes(24).toString('base64')

        const signUpRes = await auth.api.signUpEmail({
          body: {
            name: 'Local User',
            email: 'local@shogo.local',
            password,
          },
        })

        if (signUpRes?.user) {
          await (prisma as any).localConfig.upsert({
            where: { key: 'local_user_password' },
            update: { value: password },
            create: { key: 'local_user_password', value: password },
          })
          console.log('[LocalMode] Auto-seeded default user local@shogo.local')
        }
      }
    } catch (err: any) {
      console.error('[LocalMode] Failed to auto-seed user:', err.message)
    }

    // Start instance tunnel to Shogo Cloud if API key is configured
    if (process.env.SHOGO_API_KEY) {
      try {
        const { startInstanceTunnel } = await import('./lib/instance-tunnel')
        startInstanceTunnel()
      } catch (err: any) {
        console.error('[LocalMode] Failed to start instance tunnel (non-fatal):', err.message)
      }
    }
  }, 1000)
}

export default {
  port: API_PORT,
  hostname: "0.0.0.0",
  fetch: async (req: Request, server: any) => {
    const url = new URL(req.url)
    if (url.pathname === '/api/instances/ws' && req.headers.get('upgrade')?.toLowerCase() === 'websocket') {
      const authResult = await authenticateInstanceWs(req)
      if (!authResult) {
        return new Response('Unauthorized', { status: 401 })
      }
      const upgraded = server.upgrade(req, { data: authResult })
      if (upgraded) return undefined
      return new Response('WebSocket upgrade failed', { status: 500 })
    }
    return app.fetch(req, server)
  },
  websocket: {
    open: handleInstanceWsOpen,
    message: handleInstanceWsMessage,
    close: handleInstanceWsClose,
  },
  idleTimeout: 255,
}

// Pre-warm Claude Code after server is listening.
// Small delay ensures the export/listen completes before we start the warm-up.
// The warm-up sends a minimal "ping" to initialize the CLI subprocess and MCP servers.
// Disabled by default in staging/production — opt in with PREWARM_CLAUDE_CODE=true.
const PREWARM_ENABLED = process.env.PREWARM_CLAUDE_CODE === 'true'
if (PREWARM_ENABLED) {
  setTimeout(() => {
    prewarmClaudeCode().catch((err) => {
      console.error('[ClaudeCode] ⚠️ Pre-warm error (non-fatal):', err.message)
    })
  }, 3000)
}

// Start warm pool controller (Kubernetes only).
// Maintains pre-warmed pods to eliminate cold start latency for users.
// Delay reduced from 5s to 2s to ensure warm pool is available sooner
// after API pod scale-up events (avoids cold starts during burst traffic).
if (isKubernetes()) {
  setTimeout(async () => {
    try {
      const { startWarmPool } = await import('./lib/warm-pool-controller')
      await startWarmPool()
      console.log('[WarmPool] Warm pool controller started')
    } catch (err: any) {
      console.error('[WarmPool] Failed to start warm pool controller (non-fatal):', err.message)
    }

    try {
      const { startInfraMetricsCollector } = await import('./lib/infra-metrics-collector')
      startInfraMetricsCollector(prisma)
    } catch (err: any) {
      console.error('[InfraCollector] Failed to start (non-fatal):', err.message)
    }

    try {
      const { startHeartbeatScheduler } = await import('./lib/heartbeat-scheduler')
      await startHeartbeatScheduler()
      console.log('[HeartbeatScheduler] Heartbeat scheduler started')
    } catch (err: any) {
      console.error('[HeartbeatScheduler] Failed to start heartbeat scheduler (non-fatal):', err.message)
    }

    try {
      const { startAnalyticsDigestCollector } = await import('./lib/analytics-digest-collector')
      startAnalyticsDigestCollector(prisma)
    } catch (err: any) {
      console.error('[AnalyticsDigest] Failed to start (non-fatal):', err.message)
    }
  }, 2000)
}

// Start local heartbeat scheduler (local dev only)
if (process.env.SHOGO_LOCAL_MODE === 'true' && !isKubernetes()) {
  setTimeout(async () => {
    try {
      const { startLocalHeartbeatScheduler } = await import('./lib/local-heartbeat-scheduler')
      await startLocalHeartbeatScheduler(getRuntimeManager())
      console.log('[LocalHeartbeat] Local heartbeat scheduler started')
    } catch (err: any) {
      console.error('[LocalHeartbeat] Failed to start (non-fatal):', err.message)
    }
  }, 3000)
}

