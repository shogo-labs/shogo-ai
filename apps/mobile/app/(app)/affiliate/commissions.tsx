// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { useCallback, useEffect, useState } from 'react'
import { View, Text, FlatList, Pressable, ActivityIndicator, RefreshControl, Platform } from 'react-native'
import { useRouter } from 'expo-router'
import { ArrowLeft } from 'lucide-react-native'
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
      <View className="flex-row items-center gap-2 px-4 py-3 border-b border-border">
        <Pressable onPress={() => router.back()} hitSlop={8}>
          <ArrowLeft size={22} className="text-foreground" />
        </Pressable>
        <Text className="text-lg font-semibold text-foreground">Commissions</Text>
      </View>

      <View className="flex-row flex-wrap gap-2 p-4 border-b border-border">
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
            <Text className="text-center text-muted-foreground text-sm py-16">No commissions yet.</Text>
          }
          renderItem={({ item }) => (
            <Card>
              <CardContent className="flex-row items-center gap-3 p-3">
                <View className="flex-1">
                  <Text className="text-foreground font-medium">{dollars(item.amountCents)} · L{item.level}</Text>
                  <Text className="text-xs text-muted-foreground">
                    {new Date(item.createdAt).toLocaleString()}
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
