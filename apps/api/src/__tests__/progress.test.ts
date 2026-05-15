// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from 'bun:test'
import {
  VIRTUAL_TOOL_NAMES,
  isVirtualTool,
  type SubagentProgressEvent,
  type VirtualToolEvent,
  type VirtualToolName,
} from '../types/progress'

describe('VIRTUAL_TOOL_NAMES', () => {
  test('is a non-empty readonly tuple', () => {
    expect(Array.isArray(VIRTUAL_TOOL_NAMES)).toBe(true)
    expect(VIRTUAL_TOOL_NAMES.length).toBeGreaterThan(0)
  })

  test('contains the documented virtual tools', () => {
    expect(VIRTUAL_TOOL_NAMES).toContain('navigate_to_phase')
    expect(VIRTUAL_TOOL_NAMES).toContain('show_schema')
  })

  test('has no duplicate entries', () => {
    const unique = new Set(VIRTUAL_TOOL_NAMES)
    expect(unique.size).toBe(VIRTUAL_TOOL_NAMES.length)
  })

  test('every entry is a non-empty string', () => {
    for (const name of VIRTUAL_TOOL_NAMES) {
      expect(typeof name).toBe('string')
      expect(name.length).toBeGreaterThan(0)
    }
  })

  test('entries are snake_case identifiers (the convention)', () => {
    for (const name of VIRTUAL_TOOL_NAMES) {
      expect(name).toMatch(/^[a-z][a-z0-9_]*$/)
    }
  })
})

describe('isVirtualTool', () => {
  test('returns true for every name in VIRTUAL_TOOL_NAMES', () => {
    for (const name of VIRTUAL_TOOL_NAMES) {
      expect(isVirtualTool(name)).toBe(true)
    }
  })

  test('returns false for tool names that are not virtual', () => {
    for (const name of ['Read', 'Write', 'Bash', 'WebFetch', 'glob', 'edit_file']) {
      expect(isVirtualTool(name)).toBe(false)
    }
  })

  test('is case-sensitive (Navigate_To_Phase != navigate_to_phase)', () => {
    expect(isVirtualTool('navigate_to_phase')).toBe(true)
    expect(isVirtualTool('Navigate_To_Phase')).toBe(false)
    expect(isVirtualTool('NAVIGATE_TO_PHASE')).toBe(false)
  })

  test('returns false for the empty string', () => {
    expect(isVirtualTool('')).toBe(false)
  })

  test('returns false for names that are substrings or supersets of a virtual tool', () => {
    expect(isVirtualTool('navigate')).toBe(false)
    expect(isVirtualTool('navigate_to_phase_v2')).toBe(false)
    expect(isVirtualTool(' navigate_to_phase')).toBe(false) // leading space
    expect(isVirtualTool('navigate_to_phase ')).toBe(false) // trailing space
  })

  test('narrows the TypeScript type (compile-time contract)', () => {
    // This test exercises the type-guard branch. If the guard didn't narrow,
    // assignment to `VirtualToolName` would be a TS error.
    const candidate: string = 'navigate_to_phase'
    if (isVirtualTool(candidate)) {
      const narrowed: VirtualToolName = candidate
      expect(narrowed).toBe('navigate_to_phase')
    } else {
      throw new Error('expected the type guard to accept the candidate')
    }
  })
})

describe('SubagentProgressEvent type shape (runtime smoke check)', () => {
  test('subagent-start variant is constructible with the documented fields', () => {
    const ev: SubagentProgressEvent = {
      type: 'subagent-start',
      agentId: 'agent_1',
      agentType: 'general-purpose',
      timestamp: 1700000000,
    }
    expect(ev.type).toBe('subagent-start')
    if (ev.type === 'subagent-start') {
      expect(ev.agentId).toBe('agent_1')
      expect(ev.agentType).toBe('general-purpose')
    }
  })

  test('subagent-stop variant has only agentId + timestamp (no agentType)', () => {
    const ev: SubagentProgressEvent = {
      type: 'subagent-stop',
      agentId: 'agent_1',
      timestamp: 1700000001,
    }
    expect(ev.type).toBe('subagent-stop')
    // The discriminated union: stop has no `agentType` field.
    expect((ev as Record<string, unknown>).agentType).toBeUndefined()
  })

  test('tool-complete variant carries toolName + toolUseId', () => {
    const ev: SubagentProgressEvent = {
      type: 'tool-complete',
      toolName: 'Read',
      toolUseId: 'use_xyz',
      timestamp: 1700000002,
    }
    expect(ev.type).toBe('tool-complete')
    if (ev.type === 'tool-complete') {
      expect(ev.toolName).toBe('Read')
      expect(ev.toolUseId).toBe('use_xyz')
    }
  })
})

describe('VirtualToolEvent type shape (runtime smoke check)', () => {
  test('is constructible with the documented fields', () => {
    const ev: VirtualToolEvent = {
      type: 'virtual-tool-execute',
      toolUseId: 'use_1',
      toolName: 'navigate_to_phase',
      args: { phase: 'plan' },
      timestamp: 1700000003,
    }
    expect(ev.type).toBe('virtual-tool-execute')
    expect(ev.args).toEqual({ phase: 'plan' })
  })

  test('args accepts arbitrary unknown values (Record<string, unknown>)', () => {
    const ev: VirtualToolEvent = {
      type: 'virtual-tool-execute',
      toolUseId: 'use_2',
      toolName: 'show_schema',
      args: { tables: ['a', 'b'], filter: null, nested: { x: 1 } },
      timestamp: 0,
    }
    expect(ev.args.tables).toEqual(['a', 'b'])
    expect(ev.args.filter).toBeNull()
  })
})
