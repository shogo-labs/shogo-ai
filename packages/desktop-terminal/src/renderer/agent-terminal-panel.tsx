// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * AgentTerminalPanel — shows a list of active agent terminals with
 * status badges and kill buttons. Allows the user to peek at hidden
 * agent terminals that the agent creates via AgentTerminalFactory.
 *
 * This is the React component that renders in the terminal toolbar.
 * It uses the AgentTerminalFactory singleton to list instances and
 * subscribe to lifecycle events.
 */

import * as React from 'react'
import type { AgentTerminalInstance } from './agent-terminal-factory'

// ─── types ──────────────────────────────────────────────────────────────

export interface AgentTerminalPanelProps {
  /** All known agent terminal instances. */
  instances: AgentTerminalInstance[]
  /** Callback when user clicks on an instance to view its output. */
  onSelect?: (instance: AgentTerminalInstance) => void
  /** Callback when user clicks kill on an instance. */
  onKill?: (instance: AgentTerminalInstance) => void
  /** Whether the panel is visible. */
  open: boolean
  /** Callback to close the panel. */
  onClose?: () => void
}

export interface AgentTerminalEntryProps {
  instance: AgentTerminalInstance
  selected?: boolean
  onSelect?: (instance: AgentTerminalInstance) => void
  onKill?: (instance: AgentTerminalInstance) => void
}

// ─── status helpers ─────────────────────────────────────────────────────

export type TerminalStatus = 'running' | 'completed' | 'failed' | 'disposed'

export function getTerminalStatus(instance: AgentTerminalInstance): TerminalStatus {
  if (instance.disposed) return 'disposed'
  if (instance.commandResult) {
    return instance.commandResult.exitCode === 0 ? 'completed' : 'failed'
  }
  return 'running'
}

const STATUS_COLORS: Record<TerminalStatus, string> = {
  running: '#3fb950',
  completed: '#8b949e',
  failed: '#f85149',
  disposed: '#484f58',
}

const STATUS_LABELS: Record<TerminalStatus, string> = {
  running: 'Running',
  completed: 'Done',
  failed: 'Failed',
  disposed: 'Closed',
}

// ─── entry component ────────────────────────────────────────────────────

export function AgentTerminalEntry({
  instance,
  selected = false,
  onSelect,
  onKill,
}: AgentTerminalEntryProps) {
  const status = getTerminalStatus(instance)
  const elapsed = instance.commandResult?.durationMs ?? instance.elapsedMs ?? 0

  return React.createElement('div', {
    style: {
      display: 'flex',
      alignItems: 'center',
      padding: '6px 10px',
      gap: 8,
      cursor: 'pointer',
      borderRadius: 4,
      background: selected ? 'rgba(88, 166, 255, 0.12)' : 'transparent',
      border: selected ? '1px solid rgba(88, 166, 255, 0.3)' : '1px solid transparent',
      fontSize: 12,
      fontFamily: 'monospace',
    },
    onClick: () => onSelect?.(instance),
  },
    // Status dot
    React.createElement('span', {
      style: {
        width: 8,
        height: 8,
        borderRadius: '50%',
        background: STATUS_COLORS[status],
        flexShrink: 0,
      },
    }),
    // Command text
    React.createElement('span', {
      style: {
        flex: 1,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        color: '#c9d1d9',
      },
    }, instance.command || '(no command)'),
    // Duration
    React.createElement('span', {
      style: {
        color: '#8b949e',
        fontSize: 11,
        flexShrink: 0,
      },
    }, formatElapsed(elapsed)),
    // Status badge
    React.createElement('span', {
      style: {
        color: STATUS_COLORS[status],
        fontSize: 10,
        fontWeight: 600,
        textTransform: 'uppercase',
        letterSpacing: 0.5,
        flexShrink: 0,
      },
    }, STATUS_LABELS[status]),
    // Kill button (only for running)
    status === 'running' ? React.createElement('button', {
      onClick: (e: React.MouseEvent) => {
        e.stopPropagation()
        onKill?.(instance)
      },
      style: {
        background: 'none',
        border: 'none',
        color: '#f85149',
        cursor: 'pointer',
        fontSize: 11,
        padding: '2px 4px',
        borderRadius: 3,
        flexShrink: 0,
      },
      title: 'Kill terminal',
    }, '\u2715') : null,
  )
}

// ─── panel component ────────────────────────────────────────────────────

export function AgentTerminalPanel({
  instances,
  onSelect,
  onKill,
  open,
  onClose,
}: AgentTerminalPanelProps) {
  const [selectedId, setSelectedId] = React.useState<string | null>(null)

  if (!open) return null

  const running = instances.filter((i) => getTerminalStatus(i) === 'running')
  const finished = instances.filter((i) => getTerminalStatus(i) !== 'running')

  return React.createElement('div', {
    style: {
      position: 'absolute',
      top: 0,
      right: 0,
      width: 320,
      height: '100%',
      background: '#0d1117',
      borderLeft: '1px solid #30363d',
      display: 'flex',
      flexDirection: 'column',
      zIndex: 100,
      overflow: 'hidden',
    },
  },
    // Header
    React.createElement('div', {
      style: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '8px 12px',
        borderBottom: '1px solid #30363d',
        background: '#161b22',
      },
    },
      React.createElement('span', {
        style: { color: '#c9d1d9', fontSize: 13, fontWeight: 600 },
      }, `Agent Terminals (${instances.length})`),
      React.createElement('button', {
        onClick: onClose,
        style: {
          background: 'none',
          border: 'none',
          color: '#8b949e',
          cursor: 'pointer',
          fontSize: 16,
          padding: '0 4px',
        },
      }, '\u2715'),
    ),
    // Content
    React.createElement('div', {
      style: { flex: 1, overflow: 'auto', padding: '4px 0' },
    },
      instances.length === 0
        ? React.createElement('div', {
            style: {
              padding: 20,
              textAlign: 'center',
              color: '#484f58',
              fontSize: 13,
            },
          }, 'No agent terminals yet. The agent will create terminals when it needs to run commands.')
        : React.createElement(React.Fragment, null,
            // Running section
            running.length > 0 ? React.createElement(React.Fragment, null,
              React.createElement('div', {
                style: {
                  padding: '4px 12px',
                  fontSize: 10,
                  fontWeight: 600,
                  color: '#3fb950',
                  textTransform: 'uppercase',
                  letterSpacing: 1,
                },
              }, `Running (${running.length})`),
              ...running.map((inst) =>
                React.createElement(AgentTerminalEntry, {
                  key: inst.id,
                  instance: inst,
                  selected: selectedId === inst.id,
                  onSelect: (i) => { setSelectedId(i.id); onSelect?.(i) },
                  onKill,
                })
              ),
            ) : null,
            // Finished section
            finished.length > 0 ? React.createElement(React.Fragment, null,
              React.createElement('div', {
                style: {
                  padding: '8px 12px 4px',
                  fontSize: 10,
                  fontWeight: 600,
                  color: '#8b949e',
                  textTransform: 'uppercase',
                  letterSpacing: 1,
                },
              }, `Finished (${finished.length})`),
              ...finished.map((inst) =>
                React.createElement(AgentTerminalEntry, {
                  key: inst.id,
                  instance: inst,
                  selected: selectedId === inst.id,
                  onSelect: (i) => { setSelectedId(i.id); onSelect?.(i) },
                  onKill,
                })
              ),
            ) : null,
          ),
    ),
  )
}

// ─── helpers ────────────────────────────────────────────────────────────

function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return `${m}m ${s % 60}s`
}
