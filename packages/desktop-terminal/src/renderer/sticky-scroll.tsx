// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Sticky-scroll overlay — an absolute-positioned bar at the top of the
 * xterm container that surfaces the **currently running** command. It
 * updates on OSC C (start) / D (end) by subscribing to the tracker's
 * events. Click → scroll to the real prompt line.
 *
 * This module ships two surfaces:
 *
 *   1. **`useStickyScroll(tracker)`** — a tiny hook returning the
 *      sticky state. No DOM. Easy to unit-test by feeding the tracker
 *      events directly.
 *
 *   2. **`<StickyScroll />`** — a thin, unstyled React component that
 *      consumes the hook and renders a `<div>` only when there's
 *      something to show. apps/desktop wraps this with its own
 *      shadcn-styled chrome.
 *
 * `react` is a peer dependency declared in package.json — the renderer
 * package is loaded inside apps/desktop which already has React.
 * Unit tests exercise the pure reducer (`computeStickyState`) and the
 * formatter (`formatElapsed`) directly; the hook + component layers
 * are exercised end-to-end when apps/desktop integrates.
 */

import * as React from 'react'
import type { Command, Osc633Tracker, TrackerEvent } from './osc633-tracker'

// ─── pure state computation ─────────────────────────────────────────────

/**
 * Compute the sticky-scroll state from a tracker snapshot + the most
 * recent tracker event. Returns `null` when nothing should be shown.
 * Exported so we can unit-test the logic without React's renderer.
 */
export interface StickyState {
  command: Command
  /** Best-effort command line for the sticky text. */
  label: string
  /** ms since the command started. */
  elapsedMs: number
}

export function computeStickyState(tracker: Osc633Tracker, now: number = Date.now()): StickyState | null {
  const snap = tracker.snapshot()
  const cur = snap.current
  // Only show the bar when a command is *actually running* — i.e.
  // tracker is past the C mark. Prompt-only states stay invisible.
  if (!cur || cur.state !== 'running') return null
  const label = cur.commandLine || '(running command)'
  const elapsedMs = cur.startedAt !== null ? Math.max(0, now - cur.startedAt) : 0
  return { command: cur, label, elapsedMs }
}

// ─── hook ──────────────────────────────────────────────────────────────

export interface UseStickyScrollOptions {
  tracker: Osc633Tracker
  /** Re-render cadence while running (ms). Default 250. */
  tickMs?: number
  /** Inject a clock for tests. */
  now?: () => number
}

/**
 * React hook. Subscribes to the tracker and re-renders on
 * command-started / command-finished events. While running it also
 * ticks every `tickMs` so the elapsed counter advances. Unsubscribes
 * + clears the timer on unmount.
 */
export function useStickyScroll(opts: UseStickyScrollOptions): StickyState | null {
  const R = React
  const { tracker } = opts
  const tickMs = opts.tickMs ?? 250
  const now = opts.now ?? Date.now

  const [state, setState] = R.useState<StickyState | null>(() => computeStickyState(tracker, now()))

  R.useEffect(() => {
    const refresh = (): void => setState(computeStickyState(tracker, now()))
    const off = tracker.on((ev: TrackerEvent) => {
      if (ev.kind === 'command-started' || ev.kind === 'command-finished') refresh()
    })
    refresh() // initial align in case tracker already has a running command
    const timer: ReturnType<typeof setInterval> = setInterval(() => {
      // Cheap early exit when nothing's running — keeps the timer
      // alive but avoids the setState churn.
      const next = computeStickyState(tracker, now())
      if (next === null) {
        setState((prev: StickyState | null) => (prev === null ? prev : null))
        return
      }
      setState({ ...next })
    }, tickMs)
    return () => {
      off()
      clearInterval(timer)
    }
  }, [tracker, tickMs, now])

  return state
}

// ─── component ─────────────────────────────────────────────────────────

export interface StickyScrollProps {
  tracker: Osc633Tracker
  /** Click on the sticky bar → caller scrolls to that command. */
  onClick?(command: Command): void
  /** Override clock (tests / Storybook). */
  now?: () => number
  /** Refresh cadence (default 250ms). */
  tickMs?: number
  /** Extra class for styling. */
  className?: string
  /**
   * Optional predicate. When provided and returns `true`, the bar
   * stays hidden even if a command is running — VS Code suppresses it
   * once the user has scrolled back down to the live prompt. The host
   * supplies this by comparing `term.buffer.active.viewportY` to
   * `term.buffer.active.baseY` (or by checking `term.buffer.active`
   * whatever you like).
   */
  isAtBottom?(): boolean
  /** Fade-out animation length in ms when the bar dismisses. Default 800. */
  fadeOutMs?: number
}

/**
 * Default rendering — apps/desktop replaces this with its own styled
 * version using shadcn. We keep the markup minimal so it composes
 * cleanly.
 *
 * Phase 7 polish:
 *   • 1px bottom border so the bar reads as a distinct surface, not a
 *     gradient overlay on the first row of output.
 *   • Hide-when-at-bottom: when the host predicate says the user is
 *     already pinned to the live prompt, the bar disappears (matches
 *     VS Code's behavior — no point pinning what's already visible).
 *   • 800ms fade-out on transition from running → done: instead of
 *     yanking the bar off-screen, we render the last known state with
 *     opacity 0 and a `transition: opacity 800ms`. After the timer
 *     fires we drop the element entirely.
 */
export function StickyScroll(props: StickyScrollProps): unknown {
  const R = React
  const state = useStickyScroll({ tracker: props.tracker, tickMs: props.tickMs, now: props.now })
  const fadeOutMs = props.fadeOutMs ?? 800
  const atBottom = props.isAtBottom?.() ?? false

  // The "effective" state is what we actually want to render. When the
  // user is at bottom OR no command is running, we want to hide — but
  // if we just dropped a previous state, hold it through the fade.
  const liveShouldShow = state !== null && !atBottom
  const [phase, setPhase] = R.useState<'hidden' | 'shown' | 'fading'>(liveShouldShow ? 'shown' : 'hidden')
  const lastStateRef = R.useRef<StickyState | null>(state)
  if (state !== null) lastStateRef.current = state

  R.useEffect(() => {
    if (liveShouldShow) {
      setPhase('shown')
      return
    }
    if (phase === 'shown') {
      setPhase('fading')
      const t: ReturnType<typeof setTimeout> = setTimeout(() => setPhase('hidden'), fadeOutMs)
      return () => clearTimeout(t)
    }
  }, [liveShouldShow, phase, fadeOutMs])

  if (phase === 'hidden') return null
  const display = liveShouldShow ? (state as StickyState) : (lastStateRef.current as StickyState)
  if (!display) return null

  return R.createElement(
    'div',
    {
      role: 'status',
      'aria-live': 'polite',
      'data-testid': 'shogo-sticky-scroll',
      'data-phase': phase,
      className: props.className,
      onClick: () => props.onClick?.(display.command),
      style: {
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        zIndex: 5,
        font: '12px / 1.4 system-ui',
        padding: '4px 8px',
        cursor: 'pointer',
        background: 'rgba(0,0,0,0.6)',
        color: '#fff',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        borderBottom: '1px solid rgba(255,255,255,0.12)',
        opacity: phase === 'fading' ? 0 : 1,
        transition: `opacity ${fadeOutMs}ms ease-out`,
        pointerEvents: phase === 'fading' ? 'none' : 'auto',
      },
    },
    R.createElement('span', { 'aria-hidden': 'true' }, '⏵ '),
    R.createElement('span', null, display.label),
    R.createElement(
      'span',
      { style: { float: 'right', opacity: 0.7 } },
      formatElapsed(display.elapsedMs),
    ),
  )
}

/** Pretty-print elapsed ms as `Ns` / `Mm Ns` / `Hh Mm`. Exported for tests. */
export function formatElapsed(ms: number): string {
  if (ms < 1000) return '0s'
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  const rs = s - m * 60
  if (m < 60) return `${m}m ${rs}s`
  const h = Math.floor(m / 60)
  const rm = m - h * 60
  return `${h}h ${rm}m`
}
