// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The task thread side window: which background task the user pressed, and
 * what the runtime said about it. A module-level store (like the chat dock's)
 * so any row in the chat can open the pane without threading a callback from
 * the screen down through every turn component.
 */

import { useSyncExternalStore } from "react"
import type { TaskLink } from "./task-link"

export interface TaskThreadTarget {
  /** Task key (`t_xxxx`). */
  taskId: string
  title?: string
  source?: string
  status?: string
  output?: string
  outputFile?: string
  link?: TaskLink | null
  /** True while the runtime's output route is still answering. */
  loading?: boolean
  /** Set when the runtime has no such task (e.g. it was forgotten). */
  error?: string
}

let current: TaskThreadTarget | null = null
const listeners = new Set<() => void>()

function emit() {
  for (const fn of listeners) fn()
}

export const taskThreadPane = {
  get(): TaskThreadTarget | null {
    return current
  },

  subscribe(listener: () => void): () => void {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  },

  /** Show a task immediately with what the row already knows. */
  open(target: TaskThreadTarget): void {
    current = { ...target }
    emit()
  },

  /** Merge what the runtime answered into the open pane, if it is still that task. */
  patch(taskId: string, next: Partial<TaskThreadTarget>): void {
    if (!current || current.taskId !== taskId) return
    current = { ...current, ...next }
    emit()
  },

  close(): void {
    if (!current) return
    current = null
    emit()
  },
}

/** The task whose thread is open, or null. */
export function useTaskThreadTarget(): TaskThreadTarget | null {
  return useSyncExternalStore(taskThreadPane.subscribe, taskThreadPane.get, taskThreadPane.get)
}
