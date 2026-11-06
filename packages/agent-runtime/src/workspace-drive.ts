// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The guest half of a live workspace-drive grow (SHO-349).
 *
 * A metal microVM's projects live on a separate ext4 drive (label `shogo-ws`,
 * mounted at /data, bind-mounted onto /app/workspace). The host can enlarge that
 * drive's backing file while the VM runs, but Firecracker only supports
 * updating a block device nothing is writing to — so the HOST sequences:
 *
 *   guest freeze → host ftruncate → PATCH /drives → guest thaw → guest resize
 *
 * This module is that guest side: `freeze` / `thaw` / `resize`, plus the statfs
 * the Settings panel reads. Two safety properties matter more than the happy
 * path:
 *
 *   - **Nothing stays frozen.** Every freeze arms a watchdog that thaws after
 *     `freezeTimeoutMs` (10 s), whatever happened to the host. Without it a host
 *     that dies between freeze and PATCH leaves every write in the project
 *     blocked forever.
 *   - **No I/O to /data between freeze and thaw.** Logging goes to stdout, which
 *     is the serial console — never the workspace.
 */

import { execFile } from '@shogo/shared-runtime/child-process'
import { statfs } from 'node:fs/promises'

/** Where fc-init mounts the workspace drive (`build-runtime-rootfs.sh`). */
export const WORKSPACE_DRIVE_MOUNT = '/data'

/** ext4 label the drive carries (apps/metal-agent/src/data-drive.ts). */
export const WORKSPACE_DRIVE_LABEL = 'shogo-ws'

/** How long a freeze may last before the guest thaws itself. */
export const FREEZE_WATCHDOG_MS = 10_000

export type DriveOp = 'freeze' | 'thaw' | 'resize'

export interface ExecResult {
  code: number
  stdout: string
  stderr: string
}

/** Injectable shell runner — the only reason this module is unit-testable. */
export type DriveExec = (cmd: string, args: string[]) => Promise<ExecResult>

export interface WorkspaceDriveUsage {
  usedBytes: number
  totalBytes: number
}

export interface WorkspaceDriveDeps {
  exec?: DriveExec
  /** statfs of the drive's mount point; resolves null when the mount is absent. */
  usage?: (dir: string) => Promise<WorkspaceDriveUsage | null>
  /** Mount point. Defaults to /data. */
  dir?: string
  /** Freeze watchdog. Defaults to FREEZE_WATCHDOG_MS. */
  freezeTimeoutMs?: number
}

export interface WorkspaceDriveResult {
  status: number
  body: Record<string, unknown>
}

const defaultExec: DriveExec = (cmd, args) =>
  new Promise((resolve) => {
    execFile(cmd, args, { timeout: 30_000 }, (err: any, stdout, stderr) => {
      const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0
      resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? err?.message ?? '') })
    })
  })

async function defaultUsage(dir: string): Promise<WorkspaceDriveUsage | null> {
  try {
    const s = await statfs(dir)
    const totalBytes = Number(s.blocks) * Number(s.bsize)
    const freeBytes = Number(s.bavail) * Number(s.bsize)
    if (!totalBytes) return null
    return { usedBytes: Math.max(0, totalBytes - freeBytes), totalBytes }
  } catch {
    return null
  }
}

/**
 * One freeze at a time per process, with the watchdog that releases it. Held
 * module-level because the handler is stateless and a second freeze must never
 * arm a second watchdog.
 */
let freezeWatchdog: ReturnType<typeof setTimeout> | undefined
let frozen = false

function clearWatchdog(): void {
  if (freezeWatchdog !== undefined) {
    clearTimeout(freezeWatchdog)
    freezeWatchdog = undefined
  }
}

/** True while /data is frozen by this module (diagnostics + GET). */
export function isWorkspaceDriveFrozen(): boolean {
  return frozen
}

/** Test seam: forget any armed watchdog (no timers leak between tests). */
export function resetWorkspaceDriveState(): void {
  clearWatchdog()
  frozen = false
}

/**
 * Measure the workspace drive. `null` when this guest has no separate drive
 * (Knative pod, desktop, or a metal host booted with `METAL_WORKSPACE_DRIVE_MIB=0`).
 */
export async function readWorkspaceDriveUsage(
  deps: WorkspaceDriveDeps = {},
): Promise<WorkspaceDriveUsage | null> {
  const dir = deps.dir ?? WORKSPACE_DRIVE_MOUNT
  const usage = deps.usage ?? defaultUsage
  return usage(dir)
}

/**
 * `fsfreeze -f /data` and arm the watchdog. Idempotent: a second freeze is a
 * no-op (the device is already frozen) and re-arms nothing.
 */
export async function freezeWorkspaceDrive(deps: WorkspaceDriveDeps = {}): Promise<WorkspaceDriveResult> {
  const dir = deps.dir ?? WORKSPACE_DRIVE_MOUNT
  const exec = deps.exec ?? defaultExec
  if (frozen) return { status: 200, body: { ok: true, frozen: true, alreadyFrozen: true } }
  const res = await exec('fsfreeze', ['-f', dir])
  if (res.code !== 0) {
    const missing = /ENOENT|not found/i.test(res.stderr)
    return {
      status: missing ? 409 : 500,
      body: { error: missing ? 'no_fsfreeze' : 'freeze_failed', message: res.stderr.trim() },
    }
  }
  frozen = true
  clearWatchdog()
  const ms = deps.freezeTimeoutMs ?? FREEZE_WATCHDOG_MS
  freezeWatchdog = setTimeout(() => {
    freezeWatchdog = undefined
    console.error(`[workspace-drive] freeze watchdog fired after ${ms}ms — thawing ${dir}`)
    void thawWorkspaceDrive(deps).catch((err) =>
      console.error('[workspace-drive] watchdog thaw failed:', err?.message ?? err),
    )
  }, ms)
  freezeWatchdog.unref?.()
  return { status: 200, body: { ok: true, frozen: true, watchdogMs: ms } }
}

/** `fsfreeze -u /data`. Always safe: a thaw of a frozen-but-not-by-us device is a best-effort failure. */
export async function thawWorkspaceDrive(deps: WorkspaceDriveDeps = {}): Promise<WorkspaceDriveResult> {
  const dir = deps.dir ?? WORKSPACE_DRIVE_MOUNT
  const exec = deps.exec ?? defaultExec
  clearWatchdog()
  const res = await exec('fsfreeze', ['-u', dir])
  frozen = false
  if (res.code !== 0) {
    // "not frozen"-class errors are fine: the goal state is reached either way.
    const benign = /not frozen|Invalid argument/i.test(res.stderr)
    if (!benign) return { status: 500, body: { error: 'thaw_failed', message: res.stderr.trim() } }
  }
  return { status: 200, body: { ok: true, frozen: false } }
}

/**
 * `resize2fs <device>` — grow the ext4 filesystem to the (already enlarged)
 * block device. Online resize is supported for ext4 and idempotent, so this
 * runs on every grow and at boot.
 */
export async function resizeWorkspaceFilesystem(deps: WorkspaceDriveDeps = {}): Promise<WorkspaceDriveResult> {
  const exec = deps.exec ?? defaultExec
  const found = await exec('blkid', ['-L', WORKSPACE_DRIVE_LABEL])
  const device = found.stdout.trim()
  if (found.code !== 0 || !device) {
    return { status: 409, body: { error: 'no_workspace_drive' } }
  }
  const res = await exec('resize2fs', [device])
  if (res.code !== 0) {
    return { status: 500, body: { error: 'resize_failed', message: res.stderr.trim() } }
  }
  const usage = await readWorkspaceDriveUsage(deps)
  return {
    status: 200,
    body: { ok: true, device, totalBytes: usage?.totalBytes ?? null, usedBytes: usage?.usedBytes ?? null },
  }
}

/** Dispatch one `POST /pool/workspace-drive` op. */
export async function handleWorkspaceDriveOp(
  op: DriveOp,
  deps: WorkspaceDriveDeps = {},
): Promise<WorkspaceDriveResult> {
  switch (op) {
    case 'freeze':
      return freezeWorkspaceDrive(deps)
    case 'thaw':
      return thawWorkspaceDrive(deps)
    case 'resize':
      return resizeWorkspaceFilesystem(deps)
    default:
      return { status: 400, body: { error: 'invalid_op', message: `op must be freeze|thaw|resize` } }
  }
}
