/**
 * Agent Evaluation Runner
 *
 * Executes evals against the Shogo agent and collects results.
 */

import type {
  AgentEval,
  EvalResult,
  EvalSuiteResult,
  EvalCategory,
  CategorySummary,
  CriterionResult,
  ToolCall,
  EvalMetrics,
  GlobalPenalty,
} from './types'
import { evaluateToolCorrectness, extractSelectedTemplate, ranForbiddenRuntimeCommands, extractForbiddenCommands } from './validators'

/**
 * Configuration for the eval runner
 */
export interface EvalRunnerConfig {
  /** API endpoint for the agent */
  agentEndpoint?: string
  /** Timeout for each eval in ms */
  timeoutMs?: number
  /** Whether to run in verbose mode */
  verbose?: boolean
  /** Number of retries on failure */
  retries?: number
  /** Project directory for this eval (used by parallel workers) */
  projectDir?: string
}

const DEFAULT_CONFIG: Required<EvalRunnerConfig> = {
  agentEndpoint: 'http://localhost:3002/api/chat',
  timeoutMs: 300000, // 5 minutes default for complex tasks
  verbose: false,
  retries: 0,
  projectDir: '/tmp/shogo-eval-test',
}

/**
 * Mock agent response for testing the eval framework
 */
export interface MockAgentResponse {
  text: string
  toolCalls: ToolCall[]
}

/**
 * Run a single eval
 */
export async function runEval(
  eval_: AgentEval,
  config: EvalRunnerConfig = {},
  mockResponse?: MockAgentResponse
): Promise<EvalResult> {
  const cfg = { ...DEFAULT_CONFIG, ...config }
  const startTime = Date.now()

  let responseText = ''
  let toolCalls: ToolCall[] = []
  let errors: string[] = []
  let parsedMetrics = {
    stepCount: 0,
    toolCallTimestamps: [] as number[],
    inputTokens: 0,
    outputTokens: 0,
  }

  try {
    if (mockResponse) {
      // Use mock response for testing
      responseText = mockResponse.text
      toolCalls = mockResponse.toolCalls
    } else {
      // Make actual API call
      const response = await callAgent(eval_, cfg)
      responseText = response.text
      toolCalls = response.toolCalls
      parsedMetrics = response.metrics
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error))
  }

  const endTime = Date.now()
  const durationMs = endTime - startTime

  // Calculate timing metrics
  const firstToolCallMs = parsedMetrics.toolCallTimestamps.length > 0 
    ? parsedMetrics.toolCallTimestamps[0] 
    : null
  
  let avgToolCallMs: number | null = null
  if (parsedMetrics.toolCallTimestamps.length > 1) {
    const intervals: number[] = []
    for (let i = 1; i < parsedMetrics.toolCallTimestamps.length; i++) {
      intervals.push(parsedMetrics.toolCallTimestamps[i] - parsedMetrics.toolCallTimestamps[i - 1])
    }
    avgToolCallMs = intervals.reduce((a, b) => a + b, 0) / intervals.length
  }

  // Estimate tokens if not provided by API
  // Claude uses ~4 chars per token on average for English text
  // Input: prompt + tool results, Output: response + tool calls
  let inputTokens = parsedMetrics.inputTokens
  let outputTokens = parsedMetrics.outputTokens
  
  if (inputTokens === 0 && outputTokens === 0) {
    // Estimate based on content
    const inputChars = eval_.input.length + 
      toolCalls.reduce((sum, tc) => sum + JSON.stringify(tc.result || '').length, 0)
    const outputChars = responseText.length + 
      toolCalls.reduce((sum, tc) => sum + JSON.stringify(tc.params).length, 0)
    
    inputTokens = Math.round(inputChars / 4)
    outputTokens = Math.round(outputChars / 4)
  }

  // Build metrics object
  const metrics: EvalMetrics = {
    toolCallCount: toolCalls.length,
    stepCount: parsedMetrics.stepCount,
    tokens: {
      input: inputTokens,
      output: outputTokens,
      total: inputTokens + outputTokens,
    },
    timing: {
      totalMs: durationMs,
      firstToolCallMs,
      avgToolCallMs,
    },
  }

  // Debug: log tool calls if verbose
  if (cfg.verbose) {
    console.log(`  [Debug] Tool calls (${toolCalls.length} total):`)
    if (toolCalls.length === 0) {
      console.log(`    (none captured)`)
    }
    for (const tc of toolCalls) {
      console.log(`    - ${tc.name}: ${JSON.stringify(tc.params)}`)
    }
  }

  // Evaluate criteria
  const criteriaResults: CriterionResult[] = []
  let totalScore = 0

  const evalResultBase: EvalResult = {
    eval: eval_,
    passed: false,
    score: 0,
    maxScore: eval_.maxScore,
    percentage: 0,
    toolCalls,
    responseText,
    criteriaResults: [],
    triggeredAntiPatterns: [],
    timing: {
      startTime,
      endTime,
      durationMs,
    },
    metrics,
    errors: errors.length > 0 ? errors : undefined,
    projectDir: cfg.projectDir,  // Pass project directory for file validation
  }

  // Track scores by phase
  let intentionScore = 0
  let intentionMaxScore = 0
  let executionScore = 0
  let executionMaxScore = 0

  for (const criterion of eval_.validationCriteria) {
    try {
      const passed = criterion.validate(evalResultBase)
      const pointsEarned = passed ? criterion.points : 0
      totalScore += pointsEarned

      // Track by phase (default to 'intention' if not specified)
      const phase = criterion.phase || 'intention'
      if (phase === 'intention') {
        intentionScore += pointsEarned
        intentionMaxScore += criterion.points
      } else {
        executionScore += pointsEarned
        executionMaxScore += criterion.points
      }

      if (cfg.verbose) {
        const phaseLabel = phase === 'execution' ? '⚙️' : '🎯'
        console.log(`    ${passed ? '✓' : '✗'} ${phaseLabel} ${criterion.description}: ${pointsEarned}/${criterion.points}`)
      }

      criteriaResults.push({
        criterion,
        passed,
        pointsEarned,
      })
    } catch (error) {
      if (cfg.verbose) {
        console.log(`    ✗ ${criterion.description}: ERROR - ${error}`)
      }
      criteriaResults.push({
        criterion,
        passed: false,
        pointsEarned: 0,
      })
      // Still track max score for failed criteria
      const phase = criterion.phase || 'intention'
      if (phase === 'intention') {
        intentionMaxScore += criterion.points
      } else {
        executionMaxScore += criterion.points
      }
    }
  }

  // Check anti-patterns
  const triggeredAntiPatterns: string[] = []
  if (eval_.antiPatterns) {
    for (const pattern of eval_.antiPatterns) {
      if (checkAntiPattern(pattern, responseText, toolCalls)) {
        triggeredAntiPatterns.push(pattern)
      }
    }
  }

  // Calculate score after anti-patterns
  const antiPatternPenalty = triggeredAntiPatterns.length * 10
  let finalScore = Math.max(0, totalScore - antiPatternPenalty)

  // Apply global penalties (platform-level quality signals that apply to ALL evals)
  const globalPenalties: GlobalPenalty[] = []

  // Global penalty: Forbidden runtime commands (5% score reduction)
  // If the agent runs vite dev, bun run build, pkill, etc. during ANY eval,
  // something is wrong with the platform — these should never be needed.
  if (ranForbiddenRuntimeCommands(toolCalls)) {
    const forbiddenCmds = extractForbiddenCommands(toolCalls)
    const RUNTIME_PENALTY_PERCENT = 5
    const pointsDeducted = Math.round((RUNTIME_PENALTY_PERCENT / 100) * eval_.maxScore)
    
    globalPenalties.push({
      id: 'forbidden-runtime-commands',
      description: `Ran forbidden runtime commands (-${RUNTIME_PENALTY_PERCENT}%)`,
      percentagePenalty: RUNTIME_PENALTY_PERCENT,
      pointsDeducted,
      details: forbiddenCmds,
    })

    finalScore = Math.max(0, finalScore - pointsDeducted)

    if (cfg.verbose) {
      console.log(`    ⚠️ Global penalty: Forbidden runtime commands (-${pointsDeducted} pts / -${RUNTIME_PENALTY_PERCENT}%)`)
      for (const cmd of forbiddenCmds) {
        console.log(`       → ${cmd}`)
      }
    }
  }

  const percentage = (finalScore / eval_.maxScore) * 100
  const passed = percentage >= 70 && triggeredAntiPatterns.length === 0

  // Calculate phase scores
  const phaseScores = {
    intention: {
      score: intentionScore,
      maxScore: intentionMaxScore,
      percentage: intentionMaxScore > 0 ? (intentionScore / intentionMaxScore) * 100 : 100,
    },
    execution: {
      score: executionScore,
      maxScore: executionMaxScore,
      percentage: executionMaxScore > 0 ? (executionScore / executionMaxScore) * 100 : 100,
    },
  }

  if (cfg.verbose && (intentionMaxScore > 0 || executionMaxScore > 0)) {
    console.log(`    📊 Intention: ${intentionScore}/${intentionMaxScore} (${phaseScores.intention.percentage.toFixed(0)}%)`)
    console.log(`    📊 Execution: ${executionScore}/${executionMaxScore} (${phaseScores.execution.percentage.toFixed(0)}%)`)
  }

  return {
    ...evalResultBase,
    passed,
    score: finalScore,
    percentage,
    criteriaResults,
    triggeredAntiPatterns,
    phaseScores,
    globalPenalties: globalPenalties.length > 0 ? globalPenalties : undefined,
  }
}

/**
 * Run a suite of evals
 */
export async function runEvalSuite(
  name: string,
  evals: AgentEval[],
  config: EvalRunnerConfig = {}
): Promise<EvalSuiteResult> {
  const cfg = { ...DEFAULT_CONFIG, ...config }
  const results: EvalResult[] = []

  for (let i = 0; i < evals.length; i++) {
    const eval_ = evals[i]
    const startTime = Date.now()
    
    if (cfg.verbose) {
      console.log(`\n[${i + 1}/${evals.length}] Running eval: ${eval_.name}`)
      console.log(`  Started at: ${new Date().toISOString()}`)
      console.log(`  Timeout: ${(cfg.timeoutMs / 1000 / 60).toFixed(1)} minutes`)
    }

    const result = await runEval(eval_, cfg)
    results.push(result)

    const durationSec = ((Date.now() - startTime) / 1000).toFixed(1)
    if (cfg.verbose) {
      console.log(
        `  ${result.passed ? '✓' : '✗'} Score: ${result.score}/${result.maxScore} (${result.percentage.toFixed(1)}%) in ${durationSec}s`
      )
    }
  }

  // Calculate summary
  const passed = results.filter((r) => r.passed).length
  const totalPoints = results.reduce((sum, r) => sum + r.score, 0)
  const maxPoints = results.reduce((sum, r) => sum + r.maxScore, 0)

  // Calculate by category - dynamically based on what's in results
  const allCategories: EvalCategory[] = [
    'template-selection',
    'tool-usage', 
    'multi-turn',
    'edge-cases',
    // Business user categories
    'business-language',
    'business-logic-confusion',
    'multi-turn-coherence',
    'relationship-changes',
    'graceful-degradation',
    'error-recovery',
    'conditional-logic',
    'migration-concerns',
    'framework-specific',
    // Runtime safety
    'runtime-safety',
  ]
  
  const byCategory = {} as Record<EvalCategory, CategorySummary>
  for (const category of allCategories) {
    byCategory[category] = calculateCategorySummary(results, category)
  }

  return {
    name,
    timestamp: new Date(),
    results,
    summary: {
      total: evals.length,
      passed,
      failed: evals.length - passed,
      passRate: (passed / evals.length) * 100,
      averageScore: totalPoints / evals.length,
      totalPoints,
      maxPoints,
    },
    byCategory,
  }
}

/**
 * Calculate summary for a specific category
 */
function calculateCategorySummary(
  results: EvalResult[],
  category: EvalCategory
): CategorySummary {
  const categoryResults = results.filter((r) => r.eval.category === category)
  if (categoryResults.length === 0) {
    return { total: 0, passed: 0, failed: 0, passRate: 0, averageScore: 0 }
  }

  const passed = categoryResults.filter((r) => r.passed).length
  const totalScore = categoryResults.reduce((sum, r) => sum + r.score, 0)

  return {
    total: categoryResults.length,
    passed,
    failed: categoryResults.length - passed,
    passRate: (passed / categoryResults.length) * 100,
    averageScore: totalScore / categoryResults.length,
  }
}

/**
 * Call the agent API
 * 
 * For multi-turn evals with conversationHistory, we execute each turn sequentially
 * to build up real project state before running the final eval turn.
 */
async function callAgent(
  eval_: AgentEval,
  config: Required<EvalRunnerConfig>
): Promise<ParsedAgentResponse> {
  // Track accumulated messages for context
  const messages: Array<{ role: string; content: string }> = []
  
  // If there's conversation history, execute each user turn to build real state
  if (eval_.conversationHistory && eval_.conversationHistory.length > 0) {
    if (config.verbose) {
      console.log(`    [Multi-turn] Executing ${eval_.conversationHistory.length} history turns first...`)
    }
    
    for (let i = 0; i < eval_.conversationHistory.length; i++) {
      const turn = eval_.conversationHistory[i]
      
      if (turn.role === 'user') {
        // Execute user turn and wait for response
        messages.push({ role: 'user', content: turn.content })
        
        if (config.verbose) {
          console.log(`    [History ${i + 1}] User: "${turn.content.slice(0, 50)}..."`)
        }
        
        try {
          const historyResponse = await executeAgentTurn(messages, config)
          // Add assistant response to context
          messages.push({ role: 'assistant', content: historyResponse.text })
          
          if (config.verbose) {
            console.log(`    [History ${i + 1}] Assistant responded (${historyResponse.toolCalls.length} tools)`)
          }
        } catch (error) {
          if (config.verbose) {
            console.log(`    [History ${i + 1}] Error: ${error}`)
          }
          // Continue with next turn even if one fails
        }
      } else if (turn.role === 'assistant') {
        // For assistant turns in history, use the provided content
        // (this allows tests to control what the assistant "said")
        messages.push({ role: 'assistant', content: turn.content })
      }
    }
    
    if (config.verbose) {
      console.log(`    [Multi-turn] History complete, now executing final turn...`)
    }
  }

  // Add the final eval input
  messages.push({ role: 'user', content: eval_.input })
  
  // Execute the final turn and return its response
  return executeAgentTurn(messages, config)
}

/**
 * Execute a single agent turn with the given message history
 * Includes retry logic for transient API errors
 */
async function executeAgentTurn(
  messages: Array<{ role: string; content: string }>,
  config: Required<EvalRunnerConfig>
): Promise<ParsedAgentResponse> {
  const MAX_RETRIES = 3
  const RETRY_DELAY_MS = 3000
  
  // Errors that should trigger a retry
  const RETRYABLE_ERRORS = [
    'rate_limit',
    'overloaded', 
    'api_error',
    'invalid_api_key',
    'connection',
    'timeout',
    'ECONNRESET',
    'ETIMEDOUT',
    'aborted',
    '529',
    '503',
    '502',
  ]
  
  const isRetryableError = (error: any, responseText?: string): boolean => {
    const errorStr = String(error?.message || error || '').toLowerCase()
    const textStr = (responseText || '').toLowerCase()
    return RETRYABLE_ERRORS.some(e => 
      errorStr.includes(e.toLowerCase()) || textStr.includes(e.toLowerCase())
    )
  }
  
  let lastError: any = null
  
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), config.timeoutMs)

    try {
      const response = await fetch(config.agentEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages }),
        signal: controller.signal,
      })

      if (!response.ok) {
        clearTimeout(timeoutId)
        const errorMsg = `Agent API returned ${response.status}`
        
        // Check if retryable HTTP status
        if ((response.status >= 500 || response.status === 429) && attempt < MAX_RETRIES) {
          const delay = RETRY_DELAY_MS * attempt
          if (config.verbose) {
            console.warn(`    [Retry] HTTP ${response.status} on attempt ${attempt}/${MAX_RETRIES}, waiting ${delay}ms...`)
          }
          await new Promise(resolve => setTimeout(resolve, delay))
          continue
        }
        
        throw new Error(errorMsg)
      }

      // Parse streaming response
      const result = await parseAgentStreamingResponse(response, controller, config.verbose)
      clearTimeout(timeoutId)
      
      // Check if the response itself contains an API error
      if (result.text && isRetryableError(null, result.text) && attempt < MAX_RETRIES) {
        const delay = RETRY_DELAY_MS * attempt
        if (config.verbose) {
          console.warn(`    [Retry] API error in response on attempt ${attempt}/${MAX_RETRIES}: "${result.text.slice(0, 50)}..."`)
          console.warn(`    [Retry] Waiting ${delay}ms before retry...`)
        }
        await new Promise(resolve => setTimeout(resolve, delay))
        continue
      }
      
      return result
    } catch (error: any) {
      clearTimeout(timeoutId)
      lastError = error
      
      if (isRetryableError(error) && attempt < MAX_RETRIES) {
        const delay = RETRY_DELAY_MS * attempt
        if (config.verbose) {
          console.warn(`    [Retry] Error on attempt ${attempt}/${MAX_RETRIES}: ${error.message}`)
          console.warn(`    [Retry] Waiting ${delay}ms before retry...`)
        }
        await new Promise(resolve => setTimeout(resolve, delay))
        continue
      }
      
      throw error
    }
  }
  
  // Max retries exceeded
  throw lastError || new Error('Max retries exceeded')
}

/**
 * Parse agent streaming response using AI SDK UI Message Stream format.
 * 
 * The AI SDK toUIMessageStreamResponse() produces SSE with these event types:
 * - start: Stream started
 * - start-step: New agent step started
 * - text-start: Text block started (id)
 * - text-delta: Text content (id, delta)
 * - text-end: Text block ended (id)
 * - tool-input-start: Tool call started (toolCallId, toolName)
 * - tool-input-delta: Tool input chunk (toolCallId, inputTextDelta)
 * - tool-input-available: Complete tool input (toolCallId, toolName, input)
 * - tool-result: Tool execution result (toolCallId, result)
 * - finish-step: Agent step completed
 * - finish: Stream completed
 * - [DONE]: SSE stream end marker
 */
/**
 * Parsed response from agent streaming
 */
interface ParsedAgentResponse {
  text: string
  toolCalls: ToolCall[]
  metrics: {
    stepCount: number
    toolCallTimestamps: number[]
    inputTokens: number
    outputTokens: number
  }
}

async function parseAgentStreamingResponse(
  response: Response,
  controller: AbortController,
  verbose: boolean = false
): Promise<ParsedAgentResponse> {
  const toolCalls: ToolCall[] = []
  const toolInputs: Record<string, string> = {}
  const toolNames: Record<string, string> = {}
  let responseText = ''
  let stepCount = 0
  let lastLogTime = Date.now()
  const startTime = Date.now()
  const toolCallTimestamps: number[] = []
  let inputTokens = 0
  let outputTokens = 0
  const LOG_INTERVAL_MS = 5000 // Log progress every 5 seconds

  const reader = response.body?.getReader()
  if (!reader) {
    throw new Error('No response body')
  }

  const decoder = new TextDecoder()
  let buffer = ''

  const logProgress = (message: string) => {
    if (verbose) {
      const elapsed = ((Date.now() - lastLogTime) / 1000).toFixed(1)
      console.log(`    [${elapsed}s] ${message}`)
    }
  }

  try {
    while (true) {
      const { done, value } = await reader.read()
      
      if (done) {
        if (verbose) console.log(`    [Stream] Done - ${toolCalls.length} tool calls captured`)
        break
      }

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() || '' // Keep incomplete line in buffer

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue
        
        const dataStr = line.slice(6).trim()
        
        // Check for end of stream
        if (dataStr === '[DONE]') {
          if (verbose) console.log(`    [Stream] Received [DONE]`)
          return { 
            text: responseText, 
            toolCalls,
            metrics: { stepCount, toolCallTimestamps, inputTokens, outputTokens }
          }
        }

        // Skip keepalive/empty data
        if (!dataStr || dataStr === '{}') continue

        try {
          const data = JSON.parse(dataStr)
          
          switch (data.type) {
            // Step tracking
            case 'start-step':
              stepCount++
              logProgress(`Step ${stepCount} started`)
              break
              
            case 'finish-step':
              logProgress(`Step ${stepCount} finished`)
              break
              
            // Token usage (AI SDK provides this in finish events)
            case 'finish':
              if (data.usage) {
                inputTokens += data.usage.promptTokens || data.usage.inputTokens || 0
                outputTokens += data.usage.completionTokens || data.usage.outputTokens || 0
              }
              break
              
            // Text handling
            case 'text-delta':
              responseText += data.delta || ''
              break
            case 'text':
              responseText += data.content || ''
              break
              
            // Tool call handling - AI SDK UI Message Stream format
            case 'tool-input-start':
              toolInputs[data.toolCallId] = ''
              toolNames[data.toolCallId] = data.toolName || 'unknown'
              toolCallTimestamps.push(Date.now() - startTime)
              logProgress(`Tool started: ${data.toolName}`)
              break
              
            case 'tool-input-delta':
              if (data.toolCallId in toolInputs) {
                toolInputs[data.toolCallId] += data.inputTextDelta || ''
              }
              break
              
            case 'tool-input-available': {
              // Complete tool input received
              const toolCallId = data.toolCallId
              const toolName = data.toolName || toolNames[toolCallId] || 'unknown'
              const input = data.input || {}
              
              // Normalize MCP tool names to our expected format
              // MCP tools come as: mcp__wavesmith__template_copy -> template.copy
              let normalizedName = toolName
              if (toolName.startsWith('mcp__wavesmith__template_')) {
                normalizedName = toolName.replace('mcp__wavesmith__template_', 'template.')
              } else if (toolName.startsWith('mcp__') && toolName.includes('__template_')) {
                // Handle other MCP server names too
                const match = toolName.match(/mcp__\w+__template_(\w+)/)
                if (match) {
                  normalizedName = `template.${match[1]}`
                }
              }
              
              logProgress(`Tool input ready: ${normalizedName}`)
              
              // Map tool names to our expected format
              // The Shogo agent uses template.list and template.copy
              if (normalizedName === 'template.list' || normalizedName === 'template.copy') {
                toolCalls.push({
                  name: normalizedName,
                  params: input,
                  timestamp: Date.now(),
                })
              }
              // Virtual tools execute format (used by some agents)
              else if (toolName === 'mcp__virtual-tools__execute' && input.operations) {
                for (const op of input.operations) {
                  if (op.domain && op.action) {
                    toolCalls.push({
                      name: `${op.domain}.${op.action}`,
                      params: op.data || {},
                      timestamp: Date.now(),
                    })
                  }
                }
              }
              // Other tools (Bash, Read, etc.) - record them too
              else {
                toolCalls.push({
                  name: toolName,
                  params: input,
                  timestamp: Date.now(),
                })
              }
              break
            }
            
            case 'tool-output-available':
              logProgress(`Tool output received`)
              break
              
            case 'tool-result':
              // Update the most recent matching tool call with result
              for (let i = toolCalls.length - 1; i >= 0; i--) {
                if (!toolCalls[i].result) {
                  toolCalls[i].result = data.result
                  break
                }
              }
              logProgress(`Tool result captured (${toolCalls.length} total)`)
              break
              
            // Legacy format support
            case 'tool_call':
              toolCalls.push({
                name: data.name,
                params: data.params || {},
                result: data.result,
                timestamp: Date.now(),
              })
              break
          }
        } catch {
          // Skip non-JSON lines (keepalive messages, etc.)
        }
      }
      
      // Periodic progress log
      if (verbose && Date.now() - lastLogTime > LOG_INTERVAL_MS) {
        console.log(`    [Progress] ${toolCalls.length} tool calls, ${responseText.length} chars text`)
        lastLogTime = Date.now()
      }
    }
  } finally {
    reader.releaseLock()
  }

  return { 
    text: responseText, 
    toolCalls,
    metrics: { stepCount, toolCallTimestamps, inputTokens, outputTokens }
  }
}

/**
 * Check if an anti-pattern was triggered
 */
function checkAntiPattern(
  pattern: string,
  responseText: string,
  toolCalls: ToolCall[]
): boolean {
  const patternLower = pattern.toLowerCase()

  // Check for specific anti-patterns
  if (patternLower.includes('unnecessary question') || patternLower.includes('clarif')) {
    // Check if asked when shouldn't have
    const questionWords = ['what kind', 'which one', 'do you want', 'would you prefer']
    return questionWords.some((q) => responseText.toLowerCase().includes(q))
  }

  if (patternLower.includes('wrong template')) {
    // Would need expected template to check this
    return false
  }

  if (patternLower.includes('manual command') || patternLower.includes('bun install')) {
    return toolCalls.some(
      (t) =>
        (t.name === 'bash' || t.name === 'shell') &&
        String(t.params?.command || '').includes('install')
    )
  }

  if (patternLower.includes('custom code')) {
    // Check if wrote files without using template
    const hasTemplateCopy = toolCalls.some((t) => t.name === 'template.copy')
    const hasFileWrite = toolCalls.some(
      (t) => t.name === 'write' || t.name === 'edit'
    )
    return hasFileWrite && !hasTemplateCopy
  }

  // Forbidden runtime commands: restart vite, run builds, kill processes
  if (
    patternLower.includes('restart') ||
    patternLower.includes('vite') ||
    patternLower.includes('kill') ||
    patternLower.includes('forbidden runtime') ||
    patternLower.includes('build command') ||
    patternLower.includes('dev server')
  ) {
    return ranForbiddenRuntimeCommands(toolCalls)
  }

  return false
}

/**
 * Format eval results as a report
 */
export function formatEvalReport(suiteResult: EvalSuiteResult): string {
  const lines: string[] = []

  lines.push(`\n${'='.repeat(70)}`)
  lines.push(`EVAL SUITE: ${suiteResult.name}`)
  lines.push(`${'='.repeat(70)}`)
  lines.push(`Run at: ${suiteResult.timestamp.toISOString()}`)
  lines.push('')

  // Summary
  lines.push('SUMMARY')
  lines.push('-'.repeat(50))
  lines.push(`Total:       ${suiteResult.summary.total}`)
  lines.push(`Passed:      ${suiteResult.summary.passed}`)
  lines.push(`Failed:      ${suiteResult.summary.failed}`)
  lines.push(`Pass Rate:   ${suiteResult.summary.passRate.toFixed(1)}%`)
  lines.push(`Avg Score:   ${suiteResult.summary.averageScore.toFixed(1)}`)
  lines.push('')

  // Intention vs Execution breakdown
  const resultsWithPhases = suiteResult.results.filter(r => r.phaseScores)
  if (resultsWithPhases.length > 0) {
    const avgIntention = resultsWithPhases.reduce((sum, r) => 
      sum + (r.phaseScores?.intention.percentage || 0), 0) / resultsWithPhases.length
    const avgExecution = resultsWithPhases.reduce((sum, r) => 
      sum + (r.phaseScores?.execution.percentage || 0), 0) / resultsWithPhases.length
    
    lines.push('INTENTION vs EXECUTION')
    lines.push('-'.repeat(50))
    lines.push(`🎯 Intention:  ${avgIntention.toFixed(1)}% (understood the request)`)
    lines.push(`⚙️  Execution:  ${avgExecution.toFixed(1)}% (code actually works)`)
    lines.push('')
  }

  // Aggregate metrics
  const totalToolCalls = suiteResult.results.reduce((sum, r) => sum + r.metrics.toolCallCount, 0)
  const totalTokens = suiteResult.results.reduce((sum, r) => sum + r.metrics.tokens.total, 0)
  const totalTime = suiteResult.results.reduce((sum, r) => sum + r.metrics.timing.totalMs, 0)
  const avgToolCalls = totalToolCalls / suiteResult.results.length
  const avgTokens = totalTokens / suiteResult.results.length
  const avgTime = totalTime / suiteResult.results.length

  lines.push('AGGREGATE METRICS')
  lines.push('-'.repeat(50))
  lines.push(`Total Tool Calls:    ${totalToolCalls}`)
  lines.push(`Avg Tool Calls:      ${avgToolCalls.toFixed(1)} per eval`)
  lines.push(`Total Tokens:        ${totalTokens > 0 ? totalTokens.toLocaleString() : 'N/A'}`)
  lines.push(`Avg Tokens:          ${totalTokens > 0 ? avgTokens.toFixed(0) : 'N/A'} per eval`)
  lines.push(`Total Time:          ${(totalTime / 1000).toFixed(1)}s`)
  lines.push(`Avg Time:            ${(avgTime / 1000).toFixed(1)}s per eval`)
  lines.push('')

  // By category
  lines.push('BY CATEGORY')
  lines.push('-'.repeat(50))
  for (const [category, summary] of Object.entries(suiteResult.byCategory)) {
    if (summary.total > 0) {
      lines.push(
        `${category.padEnd(20)} ${summary.passed}/${summary.total} (${summary.passRate.toFixed(0)}%)`
      )
    }
  }
  lines.push('')

  // Global penalties summary
  const evalsWithPenalties = suiteResult.results.filter(r => r.globalPenalties && r.globalPenalties.length > 0)
  if (evalsWithPenalties.length > 0) {
    lines.push('GLOBAL PENALTIES')
    lines.push('-'.repeat(50))
    lines.push(`Evals penalized:  ${evalsWithPenalties.length}/${suiteResult.results.length}`)
    const totalPenaltyPoints = evalsWithPenalties.reduce((sum, r) => 
      sum + (r.globalPenalties?.reduce((s, p) => s + p.pointsDeducted, 0) || 0), 0)
    lines.push(`Total points lost: ${totalPenaltyPoints}`)
    for (const result of evalsWithPenalties) {
      for (const penalty of result.globalPenalties!) {
        lines.push(`  ⚠️ ${result.eval.name}: ${penalty.description}`)
        if (penalty.details?.length) {
          for (const detail of penalty.details) {
            lines.push(`     → ${detail}`)
          }
        }
      }
    }
    lines.push('')
  }

  // Individual results with metrics
  lines.push('INDIVIDUAL RESULTS')
  lines.push('-'.repeat(50))
  lines.push('Name'.padEnd(30) + 'Score'.padEnd(10) + 'Intent'.padEnd(10) + 'Exec'.padEnd(10) + 'Time')
  lines.push('-'.repeat(70))
  
  for (const result of suiteResult.results) {
    const status = result.passed ? '✓' : '✗'
    const score = `${result.score}/${result.maxScore}`
    const time = `${(result.metrics.timing.totalMs / 1000).toFixed(1)}s`
    
    // Phase scores
    const intentPct = result.phaseScores?.intention.percentage
    const execPct = result.phaseScores?.execution.percentage
    const intentStr = intentPct !== undefined ? `${intentPct.toFixed(0)}%` : '-'
    const execStr = execPct !== undefined ? `${execPct.toFixed(0)}%` : '-'
    
    const name = `${status} ${result.eval.name}`.slice(0, 29)
    lines.push(`${name.padEnd(30)}${score.padEnd(10)}${intentStr.padEnd(10)}${execStr.padEnd(10)}${time}`)

    if (!result.passed && result.triggeredAntiPatterns.length > 0) {
      lines.push(`    Anti-patterns: ${result.triggeredAntiPatterns.join(', ')}`)
    }

    if (result.globalPenalties && result.globalPenalties.length > 0) {
      for (const penalty of result.globalPenalties) {
        lines.push(`    ⚠️ ${penalty.description}${penalty.details?.length ? ': ' + penalty.details.join(', ') : ''}`)
      }
    }

    if (result.errors && result.errors.length > 0) {
      lines.push(`    Errors: ${result.errors.join(', ')}`)
    }
  }

  lines.push('')
  lines.push('='.repeat(70))

  return lines.join('\n')
}
