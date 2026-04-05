// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Risk Scorer
 *
 * Computes a per-node risk score (0-1) based on flow membership,
 * test coverage, security keywords, and caller count.
 */

import type { WorkspaceGraph, GraphNode } from './workspace-graph'
import { SECURITY_KEYWORDS, countFlowMemberships } from './flow-detector'

// ---------------------------------------------------------------------------
// Per-node risk computation
// ---------------------------------------------------------------------------

export function computeRiskScore(graph: WorkspaceGraph, node: GraphNode): number {
  let score = 0

  // Flow membership: +0.05 per flow, cap 0.25
  const flowCount = countFlowMemberships(graph, node.id)
  score += Math.min(flowCount * 0.05, 0.25)

  // Cross-community callers: deferred until community detection (0 for now)

  // Missing test coverage: +0.30 if no TESTED_BY, +0.05 if tested
  // TESTED_BY edges: source = function being tested, target = test function
  const testedBy = graph.getEdgesBySource(node.qualifiedName, 'TESTED_BY')
  score += testedBy.length === 0 ? 0.30 : 0.05

  // Security keywords: +0.20 if name matches any keyword
  const lower = (node.name + ' ' + node.qualifiedName).toLowerCase()
  for (const kw of SECURITY_KEYWORDS) {
    if (lower.includes(kw)) {
      score += 0.20
      break
    }
  }

  // Caller count: +min(callers/20, 0.10)
  const callers = graph.getEdgesByTarget(node.qualifiedName, 'CALLS')
  score += Math.min(callers.length / 20, 0.10)

  return Math.round(Math.min(Math.max(score, 0), 1) * 10000) / 10000
}

// ---------------------------------------------------------------------------
// Aggregate risk for a set of nodes / files
// ---------------------------------------------------------------------------

export function computeAggregateRisk(
  graph: WorkspaceGraph, nodes: GraphNode[]
): { maxRisk: number; avgRisk: number; nodeRisks: Map<string, number> } {
  const nodeRisks = new Map<string, number>()
  let totalRisk = 0
  let maxRisk = 0

  for (const node of nodes) {
    if (node.kind === 'File') continue
    const risk = computeRiskScore(graph, node)
    nodeRisks.set(node.qualifiedName, risk)
    totalRisk += risk
    maxRisk = Math.max(maxRisk, risk)
  }

  const count = nodeRisks.size || 1
  return {
    maxRisk: Math.round(maxRisk * 10000) / 10000,
    avgRisk: Math.round((totalRisk / count) * 10000) / 10000,
    nodeRisks,
  }
}

/**
 * Compute overall risk score for a set of changed files.
 * Returns the max risk among all non-File nodes in those files.
 */
export function computeFileSetRisk(
  graph: WorkspaceGraph, filePaths: string[]
): { maxRisk: number; avgRisk: number; nodeRisks: Map<string, number> } {
  const allNodes: GraphNode[] = []
  for (const fp of filePaths) {
    allNodes.push(...graph.getNodesByFile(fp))
  }
  return computeAggregateRisk(graph, allNodes)
}
