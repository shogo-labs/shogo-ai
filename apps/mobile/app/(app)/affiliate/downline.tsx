// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { useCallback, useEffect, useState } from 'react'
import { View, Text, FlatList, Pressable, ActivityIndicator, RefreshControl, Platform } from 'react-native'
import { useRouter } from 'expo-router'
import { ArrowLeft } from 'lucide-react-native'
import { Card, CardContent, Badge } from '@shogo/shared-ui/primitives'
import { useDomainHttp } from '../../../contexts/domain'
import { affiliateApi, type AffiliateDownlineNode } from '../../../lib/affiliate-api'

export default function DownlineScreen() {
  const router = useRouter()
  const http = useDomainHttp()
  const [rows, setRows] = useState<AffiliateDownlineNode[]>([])
  const [showAll, setShowAll] = useState(false)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)

  const load = useCallback(async () => {
    try {
      const res = await affiliateApi.getDownline(http, showAll ? { level: 'all' } : undefined)
      setRows(res.downline)
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [http, showAll])

  useEffect(() => { setLoading(true); load() }, [load])

  return (
    <View className="flex-1 bg-background">
      <View className="flex-row items-center gap-2 px-4 py-3 border-b border-border">
        <Pressable onPress={() => router.back()} hitSlop={8}>
          <ArrowLeft size={22} className="text-foreground" />
        </Pressable>
        <Text className="text-lg font-semibold text-foreground">Downline</Text>
      </View>

      <View className="flex-row gap-2 p-4 border-b border-border">
        <Pressable onPress={() => setShowAll(false)}>
          <Badge variant={!showAll ? 'default' : 'secondary'}>
            <Text className={!showAll ? 'text-primary-foreground text-xs' : 'text-xs'}>Direct</Text>
          </Badge>
        </Pressable>
        <Pressable onPress={() => setShowAll(true)}>
          <Badge variant={showAll ? 'default' : 'secondary'}>
            <Text className={showAll ? 'text-primary-foreground text-xs' : 'text-xs'}>Full tree</Text>
          </Badge>
        </Pressable>
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
            <Text className="text-center text-muted-foreground text-sm py-16">
              No referrals yet — share your link to get started.
            </Text>
          }
          renderItem={({ item }) => (
            <Card>
              <CardContent className="flex-row items-center gap-3 p-3">
                <View className="flex-1">
                  <Text className="text-foreground font-medium">{item.displayName ?? item.code}</Text>
                  <Text className="text-xs text-muted-foreground">
                    Code {item.code} · joined {new Date(item.createdAt).toLocaleDateString()}
                  </Text>
                </View>
                <Badge variant="secondary"><Text className="text-xs">L{item.level}</Text></Badge>
              </CardContent>
            </Card>
          )}
        />
      )}
    </View>
  )
}
