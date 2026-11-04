// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { useCallback, useRef } from 'react'

/** Returned instead of a value when a newer request for the same panel won. */
export const SUPERSEDED: unique symbol = Symbol('superseded')

/**
 * A per-panel request ticket (SHO-311 plan §5).
 *
 * Each panel on the admin pages loads from its own effect, so paging
 * 1 → 2 → 3 quickly leaves three requests in flight. Without a ticket the
 * response to page 1 can land last and paint page 1's rows under page 3's
 * pager. `track` stamps each request and resolves to `SUPERSEDED` when a newer
 * one has started, so a stale response is dropped instead of applied.
 *
 * One hook instance per panel; the returned function is stable, so it can sit
 * in the loader's dependency list without re-running the effect.
 *
 *   const track = usePanelSequence()
 *   const loadRows = useCallback(async () => {
 *     setRows((s) => ({ ...s, loading: true }))
 *     const data = await track(() => fetchAdminJson<Rows>(path, params))
 *     if (data === SUPERSEDED) return
 *     setRows({ data, loading: false })
 *   }, [page, track])
 */
export function usePanelSequence() {
  const latest = useRef(0)

  return useCallback(async function track<T>(
    run: () => Promise<T>,
  ): Promise<T | typeof SUPERSEDED> {
    latest.current += 1
    const ticket = latest.current
    const value = await run()
    return ticket === latest.current ? value : SUPERSEDED
  }, [])
}
