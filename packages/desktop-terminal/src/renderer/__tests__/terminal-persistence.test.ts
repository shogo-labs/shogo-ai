// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Unit tests for TerminalPersistence.
 *
 * Tests cover:
 *   - persistSnapshot: writes correct format to disk
 *   - autoCleanup: keeps only N most recent files
 *   - dispose: persists final snapshot + cleanup
 *   - getFilePath: returns correct path
 *   - getFilePath: respects custom dir
 *   - persistSnapshot: no-op after dispose
 *   - dispose: no-op if already disposed
 *   - persistSnapshot: handles empty commands
 *   - persistSnapshot: handles ANSI stripping
 *   - serializeCommands: correct format with multiple commands
 *   - serializeCommands: handles running command (null exitCode)
 *   - readTerminalFile: parses saved file correctly
 *   - readTerminalFile: returns null for missing file
 *   - autoCleanup: respects maxFiles limit
 *   - autoCleanup: returns count of deleted files
 *   - autoCleanup: no-op after dispose
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import {
  TerminalPersistence,
  readTerminalFile,
} from '../terminal-persistence'
import type { Command } from '../osc633-tracker'
import type { TerminalFs } from '../terminal-persistence'

// ─── Mock FS ────────────────────────────────────────────────────────────

function createMockFs(): TerminalFs & {
  files: Map<string, string>
  dirs: Set<string>
  deleted: string[]
} {
  return {
    files: new Map(),
    dirs: new Set(['.shogo/terminals']),
    deleted: [],
    async writeFile(path, data) {
      this.files.set(path, data)
    },
    async readdir(dir) {
      const prefix = dir + '/'
      const files: string[] = []
      for (const key of this.files.keys()) {
        if (key.startsWith(prefix)) {
          files.push(key.slice(prefix.length))
        }
      }
      return files
    },
    async unlink(path) {
      this.files.delete(path)
      this.deleted.push(path)
    },
    async mkdir(path) {
      this.dirs.add(path)
    },
    async stat(path) {
      const data = this.files.get(path)
      return { mtimeMs: data ? Date.now() : 0 }
    },
  }
}

/** Create a mock Command for testing. */
function mockCommand(overrides: Partial<Command> = {}): Command {
  return {
    id: 1,
    commandLine: 'echo hello',
    exitCode: 0,
    cwd: '/Users/test/project',
    startedAt: Date.now() - 1000,
    finishedAt: Date.now(),
    state: 'finished',
    promptMarker: null,
    startMarker: null,
    endMarker: null,
    ...overrides,
  }
}

// ─── Tests ──────────────────────────────────────────────────────────────

describe('TerminalPersistence', () => {
  let fs: ReturnType<typeof createMockFs>

  beforeEach(() => {
    fs = createMockFs()
  })

  it('getFilePath returns correct default path', () => {
    const p = new TerminalPersistence({ terminalId: 'term-1', fs, flushIntervalMs: 0 })
    expect(p.getFilePath()).toBe('.shogo/terminals/term-1.txt')
  })

  it('getFilePath respects custom dir', () => {
    const p = new TerminalPersistence({ terminalId: 'abc', dir: '/custom/path', fs, flushIntervalMs: 0 })
    expect(p.getFilePath()).toBe('/custom/path/abc.txt')
  })

  it('persistSnapshot writes commands to disk', async () => {
    const p = new TerminalPersistence({ terminalId: 't1', fs, flushIntervalMs: 0 })
    const cmds = [
      mockCommand({ id: 1, commandLine: 'npm test', exitCode: 0, cwd: '/proj' }),
      mockCommand({ id: 2, commandLine: 'git status', exitCode: 0, cwd: '/proj' }),
    ]

    await p.persistSnapshot(cmds, '/proj')

    const content = fs.files.get('.shogo/terminals/t1.txt')
    expect(content).toBeDefined()
    expect(content).toContain('# Terminal t1')
    expect(content).toContain('npm test')
    expect(content).toContain('git status')
    expect(content).toContain('exit: 0')
    expect(content).toContain('CWD: /proj')
  })

  it('persistSnapshot handles empty commands', async () => {
    const p = new TerminalPersistence({ terminalId: 'empty', fs, flushIntervalMs: 0 })
    await p.persistSnapshot([], null)

    const content = fs.files.get('.shogo/terminals/empty.txt')
    expect(content).toBeDefined()
    expect(content).toContain('# Commands: 0')
  })

  it('persistSnapshot strips ANSI sequences', async () => {
    const p = new TerminalPersistence({ terminalId: 'ansi', fs, flushIntervalMs: 0 })
    const cmd = mockCommand({ commandLine: '\x1b[32mecho\x1b[0m hello', exitCode: 0 })
    await p.persistSnapshot([cmd], null)

    const content = fs.files.get('.shogo/terminals/ansi.txt')
    expect(content).toContain('$ echo hello')
    expect(content).not.toContain('\x1b[32m')
  })

  it('persistSnapshot shows "running" for commands with null exitCode', async () => {
    const p = new TerminalPersistence({ terminalId: 'run', fs, flushIntervalMs: 0 })
    const cmd = mockCommand({ commandLine: 'sleep 999', exitCode: null, finishedAt: null })
    await p.persistSnapshot([cmd], null)

    const content = fs.files.get('.shogo/terminals/run.txt')
    expect(content).toContain('exit: running')
  })

  it('persistSnapshot no-op after dispose', async () => {
    const p = new TerminalPersistence({ terminalId: 'disposed', fs, flushIntervalMs: 0 })
    await p.dispose()
    await p.persistSnapshot([mockCommand()], null)

    const content = fs.files.get('.shogo/terminals/disposed.txt')
    expect(content).toBeUndefined()
  })

  it('dispose persists final snapshot when commands provided', async () => {
    const p = new TerminalPersistence({ terminalId: 'final', fs, flushIntervalMs: 0 })
    await p.dispose([mockCommand({ commandLine: 'last cmd' })], '/tmp')

    const content = fs.files.get('.shogo/terminals/final.txt')
    expect(content).toBeDefined()
    expect(content).toContain('last cmd')
  })

  it('dispose is idempotent', async () => {
    const p = new TerminalPersistence({ terminalId: 'idem', fs, flushIntervalMs: 0 })
    await p.dispose([mockCommand()], null)
    await p.dispose([mockCommand({ commandLine: 'second' })], null)

    const content = fs.files.get('.shogo/terminals/idem.txt')
    expect(content).toBeDefined()
    expect(content).toContain('echo hello') // First dispose snapshot persisted
    expect(content).not.toContain('second') // Second dispose was no-op
  })

  it('dispose no-op if no commands provided', async () => {
    const p = new TerminalPersistence({ terminalId: 'nocmd', fs, flushIntervalMs: 0 })
    await p.dispose()

    const content = fs.files.get('.shogo/terminals/nocmd.txt')
    expect(content).toBeUndefined()
  })
})

describe('TerminalPersistence — autoCleanup', () => {
  let fs: ReturnType<typeof createMockFs>

  beforeEach(() => {
    fs = createMockFs()
  })

  it('returns 0 when under the limit', async () => {
    const p = new TerminalPersistence({ terminalId: 'test', maxFiles: 5, fs, flushIntervalMs: 0 })
    // Add 3 files
    for (let i = 0; i < 3; i++) {
      fs.files.set(`.shogo/terminals/t${i}.txt`, `# Terminal t${i}`)
    }

    const deleted = await p.autoCleanup()
    expect(deleted).toBe(0)
  })

  it('deletes oldest files when over the limit', async () => {
    const p = new TerminalPersistence({ terminalId: 'test', maxFiles: 3, fs, flushIntervalMs: 0 })
    // Add 5 files with increasing mtime
    for (let i = 0; i < 5; i++) {
      const path = `.shogo/terminals/t${i}.txt`
      fs.files.set(path, `# Terminal t${i}`)
      // Mock stat to return increasing mtime
      const origStat = fs.stat.bind(fs)
      fs.stat = async (p: string) => {
        if (p === path) return { mtimeMs: i * 1000 }
        return origStat(p)
      }
    }

    const deleted = await p.autoCleanup()
    expect(deleted).toBe(2) // 5 - 3 = 2 deleted
    expect(fs.deleted.length).toBe(2)
  })

  it('returns 0 after dispose', async () => {
    const p = new TerminalPersistence({ terminalId: 'test', maxFiles: 1, fs, flushIntervalMs: 0 })
    for (let i = 0; i < 5; i++) {
      fs.files.set(`.shogo/terminals/t${i}.txt`, `data`)
    }
    await p.dispose()
    const deleted = await p.autoCleanup()
    expect(deleted).toBe(0)
  })
})

describe('readTerminalFile', () => {
  it('parses a saved terminal file', async () => {
    const content = `# Terminal myterm
# Saved: 2026-06-04T12:00:00.000Z
# CWD: /Users/test/project
# Commands: 2

$ npm test
  cwd: /Users/test/project
  exit: 0 (1523ms)
  time: 2026-06-04T11:59:58.000Z → 2026-06-04T11:59:59.523Z

$ git status
  cwd: /Users/test/project
  exit: 0 (12ms)
  time: 2026-06-04T11:59:59.600Z → 2026-06-04T11:59:59.612Z
`
    const mockFs: TerminalFs = {
      async writeFile() {},
      async readdir() { return [] },
      async unlink() {},
      async mkdir() {},
      async stat() { return { mtimeMs: 0 } },
    }

    // Override to read from our string
    const readFs = {
      ...mockFs,
      async readFile(_p: string) { return content },
    }

    const result = await readTerminalFile('/fake/path.txt', readFs as any)
    expect(result).not.toBeNull()
    expect(result!.terminalId).toBe('myterm')
    expect(result!.savedAt).toBe('2026-06-04T12:00:00.000Z')
    expect(result!.cwd).toBe('/Users/test/project')
    expect(result!.commands.length).toBe(2)
    expect(result!.commands[0].commandLine).toBe('npm test')
    expect(result!.commands[0].exitCode).toBe(0)
    expect(result!.commands[1].commandLine).toBe('git status')
  })

  it('returns null for missing file', async () => {
    const result = await readTerminalFile('/nonexistent/file.txt')
    expect(result).toBeNull()
  })
})
