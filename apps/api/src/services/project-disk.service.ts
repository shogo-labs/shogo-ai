// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Per-project workspace-drive sizing (SHO-349).
 *
 * A metal project's files live on its own sparse ext4 drive (label `shogo-ws`,
 * mounted at /data, bind-mounted onto /app/workspace). This service answers two
 * questions for `GET/PUT /api/projects/:id/disk`:
 *
 *   - what size is in force, and may this plan ask for more?
 *   - what does the guest actually have on it right now?
 *
 * The plan ceiling and the never-shrink rule live in
 * `apps/api/src/config/instance-sizes.ts` (`resolveWorkspaceDiskMiB`) so the
 * env builder that ships `SHOGO_VM_DISK_MIB` to the host and this route can
 * never disagree. Kept pure here so both are unit-testable without a VM.
 */

import {
  DEFAULT_WORKSPACE_DISK_GIB,
  INSTANCE_SIZES,
  resolveWorkspaceDiskMiB,
  workspaceDiskCeilingGiB,
  type InstanceSizeName,
} from '../config/instance-sizes'

export type DiskSubstrate = 'metal' | 'knative' | 'local'

export interface RuntimeDiskUsage {
  usedBytes: number
  totalBytes: number
}

export interface ProjectDiskDescription {
  /** What the project asked for; null = never set (fleet default). */
  requestedGiB: number | null
  /** The size actually in force (clamped to the tier ceiling, never below default). */
  effectiveGiB: number
  defaultGiB: number
  /** Largest size this workspace's tier may ask for. */
  maxGiB: number
  /** True when `effectiveGiB` is below `maxGiB`. */
  canIncrease: boolean
  /** Why not, when `canIncrease` is false. */
  reason?: string
  /** Live usage from the guest; null when the runtime is down (never wakes it). */
  usage: (RuntimeDiskUsage & { measuredAt: string }) | null
  substrate: DiskSubstrate
}

/** Trim a byte count to a whole GiB, for the numbers shown in the UI. */
export function giB(bytes: number): number {
  return Math.round((bytes / 1024 ** 3) * 10) / 10
}

export function describeProjectDisk(args: {
  requestedGiB: number | null | undefined
  instanceSize: InstanceSizeName
  substrate: DiskSubstrate
  usage?: RuntimeDiskUsage | null
  measuredAt?: Date
}): ProjectDiskDescription {
  const requested = typeof args.requestedGiB === 'number' ? args.requestedGiB : null
  const effectiveGiB = resolveWorkspaceDiskMiB(requested, args.instanceSize) / 1024
  const maxGiB = workspaceDiskCeilingGiB(args.instanceSize)
  const usage = args.usage
    ? { ...args.usage, measuredAt: (args.measuredAt ?? new Date()).toISOString() }
    : null
  return {
    requestedGiB: requested,
    effectiveGiB,
    defaultGiB: DEFAULT_WORKSPACE_DISK_GIB,
    maxGiB,
    canIncrease: effectiveGiB < maxGiB,
    ...(effectiveGiB < maxGiB ? {} : { reason: 'plan_ceiling' as const }),
    usage,
    substrate: args.substrate,
  }
}

export type DiskChangePlan =
  | { ok: true; sizeGiB: number }
  | { ok: false; status: 400 | 422; code: string; message: string }

/**
 * Validate a requested new size against the plan ceiling. Does NOT check the
 * caller's role — that is the route's job (workspace admin/owner).
 *
 * Sizes only ever go up: a request at or below the default is accepted but
 * resolves to the default, because ext4 cannot shrink online and the drive is
 * sparse anyway (lowering the setting caps future growth, nothing else).
 */
export function planDiskChange(sizeGiB: unknown, instanceSize: InstanceSizeName): DiskChangePlan {
  const size = typeof sizeGiB === 'string' ? Number(sizeGiB) : sizeGiB
  if (typeof size !== 'number' || !Number.isFinite(size)) {
    return { ok: false, status: 400, code: 'invalid_request', message: 'sizeGiB must be a number' }
  }
  const whole = Math.floor(size)
  if (whole < 1) {
    return { ok: false, status: 400, code: 'invalid_request', message: 'sizeGiB must be at least 1' }
  }
  const maxGiB = workspaceDiskCeilingGiB(instanceSize)
  if (whole > maxGiB) {
    return {
      ok: false,
      status: 422,
      code: 'plan_ceiling',
      message: `This workspace's plan allows workspace disks up to ${maxGiB} GiB.`,
    }
  }
  return { ok: true, sizeGiB: Math.max(whole, DEFAULT_WORKSPACE_DISK_GIB) }
}

/** The tier's min-scale, so a disk change never clobbers always-on on metal. */
export function instanceMinScale(instanceSize: InstanceSizeName): number {
  return (INSTANCE_SIZES as Record<string, { minScale?: number }>)[instanceSize]?.minScale ?? 0
}

/**
 * Read the guest's own statfs for the workspace drive. Best-effort: a project
 * that isn't running answers null, and nothing here wakes a VM just to measure
 * it. Guest endpoints sit under the auth-gated `/pool` prefix, so the workspace
 * runtime token is required.
 */
export async function readRuntimeDiskUsage(
  projectId: string,
  workspaceId: string,
  deps: {
    resolveUrl?: (projectId: string) => Promise<{ url: string }>
    token?: (workspaceId: string) => string
    fetchImpl?: typeof fetch
  } = {},
): Promise<RuntimeDiskUsage | null> {
  try {
    const resolveUrl =
      deps.resolveUrl ?? (async (id: string) => (await import('../lib/resolve-pod-url')).resolveProjectPodUrl(id, { logTag: 'ProjectDisk' }))
    const token =
      deps.token ?? (await import('../lib/workspace-runtime-token')).deriveWorkspaceRuntimeToken
    const fetchImpl = deps.fetchImpl ?? fetch
    const { url } = await resolveUrl(projectId)
    const base = url.replace(/\/+$/, '')
    const res = await fetchImpl(`${base}/pool/workspace-drive`, {
      headers: { 'x-runtime-token': token(workspaceId) },
      signal: AbortSignal.timeout(5000),
    })
    if (!res.ok) return null
    const body = (await res.json().catch(() => ({}))) as Partial<RuntimeDiskUsage>
    if (typeof body.usedBytes !== 'number' || typeof body.totalBytes !== 'number') return null
    return { usedBytes: body.usedBytes, totalBytes: body.totalBytes }
  } catch {
    return null
  }
}
