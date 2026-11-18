// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { useState, useEffect } from 'react'
import { View, Text, Pressable } from 'react-native'
import { Server, Cpu, HardDrive, BarChart3 } from 'lucide-react-native'
import { useActiveWorkspace } from '../../hooks/useActiveWorkspace'
import { useDomainHttp } from '../../contexts/domain'
import { api } from '../../lib/api'
import {
  getInstanceSize,
  formatStorageBytes,
  formatCpuPercent,
  formatMemoryGb,
  type InstanceSizeName,
} from '../../lib/instance-config'
import { ComputeUsageSection } from './ComputeUsageSection'
import {
  Card,
  CardContent,
  Badge,
  Skeleton,
  cn,
} from '@shogo/shared-ui/primitives'

type MetricsPeriod = '1h' | '6h' | '24h' | '7d' | '30d'

export function ComputeTab() {
  const http = useDomainHttp()
  const workspace = useActiveWorkspace()
  const workspaceId = workspace?.id
  const [instance, setInstance] = useState<any>(null)
  const [metrics, setMetrics] = useState<any>(null)
  const [metricsPeriod, setMetricsPeriod] = useState<MetricsPeriod>('24h')
  const [isLoading, setIsLoading] = useState(true)

  useEffect(() => {
    if (!workspaceId) return
    let cancelled = false
    setIsLoading(true)
    Promise.all([
      api.getWorkspaceInstance(http, workspaceId).catch(() => null),
      api.getWorkspaceMetrics(http, workspaceId, metricsPeriod).catch(() => null),
    ]).then(([inst, met]) => {
      if (!cancelled) {
        setInstance(inst)
        setMetrics(met)
        setIsLoading(false)
      }
    })
    return () => { cancelled = true }
  }, [workspaceId, http, metricsPeriod])

  if (!workspaceId) {
    return (
      <View className="py-12 items-center">
        <Text className="text-sm text-muted-foreground">No workspace selected</Text>
      </View>
    )
  }

  if (isLoading) {
    return (
      <View className="gap-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-48 w-full" />
      </View>
    )
  }

  const currentSize = (instance?.size ?? 'micro') as InstanceSizeName
  const currentSpec = getInstanceSize(currentSize)
  const storageTotalBytes = instance?.storage?.totalBytes ?? 0
  const storageLimitBytes = instance?.storage?.limitBytes ?? currentSpec.storageLimitGb * 1024 ** 3
  const storagePercent = storageLimitBytes > 0 ? Math.min((storageTotalBytes / storageLimitBytes) * 100, 100) : 0

  const cpuPercent = metrics?.current?.cpuPercent ?? 0
  const memoryBytes = metrics?.current?.memoryBytes ?? 0
  const memoryMaxBytes = currentSpec.memoryGb * 1024 ** 3
  const memoryPercent = memoryMaxBytes > 0 ? Math.min((memoryBytes / memoryMaxBytes) * 100, 100) : 0

  return (
    <View className="gap-4">
      <View>
        <Text className="text-lg font-bold text-foreground mb-1">Compute</Text>
        <Text className="text-xs text-muted-foreground">
          What this workspace has run and what it costs. Compute is billed on the machine time you use — there is no
          size to buy.
        </Text>
      </View>

      {/* Current Instance Card */}
      <Card>
        <CardContent className="p-4 gap-3">
          <View className="flex-row items-center gap-2">
            <Server size={18} className="text-primary" />
            <Text className="text-base font-semibold text-foreground">
              {currentSpec.label} Instance
            </Text>
            {currentSpec.dedicated && (
              <Badge variant="outline" className="ml-auto">
                <Text className="text-xs text-primary">Dedicated</Text>
              </Badge>
            )}
          </View>

          <View className="flex-row gap-4 mt-1">
            <View className="flex-1 gap-1">
              <View className="flex-row items-center gap-1.5">
                <Cpu size={14} className="text-muted-foreground" />
                <Text className="text-sm text-muted-foreground">CPU</Text>
              </View>
              <Text className="text-lg font-semibold text-foreground">{currentSpec.cpuLabel}</Text>
            </View>
            <View className="flex-1 gap-1">
              <View className="flex-row items-center gap-1.5">
                <BarChart3 size={14} className="text-muted-foreground" />
                <Text className="text-sm text-muted-foreground">Memory</Text>
              </View>
              <Text className="text-lg font-semibold text-foreground">{currentSpec.memoryLabel}</Text>
            </View>
          </View>

          {/* Storage bar */}
          <View className="gap-1.5 mt-1">
            <View className="flex-row items-center justify-between">
              <View className="flex-row items-center gap-1.5">
                <HardDrive size={14} className="text-muted-foreground" />
                <Text className="text-sm text-muted-foreground">Storage</Text>
              </View>
              <Text className="text-sm text-muted-foreground">
                {formatStorageBytes(storageTotalBytes)} / {currentSpec.storageLabel}
              </Text>
            </View>
            <View className="h-2 bg-muted rounded-full overflow-hidden">
              <View
                className={cn(
                  'h-full rounded-full',
                  storagePercent > 90 ? 'bg-destructive' : storagePercent > 70 ? 'bg-amber-500' : 'bg-primary',
                )}
                style={{ width: `${Math.max(storagePercent, 1)}%` }}
              />
            </View>
          </View>
        </CardContent>
      </Card>

      {/* Resource Usage Metrics */}
      {currentSpec.dedicated && metrics?.history?.timestamps?.length > 0 ? (
        <ResourceUsageSection
          metrics={metrics}
          currentSpec={currentSpec}
          metricsPeriod={metricsPeriod}
          onPeriodChange={setMetricsPeriod}
          cpuPercent={cpuPercent}
          memoryPercent={memoryPercent}
        />
      ) : null}

      {/* Metered compute: what this workspace actually ran and what it costs
          (SHO-424). Replaces the instance-size purchase cards — sizes are no
          longer sold, compute is billed on VM time. */}
      <ComputeUsageSection />
    </View>
  )
}

// ─── Resource Usage Section ─────────────────────────────────────────────────

function getBarColor(pct: number): string {
  if (pct > 80) return 'bg-destructive'
  if (pct > 60) return 'bg-amber-500'
  return 'bg-primary'
}

interface ResourceUsageSectionProps {
  metrics: any
  currentSpec: ReturnType<typeof getInstanceSize>
  metricsPeriod: MetricsPeriod
  onPeriodChange: (p: MetricsPeriod) => void
  cpuPercent: number
  memoryPercent: number
}

function ResourceUsageSection({
  metrics,
  currentSpec,
  metricsPeriod,
  onPeriodChange,
  cpuPercent,
  memoryPercent,
}: ResourceUsageSectionProps) {
  return (
    <Card>
      <CardContent className="p-4 gap-3">
        <View className="flex-row items-center justify-between">
          <Text className="text-base font-semibold text-foreground">Resource Usage</Text>
          <View className="flex-row gap-1">
            {(['1h', '6h', '24h', '7d', '30d'] as const).map((p) => (
              <Pressable
                key={p}
                onPress={() => onPeriodChange(p)}
                className={cn(
                  'px-2 py-1 rounded',
                  metricsPeriod === p ? 'bg-primary' : 'bg-muted',
                )}
              >
                <Text className={cn(
                  'text-xs font-medium',
                  metricsPeriod === p ? 'text-primary-foreground' : 'text-muted-foreground',
                )}>
                  {p}
                </Text>
              </Pressable>
            ))}
          </View>
        </View>

        {/* CPU gauge */}
        <View className="gap-1.5">
          <View className="flex-row items-center justify-between">
            <Text className="text-sm text-muted-foreground">CPU Usage</Text>
            <Text className="text-sm font-semibold text-foreground">
              {formatCpuPercent(cpuPercent)}
            </Text>
          </View>
          <View className="h-2.5 bg-muted rounded-full overflow-hidden">
            <View
              className={cn('h-full rounded-full', getBarColor(cpuPercent))}
              style={{ width: `${Math.max(cpuPercent, 1)}%` }}
            />
          </View>
        </View>

        {/* Memory gauge */}
        <View className="gap-1.5">
          <View className="flex-row items-center justify-between">
            <Text className="text-sm text-muted-foreground">Memory Usage</Text>
            <Text className="text-sm font-semibold text-foreground">
              {formatMemoryGb(metrics.current?.memoryBytes ?? 0)} / {currentSpec.memoryLabel}
            </Text>
          </View>
          <View className="h-2.5 bg-muted rounded-full overflow-hidden">
            <View
              className={cn('h-full rounded-full', getBarColor(memoryPercent))}
              style={{ width: `${Math.max(memoryPercent, 1)}%` }}
            />
          </View>
        </View>

        {/* CPU sparkline */}
        <View className="gap-2 mt-1">
          <Text className="text-xs text-muted-foreground">CPU over time</Text>
          <View className="flex-row items-end h-12 gap-px">
            {(metrics.history?.cpuPercent ?? []).slice(-30).map((val: number, i: number) => (
              <View
                key={i}
                className={cn('flex-1 rounded-t-sm', getBarColor(val))}
                style={{ height: `${Math.max(val, 2)}%`, opacity: 0.7 }}
              />
            ))}
          </View>
        </View>

        {/* Memory sparkline */}
        <View className="gap-2">
          <Text className="text-xs text-muted-foreground">Memory over time</Text>
          <View className="flex-row items-end h-12 gap-px">
            {(metrics.history?.memoryBytes ?? []).slice(-30).map((val: number, i: number) => {
              const maxMem = currentSpec.memoryGb * 1024 ** 3
              const pct = maxMem > 0 ? (val / maxMem) * 100 : 0
              return (
                <View
                  key={i}
                  className={cn('flex-1 rounded-t-sm', getBarColor(pct))}
                  style={{ height: `${Math.max(pct, 2)}%`, opacity: 0.7 }}
                />
              )
            })}
          </View>
        </View>
      </CardContent>
    </Card>
  )
}
