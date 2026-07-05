// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Canvas runtime-health SLO signals.
 *
 * Emits structured log records (routed to SigNoz via the OTEL log sink wired
 * in `@shogo/core`'s instrumentation) so we can track the rate at which the
 * canvas ships code that compiles but crashes at render time — the class of
 * failure that spawns the auto-generated "Debug: runtime error" chats.
 *
 * Two counters make up the SLO (both tagged `slo: 'canvas_runtime_health'`):
 *
 *   - `canvas_runtime_error_escaped` — the browser rendered the app and threw.
 *     This is the SLO numerator: a runtime error reached the user. Emitted
 *     from the `/agent/canvas/error` ingestion endpoint.
 *   - `canvas_typecheck_blocked` — the post-build `tsc --noEmit` gate found
 *     type errors that Vite/esbuild happily transpiled. This measures how
 *     many escapes the gate prevented (a leading indicator that should rise
 *     as escapes fall). Emitted from `canvas-typecheck.ts`.
 *
 * Dashboard math ("Debug: runtime error sessions per 100 canvas projects")
 * is computed in SigNoz from `count(canvas_runtime_error_escaped)` over
 * `count(distinct projectId)`; keep the attribute names below stable so the
 * saved query doesn't drift.
 */

import { createLogger } from '@shogo/shared-runtime'

const log = createLogger('canvas-slo')

/** Stable SLO group tag shared by every event in this module. */
const SLO = 'canvas_runtime_health'

/**
 * Coarse buckets for a runtime/compile error string. Mirrors the classes
 * observed in production ("Debug: runtime error" chats): the vast majority
 * are statically catchable reference/type errors that only escape because
 * the Vite preview build never type-checks. Kept deliberately small so the
 * SigNoz breakdown stays legible.
 */
export type CanvasErrorClass =
  | 'missing_reference' // `X is not defined` / `Cannot find name 'X'` — usually a missing import
  | 'undefined_access' // `Cannot read properties of undefined (reading 'x')`
  | 'not_a_function' // `x is not a function`
  | 'invalid_element' // `Element type is invalid ... got: boolean/object/undefined`
  | 'render_loop' // `Maximum update depth exceeded` / `Too many re-renders`
  | 'hydration' // hydration mismatch
  | 'other'

/**
 * Best-effort classifier over the raw error text. Order matters: the more
 * specific React messages are matched before the generic TypeError shapes so
 * an "Element type is invalid" doesn't get miscounted as `undefined_access`.
 */
export function classifyCanvasError(errorText: string | undefined | null): CanvasErrorClass {
  const e = (errorText ?? '').toLowerCase()
  if (!e) return 'other'
  if (e.includes('element type is invalid')) return 'invalid_element'
  if (e.includes('maximum update depth') || e.includes('too many re-renders')) return 'render_loop'
  if (e.includes('hydrat')) return 'hydration'
  if (e.includes('is not defined') || e.includes('cannot find name')) return 'missing_reference'
  if (e.includes('is not a function')) return 'not_a_function'
  if (e.includes('cannot read propert') || e.includes('reading ') || e.includes('undefined is not')) {
    return 'undefined_access'
  }
  return 'other'
}

function projectId(): string | null {
  return process.env.PROJECT_ID ?? null
}

/**
 * A runtime/compile error reached the rendered canvas (reported by the iframe
 * bridge). The SLO numerator — every one of these is a user-visible crash.
 */
export function recordCanvasRuntimeErrorEscaped(args: {
  phase: string
  error: string
  route?: string | null
}): void {
  try {
    log.warn('canvas runtime error reached the rendered preview', {
      event: 'canvas_runtime_error_escaped',
      slo: SLO,
      projectId: projectId(),
      phase: args.phase,
      errorClass: classifyCanvasError(args.error),
      route: args.route ?? null,
    })
  } catch {
    /* telemetry is best-effort — never throw from the error path */
  }
}

/**
 * The post-build `tsc --noEmit` gate caught type errors that the Vite build
 * transpiled anyway. Measures escapes prevented; `codes`/`classes` let the
 * dashboard see which error families the gate is catching most.
 */
export function recordCanvasTypecheckBlocked(args: {
  errorCount: number
  sampleCodes: string[]
  sampleClasses: CanvasErrorClass[]
}): void {
  try {
    log.warn('tsc --noEmit gate blocked type errors from reaching the preview', {
      event: 'canvas_typecheck_blocked',
      slo: SLO,
      projectId: projectId(),
      errorCount: args.errorCount,
      sampleCodes: args.sampleCodes.slice(0, 10),
      sampleClasses: Array.from(new Set(args.sampleClasses)),
    })
  } catch {
    /* best-effort */
  }
}
