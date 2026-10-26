// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-61 Part B — a MEMORY.md write can no longer destroy months of lessons.
 *
 * Two guarantees, both exercised here against the REAL write_file / edit_file
 * tools so the wiring (not just the pure helpers) is covered:
 *   1. a whole-file write that keeps less than half of a memory file is
 *      refused with `memory_shrink_guard`, unless `overwrite: true`;
 *   2. every memory write leaves the previous bytes under
 *      `.shogo/memory-history/<path>/`, newest 20 kept.
 */

import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createTools, type ToolContext } from '../gateway-tools'
import {
  MEMORY_HISTORY_DIR,
  MEMORY_HISTORY_KEEP,
  isMemoryFilePath,
  memoryFilePath,
  memoryHistoryDirFor,
  memoryShrinkGuard,
  snapshotMemoryFile,
} from '../memory-history'
import { clearTrustForTests, trustWorkspaceForTests } from './helpers/test-trust'

// realpath() because macOS' /tmp is a symlink: the permission engine compares
// real paths, so a /tmp literal reads as "outside the allowed folders".
const TEST_DIR = join(realpathSync(tmpdir()), 'sho61-memory-history')

function makeCtx(overrides?: Partial<ToolContext>): ToolContext {
  return {
    workspaceDir: TEST_DIR,
    channels: new Map(),
    config: {
      heartbeatInterval: 1800,
      heartbeatEnabled: false,
      quietHours: { start: '23:00', end: '07:00', timezone: 'UTC' },
      channels: [],
      model: { provider: 'anthropic', name: 'claude-sonnet-4-5' },
    } as any,
    projectId: 'test',
    ...overrides,
  }
}

async function run(name: string, params: Record<string, any>) {
  const ctx = makeCtx()
  const tool = createTools(ctx).find((x) => x.name === name)
  if (!tool) throw new Error(`Tool not found: ${name}`)
  const result = await tool.execute('test-call', params)
  return result.details as any
}

function historyCopies(relativePath: string): string[] {
  const dir = join(TEST_DIR, memoryHistoryDirFor(relativePath))
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter((f) => f.endsWith('.md')).sort()
}

const LESSONS = [
  '# Memory',
  '',
  '## Lessons',
  '- Never force-push a card branch; open a fresh branch instead.',
  '- A red `cla` never holds a card (2026-10-19).',
  '- Playwright specs run in agent checkouts with a frozen install.',
  '',
  '## Decisions',
  '- Desktop and cloud schemas never diverge.',
].join('\n')

beforeEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true })
  mkdirSync(TEST_DIR, { recursive: true })
  trustWorkspaceForTests(TEST_DIR)
})

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true })
})

afterAll(() => clearTrustForTests())

// ─── classification ──────────────────────────────────────────────────────────

describe('memoryFilePath', () => {
  test('recognises the durable-state files an agent keeps', () => {
    for (const p of ['MEMORY.md', 'AGENTS.md', 'TOOLS.md', 'HEARTBEAT.md', 'STACK.md', 'memory/2026-10-19.md']) {
      expect(isMemoryFilePath(p)).toBe(true)
      expect(memoryFilePath(p)).toBe(p)
    }
    expect(memoryFilePath('./MEMORY.md')).toBe('MEMORY.md')
    expect(memoryFilePath('memory\\2026-10-19.md')).toBe('memory/2026-10-19.md')
  })

  test('leaves ordinary project files alone', () => {
    for (const p of [
      'README.md',
      'src/MEMORY.md',
      'memory/notes.txt',
      'memory/nested/deep.md',
      'dist/MEMORY.md',
      '.shogo/memory-history/MEMORY.md/x.md',
      '../MEMORY.md',
    ]) {
      expect(isMemoryFilePath(p)).toBe(false)
    }
  })
})

// ─── shrink guard ────────────────────────────────────────────────────────────

describe('memoryShrinkGuard', () => {
  beforeEach(() => {
    writeFileSync(join(TEST_DIR, 'MEMORY.md'), LESSONS)
  })

  test('refuses a 49% replacement and reports both sizes', () => {
    const fiftyOne = 'x'.repeat(Math.floor(LESSONS.length * 0.49))
    const rejection = memoryShrinkGuard(TEST_DIR, 'MEMORY.md', fiftyOne)
    expect(rejection).not.toBeNull()
    expect(rejection!.code).toBe('memory_shrink_guard')
    expect(rejection!.currentChars).toBe(LESSONS.length)
    expect(rejection!.newChars).toBe(fiftyOne.length)
    // The refusal has to tell the agent how to get out of it.
    expect(rejection!.error).toContain('overwrite: true')
    expect(rejection!.error).toContain('append: true')
    expect(rejection!.error).toContain('.shogo/memory-history')
  })

  test('allows a 51% replacement', () => {
    expect(memoryShrinkGuard(TEST_DIR, 'MEMORY.md', 'y'.repeat(Math.ceil(LESSONS.length * 0.51)))).toBeNull()
  })

  test('allows exactly the threshold (>= 50%)', () => {
    expect(memoryShrinkGuard(TEST_DIR, 'MEMORY.md', 'z'.repeat(LESSONS.length / 2))).toBeNull()
  })

  test('allows the wipe when the caller passes overwrite: true', () => {
    expect(memoryShrinkGuard(TEST_DIR, 'MEMORY.md', '- booted', { overwrite: true })).toBeNull()
  })

  test('never blocks an append, a create, or a non-memory file', () => {
    expect(memoryShrinkGuard(TEST_DIR, 'MEMORY.md', '- note\n', { append: true })).toBeNull()
    expect(memoryShrinkGuard(TEST_DIR, 'TOOLS.md', 'tiny')).toBeNull()
    writeFileSync(join(TEST_DIR, 'app.ts'), 'export const x = 1\n')
    expect(memoryShrinkGuard(TEST_DIR, 'app.ts', 'x')).toBeNull()
  })

  test('guards memory/*.md daily logs too', () => {
    mkdirSync(join(TEST_DIR, 'memory'), { recursive: true })
    writeFileSync(join(TEST_DIR, 'memory/2026-10-19.md'), LESSONS)
    expect(memoryShrinkGuard(TEST_DIR, 'memory/2026-10-19.md', 'gone')).not.toBeNull()
  })
})

// ─── history ─────────────────────────────────────────────────────────────────

describe('snapshotMemoryFile', () => {
  test('copies the pre-write bytes and returns the copy path', () => {
    writeFileSync(join(TEST_DIR, 'MEMORY.md'), LESSONS)
    const copy = snapshotMemoryFile(TEST_DIR, 'MEMORY.md')
    expect(copy).toBeTruthy()
    expect(copy!.startsWith(`${MEMORY_HISTORY_DIR}/`)).toBe(true)
    expect(readFileSync(join(TEST_DIR, copy!), 'utf-8')).toBe(LESSONS)
  })

  test('keeps a distinct copy per write', () => {
    writeFileSync(join(TEST_DIR, 'MEMORY.md'), 'first\n')
    snapshotMemoryFile(TEST_DIR, 'MEMORY.md')
    writeFileSync(join(TEST_DIR, 'MEMORY.md'), 'second\n')
    snapshotMemoryFile(TEST_DIR, 'MEMORY.md')

    const copies = historyCopies('MEMORY.md')
    expect(copies.length).toBe(2)
    const contents = copies.map((c) =>
      readFileSync(join(TEST_DIR, memoryHistoryDirFor('MEMORY.md'), c), 'utf-8'),
    )
    expect(contents.sort()).toEqual(['first\n', 'second\n'])
  })

  test(`keeps only the newest ${MEMORY_HISTORY_KEEP} copies`, () => {
    for (let i = 0; i < MEMORY_HISTORY_KEEP + 5; i++) {
      writeFileSync(join(TEST_DIR, 'MEMORY.md'), `version ${i}\n`)
      snapshotMemoryFile(TEST_DIR, 'MEMORY.md')
    }
    const copies = historyCopies('MEMORY.md')
    expect(copies.length).toBe(MEMORY_HISTORY_KEEP)
    // Newest kept: the last write is still recoverable.
    const last = readFileSync(
      join(TEST_DIR, memoryHistoryDirFor('MEMORY.md'), copies[copies.length - 1]!),
      'utf-8',
    )
    expect(last).toBe(`version ${MEMORY_HISTORY_KEEP + 4}\n`)
  })

  test('does not create a copy for a missing file or a non-memory path', () => {
    expect(snapshotMemoryFile(TEST_DIR, 'TOOLS.md')).toBeNull()
    writeFileSync(join(TEST_DIR, 'app.ts'), 'x')
    expect(snapshotMemoryFile(TEST_DIR, 'app.ts')).toBeNull()
  })
})

// ─── tool wiring ─────────────────────────────────────────────────────────────

describe('write_file on a memory file', () => {
  test('refuses the wipe that erased Dev 3 — and leaves the file untouched', async () => {
    writeFileSync(join(TEST_DIR, 'MEMORY.md'), LESSONS)

    const result = await run('write_file', { path: 'MEMORY.md', content: '- Agent booted at 05:42\n' })

    expect(result.ok).toBeUndefined()
    expect(result.code).toBe('memory_shrink_guard')
    expect(result.currentChars).toBe(LESSONS.length)
    expect(result.newChars).toBe('- Agent booted at 05:42\n'.length)
    // Nothing was written, and nothing was lost.
    expect(readFileSync(join(TEST_DIR, 'MEMORY.md'), 'utf-8')).toBe(LESSONS)
    // The refusal itself does not litter history copies.
    expect(historyCopies('MEMORY.md')).toEqual([])
  })

  test('writes when the replacement is deliberate (overwrite: true) and keeps the old bytes', async () => {
    writeFileSync(join(TEST_DIR, 'MEMORY.md'), LESSONS)

    const result = await run('write_file', {
      path: 'MEMORY.md',
      content: '- Agent booted at 05:42\n',
      overwrite: true,
    })

    expect(result.ok).toBe(true)
    expect(readFileSync(join(TEST_DIR, 'MEMORY.md'), 'utf-8')).toBe('- Agent booted at 05:42\n')
    expect(result.memoryHistory).toContain(MEMORY_HISTORY_DIR)
    expect(readFileSync(join(TEST_DIR, result.memoryHistory), 'utf-8')).toBe(LESSONS)
  })

  test('appends without a shrink check and still keeps the previous version', async () => {
    writeFileSync(join(TEST_DIR, 'MEMORY.md'), LESSONS)

    const result = await run('write_file', {
      path: 'MEMORY.md',
      content: '- another lesson\n',
      append: true,
    })

    expect(result.ok).toBe(true)
    expect(readFileSync(join(TEST_DIR, 'MEMORY.md'), 'utf-8')).toBe(`${LESSONS}- another lesson\n`)
    expect(readFileSync(join(TEST_DIR, result.memoryHistory), 'utf-8')).toBe(LESSONS)
  })

  test('leaves ordinary files completely alone', async () => {
    writeFileSync(join(TEST_DIR, 'app.ts'), 'export const long = "aaaaaaaaaaaaaaaaaaaaaaaa"\n')
    const result = await run('write_file', { path: 'app.ts', content: 'x\n' })
    expect(result.ok).toBe(true)
    expect(result.memoryHistory).toBeUndefined()
    expect(readFileSync(join(TEST_DIR, 'app.ts'), 'utf-8')).toBe('x\n')
  })
})

describe('edit_file on a memory file', () => {
  test('snapshots the pre-edit content even though edits are exempt from the guard', async () => {
    writeFileSync(join(TEST_DIR, 'MEMORY.md'), LESSONS)

    const result = await run('edit_file', {
      path: 'MEMORY.md',
      old_string: '## Lessons',
      new_string: '## Hard-won lessons',
    })

    expect(result.ok).toBe(true)
    expect(readFileSync(join(TEST_DIR, 'MEMORY.md'), 'utf-8')).toContain('## Hard-won lessons')
    expect(result.memoryHistory).toBeTruthy()
    expect(readFileSync(join(TEST_DIR, result.memoryHistory), 'utf-8')).toBe(LESSONS)
  })

  test('an edit that removes most of the file is still recoverable', async () => {
    writeFileSync(join(TEST_DIR, 'MEMORY.md'), LESSONS)

    const result = await run('edit_file', {
      path: 'MEMORY.md',
      old_string: LESSONS,
      new_string: '- nothing left\n',
    })

    expect(result.ok).toBe(true)
    expect(readFileSync(join(TEST_DIR, 'MEMORY.md'), 'utf-8')).toBe('- nothing left\n')
    expect(readFileSync(join(TEST_DIR, result.memoryHistory), 'utf-8')).toBe(LESSONS)
  })
})
