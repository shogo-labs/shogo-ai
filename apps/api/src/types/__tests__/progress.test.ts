// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, it } from 'bun:test'
import {
  VIRTUAL_TOOL_NAMES,
  isVirtualTool,
  type SubagentProgressEvent,
  type VirtualToolEvent,
  type VirtualToolName,
} from '../progress'

describe('VIRTUAL_TOOL_NAMES', () => {
  it('contains the documented virtual tools', () => {
    expect(VIRTUAL_TOOL_NAMES).toContain('navigate_to_phase')
    expect(VIRTUAL_TOOL_NAMES).toContain('show_schema')
  })

  it('is a readonly tuple (length matches snapshot)', () => {
    expect(VIRTUAL_TOOL_NAMES).toHaveLength(2)
  })

  it('has no duplicates', () => {
    expect(new Set(VIRTUAL_TOOL_NAMES).size).toBe(VIRTUAL_TOOL_NAMES.length)
  })

  it('exports as const (frozen / not mutable at compile time)', () => {
    // Runtime sanity — `as const` does not freeze, but verifies the export
    // is still array-like and includes-iterable for the type guard.
    expect(Array.isArray(VIRTUAL_TOOL_NAMES)).toBe(true)
  })
})

describe('isVirtualTool', () => {
  it('returns true for navigate_to_phase', () => {
    expect(isVirtualTool('navigate_to_phase')).toBe(true)
  })

  it('returns true for show_schema', () => {
    expect(isVirtualTool('show_schema')).toBe(true)
  })

  it('returns false for unknown tool names', () => {
    expect(isVirtualTool('Read')).toBe(false)
    expect(isVirtualTool('Write')).toBe(false)
    expect(isVirtualTool('Bash')).toBe(false)
  })

  it('returns false for the empty string', () => {
    expect(isVirtualTool('')).toBe(false)
  })

  it('is case-sensitive', () => {
    expect(isVirtualTool('Navigate_To_Phase')).toBe(false)
    expect(isVirtualTool('NAVIGATE_TO_PHASE')).toBe(false)
    expect(isVirtualTool('Show_Schema')).toBe(false)
  })

  it('returns false for partial matches', () => {
    expect(isVirtualTool('navigate')).toBe(false)
    expect(isVirtualTool('navigate_to_phase ')).toBe(false)
    expect(isVirtualTool(' navigate_to_phase')).toBe(false)
    expect(isVirtualTool('navigate_to_phase_v2')).toBe(false)
  })

  it('returns false for whitespace-only input', () => {
    expect(isVirtualTool('   ')).toBe(false)
  })

  it('every entry in VIRTUAL_TOOL_NAMES is itself a virtual tool', () => {
    for (const name of VIRTUAL_TOOL_NAMES) {
      expect(isVirtualTool(name)).toBe(true)
    }
  })

  it('narrows the input type to VirtualToolName (compile-time check, runtime sanity)', () => {
    const t: string = 'navigate_to_phase'
    if (isVirtualTool(t)) {
      // After the guard, t is VirtualToolName. We just assert the runtime value.
      const narrowed: VirtualToolName = t
      expect(narrowed).toBe('navigate_to_phase')
    } else {
      throw new Error('expected isVirtualTool to narrow')
    }
  })
})

describe('type shape — SubagentProgressEvent (runtime sanity)', () => {
  it('accepts subagent-start payloads', () => {
    const ev: SubagentProgressEvent = {
      type: 'subagent-start',
      agentId: 'a-1',
      agentType: 'explore',
      timestamp: 123,
    }
    expect(ev.type).toBe('subagent-start')
  })

  it('accepts subagent-stop payloads', () => {
    const ev: SubagentProgressEvent = {
      type: 'subagent-stop',
      agentId: 'a-1',
      timestamp: 123,
    }
    expect(ev.type).toBe('subagent-stop')
  })

  it('accepts tool-complete payloads', () => {
    const ev: SubagentProgressEvent = {
      type: 'tool-complete',
      toolName: 'Read',
      toolUseId: 'use-1',
      timestamp: 123,
    }
    expect(ev.type).toBe('tool-complete')
  })
})

describe('type shape — VirtualToolEvent', () => {
  it('accepts a well-formed virtual-tool-execute event', () => {
    const ev: VirtualToolEvent = {
      type: 'virtual-tool-execute',
      toolUseId: 'use-1',
      toolName: 'navigate_to_phase',
      args: { phase: 'review' },
      timestamp: Date.now(),
    }
    expect(ev.type).toBe('virtual-tool-execute')
    expect(ev.args.phase).toBe('review')
  })

  it('allows empty args', () => {
    const ev: VirtualToolEvent = {
      type: 'virtual-tool-execute',
      toolUseId: 'use-2',
      toolName: 'show_schema',
      args: {},
      timestamp: 0,
    }
    expect(Object.keys(ev.args)).toHaveLength(0)
  })
})
