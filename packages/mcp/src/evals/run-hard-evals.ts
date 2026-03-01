#!/usr/bin/env bun
/**
 * Run Hard Agent Evals
 * 
 * These evals test the agent's ability to:
 * - Modify apps after template creation
 * - Protect generated files
 * - Make working code changes
 * 
 * Usage:
 *   bun run src/evals/run-hard-evals.ts [--verbose] [--filter <pattern>] [--model <haiku|sonnet|opus>]
 * 
 * The project-runtime must be running with SHOGO_EVAL_MODE=true
 * 
 * To run with a specific model:
 *   AGENT_MODEL=haiku bun run src/evals/run-hard-evals.ts --verbose
 */

import { runEvalSuite, formatEvalReport, type EvalRunnerConfig } from './runner'
import { ALL_HARD_EVALS, MULTI_TURN_EVALS } from './test-cases-hard'

const AGENT_ENDPOINT = 'http://localhost:6300/agent/chat'
const VALID_MODELS = ['haiku', 'sonnet', 'opus'] as const
type ModelName = typeof VALID_MODELS[number]

async function main() {
  const args = process.argv.slice(2)
  const verbose = args.includes('--verbose') || args.includes('-v')
  const filterIdx = args.indexOf('--filter')
  const filter = filterIdx !== -1 ? args[filterIdx + 1] : null
  
  // Get model from args or environment
  const modelIdx = args.indexOf('--model')
  const modelArg = modelIdx !== -1 ? args[modelIdx + 1] : null
  const model: ModelName = (modelArg || process.env.AGENT_MODEL || 'sonnet') as ModelName
  
  if (!VALID_MODELS.includes(model)) {
    console.error(`Invalid model: ${model}. Valid models: ${VALID_MODELS.join(', ')}`)
    process.exit(1)
  }
  
  console.log(`\n🤖 Model: claude-${model}`)
  
  // Select which evals to run
  let evals = ALL_HARD_EVALS
  
  if (filter) {
    evals = evals.filter(e => 
      e.id.toLowerCase().includes(filter.toLowerCase()) ||
      e.name.toLowerCase().includes(filter.toLowerCase())
    )
    console.log(`🔍 Running ${evals.length} evals matching "${filter}"`)
  }
  
  if (evals.length === 0) {
    console.error('No evals matched the filter')
    process.exit(1)
  }
  
  // Check if agent is running
  console.log(`\n🔌 Checking agent at ${AGENT_ENDPOINT}...`)
  try {
    const health = await fetch(AGENT_ENDPOINT.replace('/agent/chat', '/health'))
    if (!health.ok) {
      console.error('❌ Agent health check failed')
      console.error('Make sure project-runtime is running with SHOGO_EVAL_MODE=true')
      process.exit(1)
    }
    const healthData = await health.json()
    console.log(`✅ Agent is running (project: ${healthData.projectId})`)
  } catch (e) {
    console.error('❌ Could not connect to agent')
    console.error('Make sure project-runtime is running:')
    console.error('  cd packages/project-runtime')
    console.error('  SHOGO_EVAL_MODE=true PROJECT_DIR=/tmp/shogo-eval-test bun run src/server.ts')
    process.exit(1)
  }
  
  const config: EvalRunnerConfig = {
    agentEndpoint: AGENT_ENDPOINT,
    timeoutMs: 600000, // 10 minutes for hard tests
    verbose,
  }
  
  console.log(`\n🚀 Running ${evals.length} hard evals with claude-${model}...\n`)
  console.log('='.repeat(60))
  
  for (const eval_ of evals) {
    console.log(`\n📋 ${eval_.name} (Level ${eval_.level})`)
    console.log(`   Input: "${eval_.input.slice(0, 60)}${eval_.input.length > 60 ? '...' : ''}"`)
  }
  
  console.log('\n' + '='.repeat(60))
  console.log(`Starting evals with claude-${model}... (this may take several minutes)`)
  console.log('='.repeat(60) + '\n')
  
  const startTime = Date.now()
  const results = await runEvalSuite(`Hard Evals (claude-${model})`, evals, config)
  const duration = ((Date.now() - startTime) / 1000).toFixed(1)
  
  // Print detailed report
  console.log(formatEvalReport(results))
  
  // Calculate totals
  const totalToolCalls = results.results.reduce((sum, r) => sum + r.metrics.toolCallCount, 0)
  const totalTokens = results.results.reduce((sum, r) => sum + r.metrics.tokens.total, 0)
  
  // Print metrics summary
  console.log(`\n📊 METRICS SUMMARY`)
  console.log('-'.repeat(40))
  console.log(`⏱️  Total time:       ${duration}s`)
  console.log(`   Average per eval: ${(parseFloat(duration) / evals.length).toFixed(1)}s`)
  console.log(`🔧 Total tool calls: ${totalToolCalls}`)
  console.log(`   Avg per eval:     ${(totalToolCalls / evals.length).toFixed(1)}`)
  if (totalTokens > 0) {
    console.log(`📝 Total tokens:     ${totalTokens.toLocaleString()}`)
    console.log(`   Avg per eval:     ${(totalTokens / evals.length).toFixed(0)}`)
    // Estimate cost (Claude pricing rough estimate)
    const inputCost = results.results.reduce((sum, r) => sum + r.metrics.tokens.input, 0) * 0.000003
    const outputCost = results.results.reduce((sum, r) => sum + r.metrics.tokens.output, 0) * 0.000015
    console.log(`💰 Est. cost:        $${(inputCost + outputCost).toFixed(4)}`)
  }
  
  // Print summary by difficulty
  console.log('\n📈 BY DIFFICULTY')
  console.log('-'.repeat(40))
  for (const level of [1, 2, 3, 4] as const) {
    const levelResults = results.results.filter(r => r.eval.level === level)
    if (levelResults.length > 0) {
      const passed = levelResults.filter(r => r.passed).length
      const avgScore = levelResults.reduce((sum, r) => sum + r.percentage, 0) / levelResults.length
      const avgTime = levelResults.reduce((sum, r) => sum + r.metrics.timing.totalMs, 0) / levelResults.length
      const avgTools = levelResults.reduce((sum, r) => sum + r.metrics.toolCallCount, 0) / levelResults.length
      console.log(`Level ${level}: ${passed}/${levelResults.length} passed (avg: ${avgScore.toFixed(0)}%, ${avgTools.toFixed(0)} tools, ${(avgTime/1000).toFixed(1)}s)`)
    }
  }
  
  // Exit with error if any failed
  if (results.summary.failed > 0) {
    console.log(`\n❌ ${results.summary.failed} eval(s) failed`)
    
    // Print failed eval details
    console.log('\nFailed Evals:')
    for (const r of results.results.filter(r => !r.passed)) {
      console.log(`\n  📋 ${r.eval.name}`)
      console.log(`     Score: ${r.score}/${r.maxScore} (${r.percentage.toFixed(0)}%)`)
      console.log(`     Input: "${r.eval.input.slice(0, 50)}..."`)
      
      // Show failed criteria
      const failed = r.criteriaResults.filter(c => !c.passed)
      if (failed.length > 0) {
        console.log('     Failed criteria:')
        for (const c of failed) {
          console.log(`       ✗ ${c.criterion.description} (${c.criterion.points} pts)`)
        }
      }
      
      // Show triggered anti-patterns
      if (r.triggeredAntiPatterns.length > 0) {
        console.log('     Anti-patterns triggered:')
        for (const ap of r.triggeredAntiPatterns) {
          console.log(`       ⚠️  ${ap}`)
        }
      }
    }
    
    process.exit(1)
  }
  
  console.log(`\n✅ All ${results.summary.total} evals passed!`)
  process.exit(0)
}

main().catch(e => {
  console.error('Fatal error:', e)
  process.exit(1)
})
