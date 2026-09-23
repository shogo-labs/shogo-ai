// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Admin: Affiliate / creator payout queue (super-admin only).
 *
 * Affiliate + content-CPM payouts are NEVER automatic — there is no payout
 * cron. This is the queue of creators with approved, unpaid commissions; an
 * admin releases each one explicitly. Per-creator review (and the same pay
 * action) also lives on the creator detail page.
 *
 * Backed by:
 *   GET  /api/admin/affiliates/payouts/owed
 *   POST /api/admin/affiliates/:id/payout
 */

import { useState, useEffect, useCallback } from 'react'
import {
  View,
  Text,
  ScrollView,
  Pressable,
  ActivityIndicator,
  RefreshControl,
  useWindowDimensions,
} from 'react-native'
import { useRouter } from 'expo-router'
import { Wallet, Clock, RefreshCw, CheckCircle2 } from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import { API_URL, type AdminAffiliateOwed } from '../../lib/api'

const API_BASE = `${API_URL}/api/admin`

function usd(cents: number): string {
  return `$${(cents / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

async function fetchOwed(): Promise<AdminAffiliateOwed[]> {
  try {
    const res = await fetch(`${API_BASE}/affiliates/payouts/owed`, { credentials: 'include' })
    if (!res.ok) return []
    const json = await res.json()
    return (json?.items ?? []) as AdminAffiliateOwed[]
  } catch {
    return []
  }
}

export default function AffiliatePayoutsScreen() {
  const router = useRouter()
  const { width } = useWindowDimensions()
  const isWide = width >= 900
  const [items, setItems] = useState<AdminAffiliateOwed[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [payingId, setPayingId] = useState<string | null>(null)
  const [rowError, setRowError] = useState<Record<string, string>>({})
  const [paidMsg, setPaidMsg] = useState<string | null>(null)

  const load = useCallback(async () => {
    const data = await fetchOwed()
    setItems(data)
    setLoading(false)
    setRefreshing(false)
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const onRefresh = useCallback(() => {
    setRefreshing(true)
    load()
  }, [load])

  const pay = useCallback(async (affiliateId: string) => {
    setPayingId(affiliateId)
    setPaidMsg(null)
    setRowError((p) => {
      const next = { ...p }
      delete next[affiliateId]
      return next
    })
    try {
      const res = await fetch(`${API_BASE}/affiliates/${encodeURIComponent(affiliateId)}/payout`, {
        method: 'POST',
        credentials: 'include',
      })
      const body = await res.json().catch(() => null)
      if (!res.ok) {
        setRowError((p) => ({ ...p, [affiliateId]: body?.error?.message ?? 'Payout failed.' }))
        return
      }
      setPaidMsg(`Released ${usd(body?.paidCents ?? 0)}.`)
      await load()
    } catch {
      setRowError((p) => ({ ...p, [affiliateId]: 'Payout failed. Please try again.' }))
    } finally {
      setPayingId(null)
    }
  }, [load])

  const totalOwed = items.reduce((sum, i) => sum + i.owedCents, 0)

  if (loading) {
    return (
      <View className="flex-1 items-center justify-center bg-background">
        <ActivityIndicator size="large" />
      </View>
    )
  }

  return (
    <ScrollView
      className="flex-1 bg-background"
      contentContainerStyle={{
        paddingHorizontal: isWide ? 32 : 16,
        paddingTop: isWide ? 24 : 16,
        paddingBottom: 40,
      }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
    >
      <View className="w-full max-w-[980px] self-center">
        <View className="mb-4 rounded-2xl border border-border bg-card p-4">
          <View className="flex-row items-start gap-3">
            <View className="h-9 w-9 shrink-0 rounded-lg bg-primary/10 items-center justify-center">
              <Wallet size={17} className="text-primary" />
            </View>
            <View className="flex-1 min-w-0">
              <Text className="text-[11px] font-semibold uppercase tracking-[1.2px] text-muted-foreground">
                Affiliate finance
              </Text>
              <Text className={cn('mt-1 font-bold text-foreground tracking-tight', isWide ? 'text-2xl' : 'text-xl')}>
                Affiliate payouts
              </Text>
              <Text className="mt-1 text-sm leading-5 text-muted-foreground">
                Approved commissions awaiting an explicit manual release. Payouts are never automatic.
              </Text>
            </View>
            <Pressable onPress={onRefresh} className="rounded-lg border border-border p-2 active:bg-muted" accessibilityLabel="Refresh">
              <RefreshCw size={16} className="text-muted-foreground" />
            </Pressable>
          </View>
        </View>

        {paidMsg ? (
          <View className="flex-row items-center gap-2 rounded-lg border border-emerald-500/20 bg-emerald-500/10 px-3 py-2 mb-4">
            <CheckCircle2 size={16} color="#059669" />
            <Text className="text-sm text-emerald-700">{paidMsg}</Text>
          </View>
        ) : null}

        {items.length > 0 ? (
          <View className="mb-4 flex-row items-center justify-between rounded-xl border border-border bg-card px-4 py-3">
            <View>
              <Text className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Ready for review</Text>
              <Text className="mt-0.5 text-sm text-muted-foreground">
                {items.length} {items.length === 1 ? 'creator' : 'creators'} owed
              </Text>
            </View>
            <Text className="text-xl font-bold text-foreground">{usd(totalOwed)}</Text>
          </View>
        ) : null}

        {items.length === 0 ? (
          <View className="rounded-xl border border-border bg-card p-8 items-center">
            <Wallet size={28} className="text-muted-foreground mb-2" />
            <Text className="text-sm font-medium text-foreground">Nothing to pay out</Text>
            <Text className="text-xs text-muted-foreground mt-1 text-center">
              No creators currently have approved, unpaid commissions.
            </Text>
          </View>
        ) : (
          <View className="overflow-hidden rounded-xl border border-border bg-card">
            {items.map((item) => {
              const ready = item.payoutReady
              const busy = payingId === item.affiliateId
              const err = rowError[item.affiliateId]
              return (
                <View key={item.affiliateId} className="border-b border-border/70 p-4 last:border-b-0">
                  <View className={cn('gap-3', isWide ? 'flex-row items-center justify-between' : '')}>
                    <Pressable
                      onPress={() => router.push(`/(admin)/creators/${encodeURIComponent(item.userId)}` as any)}
                      className="flex-1 active:opacity-70"
                    >
                      <Text className="text-sm font-semibold text-foreground" numberOfLines={1}>
                        {item.name || item.email || item.code}
                      </Text>
                      <Text className="text-xs text-muted-foreground" numberOfLines={1}>
                        {item.email ? `${item.email} · ` : ''}Code {item.code}
                      </Text>
                    </Pressable>
                    <View className={cn('flex-row items-center justify-between gap-3', isWide ? '' : 'border-t border-border/70 pt-3')}>
                      <Text className="text-lg font-bold text-foreground">{usd(item.owedCents)}</Text>
                      <Pressable
                        onPress={() => pay(item.affiliateId)}
                        disabled={busy || !ready}
                        className={cn(
                          'flex-row items-center gap-1.5 px-3 py-2 rounded-lg',
                          ready ? 'bg-primary active:opacity-80' : 'bg-muted',
                        )}
                      >
                        {busy ? (
                          <ActivityIndicator size="small" color="#fff" />
                        ) : (
                          <Wallet size={14} className={ready ? 'text-primary-foreground' : 'text-muted-foreground'} />
                        )}
                        <Text className={cn('text-xs font-semibold', ready ? 'text-primary-foreground' : 'text-muted-foreground')}>
                          Pay
                        </Text>
                      </Pressable>
                    </View>
                  </View>
                  {!ready ? (
                    <View className="flex-row items-center gap-1.5 mt-2">
                      <Clock size={12} className="text-amber-500" />
                      <Text className="text-[11px] text-muted-foreground">
                        Payout setup not verified ({item.payoutStatus}) — creator must finish Stripe onboarding.
                      </Text>
                    </View>
                  ) : null}
                  {err ? <Text className="text-[11px] text-red-600 mt-2">{err}</Text> : null}
                </View>
              )
            })}
          </View>
        )}
      </View>
    </ScrollView>
  )
}
