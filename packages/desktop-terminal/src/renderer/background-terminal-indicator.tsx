// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * BackgroundTerminalIndicator — chat UI component that shows the
 * count of active background terminals and expands to show details.
 *
 * Matches Cursor's "> 1 background terminal" expandable section.
 */
import * as React from 'react'
import type { BackgroundTask } from './background-task-manager'

export interface BackgroundTerminalIndicatorProps {
  /** List of all background tasks (active + completed). */
  tasks: BackgroundTask[]
}

export function BackgroundTerminalIndicator({ tasks }: BackgroundTerminalIndicatorProps) {
  const [expanded, setExpanded] = React.useState(false)
  const activeTasks = tasks.filter((t) => t.isRunning)

  if (activeTasks.length === 0) return null

  return React.createElement('div', {
    style: {
      background: '#161b22',
      border: '1px solid #21262d',
      borderRadius: 8,
      margin: '8px 0',
      fontSize: 13,
    },
  },
    // Header — clickable to expand
    React.createElement('button', {
      onClick: () => setExpanded(!expanded),
      style: {
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        width: '100%',
        background: 'none',
        border: 'none',
        padding: '10px 14px',
        color: '#c9d1d9',
        cursor: 'pointer',
        fontSize: 13,
        textAlign: 'left',
      },
    },
      React.createElement('span', {
        style: {
          display: 'inline-block',
          width: 0,
          height: 0,
          borderLeft: '5px solid #8b949e',
          borderTop: '4px solid transparent',
          borderBottom: '4px solid transparent',
          transform: expanded ? 'rotate(90deg)' : 'none',
          transition: 'transform 0.15s',
        },
      }),
      React.createElement('span', { style: { color: '#8b949e' } }, '>'),
      React.createElement('strong', null, `${activeTasks.length} background terminal${activeTasks.length > 1 ? 's' : ''}`),
    ),
    // Expanded details
    expanded && React.createElement('div', {
      style: {
        padding: '0 14px 10px',
        borderTop: '1px solid #21262d',
      },
    },
      activeTasks.map((task) =>
        React.createElement('div', {
          key: task.sessionId,
          style: {
            padding: '8px 0',
            borderBottom: '1px solid #21262d',
            fontSize: 12,
          },
        },
          React.createElement('div', { style: { color: '#58a6ff', fontWeight: 500 } }, task.label),
          React.createElement('div', { style: { color: '#8b949e', marginTop: 2 } },
            task.url
              ? `URL: ${task.url}`
              : task.readyDescription
                ? task.readyDescription
                : `Running: ${task.command.slice(0, 60)}${task.command.length > 60 ? '...' : ''}`
          ),
          React.createElement('div', { style: { color: '#484f58', marginTop: 2 } },
            `Started ${formatElapsed(Date.now() - task.startedAt)} ago`
          ),
        )
      ),
    ),
  )
}

function formatElapsed(ms: number): string {
  const sec = Math.floor(ms / 1000)
  if (sec < 60) return `${sec}s`
  const min = Math.floor(sec / 60)
  return `${min}m ${sec % 60}s`
}
