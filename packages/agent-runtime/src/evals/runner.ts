// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Agent Runtime Eval Runner
 *
 * Spins up a real agent-runtime server (same as production), sends real
 * messages via POST /agent/chat, and collects AgentLoopResult metrics
 * from real tool execution.
 *
 * Uses a "spin up server, send HTTP, parse SSE" pattern targeting
 * the agent-runtime.
 */

import type {
  AgentEval,
  EvalResult,
  CriterionResult,
  ToolCallRecord,
  EvalMetrics,
} from './types'

export interface EvalRunnerConfig {
  agentEndpoint: string
  timeoutMs: number
  verbose: boolean
  workspaceDir: string
  agentMode?: string
}

const DEFAULT_CONFIG: EvalRunnerConfig = {
  agentEndpoint: 'http://localhost:6400/agent/chat',
  timeoutMs: 300_000,
  verbose: false,
  workspaceDir: '/tmp/agent-eval-worker-0',
}

// ---------------------------------------------------------------------------
// HTTP ↔ Agent
// ---------------------------------------------------------------------------

export interface ParsedAgentResponse {
  text: string
  toolCalls: ToolCallRecord[]
  stepCount: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

/**
 * Send a single turn to the agent via POST /agent/chat and parse the SSE
 * stream response (AI SDK UI Message Stream format).
 */
export async function sendTurn(
  messages: Array<{ role: string; parts: Array<{ type: string; text: string }> }>,
  config: EvalRunnerConfig,
): Promise<ParsedAgentResponse> {
  const MAX_RETRIES = 3
  const RETRY_DELAY = 3_000

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), config.timeoutMs)

    try {
      const body: Record<string, unknown> = { messages }

      const res = await fetch(config.agentEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      })

      if (!res.ok) {
        clearTimeout(timeout)
        const errBody = await res.text().catch(() => '(no body)')
        if (config.verbose) console.log(`      [sendTurn] HTTP ${res.status}: ${errBody.slice(0, 200)}`)
        if ((res.status >= 500 || res.status === 429) && attempt < MAX_RETRIES) {
          await Bun.sleep(RETRY_DELAY * attempt)
          continue
        }
        throw new Error(`Agent API returned ${res.status}: ${errBody.slice(0, 200)}`)
      }

      if (config.verbose) console.log(`      [sendTurn] Response OK, parsing SSE...`)
      const result = await parseSSEStream(res, config.verbose)
      clearTimeout(timeout)
      return result
    } catch (err: any) {
      clearTimeout(timeout)
      if (attempt < MAX_RETRIES && isRetryable(err)) {
        await Bun.sleep(RETRY_DELAY * attempt)
        continue
      }
      throw err
    }
  }
  throw new Error('Max retries exceeded')
}

function isRetryable(err: any): boolean {
  const msg = String(err?.message || '').toLowerCase()
  return ['rate_limit', 'overloaded', '529', '503', '502', 'econnreset', 'timeout', 'aborted']
    .some(k => msg.includes(k))
}

/**
 * Parse AI SDK UI Message Stream SSE into structured data.
 * Handles the same event types as the project-runtime runner.
 */
async function parseSSEStream(
  response: Response,
  verbose: boolean,
): Promise<ParsedAgentResponse> {
  const toolCalls: ToolCallRecord[] = []
  const toolInputs: Record<string, string> = {}
  const toolNames: Record<string, string> = {}
  const toolStartTimes: Record<string, number> = {}
  let text = ''
  let stepCount = 0
  let inputTokens = 0
  let outputTokens = 0
  let cacheReadTokens = 0
  let cacheWriteTokens = 0

  const reader = response.body?.getReader()
  if (!reader) throw new Error('No response body')

  const decoder = new TextDecoder()
  let buffer = ''

  let chunkCount = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      chunkCount++
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue
        const dataStr = line.slice(6).trim()
        if (dataStr === '[DONE]' || !dataStr || dataStr === '{}') continue

        try {
          const data = JSON.parse(dataStr)
          switch (data.type) {
            case 'start-step':
              stepCount++
              break
            case 'finish':
              if (data.usage) {
                inputTokens += data.usage.promptTokens || data.usage.inputTokens || 0
                outputTokens += data.usage.completionTokens || data.usage.outputTokens || 0
              }
              break
            case 'data-usage': {
              const u = data.data || data
              inputTokens += u.inputTokens || 0
              outputTokens += u.outputTokens || 0
              cacheReadTokens += u.cacheReadTokens || 0
              cacheWriteTokens += u.cacheWriteTokens || 0
              if (verbose) {
                const total = (u.inputTokens || 0) + (u.cacheReadTokens || 0) + (u.cacheWriteTokens || 0)
                console.log(`      Usage: ${total}+${u.outputTokens} tokens (${u.cacheReadTokens || 0} cached), ${u.iterations} iterations, ${u.toolCallCount} tools`)
              }
              break
            }
            case 'text-delta':
              text += data.delta || ''
              break
            case 'text':
              text += data.content || ''
              break
            case 'tool-input-start':
              toolInputs[data.toolCallId] = ''
              toolNames[data.toolCallId] = data.toolName || 'unknown'
              toolStartTimes[data.toolCallId] = Date.now()
              if (verbose) console.log(`      Tool started: ${data.toolName}`)
              break
            case 'tool-input-delta':
              if (data.toolCallId in toolInputs) {
                toolInputs[data.toolCallId] += data.inputTextDelta || ''
              }
              break
            case 'tool-input-available': {
              const name = data.toolName || toolNames[data.toolCallId] || 'unknown'
              toolCalls.push({
                name,
                input: data.input || {},
                output: undefined,
              })
              break
            }
            case 'tool-result':
            case 'tool-output-available': {
              const output = data.result ?? data.output
              const isError = data.isError ?? (typeof data.output === 'object' && data.output !== null && 'error' in data.output)
              for (let i = toolCalls.length - 1; i >= 0; i--) {
                if (toolCalls[i].output === undefined) {
                  const startT = toolStartTimes[data.toolCallId]
                  toolCalls[i].output = output
                  toolCalls[i].durationMs = startT ? Date.now() - startT : undefined
                  toolCalls[i].error = isError || false
                  break
                }
              }
              break
            }
          }
        } catch { /* skip non-JSON lines */ }
      }
    }
  } finally {
    reader.releaseLock()
  }

  if (verbose) {
    console.log(`      [SSE] Complete: ${toolCalls.length} tools, ${stepCount} steps`)
  }

  return { text, toolCalls, stepCount, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens }
}

// ---------------------------------------------------------------------------
// Anti-pattern checks
// ---------------------------------------------------------------------------

function checkAntiPattern(
  pattern: string,
  responseText: string,
  toolCalls: ToolCallRecord[],
): boolean {
  const p = pattern.toLowerCase()

  if (p.includes('loop') || p.includes('repeat')) {
    const names = toolCalls.map(t => t.name)
    for (let i = 2; i < names.length; i++) {
      if (names[i] === names[i - 1] && names[i] === names[i - 2]) return true
    }
  }

  if (p.includes('unnecessary') || p.includes('clarif')) {
    const questions = ['what kind', 'which one', 'do you want', 'would you prefer', 'could you clarify']
    return questions.some(q => responseText.toLowerCase().includes(q))
  }

  if (p.includes('no tool') || p.includes('zero tool')) {
    return toolCalls.length === 0
  }

  if (p.includes('canvas without') || p.includes('ui instead of work') || p.includes('interactive ui instead')) {
    const canvasCalls = toolCalls.filter(t => t.name.startsWith('canvas_'))
    const workCalls = toolCalls.filter(t =>
      !t.name.startsWith('canvas_') &&
      t.name !== 'memory_read' &&
      t.name !== 'memory_search'
    )
    return canvasCalls.length > 3 && workCalls.length < 2
  }

  if (p.includes('form field') || p.includes('builder ui') || p.includes('self-service')) {
    const updateCalls = toolCalls.filter(t => t.name === 'canvas_update')
    for (const call of updateCalls) {
      const input = JSON.stringify(call.input ?? '')
      const hasTextField = input.includes('"TextField"')
      const hasSelect = input.includes('"Select"')
      const hasFormInputs = hasTextField || hasSelect
      const hasApiSchema = toolCalls.some(t => t.name === 'canvas_api_schema')
      if (hasFormInputs && hasApiSchema) return true
    }
    return false
  }

  if (p.includes('sendtoagent for simple crud') || p.includes('sendtoagent for crud')) {
    const hasSendToAgent = toolCalls.some(t => {
      if (t.name !== 'canvas_update') return false
      const input = JSON.stringify(t.input ?? '')
      return input.includes('"sendToAgent"')
    })
    const hasApiSchema = toolCalls.some(t => t.name === 'canvas_api_schema')
    return hasSendToAgent && hasApiSchema
  }

  return false
}

// ---------------------------------------------------------------------------
// Public: Run a single eval
// ---------------------------------------------------------------------------

export async function runEval(
  eval_: AgentEval,
  config: Partial<EvalRunnerConfig> = {},
): Promise<EvalResult> {
  const cfg = { ...DEFAULT_CONFIG, ...config }
  const startTime = Date.now()
  const errors: string[] = []

  let responseText = ''
  let toolCalls: ToolCallRecord[] = []
  let finalTurnToolCalls: ToolCallRecord[] = []
  let stepCount = 0
  let inputTokens = 0
  let outputTokens = 0
  let cacheReadTokens = 0
  let cacheWriteTokens = 0

  try {
    const messages: Array<{ role: string; parts: Array<{ type: string; text: string }> }> = []

    // Execute conversation history turns first (for multi-turn evals)
    // If a user message is followed by an assistant message in the history,
    // use the assistant message directly (scripted response) instead of
    // generating one via the LLM. This allows evals to control exactly what
    // the agent "said" in prior turns so the final turn tests the right thing.
    if (eval_.conversationHistory?.length) {
      const history = eval_.conversationHistory
      if (cfg.verbose) {
        console.log(`    [Multi-turn] Executing ${history.length} history turns...`)
      }
      for (let i = 0; i < history.length; i++) {
        const turn = history[i]
        if (turn.role === 'user') {
          messages.push({ role: 'user', parts: [{ type: 'text', text: turn.content }] })
          const nextTurn = history[i + 1]
          if (nextTurn?.role === 'assistant') {
            // Use the scripted assistant response directly
            messages.push({ role: 'assistant', parts: [{ type: 'text', text: nextTurn.content }] })
            i++ // skip the assistant turn in the loop
          } else {
            // No scripted response — generate one via the LLM
            try {
              const resp = await sendTurn(messages, cfg)
              messages.push({ role: 'assistant', parts: [{ type: 'text', text: resp.text }] })
              // Accumulate history turn tool calls so scoring considers the
              // full conversation, not just the final turn (Issue 4 fix)
              toolCalls.push(...resp.toolCalls)
              stepCount += resp.stepCount
              inputTokens += resp.inputTokens
              outputTokens += resp.outputTokens
              cacheReadTokens += resp.cacheReadTokens
              cacheWriteTokens += resp.cacheWriteTokens
            } catch (e: any) {
              errors.push(`History turn error: ${e.message}`)
            }
          }
        }
      }
    }

    // Final eval turn
    messages.push({ role: 'user', parts: [{ type: 'text', text: eval_.input }] })
    const response = await sendTurn(messages, cfg)
    responseText = response.text
    finalTurnToolCalls = response.toolCalls
    toolCalls.push(...response.toolCalls)
    stepCount += response.stepCount
    inputTokens += response.inputTokens
    outputTokens += response.outputTokens
    cacheReadTokens += response.cacheReadTokens
    cacheWriteTokens += response.cacheWriteTokens
  } catch (err: any) {
    errors.push(err.message)
  }

  const endTime = Date.now()
  const durationMs = endTime - startTime

  const successfulTools = toolCalls.filter(t => !t.error).length
  const failedTools = toolCalls.filter(t => t.error).length

  const totalTokens = inputTokens + cacheReadTokens + cacheWriteTokens + outputTokens
  const metrics: EvalMetrics = {
    toolCallCount: toolCalls.length,
    successfulToolCalls: successfulTools,
    failedToolCalls: failedTools,
    iterations: stepCount,
    tokens: { input: inputTokens, output: outputTokens, cacheRead: cacheReadTokens, cacheWrite: cacheWriteTokens, total: totalTokens },
    timing: { totalMs: durationMs },
  }

  // Score criteria
  const evalBase: EvalResult = {
    eval: eval_,
    passed: false,
    score: 0,
    maxScore: eval_.maxScore,
    percentage: 0,
    responseText,
    toolCalls,
    finalTurnToolCalls,
    criteriaResults: [],
    triggeredAntiPatterns: [],
    timing: { startTime, endTime, durationMs },
    metrics,
    errors: errors.length > 0 ? errors : undefined,
    workspaceDir: cfg.workspaceDir,
  }

  let totalScore = 0
  let intentionScore = 0
  let intentionMax = 0
  let executionScore = 0
  let executionMax = 0
  const criteriaResults: CriterionResult[] = []

  for (const criterion of eval_.validationCriteria) {
    try {
      const passed = criterion.validate(evalBase)
      const points = passed ? criterion.points : 0
      totalScore += points

      const phase = criterion.phase || 'intention'
      if (phase === 'intention') { intentionScore += points; intentionMax += criterion.points }
      else { executionScore += points; executionMax += criterion.points }

      criteriaResults.push({ criterion, passed, pointsEarned: points })
    } catch (err) {
      criteriaResults.push({ criterion, passed: false, pointsEarned: 0 })
      const phase = criterion.phase || 'intention'
      if (phase === 'intention') intentionMax += criterion.points
      else executionMax += criterion.points
    }
  }

  const triggeredAntiPatterns: string[] = []
  if (eval_.antiPatterns) {
    for (const pattern of eval_.antiPatterns) {
      if (checkAntiPattern(pattern, responseText, toolCalls)) {
        triggeredAntiPatterns.push(pattern)
      }
    }
  }

  const antiPenalty = triggeredAntiPatterns.length * 10
  const finalScore = Math.max(0, totalScore - antiPenalty)
  const percentage = (finalScore / eval_.maxScore) * 100
  const passed = percentage >= 70 && triggeredAntiPatterns.length === 0

  return {
    ...evalBase,
    passed,
    score: finalScore,
    percentage,
    criteriaResults,
    triggeredAntiPatterns,
    phaseScores: {
      intention: {
        score: intentionScore,
        maxScore: intentionMax,
        percentage: intentionMax > 0 ? (intentionScore / intentionMax) * 100 : 100,
      },
      execution: {
        score: executionScore,
        maxScore: executionMax,
        percentage: executionMax > 0 ? (executionScore / executionMax) * 100 : 100,
      },
    },
  }
}
