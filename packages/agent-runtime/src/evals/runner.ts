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
  PromptBreakdown,
} from './types'

export interface EvalRunnerConfig {
  agentEndpoint: string
  timeoutMs: number
  verbose: boolean
  workspaceDir: string
  agentMode?: string
  interactionMode?: 'agent' | 'plan' | 'ask'
  /**
   * Tool calls accumulated by every previously-completed phase of the
   * pipeline this eval belongs to. Set by `runEvalOnWorker` when running
   * pipeline phase 2+; absent for standalone evals and pipeline phase 1.
   *
   * The runner unions this with the current phase's tool calls and uses
   * the result for intention-phase criteria, so checks like
   * `usedTool('write_file', 'src/App.tsx')` pass on phase 5 even if the
   * file was actually written in phase 2 — the workspace state IS
   * cumulative across phases, and intention criteria should match.
   */
  pipelineToolCalls?: ToolCallRecord[]
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
  promptBreakdown?: PromptBreakdown
  /** Gateway quality signals from the turn's `data-usage` frame. */
  loopDetected?: boolean
  hitMaxTurns?: boolean
  responseEmpty?: boolean
  /** Agent-loop iteration count reported by the gateway for this turn. */
  gatewayIterations?: number
}

/**
 * Send a single turn to the agent via POST /agent/chat and parse the SSE
 * stream response (AI SDK UI Message Stream format).
 *
 * Timeout policy:
 * - Each fetch attempt is bounded by `config.timeoutMs` (per-attempt budget).
 * - On a *self-imposed* timeout we do NOT retry — the agent loop on the
 *   server is still iterating and another `POST /agent/chat` would queue
 *   behind it. We instead fire `POST /agent/stop` so the in-VM agent stops
 *   burning tokens, then return a synthetic empty response so the rest of
 *   the eval (scoring + workspace runtime checks) still runs against
 *   whatever the agent produced before the cap.
 * - We retry only on *transient* network/server errors (HTTP 5xx, 429,
 *   ECONNRESET, …) and only `MAX_TRANSIENT_RETRIES` times. The previous
 *   8-retry policy let a single misbehaving turn consume up to
 *   8 × timeoutMs (= 40 min at the default), dominating wall time.
 */
export async function sendTurn(
  messages: Array<{ role: string; parts: Array<{ type: string; text: string }> }>,
  config: EvalRunnerConfig,
): Promise<ParsedAgentResponse> {
  const MAX_TRANSIENT_RETRIES = 3
  const RETRY_DELAY = 3_000

  for (let attempt = 1; attempt <= MAX_TRANSIENT_RETRIES; attempt++) {
    const controller = new AbortController()
    let timedOut = false
    const timeout = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, config.timeoutMs)

    try {
      // The runtime rejects requests with a missing/empty chatSessionId
      // (see `chat-session-fallback-leak.test.ts`). The eval suite always
      // calls /agent/session/reset between evals which clears the `'chat'`
      // bucket, so reusing that key here matches the reset contract and
      // keeps each eval isolated.
      const body: Record<string, unknown> = { messages, chatSessionId: 'chat' }
      if (config.interactionMode) {
        body.interactionMode = config.interactionMode
      }
      if (config.agentMode) {
        body.agentMode = config.agentMode
      }

      const res = await fetch(config.agentEndpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Chat-Session-Id': 'chat',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      })

      if (!res.ok) {
        clearTimeout(timeout)
        const errBody = await res.text().catch(() => '(no body)')
        if (config.verbose) console.log(`      [sendTurn] HTTP ${res.status}: ${errBody.slice(0, 200)}`)
        if ((res.status >= 500 || res.status === 429) && attempt < MAX_TRANSIENT_RETRIES) {
          const delay = res.status === 503 ? 5_000 : RETRY_DELAY * attempt
          await Bun.sleep(delay)
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
      if (timedOut) {
        // Self-imposed timeout: stop the in-VM agent loop (best-effort)
        // and return whatever was streamed before the cap. Retrying the
        // same fetch would just queue behind the still-running turn.
        if (config.verbose) {
          console.log(`      [sendTurn] Hit ${config.timeoutMs}ms cap; stopping agent and returning partial.`)
        }
        await stopAgentTurn(config).catch(() => {})
        return emptyResponse(`[ERROR: turn exceeded ${config.timeoutMs}ms cap]`)
      }
      if (attempt < MAX_TRANSIENT_RETRIES && isRetryable(err)) {
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
  // 'timeout' / 'aborted' intentionally omitted — those are handled
  // explicitly above via the `timedOut` flag (we never retry self-imposed
  // timeouts because the agent is still running on the server).
  return ['rate_limit', 'overloaded', '529', '503', '502', 'econnreset']
    .some(k => msg.includes(k))
}

/**
 * Best-effort cancel of the agent's in-flight turn. Mirrors
 * `apps/api/src/routes/project-chat.ts`'s "Stop" path which posts to
 * `/agent/stop` so the gateway flips its `turnAbort` signal and tools
 * stop iterating. Failing here is fine — the worker itself will be
 * recycled at end of suite anyway.
 */
async function stopAgentTurn(config: EvalRunnerConfig): Promise<void> {
  const stopUrl = config.agentEndpoint.replace(/\/agent\/chat\/?$/, '/agent/stop')
  if (stopUrl === config.agentEndpoint) return // unrecognized endpoint shape
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), 5_000)
  try {
    await fetch(stopUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Chat-Session-Id': 'chat',
      },
      body: JSON.stringify({ chatSessionId: 'chat' }),
      signal: ctl.signal,
    })
  } finally {
    clearTimeout(t)
  }
}

function emptyResponse(text: string): ParsedAgentResponse {
  return {
    text,
    toolCalls: [],
    stepCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  }
}

/**
 * Parse AI SDK UI Message Stream SSE into structured data.
 * Handles the same event types as the runtime runner.
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
  let promptBreakdown: PromptBreakdown | undefined
  let loopDetected: boolean | undefined
  let hitMaxTurns: boolean | undefined
  let responseEmpty: boolean | undefined
  let gatewayIterations = 0

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
              // Capture gateway quality signals so evals can assert on them.
              // The gateway emits these on _lastTurnUsage (see gateway.ts).
              if (typeof u.loopDetected === 'boolean') loopDetected = u.loopDetected
              if (typeof u.hitMaxTurns === 'boolean') hitMaxTurns = u.hitMaxTurns
              if (typeof u.responseEmpty === 'boolean') responseEmpty = u.responseEmpty
              if (typeof u.iterations === 'number') gatewayIterations = u.iterations
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
              break
            case 'tool-input-delta':
              if (data.toolCallId in toolInputs) {
                toolInputs[data.toolCallId] += data.inputTextDelta || ''
              }
              break
            case 'tool-input-available': {
              const name = data.toolName || toolNames[data.toolCallId] || 'unknown'
              if (verbose) {
                const inputStr = JSON.stringify(data.input || {})
                console.log(`      Tool call: ${name}(${inputStr.length > 200 ? inputStr.slice(0, 200) + '…' : inputStr})`)
              }
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
                  if (verbose) {
                    const dur = toolCalls[i].durationMs ? ` (${toolCalls[i].durationMs}ms)` : ''
                    const outputStr = JSON.stringify(output)
                    const prefix = isError ? 'Tool error' : 'Tool response'
                    console.log(`      ${prefix}: ${toolCalls[i].name}${dur} → ${outputStr.length > 200 ? outputStr.slice(0, 200) + '…' : outputStr}`)
                  }
                  break
                }
              }
              break
            }
            case 'data-prompt-breakdown': {
              promptBreakdown = data.data || data
              if (verbose && promptBreakdown) {
                console.log(`      [SSE] Prompt breakdown: ${promptBreakdown.sections?.length} sections, ~${promptBreakdown.grandEstTokens?.toLocaleString()} est tokens`)
              }
              break
            }
            case 'error': {
              const errText = data.errorText || data.message || data.error || JSON.stringify(data)
              if (verbose) console.log(`      [SSE] ERROR event: ${errText}`)
              text += `[ERROR: ${errText}]`
              break
            }
            default:
              if (verbose && !['start-step', 'finish-step', 'finish'].includes(data.type)) {
                console.log(`      [SSE] Unhandled event: ${data.type}`)
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

  return { text, toolCalls, stepCount, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, promptBreakdown, loopDetected, hitMaxTurns, responseEmpty, gatewayIterations }
}

// ---------------------------------------------------------------------------
// Subagent tool call flattening
// ---------------------------------------------------------------------------

/**
 * Extract tool calls made by subagents from agent_spawn / agent_result outputs
 * and append them to the flat toolCalls array with viaSubagent=true.
 * This lets eval assertions check tools used inside subagents.
 */
function flattenSubagentToolCalls(toolCalls: ToolCallRecord[]): ToolCallRecord[] {
  const nested: ToolCallRecord[] = []
  for (const tc of toolCalls) {
    if (tc.name !== 'agent_spawn' && tc.name !== 'agent_result') continue
    const output = tc.output as any
    if (!output || typeof output !== 'object') continue

    const parts: any[] = output.parts || output.result?.parts
    if (!Array.isArray(parts)) continue

    for (const part of parts) {
      if (part?.type !== 'tool' || !part.tool?.toolName) continue
      nested.push({
        name: part.tool.toolName,
        input: part.tool.args ?? {},
        output: part.tool.result,
        error: part.tool.state === 'error',
        viaSubagent: true,
      })
    }
  }
  return nested
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

  if (p === 'unnecessary-clarification' || p === 'unnecessary-questions') {
    const questions = ['what kind', 'which one', 'do you want', 'would you prefer', 'could you clarify']
    return questions.some(q => responseText.toLowerCase().includes(q))
  }

  if (p.includes('no tool') || p.includes('zero tool')) {
    return toolCalls.length === 0
  }

  if (p.includes('delegated-trivial')) {
    return toolCalls.some(t => t.name === 'task' || t.name === 'agent_spawn')
  }

  if (p.includes('homework') && p.includes('prisma') && p.includes('over-engineer')) {
    const json = JSON.stringify(toolCalls).toLowerCase()
    return json.includes('prisma') && (json.includes('schema.prisma') || json.includes('model '))
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
  if (eval_.interactionMode && !cfg.interactionMode) {
    cfg.interactionMode = eval_.interactionMode
  }
  const startTime = Date.now()
  const errors: string[] = []

  let responseText = ''
  let toolCalls: ToolCallRecord[] = []
  let finalTurnToolCalls: ToolCallRecord[] = []
  const perTurnToolCalls: ToolCallRecord[][] = []
  let stepCount = 0
  let inputTokens = 0
  let outputTokens = 0
  let cacheReadTokens = 0
  let cacheWriteTokens = 0
  let promptBreakdown: PromptBreakdown | undefined
  // Gateway quality signals from the final evaluated turn.
  let loopDetected = false
  let hitMaxTurns = false
  let responseEmpty: boolean | undefined
  let gatewayIterations = 0

  const askUserResponseQueue = [...(eval_.askUserResponses ?? [])]

  function accumulate(resp: ParsedAgentResponse) {
    stepCount += resp.stepCount
    inputTokens += resp.inputTokens
    outputTokens += resp.outputTokens
    cacheReadTokens += resp.cacheReadTokens
    cacheWriteTokens += resp.cacheWriteTokens
    if (!promptBreakdown && resp.promptBreakdown) promptBreakdown = resp.promptBreakdown
  }

  function responseHasAskUser(resp: ParsedAgentResponse): boolean {
    return resp.toolCalls.some(tc => tc.name === 'ask_user')
  }

  /**
   * After an LLM-generated response, check if the agent called ask_user.
   * If so and we have queued responses, send the next one as a follow-up
   * user message and return the execution response. Repeats up to maxFollowUps
   * times in case the agent asks again.
   */
  async function handleAskUserFollowUps(
    messages: Array<{ role: string; parts: Array<{ type: string; text: string }> }>,
    resp: ParsedAgentResponse,
  ): Promise<ParsedAgentResponse | null> {
    const MAX_FOLLOW_UPS = 3
    let current = resp
    let lastExecResp: ParsedAgentResponse | null = null

    for (let f = 0; f < MAX_FOLLOW_UPS; f++) {
      if (!responseHasAskUser(current) || askUserResponseQueue.length === 0) break
      const followUp = askUserResponseQueue.shift()!
      if (cfg.verbose) console.log(`      [ask_user] Auto-responding (${f + 1}): ${followUp.slice(0, 80)}...`)
      messages.push({ role: 'user', parts: [{ type: 'text', text: followUp }] })
      const execResp = await sendTurn(messages, cfg)
      messages.push({ role: 'assistant', parts: [{ type: 'text', text: execResp.text }] })
      toolCalls.push(...execResp.toolCalls)
      perTurnToolCalls.push(execResp.toolCalls)
      accumulate(execResp)
      lastExecResp = execResp
      current = execResp
    }
    return lastExecResp
  }

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
            messages.push({ role: 'assistant', parts: [{ type: 'text', text: nextTurn.content }] })
            i++
          } else {
            try {
              const resp = await sendTurn(messages, cfg)
              messages.push({ role: 'assistant', parts: [{ type: 'text', text: resp.text }] })
              toolCalls.push(...resp.toolCalls)
              perTurnToolCalls.push(resp.toolCalls)
              accumulate(resp)

              // If the agent asked clarifying questions, send eval-defined responses
              try {
                await handleAskUserFollowUps(messages, resp)
              } catch (e: any) {
                errors.push(`ask_user follow-up error: ${e.message}`)
              }
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
    perTurnToolCalls.push(response.toolCalls)
    accumulate(response)
    loopDetected = !!response.loopDetected
    hitMaxTurns = !!response.hitMaxTurns
    responseEmpty = response.responseEmpty
    gatewayIterations = response.gatewayIterations ?? gatewayIterations

    // Handle ask_user on the final turn too
    try {
      const execResp = await handleAskUserFollowUps(messages, response)
      if (execResp) {
        responseText = execResp.text
        finalTurnToolCalls = execResp.toolCalls
        loopDetected = !!execResp.loopDetected
        hitMaxTurns = !!execResp.hitMaxTurns
        responseEmpty = execResp.responseEmpty
        gatewayIterations = execResp.gatewayIterations ?? gatewayIterations
      }
    } catch (e: any) {
      errors.push(`ask_user follow-up error: ${e.message}`)
    }
  } catch (err: any) {
    errors.push(err.message)
  }

  // Flatten subagent tool calls so eval assertions can see tools used inside
  // agent_spawn / agent_result (e.g. usedToolAnywhere checks).
  const nestedCalls = flattenSubagentToolCalls(toolCalls)
  if (nestedCalls.length > 0) {
    toolCalls.push(...nestedCalls)
    const nestedFinal = flattenSubagentToolCalls(finalTurnToolCalls)
    if (nestedFinal.length > 0) finalTurnToolCalls.push(...nestedFinal)
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
    gatewayIterations: gatewayIterations || undefined,
    tokens: { input: inputTokens, output: outputTokens, cacheRead: cacheReadTokens, cacheWrite: cacheWriteTokens, total: totalTokens },
    timing: { totalMs: durationMs },
  }

  // Cumulative pipeline tool calls. For pipeline phase 1 (or standalone)
  // `cfg.pipelineToolCalls` is undefined, so this is just `toolCalls`. For
  // phase 2+ this folds in everything the same pipeline did before, so
  // intention-phase criteria correctly see the work that earlier phases
  // did in the SAME workspace. See `EvalRunnerConfig.pipelineToolCalls`.
  const pipelineCumulativeToolCalls = cfg.pipelineToolCalls && cfg.pipelineToolCalls.length > 0
    ? [...cfg.pipelineToolCalls, ...toolCalls]
    : undefined

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
    perTurnToolCalls,
    pipelineToolCalls: pipelineCumulativeToolCalls,
    criteriaResults: [],
    triggeredAntiPatterns: [],
    timing: { startTime, endTime, durationMs },
    metrics,
    errors: errors.length > 0 ? errors : undefined,
    workspaceDir: cfg.workspaceDir,
    promptBreakdown,
    loopDetected,
    hitMaxTurns,
    responseEmpty,
  }

  // For intention criteria we transparently swap `toolCalls` to the
  // cumulative pipeline view so existing helpers (`usedTool`,
  // `usedToolAnywhere`, `toolCallsJson`, etc.) report what the pipeline
  // collectively did, not just what *this phase* did. Execution criteria
  // continue to see only the current phase's calls because they're
  // testing this turn's behavior, not the pipeline's cumulative state.
  const intentionEvalBase: EvalResult = pipelineCumulativeToolCalls
    ? { ...evalBase, toolCalls: pipelineCumulativeToolCalls }
    : evalBase

  let totalScore = 0
  let intentionScore = 0
  let intentionMax = 0
  let executionScore = 0
  let executionMax = 0
  const criteriaResults: CriterionResult[] = []

  for (const criterion of eval_.validationCriteria) {
    try {
      const phase = criterion.phase || 'intention'
      const baseForCriterion = phase === 'intention' ? intentionEvalBase : evalBase
      const passed = criterion.validate(baseForCriterion)
      const points = passed ? criterion.points : 0
      totalScore += points

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

  const toolErrorCount = toolCalls.filter(t => t.error).length
  const toolErrorPenaltyRaw = toolErrorCount * 2
  const toolErrorPenalty = Math.min(toolErrorPenaltyRaw, Math.ceil(eval_.maxScore * 0.2))
  const antiPenalty = triggeredAntiPatterns.length * 10
  const finalScore = Math.max(0, totalScore - antiPenalty - toolErrorPenalty)
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
