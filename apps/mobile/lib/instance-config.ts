// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Client-side instance size configuration for the mobile app.
 * Mirrors the server config for display purposes.
 */

export type InstanceSizeName = 'micro' | 'small' | 'medium' | 'large' | 'xlarge'

export interface InstanceSizeDisplay {
  name: InstanceSizeName
  label: string
  cpuLabel: string
  cpuCores: number
  memoryLabel: string
  memoryGb: number
  storageLabel: string
  storageLimitGb: number
  dedicated: boolean
  monthlyPrice: number
  annualPrice: number
  features: string[]
}

export const INSTANCE_MARKUP = 1.0

export const INSTANCE_SIZES: InstanceSizeDisplay[] = [
  {
    name: 'micro',
    label: 'Micro',
    cpuLabel: '0.5 CPU',
    cpuCores: 0.5,
    memoryLabel: '2 GB RAM',
    memoryGb: 2,
    storageLabel: '1 GB',
    storageLimitGb: 1,
    dedicated: false,
    monthlyPrice: 0,
    annualPrice: 0,
    features: [
      '0.5 CPU core',
      '2 GB memory',
      '1 GB cloud storage',
      'Shared infrastructure',
    ],
  },
  {
    name: 'small',
    label: 'Small',
    cpuLabel: '1 CPU',
    cpuCores: 1,
    memoryLabel: '4 GB RAM',
    memoryGb: 4,
    storageLabel: '5 GB',
    storageLimitGb: 5,
    dedicated: true,
    monthlyPrice: 15,
    annualPrice: 150,
    features: [
      '1 CPU core',
      '4 GB memory',
      '5 GB cloud storage',
      'Dedicated instance',
      'Resource usage metrics',
    ],
  },
  {
    name: 'medium',
    label: 'Medium',
    cpuLabel: '2 CPU',
    cpuCores: 2,
    memoryLabel: '8 GB RAM',
    memoryGb: 8,
    storageLabel: '20 GB',
    storageLimitGb: 20,
    dedicated: true,
    monthlyPrice: 40,
    annualPrice: 400,
    features: [
      '2 CPU cores',
      '8 GB memory',
      '20 GB cloud storage',
      'Dedicated instance',
      'Resource usage metrics',
    ],
  },
  {
    name: 'large',
    label: 'Large',
    cpuLabel: '4 CPU',
    cpuCores: 4,
    memoryLabel: '16 GB RAM',
    memoryGb: 16,
    storageLabel: '100 GB',
    storageLimitGb: 100,
    dedicated: true,
    monthlyPrice: 80,
    annualPrice: 800,
    features: [
      '4 CPU cores',
      '16 GB memory',
      '100 GB cloud storage',
      'Dedicated instance',
      'Resource usage metrics',
      'Priority scheduling',
    ],
  },
  {
    name: 'xlarge',
    label: 'XLarge',
    cpuLabel: '8 CPU',
    cpuCores: 8,
    memoryLabel: '32 GB RAM',
    memoryGb: 32,
    storageLabel: '200 GB',
    storageLimitGb: 200,
    dedicated: true,
    monthlyPrice: 150,
    annualPrice: 1500,
    features: [
      '8 CPU cores',
      '32 GB memory',
      '200 GB cloud storage',
      'Dedicated instance',
      'Resource usage metrics',
      'Priority scheduling',
    ],
  },
]

export function getInstanceSize(name: InstanceSizeName): InstanceSizeDisplay {
  return INSTANCE_SIZES.find((t) => t.name === name) || INSTANCE_SIZES[0]
}

export function getDisplayPrice(size: InstanceSizeDisplay, interval: 'monthly' | 'annual'): number {
  const base = interval === 'monthly' ? size.monthlyPrice : size.annualPrice
  return Math.round(base * INSTANCE_MARKUP * 100) / 100
}

export function formatStorageBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const gb = bytes / (1024 ** 3)
  if (gb >= 1) return `${gb.toFixed(1)} GB`
  const mb = bytes / (1024 ** 2)
  if (mb >= 1) return `${mb.toFixed(0)} MB`
  const kb = bytes / 1024
  return `${kb.toFixed(0)} KB`
}

export function formatCpuPercent(percent: number): string {
  return `${percent.toFixed(1)}%`
}

export function formatMemoryGb(bytes: number): string {
  const gb = bytes / (1024 ** 3)
  return `${gb.toFixed(1)} GB`
}
