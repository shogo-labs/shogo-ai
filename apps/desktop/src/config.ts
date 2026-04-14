// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { app } from 'electron'
import path from 'path'
import fs from 'fs'

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

const DEFAULT_CONFIG: DesktopConfig = {
  mode: 'local',
  cloudUrl: 'https://studio.shogo.ai',
  vmIsolation: { ...DEFAULT_VM_CONFIG },
  meetings: { ...DEFAULT_MEETING_CONFIG },
}

function getConfigPath(): string {
  return path.join(app.getPath('userData'), 'config.json')
}

export function readConfig(): DesktopConfig {
  try {
    const raw = fs.readFileSync(getConfigPath(), 'utf-8')
    const parsed = JSON.parse(raw)
    return {
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
    }
  } catch {
    return { ...DEFAULT_CONFIG }
  }
}

export function writeConfig(config: Partial<DesktopConfig>): DesktopConfig {
  const current = readConfig()
  const merged: DesktopConfig = { ...current, ...config }
  fs.writeFileSync(getConfigPath(), JSON.stringify(merged, null, 2))
  return merged
}
