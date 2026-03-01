/**
 * Integration Runner for Agent Evaluations
 *
 * Runs evals against the actual Shogo agent API and records results.
 */

import {
  runEvalSuite,
  formatEvalReport,
  type EvalRunnerConfig,
} from './runner'
import {
  ALL_EVALS,
  TEMPLATE_SELECTION_EVALS,
  TOOL_USAGE_EVALS,
  EDGE_CASE_EVALS,
} from './test-cases'
import { ALL_EXTENDED_EVALS } from './test-cases-extended'
import {
  recordSnapshot,
  getLatestSnapshot,
  getBaselineSnapshot,
  compareSnapshots,
  formatComparisonReport,
  formatMetricsTable,
  calculateMetrics,
} from './metrics'
import type { AgentEval, EvalSuiteResult } from './types'

/**
 * Configuration for integration runs
 */
export interface IntegrationRunConfig {
  /** Label for this run (e.g., "baseline", "v2-prompt") */
  label?: string
  /** Git commit hash */
  gitCommit?: string
  /** Agent API endpoint */
  endpoint?: string
  /** Run in verbose mode */
  verbose?: boolean
  /** Include extended test cases */
  includeExtended?: boolean
  /** Compare against baseline */
  compareBaseline?: boolean
  /** Compare against latest */
  compareLatest?: boolean
  /** Save results to metrics history */
  saveResults?: boolean
  /** Category filter */
  category?: 'template-selection' | 'tool-usage' | 'edge-cases' | 'all'
}

/**
 * Run a full integration evaluation
 */
export async function runIntegrationEval(
  config: IntegrationRunConfig = {}
): Promise<{
  results: EvalSuiteResult
  comparison?: ReturnType<typeof compareSnapshots>
}> {
  const {
    label,
    gitCommit,
    endpoint = 'http://localhost:6300/agent/chat',
    verbose = false,
    includeExtended = true,
    compareBaseline = false,
    compareLatest = true,
    saveResults = true,
    category = 'all',
  } = config

  // Select evals to run
  let evalsToRun: AgentEval[]
  let suiteName: string

  switch (category) {
    case 'template-selection':
      evalsToRun = [...TEMPLATE_SELECTION_EVALS]
      if (includeExtended) {
        evalsToRun.push(
          ...ALL_EXTENDED_EVALS.filter((e) => e.category === 'template-selection')
        )
      }
      suiteName = 'Template Selection'
      break
    case 'tool-usage':
      evalsToRun = [...TOOL_USAGE_EVALS]
      if (includeExtended) {
        evalsToRun.push(
          ...ALL_EXTENDED_EVALS.filter((e) => e.category === 'tool-usage')
        )
      }
      suiteName = 'Tool Usage'
      break
    case 'edge-cases':
      evalsToRun = [...EDGE_CASE_EVALS]
      if (includeExtended) {
        evalsToRun.push(
          ...ALL_EXTENDED_EVALS.filter((e) => e.category === 'edge-cases')
        )
      }
      suiteName = 'Edge Cases'
      break
    default:
      evalsToRun = [...ALL_EVALS]
      if (includeExtended) {
        evalsToRun.push(...ALL_EXTENDED_EVALS)
      }
      suiteName = label || 'Full Integration'
  }

  console.log(`\n🧪 Running ${evalsToRun.length} evals: ${suiteName}`)
  if (label) console.log(`   Label: ${label}`)
  console.log(`   Endpoint: ${endpoint}`)
  console.log('')

  // Run the evals
  const runnerConfig: EvalRunnerConfig = {
    agentEndpoint: endpoint,
    verbose,
    timeoutMs: 120000, // 2 minutes per eval for integration tests
  }

  const results = await runEvalSuite(suiteName, evalsToRun, runnerConfig)

  // Print report
  console.log(formatEvalReport(results))

  // Calculate and display metrics
  const metrics = calculateMetrics(results)
  console.log('\n' + formatMetricsTable(metrics))

  // Save results if requested
  if (saveResults) {
    const snapshot = recordSnapshot(results, label, gitCommit)
    console.log(`\n💾 Results saved as: ${snapshot.id}`)
  }

  // Compare against previous runs
  let comparison

  if (compareBaseline) {
    const baseline = getBaselineSnapshot()
    if (baseline) {
      const current = { 
        id: 'current', 
        timestamp: new Date(), 
        label, 
        metrics, 
        evalResults: results 
      }
      comparison = compareSnapshots(baseline, current)
      console.log(formatComparisonReport(comparison))
    } else {
      console.log('\n⚠️  No baseline snapshot found for comparison')
    }
  } else if (compareLatest) {
    const latest = getLatestSnapshot()
    if (latest && latest.id !== `snapshot-${Date.now()}`) {
      const current = { 
        id: 'current', 
        timestamp: new Date(), 
        label, 
        metrics, 
        evalResults: results 
      }
      comparison = compareSnapshots(latest, current)
      console.log(formatComparisonReport(comparison))
    }
  }

  return { results, comparison }
}

/**
 * Run a quick smoke test (just a few key evals)
 */
export async function runSmokeTest(
  endpoint: string = 'http://localhost:3002/api/chat'
): Promise<boolean> {
  const smokeTestEvals = [
    ALL_EVALS.find((e) => e.id === 'template-selection-todo-direct')!,
    ALL_EVALS.find((e) => e.id === 'template-selection-expense-direct')!,
    ALL_EVALS.find((e) => e.id === 'tool-params-with-name')!,
  ].filter(Boolean)

  console.log(`\n🔥 Running smoke test (${smokeTestEvals.length} evals)...`)

  const results = await runEvalSuite('Smoke Test', smokeTestEvals, {
    agentEndpoint: endpoint,
    verbose: false,
    timeoutMs: 180000, // 3 minutes for smoke tests - agent can be slow
  })

  const passed = results.summary.passRate >= 70

  if (passed) {
    console.log(`\n✅ Smoke test PASSED (${results.summary.passRate.toFixed(0)}%)`)
  } else {
    console.log(`\n❌ Smoke test FAILED (${results.summary.passRate.toFixed(0)}%)`)
    console.log(formatEvalReport(results))
  }

  return passed
}

/**
 * Establish a baseline for future comparisons
 */
export async function establishBaseline(
  endpoint: string = 'http://localhost:3002/api/chat',
  gitCommit?: string
): Promise<void> {
  console.log('\n📊 Establishing baseline metrics...')

  const { results } = await runIntegrationEval({
    label: 'baseline',
    gitCommit,
    endpoint,
    verbose: true,
    includeExtended: true,
    compareBaseline: false,
    compareLatest: false,
    saveResults: true,
  })

  console.log('\n✅ Baseline established!')
  console.log('   Future runs will be compared against this baseline.')
}

/**
 * Quick check if agent is responding
 */
export async function checkAgentHealth(
  endpoint: string = 'http://localhost:3002/api/chat'
): Promise<boolean> {
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'Hello' }],
      }),
      signal: AbortSignal.timeout(10000),
    })

    return response.ok
  } catch {
    return false
  }
}
