// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * production_web Sentry noise filter.
 *
 * These high-volume issues are environmental (preview iframe, transient
 * backend/network, browser-extension DOM races, stale-deploy chunk loads), not
 * Shogo code defects — left unfiltered they bury real regressions in the
 * dashboard and burn quota. Each branch maps to a specific issue confirmed
 * during Sentry triage.
 *
 * Extracted from `app/_layout.tsx` so the classification is unit-testable
 * without booting the Sentry SDK / React Native. The event shape is described
 * structurally (a subset of `@sentry/*` `ErrorEvent`) so the filter has no
 * runtime dependency on the SDK.
 */

export interface NoiseFilterFrame {
  filename?: string
}

export interface NoiseFilterExceptionValue {
  type?: string
  value?: string
  stacktrace?: { frames?: NoiseFilterFrame[] }
}

export interface NoiseFilterEvent {
  message?: unknown
  exception?: { values?: NoiseFilterExceptionValue[] }
  request?: { url?: unknown }
  tags?: Record<string, unknown> | null
}

/**
 * Tag key stamped on DELIBERATE Shogo captures (e.g. chat stream-error
 * telemetry). Kept in sync with `@shogo/shared-app/chat`'s `SHOGO_TELEMETRY_TAG`
 * — duplicated as a literal here so this module has no cross-package import and
 * stays trivially unit-testable.
 */
const SHOGO_TELEMETRY_TAG = 'shogo_telemetry'

export function isNoiseEvent(event: NoiseFilterEvent): boolean {
  // Never drop an intentional Shogo capture. These carry a marker tag and rich
  // context precisely BECAUSE the raw message (e.g. "Failed to fetch",
  // "TimeoutError") overlaps the generic transient-network noise below that we
  // filter for UNOWNED global rejections. Without this bypass we'd silence the
  // very chat transport-failure telemetry we added to stop silent failures.
  if (event.tags && event.tags[SHOGO_TELEMETRY_TAG] != null) return false

  const values = event.exception?.values ?? []
  const messages = values
    .map((v) => `${v.type ?? ''}: ${v.value ?? ''}`)
    .concat(typeof event.message === 'string' ? [event.message] : [])
  const frames = values.flatMap((v) => v.stacktrace?.frames ?? [])
  const reqUrl = typeof event.request?.url === 'string' ? event.request.url : ''

  // 1. Preview-iframe failures (top issue by volume). The sandboxed preview
  //    app injects `frame_ant.js`, which fetches its own origin
  //    (<uuid>.preview.shogo.ai). While the preview is booting / being torn
  //    down those reject with "Failed to fetch" — surfaced here but owned by
  //    the preview runtime, not studio.
  const PREVIEW_HOST_RE = /(?:preview--[^.\s/]+|[^.\s/]+\.preview)\.shogo\.ai/i
  const isPreviewIframe =
    frames.some((f) => (f.filename ?? '').includes('frame_ant')) ||
    messages.some((m) => PREVIEW_HOST_RE.test(m)) ||
    PREVIEW_HOST_RE.test(reqUrl)
  if (isPreviewIframe) return true

  // 2. Transient backend availability / network — server health, not a
  //    client bug. The SDK surfaces 5xx as ShogoError; `AbortSignal.timeout`
  //    surfaces as TimeoutError; dropped/blocked connections as
  //    "Failed to fetch" / "Load failed" / "NetworkError".
  const isTransientBackend = messages.some(
    (m) =>
      /Request failed with status 50[234]\b/.test(m) ||
      /\bTimeoutError\b/.test(m) ||
      /signal timed out/i.test(m) ||
      /Failed to fetch\b/.test(m) ||
      /\bLoad failed\b/.test(m) ||
      /NetworkError when attempting to fetch/i.test(m),
  )
  if (isTransientBackend) return true

  // 3. Browser-extension DOM races (e.g. Google Translate mutates the
  //    React-owned DOM, then React's insertBefore/removeChild can't find the
  //    node). Not reproducible in-app and unfixable from our side.
  const isExtensionDomRace = messages.some(
    (m) =>
      /Failed to execute '(insertBefore|removeChild)' on 'Node'/.test(m) &&
      /not a child of this node|node to be removed is not a child/.test(m),
  )
  if (isExtensionDomRace) return true

  // 4. Lazy chunk-load failures (Sentry REACT-3K). Expo/Metro serve
  //    content-hashed JS chunks; after a deploy a client still running the
  //    previous index requests a chunk hash that no longer exists (or hits a
  //    transient CDN/network blip), so the dynamic `import()` rejects with
  //    `AsyncRequireError: Loading module …-<hash>.js failed`. It also arrives
  //    from third-party lazy boundaries we don't control (e.g. streamdown's
  //    syntax highlighter). Environmental and self-healing on reload — not a
  //    Shogo defect.
  const isChunkLoadFailure = messages.some(
    (m) =>
      /AsyncRequireError/.test(m) ||
      /Loading module .+ failed/i.test(m) ||
      /Loading chunk \S+ failed/i.test(m) ||
      /Importing a module script failed/i.test(m) ||
      /error loading dynamically imported module/i.test(m) ||
      /Failed to fetch dynamically imported module/i.test(m),
  )
  if (isChunkLoadFailure) return true

  // 5. Monaco `LeakageMonitor` diagnostic (Sentry REACT-1B). Monaco's Emitter
  //    logs a synthetic `Error("[NNN] potential listener LEAK detected, having
  //    N listeners already")` once a single emitter passes a heuristic
  //    threshold (~175/200). It is a DEV diagnostic surfaced through
  //    `console.error` from deep inside `vs/editor.api` — every frame is Monaco
  //    internal (observable `addObserver`/`onFirstObserverAdded` +
  //    instantiation-service `createInstance`), with zero Shogo frames, so it is
  //    not actionable from the report and not a user-facing failure. Long IDE
  //    sessions that open many files legitimately accrue listeners on shared
  //    services. Drop the diagnostic; a genuine leak needs live-Monaco
  //    instrumentation to localize, not these symbol-less stacks.
  const isMonacoListenerLeak = messages.some((m) =>
    /potential listener LEAK detected/i.test(m),
  )
  if (isMonacoListenerLeak) return true

  return false
}
