// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Graph Extractors
 *
 * Pluggable extractors that analyze file content and produce nodes + edges
 * for the WorkspaceGraph. Each extractor handles a specific file type or
 * relationship pattern.
 *
 * Current extractors:
 * - MarkdownExtractor: headings as Section nodes, links/images as edges
 * - ReferenceExtractor: filename mentions in text → REFERENCES edges
 */

import { basename, extname } from 'path'
import { CodeExtractor } from './code-extractor'
import type { Extractor, ExtractedData } from './workspace-graph'

// ---------------------------------------------------------------------------
// MarkdownExtractor
// ---------------------------------------------------------------------------

const MD_LINK_RE = /\[([^\]]*)\]\(([^)]+)\)/g
const MD_IMAGE_RE = /!\[([^\]]*)\]\(([^)]+)\)/g
const MD_HEADING_RE = /^(#{1,6})\s+(.+)$/gm

/**
 * Extracts structure from markdown files:
 * - Section nodes for each heading (##, ###, etc.)
 * - LINKS_TO edges for markdown links to other workspace files
 * - EMBEDS edges for image/asset references
 */
export class MarkdownExtractor implements Extractor {
  name = 'markdown'

  canHandle(filePath: string, _source: string): boolean {
    const ext = extname(filePath).toLowerCase()
    return ext === '.md' || ext === '.mdx' || ext === '.markdown'
  }

  extract(filePath: string, content: string, source: string, allFiles: string[]): ExtractedData {
    const nodes: ExtractedData['nodes'] = []
    const edges: ExtractedData['edges'] = []
    const fileQN = `${source}::${filePath}`
    const allFileSet = new Set(allFiles)
    const lines = content.split('\n')

    // Extract heading sections as nodes
    let match: RegExpExecArray | null
    MD_HEADING_RE.lastIndex = 0
    while ((match = MD_HEADING_RE.exec(content)) !== null) {
      const level = match[1].length
      const title = match[2].trim()
      const lineNum = content.substring(0, match.index).split('\n').length
      const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

      nodes.push({
        kind: 'Section',
        name: title,
        qualifiedName: `${fileQN}::section::${slug}`,
        filePath,
        source,
        lineStart: lineNum,
        lineEnd: lineNum,
        extra: { level },
      })

      edges.push({
        kind: 'CONTAINS',
        sourceQualified: fileQN,
        targetQualified: `${fileQN}::section::${slug}`,
        filePath,
        line: lineNum,
      })
    }

    // Extract markdown links → LINKS_TO edges
    MD_LINK_RE.lastIndex = 0
    while ((match = MD_LINK_RE.exec(content)) !== null) {
      const linkText = match[1]
      const href = match[2]

      if (href.startsWith('http://') || href.startsWith('https://') || href.startsWith('#')) continue

      const cleanHref = href.split('#')[0].split('?')[0]
      if (!cleanHref) continue

      const lineNum = content.substring(0, match.index).split('\n').length
      const targetPath = resolveRelativePath(filePath, cleanHref)

      if (targetPath && allFileSet.has(targetPath)) {
        edges.push({
          kind: 'LINKS_TO',
          sourceQualified: fileQN,
          targetQualified: `${source}::${targetPath}`,
          filePath,
          line: lineNum,
          extra: { text: linkText },
        })
      }
    }

    // Extract image/embed references → EMBEDS edges
    MD_IMAGE_RE.lastIndex = 0
    while ((match = MD_IMAGE_RE.exec(content)) !== null) {
      const altText = match[1]
      const src = match[2]

      if (src.startsWith('http://') || src.startsWith('https://')) continue

      const cleanSrc = src.split('#')[0].split('?')[0]
      if (!cleanSrc) continue

      const lineNum = content.substring(0, match.index).split('\n').length
      const targetPath = resolveRelativePath(filePath, cleanSrc)

      if (targetPath) {
        edges.push({
          kind: 'EMBEDS',
          sourceQualified: fileQN,
          targetQualified: `${source}::${targetPath}`,
          filePath,
          line: lineNum,
          extra: { alt: altText },
        })
      }
    }

    return { nodes, edges }
  }
}

// ---------------------------------------------------------------------------
// ReferenceExtractor
// ---------------------------------------------------------------------------

/**
 * Detects mentions of other workspace filenames in text content.
 * Creates REFERENCES edges when a file's content mentions another file by name.
 *
 * Handles patterns like:
 * - "See report.csv" / "see report.csv"
 * - "data in customers.csv"
 * - "defined in utils.py"
 * - "the config.yaml file"
 * - quoted filenames: "config.json", 'setup.md'
 */
export class ReferenceExtractor implements Extractor {
  name = 'reference'

  canHandle(_filePath: string, _source: string): boolean {
    return true
  }

  extract(filePath: string, content: string, source: string, allFiles: string[]): ExtractedData {
    const edges: ExtractedData['edges'] = []
    const fileQN = `${source}::${filePath}`

    if (allFiles.length === 0) return { nodes: [], edges: [] }

    // Build a map of basename → full paths for matching
    const nameToPath = new Map<string, string[]>()
    for (const f of allFiles) {
      if (f === filePath) continue
      const name = basename(f)
      if (name.length < 3) continue
      const ext = extname(name).toLowerCase()
      if (!ext || ext === '.') continue

      const existing = nameToPath.get(name) || []
      existing.push(f)
      nameToPath.set(name, existing)
    }

    if (nameToPath.size === 0) return { nodes: [], edges: [] }

    const lines = content.split('\n')
    const foundRefs = new Set<string>()

    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
      const line = lines[lineIdx]

      for (const [fileName, paths] of nameToPath) {
        if (!line.includes(fileName)) continue

        // Verify it's a real reference: preceded by whitespace, quotes, or line start;
        // followed by whitespace, quotes, punctuation, or line end
        const escaped = fileName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        const refPattern = new RegExp(`(?:^|[\\s"'\`(\\[/])${escaped}(?:$|[\\s"'\`),;:.!?\\])])`)
        if (!refPattern.test(line)) continue

        for (const targetPath of paths) {
          const refKey = `${filePath}->${targetPath}`
          if (foundRefs.has(refKey)) continue
          foundRefs.add(refKey)

          edges.push({
            kind: 'REFERENCES',
            sourceQualified: fileQN,
            targetQualified: `${source}::${targetPath}`,
            filePath,
            line: lineIdx + 1,
            extra: { matchedName: fileName },
          })
        }
      }
    }

    return { nodes: [], edges }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveRelativePath(fromFile: string, href: string): string | null {
  if (href.startsWith('/')) return href.substring(1)

  const fromDir = fromFile.includes('/') ? fromFile.substring(0, fromFile.lastIndexOf('/')) : ''
  const parts = (fromDir ? `${fromDir}/${href}` : href).split('/')
  const resolved: string[] = []

  for (const part of parts) {
    if (part === '.' || part === '') continue
    if (part === '..') {
      resolved.pop()
    } else {
      resolved.push(part)
    }
  }

  return resolved.length > 0 ? resolved.join('/') : null
}

/**
 * Returns all built-in extractors.
 */
export function createDefaultExtractors(): Extractor[] {
  return [new CodeExtractor(), new MarkdownExtractor(), new ReferenceExtractor()]
}
