// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * detected-urls.ts — Auto-detect dev-server URLs in PTY stdout.
 *
 * When a user runs `npm run dev` (or `vite`, `next dev`, `expo`, …) in
 * the agent terminal, the framework prints a "Local: http://…" banner.
 * We tap the PTY output stream, regex-match for the common variants,
 * and surface the discovered URL to the desktop preview UI so the user
 * can open it in one click instead of typing a port.
 *
 * Why server-side: terminal output is already streamed through us for
 * the IDE Output tab and pty WebSocket. Doing detection here means it
 * works regardless of how the dev server was started (chat-spawned,
 * user-typed in the terminal, agent-spawned) and survives a renderer
 * reload — the buffer of "most recent URL per session" persists with
 * the agent-runtime.
 *
 * What this is NOT:
 *   - Not a port scanner. We don't probe; we only observe.
 *   - Not a launcher. We don't start dev servers ourselves.
 *   - Not a proxy. The URL is handed to the renderer verbatim.
 */

const ANSI_ESCAPE_RE = /\x1B\[[0-?]*[ -/]*[@-~]/g

/**
 * Strip ANSI color/cursor escapes before regex matching. Vite uses
 * `chalk` so a typical "Local:" line is actually:
 *
 *     \x1B[32m  ➜  \x1B[39m  \x1B[1mLocal:\x1B[22m   \x1B[36mhttp://localhost:5173/\x1B[39m
 *
 * Without stripping, `Local:\s+(...)` doesn't match because of the
 * cursor-reset between the label and the URL.
 */
function stripAnsi(s: string): string {
  return s.replace(ANSI_ESCAPE_RE, '')
}

/**
 * Pattern set, in priority order. We pick the first match in the
 * chunk; if multiple frameworks print at once the first one wins
 * (callers can listen via `onDetected` to see all of them).
 */
const PATTERNS: RegExp[] = [
  // Vite, Astro, Remix, Vue, Vitest UI, SvelteKit, Solid Start, Nuxt
  //   ➜  Local:   http://localhost:5173/
  //   Local:    http://localhost:3000/
  /(?:^|\s|➜)\s*Local:\s+(https?:\/\/[^\s]+?)\/?(?=[\s\x1B]|$)/im,
  // Next.js (pages router pre-13.4): "started server on 0.0.0.0:3000, url: http://localhost:3000"
  /started server on [^,]*,\s*url:\s+(https?:\/\/[^\s]+)/i,
  // Next.js (app router 13.4+): "▲ Next.js 14.x.y\n   - Local:        http://localhost:3000"
  // — covered by the generic Local: pattern above.
  // Vue CLI legacy: "App running at:" + "  - Local:   http://localhost:8080/"
  /App running at:\s*\n?\s*-?\s*Local:\s+(https?:\/\/[^\s]+)/i,
  // CRA / webpack-dev-server: "Local:            http://localhost:3000"
  // — covered by the generic Local: pattern.
  // Rails: "Listening on http://127.0.0.1:3000"
  /Listening on (https?:\/\/[^\s]+)/i,
  // Django: "Starting development server at http://127.0.0.1:8000/"
  /Starting development server at (https?:\/\/[^\s]+)/i,
  // Flask: "Running on http://127.0.0.1:5000"
  // FastAPI / Uvicorn: "Uvicorn running on http://127.0.0.1:8000"
  /(?:Running|Uvicorn running) on (https?:\/\/[^\s]+)/i,
  // Generic: "Server running at http://…" / "Server listening at http://…"
  /Server (?:running|listening) (?:on|at) (https?:\/\/[^\s]+)/i,
]

export interface DetectedUrl {
  url: string
  /** Source PTY session id, or 'unknown' when the detector is fed raw bytes. */
  sessionId: string
  /** Millisecond epoch when detection fired. */
  detectedAt: number
}

const detectedBySession = new Map<string, DetectedUrl>()
let lastAnyDetection: DetectedUrl | null = null
const listeners = new Set<(d: DetectedUrl) => void>()

// Stream buffers per session — dev servers print the URL line in two
// flushes pretty often (label, then color reset, then URL), so we
// keep a small rolling tail per session and re-run regexes against it.
const tailBuffer = new Map<string, string>()
const TAIL_MAX_BYTES = 8 * 1024 // 8 KB is plenty for any single startup banner

/**
 * Normalize a matched URL: strip trailing slashes/punctuation/ANSI reset
 * fragments, ensure it's parseable.
 */
function normalize(rawUrl: string): string | null {
  if (!rawUrl) return null
  let u = rawUrl
  // Sometimes the regex catches a trailing color/punct/closing bracket.
  u = u.replace(/[\u001b].*$/, '')
  u = u.replace(/[)>\]"'.,;]+$/, '')
  // Strip trailing slash for stable matching, BUT keep it if path has more.
  if (u.endsWith('/') && new URL(u).pathname === '/') {
    u = u.slice(0, -1)
  }
  try {
    const parsed = new URL(u)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    return parsed.toString().replace(/\/$/, '')
  } catch {
    return null
  }
}

/**
 * Feed a chunk of PTY output through the detector. Cheap to call on
 * every onData() emission; it only does work when one of the regexes
 * matches.
 */
export function ingestChunk(sessionId: string, bytes: Uint8Array | string): DetectedUrl | null {
  const text = typeof bytes === 'string' ? bytes : new TextDecoder('utf-8', { fatal: false }).decode(bytes)
  const prev = tailBuffer.get(sessionId) ?? ''
  // Roll the tail with the new chunk, capped so we don't keep megabytes
  // of `bun dev` output in memory.
  let combined = prev + text
  if (combined.length > TAIL_MAX_BYTES) {
    combined = combined.slice(combined.length - TAIL_MAX_BYTES)
  }
  tailBuffer.set(sessionId, combined)

  const cleaned = stripAnsi(combined)
  for (const re of PATTERNS) {
    const match = cleaned.match(re)
    if (!match) continue
    const url = normalize(match[1])
    if (!url) continue
    // Dedupe against the last detection on this session — `npm run dev`
    // often re-prints the banner after HMR / file changes; we don't
    // want to spam listeners. Even on a dedupe we wipe the tail buffer
    // so subsequent chunks aren't matched against the stale banner.
    const prevDetect = detectedBySession.get(sessionId)
    if (prevDetect && prevDetect.url === url) {
      tailBuffer.set(sessionId, '')
      return prevDetect
    }
    const detection: DetectedUrl = {
      url,
      sessionId,
      detectedAt: Date.now(),
    }
    detectedBySession.set(sessionId, detection)
    lastAnyDetection = detection
    // Clear the tail buffer — the URL is captured; if the dev server
    // restarts with a new port we'll pick it up from fresh bytes.
    tailBuffer.set(sessionId, '')
    for (const cb of listeners) {
      try { cb(detection) } catch (err) { console.warn('[detected-urls] listener threw', err) }
    }
    return detection
  }
  return null
}

export function getDetectedForSession(sessionId: string): DetectedUrl | null {
  return detectedBySession.get(sessionId) ?? null
}

/**
 * Most recent detection across all sessions. Useful for the project-
 * level "current detected URL" surface; sessions detected earlier are
 * preserved but only the freshest one is presented as default.
 */
export function getMostRecentDetection(): DetectedUrl | null {
  return lastAnyDetection
}

export function listAllDetections(): DetectedUrl[] {
  return [...detectedBySession.values()].sort((a, b) => b.detectedAt - a.detectedAt)
}

export function clearDetection(sessionId: string): void {
  detectedBySession.delete(sessionId)
  tailBuffer.delete(sessionId)
  if (lastAnyDetection?.sessionId === sessionId) {
    const remaining = listAllDetections()
    lastAnyDetection = remaining[0] ?? null
  }
}

export function onDetectedUrl(cb: (d: DetectedUrl) => void): () => void {
  listeners.add(cb)
  return () => { listeners.delete(cb) }
}

/** Test/maintenance hook: wipe all state. */
export function _resetForTests(): void {
  detectedBySession.clear()
  tailBuffer.clear()
  lastAnyDetection = null
  listeners.clear()
}
