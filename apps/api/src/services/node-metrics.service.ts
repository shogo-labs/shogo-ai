// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Metrics Service — proxies SigNoz queries for per-workspace resource usage.
 *
 * SigNoz k8s-infra chart collects standard k8s.pod.* metrics via OTLP.
 * This service queries SigNoz server-side and returns sanitized time series
 * data scoped to a workspace's project pods. The user never sees SigNoz URLs,
 * credentials, or internal infrastructure names.
 */

import { prisma } from '../lib/prisma'

const SIGNOZ_ENDPOINT = process.env.SIGNOZ_QUERY_ENDPOINT
  || process.env.OTEL_EXPORTER_OTLP_ENDPOINT
  || ''

const SIGNOZ_KEY = process.env.SIGNOZ_INGESTION_KEY || ''

export type MetricsPeriod = '1h' | '6h' | '24h' | '7d' | '30d'

export interface MetricsTimeSeries {
  timestamps: number[]
  cpuPercent: number[]
  memoryBytes: number[]
}

export interface WorkspaceMetrics {
  current: {
    cpuPercent: number
    memoryBytes: number
    memoryTotalBytes: number
  }
  history: MetricsTimeSeries
  period: MetricsPeriod
}

const PERIOD_SECONDS: Record<MetricsPeriod, number> = {
  '1h': 3600,
  '6h': 21600,
  '24h': 86400,
  '7d': 604800,
  '30d': 2592000,
}

const STEP_SECONDS: Record<MetricsPeriod, number> = {
  '1h': 60,
  '6h': 300,
  '24h': 900,
  '7d': 3600,
  '30d': 14400,
}

export async function getWorkspaceMetrics(
  workspaceId: string,
  period: MetricsPeriod = '24h',
): Promise<WorkspaceMetrics | null> {
  if (!SIGNOZ_ENDPOINT) {
    return getFallbackMetrics(period)
  }

  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { id: true },
  })

  if (!workspace) return null

  return queryPodMetrics(workspaceId, period)
}

async function queryPodMetrics(
  workspaceId: string,
  period: MetricsPeriod,
): Promise<WorkspaceMetrics> {
  const projects = await prisma.project.findMany({
    where: { workspaceId, knativeServiceName: { not: null } },
    select: { id: true },
  })

  if (projects.length === 0) {
    return getFallbackMetrics(period)
  }

  const now = Math.floor(Date.now() / 1000)
  const start = now - PERIOD_SECONDS[period]
  const step = STEP_SECONDS[period]

  const projectIds = projects.map((p) => p.id)
  const podFilter = projectIds.map((id) => `k8s_pod_name=~"project-${id}.*"`).join('|')

  try {
    const [cpuData, memData] = await Promise.all([
      querySigNoz({
        query: `sum(rate(k8s_pod_cpu_time{${podFilter}}[5m])) * 100`,
        start,
        end: now,
        step,
      }),
      querySigNoz({
        query: `sum(k8s_pod_memory_working_set{${podFilter}})`,
        start,
        end: now,
        step,
      }),
    ])

    const timestamps = cpuData.map((p: any) => p[0] * 1000)
    const cpuPercent = cpuData.map((p: any) => parseFloat(p[1]) || 0)
    const memoryBytes = memData.map((p: any) => parseFloat(p[1]) || 0)

    return {
      current: {
        cpuPercent: cpuPercent[cpuPercent.length - 1] || 0,
        memoryBytes: memoryBytes[memoryBytes.length - 1] || 0,
        memoryTotalBytes: 0,
      },
      history: { timestamps, cpuPercent, memoryBytes },
      period,
    }
  } catch (err: any) {
    console.error(`[Metrics] SigNoz pod query failed for workspace ${workspaceId}:`, err.message)
    return getFallbackMetrics(period)
  }
}

async function querySigNoz(params: {
  query: string
  start: number
  end: number
  step: number
}): Promise<Array<[number, string]>> {
  const url = new URL('/api/v1/query_range', SIGNOZ_ENDPOINT)
  url.searchParams.set('query', params.query)
  url.searchParams.set('start', String(params.start))
  url.searchParams.set('end', String(params.end))
  url.searchParams.set('step', String(params.step))

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }
  if (SIGNOZ_KEY) {
    headers['signoz-access-token'] = SIGNOZ_KEY
  }

  const response = await fetch(url.toString(), { headers })

  if (!response.ok) {
    throw new Error(`SigNoz query failed: ${response.status} ${response.statusText}`)
  }

  const data = await response.json() as any

  if (data?.data?.result?.[0]?.values) {
    return data.data.result[0].values
  }

  return []
}

function getFallbackMetrics(period: MetricsPeriod): WorkspaceMetrics {
  return {
    current: { cpuPercent: 0, memoryBytes: 0, memoryTotalBytes: 0 },
    history: { timestamps: [], cpuPercent: [], memoryBytes: [] },
    period,
  }
}
