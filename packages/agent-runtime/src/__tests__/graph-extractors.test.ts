// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Graph Extractors — Unit Tests
 *
 * Tests the MarkdownExtractor and ReferenceExtractor independently
 * without requiring a database or IndexEngine.
 */

import { describe, test, expect } from 'bun:test'
import { MarkdownExtractor, ReferenceExtractor, createDefaultExtractors } from '../graph-extractors'

// ============================================================================
// MarkdownExtractor
// ============================================================================

describe('MarkdownExtractor', () => {
  const ext = new MarkdownExtractor()

  test('canHandle accepts .md, .mdx, .markdown files', () => {
    expect(ext.canHandle('readme.md', 'files')).toBe(true)
    expect(ext.canHandle('docs/guide.mdx', 'files')).toBe(true)
    expect(ext.canHandle('notes.markdown', 'files')).toBe(true)
    expect(ext.canHandle('script.py', 'code')).toBe(false)
    expect(ext.canHandle('data.csv', 'files')).toBe(false)
  })

  test('extracts Section nodes from headings', () => {
    const content = '# Title\n\n## Getting Started\n\n### Installation\n\nSome text.'
    const result = ext.extract('readme.md', content, 'files', [])

    const sections = result.nodes.filter(n => n.kind === 'Section')
    expect(sections.length).toBe(3)
    expect(sections[0].name).toBe('Title')
    expect(sections[1].name).toBe('Getting Started')
    expect(sections[2].name).toBe('Installation')
  })

  test('Section nodes have correct level in extra', () => {
    const content = '# H1\n## H2\n### H3'
    const result = ext.extract('doc.md', content, 'files', [])

    const sections = result.nodes.filter(n => n.kind === 'Section')
    expect(sections[0].extra?.level).toBe(1)
    expect(sections[1].extra?.level).toBe(2)
    expect(sections[2].extra?.level).toBe(3)
  })

  test('creates CONTAINS edges from file to sections', () => {
    const content = '# Title\n## Section'
    const result = ext.extract('doc.md', content, 'files', [])

    const contains = result.edges.filter(e => e.kind === 'CONTAINS')
    expect(contains.length).toBe(2)
    expect(contains[0].sourceQualified).toBe('files::doc.md')
  })

  test('extracts LINKS_TO edges for internal links', () => {
    const content = 'See [the guide](setup.md) for more info.'
    const allFiles = ['readme.md', 'setup.md']
    const result = ext.extract('readme.md', content, 'files', allFiles)

    const links = result.edges.filter(e => e.kind === 'LINKS_TO')
    expect(links.length).toBe(1)
    expect(links[0].targetQualified).toBe('files::setup.md')
    expect(links[0].extra?.text).toBe('the guide')
  })

  test('ignores external http links', () => {
    const content = '[Google](https://google.com) and [local](setup.md)'
    const result = ext.extract('doc.md', content, 'files', ['setup.md'])

    const links = result.edges.filter(e => e.kind === 'LINKS_TO')
    expect(links.length).toBe(1)
    expect(links[0].targetQualified).toContain('setup.md')
  })

  test('ignores anchor-only links', () => {
    const content = 'Jump to [section](#overview)'
    const result = ext.extract('doc.md', content, 'files', [])

    const links = result.edges.filter(e => e.kind === 'LINKS_TO')
    expect(links.length).toBe(0)
  })

  test('extracts EMBEDS edges for images', () => {
    const content = '![Architecture diagram](images/arch.png)'
    const result = ext.extract('readme.md', content, 'files', [])

    const embeds = result.edges.filter(e => e.kind === 'EMBEDS')
    expect(embeds.length).toBe(1)
    expect(embeds[0].targetQualified).toContain('images/arch.png')
    expect(embeds[0].extra?.alt).toBe('Architecture diagram')
  })

  test('ignores external image URLs', () => {
    const content = '![logo](https://example.com/logo.png)'
    const result = ext.extract('doc.md', content, 'files', [])

    const embeds = result.edges.filter(e => e.kind === 'EMBEDS')
    expect(embeds.length).toBe(0)
  })

  test('resolves relative paths correctly', () => {
    const content = 'See [parent doc](../overview.md)'
    const result = ext.extract('docs/guide.md', content, 'files', ['overview.md'])

    const links = result.edges.filter(e => e.kind === 'LINKS_TO')
    expect(links.length).toBe(1)
    expect(links[0].targetQualified).toBe('files::overview.md')
  })

  test('strips query params and hash from link targets', () => {
    const content = '[doc](setup.md?v=2#section)'
    const result = ext.extract('readme.md', content, 'files', ['setup.md'])

    const links = result.edges.filter(e => e.kind === 'LINKS_TO')
    expect(links.length).toBe(1)
    expect(links[0].targetQualified).toBe('files::setup.md')
  })
})

// ============================================================================
// ReferenceExtractor
// ============================================================================

describe('ReferenceExtractor', () => {
  const ext = new ReferenceExtractor()

  test('canHandle accepts all files', () => {
    expect(ext.canHandle('anything.md', 'files')).toBe(true)
    expect(ext.canHandle('code.ts', 'code')).toBe(true)
    expect(ext.canHandle('data.csv', 'files')).toBe(true)
  })

  test('detects filename mentions in text', () => {
    const content = 'The data is stored in customers.csv and the config is in config.yaml.'
    const allFiles = ['readme.md', 'customers.csv', 'config.yaml']
    const result = ext.extract('readme.md', content, 'files', allFiles)

    const refs = result.edges.filter(e => e.kind === 'REFERENCES')
    expect(refs.length).toBe(2)
    const targets = refs.map(r => r.targetQualified)
    expect(targets.some(t => t.includes('customers.csv'))).toBe(true)
    expect(targets.some(t => t.includes('config.yaml'))).toBe(true)
  })

  test('does not self-reference', () => {
    const content = 'This file is readme.md and it references readme.md again.'
    const result = ext.extract('readme.md', content, 'files', ['readme.md'])

    const refs = result.edges.filter(e => e.kind === 'REFERENCES')
    expect(refs.length).toBe(0)
  })

  test('handles quoted filenames', () => {
    const content = 'See "config.json" for settings.'
    const result = ext.extract('readme.md', content, 'files', ['config.json'])

    const refs = result.edges.filter(e => e.kind === 'REFERENCES')
    expect(refs.length).toBe(1)
  })

  test('does not match substrings (requires word boundary)', () => {
    const content = 'The myconfig.yaml file is different from config.yaml.'
    const result = ext.extract('readme.md', content, 'files', ['config.yaml'])

    const refs = result.edges.filter(e => e.kind === 'REFERENCES')
    expect(refs.length).toBe(1)
  })

  test('deduplicates references (only one edge per file pair)', () => {
    const content = 'data.csv is important.\nI said data.csv again.\ndata.csv three times.'
    const result = ext.extract('readme.md', content, 'files', ['data.csv'])

    const refs = result.edges.filter(e => e.kind === 'REFERENCES')
    expect(refs.length).toBe(1)
  })

  test('handles files with no other files gracefully', () => {
    const content = 'Some text content.'
    const result = ext.extract('readme.md', content, 'files', [])
    expect(result.nodes.length).toBe(0)
    expect(result.edges.length).toBe(0)
  })

  test('skips very short filenames (under 3 chars)', () => {
    const content = 'See ab for details.'
    const result = ext.extract('readme.md', content, 'files', ['ab'])
    expect(result.edges.length).toBe(0)
  })

  test('creates no nodes (reference extractor only produces edges)', () => {
    const content = 'Mentions data.csv here.'
    const result = ext.extract('doc.md', content, 'files', ['data.csv'])
    expect(result.nodes.length).toBe(0)
  })

  test('records matched filename in edge extra', () => {
    const content = 'Use the schema.sql file.'
    const result = ext.extract('readme.md', content, 'files', ['db/schema.sql'])

    const refs = result.edges.filter(e => e.kind === 'REFERENCES')
    expect(refs.length).toBe(1)
    expect(refs[0].extra?.matchedName).toBe('schema.sql')
  })
})

// ============================================================================
// createDefaultExtractors
// ============================================================================

describe('createDefaultExtractors', () => {
  test('returns all extractors', () => {
    const extractors = createDefaultExtractors()
    expect(extractors.length).toBe(3)
    expect(extractors[0].name).toBe('code')
    expect(extractors[1].name).toBe('markdown')
    expect(extractors[2].name).toBe('reference')
  })
})
