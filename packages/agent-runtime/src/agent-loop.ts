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
import type { Message, Model, Api } from '@mariozechner/pi-ai'
import { LoopDetector, type LoopDetectorConfig, type LoopDetectorResult } from './loop-detector'
import type { ToolContext } from './gateway-tools'
import {
  resolveModel,
  resolveApiKey,
  defaultConvertToLlm,
  extractFinalText,
  sumUsage,
} from './pi-adapter'

export type { LoopDetectorConfig, LoopDetectorResult }
export type { ToolContext }

export interface AgentLoopOptions {
  /** API key for the primary provider */
  apiKey?: string
  /** Provider name (default: 'anthropic') */
  provider?: string
  /** Model ID string (e.g. 'claude-sonnet-4-5') */
  model: string
  /** System prompt */
  system: string
  /** Existing conversation history (NOT including the new prompt) */
  history: Message[]
  /** The new user prompt text to send */
  prompt: string
  /** Pi AgentTool array */
  tools: AgentTool[]
  /** Max tool-call iterations (default: 10) */
  maxIterations?: number
  /** Max tokens per LLM call (default: 4096) */
  maxTokens?: number
  /** Called when a tool is invoked */
  onToolCall?: (name: string, input: any) => void
  /** Called at each iteration */
  onIteration?: (iteration: number) => void
  /** Called with incremental text as the model streams */
  onTextDelta?: (delta: string) => void
  /** Called before a tool executes (return false to skip) */
  onBeforeToolCall?: (toolName: string, args: any, toolCallId: string) => Promise<void>
  /** Called after a tool executes */
  onAfterToolCall?: (toolName: string, args: any, result: any, isError: boolean, toolCallId: string) => Promise<void>
  /** Called when the agent loop completes */
  onAgentEnd?: (result: AgentLoopResult) => Promise<void>
  /** Loop detection config. Pass false to disable. */
  loopDetection?: Partial<LoopDetectorConfig> | false
  /** Custom stream function (for testing — replaces Pi's streamSimple) */
  streamFn?: StreamFn
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
}

export async function runAgentLoop(options: AgentLoopOptions): Promise<AgentLoopResult> {
  const {
    apiKey,
    provider = 'anthropic',
    model: modelId,
    system,
    history,
    prompt,
    tools,
    maxIterations = 10,
    maxTokens = 4096,
    onToolCall,
    onIteration,
    onTextDelta,
    onBeforeToolCall,
    onAfterToolCall,
    onAgentEnd,
  } = options

  const model = resolveModel(provider, modelId)

  const loopDetector = options.loopDetection !== false
    ? new LoopDetector(typeof options.loopDetection === 'object' ? options.loopDetection : {})
    : null

  const toolCalls: ToolCallRecord[] = []
  const pendingArgs = new Map<string, any>()
  let iterations = 0
  let loopBreak: LoopDetectorResult | undefined
  let abortTriggered = false

  const agent = new Agent({
    initialState: {
      systemPrompt: system,
      model,
      tools,
      messages: [...history],
    },
    convertToLlm: defaultConvertToLlm,
    streamFn: options.streamFn,
    getApiKey: (prov) => {
      if (apiKey && prov === provider) return apiKey
      return resolveApiKey(prov)
    },
  })

  agent.subscribe(async (event: AgentEvent) => {
    switch (event.type) {
      case 'message_update':
        if (onTextDelta && event.assistantMessageEvent.type === 'text_delta') {
          onTextDelta(event.assistantMessageEvent.delta)
        }
        break

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
            agent.abort()
          }
        }
        break
      }

      case 'turn_end':
        iterations++
        onIteration?.(iterations)
        if (iterations >= maxIterations && !abortTriggered) {
          abortTriggered = true
          agent.abort()
        }
        break
    }
  })

  try {
    await agent.prompt(prompt)
  } catch (err: any) {
    if (!abortTriggered) {
      throw err
    }
  }

  const allMessages = agent.state.messages
  const newMessages = allMessages.slice(history.length)
  const finalText = extractFinalText(newMessages)
  const usage = sumUsage(newMessages)

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
  }

  await onAgentEnd?.(result)

  return result
}
