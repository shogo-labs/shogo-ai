// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { useCallback, useEffect, useState } from 'react'
import { View, Text, FlatList, Pressable, ActivityIndicator, RefreshControl, Platform } from 'react-native'
import { useRouter } from 'expo-router'
import { ArrowLeft, ReceiptText } from 'lucide-react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Card, CardContent, Badge } from '@shogo/shared-ui/primitives'
import { useDomainHttp } from '../../../contexts/domain'
import { affiliateApi, type AffiliateCommissionRow, type CommissionStatus } from '../../../lib/affiliate-api'

const STATUSES: Array<{ id: 'all' | CommissionStatus; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'pending', label: 'Pending' },
  { id: 'approved', label: 'Approved' },
  { id: 'paid', label: 'Paid' },
  { id: 'refunded', label: 'Refunded' },
  { id: 'clawed_back', label: 'Clawed back' },
]

function dollars(cents: number) { return `$${(cents / 100).toFixed(2)}` }

export default function CommissionsScreen() {
  const router = useRouter()
  const http = useDomainHttp()
  const insets = useSafeAreaInsets()
  const [filter, setFilter] = useState<'all' | CommissionStatus>('all')
  const [rows, setRows] = useState<AffiliateCommissionRow[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)

  const load = useCallback(async () => {
    try {
      const res = await affiliateApi.listCommissions(http, {
        status: filter === 'all' ? undefined : filter,
        limit: 100,
      })
      setRows(res.commissions)
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [filter, http])

  useEffect(() => { setLoading(true); load() }, [load])

  return (
    <View className="flex-1 bg-background">
      <View
        className="flex-row items-center gap-3 px-5 pb-3 border-b border-border"
        style={{ paddingTop: Math.max(insets.top, 12) }}
      >
        <Pressable onPress={() => router.back()} hitSlop={8}>
          <ArrowLeft size={22} className="text-foreground" />
        </Pressable>
        <View className="flex-1">
          <Text className="text-[11px] uppercase tracking-[1.5px] font-semibold text-muted-foreground">
            Referral earnings
          </Text>
          <Text className="text-lg font-semibold text-foreground">Commissions</Text>
        </View>
      </View>

      <View className="px-5 pt-4 pb-3 border-b border-border">
        <View className="flex-row items-center gap-2 mb-3">
          <View className="h-7 w-7 rounded-lg bg-muted items-center justify-center">
            <ReceiptText size={14} className="text-foreground" />
          </View>
          <Text className="text-sm text-muted-foreground">
            Filter your earnings activity
          </Text>
        </View>
        <View className="flex-row flex-wrap gap-2">
          {STATUSES.map((s) => (
            <Pressable key={s.id} onPress={() => setFilter(s.id)}>
              <Badge variant={filter === s.id ? 'default' : 'secondary'}>
                <Text className={filter === s.id ? 'text-primary-foreground text-xs' : 'text-xs'}>
                  {s.label}
                </Text>
              </Badge>
            </Pressable>
          ))}
        </View>
      </View>

      {loading ? (
        <View className="py-16 items-center"><ActivityIndicator /></View>
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(r) => r.id}
          contentContainerStyle={{
            paddingHorizontal: 20,
            paddingTop: 16,
            paddingBottom: Math.max(insets.bottom, 16) + 28,
            gap: 10,
            flexGrow: 1,
          }}
          refreshControl={Platform.OS !== 'web' ? (
            <RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load() }} />
          ) : undefined}
          ListEmptyComponent={
            <View className="items-center py-16 px-8">
              <Text className="text-base font-semibold text-foreground">No commissions yet</Text>
              <Text className="text-center text-muted-foreground text-sm mt-1">
                Earnings from qualifying referrals will appear here.
              </Text>
            </View>
          }
          renderItem={({ item }) => (
            <Card>
              <CardContent className="flex-row items-center gap-3 p-4">
                <View className="flex-1">
                  <Text className="text-foreground text-lg font-semibold">
                    {dollars(item.amountCents)}
                  </Text>
                  <Text className="text-xs text-muted-foreground">
                    Level {item.level} · {new Date(item.createdAt).toLocaleString()}
                  </Text>
                </View>
                <Badge variant="secondary"><Text className="text-xs">{item.status}</Text></Badge>
              </CardContent>
            </Card>
          )}
        />
      )}
    </View>
  )
}
