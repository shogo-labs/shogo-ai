// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Per-project machine size (vCPU + RAM) on metal, for Settings → Machine.
 *
 * `Project.vmVcpus` / `Project.vmMemoryMiB` ask the host to boot this project's
 * microVM bigger than the standard class. The host reads them only when it
 * assigns a VM, so a change takes effect on the next start; the panel offers a
 * restart to apply it now.
 *
 * Every preset is offered on every workspace: the machine is paid for by the
 * hour it runs (`VM_PRICING`), not by the workspace's tier, so the picker shows
 * each size with its hourly price instead of locking the ones "above the plan".
 * The workspace budget still caps what the size is accounted at
 * (`accountedVmMemMiB`), so a big machine on a small workspace cannot evict its
 * other running projects.
 */

import type { InstanceSizeName } from '../config/instance-sizes'
import { INSTANCE_SIZES } from '../config/instance-sizes'
import { vmHourlyUsd } from '../config/vm-pricing'

export type MachineSubstrate = 'metal' | 'knative' | 'local'
export type MachineSizeId = 'standard' | 'medium' | 'large' | 'xlarge'

export interface MachineSizeSpec {
  id: MachineSizeId
  label: string
  vcpus: number
  memMiB: number
}

/**
 * The sizes a user can pick. `standard` is what every project gets with no
 * override (production hosts boot METAL_VCPUS=2, METAL_MEM_MIB=4096); picking
 * it clears the columns.
 */
export const MACHINE_SIZES: readonly MachineSizeSpec[] = [
  { id: 'standard', label: 'Standard', vcpus: 2, memMiB: 4096 },
  { id: 'medium', label: 'Medium', vcpus: 4, memMiB: 8192 },
  { id: 'large', label: 'Large', vcpus: 4, memMiB: 16384 },
  { id: 'xlarge', label: 'XLarge', vcpus: 8, memMiB: 32768 },
]

const STANDARD = MACHINE_SIZES[0]

export interface ProjectMachineDescription {
  current: {
    /** `custom` when an operator set a size that isn't one of the presets. */
    id: MachineSizeId | 'custom'
    label: string
    vcpus: number
    memMiB: number
  }
  /** Every preset, with what one active hour of it costs. */
  options: Array<MachineSizeSpec & { hourlyUsd: number }>
  instanceSize: InstanceSizeName
  substrate: MachineSubstrate
  /** A VM is up for this project now (a size change waits for a restart). */
  running: boolean
  /** Size can be changed here (metal only; desktop uses the computer itself). */
  canChange: boolean
  canRestart: boolean
}

export function currentMachineSize(
  vmMemoryMiB: number | null | undefined,
  vmVcpus: number | null | undefined,
): ProjectMachineDescription['current'] {
  const mem = typeof vmMemoryMiB === 'number' && vmMemoryMiB > 0 ? vmMemoryMiB : null
  const cpus = typeof vmVcpus === 'number' && vmVcpus > 0 ? vmVcpus : null
  if (mem === null && cpus === null) return { ...STANDARD }
  // The host only ever raises the class size, so an unset half is the standard one.
  const effMem = Math.max(mem ?? STANDARD.memMiB, STANDARD.memMiB)
  const effCpus = Math.max(cpus ?? STANDARD.vcpus, STANDARD.vcpus)
  const preset = MACHINE_SIZES.find((s) => s.memMiB === effMem && s.vcpus === effCpus)
  if (preset) return { ...preset }
  return { id: 'custom', label: 'Custom', vcpus: effCpus, memMiB: effMem }
}

export function describeProjectMachine(args: {
  vmMemoryMiB: number | null | undefined
  vmVcpus: number | null | undefined
  instanceSize: InstanceSizeName
  substrate: MachineSubstrate
  running: boolean
}): ProjectMachineDescription {
  const instanceSize: InstanceSizeName = INSTANCE_SIZES[args.instanceSize] ? args.instanceSize : 'micro'
  const metal = args.substrate === 'metal'
  return {
    current: currentMachineSize(args.vmMemoryMiB, args.vmVcpus),
    options: MACHINE_SIZES.map((s) => ({ ...s, hourlyUsd: vmHourlyUsd(s.vcpus, s.memMiB) })),
    instanceSize,
    substrate: args.substrate,
    running: args.running,
    canChange: metal,
    canRestart: metal,
  }
}

export type MachineChangePlan =
  | { ok: true; size: MachineSizeSpec; vmMemoryMiB: number | null; vmVcpus: number | null }
  | { ok: false; status: 400; code: string; message: string }

/**
 * Validate a picked size. Every preset is allowed on every workspace — the
 * machine is billed by the hour it runs, so there is no tier to check against.
 * Role checks are the route's job.
 */
export function planMachineChange(sizeId: unknown): MachineChangePlan {
  const size = MACHINE_SIZES.find((s) => s.id === sizeId)
  if (!size) {
    return {
      ok: false,
      status: 400,
      code: 'invalid_request',
      message: `size must be one of ${MACHINE_SIZES.map((s) => s.id).join(', ')}`,
    }
  }
  if (size.id === 'standard') return { ok: true, size, vmMemoryMiB: null, vmVcpus: null }
  return { ok: true, size, vmMemoryMiB: size.memMiB, vmVcpus: size.vcpus }
}

export type RestartOutcome =
  | { ok: true; restarted: boolean; message: string }
  | { ok: false; status: number; message: string }

/**
 * Restart a project's metal runtime from a clean boot so a new size applies.
 * Same path as the admin recycle (files are backed up first; a failed backup
 * aborts and nothing is removed), but it does not wait for the boot: the
 * project comes back in the background and on its next open.
 */
export async function restartProjectMachine(
  projectId: string,
  actor: { id: string; email?: string },
  deps?: {
    recycle?: typeof import('../lib/admin-runtime-recycle').recycleRuntimes
    loadDeps?: () => Promise<import('../lib/admin-runtime-recycle').RecycleDeps>
  },
): Promise<RestartOutcome> {
  const mod = deps?.recycle && deps?.loadDeps ? null : await import('../lib/admin-runtime-recycle')
  const recycle = deps?.recycle ?? mod!.recycleRuntimes
  const recycleDeps = await (deps?.loadDeps ?? (() => mod!.defaultRecycleDeps('project-machine-audit')))()
  const result = await recycle(
    { projectId, coldBoot: false, reason: `machine restart by ${actor.email ?? actor.id}` },
    actor,
    recycleDeps,
  )
  if (result.status === 404) {
    return { ok: true, restarted: false, message: 'The project is not running. The new size applies when it next starts.' }
  }
  if (!result.body.ok) {
    return {
      ok: false,
      status: result.status,
      message:
        result.status === 409
          ? 'Restart stopped: saving the project files first failed, so nothing was changed. Try again in a minute.'
          : String(result.body.error ?? 'Restart failed'),
    }
  }
  // Bring it back without holding the request open (a cold boot can take a minute).
  recycleDeps.coldBoot(projectId).catch((err: any) => {
    console.warn(`[ProjectMachine] background boot for ${projectId} failed:`, err?.message ?? err)
  })
  return { ok: true, restarted: true, message: 'Restarting. The project is back in about a minute.' }
}
