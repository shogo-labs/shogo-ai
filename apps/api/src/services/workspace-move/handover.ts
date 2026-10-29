// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Handover: nothing runs twice.
 *
 * A workspace's schedules and triggers are the only parts of it that *do*
 * something on their own. If both copies were live, every cron would fire twice
 * and every trigger would answer a message twice, so:
 *
 *   1. the records phase writes every `AgentSchedule` and `EventSubscription`
 *      to the target **disabled**, remembering what it was at the source;
 *   2. "Switch over" disables them at the source **first**, then enables the
 *      ones that were on at the target — at no point are both enabled;
 *   3. "Switch back" is the same in reverse, so a user who changes their mind
 *      gets their source back exactly as it was.
 *
 * The source workspace is never deleted (decision D1): it keeps its rows and
 * files, gains a "Moved to <target>" marker, and is otherwise untouched.
 */

import { deriveMoveId } from './ids'
import type { MoveHandoverState, MoveRow } from './types'

export type HandoverKind = 'schedule' | 'trigger'

/**
 * Read the handover state off a `WorkspaceMove` row.
 *
 * The SQLite Json column does not round-trip an **empty** array: `[]` comes
 * back as the string `"[]"`, while a non-empty array comes back as an array.
 * A workspace with no schedules (or no triggers) is the common case, and it
 * crashed the handover phase on `.map` — after every byte had already copied,
 * so the move failed at the last step with the target half-populated. Normalise
 * on read rather than trust the driver.
 */
export function readHandover(raw: unknown): MoveHandoverState {
  const value = (raw ?? {}) as Record<string, unknown>
  const state: MoveHandoverState = {
    schedules: handoverRows(value.schedules),
    triggers: handoverRows(value.triggers),
  }
  if (typeof value.switchedOverAt === 'string') state.switchedOverAt = value.switchedOverAt
  return state
}

function handoverRows(value: unknown): MoveHandoverState['schedules'] {
  if (Array.isArray(value)) return value as MoveHandoverState['schedules']
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value)
      if (Array.isArray(parsed)) return parsed as MoveHandoverState['schedules']
    } catch {
      // A value that is neither an array nor JSON is not a row set.
    }
  }
  return []
}

export function buildHandover(moveId: string, rows: Map<string, MoveRow[]>): MoveHandoverState {
  const schedules = (rows.get('AgentSchedule') ?? []).map((row) => ({
    sourceId: String(row.id),
    targetId: deriveMoveId(moveId, String(row.id)),
    name: String(row.name ?? 'Schedule'),
    enabled: row.enabled !== false,
  }))
  const triggers = (rows.get('EventSubscription') ?? []).map((row) => ({
    sourceId: String(row.id),
    targetId: deriveMoveId(moveId, String(row.id)),
    name: String(row.name ?? 'Trigger'),
    enabled: row.enabled !== false,
  }))
  return { schedules, triggers }
}

export interface HandoverSwitch {
  kind: HandoverKind
  ids: string[]
  enabled: boolean
}

export interface HandoverSides {
  source: {
    /** Enable or disable schedules/triggers *at the source*, by source id. */
    setEnabled(input: HandoverSwitch): Promise<void>
    /** Write (or clear, with null) the "Moved to <target>" marker. */
    markMoved(targetWorkspaceId: string | null): Promise<void>
  }
  target: {
    /** Enable or disable the same rows at the target, by derived id. */
    setEnabled(input: HandoverSwitch): Promise<void>
  }
}

/** Ids that were on at the source, i.e. the ones that should be live at the target. */
function liveIds(state: MoveHandoverState, kind: HandoverKind): string[] {
  const rows = kind === 'schedule' ? state.schedules : state.triggers
  return rows.filter((row) => row.enabled).map((row) => row.targetId)
}

function allSourceIds(state: MoveHandoverState, kind: HandoverKind): string[] {
  const rows = kind === 'schedule' ? state.schedules : state.triggers
  return rows.map((row) => row.sourceId)
}

/**
 * Hand the workspace over. Order is the contract: the source goes quiet before
 * the target wakes up, never the other way round.
 */
export async function switchOver(
  sides: HandoverSides,
  state: MoveHandoverState,
  targetWorkspaceId: string,
): Promise<void> {
  for (const kind of ['schedule', 'trigger'] as const) {
    const sourceIds = allSourceIds(state, kind)
    if (sourceIds.length) await sides.source.setEnabled({ kind, ids: sourceIds, enabled: false })
    const targetIds = liveIds(state, kind)
    if (targetIds.length) await sides.target.setEnabled({ kind, ids: targetIds, enabled: true })
  }
  await sides.source.markMoved(targetWorkspaceId)
}

/** Put the source back the way it was and quiet the target. */
export async function switchBack(sides: HandoverSides, state: MoveHandoverState): Promise<void> {
  for (const kind of ['schedule', 'trigger'] as const) {
    const targetIds = allSourceIds(state, kind).map((sourceId) => sourceIdToTarget(state, kind, sourceId))
    if (targetIds.length) await sides.target.setEnabled({ kind, ids: targetIds, enabled: false })
    const live = (kind === 'schedule' ? state.schedules : state.triggers)
      .filter((row) => row.enabled)
      .map((row) => row.sourceId)
    if (live.length) await sides.source.setEnabled({ kind, ids: live, enabled: true })
  }
  await sides.source.markMoved(null)
}

function sourceIdToTarget(state: MoveHandoverState, kind: HandoverKind, sourceId: string): string {
  const rows = kind === 'schedule' ? state.schedules : state.triggers
  return rows.find((row) => row.sourceId === sourceId)?.targetId ?? sourceId
}
