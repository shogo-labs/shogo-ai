// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Agentic Tool-Call Loop — Pi Agent Core Adapter
 *
 * Wraps Pi Agent Core's Agent class to provide runAgentLoop() for the gateway.
 * This replaces the previous hand-rolled Anthropic fetch loop with Pi's
 * production-tested multi-provider agent runtime.
 *
 * Pi Agent Core handles:
 * - Multi-provider LLM streaming (Anthropic, OpenAI, Google, xAI, Groq, etc.)
 * - Tool call validation via TypeBox/AJV
 * - Event-driven tool execution with abort support
 * - Streaming events for UI updates
 *
 * We layer on top:
 * - LoopDetector circuit breaker (wired via Agent.subscribe)
 * - Max iteration enforcement
 * - AgentLoopResult mapping for the gateway
 */

import type { AgentTool, AgentEvent, StreamFn } from '@mariozechner/pi-agent-core'
import { Agent } from '@mariozechner/pi-agent-core'
import type { Message, Model, Api, ImageContent } from '@mariozechner/pi-ai'
import { LoopDetector, type LoopDetectorConfig, type LoopDetectorResult } from './loop-detector'
import type { ToolContext } from './gateway-tools'
import {
  resolveModel,
  resolveApiKey,
  defaultConvertToLlm,
  extractFinalText,
  sumUsage,
} from './pi-adapter'
import { wrapToolsWithOrchestration, type OrchestrationOptions } from './tool-orchestration'

export type { LoopDetectorConfig, LoopDetectorResult }
export type { ToolContext }
export type { OrchestrationOptions }

export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'

export interface AgentLoopOptions {
  /** API key for the primary provider */
  apiKey?: string
  /** Provider name (default: 'anthropic') */
  provider?: string
  /** Model ID string (e.g. 'claude-sonnet-4-6') */
  model: string
  /** System prompt */
  system: string
  /** Existing conversation history (NOT including the new prompt) */
  history: Message[]
  /** The new user prompt text to send */
  prompt: string
  /** Optional images to include with the prompt (native vision support) */
  images?: ImageContent[]
  /** Pi AgentTool array */
  tools: AgentTool[]
  /** Max tool-call iterations (default: 10) */
  maxIterations?: number
  /** Max tokens per LLM call. Defaults to the model's max from the catalog. */
  maxTokens?: number
  /** Thinking/reasoning level (default: 'medium') */
  thinkingLevel?: ThinkingLevel
  /** Called when a tool is invoked */
  onToolCall?: (name: string, input: any) => void
  /** Called at each iteration */
  onIteration?: (iteration: number) => void
  /** Called with incremental text as the model streams */
  onTextDelta?: (delta: string) => void
  /** Called when thinking/reasoning starts */
  onThinkingStart?: () => void
  /** Called with incremental thinking/reasoning text */
  onThinkingDelta?: (delta: string) => void
  /** Called when thinking/reasoning ends */
  onThinkingEnd?: () => void
  /** Called before a tool executes (return false to skip) */
  onBeforeToolCall?: (toolName: string, args: any, toolCallId: string) => Promise<void>
  /** Called after a tool executes */
  onAfterToolCall?: (toolName: string, args: any, result: any, isError: boolean, toolCallId: string) => Promise<void>
  /** Called when the agent loop completes */
  onAgentEnd?: (result: AgentLoopResult) => Promise<void>
  /** Called when the LLM starts generating a tool call */
  onToolCallStart?: (toolName: string, toolCallId: string) => void
  /** Called with incremental JSON fragments as the LLM generates tool call arguments */
  onToolCallDelta?: (toolName: string, delta: string, toolCallId: string) => void
  /** Called when the LLM finishes generating a tool call (before execution) */
  onToolCallEnd?: (toolName: string, toolCallId: string) => void
  /** Loop detection config. Pass false to disable. */
  loopDetection?: Partial<LoopDetectorConfig> | false
  /** Custom stream function (for testing — replaces Pi's streamSimple) */
  streamFn?: StreamFn
  /** Tool orchestration config. Pass false to disable wrapping (tools run raw parallel). */
  orchestration?: OrchestrationOptions | false
  /** AbortSignal for external cancellation (e.g., user stop). */
  signal?: AbortSignal
  /**
   * Layer 5: Reactive compaction callback. When the LLM returns a 413 or
   * context-overflow error, this is called to aggressively compact history.
   * Returns the new compacted history to retry with. Capped at 1 retry.
   */
  onContextOverflow?: () => Promise<Message[] | null>
}

export interface ToolCallRecord {
  name: string
  input: Record<string, any>
  output: any
}

export interface AgentLoopResult {
  text: string
  toolCalls: ToolCallRecord[]
  iterations: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  /** All new messages produced during this loop (user prompt + assistant + tool results) */
  newMessages: Message[]
  /** Set if the loop was terminated by the circuit breaker */
  loopBreak?: LoopDetectorResult
  /** Set if the agent encountered an error (provider failure, etc.). Partial results are still available. */
  error?: Error
  /** True when the loop stopped because maxIterations was reached, NOT because the model finished naturally */
  maxIterationsExhausted?: boolean
  /** The stop reason from the last LLM response (e.g. 'end_turn', 'tool_use', 'max_tokens') */
  lastStopReason?: string
  /** Whether the last turn included tool call executions (more reliable than checking stopReason) */
  lastTurnHadToolCalls?: boolean
}

export async function runAgentLoop(options: AgentLoopOptions): Promise<AgentLoopResult> {
  const {
    apiKey,
    provider = 'anthropic',
    model: modelId,
    system,
    history,
    prompt,
    images,
    tools,
    maxIterations = 10,
    maxTokens,
    thinkingLevel = 'medium',
    onToolCall,
    onIteration,
    onTextDelta,
    onThinkingStart,
    onThinkingDelta,
    onThinkingEnd,
    onBeforeToolCall,
    onAfterToolCall,
    onAgentEnd,
    onToolCallStart,
    onToolCallDelta,
    onToolCallEnd,
  } = options

  const resolvedModel = resolveModel(provider, modelId)
  const model = maxTokens ? { ...resolvedModel, maxTokens } : resolvedModel

  const loopDetector = options.loopDetection !== false
    ? new LoopDetector(typeof options.loopDetection === 'object' ? options.loopDetection : {})
    : null

  // Wrap tools with orchestration: read-only tools run freely in parallel,
  // write/mutating tools are serialized via an exclusive mutex, all gated
  // by a concurrency semaphore (default 10).
  const orchestrated = options.orchestration !== false
    ? wrapToolsWithOrchestration(tools, typeof options.orchestration === 'object' ? options.orchestration : {})
    : { tools, state: null }

  const toolCalls: ToolCallRecord[] = []
  const pendingArgs = new Map<string, any>()
  const streamingToolCalls = new Map<number, { name: string; id: string }>()
  let iterations = 0
  let loopBreak: LoopDetectorResult | undefined
  let abortTriggered = false
  let abortReason: 'external' | 'max_iterations' | 'loop_detected' | undefined
  let maxIterationsExhausted = false
  let lastStopReason: string | undefined
  let lastTurnHadToolCalls = false

  const { signal } = options

  if (signal?.aborted) {
    abortTriggered = true
  }

  const agent = new Agent({
    initialState: {
      systemPrompt: system,
      model,
      thinkingLevel: thinkingLevel === 'off' ? undefined : thinkingLevel,
      tools: orchestrated.tools,
      messages: [...history],
    },
    toolExecution: 'parallel',
    convertToLlm: defaultConvertToLlm,
    streamFn: options.streamFn,
    getApiKey: (prov) => {
      if (apiKey && prov === provider) return apiKey
      return resolveApiKey(prov)
    },
  })

  agent.subscribe(async (event: AgentEvent) => {
    switch (event.type) {
      case 'message_update': {
        const ame = event.assistantMessageEvent
        if (ame.type === 'thinking_start') {
          onThinkingStart?.()
        } else if (ame.type === 'thinking_delta') {
          onThinkingDelta?.(ame.delta)
        } else if (ame.type === 'thinking_end') {
          onThinkingEnd?.()
        } else if (ame.type === 'text_delta') {
          onTextDelta?.(ame.delta)
        } else if (ame.type === 'toolcall_start') {
          const tc = ame.partial.content[ame.contentIndex]
          if (tc && tc.type === 'toolCall') {
            streamingToolCalls.set(ame.contentIndex, { name: tc.name, id: tc.id })
            onToolCallStart?.(tc.name, tc.id)
          }
        } else if (ame.type === 'toolcall_delta') {
          const info = streamingToolCalls.get(ame.contentIndex)
          if (info) {
            onToolCallDelta?.(info.name, ame.delta, info.id)
          }
        } else if (ame.type === 'toolcall_end') {
          const info = streamingToolCalls.get(ame.contentIndex)
          if (info) {
            onToolCallEnd?.(info.name, info.id)
            streamingToolCalls.delete(ame.contentIndex)
          }
        }
        break
      }

      case 'tool_execution_start':
        pendingArgs.set(event.toolCallId, event.args)
        onToolCall?.(event.toolName, event.args)
        await onBeforeToolCall?.(event.toolName, event.args, event.toolCallId)
        break

      case 'tool_execution_end': {
        const args = pendingArgs.get(event.toolCallId)
        pendingArgs.delete(event.toolCallId)

        const output = event.isError
          ? { error: event.result?.content?.[0]?.text || 'Tool error' }
          : event.result?.details ?? event.result

        toolCalls.push({
          name: event.toolName,
          input: args,
          output,
        })

        await onAfterToolCall?.(event.toolName, args, output, event.isError, event.toolCallId)

        if (loopDetector && !abortTriggered) {
          const check = loopDetector.recordAndCheck(event.toolName, args, output)
          if (check.loopDetected) {
            loopBreak = check
            abortTriggered = true
            abortReason = 'loop_detected'
            agent.abort()
          }
        }
        break
      }

      case 'turn_end': {
        iterations++
        const turnMsg = (event as any).message
        if (turnMsg?.role === 'assistant' && turnMsg.stopReason) {
          lastStopReason = turnMsg.stopReason
        }
        const turnToolResults = (event as any).toolResults
        lastTurnHadToolCalls = Array.isArray(turnToolResults) && turnToolResults.length > 0
        onIteration?.(iterations)
        // Track the stop reason from the last assistant message
        const msgs = agent.state.messages
        for (let i = msgs.length - 1; i >= 0; i--) {
          if (msgs[i].role === 'assistant' && (msgs[i] as any).stopReason) {
            lastStopReason = (msgs[i] as any).stopReason
            break
          }
        }
        if (iterations >= maxIterations && !abortTriggered) {
          maxIterationsExhausted = true
          abortTriggered = true
          abortReason = 'max_iterations'
          agent.abort()
        }
        break
      }
    }
  })

  const onAbort = () => {
    if (!abortTriggered) {
      abortTriggered = true
      abortReason = 'external'
      agent.abort()
    }
  }
  if (signal && !signal.aborted) {
    signal.addEventListener('abort', onAbort, { once: true })
  }

  let promptError: Error | undefined
  let reactiveRetried = false
  try {
    if (abortTriggered) {
      promptError = new Error('Aborted before prompt')
    } else {
      await agent.prompt(prompt, images && images.length > 0 ? images : undefined)
    }
  } catch (err: any) {
    if (!abortTriggered) {
      // Layer 5: Reactive compaction on context overflow / 413
      if (options.onContextOverflow && !reactiveRetried && isContextOverflowError(err)) {
        reactiveRetried = true
        console.warn(`[AgentLoop] Context overflow detected — attempting reactive compaction`)
        try {
          const compactedHistory = await options.onContextOverflow()
          if (compactedHistory) {
            agent.state.messages = [...compactedHistory]
            await agent.prompt(prompt, images && images.length > 0 ? images : undefined)
          } else {
            promptError = err
          }
        } catch (retryErr: any) {
          console.error(`[AgentLoop] Reactive compaction retry failed:`, retryErr.message)
          promptError = retryErr
        }
      } else {
        promptError = err
      }
    } else if (abortReason === 'max_iterations') {
      // maxIterations abort should not silently swallow the error — the task
      // was likely incomplete. Surface it so the gateway can inform the user.
      promptError = new Error(
        `Agent reached the maximum iteration limit (${maxIterations}). The task may be incomplete — you can continue the conversation to pick up where it left off.`
      )
    }
    // External aborts (user stop) and loop detection aborts are intentional —
    // don't surface those as errors (loop detection is handled via loopBreak).
  } finally {
    signal?.removeEventListener('abort', onAbort)
  }

  const allMessages = agent.state.messages
  const newMessages = allMessages.slice(history.length)
  const finalText = extractFinalText(newMessages)
  const usage = sumUsage(newMessages)

  // Detect if the model's output was truncated (max_tokens hit → stopReason='length')
  // without maxIterations being exhausted. Mark as maxIterationsExhausted so the
  // caller knows to continue.
  if (!maxIterationsExhausted && !abortTriggered && lastStopReason === 'length') {
    maxIterationsExhausted = true
    console.warn('[AgentLoop] Model output truncated (stop_reason=max_tokens/length) — marking as incomplete for continuation')
  }

  // Determine the error to surface. promptError is set when agent.prompt()
  // throws directly. When the provider fails but pi-agent-core swallows the
  // error (e.g. stream function throws), agent.prompt() resolves with 0
  // output — detect that as an implicit error so callers can show a message.
  //
  // Also extract error messages from pi-agent-core (it catches stream errors
  // internally and appends error messages instead of re-throwing).
  const coreErrorMsg = newMessages.find((m: any) => m.errorMessage)
  const rawCoreError = (coreErrorMsg as any)?.errorMessage
  const coreError = rawCoreError ? parseProviderError(rawCoreError) : undefined
  const implicitError =
    !promptError && usage.output === 0 && toolCalls.length === 0 && !abortTriggered
      ? new Error(
          coreError
            ? `Provider error: ${coreError}`
            : 'Agent produced no output — possible provider error'
        )
      : undefined

  // If there was a core error but the agent DID make progress (tool calls executed),
  // don't treat it as a hard error — mark as exhausted so the caller can continue.
  if (coreError && !implicitError && !promptError && toolCalls.length > 0 && !maxIterationsExhausted) {
    maxIterationsExhausted = true
    console.warn(`[AgentLoop] Provider error mid-stream after ${toolCalls.length} tool calls — marking as incomplete for continuation: ${coreError}`)
  }

  if (coreError) {
    console.error(`[AgentLoop] Provider error from pi-agent-core: ${coreError}`)
  }

  const result: AgentLoopResult = {
    text: loopBreak
      ? `[LOOP DETECTED] ${loopBreak.pattern || loopBreak.reason}`
      : finalText,
    toolCalls,
    iterations,
    inputTokens: usage.input,
    outputTokens: usage.output,
    cacheReadTokens: usage.cacheRead,
    cacheWriteTokens: usage.cacheWrite,
    newMessages,
    loopBreak,
    error: promptError || implicitError,
    maxIterationsExhausted,
    lastStopReason,
    lastTurnHadToolCalls,
  }

  await onAgentEnd?.(result)

  return result
}

/**
 * Extract a human-readable message from raw provider error strings.
 * pi-agent-core often returns errors like: `402 {"type":"error","error":{"type":"billing_error","message":"..."}}`
 */
function parseProviderError(raw: string): string {
  const jsonStart = raw.indexOf('{')
  if (jsonStart >= 0) {
    try {
      const parsed = JSON.parse(raw.slice(jsonStart))
      const msg = parsed?.error?.message || parsed?.message
      if (msg) {
        const status = raw.slice(0, jsonStart).trim()
        return status ? `${status} ${msg}` : msg
      }
    } catch {}
  }
  return raw
}

function isContextOverflowError(err: any): boolean {
  if (!err) return false
  const status = err.status ?? err.statusCode ?? err.code
  if (status === 413) return true
  const msg = String(err.message || err).toLowerCase()
  return (
    msg.includes('context') && (msg.includes('overflow') || msg.includes('too long') || msg.includes('exceed'))
  ) || msg.includes('prompt is too long')
    || msg.includes('maximum context length')
    || msg.includes('request too large')
}
