// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { useCallback, useEffect, useState } from 'react'
import { View, Text, FlatList, Pressable, ActivityIndicator, RefreshControl, Platform } from 'react-native'
import { useRouter } from 'expo-router'
import { ArrowLeft } from 'lucide-react-native'
import { Card, CardContent, Badge } from '@shogo/shared-ui/primitives'
import { useDomainHttp } from '../../../contexts/domain'
import { affiliateApi, type AffiliatePayoutRow } from '../../../lib/affiliate-api'

function dollars(cents: number) { return `$${(cents / 100).toFixed(2)}` }

export default function PayoutsScreen() {
  const router = useRouter()
  const http = useDomainHttp()
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
      <View className="flex-row items-center gap-2 px-4 py-3 border-b border-border">
        <Pressable onPress={() => router.back()} hitSlop={8}>
          <ArrowLeft size={22} className="text-foreground" />
        </Pressable>
        <Text className="text-lg font-semibold text-foreground">Payouts</Text>
      </View>

      {loading ? (
        <View className="py-16 items-center"><ActivityIndicator /></View>
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(r) => r.id}
          contentContainerStyle={{ padding: 16, gap: 8 }}
          refreshControl={Platform.OS !== 'web' ? (
            <RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load() }} />
          ) : undefined}
          ListEmptyComponent={
            <Text className="text-center text-muted-foreground text-sm py-16">No payouts yet.</Text>
          }
          renderItem={({ item }) => (
            <Card>
              <CardContent className="flex-row items-center gap-3 p-3">
                <View className="flex-1">
                  <Text className="text-foreground font-medium">{dollars(item.amountCents)}</Text>
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
