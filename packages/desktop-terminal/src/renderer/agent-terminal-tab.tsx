// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * AgentTerminalTab — renders a terminal tab with an ∞ (infinity) icon,
 * the "Shogo" label, and read-only status. Matches Cursor's agent
 * terminal UX.
 *
 * Features:
 *   - ∞ icon distinguishes agent terminals from user terminals
 *   - "Agent terminals are read-only" status bar text
 *   - Right-click context menu with "Shell integration: Rich" details
 *   - Read-only keyboard input (user can scroll/copy but not type)
 */
import * as React from 'react'

export interface AgentTerminalInfo {
  /** Unique session ID for this agent terminal. */
  sessionId: string
  /** Display label, e.g. "Shogo (cd /path && bun run dev)". */
  label: string
  /** Working directory of the agent terminal. */
  cwd: string
  /** Whether the terminal is currently running a command. */
  isRunning: boolean
  /** Shell integration detection status. */
  shellIntegration: 'rich' | 'basic' | 'none'
  /** OSC sequences seen by this terminal. */
  seenSequences: string[]
  /** The command being run. */
  command?: string
}

// ─── Infinity Icon ────────────────────────────────────────────────────

/** The ∞ (infinity) icon as an SVG path. Same style as Cursor uses. */
export function InfinityIcon({ size = 16, color = '#8b949e' }: { size?: number; color?: string }) {
  return React.createElement('svg', {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: color,
    strokeWidth: 2,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
  },
    React.createElement('path', { d: 'M18.178 8c5.096 0 5.096 8 0 8-5.095 0-7.133-8-12.739-8-4.585 0-4.585 8 0 8 5.606 0 7.644-8 12.74-8z' }),
  )
}

// ─── Tab Component ────────────────────────────────────────────────────

export interface AgentTerminalTabProps {
  /** Agent terminal info. */
  terminal: AgentTerminalInfo
  /** Whether this tab is currently selected/active. */
  isActive: boolean
  /** Callback when tab is clicked. */
  onSelect: () => void
  /** Callback when close button is clicked. */
  onClose: () => void
}

export function AgentTerminalTab({ terminal, isActive, onSelect, onClose }: AgentTerminalTabProps) {
  const [showDetails, setShowDetails] = React.useState(false)

  return React.createElement('div', {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 6,
      padding: '4px 10px',
      borderRadius: 6,
      cursor: 'pointer',
      background: isActive ? '#1f6feb22' : 'transparent',
      border: isActive ? '1px solid #1f6feb44' : '1px solid transparent',
      fontSize: 13,
      color: isActive ? '#c9d1d9' : '#8b949e',
      position: 'relative',
    },
    onClick: onSelect,
    onMouseEnter: () => setShowDetails(true),
    onMouseLeave: () => setShowDetails(false),
    'data-agent-terminal': terminal.sessionId,
  },
    // ∞ icon
    React.createElement(InfinityIcon, { size: 14, color: isActive ? '#58a6ff' : '#484f58' }),
    // Label (truncated)
    React.createElement('span', {
      style: {
        maxWidth: 150,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      },
      title: terminal.label,
    }, terminal.label),
    // Running indicator
    terminal.isRunning && React.createElement('span', {
      style: {
        width: 6,
        height: 6,
        borderRadius: 3,
        background: '#3fb950',
        display: 'inline-block',
      },
    }),
    // Close button
    React.createElement('button', {
      onClick: (e: React.MouseEvent) => {
        e.stopPropagation()
        onClose()
      },
      style: {
        background: 'none',
        border: 'none',
        color: '#8b949e',
        cursor: 'pointer',
        padding: 2,
        fontSize: 14,
        lineHeight: 1,
        borderRadius: 3,
        marginLeft: 4,
      },
      title: 'Close agent terminal',
    }, '×'),
    // Details tooltip
    showDetails && React.createElement(AgentTerminalDetails, { terminal }),
  )
}

// ─── Details Tooltip ──────────────────────────────────────────────────

function AgentTerminalDetails({ terminal }: { terminal: AgentTerminalInfo }) {
  return React.createElement('div', {
    style: {
      position: 'absolute',
      top: '100%',
      left: 0,
      zIndex: 100,
      background: '#1c2128',
      border: '1px solid #30363d',
      borderRadius: 8,
      padding: 12,
      minWidth: 280,
      fontSize: 12,
      color: '#c9d1d9',
      boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
    },
    onClick: (e: React.MouseEvent) => e.stopPropagation(),
  },
    React.createElement('div', { style: { fontWeight: 600, marginBottom: 6, color: '#58a6ff' } }, terminal.label),
    React.createElement('div', { style: { color: '#8b949e', marginBottom: 4 } },
      `Shell integration: ${terminal.shellIntegration === 'rich' ? 'Rich' : terminal.shellIntegration}`
    ),
    React.createElement('ul', { style: { paddingLeft: 16, margin: 0, lineHeight: 1.8 } },
      React.createElement('li', null, `Current working directory: ${terminal.cwd}`),
      React.createElement('li', null, `Seen sequences: ${terminal.seenSequences.join(', ') || 'none'}`),
      terminal.command && React.createElement('li', { style: { wordBreak: 'break-all' } },
        `Prompt input: ${terminal.command}`
      ),
    ),
  )
}

// ─── Status Bar ───────────────────────────────────────────────────────

export interface AgentStatusBarProps {
  /** Number of active agent terminals. */
  count: number
}

/**
 * "Agent terminals are read-only" status bar text.
 * Shown when an agent terminal is active.
 */
export function AgentStatusBar({ count }: AgentStatusBarProps) {
  if (count === 0) return null

  return React.createElement('div', {
    style: {
      padding: '2px 12px',
      fontSize: 11,
      color: '#484f58',
      borderTop: '1px solid #21262d',
      display: 'flex',
      alignItems: 'center',
      gap: 6,
    },
  },
    React.createElement(InfinityIcon, { size: 10, color: '#484f58' }),
    React.createElement('span', null, `Agent terminal${count > 1 ? 's' : ''} are read-only`),
    count > 1 && React.createElement('span', { style: { color: '#30363d' } }, `(${count} active)`),
  )
}
