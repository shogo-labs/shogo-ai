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
 * The workspace tier is a memory budget shared by every running project, so a
 * size is offered only when it fits in that budget, and the env builders count
 * the chosen size against it (`accountedVmMemMiB`). Going back to Standard is
 * always allowed.
 */

import { INSTANCE_SIZES, INSTANCE_SIZE_ORDER, type InstanceSizeName } from '../config/instance-sizes'

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

/** Smallest workspace tier whose memory budget holds `memMiB`. */
export function tierForMachineMemory(memMiB: number): InstanceSizeName | null {
  for (const size of INSTANCE_SIZE_ORDER) {
    if (INSTANCE_SIZES[size].memoryGb * 1024 >= memMiB) return size
  }
  return null
}

export function machineSizeAllowed(spec: MachineSizeSpec, instanceSize: InstanceSizeName): boolean {
  if (spec.id === 'standard') return true
  const budgetMiB = (INSTANCE_SIZES[instanceSize] ?? INSTANCE_SIZES.micro).memoryGb * 1024
  return spec.memMiB <= budgetMiB
}

export interface ProjectMachineDescription {
  current: {
    /** `custom` when an operator set a size that isn't one of the presets. */
    id: MachineSizeId | 'custom'
    label: string
    vcpus: number
    memMiB: number
  }
  options: Array<MachineSizeSpec & { allowed: boolean; requiredTier: InstanceSizeName | null }>
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
    options: MACHINE_SIZES.map((s) => ({
      ...s,
      allowed: machineSizeAllowed(s, instanceSize),
      requiredTier: s.id === 'standard' ? null : tierForMachineMemory(s.memMiB),
    })),
    instanceSize,
    substrate: args.substrate,
    running: args.running,
    canChange: metal,
    canRestart: metal,
  }
}

export type MachineChangePlan =
  | { ok: true; size: MachineSizeSpec; vmMemoryMiB: number | null; vmVcpus: number | null }
  | { ok: false; status: 400 | 422; code: string; message: string }

/** Validate a picked size against the workspace tier. Role checks are the route's job. */
export function planMachineChange(sizeId: unknown, instanceSize: InstanceSizeName): MachineChangePlan {
  const size = MACHINE_SIZES.find((s) => s.id === sizeId)
  if (!size) {
    return {
      ok: false,
      status: 400,
      code: 'invalid_request',
      message: `size must be one of ${MACHINE_SIZES.map((s) => s.id).join(', ')}`,
    }
  }
  if (!machineSizeAllowed(size, instanceSize)) {
    const tier = tierForMachineMemory(size.memMiB)
    return {
      ok: false,
      status: 422,
      code: 'plan_ceiling',
      message: `${size.label} (${size.vcpus} vCPU, ${size.memMiB / 1024} GB) needs the ${
        tier ? INSTANCE_SIZES[tier].label : 'largest'
      } workspace plan or higher.`,
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
