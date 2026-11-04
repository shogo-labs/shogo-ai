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

/** What a `last-quit.json` activity block may contain, old shape or new. */
type StoredActivity = {
  agentRuns?: unknown
  backgroundCommands?: unknown
  /** The pre-SHO-317 name for `agentRuns`. */
  liveTurns?: unknown
}

/** The activity block, normalised from either the current or the old record shape. */
function normalizeActivity(raw: StoredActivity | null | undefined): LiveActivity {
  const source = raw ?? {}
  // An old record (SHO-181) stored `liveTurns` + `runningTasks` +
  // `runningAgentReplies` and summed them; `liveTurns` is the only one that was
  // ever an agent run, so it becomes `agentRuns` and the rest are dropped.
  const runs = source.agentRuns ?? source.liveTurns
  return {
    agentRuns: Math.max(0, Number(runs) | 0),
    backgroundCommands: Math.max(0, Number(source.backgroundCommands) | 0),
  }
}

export function buildLastQuitRecord(input: BuildRecordInput): LastQuitRecord {
  return {
    reason: input.reason,
    fromVersion: input.version ?? null,
    at: (input.now ?? new Date()).toISOString(),
    activity: normalizeActivity(input.activity),
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
    const reason = parsed.reason === 'update' || parsed.reason === 'restart' || parsed.reason === 'quit' ? parsed.reason : 'quit'
    return {
      reason,
      fromVersion: typeof parsed.fromVersion === 'string' ? parsed.fromVersion : null,
      at: parsed.at,
      activity: normalizeActivity(parsed.activity),
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
  const runs = record.activity.agentRuns
  const commands = record.activity.backgroundCommands
  if (runs <= 0 && commands <= 0) return null
  const runsPhrase = runs === 1 ? '1 agent run' : `${runs} agent runs`
  const commandsPhrase = commands === 1 ? '1 background command' : `${commands} background commands`
  const verb = record.reason === 'quit' ? 'Quitting interrupted' : 'Restarting for the update interrupted'
  const resume = record.reason === 'quit' ? ' on the next launch' : ''
  // Background commands are mentioned next to the runs, never instead of them:
  // they die with the process but they are not agent runs, and they do not come
  // back the way a run does — they report back as interrupted (SHO-317).
  if (runs > 0 && commands > 0) {
    return `${verb} ${runsPhrase}, and ${commandsPhrase}. The runs pick up again automatically${resume}; the commands report back as interrupted.`
  }
  if (runs > 0) return `${verb} ${runsPhrase}; they pick up again automatically${resume}.`
  return `${verb} ${commandsPhrase}; ${commands === 1 ? 'it reports' : 'they report'} back as interrupted.`
}
