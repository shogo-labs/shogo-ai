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
import { getProjectPodUrl } from "../lib/knative-project-manager"
import { prisma } from "../lib/prisma"
import type { IRuntimeManager } from "../lib/runtime"
import { calculateCreditCost, proxyModelToBillingModel } from "../lib/credit-cost"
import * as billingService from "../services/billing.service"

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
  project: { id: string; workspaceId: string }
) {
  const decoder = new TextDecoder()
  const reader = stream.getReader()
  let buffer = ''
  let toolCallCount = 0
  const toolCalls: { toolName: string; args: string }[] = []
  let lastUsage: { promptTokens?: number; completionTokens?: number; totalTokens?: number } | null = null

  // server-side-persistence: Accumulate assistant message content for DB persistence
  let accumulatedText = ''
  const toolCallDetails: { toolCallId: string; toolName: string; input: any }[] = []

  try {
    while (true) {
      const { done, value } = await reader.read()
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

        // server-side-persistence: Accumulate text content from stream
        if (type === 'text-delta' && data.delta) {
          accumulatedText += data.delta
        }

        // Track tool calls
        if (type === 'tool-call-start' || type === 'tool-call') {
          toolCallCount++
          toolCalls.push({
            toolName: data.toolName || data.name || 'unknown',
            args: typeof data.args === 'string' ? data.args : JSON.stringify(data.args || {}),
          })
        }

        // server-side-persistence: Capture finalized tool call details for message parts
        if (type === 'tool-input-available') {
          toolCallDetails.push({
            toolCallId: data.toolCallId || `tool-${Date.now()}`,
            toolName: data.toolName || 'unknown',
            input: data.input || {},
          })
        }

        // Track usage from finish events or dedicated usage events
        if (type === 'finish' || type === 'finish-step' || type === 'usage' || type === 'data-usage') {
          // Custom data-usage event from project-runtime puts data in `data` field
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
              toolCallCount++
              toolCalls.push({
                toolName: tc.toolName || tc.name || 'unknown',
                args: typeof tc.args === 'string' ? tc.args : JSON.stringify(tc.args || {}),
              })
            }
          }
        }
      }
    }
  } finally {
    reader.releaseLock()
  }

  // Extract billing context
  const workspaceId = requestBody?.workspaceId || project.workspaceId
  const userId = requestBody?.userId || 'system'
  const agentMode = requestBody?.agentMode || 'advanced'
  const chatSessionId = requestBody?.ccSessionId || null

  const inputTokens = lastUsage?.promptTokens || 0
  const outputTokens = lastUsage?.completionTokens || 0
  const totalTokens = lastUsage?.totalTokens || (inputTokens + outputTokens)

  console.log(
    `[ProjectChat] 📊 Stream complete — tokens: ${totalTokens} (in: ${inputTokens}, out: ${outputTokens}), tool calls: ${toolCallCount}, agent mode: ${agentMode}`
  )

  // Charge credits if we have token data
  if (totalTokens > 0 && workspaceId) {
    const billingModel = proxyModelToBillingModel(agentMode === 'basic' ? 'haiku' : 'sonnet')
    const creditCost = calculateCreditCost(totalTokens, billingModel)
    const modelUsed = agentMode === 'basic' ? 'haiku' : 'sonnet'

    try {
      const result = await billingService.consumeCredits(
        workspaceId,
        project.id,
        userId,
        'chat_message',
        creditCost,
        {
          inputTokens,
          outputTokens,
          totalTokens,
          agentMode,
          modelUsed,
          toolCallCount,
          ccSessionId: chatSessionId,
        }
      )

      if (result.success) {
        console.log(
          `[ProjectChat] 💰 Charged ${creditCost} credits (${totalTokens} tokens, model: ${modelUsed}) for workspace ${workspaceId} — remaining: ${result.remainingCredits}`
        )
      } else {
        console.warn(`[ProjectChat] ⚠️ Could not charge credits: ${result.error}`)
      }
    } catch (err) {
      console.error("[ProjectChat] Failed to charge credits:", err)
    }
  }

  // Log tool calls to the database
  if (toolCalls.length > 0 && chatSessionId) {
    try {
      // Ensure the chat session exists
      const session = await prisma.chatSession.findUnique({ where: { id: chatSessionId } })
      if (session) {
        await prisma.toolCallLog.createMany({
          data: toolCalls.map((tc) => ({
            chatSessionId,
            toolName: tc.toolName,
            args: tc.args,
            status: 'complete',
            messageId: '',
          })),
        })
        console.log(`[ProjectChat] 🔧 Logged ${toolCalls.length} tool calls for session ${chatSessionId}`)
      }
    } catch (err) {
      console.error("[ProjectChat] Failed to log tool calls:", err)
    }
  }

  // server-side-persistence: Persist assistant message to database
  // This ensures messages survive page refreshes and client disconnects.
  if (chatSessionId && (accumulatedText || toolCallDetails.length > 0)) {
    try {
      const session = await prisma.chatSession.findUnique({ where: { id: chatSessionId } })
      if (session) {
        // Build parts array matching the frontend's expected format
        const parts: any[] = []
        if (accumulatedText) {
          parts.push({ type: 'text', text: accumulatedText })
        }
        for (const tc of toolCallDetails) {
          parts.push({
            type: 'dynamic-tool',
            toolCallId: tc.toolCallId,
            toolName: tc.toolName,
            input: tc.input,
            output: { success: true },
            state: 'output-available',
          })
        }

        await prisma.chatMessage.create({
          data: {
            sessionId: chatSessionId,
            role: 'assistant',
            content: accumulatedText,
            parts: parts.length > 0 ? JSON.stringify(parts) : undefined,
          },
        })
        console.log(`[ProjectChat] 💾 Persisted assistant message (${accumulatedText.length} chars, ${toolCallDetails.length} tool calls) for session ${chatSessionId}`)
      }
    } catch (err) {
      console.error("[ProjectChat] Failed to persist assistant message:", err)
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

      // Use agentPort if available, otherwise calculate from Vite port
      // Agent runs on port = Vite port + 1000 (e.g., 5200 -> 6200)
      const agentPort = runtime.agentPort || (runtime.port + 1000)
      return `http://localhost:${agentPort}`
    } else {
      throw new Error("No runtime manager available for local development")
    }
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

    try {
      // Validate project exists
      const project = await validateProject(projectId)
      if (!project) {
        return c.json(
          { error: { code: "project_not_found", message: "Project not found" } },
          404
        )
      }

      // Pre-check credits before proxying to runtime
      if (!await billingService.hasCredits(project.workspaceId)) {
        return c.json(
          { error: { code: "insufficient_credits", message: "You've run out of credits. Please upgrade your plan to continue." } },
          402
        )
      }

      // Get project pod URL
      // This will create the pod if needed and wait for it to be ready
      let podUrl: string
      try {
        podUrl = await getProjectUrl(projectId)
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

      console.log(`[ProjectChat] Proxying to: ${podUrl}/agent/chat`)

      // Get the request body and parse for billing context
      const body = await c.req.text()
      let parsedBody: any = {}
      try { parsedBody = JSON.parse(body) } catch { /* not JSON, that's fine */ }

      // Forward headers
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      }

      // Copy relevant headers from original request
      const authHeader = c.req.header("Authorization")
      if (authHeader) headers["Authorization"] = authHeader

      const sessionHeader = c.req.header("X-Session-Id")
      if (sessionHeader) headers["X-Session-Id"] = sessionHeader

      // Retry configuration for transient errors during cold starts
      // Uses constant 500ms delay with max 50 retries (up to 25 seconds total)
      const MAX_RETRIES = 50
      const RETRY_DELAY_MS = 500
      let lastError: Error | null = null

      for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
          // Make request to project pod
          const response = await fetch(`${podUrl}/agent/chat`, {
            method: "POST",
            headers,
            body,
          })

          // Check for errors
          if (!response.ok) {
            const errorText = await response.text()
            console.error(`[ProjectChat] Pod returned error: ${response.status} ${errorText}`)

            // Don't retry on client errors (4xx)
            if (response.status >= 400 && response.status < 500) {
              return c.json(
                { error: { code: "pod_error", message: `Pod error: ${response.status}` } },
                response.status as any
              )
            }

            // Retry on 5xx errors (server temporarily unavailable)
            if (attempt < MAX_RETRIES) {
              console.log(`[ProjectChat] Retrying in ${RETRY_DELAY_MS}ms (attempt ${attempt}/${MAX_RETRIES})...`)
              await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS))
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

          // Fire-and-forget: scan the tracking stream for usage data
          trackUsageFromStream(trackingStream, parsedBody, project).catch((err) =>
            console.error("[ProjectChat] Usage tracking error:", err)
          )

          // Return the client stream
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

          if (isTransientError && attempt < MAX_RETRIES) {
            console.log(`[ProjectChat] Connection error, retrying in ${RETRY_DELAY_MS}ms (attempt ${attempt}/${MAX_RETRIES}):`, fetchError.message || fetchError.code)
            await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS))
            continue
          }

          // Non-transient error or max retries reached
          throw fetchError
        }
      }

      // Should not reach here, but handle just in case
      console.error("[ProjectChat] Max retries exceeded:", lastError)
      return c.json(
        { error: { code: "proxy_error", message: lastError?.message || "Max retries exceeded" } },
        503
      )
    } catch (error: any) {
      console.error("[ProjectChat] Proxy error:", error)
      return c.json(
        { error: { code: "proxy_error", message: error.message || "Proxy failed" } },
        500
      )
    }
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
