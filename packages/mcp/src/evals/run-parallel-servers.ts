#!/usr/bin/env bun
/**
 * Parallel Eval Runner with Multiple Server Instances
 * 
 * Starts multiple project-runtime servers on different ports,
 * each with its own PROJECT_DIR, to run evals truly in parallel.
 * 
 * Usage:
 *   bun run src/evals/run-parallel-servers.ts --template crm --model haiku --workers 4
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
import type { AgentEval, EvalResult } from './types'
import { mkdirSync, rmSync, existsSync, writeFileSync } from 'fs'

// Parse args
const args = process.argv.slice(2)

function getArg(name: string, defaultValue?: string): string | undefined {
  // Check --name=value format
  const eqArg = args.find(a => a.startsWith(`--${name}=`))
  if (eqArg) return eqArg.split('=')[1]
  
  // Check --name value format
  const idx = args.indexOf(`--${name}`)
  if (idx !== -1 && args[idx + 1] && !args[idx + 1].startsWith('--')) {
    return args[idx + 1]
  }
  
  return defaultValue
}

const templateArg = getArg('template', 'all')!
const modelArg = getArg('model', 'haiku')!
const workersArg = parseInt(getArg('workers', '3')!)
const filterArg = getArg('filter')

const BASE_PORT = 6300
const MCP_SERVER = '/Users/russell/git/shogo-ai/packages/mcp/src/server-templates.ts'
const PROJECT_RUNTIME = '/Users/russell/git/shogo-ai/packages/project-runtime/src/server.ts'

interface Worker {
  id: number
  port: number
  projectDir: string
  process: Subprocess | null
  busy: boolean
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
    case 'all': return [...ALL_CRM_EVALS, ...ALL_INVENTORY_EVALS, ...ALL_HARD_EVALS, ...ALL_BUSINESS_USER_EVALS]
    default:
      console.error(`Unknown template: ${template}. Valid options: crm, inventory, hard, business, vague, level5, level6, all`)
      process.exit(1)
  }
}

// Start a worker server
async function startWorker(id: number): Promise<Worker> {
  const port = BASE_PORT + id
  const projectDir = `/tmp/shogo-eval-worker-${id}`
  
  // Clean and create project dir
  if (existsSync(projectDir)) {
    rmSync(projectDir, { recursive: true, force: true })
  }
  mkdirSync(projectDir, { recursive: true })
  
  console.log(`  Starting worker ${id} on port ${port}...`)
  
  // Kill any existing process on this port
  try {
    execSync(`lsof -ti:${port} | xargs kill -9 2>/dev/null || true`, { stdio: 'pipe' })
  } catch {}
  
  // Small delay to ensure port is free
  await Bun.sleep(500)
  
  // Start the server with inherited stdio for debugging
  const proc = spawn({
    cmd: ['bun', 'run', PROJECT_RUNTIME],
    env: {
      ...process.env,
      PORT: String(port),
      PROJECT_DIR: projectDir,
      PROJECT_ID: `eval-worker-${id}`,
      MCP_SERVER_PATH: MCP_SERVER,
      AGENT_MODEL: modelArg,
      SHOGO_EVAL_MODE: 'true',
      // Reduce memory usage
      NODE_OPTIONS: '--max-old-space-size=512',
    },
    stdout: 'ignore',  // Don't buffer output
    stderr: 'ignore',
  })
  
  // Check if process started
  if (proc.exitCode !== null) {
    throw new Error(`Worker ${id} process exited immediately with code ${proc.exitCode}`)
  }
  
  // Wait for server to be ready with exponential backoff
  const maxWait = 45000
  const startTime = Date.now()
  let delay = 500
  
  while (Date.now() - startTime < maxWait) {
    try {
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), 3000)
      
      const res = await fetch(`http://localhost:${port}/health`, {
        signal: controller.signal,
      })
      clearTimeout(timeoutId)
      
      if (res.ok) {
        console.log(`  ✓ Worker ${id} ready on port ${port} (${Date.now() - startTime}ms)`)
        return { id, port, projectDir, process: proc, busy: false }
      }
    } catch (e: any) {
      // Check if process died
      if (proc.exitCode !== null) {
        throw new Error(`Worker ${id} process died with code ${proc.exitCode}`)
      }
    }
    
    await Bun.sleep(delay)
    delay = Math.min(delay * 1.2, 2000)  // Exponential backoff, max 2s
  }
  
  // Cleanup on failure
  proc.kill()
  throw new Error(`Worker ${id} failed to start within ${maxWait}ms`)
}

// Stop a worker
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

// Run eval on a specific worker
async function runEvalOnWorker(
  worker: Worker,
  ev: AgentEval,
  index: number,
  total: number
): Promise<EvalResult> {
  // Clean project dir
  try {
    execSync(`rm -rf ${worker.projectDir}/* 2>/dev/null || true`, { stdio: 'pipe' })
  } catch {}
  mkdirSync(worker.projectDir, { recursive: true })
  
  const config: EvalRunnerConfig = {
    agentEndpoint: `http://localhost:${worker.port}/agent/chat`,
    timeoutMs: 600000,
    retries: 0,
    verbose: false,
    projectDir: worker.projectDir,  // Pass worker's project directory for validation
  }
  
  const startTime = Date.now()
  console.log(`[${index + 1}/${total}] Worker ${worker.id}: ${ev.name}`)
  
  try {
    const result = await runEval(ev, config)
    const duration = ((Date.now() - startTime) / 1000).toFixed(1)
    const status = result.passed ? '✓' : '✗'
    console.log(`[${index + 1}/${total}] ${status} ${ev.name}: ${result.score}/${ev.maxScore} (${duration}s)`)
    return result
  } catch (error: any) {
    console.error(`[${index + 1}/${total}] ✗ ${ev.name}: ERROR - ${error.message}`)
    return {
      evalId: ev.id,
      passed: false,
      score: 0,
      maxScore: ev.maxScore || 100,
      scorePercent: 0,
      responseText: '',
      toolCalls: [],
      criteriaResults: [],
      metrics: {
        toolCallCount: 0,
        stepCount: 0,
        tokens: { input: 0, output: 0, total: 0 },
        timing: { totalMs: Date.now() - startTime, firstToolCallMs: null, avgToolCallMs: null },
      },
      errors: [error.message],
    }
  }
}

// Global workers reference for cleanup
let globalWorkers: Worker[] = []

// Cleanup on exit
function cleanup() {
  console.log('\n🛑 Cleaning up workers...')
  globalWorkers.forEach(stopWorker)
  globalWorkers = []
}

// Handle termination signals
process.on('SIGINT', () => {
  console.log('\n⚠️  Received SIGINT')
  cleanup()
  process.exit(130)
})

process.on('SIGTERM', () => {
  console.log('\n⚠️  Received SIGTERM')
  cleanup()
  process.exit(143)
})

// Force unbuffered output
const log = (...args: any[]) => {
  console.log(...args)
  // Force flush on Bun
  if (typeof Bun !== 'undefined') {
    Bun.write(Bun.stdout, '')
  }
}

// Main function
async function main() {
  log('')
  log('🚀 PARALLEL EVAL RUNNER (Multi-Server)')
  log('═'.repeat(50))
  console.log(`🏢 Template: ${templateArg.toUpperCase()}`)
  console.log(`🤖 Model: claude-${modelArg}`)
  console.log(`👷 Workers: ${workersArg}`)
  console.log('')
  
  let evals = getEvals(templateArg)
  
  if (filterArg) {
    const filterLower = filterArg.toLowerCase()
    evals = evals.filter(e => 
      e.id.toLowerCase().includes(filterLower) ||
      e.name.toLowerCase().includes(filterLower)
    )
  }
  
  console.log(`📋 Total Evals: ${evals.length}`)
  console.log('')
  
  if (evals.length === 0) {
    console.log('No evals found')
    process.exit(1)
  }
  
  // Start workers sequentially to avoid resource contention
  console.log('🔧 Starting workers (sequentially to avoid resource contention)...')
  const workers: Worker[] = []
  
  try {
    for (let i = 0; i < workersArg; i++) {
      const worker = await startWorker(i)
      workers.push(worker)
      globalWorkers.push(worker)
      // Small delay between worker starts
      if (i < workersArg - 1) {
        await Bun.sleep(1000)
      }
    }
  } catch (error: any) {
    console.error(`❌ Failed to start workers: ${error.message}`)
    cleanup()
    process.exit(1)
  }
  
  console.log('')
  console.log('🏃 Running evals...')
  console.log('─'.repeat(50))
  
  const overallStart = Date.now()
  const results: EvalResult[] = []
  
  // Create a queue of evals
  const evalQueue = [...evals]
  let completedCount = 0
  
  // Process evals with worker pool
  const runningPromises = new Map<number, Promise<void>>()
  
  while (evalQueue.length > 0 || runningPromises.size > 0) {
    // Start evals on available workers
    for (const worker of workers) {
      if (!worker.busy && evalQueue.length > 0) {
        const ev = evalQueue.shift()!
        const evalIndex = evals.length - evalQueue.length - 1
        
        worker.busy = true
        const promise = runEvalOnWorker(worker, ev, evalIndex, evals.length)
          .then(result => {
            results.push(result)
            completedCount++
            worker.busy = false
            runningPromises.delete(worker.id)
          })
          .catch(err => {
            console.error(`Worker ${worker.id} error:`, err)
            worker.busy = false
            runningPromises.delete(worker.id)
          })
        
        runningPromises.set(worker.id, promise)
      }
    }
    
    // Wait a bit before checking again
    if (runningPromises.size > 0) {
      await Promise.race([...runningPromises.values()])
    }
  }
  
  const overallTime = (Date.now() - overallStart) / 1000
  
  // Stop workers
  console.log('')
  console.log('🛑 Stopping workers...')
  workers.forEach(stopWorker)
  globalWorkers = []  // Clear global reference
  
  // Summary
  console.log('')
  console.log('═'.repeat(50))
  console.log('📊 RESULTS SUMMARY')
  console.log('═'.repeat(50))
  
  const passed = results.filter(r => r.passed).length
  const failed = results.filter(r => !r.passed).length
  const avgScore = results.length > 0 
    ? results.reduce((s, r) => s + r.score, 0) / results.length 
    : 0
  
  // Calculate intention vs execution scores
  let totalIntentionScore = 0
  let totalIntentionMax = 0
  let totalExecutionScore = 0
  let totalExecutionMax = 0
  
  for (const r of results) {
    if (r.phaseScores) {
      totalIntentionScore += r.phaseScores.intention.score
      totalIntentionMax += r.phaseScores.intention.maxScore
      totalExecutionScore += r.phaseScores.execution.score
      totalExecutionMax += r.phaseScores.execution.maxScore
    }
  }
  
  const intentionPct = totalIntentionMax > 0 ? (totalIntentionScore / totalIntentionMax * 100) : 0
  const executionPct = totalExecutionMax > 0 ? (totalExecutionScore / totalExecutionMax * 100) : 100
  
  console.log(``)
  console.log(`Total:        ${results.length}`)
  console.log(`Passed:       ${passed} (${(passed / results.length * 100).toFixed(1)}%)`)
  console.log(`Failed:       ${failed}`)
  console.log(`Avg Score:    ${avgScore.toFixed(1)}`)
  console.log(``)
  console.log('INTENTION vs EXECUTION')
  console.log('─'.repeat(50))
  console.log(`🎯 Intention:  ${intentionPct.toFixed(1)}% (${totalIntentionScore}/${totalIntentionMax} pts)`)
  console.log(`⚙️  Execution:  ${executionPct.toFixed(1)}% (${totalExecutionScore}/${totalExecutionMax} pts)`)
  console.log(``)
  console.log(`⏱️  Total Time:    ${overallTime.toFixed(1)}s`)
  console.log(`   Per Eval:      ${(overallTime / results.length).toFixed(1)}s avg`)
  console.log(`   Sequential:    ~${(results.length * 90)}s estimated`)
  console.log(`   Speedup:       ~${((results.length * 90) / overallTime).toFixed(1)}x`)
  
  // Individual results with intent/exec scores
  console.log('')
  console.log('INDIVIDUAL RESULTS')
  console.log('─'.repeat(70))
  console.log('Name'.padEnd(40) + 'Score'.padEnd(10) + 'Intent'.padEnd(10) + 'Exec')
  console.log('─'.repeat(70))
  
  for (const r of results) {
    const ev = evals.find(e => e.id === r.evalId)
    const name = (ev?.name || r.evalId).slice(0, 38)
    const status = r.passed ? '✓' : '✗'
    const score = `${r.score}/${ev?.maxScore || 100}`
    const intentPct = r.phaseScores ? `${r.phaseScores.intention.percentage.toFixed(0)}%` : 'N/A'
    const execPct = r.phaseScores ? `${r.phaseScores.execution.percentage.toFixed(0)}%` : 'N/A'
    console.log(`${status} ${name.padEnd(38)} ${score.padEnd(10)} ${intentPct.padEnd(10)} ${execPct}`)
  }
  
  // Export for DSPy
  const outputPath = `/tmp/eval-results-${modelArg}-${templateArg}-${Date.now()}.json`
  const exportData = {
    model: modelArg,
    template: templateArg,
    timestamp: new Date().toISOString(),
    totalTime: overallTime,
    workers: workersArg,
    summary: { total: results.length, passed, failed, avgScore },
    results: results.map(r => ({
      evalId: r.evalId,
      passed: r.passed,
      score: r.score,
      maxScore: evals.find(e => e.id === r.evalId)?.maxScore || 100,
      tools: r.toolCalls.length,
      criteriaResults: r.criteriaResults,
    })),
  }
  
  writeFileSync(outputPath, JSON.stringify(exportData, null, 2))
  console.log('')
  console.log(`📁 Results: ${outputPath}`)
  
  process.exit(failed > 0 ? 1 : 0)
}

main().catch(err => {
  console.error('Fatal error:', err)
  process.exit(1)
})
