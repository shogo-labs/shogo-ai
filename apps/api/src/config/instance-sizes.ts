// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Workspace Instance Size Configuration
 *
 * Single source of truth for instance size specs (CPU, RAM, storage, pricing).
 * Adjust INSTANCE_MARKUP to scale all prices proportionally.
 *
 * All sizes share K8s nodes. Requests (scheduling guarantee) are set to 50%
 * of limits (burstable cap). Paid sizes keep min-scale 1 for zero cold starts.
 */

import { isMobileTechStack as isMobileTechStackShared } from '@shogo/shared-runtime'

export const INSTANCE_MARKUP = 1.0

export interface InstanceSizeSpec {
  label: string
  cpu: string
  cpuCores: number
  memory: string
  memoryGb: number
  requestCpu: string
  requestMemory: string
  storageLimitBytes: number
  storageGbLabel: string
  diskSizeLimit: string
  baseCostMonthly: number
  baseCostAnnual: number
  minScale: number
}

export type InstanceSizeName = 'micro' | 'small' | 'medium' | 'large' | 'xlarge'

export const INSTANCE_SIZES: Record<InstanceSizeName, InstanceSizeSpec> = {
  micro: {
    label: 'Micro',
    cpu: '500m',
    cpuCores: 0.5,
    memory: '2Gi',
    memoryGb: 2,
    requestCpu: '100m',
    requestMemory: '768Mi',
    storageLimitBytes: 1 * 1024 ** 3,
    storageGbLabel: '1 GB',
    diskSizeLimit: '2Gi',
    baseCostMonthly: 0,
    baseCostAnnual: 0,
    minScale: 0,
  },
  small: {
    label: 'Small',
    cpu: '1000m',
    cpuCores: 1,
    memory: '4Gi',
    memoryGb: 4,
    requestCpu: '500m',
    requestMemory: '2Gi',
    storageLimitBytes: 5 * 1024 ** 3,
    storageGbLabel: '5 GB',
    diskSizeLimit: '4Gi',
    baseCostMonthly: 15,
    baseCostAnnual: 150,
    minScale: 1,
  },
  medium: {
    label: 'Medium',
    cpu: '2000m',
    cpuCores: 2,
    memory: '8Gi',
    memoryGb: 8,
    requestCpu: '1000m',
    requestMemory: '4Gi',
    storageLimitBytes: 20 * 1024 ** 3,
    storageGbLabel: '20 GB',
    diskSizeLimit: '8Gi',
    baseCostMonthly: 40,
    baseCostAnnual: 400,
    minScale: 1,
  },
  large: {
    label: 'Large',
    cpu: '4000m',
    cpuCores: 4,
    memory: '16Gi',
    memoryGb: 16,
    requestCpu: '2000m',
    requestMemory: '8Gi',
    storageLimitBytes: 100 * 1024 ** 3,
    storageGbLabel: '100 GB',
    diskSizeLimit: '16Gi',
    baseCostMonthly: 80,
    baseCostAnnual: 800,
    minScale: 1,
  },
  xlarge: {
    label: 'XLarge',
    cpu: '8000m',
    cpuCores: 8,
    memory: '32Gi',
    memoryGb: 32,
    requestCpu: '4000m',
    requestMemory: '16Gi',
    storageLimitBytes: 200 * 1024 ** 3,
    storageGbLabel: '200 GB',
    diskSizeLimit: '32Gi',
    baseCostMonthly: 150,
    baseCostAnnual: 1500,
    minScale: 1,
  },
} as const

export const INSTANCE_SIZE_ORDER: InstanceSizeName[] = ['micro', 'small', 'medium', 'large', 'xlarge']

export function getInstanceSizeSpec(size: InstanceSizeName): InstanceSizeSpec {
  return INSTANCE_SIZES[size]
}

/**
 * Mobile/RN tech stacks (Expo + Metro) are too heavy for `micro`:
 * Expo's `node_modules` is ~1 GB on disk, and Metro's first bundle plus
 * the TypeScript/ESLint workers easily exceeds 2 GiB of RAM. Force at
 * least `small` so users on the free tier don't immediately hit the
 * same wall the "Mobile Game Planning" diagnostic project hit.
 *
 * Floor is applied at runtime, not at billing time — users are not
 * charged the `small` price; we just provision enough headroom for the
 * stack to actually run.
 */
const MOBILE_TECH_STACK_FLOOR: InstanceSizeName = 'small'

/**
 * Re-export the canonical mobile-stack predicate from `@shogo/shared-runtime`
 * so existing call sites (`knative-project-manager.ts`) keep working without
 * a code change. The actual logic lives in the central tech-stack registry —
 * see `packages/shared-runtime/src/tech-stack-registry.ts`. Do NOT add an
 * inline `startsWith('expo')` check here; that heuristic is what the
 * registry was introduced to kill.
 */
export const isMobileTechStack = isMobileTechStackShared

export function applyTechStackFloor(
  size: InstanceSizeName,
  techStackId: string | null | undefined,
): InstanceSizeName {
  if (!isMobileTechStack(techStackId)) return size
  const currentIdx = INSTANCE_SIZE_ORDER.indexOf(size)
  const floorIdx = INSTANCE_SIZE_ORDER.indexOf(MOBILE_TECH_STACK_FLOOR)
  return currentIdx >= floorIdx ? size : MOBILE_TECH_STACK_FLOOR
}

/**
 * Mobile stacks need extra disk for `node_modules` plus Metro's bundle
 * cache. Even after picking `small` (4 GiB diskSizeLimit), Expo + RN +
 * three.js can consume more, so we lift the disk overlay specifically
 * for mobile while leaving CPU/RAM at the size's normal limits.
 */
export function getMobileDiskSizeLimit(size: InstanceSizeName): string {
  switch (size) {
    case 'micro':
    case 'small':
      return '6Gi'
    case 'medium':
      return '10Gi'
    default:
      return INSTANCE_SIZES[size].diskSizeLimit
  }
}

export function getInstanceDisplayPrice(size: InstanceSizeName, interval: 'monthly' | 'annual'): number {
  const spec = INSTANCE_SIZES[size]
  const base = interval === 'monthly' ? spec.baseCostMonthly : spec.baseCostAnnual
  return Math.round(base * INSTANCE_MARKUP * 100) / 100
}

export function isInstanceUpgrade(from: InstanceSizeName, to: InstanceSizeName): boolean {
  return INSTANCE_SIZE_ORDER.indexOf(to) > INSTANCE_SIZE_ORDER.indexOf(from)
}

/**
 * Build Kubernetes resource overrides for a given instance size.
 * All sizes use shared nodes with both requests and limits.
 * Requests = scheduling guarantee (50% of limits for burstable overcommit).
 * Limits = hard cap on burst usage.
 */
export function getKubernetesResourceOverrides(size: InstanceSizeName) {
  const spec = INSTANCE_SIZES[size]
  return {
    requests: { memory: spec.requestMemory, cpu: spec.requestCpu },
    limits: { memory: spec.memory, cpu: spec.cpu },
    diskSizeLimit: spec.diskSizeLimit,
    minScale: spec.minScale,
  }
}
