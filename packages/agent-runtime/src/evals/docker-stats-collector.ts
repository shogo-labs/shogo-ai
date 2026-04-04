// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Lightweight Docker container resource monitor.
 *
 * Polls `docker stats --no-stream` at a configurable interval and tracks
 * peak/average CPU (millicores) and memory (MiB) for a named container.
 */

import { execSync } from 'child_process'
import { cpus } from 'os'
import type { ContainerResourceMetrics } from './types'

const POLL_INTERVAL_MS = 2_000

export class DockerStatsCollector {
  private containerName: string
  private timer: ReturnType<typeof setInterval> | null = null
  private numCPUs: number
  private cpuSamples: number[] = []
  private memSamples: number[] = []

  constructor(containerName: string) {
    this.containerName = containerName
    this.numCPUs = cpus().length
  }

  start(): void {
    if (this.timer) return
    this.cpuSamples = []
    this.memSamples = []
    this.sample()
    this.timer = setInterval(() => this.sample(), POLL_INTERVAL_MS)
  }

  stop(): ContainerResourceMetrics | null {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    this.sample()

    if (this.cpuSamples.length === 0) return null

    const peakCpu = Math.max(...this.cpuSamples)
    const avgCpu = this.cpuSamples.reduce((a, b) => a + b, 0) / this.cpuSamples.length
    const peakMem = Math.max(...this.memSamples)
    const avgMem = this.memSamples.reduce((a, b) => a + b, 0) / this.memSamples.length

    return {
      peakCpuMillicores: Math.round(peakCpu),
      avgCpuMillicores: Math.round(avgCpu),
      peakMemoryMiB: Math.round(peakMem * 10) / 10,
      avgMemoryMiB: Math.round(avgMem * 10) / 10,
      samples: this.cpuSamples.length,
    }
  }

  private sample(): void {
    try {
      const raw = execSync(
        `docker stats --no-stream --format '{{json .}}' "${this.containerName}"`,
        { encoding: 'utf-8', stdio: 'pipe', timeout: 5_000 },
      ).trim()
      if (!raw) return

      const data = JSON.parse(raw)
      const cpuPercent = parseFloat(String(data.CPUPerc).replace('%', ''))
      const memUsage = parseMemoryMiB(String(data.MemUsage))

      if (!isNaN(cpuPercent)) {
        // Docker CPUPerc is relative to total host CPU (e.g. 800% on 8 cores = all cores).
        // Convert to millicores: percent / 100 * 1000.
        const millicores = (cpuPercent / 100) * 1000
        this.cpuSamples.push(millicores)
      }
      if (!isNaN(memUsage)) {
        this.memSamples.push(memUsage)
      }
    } catch {
      // Container may be gone or Docker daemon busy — skip this sample.
    }
  }
}

/** Parse the usage portion of Docker's MemUsage field (e.g. "156.2MiB / 7.653GiB") into MiB. */
function parseMemoryMiB(memUsage: string): number {
  const usagePart = memUsage.split('/')[0].trim()
  const match = usagePart.match(/^([\d.]+)\s*(B|KiB|MiB|GiB|TiB|kB|MB|GB|TB)$/i)
  if (!match) return NaN

  const value = parseFloat(match[1])
  switch (match[2].toLowerCase()) {
    case 'b': return value / (1024 * 1024)
    case 'kib': case 'kb': return value / 1024
    case 'mib': case 'mb': return value
    case 'gib': case 'gb': return value * 1024
    case 'tib': case 'tb': return value * 1024 * 1024
    default: return NaN
  }
}

/** Format millicores for display (e.g. 1500 -> "1500m", 0 -> "0m"). */
export function formatMillicores(m: number): string {
  return `${Math.round(m)}m`
}
