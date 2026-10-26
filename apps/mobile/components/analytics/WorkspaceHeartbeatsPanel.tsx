// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * WorkspaceHeartbeatsPanel
 *
 * Heartbeats tab of the workspace Analytics screen: every agent with a
 * heartbeat on — plus any that spent in the window and has since been switched
 * off — with its interval, quiet hours, model, last/next tick, tick count and
 * what it cost, next to the share of the workspace's spend it accounts for.
 *
 * The endpoint is Business plan or higher, so a 403 renders the upgrade note
 * instead of a bare error. Owners/admins see the whole workspace; a member sees
 * the projects they can read, and only gets "Turn off" on the ones they may
 * write. Turning one off is the existing project heartbeat PATCH — no new write
 * path — and the row is re-read afterwards so the numbers stay honest.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ActivityIndicator, Pressable, ScrollView, View } from 'react-native'
import { useRouter } from 'expo-router'
import {
  Activity,
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  Coins,
  Gauge,
  Lock,
  Moon,
} from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import {
  AlertDialog,
  AlertDialogBackdrop,
  AlertDialogBody,
  AlertDialogContent,
  AlertDialogFooter,
  AlertDialogHeader,
} from '@/components/ui/alert-dialog'
import { Button, ButtonText } from '@/components/ui/button'
import { Heading } from '@/components/ui/heading'
import { Text as UIText } from '@/components/ui/text'
import { useDomainHttp } from '../../contexts/domain'
import { useActiveWorkspace } from '../../hooks/useActiveWorkspace'
import { api } from '../../lib/api'
import { compactNumber } from '../../lib/engagement-utils'
import { nativeActivePill } from '../../lib/native-active-shadow'
import { Text } from '../settings/account-sheet-chrome'
import { LoadErrorNotice } from './LoadErrorNotice'
import { StatCard, formatDollarCost, getModelDisplayName } from './SharedAnalytics'

export type HeartbeatPeriod = '24h' | '7d' | '30d'

export interface HeartbeatAgentRow {
  projectId: string
  projectName: string
  owner: { userId: string; name: string | null; email: string | null } | null
  enabled: boolean
  intervalSeconds: number
  quietHours: { start: string; end: string; timezone: string | null } | null
  lastHeartbeatAt: string | null
  nextHeartbeatAt: string | null
  configuredModel: string
  configuredModelLabel: string | null
  modelsUsed: Array<{ model: string; billedUsd: number }>
  ticks: number
  billedUsd: number
  rawUsd: number
  totalTokens: number
  avgUsdPerTick: number | null
  canEdit: boolean
}

export interface WorkspaceHeartbeatsReport {
  period: HeartbeatPeriod
  window: { from: string; to: string }
  totals: {
    agentsEnabled: number
    agentsWithSpend: number
    ticks: number
    billedUsd: number
    rawUsd: number
    totalTokens: number
    workspaceBilledUsd: number
  }
  daily: Array<{ date: string; heartbeatUsd: number; otherUsd: number }>
  agents: HeartbeatAgentRow[]
}

const PERIODS: Array<{ id: HeartbeatPeriod; label: string }> = [
  { id: '24h', label: '24h' },
  { id: '7d', label: '7d' },
  { id: '30d', label: '30d' },
]

type SortKey = 'agent' | 'owner' | 'interval' | 'quiet' | 'model' | 'last' | 'next' | 'ticks' | 'spend' | 'avg'

const COLUMNS: { key: string; label: string; width: number; align?: 'right'; sort?: SortKey }[] = [
  { key: 'agent', label: 'Agent', width: 200, sort: 'agent' },
  { key: 'owner', label: 'Owner', width: 130, sort: 'owner' },
  { key: 'interval', label: 'Interval', width: 104, sort: 'interval' },
  { key: 'quiet', label: 'Quiet hours', width: 118, sort: 'quiet' },
  { key: 'model', label: 'Model', width: 130, sort: 'model' },
  { key: 'last', label: 'Last tick', width: 88, align: 'right', sort: 'last' },
  { key: 'next', label: 'Next tick', width: 88, align: 'right', sort: 'next' },
  { key: 'ticks', label: 'Ticks', width: 60, align: 'right', sort: 'ticks' },
  { key: 'spend', label: 'Spend', width: 84, align: 'right', sort: 'spend' },
  { key: 'avg', label: 'Avg / tick', width: 86, align: 'right', sort: 'avg' },
  { key: 'action', label: '', width: 88 },
]

/** "every 30 min", "every 6h", "every 15m" — never "every 1800s". */
export function formatInterval(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '—'
  if (seconds < 3600) return `every ${Math.round(seconds / 60)} min`
  if (seconds < 86_400) {
    const hours = seconds / 3600
    return `every ${Number.isInteger(hours) ? hours : hours.toFixed(1)}h`
  }
  return `every ${Math.round(seconds / 86_400)}d`
}

/** "9h ago" / "in 20m" — the tables need minutes, not the day buckets elsewhere. */
export function relativeTick(iso: string | null, now: Date = new Date()): string {
  if (!iso) return '—'
  const then = new Date(iso)
  if (isNaN(then.getTime())) return '—'
  const diffMin = Math.round((then.getTime() - now.getTime()) / 60_000)
  const ahead = diffMin > 0
  const mins = Math.abs(diffMin)
  const span = mins < 1 ? 'now'
    : mins < 60 ? `${mins}m`
      : mins < 60 * 24 ? `${Math.round(mins / 60)}h`
        : `${Math.round(mins / (60 * 24))}d`
  if (span === 'now') return 'just now'
  return ahead ? `in ${span}` : `${span} ago`
}

/** Whole percent of the workspace's spend — the number the card is about. */
export function formatShareOfSpend(heartbeatUsd: number, workspaceUsd: number): string {
  if (!Number.isFinite(heartbeatUsd) || !Number.isFinite(workspaceUsd) || workspaceUsd <= 0) return '—'
  const pct = (heartbeatUsd / workspaceUsd) * 100
  if (pct > 0 && pct < 1) return '<1%'
  return `${Math.round(pct)}%`
}

const ownerLabel = (owner: HeartbeatAgentRow['owner']): string =>
  owner ? (owner.name || owner.email || 'Former member') : 'Workspace'

const sortValue = (row: HeartbeatAgentRow, key: SortKey): number | string => {
  switch (key) {
    case 'agent':
      return row.projectName.toLowerCase()
    case 'owner':
      return ownerLabel(row.owner).toLowerCase()
    case 'interval':
      return row.intervalSeconds
    case 'quiet':
      return row.quietHours ? 1 : 0
    case 'model':
      return (row.configuredModelLabel || row.configuredModel).toLowerCase()
    case 'last':
      return row.lastHeartbeatAt ? Date.parse(row.lastHeartbeatAt) : 0
    case 'next':
      return row.nextHeartbeatAt ? Date.parse(row.nextHeartbeatAt) : 0
    case 'ticks':
      return row.ticks
    case 'spend':
      return row.billedUsd
    case 'avg':
      return row.avgUsdPerTick ?? 0
  }
}

export function sortHeartbeatRows(
  rows: HeartbeatAgentRow[],
  key: SortKey,
  dir: 'asc' | 'desc',
): HeartbeatAgentRow[] {
  const sign = dir === 'asc' ? 1 : -1
  return [...rows].sort((a, b) => {
    const av = sortValue(a, key)
    const bv = sortValue(b, key)
    const cmp = typeof av === 'string' ? av.localeCompare(bv as string) : (av as number) - (bv as number)
    return cmp * sign || a.projectName.localeCompare(b.projectName)
  })
}

/** True when the charges ran on something other than what the config asks for. */
export function modelMismatch(row: HeartbeatAgentRow): string | null {
  const used = row.modelsUsed.map((m) => m.model).filter((m) => !!m && m !== 'unknown')
  if (!used.length || !row.configuredModel) return null
  if (used.includes(row.configuredModel)) return null
  return used[0]
}

function Cell({ width, align, children }: { width: number; align?: 'right'; children: React.ReactNode }) {
  return (
    <View style={{ width }} className={cn('px-2', align === 'right' && 'items-end')}>
      {children}
    </View>
  )
}

function PeriodPills({ value, onChange }: { value: HeartbeatPeriod; onChange: (p: HeartbeatPeriod) => void }) {
  return (
    <View className="flex-row items-center bg-muted rounded-md p-0.5 gap-0.5 self-start">
      {PERIODS.map((p) => {
        const active = p.id === value
        const pill = nativeActivePill(active, { webShadow: false })
        return (
          <Pressable
            key={p.id}
            accessibilityRole="button"
            testID={`heartbeat-period-${p.id}`}
            onPress={() => onChange(p.id)}
            className={cn('px-3 h-8 items-center justify-center rounded', pill.className)}
            style={pill.style}
          >
            <Text className={cn('text-xs font-medium', active ? 'text-foreground' : 'text-muted-foreground')}>
              {p.label}
            </Text>
          </Pressable>
        )
      })}
    </View>
  )
}

/** Heartbeat vs everything else, per day. Two thin bars rather than a chart lib. */
function DailySplit({ daily }: { daily: WorkspaceHeartbeatsReport['daily'] }) {
  const max = Math.max(...daily.map((d) => d.heartbeatUsd + d.otherUsd), 0)
  if (daily.length === 0 || max <= 0) return null

  return (
    <View className="rounded-xl border border-border bg-card p-4 gap-3" testID="heartbeat-daily-split">
      <View className="flex-row items-center justify-between gap-2 flex-wrap">
        <Text className="text-sm font-semibold text-foreground">Heartbeat vs the rest</Text>
        <View className="flex-row items-center gap-3">
          <View className="flex-row items-center gap-1">
            <View className="h-2 w-2 rounded-sm bg-amber-500" />
            <Text className="text-[10px] text-muted-foreground">Heartbeat</Text>
          </View>
          <View className="flex-row items-center gap-1">
            <View className="h-2 w-2 rounded-sm bg-primary/40" />
            <Text className="text-[10px] text-muted-foreground">Other</Text>
          </View>
        </View>
      </View>
      <View className="flex-row items-end gap-1 h-24">
        {daily.map((day) => {
          const heartbeatH = (day.heartbeatUsd / max) * 100
          const otherH = (day.otherUsd / max) * 100
          return (
            <View key={day.date} className="flex-1 items-center justify-end h-full" testID={`heartbeat-day-${day.date}`}>
              <View style={{ height: `${otherH}%` }} className="w-full bg-primary/40 rounded-t-sm" />
              <View style={{ height: `${heartbeatH}%` }} className="w-full bg-amber-500" />
            </View>
          )
        })}
      </View>
      <Text className="text-[10px] text-muted-foreground">
        {daily[0].date} → {daily[daily.length - 1].date}
      </Text>
    </View>
  )
}

export function WorkspaceHeartbeatsPanel({ workspaceId }: { workspaceId?: string } = {}) {
  const http = useDomainHttp()
  const router = useRouter()
  const workspace = useActiveWorkspace()
  const activeWorkspaceId = workspaceId ?? workspace?.id

  const [period, setPeriod] = useState<HeartbeatPeriod>('24h')
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' }>({ key: 'spend', dir: 'desc' })
  const [state, setState] = useState<{
    data: WorkspaceHeartbeatsReport | null
    loading: boolean
    error: string | null
    locked: boolean
  }>({ data: null, loading: true, error: null, locked: false })
  const [confirming, setConfirming] = useState<HeartbeatAgentRow | null>(null)
  const [busyProject, setBusyProject] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const latest = useRef(0)

  const load = useCallback(() => {
    if (!activeWorkspaceId) return
    const requestId = ++latest.current
    setState((s) => ({ ...s, loading: true, error: null, locked: false }))
    api
      .getWorkspaceAnalytics<WorkspaceHeartbeatsReport>(http, activeWorkspaceId, 'heartbeats', { period })
      .then((data) => {
        if (requestId === latest.current) setState({ data, loading: false, error: null, locked: false })
      })
      .catch((err: any) => {
        if (requestId !== latest.current) return
        // A 403 is either the plan gate or a non-member. Both read as "not
        // available here", never as a broken tab.
        setState({
          data: null,
          loading: false,
          error: err?.message || 'Could not load heartbeat spend',
          locked: err?.status === 403,
        })
      })
  }, [http, activeWorkspaceId, period])

  useEffect(() => { load() }, [load])

  const rows = useMemo(
    () => (state.data ? sortHeartbeatRows(state.data.agents, sort.key, sort.dir) : []),
    [state.data, sort],
  )

  const turnOff = useCallback(async (row: HeartbeatAgentRow) => {
    setBusyProject(row.projectId)
    setActionError(null)
    try {
      // The existing writer, not a new path: the same PATCH the project's own
      // settings use, which goes through `updateHeartbeatConfig`.
      await http.patch(`/api/projects/${row.projectId}/heartbeat`, { heartbeatEnabled: false })
      setConfirming(null)
      load()
    } catch (err: any) {
      setActionError(err?.message || 'Could not turn the heartbeat off')
      setConfirming(null)
    } finally {
      setBusyProject(null)
    }
  }, [http, load])

  if (!activeWorkspaceId) {
    return (
      <View className="py-12 items-center">
        <Text className="text-sm text-muted-foreground">No workspace selected</Text>
      </View>
    )
  }

  const header = (
    <View>
      <Text className="text-lg font-bold text-foreground mb-1">Heartbeats</Text>
      <Text className="text-xs text-muted-foreground">
        Every agent checking in on a schedule, and what each one costs.
      </Text>
    </View>
  )

  // A 403 is the plan gate or a non-member. The plan copy is only honest when
  // the server actually said "plan"; anything else is its own explanation.
  const lockedCopy = state.error && !/plan/i.test(state.error)
    ? state.error
    : 'Seeing every agent’s heartbeat and what it costs is available to workspace owners and admins on the Business plan or higher.'

  if (state.locked) {
    return (
      <View className="gap-4">
        {header}
        <View className="rounded-xl border border-border bg-card p-4 flex-row items-center gap-3" testID="heartbeat-locked">
          <Lock size={16} className="text-muted-foreground" />
          <View className="flex-1">
            <Text className="text-sm font-semibold text-foreground">Heartbeat spend</Text>
            <Text className="text-xs text-muted-foreground">{lockedCopy}</Text>
          </View>
        </View>
      </View>
    )
  }

  const totals = state.data?.totals
  const agents = rows

  const toggleSort = (key: SortKey) =>
    setSort((s) => (s.key === key
      ? { key, dir: s.dir === 'desc' ? 'asc' : 'desc' }
      : { key, dir: key === 'agent' || key === 'owner' ? 'asc' : 'desc' }))

  return (
    <View className="gap-4">
      {header}

      <View className="flex-row items-center justify-between gap-2 flex-wrap">
        <PeriodPills value={period} onChange={setPeriod} />
        {state.loading && state.data ? <ActivityIndicator size="small" /> : null}
      </View>

      {state.error && !state.data ? (
        <LoadErrorNotice errors={{ 'heartbeat spend': state.error }} />
      ) : null}
      {actionError ? <LoadErrorNotice errors={{ 'the change': actionError }} /> : null}

      <View className="flex-row flex-wrap gap-2">
        <StatCard
          label="Agents on"
          value={totals ? totals.agentsEnabled : undefined}
          icon={Activity}
          subtitle={totals ? `${totals.agentsWithSpend} spent this period` : undefined}
        />
        <StatCard
          label="Ticks"
          value={totals ? compactNumber(totals.ticks) : undefined}
          icon={Activity}
          subtitle={totals ? `${compactNumber(totals.totalTokens)} tokens` : undefined}
        />
        <StatCard
          label="Heartbeat spend"
          value={totals ? formatDollarCost(totals.billedUsd) : undefined}
          icon={Coins}
        />
        <StatCard
          label="Share of spend"
          value={totals ? formatShareOfSpend(totals.billedUsd, totals.workspaceBilledUsd) : undefined}
          icon={Gauge}
          subtitle={totals ? `${formatDollarCost(totals.workspaceBilledUsd)} total` : undefined}
        />
      </View>

      {state.data ? <DailySplit daily={state.data.daily} /> : null}

      <View className="rounded-xl border border-border bg-card p-4">
        {!state.data ? (
          <View className="py-10 items-center justify-center gap-2">
            {state.loading ? (
              <ActivityIndicator />
            ) : (
              <Text className="text-sm text-muted-foreground">
                {state.error ?? 'Heartbeat spend is unavailable right now'}
              </Text>
            )}
          </View>
        ) : agents.length === 0 ? (
          <View className="py-10 items-center justify-center gap-1" testID="heartbeat-empty">
            <Activity size={18} className="text-muted-foreground" />
            <Text className="text-sm font-medium text-foreground">No agents have heartbeats on</Text>
            <Text className="text-xs text-muted-foreground text-center">
              Turn one on in a project’s settings and its cost shows up here.
            </Text>
          </View>
        ) : (
          <ScrollView horizontal showsHorizontalScrollIndicator testID="heartbeats-table">
            <View className={cn(state.loading && 'opacity-60')}>
              <View className="flex-row border-b border-border pb-1.5">
                {COLUMNS.map((col) => {
                  const sortable = !!col.sort
                  const active = sortable && sort.key === col.sort
                  const Arrow = sort.dir === 'desc' ? ChevronDown : ChevronUp
                  return (
                    <Pressable
                      key={col.label || 'action'}
                      disabled={!sortable}
                      onPress={() => col.sort && toggleSort(col.sort)}
                      testID={`heartbeat-sort-${col.label || 'action'}`}
                    >
                      <Cell width={col.width} align={col.align}>
                        <View className="flex-row items-center gap-0.5">
                          <Text
                            className={cn(
                              'text-[11px] font-medium',
                              active ? 'text-foreground' : 'text-muted-foreground',
                            )}
                          >
                            {col.label}
                          </Text>
                          {active ? <Arrow size={11} className="text-foreground" /> : null}
                        </View>
                      </Cell>
                    </Pressable>
                  )
                })}
              </View>

              {agents.map((row) => {
                const mismatch = modelMismatch(row)
                return (
                  <Pressable
                    key={row.projectId}
                    testID={`heartbeat-row-${row.projectId}`}
                    onPress={() => router.push({
                      pathname: '/(app)/projects/[id]',
                      params: { id: row.projectId, tab: 'settings' },
                    } as any)}
                    className="flex-row items-center py-2 border-b border-border/50 active:bg-muted/40"
                  >
                    <Cell width={200}>
                      <Text className="text-xs font-medium text-foreground" numberOfLines={1}>
                        {row.projectName}
                      </Text>
                      <View
                        className={cn(
                          'self-start mt-1 rounded px-1.5 py-0.5',
                          row.enabled ? 'bg-primary/10' : 'bg-muted',
                        )}
                      >
                        <Text
                          className={cn(
                            'text-[10px] font-medium',
                            row.enabled ? 'text-primary' : 'text-muted-foreground',
                          )}
                        >
                          {row.enabled ? 'On' : 'Off'}
                        </Text>
                      </View>
                    </Cell>
                    <Cell width={130}>
                      <Text className="text-xs text-foreground" numberOfLines={1}>
                        {ownerLabel(row.owner)}
                      </Text>
                    </Cell>
                    <Cell width={104}>
                      <Text className="text-xs text-foreground">{formatInterval(row.intervalSeconds)}</Text>
                    </Cell>
                    <Cell width={118}>
                      {row.quietHours ? (
                        <View className="flex-row items-center gap-1">
                          <Moon size={11} className="text-muted-foreground" />
                          <Text className="text-xs text-foreground">
                            {row.quietHours.start}–{row.quietHours.end}
                          </Text>
                        </View>
                      ) : (
                        <Text className="text-xs text-muted-foreground">None</Text>
                      )}
                    </Cell>
                    <Cell width={130}>
                      <Text className="text-xs text-foreground" numberOfLines={1}>
                        {getModelDisplayName(row.configuredModelLabel || row.configuredModel || '')}
                      </Text>
                      {mismatch ? (
                        <View className="flex-row items-center gap-1 mt-0.5" testID={`heartbeat-model-mismatch-${row.projectId}`}>
                          <AlertTriangle size={10} className="text-amber-500" />
                          <Text className="text-[10px] text-amber-600" numberOfLines={1}>
                            ran on {getModelDisplayName(mismatch)}
                          </Text>
                        </View>
                      ) : null}
                    </Cell>
                    <Cell width={88} align="right">
                      <Text className="text-xs text-muted-foreground">{relativeTick(row.lastHeartbeatAt)}</Text>
                    </Cell>
                    <Cell width={88} align="right">
                      <Text className="text-xs text-muted-foreground">
                        {row.enabled ? relativeTick(row.nextHeartbeatAt) : '—'}
                      </Text>
                    </Cell>
                    <Cell width={60} align="right">
                      <Text className="text-xs text-foreground">{compactNumber(row.ticks)}</Text>
                    </Cell>
                    <Cell width={84} align="right">
                      <Text className="text-xs font-medium text-foreground">{formatDollarCost(row.billedUsd)}</Text>
                    </Cell>
                    <Cell width={86} align="right">
                      <Text className="text-xs text-foreground">
                        {row.avgUsdPerTick == null ? '—' : formatDollarCost(row.avgUsdPerTick)}
                      </Text>
                    </Cell>
                    <Cell width={88}>
                      {row.canEdit && row.enabled ? (
                        <Pressable
                          testID={`heartbeat-turn-off-${row.projectId}`}
                          disabled={busyProject === row.projectId}
                          onPress={() => setConfirming(row)}
                          className="rounded border border-border px-2 py-1 active:bg-muted"
                        >
                          <Text className="text-[10px] font-medium text-foreground">
                            {busyProject === row.projectId ? 'Turning off…' : 'Turn off'}
                          </Text>
                        </Pressable>
                      ) : null}
                    </Cell>
                  </Pressable>
                )
              })}

              {totals ? (
                <View className="flex-row items-center pt-2" testID="heartbeat-total">
                  <Cell width={200}>
                    <Text className="text-xs font-semibold text-foreground">
                      Workspace total ({totals.agentsEnabled} on)
                    </Text>
                  </Cell>
                  <Cell width={130}><Text className="text-xs text-muted-foreground"> </Text></Cell>
                  <Cell width={104}><Text className="text-xs text-muted-foreground"> </Text></Cell>
                  <Cell width={118}><Text className="text-xs text-muted-foreground"> </Text></Cell>
                  <Cell width={130}><Text className="text-xs text-muted-foreground"> </Text></Cell>
                  <Cell width={88} align="right"><Text className="text-xs text-muted-foreground"> </Text></Cell>
                  <Cell width={88} align="right"><Text className="text-xs text-muted-foreground"> </Text></Cell>
                  <Cell width={60} align="right">
                    <Text className="text-xs font-semibold text-foreground">{compactNumber(totals.ticks)}</Text>
                  </Cell>
                  <Cell width={84} align="right">
                    <Text className="text-xs font-semibold text-foreground">{formatDollarCost(totals.billedUsd)}</Text>
                  </Cell>
                  <Cell width={86} align="right">
                    <Text className="text-xs text-muted-foreground">
                      {formatShareOfSpend(totals.billedUsd, totals.workspaceBilledUsd)} of spend
                    </Text>
                  </Cell>
                  <Cell width={88}><Text className="text-xs text-muted-foreground"> </Text></Cell>
                </View>
              ) : null}
            </View>
          </ScrollView>
        )}
      </View>

      <AlertDialog isOpen={!!confirming} onClose={() => setConfirming(null)} size="sm">
        <AlertDialogBackdrop />
        <AlertDialogContent testID="heartbeat-turn-off-confirm">
          <AlertDialogHeader>
            <Heading size="md" className="text-typography-950">
              Turn this heartbeat off?
            </Heading>
          </AlertDialogHeader>
          <AlertDialogBody className="mb-4 mt-3">
            <UIText size="sm" className="text-typography-700">
              {confirming
                ? `${confirming.projectName} spent ${formatDollarCost(confirming.billedUsd)} on ${compactNumber(confirming.ticks)} heartbeat ticks in this period. Turning it off stops the next tick — it stays off until someone turns it back on.`
                : ''}
            </UIText>
          </AlertDialogBody>
          <AlertDialogFooter>
            <Button variant="outline" action="secondary" onPress={() => setConfirming(null)} accessibilityLabel="Cancel">
              <ButtonText>Cancel</ButtonText>
            </Button>
            <Button
              action="primary"
              accessibilityLabel="Turn off heartbeat"
              onPress={() => confirming && turnOff(confirming)}
            >
              <ButtonText>Turn off</ButtonText>
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </View>
  )
}
