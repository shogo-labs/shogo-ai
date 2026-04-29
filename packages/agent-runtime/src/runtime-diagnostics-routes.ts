// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Runtime-pod diagnostics routes.
 *
 * The pod IS one project, so the URL surface is collapsed:
 *
 *   API surface (apps/api):    /api/projects/:projectId/diagnostics
 *   Runtime surface (this):    /diagnostics
 *
 * The handlers themselves are the shared `diagnosticsRoutes` factory from
 * `apps/api/src/routes/diagnostics.ts` — we just adapt the URL by rewriting
 * `/diagnostics` → `/projects/<currentProjectId>/diagnostics` before
 * forwarding to the factory's router. Same source of truth, no drift.
 *
 * Mounted in `packages/agent-runtime/src/server.ts` BEFORE the SPA static
 * fallback (`app.get('*')` at the bottom). `/diagnostics` is also added to
 * `authPrefixes` and to the SPA fallback's skip-list, so:
 *
 *   - GET  /diagnostics with valid `x-runtime-token` → handled here
 *   - GET  /diagnostics without token                → 401 from auth middleware
 *   - GET  /diagnostics-foo (typo, no match here)    → notFound, NOT index.html
 *
 * That last point is the staging-404 trap PR #458 fixed for the terminal —
 * we honor it from day one for the diagnostics routes.
 */

import { Hono } from "hono"
import { dirname, basename } from "path"
import { diagnosticsRoutes } from "@shogo/shared-runtime"

export interface RuntimeDiagnosticsRoutesConfig {
  /** Absolute path to the workspace directory (per-project mount or overlay). */
  workspaceDir: string
  /**
   * Returns the current project id assigned to this pod. Reads from
   * `runtimeState.currentProjectId`; passed as a function so the route stays
   * correct after pool re-assignments.
   */
  getCurrentProjectId: () => string | null | undefined
}

export function runtimeDiagnosticsRoutes(config: RuntimeDiagnosticsRoutesConfig) {
  const { workspaceDir, getCurrentProjectId } = config

  // The shared factory wants `${workspacesDir}/${projectId}` as the project
  // dir — so we hand it the parent and let it append the projectId we
  // synthesize from runtime state. The pod's mount layout already follows
  // exactly this shape (workspaceDir = /host-workspaces/<projectId>) so the
  // resolved path lines up. Where it doesn't (overlay mode without mount),
  // we fall back to the workspaceDir itself by computing parent/leaf at
  // request time.
  const inner = new Hono()

  inner.use("*", async (c, next) => {
    const projectId = getCurrentProjectId()
    if (!projectId) {
      return c.json(
        { error: { code: "no_project_assigned", message: "Pod has no project assigned yet" } },
        503,
      )
    }
    // Decide workspacesDir/projectId pair so `${workspacesDir}/${projectId}`
    // resolves to `workspaceDir`.
    let workspacesDir: string
    let urlProjectId: string
    if (basename(workspaceDir) === projectId) {
      workspacesDir = dirname(workspaceDir)
      urlProjectId = projectId
    } else {
      // Overlay or symlink mode — workspaceDir doesn't end with the projectId.
      // Use parent + leaf as-is; the factory only uses the path to spawn tools.
      workspacesDir = dirname(workspaceDir)
      urlProjectId = basename(workspaceDir) || projectId
    }

    const router = diagnosticsRoutes({ workspacesDir })

    // Rewrite the incoming URL: /diagnostics → /projects/<id>/diagnostics
    // (same for /diagnostics/refresh).
    const url = new URL(c.req.url)
    if (url.pathname === "/diagnostics") {
      url.pathname = `/projects/${urlProjectId}/diagnostics`
    } else if (url.pathname === "/diagnostics/refresh") {
      url.pathname = `/projects/${urlProjectId}/diagnostics/refresh`
    } else {
      return next()
    }

    const init: RequestInit = {
      method: c.req.method,
      headers: c.req.raw.headers,
    }
    if (c.req.method !== "GET" && c.req.method !== "HEAD") {
      init.body = c.req.raw.body
      // @ts-expect-error - required when forwarding a streaming body in Node
      init.duplex = "half"
    }
    const newReq = new Request(url.toString(), init)
    return router.fetch(newReq)
  })

  return inner
}

export default runtimeDiagnosticsRoutes
