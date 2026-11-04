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
        activity: { agentRuns: 1, backgroundCommands: 1 },
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
          activity: { agentRuns: 1, backgroundCommands: 2 },
        }),
      )

      expect(takeInterruptedNotice(file.path)).toBe(
        'Restarting for the update interrupted 1 agent run, and 2 background commands. ' +
          'The runs pick up again automatically; the commands report back as interrupted.',
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
        buildLastQuitRecord({ reason: 'quit', activity: { agentRuns: 0, backgroundCommands: 0 } }),
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
        activity: { agentRuns: 1, backgroundCommands: 0 },
      }),
    ).toBe('Quitting interrupted 1 agent run; they pick up again automatically on the next launch.')
  })

  it('reports a background command on its own without inventing agent runs', () => {
    expect(
      buildInterruptedNotice({
        reason: 'update',
        fromVersion: '2.3.10',
        at: '2026-10-24T06:33:00.000Z',
        activity: { agentRuns: 0, backgroundCommands: 1 },
      }),
    ).toBe('Restarting for the update interrupted 1 background command; it reports back as interrupted.')
  })

  it('reads a record written before agentRuns existed', () => {
    // SHO-181 stored three counts and summed them. Only `liveTurns` was an agent
    // run; the other two must not come back as extra runs on the next boot.
    const file = tempFile()
    try {
      writeFileSync(
        file.path,
        JSON.stringify({
          reason: 'update',
          fromVersion: '2.3.9',
          at: '2026-10-24T06:33:00.000Z',
          activity: { liveTurns: 4, runningTasks: 7, runningAgentReplies: 2 },
        }),
        'utf8',
      )

      expect(readLastQuit(file.path)?.activity).toEqual({ agentRuns: 4, backgroundCommands: 0 })
      expect(takeInterruptedNotice(file.path)).toBe(
        'Restarting for the update interrupted 4 agent runs; they pick up again automatically.',
      )
    } finally {
      file.cleanup()
    }
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
