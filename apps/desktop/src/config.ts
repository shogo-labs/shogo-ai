// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { app } from 'electron'
import path from 'path'
import fs from 'fs'

export interface VMIsolationConfig {
  enabled: boolean | 'auto'
  memoryMB: number
  cpus: number
}

export interface DesktopConfig {
  mode: 'local' | 'cloud'
  cloudUrl: string
  vmIsolation: VMIsolationConfig
}

const DEFAULT_VM_CONFIG: VMIsolationConfig = {
  enabled: 'auto',
  memoryMB: 4096,
  cpus: 0,  // 0 = auto (half physical cores)
}

const DEFAULT_CONFIG: DesktopConfig = {
  mode: 'local',
  cloudUrl: 'https://studio.shogo.ai',
  vmIsolation: { ...DEFAULT_VM_CONFIG },
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
