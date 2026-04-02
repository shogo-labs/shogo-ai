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
 * Assignment is detected from:
 *   1. ASSIGNED_PROJECT env var (Kubernetes Downward API)
 *   2. Disk marker file (.shogo-pool-assignment) written during /pool/assign
 *      — survives container restarts on emptyDir volumes
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
  let assignedProject = process.env.ASSIGNED_PROJECT
  if (!assignedProject || assignedProject === '' || assignedProject === '__POOL__') {
    assignedProject = readAssignmentMarker(workDir)
  }
  if (!assignedProject) {
    return null
  }

  console.log(`[self-assign] Detected assignment: ${assignedProject}`)

  const baseUrl = apiUrl || deriveApiUrl()
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

function readSAToken(): string | null {
  try {
    if (existsSync(SA_TOKEN_PATH)) {
      return readFileSync(SA_TOKEN_PATH, 'utf-8').trim()
    }
  } catch {
    // Not running in K8s
  }
  return null
}

function deriveApiUrl(): string | null {
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
