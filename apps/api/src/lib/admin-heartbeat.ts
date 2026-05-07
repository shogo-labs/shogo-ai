// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Admin Heartbeat helper
 *
 * Returns the active heartbeat scheduler instance for the current API process,
 * picking the cloud (Kubernetes) implementation when running in-cluster and the
 * local-dev one otherwise. Mirrors the start-up logic in `server.ts` so that
 * admin routes don't need to know about local-vs-cloud.
 *
 * Note: pause/stats/breaker state lives in-memory per API instance. In a
 * multi-pod production deployment, each pod has its own scheduler, so admin
 * controls only affect the pod that handled the request.
 */

import type { BaseHeartbeatScheduler } from './base-heartbeat-scheduler'

const isKubernetes = () => !!process.env.KUBERNETES_SERVICE_HOST

export async function getActiveHeartbeatScheduler(): Promise<BaseHeartbeatScheduler> {
  if (isKubernetes()) {
    const { getHeartbeatScheduler } = await import('./heartbeat-scheduler')
    return getHeartbeatScheduler()
  }
  const { getLocalHeartbeatScheduler } = await import('./local-heartbeat-scheduler')
  return getLocalHeartbeatScheduler()
}

export function getSchedulerKind(): 'cloud' | 'local' {
  return isKubernetes() ? 'cloud' : 'local'
}
