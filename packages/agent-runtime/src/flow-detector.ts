// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Execution Flow Detection
 *
 * Detects entry points (functions with no callers, framework decorators,
 * or naming patterns), traces call chains via BFS, and scores criticality.
 */

import type { WorkspaceGraph, GraphNode, GraphEdge } from './workspace-graph'
import type { Database } from 'bun:sqlite'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const SECURITY_KEYWORDS = new Set([
  'auth', 'login', 'password', 'token', 'session', 'crypt', 'secret',
  'credential', 'permission', 'sql', 'query', 'execute', 'connect',
  'socket', 'request', 'http', 'sanitize', 'validate', 'encrypt',
  'decrypt', 'hash', 'sign', 'verify', 'admin', 'privilege',
])

const FRAMEWORK_DECORATOR_PATTERNS = [
  /app\.(get|post|put|delete|patch|route|websocket)/i,
  /router\.(get|post|put|delete|patch|route)/i,
  /blueprint\.(route|before_request|after_request)/i,
  /click\.(command|group)/i,
  /celery\.(task|shared_task)/i,
  /api_view/i,
  /\baction\b/i,
  /@(Get|Post|Put|Delete|Patch|RequestMapping)/,
]

const ENTRY_NAME_PATTERNS = [
  /^main$/,
  /^__main__$/,
  /^test_/,
  /^Test[A-Z]/,
  /^on_/,
  /^handle_/,
]

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FlowInfo {
  name: string
  entryPointQN: string
  entryPointId: number | null
  path: number[]
  pathQNs: string[]
  depth: number
  nodeCount: number
  fileCount: number
  files: string[]
  criticality: number
}

// ---------------------------------------------------------------------------
// Entry Point Detection
// ---------------------------------------------------------------------------

function hasFrameworkDecorator(node: GraphNode): boolean {
  const decorators = node.extra?.decorators
  if (!decorators || !Array.isArray(decorators)) return false
  for (const dec of decorators) {
    for (const pat of FRAMEWORK_DECORATOR_PATTERNS) {
      if (pat.test(dec)) return true
    }
  }
  return false
}

function matchesEntryName(node: GraphNode): boolean {
  return ENTRY_NAME_PATTERNS.some(p => p.test(node.name))
}

export function detectEntryPoints(graph: WorkspaceGraph): GraphNode[] {
  const candidates = graph.getNodesByKind(['Function', 'Test'])
  const calledQNs = graph.getAllCallTargets()
  const seen = new Set<string>()
  const entries: GraphNode[] = []

  for (const node of candidates) {
    if (seen.has(node.qualifiedName)) continue

    const isEntry =
      !calledQNs.has(node.qualifiedName) ||
      hasFrameworkDecorator(node) ||
      matchesEntryName(node)

    if (isEntry) {
      seen.add(node.qualifiedName)
      entries.push(node)
    }
  }

  return entries
}

// ---------------------------------------------------------------------------
// Flow Tracing (BFS on CALLS edges)
// ---------------------------------------------------------------------------

export function traceFlows(graph: WorkspaceGraph, maxDepth = 15): FlowInfo[] {
  const entries = detectEntryPoints(graph)
  const flows: FlowInfo[] = []

  for (const ep of entries) {
    const visited = new Set<string>([ep.qualifiedName])
    const pathIds: number[] = [ep.id]
    const pathQNs: string[] = [ep.qualifiedName]
    const queue: Array<{ qn: string; depth: number }> = [{ qn: ep.qualifiedName, depth: 0 }]
    let actualDepth = 0

    while (queue.length > 0) {
      const { qn, depth } = queue.shift()!
      actualDepth = Math.max(actualDepth, depth)

      if (depth >= maxDepth) continue

      const callEdges = graph.getEdgesBySource(qn, 'CALLS')
      for (const edge of callEdges) {
        if (visited.has(edge.targetQualified)) continue
        const targetNode = graph.getNodeByQualifiedName(edge.targetQualified)
        if (!targetNode) continue

        visited.add(edge.targetQualified)
        pathIds.push(targetNode.id)
        pathQNs.push(edge.targetQualified)
        queue.push({ qn: edge.targetQualified, depth: depth + 1 })
      }
    }

    if (pathIds.length < 2) continue

    const fileSet = new Set<string>()
    for (const qn of pathQNs) {
      const node = graph.getNodeByQualifiedName(qn)
      if (node) fileSet.add(node.filePath)
    }

    const flow: FlowInfo = {
      name: sanitizeName(ep.name),
      entryPointQN: ep.qualifiedName,
      entryPointId: ep.id,
      path: pathIds,
      pathQNs,
      depth: actualDepth,
      nodeCount: pathIds.length,
      fileCount: fileSet.size,
      files: [...fileSet],
      criticality: 0,
    }

    flow.criticality = computeCriticality(flow, graph)
    flows.push(flow)
  }

  flows.sort((a, b) => b.criticality - a.criticality)
  return flows
}

function sanitizeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_.-]/g, '_').substring(0, 100)
}

// ---------------------------------------------------------------------------
// Criticality Scoring
// ---------------------------------------------------------------------------

export function computeCriticality(flow: FlowInfo, graph: WorkspaceGraph): number {
  const nodeCount = flow.pathQNs.length
  if (nodeCount === 0) return 0

  // File spread: 30%
  const fileSpread = flow.fileCount <= 1 ? 0 : Math.min((flow.fileCount - 1) / 4, 1.0)

  // External calls: 20%
  let externalCount = 0
  for (const qn of flow.pathQNs) {
    const callEdges = graph.getEdgesBySource(qn, 'CALLS')
    for (const edge of callEdges) {
      const target = graph.getNodeByQualifiedName(edge.targetQualified)
      if (!target) externalCount++
    }
  }
  const externalScore = Math.min(externalCount / 5, 1.0)

  // Security keywords: 25%
  let securityHits = 0
  for (const qn of flow.pathQNs) {
    const node = graph.getNodeByQualifiedName(qn)
    if (!node) continue
    const lower = (node.name + ' ' + node.qualifiedName).toLowerCase()
    for (const kw of SECURITY_KEYWORDS) {
      if (lower.includes(kw)) { securityHits++; break }
    }
  }
  const securityScore = Math.min(securityHits / nodeCount, 1.0)

  // Test gap: 15%
  let testedCount = 0
  for (const qn of flow.pathQNs) {
    const testedBy = graph.getEdgesBySource(qn, 'TESTED_BY')
    if (testedBy.length > 0) testedCount++
  }
  const testGap = 1 - (testedCount / nodeCount)

  // Depth: 10%
  const depthScore = Math.min(flow.depth / 10, 1.0)

  const raw = fileSpread * 0.30 + externalScore * 0.20 + securityScore * 0.25 + testGap * 0.15 + depthScore * 0.10
  return Math.round(Math.min(Math.max(raw, 0), 1) * 10000) / 10000
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

export function storeFlows(graph: WorkspaceGraph, flows: FlowInfo[]): number {
  const db = graph.getDatabase()
  const now = Date.now() / 1000

  db.prepare('DELETE FROM flow_memberships').run()
  db.prepare('DELETE FROM flows').run()

  let count = 0
  for (const flow of flows) {
    const result = db.prepare(`
      INSERT INTO flows (name, entry_point_qn, depth, node_count, file_count, criticality, path_json, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      flow.name, flow.entryPointQN, flow.depth,
      flow.nodeCount, flow.fileCount, flow.criticality,
      JSON.stringify(flow.path), now,
    )

    const flowId = Number(db.prepare('SELECT last_insert_rowid() as id').get()!.id)

    for (let i = 0; i < flow.path.length; i++) {
      try {
        db.prepare(`
          INSERT OR IGNORE INTO flow_memberships (flow_id, node_id, position) VALUES (?, ?, ?)
        `).run(flowId, flow.path[i], i)
      } catch { /* duplicate node_id across flows is expected */ }
    }

    count++
  }

  return count
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export function getFlows(graph: WorkspaceGraph, limit = 50, sortBy: 'criticality' | 'name' = 'criticality'): any[] {
  const db = graph.getDatabase()
  const orderCol = sortBy === 'name' ? 'name' : 'criticality DESC'
  return db.prepare(`SELECT * FROM flows ORDER BY ${orderCol} LIMIT ?`).all(limit) as any[]
}

export function getAffectedFlows(graph: WorkspaceGraph, changedFiles: string[]): any[] {
  if (changedFiles.length === 0) return []
  const db = graph.getDatabase()

  const placeholders = changedFiles.map(() => '?').join(',')
  const nodeIds = db.prepare(
    `SELECT id FROM graph_nodes WHERE file_path IN (${placeholders})`
  ).all(...changedFiles) as { id: number }[]

  if (nodeIds.length === 0) return []

  const idPlaceholders = nodeIds.map(() => '?').join(',')
  const flowIds = db.prepare(
    `SELECT DISTINCT flow_id FROM flow_memberships WHERE node_id IN (${idPlaceholders})`
  ).all(...nodeIds.map(n => n.id)) as { flow_id: number }[]

  if (flowIds.length === 0) return []

  const fPlaceholders = flowIds.map(() => '?').join(',')
  return db.prepare(
    `SELECT * FROM flows WHERE id IN (${fPlaceholders}) ORDER BY criticality DESC`
  ).all(...flowIds.map(f => f.flow_id)) as any[]
}

export function countFlowMemberships(graph: WorkspaceGraph, nodeId: number): number {
  const db = graph.getDatabase()
  const row = db.prepare('SELECT COUNT(*) as cnt FROM flow_memberships WHERE node_id = ?').get(nodeId) as { cnt: number }
  return row?.cnt ?? 0
}
