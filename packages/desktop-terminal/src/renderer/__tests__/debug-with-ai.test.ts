// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, it, expect } from 'bun:test'
import type { Command } from '../osc633-tracker'
import type { BufferReader } from '../quick-fix/quick-fix-manager'
import {
  buildDebugContext,
  debugWithAi,
  serialiseDebugContext,
  type DebugContext,
} from '../debug-with-ai'

function makeCommand(over: Partial<Command> = {}): Command {
  return {
    id: 1,
    commandLine: 'npm test',
    cwd: '/tmp/proj',
    exitCode: 1,
    promptMarker: { line: 5 },
    startMarker: { line: 10 },
    endMarker: { line: 20 },
    startedAt: 1_000,
    finishedAt: 4_500,
    state: 'finished',
    ...over,
  } as Command
}

function makeBuffer(rows: Record<number, string>, defaultLine = ''): BufferReader {
  return {
    readRows(start, end) {
      const out: string[] = []
      for (let i = start; i < end; i++) out.push(rows[i] ?? defaultLine)
      return out
    },
  }
}

// ─── buildDebugContext ────────────────────────────────────────────

describe('buildDebugContext', () => {
  it('collects commandLine + cwd + exitCode + duration', () => {
    const ctx = buildDebugContext({ command: makeCommand(), buffer: makeBuffer({}) })
    expect(ctx.commandLine).toBe('npm test')
    expect(ctx.cwd).toBe('/tmp/proj')
    expect(ctx.exitCode).toBe(1)
    expect(ctx.durationMs).toBe(3_500)
    expect(ctx.commandId).toBe(1)
  })

  it('reads the row range from the buffer and truncates to tailRows', () => {
    const rows: Record<number, string> = {}
    for (let i = 10; i < 20; i++) rows[i] = `line${i}`
    const ctx = buildDebugContext({ command: makeCommand(), buffer: makeBuffer(rows), tailRows: 3 })
    expect(ctx.output.split('\n')).toEqual(['line17', 'line18', 'line19'])
    expect(ctx.outputRows).toBe(10)
  })

  it('returns empty output when start/end markers are missing', () => {
    const ctx = buildDebugContext({
      command: makeCommand({ startMarker: null, endMarker: null }),
      buffer: makeBuffer({ 10: 'x' }),
    })
    expect(ctx.output).toBe('')
    expect(ctx.outputRows).toBe(0)
  })

  it('returns empty output when the marker range is degenerate', () => {
    const ctx = buildDebugContext({
      command: makeCommand({ startMarker: { line: 10 }, endMarker: { line: 10 } }),
      buffer: makeBuffer({}),
    })
    expect(ctx.output).toBe('')
  })

  it('preserves null exit code (interrupted command)', () => {
    const ctx = buildDebugContext({
      command: makeCommand({ exitCode: null }),
      buffer: makeBuffer({}),
    })
    expect(ctx.exitCode).toBeNull()
  })

  it('returns null duration when timestamps are missing', () => {
    const ctx = buildDebugContext({
      command: makeCommand({ startedAt: null, finishedAt: null }),
      buffer: makeBuffer({}),
    })
    expect(ctx.durationMs).toBeNull()
  })

  it('trims leading/trailing whitespace from commandLine', () => {
    const ctx = buildDebugContext({
      command: makeCommand({ commandLine: '   npm test   ' }),
      buffer: makeBuffer({}),
    })
    expect(ctx.commandLine).toBe('npm test')
  })

  it('passes shell through verbatim when supplied', () => {
    const ctx = buildDebugContext({ command: makeCommand(), buffer: makeBuffer({}), shell: '/bin/zsh' })
    expect(ctx.shell).toBe('/bin/zsh')
  })
})

// ─── env redaction ─────────────────────────────────────────────────

describe('buildDebugContext — env redaction', () => {
  it('redacts default secret keys', () => {
    const ctx = buildDebugContext({
      command: makeCommand(),
      buffer: makeBuffer({}),
      env: {
        HOME: '/home/u',
        OPENAI_API_KEY: 'sk-secret',
        GITHUB_TOKEN: 'ghp-secret',
        AWS_SECRET_ACCESS_KEY: 'aws-secret',
        PATH: '/usr/bin',
      },
    })
    expect(ctx.env).toBeTruthy()
    expect(ctx.env!.hadSecretsRedacted).toBe(true)
    expect(ctx.env!.vars.OPENAI_API_KEY).toBe('<redacted>')
    expect(ctx.env!.vars.GITHUB_TOKEN).toBe('<redacted>')
    expect(ctx.env!.vars.AWS_SECRET_ACCESS_KEY).toBe('<redacted>')
    expect(ctx.env!.vars.HOME).toBe('/home/u')
    expect(ctx.env!.vars.PATH).toBe('/usr/bin')
  })

  it('reports hadSecretsRedacted=false when nothing was redacted', () => {
    const ctx = buildDebugContext({
      command: makeCommand(),
      buffer: makeBuffer({}),
      env: { HOME: '/h', PATH: '/usr/bin' },
    })
    expect(ctx.env!.hadSecretsRedacted).toBe(false)
  })

  it('honours a custom redaction regex', () => {
    const ctx = buildDebugContext({
      command: makeCommand(),
      buffer: makeBuffer({}),
      env: { MY_CUSTOM_KEY: 'x', SAFE_VAR: 'y' },
      envRedactPattern: /^MY_/,
    })
    expect(ctx.env!.vars.MY_CUSTOM_KEY).toBe('<redacted>')
    expect(ctx.env!.vars.SAFE_VAR).toBe('y')
  })

  it('returns no env section when env was not supplied', () => {
    const ctx = buildDebugContext({ command: makeCommand(), buffer: makeBuffer({}) })
    expect(ctx.env).toBeUndefined()
  })
})

// ─── serialiseDebugContext ────────────────────────────────────────

describe('serialiseDebugContext', () => {
  function baseCtx(over: Partial<DebugContext> = {}): DebugContext {
    return {
      commandId: 1,
      commandLine: 'npm test',
      cwd: '/tmp/proj',
      exitCode: 1,
      output: 'FAIL\nAssertionError',
      outputRows: 10,
      shell: '/bin/zsh',
      durationMs: 1_500,
      ...over,
    }
  }

  it('emits a title + metadata + fenced output block', () => {
    const md = serialiseDebugContext(baseCtx())
    expect(md).toContain('## Help me debug this failing command')
    expect(md).toContain('**Command:** `npm test`')
    expect(md).toContain('**Working dir:** `/tmp/proj`')
    expect(md).toContain('**Shell:** `/bin/zsh`')
    expect(md).toContain('**Exit code:** 1')
    expect(md).toContain('**Duration:** 1.5s')
    expect(md).toContain('### Output (last 10 rows)')
    expect(md).toContain('```\nFAIL\nAssertionError\n```')
  })

  it('formats duration in ms / s / m+s buckets', () => {
    expect(serialiseDebugContext(baseCtx({ durationMs: 500 }))).toContain('500ms')
    expect(serialiseDebugContext(baseCtx({ durationMs: 45_000 }))).toContain('45.0s')
    expect(serialiseDebugContext(baseCtx({ durationMs: 125_000 }))).toContain('2m 5s')
  })

  it('omits duration line when null', () => {
    const md = serialiseDebugContext(baseCtx({ durationMs: null }))
    expect(md).not.toContain('**Duration:**')
  })

  it('shows "interrupted" for null exitCode', () => {
    expect(serialiseDebugContext(baseCtx({ exitCode: null }))).toContain('**Exit code:** interrupted')
  })

  it('shows "(no output captured)" when output is empty', () => {
    expect(serialiseDebugContext(baseCtx({ output: '', outputRows: 0 }))).toContain('(no output captured)')
  })

  it('emits Environment section when env is present + flags redaction', () => {
    const md = serialiseDebugContext(baseCtx({
      env: { vars: { HOME: '/h', SECRET: '<redacted>' }, hadSecretsRedacted: true },
    }))
    expect(md).toContain('### Environment (secrets redacted)')
    expect(md).toContain('HOME=/h')
    expect(md).toContain('SECRET=<redacted>')
  })

  it('omits Environment section when env is undefined', () => {
    const md = serialiseDebugContext(baseCtx({ env: undefined }))
    expect(md).not.toContain('### Environment')
  })

  it('replaces empty commandLine with "(unknown)"', () => {
    const md = serialiseDebugContext(baseCtx({ commandLine: '' }))
    expect(md).toContain('**Command:** `(unknown)`')
  })
})

// ─── debugWithAi convenience ──────────────────────────────────────

describe('debugWithAi', () => {
  it('builds + serialises + forwards to the handler', () => {
    const calls: { ctx: DebugContext; md: string }[] = []
    const rows: Record<number, string> = { 10: 'a', 11: 'b' }
    const result = debugWithAi({
      command: makeCommand({ endMarker: { line: 12 } }),
      buffer: makeBuffer(rows),
      handler: (ctx, md) => calls.push({ ctx, md }),
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.ctx.output).toBe('a\nb')
    expect(calls[0]!.md).toContain('## Help me debug')
    expect(result).toBe(calls[0]!.ctx)
  })
})
