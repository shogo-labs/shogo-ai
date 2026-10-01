// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Fault injection for the staging durability e2e (`METAL_E2E_FAULTS=1` only).
 *
 *   - `crash`: SIGKILL the runtime's Firecracker process and leave its disk,
 *     as an OOM kill or host fault would. The next open must rescue the
 *     workspace from that disk (`rescueWorkspace`) before booting a new VM.
 *   - `drop-snapshot`: remove a suspended runtime's local AND durable snapshot,
 *     so the next open has to cold-boot from the source / repo backups.
 *   - `evict-local`: remove only the local snapshot, so the next open has to
 *     pull the durable one — what a wake on a different host does.
 */

import type { MetalWarmPool } from './pool'

export type E2eFault = 'crash' | 'drop-snapshot' | 'evict-local'

export interface E2eFaultResult {
  ok: boolean
  action?: E2eFault
  vmId?: string
  error?: string
}

export async function injectE2eFault(
  pool: Pick<MetalWarmPool, 'getAssigned' | 'evictForGc'>,
  projectId: string,
  action: unknown,
  kill: (pid: number) => void = (pid) => process.kill(pid, 'SIGKILL'),
): Promise<E2eFaultResult> {
  switch (action) {
    case 'crash': {
      const a = pool.getAssigned(projectId)
      if (!a) return { ok: false, error: `${projectId} is not running on this host` }
      kill(a.handle.pid)
      console.warn(`[e2e-fault] killed VM ${a.handle.id} (pid ${a.handle.pid}) for ${projectId}`)
      return { ok: true, action, vmId: a.handle.id }
    }
    case 'drop-snapshot': {
      if (pool.getAssigned(projectId)) return { ok: false, error: `${projectId} is still running; suspend it first` }
      if (!(await pool.evictForGc(projectId, { alsoDurable: true }))) {
        return { ok: false, error: `no evictable snapshot for ${projectId} on this host` }
      }
      console.warn(`[e2e-fault] dropped local and durable snapshot for ${projectId}`)
      return { ok: true, action }
    }
    case 'evict-local': {
      if (pool.getAssigned(projectId)) return { ok: false, error: `${projectId} is still running; suspend it first` }
      // Refuses unless a current durable snapshot exists, so this never loses work.
      if (!(await pool.evictForGc(projectId))) {
        return { ok: false, error: `no local snapshot for ${projectId} with a current durable copy` }
      }
      console.warn(`[e2e-fault] dropped the local snapshot for ${projectId}; the next open pulls the durable one`)
      return { ok: true, action }
    }
    default:
      return { ok: false, error: `unknown fault ${JSON.stringify(action)} (crash | drop-snapshot | evict-local)` }
  }
}
