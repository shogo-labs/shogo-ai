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
  workspaceDiskIncludedGiB,
  type InstanceSizeName,
} from '../config/instance-sizes'
import { DISK_ADDON_USD_PER_GIB_MONTH, diskAddonMonthlyUsd } from '../config/disk-pricing'

export type DiskSubstrate = 'metal' | 'knative' | 'local'

export interface RuntimeDiskUsage {
  usedBytes: number
  totalBytes: number
}

export interface ProjectDiskDescription {
  /** What the project asked for; null = never set (fleet default). */
  requestedGiB: number | null
  /** The size actually in force (clamped to the ceiling, never below default). */
  effectiveGiB: number
  defaultGiB: number
  /** GiB this tier includes before the paid add-on. */
  includedGiB: number
  /** Largest size this workspace may ask for (200 when it can buy the add-on). */
  maxGiB: number
  /** GiB above the tier's included amount — the part that is billed. */
  addonGiB: number
  /** USD per GiB-month for the add-on. */
  pricePerGiBMonthUsd: number
  /** Monthly price of the current add-on GiB. */
  addonMonthlyUsd: number
  /** True when `effectiveGiB` is below `maxGiB`. */
  canIncrease: boolean
  /** Why not, when `canIncrease` is false. */
  reason?: 'plan_ceiling' | 'plan_required'
  /** True when this workspace may buy disk above what its tier includes. */
  canBuyAddon: boolean
  /** Why not, when `canBuyAddon` is false. */
  buyBlockedReason?: 'plan_required' | 'usage_limit_reached'
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
  /** Whether this workspace may buy the disk add-on (paid plan, wallet funded). */
  canBuyAddon?: boolean
  /** Why the add-on is blocked, when `canBuyAddon` is false. */
  buyBlockedReason?: 'plan_required' | 'usage_limit_reached'
  usage?: RuntimeDiskUsage | null
  measuredAt?: Date
}): ProjectDiskDescription {
  const requested = typeof args.requestedGiB === 'number' ? args.requestedGiB : null
  const canBuyAddon = args.canBuyAddon ?? false
  const effectiveGiB = resolveWorkspaceDiskMiB(requested, args.instanceSize, { canBuyAddon }) / 1024
  const includedGiB = workspaceDiskIncludedGiB(args.instanceSize)
  const maxGiB = workspaceDiskCeilingGiB(args.instanceSize, { canBuyAddon })
  const addonGiB = Math.max(0, effectiveGiB - includedGiB)
  const usage = args.usage
    ? { ...args.usage, measuredAt: (args.measuredAt ?? new Date()).toISOString() }
    : null
  const canIncrease = effectiveGiB < maxGiB
  return {
    requestedGiB: requested,
    effectiveGiB,
    defaultGiB: DEFAULT_WORKSPACE_DISK_GIB,
    includedGiB,
    maxGiB,
    addonGiB,
    pricePerGiBMonthUsd: DISK_ADDON_USD_PER_GIB_MONTH,
    addonMonthlyUsd: diskAddonMonthlyUsd(addonGiB),
    canIncrease,
    ...(canIncrease ? {} : { reason: canBuyAddon ? ('plan_ceiling' as const) : ('plan_required' as const) }),
    canBuyAddon,
    ...(canBuyAddon ? {} : { buyBlockedReason: args.buyBlockedReason ?? ('plan_required' as const) }),
    usage,
    substrate: args.substrate,
  }
}

export type DiskChangePlan =
  | { ok: true; sizeGiB: number }
  | { ok: false; status: 400 | 402 | 422; code: string; message: string }

/**
 * Validate a requested new size against the ceiling. Does NOT check the
 * caller's role — that is the route's job (workspace admin/owner).
 *
 * Disks never shrink: a request below the size already in force is refused
 * with 422 `cannot_shrink` (ext4 cannot shrink online, and the drive is sparse
 * anyway). A request above what the tier includes is refused with 402
 * `plan_required` when the workspace may not buy the add-on, and 422
 * `plan_ceiling` when it may but asked for more than the hard cap.
 */
export function planDiskChange(
  sizeGiB: unknown,
  instanceSize: InstanceSizeName,
  opts: { canBuyAddon?: boolean; currentEffectiveGiB?: number } = {},
): DiskChangePlan {
  const size = typeof sizeGiB === 'string' ? Number(sizeGiB) : sizeGiB
  if (typeof size !== 'number' || !Number.isFinite(size)) {
    return { ok: false, status: 400, code: 'invalid_request', message: 'sizeGiB must be a number' }
  }
  const whole = Math.floor(size)
  if (whole < 1) {
    return { ok: false, status: 400, code: 'invalid_request', message: 'sizeGiB must be at least 1' }
  }
  const canBuyAddon = opts.canBuyAddon ?? false
  const current = opts.currentEffectiveGiB
  if (typeof current === 'number' && whole < current) {
    return {
      ok: false,
      status: 422,
      code: 'cannot_shrink',
      message: `Disks can't shrink — this drive is already ${current} GiB.`,
    }
  }
  const maxGiB = workspaceDiskCeilingGiB(instanceSize, { canBuyAddon })
  if (whole > maxGiB) {
    if (!canBuyAddon) {
      return {
        ok: false,
        status: 402,
        code: 'plan_required',
        message: `This workspace's plan includes ${workspaceDiskIncludedGiB(instanceSize)} GiB. Upgrade to buy more disk.`,
      }
    }
    return {
      ok: false,
      status: 422,
      code: 'plan_ceiling',
      message: `Workspace disks can be at most ${maxGiB} GiB.`,
    }
  }
  return { ok: true, sizeGiB: Math.max(whole, DEFAULT_WORKSPACE_DISK_GIB) }
}

/** The tier's min-scale, so a disk change never clobbers always-on on metal. */
export function instanceMinScale(instanceSize: InstanceSizeName): number {
  return (INSTANCE_SIZES as Record<string, { minScale?: number }>)[instanceSize]?.minScale ?? 0
}

/**
 * Whether a workspace may buy disk above what its tier includes (SHO-401).
 *
 * Paid plans only (the default Russell was asked about): a `free` workspace is
 * capped at its included GiB. Local/desktop is unlimited — no charge, no job —
 * so it may always grow. The wallet pre-flight (does the wallet cover a month
 * of the new add-on?) is a separate check the PUT route does.
 */
export async function resolveDiskAddonEligibility(
  workspaceId: string,
): Promise<{ canBuyAddon: boolean; buyBlockedReason?: 'plan_required' | 'usage_limit_reached' }> {
  if (process.env.SHOGO_LOCAL_MODE === 'true') return { canBuyAddon: true }
  try {
    const { getEffectivePlanId } = await import('./billing.service')
    const plan = await getEffectivePlanId(workspaceId)
    if (plan === 'free') return { canBuyAddon: false, buyBlockedReason: 'plan_required' }
    return { canBuyAddon: true }
  } catch (err: any) {
    console.warn(`[ProjectDisk] plan lookup failed for ${workspaceId}:`, err?.message ?? err)
    return { canBuyAddon: false, buyBlockedReason: 'plan_required' }
  }
}

/**
 * Read the guest's own statfs for a bare `ws:<workspaceId>` workspace runtime
 * (SHO-401). Same passive contract as `readRuntimeDiskUsage`: it only talks to
 * a runtime that is already up, never waking one.
 */
export async function readWorkspaceRuntimeDiskUsage(
  workspaceId: string,
  deps: {
    peekUrl?: (key: string) => string | null | undefined
    token?: (workspaceId: string) => string
    fetchImpl?: typeof fetch
  } = {},
): Promise<RuntimeDiskUsage | null> {
  const { workspaceRuntimeKey } = await import('../lib/metal-warm-pool-controller')
  return readRuntimeDiskUsage(workspaceRuntimeKey(workspaceId), workspaceId, deps)
}

/**
 * Read the guest's own statfs for the workspace drive. Best-effort and
 * **passive**: it only talks to a runtime that is already up, never resolving a
 * placement or waking a VM (AC 8 — opening Settings must not cold-boot a
 * project). A stopped project answers null and the panel says usage appears
 * while the project is running. Guest endpoints sit under the auth-gated
 * `/pool` prefix, so the workspace runtime token is required.
 */
export async function readRuntimeDiskUsage(
  projectId: string,
  workspaceId: string,
  deps: {
    /** Already-running URL, or null when nothing is up. Must never wake a VM. */
    peekUrl?: (projectId: string) => string | null | undefined
    token?: (workspaceId: string) => string
    fetchImpl?: typeof fetch
  } = {},
): Promise<RuntimeDiskUsage | null> {
  try {
    const peekUrl =
      deps.peekUrl ??
      (await (async () => {
        const { peekMetalProjectUrl } = await import('../lib/metal-warm-pool-controller')
        return (id: string) => peekMetalProjectUrl(id) ?? null
      })())
    const url = peekUrl(projectId)
    if (!url) return null
    const token =
      deps.token ?? (await import('../lib/workspace-runtime-token')).deriveWorkspaceRuntimeToken
    const fetchImpl = deps.fetchImpl ?? fetch
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
