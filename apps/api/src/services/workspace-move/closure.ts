// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * What "just these channels and agents" actually means.
 *
 * A workspace is a graph, not a folder tree: a board hangs off a channel, a
 * card's history hangs off the board, an agent's schedule points at the chat it
 * reports into. Selecting two channels and one agent therefore has to pull a
 * *closure*, and the only way to keep that honest as models are added is to
 * decide, per model, how it joins the closure.
 *
 * `MOVE_CLOSURE` is that decision, and `__tests__/closure-coverage.test.ts`
 * fails when a model in either schema has no entry — so a new model cannot
 * silently travel in every partial move (or silently vanish from them).
 *
 * Modes:
 *   always        workspace furniture every move needs (the workspace row,
 *                 members, the agent profile, groups, settings)
 *   root          the things the user picks (Conversation, Project)
 *   conversation  rows that hang off a channel by a foreign key
 *   project       rows that hang off a project (derived from the export scope)
 *   parent        rows that hang off a row of another model (export scope)
 *   via           rows reachable through any declared foreign key — the
 *                 fixpoint pass that picks up boards' cards, a schedule's chat,
 *                 a project's social posts
 */

import { WORKSPACE_EXPORT_MANIFEST, insertOrder, scopeFor } from '../workspace-export/manifest'
import type { MoveRow, MoveSelection } from './types'

export type ClosureMode = 'always' | 'root' | 'conversation' | 'project' | 'parent' | 'via'

export interface ClosureRule {
  mode: ClosureMode
  /** Foreign keys to follow for `via` / `conversation`. Defaults are below. */
  fields?: readonly string[]
}

/** FK columns that never pull a row into the closure. */
const NEVER_FOLLOW = new Set(['id', 'workspaceId', 'userId', 'createdById', 'updatedById'])

/**
 * Models whose export scope is `workspace` need an explicit decision here.
 * Anything not listed falls back to its export scope (see `closureRuleFor`).
 */
export const MOVE_CLOSURE: Record<string, ClosureRule> = {
  // ── workspace furniture: every move carries these ─────────────────
  Folder: { mode: 'always' },
  ProjectAgent: { mode: 'via', fields: ['projectId'] },
  WorkspaceAgentProfile: { mode: 'always' },
  SubagentModelOverride: { mode: 'always' },
  WorkspaceModelVisibility: { mode: 'always' },
  CustomEmoji: { mode: 'always' },
  Member: { mode: 'always' },
  Invitation: { mode: 'always' },
  InviteLink: { mode: 'always' },
  UserGroup: { mode: 'always' },
  UserIntegrationWorkspaceGrant: { mode: 'always' },
  MeetingTemplate: { mode: 'always' },

  // ── the things the user picks ─────────────────────────────────────
  Conversation: { mode: 'root' },
  Project: { mode: 'root' },

  // ── a channel's own content ───────────────────────────────────────
  Board: { mode: 'conversation', fields: ['conversationId'] },
  Meeting: { mode: 'conversation', fields: ['conversationId'] },

  // ── reachable through a foreign key ───────────────────────────────
  // A chat with an agent belongs to the project it is about; a schedule
  // belongs to the chat it reports into; a trigger to the channel it posts to.
  ChatSession: { mode: 'via', fields: ['projectId'] },
  ChatReminder: { mode: 'via', fields: ['chatSessionId', 'conversationId'] },
  StarredProject: { mode: 'via', fields: ['projectId'] },
  WorkItem: { mode: 'via', fields: ['boardId'] },
  WorkItemEvent: { mode: 'via', fields: ['workItemId'] },
  WorkItemLink: { mode: 'via', fields: ['fromItemId', 'toItemId'] },
  ProblemOccurrence: { mode: 'via', fields: ['projectId', 'problemId'] },
  AgentSchedule: { mode: 'via', fields: ['chatSessionId', 'notifyConversationId', 'goalId'] },
  Goal: { mode: 'via', fields: ['projectId', 'chatSessionId', 'conversationId'] },
  EventSubscription: { mode: 'via', fields: ['notifyConversationId', 'installId'] },
  AgentTask: { mode: 'via', fields: ['projectId', 'chatSessionId'] },
  VoiceProjectConfig: { mode: 'via', fields: ['projectId'] },
  SocialAutomation: { mode: 'via', fields: ['projectId'] },
  SocialPost: { mode: 'via', fields: ['projectId'] },
}

/** Parent-scoped models hang off their parent; declared in the export manifest. */
function ruleFromScope(model: string): ClosureRule | null {
  const scope = scopeFor(model)
  if (!scope) return null
  switch (scope.kind) {
    case 'workspace-row':
      return { mode: 'always' }
    case 'project':
      return { mode: 'project' }
    case 'parent':
      return { mode: 'parent' }
    case 'workspace':
      // Deliberately not defaulted: a workspace-scoped model needs a human
      // decision about how it joins a partial move.
      return MOVE_CLOSURE[model] ?? null
    default:
      return null
  }
}

export function closureRuleFor(model: string): ClosureRule | null {
  return MOVE_CLOSURE[model] ?? ruleFromScope(model)
}

/** Every included model that still needs a decision — the coverage test. */
export function modelsWithoutClosureRule(): string[] {
  return insertOrder().filter((model) => !closureRuleFor(model))
}

function fkFields(model: string, rule: ClosureRule, row: MoveRow): string[] {
  if (rule.fields?.length) return [...rule.fields]
  return Object.keys(row).filter(
    (key) => key.endsWith('Id') && !NEVER_FOLLOW.has(key) && typeof row[key] === 'string' && row[key],
  )
}

export interface ClosureResult {
  rows: Map<string, MoveRow[]>
  /** Per-model counts, in insert order, for the plan step. */
  counts: Array<{ model: string; rows: number }>
}

/**
 * Narrow a workspace-wide snapshot to the selected channels and projects.
 *
 * `mode: 'all'` returns the snapshot untouched (minus nothing) — a whole
 * workspace move is the common case and must not pay for the graph walk.
 */
export function applySelectionClosure(
  snapshot: Map<string, MoveRow[]>,
  selection: MoveSelection,
): ClosureResult {
  if (selection.mode === 'all') {
    const rows = new Map<string, MoveRow[]>()
    for (const [model, list] of snapshot) rows.set(model, list)
    return { rows, counts: countRows(rows) }
  }

  const selectedConversations = new Set(selection.conversationIds ?? [])
  const selectedProjects = new Set(selection.projectIds ?? [])
  const included = new Map<string, Set<string>>()
  const result = new Map<string, MoveRow[]>()

  const include = (model: string, row: MoveRow) => {
    const id = String(row?.id ?? '')
    if (!id) return false
    let ids = included.get(model)
    if (!ids) {
      ids = new Set()
      included.set(model, ids)
    }
    if (ids.has(id)) return false
    ids.add(id)
    const list = result.get(model) ?? []
    list.push(row)
    result.set(model, list)
    return true
  }

  const allIncludedIds = (): Set<string> => {
    const ids = new Set<string>()
    for (const set of included.values()) for (const id of set) ids.add(id)
    return ids
  }

  for (const model of insertOrder()) {
    const rule = closureRuleFor(model)
    const rows = snapshot.get(model) ?? []
    if (!rule || !rows.length) continue

    if (rule.mode === 'always') {
      for (const row of rows) include(model, row)
      continue
    }
    if (rule.mode === 'root') {
      const wanted = model === 'Conversation' ? selectedConversations : model === 'Project' ? selectedProjects : new Set<string>()
      for (const row of rows) if (wanted.has(String(row.id))) include(model, row)
      continue
    }
    if (rule.mode === 'project') {
      for (const row of rows) {
        if (selectedProjects.has(String(row.projectId ?? ''))) include(model, row)
      }
      continue
    }
    if (rule.mode === 'conversation') {
      const fields = rule.fields ?? ['conversationId']
      for (const row of rows) {
        if (fields.some((field) => selectedConversations.has(String(row[field] ?? '')))) {
          include(model, row)
        }
      }
      continue
    }
    // `parent` and `via` need the closure to grow first; the fixpoint below
    // handles them, so nothing is included in this pass.
  }

  // Fixpoint: a row joins when something it points at is already in. Repeats
  // until a pass adds nothing, which is bounded by the number of models.
  const maxPasses = insertOrder().length + 1
  for (let pass = 0; pass < maxPasses; pass++) {
    const ids = allIncludedIds()
    let added = 0
    for (const model of insertOrder()) {
      const rule = closureRuleFor(model)
      if (!rule) continue
      const rows = snapshot.get(model) ?? []
      if (!rows.length) continue
      if (rule.mode === 'via') {
        for (const row of rows) {
          const fields = fkFields(model, rule, row)
          if (fields.some((field) => ids.has(String(row[field] ?? '')))) {
            if (include(model, row)) added++
          }
        }
        continue
      }
      if (rule.mode === 'parent') {
        const scope = scopeFor(model)
        if (!scope || scope.kind !== 'parent') continue
        const parentIds = included.get(scope.parent)
        if (!parentIds?.size) continue
        for (const row of rows) {
          if (parentIds.has(String(row[scope.field] ?? ''))) {
            if (include(model, row)) added++
          }
        }
      }
    }
    if (!added) break
  }

  // Rows are returned in insert order so the records phase can stream them
  // without re-sorting, and children never arrive before their parents.
  const ordered = new Map<string, MoveRow[]>()
  for (const model of insertOrder()) {
    const list = result.get(model)
    if (list?.length) ordered.set(model, list)
  }
  return { rows: ordered, counts: countRows(ordered) }
}

function countRows(rows: Map<string, MoveRow[]>): Array<{ model: string; rows: number }> {
  const counts: Array<{ model: string; rows: number }> = []
  for (const model of insertOrder()) {
    const list = rows.get(model)
    if (list?.length) counts.push({ model, rows: list.length })
  }
  return counts
}

/** Models that are part of the export format but not of a move. */
export function moveExcludedModels(): string[] {
  return Object.entries(WORKSPACE_EXPORT_MANIFEST)
    .filter(([, entry]) => entry.decision !== 'include')
    .map(([model]) => model)
}
