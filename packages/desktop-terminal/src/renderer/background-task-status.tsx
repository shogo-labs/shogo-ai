// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * BackgroundTaskStatus — shows running background commands in the
 * terminal status area. Displays each task's command, elapsed time,
 * and status (running / completed / failed).
 *
 * Phase 3 deliverable — UX gap closure for background commands.
 *
 * Usage:
 *   <BackgroundTaskStatus tasks={activeTasks} onJumpToTerminal={...} />
 */

import * as React from 'react'
import type { BackgroundTask, CommandResult } from './agent-terminal-bridge'

// ─── types ──────────────────────────────────────────────────────────────

interface BackgroundTaskStatusProps {
  /** Active and recently completed background tasks. */
  tasks: BackgroundTaskInfo[]
  /** Called when user clicks a task to jump to its terminal. */
  onJumpToTerminal?: (taskId: string) => void
  /** Called when user clicks dismiss on a completed task. */
  onDismiss?: (taskId: string) => void
}

export interface BackgroundTaskInfo {
  id: string
  command: string
  status: 'running' | 'completed' | 'failed'
  exitCode?: number | null
  startedAt: number
  completedAt?: number
}

// ─── component ──────────────────────────────────────────────────────────

export function BackgroundTaskStatus({
  tasks,
  onJumpToTerminal,
  onDismiss,
}: BackgroundTaskStatusProps) {
  if (tasks.length === 0) return null

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
        padding: '4px 8px',
        borderBottom: '1px solid rgba(139, 148, 158, 0.15)',
        fontSize: 11,
        fontFamily: 'Menlo, Monaco, Consolas, monospace',
      }}
    >
      {tasks.map((task) => (
        <BackgroundTaskRow
          key={task.id}
          task={task}
          onJump={() => onJumpToTerminal?.(task.id)}
          onDismiss={() => onDismiss?.(task.id)}
        />
      ))}
    </div>
  )
}

// ─── row ────────────────────────────────────────────────────────────────

function BackgroundTaskRow({
  task,
  onJump,
  onDismiss,
}: {
  task: BackgroundTaskInfo
  onJump: () => void
  onDismiss: () => void
}) {
  const [elapsed, setElapsed] = React.useState(() => Date.now() - task.startedAt)

  // Tick for running tasks
  React.useEffect(() => {
    if (task.status !== 'running') return
    const id = setInterval(() => setElapsed(Date.now() - task.startedAt), 1000)
    return () => clearInterval(id)
  }, [task.status, task.startedAt])

  const statusIcon = task.status === 'running'
    ? '🔄'
    : task.status === 'completed'
      ? '✅'
      : '❌'

  const elapsedStr = task.status === 'running'
    ? formatElapsed(elapsed)
    : task.completedAt
      ? formatElapsed(task.completedAt - task.startedAt)
      : ''

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '2px 4px',
        borderRadius: 4,
        backgroundColor: task.status === 'running'
          ? 'rgba(56, 139, 253, 0.08)'
          : task.status === 'failed'
            ? 'rgba(248, 81, 73, 0.08)'
            : 'transparent',
        cursor: 'pointer',
      }}
      onClick={onJump}
      title="Click to jump to terminal"
    >
      <span>{statusIcon}</span>
      <span
        style={{
          flex: 1,
          color: '#c9d1d9',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        $ {task.command}
      </span>
      {elapsedStr && (
        <span style={{ color: '#6e7681', whiteSpace: 'nowrap' }}>
          {elapsedStr}
        </span>
      )}
      {task.status !== 'running' && (
        <button
          onClick={(e) => { e.stopPropagation(); onDismiss() }}
          style={{
            background: 'none',
            border: 'none',
            color: '#6e7681',
            cursor: 'pointer',
            padding: 0,
            fontSize: 12,
            lineHeight: 1,
          }}
          title="Dismiss"
        >
          ×
        </button>
      )}
    </div>
  )
}

// ─── helpers ────────────────────────────────────────────────────────────

function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const remainingSec = seconds % 60
  return `${minutes}m ${remainingSec}s`
}

// ─── hook for managing background tasks ─────────────────────────────────

export function useBackgroundTasks() {
  const [tasks, setTasks] = React.useState<BackgroundTaskInfo[]>([])

  const addTask = React.useCallback((task: BackgroundTask) => {
    setTasks((prev) => [
      ...prev,
      {
        id: task.id,
        command: task.command,
        status: 'running',
        startedAt: Date.now(),
      },
    ])

    // Subscribe to completion
    task.promise.then(
      (result) => {
        setTasks((prev) =>
          prev.map((t) =>
            t.id === task.id
              ? {
                  ...t,
                  status: result.exitCode === 0 ? 'completed' : 'failed',
                  exitCode: result.exitCode,
                  completedAt: Date.now(),
                }
              : t
          )
        )
      },
      () => {
        // Promise rejected — mark as failed
        setTasks((prev) =>
          prev.map((t) =>
            t.id === task.id
              ? { ...t, status: 'failed', exitCode: null, completedAt: Date.now() }
              : t
          )
        )
      }
    )
  }, [])

  const dismissTask = React.useCallback((taskId: string) => {
    setTasks((prev) => prev.filter((t) => t.id !== taskId))
  }, [])

  const clearCompleted = React.useCallback(() => {
    setTasks((prev) => prev.filter((t) => t.status === 'running'))
  }, [])

  return { tasks, addTask, dismissTask, clearCompleted }
}
