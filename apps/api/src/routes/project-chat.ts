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
import { getModelTier, resolveModelId } from "@shogo/model-catalog"
import { stampModelProvider } from "../lib/stamp-model-provider"
import * as checkpointService from "../services/checkpoint.service"
import { isGitAvailable } from "../services/git.service"
import { setProjectUser } from "../lib/project-user-context"
import { openSession, closeSession, setQualitySignals } from "../lib/proxy-billing-session"
import { enrichWorkspaceReferences, enrichProjectReferences } from "../lib/chat-references"

const chatTracer = trace.getTracer("shogo-api-chat")

// Environment detection
const isKubernetes = () => !!process.env.KUBERNETES_SERVICE_HOST
const isVMIsolation = () => process.env.SHOGO_VM_ISOLATION === 'true'

// =============================================================================
// Configuration
// =============================================================================

export interface ProjectChatRoutesConfig {
  /**
   * Local runtime manager (used in non-K8s environments).
   */
  runtimeManager?: IRuntimeManager
}

const PROJECT_ROOT = resolve(import.meta.dir, '../../../..')
const WORKSPACES_DIR = process.env.WORKSPACES_DIR || resolve(PROJECT_ROOT, 'workspaces')

export const FILE_MODIFYING_TOOLS = new Set([
  'write_file', 'edit_file', 'delete_file',
  'exec', 'generate_image',
  'connect',
  // Legacy names retained so historical tool calls in checkpoints continue to flag
  'tool_install', 'mcp_install',
])

export function hasFileModifyingTools(toolCallMap: Map<string, { toolName: string }>): boolean {
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
 * The Vercel AI SDK UI protocol uses newline-delimited messages. Key prefixes:
 *   e: (finish)  — JSON with usage { promptTokens, completionTokens }
 *   9: (tool_call) — tool invocations
 *   d: (finish_message/finish_step) — JSON with usage
 *
 * We consume the entire tracking stream, count tool calls, and extract the
 * final usage object. Then we charge marked-up USD via the billing service
 * and log a `ToolCallLog` entry per tool call.
 *
 * EOF-without-turn-complete handling:
 *   The runtime emits `data-turn-complete` exactly once at the tail of every
 *   turn it brings to a terminal state — including `status: 'aborted'` when
 *   the user clicked Stop. If our reader EOFs before seeing that marker, the
 *   API↔runtime body was cut while the agent was still working.
 *   Two real triggers now:
 *     1. Knative activator's 5-min request timeout, or pod restart mid-turn
 *        — the runtime's `streamBufferStore` is still alive and growing.
 *     2. The pod itself died (crash, OOM) — buffer is gone with the process.
 *   We try server-side auto-resume against `/agent/chat/:id/stream?fromSeq=0`
 *   to drain the rest of the turn from the runtime's buffer when it's still
 *   alive (case 1). If the resume returns 204 / errors (case 2), we fall
 *   back to persisting whatever was accumulated when the original cut hit,
 *   so the user's truncated turn still lands in DB.
 *
 *   User-initiated Stop is no longer a 204 case — `/agent/stop` only flips
 *   the abort signal; the buffer is closed naturally once the agent loop's
 *   wind-down emits `data-usage` and `data-turn-complete{status:'aborted'}`,
 *   so we observe a real terminal frame and bill the partial usage.
 */
export async function trackUsageFromStream(
  stream: ReadableStream<Uint8Array>,
  requestBody: any,
  project: { id: string; workspaceId: string },
  options: {
    /**
     * Reconnect to the runtime's stream buffer for `fromSeq=N`. Returns null
     * (or a non-200 Response) if the buffer is gone — caller falls back to
     * partial persistence in that case. Wired by the route handler via
     * `fetchFromRuntime` so the request hits the same pod that owns the
     * buffer.
     */
    resume?: (fromSeq: number) => Promise<Response | null>
    /**
     * Resolved chat-session id from the route handler. Takes precedence
     * over `requestBody.chatSessionId`. When the route handler reads
     * `X-Chat-Session-Id` from the request headers, it must pass that
     * value here so persistence and closeSession key on the same id
     * the billing session was opened under — otherwise the billing
     * bucket leaks and the assistant row lands in (or is dropped from)
     * the wrong session. See project-chat-session-id-split.test.ts.
     */
    chatSessionId?: string | null
  } = {},
) {
  const decoder = new TextDecoder()
  type UsageSnapshot = { promptTokens?: number; completionTokens?: number; totalTokens?: number }
  const usageRef: { value: UsageSnapshot | null } = { value: null }

  // Accumulate tool call data incrementally as stream events arrive.
  // Keyed by toolCallId so args, result, and duration are captured correctly.
  interface ToolCallRecord {
    toolCallId: string
    toolName: string
    args: any
    result: any
    startedAt: number
    duration: number | null
    /** Set when the runtime reports the tool errored, so we persist status='error'. */
    error?: boolean
  }
  let toolCallMap = new Map<string, ToolCallRecord>()

  // server-side-persistence: Accumulate ordered parts for DB persistence.
  // We maintain the natural interleaving of text and tool calls so that
  // on page refresh the parts array faithfully reproduces the original order.
  let accumulatedText = ''
  let orderedParts: any[] = []
  // Index into orderedParts by toolCallId so we can back-fill output later
  let toolPartIndex = new Map<string, any>()
  let currentTextPart: { type: 'text'; text: string } | null = null
  let currentReasoningPart: { type: 'reasoning'; text: string; durationMs?: number } | null = null
  let reasoningStartedAt: number | null = null
  // True iff the original POST stream errored (chunk read threw / idle
  // timeout fired) before any clean EOF. Used to gate auto-checkpoint —
  // a hard read error means file edits the agent reported may not have
  // actually persisted.
  let originalStreamErrored = false
  // True iff we observed the runtime's terminal `data-turn-complete` SSE
  // frame. Used to decide whether to attempt auto-resume after EOF.
  let observedTurnComplete = false
  let turnCompleteStatus: 'completed' | 'failed' | null = null
  let qualitySignals: {
    success?: boolean
    hitMaxTurns?: boolean
    loopDetected?: boolean
    escalated?: boolean
    responseEmpty?: boolean
  } = {}
  // Highest seq the runtime has reported via `data-turn-seq` heartbeats.
  // Currently we resume with fromSeq=0 (full replay) for simplicity, but
  // we keep this around for diagnostics and for future delta-resume.
  let lastObservedSeq = 0

  const PER_CHUNK_IDLE_TIMEOUT_MS = parseInt(process.env.CHAT_STREAM_IDLE_TIMEOUT_MS || '3600000', 10)

  /**
   * Reset all turn-scoped accumulators. Used before re-consuming a full
   * replay from the runtime's buffer so a successful resume produces a
   * coherent, non-duplicated message instead of appending replayed
   * text-deltas onto the partial we already had.
   */
  function resetAccumulatedState() {
    toolCallMap = new Map()
    orderedParts = []
    toolPartIndex = new Map()
    accumulatedText = ''
    currentTextPart = null
    currentReasoningPart = null
    reasoningStartedAt = null
    observedTurnComplete = false
    turnCompleteStatus = null
    usageRef.value = null
    qualitySignals = {}
  }

  /**
   * Partial reset on an inference retry. The runtime re-issued a model call
   * that dropped mid-generation, so the failed step's partial text/reasoning
   * (and any partially-streamed tool input that never executed) must be
   * discarded — otherwise the regenerated output gets concatenated onto the
   * thrown-away partial in the persisted ChatMessage. Earlier COMPLETED steps
   * (assistant text + executed tool calls) are preserved: pi-agent-core runs
   * tools only after a complete assistant message, so a failed step never
   * produced a `tool-input-available` part.
   */
  function resetCurrentStepPartials() {
    if (currentReasoningPart) {
      const idx = orderedParts.lastIndexOf(currentReasoningPart)
      if (idx >= 0) orderedParts.splice(idx, 1)
      currentReasoningPart = null
      reasoningStartedAt = null
    }
    if (currentTextPart) {
      const idx = orderedParts.lastIndexOf(currentTextPart)
      if (idx >= 0) orderedParts.splice(idx, 1)
      currentTextPart = null
    }
    // Drop any partially-streamed tool calls from the failed step. A completed
    // tool from an earlier step reached `tool-input-available` and so has an
    // entry in `toolPartIndex`; a failed step's tool only ever got a
    // `tool-input-start` (toolCallMap only) and never executed.
    for (const id of [...toolCallMap.keys()]) {
      if (!toolPartIndex.has(id)) toolCallMap.delete(id)
    }
    // Recompute the flattened text from the surviving ordered text parts so
    // `content` reflects only completed output.
    accumulatedText = orderedParts
      .filter((p) => p.type === 'text')
      .map((p) => p.text)
      .join('')
  }

  /**
   * Process one SSE line (already \n-split). Updates the closure-scoped
   * accumulator state in place. Tolerant of legacy (`9:`, `e:`, `d:`)
   * data-stream prefixes alongside the modern `data: {json}` SSE format.
   */
  function processLine(line: string) {
    if (!line.trim()) return

    // The project runtime uses toUIMessageStreamResponse() which produces
    // Server-Sent Events (SSE) format: "data: {json}\n\n"
    let payload = line
    if (line.startsWith('data: ')) {
      payload = line.slice(6)
    } else if (line.startsWith('data:')) {
      payload = line.slice(5)
    }

    if (payload === '[DONE]' || line.startsWith('event:') || line.startsWith('id:') || line.startsWith('retry:')) {
      return
    }

    let data: any
    try {
      data = JSON.parse(payload)
    } catch {
      const prefix = line.slice(0, 2)
      if (prefix === '9:' || prefix === 'e:' || prefix === 'd:') {
        try { data = JSON.parse(line.slice(2)) } catch { return }
        if (prefix === '9:' && !data.type) data.type = 'tool-call'
        if ((prefix === 'e:' || prefix === 'd:') && !data.type) data.type = 'finish'
      } else {
        return
      }
    }

    if (!data || typeof data !== 'object') return

    const type = data.type

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

    if (type === 'text-delta' && data.delta) {
      currentReasoningPart = null
      accumulatedText += data.delta
      if (!currentTextPart) {
        currentTextPart = { type: 'text', text: '' }
        orderedParts.push(currentTextPart)
      }
      currentTextPart.text += data.delta
    }

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
      // NOTE: do NOT set `output` here. Some tools (notably `ask_user`)
      // intentionally never emit `tool-output-available`; baking
      // `output: null` + `state: 'output-available'` into the persisted
      // part makes the widget render as already-answered after a cold
      // hydration, since `null !== undefined`.
      const part: {
        type: 'dynamic-tool'
        toolCallId: string
        toolName: string
        input: any
        state: string
        output?: any
      } = {
        type: 'dynamic-tool',
        toolCallId,
        toolName: data.toolName || toolCallMap.get(toolCallId)?.toolName || 'unknown',
        input: data.input || {},
        state: 'input-available',
      }
      orderedParts.push(part)
      toolPartIndex.set(toolCallId, part)
    }

    if (type === 'tool-output-available') {
      const toolCallId = data.toolCallId || ''
      const record = toolCallMap.get(toolCallId)
      if (record) {
        record.result = data.output ?? null
        record.duration = Date.now() - record.startedAt
        // Detect failure markers in the output so we can persist status='error'.
        const out: any = data.output
        if (
          out &&
          typeof out === 'object' &&
          (out.success === false || out.isError === true || out.error != null)
        ) {
          record.error = true
        }
      }
      const part = toolPartIndex.get(toolCallId)
      if (part) {
        part.output = data.output ?? { success: true }
        part.state = 'output-available'
      }
    }

    if (type === 'tool-output-error') {
      const toolCallId = data.toolCallId || ''
      const record = toolCallMap.get(toolCallId)
      if (record) {
        record.error = true
        record.result = { error: data.errorText ?? data.error ?? 'tool error' }
        record.duration = Date.now() - record.startedAt
      }
      const part = toolPartIndex.get(toolCallId)
      if (part) {
        part.output = { error: data.errorText ?? data.error ?? 'tool error' }
        part.state = 'output-error'
      }
    }

    // The runtime emits `data-inference-retry` when it re-issues a model call
    // that dropped mid-generation. Discard the failed step's partial output so
    // the persisted message holds the final retried output, not a concatenation.
    if (type === 'data-inference-retry') {
      resetCurrentStepPartials()
      return
    }

    // The runtime writes `data-turn-complete` exactly once at the tail
    // of every successfully-streamed turn (including failed turns it
    // caught and reported). Its presence confirms the agent reached a
    // terminal state; its absence on EOF identifies an upstream cut
    // (activator timeout, pod restart, network drop, stop button).
    if (type === 'data-turn-complete') {
      observedTurnComplete = true
      const status = data?.data?.status
      if (status === 'completed' || status === 'failed') {
        turnCompleteStatus = status
      }
    }

    // Heartbeat the runtime emits every ~250ms with the buffer's lastSeq.
    // Lets us know how far the buffer has progressed for resume diagnostics.
    if (type === 'data-turn-seq') {
      const seq = data?.data?.seq
      if (typeof seq === 'number' && seq > lastObservedSeq) {
        lastObservedSeq = seq
      }
    }

    if (type === 'finish' || type === 'finish-step' || type === 'usage' || type === 'data-usage') {
      const usageData = data.usage || data.data
      if (usageData && (usageData.inputTokens || usageData.outputTokens || usageData.promptTokens || usageData.completionTokens || usageData.totalTokens)) {
        usageRef.value = {
          // Support both v5 (promptTokens) and v6 (inputTokens) naming
          promptTokens: usageData.promptTokens || usageData.inputTokens || 0,
          completionTokens: usageData.completionTokens || usageData.outputTokens || 0,
          totalTokens: usageData.totalTokens || ((usageData.promptTokens || usageData.inputTokens || 0) + (usageData.completionTokens || usageData.outputTokens || 0)),
        }
        qualitySignals = {
          success: usageData.success === undefined ? undefined : usageData.success === true,
          hitMaxTurns: usageData.hitMaxTurns === true,
          loopDetected: usageData.loopDetected === true,
          escalated: usageData.escalated === true,
          responseEmpty: usageData.responseEmpty === true,
        }
      }
      if (data.promptTokens || data.completionTokens || data.inputTokens || data.outputTokens) {
        usageRef.value = {
          promptTokens: data.promptTokens || data.inputTokens || 0,
          completionTokens: data.completionTokens || data.outputTokens || 0,
          totalTokens: data.totalTokens || ((data.promptTokens || data.inputTokens || 0) + (data.completionTokens || data.outputTokens || 0)),
        }
        qualitySignals = {
          success: data.success === undefined ? undefined : data.success === true,
          hitMaxTurns: data.hitMaxTurns === true,
          loopDetected: data.loopDetected === true,
          escalated: data.escalated === true,
          responseEmpty: data.responseEmpty === true,
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

  /**
   * Drain a reader to EOF, parsing SSE frames into the closure-scoped
   * accumulators. Returns true on clean EOF; false if a chunk read threw
   * or the per-chunk idle timeout fired.
   */
  async function consumeStream(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<boolean> {
    let buffer = ''
    try {
      while (true) {
        let idleTimer: ReturnType<typeof setTimeout> | undefined
        const idleTimeout = new Promise<{ done: true; value: undefined }>((_, reject) => {
          idleTimer = setTimeout(() => reject(new Error('chunk idle timeout')), PER_CHUNK_IDLE_TIMEOUT_MS)
        })
        let result: { done: boolean; value: Uint8Array | undefined }
        try {
          result = await Promise.race([reader.read(), idleTimeout]) as any
        } finally {
          clearTimeout(idleTimer)
        }
        const { done, value } = result!
        if (done) break
        buffer += decoder.decode(value, { stream: true })

        const lines = buffer.split('\n')
        buffer = lines.pop() || ''

        for (const line of lines) {
          processLine(line)
        }
      }
      return true
    } catch (streamErr: any) {
      console.warn(`[ProjectChat] Stream interrupted (${streamErr.code || streamErr.message}), persisting ${accumulatedText.length} chars accumulated so far`)
      return false
    } finally {
      try { reader.releaseLock() } catch { /* already released */ }
    }
  }

  // First pass: consume the original tee'd tracking stream.
  const firstOk = await consumeStream(stream.getReader())
  if (!firstOk) originalStreamErrored = true

  // Extract context. The route handler resolves chatSessionId from
  // `X-Chat-Session-Id` header OR `requestBody.chatSessionId` and passes
  // the resolved value via `options.chatSessionId`; we treat that as
  // authoritative so billing (open/close) and persistence agree. The
  // `requestBody.chatSessionId` fallback exists for older callers that
  // don't yet thread the option through.
  const chatSessionId = options.chatSessionId ?? requestBody?.chatSessionId ?? null
  const agentMode = requestBody?.agentMode || 'advanced'

  // Auto-resume drive: when the original stream EOF'd cleanly but the runtime
  // never emitted `data-turn-complete`, the upstream proxy cut us off mid-turn.
  // The runtime keeps appending to its `streamBufferStore` independent of the
  // HTTP connection, so we reconnect via `/agent/chat/:id/stream?fromSeq=0`
  // and drain the full turn from the buffer. We use fromSeq=0 (full replay)
  // rather than fromSeq=lastObservedSeq because the seq the heartbeat reports
  // lags the actual chunks, and a full reset+replay avoids any text-delta
  // duplication. If the buffer is gone (stop button or pod crash → 204), or
  // the resume itself errors, we fall through to persisting whatever the
  // original stream gave us.
  let resumeOutcome: 'not-attempted' | 'recovered' | 'buffer-gone' | 'failed' = 'not-attempted'
  const eofWithoutTurnComplete = !originalStreamErrored && !observedTurnComplete

  if (eofWithoutTurnComplete && chatSessionId && options.resume) {
    console.log(
      `[ProjectChat] EOF without turn-complete for session ${chatSessionId} (lastObservedSeq=${lastObservedSeq}) — server-side resume from buffer`
    )
    let resumeRes: Response | null = null
    try {
      resumeRes = await options.resume(0)
    } catch (err: any) {
      resumeOutcome = 'failed'
      console.warn(`[ProjectChat] Resume fetch threw: ${err?.message || err}`)
    }

    if (resumeRes) {
      if (resumeRes.status === 200 && resumeRes.body) {
        // Reset state — we're going to re-consume the entire turn from the
        // buffer's full replay, so any text/tool data we accumulated from
        // the original stream needs to be cleared to avoid duplication.
        resetAccumulatedState()
        const resumeOk = await consumeStream(resumeRes.body.getReader())
        if (observedTurnComplete) {
          resumeOutcome = 'recovered'
        } else {
          resumeOutcome = 'failed'
          console.warn(
            `[ProjectChat] Resume drained without seeing data-turn-complete (resumeOk=${resumeOk}) — persisting whatever was replayed`
          )
        }
      } else if (resumeRes.status === 204) {
        // Buffer aborted (stop button), expired, or pod restarted between
        // the original cut and our resume. Keep the partial we have.
        resumeOutcome = 'buffer-gone'
        console.log(
          `[ProjectChat] Resume returned 204 for session ${chatSessionId} — persisting partial (likely stop button or pod crash)`
        )
      } else {
        resumeOutcome = 'failed'
        console.warn(
          `[ProjectChat] Resume returned unexpected status ${resumeRes.status} — persisting partial`
        )
        try { resumeRes.body?.cancel() } catch { /* noop */ }
      }
    }
  }

  const inputTokens = usageRef.value?.promptTokens || 0
  const outputTokens = usageRef.value?.completionTokens || 0
  const totalTokens = usageRef.value?.totalTokens || (inputTokens + outputTokens)
  const toolCallCount = toolCallMap.size

  let streamOutcome: string
  if (observedTurnComplete) {
    streamOutcome = resumeOutcome === 'recovered'
      ? `complete via resume (status=${turnCompleteStatus ?? 'unknown'})`
      : `complete (status=${turnCompleteStatus ?? 'unknown'})`
  } else if (originalStreamErrored) {
    streamOutcome = 'interrupted'
  } else if (resumeOutcome === 'buffer-gone') {
    streamOutcome = 'partial (stop-or-crash)'
  } else if (resumeOutcome === 'failed') {
    streamOutcome = 'partial (resume-failed)'
  } else if (resumeOutcome === 'not-attempted') {
    streamOutcome = 'partial (no-resume-hook)'
  } else {
    streamOutcome = 'partial'
  }

  console.log(
    `[ProjectChat] 📊 Stream ${streamOutcome} — tokens: ${totalTokens} (in: ${inputTokens}, out: ${outputTokens}), tool calls: ${toolCallCount}, agent mode: ${agentMode}`
  )

  // Always close the billing session and charge what the AI proxy already
  // counted in this session. When auto-resume succeeds, the resumed stream's
  // continued AI proxy calls have accumulated into the same session before
  // we close it, so the full turn bills correctly. When it returns 204 (stop
  // button), we charge what the user actually consumed up to the cut.
  //
  // Set quality signals BEFORE closing the session so they reach
  // recordAgentCostMetric inside closeSession (closeSession deletes the
  // session before reading quality, so a post-close set would be a no-op).
  setQualitySignals(project.id, qualitySignals, chatSessionId)
  const { billedUsd } = await closeSession(project.id, {
    discardPartial: false,
    chatSessionId,
  })
  if (billedUsd > 0) {
    console.log(`[ProjectChat] 💰 Billing session closed — charged $${billedUsd.toFixed(4)} for project ${project.id}`)
  }

  // Persist whatever we accumulated. Partial rows are fine: the agent's
  // next-turn context comes from the runtime's in-memory SessionManager
  // (and its on-disk persistence), NOT from this `ChatMessage` table, so
  // a truncated row only affects what the user sees on page reload — and
  // that should be what they actually saw.
  let assistantMessageId: string | null = null
  if (chatSessionId && (accumulatedText || toolCallMap.size > 0)) {
    try {
      const session = await prisma.chatSession.findUnique({ where: { id: chatSessionId } })
      if (session) {
        const parts = orderedParts.filter(
          (p) => !((p.type === 'text' || p.type === 'reasoning') && (!p.text || !p.text.trim()))
        )

        const message = await prisma.chatMessage.create({
          data: {
            sessionId: chatSessionId,
            role: 'assistant',
            content: accumulatedText,
            parts: parts.length > 0 ? JSON.stringify(parts) : undefined,
            agent: 'technical',
          },
        })
        assistantMessageId = message.id
        const partialTag = observedTurnComplete ? '' : ', partial'
        console.log(
          `[ProjectChat] 💾 Persisted assistant message (${accumulatedText.length} chars, ${toolCallCount} tool calls${partialTag}) for session ${chatSessionId}`
        )

        const now = new Date()
        // Bump the session's lastActiveAt so the chat history sidebar
        // buckets reflect the most recent message rather than the
        // session's creation time. The user-message path goes through
        // the chatMessageHooks afterCreate hook; this stream path
        // bypasses that hook (it persists assistant messages directly),
        // so we mirror the bump here.
        prisma.chatSession.update({
          where: { id: chatSessionId },
          data: { lastActiveAt: now, updatedAt: now },
        }).catch(() => {})

        prisma.project.update({
          where: { id: project.id },
          data: { lastMessageAt: now },
        }).catch(() => {})
      }
    } catch (err) {
      console.error("[ProjectChat] Failed to persist assistant message:", err)
    }
  }

  // Log tool calls with real args, results, duration, and the correct messageId.
  // We log in the partial case too so debugging shows what the user actually saw.
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
            status: tc.error ? ('error' as const) : ('complete' as const),
          })),
        })
        console.log(`[ProjectChat] 🔧 Logged ${toolCallMap.size} tool calls for session ${chatSessionId}`)
      }
    } catch (err) {
      console.error("[ProjectChat] Failed to log tool calls:", err)
    }
  }

  // Auto-checkpoint: create a git snapshot when the agent modified files.
  // Only checkpoint on a fully-completed turn — partials may have left the
  // workspace in an inconsistent state if the agent was killed mid file-edit.
  // In Kubernetes the workspace lives on the agent pod, not on the API pod,
  // so the local path doesn't exist. Skip silently instead of logging a
  // warning on every streamed response.
  //
  // External (VS Code-style) projects: NEVER auto-commit. The "workspace"
  // is the user's own repo, and writing `AI: edit_file (3 tool calls)`
  // commits into their branch is the cardinal sin every IDE-style tool
  // explicitly avoids. External users keep their own git workflow; the
  // CheckpointsPanel renders a "use your own git" banner instead.
  // SHOGO_CLOUD_SYNC=1 indicates a paired worker (cli_worker) is the source
  // of truth for this project's git history — its watcher pushes commits
  // through /api/projects/:id/git/git-receive-pack, and the post-receive
  // hook in routes/git-http.ts inserts ProjectCheckpoint rows. Skip the
  // chat-turn auto-checkpoint to avoid a second row with the same SHA.
  const workerOwnsSync =
    process.env.SHOGO_CLOUD_SYNC === '1' || process.env.SHOGO_CLOUD_SYNC === 'true'
  // BETA: per-chat git worktrees. When on, the agent's edits live on the
  // chat's branch in an isolated worktree (committed + persisted runtime-side),
  // not in the main working tree. The project-scoped checkpoint here would
  // either no-op or capture unrelated main state, so skip it entirely.
  let worktreesEnabled = false
  try {
    const p = await prisma.project.findUnique({ where: { id: project.id }, select: { settings: true } as any }) as { settings?: unknown } | null
    const raw = p?.settings
    const settings = typeof raw === 'string' ? (() => { try { return JSON.parse(raw) } catch { return null } })() : raw
    worktreesEnabled = !!(settings && typeof settings === 'object' && (settings as Record<string, unknown>).gitWorktreesEnabled === true)
  } catch { /* default false */ }
  if (
    !workerOwnsSync &&
    !worktreesEnabled &&
    hasFileModifyingTools(toolCallMap) &&
    observedTurnComplete &&
    !originalStreamErrored &&
    isGitAvailable() &&
    (project as { workingMode?: string }).workingMode !== 'external'
  ) {
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
    if (!isKubernetes() && !isVMIsolation() && !runtimeManager) {
      throw new Error("No runtime manager available for local development")
    }

    // Special-case: host runtime in 'starting' state. resolveProjectPodUrl
    // would call manager.start() (which deduplicates concurrent starts
    // and waits), but in the chat path we'd rather block via
    // waitForRuntimeReady so progress logs land in the right log
    // file. Punch through here only when host mode is in flight.
    if (runtimeManager && !isKubernetes() && !isVMIsolation()) {
      const existing = runtimeManager.status(projectId)
      if (existing?.status === 'starting') {
        console.log(`[ProjectChat] Runtime for ${projectId} is starting, waiting...`)
        await waitForRuntimeReady(projectId)
      }
    }

    const { resolveProjectPodUrl } = await import("../lib/resolve-pod-url")
    const res = await resolveProjectPodUrl(projectId, {
      logTag: 'ProjectChat',
      // Chat traffic must keep flowing if the warm pool gives up
      // entirely — without fallback the user is permanently stuck.
      onVMPermanentlyDisabled: 'fallback-to-host',
      // Preserves the historical 5×3s retry loop for transient
      // warm-pool boot failures.
      maxVMRetries: 5,
      vmRetryDelayMs: 3000,
      runtimeManager: runtimeManager ?? undefined,
    })
    return res.url
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
    const { deriveProjectRuntimeToken } = await import("../lib/project-runtime-token")
    const headers = new Headers(init?.headers)
    if (!headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json")
    }
    headers.set("x-runtime-token", await deriveProjectRuntimeToken(projectId))
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

      if (!await billingService.hasBalance(project.workspaceId)) {
        chatSpan.setAttribute("error.type", "usage_limit_reached")
        chatSpan.end()
        return c.json(
          { error: { code: "usage_limit_reached", message: "You've reached your usage limit. Enable usage-based pricing or upgrade your plan to continue." } },
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

      // Enforce model tier for free/basic-plan workspaces (server-side guard)
      if (parsedBody.agentMode) {
        const resolved = resolveModelId(parsedBody.agentMode)
        const tier = getModelTier(resolved)
        if (tier !== 'economy') {
          const hasAdvanced = await billingService.hasAdvancedModelAccess(project.workspaceId)
          if (!hasAdvanced) {
            parsedBody.agentMode = 'claude-haiku-4-5-20251001'
          }
        }
        // Resolve the model's native provider from the registry and stamp it on
        // the forwarded body. Runs after any tier-downgrade so the provider
        // reflects the model that will actually run. Lets a UUID-addressed DB
        // model route to its native provider instead of being inferred as
        // `custom` by the runtime.
        stampModelProvider(parsedBody)
        body = JSON.stringify(parsedBody)
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

      // Harden "@" references before forwarding. Workspace refs get an
      // authoritative DB summary; project refs are access-checked + normalized.
      // File references pass through untouched (resolved by the runtime on
      // disk). NOTE: a per-project runtime is single-root, so referenced
      // sibling projects are NOT mounted here — the runtime reports them as
      // unavailable. Cross-project file context lands on the merged-root
      // workspace runtime (workspace-chat path).
      if (Array.isArray(parsedBody?.references) && parsedBody.references.length > 0) {
        const wsChanged = await enrichWorkspaceReferences(parsedBody, verifiedUserId)
        const projectRefs = await enrichProjectReferences(
          parsedBody,
          verifiedUserId,
          project.workspaceId,
        )
        if (wsChanged || projectRefs.changed) {
          body = JSON.stringify(parsedBody)
        }
      }

      // Extract the chat-session id up-front so the billing session can be
      // keyed by `(projectId, chatSessionId)`. The id is on the request
      // body (`parsedBody.chatSessionId`) for follow-up turns and on the
      // `X-Chat-Session-Id` header when the client opts to send it there
      // (e.g. wrapping fetchers that don't see the body). Either source
      // works; prefer the header so the body field stays as documentation
      // only.
      const incomingChatSessionId: string | null =
        c.req.header('X-Chat-Session-Id') || parsedBody?.chatSessionId || null

      // chatSessionId is REQUIRED. The runtime keys its in-memory
      // SessionManager by this id; an absent/empty value used to fall
      // through to a literal `'chat'` bucket inside the runtime
      // (server.ts and gateway.ts both had `|| 'chat'`), which silently
      // glommed every no-id turn from any caller into a single shared
      // conversation history per project pod. Reject at the edge so the
      // leak can never reach the runtime, and so the billing session
      // below is always opened with a real key. Mirrors the same guard
      // already present on the voice routes.
      if (!incomingChatSessionId || typeof incomingChatSessionId !== 'string' || incomingChatSessionId.trim() === '') {
        chatSpan.setStatus({ code: SpanStatusCode.ERROR, message: "chat_session_id_required" })
        chatSpan.end()
        return c.json(
          {
            error: {
              code: "chat_session_id_required",
              message: "chatSessionId is required — send it as the X-Chat-Session-Id header or as `chatSessionId` in the JSON body",
            },
          },
          400
        )
      }

      // Open a billing session so the AI proxy accumulates tokens across
      // all API calls in the agentic loop instead of charging per-call.
      // The session is closed in trackUsageFromStream after the stream ends.
      // Guard: if the handler exits without starting a stream (retry
      // exhaustion, client disconnect, thrown error), the finally block
      // ensures closeSession runs so we don't leak an open session.
      openSession(projectId, project.workspaceId, billingUserId || 'system', incomingChatSessionId)
      let billingSessionHandedOff = false
      try {

      // Forward headers
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      }

      const { deriveProjectRuntimeToken } = await import('../lib/project-runtime-token')
      headers["x-runtime-token"] = await deriveProjectRuntimeToken(projectId, { workspaceId: project.workspaceId })

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

      // Forward the chat-session id so the runtime can stamp it on its
      // outbound ai-proxy calls. Without this, accumulateUsage on the AI
      // proxy side falls back to the legacy projectId-only key and
      // collides with concurrent turns from other chat sessions.
      if (incomingChatSessionId) {
        headers["X-Chat-Session-Id"] = incomingChatSessionId
      }

      // Retry configuration for transient errors during cold starts.
      // Uses exponential backoff: 500ms, 1s, 2s, 4s, 4s... (capped at 4s)
      // Max 30 retries (~45 seconds total) with an explicit long-turn fetch timeout.
      const MAX_RETRIES = 30
      const BASE_DELAY_MS = 500
      const MAX_DELAY_MS = 4000
      const FETCH_TIMEOUT_MS = parseInt(process.env.CHAT_UPSTREAM_FETCH_TIMEOUT_MS || '14400000', 10)
      let lastError: Error | null = null
      let consecutiveConnectionErrors = 0
      // Threshold for forcing a runtime restart when the same URL keeps
      // refusing connections (likely the runtime process died but the
      // RuntimeManager hasn't observed it yet via health checks).
      const FORCE_RUNTIME_RESTART_AFTER = 3

      // Do NOT include clientSignal in fetchSignal. A client disconnect
      // (e.g. page refresh) must NOT abort the upstream fetch — the runtime
      // keeps the agent running in memory so the client can resume the stream.
      // trackUsageFromStream also needs the full stream for billing/persistence.
      const clientSignal = c.req.raw.signal
      const fetchSignal = AbortSignal.timeout(FETCH_TIMEOUT_MS)

      for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        // Check if client already disconnected before retrying
        if (clientSignal?.aborted) {
          console.log(`[ProjectChat] Client disconnected before attempt ${attempt}, stopping retries`)
          chatSpan.setStatus({ code: SpanStatusCode.OK, message: "client_disconnected" })
          chatSpan.end()
          return new Response(null, { status: 499 })
        }

        try {
          const response = await fetch(`${podUrl}${chatEndpoint}`, {
            method: "POST",
            headers,
            body,
            signal: fetchSignal,
          })

          // The TCP connection succeeded — reset the connection-error
          // streak even if the runtime returns a non-2xx status code.
          consecutiveConnectionErrors = 0

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
            // Threshold is intentionally higher than other callers because the
            // chat path sees transient 401s during normal warm-pool transitions.
            const EVICT_AFTER_ATTEMPTS = 8
            const { evictIfPodMissingAuth } = await import('../lib/warm-pool-self-heal')
            const evicted = await evictIfPodMissingAuth(
              projectId,
              response.status,
              errorText,
              attempt,
              EVICT_AFTER_ATTEMPTS,
            )
            if (evicted) {
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
          // Expose turn-ledger headers so the browser can read them
          // (cross-origin response headers default to hidden in fetch).
          responseHeaders.set(
            "Access-Control-Expose-Headers",
            "X-Turn-Id, X-Chat-Session-Id, X-Last-Seq, X-Turn-Status",
          )

          // Instead of tee() (which stops pulling when the client
          // branch is cancelled on browser disconnect), we read the
          // fetch body in a background loop and independently push
          // chunks to both the client stream and usage tracking.
          // This ensures billing/persistence always sees the full
          // stream even if the browser drops the connection early.
          //
          // Tracking side uses a consumer-pull queue (plain JS array,
          // no backpressure against the shared upstream bgReader) to
          // avoid cross-stream coupling that can cause the client SSE
          // stream to terminate prematurely on long agent turns.
          //
          // Bun quirk defense: the tracking stream's pull() loops
          // internally on a notification Promise instead of relying on
          // the runtime to re-invoke pull() after a returned Promise
          // resolves (Bun has historically mis-handled that path and
          // left the tracking consumer hung). A cancel() handler also
          // unblocks pull() if the consumer goes away.
          const bgReader = response.body!.getReader()
          const trackingChunks: Uint8Array[] = []
          let trackingDone = false
          let trackingNotify: (() => void) | null = null
          const trackingWait = () =>
            new Promise<void>((resolve) => { trackingNotify = resolve })
          const trackingStream = new ReadableStream<Uint8Array>({
            async pull(controller) {
              while (trackingChunks.length === 0 && !trackingDone) {
                await trackingWait()
              }
              if (trackingChunks.length > 0) {
                controller.enqueue(trackingChunks.shift()!)
                return
              }
              controller.close()
            },
            cancel() {
              trackingDone = true
              trackingNotify?.()
              trackingNotify = null
            },
          })

          let clientEnqueueErrors = 0
          const clientStream = new ReadableStream<Uint8Array>({
            start(controller) {
              const keepaliveChunk = new TextEncoder().encode(': proxy-keep-alive\n\n')
              const proxyKeepalive = setInterval(() => {
                try {
                  controller.enqueue(keepaliveChunk)
                } catch {
                  clearInterval(proxyKeepalive)
                }
              }, 15_000)
              ;(async () => {
                try {
                  let chunkCount = 0
                  while (true) {
                    const { done, value } = await bgReader.read()
                    if (done) break
                    chunkCount++
                    trackingChunks.push(value)
                    trackingNotify?.()
                    trackingNotify = null
                    try { controller.enqueue(value) } catch {
                      if (clientEnqueueErrors === 0) {
                        console.log(`[ProjectChat:Stream] Client disconnected at chunk #${chunkCount} — stream continues for tracking/persistence`)
                      }
                      clientEnqueueErrors++
                    }
                  }
                  console.log(`[ProjectChat:Stream] Background reader finished: ${chunkCount} chunks, ${clientEnqueueErrors} client errors`)
                } catch (err: any) {
                  console.log(`[ProjectChat:Stream] Background reader error: ${err.message}`)
                  try { controller.error(err) } catch { /* client gone */ }
                } finally {
                  clearInterval(proxyKeepalive)
                  trackingDone = true
                  trackingNotify?.()
                  trackingNotify = null
                  try { controller.close() } catch { /* already closed */ }
                }
              })()
            },
          })

          // trackUsageFromStream takes ownership of billing — it calls
          // closeSession after the stream finishes. Mark the handoff so
          // our finally guard doesn't double-close.
          billingSessionHandedOff = true
          trackUsageFromStream(trackingStream, parsedBody, project, {
            // Single source of truth for the chat-session id. The route
            // handler resolved it from `X-Chat-Session-Id` || body, and
            // the billing session was opened with this exact value; we
            // pass it through so closeSession + persistence key on the
            // same id and never diverge from billing.
            chatSessionId: incomingChatSessionId,
            // Server-side auto-resume hook. When the original POST stream
            // EOFs before `data-turn-complete`, the tracker reconnects
            // here to drain the rest of the turn from the runtime's
            // in-memory `streamBufferStore` so the full message lands in
            // DB even if the client never reconnects (closed tab, etc.).
            // `fetchFromRuntime` reuses the same project URL resolution +
            // runtime token, so the resume hits the same pod that owns
            // the buffer.
            resume: async (fromSeq) => {
              const sessionId = incomingChatSessionId
              if (!sessionId) return null
              try {
                return await fetchFromRuntime(
                  projectId,
                  `/agent/chat/${encodeURIComponent(sessionId)}/stream?fromSeq=${fromSeq}`,
                  { method: 'GET' },
                )
              } catch (err: any) {
                console.warn(`[ProjectChat] Resume fetch failed for ${projectId}/${sessionId}:`, err?.message || err)
                return null
              }
            },
          }).catch((err) =>
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

          const isClientAbort = fetchError.name === 'AbortError' && clientSignal?.aborted
          if (isClientAbort) {
            console.log(`[ProjectChat] Client disconnected, stopping retry loop`)
            chatSpan.setStatus({ code: SpanStatusCode.OK, message: "client_disconnected" })
            chatSpan.end()
            return new Response(null, { status: 499 })
          }

          const isAbortError = fetchError.name === 'TimeoutError' || fetchError.name === 'AbortError'

          if ((isTransientError || isAbortError) && attempt < MAX_RETRIES) {
            const delay = Math.min(BASE_DELAY_MS * Math.pow(2, attempt - 1), MAX_DELAY_MS)

            if (isTransientError) {
              consecutiveConnectionErrors++
              // If the runtime process died on a stale local port, the existing
              // podUrl will keep refusing connections forever. Re-resolve the
              // URL so we pick up any port change RuntimeManager / warm pool /
              // Knative may have made. After repeated refusals, force a fresh
              // start so we stop hammering a dead runtime.
              try {
                if (runtimeManager && consecutiveConnectionErrors >= FORCE_RUNTIME_RESTART_AFTER) {
                  console.warn(`[ProjectChat] ${consecutiveConnectionErrors} consecutive connection errors against ${podUrl} — forcing runtime restart for ${projectId}`)
                  const fresh = await runtimeManager.restart(projectId)
                  const agentPort = fresh.agentPort || (fresh.port + 1000)
                  const runtimeHost = new URL(fresh.url).hostname
                  podUrl = `http://${runtimeHost}:${agentPort}`
                  consecutiveConnectionErrors = 0
                } else {
                  const refreshed = await getProjectUrl(projectId)
                  if (refreshed && refreshed !== podUrl) {
                    console.log(`[ProjectChat] Runtime URL changed mid-retry: ${podUrl} -> ${refreshed}`)
                    podUrl = refreshed
                    consecutiveConnectionErrors = 0
                  }
                }
              } catch (rerouteErr: any) {
                console.warn(`[ProjectChat] Failed to refresh runtime URL after connection error: ${rerouteErr?.message || rerouteErr}`)
              }
            } else {
              consecutiveConnectionErrors = 0
            }

            console.log(`[ProjectChat] Connection error, retrying in ${delay}ms (attempt ${attempt}/${MAX_RETRIES}) against ${podUrl}:`, fetchError.message || fetchError.code)
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

      } finally {
        // Guard: close the billing session if trackUsageFromStream never
        // took ownership (retry exhaustion, client disconnect, thrown error).
        // closeSession is idempotent — safe to call even if already closed.
        if (!billingSessionHandedOff) {
          closeSession(projectId, { chatSessionId: incomingChatSessionId }).catch((err) =>
            console.error(`[ProjectChat] Failed to close orphaned billing session for ${projectId}:`, err)
          )
        }
      }
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
   * GET /projects/:projectId/chat/:chatSessionId/stream - Resume active stream
   *
   * Matches the AI SDK's default resume URL pattern: ${api}/${chatId}/stream
   *
   * Optional query: ?fromSeq=N — replay only frames the runtime emitted after
   * sequence N. Combined with the runtime's `data-turn-start` /
   * `data-turn-complete` markers, this gives a client a delta resume so it
   * can attach mid-turn without re-rendering already-displayed text.
   *
   * Status codes:
   *   - 200 — replay stream (live or terminal frames). Headers expose
   *           `X-Turn-Id`, `X-Last-Seq`, `X-Turn-Status`.
   *   - 204 — no buffered turn for this session at all.
   */
  router.get("/projects/:projectId/chat/:chatSessionId/stream", async (c) => {
    const projectId = c.req.param("projectId")
    const chatSessionId = c.req.param("chatSessionId")
    const fromSeq = c.req.query("fromSeq")

    try {
      const project = await validateProject(projectId)
      if (!project) {
        return c.json(
          { error: { code: "project_not_found", message: "Project not found" } },
          404
        )
      }

      const runtimePath = fromSeq !== undefined && fromSeq !== ""
        ? `/agent/chat/${chatSessionId}/stream?fromSeq=${encodeURIComponent(fromSeq)}`
        : `/agent/chat/${chatSessionId}/stream`

      const response = await fetchFromRuntime(
        projectId,
        runtimePath,
        { method: "GET" },
      )

      if (response.status === 204) {
        return new Response(null, { status: 204 })
      }

      if (response.body) {
        const responseHeaders = new Headers()
        response.headers.forEach((value, key) => {
          if (!["content-length", "transfer-encoding", "connection"].includes(key.toLowerCase())) {
            responseHeaders.set(key, value)
          }
        })
        responseHeaders.set("Access-Control-Allow-Origin", "*")
        responseHeaders.set(
          "Access-Control-Expose-Headers",
          "X-Turn-Id, X-Last-Seq, X-Turn-Status",
        )
        responseHeaders.set("X-Accel-Buffering", "no")
        return new Response(response.body, {
          status: response.status,
          headers: responseHeaders,
        })
      }

      return new Response(null, { status: 204 })
    } catch (err: any) {
      console.warn(`[ProjectChat] resume proxy error for ${projectId}/${chatSessionId}:`, err?.message || err)
      return new Response(null, { status: 204 })
    }
  })

  /**
   * GET /projects/:projectId/chat/:chatSessionId/turn - Read-only durable turn snapshot
   *
   * Lets a client poll for the current state of a turn (status, lastSeq,
   * turnId, terminal reason) without opening a streaming connection. The
   * client can then decide whether to call /stream?fromSeq=N to resume.
   */
  router.get("/projects/:projectId/chat/:chatSessionId/turn", async (c) => {
    const projectId = c.req.param("projectId")
    const chatSessionId = c.req.param("chatSessionId")

    try {
      const project = await validateProject(projectId)
      if (!project) {
        return c.json(
          { error: { code: "project_not_found", message: "Project not found" } },
          404
        )
      }

      const response = await fetchFromRuntime(
        projectId,
        `/agent/chat/${chatSessionId}/turn`,
        { method: "GET" },
      )

      if (response.status === 404) {
        return c.json({ status: "unknown" as const }, 404)
      }

      const data = await response.json()
      return c.json(data, response.status as any)
    } catch (err: any) {
      console.warn(`[ProjectChat] turn snapshot proxy error for ${projectId}/${chatSessionId}:`, err?.message || err)
      return c.json({ status: "unknown" as const }, 404)
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

      const body = await c.req.text()
      const response = await fetchFromRuntime(projectId, "/agent/stop", {
        method: "POST",
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
   * POST /projects/:projectId/chat/subagents/:instanceId/stop - Cancel a single subagent
   * Proxies to the project runtime's /agent/subagents/:instanceId/stop endpoint
   */
  router.post("/projects/:projectId/chat/subagents/:instanceId/stop", async (c) => {
    const projectId = c.req.param("projectId")
    const instanceId = c.req.param("instanceId")

    try {
      const project = await validateProject(projectId)
      if (!project) {
        return c.json(
          { error: { code: "project_not_found", message: "Project not found" } },
          404
        )
      }

      const response = await fetchFromRuntime(
        projectId,
        `/agent/subagents/${encodeURIComponent(instanceId)}/stop`,
        { method: "POST", body: "{}" }
      )

      const result = await response.json()
      return c.json(result)
    } catch (error: any) {
      console.error("[ProjectChat] Subagent stop error:", error)
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
