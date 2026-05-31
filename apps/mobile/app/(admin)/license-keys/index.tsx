// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Admin License Keys - Listing of minted `LicenseKey` rows with a batch
 * filter, redeemed-status filter, and a "Mint keys" button.
 *
 * License keys are single-use coupons that confer a paid-tier
 * `WorkspaceGrant` when redeemed. Plaintext codes are returned exactly
 * once at mint time (see ./mint.tsx) and are never persisted, so this
 * list only ever shows the `codePrefix`, never the full key.
 */

import { useState, useEffect, useCallback } from 'react'
import {
  View,
  Text,
  FlatList,
  Pressable,
  TextInput,
  ActivityIndicator,
  RefreshControl,
  useWindowDimensions,
} from 'react-native'
import { useRouter } from 'expo-router'
import {
  Search,
  KeyRound,
  Plus,
  ChevronLeft,
  ChevronRight,
  Users,
  DollarSign,
  Ban,
} from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import { API_URL } from '../../../lib/api'

const API_BASE = `${API_URL}/api/admin`

const PAGE_SIZE = 50

interface AdminLicenseKey {
  id: string
  codePrefix: string
  batchId: string | null
  planId: string
  monthlyIncludedUsd: number
  freeSeats: number
  durationDays: number | null
  expiresAt: string | null
  redeemedAt: string | null
  redeemedByWorkspaceId: string | null
  redeemedByUserId: string | null
  redeemedGrantId: string | null
  note: string | null
  createdByUserId: string | null
  createdAt: string
}

interface LicenseKeysResponse {
  items: AdminLicenseKey[]
  count: number
}

async function fetchAdminJson<T>(path: string, params?: Record<string, string>): Promise<T | null> {
  const qs = params ? '?' + new URLSearchParams(params).toString() : ''
  try {
    const res = await fetch(`${API_BASE}${path}${qs}`, { credentials: 'include' })
    if (!res.ok) return null
    const json = await res.json()
    return json.data ?? null
  } catch {
    return null
  }
}

async function postAdmin<T>(path: string): Promise<{ ok: boolean; data?: T; error?: string }> {
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
    })
    const json = await res.json().catch(() => null)
    if (!res.ok) {
      return { ok: false, error: json?.error?.message ?? `HTTP ${res.status}` }
    }
    return { ok: true, data: json?.data }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'request failed' }
  }
}

const STATUS_OPTIONS = [
  { value: 'available', label: 'Available' },
  { value: 'redeemed', label: 'Redeemed' },
  { value: 'all', label: 'All' },
] as const

type StatusFilter = (typeof STATUS_OPTIONS)[number]['value']

type KeyState = 'redeemed' | 'expired' | 'available'

function keyState(key: AdminLicenseKey, now: Date = new Date()): KeyState {
  if (key.redeemedAt) return 'redeemed'
  if (key.expiresAt && new Date(key.expiresAt) <= now) return 'expired'
  return 'available'
}

const STATE_PILL: Record<KeyState, { bg: string; text: string; label: string }> = {
  redeemed: {
    bg: 'bg-blue-100 dark:bg-blue-900/30',
    text: 'text-blue-700 dark:text-blue-400',
    label: 'Redeemed',
  },
  available: {
    bg: 'bg-green-100 dark:bg-green-900/30',
    text: 'text-green-700 dark:text-green-400',
    label: 'Available',
  },
  expired: {
    bg: 'bg-muted',
    text: 'text-muted-foreground',
    label: 'Expired',
  },
}

function LicenseKeyRow({
  licenseKey,
  isWide,
  onRevoke,
  revoking,
}: {
  licenseKey: AdminLicenseKey
  isWide: boolean
  onRevoke: () => void
  revoking: boolean
}) {
  const state = keyState(licenseKey)
  const pill = STATE_PILL[state]
  const subtitle = licenseKey.batchId
    ? `Batch ${licenseKey.batchId}`
    : licenseKey.expiresAt
      ? `Expires ${new Date(licenseKey.expiresAt).toLocaleDateString()}`
      : licenseKey.note || 'No batch'

  return (
    <View
      className={cn(
        'flex-row items-center border-b border-border',
        isWide ? 'px-4 py-3' : 'p-3',
      )}
    >
      <View className="h-9 w-9 rounded-lg bg-primary/10 items-center justify-center mr-3">
        <KeyRound size={16} className="text-primary" />
      </View>

      <View className={cn('min-w-0 mr-2', isWide ? 'w-[240px]' : 'flex-1')}>
        <Text className="text-sm font-medium text-foreground" numberOfLines={1}>
          {licenseKey.codePrefix}…
        </Text>
        <Text className="text-xs text-muted-foreground" numberOfLines={1}>
          {subtitle}
        </Text>
      </View>

      <View className="w-[70px] mr-3">
        <Text className="text-xs font-medium text-foreground capitalize" numberOfLines={1}>
          {licenseKey.planId}
        </Text>
      </View>

      <View className="flex-row items-center gap-1 mr-3 w-[70px]">
        <Users size={11} className="text-muted-foreground" />
        <Text className="text-xs text-muted-foreground">{licenseKey.freeSeats}</Text>
      </View>

      <View className="flex-row items-center gap-1 mr-3 w-[90px]">
        <DollarSign size={11} className="text-muted-foreground" />
        <Text className="text-xs text-muted-foreground">
          ${licenseKey.monthlyIncludedUsd.toFixed(0)}/mo
        </Text>
      </View>

      <View className={cn('px-2 py-0.5 rounded-full mr-3', pill.bg)}>
        <Text className={cn('text-[10px] font-medium', pill.text)}>{pill.label}</Text>
      </View>

      {isWide && (
        <View className="w-[90px] flex-row justify-end ml-auto">
          {state === 'available' ? (
            <Pressable
              onPress={onRevoke}
              disabled={revoking}
              className={cn(
                'flex-row items-center gap-1 px-2 py-1 rounded-md border border-border active:opacity-70',
                revoking && 'opacity-40',
              )}
            >
              {revoking ? (
                <ActivityIndicator size="small" />
              ) : (
                <>
                  <Ban size={12} className="text-red-600 dark:text-red-400" />
                  <Text className="text-[11px] text-red-600 dark:text-red-400">Revoke</Text>
                </>
              )}
            </Pressable>
          ) : (
            <Text className="text-xs text-muted-foreground">
              {new Date(licenseKey.createdAt).toLocaleDateString(undefined, {
                month: 'short',
                day: 'numeric',
              })}
            </Text>
          )}
        </View>
      )}
    </View>
  )
}

export default function AdminLicenseKeysPage() {
  const router = useRouter()
  const { width } = useWindowDimensions()
  const isWide = width >= 900

  const [batchSearch, setBatchSearch] = useState('')
  const [offset, setOffset] = useState(0)
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [data, setData] = useState<LicenseKeysResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [revokingId, setRevokingId] = useState<string | null>(null)

  const loadKeys = useCallback(async () => {
    const params: Record<string, string> = {
      limit: String(PAGE_SIZE),
      offset: String(offset),
    }
    if (batchSearch.trim()) params.batchId = batchSearch.trim()
    if (statusFilter === 'available') params.redeemed = 'false'
    if (statusFilter === 'redeemed') params.redeemed = 'true'

    const result = await fetchAdminJson<LicenseKeysResponse>('/license-keys', params)
    setData(result)
    setLoading(false)
    setRefreshing(false)
  }, [offset, batchSearch, statusFilter])

  useEffect(() => {
    setLoading(true)
    loadKeys()
  }, [loadKeys])

  const onRefresh = () => {
    setRefreshing(true)
    loadKeys()
  }

  const onRevoke = async (id: string) => {
    setRevokingId(id)
    const result = await postAdmin(`/license-keys/${id}/revoke`)
    setRevokingId(null)
    if (!result.ok) {
      if (typeof window !== 'undefined' && typeof window.alert === 'function') {
        window.alert(`Failed to revoke\n\n${result.error ?? 'Unknown error'}`)
      }
      return
    }
    loadKeys()
  }

  const items = data?.items ?? []
  const page = Math.floor(offset / PAGE_SIZE) + 1
  const hasNext = items.length === PAGE_SIZE
  const hasPrev = offset > 0

  const ListHeader = () => (
    <View className="gap-3 mb-2">
      <View className={cn(isWide ? 'flex-row items-center gap-3' : 'gap-3')}>
        <View
          className={cn(
            'flex-row items-center border border-border rounded-lg px-3 py-2 bg-card',
            isWide ? 'flex-1' : '',
          )}
        >
          <Search size={16} className="text-muted-foreground mr-2" />
          <TextInput
            placeholder="Filter by batch id…"
            placeholderTextColor="#9ca3af"
            value={batchSearch}
            onChangeText={(t) => {
              setBatchSearch(t)
              setOffset(0)
            }}
            autoCapitalize="none"
            autoCorrect={false}
            className="flex-1 text-foreground text-sm"
          />
        </View>

        <View
          className={cn(
            'flex-row items-center bg-muted rounded-lg p-0.5 gap-0.5',
            isWide ? 'w-[280px]' : '',
          )}
        >
          {STATUS_OPTIONS.map((s) => (
            <Pressable
              key={s.value}
              onPress={() => {
                setStatusFilter(s.value)
                setOffset(0)
              }}
              className={cn(
                'flex-1 items-center py-1.5 rounded-md',
                statusFilter === s.value ? 'bg-background shadow-sm' : '',
              )}
            >
              <Text
                className={cn(
                  'text-xs font-medium',
                  statusFilter === s.value ? 'text-foreground' : 'text-muted-foreground',
                )}
              >
                {s.label}
              </Text>
            </Pressable>
          ))}
        </View>

        <Pressable
          onPress={() => router.push('/(admin)/license-keys/mint' as any)}
          className="flex-row items-center gap-1.5 bg-primary px-3 py-2 rounded-lg active:opacity-80"
        >
          <Plus size={14} className="text-primary-foreground" />
          <Text className="text-sm font-medium text-primary-foreground">Mint keys</Text>
        </Pressable>
      </View>

      <View
        className={cn(
          'flex-row items-center bg-muted/50 rounded-t-lg border-b border-border',
          isWide ? 'px-4 py-2.5' : 'px-3 py-2',
        )}
      >
        <View className="w-9 mr-3" />
        <Text
          className={cn(
            'text-xs font-medium text-muted-foreground',
            isWide ? 'w-[240px]' : 'flex-1',
          )}
        >
          Key
        </Text>
        <Text className="text-xs font-medium text-muted-foreground w-[70px] mr-3">Plan</Text>
        <Text className="text-xs font-medium text-muted-foreground w-[70px] mr-3">Seats</Text>
        <Text className="text-xs font-medium text-muted-foreground w-[90px] mr-3">Monthly USD</Text>
        <Text className="text-xs font-medium text-muted-foreground mr-3">Status</Text>
        {isWide && (
          <Text className="text-xs font-medium text-muted-foreground w-[90px] text-right ml-auto">
            Action
          </Text>
        )}
      </View>
    </View>
  )

  const ListFooter = () => {
    if (!hasNext && !hasPrev) return null
    return (
      <View className="flex-row items-center justify-end mt-3 px-1">
        <View className="flex-row items-center gap-2">
          <Pressable
            onPress={() => setOffset((o) => Math.max(0, o - PAGE_SIZE))}
            disabled={!hasPrev}
            className={cn('p-2 rounded-md border border-border', !hasPrev && 'opacity-30')}
          >
            <ChevronLeft size={16} className="text-foreground" />
          </Pressable>
          <Text className="text-xs text-muted-foreground">Page {page}</Text>
          <Pressable
            onPress={() => setOffset((o) => o + PAGE_SIZE)}
            disabled={!hasNext}
            className={cn('p-2 rounded-md border border-border', !hasNext && 'opacity-30')}
          >
            <ChevronRight size={16} className="text-foreground" />
          </Pressable>
        </View>
      </View>
    )
  }

  const EmptyState = () => (
    <View className="items-center justify-center py-16">
      <KeyRound size={32} className="text-muted-foreground/50 mb-2" />
      <Text className="text-sm text-muted-foreground">No license keys</Text>
    </View>
  )

  return (
    <View className={cn('flex-1 bg-background', isWide ? 'px-8 pt-6' : 'px-4 pt-2')}>
      <View className="flex-1">
        <FlatList
          data={items}
          keyExtractor={(item) => item.id}
          ListHeaderComponent={<ListHeader />}
          ListFooterComponent={<ListFooter />}
          ListEmptyComponent={loading ? null : <EmptyState />}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
          renderItem={({ item }) => (
            <LicenseKeyRow
              licenseKey={item}
              isWide={isWide}
              revoking={revokingId === item.id}
              onRevoke={() => onRevoke(item.id)}
            />
          )}
          contentContainerStyle={{ paddingBottom: 20 }}
          showsVerticalScrollIndicator={false}
        />
        {loading && !refreshing && (
          <View className="absolute inset-0 items-center justify-center bg-background/80">
            <ActivityIndicator size="large" />
          </View>
        )}
      </View>
    </View>
  )
}
