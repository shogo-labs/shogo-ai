// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * BackgroundTaskManager — tracks background terminal tasks, their
 * status, and notifies listeners when tasks start, complete, or
 * when a URL is detected.
 *
 * Drives the "Monitored background task N active" UI in the chat.
 */

import { ReadySignalDetector, type ReadySignal } from './ready-signal-detector'

export interface BackgroundTask {
  /** Unique session ID from the PTY host. */
  sessionId: string
  /** Human-readable label, e.g. "Shogo (cd /path && bun run dev)". */
  label: string
  /** The command being run. */
  command: string
  /** Working directory. */
  cwd: string
  /** When the task was started. */
  startedAt: number
  /** When the task completed (null if still running). */
  completedAt: number | null
  /** Exit code when completed (null if still running or killed). */
  exitCode: number | null
  /** Detected URL, if any. */
  url: string | null
  /** Whether the task is still running. */
  isRunning: boolean
  /** Ready signal description, if detected. */
  readyDescription: string | null
}

export type BackgroundTaskListener = (tasks: BackgroundTask[]) => void

export class BackgroundTaskManager {
  private tasks = new Map<string, BackgroundTask>()
  private detectors = new Map<string, ReadySignalDetector>()
  private listeners: Set<BackgroundTaskListener> = new Set()
  private disposed = false

  /** Subscribe to task list changes. Returns unsubscribe function. */
  onChange(listener: BackgroundTaskListener): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Get all tracked tasks. */
  getTasks(): BackgroundTask[] {
    return Array.from(this.tasks.values())
  }

  /** Get only active (running) tasks. */
  getActiveTasks(): BackgroundTask[] {
    return this.getTasks().filter((t) => t.isRunning)
  }

  /** Count of active background tasks. */
  getActiveCount(): number {
    return this.getActiveTasks().length
  }

  /**
   * Register a new background task.
   * Sets up a ReadySignalDetector for this task's output.
   */
  registerTask(task: {
    sessionId: string
    label: string
    command: string
    cwd: string
  }): BackgroundTask {
    const bgTask: BackgroundTask = {
      ...task,
      startedAt: Date.now(),
      completedAt: null,
      exitCode: null,
      url: null,
      isRunning: true,
      readyDescription: null,
    }

    this.tasks.set(task.sessionId, bgTask)

    // Set up ready signal detector
    const detector = new ReadySignalDetector()
    detector.onReady((signal) => {
      const t = this.tasks.get(task.sessionId)
      if (t) {
        t.url = signal.url ?? null
        t.readyDescription = signal.description
        this.emitChange()
      }
    })
    this.detectors.set(task.sessionId, detector)

    this.emitChange()
    return bgTask
  }

  /**
   * Feed output data for a specific task.
   * Routes to the task's ReadySignalDetector.
   */
  feedOutput(sessionId: string, data: string): void {
    this.detectors.get(sessionId)?.feedOutput(data)
  }

  /**
   * Mark a task as completed.
   */
  completeTask(sessionId: string, exitCode: number | null = 0): void {
    const task = this.tasks.get(sessionId)
    if (task) {
      task.completedAt = Date.now()
      task.exitCode = exitCode
      task.isRunning = false
      this.detectors.get(sessionId)?.flush()
      this.detectors.get(sessionId)?.dispose()
      this.detectors.delete(sessionId)
      this.emitChange()
    }
  }

  /**
   * Remove a completed task from tracking.
   */
  removeTask(sessionId: string): void {
    this.detectors.get(sessionId)?.dispose()
    this.detectors.delete(sessionId)
    this.tasks.delete(sessionId)
    this.emitChange()
  }

  /** Clean up all tasks and detectors. */
  dispose(): void {
    this.disposed = true
    for (const detector of this.detectors.values()) {
      detector.dispose()
    }
    this.detectors.clear()
    this.tasks.clear()
    this.listeners.clear()
  }

  private emitChange(): void {
    if (this.disposed) return
    const list = this.getTasks()
    for (const listener of this.listeners) {
      listener(list)
    }
  }
}

// ─── Module-level singleton ───────────────────────────────────────────

/**
 * Singleton BackgroundTaskManager for the current session.
 * Import and use across the app.
 */
export const backgroundTaskManager = new BackgroundTaskManager()
