/**
 * Metrics Tracking for Agent Evaluations
 *
 * Track eval results over time to measure prompt optimization progress.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import type { EvalSuiteResult, AgentMetrics, EvalCategory } from './types'

/**
 * A single metrics snapshot
 */
export interface MetricsSnapshot {
  /** Unique ID for this snapshot */
  id: string
  /** When the snapshot was taken */
  timestamp: Date
  /** Optional label (e.g., "baseline", "v2-prompt", "after-template-fix") */
  label?: string
  /** Git commit hash if available */
  gitCommit?: string
  /** The metrics values */
  metrics: AgentMetrics
  /** Raw eval results */
  evalResults: EvalSuiteResult
}

/**
 * History of metrics snapshots
 */
export interface MetricsHistory {
  snapshots: MetricsSnapshot[]
}

const METRICS_DIR = '.shogo-evals'
const METRICS_FILE = 'metrics-history.json'

/**
 * Get the metrics file path
 */
function getMetricsPath(baseDir: string = process.cwd()): string {
  return join(baseDir, METRICS_DIR, METRICS_FILE)
}

/**
 * Load metrics history from disk
 */
export function loadMetricsHistory(baseDir?: string): MetricsHistory {
  const path = getMetricsPath(baseDir)
  
  if (!existsSync(path)) {
    return { snapshots: [] }
  }
  
  try {
    const content = readFileSync(path, 'utf-8')
    const data = JSON.parse(content)
    
    // Convert date strings back to Date objects
    data.snapshots = data.snapshots.map((s: any) => ({
      ...s,
      timestamp: new Date(s.timestamp),
      evalResults: {
        ...s.evalResults,
        timestamp: new Date(s.evalResults.timestamp),
      },
    }))
    
    return data
  } catch (error) {
    console.warn('Failed to load metrics history:', error)
    return { snapshots: [] }
  }
}

/**
 * Save metrics history to disk
 */
export function saveMetricsHistory(history: MetricsHistory, baseDir?: string): void {
  const path = getMetricsPath(baseDir)
  const dir = dirname(path)
  
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  
  writeFileSync(path, JSON.stringify(history, null, 2))
}

/**
 * Calculate metrics from eval results
 */
export function calculateMetrics(results: EvalSuiteResult): AgentMetrics {
  const templateEvals = results.results.filter(
    (r) => r.eval.category === 'template-selection'
  )
  
  const toolEvals = results.results.filter(
    (r) => r.eval.category === 'tool-usage'
  )
  
  // Template selection accuracy
  const templateCorrect = templateEvals.filter((r) => {
    if (!r.eval.expectedTemplate) return true
    const copyCall = r.toolCalls.find((t) => t.name === 'template.copy')
    return copyCall?.params?.template === r.eval.expectedTemplate
  })
  
  const templateSelectionAccuracy = templateEvals.length > 0
    ? templateCorrect.length / templateEvals.length
    : 1.0
  
  // Tool call success rate
  const toolCallSuccessRate = results.summary.passRate / 100
  
  // Parameter accuracy (from tool correctness scores)
  const paramScores = results.results.map((r) => {
    const criteria = r.criteriaResults.filter(
      (c) => c.criterion.id.includes('param') || c.criterion.id.includes('tool-usage')
    )
    if (criteria.length === 0) return 1.0
    return criteria.filter((c) => c.passed).length / criteria.length
  })
  const parameterAccuracy = paramScores.reduce((a, b) => a + b, 0) / paramScores.length
  
  // First-try success rate
  const firstTrySuccessRate = results.summary.passed / results.summary.total
  
  // Clarification rate
  const askedClarification = results.results.filter((r) => {
    const text = r.responseText.toLowerCase()
    return text.includes('would you') || text.includes('which') || text.includes('what kind')
  })
  const clarificationRate = askedClarification.length / results.results.length
  
  // Average latency
  const latencies = results.results.map((r) => r.timing.durationMs)
  const averageLatencyMs = latencies.reduce((a, b) => a + b, 0) / latencies.length
  
  return {
    templateSelectionAccuracy,
    toolCallSuccessRate,
    parameterAccuracy,
    firstTrySuccessRate,
    clarificationRate,
    averageLatencyMs,
  }
}

/**
 * Create a new metrics snapshot
 */
export function createSnapshot(
  results: EvalSuiteResult,
  label?: string,
  gitCommit?: string
): MetricsSnapshot {
  return {
    id: `snapshot-${Date.now()}`,
    timestamp: new Date(),
    label,
    gitCommit,
    metrics: calculateMetrics(results),
    evalResults: results,
  }
}

/**
 * Add a snapshot to history and save
 */
export function recordSnapshot(
  results: EvalSuiteResult,
  label?: string,
  gitCommit?: string,
  baseDir?: string
): MetricsSnapshot {
  const history = loadMetricsHistory(baseDir)
  const snapshot = createSnapshot(results, label, gitCommit)
  
  history.snapshots.push(snapshot)
  saveMetricsHistory(history, baseDir)
  
  return snapshot
}

/**
 * Compare two snapshots
 */
export interface MetricsComparison {
  before: MetricsSnapshot
  after: MetricsSnapshot
  delta: {
    templateSelectionAccuracy: number
    toolCallSuccessRate: number
    parameterAccuracy: number
    firstTrySuccessRate: number
    clarificationRate: number
    averageLatencyMs: number
  }
  improved: string[]
  regressed: string[]
  unchanged: string[]
}

export function compareSnapshots(
  before: MetricsSnapshot,
  after: MetricsSnapshot
): MetricsComparison {
  const delta = {
    templateSelectionAccuracy:
      after.metrics.templateSelectionAccuracy - before.metrics.templateSelectionAccuracy,
    toolCallSuccessRate:
      after.metrics.toolCallSuccessRate - before.metrics.toolCallSuccessRate,
    parameterAccuracy:
      after.metrics.parameterAccuracy - before.metrics.parameterAccuracy,
    firstTrySuccessRate:
      after.metrics.firstTrySuccessRate - before.metrics.firstTrySuccessRate,
    clarificationRate:
      after.metrics.clarificationRate - before.metrics.clarificationRate,
    averageLatencyMs:
      after.metrics.averageLatencyMs - before.metrics.averageLatencyMs,
  }
  
  const improved: string[] = []
  const regressed: string[] = []
  const unchanged: string[] = []
  
  const threshold = 0.01 // 1% threshold for considering a change
  
  // Higher is better for these
  const higherIsBetter = [
    'templateSelectionAccuracy',
    'toolCallSuccessRate',
    'parameterAccuracy',
    'firstTrySuccessRate',
  ]
  
  // Lower is better for these
  const lowerIsBetter = ['clarificationRate', 'averageLatencyMs']
  
  for (const metric of higherIsBetter) {
    const d = delta[metric as keyof typeof delta]
    if (d > threshold) improved.push(metric)
    else if (d < -threshold) regressed.push(metric)
    else unchanged.push(metric)
  }
  
  for (const metric of lowerIsBetter) {
    const d = delta[metric as keyof typeof delta]
    if (d < -threshold) improved.push(metric)
    else if (d > threshold) regressed.push(metric)
    else unchanged.push(metric)
  }
  
  return { before, after, delta, improved, regressed, unchanged }
}

/**
 * Format a metrics comparison as a report
 */
export function formatComparisonReport(comparison: MetricsComparison): string {
  const lines: string[] = []
  
  lines.push('\n' + '='.repeat(60))
  lines.push('METRICS COMPARISON')
  lines.push('='.repeat(60))
  lines.push(`Before: ${comparison.before.label || comparison.before.id}`)
  lines.push(`After:  ${comparison.after.label || comparison.after.id}`)
  lines.push('')
  
  lines.push('CHANGES')
  lines.push('-'.repeat(40))
  
  const formatDelta = (value: number, isPercentage: boolean = true) => {
    const sign = value >= 0 ? '+' : ''
    if (isPercentage) {
      return `${sign}${(value * 100).toFixed(1)}%`
    }
    return `${sign}${value.toFixed(0)}ms`
  }
  
  lines.push(`Template Selection: ${formatDelta(comparison.delta.templateSelectionAccuracy)}`)
  lines.push(`Tool Call Success:  ${formatDelta(comparison.delta.toolCallSuccessRate)}`)
  lines.push(`Parameter Accuracy: ${formatDelta(comparison.delta.parameterAccuracy)}`)
  lines.push(`First-Try Success:  ${formatDelta(comparison.delta.firstTrySuccessRate)}`)
  lines.push(`Clarification Rate: ${formatDelta(comparison.delta.clarificationRate)}`)
  lines.push(`Average Latency:    ${formatDelta(comparison.delta.averageLatencyMs, false)}`)
  lines.push('')
  
  if (comparison.improved.length > 0) {
    lines.push(`✅ Improved: ${comparison.improved.join(', ')}`)
  }
  if (comparison.regressed.length > 0) {
    lines.push(`❌ Regressed: ${comparison.regressed.join(', ')}`)
  }
  if (comparison.unchanged.length > 0) {
    lines.push(`➖ Unchanged: ${comparison.unchanged.join(', ')}`)
  }
  
  lines.push('')
  lines.push('='.repeat(60))
  
  return lines.join('\n')
}

/**
 * Get the latest snapshot
 */
export function getLatestSnapshot(baseDir?: string): MetricsSnapshot | null {
  const history = loadMetricsHistory(baseDir)
  if (history.snapshots.length === 0) return null
  return history.snapshots[history.snapshots.length - 1]
}

/**
 * Get baseline snapshot (first one or labeled "baseline")
 */
export function getBaselineSnapshot(baseDir?: string): MetricsSnapshot | null {
  const history = loadMetricsHistory(baseDir)
  if (history.snapshots.length === 0) return null
  
  const baseline = history.snapshots.find((s) => s.label === 'baseline')
  if (baseline) return baseline
  
  return history.snapshots[0]
}

/**
 * Format metrics as a simple table
 */
export function formatMetricsTable(metrics: AgentMetrics): string {
  const lines: string[] = []
  
  lines.push('AGENT METRICS')
  lines.push('-'.repeat(40))
  lines.push(`Template Selection:  ${(metrics.templateSelectionAccuracy * 100).toFixed(1)}%`)
  lines.push(`Tool Call Success:   ${(metrics.toolCallSuccessRate * 100).toFixed(1)}%`)
  lines.push(`Parameter Accuracy:  ${(metrics.parameterAccuracy * 100).toFixed(1)}%`)
  lines.push(`First-Try Success:   ${(metrics.firstTrySuccessRate * 100).toFixed(1)}%`)
  lines.push(`Clarification Rate:  ${(metrics.clarificationRate * 100).toFixed(1)}%`)
  lines.push(`Average Latency:     ${metrics.averageLatencyMs.toFixed(0)}ms`)
  
  return lines.join('\n')
}
