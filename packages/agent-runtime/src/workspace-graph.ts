// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Workspace Knowledge Graph
 *
 * Structural graph layer that sits alongside the IndexEngine in the same
 * SQLite database. Stores nodes (files, sections, entities) and edges
 * (links, references, embeds) extracted from workspace content.
 *
 * Provides blast-radius analysis via BFS traversal — given a set of
 * changed files, find all files and symbols that are affected.
 *
 * Edge extraction is pluggable: each Extractor handles one file type
 * (markdown links, filename references in text, etc.).
 */

import type { Database } from 'bun:sqlite'
import { existsSync, readFileSync, statSync } from 'fs'
import { join, relative, basename } from 'path'
import type { IndexEngine } from './index-engine'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GraphNode {
  id: number
  kind: string
  name: string
  qualifiedName: string
  filePath: string
  source: string
  lineStart: number | null
  lineEnd: number | null
  language: string | null
  parentName: string | null
  params: string | null
  returnType: string | null
  fileHash: string | null
  extra: Record<string, any>
  updatedAt: number
}

export interface GraphEdge {
  id: number
  kind: string
  sourceQualified: string
  targetQualified: string
  filePath: string
  line: number
  extra: Record<string, any>
  updatedAt: number
}

export interface ImpactResult {
  changedNodes: GraphNode[]
  impactedNodes: GraphNode[]
  impactedFiles: string[]
  edges: GraphEdge[]
  truncated: boolean
  totalImpacted: number
}

export interface ExtractedData {
  nodes: Array<{
    kind: string
    name: string
    qualifiedName: string
    filePath: string
    source: string
    lineStart?: number
    lineEnd?: number
    language?: string
    parentName?: string
    params?: string
    returnType?: string
    extra?: Record<string, any>
  }>
  edges: Array<{
    kind: string
    sourceQualified: string
    targetQualified: string
    filePath: string
    line?: number
    extra?: Record<string, any>
  }>
}

export interface Extractor {
  name: string
  canHandle(filePath: string, source: string): boolean
  extract(filePath: string, content: string, source: string, allFiles: string[]): ExtractedData
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const GRAPH_SCHEMA = `
CREATE TABLE IF NOT EXISTS graph_nodes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    qualified_name TEXT NOT NULL UNIQUE,
    file_path TEXT NOT NULL,
    source TEXT NOT NULL,
    line_start INTEGER,
    line_end INTEGER,
    language TEXT,
    parent_name TEXT,
    params TEXT,
    return_type TEXT,
    file_hash TEXT,
    extra TEXT DEFAULT '{}',
    updated_at REAL NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_graph_nodes_file ON graph_nodes(file_path);
CREATE INDEX IF NOT EXISTS idx_graph_nodes_kind ON graph_nodes(kind);
CREATE INDEX IF NOT EXISTS idx_graph_nodes_qualified ON graph_nodes(qualified_name);
CREATE INDEX IF NOT EXISTS idx_graph_nodes_source ON graph_nodes(source);

CREATE TABLE IF NOT EXISTS graph_edges (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    source_qualified TEXT NOT NULL,
    target_qualified TEXT NOT NULL,
    file_path TEXT NOT NULL,
    line INTEGER DEFAULT 0,
    extra TEXT DEFAULT '{}',
    updated_at REAL NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_graph_edges_source ON graph_edges(source_qualified);
CREATE INDEX IF NOT EXISTS idx_graph_edges_target ON graph_edges(target_qualified);
CREATE INDEX IF NOT EXISTS idx_graph_edges_kind ON graph_edges(kind);
CREATE INDEX IF NOT EXISTS idx_graph_edges_file ON graph_edges(file_path);

CREATE TABLE IF NOT EXISTS flows (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    entry_point_qn TEXT NOT NULL,
    depth INTEGER NOT NULL,
    node_count INTEGER NOT NULL,
    file_count INTEGER NOT NULL,
    criticality REAL NOT NULL DEFAULT 0.0,
    path_json TEXT NOT NULL,
    updated_at REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_flows_criticality ON flows(criticality DESC);
CREATE INDEX IF NOT EXISTS idx_flows_entry ON flows(entry_point_qn);

CREATE TABLE IF NOT EXISTS flow_memberships (
    flow_id INTEGER NOT NULL,
    node_id INTEGER NOT NULL,
    position INTEGER NOT NULL,
    PRIMARY KEY (flow_id, node_id)
);
CREATE INDEX IF NOT EXISTS idx_flow_memberships_node ON flow_memberships(node_id);
`

// ---------------------------------------------------------------------------
// WorkspaceGraph
// ---------------------------------------------------------------------------

export class WorkspaceGraph {
  private db: Database
  private extractors: Extractor[] = []
  private indexEngine: IndexEngine

  constructor(indexEngine: IndexEngine) {
    this.indexEngine = indexEngine
    this.db = indexEngine.getDatabase()
    this.initSchema()
  }

  /**
   * Re-acquire the database handle from the index engine after a reconnect.
   */
  reconnect(): void {
    this.db = this.indexEngine.getDatabase()
    this.initSchema()
  }

  private initSchema(): void {
    this.db.exec(GRAPH_SCHEMA)
  }

  registerExtractor(extractor: Extractor): void {
    this.extractors.push(extractor)
  }

  // ---------------------------------------------------------------------------
  // Graph Building
  // ---------------------------------------------------------------------------

  /**
   * Build or rebuild the graph for files indexed under a given source.
   * Reads file content, runs extractors, and stores nodes + edges.
   */
  buildGraph(sourceId?: string): { nodesCreated: number; edgesCreated: number; filesProcessed: number } {
    const sourceFilter = sourceId ? ` WHERE source = ?` : ''
    const params = sourceId ? [sourceId] : []

    const files = this.db.prepare(`SELECT path, source FROM meta${sourceFilter}`).all(...params) as Array<{
      path: string; source: string
    }>

    const allPaths = files.map(f => f.path)

    let nodesCreated = 0
    let edgesCreated = 0
    let filesProcessed = 0
    const now = Date.now() / 1000

    for (const { path: filePath, source } of files) {
      const src = this.indexEngine.getSource(source)
      if (!src) continue

      const absPath = join(src.scanDir, filePath)
      if (!existsSync(absPath)) continue

      let content: string
      try {
        content = readFileSync(absPath, 'utf-8')
      } catch { continue }

      const fileHash = this.computeHash(content)

      const existingNode = this.db.prepare(
        'SELECT file_hash FROM graph_nodes WHERE qualified_name = ? AND kind = ?'
      ).get(`${source}::${filePath}`, 'File') as { file_hash: string } | undefined

      if (existingNode?.file_hash === fileHash) continue

      this.removeFileData(filePath, source)

      // Always create a File node
      this.db.prepare(`
        INSERT OR REPLACE INTO graph_nodes (kind, name, qualified_name, file_path, source, file_hash, extra, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, '{}', ?)
      `).run('File', basename(filePath), `${source}::${filePath}`, filePath, source, fileHash, now)
      nodesCreated++

      for (const ext of this.extractors) {
        if (!ext.canHandle(filePath, source)) continue

        const data = ext.extract(filePath, content, source, allPaths)

        for (const node of data.nodes) {
          this.db.prepare(`
            INSERT OR REPLACE INTO graph_nodes (kind, name, qualified_name, file_path, source, line_start, line_end, language, parent_name, params, return_type, extra, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            node.kind, node.name, node.qualifiedName, node.filePath,
            node.source, node.lineStart ?? null, node.lineEnd ?? null,
            node.language ?? null, node.parentName ?? null,
            node.params ?? null, node.returnType ?? null,
            JSON.stringify(node.extra ?? {}), now,
          )
          nodesCreated++
        }

        for (const edge of data.edges) {
          this.db.prepare(`
            INSERT INTO graph_edges (kind, source_qualified, target_qualified, file_path, line, extra, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `).run(
            edge.kind, edge.sourceQualified, edge.targetQualified,
            edge.filePath, edge.line ?? 0, JSON.stringify(edge.extra ?? {}), now,
          )
          edgesCreated++
        }
      }

      filesProcessed++
    }

    return { nodesCreated, edgesCreated, filesProcessed }
  }

  /**
   * Incrementally update the graph for specific changed files.
   * Re-extracts nodes/edges for the changed files and their dependents.
   */
  updateGraph(changedPaths: string[], source: string): { nodesCreated: number; edgesCreated: number } {
    const src = this.indexEngine.getSource(source)
    if (!src) return { nodesCreated: 0, edgesCreated: 0 }

    const allFiles = (this.db.prepare('SELECT path FROM meta WHERE source = ?').all(source) as { path: string }[])
      .map(f => f.path)

    let nodesCreated = 0
    let edgesCreated = 0
    const now = Date.now() / 1000

    const filesToProcess = new Set(changedPaths)

    // Find dependents: files that have edges pointing to/from any changed file
    for (const fp of changedPaths) {
      const qualifiedName = `${source}::${fp}`
      const dependents = this.db.prepare(`
        SELECT DISTINCT n.file_path FROM graph_edges e
        JOIN graph_nodes n ON n.qualified_name = e.source_qualified
        WHERE e.target_qualified = ? OR e.target_qualified LIKE ?
      `).all(qualifiedName, `${source}::${fp}::%`) as { file_path: string }[]
      for (const { file_path } of dependents) {
        filesToProcess.add(file_path)
      }
    }

    for (const filePath of filesToProcess) {
      const absPath = join(src.scanDir, filePath)

      if (!existsSync(absPath)) {
        this.removeFileData(filePath, source)
        continue
      }

      let content: string
      try {
        content = readFileSync(absPath, 'utf-8')
      } catch { continue }

      const fileHash = this.computeHash(content)
      this.removeFileData(filePath, source)

      this.db.prepare(`
        INSERT OR REPLACE INTO graph_nodes (kind, name, qualified_name, file_path, source, file_hash, extra, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, '{}', ?)
      `).run('File', basename(filePath), `${source}::${filePath}`, filePath, source, fileHash, now)
      nodesCreated++

      for (const ext of this.extractors) {
        if (!ext.canHandle(filePath, source)) continue

        const data = ext.extract(filePath, content, source, allFiles)

        for (const node of data.nodes) {
          this.db.prepare(`
            INSERT OR REPLACE INTO graph_nodes (kind, name, qualified_name, file_path, source, line_start, line_end, language, parent_name, params, return_type, extra, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            node.kind, node.name, node.qualifiedName, node.filePath,
            node.source, node.lineStart ?? null, node.lineEnd ?? null,
            node.language ?? null, node.parentName ?? null,
            node.params ?? null, node.returnType ?? null,
            JSON.stringify(node.extra ?? {}), now,
          )
          nodesCreated++
        }

        for (const edge of data.edges) {
          this.db.prepare(`
            INSERT INTO graph_edges (kind, source_qualified, target_qualified, file_path, line, extra, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `).run(
            edge.kind, edge.sourceQualified, edge.targetQualified,
            edge.filePath, edge.line ?? 0, JSON.stringify(edge.extra ?? {}), now,
          )
          edgesCreated++
        }
      }
    }

    return { nodesCreated, edgesCreated }
  }

  // ---------------------------------------------------------------------------
  // Blast Radius (BFS Impact Analysis)
  // ---------------------------------------------------------------------------

  /**
   * Compute the impact radius for a set of changed file paths.
   * BFS traversal in both directions (callers + dependents) up to maxDepth.
   */
  getImpactRadius(filePaths: string[], maxDepth = 2, maxNodes = 500): ImpactResult {
    const seedNodes = new Set<string>()

    for (const fp of filePaths) {
      const nodes = this.db.prepare(
        'SELECT qualified_name FROM graph_nodes WHERE file_path = ?'
      ).all(fp) as { qualified_name: string }[]
      for (const { qualified_name } of nodes) {
        seedNodes.add(qualified_name)
      }
    }

    const visited = new Set<string>(seedNodes)
    let frontier = new Set<string>(seedNodes)
    let truncated = false

    for (let depth = 0; depth < maxDepth; depth++) {
      if (frontier.size === 0) break
      const nextFrontier = new Set<string>()

      for (const qn of frontier) {
        // Outgoing edges (dependents)
        const outgoing = this.db.prepare(
          'SELECT target_qualified FROM graph_edges WHERE source_qualified = ?'
        ).all(qn) as { target_qualified: string }[]
        for (const { target_qualified } of outgoing) {
          if (!visited.has(target_qualified)) {
            nextFrontier.add(target_qualified)
          }
        }

        // Incoming edges (callers/importers)
        const incoming = this.db.prepare(
          'SELECT source_qualified FROM graph_edges WHERE target_qualified = ?'
        ).all(qn) as { source_qualified: string }[]
        for (const { source_qualified } of incoming) {
          if (!visited.has(source_qualified)) {
            nextFrontier.add(source_qualified)
          }
        }
      }

      if (visited.size + nextFrontier.size > maxNodes) {
        truncated = true
        break
      }

      for (const qn of nextFrontier) {
        visited.add(qn)
      }
      frontier = nextFrontier
    }

    const impactedQualifiedNames = [...visited].filter(qn => !seedNodes.has(qn))

    const changedNodes = this.getNodesByQualifiedNames([...seedNodes])
    const impactedNodes = this.getNodesByQualifiedNames(impactedQualifiedNames)
    const impactedFiles = [...new Set(impactedNodes.map(n => n.filePath))]

    const allQualifiedNames = [...visited]
    const edges = this.getEdgesAmong(allQualifiedNames)

    return {
      changedNodes,
      impactedNodes,
      impactedFiles,
      edges,
      truncated,
      totalImpacted: impactedNodes.length,
    }
  }

  // ---------------------------------------------------------------------------
  // Query Helpers
  // ---------------------------------------------------------------------------

  queryNeighbors(qualifiedName: string, edgeKinds?: string[], depth = 1): GraphNode[] {
    const visited = new Set<string>([qualifiedName])
    let frontier = new Set<string>([qualifiedName])

    for (let d = 0; d < depth; d++) {
      if (frontier.size === 0) break
      const next = new Set<string>()

      for (const qn of frontier) {
        let outSql = 'SELECT target_qualified FROM graph_edges WHERE source_qualified = ?'
        let inSql = 'SELECT source_qualified FROM graph_edges WHERE target_qualified = ?'
        const params: any[] = [qn]

        if (edgeKinds && edgeKinds.length > 0) {
          const placeholders = edgeKinds.map(() => '?').join(',')
          outSql += ` AND kind IN (${placeholders})`
          inSql += ` AND kind IN (${placeholders})`
          params.push(...edgeKinds)
        }

        const outgoing = this.db.prepare(outSql).all(...params) as { target_qualified: string }[]
        for (const { target_qualified } of outgoing) {
          if (!visited.has(target_qualified)) next.add(target_qualified)
        }

        const incoming = this.db.prepare(inSql).all(qn, ...(edgeKinds ?? [])) as { source_qualified: string }[]
        for (const { source_qualified } of incoming) {
          if (!visited.has(source_qualified)) next.add(source_qualified)
        }
      }

      for (const qn of next) visited.add(qn)
      frontier = next
    }

    visited.delete(qualifiedName)
    return this.getNodesByQualifiedNames([...visited])
  }

  getNodesByFile(filePath: string): GraphNode[] {
    const rows = this.db.prepare('SELECT * FROM graph_nodes WHERE file_path = ?').all(filePath) as any[]
    return rows.map(rowToNode)
  }

  getStats(): { totalNodes: number; totalEdges: number; nodesByKind: Record<string, number>; edgesByKind: Record<string, number> } {
    const totalNodes = (this.db.prepare('SELECT COUNT(*) as cnt FROM graph_nodes').get() as { cnt: number }).cnt
    const totalEdges = (this.db.prepare('SELECT COUNT(*) as cnt FROM graph_edges').get() as { cnt: number }).cnt

    const nodeKinds = this.db.prepare('SELECT kind, COUNT(*) as cnt FROM graph_nodes GROUP BY kind').all() as { kind: string; cnt: number }[]
    const edgeKinds = this.db.prepare('SELECT kind, COUNT(*) as cnt FROM graph_edges GROUP BY kind').all() as { kind: string; cnt: number }[]

    const nodesByKind: Record<string, number> = {}
    for (const { kind, cnt } of nodeKinds) nodesByKind[kind] = cnt
    const edgesByKind: Record<string, number> = {}
    for (const { kind, cnt } of edgeKinds) edgesByKind[kind] = cnt

    return { totalNodes, totalEdges, nodesByKind, edgesByKind }
  }

  // ---------------------------------------------------------------------------
  // Node/Edge Queries for Flows & Risk
  // ---------------------------------------------------------------------------

  getNodesByKind(kinds: string[]): GraphNode[] {
    if (kinds.length === 0) return []
    const placeholders = kinds.map(() => '?').join(',')
    const rows = this.db.prepare(
      `SELECT * FROM graph_nodes WHERE kind IN (${placeholders})`
    ).all(...kinds) as any[]
    return rows.map(rowToNode)
  }

  getNodeByQualifiedName(qn: string): GraphNode | null {
    const row = this.db.prepare('SELECT * FROM graph_nodes WHERE qualified_name = ?').get(qn) as any
    return row ? rowToNode(row) : null
  }

  getNodeById(id: number): GraphNode | null {
    const row = this.db.prepare('SELECT * FROM graph_nodes WHERE id = ?').get(id) as any
    return row ? rowToNode(row) : null
  }

  getEdgesBySource(qn: string, kind?: string): GraphEdge[] {
    const sql = kind
      ? 'SELECT * FROM graph_edges WHERE source_qualified = ? AND kind = ?'
      : 'SELECT * FROM graph_edges WHERE source_qualified = ?'
    const rows = (kind
      ? this.db.prepare(sql).all(qn, kind)
      : this.db.prepare(sql).all(qn)) as any[]
    return rows.map(rowToEdge)
  }

  getEdgesByTarget(qn: string, kind?: string): GraphEdge[] {
    const sql = kind
      ? 'SELECT * FROM graph_edges WHERE target_qualified = ? AND kind = ?'
      : 'SELECT * FROM graph_edges WHERE target_qualified = ?'
    const rows = (kind
      ? this.db.prepare(sql).all(qn, kind)
      : this.db.prepare(sql).all(qn)) as any[]
    return rows.map(rowToEdge)
  }

  getAllCallTargets(): Set<string> {
    const rows = this.db.prepare(
      "SELECT DISTINCT target_qualified FROM graph_edges WHERE kind = 'CALLS'"
    ).all() as { target_qualified: string }[]
    return new Set(rows.map(r => r.target_qualified))
  }

  /** Expose the DB handle for flow/risk modules that need direct SQL. */
  getDatabase(): Database { return this.db }

  // ---------------------------------------------------------------------------
  // Internal Helpers
  // ---------------------------------------------------------------------------

  private getNodesByQualifiedNames(names: string[]): GraphNode[] {
    if (names.length === 0) return []
    const placeholders = names.map(() => '?').join(',')
    const rows = this.db.prepare(
      `SELECT * FROM graph_nodes WHERE qualified_name IN (${placeholders})`
    ).all(...names) as any[]
    return rows.map(rowToNode)
  }

  private getEdgesAmong(qualifiedNames: string[]): GraphEdge[] {
    if (qualifiedNames.length === 0) return []
    const placeholders = qualifiedNames.map(() => '?').join(',')
    const rows = this.db.prepare(`
      SELECT * FROM graph_edges
      WHERE source_qualified IN (${placeholders})
        AND target_qualified IN (${placeholders})
    `).all(...qualifiedNames, ...qualifiedNames) as any[]
    return rows.map(rowToEdge)
  }

  private removeFileData(filePath: string, source: string): void {
    const qualifiedPrefix = `${source}::${filePath}`
    this.db.prepare('DELETE FROM graph_edges WHERE file_path = ?').run(filePath)
    this.db.prepare(
      'DELETE FROM graph_edges WHERE source_qualified LIKE ? OR target_qualified LIKE ?'
    ).run(`${qualifiedPrefix}%`, `${qualifiedPrefix}%`)
    this.db.prepare(
      'DELETE FROM graph_nodes WHERE file_path = ? AND source = ?'
    ).run(filePath, source)
  }

  private computeHash(content: string): string {
    const hasher = new Bun.CryptoHasher('sha256')
    hasher.update(content)
    return hasher.digest('hex')
  }
}

// ---------------------------------------------------------------------------
// Row Mappers
// ---------------------------------------------------------------------------

function rowToNode(row: any): GraphNode {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    qualifiedName: row.qualified_name,
    filePath: row.file_path,
    source: row.source,
    lineStart: row.line_start,
    lineEnd: row.line_end,
    language: row.language,
    parentName: row.parent_name,
    params: row.params ?? null,
    returnType: row.return_type ?? null,
    fileHash: row.file_hash,
    extra: JSON.parse(row.extra || '{}'),
    updatedAt: row.updated_at,
  }
}

function rowToEdge(row: any): GraphEdge {
  return {
    id: row.id,
    kind: row.kind,
    sourceQualified: row.source_qualified,
    targetQualified: row.target_qualified,
    filePath: row.file_path,
    line: row.line,
    extra: JSON.parse(row.extra || '{}'),
    updatedAt: row.updated_at,
  }
}
