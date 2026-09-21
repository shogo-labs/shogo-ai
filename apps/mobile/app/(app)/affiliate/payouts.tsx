// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { useCallback, useEffect, useState } from 'react'
import { View, Text, FlatList, Pressable, ActivityIndicator, RefreshControl, Platform } from 'react-native'
import { useRouter } from 'expo-router'
import { ArrowLeft, Landmark } from 'lucide-react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Card, CardContent, Badge } from '@shogo/shared-ui/primitives'
import { useDomainHttp } from '../../../contexts/domain'
import { affiliateApi, type AffiliatePayoutRow } from '../../../lib/affiliate-api'

function dollars(cents: number) { return `$${(cents / 100).toFixed(2)}` }

export default function PayoutsScreen() {
  const router = useRouter()
  const http = useDomainHttp()
  const insets = useSafeAreaInsets()
  const [rows, setRows] = useState<AffiliatePayoutRow[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)

  const load = useCallback(async () => {
    try {
      const res = await affiliateApi.listPayouts(http)
      setRows(res.payouts)
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [http])

  useEffect(() => { load() }, [load])

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
          <Text className="text-lg font-semibold text-foreground">Payouts</Text>
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
          ListHeaderComponent={
            <View className="flex-row items-center gap-3 rounded-xl bg-muted/50 p-4 mb-2">
              <View className="h-9 w-9 rounded-xl bg-background items-center justify-center">
                <Landmark size={18} className="text-foreground" />
              </View>
              <Text className="text-sm text-muted-foreground flex-1">
                Completed and in-progress transfers to your connected bank account.
              </Text>
            </View>
          }
          refreshControl={Platform.OS !== 'web' ? (
            <RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load() }} />
          ) : undefined}
          ListEmptyComponent={
            <View className="items-center py-14 px-8">
              <Text className="text-base font-semibold text-foreground">No payouts yet</Text>
              <Text className="text-center text-muted-foreground text-sm mt-1">
                Payouts are shown here once a transfer has been created.
              </Text>
            </View>
          }
          renderItem={({ item }) => (
            <Card>
              <CardContent className="flex-row items-center gap-3 p-4">
                <View className="flex-1">
                  <Text className="text-foreground text-lg font-semibold">{dollars(item.amountCents)}</Text>
                  <Text className="text-xs text-muted-foreground">
                    {item.paidAt
                      ? `Paid ${new Date(item.paidAt).toLocaleDateString()}`
                      : `Created ${new Date(item.createdAt).toLocaleDateString()}`}
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
