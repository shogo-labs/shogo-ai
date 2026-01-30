#!/usr/bin/env bun
/**
 * Parallel Eval Runner
 * 
 * Runs multiple evals concurrently for faster testing.
 * Each eval gets its own project directory.
 * 
 * Usage:
 *   bun run src/evals/run-parallel-evals.ts --template crm --model haiku --concurrency 4
 */

import { runEval, type EvalRunnerConfig } from './runner'
import { ALL_CRM_EVALS } from './test-cases-crm'
import { ALL_INVENTORY_EVALS } from './test-cases-inventory'
import { ALL_HARD_EVALS } from './test-cases-hard'
import type { AgentEval, EvalResult } from './types'
import { execSync } from 'child_process'
import { mkdirSync, rmSync, existsSync } from 'fs'

// Parse command line arguments
const args = process.argv.slice(2)
const templateArg = args.find(a => a.startsWith('--template='))?.split('=')[1] ||
                    args[args.indexOf('--template') + 1] || 
                    'all'
const modelArg = args.find(a => a.startsWith('--model='))?.split('=')[1] ||
                 args[args.indexOf('--model') + 1] || 
                 process.env.AGENT_MODEL ||
                 'sonnet'
const concurrencyArg = parseInt(
  args.find(a => a.startsWith('--concurrency='))?.split('=')[1] ||
  args[args.indexOf('--concurrency') + 1] || 
  '3'
)
const filterArg = args.find(a => a.startsWith('--filter='))?.split('=')[1] ||
                  args[args.indexOf('--filter') + 1]
const verboseArg = args.includes('--verbose') || args.includes('-v')

// Get evals based on template
function getEvals(template: string): AgentEval[] {
  switch (template.toLowerCase()) {
    case 'crm':
      return ALL_CRM_EVALS
    case 'inventory':
    case 'inv':
      return ALL_INVENTORY_EVALS
    case 'hard':
    case 'todo':
      return ALL_HARD_EVALS
    case 'all':
      return [...ALL_CRM_EVALS, ...ALL_INVENTORY_EVALS, ...ALL_HARD_EVALS]
    default:
      console.error(`Unknown template: ${template}`)
      console.error('Available: crm, inventory, hard, all')
      process.exit(1)
  }
}

// Create unique project directory for each eval
function createProjectDir(evalId: string): string {
  const baseDir = '/tmp/shogo-eval'
  const projectDir = `${baseDir}/${evalId.replace(/[^a-z0-9]/gi, '-')}-${Date.now()}`
  
  if (existsSync(projectDir)) {
    rmSync(projectDir, { recursive: true, force: true })
  }
  mkdirSync(projectDir, { recursive: true })
  
  return projectDir
}

// Run a single eval with its own project directory
async function runSingleEval(
  ev: AgentEval, 
  config: EvalRunnerConfig,
  index: number,
  total: number
): Promise<EvalResult & { evalName: string }> {
  const projectDir = createProjectDir(ev.id)
  const startTime = Date.now()
  
  if (verboseArg) {
    console.log(`[${index + 1}/${total}] Starting: ${ev.name}`)
    console.log(`   Project dir: ${projectDir}`)
  }
  
  try {
    // Note: The agent will use SERVER's PROJECT_DIR, not this one
    // For true isolation, we'd need multiple server instances
    const result = await runEval(ev, config)
    
    const duration = ((Date.now() - startTime) / 1000).toFixed(1)
    const status = result.passed ? '✓' : '✗'
    console.log(`[${index + 1}/${total}] ${status} ${ev.name}: ${result.score}/${ev.maxScore} (${duration}s)`)
    
    return { ...result, evalName: ev.name }
  } catch (error: any) {
    console.error(`[${index + 1}/${total}] ✗ ${ev.name}: ERROR - ${error.message}`)
    return {
      evalId: ev.id,
      evalName: ev.name,
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
  } finally {
    // Cleanup project directory
    try {
      rmSync(projectDir, { recursive: true, force: true })
    } catch {}
  }
}

// Run evals in parallel batches
async function runParallelBatches(
  evals: AgentEval[],
  config: EvalRunnerConfig,
  concurrency: number
): Promise<EvalResult[]> {
  const results: EvalResult[] = []
  
  for (let i = 0; i < evals.length; i += concurrency) {
    const batch = evals.slice(i, i + concurrency)
    const batchNum = Math.floor(i / concurrency) + 1
    const totalBatches = Math.ceil(evals.length / concurrency)
    
    console.log(`\n📦 Batch ${batchNum}/${totalBatches} (${batch.length} evals)`)
    console.log('─'.repeat(50))
    
    // Clean project dir before batch
    execSync('rm -rf /tmp/shogo-eval-test && mkdir -p /tmp/shogo-eval-test', { stdio: 'pipe' })
    
    // Run batch concurrently
    const batchResults = await Promise.all(
      batch.map((ev, idx) => runSingleEval(ev, config, i + idx, evals.length))
    )
    
    results.push(...batchResults)
  }
  
  return results
}

async function main() {
  console.log('')
  console.log('🚀 PARALLEL EVAL RUNNER')
  console.log('═'.repeat(50))
  console.log(`🏢 Template: ${templateArg.toUpperCase()}`)
  console.log(`🤖 Model: claude-${modelArg}`)
  console.log(`⚡ Concurrency: ${concurrencyArg}`)
  
  let evals = getEvals(templateArg)
  
  // Apply filter if provided
  if (filterArg) {
    const filterLower = filterArg.toLowerCase()
    evals = evals.filter(e => 
      e.id.toLowerCase().includes(filterLower) ||
      e.name.toLowerCase().includes(filterLower) ||
      e.input.toLowerCase().includes(filterLower)
    )
  }
  
  console.log(`📋 Evals: ${evals.length}`)
  console.log('')
  
  if (evals.length === 0) {
    console.log('No evals matched the filter')
    process.exit(1)
  }
  
  // Check agent health
  console.log(`🔌 Checking agent at http://localhost:6300/agent/chat...`)
  try {
    const healthRes = await fetch('http://localhost:6300/health')
    if (!healthRes.ok) {
      throw new Error(`Health check returned ${healthRes.status}`)
    }
    const health = await healthRes.json()
    console.log(`✅ Agent is running (project: ${health.projectId || 'unknown'})`)
  } catch (error) {
    console.error('❌ Agent is not running. Please start with:')
    console.error(`   ./packages/mcp/src/evals/start-eval-server.sh ${modelArg}`)
    process.exit(1)
  }
  
  // Configuration
  const config: EvalRunnerConfig = {
    agentEndpoint: 'http://localhost:6300/agent/chat',
    timeoutMs: 600000, // 10 minutes
    retries: 0,
    verbose: verboseArg,
  }
  
  const overallStart = Date.now()
  
  // Run evals in parallel batches
  const results = await runParallelBatches(evals, config, concurrencyArg)
  
  const overallTime = (Date.now() - overallStart) / 1000
  
  // Generate summary
  console.log('')
  console.log('═'.repeat(50))
  console.log('📊 RESULTS SUMMARY')
  console.log('═'.repeat(50))
  
  const passed = results.filter(r => r.passed).length
  const failed = results.filter(r => !r.passed).length
  const avgScore = results.reduce((s, r) => s + r.score, 0) / results.length
  const totalTools = results.reduce((s, r) => s + (r.metrics?.toolCallCount || 0), 0)
  const totalTokens = results.reduce((s, r) => s + (r.metrics?.tokens?.total || 0), 0)
  
  console.log(``)
  console.log(`Total:        ${results.length}`)
  console.log(`Passed:       ${passed} (${(passed / results.length * 100).toFixed(1)}%)`)
  console.log(`Failed:       ${failed}`)
  console.log(`Avg Score:    ${avgScore.toFixed(1)}`)
  console.log(``)
  console.log(`⏱️  Total Time:    ${overallTime.toFixed(1)}s`)
  console.log(`   Per Eval:      ${(overallTime / results.length).toFixed(1)}s avg`)
  console.log(`   (Sequential:   ~${(results.length * 60).toFixed(0)}s estimated)`)
  console.log(`   Speedup:       ~${((results.length * 60) / overallTime).toFixed(1)}x`)
  console.log(``)
  console.log(`🔧 Tool Calls:    ${totalTools} (${(totalTools / results.length).toFixed(1)} avg)`)
  console.log(`📝 Tokens:        ${totalTokens.toLocaleString()}`)
  
  // List failed evals
  if (failed > 0) {
    console.log('')
    console.log('❌ FAILED EVALS:')
    console.log('─'.repeat(50))
    for (const r of results.filter(r => !r.passed)) {
      const ev = evals.find(e => e.id === r.evalId)
      console.log(`  ✗ ${ev?.name || r.evalId}: ${r.score}/${ev?.maxScore || 100}`)
      if (r.errors?.length) {
        console.log(`    Error: ${r.errors[0]}`)
      }
    }
  }
  
  // Export results to JSON for DSPy
  const outputPath = `/tmp/eval-results-${modelArg}-${Date.now()}.json`
  const exportData = {
    model: modelArg,
    template: templateArg,
    timestamp: new Date().toISOString(),
    summary: {
      total: results.length,
      passed,
      failed,
      passRate: passed / results.length,
      avgScore,
    },
    results: results.map(r => ({
      evalId: r.evalId,
      passed: r.passed,
      score: r.score,
      maxScore: evals.find(e => e.id === r.evalId)?.maxScore || 100,
      toolCalls: r.toolCalls.length,
      responsePreview: r.responseText.substring(0, 200),
      criteriaResults: r.criteriaResults,
    })),
  }
  
  await Bun.write(outputPath, JSON.stringify(exportData, null, 2))
  console.log('')
  console.log(`📁 Results exported to: ${outputPath}`)
  
  process.exit(failed > 0 ? 1 : 0)
}

main().catch(console.error)
