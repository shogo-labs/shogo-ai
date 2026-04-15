// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { useState, useEffect, useCallback, useRef } from 'react'
import { View, Text, Pressable, Platform } from 'react-native'
import * as WebBrowser from 'expo-web-browser'
import * as ExpoLinking from 'expo-linking'
import {
  Server,
  Cpu,
  HardDrive,
  BarChart3,
  TrendingUp,
  TrendingDown,
} from 'lucide-react-native'
import { useActiveWorkspace } from '../../hooks/useActiveWorkspace'
import { useDomainHttp } from '../../contexts/domain'
import { useBillingData } from '@shogo/shared-app/hooks'
import { api } from '../../lib/api'
import {
  INSTANCE_SIZES,
  getInstanceSize,
  formatStorageBytes,
  formatCpuPercent,
  formatMemoryGb,
  type InstanceSizeName,
} from '../../lib/instance-config'
import { InstanceComparisonTable } from './InstanceComparisonTable'
import {
  Card,
  CardContent,
  Badge,
  Button,
  Alert,
  AlertTitle,
  AlertDescription,
  Skeleton,
  cn,
} from '@shogo/shared-ui/primitives'

type MetricsPeriod = '1h' | '6h' | '24h' | '7d' | '30d'

export function ComputeTab() {
  const http = useDomainHttp()
  const workspace = useActiveWorkspace()
  const workspaceId = workspace?.id
  const { subscription } = useBillingData(workspaceId)

  const [instance, setInstance] = useState<any>(null)
  const [metrics, setMetrics] = useState<any>(null)
  const [metricsPeriod, setMetricsPeriod] = useState<MetricsPeriod>('24h')
  const [isLoading, setIsLoading] = useState(true)
  const [isCheckoutLoading, setIsCheckoutLoading] = useState(false)
  const [billingInterval, setBillingInterval] = useState<'monthly' | 'annual'>('monthly')

  const tableSectionRef = useRef<View>(null)

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

  const handleInstanceCheckout = useCallback(async (size: InstanceSizeName) => {
    if (!workspaceId || size === 'micro') return
    setIsCheckoutLoading(true)
    try {
      const isNative = Platform.OS !== 'web'
      const redirectBase = isNative
        ? ExpoLinking.createURL('settings')
        : (typeof window !== 'undefined' ? window.location.origin : undefined)

      const data = await api.createInstanceCheckout(http, {
        workspaceId,
        instanceSize: size,
        billingInterval,
        ...(redirectBase && {
          successUrl: `${redirectBase}/?workspace=${workspaceId}&instance_checkout=success&session_id={CHECKOUT_SESSION_ID}`,
          cancelUrl: `${redirectBase}/?workspace=${workspaceId}&instance_checkout=canceled`,
        }),
      })

      if (data.url) {
        if (!isNative) {
          window.location.href = data.url
        } else {
          const scheme = ExpoLinking.createURL('')
          await WebBrowser.openAuthSessionAsync(data.url, scheme)
        }
      }
    } catch (e) {
      console.warn('[Compute] checkout failed:', e)
    } finally {
      setIsCheckoutLoading(false)
    }
  }, [http, workspaceId, billingInterval])

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
          Manage your workspace instance size and monitor resource usage.
        </Text>
      </View>

      {/* Resize recommendation */}
      <ResizeRecommendation
        currentSize={currentSize}
        cpuPercent={cpuPercent}
        memoryPercent={memoryPercent}
        isDedicated={currentSpec.dedicated}
      />

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
      ) : !currentSpec.dedicated ? (
        <Card className="border-dashed border-primary/30">
          <CardContent className="p-4 items-center gap-2">
            <BarChart3 size={24} className="text-primary" />
            <Text className="text-sm font-medium text-foreground text-center">
              Upgrade to a dedicated instance for detailed resource metrics.
            </Text>
          </CardContent>
        </Card>
      ) : null}

      {/* Billing interval toggle */}
      <View className="flex-row items-center justify-between mt-2">
        <Text className="text-base font-semibold text-foreground">Instance Sizes</Text>
        <View className="flex-row border border-border rounded-lg bg-muted/60 p-0.5">
          <Pressable
            onPress={() => setBillingInterval('monthly')}
            className={cn(
              'px-3 py-1.5 rounded-md',
              billingInterval === 'monthly' && 'bg-primary',
            )}
          >
            <Text className={cn(
              'text-xs font-medium',
              billingInterval === 'monthly' ? 'text-primary-foreground' : 'text-foreground',
            )}>
              Monthly
            </Text>
          </Pressable>
          <Pressable
            onPress={() => setBillingInterval('annual')}
            className={cn(
              'px-3 py-1.5 rounded-md',
              billingInterval === 'annual' && 'bg-primary',
            )}
          >
            <Text className={cn(
              'text-xs font-medium',
              billingInterval === 'annual' ? 'text-primary-foreground' : 'text-foreground',
            )}>
              Annual
            </Text>
          </Pressable>
        </View>
      </View>

      {/* Instance Comparison Table */}
      <View ref={tableSectionRef}>
        <InstanceComparisonTable
          currentSize={currentSize}
          billingInterval={billingInterval}
          onSelectSize={handleInstanceCheckout}
          isCheckoutLoading={isCheckoutLoading}
        />
      </View>
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

// ─── Resize Recommendation ──────────────────────────────────────────────────

function ResizeRecommendation({
  currentSize,
  cpuPercent,
  memoryPercent,
  isDedicated,
}: {
  currentSize: InstanceSizeName
  cpuPercent: number
  memoryPercent: number
  isDedicated: boolean
}) {
  if (!isDedicated) return null

  const currentIdx = INSTANCE_SIZES.findIndex((s) => s.name === currentSize)
  const shouldUpgrade = cpuPercent > 75 || memoryPercent > 75
  const shouldDowngrade = cpuPercent < 20 && memoryPercent < 20 && currentIdx > 1

  if (!shouldUpgrade && !shouldDowngrade) return null

  if (shouldUpgrade) {
    const nextSize = currentIdx < INSTANCE_SIZES.length - 1
      ? INSTANCE_SIZES[currentIdx + 1]
      : null

    return (
      <Alert>
        <TrendingUp size={16} className="text-amber-500" />
        <AlertTitle>High resource usage detected</AlertTitle>
        <AlertDescription>
          {cpuPercent > 75 && memoryPercent > 75
            ? `CPU (${cpuPercent.toFixed(0)}%) and memory (${memoryPercent.toFixed(0)}%) are both above 75%.`
            : cpuPercent > 75
              ? `CPU usage is at ${cpuPercent.toFixed(0)}%.`
              : `Memory usage is at ${memoryPercent.toFixed(0)}%.`}
          {nextSize ? ` Consider upgrading to ${nextSize.label} for better performance.` : ' You are on the largest available instance.'}
        </AlertDescription>
      </Alert>
    )
  }

  const prevSize = INSTANCE_SIZES[currentIdx - 1]
  return (
    <Alert>
      <TrendingDown size={16} className="text-blue-500" />
      <AlertTitle>Instance may be over-provisioned</AlertTitle>
      <AlertDescription>
        CPU ({cpuPercent.toFixed(0)}%) and memory ({memoryPercent.toFixed(0)}%) are both under 20%.
        You could save by downgrading to {prevSize.label}.
      </AlertDescription>
    </Alert>
  )
}
