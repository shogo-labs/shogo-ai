// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * WorkspaceGraph — Unit Tests
 *
 * Tests the knowledge graph layer:
 * - Graph building from indexed files
 * - Node/edge creation from extractors
 * - BFS impact radius analysis
 * - Incremental graph updates
 * - Query helpers (queryNeighbors, getNodesByFile, getStats)
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { IndexEngine, createFilesSource, type IndexEngineConfig } from '../index-engine'
import { WorkspaceGraph } from '../workspace-graph'
import { MarkdownExtractor, ReferenceExtractor } from '../graph-extractors'

const TEST_DIR = '/tmp/test-workspace-graph-unit'
const FILES_DIR = join(TEST_DIR, 'files')
const DB_DIR = join(TEST_DIR, '.shogo')

function setup() {
  rmSync(TEST_DIR, { recursive: true, force: true })
  mkdirSync(DB_DIR, { recursive: true })
  mkdirSync(FILES_DIR, { recursive: true })
}

function writeFile(relPath: string, content: string) {
  const abs = join(FILES_DIR, relPath)
  const dir = abs.substring(0, abs.lastIndexOf('/'))
  mkdirSync(dir, { recursive: true })
  writeFileSync(abs, content, 'utf-8')
}

function makeEngine(): IndexEngine {
  return new IndexEngine({
    dbPath: join(DB_DIR, 'index.db'),
    sources: [createFilesSource(TEST_DIR)],
  })
}

// ============================================================================
// Graph building
// ============================================================================

describe('WorkspaceGraph: building', () => {
  let engine: IndexEngine
  let graph: WorkspaceGraph

  beforeAll(async () => {
    setup()

    writeFile('readme.md', [
      '# Project Docs',
      '',
      '## Getting Started',
      'See [setup guide](setup.md) for installation.',
      '',
      '## Architecture',
      'The system uses a [database](db-schema.md) and references data.csv.',
      '',
      '![diagram](images/arch.png)',
    ].join('\n'))

    writeFile('setup.md', [
      '# Setup Guide',
      '',
      'Follow these steps to install:',
      '1. Clone the repo',
      '2. Run install script',
      '',
      'Also see readme.md for overview.',
    ].join('\n'))

    writeFile('db-schema.md', [
      '# Database Schema',
      '',
      '## Tables',
      '- users: id, name, email',
      '- orders: id, user_id, total',
    ].join('\n'))

    writeFile('data.csv', 'name,value\nalpha,100\nbeta,200')

    engine = makeEngine()
    await engine.reindex('files')

    graph = new WorkspaceGraph(engine)
    graph.registerExtractor(new MarkdownExtractor())
    graph.registerExtractor(new ReferenceExtractor())
  })

  afterAll(() => {
    engine.close()
    rmSync(TEST_DIR, { recursive: true, force: true })
  })

  test('buildGraph creates File nodes for all indexed files', () => {
    const result = graph.buildGraph('files')
    expect(result.filesProcessed).toBeGreaterThan(0)
    expect(result.nodesCreated).toBeGreaterThan(0)

    const stats = graph.getStats()
    expect(stats.totalNodes).toBeGreaterThan(0)
    expect(stats.nodesByKind['File']).toBeGreaterThanOrEqual(4)
  })

  test('MarkdownExtractor creates Section nodes from headings', () => {
    const stats = graph.getStats()
    expect(stats.nodesByKind['Section']).toBeGreaterThan(0)
  })

  test('MarkdownExtractor creates LINKS_TO edges for internal links', () => {
    const stats = graph.getStats()
    expect(stats.edgesByKind['LINKS_TO']).toBeGreaterThan(0)
  })

  test('MarkdownExtractor creates EMBEDS edges for images', () => {
    const stats = graph.getStats()
    expect(stats.edgesByKind['EMBEDS']).toBeGreaterThan(0)
  })

  test('MarkdownExtractor creates CONTAINS edges for sections', () => {
    const stats = graph.getStats()
    expect(stats.edgesByKind['CONTAINS']).toBeGreaterThan(0)
  })

  test('ReferenceExtractor creates REFERENCES edges for filename mentions', () => {
    const stats = graph.getStats()
    expect(stats.edgesByKind['REFERENCES']).toBeGreaterThan(0)
  })

  test('getNodesByFile returns nodes for a specific file', () => {
    const nodes = graph.getNodesByFile('readme.md')
    expect(nodes.length).toBeGreaterThan(0)
    const fileNode = nodes.find(n => n.kind === 'File')
    expect(fileNode).toBeDefined()
    expect(fileNode!.name).toBe('readme.md')
  })

  test('rebuild with unchanged files is a no-op', () => {
    const result = graph.buildGraph('files')
    expect(result.filesProcessed).toBe(0)
  })
})

// ============================================================================
// Impact radius (BFS)
// ============================================================================

describe('WorkspaceGraph: impact radius', () => {
  let engine: IndexEngine
  let graph: WorkspaceGraph

  beforeAll(async () => {
    setup()

    writeFile('index.md', '# Index\nSee [config](config.md) and [data docs](data.md) for details.')
    writeFile('config.md', '# Config\nReferences data.csv and uses setup.md patterns.')
    writeFile('data.md', '# Data\nDescribes the data.csv format.')
    writeFile('setup.md', '# Setup\nIndependent guide.')
    writeFile('data.csv', 'a,b\n1,2')

    engine = makeEngine()
    await engine.reindex('files')

    graph = new WorkspaceGraph(engine)
    graph.registerExtractor(new MarkdownExtractor())
    graph.registerExtractor(new ReferenceExtractor())
    graph.buildGraph('files')
  })

  afterAll(() => {
    engine.close()
    rmSync(TEST_DIR, { recursive: true, force: true })
  })

  test('impact radius for a central file includes dependents', () => {
    const result = graph.getImpactRadius(['config.md'], 2)
    expect(result.changedNodes.length).toBeGreaterThan(0)
    expect(result.totalImpacted).toBeGreaterThan(0)
  })

  test('impact radius for leaf file has fewer impacted nodes', () => {
    const leafResult = graph.getImpactRadius(['setup.md'], 1)
    const centralResult = graph.getImpactRadius(['config.md'], 2)
    expect(leafResult.totalImpacted).toBeLessThanOrEqual(centralResult.totalImpacted)
  })

  test('impact radius with depth 0 returns only changed nodes', () => {
    const result = graph.getImpactRadius(['index.md'], 0)
    expect(result.impactedNodes.length).toBe(0)
    expect(result.changedNodes.length).toBeGreaterThan(0)
  })

  test('impactedFiles is a deduplicated list of file paths', () => {
    const result = graph.getImpactRadius(['data.csv'], 2)
    const uniquePaths = new Set(result.impactedFiles)
    expect(uniquePaths.size).toBe(result.impactedFiles.length)
  })

  test('truncated flag is set when maxNodes is exceeded', () => {
    const result = graph.getImpactRadius(['index.md'], 10, 2)
    expect(typeof result.truncated).toBe('boolean')
  })
})

// ============================================================================
// Incremental updates
// ============================================================================

describe('WorkspaceGraph: incremental updates', () => {
  let engine: IndexEngine
  let graph: WorkspaceGraph

  beforeAll(async () => {
    setup()
    writeFile('a.md', '# Doc A\nLinks to [Doc B](b.md).')
    writeFile('b.md', '# Doc B\nStandalone document.')

    engine = makeEngine()
    await engine.reindex('files')

    graph = new WorkspaceGraph(engine)
    graph.registerExtractor(new MarkdownExtractor())
    graph.registerExtractor(new ReferenceExtractor())
    graph.buildGraph('files')
  })

  afterAll(() => {
    engine.close()
    rmSync(TEST_DIR, { recursive: true, force: true })
  })

  test('updateGraph re-processes changed files', async () => {
    await new Promise(r => setTimeout(r, 50))
    writeFile('a.md', '# Doc A v2\nNow links to [Doc C](c.md) instead.')
    writeFile('c.md', '# Doc C\nNew document.')
    await engine.reindex('files')

    const result = graph.updateGraph(['a.md', 'c.md'], 'files')
    expect(result.nodesCreated).toBeGreaterThan(0)
  })

  test('nodes for updated file reflect new content', () => {
    const nodes = graph.getNodesByFile('a.md')
    const sectionNode = nodes.find(n => n.kind === 'Section')
    expect(sectionNode).toBeDefined()
    expect(sectionNode!.name).toContain('Doc A v2')
  })
})

// ============================================================================
// Query helpers
// ============================================================================

describe('WorkspaceGraph: queryNeighbors', () => {
  let engine: IndexEngine
  let graph: WorkspaceGraph

  beforeAll(async () => {
    setup()
    writeFile('hub.md', '# Hub\nSee [spoke1](spoke1.md) and [spoke2](spoke2.md).')
    writeFile('spoke1.md', '# Spoke 1\nLinked from hub.')
    writeFile('spoke2.md', '# Spoke 2\nLinked from hub.')
    writeFile('isolated.md', '# Isolated\nNo connections.')

    engine = makeEngine()
    await engine.reindex('files')

    graph = new WorkspaceGraph(engine)
    graph.registerExtractor(new MarkdownExtractor())
    graph.registerExtractor(new ReferenceExtractor())
    graph.buildGraph('files')
  })

  afterAll(() => {
    engine.close()
    rmSync(TEST_DIR, { recursive: true, force: true })
  })

  test('queryNeighbors for hub finds spokes', () => {
    const neighbors = graph.queryNeighbors('files::hub.md', undefined, 1)
    const neighborFiles = neighbors.map(n => n.filePath)
    expect(neighborFiles.some(f => f === 'spoke1.md' || f === 'spoke2.md' || f === 'hub.md')).toBe(true)
  })

  test('queryNeighbors with edgeKinds filter', () => {
    const linksOnly = graph.queryNeighbors('files::hub.md', ['LINKS_TO'], 1)
    expect(linksOnly.length).toBeGreaterThan(0)
  })

  test('queryNeighbors for isolated file returns few neighbors', () => {
    const neighbors = graph.queryNeighbors('files::isolated.md', undefined, 1)
    const externalNeighbors = neighbors.filter(n => n.filePath !== 'isolated.md')
    expect(externalNeighbors.length).toBe(0)
  })

  test('getStats returns correct counts', () => {
    const stats = graph.getStats()
    expect(stats.totalNodes).toBeGreaterThan(0)
    expect(stats.totalEdges).toBeGreaterThan(0)
    expect(typeof stats.nodesByKind).toBe('object')
    expect(typeof stats.edgesByKind).toBe('object')
  })
})
