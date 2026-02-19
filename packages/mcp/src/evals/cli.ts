#!/usr/bin/env bun
/**
 * CLI for running Shogo Agent Evaluations
 *
 * Usage:
 *   bun run packages/mcp/src/evals/cli.ts [command] [options]
 *
 * Commands:
 *   run              Run evaluations (default)
 *   baseline         Establish baseline metrics
 *   compare          Compare current vs baseline
 *   smoke            Quick smoke test
 *   health           Check if agent is responding
 *
 * Options:
 *   --category <cat>   Run only evals in this category
 *   --verbose          Show detailed output
 *   --json             Output results as JSON
 *   --label <name>     Label for this run
 *   --save             Save results to metrics history
 *   --extended         Include extended test cases
 *   --endpoint <url>   Agent API endpoint
 *   --help             Show help
 */

import {
  runEvalSuite,
  formatEvalReport,
  ALL_EVALS,
  ALL_EXTENDED_EVALS,
  TEMPLATE_SELECTION_EVALS,
  TOOL_USAGE_EVALS,
  EDGE_CASE_EVALS,
  ALL_BUSINESS_USER_EVALS,
  MULTI_TURN_COHERENCE_EVALS,
  RUNTIME_SAFETY_EVALS,
  type EvalCategory,
  type AgentEval,
} from './index'
import {
  runIntegrationEval,
  runSmokeTest,
  establishBaseline,
  checkAgentHealth,
} from './integration-runner'
import {
  getBaselineSnapshot,
  getLatestSnapshot,
  compareSnapshots,
  formatComparisonReport,
  formatMetricsTable,
  calculateMetrics,
  recordSnapshot,
} from './metrics'

// Parse CLI arguments
const args = process.argv.slice(2)

function showHelp() {
  console.log(`
Shogo Agent Evaluation CLI

Usage:
  bun run packages/mcp/src/evals/cli.ts [command] [options]

Commands:
  run              Run evaluations (default)
  baseline         Establish baseline metrics for comparison
  compare          Compare latest run vs baseline
  smoke            Quick smoke test (3 key evals)
  health           Check if agent API is responding

Options:
  --category <cat>   Run only evals in this category
                     Categories: template-selection, tool-usage, multi-turn, edge-cases
                                 business, multi-turn-coherence
  --filter <pattern> Filter evals by name pattern (case insensitive)
  --verbose          Show detailed output during run
  --json             Output results as JSON (for programmatic use)
  --label <name>     Label for this run (e.g., "v2-prompt", "after-fix")
  --save             Save results to metrics history
  --extended         Include extended test cases (27 total)
  --endpoint <url>   Shogo agent endpoint (default: http://localhost:6300/agent/chat)
  --help             Show this help message

Examples:
  # Run all evals with mock (no agent needed)
  bun run packages/mcp/src/evals/cli.ts

  # Run against live agent
  bun run packages/mcp/src/evals/cli.ts --endpoint http://localhost:3002/api/chat

  # Establish baseline before making prompt changes
  bun run packages/mcp/src/evals/cli.ts baseline --endpoint http://localhost:3002/api/chat

  # Run after changes and compare to baseline
  bun run packages/mcp/src/evals/cli.ts run --label "v2-prompt" --save --extended

  # Run only template selection evals
  bun run packages/mcp/src/evals/cli.ts --category template-selection --verbose

  # Quick smoke test
  bun run packages/mcp/src/evals/cli.ts smoke --endpoint http://localhost:3002/api/chat

  # Output as JSON for CI
  bun run packages/mcp/src/evals/cli.ts --json > results.json

Workflow for Prompt Optimization:
  1. Start agent: bun run api:dev (in another terminal)
  2. Establish baseline: bun run packages/mcp/src/evals/cli.ts baseline
  3. Make prompt changes in packages/project-runtime/src/system-prompt.ts
  4. Run evals: bun run packages/mcp/src/evals/cli.ts run --label "your-change" --save
  5. Review comparison report
  6. Iterate until metrics improve
`)
}

function getArg(name: string): string | undefined {
  const index = args.indexOf(`--${name}`)
  if (index !== -1 && args[index + 1] && !args[index + 1].startsWith('--')) {
    return args[index + 1]
  }
  return undefined
}

function hasFlag(name: string): boolean {
  return args.includes(`--${name}`)
}

function getCommand(): string {
  const commands = ['run', 'baseline', 'compare', 'smoke', 'health']
  for (const arg of args) {
    if (commands.includes(arg)) return arg
  }
  return 'run'
}

async function main() {
  // Check for help
  if (hasFlag('help')) {
    showHelp()
    process.exit(0)
  }

  const command = getCommand()
  const verbose = hasFlag('verbose')
  const jsonOutput = hasFlag('json')
  const includeExtended = hasFlag('extended')
  const saveResults = hasFlag('save')
  const category = getArg('category') as EvalCategory | 'business' | 'business-user' | 'multiturn' | undefined
  // Default to Shogo agent in project-runtime (has template tools)
  // Platform /api/chat uses persona prompts without template tools
  const endpoint = getArg('endpoint') || 'http://localhost:6300/agent/chat'
  const label = getArg('label')

  // Handle commands
  switch (command) {
    case 'health': {
      if (!jsonOutput) console.log(`\n🏥 Checking agent health at ${endpoint}...`)
      const healthy = await checkAgentHealth(endpoint)
      if (jsonOutput) {
        console.log(JSON.stringify({ healthy, endpoint }))
      } else if (healthy) {
        console.log('✅ Agent is responding\n')
      } else {
        console.log('❌ Agent is not responding\n')
        process.exit(1)
      }
      return
    }

    case 'smoke': {
      if (!jsonOutput) console.log(`\n🔥 Running smoke test against ${endpoint}...`)
      const passed = await runSmokeTest(endpoint)
      if (jsonOutput) {
        console.log(JSON.stringify({ passed, endpoint }))
      }
      process.exit(passed ? 0 : 1)
    }

    case 'baseline': {
      if (!jsonOutput) console.log(`\n📊 Establishing baseline at ${endpoint}...`)
      await establishBaseline(endpoint)
      return
    }

    case 'compare': {
      const baseline = getBaselineSnapshot()
      const latest = getLatestSnapshot()
      
      if (!baseline) {
        console.error('❌ No baseline found. Run "baseline" command first.')
        process.exit(1)
      }
      
      if (!latest || latest.id === baseline.id) {
        console.error('❌ No runs after baseline. Run evals with --save first.')
        process.exit(1)
      }
      
      const comparison = compareSnapshots(baseline, latest)
      
      if (jsonOutput) {
        console.log(JSON.stringify(comparison, null, 2))
      } else {
        console.log(formatComparisonReport(comparison))
      }
      return
    }

    case 'run':
    default: {
      // Select evals to run
      let evalsToRun: AgentEval[]
      let suiteName: string
      const filterPattern = getArg('filter')

      if (category) {
        switch (category) {
          case 'template-selection':
            evalsToRun = [...TEMPLATE_SELECTION_EVALS]
            if (includeExtended) {
              evalsToRun.push(...ALL_EXTENDED_EVALS.filter(e => e.category === 'template-selection'))
            }
            suiteName = 'Template Selection'
            break
          case 'tool-usage':
            evalsToRun = [...TOOL_USAGE_EVALS]
            if (includeExtended) {
              evalsToRun.push(...ALL_EXTENDED_EVALS.filter(e => e.category === 'tool-usage'))
            }
            suiteName = 'Tool Usage'
            break
          case 'edge-cases':
            evalsToRun = [...EDGE_CASE_EVALS]
            if (includeExtended) {
              evalsToRun.push(...ALL_EXTENDED_EVALS.filter(e => e.category === 'edge-cases'))
            }
            suiteName = 'Edge Cases'
            break
          // Business user categories
          case 'business':
          case 'business-user':
            evalsToRun = [...ALL_BUSINESS_USER_EVALS]
            suiteName = 'Business User'
            break
          case 'multi-turn-coherence':
          case 'multiturn':
            evalsToRun = [...MULTI_TURN_COHERENCE_EVALS]
            suiteName = 'Multi-Turn Coherence'
            break
          case 'runtime-safety':
            evalsToRun = [...RUNTIME_SAFETY_EVALS]
            suiteName = 'Runtime Safety'
            break
          default:
            evalsToRun = ALL_EVALS.filter(e => e.category === category)
            if (includeExtended) {
              evalsToRun.push(...ALL_EXTENDED_EVALS.filter(e => e.category === category))
            }
            evalsToRun.push(...ALL_BUSINESS_USER_EVALS.filter(e => e.category === category))
            suiteName = category
        }
      } else {
        evalsToRun = [...ALL_EVALS]
        if (includeExtended) {
          evalsToRun.push(...ALL_EXTENDED_EVALS)
        }
        suiteName = label || 'All Evals'
      }
      
      // Apply filter if provided
      if (filterPattern) {
        const pattern = filterPattern.toLowerCase()
        evalsToRun = evalsToRun.filter(e => e.name.toLowerCase().includes(pattern))
        suiteName = `${suiteName} (filtered: ${filterPattern})`
      }

      if (evalsToRun.length === 0) {
        console.error(`No evals found for category: ${category}`)
        process.exit(1)
      }

      if (!jsonOutput) {
        console.log(`\n🧪 Running ${evalsToRun.length} evals: ${suiteName}`)
        if (label) console.log(`   Label: ${label}`)
        console.log(`   Endpoint: ${endpoint}`)
        console.log('')
      }

      // Run the evals
      const config = {
        verbose,
        agentEndpoint: endpoint,
      }

      const results = await runEvalSuite(suiteName, evalsToRun, config)

      // Save if requested
      if (saveResults) {
        const snapshot = recordSnapshot(results, label)
        if (!jsonOutput) {
          console.log(`\n💾 Results saved as: ${snapshot.id}`)
        }
      }

      // Output results
      if (jsonOutput) {
        console.log(JSON.stringify(results, null, 2))
      } else {
        console.log(formatEvalReport(results))

        // Show metrics
        const metrics = calculateMetrics(results)
        console.log('\n' + formatMetricsTable(metrics))

        // Compare to baseline if available
        const baseline = getBaselineSnapshot()
        if (baseline && saveResults) {
          const current = { 
            id: 'current', 
            timestamp: new Date(), 
            label, 
            metrics, 
            evalResults: results 
          }
          const comparison = compareSnapshots(baseline, current)
          console.log(formatComparisonReport(comparison))
        }

        // Summary with emoji
        const emoji = results.summary.passRate >= 80 ? '✅' : 
                      results.summary.passRate >= 50 ? '⚠️' : '❌'
        
        console.log(`\n${emoji} Overall: ${results.summary.passRate.toFixed(1)}% pass rate`)
        console.log(`   ${results.summary.passed}/${results.summary.total} evals passed\n`)
      }

      // Exit with error code if too many failures
      if (results.summary.passRate < 50) {
        process.exit(1)
      }
    }
  }
}

main().catch((error) => {
  console.error('Error running evals:', error)
  process.exit(1)
})
