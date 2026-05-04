// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Problems tab — VS Code-style aggregated diagnostics list.
 *
 * Hosted by `BottomPanel.tsx`. Behaves like VS Code's Problems view:
 *   - Groups diagnostics by file with expand/collapse
 *   - Shows severity icon + count badges in the header
 *   - Click a row → opens the file at the offending line/col
 *   - Refresh button forces a fresh tsc + eslint + build pass
 *   - Auto-polls while the tab is visible (every 6s, with `since` so most
 *     polls are tiny "unchanged: true" responses)
 *   - Surfaces "service starting" cleanly when the runtime pod is warming
 *
 * Architecture note: this component is purely presentational + data-fetching.
 * Navigating to a file delegates to the parent's `onReveal` callback, which
 * is the same `revealMatch` already used by the search panel. No new IDE
 * plumbing required.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  AlertCircle, AlertTriangle, ChevronDown, ChevronRight, Info, Lightbulb, RefreshCw,
} from "lucide-react-native"
import {
  fetchDiagnostics,
  refreshDiagnostics,
  type Diagnostic,
  type DiagnosticsResult,
  DiagnosticsApiError,
} from "../../../../lib/diagnostics-api"

const POLL_INTERVAL_MS = 6_000
type SeverityFilter = "all" | Diagnostic["severity"]

export interface ProblemsProps {
  projectId: string | null | undefined
  /** True when the Problems tab is the active tab. We only poll while visible. */
  visible: boolean
  /**
   * Open a file at a 1-based (line, col). Wired up in Workbench to
   * `revealMatch("agent", path, line, col)`. Optional — when omitted,
   * clicking a row is a no-op (still useful for read-only contexts).
   */
  onReveal?: (path: string, line: number, column: number) => void
}

interface FileGroup {
  file: string
  diagnostics: Diagnostic[]
  errorCount: number
  warningCount: number
}

function groupByFile(diagnostics: Diagnostic[]): FileGroup[] {
  const map = new Map<string, FileGroup>()
  for (const d of diagnostics) {
    const key = d.file
    let g = map.get(key)
    if (!g) {
      g = { file: key, diagnostics: [], errorCount: 0, warningCount: 0 }
      map.set(key, g)
    }
    g.diagnostics.push(d)
    if (d.severity === "error") g.errorCount++
    else if (d.severity === "warning") g.warningCount++
  }
  // Sort: files with errors first, then by name. Within a file, by line/col.
  const groups = [...map.values()]
  groups.sort((a, b) => {
    if ((b.errorCount > 0 ? 1 : 0) !== (a.errorCount > 0 ? 1 : 0)) {
      return (b.errorCount > 0 ? 1 : 0) - (a.errorCount > 0 ? 1 : 0)
    }
    return a.file.localeCompare(b.file)
  })
  for (const g of groups) {
    g.diagnostics.sort((a, b) => a.line - b.line || a.column - b.column)
  }
  return groups
}

function severityIcon(sev: Diagnostic["severity"], size = 12) {
  // Colors are pulled from --ide-* CSS vars so light theme + custom themes
  // work out of the box. Keep aria-hidden — text label travels via the
  // button's aria-label.
  switch (sev) {
    case "error":   return <AlertCircle size={size} color="var(--ide-error)" aria-hidden />
    case "warning": return <AlertTriangle size={size} color="var(--ide-warning)" aria-hidden />
    case "info":    return <Info size={size} color="var(--ide-active-ring)" aria-hidden />
    case "hint":    return <Lightbulb size={size} color="var(--ide-muted)" aria-hidden />
  }
}

function basenameOf(path: string): string {
  const i = path.lastIndexOf("/")
  return i === -1 ? path : path.slice(i + 1)
}

function dirnameOf(path: string): string {
  const i = path.lastIndexOf("/")
  return i === -1 ? "" : path.slice(0, i)
}

export function Problems({ projectId, visible, onReveal }: ProblemsProps) {
  const [result, setResult] = useState<DiagnosticsResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<DiagnosticsApiError | Error | null>(null)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [severityFilter, setSeverityFilter] = useState<SeverityFilter>("all")
  const abortRef = useRef<AbortController | null>(null)
  const lastRunAtRef = useRef<string | undefined>(undefined)
  // Refs mirror the state values that `load` reads — kept out of the
  // dependency array so `load` has a stable identity. Without this the
  // polling interval used to be torn down + rebuilt on every fetch, which
  // opened a stale-closure window where in-flight responses could land
  // against an aborted controller.
  const hasResultRef = useRef(false)
  const refreshingRef = useRef(false)

  const load = useCallback(async (force: boolean) => {
    if (!projectId) return
    // Don't let the every-6s poll abort a refresh the user just kicked off.
    // The next poll will catch up after refresh resolves.
    if (!force && refreshingRef.current) return

    abortRef.current?.abort()
    const ctrl = new AbortController()
    abortRef.current = ctrl
    if (force) {
      setRefreshing(true)
      refreshingRef.current = true
    } else if (!hasResultRef.current) {
      setLoading(true)
    }
    try {
      const data = force
        ? await refreshDiagnostics(projectId, { signal: ctrl.signal })
        : await fetchDiagnostics(projectId, { signal: ctrl.signal, since: lastRunAtRef.current })
      if (ctrl.signal.aborted) return
      if ("unchanged" in data && data.unchanged) {
        // Server says nothing has changed since `since` — keep current state.
        lastRunAtRef.current = data.lastRunAt
      } else {
        const fresh = data as DiagnosticsResult
        setResult(fresh)
        hasResultRef.current = true
        lastRunAtRef.current = fresh.lastRunAt
      }
      setError(null)
    } catch (err) {
      if ((err as any)?.name === "AbortError") return
      // Surface the error even if we already have a result. Polling failures
      // after first success used to be silently swallowed; a banner above
      // the list (rendered conditionally below) keeps the user informed.
      setError(err as Error)
    } finally {
      if (!ctrl.signal.aborted) {
        setLoading(false)
        setRefreshing(false)
        refreshingRef.current = false
      }
    }
  }, [projectId])

  // Initial load when the tab becomes visible.
  useEffect(() => {
    if (visible) void load(false)
    return () => abortRef.current?.abort()
  }, [visible, projectId, load])

  // Polling while visible. Stable interval — doesn't get rebuilt on every
  // fetch, so polls don't double up.
  useEffect(() => {
    if (!visible || !projectId) return
    const t = setInterval(() => { void load(false) }, POLL_INTERVAL_MS)
    return () => clearInterval(t)
  }, [visible, projectId, load])

  const visibleDiagnostics = useMemo(() => {
    const diagnostics = result?.diagnostics ?? []
    return severityFilter === "all"
      ? diagnostics
      : diagnostics.filter((d) => d.severity === severityFilter)
  }, [result, severityFilter])
  const groups = useMemo(
    () => groupByFile(visibleDiagnostics),
    [visibleDiagnostics],
  )
  const totals = useMemo(() => {
    let errors = 0, warnings = 0
    for (const d of result?.diagnostics ?? []) {
      if (d.severity === "error") errors++
      else if (d.severity === "warning") warnings++
    }
    return { errors, warnings }
  }, [result])

  const toggle = (file: string) => {
    setCollapsed(prev => {
      const next = new Set(prev)
      if (next.has(file)) next.delete(file); else next.add(file)
      return next
    })
  }

  // ─── Render branches ──────────────────────────────────────────────────────

  if (!projectId) {
    return (
      <div
        className="flex h-full items-center justify-center p-4 text-[12px] text-[color:var(--ide-muted)]"
        role="status"
      >
        Open a project to see problems.
      </div>
    )
  }

  const hasZero = totals.errors === 0 && totals.warnings === 0
  const isStartingError = error instanceof DiagnosticsApiError && error.code === "service_starting"

  return (
    <div
      className="flex h-full flex-col bg-[color:var(--ide-bg)] text-[color:var(--ide-text)]"
      aria-label="Problems"
    >
      {/* Header */}
      <div className="flex min-h-[36px] items-center justify-between border-b border-[color:var(--ide-border)] px-3 py-1.5">
        <div className="flex items-center gap-3 text-[11px]" aria-live="polite">
          {result ? (
            hasZero ? (
              <span className="text-[color:var(--ide-muted)]">No problems</span>
            ) : (
              <>
                {totals.errors > 0 && (
                  <span className="flex items-center gap-1">
                    <AlertCircle size={12} color="var(--ide-error)" aria-hidden />
                    <span className="text-[color:var(--ide-text)]">{totals.errors}</span>
                    <span className="text-[color:var(--ide-muted)]">
                      {totals.errors === 1 ? "error" : "errors"}
                    </span>
                  </span>
                )}
                {totals.warnings > 0 && (
                  <span className="flex items-center gap-1">
                    <AlertTriangle size={12} color="var(--ide-warning)" aria-hidden />
                    <span className="text-[color:var(--ide-text)]">{totals.warnings}</span>
                    <span className="text-[color:var(--ide-muted)]">
                      {totals.warnings === 1 ? "warning" : "warnings"}
                    </span>
                  </span>
                )}
                {result.fromCache && (
                  <span
                    className="text-[10px] text-[color:var(--ide-muted-strong)]"
                    title={`Last run: ${new Date(result.lastRunAt).toLocaleTimeString()}`}
                  >
                    cached
                  </span>
                )}
              </>
            )
          ) : (
            <span className="text-[color:var(--ide-muted)]">
              {loading ? "Checking for problems…" : "Idle"}
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={() => void load(true)}
          disabled={refreshing || !projectId}
          aria-label="Re-check for problems"
          title="Re-check for problems"
          className="flex h-9 w-9 items-center justify-center rounded text-[color:var(--ide-muted)] hover:bg-[color:var(--ide-hover-subtle)] hover:text-[color:var(--ide-text-strong)] focus-visible:outline focus-visible:outline-1 focus-visible:outline-[color:var(--ide-active-ring)] disabled:opacity-50"
        >
          <RefreshCw size={14} className={refreshing ? "animate-spin" : ""} aria-hidden />
        </button>
      </div>

      {result && (
        <div className="flex items-center gap-1 border-b border-[color:var(--ide-border)] px-3 py-1">
          {(["all", "error", "warning", "info", "hint"] as const).map((filter) => {
            const active = severityFilter === filter
            return (
              <button
                key={filter}
                type="button"
                onClick={() => setSeverityFilter(filter)}
                className={`rounded-full px-2 py-0.5 text-[10px] capitalize ${
                  active
                    ? "bg-[color:var(--ide-hover)] text-[color:var(--ide-text-strong)]"
                    : "text-[color:var(--ide-muted)] hover:bg-[color:var(--ide-hover-subtle)] hover:text-[color:var(--ide-text)]"
                }`}
              >
                {filter}
              </button>
            )
          })}
          <button
            type="button"
            className="ml-auto rounded px-2 py-0.5 text-[10px] text-[color:var(--ide-muted)] hover:bg-[color:var(--ide-hover-subtle)] hover:text-[color:var(--ide-text)]"
            onClick={() => setCollapsed(new Set())}
          >
            Expand all
          </button>
          <button
            type="button"
            className="rounded px-2 py-0.5 text-[10px] text-[color:var(--ide-muted)] hover:bg-[color:var(--ide-hover-subtle)] hover:text-[color:var(--ide-text)]"
            onClick={() => setCollapsed(new Set(groups.map((g) => g.file)))}
          >
            Collapse all
          </button>
        </div>
      )}

      {/* Notes (per-source banners) */}
      {result?.notes && result.notes.length > 0 && (
        <div
          className="border-b border-[color:var(--ide-border)] bg-[color:var(--ide-surface)] px-3 py-1 text-[10px] text-[color:var(--ide-muted)]"
          role="status"
        >
          {result.notes.map(n => (
            <div key={n.source}>
              <span className="uppercase tracking-wide text-[color:var(--ide-muted-strong)]">{n.source}</span>: {n.message}
            </div>
          ))}
        </div>
      )}

      {/* Polling-failure banner — only when we have stale results AND a fresh error.
          Without this, network blips silently froze the list at the last good state. */}
      {error && result && !isStartingError && (
        <div
          className="flex items-center justify-between gap-2 border-b border-[color:var(--ide-border)] bg-[color:var(--ide-surface)] px-3 py-1 text-[11px] text-[color:var(--ide-error)]"
          role="status"
        >
          <span className="truncate">
            Couldn't refresh problems: {error.message}
          </span>
          <button
            type="button"
            onClick={() => void load(true)}
            className="rounded px-2 py-0.5 text-[color:var(--ide-text)] hover:bg-[color:var(--ide-hover)]"
          >
            Retry
          </button>
        </div>
      )}

      {/* Body */}
      <div className="flex-1 overflow-auto">
        {error && !result ? (
          <ErrorState error={error} onRetry={() => void load(true)} />
        ) : loading && !result ? (
          <SkeletonRows />
        ) : groups.length === 0 ? (
          <div className="p-3 text-[12px] text-[color:var(--ide-muted)]">
            No problems detected in workspace.
          </div>
        ) : (
          <ul
            role="tree"
            aria-label="Problems by file"
            className="font-mono text-[12px]"
          >
            {groups.map(g => {
              const isCollapsed = collapsed.has(g.file)
              return (
                <li key={g.file} role="treeitem" aria-expanded={!isCollapsed}>
                  <button
                    type="button"
                    onClick={() => toggle(g.file)}
                    aria-expanded={!isCollapsed}
                    className="flex min-h-[36px] w-full items-center gap-1 px-2 text-left hover:bg-[color:var(--ide-hover)] focus-visible:outline focus-visible:outline-1 focus-visible:outline-[color:var(--ide-active-ring)]"
                  >
                    {isCollapsed
                      ? <ChevronRight size={14} color="var(--ide-muted)" aria-hidden />
                      : <ChevronDown size={14} color="var(--ide-muted)" aria-hidden />
                    }
                    <span className="truncate text-[color:var(--ide-text)]">{basenameOf(g.file)}</span>
                    <span className="ml-1 truncate text-[10px] text-[color:var(--ide-muted)]">
                      {dirnameOf(g.file)}
                    </span>
                    <span className="ml-auto flex items-center gap-2 text-[10px] text-[color:var(--ide-muted)]">
                      {g.errorCount > 0 && (
                        <span
                          className="rounded-full px-1.5 text-[color:var(--ide-error)]"
                          style={{ background: "color-mix(in srgb, var(--ide-error) 22%, transparent)" }}
                          aria-label={`${g.errorCount} ${g.errorCount === 1 ? "error" : "errors"}`}
                        >
                          {g.errorCount}
                        </span>
                      )}
                      {g.warningCount > 0 && (
                        <span
                          className="rounded-full px-1.5 text-[color:var(--ide-warning)]"
                          style={{ background: "color-mix(in srgb, var(--ide-warning) 22%, transparent)" }}
                          aria-label={`${g.warningCount} ${g.warningCount === 1 ? "warning" : "warnings"}`}
                        >
                          {g.warningCount}
                        </span>
                      )}
                    </span>
                  </button>

                  {!isCollapsed && (
                    <ul role="group" aria-label={`Problems in ${basenameOf(g.file)}`}>
                      {g.diagnostics.map(d => (
                        <li key={d.id} role="treeitem">
                          <button
                            type="button"
                            onClick={() => onReveal?.(d.file, d.line, d.column)}
                            onContextMenu={(event) => {
                              event.preventDefault()
                              void navigator.clipboard?.writeText(`${d.file}:${d.line}:${d.column} ${d.message}`)
                            }}
                            disabled={!onReveal}
                            aria-label={`${d.severity} ${d.code ?? ""} ${d.message} at ${basenameOf(d.file)} line ${d.line} column ${d.column}`}
                            title={d.message}
                            className="flex min-h-[32px] w-full items-start gap-2 px-6 py-1 text-left hover:bg-[color:var(--ide-hover)] focus-visible:outline focus-visible:outline-1 focus-visible:outline-[color:var(--ide-active-ring)] disabled:cursor-default disabled:hover:bg-transparent"
                          >
                            <span className="mt-0.5 flex-shrink-0">{severityIcon(d.severity)}</span>
                            <span className="flex-1 truncate text-[color:var(--ide-text)]">{d.message}</span>
                            {d.code && (
                              <span className="flex-shrink-0 text-[10px] text-[color:var(--ide-muted)]">{d.code}</span>
                            )}
                            <span className="flex-shrink-0 text-[10px] tabular-nums text-[color:var(--ide-muted)]">
                              [{d.source}] {d.line}:{d.column}
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </div>
  )
}

// ─── Sub-components ──────────────────────────────────────────────────────────

function SkeletonRows() {
  return (
    <div className="space-y-2 p-3" role="status" aria-label="Checking for problems">
      {[0, 1, 2].map(i => (
        <div key={i} className="flex items-center gap-2">
          <div className="h-3 w-3 animate-pulse rounded bg-[color:var(--ide-border)]" />
          <div className="h-3 flex-1 animate-pulse rounded bg-[color:var(--ide-border)]" />
        </div>
      ))}
    </div>
  )
}

function ErrorState({ error, onRetry }: { error: Error; onRetry: () => void }) {
  const isStarting = error instanceof DiagnosticsApiError && error.code === "service_starting"
  return (
    <div
      className="flex h-full flex-col items-center justify-center gap-2 p-4 text-center text-[12px] text-[color:var(--ide-muted)]"
      role="alert"
    >
      <div className="text-[color:var(--ide-text)]">
        {isStarting ? "Problems service is starting…" : "Couldn't load problems"}
      </div>
      {!isStarting && (
        <div className="max-w-md text-[11px] text-[color:var(--ide-muted)]">{error.message}</div>
      )}
      <button
        type="button"
        onClick={onRetry}
        className="mt-1 inline-flex h-9 items-center rounded border border-[color:var(--ide-border-strong)] px-3 text-[11px] text-[color:var(--ide-text)] hover:bg-[color:var(--ide-hover-subtle)] focus-visible:outline focus-visible:outline-1 focus-visible:outline-[color:var(--ide-active-ring)]"
      >
        Retry
      </button>
    </div>
  )
}

export default Problems
