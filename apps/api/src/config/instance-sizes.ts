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
