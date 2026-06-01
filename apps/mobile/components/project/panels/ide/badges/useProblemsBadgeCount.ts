// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Desktop-only hook that keeps the Activity Bar's Problems badge live
 * even when the Problems panel itself isn't open.
 *
 * Why this exists separately from Problems.tsx's own polling:
 *
 *   Problems.tsx already polls fetchDiagnostics — but only while the tab
 *   is visible. When the bottom panel is closed (typical), no fetches go
 *   out and the activity-bar badge would silently freeze at its last
 *   value. VS Code keeps its badge live regardless of which panel is
 *   open, and we want the same here.
 *
 *   This hook does a slow, independent poll (default 30s) so the badge
 *   is fresh-ish without piling up requests. When the Problems tab is
 *   open, both polls fire — that's one extra small request every 30s,
 *   not enough to justify the plumbing of shared state.
 *
 * Contract:
 *   - When `enabled` is false (web / mobile, or no projectId), the hook
 *     never fetches and always returns { count: 0, severity: null }.
 *   - Polling stops on unmount and on projectId change. A stale response
 *     for a previous projectId is discarded via an `alive` flag.
 *   - DiagnosticsApiError with code 'service_starting' is treated as
 *     "no data yet" — count stays at its previous value rather than
 *     flickering to 0.
 */

import { useEffect, useRef, useState } from "react"

import {
  DiagnosticsApiError,
  fetchDiagnostics,
} from "../../../../../lib/diagnostics-api"
import { problemsBadge, type ProblemsBadgeResult } from "./formatBadge"

const DEFAULT_INTERVAL_MS = 30_000

export interface UseProblemsBadgeOptions {
  projectId: string | null | undefined
  enabled: boolean
  /** Override poll cadence for tests / future tuning. */
  intervalMs?: number
  /**
   * Inject the fetch implementation. Defaults to the module-level
   * `fetchDiagnostics`. Exposed so tests can drive deterministic
   * responses (success / unchanged / DiagnosticsApiError / generic
   * throw) without depending on bun-test's mock-module cache semantics,
   * which are order-sensitive across the wider test suite. Production
   * code MUST NOT pass this — the default keeps the hook's contract
   * (and the BUG-004 fix) identical to its single-import history.
   */
  fetchImpl?: typeof fetchDiagnostics
}

export function useProblemsBadgeCount(
  opts: UseProblemsBadgeOptions,
): ProblemsBadgeResult {
  const { projectId, enabled, intervalMs = DEFAULT_INTERVAL_MS, fetchImpl = fetchDiagnostics } = opts
  const [state, setState] = useState<ProblemsBadgeResult>({ count: 0, severity: null })
  const lastRunAtRef = useRef<string | null>(null)

  useEffect(() => {
    if (!enabled || !projectId) {
      // Hard reset on disable so a previous projectId's count doesn't
      // linger as we transition states.
      setState({ count: 0, severity: null })
      lastRunAtRef.current = null
      return
    }

    let alive = true
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null

    // Reset cache on every effect run so a stale lastRunAt from a previous
    // projectId can't pollute the first fetch of a fresh one (would
    // otherwise risk a misleading "unchanged" response that leaves the
    // badge frozen on the wrong project's count).
    lastRunAtRef.current = null

    const tick = async () => {
      try {
        const since = lastRunAtRef.current ?? undefined
        const result = await fetchImpl(projectId, { since })
        if (!alive) return
        if ("unchanged" in result) {
          // Server says nothing changed — keep prior count.
          lastRunAtRef.current = result.lastRunAt
        } else {
          lastRunAtRef.current = result.lastRunAt
          setState(problemsBadge(result.diagnostics))
        }
      } catch (e) {
        if (!alive) return
        if (e instanceof DiagnosticsApiError && e.code === "service_starting") {
          // Pod warming — keep prior count, just try again later.
        } else {
          // Any other error: don't flicker, just retry on next tick.
          // eslint-disable-next-line no-console
          console.warn("[shogo-ide/badges] diagnostics poll failed:", e)
        }
      } finally {
        if (alive) {
          timeoutHandle = setTimeout(tick, intervalMs)
        }
      }
    }

    // Kick off immediately so the badge appears before the first 30s pass.
    void tick()

    return () => {
      alive = false
      if (timeoutHandle !== null) clearTimeout(timeoutHandle)
    }
  }, [projectId, enabled, intervalMs, fetchImpl])

  return state
}
