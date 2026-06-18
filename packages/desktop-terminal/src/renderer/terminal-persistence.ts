// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * TerminalPersistence — saves terminal scrollback to disk files.
 *
 * Each terminal gets a file at `.shogo/terminals/{terminal-id}.txt` containing
 * recent commands + output. The agent reads these files to answer questions
 * like "what did I just do?" after a terminal session.
 *
 * Lifecycle:
 *   1. Caller creates a TerminalPersistence with a terminal ID
 *   2. On command completion: persistSnapshot() is called
 *   3. On terminal close: dispose() persists a final snapshot
 *   4. Cleanup: autoCleanup() keeps only the last N files
 *
 * Usage:
 *   const persistence = new TerminalPersistence({ terminalId: '1', dir: '/path/.shogo/terminals' })
 *   // When a command finishes:
 *   persistence.persistSnapshot(commands)
 *   // When terminal closes:
 *   persistence.dispose()
 */

import type { Command } from './osc633-tracker'
import { stripAnsi } from './strip-ansi'

// ─── types ──────────────────────────────────────────────────────────────

export interface TerminalPersistenceOptions {
  /** Unique terminal identifier. Used as filename. */
  terminalId: string
  /** Base directory for persistence files. Default: '.shogo/terminals' */
  dir?: string
  /** Max files to keep. Default: 20 */
  maxFiles?: number
  /**
   * @deprecated No-op. Persistence is now flushed explicitly on command
   * finish and terminal close (see ShogoTerminalSurface); there is no
   * background timer. Retained only for call-site/test compatibility.
   */
  flushIntervalMs?: number
  /** Max commands to keep per snapshot. Default: 50 */
  maxCommands?: number
  /** File system implementation. Default: Node fs. Override for tests. */
  fs?: TerminalFs
}

export interface TerminalFs {
  writeFile(path: string, data: string): Promise<void>
  readdir(dir: string): Promise<string[]>
  unlink(path: string): Promise<void>
  mkdir(path: string, opts?: { recursive?: boolean }): Promise<void>
  stat(path: string): Promise<{ mtimeMs: number }>
}

export interface PersistenceSnapshot {
  /** Terminal ID. */
  terminalId: string
  /** When the snapshot was taken. */
  savedAt: string
  /** Current working directory at save time. */
  cwd: string | null
  /** The commands captured. */
  commands: SerializedCommand[]
}

export interface SerializedCommand {
  id: number
  commandLine: string
  exitCode: number | null
  cwd: string | null
  startedAt: number | null
  finishedAt: number | null
}

// ─── helpers ────────────────────────────────────────────────────────────

/** Serialize commands to a human-readable text format. */
function serializeCommands(
  commands: readonly Command[],
  cwd: string | null,
  terminalId: string,
  savedAt: string,
  maxCommands: number,
): string {
  const recent = commands.slice(-maxCommands)

  const lines: string[] = [
    `# Terminal ${terminalId}`,
    `# Saved: ${savedAt}`,
    cwd ? `# CWD: ${cwd}` : '# CWD: unknown',
    `# Commands: ${recent.length}`,
    '',
  ]

  for (const cmd of recent) {
    const cmdText = stripAnsi(cmd.commandLine).trim()
    if (!cmdText) continue

    const started = cmd.startedAt ? new Date(cmd.startedAt).toISOString() : '?'
    const finished = cmd.finishedAt ? new Date(cmd.finishedAt).toISOString() : 'running'
    const duration = cmd.startedAt && cmd.finishedAt
      ? `${cmd.finishedAt - cmd.startedAt}ms`
      : '?'
    const exit = cmd.exitCode !== null ? `${cmd.exitCode}` : 'running'

    lines.push(`$ ${cmdText}`)
    lines.push(`  cwd: ${cmd.cwd ?? cwd ?? '?'}`)
    lines.push(`  exit: ${exit} (${duration})`)
    lines.push(`  time: ${started} → ${finished}`)
    lines.push('')
  }

  return lines.join('\n')
}

// ─── class ──────────────────────────────────────────────────────────────

export class TerminalPersistence {
  private terminalId: string
  private dir: string
  private maxFiles: number
  private maxCommands: number
  private fs: TerminalFs
  private disposed = false

  constructor(opts: TerminalPersistenceOptions) {
    this.terminalId = opts.terminalId
    this.dir = opts.dir ?? '.shogo/terminals'
    this.maxFiles = opts.maxFiles ?? 20
    this.maxCommands = opts.maxCommands ?? 50
    this.fs = opts.fs ?? createNodeFs()
  }

  /**
   * Get the file path for this terminal's persistence file.
   */
  getFilePath(): string {
    return `${this.dir}/${this.terminalId}.txt`
  }

  /**
   * Persist a snapshot of terminal commands to disk.
   * Called on command completion or terminal close.
   */
  async persistSnapshot(
    commands: readonly Command[],
    cwd: string | null,
  ): Promise<void> {
    if (this.disposed) return

    const content = serializeCommands(
      commands, cwd, this.terminalId,
      new Date().toISOString(),
      this.maxCommands,
    )

    try {
      await this.fs.mkdir(this.dir, { recursive: true })
      await this.fs.writeFile(this.getFilePath(), content)
    } catch (err) {
      console.warn(`[TerminalPersistence] Failed to write ${this.getFilePath()}:`, err)
    }
  }

  /**
   * Auto-cleanup: keep only the last N terminal files by mtime.
   */
  async autoCleanup(): Promise<number> {
    if (this.disposed) return 0

    try {
      await this.fs.mkdir(this.dir, { recursive: true })
      const files = await this.fs.readdir(this.dir)
      const txtFiles = files.filter((f) => f.endsWith('.txt'))

      if (txtFiles.length <= this.maxFiles) return 0

      // Sort by mtime (oldest first)
      const withStats = await Promise.all(
        txtFiles.map(async (f) => {
          try {
            const stat = await this.fs.stat(`${this.dir}/${f}`)
            return { file: f, mtimeMs: stat.mtimeMs }
          } catch {
            return { file: f, mtimeMs: 0 }
          }
        }),
      )
      withStats.sort((a, b) => a.mtimeMs - b.mtimeMs)

      // Delete oldest files beyond the limit
      const toDelete = withStats.slice(0, txtFiles.length - this.maxFiles)
      for (const { file } of toDelete) {
        await this.fs.unlink(`${this.dir}/${file}`)
      }
      return toDelete.length
    } catch (err) {
      console.warn('[TerminalPersistence] Auto-cleanup failed:', err)
      return 0
    }
  }

  /**
   * Dispose: optionally persist a final snapshot, then mark disposed.
   */
  async dispose(finalCommands?: readonly Command[], finalCwd?: string | null): Promise<void> {
    if (this.disposed) return

    // Persist final snapshot if commands provided (BEFORE marking disposed)
    if (finalCommands && finalCommands.length > 0) {
      await this.persistSnapshot(finalCommands, finalCwd ?? null)
    }

    this.disposed = true

    // Auto-cleanup after persisting
    await this.autoCleanup()
  }
}

// ─── default fs implementation ──────────────────────────────────────────

function createNodeFs(): TerminalFs {
  // Use dynamic import to avoid bundling issues in browser/test contexts
  return {
    async writeFile(path, data) {
      const { writeFile } = await import(/* @vite-ignore */ 'node:fs/promises' as string)
      await writeFile(path, data, 'utf-8')
    },
    async readdir(dir) {
      const { readdir } = await import(/* @vite-ignore */ 'node:fs/promises' as string)
      return await readdir(dir)
    },
    async unlink(path) {
      const { unlink } = await import(/* @vite-ignore */ 'node:fs/promises' as string)
      await unlink(path)
    },
    async mkdir(path, opts) {
      const { mkdir } = await import(/* @vite-ignore */ 'node:fs/promises' as string)
      await mkdir(path, opts)
    },
    async stat(path) {
      const { stat } = await import(/* @vite-ignore */ 'node:fs/promises' as string)
      const s = await stat(path)
      return { mtimeMs: s.mtimeMs }
    },
  }
}

// ─── read-back helper (used by terminal_read tool) ──────────────────────

/**
 * Read a terminal persistence file and parse it into structured data.
 * Used by the terminal_read tool to answer "what did I just do?"
 */
export interface ReadTerminalFs extends TerminalFs {
  readFile(path: string): Promise<string>
}

export async function readTerminalFile(
  filePath: string,
  fs?: Partial<ReadTerminalFs>,
): Promise<PersistenceSnapshot | null> {
  try {
    let content: string
    if (fs?.readFile) {
      content = await fs.readFile(filePath)
    } else {
      const mod = await import(/* @vite-ignore */ 'node:fs/promises' as string)
      content = await mod.readFile(filePath, 'utf-8')
    }

    // Parse the text format back into a snapshot
    const lines = content.split('\n')
    const terminalId = lines[0]?.replace('# Terminal ', '').trim() ?? 'unknown'
    const savedAt = lines[1]?.replace('# Saved: ', '').trim() ?? ''
    const cwd = lines[2]?.replace('# CWD: ', '').trim() ?? null

    const commands: SerializedCommand[] = []
    let i = 4 // skip header lines + blank
    let cmdId = 1
    while (i < lines.length) {
      const line = lines[i]
      if (line?.startsWith('$ ')) {
        const cmdLine = line.slice(2)
        const cwdLine = lines[i + 1]?.replace('  cwd: ', '').trim() ?? null
        const exitLine = lines[i + 2]?.replace('  exit: ', '').trim() ?? ''
        const exitCode = exitLine.startsWith('running') ? null
          : parseInt(exitLine.split(' ')[0]!, 10) || 0
        const timeLine = lines[i + 3]?.replace('  time: ', '').trim() ?? ''

        commands.push({
          id: cmdId++,
          commandLine: cmdLine,
          exitCode,
          cwd: cwdLine === 'unknown' ? null : cwdLine,
          startedAt: null,
          finishedAt: null,
        })
        i += 4 // skip $, cwd, exit, time lines
      } else {
        i++
      }
    }

    return { terminalId, savedAt, cwd, commands }
  } catch {
    return null
  }
}
