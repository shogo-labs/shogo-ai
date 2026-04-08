// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Remote Control — Version Compatibility & Feature Capabilities
 *
 * Centralizes minimum agent/API versions required per feature so that
 * the mobile app can gate UI surfaces when the desktop is too old.
 * The desktop reports its versions in heartbeat metadata; the mobile
 * compares against this map before rendering tabs or actions.
 */

export const REMOTE_CONTROL_PROTOCOL_VERSION = 2

export interface RemoteCapability {
  /** Human-readable feature name */
  label: string
  /** Minimum protocol version the desktop must report */
  minProtocolVersion: number
  /** If true, feature degrades gracefully (gray out instead of hide) */
  softGate?: boolean
}

export const CAPABILITIES = {
  status: { label: 'Status', minProtocolVersion: 1 },
  chat: { label: 'Chat', minProtocolVersion: 1 },
  files: { label: 'Files', minProtocolVersion: 1 },
  controls: { label: 'Controls', minProtocolVersion: 1 },
  logs: { label: 'Live Logs', minProtocolVersion: 2, softGate: true },
  projectManagement: { label: 'Project Management', minProtocolVersion: 2, softGate: true },
  modelSwitch: { label: 'Model Switching', minProtocolVersion: 2, softGate: true },
  fileEdit: { label: 'File Editing', minProtocolVersion: 2, softGate: true },
  fileUpload: { label: 'File Upload', minProtocolVersion: 2, softGate: true },
} as const satisfies Record<string, RemoteCapability>

export type CapabilityKey = keyof typeof CAPABILITIES

/**
 * Compare a semver-like version string against a minimum.
 * Accepts "major.minor.patch" or just a protocol version number.
 */
export function semverGte(version: string, minimum: string): boolean {
  const parse = (v: string) => v.split('.').map(Number)
  const a = parse(version)
  const b = parse(minimum)
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const av = a[i] ?? 0
    const bv = b[i] ?? 0
    if (av > bv) return true
    if (av < bv) return false
  }
  return true
}

/**
 * Check if a specific capability is available given the instance's
 * reported protocol version.
 */
export function isCapabilityAvailable(
  capability: CapabilityKey,
  instanceProtocolVersion: number | undefined,
): boolean {
  if (instanceProtocolVersion === undefined) return false
  return instanceProtocolVersion >= CAPABILITIES[capability].minProtocolVersion
}

/**
 * Given instance metadata, extract the protocol version.
 * Falls back to 1 for instances that predate the version field
 * (they support the original tab set).
 */
export function getProtocolVersion(metadata: Record<string, unknown> | null | undefined): number {
  const v = metadata?.protocolVersion
  return typeof v === 'number' ? v : 1
}

/**
 * Latency thresholds for the connection quality indicator.
 */
export const LATENCY_THRESHOLDS = {
  good: 150,
  fair: 400,
} as const

export type ConnectionQuality = 'good' | 'fair' | 'poor' | 'unknown'
export type ConnectionMode = 'cloud' | 'lan' | 'hybrid'

export function classifyLatency(ms: number): ConnectionQuality {
  if (ms <= LATENCY_THRESHOLDS.good) return 'good'
  if (ms <= LATENCY_THRESHOLDS.fair) return 'fair'
  return 'poor'
}
