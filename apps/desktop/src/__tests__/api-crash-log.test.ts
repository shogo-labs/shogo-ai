// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-60: supervisor events and the API child's stderr used to go to
 * `console.log` only, so nothing about a crash survived the app. This covers
 * `api-crash-log.ts` — append, 1 MB rotation, the bounded stderr tail and the
 * `gave_up` entry — against a real temp file, no Electron.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  API_CRASH_LOG_MAX_BYTES,
  API_STDERR_TAIL_LINES,
  ApiCrashLog,
} from '../api-crash-log'

const dirs: string[] = []

function tempLog(): { dir: string; filePath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'shogo-api-crash-log-'))
  dirs.push(dir)
  return { dir, filePath: join(dir, 'logs', 'api-supervisor.log') }
}

function lines(filePath: string): Array<Record<string, unknown>> {
  return readFileSync(filePath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true })
})

describe('ApiCrashLog', () => {
  it('appends one JSON line per event, creating the directory', () => {
    const { filePath } = tempLog()
    const log = new ApiCrashLog({ filePath, now: () => new Date('2026-10-19T12:00:00.000Z') })

    log.append('spawn', { pid: 4242 })
    log.append('exit', { code: null, signal: 'SIGKILL' })

    const entries = lines(filePath)
    expect(entries).toHaveLength(2)
    expect(entries[0]).toEqual({ ts: '2026-10-19T12:00:00.000Z', event: 'spawn', pid: 4242 })
    expect(entries[1]!.event).toBe('exit')
    expect(entries[1]!.signal).toBe('SIGKILL')
  })

  it('rotates to .1 once the next line would cross the cap', () => {
    const { filePath } = tempLog()
    const writer = new ApiCrashLog({ filePath })

    writer.append('spawn', { pid: 1 })
    const firstSize = readFileSync(filePath).byteLength

    // A cap just above one line: the next append has to move the first aside.
    const log = new ApiCrashLog({ filePath, maxBytes: firstSize + 5 })
    log.append('exit', { code: 1 })

    expect(existsSync(`${filePath}.1`)).toBe(true)
    expect(lines(`${filePath}.1`)).toHaveLength(1)
    expect(lines(filePath)).toHaveLength(1)
    expect(lines(filePath)[0]!.event).toBe('exit')
  })

  it('defaults the cap to 1 MB', () => {
    expect(API_CRASH_LOG_MAX_BYTES).toBe(1_000_000)
  })

  it('keeps only the last 100 stderr lines', () => {
    const { filePath } = tempLog()
    const log = new ApiCrashLog({ filePath })

    for (let i = 1; i <= 150; i++) log.appendStderr(`line ${i}\n`)

    const tail = log.stderrTail()
    expect(tail).toHaveLength(API_STDERR_TAIL_LINES)
    expect(tail[0]).toBe('line 51')
    expect(tail[tail.length - 1]).toBe('line 150')
  })

  it('splits a chunk that arrives mid-line and drops blank lines', () => {
    const { filePath } = tempLog()
    const log = new ApiCrashLog({ filePath })

    log.appendStderr('error: sqlite is locked\n\n  at db.ts:12')
    log.appendStderr('\nwarning: retrying')

    expect(log.stderrTail()).toEqual([
      'error: sqlite is locked',
      '  at db.ts:12',
      'warning: retrying',
    ])
  })

  it('records gave_up with the stderr tail attached', () => {
    const { filePath } = tempLog()
    const log = new ApiCrashLog({ filePath })

    log.appendStderr('FATAL: cannot open database\n')
    log.append('gave_up', { error: '5 restart attempts failed', stderr: log.stderrTail() })

    const [entry] = lines(filePath)
    expect(entry!.event).toBe('gave_up')
    expect(entry!.error).toBe('5 restart attempts failed')
    expect(entry!.stderr).toEqual(['FATAL: cannot open database'])
  })

  it('never throws when the log file cannot be written', () => {
    const { dir } = tempLog()
    // A directory where the file should be: every append fails, nothing throws.
    const filePath = join(dir, 'logs')
    writeFileSync(join(dir, 'placeholder'), '')
    const log = new ApiCrashLog({ filePath })
    expect(() => log.append('spawn', { pid: 1 })).not.toThrow()
  })
})
