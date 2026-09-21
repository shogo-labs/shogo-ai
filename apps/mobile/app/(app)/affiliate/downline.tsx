// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { useCallback, useEffect, useState } from 'react'
import { View, Text, FlatList, Pressable, ActivityIndicator, RefreshControl, Platform } from 'react-native'
import { useRouter } from 'expo-router'
import { ArrowLeft, Users } from 'lucide-react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Card, CardContent, Badge } from '@shogo/shared-ui/primitives'
import { useDomainHttp } from '../../../contexts/domain'
import { affiliateApi, type AffiliateDownlineNode } from '../../../lib/affiliate-api'

export default function DownlineScreen() {
  const router = useRouter()
  const http = useDomainHttp()
  const insets = useSafeAreaInsets()
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
      <View
        className="flex-row items-center gap-3 px-5 pb-3 border-b border-border"
        style={{ paddingTop: Math.max(insets.top, 12) }}
      >
        <Pressable onPress={() => router.back()} hitSlop={8}>
          <ArrowLeft size={22} className="text-foreground" />
        </Pressable>
        <View className="flex-1">
          <Text className="text-[11px] uppercase tracking-[1.5px] font-semibold text-muted-foreground">
            Referral network
          </Text>
          <Text className="text-lg font-semibold text-foreground">Downline</Text>
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
            paddingTop: 20,
            paddingBottom: Math.max(insets.bottom, 16) + 28,
            gap: 10,
            flexGrow: 1,
          }}
          refreshControl={Platform.OS !== 'web' ? (
            <RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load() }} />
          ) : undefined}
          ListHeaderComponent={
            <View className="w-full max-w-5xl self-center gap-4 mb-2">
              <View className="gap-1">
                <Text className="text-2xl font-semibold tracking-tight text-foreground">
                  People growing with you
                </Text>
                <Text className="text-sm text-muted-foreground leading-5">
                  Follow direct referrals or the full network built from your link.
                </Text>
              </View>
              <Card>
                <CardContent className="flex-row items-center gap-3 p-4">
                  <View className="h-9 w-9 rounded-xl bg-primary/10 items-center justify-center">
                    <Users size={18} className="text-primary" />
                  </View>
                  <View className="flex-1 gap-2">
                    <View className="flex-row items-center justify-between gap-2">
                      <Text className="text-sm font-semibold text-foreground">
                        {showAll ? 'Full referral tree' : 'Direct referrals'}
                      </Text>
                      <Text className="text-xs text-muted-foreground">
                        {rows.length} {rows.length === 1 ? 'member' : 'members'}
                      </Text>
                    </View>
                    <View className="flex-row gap-2">
                      <Pressable onPress={() => setShowAll(false)}>
                        <Badge variant={!showAll ? 'default' : 'secondary'}>
                          <Text className={!showAll ? 'text-primary-foreground text-xs' : 'text-xs'}>
                            Direct
                          </Text>
                        </Badge>
                      </Pressable>
                      <Pressable onPress={() => setShowAll(true)}>
                        <Badge variant={showAll ? 'default' : 'secondary'}>
                          <Text className={showAll ? 'text-primary-foreground text-xs' : 'text-xs'}>
                            Full tree
                          </Text>
                        </Badge>
                      </Pressable>
                    </View>
                  </View>
                </CardContent>
              </Card>
              <Text className="text-[11px] uppercase tracking-[1.5px] font-semibold text-muted-foreground">
                {showAll ? 'All levels' : 'First level'}
              </Text>
            </View>
          }
          ListEmptyComponent={
            <View className="w-full max-w-5xl self-center items-center py-16 px-8">
              <View className="h-12 w-12 rounded-full bg-muted items-center justify-center mb-3">
                <Users size={20} className="text-muted-foreground" />
              </View>
              <Text className="text-base font-semibold text-foreground">No referrals yet</Text>
              <Text className="text-center text-muted-foreground text-sm mt-1">
                Share your referral link to begin building your network.
              </Text>
            </View>
          }
          renderItem={({ item }) => (
            <View className="w-full max-w-5xl self-center">
              <Card>
                <CardContent className="flex-row items-center gap-3 p-4">
                  <View className="h-9 w-9 rounded-xl bg-muted items-center justify-center">
                    <Text className="text-sm font-semibold text-foreground">
                      {(item.displayName ?? item.code).slice(0, 1).toUpperCase()}
                    </Text>
                  </View>
                  <View className="flex-1">
                    <Text className="text-foreground font-medium">{item.displayName ?? item.code}</Text>
                    <Text className="text-xs text-muted-foreground">
                      Referral code {item.code} · joined {new Date(item.createdAt).toLocaleDateString()}
                    </Text>
                  </View>
                  <Badge variant="secondary"><Text className="text-xs">Level {item.level}</Text></Badge>
                </CardContent>
              </Card>
            </View>
          )}
        />
      )}
    </View>
  )
}
