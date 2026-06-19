// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Output tab — ambient stream of agent runtime logs (build / console /
 * canvas-error / chat-derived exec entries) for the IDE bottom drawer.
 *
 * Renders web-mode HTML directly (the BottomPanel is `Platform.OS ===
 * 'web'`-gated upstream) so we don't pay for the React Native shim.
 *
 * The tab is intentionally narrow: the runtime-log store + hook do all
 * the data fetching, deduping, ring-buffer trimming, and transport
 * fallback. This file is the rendering policy: filter pills, search,
 * level badges, auto-scroll, clear, export.
 */

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ReactElement,
} from 'react'
import {
  formatTime,
  parseLogLine,
  type LogLevel,
} from '../log-utils'
import {
  clearProject,
  markAllSeen,
  type RuntimeLogEntry,
  type RuntimeLogSource,
} from '../../../../lib/runtime-logs/runtime-log-store'
import { useRuntimeLogStream } from '../../../../lib/runtime-logs/useRuntimeLogStream'
import { useStickyBottom } from './sticky-bottom'
import { ideBottomPanelStore } from '../../../../lib/ide-bottom-panel-store'
import { getDesktopExtensionsBridge } from './extensions/useExtensions'
import type { ExtensionHostEvent, ExtensionOutputChannel } from './extensions/types'

type SourceFilter = 'all' | RuntimeLogSource | 'extension'

const SOURCE_FILTERS: ReadonlyArray<{ id: SourceFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'build', label: 'Build' },
  { id: 'console', label: 'Console' },
  { id: 'canvas-error', label: 'Canvas' },
  { id: 'exec', label: 'Exec' },
  { id: 'extension', label: 'Extensions' },
]

const LEVEL_BADGE_CLASS: Record<LogLevel, string> = {
  error: 'bg-red-900/60 text-red-200',
  warn: 'bg-amber-900/50 text-amber-200',
  info: '',
}

const LEVEL_TEXT_CLASS: Record<LogLevel, string> = {
  error: 'text-red-200',
  warn: 'text-amber-200',
  info: 'text-zinc-200',
}

interface OutputTabProps {
  projectId: string | null | undefined
  agentUrl: string | null | undefined
  /** Chat messages from `useChat` — exec entries are merged in. */
  messages?: any[]
  /** Tab is currently active in the BottomPanel (drives `markAllSeen`). */
  visible: boolean
  /** Optional injection seam for tests. */
  __eventSourceFactory?: (url: string) => EventSource
  /** Optional injection seam for tests. */
  __fetcher?: typeof fetch
}

interface LogRow {
  entry: RuntimeLogEntry
  message: string
  ts: string | null
}

function deriveLogRow(entry: RuntimeLogEntry): LogRow {
  // Run the existing log-utils parser to peel off ANSI / timestamps so the
  // Output tab renders identically to Monitor's LogsPanel.
  const parsed = parseLogLine(entry.text)
  return {
    entry,
    message: parsed.message || entry.text,
    ts: parsed.ts,
  }
}

export function OutputTab({
  projectId,
  agentUrl,
  messages,
  visible,
  __eventSourceFactory,
  __fetcher,
}: OutputTabProps): ReactElement {
  const safeProjectId = projectId ?? '__no_project__'
  const { entries, unseenErrors } = useRuntimeLogStream({
    projectId: safeProjectId,
    agentUrl: agentUrl ?? null,
    messages,
    eventSourceFactory: __eventSourceFactory,
    fetcher: __fetcher,
  })

  const [sourceFilter, setSourceFilter] = useState<SourceFilter>('all')
  const [search, setSearch] = useState('')
  const [autoScroll, setAutoScroll] = useState(true)
  const [extensionChannels, setExtensionChannels] = useState<ExtensionOutputChannel[]>([])
  const [activeExtensionChannelId, setActiveExtensionChannelId] = useState<string>('')
  const listRef = useRef<HTMLDivElement | null>(null)

  // Mark this project's errors as seen as soon as the user views the tab.
  // The BottomPanel re-renders the tab with `visible=true` on activation;
  // `markAllSeen` is idempotent for projects with 0 unseen errors.
  useEffect(() => {
    if (visible && safeProjectId) markAllSeen(safeProjectId)
  }, [visible, safeProjectId, entries.length])

  useEffect(() => {
    const bridge = getDesktopExtensionsBridge()
    if (!bridge) return
    let disposed = false
    void bridge.getOutputChannels().then((response) => {
      if (!disposed && response.ok) setExtensionChannels(response.channels ?? [])
    })
    return bridge.onEvent((event: ExtensionHostEvent) => {
      if (event.type !== 'outputChanged') return
      setExtensionChannels(event.channels)
      if (!activeExtensionChannelId && event.channels[0]) setActiveExtensionChannelId(event.channels[0].id)
      if (event.changed?.visible) {
        ideBottomPanelStore.setOpen(true)
        ideBottomPanelStore.setActiveTab('Output')
        setSourceFilter('extension')
        setActiveExtensionChannelId(event.changed.id)
      }
    })
  }, [activeExtensionChannelId])

  const rows: LogRow[] = useMemo(() => {
    let filtered: ReadonlyArray<RuntimeLogEntry> = sourceFilter === 'extension' ? [] : entries
    if (sourceFilter !== 'all' && sourceFilter !== 'extension') {
      filtered = filtered.filter((e) => e.source === sourceFilter)
    }
    const q = search.trim().toLowerCase()
    if (q.length > 0) {
      filtered = filtered.filter((e) => e.text.toLowerCase().includes(q))
    }
    return filtered.map(deriveLogRow)
  }, [entries, sourceFilter, search])

  const activeExtensionChannel = useMemo(() => {
    return extensionChannels.find((channel) => channel.id === activeExtensionChannelId) ?? extensionChannels[0] ?? null
  }, [activeExtensionChannelId, extensionChannels])

  const extensionOutputText = activeExtensionChannel?.lines ?? ''
  const extensionOutputMatches = sourceFilter === 'extension' && search.trim().length > 0
    ? extensionOutputText.toLowerCase().includes(search.trim().toLowerCase())
    : true

  // BUG-009 fix: sticky-bottom auto-scroll. The user's autoScroll toggle
  // enables tail-follow; the hook honours it ONLY when the viewport is
  // within 24px of the bottom (canvas prescription). If the user scrolls
  // up to read scrollback, new rows arrive silently below — no yank.
  // Re-running on filtered length (not entries length) so toggling a
  // source filter doesn't unscroll the user.
  const { scrollToBottom } = useStickyBottom(listRef, { enabled: autoScroll })
  useEffect(() => {
    scrollToBottom()
  }, [rows.length, extensionOutputText.length, scrollToBottom])

  const errorCount = useMemo(
    () => entries.filter((e) => e.level === 'error').length,
    [entries],
  )

  const handleClear = (): void => {
    if (safeProjectId) clearProject(safeProjectId)
  }

  const handleExport = (): void => {
    if (rows.length === 0) return
    const lines = rows.map((r) => {
      const parts = [
        new Date(r.entry.ts).toISOString(),
        `[${r.entry.source}]`,
        r.entry.level !== 'info' ? `[${r.entry.level.toUpperCase()}]` : '',
        r.entry.text,
      ]
      return parts.filter(Boolean).join(' ')
    })
    const blob = new Blob([lines.join('\n')], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `agent-runtime-logs-${new Date().toISOString().slice(0, 10)}.txt`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div
      className="flex h-full flex-col bg-[#1e1e1e] text-[12px] text-zinc-200"
      data-testid="output-tab"
    >
      {/* ─── Toolbar ─── */}
      <div
        className="flex items-center gap-2 border-b border-[#2a2a2a] px-3 py-1.5"
        role="toolbar"
        aria-label="Output toolbar"
      >
        <div role="group" aria-label="Filter by source" className="flex gap-1">
          {SOURCE_FILTERS.map((f) => {
            const active = sourceFilter === f.id
            return (
              <button
                key={f.id}
                type="button"
                role="radio"
                aria-checked={active}
                aria-label={`Filter by ${f.label}`}
                onClick={() => setSourceFilter(f.id)}
                className={`rounded-full px-2 py-0.5 text-[11px] ${
                  active
                    ? 'bg-zinc-600 text-white'
                    : 'bg-zinc-800/60 text-zinc-400 hover:text-white'
                }`}
              >
                {f.label}
              </button>
            )
          })}
        </div>

        {sourceFilter === 'extension' && extensionChannels.length > 0 && (
          <select
            value={activeExtensionChannel?.id ?? ''}
            onChange={(event) => setActiveExtensionChannelId(event.target.value)}
            aria-label="Extension output channel"
            className="max-w-64 rounded border border-[#2a2a2a] bg-[#252526] px-2 py-0.5 text-[11px] text-zinc-200 outline-none focus:border-[#0078d4]"
          >
            {extensionChannels.map((channel) => (
              <option key={channel.id} value={channel.id}>{channel.name} · {channel.extensionId}</option>
            ))}
          </select>
        )}

        <div className="ml-auto flex items-center gap-2">
          <label className="flex items-center gap-1 text-[11px] text-zinc-400">
            <input
              type="checkbox"
              checked={autoScroll}
              onChange={(e: ChangeEvent<HTMLInputElement>) => setAutoScroll(e.target.checked)}
              aria-label="Auto-scroll output"
            />
            Auto-scroll
          </label>
          <input
            type="search"
            role="searchbox"
            placeholder="Filter…"
            value={search}
            onChange={(e: ChangeEvent<HTMLInputElement>) => setSearch(e.target.value)}
            aria-label="Search output"
            className="w-40 rounded border border-[#2a2a2a] bg-[#252526] px-2 py-0.5 text-[11px] text-zinc-200 outline-none focus:border-[#0078d4]"
          />
          <button
            type="button"
            onClick={handleExport}
            disabled={rows.length === 0}
            aria-label="Export output"
            className="rounded px-2 py-0.5 text-[11px] text-zinc-400 hover:text-white disabled:opacity-40"
          >
            Export
          </button>
          <button
            type="button"
            onClick={handleClear}
            aria-label="Clear output"
            className="rounded px-2 py-0.5 text-[11px] text-zinc-400 hover:text-white"
          >
            Clear
          </button>
        </div>
      </div>

      {/* ─── Status row (counts) ─── */}
      <div
        className="flex items-center gap-3 border-b border-[#2a2a2a] px-3 py-1 text-[10px] text-zinc-500"
        role="status"
        aria-live="polite"
      >
        <span>
          {rows.length} {rows.length === 1 ? 'entry' : 'entries'}
        </span>
        {errorCount > 0 && (
          <span
            className="text-red-400"
            aria-label={`${errorCount} unseen error${errorCount === 1 ? '' : 's'}`}
          >
            {errorCount} {errorCount === 1 ? 'error' : 'errors'}
          </span>
        )}
        {unseenErrors > 0 && (
          <span className="text-red-400" data-testid="unseen-error-count">
            {unseenErrors} new
          </span>
        )}
      </div>

      {/* ─── Body ─── */}
      <div
        ref={listRef}
        role="region"
        aria-label="Output entries"
        className="flex-1 overflow-auto px-3 py-2 font-mono"
      >
        {sourceFilter === 'extension' ? (
          !activeExtensionChannel ? (
            <div className="py-8 text-center text-[11px] text-zinc-500">
              No extension output channels yet.
            </div>
          ) : !extensionOutputMatches ? (
            <div className="py-8 text-center text-[11px] text-zinc-500">
              No output in {activeExtensionChannel.name} matches the current filter.
            </div>
          ) : (
            <pre className="whitespace-pre-wrap break-words text-zinc-200">
              {extensionOutputText || `${activeExtensionChannel.name} is open. No output has been written yet.`}
            </pre>
          )
        ) : !agentUrl ? (
          <div className="py-8 text-center text-[11px] text-zinc-500">
            No runtime logs yet. Start the agent to see activity.
          </div>
        ) : rows.length === 0 ? (
          <div className="py-8 text-center text-[11px] text-zinc-500">
            {entries.length === 0
              ? 'No runtime logs yet.'
              : 'No entries match the current filters.'}
          </div>
        ) : (
          <ul role="list" className="space-y-0.5">
            {rows.map((r) => (
              <li
                key={`${r.entry.source}-${r.entry.seq}-${r.entry.ts}`}
                role="listitem"
                className="flex items-start gap-2"
              >
                {r.ts ? (
                  <span className="w-[70px] shrink-0 text-[10px] text-zinc-500">
                    {formatTime(r.ts)}
                  </span>
                ) : (
                  <span className="w-[70px] shrink-0 text-[10px] text-zinc-600">
                    {formatTime(new Date(r.entry.ts).toISOString())}
                  </span>
                )}
                {r.entry.level !== 'info' && (
                  <span
                    className={`shrink-0 rounded px-1 text-[9px] uppercase ${LEVEL_BADGE_CLASS[r.entry.level]}`}
                  >
                    {r.entry.level}
                  </span>
                )}
                <span className="shrink-0 text-[10px] text-zinc-500">
                  [{r.entry.source}]
                </span>
                <span
                  className={`whitespace-pre-wrap break-words ${LEVEL_TEXT_CLASS[r.entry.level]}`}
                >
                  {r.message}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
