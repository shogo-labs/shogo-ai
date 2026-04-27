// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { app } from 'electron'
import path from 'path'
import fs from 'fs'
import crypto from 'crypto'
import os from 'os'

export interface VMIsolationConfig {
  enabled: boolean | 'auto'
  memoryMB: number
  cpus: number
  /** Share the host workspace directory into the VM via 9p mount.
   *  When true (default), the VM sees host project files via 9p.
   *  When false, the VM uses an isolated overlay disk. */
  mountWorkspace: boolean
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

export interface DesktopConfig {
  mode: 'local' | 'cloud'
  cloudUrl: string
  vmIsolation: VMIsolationConfig
  meetings: MeetingConfig
  /** Stable per-machine identifier. Generated on first launch and used so
   * Shogo Cloud can dedupe device-session API keys when the same desktop
   * install signs in multiple times. Treated as non-secret metadata — the
   * minted API key is still the only credential. */
  deviceId: string
}

const DEFAULT_VM_CONFIG: VMIsolationConfig = {
  enabled: 'auto',
  memoryMB: 1536,
  cpus: 0,  // 0 = auto (half physical cores)
  mountWorkspace: true,
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
  cloudUrl: 'https://studio.shogo.ai',
  vmIsolation: { ...DEFAULT_VM_CONFIG },
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
    cloudUrl: typeof parsed.cloudUrl === 'string' && parsed.cloudUrl
      ? parsed.cloudUrl
      : DEFAULT_CONFIG.cloudUrl,
    vmIsolation: {
      ...DEFAULT_VM_CONFIG,
      ...(typeof parsed.vmIsolation === 'object' && parsed.vmIsolation !== null
        ? parsed.vmIsolation
        : {}),
    },
    meetings: {
      ...DEFAULT_MEETING_CONFIG,
      ...(typeof parsed.meetings === 'object' && parsed.meetings !== null
        ? parsed.meetings
        : {}),
    },
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
