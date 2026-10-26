// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * What the last deliberate stop interrupted (SHO-181).
 *
 * "Restart now" is a legitimate choice, but it should not be a silent one: the
 * runs it kills are resumed by the runtime boot sweep, and the person who
 * clicked it is owed one line saying so. The record is written just before the
 * app goes away and read once on the next boot — the file is deleted as it is
 * read, so the notice appears exactly once.
 *
 * Electron-free: the caller passes the userData path.
 */

import { existsSync, readFileSync, rmSync, writeFileSync } from 'fs'
import type { LiveActivity } from './live-activity'
import type { StopReason } from './api-stop'

export const LAST_QUIT_FILE = 'last-quit.json'

export interface LastQuitRecord {
  reason: StopReason
  /** The version that was running when the stop was chosen. */
  fromVersion: string | null
  /** ISO timestamp of the choice. */
  at: string
  /** What was live at that moment. */
  activity: LiveActivity
}

export interface BuildRecordInput {
  reason: StopReason
  version?: string | null
  activity: LiveActivity | null
  now?: Date
}

export function buildLastQuitRecord(input: BuildRecordInput): LastQuitRecord {
  const activity = input.activity ?? { liveTurns: 0, runningTasks: 0, runningAgentReplies: 0 }
  return {
    reason: input.reason,
    fromVersion: input.version ?? null,
    at: (input.now ?? new Date()).toISOString(),
    activity: {
      liveTurns: Math.max(0, activity.liveTurns | 0),
      runningTasks: Math.max(0, activity.runningTasks | 0),
      runningAgentReplies: Math.max(0, activity.runningAgentReplies | 0),
    },
  }
}

/** Write the record. Best effort: a failed write must never block the quit. */
export function writeLastQuit(filePath: string, record: LastQuitRecord): boolean {
  try {
    writeFileSync(filePath, JSON.stringify(record, null, 2), 'utf8')
    return true
  } catch (err) {
    console.warn('[Desktop] Could not write last-quit.json:', err)
    return false
  }
}

export function readLastQuit(filePath: string): LastQuitRecord | null {
  try {
    if (!existsSync(filePath)) return null
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as Partial<LastQuitRecord> | null
    if (!parsed || typeof parsed !== 'object' || typeof parsed.at !== 'string') return null
    const activity = parsed.activity ?? {}
    const reason = parsed.reason === 'update' || parsed.reason === 'restart' || parsed.reason === 'quit' ? parsed.reason : 'quit'
    return {
      reason,
      fromVersion: typeof parsed.fromVersion === 'string' ? parsed.fromVersion : null,
      at: parsed.at,
      activity: {
        liveTurns: Math.max(0, Number((activity as LiveActivity).liveTurns) | 0),
        runningTasks: Math.max(0, Number((activity as LiveActivity).runningTasks) | 0),
        runningAgentReplies: Math.max(0, Number((activity as LiveActivity).runningAgentReplies) | 0),
      },
    }
  } catch {
    return null
  }
}

/**
 * The one-line notice for the next boot, or null when nothing was interrupted
 * (or the record is unreadable). The file is removed either way: a record is
 * news exactly once.
 */
export function takeInterruptedNotice(filePath: string): string | null {
  const record = readLastQuit(filePath)
  try {
    if (existsSync(filePath)) rmSync(filePath, { force: true })
  } catch {
    // Leaving the file behind only means the notice repeats; never fail a boot.
  }
  return record ? buildInterruptedNotice(record) : null
}

export function buildInterruptedNotice(record: LastQuitRecord): string | null {
  const total =
    record.activity.liveTurns + record.activity.runningTasks + record.activity.runningAgentReplies
  if (total <= 0) return null
  const runs = total === 1 ? '1 agent run' : `${total} agent runs`
  if (record.reason === 'quit') {
    return `Quitting interrupted ${runs}; they pick up again automatically on the next launch.`
  }
  return `Restarting for the update interrupted ${runs}; they pick up again automatically.`
}
