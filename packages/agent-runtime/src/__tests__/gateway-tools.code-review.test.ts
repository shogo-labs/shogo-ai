// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// gateway-tools.ts — detect_changes + review_context coverage sweep
// Targets uncovered clusters in createCodeReviewTool (L4940-5070) and
// createReviewContextTool (L5076-5260): the diff parsing (L4984-4994), the
// overlap path (L5015-5036), node-iteration skip (L5140-5148), and the source-
// hunk range merging (L5169-5196).

import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

// Mock child_process so execSync returns controlled diff output
let execOutputs: Record<string, string> = {}
let execThrows: Record<string, boolean> = {}
// gateway-tools uses require('child_process') dynamically inside detect_changes
// and review_context — patch the CJS resolved module's execSync. mock.module()
// alone is unreliable for require() in mixed ESM/CJS.
function fakeExecSync(cmd: string): string {
  for (const k of Object.keys(execThrows)) {
    if (cmd.includes(k) && execThrows[k]) throw new Error('git failed')
  }
  for (const k of Object.keys(execOutputs)) {
    if (cmd.includes(k)) return execOutputs[k]
  }
  return ''
}
{
  const cpCjs = require('child_process')
  cpCjs.execSync = fakeExecSync
}

// Mock risk-scorer + flow-detector (loaded via require())
mock.module('../risk-scorer', () => ({
  computeRiskScore: (_g: any, node: any) => (node.name?.includes('risky') ? 0.875 : 0.123),
  computeFileSetRisk: () => ({ maxRisk: 0.875, avgRisk: 0.45 }),
}))
mock.module('../flow-detector', () => ({
  getAffectedFlows: () => [
    { name: 'CheckoutFlow', criticality: 'high', node_count: 5 },
    { name: 'LoginFlow', criticality: 'medium', node_count: 3 },
  ],
}))

const { createTools } = await import('../gateway-tools')

let TEST_DIR: string
function freshDir() {
  TEST_DIR = mkdtempSync(join(tmpdir(), 'code-review-'))
}

function makeFakeGraph(opts: {
  nodes?: Record<string, any[]>
  edgesBySource?: Record<string, any[]>
  impactRadius?: any
} = {}): any {
  const nodes = opts.nodes ?? {}
  const edges = opts.edgesBySource ?? {}
  return {
    getNodesByFile: (fp: string) => nodes[fp] ?? [],
    getEdgesBySource: (qn: string, kind: string) => (edges[`${qn}|${kind}`] ?? []),
    getImpactRadius: () => {
      const ir = opts.impactRadius ?? {}
      return {
        changedNodes: ir.changedNodes ?? [],
        impactedFiles: ir.impactedFiles ?? [],
        impactedNodes: ir.impactedNodes ?? [],
        edges: (ir.edges ?? []).map((e: any) => ({
          kind: e.kind ?? 'CALLS',
          source: e.source ?? 'a',
          target: e.target ?? 'b',
          sourceQualified: e.sourceQualified ?? (e.source ?? 'mod::a'),
          targetQualified: e.targetQualified ?? (e.target ?? 'mod::b'),
        })),
        totalImpacted: ir.totalImpacted ?? (ir.impactedFiles ?? []).length,
        truncated: ir.truncated ?? false,
      }
    },
  }
}

function makeCtx(graph: any, overrides: any = {}): any {
  return {
    workspaceDir: TEST_DIR,
    channels: new Map(),
    config: {
      heartbeatInterval: 1800, heartbeatEnabled: false,
      quietHours: { start: '23:00', end: '07:00', timezone: 'UTC' },
      channels: [], model: { provider: 'anthropic', name: 'claude-sonnet-4-5' },
    },
    projectId: 'proj-code-review',
    sessionId: 'sess-1',
    mainSessionIds: ['sess-1'],
    workspaceGraph: graph,
    ...overrides,
  }
}

async function exec(ctx: any, name: string, params: Record<string, any>) {
  const tools = createTools(ctx)
  const tool = tools.find((t: any) => t.name === name)
  if (!tool) throw new Error(`tool ${name} not found`)
  const r = await tool.execute('id', params)
  return r.details ?? r
}

beforeEach(() => {
  freshDir()
  execOutputs = {}
  execThrows = {}
})
afterEach(() => {
  if (TEST_DIR && existsSync(TEST_DIR)) {
    try { rmSync(TEST_DIR, { recursive: true, force: true }) } catch {}
  }
})

describe('detect_changes', () => {
  test('returns error when graph unavailable', async () => {
    const ctx = makeCtx(null) // ctx.workspaceGraph = null, getOrCreateGraph will try to init and likely fail
    const r = await exec(ctx, 'detect_changes', { changed_files: [] })
    // Either error (graph null) OR "No changes detected" (empty file list path)
    expect(r.error || r.summary).toBeDefined()
  })

  test('uses explicit changed_files and skips git diff', async () => {
    const graph = makeFakeGraph({
      nodes: {
        'src/foo.ts': [
          { kind: 'Function', name: 'doThing', filePath: 'src/foo.ts',
            qualifiedName: 'src/foo.ts:doThing', lineStart: 10, lineEnd: 20 },
          { kind: 'File', name: 'foo.ts', filePath: 'src/foo.ts',
            qualifiedName: 'src/foo.ts', lineStart: 1, lineEnd: 100 },
        ],
      },
      edgesBySource: {
        'src/foo.ts:doThing|TESTED_BY': [{ target: 'tests/foo.test.ts:test1' }],
      },
    })
    execOutputs['git diff --unified=0'] = ''
    const ctx = makeCtx(graph)
    const r = await exec(ctx, 'detect_changes', { changed_files: ['src/foo.ts'] })
    expect(r.summary).toContain('files changed')
    expect(r.changed_functions.length).toBeGreaterThanOrEqual(1)
    expect(r.changed_functions[0].name).toBe('doThing')
    expect(r.changed_functions[0].tested).toBe(true)
    expect(r.review_priorities).toBeDefined()
  })

  test('parses unified diff line ranges and applies overlap filter', async () => {
    const graph = makeFakeGraph({
      nodes: {
        'src/bar.ts': [
          { kind: 'Function', name: 'inRange', filePath: 'src/bar.ts',
            qualifiedName: 'src/bar.ts:inRange', lineStart: 12, lineEnd: 18 },
          { kind: 'Function', name: 'outOfRange', filePath: 'src/bar.ts',
            qualifiedName: 'src/bar.ts:outOfRange', lineStart: 100, lineEnd: 120 },
        ],
      },
    })
    execOutputs['git diff --name-only'] = 'src/bar.ts'
    execOutputs['git diff --unified=0'] = [
      'diff --git a/src/bar.ts b/src/bar.ts',
      '--- a/src/bar.ts',
      '+++ b/src/bar.ts',
      '@@ -10,3 +10,5 @@',
      '+new line',
      '+new line',
    ].join('\n')
    const ctx = makeCtx(graph)
    const r = await exec(ctx, 'detect_changes', {})
    // inRange (12-18) overlaps with @@ +10,5 (10-14) -> included
    // outOfRange (100-120) does not overlap -> excluded
    const names = r.changed_functions.map((f: any) => f.name)
    expect(names).toContain('inRange')
    expect(names).not.toContain('outOfRange')
  })

  test('git diff failure returns error', async () => {
    const graph = makeFakeGraph()
    execThrows['git diff --name-only'] = true
    const ctx = makeCtx(graph)
    const r = await exec(ctx, 'detect_changes', { base: 'origin/main' })
    expect(String(r.error)).toContain('Failed to run git diff against origin/main')
  })

  test('returns no-changes summary when diff is empty', async () => {
    const graph = makeFakeGraph()
    execOutputs['git diff --name-only'] = ''
    const ctx = makeCtx(graph)
    const r = await exec(ctx, 'detect_changes', {})
    expect(r.summary).toContain('No changes detected')
    expect(r.risk_score).toBe(0)
  })

  test('include_source reads file content for changed nodes', async () => {
    writeFileSync(join(TEST_DIR, 'src.ts'),
      Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n'))
    mkdirSync(join(TEST_DIR, 'src'), { recursive: true })
    writeFileSync(join(TEST_DIR, 'src', 'inc.ts'),
      Array.from({ length: 30 }, (_, i) => `code ${i + 1}`).join('\n'))
    const graph = makeFakeGraph({
      nodes: {
        'src/inc.ts': [{
          kind: 'Function', name: 'reader', filePath: 'src/inc.ts',
          qualifiedName: 'src/inc.ts:reader', lineStart: 5, lineEnd: 10,
        }],
      },
    })
    const ctx = makeCtx(graph)
    const r = await exec(ctx, 'detect_changes', {
      changed_files: ['src/inc.ts'],
      include_source: true,
    })
    const entry = r.changed_functions.find((f: any) => f.name === 'reader')
    expect(entry).toBeDefined()
    expect(entry.source).toContain('code 5')
    expect(entry.source).toContain('code 10')
  })

  test('include_source swallows readFile errors gracefully', async () => {
    const graph = makeFakeGraph({
      nodes: {
        'nonexistent/path.ts': [{
          kind: 'Function', name: 'ghost', filePath: 'nonexistent/path.ts',
          qualifiedName: 'nonexistent/path.ts:ghost', lineStart: 5, lineEnd: 10,
        }],
      },
    })
    const ctx = makeCtx(graph)
    const r = await exec(ctx, 'detect_changes', {
      changed_files: ['nonexistent/path.ts'],
      include_source: true,
    })
    expect(r.changed_functions[0].name).toBe('ghost')
    expect(r.changed_functions[0].source).toBeUndefined()
  })

  test('skips File-kind nodes', async () => {
    const graph = makeFakeGraph({
      nodes: {
        'src/a.ts': [
          { kind: 'File', name: 'a.ts', filePath: 'src/a.ts',
            qualifiedName: 'src/a.ts', lineStart: 1, lineEnd: 50 },
        ],
      },
    })
    const ctx = makeCtx(graph)
    const r = await exec(ctx, 'detect_changes', { changed_files: ['src/a.ts'] })
    expect(r.changed_functions.length).toBe(0)
  })

  test('test_gaps lists untested non-test changed functions', async () => {
    const graph = makeFakeGraph({
      nodes: {
        'src/x.ts': [
          { kind: 'Function', name: 'risky_untested', filePath: 'src/x.ts',
            qualifiedName: 'src/x.ts:risky_untested', lineStart: 1, lineEnd: 10 },
        ],
      },
    })
    const ctx = makeCtx(graph)
    const r = await exec(ctx, 'detect_changes', { changed_files: ['src/x.ts'] })
    expect(r.test_gaps.length).toBeGreaterThanOrEqual(1)
    expect(r.test_gaps[0].name).toBe('risky_untested')
  })
})

describe('review_context', () => {
  test('returns error when graph unavailable', async () => {
    const ctx = makeCtx(null)
    const r = await exec(ctx, 'review_context', { changed_files: [] })
    expect(r.error || r.summary).toBeDefined()
  })

  test('explicit changed_files runs end-to-end with source hunks', async () => {
    mkdirSync(join(TEST_DIR, 'src'), { recursive: true })
    writeFileSync(join(TEST_DIR, 'src', 'svc.ts'),
      Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join('\n'))
    const graph = makeFakeGraph({
      nodes: {
        'src/svc.ts': [
          { kind: 'Function', name: 'svcOne', filePath: 'src/svc.ts',
            qualifiedName: 'src/svc.ts:svcOne', lineStart: 5, lineEnd: 10 },
          { kind: 'Function', name: 'svcTwo', filePath: 'src/svc.ts',
            qualifiedName: 'src/svc.ts:svcTwo', lineStart: 7, lineEnd: 15 },
          { kind: 'File', name: 'svc.ts', filePath: 'src/svc.ts',
            qualifiedName: 'src/svc.ts', lineStart: 1, lineEnd: 50 },
        ],
      },
      impactRadius: {
        changedNodes: [
          { kind: 'Function', name: 'svcOne', filePath: 'src/svc.ts',
            qualifiedName: 'src/svc.ts:svcOne', lineStart: 5, lineEnd: 10 },
          { kind: 'File', name: 'svc.ts', filePath: 'src/svc.ts',
            qualifiedName: 'src/svc.ts', lineStart: 1, lineEnd: 50 },
        ],
        impactedFiles: ['src/svc.ts', 'src/dep1.ts', 'src/dep2.ts',
                        'src/dep3.ts', 'src/dep4.ts', 'src/dep5.ts'],
        edges: [
          { kind: 'INHERITS', source: 'a', target: 'b' },
          { kind: 'CALLS', source: 'c', target: 'd' },
        ],
      },
    })
    const ctx = makeCtx(graph)
    const r = await exec(ctx, 'review_context', {
      changed_files: ['src/svc.ts'],
      include_source: true,
      max_lines_per_file: 200,
    })
    expect(r.changed_nodes).toBeDefined()
    expect(r.source_hunks).toBeDefined()
    // Source hunks built around svcOne(5-10) and svcTwo(7-15) → merged into one range
    expect(r.source_hunks.length).toBeGreaterThanOrEqual(1)
    // Should contain 'Wide blast radius' guidance because 6 impactedFiles
    expect(r.review_guidance.some((g: string) => g.includes('blast radius'))).toBe(true)
    // Should contain INHERITS guidance
    expect(r.review_guidance.some((g: string) =>
      g.toLowerCase().includes('inherit') || g.toLowerCase().includes('subclass'))).toBe(true)
  })

  test('falls back to truncated full file when no nodes', async () => {
    mkdirSync(join(TEST_DIR, 'src'), { recursive: true })
    writeFileSync(join(TEST_DIR, 'src', 'plain.ts'),
      Array.from({ length: 50 }, (_, i) => `plain ${i + 1}`).join('\n'))
    const graph = makeFakeGraph({
      nodes: { 'src/plain.ts': [] },
      impactRadius: { changedNodes: [], impactedFiles: ['src/plain.ts'], edges: [] },
    })
    const ctx = makeCtx(graph)
    const r = await exec(ctx, 'review_context', {
      changed_files: ['src/plain.ts'],
      max_lines_per_file: 10,
    })
    expect(r.source_hunks.length).toBe(1)
    expect(r.source_hunks[0].lines).toBe('1-10')
    expect(r.source_hunks[0].content).toContain('plain 1')
    expect(r.source_hunks[0].content).toContain('plain 10')
  })

  test('skips nonexistent files in source_hunks', async () => {
    const graph = makeFakeGraph({
      nodes: { 'src/missing.ts': [] },
      impactRadius: { changedNodes: [], impactedFiles: [], edges: [] },
    })
    const ctx = makeCtx(graph)
    const r = await exec(ctx, 'review_context', {
      changed_files: ['src/missing.ts'],
      include_source: true,
    })
    expect(r.source_hunks.length).toBe(0)
  })

  test('include_source=false omits hunks', async () => {
    const graph = makeFakeGraph({
      nodes: {},
      impactRadius: { changedNodes: [], impactedFiles: [], edges: [] },
    })
    const ctx = makeCtx(graph)
    const r = await exec(ctx, 'review_context', {
      changed_files: ['src/whatever.ts'],
      include_source: false,
    })
    expect(r.source_hunks.length).toBe(0)
  })

  test('git diff failure returns error', async () => {
    const graph = makeFakeGraph()
    execThrows['git diff --name-only'] = true
    const ctx = makeCtx(graph)
    const r = await exec(ctx, 'review_context', { base: 'origin/dev' })
    expect(String(r.error)).toContain('Failed to run git diff against origin/dev')
  })

  test('returns no-changes summary on empty diff', async () => {
    const graph = makeFakeGraph()
    execOutputs['git diff --name-only'] = ''
    const ctx = makeCtx(graph)
    const r = await exec(ctx, 'review_context', {})
    expect(r.summary).toContain('No changes detected')
  })

  test('max_lines_per_file caps total source output', async () => {
    mkdirSync(join(TEST_DIR, 'src'), { recursive: true })
    writeFileSync(join(TEST_DIR, 'src', 'big.ts'),
      Array.from({ length: 200 }, (_, i) => `big ${i + 1}`).join('\n'))
    const nodes = Array.from({ length: 5 }, (_, i) => ({
      kind: 'Function', name: `f${i}`, filePath: 'src/big.ts',
      qualifiedName: `src/big.ts:f${i}`,
      lineStart: i * 50 + 1, lineEnd: i * 50 + 30,
    }))
    const graph = makeFakeGraph({
      nodes: { 'src/big.ts': nodes },
      impactRadius: { changedNodes: nodes, impactedFiles: ['src/big.ts'], edges: [] },
    })
    const ctx = makeCtx(graph)
    const r = await exec(ctx, 'review_context', {
      changed_files: ['src/big.ts'],
      max_lines_per_file: 40,
    })
    // After cap, totalLines >= 40 stops further hunks
    expect(r.source_hunks.length).toBeLessThanOrEqual(2)
  })
})
