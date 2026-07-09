// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { app } from 'electron'
import path from 'path'
import fs from 'fs'
import crypto from 'crypto'
import os from 'os'

export interface VMIsolationConfig {
  enabled: boolean | 'auto'
  /** Maximum RAM ceiling for VMs in MB. Assigned VMs get inflated to this
   *  ceiling on /pool/assign. */
  memoryMB: number
  /** Initial RAM target for warm-pool VMs in MB. Lower values let pool
   *  VMs idle at a small footprint; the controller balloon-deflates back
   *  to `memoryMB` on assignment. Set to the same value as `memoryMB` to
   *  disable right-sizing. */
  poolMemoryMB: number
  cpus: number
  /** Share the host workspace directory into the VM via 9p mount.
   *  When true (default), the VM sees host project files via 9p.
   *  When false, the VM uses an isolated overlay disk. */
  mountWorkspace: boolean
}

export interface HostRuntimeConfig {
  /** Per-project RAM ceiling in MB for the host-spawned agent-runtime process
   *  group (bun + vite + preview sidecars). Enforced via cgroup v2 on Linux, a
   *  Job Object on Windows, and an RSS watchdog on macOS. */
  memoryMB: number
  /** CPU ceiling as a percentage of a single core (100 = one full core). Only
   *  enforced where the OS supports it (cgroup CPUQuota on Linux). 0 = no cap. */
  cpuPercent: number
  /** Number of generic (PROJECT_ID=__POOL__) runtimes to keep pre-booted so a
   *  project open can claim one and skip the cold spawn. 0 = disabled. */
  warmPoolSize: number
}

export interface MeetingConfig {
  autoDetect: boolean
  autoRecord: boolean
  autoRecordConfirmCount: number
  gracePeriodSeconds: number
  autoStopSeconds: number
  whisperModel: string
  useCloudTranscription: boolean
}

export interface BugReportConfig {
  discordWebhookUrl?: string
  githubRepo?: string
  githubToken?: string
  maxLogLines?: number
}

export interface DesktopConfig {
  mode: 'local' | 'cloud'
  vmIsolation: VMIsolationConfig
  hostRuntime: HostRuntimeConfig
  meetings: MeetingConfig
  bugReport?: BugReportConfig
  /** Stable per-machine identifier. Generated on first launch and used so
   * Shogo Cloud can dedupe device-session API keys when the same desktop
   * install signs in multiple times. Treated as non-secret metadata — the
   * minted API key is still the only credential. */
  deviceId: string
}

/** Default Shogo Cloud endpoint used when SHOGO_CLOUD_URL is not set. */
const SHOGO_CLOUD_URL_DEFAULT = 'https://studio.shogo.ai'

/**
 * Resolve the Shogo Cloud endpoint for this desktop process.
 *
 * Single source of truth: the `SHOGO_CLOUD_URL` env var (default
 * https://studio.shogo.ai). Per-install JSON overrides are deliberately
 * NOT supported — set the env var (e.g. for staging) before launching the
 * desktop binary.
 */
export function getCloudUrl(): string {
  return (process.env.SHOGO_CLOUD_URL || SHOGO_CLOUD_URL_DEFAULT).replace(/\/$/, '')
}

const DEFAULT_VM_CONFIG: VMIsolationConfig = {
  enabled: false,
  memoryMB: 4096,
  poolMemoryMB: 1536,
  cpus: 0,  // 0 = auto (half physical cores)
  mountWorkspace: true,
}

const DEFAULT_HOST_RUNTIME_CONFIG: HostRuntimeConfig = {
  memoryMB: 2048,
  cpuPercent: 0,  // 0 = no CPU cap
  warmPoolSize: 0,  // 0 = warm pool disabled
}

const DEFAULT_MEETING_CONFIG: MeetingConfig = {
  autoDetect: true,
  autoRecord: false,
  autoRecordConfirmCount: 0,
  gracePeriodSeconds: 10,
  autoStopSeconds: 60,
  whisperModel: 'base.en',
  useCloudTranscription: false,
}

const DEFAULT_CONFIG: Omit<DesktopConfig, 'deviceId'> = {
  mode: 'local',
  vmIsolation: { ...DEFAULT_VM_CONFIG },
  hostRuntime: { ...DEFAULT_HOST_RUNTIME_CONFIG },
  meetings: { ...DEFAULT_MEETING_CONFIG },
}

function getConfigPath(): string {
  return path.join(app.getPath('userData'), 'config.json')
}

function generateDeviceId(): string {
  return crypto.randomUUID()
}

export function readConfig(): DesktopConfig {
  let parsed: any = {}
  try {
    const raw = fs.readFileSync(getConfigPath(), 'utf-8')
    parsed = JSON.parse(raw)
  } catch {
    parsed = {}
  }

  const existingDeviceId = typeof parsed.deviceId === 'string' && parsed.deviceId ? parsed.deviceId : null

  const config: DesktopConfig = {
    mode: parsed.mode === 'cloud' ? 'cloud' : 'local',
    vmIsolation: {
      ...DEFAULT_VM_CONFIG,
      ...(typeof parsed.vmIsolation === 'object' && parsed.vmIsolation !== null
        ? parsed.vmIsolation
        : {}),
    },
    hostRuntime: {
      ...DEFAULT_HOST_RUNTIME_CONFIG,
      ...(typeof parsed.hostRuntime === 'object' && parsed.hostRuntime !== null
        ? parsed.hostRuntime
        : {}),
    },
    meetings: {
      ...DEFAULT_MEETING_CONFIG,
      ...(typeof parsed.meetings === 'object' && parsed.meetings !== null
        ? parsed.meetings
        : {}),
    },
    bugReport: typeof parsed.bugReport === 'object' && parsed.bugReport !== null
      ? parsed.bugReport
      : undefined,
    deviceId: existingDeviceId || generateDeviceId(),
  }

  // Persist the freshly generated deviceId so all subsequent reads are stable.
  if (!existingDeviceId) {
    try {
      fs.writeFileSync(getConfigPath(), JSON.stringify({ ...parsed, deviceId: config.deviceId }, null, 2))
    } catch {
      // Best-effort; if we can't persist we just regenerate next launch.
    }
  }

  return config
}

export function writeConfig(config: Partial<DesktopConfig>): DesktopConfig {
  const current = readConfig()
  const merged: DesktopConfig = { ...current, ...config }
  fs.writeFileSync(getConfigPath(), JSON.stringify(merged, null, 2))
  return merged
}

export interface DeviceInfo {
  id: string
  name: string
  platform: NodeJS.Platform
  appVersion: string
}

/** Read-only identity bundle for the current desktop install. Safe to hand
 * to the renderer and include in the cloud device-login mint call. */
export function getDeviceInfo(): DeviceInfo {
  const { deviceId } = readConfig()
  return {
    id: deviceId,
    name: os.hostname() || 'Shogo Desktop',
    platform: process.platform,
    appVersion: app.getVersion(),
  }
}
