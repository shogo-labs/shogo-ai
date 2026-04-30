// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Vite plugin that pushes build/HMR errors into the diagnostics build buffer.
 *
 * Wire-up: register the plugin in the workspace's `vite.config.ts` (the
 * runtime template seeds this so users don't have to opt in):
 *
 *   import { shogoDiagnosticsPlugin } from "@shogo/agent-runtime/vite-error-bridge"
 *
 *   export default defineConfig({
 *     plugins: [react(), shogoDiagnosticsPlugin()],
 *   })
 *
 * The plugin reads the project id from `process.env.PROJECT_ID` (set by the
 * runtime's onAssign) and routes errors to the same buffer the diagnostics
 * router reads. A successful HMR update clears the buffer for that project,
 * so resolved errors disappear from the Problems tab automatically.
 *
 * No network calls — both producer and consumer live in the same process.
 *
 * v1 status: this plugin file ships with the runtime, but is NOT yet
 * auto-registered in the seeded workspace `vite.config.ts`. Until v2, the
 * build-error source returns an empty array and the Problems tab surfaces
 * TS + ESLint diagnostics only.
 *
 * KNOWN PROCESS-BOUNDARY DEFECT (must be solved in v2):
 *   The runtime pod runs Vite as a *separate* child process from the Hono
 *   server that owns `getBuildErrors`. The buffer in
 *   `diagnostics-build-buffer.ts` lives in the Hono process; the writer in
 *   this plugin would live in the Vite child. They share no memory, so
 *   `recordBuildError` here would never be visible to the diagnostics
 *   reader. None of the previously-listed wiring options (add as workspace
 *   dep / inline into template / `--config` override) fix this on their
 *   own — they all still split producer and consumer across processes.
 *
 * Wiring strategies that DO work (pick one in v2):
 *   A) IPC over HTTP — plugin POSTs to `http://127.0.0.1:<runtime-port>/internal/build-error`
 *      with the runtime auth secret. Cheap, language-agnostic, decoupled.
 *   B) Shared file — plugin appends JSON lines to `<workspace>/.shogo/build-errors.log`
 *      and the diagnostics reader tails the file (simple, no port coupling).
 *   C) Make the runtime own the Vite dev server (programmatic `createServer`)
 *      and register this plugin in-process. Biggest refactor; cleanest.
 *
 * Until one of A/B/C lands, treat this file as scaffolding. The unit tests
 * directly call `recordBuildError` to exercise the read path; the writer
 * path is only reachable via tests that spawn an actual Vite child, which
 * we deliberately don't ship in the unit suite.
 */

import { recordBuildError, clearBuildErrors } from "@shogo/shared-runtime"

// Vite's `Plugin` type isn't statically importable here without making
// vite a hard dep. We type loosely; consumers of this plugin already have
// vite installed and will see the right shape via duck typing.
interface VitePluginShape {
  name: string
  configureServer?: (server: any) => void
  handleHotUpdate?: (ctx: any) => any
}

export interface ShogoDiagnosticsPluginOptions {
  /** Override projectId (defaults to PROJECT_ID env var). */
  projectId?: string
  /** When true, also log captured errors to the runtime stdout. Default: false. */
  verbose?: boolean
}

interface ViteErrorPayload {
  err: {
    message?: string
    id?: string
    loc?: { file?: string; line?: number; column?: number }
    plugin?: string
    code?: string
  }
}

export function shogoDiagnosticsPlugin(options: ShogoDiagnosticsPluginOptions = {}): VitePluginShape {
  const projectId = options.projectId ?? process.env.PROJECT_ID ?? ""
  const verbose = !!options.verbose

  return {
    name: "shogo:diagnostics",

    configureServer(server: any) {
      if (!projectId) return
      // Capture transform / load errors emitted to the HMR client.
      server.ws?.on?.("vite:error", (payload: ViteErrorPayload) => {
        const err = payload?.err ?? {}
        recordBuildError(projectId, {
          file: err.loc?.file ?? err.id,
          line: err.loc?.line,
          column: err.loc?.column,
          code: err.plugin ? `vite:${err.plugin}` : "vite",
          message: err.message ?? "Vite build error",
        })
        if (verbose) {
          console.warn(`[shogo:diagnostics] captured vite:error in ${err.loc?.file ?? err.id}: ${err.message}`)
        }
      })
    },

    /**
     * Vite calls `handleHotUpdate` for every successful HMR pass. We use that
     * as a signal that the previously captured errors are likely resolved —
     * clearing the buffer means the Problems tab refreshes to "no problems"
     * the next time the user polls. If a fresh error fires immediately after
     * this hook, the `vite:error` handler above repopulates the buffer.
     *
     * NOTE: this is heuristic. A user can still see a stale entry briefly if
     * they look at the tab between the error and the corresponding HMR
     * recovery. The 30s server-side cache TTL bounds the staleness.
     */
    handleHotUpdate() {
      if (!projectId) return
      clearBuildErrors(projectId)
    },
  }
}

export default shogoDiagnosticsPlugin
