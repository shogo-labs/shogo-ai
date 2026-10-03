// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * TeamWorkTable
 *
 * One row per workspace member: approvals decided, tasks completed, lines
 * changed, messages, tokens, active days, streak, and when they were last
 * active. Sortable. Tapping a row opens that member's full dashboard.
 *
 * Owners/admins on a Business plan or higher only. The API enforces both; the
 * `locked` prop just avoids a request that would be refused and shows an
 * upgrade note instead.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { ActivityIndicator, Image, Pressable, ScrollView, View } from 'react-native'
import { ChevronDown, ChevronUp, Lock } from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import { useDomainHttp } from '../../contexts/domain'
import { api } from '../../lib/api'
import {
  compactNumber,
  deviceTimezone,
  formatLastActive,
  type EngagementPeriod,
  type TeamWork,
  type TeamWorkRow,
} from '../../lib/engagement-utils'
import { Text } from '../settings/account-sheet-chrome'
import { RangeSwitch } from './UsageDashboard'

type SortKey =
  | 'name'
  | 'approvals'
  | 'tasks'
  | 'lines'
  | 'messages'
  | 'tokens'
  | 'activeDays'
  | 'streak'
  | 'lastActive'

const COLUMNS: { key: SortKey; label: string; width: number; align?: 'right' }[] = [
  { key: 'name', label: 'Member', width: 190 },
  { key: 'approvals', label: 'Approvals', width: 86, align: 'right' },
  { key: 'tasks', label: 'Tasks done', width: 90, align: 'right' },
  { key: 'lines', label: 'Lines changed', width: 104, align: 'right' },
  { key: 'messages', label: 'Messages', width: 84, align: 'right' },
  { key: 'tokens', label: 'Tokens', width: 76, align: 'right' },
  { key: 'activeDays', label: 'Active days', width: 90, align: 'right' },
  { key: 'streak', label: 'Streak', width: 66, align: 'right' },
  { key: 'lastActive', label: 'Last active', width: 100, align: 'right' },
]

const sortValue = (row: TeamWorkRow, key: SortKey): number | string => {
  const t = row.totals
  switch (key) {
    case 'name':
      return (row.name || row.email || row.userId).toLowerCase()
    case 'approvals':
      return t.approvalsDecided
    case 'tasks':
      return t.tasksCompleted
    case 'lines':
      return t.linesAdded + t.linesRemoved
    case 'messages':
      return t.messagesSent
    case 'tokens':
      return t.tokens
    case 'activeDays':
      return t.activeDays
    case 'streak':
      return row.streak.current
    case 'lastActive':
      return t.lastActiveAt ? Date.parse(t.lastActiveAt) : 0
  }
}

export function sortTeamRows(rows: TeamWorkRow[], key: SortKey, dir: 'asc' | 'desc'): TeamWorkRow[] {
  const sign = dir === 'asc' ? 1 : -1
  return [...rows].sort((a, b) => {
    const av = sortValue(a, key)
    const bv = sortValue(b, key)
    const cmp = typeof av === 'string' ? av.localeCompare(bv as string) : (av as number) - (bv as number)
    return cmp * sign || String(sortValue(a, 'name')).localeCompare(String(sortValue(b, 'name')))
  })
}

function Cell({ width, align, children }: { width: number; align?: 'right'; children: React.ReactNode }) {
  return (
    <View style={{ width }} className={cn('px-2', align === 'right' && 'items-end')}>
      {children}
    </View>
  )
}

function MemberAvatar({ row }: { row: TeamWorkRow }) {
  const initial = (row.name || row.email || '?').trim().charAt(0).toUpperCase()
  return row.image ? (
    <Image source={{ uri: row.image }} className="h-6 w-6 rounded-full" />
  ) : (
    <View className="h-6 w-6 rounded-full bg-primary/10 items-center justify-center">
      <Text className="text-[10px] font-semibold text-primary">{initial}</Text>
    </View>
  )
}

export function TeamWorkTable({
  workspaceId,
  locked = false,
  onSelectMember,
}: {
  workspaceId: string
  /** True when the workspace is below the Business plan. */
  locked?: boolean
  onSelectMember?: (userId: string, label: string) => void
}) {
  const http = useDomainHttp()
  const [period, setPeriod] = useState<EngagementPeriod>('7d')
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' }>({ key: 'approvals', dir: 'desc' })
  const [state, setState] = useState<{ data: TeamWork | null; loading: boolean; error: string | null }>({
    data: null,
    loading: !locked,
    error: null,
  })
  const latest = useRef(0)

  useEffect(() => {
    if (locked) return
    const requestId = ++latest.current
    setState((s) => ({ ...s, loading: true, error: null }))
    api
      .getWorkspaceAnalytics<TeamWork>(http, workspaceId, 'team-work', { period, tz: deviceTimezone() })
      .then((data) => {
        if (requestId === latest.current) setState({ data, loading: false, error: null })
      })
      .catch((err: any) => {
        if (requestId === latest.current) {
          setState({ data: null, loading: false, error: err?.message || 'Could not load team activity' })
        }
      })
  }, [http, workspaceId, period, locked])

  const rows = useMemo(
    () => (state.data ? sortTeamRows(state.data.rows, sort.key, sort.dir) : []),
    [state.data, sort],
  )

  if (locked) {
    return (
      <View className="rounded-xl border border-border bg-card p-4 flex-row items-center gap-3">
        <Lock size={16} className="text-muted-foreground" />
        <View className="flex-1">
          <Text className="text-sm font-semibold text-foreground">Team activity</Text>
          <Text className="text-xs text-muted-foreground">
            See what each person got done — approvals, tasks, lines changed, messages and streaks — on the Business plan.
          </Text>
        </View>
      </View>
    )
  }

  const toggleSort = (key: SortKey) =>
    setSort((s) => (s.key === key ? { key, dir: s.dir === 'desc' ? 'asc' : 'desc' } : { key, dir: key === 'name' ? 'asc' : 'desc' }))

  const team = state.data?.team

  return (
    <View className="rounded-xl border border-border bg-card p-4 gap-3">
      <View className="flex-row items-start justify-between flex-wrap gap-2">
        <View className="flex-1 min-w-[180px]">
          <Text className="text-sm font-semibold text-foreground">Team activity</Text>
          <Text className="text-xs text-muted-foreground">
            Approvals, work done and engagement per member. Tap a row for their full dashboard.
          </Text>
        </View>
        <RangeSwitch value={period} onChange={setPeriod} />
      </View>

      {!state.data ? (
        <View className="py-8 items-center justify-center">
          {state.loading ? (
            <ActivityIndicator />
          ) : (
            <Text className="text-sm text-muted-foreground">{state.error ?? 'No team activity'}</Text>
          )}
        </View>
      ) : (
        <ScrollView horizontal showsHorizontalScrollIndicator>
          <View className={cn(state.loading && 'opacity-60')}>
            <View className="flex-row border-b border-border pb-1.5">
              {COLUMNS.map((col) => {
                const active = sort.key === col.key
                const Arrow = sort.dir === 'desc' ? ChevronDown : ChevronUp
                return (
                  <Pressable key={col.key} onPress={() => toggleSort(col.key)}>
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

            {rows.map((row) => {
              const t = row.totals
              const label = row.name || row.email || row.userId
              return (
                <Pressable
                  key={row.userId}
                  onPress={() => onSelectMember?.(row.userId, label)}
                  className="flex-row items-center py-2 border-b border-border/50"
                >
                  <Cell width={190}>
                    <View className="flex-row items-center gap-2">
                      <MemberAvatar row={row} />
                      <View className="flex-1">
                        <Text className="text-xs font-medium text-foreground" numberOfLines={1}>
                          {label}
                        </Text>
                        {row.role ? (
                          <Text className="text-[10px] text-muted-foreground capitalize">{row.role}</Text>
                        ) : (
                          <Text className="text-[10px] text-muted-foreground">Former member</Text>
                        )}
                      </View>
                    </View>
                  </Cell>
                  <Cell width={86} align="right">
                    <Text className="text-xs text-foreground">{t.approvalsDecided}</Text>
                  </Cell>
                  <Cell width={90} align="right">
                    <Text className="text-xs text-foreground">{t.tasksCompleted}</Text>
                  </Cell>
                  <Cell width={104} align="right">
                    <Text className="text-xs text-foreground">
                      +{compactNumber(t.linesAdded)} / −{compactNumber(t.linesRemoved)}
                    </Text>
                  </Cell>
                  <Cell width={84} align="right">
                    <Text className="text-xs text-foreground">{compactNumber(t.messagesSent)}</Text>
                  </Cell>
                  <Cell width={76} align="right">
                    <Text className="text-xs text-foreground">{compactNumber(t.tokens)}</Text>
                  </Cell>
                  <Cell width={90} align="right">
                    <Text className="text-xs text-foreground">{t.activeDays}</Text>
                  </Cell>
                  <Cell width={66} align="right">
                    <Text className="text-xs text-foreground">{row.streak.current}d</Text>
                  </Cell>
                  <Cell width={100} align="right">
                    <Text className="text-xs text-muted-foreground">{formatLastActive(t.lastActiveAt)}</Text>
                  </Cell>
                </Pressable>
              )
            })}

            {team ? (
              <View className="flex-row items-center pt-2">
                <Cell width={190}>
                  <Text className="text-xs font-semibold text-foreground">Team total</Text>
                </Cell>
                <Cell width={86} align="right">
                  <Text className="text-xs font-semibold text-foreground">{team.approvalsDecided}</Text>
                </Cell>
                <Cell width={90} align="right">
                  <Text className="text-xs font-semibold text-foreground">{team.tasksCompleted}</Text>
                </Cell>
                <Cell width={104} align="right">
                  <Text className="text-xs font-semibold text-foreground">
                    +{compactNumber(team.linesAdded)} / −{compactNumber(team.linesRemoved)}
                  </Text>
                </Cell>
                <Cell width={84} align="right">
                  <Text className="text-xs font-semibold text-foreground">{compactNumber(team.messagesSent)}</Text>
                </Cell>
                <Cell width={76} align="right">
                  <Text className="text-xs font-semibold text-foreground">{compactNumber(team.tokens)}</Text>
                </Cell>
                <Cell width={90} align="right">
                  <Text className="text-xs text-muted-foreground"> </Text>
                </Cell>
                <Cell width={66} align="right">
                  <Text className="text-xs text-muted-foreground"> </Text>
                </Cell>
                <Cell width={100} align="right">
                  <Text className="text-xs text-muted-foreground"> </Text>
                </Cell>
              </View>
            ) : null}
          </View>
        </ScrollView>
      )}
    </View>
  )
}
