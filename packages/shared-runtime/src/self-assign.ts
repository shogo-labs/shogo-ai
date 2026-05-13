// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Self-Assign on Boot
 *
 * When a warm pool pod restarts (OOM, node drain, scale-to-zero cold start),
 * it boots with PROJECT_ID=__POOL__ and WARM_POOL_MODE=true. If the pod was
 * previously assigned to a project, this module fetches the project config
 * from the API and returns it for the runtime to apply.
 *
 * Assignment is detected from, in order:
 *   1. `ASSIGNED_PROJECT` env var (Kubernetes Downward API).
 *   2. Disk marker file (`.shogo-pool-assignment`) written during
 *      `/pool/assign`. Survives in-place container restarts on the same
 *      emptyDir volume but NOT pod recreation.
 *   3. `whoami` lookup against the API by `KNATIVE_SERVICE_NAME` (the
 *      pod's stable identity, also injected via the Downward API). The
 *      API has the authoritative project↔service mapping in
 *      `Project.knativeServiceName`, so a recreated pod can recover its
 *      assignment with no out-of-band coordination. This is the only path
 *      that survives pod recreation; without it, K8s recreating a
 *      promoted pod produces the "promoted-but-orphaned" failure mode
 *      where the pod stays in pool mode and 401s every request forever
 *      (the 2026-05-13 staging incident).
 */

import { readFileSync, existsSync } from 'fs'
import { join } from 'path'

export const POOL_ASSIGNMENT_MARKER = '.shogo-pool-assignment'

const SA_TOKEN_PATH = '/var/run/secrets/kubernetes.io/serviceaccount/token'

export interface SelfAssignConfig {
  projectId: string
  env: Record<string, string>
}

/**
 * Check if this pod has a project assignment and fetch the config if so.
 * Returns null if no assignment is found or if fetching fails.
 *
 * @param apiUrl - The API server URL (derived from AI_PROXY_URL or explicitly set)
 * @param workDir - Workspace directory to check for disk-based assignment marker
 */
export async function checkSelfAssign(apiUrl?: string, workDir?: string): Promise<SelfAssignConfig | null> {
  const baseUrl = apiUrl || deriveApiUrl()

  const assignedProject = await discoverAssignedProject(workDir, baseUrl)
  if (!assignedProject) {
    return null
  }

  console.log(`[self-assign] Detected assignment: ${assignedProject}`)

  if (!baseUrl) {
    console.error('[self-assign] Cannot determine API URL for config fetch')
    return null
  }

  const saToken = readSAToken()
  const configUrl = `${baseUrl}/api/internal/pod-config/${assignedProject}`

  console.log(`[self-assign] Fetching config from ${configUrl}`)
  const startTime = Date.now()

  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    }
    if (saToken) {
      headers['Authorization'] = `Bearer ${saToken}`
    }

    const response = await fetch(configUrl, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(30_000),
    })

    if (!response.ok) {
      const body = await response.text()
      console.error(`[self-assign] Config fetch failed (${response.status}): ${body}`)
      return null
    }

    const data = await response.json() as { projectId: string; env: Record<string, string> }
    const duration = Date.now() - startTime
    console.log(`[self-assign] Config fetched for ${data.projectId} in ${duration}ms (${Object.keys(data.env).length} env vars)`)

    return data
  } catch (err: any) {
    const duration = Date.now() - startTime
    console.error(`[self-assign] Config fetch failed after ${duration}ms:`, err.message)
    return null
  }
}

/**
 * Read the Kubernetes ServiceAccount token mounted at the standard path.
 * Returns null when not running inside a pod. Exported so the token-refresh
 * loop can reuse the exact same auth used by self-assign on boot, instead of
 * duplicating the path and read logic.
 *
 * The `K8S_SA_TOKEN_OVERRIDE` env var lets tests and local dev supply a
 * fake token without writing to `/var/run/secrets/...`. NEVER set this in
 * production — the token bypasses the file-mount contract.
 */
export function readSAToken(): string | null {
  if (process.env.K8S_SA_TOKEN_OVERRIDE) return process.env.K8S_SA_TOKEN_OVERRIDE
  try {
    if (existsSync(SA_TOKEN_PATH)) {
      return readFileSync(SA_TOKEN_PATH, 'utf-8').trim()
    }
  } catch {
    // Not running in K8s
  }
  return null
}

/**
 * Resolve the Shogo API base URL the runtime should talk to. Looks at
 * SHOGO_API_URL / API_URL explicit overrides, falls back to deriving from
 * AI_PROXY_URL (stripping the `/api/ai/v1` suffix), and finally constructs
 * an in-cluster ClusterIP-style URL from SYSTEM_NAMESPACE.
 *
 * Exported so the token-refresh loop hits the same endpoint self-assign
 * uses on boot.
 */
export function deriveApiUrl(): string | null {
  if (process.env.SHOGO_API_URL) return process.env.SHOGO_API_URL
  if (process.env.API_URL) return process.env.API_URL

  // Derive from AI_PROXY_URL: http://api.ns.svc.cluster.local/api/ai/v1 -> http://api.ns.svc.cluster.local
  const proxyUrl = process.env.AI_PROXY_URL
  if (proxyUrl) {
    try {
      const url = new URL(proxyUrl)
      return `${url.protocol}//${url.host}`
    } catch {
      // Invalid URL
    }
  }

  // Fallback using system namespace
  const systemNs = process.env.SYSTEM_NAMESPACE || 'shogo-system'
  return `http://api.${systemNs}.svc.cluster.local`
}

function readAssignmentMarker(workDir?: string): string | null {
  const dir = workDir || process.env.WORKSPACE_DIR
  if (!dir) return null
  try {
    const markerPath = join(dir, POOL_ASSIGNMENT_MARKER)
    if (existsSync(markerPath)) {
      const projectId = readFileSync(markerPath, 'utf-8').trim()
      if (projectId && projectId !== '__POOL__') {
        console.log(`[self-assign] Found disk assignment marker: ${projectId}`)
        return projectId
      }
    }
  } catch {
    // Marker file unreadable
  }
  return null
}

/**
 * Discover this pod's project assignment, in priority order:
 *
 *   1. `ASSIGNED_PROJECT` env var (set by the K8s Downward API when a
 *      controller has explicitly bound a project to a pod template).
 *   2. `.shogo-pool-assignment` marker on the workspace emptyDir (written
 *      during `/pool/assign`). Survives in-place container restarts.
 *   3. `whoami` lookup against the API by `KNATIVE_SERVICE_NAME`. The
 *      ksvc name is exposed via the Downward API on every warm-pool pod
 *      template (see `apps/api/src/lib/warm-pool-controller.ts`'s
 *      `createWarmPod()`), so a recreated pod can recover its project
 *      mapping without any out-of-band coordination.
 *
 * The whoami fallback is the only path that survives K8s recreating a
 * promoted pod — without it, the pod stays in pool mode forever.
 *
 * Exported for tests.
 */
export async function discoverAssignedProject(
  workDir?: string,
  apiUrl?: string | null,
): Promise<string | null> {
  const fromEnv = process.env.ASSIGNED_PROJECT
  if (fromEnv && fromEnv !== '' && fromEnv !== '__POOL__') {
    return fromEnv
  }

  const fromMarker = readAssignmentMarker(workDir)
  if (fromMarker) return fromMarker

  return await whoamiLookup(apiUrl)
}

async function whoamiLookup(apiUrl?: string | null): Promise<string | null> {
  const svcName = process.env.KNATIVE_SERVICE_NAME
  if (!svcName) return null
  if (!apiUrl) {
    console.warn('[self-assign] KNATIVE_SERVICE_NAME set but no API URL — skipping whoami lookup')
    return null
  }
  const saToken = readSAToken()
  if (!saToken) {
    // Outside a K8s pod (local dev / tests). The API rejects whoami without
    // a SA token, so don't even try.
    return null
  }
  const whoamiUrl = `${apiUrl}/api/internal/whoami/${encodeURIComponent(svcName)}`
  try {
    const res = await fetch(whoamiUrl, {
      method: 'GET',
      headers: { Authorization: `Bearer ${saToken}` },
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '<no body>')
      console.warn(`[self-assign] whoami(${svcName}) returned ${res.status}: ${body.slice(0, 200)}`)
      return null
    }
    const data = await res.json() as { projectId?: string | null }
    if (data.projectId && typeof data.projectId === 'string') {
      console.log(`[self-assign] Discovered project ${data.projectId} via whoami(${svcName})`)
      return data.projectId
    }
    // 200 with `{ projectId: null }` is a valid answer: this ksvc exists in
    // the pool but is not currently promoted to a project. Stay in pool mode.
    return null
  } catch (err: any) {
    console.warn(`[self-assign] whoami(${svcName}) fetch failed: ${err?.message || err}`)
    return null
  }
}
