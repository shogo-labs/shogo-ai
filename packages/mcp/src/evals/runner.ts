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
} from './types'
import { evaluateToolCorrectness, extractSelectedTemplate } from './validators'

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
}

const DEFAULT_CONFIG: Required<EvalRunnerConfig> = {
  agentEndpoint: 'http://localhost:3002/api/chat',
  timeoutMs: 300000, // 5 minutes default for complex tasks
  verbose: false,
  retries: 0,
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
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error))
  }

  const endTime = Date.now()

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
      durationMs: endTime - startTime,
    },
    errors: errors.length > 0 ? errors : undefined,
  }

  for (const criterion of eval_.validationCriteria) {
    try {
      const passed = criterion.validate(evalResultBase)
      const pointsEarned = passed ? criterion.points : 0
      totalScore += pointsEarned

      if (cfg.verbose) {
        console.log(`    ${passed ? '✓' : '✗'} ${criterion.description}: ${pointsEarned}/${criterion.points}`)
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

  // Calculate final score (deduct for anti-patterns)
  const antiPatternPenalty = triggeredAntiPatterns.length * 10
  const finalScore = Math.max(0, totalScore - antiPatternPenalty)
  const percentage = (finalScore / eval_.maxScore) * 100
  const passed = percentage >= 70 && triggeredAntiPatterns.length === 0

  return {
    ...evalResultBase,
    passed,
    score: finalScore,
    percentage,
    criteriaResults,
    triggeredAntiPatterns,
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

  // Calculate by category
  const byCategory: Record<EvalCategory, CategorySummary> = {
    'template-selection': calculateCategorySummary(results, 'template-selection'),
    'tool-usage': calculateCategorySummary(results, 'tool-usage'),
    'multi-turn': calculateCategorySummary(results, 'multi-turn'),
    'edge-cases': calculateCategorySummary(results, 'edge-cases'),
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
 */
async function callAgent(
  eval_: AgentEval,
  config: Required<EvalRunnerConfig>
): Promise<{ text: string; toolCalls: ToolCall[] }> {
  // Build messages array
  const messages = []

  // Add conversation history if present
  if (eval_.conversationHistory) {
    for (const turn of eval_.conversationHistory) {
      messages.push({
        role: turn.role,
        content: turn.content,
      })
    }
  }

  // Add current input
  messages.push({
    role: 'user',
    content: eval_.input,
  })

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
      throw new Error(`Agent API returned ${response.status}`)
    }

    // Parse streaming response
    const result = await parseAgentStreamingResponse(response, controller, config.verbose)
    clearTimeout(timeoutId)
    return result
  } catch (error) {
    clearTimeout(timeoutId)
    throw error
  }
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
async function parseAgentStreamingResponse(
  response: Response,
  controller: AbortController,
  verbose: boolean = false
): Promise<{ text: string; toolCalls: ToolCall[] }> {
  const toolCalls: ToolCall[] = []
  const toolInputs: Record<string, string> = {}
  const toolNames: Record<string, string> = {}
  let responseText = ''
  let stepCount = 0
  let lastLogTime = Date.now()
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
          return { text: responseText, toolCalls }
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
                })
              }
              // Virtual tools execute format (used by some agents)
              else if (toolName === 'mcp__virtual-tools__execute' && input.operations) {
                for (const op of input.operations) {
                  if (op.domain && op.action) {
                    toolCalls.push({
                      name: `${op.domain}.${op.action}`,
                      params: op.data || {},
                    })
                  }
                }
              }
              // Other tools (Bash, Read, etc.) - record them too
              else {
                toolCalls.push({
                  name: toolName,
                  params: input,
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

  return { text: responseText, toolCalls }
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

  return false
}

/**
 * Format eval results as a report
 */
export function formatEvalReport(suiteResult: EvalSuiteResult): string {
  const lines: string[] = []

  lines.push(`\n${'='.repeat(60)}`)
  lines.push(`EVAL SUITE: ${suiteResult.name}`)
  lines.push(`${'='.repeat(60)}`)
  lines.push(`Run at: ${suiteResult.timestamp.toISOString()}`)
  lines.push('')

  // Summary
  lines.push('SUMMARY')
  lines.push('-'.repeat(40))
  lines.push(`Total:       ${suiteResult.summary.total}`)
  lines.push(`Passed:      ${suiteResult.summary.passed}`)
  lines.push(`Failed:      ${suiteResult.summary.failed}`)
  lines.push(`Pass Rate:   ${suiteResult.summary.passRate.toFixed(1)}%`)
  lines.push(`Avg Score:   ${suiteResult.summary.averageScore.toFixed(1)}`)
  lines.push('')

  // By category
  lines.push('BY CATEGORY')
  lines.push('-'.repeat(40))
  for (const [category, summary] of Object.entries(suiteResult.byCategory)) {
    if (summary.total > 0) {
      lines.push(
        `${category.padEnd(20)} ${summary.passed}/${summary.total} (${summary.passRate.toFixed(0)}%)`
      )
    }
  }
  lines.push('')

  // Individual results
  lines.push('INDIVIDUAL RESULTS')
  lines.push('-'.repeat(40))
  for (const result of suiteResult.results) {
    const status = result.passed ? '✓' : '✗'
    const score = `${result.score}/${result.maxScore}`
    lines.push(`${status} ${result.eval.name.padEnd(35)} ${score}`)

    if (!result.passed && result.triggeredAntiPatterns.length > 0) {
      lines.push(`    Anti-patterns: ${result.triggeredAntiPatterns.join(', ')}`)
    }

    if (result.errors && result.errors.length > 0) {
      lines.push(`    Errors: ${result.errors.join(', ')}`)
    }
  }

  lines.push('')
  lines.push('='.repeat(60))

  return lines.join('\n')
}
