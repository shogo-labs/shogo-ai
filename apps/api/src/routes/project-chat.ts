// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Project Chat Proxy Routes
 *
 * Proxies chat requests to per-project runtime pods.
 *
 * In Kubernetes: Routes to Knative Services via internal DNS
 * In Local Dev: Routes to local RuntimeManager-spawned processes
 *
 * Endpoints:
 * - POST /projects/:projectId/chat - Proxy chat to project pod
 */

import { Hono } from "hono"
import { resolve } from "path"
import { existsSync } from "fs"
import { trace, SpanStatusCode } from "@opentelemetry/api"

import { prisma } from "../lib/prisma"
import type { IRuntimeManager } from "../lib/runtime"
import * as billingService from "../services/billing.service"
import * as checkpointService from "../services/checkpoint.service"
import { setProjectUser } from "../lib/project-user-context"
import { openSession, closeSession } from "../lib/proxy-billing-session"

const chatTracer = trace.getTracer("shogo-api-chat")

// Environment detection
const isKubernetes = () => !!process.env.KUBERNETES_SERVICE_HOST

// =============================================================================
// Configuration
// =============================================================================

export interface ProjectChatRoutesConfig {
  /**
   * Local runtime manager (used in non-K8s environments).
   */
  runtimeManager?: IRuntimeManager
}

const PROJECT_ROOT = resolve(__dirname, '../../../..')
const WORKSPACES_DIR = process.env.WORKSPACES_DIR || resolve(PROJECT_ROOT, 'workspaces')

const FILE_MODIFYING_TOOLS = new Set([
  'write_file', 'exec',
  'canvas_create', 'canvas_update', 'canvas_data', 'canvas_data_patch', 'canvas_delete',
  'canvas_api_schema', 'canvas_api_seed', 'canvas_api_hooks', 'canvas_api_bind',
  'tool_install', 'mcp_install',
])

function hasFileModifyingTools(toolCallMap: Map<string, { toolName: string }>): boolean {
  for (const tc of toolCallMap.values()) {
    if (FILE_MODIFYING_TOOLS.has(tc.toolName) || tc.toolName.startsWith('mcp_')) {
      return true
    }
  }
  return false
}

// =============================================================================
// Stream Usage Tracking
// =============================================================================

/**
 * Scan a teed copy of the AI SDK stream for usage/tool-call data.
 *
 * The Vercel AI SDK UI protocol uses newline-delimited messages.  Key prefixes:
 *   e: (finish)  — JSON with usage { promptTokens, completionTokens }
 *   9: (tool_call) — tool invocations
 *   d: (finish_message/finish_step) — JSON with usage
 *
 * We consume the entire tracking stream, count tool calls, and extract the
 * final usage object. Then we charge credits via the billing service and
 * log a `ToolCallLog` entry per tool call.
 */
async function trackUsageFromStream(
  stream: ReadableStream<Uint8Array>,
  requestBody: any,
  project: { id: string; workspaceId: string },
) {
  const decoder = new TextDecoder()
  const reader = stream.getReader()
  let buffer = ''
  let lastUsage: { promptTokens?: number; completionTokens?: number; totalTokens?: number } | null = null

  // Accumulate tool call data incrementally as stream events arrive.
  // Keyed by toolCallId so args, result, and duration are captured correctly.
  interface ToolCallRecord {
    toolCallId: string
    toolName: string
    args: any
    result: any
    startedAt: number
    duration: number | null
  }
  const toolCallMap = new Map<string, ToolCallRecord>()

  // server-side-persistence: Accumulate ordered parts for DB persistence.
  // We maintain the natural interleaving of text and tool calls so that
  // on page refresh the parts array faithfully reproduces the original order.
  let accumulatedText = ''
  const orderedParts: any[] = []
  // Index into orderedParts by toolCallId so we can back-fill output later
  const toolPartIndex = new Map<string, any>()
  let currentTextPart: { type: 'text'; text: string } | null = null
  let currentReasoningPart: { type: 'reasoning'; text: string; durationMs?: number } | null = null
  let reasoningStartedAt: number | null = null
  let streamInterrupted = false

  const PER_CHUNK_IDLE_TIMEOUT_MS = 120_000

  try {
    while (true) {
      const idleTimeout = new Promise<{ done: true; value: undefined }>((_, reject) =>
        setTimeout(() => reject(new Error('chunk idle timeout')), PER_CHUNK_IDLE_TIMEOUT_MS)
      )
      const { done, value } = await Promise.race([reader.read(), idleTimeout])
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      // Process complete lines
      const lines = buffer.split('\n')
      buffer = lines.pop() || '' // Keep the incomplete last line

      for (const line of lines) {
        if (!line.trim()) continue

        // The project runtime uses toUIMessageStreamResponse() which produces
        // Server-Sent Events (SSE) format: "data: {json}\n\n"
        // Parse SSE data lines
        let payload = line
        if (line.startsWith('data: ')) {
          payload = line.slice(6) // Strip "data: " prefix
        } else if (line.startsWith('data:')) {
          payload = line.slice(5)
        }

        // Skip SSE control lines and [DONE] marker
        if (payload === '[DONE]' || line.startsWith('event:') || line.startsWith('id:') || line.startsWith('retry:')) {
          continue
        }

        // Try to parse as JSON
        let data: any
        try {
          data = JSON.parse(payload)
        } catch {
          // Also try legacy data stream protocol (e.g. "e:{json}", "9:{json}")
          const prefix = line.slice(0, 2)
          if (prefix === '9:' || prefix === 'e:' || prefix === 'd:') {
            try { data = JSON.parse(line.slice(2)) } catch { continue }
            // Legacy data stream: mark type based on prefix
            if (prefix === '9:' && !data.type) data.type = 'tool-call'
            if ((prefix === 'e:' || prefix === 'd:') && !data.type) data.type = 'finish'
          } else {
            continue
          }
        }

        if (!data || typeof data !== 'object') continue

        // UI Message Stream protocol uses { type: "..." } format
        const type = data.type

        // server-side-persistence: Accumulate reasoning/thinking content
        if (type === 'reasoning-start') {
          currentTextPart = null
          reasoningStartedAt = Date.now()
          currentReasoningPart = { type: 'reasoning', text: '' }
          orderedParts.push(currentReasoningPart)
        }
        if (type === 'reasoning-delta' && data.delta && currentReasoningPart) {
          currentReasoningPart.text += data.delta
        }
        if (type === 'reasoning-end') {
          if (currentReasoningPart && reasoningStartedAt) {
            currentReasoningPart.durationMs = Date.now() - reasoningStartedAt
          }
          currentReasoningPart = null
          reasoningStartedAt = null
        }

        // server-side-persistence: Accumulate text content from stream
        if (type === 'text-delta' && data.delta) {
          currentReasoningPart = null
          accumulatedText += data.delta
          if (!currentTextPart) {
            currentTextPart = { type: 'text', text: '' }
            orderedParts.push(currentTextPart)
          }
          currentTextPart.text += data.delta
        }

        // Track tool calls: create record at start, fill in args/result as they arrive
        if (type === 'tool-input-start' || type === 'tool-call-start' || type === 'tool-call') {
          const toolCallId = data.toolCallId || `tool-${Date.now()}-${toolCallMap.size}`
          if (!toolCallMap.has(toolCallId)) {
            toolCallMap.set(toolCallId, {
              toolCallId,
              toolName: data.toolName || data.name || 'unknown',
              args: data.args || data.input || null,
              result: null,
              startedAt: Date.now(),
              duration: null,
            })
          }
        }

        // Finalized tool input: capture the real args
        if (type === 'tool-input-available') {
          const toolCallId = data.toolCallId || ''
          const record = toolCallMap.get(toolCallId)
          if (record) {
            record.args = data.input ?? record.args
          } else {
            toolCallMap.set(toolCallId, {
              toolCallId,
              toolName: data.toolName || 'unknown',
              args: data.input || null,
              result: null,
              startedAt: Date.now(),
              duration: null,
            })
          }

          currentTextPart = null
          currentReasoningPart = null
          const part = {
            type: 'dynamic-tool',
            toolCallId,
            toolName: data.toolName || toolCallMap.get(toolCallId)?.toolName || 'unknown',
            input: data.input || {},
            output: null as any,
            state: 'output-available',
          }
          orderedParts.push(part)
          toolPartIndex.set(toolCallId, part)
        }

        // Finalized tool output: capture the real result and compute duration
        if (type === 'tool-output-available') {
          const toolCallId = data.toolCallId || ''
          const record = toolCallMap.get(toolCallId)
          if (record) {
            record.result = data.output ?? null
            record.duration = Date.now() - record.startedAt
          }
          const part = toolPartIndex.get(toolCallId)
          if (part) {
            part.output = data.output ?? { success: true }
          }
        }

        // Track usage from finish events or dedicated usage events
        if (type === 'finish' || type === 'finish-step' || type === 'usage' || type === 'data-usage') {
          // Custom data-usage event from runtime puts data in `data` field
          const usageData = data.usage || data.data
          if (usageData && (usageData.inputTokens || usageData.outputTokens || usageData.promptTokens || usageData.completionTokens || usageData.totalTokens)) {
            lastUsage = {
              // Support both v5 (promptTokens) and v6 (inputTokens) naming
              promptTokens: usageData.promptTokens || usageData.inputTokens || 0,
              completionTokens: usageData.completionTokens || usageData.outputTokens || 0,
              totalTokens: usageData.totalTokens || ((usageData.promptTokens || usageData.inputTokens || 0) + (usageData.completionTokens || usageData.outputTokens || 0)),
            }
          }
          // Sometimes usage is at top level
          if (data.promptTokens || data.completionTokens || data.inputTokens || data.outputTokens) {
            lastUsage = {
              promptTokens: data.promptTokens || data.inputTokens || 0,
              completionTokens: data.completionTokens || data.outputTokens || 0,
              totalTokens: data.totalTokens || ((data.promptTokens || data.inputTokens || 0) + (data.completionTokens || data.outputTokens || 0)),
            }
          }
        }

        // Legacy: handle array-style tool calls (data stream protocol "9:[{...}]")
        if (Array.isArray(data)) {
          for (const tc of data) {
            if (tc.toolName || tc.name) {
              const toolCallId = tc.toolCallId || `legacy-${Date.now()}-${toolCallMap.size}`
              if (!toolCallMap.has(toolCallId)) {
                toolCallMap.set(toolCallId, {
                  toolCallId,
                  toolName: tc.toolName || tc.name || 'unknown',
                  args: tc.args || null,
                  result: null,
                  startedAt: Date.now(),
                  duration: null,
                })
              }
            }
          }
        }
      }
    }
  } catch (streamErr: any) {
    streamInterrupted = true
    console.warn(`[ProjectChat] Stream interrupted (${streamErr.code || streamErr.message}), persisting ${accumulatedText.length} chars accumulated so far`)
  } finally {
    reader.releaseLock()
  }

  // Extract context
  const chatSessionId = requestBody?.chatSessionId || null
  const agentMode = requestBody?.agentMode || 'advanced'

  const inputTokens = lastUsage?.promptTokens || 0
  const outputTokens = lastUsage?.completionTokens || 0
  const totalTokens = lastUsage?.totalTokens || (inputTokens + outputTokens)

  const toolCallCount = toolCallMap.size

  console.log(
    `[ProjectChat] 📊 Stream ${streamInterrupted ? 'interrupted' : 'complete'} — tokens: ${totalTokens} (in: ${inputTokens}, out: ${outputTokens}), tool calls: ${toolCallCount}, agent mode: ${agentMode}`
  )

  // Credit billing is handled by the AI proxy billing session (opened before
  // proxying, closed after stream completes in the route handler).

  // Close the billing session — this triggers the actual credit charge
  // based on total accumulated tokens across all API calls in the agentic loop.
  const { creditCost } = await closeSession(project.id)
  if (creditCost > 0) {
    console.log(`[ProjectChat] 💰 Billing session closed — charged ${creditCost} credits for project ${project.id}`)
  }

  // Persist assistant message first so we have a messageId for tool call logs.
  let assistantMessageId: string | null = null

  if (chatSessionId && (accumulatedText || toolCallMap.size > 0)) {
    try {
      const session = await prisma.chatSession.findUnique({ where: { id: chatSessionId } })
      if (session) {
        // Use orderedParts which preserves the natural interleaving of
        // text and tool calls as they appeared in the stream.
        // Filter out empty text/reasoning parts that can accumulate from keepalive pings.
        const parts = orderedParts.filter(
          (p) => !((p.type === 'text' || p.type === 'reasoning') && (!p.text || !p.text.trim()))
        )

        const message = await prisma.chatMessage.create({
          data: {
            sessionId: chatSessionId,
            role: 'assistant',
            content: accumulatedText,
            parts: parts.length > 0 ? JSON.stringify(parts) : undefined,
          },
        })
        assistantMessageId = message.id
        console.log(`[ProjectChat] 💾 Persisted assistant message (${accumulatedText.length} chars, ${toolCallCount} tool calls${streamInterrupted ? ', partial' : ''}) for session ${chatSessionId}`)
      }
    } catch (err) {
      console.error("[ProjectChat] Failed to persist assistant message:", err)
    }
  }

  // Log tool calls with real args, results, duration, and the correct messageId
  if (toolCallMap.size > 0 && chatSessionId) {
    try {
      const session = assistantMessageId
        ? true
        : !!(await prisma.chatSession.findUnique({ where: { id: chatSessionId } }))

      if (session) {
        await prisma.toolCallLog.createMany({
          data: [...toolCallMap.values()].map((tc) => ({
            chatSessionId,
            messageId: assistantMessageId || '',
            toolName: tc.toolName,
            args: tc.args != null ? JSON.stringify(tc.args) : undefined,
            result: tc.result != null ? JSON.stringify(tc.result) : undefined,
            duration: tc.duration,
            status: 'complete' as const,
          })),
        })
        console.log(`[ProjectChat] 🔧 Logged ${toolCallMap.size} tool calls for session ${chatSessionId}`)
      }
    } catch (err) {
      console.error("[ProjectChat] Failed to log tool calls:", err)
    }
  }

  // Auto-checkpoint: create a git snapshot when the agent modified files.
  // In Kubernetes the workspace lives on the agent pod, not on the API pod,
  // so the local path doesn't exist. Skip silently instead of logging a warning
  // on every streamed response.
  if (hasFileModifyingTools(toolCallMap) && !streamInterrupted) {
    const workspacePath = resolve(WORKSPACES_DIR, project.id)
    if (existsSync(workspacePath)) {
      const toolNames = [...new Set([...toolCallMap.values()].map(tc => tc.toolName))].join(', ')
      checkpointService.createCheckpoint({
        projectId: project.id,
        workspacePath,
        message: `AI: ${toolNames} (${toolCallMap.size} tool calls)`,
        isAutomatic: true,
      }).catch((err) => {
        console.warn('[ProjectChat] Auto-checkpoint failed (non-blocking):', err.message)
      })
    }
  }
}

// =============================================================================
// Routes
// =============================================================================

export function projectChatRoutes(config: ProjectChatRoutesConfig) {
  const { runtimeManager } = config
  const router = new Hono()

  /**
   * Validate project exists before operations.
   */
  async function validateProject(projectId: string) {
    try {
      const project = await prisma.project.findUnique({
        where: { id: projectId },
        select: { id: true, name: true, workspaceId: true },
      })
      return project || null
    } catch (err) {
      console.error("[ProjectChat] Project lookup error:", err)
      return null
    }
  }

  /**
   * Wait for runtime to become ready (status === 'running').
   * Used when runtime is already starting from another request.
   */
  async function waitForRuntimeReady(projectId: string, timeoutMs: number = 30000): Promise<void> {
    const startTime = Date.now()
    const checkInterval = 500

    while (Date.now() - startTime < timeoutMs) {
      const runtime = runtimeManager?.status(projectId)
      if (runtime?.status === 'running') {
        return
      }
      if (runtime?.status === 'error' || runtime?.status === 'stopped') {
        throw new Error(`Runtime for ${projectId} failed to start: ${runtime.status}`)
      }
      await new Promise(resolve => setTimeout(resolve, checkInterval))
    }
    throw new Error(`Timeout waiting for runtime ${projectId} to become ready`)
  }

  /**
   * Get the URL for a project's runtime agent server.
   * Handles both Kubernetes (Knative) and local development.
   *
   * Properly handles concurrent requests by:
   * - Starting the runtime if stopped/error/missing
   * - Waiting if runtime is already starting from another request
   */
  async function getProjectUrl(projectId: string): Promise<string> {
    if (isKubernetes()) {
      // In Kubernetes: Use Knative project manager
      const { getProjectPodUrl } = await import("../lib/knative-project-manager")
      return await getProjectPodUrl(projectId)
    } else if (runtimeManager) {
      // Local development: Use RuntimeManager
      let runtime = runtimeManager.status(projectId)

      if (!runtime || runtime.status === "stopped" || runtime.status === "error") {
        // No runtime or failed - start it
        console.log(`[ProjectChat] Starting runtime for ${projectId}...`)
        runtime = await runtimeManager.start(projectId)
      } else if (runtime.status === "starting") {
        // Runtime is being started by another request - wait for it
        console.log(`[ProjectChat] Runtime for ${projectId} is starting, waiting...`)
        await waitForRuntimeReady(projectId)
        runtime = runtimeManager.status(projectId)!
      }
      // else: runtime.status === "running" - proceed immediately

      const agentPort = runtime.agentPort || (runtime.port + 1000)
      const runtimeHost = new URL(runtime.url).hostname
      return `http://${runtimeHost}:${agentPort}`
    } else {
      throw new Error("No runtime manager available for local development")
    }
  }

  /**
   * Make an authenticated fetch to the project's agent runtime.
   * Resolves the runtime URL and injects the per-project runtime token.
   */
  async function fetchFromRuntime(
    projectId: string,
    path: string,
    init?: RequestInit,
  ): Promise<Response> {
    const baseUrl = await getProjectUrl(projectId)
    const { deriveRuntimeToken } = await import("../lib/runtime-token")
    const headers = new Headers(init?.headers)
    if (!headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json")
    }
    headers.set("x-runtime-token", deriveRuntimeToken(projectId))
    return fetch(`${baseUrl}${path}`, { ...init, headers })
  }

  /**
   * POST /projects/:projectId/chat - Proxy chat to project pod
   *
   * Forwards the chat request to the project's runtime pod and streams
   * the response back to the client.
   *
   * Includes retry logic for transient errors (connection refused, etc.)
   * during cold starts when the pod may not be fully ready yet.
   */
  router.post("/projects/:projectId/chat", async (c) => {
    const projectId = c.req.param("projectId")
    console.log(`[ProjectChat] Received chat request for project: ${projectId}`)

    return chatTracer.startActiveSpan("chat.proxy", {
      attributes: { "project.id": projectId },
    }, async (chatSpan) => {
    try {
      const project = await validateProject(projectId)
      if (!project) {
        chatSpan.setStatus({ code: SpanStatusCode.ERROR, message: "project_not_found" })
        chatSpan.end()
        return c.json(
          { error: { code: "project_not_found", message: "Project not found" } },
          404
        )
      }

      if (!await billingService.hasCredits(project.workspaceId)) {
        chatSpan.setAttribute("error.type", "insufficient_credits")
        chatSpan.end()
        return c.json(
          { error: { code: "insufficient_credits", message: "You've run out of credits. Please upgrade your plan to continue." } },
          402
        )
      }

      let podUrl: string
      try {
        const podStartTime = Date.now()
        podUrl = await chatTracer.startActiveSpan("chat.get_pod_url", {
          attributes: { "project.id": projectId },
        }, async (podSpan) => {
          try {
            const url = await getProjectUrl(projectId)
            podSpan.setAttribute("pod.url", url)
            podSpan.setAttribute("pod.resolve_ms", Date.now() - podStartTime)
            podSpan.setStatus({ code: SpanStatusCode.OK })
            return url
          } catch (err: any) {
            podSpan.setStatus({ code: SpanStatusCode.ERROR, message: err.message })
            podSpan.recordException(err)
            throw err
          } finally {
            podSpan.end()
          }
        })
      } catch (err: any) {
        console.error(`[ProjectChat] Failed to get project URL:`, err)
        // Return a structured error that the frontend can handle gracefully
        // Include "starting" status so frontend knows to retry
        const isTimeout = err.message?.includes('timeout') || err.message?.includes('Timeout')
        const isStarting = err.message?.includes('not ready') || err.message?.includes('starting')
        
        return c.json(
          { 
            error: { 
              code: isTimeout || isStarting ? "pod_starting" : "pod_unavailable", 
              message: isTimeout 
                ? "Project runtime is still starting. Please retry in a few seconds."
                : isStarting
                  ? "Project runtime is starting up. Please wait..."
                  : err.message || "Project runtime unavailable",
              retryable: true, // Tell frontend this is a temporary condition
            } 
          },
          isTimeout || isStarting ? 503 : 503
        )
      }

      const chatEndpoint = '/agent/chat'

      console.log(`[ProjectChat] Proxying to: ${podUrl}${chatEndpoint}`)

      // Get the request body and parse for billing context
      let body = await c.req.text()
      let parsedBody: any = {}
      try { parsedBody = JSON.parse(body) } catch { /* not JSON, that's fine */ }

      // Enforce basic agent mode for free/basic-plan workspaces (server-side guard)
      if (parsedBody.agentMode && parsedBody.agentMode !== 'basic') {
        const hasAdvanced = await billingService.hasAdvancedModelAccess(project.workspaceId)
        if (!hasAdvanced) {
          parsedBody.agentMode = 'basic'
          body = JSON.stringify(parsedBody)
        }
      }

      // Track the user who initiated this chat so AI proxy requests from the
      // runtime (which use a generic 'system' token) can be attributed correctly.
      const billingUserId = parsedBody?.userId || c.req.header("X-Billing-User-Id")
      if (billingUserId && billingUserId !== 'system') {
        setProjectUser(projectId, billingUserId)
      }

      // Validate the claimed user ID against workspace membership.
      // Only forward a trusted X-User-Id if the user is actually a member
      // of the project's workspace — prevents header spoofing.
      let verifiedUserId: string | undefined
      if (billingUserId && billingUserId !== 'system') {
        try {
          const member = await prisma.member.findFirst({
            where: {
              userId: billingUserId,
              workspaceId: project.workspaceId,
            },
            select: { id: true },
          })
          if (member) {
            verifiedUserId = billingUserId
          } else {
            console.warn(`[ProjectChat] User ${billingUserId} is not a member of workspace ${project.workspaceId} — ignoring for Composio context`)
          }
        } catch (err: any) {
          console.error(`[ProjectChat] Failed to verify user membership:`, err.message)
        }
      }

      // Open a billing session so the AI proxy accumulates tokens across
      // all API calls in the agentic loop instead of charging per-call.
      // The session is closed in trackUsageFromStream after the stream ends.
      openSession(projectId, project.workspaceId, billingUserId || 'system')

      // Forward headers
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      }

      const { deriveRuntimeToken } = await import('../lib/runtime-token')
      headers["x-runtime-token"] = deriveRuntimeToken(projectId)

      // Copy relevant headers from original request
      const authHeader = c.req.header("Authorization")
      if (authHeader) headers["Authorization"] = authHeader

      const sessionHeader = c.req.header("X-Session-Id")
      if (sessionHeader) headers["X-Session-Id"] = sessionHeader

      // Forward the real user ID so the runtime can include it in AI proxy calls.
      // This bridges the gap when the proxy token only has a generic userId.
      if (billingUserId && billingUserId !== 'system') {
        headers["X-Billing-User-Id"] = billingUserId
      }

      // Forward verified user ID for per-user integrations (e.g. Composio OAuth).
      // Only set after validating workspace membership above.
      if (verifiedUserId) {
        headers["X-User-Id"] = verifiedUserId
      }

      // Retry configuration for transient errors during cold starts.
      // Uses exponential backoff: 500ms, 1s, 2s, 4s, 4s... (capped at 4s)
      // Max 30 retries (~45 seconds total) with explicit 120s fetch timeout
      const MAX_RETRIES = 30
      const BASE_DELAY_MS = 500
      const MAX_DELAY_MS = 4000
      const FETCH_TIMEOUT_MS = 600_000
      let lastError: Error | null = null

      for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
          const response = await fetch(`${podUrl}${chatEndpoint}`, {
            method: "POST",
            headers,
            body,
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
          })

          // Check for errors
          if (!response.ok) {
            const errorText = await response.text()
            console.error(`[ProjectChat] Pod returned error: ${response.status} ${errorText}`)

            // 401/403/404 during warm pool transitions are transient — retry.
            // 404 means the runtime hasn't registered routes yet after assignment.
            const isTransientAuthError = (response.status === 401 || response.status === 403 || response.status === 404) && attempt < MAX_RETRIES

            // Detect permanently broken pods: "RUNTIME_AUTH_SECRET not configured"
            // means the container restarted and lost its assignment. Evict after
            // a grace period to allow self-assign to complete on the pod.
            const isPodMissingAuth = response.status === 401 && errorText.includes('RUNTIME_AUTH_SECRET not configured')
            const EVICT_AFTER_ATTEMPTS = 8

            if (isPodMissingAuth && attempt >= EVICT_AFTER_ATTEMPTS) {
              console.error(`[ProjectChat] Pod for ${projectId} is permanently broken (no auth secret after ${attempt} attempts) — evicting`)
              try {
                const { getWarmPoolController } = await import('../lib/warm-pool-controller')
                const warmPool = getWarmPoolController()
                await warmPool.evictProject(projectId)
                console.log(`[ProjectChat] Evicted broken pod for ${projectId} — next request will get a fresh assignment`)
              } catch (evictErr: any) {
                console.error(`[ProjectChat] Failed to evict broken pod for ${projectId}:`, evictErr.message)
              }
              return c.json(
                { error: { code: "pod_restarted", message: "Your session pod restarted. Please try again — a fresh pod will be assigned automatically." } },
                503 as any
              )
            }

            if (isTransientAuthError) {
              const delay = Math.min(BASE_DELAY_MS * Math.pow(2, attempt - 1), MAX_DELAY_MS)
              console.log(`[ProjectChat] Transient ${response.status} from pod, retrying in ${delay}ms (attempt ${attempt}/${MAX_RETRIES})`)
              await new Promise(resolve => setTimeout(resolve, delay))
              continue
            }

            if (response.status >= 400 && response.status < 500) {
              return c.json(
                { error: { code: "pod_error", message: `Pod error: ${response.status}`, detail: errorText.slice(0, 200) } },
                response.status as any
              )
            }

            // Retry on 5xx errors (server temporarily unavailable)
            if (attempt < MAX_RETRIES) {
              const delay = Math.min(BASE_DELAY_MS * Math.pow(2, attempt - 1), MAX_DELAY_MS)
              console.log(`[ProjectChat] Retrying in ${delay}ms (attempt ${attempt}/${MAX_RETRIES})...`)
              await new Promise(resolve => setTimeout(resolve, delay))
              continue
            }

            return c.json(
              { error: { code: "pod_error", message: `Pod error: ${response.status}` } },
              response.status as any
            )
          }

          // Stream the response back
          // Copy response headers
          const responseHeaders = new Headers()
          response.headers.forEach((value, key) => {
            // Don't copy certain headers
            if (!["content-length", "transfer-encoding", "connection"].includes(key.toLowerCase())) {
              responseHeaders.set(key, value)
            }
          })

          // Add CORS headers
          responseHeaders.set("Access-Control-Allow-Origin", "*")
          responseHeaders.set("Access-Control-Allow-Methods", "POST, OPTIONS")
          responseHeaders.set("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Session-Id")

          // Tee the stream: one for the client, one for usage tracking
          const [clientStream, trackingStream] = response.body!.tee()

          trackUsageFromStream(trackingStream, parsedBody, project).catch((err) =>
            console.error("[ProjectChat] Usage tracking error:", err)
          )

          chatSpan.setAttribute("chat.status", response.status)
          chatSpan.setStatus({ code: SpanStatusCode.OK })
          chatSpan.end()

          return new Response(clientStream, {
            status: response.status,
            headers: responseHeaders,
          })
        } catch (fetchError: any) {
          lastError = fetchError

          // Retry on connection errors (ECONNREFUSED, ECONNRESET, etc.)
          const isTransientError =
            fetchError.code === 'ECONNREFUSED' ||
            fetchError.code === 'ECONNRESET' ||
            fetchError.code === 'ETIMEDOUT' ||
            fetchError.cause?.code === 'ECONNREFUSED' ||
            fetchError.cause?.code === 'ECONNRESET' ||
            fetchError.cause?.code === 'ETIMEDOUT' ||
            fetchError.message?.includes('connection refused') ||
            fetchError.message?.includes('ECONNREFUSED')

          const isAbortError = fetchError.name === 'TimeoutError' || fetchError.name === 'AbortError'

          if ((isTransientError || isAbortError) && attempt < MAX_RETRIES) {
            const delay = Math.min(BASE_DELAY_MS * Math.pow(2, attempt - 1), MAX_DELAY_MS)
            console.log(`[ProjectChat] Connection error, retrying in ${delay}ms (attempt ${attempt}/${MAX_RETRIES}):`, fetchError.message || fetchError.code)
            await new Promise(resolve => setTimeout(resolve, delay))
            continue
          }

          // Non-transient error or max retries reached
          throw fetchError
        }
      }

      // Should not reach here, but handle just in case
      console.error("[ProjectChat] Max retries exceeded:", lastError)
      chatSpan.setStatus({ code: SpanStatusCode.ERROR, message: "max_retries_exceeded" })
      chatSpan.end()
      return c.json(
        { error: { code: "proxy_error", message: lastError?.message || "Max retries exceeded" } },
        503
      )
    } catch (error: any) {
      console.error("[ProjectChat] Proxy error:", error)
      chatSpan.setStatus({ code: SpanStatusCode.ERROR, message: error.message })
      chatSpan.recordException(error)
      chatSpan.end()
      return c.json(
        { error: { code: "proxy_error", message: error.message || "Proxy failed" } },
        500
      )
    }
    }) // end chatTracer.startActiveSpan
  })

  /**
   * POST /projects/:projectId/chat/stop - Stop/interrupt active generation
   * Proxies to the project runtime's /agent/stop endpoint
   */
  router.post("/projects/:projectId/chat/stop", async (c) => {
    const projectId = c.req.param("projectId")
    console.log(`[ProjectChat] Received stop request for project: ${projectId}`)

    try {
      const project = await validateProject(projectId)
      if (!project) {
        return c.json(
          { error: { code: "project_not_found", message: "Project not found" } },
          404
        )
      }

      let podUrl: string
      try {
        podUrl = await getProjectUrl(projectId)
      } catch {
        return c.json({ success: true, message: "No active runtime to stop" })
      }

      const body = await c.req.text()
      const response = await fetch(`${podUrl}/agent/stop`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: body || "{}",
      })

      const result = await response.json()
      return c.json(result)
    } catch (error: any) {
      console.error("[ProjectChat] Stop error:", error)
      return c.json({ success: false, error: error.message }, 500)
    }
  })

  /**
   * POST /projects/:projectId/permission-response - Proxy permission approval to agent runtime
   */
  router.post("/projects/:projectId/permission-response", async (c) => {
    const projectId = c.req.param("projectId")

    try {
      const body = await c.req.text()
      const response = await fetchFromRuntime(projectId, "/agent/permission-response", {
        method: "POST",
        body: body || "{}",
      })

      const result = await response.json()
      return c.json(result)
    } catch (error: any) {
      const isRuntimeDown =
        error.message?.includes("ECONNREFUSED") ||
        error.message?.includes("No runtime manager") ||
        error.message?.includes("not running")
      if (isRuntimeDown) {
        return c.json(
          { error: { code: "runtime_unavailable", message: "No active runtime" } },
          503
        )
      }
      console.error("[ProjectChat] Permission response proxy error:", error)
      return c.json(
        { error: { code: "proxy_error", message: error.message || "Failed to forward permission response" } },
        500
      )
    }
  })

  /**
   * GET /projects/:projectId/chat/status - Check project runtime status
   */
  router.get("/projects/:projectId/chat/status", async (c) => {
    const projectId = c.req.param("projectId")

    try {
      // Validate project exists
      const project = await validateProject(projectId)
      if (!project) {
        return c.json(
          { error: { code: "project_not_found", message: "Project not found" } },
          404
        )
      }

      if (isKubernetes()) {
        // In Kubernetes: Check Knative Service status
        const { getKnativeProjectManager } = await import("../lib/knative-project-manager")
        const manager = getKnativeProjectManager()
        const status = await manager.getStatus(projectId)

        return c.json({
          mode: "kubernetes",
          exists: status.exists,
          ready: status.ready,
          url: status.url,
          replicas: status.replicas,
        })
      } else if (runtimeManager) {
        // Local development: Check RuntimeManager
        const runtime = runtimeManager.status(projectId)

        return c.json({
          mode: "local",
          exists: !!runtime,
          ready: runtime?.status === "running",
          url: runtime?.url || null,
          status: runtime?.status || "stopped",
        })
      } else {
        return c.json({
          mode: "none",
          exists: false,
          ready: false,
          url: null,
          message: "No runtime manager configured",
        })
      }
    } catch (error: any) {
      console.error("[ProjectChat] Status error:", error)
      return c.json(
        { error: { code: "status_error", message: error.message } },
        500
      )
    }
  })

  /**
   * POST /projects/:projectId/chat/wake - Wake up a scaled-to-zero pod
   */
  router.post("/projects/:projectId/chat/wake", async (c) => {
    const projectId = c.req.param("projectId")

    try {
      // Validate project exists
      const project = await validateProject(projectId)
      if (!project) {
        return c.json(
          { error: { code: "project_not_found", message: "Project not found" } },
          404
        )
      }

      // Get or create the project URL (this will create pod if needed)
      const url = await getProjectUrl(projectId)

      // In Kubernetes, wait for pod to be ready
      if (isKubernetes()) {
        const { getKnativeProjectManager } = await import("../lib/knative-project-manager")
        const manager = getKnativeProjectManager()
        await manager.waitForReady(projectId, 60000)
      }

      return c.json({
        success: true,
        url,
        message: "Project runtime is ready",
      })
    } catch (error: any) {
      console.error("[ProjectChat] Wake error:", error)
      return c.json(
        { error: { code: "wake_error", message: error.message } },
        500
      )
    }
  })

  return router
}

export default projectChatRoutes
