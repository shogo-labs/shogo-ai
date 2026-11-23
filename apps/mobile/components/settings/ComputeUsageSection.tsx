// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Workspace compute usage (SHO-424).
 *
 * Replaces the instance-size purchase cards: compute is now billed on the VM
 * time a workspace actually uses (vCPU-hours + GiB-hours, agent and app time
 * only — the idle tail is free), so this shows what ran and what it costs
 * instead of selling a monthly size.
 *
 * The server decides the shape: an owner/admin gets the per-project, per-size
 * and per-state split, a member gets the period total. Everything is labelled
 * "estimate" while the biller runs in shadow mode, because nothing is being
 * charged yet.
 */

import { useState, useEffect, useCallback } from 'react'
import { View, Text, Pressable } from 'react-native'
import { Calculator, Cpu, Clock, Zap } from 'lucide-react-native'
import { useActiveWorkspace } from '../../hooks/useActiveWorkspace'
import { useDomainHttp } from '../../contexts/domain'
import { api } from '../../lib/api'
import { Card, CardContent, Badge, cn } from '@shogo/shared-ui/primitives'
import { Spinner } from '@/components/ui/spinner'

interface UsageResponse {
  mode: 'shadow' | 'enforce'
  currency: string
  periodStart: string
  periodEnd: string
  rates: { vcpuHour: number; gibHour: number; idleBilling: 'full' | 'memory_only' | 'none' }
  totals: {
    activeVmHours: number
    totalVmHours: number
    vcpuHours: number
    gibHours: number
    estimatedUsd: number
    notBilledUsd: number
  }
  daily: Array<{ day: string; vmHours: number; activeVmHours: number; idleVmHours: number; estimatedUsd: number }>
  byProject?: Array<{
    projectId: string | null
    name: string
    activeVmHours: number
    idleVmHours: number
    estimatedUsd: number
  }>
  bySize?: Array<{
    label: string
    vcpus: number
    memMiB: number
    activeVmHours: number
    idleVmHours: number
    estimatedUsd: number
  }>
  byState?: Array<{ state: string; label: string; billed: boolean; vmHours: number; estimatedUsd: number }>
  byCause?: Array<{ cause: string; vmHours: number; billed: boolean; estimatedUsd: number }>
  runningNow?: Array<{ runtimeKey: string; name: string; memMiB: number; runningSinceMs: number | null }>
}

function money(usd: number): string {
  if (usd === 0) return '$0.00'
  if (usd < 0.01) return '<$0.01'
  return `$${usd.toFixed(2)}`
}

function hours(h: number): string {
  if (h === 0) return '0 h'
  if (h < 1) return `${Math.round(h * 60)} min`
  return `${h.toFixed(1)} h`
}

function duration(ms: number | null): string {
  if (ms === null || ms < 0) return ''
  const mins = Math.floor(ms / 60_000)
  if (mins < 60) return `${mins}m`
  const h = Math.floor(mins / 60)
  return `${h}h ${mins % 60}m`
}

const CAUSE_LABEL: Record<string, string> = {
  user_open: 'Opened by a person',
  agent_wake: 'Agent wake',
  schedule: 'Schedule',
  published: 'Published site (billed separately)',
  rewarm: 'Platform re-warm',
  prewarm: 'Platform pre-warm',
}

export function ComputeUsageSection() {
  const http = useDomainHttp()
  const workspace = useActiveWorkspace()
  const workspaceId = workspace?.id

  const [usage, setUsage] = useState<UsageResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(true)

  const load = useCallback(async () => {
    if (!workspaceId) return
    setIsLoading(true)
    try {
      const data = await api.getWorkspaceComputeUsage(http, workspaceId)
      setUsage(data)
      setError(null)
    } catch (e: any) {
      // Surface the server's own words — a generic "failed to load" strands
      // whoever is looking at a $0 bill.
      setError(e?.message ?? 'Could not load compute usage')
    } finally {
      setIsLoading(false)
    }
  }, [http, workspaceId])

  useEffect(() => {
    void load()
  }, [load])

  if (!workspaceId) {
    return (
      <View className="py-12 items-center">
        <Text className="text-sm text-muted-foreground">No workspace selected</Text>
      </View>
    )
  }

  if (isLoading) {
    return (
      <View className="py-12 items-center gap-3">
        <Spinner />
        <Text className="text-xs text-muted-foreground">Loading compute usage…</Text>
      </View>
    )
  }

  if (error) {
    return (
      <Card className="border-destructive/40">
        <CardContent className="p-4 gap-2">
          <Text className="text-sm font-semibold text-foreground">Compute usage unavailable</Text>
          <Text className="text-xs text-muted-foreground">{error}</Text>
          <Pressable onPress={() => void load()} className="mt-1">
            <Text className="text-xs font-medium text-primary">Try again</Text>
          </Pressable>
        </CardContent>
      </Card>
    )
  }

  if (!usage) return null

  const detailed = Array.isArray(usage.byProject)
  const shadow = usage.mode === 'shadow'
  const maxDay = Math.max(1, ...usage.daily.map((d) => d.vmHours))

  return (
    <View className="gap-4">
      {/* Headline: this period */}
      <Card>
        <CardContent className="p-4 gap-3">
          <View className="flex-row items-center gap-2">
            <Zap size={18} className="text-primary" />
            <Text className="text-base font-semibold text-foreground">This period</Text>
            <Badge variant="outline" className="ml-auto">
              <Text className="text-xs text-muted-foreground">
                {shadow ? 'Estimate' : 'Billed'}
              </Text>
            </Badge>
          </View>

          <View className="flex-row items-baseline gap-2">
            <Text className="text-3xl font-bold text-foreground">{money(usage.totals.estimatedUsd)}</Text>
            <Text className="text-xs text-muted-foreground">
              {shadow ? 'estimated, not yet charged' : 'charged to this workspace'}
            </Text>
          </View>

          <View className="flex-row flex-wrap gap-x-6 gap-y-2">
            <Stat label="Billed time" value={hours(usage.totals.activeVmHours)} />
            <Stat label="Idle (free)" value={hours(Math.max(0, usage.totals.totalVmHours - usage.totals.activeVmHours))} />
            <Stat label="vCPU-hours" value={usage.totals.vcpuHours.toFixed(1)} />
            <Stat label="GiB-hours" value={usage.totals.gibHours.toFixed(1)} />
          </View>

          <Text className="text-[11px] text-muted-foreground">
            ${usage.rates.vcpuHour.toFixed(2)}/vCPU-hour + ${usage.rates.gibHour.toFixed(3)}/GiB-hour, charged for the
            time an agent turn or your app was actually running. Idle time is metered but not billed.
          </Text>
        </CardContent>
      </Card>

      {/* 30-day chart */}
      {usage.daily.length > 0 && (
        <Card>
          <CardContent className="p-4 gap-3">
            <View className="flex-row items-center gap-2">
              <Clock size={16} className="text-muted-foreground" />
              <Text className="text-sm font-semibold text-foreground">Last 30 days</Text>
            </View>
            <View className="flex-row items-end h-20 gap-[2px]">
              {usage.daily.map((d) => (
                <View key={d.day} className="flex-1 justify-end" style={{ height: '100%' }}>
                  <View
                    className={cn('w-full rounded-t-sm', d.activeVmHours > 0 ? 'bg-primary' : 'bg-muted')}
                    style={{ height: `${Math.max((d.vmHours / maxDay) * 100, d.vmHours > 0 ? 4 : 1)}%` }}
                  />
                </View>
              ))}
            </View>
            <View className="flex-row justify-between">
              <Text className="text-[10px] text-muted-foreground">{usage.daily[0]?.day}</Text>
              <Text className="text-[10px] text-muted-foreground">
                peak {hours(maxDay)}/day
              </Text>
              <Text className="text-[10px] text-muted-foreground">
                {usage.daily[usage.daily.length - 1]?.day}
              </Text>
            </View>
          </CardContent>
        </Card>
      )}

      {/* Billed vs not billed */}
      {usage.byState && usage.byState.length > 0 && (
        <Card>
          <CardContent className="p-4 gap-3">
            <Text className="text-sm font-semibold text-foreground">Where the time went</Text>
            {usage.byState.map((s) => (
              <View key={s.state} className="flex-row items-center justify-between">
                <View className="flex-row items-center gap-2 flex-1">
                  <Text className="text-sm text-foreground flex-1" numberOfLines={2}>
                    {s.label}
                  </Text>
                  {!s.billed && (
                    <Badge variant="outline">
                      <Text className="text-[10px] text-muted-foreground">not billed</Text>
                    </Badge>
                  )}
                </View>
                <Text className="text-sm text-muted-foreground">{hours(s.vmHours)}</Text>
              </View>
            ))}
          </CardContent>
        </Card>
      )}

      {/* Per project (owner/admin only) */}
      {detailed && usage.byProject && usage.byProject.length > 0 && (
        <Card>
          <CardContent className="p-4 gap-3">
            <Text className="text-sm font-semibold text-foreground">By project</Text>
            {usage.byProject.map((p) => (
              <View key={p.projectId ?? 'workspace'} className="flex-row items-center justify-between">
                <Text className="text-sm text-foreground flex-1 mr-3" numberOfLines={2}>
                  {p.name}
                </Text>
                <Text className="text-xs text-muted-foreground mr-3">{hours(p.activeVmHours)}</Text>
                <Text className="text-sm text-foreground">{money(p.estimatedUsd)}</Text>
              </View>
            ))}
          </CardContent>
        </Card>
      )}

      {/* Per machine size (owner/admin only) */}
      {detailed && usage.bySize && usage.bySize.length > 0 && (
        <Card>
          <CardContent className="p-4 gap-3">
            <View className="flex-row items-center gap-2">
              <Cpu size={16} className="text-muted-foreground" />
              <Text className="text-sm font-semibold text-foreground">By machine size</Text>
            </View>
            {usage.bySize.map((s) => (
              <View key={s.label} className="flex-row items-center justify-between">
                <Text className="text-sm text-foreground flex-1 mr-3">{s.label}</Text>
                <Text className="text-xs text-muted-foreground mr-3">{hours(s.activeVmHours)}</Text>
                <Text className="text-sm text-foreground">{money(s.estimatedUsd)}</Text>
              </View>
            ))}
          </CardContent>
        </Card>
      )}

      {/* Running now (owner/admin only) */}
      {detailed && (
        <Card>
          <CardContent className="p-4 gap-3">
            <View className="flex-row items-center gap-2">
              <Calculator size={16} className="text-muted-foreground" />
              <Text className="text-sm font-semibold text-foreground">Running now</Text>
            </View>
            {usage.runningNow && usage.runningNow.length > 0 ? (
              usage.runningNow.map((r) => (
                <View key={r.runtimeKey} className="flex-row items-center justify-between">
                  <Text className="text-sm text-foreground flex-1 mr-3" numberOfLines={1}>
                    {r.name}
                  </Text>
                  <Text className="text-xs text-muted-foreground">
                    {r.memMiB > 0 ? `${(r.memMiB / 1024).toFixed(0)} GiB · ` : ''}
                    {duration(r.runningSinceMs) || 'live'}
                  </Text>
                </View>
              ))
            ) : (
              <Text className="text-xs text-muted-foreground">
                Nothing running right now. A runtime counts here while it is awake; idle runtimes are suspended and
                cost nothing.
              </Text>
            )}
          </CardContent>
        </Card>
      )}

      {/* Cause split (owner/admin only) */}
      {detailed && usage.byCause && usage.byCause.length > 0 && (
        <Card>
          <CardContent className="p-4 gap-2">
            <Text className="text-sm font-semibold text-foreground">What started it</Text>
            {usage.byCause.map((c) => (
              <View key={c.cause} className="flex-row items-center justify-between">
                <Text className="text-xs text-muted-foreground flex-1 mr-3">
                  {CAUSE_LABEL[c.cause] ?? c.cause}
                </Text>
                <Text className="text-xs text-muted-foreground">{hours(c.vmHours)}</Text>
              </View>
            ))}
          </CardContent>
        </Card>
      )}
    </View>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <View className="gap-0.5">
      <Text className="text-[11px] text-muted-foreground">{label}</Text>
      <Text className="text-sm font-semibold text-foreground">{value}</Text>
    </View>
  )
}
