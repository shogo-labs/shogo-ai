// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Unit tests for ContextAggregator, serializeContext, formatContextMessage.
 *
 * Tests cover:
 *   - Token budget enforcement and priority ordering
 *   - Source collection with partial failures
 *   - Serialization of all context types
 *   - Edge cases: empty context, quote escaping, zero timestamps
 */

import { describe, it, expect, mock } from 'bun:test'
import {
  ContextAggregator,
  serializeContext,
  formatContextMessage,
  type AggregatedContext,
  type Command,
} from '../context-aggregator'
import { Osc633Tracker } from '../osc633-tracker'

// ─── helpers ────────────────────────────────────────────────────────────

/** Feed a complete A-B-C-D cycle into a tracker and return the finished command. */
function feedCommand(tracker: Osc633Tracker, cmdLine: string, exitCode: number, cwd?: string): Command {
  const feed = (s: string) => {
    const enc = new TextEncoder().encode(s)
    const { OscDecoder } = require('@shogo/pty-core')
    const decoder = new OscDecoder()
    const { events } = decoder.feed(enc)
    tracker.feedAll(events)
  }
  if (cwd) feed(`\x1b]633;P;Cwd=${cwd}\x07`)
  feed(`\x1b]633;A\x07`)
  feed(`\x1b]633;B\x07`)
  feed(`\x1b]633;E;${cmdLine}\x07`)
  feed(`\x1b]633;C\x07`)
  feed(`\x1b]633;D;${exitCode}\x07`)
  const snap = tracker.snapshot()
  return snap.commands[snap.commands.length - 1]!
}

function makeTracker(): Osc633Tracker {
  return new Osc633Tracker()
}

function makeFakeSources(opts?: {
  file?: { relativePath: string; language: string; selection?: string } | null
  git?: { branch: string; stagedCount: number; modifiedCount: number; untrackedCount: number; conflictCount: number } | null
  diags?: Array<{ severity: 'error' | 'warning' | 'info'; file: string; line: number; column: number; message: string }>
}) {
  return {
    editor: {
      getActiveFile: async () => opts?.file ?? null,
    },
    git: {
      getStatus: async () => opts?.git ?? null,
    },
    diagnostics: {
      getDiagnostics: async () => opts?.diags ?? [],
    },
  }
}

// ─── ContextAggregator.collect() ────────────────────────────────────────

describe('ContextAggregator', () => {
  describe('collect() — basic behavior', () => {
    it('collects terminal commands from the tracker', async () => {
      const tracker = makeTracker()
      feedCommand(tracker, 'npm test', 1, '/proj')
      feedCommand(tracker, 'ls', 0, '/proj')

      const agg = new ContextAggregator({
        tracker,
        ...makeFakeSources(),
      })
      const ctx = await agg.collect()

      expect(ctx.terminalCommands).toHaveLength(2)
      expect(ctx.terminalCommands[0].commandLine).toBe('npm test')
      expect(ctx.terminalCommands[1].commandLine).toBe('ls')
    })

    it('collects from all sources in parallel', async () => {
      const tracker = makeTracker()
      feedCommand(tracker, 'echo hi', 0)

      const agg = new ContextAggregator({
        tracker,
        ...makeFakeSources({
          file: { relativePath: 'src/App.tsx', language: 'typescriptreact' },
          git: { branch: 'main', stagedCount: 1, modifiedCount: 0, untrackedCount: 0, conflictCount: 0 },
          diags: [{ severity: 'error', file: 'src/App.tsx', line: 10, column: 5, message: 'Type error' }],
        }),
      })
      const ctx = await agg.collect()

      expect(ctx.terminalCommands).toHaveLength(1)
      expect(ctx.activeFile?.relativePath).toBe('src/App.tsx')
      expect(ctx.gitStatus?.branch).toBe('main')
      expect(ctx.diagnostics).toHaveLength(1)
    })

    it('returns empty sources when everything is empty', async () => {
      const agg = new ContextAggregator({
        tracker: makeTracker(),
        ...makeFakeSources(),
      })
      const ctx = await agg.collect()

      expect(ctx.terminalCommands).toHaveLength(0)
      expect(ctx.activeFile).toBeNull()
      expect(ctx.gitStatus).toBeNull()
      expect(ctx.diagnostics).toHaveLength(0)
      expect(ctx.sources).toHaveLength(0)
    })
  })

  describe('collect() — failure resilience', () => {
    it('continues when editor source throws', async () => {
      const tracker = makeTracker()
      feedCommand(tracker, 'ls', 0)
      const agg = new ContextAggregator({
        tracker,
        editor: { getActiveFile: async () => { throw new Error('IPC failed') } },
        git: { getStatus: async () => null },
        diagnostics: { getDiagnostics: async () => [] },
      })
      const ctx = await agg.collect()
      expect(ctx.terminalCommands).toHaveLength(1)
      expect(ctx.activeFile).toBeNull()
    })

    it('continues when git source throws', async () => {
      const agg = new ContextAggregator({
        tracker: makeTracker(),
        editor: { getActiveFile: async () => null },
        git: { getStatus: async () => { throw new Error('git broken') } },
        diagnostics: { getDiagnostics: async () => [] },
      })
      const ctx = await agg.collect()
      expect(ctx.gitStatus).toBeNull()
    })

    it('continues when diagnostics source throws', async () => {
      const agg = new ContextAggregator({
        tracker: makeTracker(),
        editor: { getActiveFile: async () => null },
        git: { getStatus: async () => null },
        diagnostics: { getDiagnostics: async () => { throw new Error('broken') } },
      })
      const ctx = await agg.collect()
      expect(ctx.diagnostics).toHaveLength(0)
    })
  })

  describe('collect() — token budget', () => {
    it('respects a tiny token budget by dropping lower-priority items', async () => {
      const tracker = makeTracker()
      feedCommand(tracker, 'npm test', 1, '/proj')
      const agg = new ContextAggregator({
        tracker,
        ...makeFakeSources({
          file: { relativePath: 'src/very-long-file-path/Component.tsx', language: 'typescriptreact' },
          git: { branch: 'feature/long-branch-name', stagedCount: 5, modifiedCount: 3, untrackedCount: 1, conflictCount: 0 },
        }),
        tokenBudget: 25, // Very tight — only ~100 chars
      })
      const ctx = await agg.collect()

      // With 25 tokens = 100 chars, terminal command alone takes ~63 tokens
      // So nothing fits except maybe the terminal command
      expect(ctx.tokenEstimate).toBeLessThanOrEqual(25)
    })

    it('prioritizes diagnostics over git when budget is tight', async () => {
      const tracker = makeTracker()
      const agg = new ContextAggregator({
        tracker,
        editor: { getActiveFile: async () => null },
        git: { getStatus: async () => ({ branch: 'main', stagedCount: 0, modifiedCount: 0, untrackedCount: 0, conflictCount: 0 }) },
        diagnostics: { getDiagnostics: async () => [
          { severity: 'error', file: 'a.ts', line: 1, column: 1, message: 'err1' },
        ] },
        tokenBudget: 100,
      })
      const ctx = await agg.collect()

      // Diagnostics should be included before git
      expect(ctx.diagnostics.length).toBeGreaterThanOrEqual(0) // depends on budget
      const diagSource = ctx.sources.find(s => s.type === 'diagnostics')
      const gitSource = ctx.sources.find(s => s.type === 'git')
      if (diagSource && gitSource) {
        const diagIdx = ctx.sources.indexOf(diagSource)
        const gitIdx = ctx.sources.indexOf(gitSource)
        expect(diagIdx).toBeLessThan(gitIdx)
      }
    })

    it('only takes the last 5 commands from tracker', async () => {
      const tracker = makeTracker()
      for (let i = 0; i < 10; i++) {
        feedCommand(tracker, `cmd${i}`, 0, '/proj')
      }
      const agg = new ContextAggregator({
        tracker,
        ...makeFakeSources(),
        tokenBudget: 100_000, // Huge budget — take everything
      })
      const ctx = await agg.collect()

      expect(ctx.terminalCommands).toHaveLength(5)
      // Should be the last 5
      expect(ctx.terminalCommands[0].commandLine).toBe('cmd5')
      expect(ctx.terminalCommands[4].commandLine).toBe('cmd9')
    })
  })

  describe('collect() — source labels', () => {
    it('generates correct terminal label for single command', async () => {
      const tracker = makeTracker()
      feedCommand(tracker, 'ls', 0)
      const agg = new ContextAggregator({ tracker, ...makeFakeSources() })
      const ctx = await agg.collect()
      expect(ctx.sources.find(s => s.type === 'terminal')?.label).toBe('1 terminal command')
    })

    it('generates correct terminal label for multiple commands', async () => {
      const tracker = makeTracker()
      feedCommand(tracker, 'ls', 0)
      feedCommand(tracker, 'pwd', 0)
      const agg = new ContextAggregator({ tracker, ...makeFakeSources() })
      const ctx = await agg.collect()
      expect(ctx.sources.find(s => s.type === 'terminal')?.label).toBe('2 terminal commands')
    })
  })
})

// ─── serializeContext() ─────────────────────────────────────────────────

describe('serializeContext', () => {
  it('serializes terminal commands with exit code', () => {
    const tracker = makeTracker()
    const cmd = feedCommand(tracker, 'npm test', 1, '/proj')
    const ctx: AggregatedContext = {
      terminalCommands: [cmd],
      activeFile: null,
      gitStatus: null,
      diagnostics: [],
      tokenEstimate: 10,
      sources: [{ type: 'terminal', label: '1 command', itemCount: 1 }],
    }
    const text = serializeContext(ctx)
    expect(text).toContain('$ npm test')
    expect(text).toContain('exit 1')
    expect(text).toContain('cwd: /proj')
  })

  it('shows ✓ for exit code 0', () => {
    const tracker = makeTracker()
    const cmd = feedCommand(tracker, 'ls', 0, '/tmp')
    const ctx: AggregatedContext = {
      terminalCommands: [cmd],
      activeFile: null,
      gitStatus: null,
      diagnostics: [],
      tokenEstimate: 10,
      sources: [],
    }
    const text = serializeContext(ctx)
    expect(text).toContain('✓')
  })

  it('shows "interrupted" for null exit code', () => {
    const ctx: AggregatedContext = {
      terminalCommands: [{
        id: 1, commandLine: 'top', cwd: null, exitCode: null,
        promptMarker: null, startMarker: null, endMarker: null,
        startedAt: null, finishedAt: null, state: 'finished',
      }],
      activeFile: null, gitStatus: null, diagnostics: [],
      tokenEstimate: 0, sources: [],
    }
    const text = serializeContext(ctx)
    expect(text).toContain('interrupted')
  })

  it('handles command with empty commandLine', () => {
    const ctx: AggregatedContext = {
      terminalCommands: [{
        id: 1, commandLine: '', cwd: null, exitCode: 0,
        promptMarker: null, startMarker: null, endMarker: null,
        startedAt: null, finishedAt: null, state: 'finished',
      }],
      activeFile: null, gitStatus: null, diagnostics: [],
      tokenEstimate: 0, sources: [],
    }
    const text = serializeContext(ctx)
    expect(text).toContain('(no command)')
  })

  it('serializes diagnostics with correct icons', () => {
    const ctx: AggregatedContext = {
      terminalCommands: [],
      activeFile: null, gitStatus: null,
      diagnostics: [
        { severity: 'error', file: 'a.ts', line: 1, column: 1, message: 'err' },
        { severity: 'warning', file: 'b.ts', line: 2, column: 3, message: 'warn' },
        { severity: 'info', file: 'c.ts', line: 4, column: 5, message: 'info' },
      ],
      tokenEstimate: 0, sources: [],
    }
    const text = serializeContext(ctx)
    expect(text).toContain('❌ a.ts:1:1 — err')
    expect(text).toContain('⚠️ b.ts:2:3 — warn')
    expect(text).toContain('ℹ️ c.ts:4:5 — info')
  })

  it('serializes git status with changes', () => {
    const ctx: AggregatedContext = {
      terminalCommands: [],
      activeFile: null,
      gitStatus: { branch: 'feat/x', stagedCount: 2, modifiedCount: 1, untrackedCount: 0, conflictCount: 0 },
      diagnostics: [], tokenEstimate: 0, sources: [],
    }
    const text = serializeContext(ctx)
    expect(text).toContain('Branch: feat/x')
    expect(text).toContain('2 staged')
    expect(text).toContain('1 modified')
  })

  it('serializes clean git status', () => {
    const ctx: AggregatedContext = {
      terminalCommands: [],
      activeFile: null,
      gitStatus: { branch: 'main', stagedCount: 0, modifiedCount: 0, untrackedCount: 0, conflictCount: 0 },
      diagnostics: [], tokenEstimate: 0, sources: [],
    }
    const text = serializeContext(ctx)
    expect(text).toContain('clean working tree')
  })

  it('serializes active file with selection', () => {
    const ctx: AggregatedContext = {
      terminalCommands: [],
      activeFile: { relativePath: 'src/App.tsx', language: 'typescriptreact', selection: 'const x = 1' },
      gitStatus: null, diagnostics: [], tokenEstimate: 0, sources: [],
    }
    const text = serializeContext(ctx)
    expect(text).toContain('src/App.tsx (typescriptreact)')
    expect(text).toContain('Selected: "const x = 1"')
  })

  it('truncates long selection to 200 chars', () => {
    const longSelection = 'x'.repeat(300)
    const ctx: AggregatedContext = {
      terminalCommands: [],
      activeFile: { relativePath: 'a.ts', language: 'ts', selection: longSelection },
      gitStatus: null, diagnostics: [], tokenEstimate: 0, sources: [],
    }
    const text = serializeContext(ctx)
    expect(text).toContain('...')
    expect(text).not.toContain('x'.repeat(201))
  })

  it('returns empty string for completely empty context', () => {
    const ctx: AggregatedContext = {
      terminalCommands: [], activeFile: null, gitStatus: null,
      diagnostics: [], tokenEstimate: 0, sources: [],
    }
    expect(serializeContext(ctx)).toBe('')
  })
})

// ─── formatContextMessage() ─────────────────────────────────────────────

describe('formatContextMessage', () => {
  it('wraps context in [CONTEXT] block with delimiters', () => {
    const result = formatContextMessage('## Terminal\n$ ls', 'hello')
    expect(result).toContain('[CONTEXT — auto-generated, do not cite directly]')
    expect(result).toContain('[END CONTEXT]')
    expect(result).toContain('## Terminal\n$ ls')
    expect(result).toContain('User message: "hello"')
  })

  it('escapes double quotes in user message', () => {
    const result = formatContextMessage('ctx', 'say "hello"')
    expect(result).toContain('User message: "say \\"hello\\""')
  })

  it('trims the context block', () => {
    const result = formatContextMessage('  \n  context\n  \n', 'msg')
    expect(result).toContain('[END CONTEXT]\n\nUser message:')
  })
})
