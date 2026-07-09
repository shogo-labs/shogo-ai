// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Persistent registry of LIVE (assigned, running) microVMs.
 *
 * The `assigned` map — projectId → the firecracker process currently serving it
 * — lives in memory. A node-agent restart (every code deploy) loses it. Today
 * that is masked by systemd killing the whole cgroup on restart, which takes the
 * firecracker children down with the agent; the projects then cold-resume from
 * their last snapshot on the next open.
 *
 * For a ROLLING deploy we instead keep the firecracker processes running across
 * the restart (systemd `KillMode=process`) and RE-ADOPT them in the new agent.
 * This is the same pattern containerd's runtime-v2 shims use: each shim persists
 * its connection info (bootstrap.json / shim.pid / shim.sock) and on a containerd
 * restart the daemon reconnects to the still-running shim instead of recreating
 * the workload. This file is our `bootstrap.json`: enough per-VM state that a
 * fresh process can re-attach to a running firecracker (its API unix socket) and
 * its guest (the /30 TAP IP) WITHOUT rebooting the VM.
 *
 * Writes are atomic per-entry (tmp + rename) so a crash mid-write never yields a
 * torn record, mirroring CacheIndex. Entries are removed as soon as a VM leaves
 * the assigned set (suspend / stop / evict) so the registry only ever describes
 * VMs that should be running right now.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { VmNet } from './net'

export interface LiveVmEntry {
  projectId: string
  /** firecracker --id (the handle id). */
  vmId: string
  /** firecracker process pid — the liveness + adoption key. */
  pid: number
  guestIp: string
  /** http://<guestIp>:<guestPort> — the in-guest agent. */
  agentUrl: string
  /** firecracker API unix socket (persists in runDir across a restart). */
  socketPath: string
  serialLog: string
  net: VmNet
  rootfs: string
  vcpus: number
  memoryMB: number
  assignedAt: number
  lastTouchedAt: number
  /** Snapshot files this VM was restored from (protected from orphan reclaim). */
  restoredFrom?: { vmstate: string; mem: string }
  /** Always-on (paid tier): reaper never idle-suspends; persisted for adopt. */
  alwaysOn?: boolean
  /** Guest RUNTIME_AUTH_SECRET — lets suspend call the guest `/pool/export`. */
  runtimeToken?: string
  /** Server-backed published subdomain — drives host-side writable-state export. */
  publishedSubdomain?: string
  v: 1
}

export class LiveRegistry {
  private dir: string

  constructor(runDir: string) {
    this.dir = join(runDir, 'live')
    mkdirSync(this.dir, { recursive: true })
  }

  private path(projectId: string): string {
    return join(this.dir, `${encodeURIComponent(projectId)}.json`)
  }

  put(entry: LiveVmEntry): void {
    const p = this.path(entry.projectId)
    const tmp = `${p}.tmp`
    writeFileSync(tmp, JSON.stringify(entry))
    try {
      renameSync(tmp, p) // atomic on the same filesystem
    } catch {
      writeFileSync(p, JSON.stringify(entry))
      rmSync(tmp, { force: true })
    }
  }

  get(projectId: string): LiveVmEntry | null {
    const p = this.path(projectId)
    if (!existsSync(p)) return null
    try {
      return JSON.parse(readFileSync(p, 'utf8')) as LiveVmEntry
    } catch {
      return null
    }
  }

  remove(projectId: string): void {
    rmSync(this.path(projectId), { force: true })
  }

  /** All valid entries; silently skips corrupt files. */
  all(): LiveVmEntry[] {
    const out: LiveVmEntry[] = []
    let names: string[] = []
    try {
      names = readdirSync(this.dir)
    } catch {
      return out
    }
    for (const name of names) {
      if (!name.endsWith('.json') || name.endsWith('.tmp')) continue
      try {
        const e = JSON.parse(readFileSync(join(this.dir, name), 'utf8')) as LiveVmEntry
        if (e && e.projectId && typeof e.pid === 'number') out.push(e)
      } catch {
        /* skip corrupt */
      }
    }
    return out
  }
}

/** True if a process with this pid currently exists (signal 0 probe). */
export function pidAlive(pid: number): boolean {
  if (!pid || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err: any) {
    // ESRCH = no such process; EPERM = exists but not signalable (still alive).
    return err?.code === 'EPERM'
  }
}
