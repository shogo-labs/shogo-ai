// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import type { ReactNode } from 'react'
import { View, ScrollView, Pressable, Modal, ActivityIndicator } from 'react-native'
import { X } from 'lucide-react-native'
import type { MemberInsight } from '../../lib/api'
import { RoleBadge } from './people/MemberRow'
import {
  Text,
  useAccountSheetIcons,
} from './account-sheet-chrome'
import { StackedAreaChart } from '../analytics/StackedAreaChart'

type MemberUsagePeriod = '7d' | '30d' | '90d'

function formatNumber(value: number): string {
  return new Intl.NumberFormat().format(Math.round(value))
}

function formatUsd(value: number): string {
  if (value === 0) return '$0.00'
  if (value < 0.01) return '<$0.01'
  return `$${value.toFixed(2)}`
}

function formatLines(added: number, removed: number): string {
  return `+${formatNumber(added)} / -${formatNumber(removed)}`
}

export interface MemberProfile {
  name: string
  email: string
  role: string
}

/**
 * Bottom sheet for a single workspace member: who they are, an optional
 * "Access" section (role / remove / leave controls, supplied by the caller),
 * and their usage for the selected period.
 */
export function MemberDetailSheet({
  visible,
  profile,
  member,
  canSeeUsage,
  loading,
  period,
  onPeriodChange,
  onClose,
  access,
}: {
  visible: boolean
  profile: MemberProfile | null
  /** Usage insight for the member; `null` when there is none for this period. */
  member: MemberInsight | null
  /** Usage is only visible to owners/admins and to the member themselves. */
  canSeeUsage: boolean
  loading: boolean
  period: MemberUsagePeriod
  onPeriodChange: (period: MemberUsagePeriod) => void
  onClose: () => void
  access?: ReactNode
}) {
  const { X: CloseIcon } = useAccountSheetIcons({ X })
  const displayName = profile?.name || member?.userName || member?.userEmail || 'Member'
  const displayEmail = profile?.email || member?.userEmail || ''
  const chartDays = (member?.daily ?? []).map((day) => ({
    date: day.date,
    values: { tokens: day.totalTokens },
  }))

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
    >
      <View className="flex-1 justify-end bg-black/50">
        <View className="max-h-[92%] rounded-t-2xl border border-border bg-background">
          <View className="flex-row items-center justify-between border-b border-border px-5 py-4">
            <View className="min-w-0 flex-1">
              <Text className="text-lg font-semibold text-foreground" numberOfLines={1}>
                {displayName}
              </Text>
              <View className="mt-1 flex-row items-center gap-2">
                {profile?.role ? <RoleBadge role={profile.role} /> : null}
                {displayEmail ? (
                  <Text className="min-w-0 flex-shrink text-xs text-muted-foreground" numberOfLines={1}>
                    {displayEmail}
                  </Text>
                ) : null}
              </View>
            </View>
            <Pressable
              onPress={onClose}
              className="h-9 w-9 items-center justify-center rounded-md"
              accessibilityLabel="Close member usage details"
            >
              <CloseIcon size={18} className="text-muted-foreground" />
            </Pressable>
          </View>

          <ScrollView contentContainerClassName="gap-4 px-5 py-5">
            {access}

            {canSeeUsage ? (
              <View className="gap-2">
                <Text className="text-sm font-semibold text-foreground">Usage</Text>
                <View className="flex-row gap-2">
                  {(['7d', '30d', '90d'] as MemberUsagePeriod[]).map((option) => (
                    <Pressable
                      key={option}
                      onPress={() => onPeriodChange(option)}
                      className={`rounded-md border px-3 py-2 ${
                        period === option ? 'border-foreground bg-muted' : 'border-border'
                      }`}
                    >
                      <Text className="text-xs font-medium text-foreground">{option}</Text>
                    </Pressable>
                  ))}
                </View>
              </View>
            ) : null}

            {!canSeeUsage ? (
              <Text className="py-6 text-center text-sm text-muted-foreground">
                Usage details are only visible to workspace owners and admins.
              </Text>
            ) : loading ? (
              <View className="h-48 items-center justify-center">
                <ActivityIndicator />
              </View>
            ) : member ? (
              <>
                <View className="flex-row flex-wrap gap-2">
                  {[
                    ['Plans', formatNumber(member.plansCreated)],
                    ['Code lines', formatLines(member.linesAdded, member.linesRemoved)],
                    ['Tokens', formatNumber(member.totalTokens)],
                    ['Requests', formatNumber(member.requests)],
                    ['Spend', formatUsd(member.spendUsd)],
                    ['Files', formatNumber(member.filesEdited)],
                  ].map(([label, value]) => (
                    <View key={label} className="min-w-[30%] flex-1 rounded-xl border border-border bg-card p-3">
                      <Text className="text-[11px] text-muted-foreground">{label}</Text>
                      <Text className="mt-1 text-base font-semibold text-foreground">{value}</Text>
                    </View>
                  ))}
                </View>

                {chartDays.length > 0 && (
                  <View className="gap-2">
                    <Text className="text-sm font-semibold text-foreground">Daily tokens</Text>
                    <StackedAreaChart
                      days={chartDays}
                      series={[{ id: 'tokens', label: 'Tokens', color: '#3b82f6' }]}
                      height={210}
                      formatY={formatNumber}
                      formatTooltip={formatNumber}
                    />
                  </View>
                )}

                <View className="gap-2">
                  <Text className="text-sm font-semibold text-foreground">Models used</Text>
                  {member.models.length === 0 ? (
                    <Text className="text-sm text-muted-foreground">No model usage in this period.</Text>
                  ) : (
                    <View className="overflow-hidden rounded-xl border border-border">
                      {member.models.map((model) => (
                        <View key={`${model.model}:${model.provider}`} className="flex-row items-center justify-between border-b border-border px-3 py-3 last:border-b-0">
                          <View className="min-w-0 flex-1">
                            <Text className="text-sm font-medium text-foreground" numberOfLines={1}>{model.model}</Text>
                            <Text className="text-xs text-muted-foreground">
                              {formatNumber(model.requests)} requests · {formatNumber(model.totalTokens)} tokens
                            </Text>
                          </View>
                          <Text className="text-sm tabular-nums text-foreground">{formatUsd(model.spendUsd)}</Text>
                        </View>
                      ))}
                    </View>
                  )}
                </View>

                <View className="gap-1">
                  <Text className="text-sm font-semibold text-foreground">Code changes</Text>
                  <Text className="text-sm text-muted-foreground">
                    {formatLines(member.linesAdded, member.linesRemoved)} across {formatNumber(member.filesEdited)} file operations
                  </Text>
                </View>
              </>
            ) : (
              <Text className="py-10 text-center text-sm text-muted-foreground">
                No usage data for this period.
              </Text>
            )}
          </ScrollView>
        </View>
      </View>
    </Modal>
  )
}
