// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-181 AC7 — saying what a deliberate stop interrupted.
 *
 * "Restart now" is allowed, but it must not be silent: the next boot reads one
 * line saying how many runs it killed and that they resume on their own. The
 * record is deleted as it is read, so the notice appears exactly once.
 */
import { describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  buildInterruptedNotice,
  buildLastQuitRecord,
  readLastQuit,
  takeInterruptedNotice,
  writeLastQuit,
} from '../last-quit'

function tempFile(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'sho181-last-quit-'))
  return { path: join(dir, 'last-quit.json'), cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

describe('last-quit.json', () => {
  it('round-trips what was live when the user chose to restart anyway', () => {
    const file = tempFile()
    try {
      const record = buildLastQuitRecord({
        reason: 'update',
        version: '2.3.10',
        activity: { liveTurns: 1, runningTasks: 1, runningAgentReplies: 1 },
      })
      expect(writeLastQuit(file.path, record)).toBe(true)
      expect(readLastQuit(file.path)).toEqual(record)
    } finally {
      file.cleanup()
    }
  })

  it('shows the interrupted-runs notice once, then never again', () => {
    const file = tempFile()
    try {
      writeLastQuit(
        file.path,
        buildLastQuitRecord({
          reason: 'update',
          version: '2.3.10',
          activity: { liveTurns: 1, runningTasks: 1, runningAgentReplies: 0 },
        }),
      )

      expect(takeInterruptedNotice(file.path)).toBe(
        'Restarting for the update interrupted 2 agent runs; they pick up again automatically.',
      )
      expect(takeInterruptedNotice(file.path)).toBeNull()
      // Read means gone: the file is what makes it once-only.
      expect(() => readFileSync(file.path, 'utf8')).toThrow()
    } finally {
      file.cleanup()
    }
  })

  it('stays quiet when the restart interrupted nothing', () => {
    const file = tempFile()
    try {
      writeLastQuit(
        file.path,
        buildLastQuitRecord({ reason: 'quit', activity: { liveTurns: 0, runningTasks: 0, runningAgentReplies: 0 } }),
      )
      expect(takeInterruptedNotice(file.path)).toBeNull()
    } finally {
      file.cleanup()
    }
  })

  it('says quit when the stop was a quit, and counts a single run in the singular', () => {
    expect(
      buildInterruptedNotice({
        reason: 'quit',
        fromVersion: '2.3.10',
        at: '2026-10-24T06:33:00.000Z',
        activity: { liveTurns: 1, runningTasks: 0, runningAgentReplies: 0 },
      }),
    ).toBe('Quitting interrupted 1 agent run; they pick up again automatically on the next launch.')
  })

  it('ignores a corrupt record instead of failing the boot', () => {
    const file = tempFile()
    try {
      writeFileSync(file.path, '{ not json', 'utf8')
      expect(takeInterruptedNotice(file.path)).toBeNull()
      expect(readLastQuit(file.path)).toBeNull()
    } finally {
      file.cleanup()
    }
  })

  it('a missing file is simply no news', () => {
    const file = tempFile()
    try {
      expect(takeInterruptedNotice(file.path)).toBeNull()
    } finally {
      file.cleanup()
    }
  })
})
