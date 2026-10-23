// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Pure helpers behind the Tasks screen's paging. Kept out of the screen so the
 * two rules that are easy to get wrong — which rows a page may add, and where
 * the next page resumes — can be tested without rendering it.
 */
import type { AgentTask } from './api'

/**
 * Add a page to what is already shown, skipping rows from another workspace and
 * rows already present. The list is ordered by updatedAt, so a task edited
 * between two requests comes back on the later page too and must not double up.
 * Returns `prev` itself when the page adds nothing.
 */
export function appendTasksPage(
  prev: AgentTask[],
  page: AgentTask[],
  workspaceId: string | null | undefined,
): AgentTask[] {
  const seen = new Set(prev.map((task) => task.id))
  const added = page.filter((task) => task.workspaceId === workspaceId && !seen.has(task.id))
  return added.length ? [...prev, ...added] : prev
}

/**
 * Where the next page resumes: after the oldest row on screen. Both halves are
 * needed because updatedAt is not unique — a batch of tasks finishing together
 * shares a millisecond, and resuming on the timestamp alone skips the rest of it.
 */
export function nextPageCursor(tasks: AgentTask[]): { before: string; beforeId: string } | null {
  const last = tasks[tasks.length - 1]
  return last ? { before: last.updatedAt, beforeId: last.id } : null
}
