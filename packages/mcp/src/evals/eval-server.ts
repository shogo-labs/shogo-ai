#!/usr/bin/env bun
/**
 * Eval Server - HTTP server that manages parallel eval workers
 * 
 * Runs evals in the background with worker processes.
 * Progress can be checked via HTTP endpoints.
 * 
 * Usage:
 *   bun run src/evals/eval-server.ts --template business --model sonnet --workers 4 --port 7000
 * 
 * Endpoints:
 *   GET /status    - Current run status and progress
 *   GET /results   - Full results (when complete)
 *   POST /stop     - Stop the current run
 */

import { spawn, type Subprocess } from 'bun'
import { execSync } from 'child_process'
import { runEval, type EvalRunnerConfig } from './runner'
import { ALL_CRM_EVALS } from './test-cases-crm'
import { ALL_INVENTORY_EVALS } from './test-cases-inventory'
import { ALL_HARD_EVALS } from './test-cases-hard'
import { 
  ALL_BUSINESS_USER_EVALS,
  VAGUE_BUSINESS_LANGUAGE_EVALS,
  LEVEL_5_BUSINESS_EVALS,
  LEVEL_6_BUSINESS_EVALS,
} from './test-cases-business-user'
import { ALL_SHADCN_EVALS } from './test-cases-shadcn'
import type { AgentEval, EvalResult } from './types'
import { mkdirSync, rmSync, existsSync, writeFileSync, readFileSync } from 'fs'

// Checkpoint file for resuming
const CHECKPOINT_FILE = '/tmp/eval-checkpoint.json'

interface Checkpoint {
  template: string
  model: string
  workers: number
  startTime: number
  completedEvalIds: string[]
  results: EvalResult[]
  lastUpdated: string
  // Token/cost tracking
  totalInputTokens: number
  totalOutputTokens: number
  totalCost: number
}

function saveCheckpoint() {
  // Extract eval IDs - handle both evalId and eval.id formats
  const completedEvalIds = state.results.map(r => {
    if (r.evalId) return r.evalId
    if ((r as any).eval?.id) return (r as any).eval.id
    return null
  }).filter(Boolean)
  
  const checkpoint: Checkpoint = {
    template: templateArg,
    model: modelArg,
    workers: workersArg,
    startTime: state.startTime || Date.now(),
    completedEvalIds,
    results: state.results,
    lastUpdated: new Date().toISOString(),
    totalInputTokens: state.totalInputTokens,
    totalOutputTokens: state.totalOutputTokens,
    totalCost: state.totalCost,
  }
  writeFileSync(CHECKPOINT_FILE, JSON.stringify(checkpoint, null, 2))
}

function loadCheckpoint(): Checkpoint | null {
  if (!existsSync(CHECKPOINT_FILE)) return null
  try {
    const data = JSON.parse(readFileSync(CHECKPOINT_FILE, 'utf-8'))
    // Only resume if same template/model
    if (data.template === templateArg && data.model === modelArg) {
      return data
    }
    console.log('⚠️  Checkpoint exists but for different template/model, starting fresh')
    return null
  } catch {
    return null
  }
}

function clearCheckpoint() {
  if (existsSync(CHECKPOINT_FILE)) {
    rmSync(CHECKPOINT_FILE)
  }
}

// Parse args
const args = process.argv.slice(2)

function getArg(name: string, defaultValue?: string): string | undefined {
  const eqArg = args.find(a => a.startsWith(`--${name}=`))
  if (eqArg) return eqArg.split('=')[1]
  const idx = args.indexOf(`--${name}`)
  if (idx !== -1 && args[idx + 1] && !args[idx + 1].startsWith('--')) {
    return args[idx + 1]
  }
  return defaultValue
}

const templateArg = getArg('template', 'business')!
const modelArg = getArg('model', 'sonnet')!
const workersArg = parseInt(getArg('workers', '4')!)
const serverPort = parseInt(getArg('port', '7000')!)
const filterArg = getArg('filter')
const freshStart = args.includes('--fresh')
const verboseMode = args.includes('--verbose') || args.includes('-v')
const retryFailedOnly = args.includes('--retry-failed')
const mergeResultsPath = getArg('merge-results')  // Path to previous results to merge with

// Verbose log file
const VERBOSE_LOG_FILE = `/tmp/eval-verbose-${Date.now()}.log`

function verboseLog(message: string) {
  const timestamp = new Date().toISOString()
  const line = `[${timestamp}] ${message}\n`
  if (verboseMode) {
    process.stdout.write(line)
  }
  // Always append to log file
  try {
    const { appendFileSync } = require('fs')
    appendFileSync(VERBOSE_LOG_FILE, line)
  } catch {}
}

// Cost calculation (Claude pricing as of 2024)
// https://www.anthropic.com/pricing
const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  // Sonnet (claude-sonnet-4)
  sonnet: { input: 0.000003, output: 0.000015 },  // $3/$15 per 1M tokens
  // Haiku (claude-3-5-haiku)
  haiku: { input: 0.0000008, output: 0.000004 },  // $0.80/$4 per 1M tokens
  // Opus (claude-3-opus)
  opus: { input: 0.000015, output: 0.000075 },    // $15/$75 per 1M tokens
}

function getModelPricing(model: string): { input: number; output: number } {
  const normalizedModel = model.toLowerCase()
  if (normalizedModel.includes('haiku')) return MODEL_PRICING.haiku
  if (normalizedModel.includes('opus')) return MODEL_PRICING.opus
  return MODEL_PRICING.sonnet // Default to sonnet
}

function calculateCost(inputTokens: number, outputTokens: number): number {
  const pricing = getModelPricing(modelArg)
  return (inputTokens * pricing.input) + (outputTokens * pricing.output)
}

const BASE_PORT = 6300
const MCP_SERVER = '/Users/russell/git/shogo-ai/packages/mcp/src/server-templates.ts'
const PROJECT_RUNTIME = '/Users/russell/git/shogo-ai/packages/project-runtime/src/server.ts'

// =============================================================================
// AI Proxy Auto-Detection
// =============================================================================
// On startup, detect the local API server's AI proxy and generate a token so
// eval workers route LLM calls through the proxy instead of using raw API keys.

interface AIProxyConfig {
  url: string    // AI_PROXY_URL for project-runtime (e.g. http://localhost:8002/api/ai/v1)
  token: string  // AI_PROXY_TOKEN (signed JWT)
}

/** Inline JWT generation — same logic as apps/api/src/lib/ai-proxy-token.ts */
function base64urlEncode(data: string | ArrayBuffer): string {
  const bytes =
    typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data)
  const base64 = btoa(String.fromCharCode.apply(null, Array.from(bytes)))
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

async function generateEvalProxyToken(secret: string): Promise<string> {
  const header = { alg: 'HS256', typ: 'JWT' }
  const now = Date.now()
  const payload = {
    projectId: 'eval-server',
    workspaceId: 'eval-workspace',
    type: 'ai-proxy',
    iat: Math.floor(now / 1000),
    exp: Math.floor((now + 24 * 60 * 60 * 1000) / 1000), // 24h
  }

  const encodedHeader = base64urlEncode(JSON.stringify(header))
  const encodedPayload = base64urlEncode(JSON.stringify(payload))
  const signingInput = `${encodedHeader}.${encodedPayload}`

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signingInput))
  return `${signingInput}.${base64urlEncode(signature)}`
}

/**
 * Detect the AI proxy on the local API server.
 *
 * Priority:
 *  1. AI_PROXY_URL + AI_PROXY_TOKEN already in env → use directly
 *  2. Probe the local API server health endpoint → generate a token
 *  3. Return null (workers will fall back to direct ANTHROPIC_API_KEY)
 */
async function detectAIProxy(): Promise<AIProxyConfig | null> {
  // 1) Already configured in env
  if (process.env.AI_PROXY_URL && process.env.AI_PROXY_TOKEN) {
    console.log('🔑 AI Proxy: using env AI_PROXY_URL + AI_PROXY_TOKEN')
    return { url: process.env.AI_PROXY_URL, token: process.env.AI_PROXY_TOKEN }
  }

  // 2) Try to detect the local API server
  const apiPort = process.env.API_PORT || '8002'
  const apiBase = `http://localhost:${apiPort}`
  const proxyHealthUrl = `${apiBase}/api/ai/proxy/health`

  try {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 3000)
    const res = await fetch(proxyHealthUrl, { signal: controller.signal })
    clearTimeout(timeoutId)

    if (!res.ok) {
      console.log(`🔑 AI Proxy: API server health returned ${res.status}, skipping proxy`)
      return null
    }

    const health = await res.json() as { status: string; providers: Record<string, boolean> }

    if (!health.providers?.anthropic) {
      console.log('🔑 AI Proxy: API server has no Anthropic key configured, skipping proxy')
      return null
    }

    // Generate a proxy token using the shared secret
    const secret =
      process.env.AI_PROXY_SECRET ||
      process.env.BETTER_AUTH_SECRET ||
      process.env.PREVIEW_TOKEN_SECRET
    if (!secret) {
      console.log('🔑 AI Proxy: No signing secret (AI_PROXY_SECRET / BETTER_AUTH_SECRET), skipping proxy')
      return null
    }

    const token = await generateEvalProxyToken(secret)
    const url = `${apiBase}/api/ai/v1`

    console.log(`🔑 AI Proxy: detected API server at ${apiBase} (anthropic=true)`)
    console.log(`   Proxy URL: ${url}`)
    console.log(`   Token: ${token.slice(0, 30)}...`)

    return { url, token }
  } catch (err: any) {
    if (err.name === 'AbortError') {
      console.log('🔑 AI Proxy: API server not reachable (timeout), skipping proxy')
    } else {
      console.log(`🔑 AI Proxy: Could not reach API server (${err.message}), skipping proxy`)
    }
    return null
  }
}

// Resolved at startup, used by startWorker
let aiProxyConfig: AIProxyConfig | null = null

// State
interface Worker {
  id: number
  port: number
  projectDir: string
  process: Subprocess | null
  busy: boolean
  currentEval: string | null
}

interface RunState {
  status: 'idle' | 'starting' | 'running' | 'stopping' | 'complete' | 'error'
  startTime: number | null
  workers: Worker[]
  evals: AgentEval[]
  queue: AgentEval[]
  results: EvalResult[]
  completedCount: number
  errors: string[]
  // Token/cost tracking
  totalInputTokens: number
  totalOutputTokens: number
  totalCost: number
}

const state: RunState = {
  status: 'idle',
  startTime: null,
  workers: [],
  evals: [],
  queue: [],
  results: [],
  completedCount: 0,
  errors: [],
  totalInputTokens: 0,
  totalOutputTokens: 0,
  totalCost: 0,
}

// Get evals
function getEvals(template: string): AgentEval[] {
  switch (template.toLowerCase()) {
    case 'crm': return ALL_CRM_EVALS
    case 'inventory': return ALL_INVENTORY_EVALS
    case 'hard': return ALL_HARD_EVALS
    case 'business': return ALL_BUSINESS_USER_EVALS
    case 'vague': return VAGUE_BUSINESS_LANGUAGE_EVALS
    case 'level5': return LEVEL_5_BUSINESS_EVALS
    case 'level6': return LEVEL_6_BUSINESS_EVALS
    case 'shadcn': return ALL_SHADCN_EVALS
    case 'all': return [...ALL_CRM_EVALS, ...ALL_INVENTORY_EVALS, ...ALL_HARD_EVALS, ...ALL_BUSINESS_USER_EVALS, ...ALL_SHADCN_EVALS]
    default:
      throw new Error(`Unknown template: ${template}`)
  }
}

// Start a worker server
async function startWorker(id: number): Promise<Worker> {
  const port = BASE_PORT + id
  const projectDir = `/tmp/shogo-eval-worker-${id}`
  
  // Fast cleanup: rename old dir out of the way (instant), then remove in background
  if (existsSync(projectDir)) {
    const trashDir = `${projectDir}-trash-${Date.now()}`
    try {
      // rename is instant (same filesystem), then we can rm in background
      require('fs').renameSync(projectDir, trashDir)
      // Fire-and-forget cleanup of the renamed dir
      spawn({ cmd: ['rm', '-rf', trashDir], stdout: 'ignore', stderr: 'ignore' })
    } catch {
      // Fallback to sync removal if rename fails
      rmSync(projectDir, { recursive: true, force: true })
    }
  }
  mkdirSync(projectDir, { recursive: true })
  
  console.log(`  Starting worker ${id} on port ${port}...`)
  
  try {
    execSync(`lsof -ti:${port} | xargs kill -9 2>/dev/null || true`, { stdio: 'pipe' })
  } catch {}
  
  await Bun.sleep(500)
  
  // Build worker env — inject AI proxy config if detected
  const workerEnv: Record<string, string> = {
    ...Object.fromEntries(
      Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)
    ),
    PORT: String(port),
    PROJECT_DIR: projectDir,
    PROJECT_ID: `eval-worker-${id}`,
    MCP_SERVER_PATH: MCP_SERVER,
    AGENT_MODEL: modelArg,
    SHOGO_EVAL_MODE: 'true',
    NODE_OPTIONS: '--max-old-space-size=512',
  }
  if (aiProxyConfig) {
    workerEnv.AI_PROXY_URL = aiProxyConfig.url
    workerEnv.AI_PROXY_TOKEN = aiProxyConfig.token
  }

  const proc = spawn({
    cmd: ['bun', 'run', PROJECT_RUNTIME],
    env: workerEnv,
    stdout: 'ignore',
    stderr: 'ignore',
  })
  
  if (proc.exitCode !== null) {
    throw new Error(`Worker ${id} process exited immediately with code ${proc.exitCode}`)
  }
  
  const maxWait = 45000
  const startTime = Date.now()
  let delay = 500
  
  while (Date.now() - startTime < maxWait) {
    try {
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), 3000)
      const res = await fetch(`http://localhost:${port}/health`, { signal: controller.signal })
      clearTimeout(timeoutId)
      
      if (res.ok) {
        console.log(`  ✓ Worker ${id} ready on port ${port} (${Date.now() - startTime}ms)`)
        return { id, port, projectDir, process: proc, busy: false, currentEval: null }
      }
    } catch {
      if (proc.exitCode !== null) {
        throw new Error(`Worker ${id} process died with code ${proc.exitCode}`)
      }
    }
    await Bun.sleep(delay)
    delay = Math.min(delay * 1.2, 2000)
  }
  
  proc.kill()
  throw new Error(`Worker ${id} failed to start within ${maxWait}ms`)
}

function stopWorker(worker: Worker) {
  if (worker.process) {
    worker.process.kill()
  }
  try {
    execSync(`lsof -ti:${worker.port} | xargs kill -9 2>/dev/null || true`, { stdio: 'pipe' })
  } catch {}
  if (existsSync(worker.projectDir)) {
    rmSync(worker.projectDir, { recursive: true, force: true })
  }
}

// Run eval on a worker
async function runEvalOnWorker(worker: Worker, ev: AgentEval): Promise<EvalResult> {
  try {
    execSync(`rm -rf ${worker.projectDir}/* 2>/dev/null || true`, { stdio: 'pipe' })
  } catch {}
  mkdirSync(worker.projectDir, { recursive: true })
  
  const config: EvalRunnerConfig = {
    agentEndpoint: `http://localhost:${worker.port}/agent/chat`,
    timeoutMs: 600000,
    retries: 0,
    verbose: verboseMode,
    projectDir: worker.projectDir,
  }
  
  const startTime = Date.now()
  
  verboseLog(`[Worker ${worker.id}] Starting eval: ${ev.name}`)
  verboseLog(`[Worker ${worker.id}] Input: ${ev.input.slice(0, 100)}...`)
  if (ev.conversationHistory?.length) {
    verboseLog(`[Worker ${worker.id}] Has ${ev.conversationHistory.length} history turns`)
  }
  
  try {
    const result = await runEval(ev, config)
    const duration = ((Date.now() - startTime) / 1000).toFixed(1)
    const status = result.passed ? '✓' : '✗'
    
    // Track tokens and cost
    const inputTokens = result.metrics?.tokens?.input || 0
    const outputTokens = result.metrics?.tokens?.output || 0
    const evalCost = calculateCost(inputTokens, outputTokens)
    
    state.totalInputTokens += inputTokens
    state.totalOutputTokens += outputTokens
    state.totalCost += evalCost
    
    // Detect API errors in the response text
    const responseText = result.responseText || ''
    const isApiError = responseText.includes('Invalid API key') || 
                       responseText.includes('API error') ||
                       responseText.includes('rate limit') ||
                       responseText.includes('quota exceeded') ||
                       (responseText.length < 50 && result.toolCalls?.length === 0)
    
    if (isApiError) {
      console.error(`[${state.completedCount + 1}/${state.evals.length}] ⚠️  ${ev.name}: API ERROR - "${responseText.slice(0, 100)}" (${duration}s)`)
      verboseLog(`[Worker ${worker.id}] ⚠️  API ERROR DETECTED: "${responseText}"`)
      
      // Mark as error for potential retry
      result.errors = result.errors || []
      result.errors.push(`API Error: ${responseText}`)
      
      // Store the error type for analysis
      ;(result as any).apiError = true
      ;(result as any).apiErrorMessage = responseText
    } else {
      const tokenInfo = inputTokens > 0 ? ` [${inputTokens}+${outputTokens} tokens, $${evalCost.toFixed(4)}]` : ''
      console.log(`[${state.completedCount + 1}/${state.evals.length}] ${status} ${ev.name}: ${result.score}/${ev.maxScore} (${duration}s)${tokenInfo}`)
    }
    
    verboseLog(`[Worker ${worker.id}] Completed: ${ev.name} - ${status} ${result.score}/${ev.maxScore}`)
    verboseLog(`[Worker ${worker.id}] Tool calls: ${result.toolCalls?.length || 0}`)
    verboseLog(`[Worker ${worker.id}] Tokens: ${inputTokens} input, ${outputTokens} output`)
    verboseLog(`[Worker ${worker.id}] Response (first 200 chars): ${responseText.slice(0, 200)}...`)
    
    // Log criteria results in verbose mode
    if (verboseMode && result.criteriaResults) {
      for (const cr of result.criteriaResults) {
        verboseLog(`[Worker ${worker.id}]   ${cr.passed ? '✓' : '✗'} ${cr.criterion.description}: ${cr.pointsEarned}/${cr.criterion.points}`)
      }
    }
    
    return result
  } catch (error: any) {
    const duration = ((Date.now() - startTime) / 1000).toFixed(1)
    console.error(`[${state.completedCount + 1}/${state.evals.length}] ❌ ${ev.name}: EXCEPTION - ${error.message} (${duration}s)`)
    verboseLog(`[Worker ${worker.id}] EXCEPTION: ${error.message}`)
    verboseLog(`[Worker ${worker.id}] Stack: ${error.stack}`)
    
    return {
      evalId: ev.id,
      passed: false,
      score: 0,
      maxScore: ev.maxScore || 100,
      scorePercent: 0,
      responseText: `Error: ${error.message}`,
      toolCalls: [],
      criteriaResults: [],
      metrics: {
        toolCallCount: 0,
        stepCount: 0,
        tokens: { input: 0, output: 0, total: 0 },
        timing: { totalMs: Date.now() - startTime, firstToolCallMs: null, avgToolCallMs: null },
      },
      errors: [error.message],
      apiError: true,
      apiErrorMessage: error.message,
    } as any
  }
}

// Worker loop - process evals from queue
async function workerLoop(worker: Worker) {
  while (state.status === 'running' && state.queue.length > 0) {
    const ev = state.queue.shift()
    if (!ev) break
    
    worker.busy = true
    worker.currentEval = ev.name
    
    console.log(`[${state.completedCount + 1}/${state.evals.length}] Worker ${worker.id}: ${ev.name}`)
    
    try {
      const result = await runEvalOnWorker(worker, ev)
      state.results.push(result)
      state.completedCount++
      
      // Save checkpoint after each completed eval
      saveCheckpoint()
    } catch (error: any) {
      state.errors.push(`Worker ${worker.id} error on ${ev.name}: ${error.message}`)
    }
    
    worker.busy = false
    worker.currentEval = null
  }
}

// Start the eval run
async function startRun() {
  state.status = 'starting'
  state.results = []
  state.completedCount = 0
  state.errors = []
  
  // Auto-detect AI proxy before starting workers
  aiProxyConfig = await detectAIProxy()

  console.log('')
  console.log('🚀 EVAL SERVER')
  console.log('═'.repeat(50))
  console.log(`🏢 Template: ${templateArg.toUpperCase()}`)
  console.log(`🤖 Model: claude-${modelArg}`)
  console.log(`👷 Workers: ${workersArg}`)
  console.log(`🌐 Server: http://localhost:${serverPort}`)
  if (aiProxyConfig) {
    console.log(`🔑 AI Proxy: ${aiProxyConfig.url}`)
  } else {
    console.log(`🔑 AI Proxy: disabled (using direct ANTHROPIC_API_KEY)`)
  }
  if (retryFailedOnly) {
    console.log(`🔄 Mode: Retry failed evals only`)
  }
  if (mergeResultsPath) {
    console.log(`📥 Merge with: ${mergeResultsPath}`)
  }
  console.log('')
  
  // Get evals
  let evals = getEvals(templateArg)
  if (filterArg) {
    const filterLower = filterArg.toLowerCase()
    evals = evals.filter(e => 
      e.id.toLowerCase().includes(filterLower) ||
      e.name.toLowerCase().includes(filterLower)
    )
  }
  
  state.evals = evals
  
  // Load previous results if --retry-failed or --merge-results is set
  let previousResults: EvalResult[] = []
  let failedEvalIds: string[] = []
  
  if (mergeResultsPath && existsSync(mergeResultsPath)) {
    try {
      const prevData = JSON.parse(readFileSync(mergeResultsPath, 'utf-8'))
      previousResults = prevData.results || []
      
      // Find failed evals (including API errors)
      failedEvalIds = previousResults
        .filter((r: any) => !r.passed || r.apiError || (r.errors && r.errors.length > 0))
        .map((r: any) => r.evalId)
      
      console.log(`📥 Loaded previous results: ${previousResults.length} evals`)
      console.log(`   Failed/Error evals: ${failedEvalIds.length}`)
      
      // Load costs from previous run
      if (prevData.tokens) {
        state.totalInputTokens = prevData.tokens.input || 0
        state.totalOutputTokens = prevData.tokens.output || 0
        state.totalCost = prevData.cost?.total || 0
      }
      console.log('')
    } catch (e: any) {
      console.error(`⚠️  Could not load previous results: ${e.message}`)
    }
  }
  
  if (retryFailedOnly && failedEvalIds.length > 0) {
    // Only run the failed evals
    evals = evals.filter(e => failedEvalIds.includes(e.id))
    console.log(`🔄 Retrying ${evals.length} failed evals only`)
    console.log('')
  }
  
  // Check for checkpoint to resume (unless --fresh flag)
  const checkpoint = freshStart ? null : loadCheckpoint()
  if (freshStart) {
    clearCheckpoint()
    console.log('🔄 Fresh start requested, cleared any existing checkpoint')
    console.log('')
  }
  if (checkpoint && checkpoint.completedEvalIds.length > 0 && !retryFailedOnly) {
    console.log(`📥 RESUMING from checkpoint (${checkpoint.completedEvalIds.length}/${evals.length} completed)`)
    console.log(`   Last updated: ${checkpoint.lastUpdated}`)
    if (checkpoint.totalCost > 0) {
      console.log(`   Cost so far: $${checkpoint.totalCost.toFixed(4)}`)
    }
    console.log('')
    
    state.startTime = checkpoint.startTime
    state.results = checkpoint.results
    state.completedCount = checkpoint.completedEvalIds.length
    state.totalInputTokens = checkpoint.totalInputTokens || 0
    state.totalOutputTokens = checkpoint.totalOutputTokens || 0
    state.totalCost = checkpoint.totalCost || 0
    
    // Filter out already completed evals
    state.queue = evals.filter(e => !checkpoint.completedEvalIds.includes(e.id))
  } else {
    state.startTime = Date.now()
    state.queue = [...evals]
    if (!mergeResultsPath) {
      state.totalInputTokens = 0
      state.totalOutputTokens = 0
      state.totalCost = 0
    }
  }
  
  // Store previous results for merging later
  ;(state as any).previousResults = previousResults
  ;(state as any).mergeMode = !!mergeResultsPath
  
  console.log(`📋 Total Evals: ${evals.length}`)
  console.log(`📋 Remaining: ${state.queue.length}`)
  console.log('')
  
  // Start workers
  console.log('🔧 Starting workers...')
  state.workers = []
  
  try {
    for (let i = 0; i < workersArg; i++) {
      const worker = await startWorker(i)
      state.workers.push(worker)
      if (i < workersArg - 1) await Bun.sleep(1000)
    }
  } catch (error: any) {
    state.status = 'error'
    state.errors.push(`Failed to start workers: ${error.message}`)
    console.error(`❌ ${error.message}`)
    return
  }
  
  console.log('')
  console.log('🏃 Running evals...')
  console.log('─'.repeat(50))
  
  state.status = 'running'
  
  // Start worker loops
  const workerPromises = state.workers.map(w => workerLoop(w))
  
  // Wait for all workers to finish
  await Promise.all(workerPromises)
  
  // Complete
  state.status = 'complete'
  
  const totalTime = (Date.now() - state.startTime!) / 1000
  
  // Stop workers
  console.log('')
  console.log('🛑 Stopping workers...')
  state.workers.forEach(stopWorker)
  
  // Clear checkpoint on successful completion
  clearCheckpoint()
  console.log('✅ Checkpoint cleared (run complete)')
  
  // Print summary
  printSummary(totalTime)
}

function printSummary(totalTime: number) {
  console.log('')
  console.log('═'.repeat(50))
  console.log('📊 RESULTS SUMMARY')
  console.log('═'.repeat(50))
  
  // Merge results if we have previous results
  let allResults = state.results
  const previousResults = (state as any).previousResults || []
  const mergeMode = (state as any).mergeMode || false
  
  if (mergeMode && previousResults.length > 0) {
    // Get the IDs of newly run evals
    const newEvalIds = new Set(state.results.map((r: any) => r.evalId || r.eval?.id))
    
    // Keep previous results for evals we didn't re-run
    const keptPreviousResults = previousResults.filter((r: any) => {
      const evalId = r.evalId || r.eval?.id
      return !newEvalIds.has(evalId)
    })
    
    allResults = [...keptPreviousResults, ...state.results]
    console.log(`📎 Merged: ${keptPreviousResults.length} previous + ${state.results.length} new = ${allResults.length} total`)
    console.log('')
  }
  
  // Count API errors
  const apiErrors = allResults.filter((r: any) => r.apiError).length
  if (apiErrors > 0) {
    console.log(`⚠️  API Errors: ${apiErrors} evals failed due to API issues`)
    console.log('')
  }
  
  const passed = allResults.filter(r => r.passed && !(r as any).apiError).length
  const failed = allResults.filter(r => !r.passed).length
  const avgScore = allResults.length > 0 
    ? allResults.reduce((s, r) => s + r.score, 0) / allResults.length 
    : 0
  
  let totalIntentionScore = 0, totalIntentionMax = 0
  let totalExecutionScore = 0, totalExecutionMax = 0
  
  for (const r of allResults) {
    if (r.phaseScores) {
      totalIntentionScore += r.phaseScores.intention.score
      totalIntentionMax += r.phaseScores.intention.maxScore
      totalExecutionScore += r.phaseScores.execution.score
      totalExecutionMax += r.phaseScores.execution.maxScore
    }
  }
  
  const intentionPct = totalIntentionMax > 0 ? (totalIntentionScore / totalIntentionMax * 100) : 0
  const executionPct = totalExecutionMax > 0 ? (totalExecutionScore / totalExecutionMax * 100) : 100
  
  console.log(`Total:        ${allResults.length}`)
  console.log(`Passed:       ${passed} (${(passed / allResults.length * 100).toFixed(1)}%)`)
  console.log(`Failed:       ${failed}`)
  if (apiErrors > 0) {
    console.log(`API Errors:   ${apiErrors}`)
  }
  console.log(`Avg Score:    ${avgScore.toFixed(1)}`)
  console.log('')
  console.log('INTENTION vs EXECUTION')
  console.log('─'.repeat(50))
  console.log(`🎯 Intention:  ${intentionPct.toFixed(1)}% (${totalIntentionScore}/${totalIntentionMax} pts)`)
  console.log(`⚙️  Execution:  ${executionPct.toFixed(1)}% (${totalExecutionScore}/${totalExecutionMax} pts)`)
  console.log('')
  console.log(`⏱️  Total Time: ${totalTime.toFixed(1)}s`)
  console.log('')
  console.log('TOKEN USAGE & COST')
  console.log('─'.repeat(50))
  console.log(`📝 Input Tokens:   ${state.totalInputTokens.toLocaleString()}`)
  console.log(`📝 Output Tokens:  ${state.totalOutputTokens.toLocaleString()}`)
  console.log(`📝 Total Tokens:   ${(state.totalInputTokens + state.totalOutputTokens).toLocaleString()}`)
  console.log(`💰 Total Cost:     $${state.totalCost.toFixed(4)}`)
  if (state.results.length > 0) {
    console.log(`💰 Avg Cost/Eval:  $${(state.totalCost / state.results.length).toFixed(4)}`)
  }
  
  // Individual results
  console.log('')
  console.log('INDIVIDUAL RESULTS')
  console.log('─'.repeat(80))
  console.log('Name'.padEnd(40) + 'Score'.padEnd(10) + 'Intent'.padEnd(10) + 'Exec'.padEnd(10) + 'Status')
  console.log('─'.repeat(80))
  
  for (const r of allResults) {
    // Handle both evalId at top level and eval.id from runner
    const evalId = r.evalId || (r as any).eval?.id || 'unknown'
    const ev = state.evals.find(e => e.id === evalId)
    const name = (ev?.name || (r as any).eval?.name || evalId).slice(0, 38)
    const isApiError = (r as any).apiError
    const status = isApiError ? '⚠' : (r.passed ? '✓' : '✗')
    const score = `${r.score}/${ev?.maxScore || (r as any).eval?.maxScore || 100}`
    const intentPct = r.phaseScores ? `${r.phaseScores.intention.percentage.toFixed(0)}%` : 'N/A'
    const execPct = r.phaseScores ? `${r.phaseScores.execution.percentage.toFixed(0)}%` : 'N/A'
    const statusText = isApiError ? 'API ERR' : (r.passed ? 'PASS' : 'FAIL')
    console.log(`${status} ${name.padEnd(38)} ${score.padEnd(10)} ${intentPct.padEnd(10)} ${execPct.padEnd(10)} ${statusText}`)
  }
  
  // Save results
  const outputPath = `/tmp/eval-results-${modelArg}-${templateArg}-${Date.now()}.json`
  const exportData = {
    model: modelArg,
    template: templateArg,
    timestamp: new Date().toISOString(),
    totalTime,
    workers: workersArg,
    merged: mergeMode,
    summary: { 
      total: allResults.length, 
      passed, 
      failed, 
      apiErrors,
      avgScore,
      intentionPercent: intentionPct,
      executionPercent: executionPct,
    },
    tokens: {
      input: state.totalInputTokens,
      output: state.totalOutputTokens,
      total: state.totalInputTokens + state.totalOutputTokens,
    },
    cost: {
      total: state.totalCost,
      perEval: allResults.length > 0 ? state.totalCost / allResults.length : 0,
      inputCost: state.totalInputTokens * getModelPricing(modelArg).input,
      outputCost: state.totalOutputTokens * getModelPricing(modelArg).output,
      pricing: {
        model: modelArg,
        inputPer1M: getModelPricing(modelArg).input * 1000000,
        outputPer1M: getModelPricing(modelArg).output * 1000000,
      },
    },
    results: allResults.map(r => {
      const evalId = r.evalId || (r as any).eval?.id || 'unknown'
      const ev = state.evals.find(e => e.id === evalId)
      const inputTokens = r.metrics?.tokens?.input || 0
      const outputTokens = r.metrics?.tokens?.output || 0
      return {
        evalId,
        name: ev?.name || (r as any).eval?.name || evalId,
        passed: r.passed,
        score: r.score,
        maxScore: ev?.maxScore || (r as any).eval?.maxScore || 100,
        intentionScore: r.phaseScores?.intention.percentage || 0,
        executionScore: r.phaseScores?.execution.percentage || 0,
        tools: r.toolCalls?.length || 0,
        tokens: {
          input: inputTokens,
          output: outputTokens,
          total: inputTokens + outputTokens,
        },
        cost: calculateCost(inputTokens, outputTokens),
        durationMs: r.metrics?.timing?.totalMs || r.timing?.durationMs || 0,
        apiError: (r as any).apiError || false,
        apiErrorMessage: (r as any).apiErrorMessage || null,
        errors: r.errors || [],
      }
    }),
  }
  writeFileSync(outputPath, JSON.stringify(exportData, null, 2))
  console.log('')
  console.log(`📁 Results: ${outputPath}`)
  if (verboseMode) {
    console.log(`📁 Verbose log: ${VERBOSE_LOG_FILE}`)
  }
  
  // Print retry command if there were API errors
  if (apiErrors > 0) {
    console.log('')
    console.log('💡 To retry failed evals:')
    console.log(`   bun run src/evals/eval-server.ts --template ${templateArg} --model ${modelArg} --workers 1 --retry-failed --merge-results ${outputPath}`)
  }
}

// HTTP Server
const server = Bun.serve({
  port: serverPort,
  fetch(req) {
    const url = new URL(req.url)
    
    if (url.pathname === '/status') {
      const elapsed = state.startTime ? (Date.now() - state.startTime) / 1000 : 0
      const activeWorkers = state.workers.filter(w => w.busy).map(w => ({
        id: w.id,
        currentEval: w.currentEval,
      }))
      
      return Response.json({
        status: state.status,
        elapsed: elapsed.toFixed(1) + 's',
        progress: `${state.completedCount}/${state.evals.length}`,
        percent: state.evals.length > 0 ? ((state.completedCount / state.evals.length) * 100).toFixed(1) + '%' : '0%',
        activeWorkers,
        queueLength: state.queue.length,
        tokens: {
          input: state.totalInputTokens,
          output: state.totalOutputTokens,
          total: state.totalInputTokens + state.totalOutputTokens,
        },
        cost: `$${state.totalCost.toFixed(4)}`,
        errors: state.errors,
      })
    }
    
    if (url.pathname === '/results') {
      if (state.status !== 'complete') {
        return Response.json({ error: 'Run not complete', status: state.status }, { status: 400 })
      }
      
      const passed = state.results.filter(r => r.passed).length
      const failed = state.results.filter(r => !r.passed).length
      
      return Response.json({
        status: state.status,
        summary: {
          total: state.results.length,
          passed,
          failed,
          passRate: ((passed / state.results.length) * 100).toFixed(1) + '%',
        },
        results: state.results.map(r => ({
          evalId: r.evalId,
          name: state.evals.find(e => e.id === r.evalId)?.name || r.evalId,
          passed: r.passed,
          score: r.score,
          maxScore: state.evals.find(e => e.id === r.evalId)?.maxScore || 100,
          intentionScore: r.phaseScores?.intention.percentage.toFixed(0) + '%',
          executionScore: r.phaseScores?.execution.percentage.toFixed(0) + '%',
        })),
      })
    }
    
    if (url.pathname === '/stop' && req.method === 'POST') {
      if (state.status === 'running') {
        state.status = 'stopping'
        state.queue = [] // Clear queue so workers stop
        return Response.json({ message: 'Stopping...' })
      }
      return Response.json({ message: 'Not running', status: state.status })
    }
    
    // Health check
    if (url.pathname === '/health') {
      return Response.json({ ok: true, status: state.status })
    }
    
    // Checkpoint info
    if (url.pathname === '/checkpoint') {
      if (existsSync(CHECKPOINT_FILE)) {
        const checkpoint = JSON.parse(readFileSync(CHECKPOINT_FILE, 'utf-8'))
        return Response.json({
          exists: true,
          completed: checkpoint.completedEvalIds.length,
          total: state.evals.length || checkpoint.completedEvalIds.length,
          lastUpdated: checkpoint.lastUpdated,
          template: checkpoint.template,
          model: checkpoint.model,
        })
      }
      return Response.json({ exists: false })
    }
    
    return Response.json({
      endpoints: {
        'GET /status': 'Current run status and progress',
        'GET /results': 'Full results (when complete)',
        'GET /checkpoint': 'Checkpoint status for resume',
        'POST /stop': 'Stop the current run',
        'GET /health': 'Health check',
      }
    })
  },
})

console.log(`🌐 Eval server listening on http://localhost:${serverPort}`)
console.log('   GET /status     - Check progress (includes cost)')
console.log('   GET /results    - Get full results')
console.log('   GET /checkpoint - Check checkpoint for resume')
console.log('   POST /stop      - Stop the run')
console.log('')
console.log('💡 Options:')
console.log('   --fresh              Start fresh (ignore checkpoint)')
console.log('   --verbose            Enable verbose logging to file')
console.log('   --retry-failed       Only retry failed/errored evals')
console.log('   --merge-results <f>  Merge with previous results file')
console.log('')
if (verboseMode) {
  console.log(`📝 Verbose log: ${VERBOSE_LOG_FILE}`)
  console.log('')
}

// Start the run
startRun().catch(err => {
  console.error('Fatal error:', err)
  state.status = 'error'
  state.errors.push(err.message)
})
