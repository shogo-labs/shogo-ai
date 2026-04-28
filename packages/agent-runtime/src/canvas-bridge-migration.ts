// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Canvas bridge migration
 * ---------------------------------------------------------------------------
 * Older workspaces have a fat `src/main.tsx` that bakes the entire iframe
 * bridge (update toast, SSE listener, theme handlers, capability detection,
 * error forwarders) into the user-visible bundle. That code is now served
 * live from the agent runtime — see static/canvas-bridge.js — so the
 * workspace's `main.tsx` should only render <App />.
 *
 * On every workspace boot (in canvas-code mode), this migration:
 *   1. Reads `<workspace>/.shogo-runtime-version` if present.
 *   2. Reads `<workspace>/src/main.tsx` if present.
 *   3. If the marker matches the current version AND the file's contents
 *      already match the canonical slim version, exits — nothing to do.
 *   4. Otherwise overwrites `src/main.tsx` with the canonical version and
 *      writes the marker. The caller should then trigger a rebuild so the
 *      newly slim app picks up the bridge from the next page load.
 *
 * The rewrite uses raw `fs.writeFileSync` (not `gateway-tools.write_file`),
 * so the protected-files gate doesn't block it. Self-healing is the whole
 * point: if anything ever drifts the file (older agent-runtime, escape
 * hatch, manual edit), the next workspace boot puts it back.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { dirname, join } from 'path'

/**
 * Bump this whenever the canonical slim main.tsx contract changes (e.g. we
 * add a new global like ShogoErrorBoundary that requires a different render
 * call). Workspaces with a marker < this version get re-migrated.
 *
 * v2: ShogoErrorBoundary.tsx is now also Shogo-managed and seeded by this
 * migration. Older workspaces (marker = 1) had their main.tsx rewritten to
 * import './ShogoErrorBoundary' but the file itself was never written —
 * this bump heals them.
 */
export const RUNTIME_BRIDGE_VERSION = 2

const VERSION_MARKER_FILE = '.shogo-runtime-version'
const MAIN_TSX_RELATIVE = 'src/main.tsx'
const ERROR_BOUNDARY_RELATIVE = 'src/ShogoErrorBoundary.tsx'

/**
 * Canonical slim main.tsx. Must stay in lockstep with the source-of-truth
 * file at templates/runtime-template/src/main.tsx — they are intentionally
 * identical so a fresh seed and a migrated workspace produce the exact same
 * file on disk.
 */
export const CANONICAL_MAIN_TSX = `// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
import { createRoot } from 'react-dom/client'
import App from './App'
import { ShogoErrorBoundary } from './ShogoErrorBoundary'
import './index.css'

// Render the user's React app. Everything else — the update toast, the
// parent <-> iframe theme bridge, capability detection, async error
// forwarding, the canvas-ready handshake — is owned by the canvas-bridge
// script that the agent runtime injects into the HTML served to the iframe.
// See packages/agent-runtime/static/canvas-bridge.js.
//
// DO NOT add bridge concerns back into this file. It is a Shogo-managed
// platform contract: in canvas-code mode, write_file / edit_file / delete_file
// reject mutations to src/main.tsx (see packages/agent-runtime/src/protected-files.ts),
// and a self-heal pass at workspace boot rewrites the file to this canonical
// shape if it has drifted.

const root = document.getElementById('root')
if (root) {
  createRoot(root).render(
    <ShogoErrorBoundary>
      <App />
    </ShogoErrorBoundary>,
  )
}
`

/**
 * Canonical ShogoErrorBoundary. Catches React render errors inside the user's
 * app, posts `canvas-error` to the parent so the agent can see/fix it, and
 * renders a clean recoverable fallback instead of a white screen.
 *
 * Must stay in lockstep with templates/runtime-template/src/ShogoErrorBoundary.tsx.
 * This is a Shogo-managed file: in canvas-code mode the protected-files gate
 * blocks agent edits, and this migration rewrites it on workspace boot if it
 * has drifted.
 */
export const CANONICAL_SHOGO_ERROR_BOUNDARY_TSX = `// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
import { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props {
  children: ReactNode
}

interface State {
  hasError: boolean
  error: Error | null
  showDetails: boolean
}

function reportToParent(error: string, phase: string = 'runtime') {
  if (typeof window === 'undefined' || window.parent === window) return
  try {
    window.parent.postMessage({ type: 'canvas-error', phase, error }, '*')
  } catch {
    // ignore — parent may be cross-origin without listener
  }
}

export class ShogoErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null, showDetails: false }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    const stack = error.stack ?? ''
    const componentStack = info.componentStack ?? ''
    reportToParent(\`\${error.message}\\n\${stack}\\n\${componentStack}\`.trim())
    console.error('[ShogoErrorBoundary]', error, info)
  }

  handleRetry = () => {
    this.setState({ hasError: false, error: null, showDetails: false })
  }

  handleReload = () => {
    window.location.reload()
  }

  toggleDetails = () => {
    this.setState((s) => ({ showDetails: !s.showDetails }))
  }

  render() {
    if (!this.state.hasError) return this.props.children

    const err = this.state.error
    const message = err?.message ?? 'Unknown error'
    const stack = err?.stack ?? ''

    return (
      <div
        style={{
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '24px',
          fontFamily:
            "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
          background: 'var(--background, #fafafa)',
          color: 'var(--foreground, #111)',
          boxSizing: 'border-box',
        }}
      >
        <div
          style={{
            maxWidth: '520px',
            width: '100%',
            border: '1px solid var(--border, #e5e5e5)',
            borderRadius: '16px',
            padding: '24px',
            background: 'var(--card, #fff)',
            boxShadow: '0 4px 24px rgba(0, 0, 0, 0.06)',
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '12px',
              marginBottom: '12px',
            }}
          >
            <div
              style={{
                width: '40px',
                height: '40px',
                borderRadius: '10px',
                background: 'rgba(245, 158, 11, 0.12)',
                color: '#d97706',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: '20px',
                fontWeight: 700,
              }}
              aria-hidden
            >
              !
            </div>
            <h1 style={{ fontSize: '18px', fontWeight: 600, margin: 0 }}>
              Something went wrong
            </h1>
          </div>

          <p
            style={{
              fontSize: '14px',
              lineHeight: 1.5,
              color: 'var(--muted-foreground, #666)',
              margin: '0 0 16px 0',
            }}
          >
            The app crashed while rendering. You can try again, or reload the
            page. Shogo has been notified.
          </p>

          <div
            style={{
              fontSize: '13px',
              fontFamily:
                "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
              padding: '10px 12px',
              borderRadius: '8px',
              background: 'var(--muted, #f4f4f5)',
              color: 'var(--foreground, #111)',
              marginBottom: '12px',
              wordBreak: 'break-word',
            }}
          >
            {message}
          </div>

          {stack && (
            <>
              <button
                type="button"
                onClick={this.toggleDetails}
                style={{
                  background: 'transparent',
                  border: 'none',
                  padding: 0,
                  fontSize: '12px',
                  color: 'var(--muted-foreground, #666)',
                  cursor: 'pointer',
                  marginBottom: '12px',
                  textDecoration: 'underline',
                }}
              >
                {this.state.showDetails ? 'Hide details' : 'Show details'}
              </button>
              {this.state.showDetails && (
                <pre
                  style={{
                    fontSize: '11.5px',
                    lineHeight: 1.4,
                    fontFamily:
                      "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                    padding: '12px',
                    borderRadius: '8px',
                    background: 'var(--muted, #f4f4f5)',
                    color: 'var(--foreground, #111)',
                    margin: '0 0 16px 0',
                    overflow: 'auto',
                    maxHeight: '240px',
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                  }}
                >
                  {stack}
                </pre>
              )}
            </>
          )}

          <div style={{ display: 'flex', gap: '8px' }}>
            <button
              type="button"
              onClick={this.handleRetry}
              style={{
                flex: 1,
                cursor: 'pointer',
                fontFamily: 'inherit',
                fontSize: '14px',
                fontWeight: 600,
                padding: '10px 16px',
                borderRadius: '10px',
                border: 'none',
                background: 'var(--primary, #111)',
                color: 'var(--primary-foreground, #fff)',
              }}
            >
              Try again
            </button>
            <button
              type="button"
              onClick={this.handleReload}
              style={{
                flex: 1,
                cursor: 'pointer',
                fontFamily: 'inherit',
                fontSize: '14px',
                fontWeight: 600,
                padding: '10px 16px',
                borderRadius: '10px',
                border: '1px solid var(--border, #e5e5e5)',
                background: 'transparent',
                color: 'var(--foreground, #111)',
              }}
            >
              Reload
            </button>
          </div>
        </div>
      </div>
    )
  }
}
`

export interface MigrationResult {
  /** True if any managed file was rewritten on disk during this call. */
  rewrote: boolean
  /** Workspace-relative paths that were rewritten (if any). */
  paths?: string[]
  /** Absolute path of the primary file that was rewritten (if any). Kept for
   *  backwards compatibility with the v1 single-file caller. */
  path?: string
  /** Reason logged for observability. */
  reason: 'no-main-tsx' | 'already-canonical' | 'version-bump' | 'content-drift'
}

/**
 * Idempotent migration pass. Safe to call on every workspace boot. Returns
 * a `MigrationResult` describing what happened so the caller can decide
 * whether to trigger a rebuild.
 *
 * Manages two files in lockstep:
 *  - `src/main.tsx`              — canonical slim entry that imports the boundary.
 *  - `src/ShogoErrorBoundary.tsx` — companion error boundary the entry depends on.
 *
 * Both are Shogo-managed: the canonical content is rewritten on version bump
 * or content drift. If `main.tsx` exists but the boundary file is missing
 * (true for any workspace migrated under v1), this pass writes the boundary
 * so the import resolves and Vite stops failing.
 */
export function migrateRuntimeTemplate(workspaceDir: string): MigrationResult {
  const mainTsxPath = join(workspaceDir, MAIN_TSX_RELATIVE)
  const errorBoundaryPath = join(workspaceDir, ERROR_BOUNDARY_RELATIVE)
  const markerPath = join(workspaceDir, VERSION_MARKER_FILE)

  // No main.tsx → nothing to migrate (workspace not seeded yet, or not a
  // canvas-code project at all). The marker is also untouched in this case.
  if (!existsSync(mainTsxPath)) {
    return { rewrote: false, reason: 'no-main-tsx' }
  }

  let currentVersion = 0
  if (existsSync(markerPath)) {
    try {
      const raw = readFileSync(markerPath, 'utf-8').trim()
      const parsed = parseInt(raw, 10)
      if (Number.isFinite(parsed)) currentVersion = parsed
    } catch { /* missing / unreadable marker → treat as version 0 */ }
  }

  let currentMain = ''
  try {
    currentMain = readFileSync(mainTsxPath, 'utf-8')
  } catch {
    return { rewrote: false, reason: 'no-main-tsx' }
  }

  let currentBoundary: string | null = null
  if (existsSync(errorBoundaryPath)) {
    try {
      currentBoundary = readFileSync(errorBoundaryPath, 'utf-8')
    } catch { /* unreadable → treat as missing, will be rewritten */ }
  }

  const mainCanonical = currentMain === CANONICAL_MAIN_TSX
  const boundaryCanonical = currentBoundary === CANONICAL_SHOGO_ERROR_BOUNDARY_TSX

  // Marker is up to date AND both files match canonical → no-op.
  if (currentVersion === RUNTIME_BRIDGE_VERSION && mainCanonical && boundaryCanonical) {
    return { rewrote: false, reason: 'already-canonical', path: mainTsxPath }
  }

  const rewritten: string[] = []

  if (!mainCanonical) {
    writeFileSync(mainTsxPath, CANONICAL_MAIN_TSX, 'utf-8')
    rewritten.push(MAIN_TSX_RELATIVE)
  }

  if (!boundaryCanonical) {
    try {
      mkdirSync(dirname(errorBoundaryPath), { recursive: true })
    } catch { /* dir likely already exists */ }
    writeFileSync(errorBoundaryPath, CANONICAL_SHOGO_ERROR_BOUNDARY_TSX, 'utf-8')
    rewritten.push(ERROR_BOUNDARY_RELATIVE)
  }

  // Write/refresh the marker. Best-effort; failure here doesn't roll back
  // the file writes — next boot will just rewrite again, which is fine.
  try {
    mkdirSync(dirname(markerPath), { recursive: true })
    writeFileSync(markerPath, String(RUNTIME_BRIDGE_VERSION) + '\n', 'utf-8')
  } catch (err) {
    console.warn(`[canvas-bridge-migration] Failed to write marker ${markerPath}:`, (err as Error).message)
  }

  const reason: MigrationResult['reason'] =
    currentVersion < RUNTIME_BRIDGE_VERSION ? 'version-bump' : 'content-drift'

  if (rewritten.length === 0) {
    // Edge case: marker was stale but content was already canonical. Treat as
    // a version-bump for observability but no rebuild is needed.
    return { rewrote: false, reason, path: mainTsxPath, paths: [] }
  }

  console.log(
    `[canvas-bridge-migration] Rewrote ${rewritten.join(', ')} ` +
    `(workspace=${workspaceDir}, was-version=${currentVersion}, now-version=${RUNTIME_BRIDGE_VERSION}, reason=${reason})`
  )

  return { rewrote: true, path: mainTsxPath, paths: rewritten, reason }
}
