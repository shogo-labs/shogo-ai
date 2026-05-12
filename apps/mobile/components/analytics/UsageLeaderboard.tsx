// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * UsageLeaderboard
 *
 * Per-user spend leaderboard rendered below the Team Usage chart on the
 * workspace Usage tab. Reduces the per-(user, model) rows that
 * `getUsageSummary` returns into one row per user, with a "favorite model"
 * picked by token count.
 *
 * Columns are spend-focused (per the UX refresh decision): # / User /
 * Favorite Model / Requests / Total Tokens / Billed $.
 */

import { useMemo, useState } from 'react'
import { View, Text, Pressable, Image, Platform } from 'react-native'
import { ArrowUpDown, ChevronDown, ChevronUp, Download, Braces } from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import {
  type UsageSummaryData,
  formatNumber,
  formatDollarCost,
  getModelColor,
  getModelTextColor,
  getModelDisplayName,
} from './SharedAnalytics'

type SortKey = 'requests' | 'tokens' | 'billed' | 'name'
type SortDir = 'asc' | 'desc'

interface LeaderboardRow {
  userId: string
  userName: string | null
  userEmail: string
  userImage: string | null
  favoriteModel: string
  requests: number
  tokens: number
  billed: number
}

function aggregate(data: UsageSummaryData): LeaderboardRow[] {
  const byUser = new Map<string, {
    userId: string
    userName: string | null
    userEmail: string
    userImage: string | null
    requests: number
    tokens: number
    billed: number
    modelTokens: Map<string, number>
  }>()

  for (const row of data?.summaries ?? []) {
    let entry = byUser.get(row.userId)
    if (!entry) {
      entry = {
        userId: row.userId,
        userName: row.userName,
        userEmail: row.userEmail,
        userImage: row.userImage,
        requests: 0,
        tokens: 0,
        billed: 0,
        modelTokens: new Map(),
      }
      byUser.set(row.userId, entry)
    }
    entry.requests += row.requestCount
    entry.tokens += row.totalTokens
    entry.billed += row.totalBilledUsd
    entry.modelTokens.set(
      row.model,
      (entry.modelTokens.get(row.model) ?? 0) + row.totalTokens,
    )
  }

  return [...byUser.values()].map((u) => {
    let favoriteModel = 'unknown'
    let max = -1
    for (const [model, t] of u.modelTokens.entries()) {
      if (t > max) {
        max = t
        favoriteModel = model
      }
    }
    return {
      userId: u.userId,
      userName: u.userName,
      userEmail: u.userEmail,
      userImage: u.userImage,
      favoriteModel,
      requests: u.requests,
      tokens: u.tokens,
      billed: u.billed,
    }
  })
}

function downloadCsv(rows: LeaderboardRow[]) {
  const escape = (val: unknown): string => {
    if (val === null || val === undefined) return ''
    const s = String(val)
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const header = ['Rank', 'User', 'Email', 'Favorite Model', 'Requests', 'Tokens', 'Billed USD']
  const lines = [header.join(',')]
  rows.forEach((r, i) => {
    lines.push([
      i + 1,
      escape(r.userName || ''),
      escape(r.userEmail),
      escape(r.favoriteModel),
      r.requests,
      r.tokens,
      r.billed.toFixed(4),
    ].join(','))
  })
  triggerDownload(lines.join('\n'), 'leaderboard.csv', 'text/csv')
}

function downloadJson(rows: LeaderboardRow[]) {
  triggerDownload(JSON.stringify(rows, null, 2), 'leaderboard.json', 'application/json')
}

function triggerDownload(content: string, filename: string, mime: string) {
  if (Platform.OS !== 'web' || typeof document === 'undefined') return
  const blob = new Blob([content], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

export function UsageLeaderboard({
  data,
  loading,
  topN = 10,
}: {
  data: UsageSummaryData | null
  loading: boolean
  topN?: number
}) {
  const [sortKey, setSortKey] = useState<SortKey>('billed')
  const [sortDir, setSortDir] = useState<SortDir>('desc')

  const rows = useMemo(() => (data ? aggregate(data) : []), [data])
  const sorted = useMemo(() => {
    const sortedAll = [...rows].sort((a, b) => {
      let cmp = 0
      if (sortKey === 'requests') cmp = a.requests - b.requests
      else if (sortKey === 'tokens') cmp = a.tokens - b.tokens
      else if (sortKey === 'billed') cmp = a.billed - b.billed
      else cmp = (a.userName || a.userEmail).localeCompare(b.userName || b.userEmail)
      return sortDir === 'asc' ? cmp : -cmp
    })
    return sortedAll
  }, [rows, sortKey, sortDir])

  const visible = sorted.slice(0, topN)

  const toggleSort = (key: SortKey) => {
    if (key === sortKey) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    else {
      setSortKey(key)
      setSortDir('desc')
    }
  }

  const SortArrow = ({ k }: { k: SortKey }) =>
    sortKey === k ? (
      sortDir === 'asc' ? (
        <ChevronUp size={11} className="text-foreground" />
      ) : (
        <ChevronDown size={11} className="text-foreground" />
      )
    ) : (
      <ArrowUpDown size={11} className="text-muted-foreground/40" />
    )

  return (
    <View className="rounded-xl border border-border bg-card p-4">
      <View className="flex-row items-center justify-between mb-3">
        <Text className="text-sm font-semibold text-foreground">Usage Leaderboard</Text>
      </View>

      {/* Header row */}
      <View className="flex-row items-center px-2 py-2 bg-muted/30 rounded-md border border-border">
        <Text className="w-6 text-[10px] font-medium text-muted-foreground">#</Text>
        <Pressable
          onPress={() => toggleSort('name')}
          className="flex-1 flex-row items-center gap-1 mr-2"
        >
          <Text className="text-[10px] font-medium text-muted-foreground">User</Text>
          <SortArrow k="name" />
        </Pressable>
        <Text className="w-32 text-[10px] font-medium text-muted-foreground">Favorite Model</Text>
        <Pressable
          onPress={() => toggleSort('requests')}
          className="w-16 flex-row items-center justify-end gap-1"
        >
          <Text className="text-[10px] font-medium text-muted-foreground">Requests</Text>
          <SortArrow k="requests" />
        </Pressable>
        <Pressable
          onPress={() => toggleSort('tokens')}
          className="w-20 flex-row items-center justify-end gap-1"
        >
          <Text className="text-[10px] font-medium text-muted-foreground">Tokens</Text>
          <SortArrow k="tokens" />
        </Pressable>
        <Pressable
          onPress={() => toggleSort('billed')}
          className="w-16 flex-row items-center justify-end gap-1"
        >
          <Text className="text-[10px] font-medium text-muted-foreground">Billed $</Text>
          <SortArrow k="billed" />
        </Pressable>
      </View>

      {loading ? (
        <View className="py-12 items-center">
          <Text className="text-sm text-muted-foreground">Loading…</Text>
        </View>
      ) : visible.length === 0 ? (
        <View className="py-12 items-center">
          <Text className="text-sm text-muted-foreground">No usage yet</Text>
        </View>
      ) : (
        <View className="border border-t-0 border-border rounded-b-md overflow-hidden -mt-px">
          {visible.map((row, i) => (
            <View
              key={row.userId}
              className={cn(
                'flex-row items-center px-2 py-2.5 border-b border-border/50',
                i % 2 !== 0 && 'bg-muted/10',
                i === visible.length - 1 && 'border-b-0',
              )}
            >
              <Text className="w-6 text-xs text-muted-foreground tabular-nums">{i + 1}</Text>
              <View className="flex-1 flex-row items-center gap-2 mr-2 min-w-0">
                {row.userImage ? (
                  <Image source={{ uri: row.userImage }} className="h-7 w-7 rounded-full" />
                ) : (
                  <View className="h-7 w-7 rounded-full bg-primary/20 items-center justify-center">
                    <Text className="text-[10px] font-medium text-primary">
                      {(row.userName || row.userEmail || '?')[0]?.toUpperCase()}
                    </Text>
                  </View>
                )}
                <View className="min-w-0 flex-1">
                  <Text className="text-xs font-medium text-foreground" numberOfLines={1}>
                    {row.userName || row.userEmail.split('@')[0]}
                  </Text>
                  <Text className="text-[10px] text-muted-foreground" numberOfLines={1}>
                    {row.userEmail}
                  </Text>
                </View>
              </View>
              <View className={cn('w-32 px-1.5 py-0.5 rounded border mr-1', getModelColor(row.favoriteModel))}>
                <Text className={cn('text-[10px] font-medium', getModelTextColor(row.favoriteModel))} numberOfLines={1}>
                  {getModelDisplayName(row.favoriteModel)}
                </Text>
              </View>
              <Text className="w-16 text-right text-xs font-mono text-foreground">
                {row.requests.toLocaleString()}
              </Text>
              <Text className="w-20 text-right text-xs font-mono text-foreground">
                {formatNumber(row.tokens)}
              </Text>
              <Text className="w-16 text-right text-xs font-mono text-foreground">
                {formatDollarCost(row.billed)}
              </Text>
            </View>
          ))}
        </View>
      )}

      <View className="flex-row items-center justify-between mt-3">
        <Text className="text-[11px] text-muted-foreground">
          Top {visible.length} of {rows.length} {rows.length === 1 ? 'member' : 'members'}
        </Text>
        <View className="flex-row items-center gap-2">
          <Pressable
            onPress={() => downloadCsv(sorted)}
            hitSlop={6}
            className="p-1.5 rounded hover:bg-muted/50"
            accessibilityLabel="Download leaderboard as CSV"
          >
            <Download size={14} className="text-muted-foreground" />
          </Pressable>
          <Pressable
            onPress={() => downloadJson(sorted)}
            hitSlop={6}
            className="p-1.5 rounded hover:bg-muted/50"
            accessibilityLabel="Download leaderboard as JSON"
          >
            <Braces size={14} className="text-muted-foreground" />
          </Pressable>
        </View>
      </View>
    </View>
  )
}
