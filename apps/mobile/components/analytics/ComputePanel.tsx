// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Admin → Analytics → Compute (SHO-424).
 *
 * The fleet's microVM compute, in the terms an operator needs: how many VM
 * hours the platform ran, how much of that is billable, what it would bill
 * under the current pricing, and how that compares to the host bill. The
 * reconciliation line at the bottom is the one to read first — a host that runs
 * VMs but never reported a meter is invisible to billing, and that is the
 * failure this panel exists to surface before an invoice does.
 */

import { useCallback, useEffect, useState } from 'react'
import { View, Text } from 'react-native'
import { Cpu, Server, AlertTriangle } from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import { fetchAdminJson } from '../../app/(admin)/_analytics-shared'

interface ComputeSummary {
  mode: 'shadow' | 'enforce'
  windowStart: string
  generatedAt: string
  rates: { vcpuHour: number; gibHour: number; idleBilling: string }
  fleet: {
    hosts: number
    hostMonthlyUsd: number
    hostCostUsd: number
    marginUsd: number
    assignedNow: number
    livenessNow: { appActive: number; agentActive: number; idleTail: number } | null
  }
  totals: {
    vmHours: number
    activeVmHours: number
    idleVmHours: number
    billableUsd: number
    platformOverheadUsd: number
    stampedUsd: number
    stampedRows: number
  }
  byCause: Array<{ cause: string; vmHours: number; estimatedUsd: number; notBilledUsd: number }>
  topWorkspaces: Array<{
    workspaceId: string
    name: string
    vmHours: number
    activeVmHours: number
    estimatedUsd: number
    notBilledUsd: number
  }>
  reconciliation: { hostsReportingUsage: number; hostsMissingMeter: string[] }
}

const CAUSE_LABEL: Record<string, string> = {
  user_open: 'Opened by a person',
  agent_wake: 'Agent wake',
  schedule: 'Schedule',
  published: 'Published site (billed separately)',
  rewarm: 'Platform re-warm',
  prewarm: 'Platform pre-warm',
}

function money(usd: number): string {
  if (Math.abs(usd) >= 1000) return `$${(usd / 1000).toFixed(1)}k`
  return `$${usd.toFixed(2)}`
}

function hrs(h: number): string {
  if (h >= 1000) return `${(h / 1000).toFixed(1)}k h`
  return `${h.toFixed(h < 10 ? 1 : 0)} h`
}

export function ComputePanel() {
  const [data, setData] = useState<ComputeSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    const res = await fetchAdminJson<ComputeSummary>('/compute')
    setData(res)
    setFailed(!res)
    setLoading(false)
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  if (loading) {
    return (
      <View className="rounded-xl border border-border bg-card p-4">
        <Text className="text-sm text-muted-foreground">Loading compute…</Text>
      </View>
    )
  }

  if (failed || !data || !data.totals || !data.fleet) {
    return (
      <View className="rounded-xl border border-border bg-card p-4 gap-1">
        <Text className="text-sm font-semibold text-foreground">Compute</Text>
        <Text className="text-xs text-muted-foreground">
          Could not load fleet compute (super admin required, or the meter has not run yet).
        </Text>
      </View>
    )
  }

  const shadow = data.mode === 'shadow'
  // A partial payload must not blank the whole analytics screen: this renders
  // inside a page with no error boundary, and every one of these blocks is
  // optional in the sense that its absence is a fact to show, not a crash.
  const reconciliation = data.reconciliation ?? { hostsReportingUsage: 0, hostsMissingMeter: [] }
  const missingMeter = reconciliation.hostsMissingMeter ?? []
  const byCause = data.byCause ?? []
  const topWorkspaces = data.topWorkspaces ?? []

  return (
    <View className="gap-3">
      <View className="flex-row items-center gap-2">
        <Cpu size={18} className="text-primary" />
        <Text className="text-base font-bold text-foreground">Compute</Text>
        <View className={cn('rounded px-2 py-0.5', shadow ? 'bg-amber-500/15' : 'bg-primary/15')}>
          <Text className={cn('text-[10px] font-semibold', shadow ? 'text-amber-600' : 'text-primary')}>
            {shadow ? 'SHADOW — not charged' : 'ENFORCE — charging'}
          </Text>
        </View>
      </View>

      <View className="flex-row flex-wrap gap-2">
        <Tile label="VM hours (MTD)" value={hrs(data.totals.vmHours)} sub={`${hrs(data.totals.activeVmHours)} billable`} />
        <Tile label="Would bill" value={money(data.totals.billableUsd)} sub={`${money(data.totals.platformOverheadUsd)} not billed`} />
        <Tile label="Stamped" value={money(data.totals.stampedUsd)} sub={`${data.totals.stampedRows} hour rows`} />
        <Tile label="Host cost / MTD" value={money(data.fleet.hostCostUsd)} sub={`${data.fleet.hosts} hosts × $${data.fleet.hostMonthlyUsd}`} />
        <Tile
          label="Margin"
          value={money(data.fleet.marginUsd)}
          sub={data.fleet.marginUsd >= 0 ? 'billable covers hosts' : 'hosts cost more'}
          tone={data.fleet.marginUsd >= 0 ? 'good' : 'bad'}
        />
        <Tile label="Running now" value={String(data.fleet.assignedNow)} sub={`${data.fleet.livenessNow?.agentActive ?? 0} agent · ${data.fleet.livenessNow?.appActive ?? 0} app · ${data.fleet.livenessNow?.idleTail ?? 0} idle`} />
      </View>

      {byCause.length > 0 && (
        <View className="rounded-xl border border-border bg-card p-3 gap-1">
          <Text className="text-xs font-semibold text-foreground mb-1">By cause</Text>
          {byCause.map((c) => (
            <View key={c.cause} className="flex-row items-center justify-between">
              <Text className="text-xs text-muted-foreground flex-1 mr-2">{CAUSE_LABEL[c.cause] ?? c.cause}</Text>
              <Text className="text-xs text-muted-foreground mr-3">{hrs(c.vmHours)}</Text>
              <Text className="text-xs text-foreground">{money(c.estimatedUsd)}</Text>
            </View>
          ))}
        </View>
      )}

      {topWorkspaces.length > 0 && (
        <View className="rounded-xl border border-border bg-card p-3 gap-1">
          <Text className="text-xs font-semibold text-foreground mb-1">Top workspaces (MTD)</Text>
          {topWorkspaces.slice(0, 10).map((w) => (
            <View key={w.workspaceId} className="flex-row items-center justify-between">
              <Text className="text-xs text-foreground flex-1 mr-2" numberOfLines={1}>{w.name}</Text>
              <Text className="text-xs text-muted-foreground mr-3">{hrs(w.vmHours)}</Text>
              <Text className="text-xs text-foreground">{money(w.estimatedUsd)}</Text>
            </View>
          ))}
        </View>
      )}

      <View
        className={cn(
          'rounded-xl border p-3 gap-1',
          missingMeter.length > 0 ? 'border-amber-500/40 bg-amber-500/5' : 'border-border bg-card',
        )}
      >
        <View className="flex-row items-center gap-2">
          {missingMeter.length > 0 ? (
            <AlertTriangle size={14} className="text-amber-600" />
          ) : (
            <Server size={14} className="text-muted-foreground" />
          )}
          <Text className="text-xs font-semibold text-foreground">Meter coverage</Text>
        </View>
        <Text className="text-xs text-muted-foreground">
          {reconciliation.hostsReportingUsage} host(s) reported usage in the last 72h.{' '}
          {missingMeter.length === 0
            ? 'Every host with assigned VMs is reporting — ingested hours should track the fleet.'
            : `${missingMeter.length} host(s) are running VMs but reporting nothing: ${missingMeter.join(', ')}. Their hours are invisible to billing until they heartbeat a meter.`}
        </Text>
        <Text className="text-[10px] text-muted-foreground">
          Rates: ${data.rates.vcpuHour.toFixed(2)}/vCPU-h + ${data.rates.gibHour.toFixed(3)}/GiB-h, idle billed:{' '}
          {data.rates.idleBilling}.
        </Text>
      </View>
    </View>
  )
}

function Tile({
  label,
  value,
  sub,
  tone,
}: {
  label: string
  value: string
  sub?: string
  tone?: 'good' | 'bad'
}) {
  return (
    <View className="flex-1 min-w-[140px] rounded-xl border border-border bg-card p-3">
      <Text className="text-[11px] font-medium text-muted-foreground">{label}</Text>
      <Text
        className={cn(
          'text-lg font-bold',
          tone === 'good' ? 'text-emerald-600' : tone === 'bad' ? 'text-destructive' : 'text-foreground',
        )}
      >
        {value}
      </Text>
      {sub ? <Text className="text-[10px] text-muted-foreground">{sub}</Text> : null}
    </View>
  )
}
