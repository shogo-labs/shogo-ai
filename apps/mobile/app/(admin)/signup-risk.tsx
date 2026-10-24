// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Admin: signup risk review (super-admin only).
 *
 * Lists scored signups (highest risk first), with a summary of the last 30
 * days by band and decision. Expand a row to see the accounts it's linked to
 * (same IP prefix, device id, or canonical email) and whether each has a paid
 * or trialing subscription. Approve releases the full $10, revoke zeroes the
 * remaining credit, ban revokes and ends sessions.
 *
 * Backed by:
 *   GET  /api/admin/signup-risk?pending=1
 *   GET  /api/admin/signup-risk/:userId
 *   POST /api/admin/signup-risk/:userId/{approve|revoke|ban}
 */

import { useState, useEffect, useCallback } from 'react'
import { View, Text, ScrollView, Pressable, ActivityIndicator, RefreshControl } from 'react-native'
import { ShieldAlert, RefreshCw, ChevronDown, ChevronRight } from 'lucide-react-native'
import { API_URL } from '../../lib/api'

const API_BASE = `${API_URL}/api/admin/signup-risk`

interface RiskSummaryRow { band: string; decision: string; count: number }
interface RiskItem {
  userId: string
  email: string | null
  name: string | null
  emailVerified: boolean
  score: number
  band: string
  decision: string
  reviewDecision: string | null
  ip: string | null
  ipPrefix: string | null
  country: string | null
  deviceId: string | null
  signals: { items?: Array<{ key: string; label?: string; points: number }> } | null
}
interface LinkedAccount {
  userId: string
  email: string | null
  emailVerified: boolean
  paid: { planId: string; status: string } | null
  linkedBy: Array<'ip' | 'ipPrefix' | 'device' | 'email'>
  band: string
  score: number
}
interface RiskDetail {
  subject: RiskItem & { paid: { planId: string; status: string } | null }
  linked: LinkedAccount[]
}

async function getJson<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(`${API_BASE}${path}`, { credentials: 'include' })
    if (!res.ok) return null
    return (await res.json()) as T
  } catch {
    return null
  }
}

async function postAction(userId: string, action: 'approve' | 'revoke' | 'ban'): Promise<string> {
  try {
    const res = await fetch(`${API_BASE}/${encodeURIComponent(userId)}/${action}`, {
      method: 'POST',
      credentials: 'include',
    })
    const json = await res.json().catch(() => ({}))
    if (!res.ok) return json?.error ?? `Failed (${res.status})`
    return action === 'approve' ? 'Credit released' : action === 'revoke' ? 'Credit revoked' : 'Banned: credit revoked, sessions ended'
  } catch {
    return 'Network error'
  }
}

const BAND_CLASS: Record<string, string> = {
  high: 'text-destructive',
  medium: 'text-amber-600',
  low: 'text-muted-foreground',
}

export default function SignupRiskScreen() {
  const [items, setItems] = useState<RiskItem[]>([])
  const [summary, setSummary] = useState<RiskSummaryRow[]>([])
  const [pendingOnly, setPendingOnly] = useState(true)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [detail, setDetail] = useState<RiskDetail | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  const load = useCallback(async () => {
    const data = await getJson<{ summary: { byBandAndDecision: RiskSummaryRow[] }; items: RiskItem[] }>(
      `?pending=${pendingOnly ? '1' : '0'}`,
    )
    setItems(data?.items ?? [])
    setSummary(data?.summary?.byBandAndDecision ?? [])
    setLoading(false)
    setRefreshing(false)
  }, [pendingOnly])

  useEffect(() => {
    setLoading(true)
    void load()
  }, [load])

  const toggleExpand = async (userId: string) => {
    if (expandedId === userId) {
      setExpandedId(null)
      setDetail(null)
      return
    }
    setExpandedId(userId)
    setDetail(null)
    const d = await getJson<RiskDetail & { ok: boolean }>(`/${encodeURIComponent(userId)}`)
    setDetail(d ?? null)
  }

  const act = async (userId: string, action: 'approve' | 'revoke' | 'ban') => {
    setBusyId(userId)
    const msg = await postAction(userId, action)
    setMessage(msg)
    setBusyId(null)
    void load()
  }

  return (
    <ScrollView
      className="flex-1 bg-background"
      contentContainerStyle={{ padding: 16, gap: 12 }}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); void load() }} />
      }
    >
      <View className="flex-row items-center justify-between">
        <View className="flex-row items-center gap-2">
          <ShieldAlert size={18} color="#6b7280" />
          <Text className="text-lg font-semibold text-foreground">Signup risk</Text>
        </View>
        <Pressable onPress={() => { setLoading(true); void load() }} className="p-2">
          <RefreshCw size={16} color="#6b7280" />
        </Pressable>
      </View>

      <View className="rounded-xl border border-border bg-card p-3 gap-1">
        <Text className="text-xs font-medium text-muted-foreground">Last 30 days</Text>
        {summary.length === 0 ? (
          <Text className="text-sm text-muted-foreground">No assessments yet.</Text>
        ) : (
          summary.map((row) => (
            <Text key={`${row.band}-${row.decision}`} className="text-sm text-foreground">
              {row.band} · {row.decision}: {row.count}
            </Text>
          ))
        )}
      </View>

      <View className="flex-row gap-2">
        {[true, false].map((flag) => (
          <Pressable
            key={String(flag)}
            onPress={() => { setLoading(true); setPendingOnly(flag) }}
            className={`px-3 py-1.5 rounded-md border border-border ${pendingOnly === flag ? 'bg-primary' : 'bg-background'}`}
          >
            <Text className={`text-xs font-medium ${pendingOnly === flag ? 'text-primary-foreground' : 'text-foreground'}`}>
              {flag ? 'Needs review' : 'All scored'}
            </Text>
          </Pressable>
        ))}
      </View>

      {message ? <Text className="text-xs text-muted-foreground">{message}</Text> : null}

      {loading ? (
        <ActivityIndicator />
      ) : items.length === 0 ? (
        <Text className="text-sm text-muted-foreground">Nothing to review.</Text>
      ) : (
        items.map((item) => {
          const expanded = expandedId === item.userId
          return (
            <View key={item.userId} className="rounded-xl border border-border bg-card p-3 gap-2">
              <Pressable onPress={() => toggleExpand(item.userId)} className="flex-row items-center gap-2">
                {expanded ? <ChevronDown size={14} color="#6b7280" /> : <ChevronRight size={14} color="#6b7280" />}
                <View className="flex-1">
                  <Text className="text-sm font-medium text-foreground">{item.email ?? item.userId}</Text>
                  <Text className={`text-xs ${BAND_CLASS[item.band] ?? 'text-muted-foreground'}`}>
                    {item.band} · score {item.score} · {item.decision}
                    {item.reviewDecision ? ` · ${item.reviewDecision}` : ''}
                  </Text>
                </View>
              </Pressable>

              {expanded && (
                <View className="gap-2 pt-1">
                  <Text className="text-xs text-muted-foreground">
                    {item.country ?? 'unknown country'} · IP {item.ip ?? 'n/a'} · device {item.deviceId ? item.deviceId.slice(0, 8) : 'n/a'}
                  </Text>
                  {(item.signals?.items ?? []).map((sig) => (
                    <Text key={sig.key} className="text-xs text-foreground">
                      +{sig.points} {sig.label ?? sig.key}
                    </Text>
                  ))}
                  <Text className="text-xs font-medium text-foreground">
                    Linked accounts: {detail && detail.subject.userId === item.userId ? detail.linked.length : '…'}
                  </Text>
                  {detail && detail.subject.userId === item.userId && detail.linked.map((l) => (
                    <Text key={l.userId} className="text-xs text-muted-foreground">
                      {l.email ?? l.userId} · {l.linkedBy.join(', ')} · {l.paid ? `paid (${l.paid.planId})` : 'not paid'}
                    </Text>
                  ))}
                  <View className="flex-row gap-2 pt-1">
                    <Pressable
                      disabled={busyId === item.userId}
                      onPress={() => act(item.userId, 'approve')}
                      className="px-3 py-1.5 rounded-md bg-primary"
                    >
                      <Text className="text-xs font-medium text-primary-foreground">Approve $10</Text>
                    </Pressable>
                    <Pressable
                      disabled={busyId === item.userId}
                      onPress={() => act(item.userId, 'revoke')}
                      className="px-3 py-1.5 rounded-md border border-border"
                    >
                      <Text className="text-xs font-medium text-foreground">Revoke</Text>
                    </Pressable>
                    <Pressable
                      disabled={busyId === item.userId}
                      onPress={() => act(item.userId, 'ban')}
                      className="px-3 py-1.5 rounded-md border border-destructive"
                    >
                      <Text className="text-xs font-medium text-destructive">Ban</Text>
                    </Pressable>
                  </View>
                </View>
              )}
            </View>
          )
        })
      )}
    </ScrollView>
  )
}
