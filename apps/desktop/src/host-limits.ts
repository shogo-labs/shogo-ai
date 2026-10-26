// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * `host-limits.json` — the machine-level limits the agent runtime must honour,
 * published by the desktop app and watched by the worker.
 *
 * The runtime learns its limits from the environment at spawn, so an env var
 * can only ever change on a restart. Settings changes have to land on a running
 * app (SHO-203), so the values live in this file instead: the desktop writes it
 * on boot and on every settings change, the API forwards its path as
 * `SHOGO_HOST_LIMITS_FILE`, and both the exec memory guard and
 * `WorkerRuntimeManager` re-read it as it changes.
 */
import { mkdirSync, renameSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import {
  resolveExecMemoryMB,
  type ExecMemorySetting,
} from './runtime-memory'

export const HOST_LIMITS_FILE_NAME = 'host-limits.json'

/** What the desktop publishes. Keep it JSON-simple: other processes parse it. */
export interface HostLimits {
  /** MB the agent's `exec` commands may use, already resolved for this host. */
  execMemoryMB: number
  /** Total physical RAM of this computer, so the OOM note can name it. */
  totalMemMB: number
  /** `auto` = scaled to RAM, `settings` = an explicit value from Settings. */
  source: 'auto' | 'settings'
}

/** What the settings UI shows. */
export interface HostRuntimeView {
  /** The runtime's own leak ceiling. Unrelated to commands. */
  memoryMB: number
  cpuPercent: number
  execMemoryMB: ExecMemorySetting
  /** What `execMemoryMB` resolves to on this machine right now. */
  resolvedExecMemoryMB: number
  totalMemMB: number
}

export function hostLimitsPath(dataDir: string): string {
  return join(dataDir, HOST_LIMITS_FILE_NAME)
}

/** Resolve a settings value into the file's shape for a machine of this size. */
export function buildHostLimits(
  execMemory: ExecMemorySetting | undefined,
  totalMemMB: number,
): HostLimits {
  const source = execMemory === undefined || execMemory === 'auto' ? 'auto' : 'settings'
  return {
    execMemoryMB: resolveExecMemoryMB(execMemory, totalMemMB),
    totalMemMB: Math.floor(totalMemMB),
    source,
  }
}

/**
 * Write the limits file atomically (tmp + rename, like the exec PID file), so a
 * watcher never reads half a document and mistakes it for "no limit".
 * Returns the path, which is what the caller passes on as
 * `SHOGO_HOST_LIMITS_FILE`.
 */
export function writeHostLimits(dataDir: string, limits: HostLimits): string {
  const file = hostLimitsPath(dataDir)
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(limits))
  renameSync(tmp, file)
  return file
}

export function hostRuntimeView(
  config: { execMemoryMB?: ExecMemorySetting; memoryMB: number; cpuPercent: number },
  totalMemMB: number,
): HostRuntimeView {
  const total = Math.floor(totalMemMB)
  return {
    memoryMB: config.memoryMB,
    cpuPercent: config.cpuPercent,
    execMemoryMB: config.execMemoryMB ?? 'auto',
    resolvedExecMemoryMB: resolveExecMemoryMB(config.execMemoryMB, total),
    totalMemMB: total,
  }
}
