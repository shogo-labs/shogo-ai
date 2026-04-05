// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Risk Scorer — Unit Tests
 *
 * Tests per-node risk scoring based on flow membership, test coverage,
 * security keywords, and caller count.
 */

import { describe, test, expect } from 'bun:test'
import { computeRiskScore, computeAggregateRisk, computeFileSetRisk } from '../risk-scorer'
import { WorkspaceGraph } from '../workspace-graph'
import { IndexEngine } from '../index-engine'
import { traceFlows, storeFlows } from '../flow-detector'
import { mkdtempSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

function createTestEnv() {
  const tmpDir = mkdtempSync(join(tmpdir(), 'risk-test-'))
  const shogoDir = join(tmpDir, '.shogo')
  mkdirSync(shogoDir, { recursive: true })
  mkdirSync(join(tmpDir, 'src'), { recursive: true })

  writeFileSync(join(tmpDir, 'src', 'main.py'), 'pass')
  writeFileSync(join(tmpDir, 'src', 'auth.py'), 'pass')
  writeFileSync(join(tmpDir, 'src', 'test_main.py'), 'pass')

  const engine = new IndexEngine({
    dbPath: join(shogoDir, 'index.db'),
    sources: [{
      id: 'code',
      scanDir: tmpDir,
      include: ['**/*.py'],
      exclude: [],
    }],
  })

  const graph = new WorkspaceGraph(engine)
  return { graph, tmpDir }
}

function insertNode(graph: WorkspaceGraph, kind: string, name: string, filePath: string) {
  const db = graph.getDatabase()
  const qn = `code::${filePath}::${name}`
  const now = Date.now() / 1000
  db.prepare(`
    INSERT OR REPLACE INTO graph_nodes (kind, name, qualified_name, file_path, source, line_start, line_end, extra, updated_at)
    VALUES (?, ?, ?, ?, 'code', 1, 10, '{}', ?)
  `).run(kind, name, qn, filePath, now)
  return qn
}

function insertEdge(graph: WorkspaceGraph, kind: string, sourceQN: string, targetQN: string, filePath: string) {
  const db = graph.getDatabase()
  const now = Date.now() / 1000
  db.prepare(`
    INSERT INTO graph_edges (kind, source_qualified, target_qualified, file_path, line, extra, updated_at)
    VALUES (?, ?, ?, ?, 0, '{}', ?)
  `).run(kind, sourceQN, targetQN, filePath, now)
}

function getNode(graph: WorkspaceGraph, name: string) {
  const db = graph.getDatabase()
  const row = db.prepare("SELECT * FROM graph_nodes WHERE name = ?").get(name) as any
  if (!row) throw new Error(`Node not found: ${name}`)
  return {
    id: row.id, kind: row.kind, name: row.name,
    qualifiedName: row.qualified_name, filePath: row.file_path,
    source: row.source, lineStart: row.line_start, lineEnd: row.line_end,
    language: row.language, parentName: row.parent_name,
    params: row.params, returnType: row.return_type,
    fileHash: row.file_hash, extra: JSON.parse(row.extra || '{}'),
    updatedAt: row.updated_at,
  }
}

// ============================================================================
// computeRiskScore
// ============================================================================

describe('computeRiskScore', () => {
  test('untested node gets +0.30', () => {
    const { graph } = createTestEnv()
    insertNode(graph, 'Function', 'process', 'src/main.py')

    const node = getNode(graph, 'process')
    const risk = computeRiskScore(graph, node)
    expect(risk).toBeGreaterThanOrEqual(0.30)
  })

  test('tested node gets only +0.05 for test coverage', () => {
    const { graph } = createTestEnv()
    const processQN = insertNode(graph, 'Function', 'process', 'src/main.py')
    const testQN = insertNode(graph, 'Test', 'test_process', 'src/test_main.py')
    insertEdge(graph, 'TESTED_BY', processQN, testQN, 'src/test_main.py')

    const node = getNode(graph, 'process')
    const risk = computeRiskScore(graph, node)
    expect(risk).toBeLessThan(0.30) // less than untested
  })

  test('security keyword match adds +0.20', () => {
    const { graph } = createTestEnv()
    insertNode(graph, 'Function', 'authenticate_user', 'src/auth.py')

    const node = getNode(graph, 'authenticate_user')
    const risk = computeRiskScore(graph, node)
    expect(risk).toBeGreaterThanOrEqual(0.50) // 0.30 (untested) + 0.20 (security)
  })

  test('caller count adds up to 0.10', () => {
    const { graph } = createTestEnv()
    const helperQN = insertNode(graph, 'Function', 'helper', 'src/main.py')

    // Add many callers
    for (let i = 0; i < 20; i++) {
      const callerQN = insertNode(graph, 'Function', `caller_${i}`, 'src/main.py')
      insertEdge(graph, 'CALLS', callerQN, helperQN, 'src/main.py')
    }

    const node = getNode(graph, 'helper')
    const risk = computeRiskScore(graph, node)
    // Should be: 0.30 (untested) + 0.10 (20 callers / 20 = 1.0, capped at 0.10)
    expect(risk).toBeGreaterThanOrEqual(0.40)
  })

  test('flow membership adds risk', () => {
    const { graph } = createTestEnv()
    const mainQN = insertNode(graph, 'Function', 'main', 'src/main.py')
    const helperQN = insertNode(graph, 'Function', 'helper_fn', 'src/main.py')
    insertEdge(graph, 'CALLS', mainQN, helperQN, 'src/main.py')

    const flows = traceFlows(graph)
    storeFlows(graph, flows)

    const node = getNode(graph, 'main')
    const risk = computeRiskScore(graph, node)
    // Should include flow membership bonus
    expect(risk).toBeGreaterThanOrEqual(0.30) // at least untested
  })

  test('score clamps at 1.0', () => {
    const { graph } = createTestEnv()
    const loginQN = insertNode(graph, 'Function', 'login_authenticate_password', 'src/auth.py')

    // Make it a heavily called security function with flows
    for (let i = 0; i < 30; i++) {
      const callerQN = insertNode(graph, 'Function', `endpoint_${i}`, 'src/auth.py')
      insertEdge(graph, 'CALLS', callerQN, loginQN, 'src/auth.py')
    }

    const flows = traceFlows(graph)
    storeFlows(graph, flows)

    const node = getNode(graph, 'login_authenticate_password')
    const risk = computeRiskScore(graph, node)
    expect(risk).toBeLessThanOrEqual(1.0)
    expect(risk).toBeGreaterThan(0)
  })
})

// ============================================================================
// Aggregate risk
// ============================================================================

describe('computeAggregateRisk', () => {
  test('returns maxRisk and avgRisk', () => {
    const { graph } = createTestEnv()
    insertNode(graph, 'Function', 'safe_func', 'src/main.py')
    insertNode(graph, 'Function', 'authenticate', 'src/auth.py')

    const nodes = [getNode(graph, 'safe_func'), getNode(graph, 'authenticate')]
    const { maxRisk, avgRisk } = computeAggregateRisk(graph, nodes)

    expect(maxRisk).toBeGreaterThan(0)
    expect(avgRisk).toBeGreaterThan(0)
    expect(maxRisk).toBeGreaterThanOrEqual(avgRisk)
  })
})

describe('computeFileSetRisk', () => {
  test('computes risk for a set of files', () => {
    const { graph } = createTestEnv()
    insertNode(graph, 'Function', 'process', 'src/main.py')
    insertNode(graph, 'Function', 'login', 'src/auth.py')

    const { maxRisk, avgRisk } = computeFileSetRisk(graph, ['src/main.py', 'src/auth.py'])
    expect(maxRisk).toBeGreaterThan(0)
    expect(avgRisk).toBeGreaterThan(0)
  })
})
