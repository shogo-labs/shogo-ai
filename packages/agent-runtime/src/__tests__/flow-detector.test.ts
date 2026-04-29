// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Flow Detector — Unit Tests
 *
 * Tests entry point detection, BFS flow tracing, criticality scoring,
 * and flow storage/retrieval using an in-memory SQLite database.
 */

import { describe, test, expect, beforeEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { detectEntryPoints, traceFlows, computeCriticality, storeFlows, getFlows, getAffectedFlows, countFlowMemberships } from '../flow-detector'
import { WorkspaceGraph, type GraphNode } from '../workspace-graph'
import { IndexEngine } from '../index-engine'
import { mkdtempSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

function createTestEnv() {
  const tmpDir = mkdtempSync(join(tmpdir(), 'flow-test-'))
  const shogoDir = join(tmpDir, '.shogo')
  mkdirSync(shogoDir, { recursive: true })
  mkdirSync(join(tmpDir, 'src'), { recursive: true })

  // Create dummy source files so IndexEngine can scan them
  writeFileSync(join(tmpDir, 'src', 'main.py'), 'def main(): pass')
  writeFileSync(join(tmpDir, 'src', 'utils.py'), 'def helper(): pass')
  writeFileSync(join(tmpDir, 'src', 'auth.py'), 'def login(): pass')

  const engine = new IndexEngine({
    dbPath: join(shogoDir, 'index.db'),
    sources: [{
      id: 'code',
      scanDir: tmpDir,
      extensions: new Set(['.py']),
    }],
  })

  const graph = new WorkspaceGraph(engine)
  return { graph, tmpDir, engine }
}

function insertNode(graph: WorkspaceGraph, kind: string, name: string, filePath: string, opts: { params?: string; lineStart?: number; lineEnd?: number; extra?: any } = {}) {
  const db = graph.getDatabase()
  const qn = `code::${filePath}::${name}`
  const now = Date.now() / 1000
  db.prepare(`
    INSERT OR REPLACE INTO graph_nodes (kind, name, qualified_name, file_path, source, line_start, line_end, params, extra, updated_at)
    VALUES (?, ?, ?, ?, 'code', ?, ?, ?, ?, ?)
  `).run(kind, name, qn, filePath, opts.lineStart ?? 1, opts.lineEnd ?? 10, opts.params ?? null, JSON.stringify(opts.extra ?? {}), now)
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

// ============================================================================
// Entry point detection
// ============================================================================

describe('detectEntryPoints', () => {
  test('functions with no callers are entry points', () => {
    const { graph } = createTestEnv()
    const mainQN = insertNode(graph, 'Function', 'process', 'src/main.py')
    const helperQN = insertNode(graph, 'Function', 'helper', 'src/utils.py')
    insertEdge(graph, 'CALLS', mainQN, helperQN, 'src/main.py')

    const entries = detectEntryPoints(graph)
    expect(entries.some(e => e.name === 'process')).toBe(true)
    // helper is called, but has no callers pointing to it... actually mainQN calls helperQN
    // so helperQN IS called (has incoming CALLS), so it should NOT be an entry point
  })

  test('functions matching entry name patterns are entry points', () => {
    const { graph } = createTestEnv()
    insertNode(graph, 'Function', 'main', 'src/main.py')
    insertNode(graph, 'Function', 'handle_request', 'src/main.py')
    insertNode(graph, 'Function', 'on_startup', 'src/main.py')

    const entries = detectEntryPoints(graph)
    expect(entries.some(e => e.name === 'main')).toBe(true)
    expect(entries.some(e => e.name === 'handle_request')).toBe(true)
    expect(entries.some(e => e.name === 'on_startup')).toBe(true)
  })

  test('test functions are entry points', () => {
    const { graph } = createTestEnv()
    insertNode(graph, 'Test', 'test_login', 'src/test_auth.py')

    const entries = detectEntryPoints(graph)
    expect(entries.some(e => e.name === 'test_login')).toBe(true)
  })
})

// ============================================================================
// Flow tracing
// ============================================================================

describe('traceFlows', () => {
  test('traces a simple call chain', () => {
    const { graph } = createTestEnv()
    const mainQN = insertNode(graph, 'Function', 'main', 'src/main.py')
    const processQN = insertNode(graph, 'Function', 'process_data', 'src/main.py')
    const saveQN = insertNode(graph, 'Function', 'save_result', 'src/utils.py')

    insertEdge(graph, 'CALLS', mainQN, processQN, 'src/main.py')
    insertEdge(graph, 'CALLS', processQN, saveQN, 'src/main.py')

    const flows = traceFlows(graph)
    const mainFlow = flows.find(f => f.entryPointQN === mainQN)
    expect(mainFlow).toBeDefined()
    expect(mainFlow!.nodeCount).toBeGreaterThanOrEqual(3)
    expect(mainFlow!.fileCount).toBeGreaterThanOrEqual(2)
  })

  test('skips flows with < 2 nodes', () => {
    const { graph } = createTestEnv()
    insertNode(graph, 'Function', 'lonely', 'src/main.py')

    const flows = traceFlows(graph)
    const lonelyFlow = flows.find(f => f.name === 'lonely')
    expect(lonelyFlow).toBeUndefined()
  })

  test('respects maxDepth', () => {
    const { graph } = createTestEnv()
    const a = insertNode(graph, 'Function', 'a', 'src/main.py')
    const b = insertNode(graph, 'Function', 'b', 'src/main.py')
    const c = insertNode(graph, 'Function', 'c', 'src/main.py')
    const d = insertNode(graph, 'Function', 'd', 'src/main.py')

    insertEdge(graph, 'CALLS', a, b, 'src/main.py')
    insertEdge(graph, 'CALLS', b, c, 'src/main.py')
    insertEdge(graph, 'CALLS', c, d, 'src/main.py')

    const flows = traceFlows(graph, 2)
    const aFlow = flows.find(f => f.entryPointQN === a)
    expect(aFlow).toBeDefined()
    expect(aFlow!.nodeCount).toBeLessThanOrEqual(3) // a, b, c (depth 2 from a)
  })

  test('handles cycles gracefully', () => {
    const { graph } = createTestEnv()
    const a = insertNode(graph, 'Function', 'handle_event', 'src/main.py')
    const b = insertNode(graph, 'Function', 'dispatch', 'src/main.py')

    insertEdge(graph, 'CALLS', a, b, 'src/main.py')
    insertEdge(graph, 'CALLS', b, a, 'src/main.py')

    const flows = traceFlows(graph)
    expect(flows.length).toBeGreaterThanOrEqual(1)
    // Should not infinite loop
  })
})

// ============================================================================
// Criticality scoring
// ============================================================================

describe('computeCriticality', () => {
  test('produces a score between 0 and 1', () => {
    const { graph } = createTestEnv()
    const main = insertNode(graph, 'Function', 'main', 'src/main.py')
    const helper = insertNode(graph, 'Function', 'helper', 'src/utils.py')
    insertEdge(graph, 'CALLS', main, helper, 'src/main.py')

    const flows = traceFlows(graph)
    for (const flow of flows) {
      expect(flow.criticality).toBeGreaterThanOrEqual(0)
      expect(flow.criticality).toBeLessThanOrEqual(1)
    }
  })

  test('security-related functions increase criticality', () => {
    const { graph } = createTestEnv()
    const login = insertNode(graph, 'Function', 'authenticate_user', 'src/auth.py')
    const validate = insertNode(graph, 'Function', 'validate_token', 'src/auth.py')
    insertEdge(graph, 'CALLS', login, validate, 'src/auth.py')

    const flows = traceFlows(graph)
    const authFlow = flows.find(f => f.entryPointQN === login)
    expect(authFlow).toBeDefined()
    expect(authFlow!.criticality).toBeGreaterThan(0)
  })
})

// ============================================================================
// Storage
// ============================================================================

describe('storeFlows and getFlows', () => {
  test('stores and retrieves flows', () => {
    const { graph } = createTestEnv()
    const main = insertNode(graph, 'Function', 'main', 'src/main.py')
    const helper = insertNode(graph, 'Function', 'helper', 'src/utils.py')
    insertEdge(graph, 'CALLS', main, helper, 'src/main.py')

    const flows = traceFlows(graph)
    const stored = storeFlows(graph, flows)
    expect(stored).toBeGreaterThanOrEqual(1)

    const retrieved = getFlows(graph)
    expect(retrieved.length).toBeGreaterThanOrEqual(1)
    expect(retrieved[0].name).toBeDefined()
    expect(retrieved[0].criticality).toBeDefined()
  })

  test('getAffectedFlows finds flows containing changed files', () => {
    const { graph } = createTestEnv()
    const main = insertNode(graph, 'Function', 'main', 'src/main.py')
    const helper = insertNode(graph, 'Function', 'helper', 'src/utils.py')
    insertEdge(graph, 'CALLS', main, helper, 'src/main.py')

    const flows = traceFlows(graph)
    storeFlows(graph, flows)

    const affected = getAffectedFlows(graph, ['src/utils.py'])
    expect(affected.length).toBeGreaterThanOrEqual(1)
  })

  test('countFlowMemberships returns correct count', () => {
    const { graph } = createTestEnv()
    const main = insertNode(graph, 'Function', 'main', 'src/main.py')
    const helper = insertNode(graph, 'Function', 'helper', 'src/utils.py')
    insertEdge(graph, 'CALLS', main, helper, 'src/main.py')

    const flows = traceFlows(graph)
    storeFlows(graph, flows)

    // main node should be in at least 1 flow
    const db = graph.getDatabase()
    const mainRow = db.prepare("SELECT id FROM graph_nodes WHERE name = 'main'").get() as { id: number } | null
    if (mainRow) {
      const count = countFlowMemberships(graph, mainRow.id)
      expect(count).toBeGreaterThanOrEqual(1)
    }
  })
})
