// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Wake a hosted workspace's tunnel when the workspace is opened (SHO-538).
 *
 * A desktop's tunnel closes after five idle minutes, and the desktop only learns
 * the cloud wants it back from its next heartbeat poll — an idle one polls every
 * 60 s. Waiting for that inside the first files or plans call is what made the
 * first attempt fail; asking as soon as the workspace is on screen means the
 * tunnel is usually up before anything reads from it.
 *
 * The request is the one the runtime picker already makes
 * (`POST /api/instances/:id/request-connect`): it stamps `wsRequestedAt` and
 * marks a viewer, which puts the desktop on its fast poll. Repeated while the
 * workspace stays open, so the five-minute idle close never puts a viewer back
 * to square one — and every mount shares one request per instance.
 */
import { useEffect } from 'react'
import { API_URL } from '../lib/api-url'
import { agentFetch } from '../lib/agent-fetch'

/** Inside the API's `WS_REQUEST_TTL_MS` (2 min), so a viewer never lapses to an idle poll. */
const RE_REQUEST_MS = 90_000

/** Several screens read the workspace in view at once; one wake is enough. */
const DEBOUNCE_MS = 10_000

const lastRequestedAt = new Map<string, number>()

/** Test seam: forget what was asked, so a case can ask again. */
export function _resetHostTunnelWakeForTests(): void {
  lastRequestedAt.clear()
}

/**
 * Ask the host named by `instanceId` for its tunnel, at most once per
 * `DEBOUNCE_MS`. Fire-and-forget: the call that needs the runtime reports its
 * own failure, so a wake that cannot be asked for only costs the fast path.
 */
export function requestHostTunnel(instanceId: string, workspaceId: string | null): void {
  const now = Date.now()
  const last = lastRequestedAt.get(instanceId)
  if (last !== undefined && now - last < DEBOUNCE_MS) return
  lastRequestedAt.set(instanceId, now)

  void agentFetch(`${API_URL}/api/instances/${encodeURIComponent(instanceId)}/request-connect`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    // Naming the workspace lets the host be woken for any member of a workspace
    // it serves, not only for the machine's owner.
    body: JSON.stringify(workspaceId ? { workspaceId } : {}),
  })
    .then((res) => {
      if (!res.ok) console.warn(`[host-wake] pre-wake refused (${res.status}) for ${instanceId}`)
    })
    .catch((err) => {
      console.warn('[host-wake] pre-wake failed:', err?.message ?? err)
    })
}

/** Keep a hosted workspace's tunnel warm while it is the workspace in view. */
export function useHostTunnelWake(
  instanceId: string | null | undefined,
  workspaceId: string | null | undefined,
): void {
  useEffect(() => {
    if (!instanceId || !workspaceId) return
    requestHostTunnel(instanceId, workspaceId)
    const timer = setInterval(() => requestHostTunnel(instanceId, workspaceId), RE_REQUEST_MS)
    return () => clearInterval(timer)
  }, [instanceId, workspaceId])
}
