// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Auto-Checkpoint Detection Tests
 *
 * Tests that hasFileModifyingTools correctly identifies all tool names
 * that should trigger an automatic checkpoint after a chat session.
 *
 * Run: bun test apps/api/src/__tests__/auto-checkpoint.test.ts
 */

import { describe, test, expect } from 'bun:test'
import { FILE_MODIFYING_TOOLS, hasFileModifyingTools } from '../routes/project-chat'

function makeToolMap(toolNames: string[]): Map<string, { toolName: string }> {
  const map = new Map<string, { toolName: string }>()
  toolNames.forEach((name, i) => {
    map.set(`call-${i}`, { toolName: name })
  })
  return map
}

// =============================================================================
// FILE_MODIFYING_TOOLS set completeness
// =============================================================================

describe('FILE_MODIFYING_TOOLS set', () => {
  const expectedTools = [
    'write_file',
    'edit_file',
    'delete_file',
    'exec',
    'generate_image',
    'tool_install',
    'mcp_install',
  ]

  for (const tool of expectedTools) {
    test(`includes ${tool}`, () => {
      expect(FILE_MODIFYING_TOOLS.has(tool)).toBe(true)
    })
  }

  test('does not include read-only tools', () => {
    const readOnlyTools = [
      'read_file',
      'glob',
      'grep',
      'ls',
      'list_files',
      'search',
      'impact_radius',
      'detect_changes',
      'review_context',
      'read_lints',
    ]
    for (const tool of readOnlyTools) {
      expect(FILE_MODIFYING_TOOLS.has(tool)).toBe(false)
    }
  })
})

// =============================================================================
// hasFileModifyingTools
// =============================================================================

describe('hasFileModifyingTools', () => {
  test('returns true for write_file', () => {
    expect(hasFileModifyingTools(makeToolMap(['write_file']))).toBe(true)
  })

  test('returns true for edit_file', () => {
    expect(hasFileModifyingTools(makeToolMap(['edit_file']))).toBe(true)
  })

  test('returns true for delete_file', () => {
    expect(hasFileModifyingTools(makeToolMap(['delete_file']))).toBe(true)
  })

  test('returns true for exec', () => {
    expect(hasFileModifyingTools(makeToolMap(['exec']))).toBe(true)
  })

  test('returns true for generate_image', () => {
    expect(hasFileModifyingTools(makeToolMap(['generate_image']))).toBe(true)
  })

  test('returns true for tool_install', () => {
    expect(hasFileModifyingTools(makeToolMap(['tool_install']))).toBe(true)
  })

  test('returns true for mcp_install', () => {
    expect(hasFileModifyingTools(makeToolMap(['mcp_install']))).toBe(true)
  })

  test('returns true for any mcp_ prefixed tool', () => {
    expect(hasFileModifyingTools(makeToolMap(['mcp_github_create_issue']))).toBe(true)
    expect(hasFileModifyingTools(makeToolMap(['mcp_filesystem_write']))).toBe(true)
    expect(hasFileModifyingTools(makeToolMap(['mcp_custom_server_do_thing']))).toBe(true)
  })

  test('returns false for read-only tools', () => {
    expect(hasFileModifyingTools(makeToolMap(['read_file']))).toBe(false)
    expect(hasFileModifyingTools(makeToolMap(['glob']))).toBe(false)
    expect(hasFileModifyingTools(makeToolMap(['grep']))).toBe(false)
    expect(hasFileModifyingTools(makeToolMap(['ls']))).toBe(false)
    expect(hasFileModifyingTools(makeToolMap(['search']))).toBe(false)
  })

  test('returns false for empty tool map', () => {
    expect(hasFileModifyingTools(new Map())).toBe(false)
  })

  test('returns true when at least one tool is file-modifying', () => {
    const map = makeToolMap(['read_file', 'glob', 'edit_file', 'search'])
    expect(hasFileModifyingTools(map)).toBe(true)
  })

  test('returns false when all tools are read-only', () => {
    const map = makeToolMap(['read_file', 'glob', 'grep', 'search', 'ls'])
    expect(hasFileModifyingTools(map)).toBe(false)
  })
})
