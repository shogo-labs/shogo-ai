#!/usr/bin/env bun
/**
 * Run template-specific evals (CRM, Inventory, etc.)
 * 
 * Usage:
 *   bun run src/evals/run-template-evals.ts --template crm --model haiku
 *   bun run src/evals/run-template-evals.ts --template inventory --model sonnet
 *   bun run src/evals/run-template-evals.ts --template all --model opus
 */

import { runEvalSuite, formatEvalReport, type EvalRunnerConfig } from './runner'
import type { EvalSuiteResult } from './types'
import { ALL_CRM_EVALS } from './test-cases-crm'
import { ALL_INVENTORY_EVALS } from './test-cases-inventory'
import type { AgentEval } from './types'

// Parse command line arguments
const args = process.argv.slice(2)
const templateArg = args.find(a => a.startsWith('--template='))?.split('=')[1] ||
                    args[args.indexOf('--template') + 1] || 
                    'crm'
const modelArg = args.find(a => a.startsWith('--model='))?.split('=')[1] ||
                 args[args.indexOf('--model') + 1] || 
                 process.env.AGENT_MODEL ||
                 'sonnet'
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
    case 'all':
      return [...ALL_CRM_EVALS, ...ALL_INVENTORY_EVALS]
    default:
      console.error(`Unknown template: ${template}`)
      console.error('Available: crm, inventory, all')
      process.exit(1)
  }
}

async function main() {
  console.log('')
  console.log(`🏢 Template: ${templateArg.toUpperCase()}`)
  console.log(`🤖 Model: claude-${modelArg}`)
  
  let evals = getEvals(templateArg)
  
  // Apply filter if provided
  if (filterArg) {
    const filterLower = filterArg.toLowerCase()
    evals = evals.filter(e => 
      e.id.toLowerCase().includes(filterLower) ||
      e.name.toLowerCase().includes(filterLower) ||
      e.input.toLowerCase().includes(filterLower)
    )
    console.log(`🔍 Running ${evals.length} evals matching "${filterArg}"`)
  } else {
    console.log(`🔍 Running ${evals.length} evals`)
  }
  
  if (evals.length === 0) {
    console.log('No evals matched the filter')
    process.exit(1)
  }
  
  // Check agent health
  console.log('')
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
    timeoutMs: 600000, // 10 minutes for complex template evals
    retries: 1,
    verbose: verboseArg,
  }
  
  console.log('')
  console.log(`🚀 Running ${evals.length} ${templateArg} evals with claude-${modelArg}...`)
  console.log('')
  
  for (const ev of evals) {
    console.log('============================================================')
    console.log(``)
    console.log(`📋 ${ev.name} (Level ${ev.level})`)
    console.log(`   Input: "${ev.input.substring(0, 60)}..."`)
    console.log(``)
    console.log('============================================================')
  }
  
  console.log('Starting evals with claude-' + modelArg + '... (this may take several minutes)')
  console.log('============================================================')
  console.log('')
  
  // Clean project directory before each eval
  const cleanProject = async () => {
    const { execSync } = await import('child_process')
    execSync('rm -rf /tmp/shogo-eval-test && mkdir -p /tmp/shogo-eval-test', { stdio: 'pipe' })
  }
  
  // Run evals one at a time with project cleanup
  const results = []
  for (const ev of evals) {
    await cleanProject()
    const suiteResult = await runEvalSuite(`${templateArg}-${ev.id}`, [ev], config)
    if (suiteResult.results.length > 0) {
      results.push(suiteResult.results[0])
    }
  }
  
  // Generate report
  const passed = results.filter(r => r.passed).length
  const failed = results.filter(r => !r.passed).length
  
  // Build byCategory summary
  const byCategory: Record<string, { total: number; passed: number; passRate: number }> = {}
  for (const r of results) {
    const category = evals.find(e => e.id === r.eval?.id)?.category || 'unknown'
    if (!byCategory[category]) {
      byCategory[category] = { total: 0, passed: 0, passRate: 0 }
    }
    byCategory[category].total++
    if (r.passed) byCategory[category].passed++
  }
  for (const cat of Object.values(byCategory)) {
    cat.passRate = cat.total > 0 ? (cat.passed / cat.total) * 100 : 0
  }
  
  const suiteResult: EvalSuiteResult = {
    name: `${templateArg.toUpperCase()} Evals (claude-${modelArg})`,
    timestamp: new Date(),
    results,
    summary: {
      total: results.length,
      passed,
      failed,
      passRate: passed / results.length * 100,
      averageScore: results.reduce((s, r) => s + r.score, 0) / results.length,
      totalPoints: results.reduce((s, r) => s + r.score, 0),
      maxPoints: results.reduce((s, r) => s + r.maxScore, 0),
    },
    byCategory: byCategory as any,
  }
  const report = formatEvalReport(suiteResult)
  console.log(report)
  
  // Calculate metrics
  const totalToolCalls = results.reduce((sum, r) => sum + (r.metrics?.toolCallCount || 0), 0)
  const totalTokens = results.reduce((sum, r) => sum + (r.metrics?.tokens.total || 0), 0)
  const totalTime = results.reduce((sum, r) => sum + (r.metrics?.timing.totalMs || 0), 0)
  
  console.log('')
  console.log(`📊 METRICS SUMMARY`)
  console.log(`----------------------------------------`)
  console.log(`⏱️  Total time:       ${(totalTime / 1000).toFixed(1)}s`)
  console.log(`   Average per eval: ${(totalTime / 1000 / results.length).toFixed(1)}s`)
  console.log(`🔧 Total tool calls: ${totalToolCalls}`)
  console.log(`   Avg per eval:     ${(totalToolCalls / results.length).toFixed(1)}`)
  console.log(`📝 Total tokens:     ${totalTokens.toLocaleString()}`)
  console.log(`   Avg per eval:     ${Math.round(totalTokens / results.length)}`)
  
  // Estimate cost (rough: $3/1M input, $15/1M output for Claude)
  const estimatedCost = (totalTokens * 0.000015).toFixed(4)
  console.log(`💰 Est. cost:        $${estimatedCost}`)
  
  // Group by level
  console.log('')
  console.log(`📈 BY DIFFICULTY`)
  console.log(`----------------------------------------`)
  const byLevel = new Map<number, typeof results>()
  for (const r of results) {
    const level = evals.find(e => e.id === r.eval?.id)?.level || 0
    if (!byLevel.has(level)) byLevel.set(level, [])
    byLevel.get(level)!.push(r)
  }
  for (const [level, levelResults] of [...byLevel.entries()].sort((a, b) => a[0] - b[0])) {
    const levelPassed = levelResults.filter(r => r.passed).length
    const levelTotal = levelResults.length
    const avgScore = Math.round(levelResults.reduce((s, r) => s + r.score, 0) / levelTotal)
    const avgTools = (levelResults.reduce((s, r) => s + (r.metrics?.toolCallCount || 0), 0) / levelTotal).toFixed(1)
    const avgTime = (levelResults.reduce((s, r) => s + (r.metrics?.timing.totalMs || 0), 0) / levelTotal / 1000).toFixed(1)
    console.log(`Level ${level}: ${levelPassed}/${levelTotal} passed (avg: ${avgScore}%, ${avgTools} tools, ${avgTime}s)`)
  }
  
  // Group by category (for console output)
  console.log('')
  console.log(`📈 BY CATEGORY`)
  console.log(`----------------------------------------`)
  const categoryMap = new Map<string, typeof results>()
  for (const r of results) {
    const category = evals.find(e => e.id === r.eval?.id)?.category || 'unknown'
    if (!categoryMap.has(category)) categoryMap.set(category, [])
    categoryMap.get(category)!.push(r)
  }
  for (const [category, catResults] of [...categoryMap.entries()].sort()) {
    const catPassed = catResults.filter(r => r.passed).length
    const catTotal = catResults.length
    const avgScore = Math.round(catResults.reduce((s, r) => s + r.score, 0) / catTotal)
    console.log(`${category}: ${catPassed}/${catTotal} passed (avg: ${avgScore}%)`)
  }
  
  console.log('')
  if (failed === 0) {
    console.log(`✅ All ${passed} evals passed!`)
  } else {
    console.log(`❌ ${failed} eval(s) failed`)
    console.log('')
    console.log('Failed Evals:')
    for (const r of results.filter(r => !r.passed)) {
      const ev = evals.find(e => e.id === r.eval?.id)
      console.log('')
      console.log(`  📋 ${ev?.name || r.eval?.id}`)
      console.log(`     Score: ${r.score}/${ev?.maxScore || 100} (${r.percentage.toFixed(0)}%)`)
      console.log(`     Input: "${ev?.input.substring(0, 50)}..."`)
      
      // Show which criteria failed
      const failedCriteria = r.criteriaResults?.filter(c => !c.passed) || []
      if (failedCriteria.length > 0) {
        console.log(`     Failed criteria:`)
        for (const c of failedCriteria) {
          console.log(`       ✗ ${c.criterion.description} (${c.criterion.points} pts)`)
        }
      }
    }
  }
  
  process.exit(failed > 0 ? 1 : 0)
}

main().catch(console.error)
