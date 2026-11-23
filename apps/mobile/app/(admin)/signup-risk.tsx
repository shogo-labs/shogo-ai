// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Admin: signup risk review + abuse flags (super-admin only).
 *
 * Two tabs:
 *   "Signup Risk" — scored signups, approve / revoke / ban.
 *   "Abuse" (SHO-459) — daily abuse flags, ban / unban / clear.
 *
 * Backed by:
 *   GET  /api/admin/signup-risk?pending=1
 *   GET  /api/admin/signup-risk/:userId
 *   POST /api/admin/signup-risk/:userId/{approve|revoke|ban|unban}
 *   GET  /api/admin/signup-risk/abuse?status=
 *   POST /api/admin/signup-risk/abuse/:flagId/clear
 */

import { useState, useEffect, useCallback } from 'react'
import { View, Text, ScrollView, Pressable, RefreshControl } from 'react-native'
import { ShieldAlert, RefreshCw, ChevronDown, ChevronRight } from 'lucide-react-native'
import { API_URL } from '../../lib/api'
import { Spinner } from '@/components/ui/spinner'

const API_BASE = `${API_URL}/api/admin/signup-risk`

interface RiskSummaryRow { band: string; decision: string; count: number }
interface RiskItem {
  userId: string
  email: string | null
  name: string | null
  emailVerified: boolean
  bannedAt: string | null
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
interface AbuseFlag {
  id: string
  userId: string
  email: string | null
  bannedAt: string | null
  runDate: string
  category: string
  severity: number
  confidence: string
  status: string
  decidedByUserId: string | null
  decidedAt: string | null
  clusterKey: string | null
  createdAt: string
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

async function postAction(userId: string, action: 'approve' | 'revoke' | 'ban' | 'unban'): Promise<string> {
  try {
    const res = await fetch(`${API_BASE}/${encodeURIComponent(userId)}/${action}`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: action === 'ban' ? JSON.stringify({ reason: 'admin-ban' }) : undefined,
    })
    const json = await res.json().catch(() => ({}))
    if (!res.ok) return json?.error ?? `Failed (${res.status})`
    if (action === 'approve') return 'Credit released'
    if (action === 'revoke') return 'Credit revoked'
    if (action === 'ban') return 'Banned: sessions ended, keys revoked'
    if (action === 'unban') return 'Unbanned'
    return 'Done'
  } catch {
    return 'Network error'
  }
}

async function clearFlag(flagId: string): Promise<string> {
  try {
    const res = await fetch(`${API_BASE}/abuse/${encodeURIComponent(flagId)}/clear`, {
      method: 'POST',
      credentials: 'include',
    })
    if (!res.ok) return `Failed (${res.status})`
    return 'Cleared'
  } catch {
    return 'Network error'
  }
}

const BAND_CLASS: Record<string, string> = {
  high: 'text-destructive',
  medium: 'text-amber-600',
  low: 'text-muted-foreground',
}
const STATUS_CLASS: Record<string, string> = {
  flagged: 'text-amber-600',
  banned: 'text-destructive',
  cleared: 'text-muted-foreground',
}

// ─── Signup risk tab ───────────────────────────────────────────────────────

function SignupRiskTab() {
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
    if (expandedId === userId) { setExpandedId(null); setDetail(null); return }
    setExpandedId(userId)
    setDetail(null)
    const d = await getJson<RiskDetail & { ok: boolean }>(`/${encodeURIComponent(userId)}`)
    setDetail(d ?? null)
  }

  const act = async (userId: string, action: 'approve' | 'revoke' | 'ban' | 'unban') => {
    setBusyId(userId)
    const msg = await postAction(userId, action)
    setMessage(msg)
    setBusyId(null)
    void load()
  }

  if (loading) return <Spinner className="mt-8" />

  return (
    <ScrollView
      className="flex-1 bg-background"
      contentContainerStyle={{ padding: 16, gap: 12 }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); void load() }} />}
    >
      {message && (
        <View className="bg-muted rounded-md px-3 py-2">
          <Text className="text-sm text-foreground">{message}</Text>
        </View>
      )}

      <View className="flex-row gap-2">
        <Pressable
          onPress={() => { setPendingOnly(true); setItems([]); setLoading(true) }}
          className={`px-3 py-1.5 rounded-md border ${pendingOnly ? 'bg-primary border-primary' : 'border-border'}`}
        >
          <Text className={`text-xs font-medium ${pendingOnly ? 'text-primary-foreground' : 'text-foreground'}`}>Pending</Text>
        </Pressable>
        <Pressable
          onPress={() => { setPendingOnly(false); setItems([]); setLoading(true) }}
          className={`px-3 py-1.5 rounded-md border ${!pendingOnly ? 'bg-primary border-primary' : 'border-border'}`}
        >
          <Text className={`text-xs font-medium ${!pendingOnly ? 'text-primary-foreground' : 'text-foreground'}`}>All</Text>
        </Pressable>
      </View>

      {summary.length > 0 && (
        <View className="bg-muted rounded-md px-3 py-2 gap-1">
          {summary.map((s) => (
            <Text key={`${s.band}-${s.decision}`} className="text-xs text-foreground">
              {s.band}/{s.decision ?? 'pending'}: {s.count}
            </Text>
          ))}
        </View>
      )}

      {items.map((item) => {
        const expanded = expandedId === item.userId
        return (
          <View key={item.userId} className="bg-card rounded-lg border border-border p-3 gap-1">
            <Pressable onPress={() => void toggleExpand(item.userId)} className="flex-row items-center justify-between">
              <View className="flex-1 gap-0.5">
                <Text className="text-sm font-medium text-foreground" numberOfLines={1}>{item.email ?? item.userId}</Text>
                <Text className={`text-xs font-semibold ${BAND_CLASS[item.band] ?? 'text-foreground'}`}>
                  {item.band} · {item.score}pts · {item.reviewDecision ?? 'unreviewed'}
                  {item.bannedAt ? ' · BANNED' : ''}
                </Text>
              </View>
              {expanded ? <ChevronDown className="text-muted-foreground" size={14} /> : <ChevronRight size={14} />}
            </Pressable>
            {expanded && (
              <View className="gap-2 pt-1">
                <Text className="text-xs text-muted-foreground">
                  {item.country ?? 'unknown country'} · IP {item.ip ?? 'n/a'} · device {item.deviceId ? item.deviceId.slice(0, 8) : 'n/a'}
                </Text>
                {(item.signals?.items ?? []).map((sig) => (
                  <Text key={sig.key} className="text-xs text-foreground">+{sig.points} {sig.label ?? sig.key}</Text>
                ))}
                <Text className="text-xs font-medium text-foreground">
                  Linked: {detail && detail.subject.userId === item.userId ? detail.linked.length : '…'}
                </Text>
                {detail && detail.subject.userId === item.userId && detail.linked.map((l) => (
                  <Text key={l.userId} className="text-xs text-muted-foreground">
                    {l.email ?? l.userId} · {l.linkedBy.join(', ')} · {l.paid ? `paid (${l.paid.planId})` : 'free'}
                  </Text>
                ))}
                <View className="flex-row flex-wrap gap-2 pt-1">
                  <Pressable disabled={busyId === item.userId} onPress={() => act(item.userId, 'approve')} className="px-3 py-1.5 rounded-md bg-primary">
                    <Text className="text-xs font-medium text-primary-foreground">Approve $10</Text>
                  </Pressable>
                  <Pressable disabled={busyId === item.userId} onPress={() => act(item.userId, 'revoke')} className="px-3 py-1.5 rounded-md border border-border">
                    <Text className="text-xs font-medium text-foreground">Revoke</Text>
                  </Pressable>
                  {item.bannedAt ? (
                    <Pressable disabled={busyId === item.userId} onPress={() => act(item.userId, 'unban')} className="px-3 py-1.5 rounded-md border border-border">
                      <Text className="text-xs font-medium text-foreground">Unban</Text>
                    </Pressable>
                  ) : (
                    <Pressable disabled={busyId === item.userId} onPress={() => act(item.userId, 'ban')} className="px-3 py-1.5 rounded-md border border-destructive">
                      <Text className="text-xs font-medium text-destructive">Ban</Text>
                    </Pressable>
                  )}
                </View>
              </View>
            )}
          </View>
        )
      })}
      {items.length === 0 && <Text className="text-sm text-muted-foreground text-center py-8">No items</Text>}
    </ScrollView>
  )
}

// ─── Abuse tab ─────────────────────────────────────────────────────────────

function AbuseTab() {
  const [flags, setFlags] = useState<AbuseFlag[]>([])
  const [statusFilter, setStatusFilter] = useState<'flagged' | 'banned' | 'cleared' | ''>('flagged')
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  const load = useCallback(async () => {
    const data = await getJson<{ ok: boolean; flags: AbuseFlag[] }>(
      `/abuse${statusFilter ? `?status=${statusFilter}` : ''}`,
    )
    setFlags(data?.flags ?? [])
    setLoading(false)
    setRefreshing(false)
  }, [statusFilter])

  useEffect(() => { setLoading(true); void load() }, [load])

  const banAccount = async (userId: string) => {
    setBusyId(userId)
    const msg = await postAction(userId, 'ban')
    setMessage(msg)
    setBusyId(null)
    void load()
  }

  const unbanAccount = async (userId: string) => {
    setBusyId(userId)
    const msg = await postAction(userId, 'unban')
    setMessage(msg)
    setBusyId(null)
    void load()
  }

  const clear = async (flagId: string) => {
    setBusyId(flagId)
    const msg = await clearFlag(flagId)
    setMessage(msg)
    setBusyId(null)
    void load()
  }

  if (loading) return <Spinner className="mt-8" />

  return (
    <ScrollView
      className="flex-1 bg-background"
      contentContainerStyle={{ padding: 16, gap: 12 }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); void load() }} />}
    >
      {message && (
        <View className="bg-muted rounded-md px-3 py-2">
          <Text className="text-sm text-foreground">{message}</Text>
        </View>
      )}

      <View className="flex-row gap-2 flex-wrap">
        {(['flagged', 'banned', 'cleared', ''] as const).map((s) => (
          <Pressable
            key={s || 'all'}
            onPress={() => { setStatusFilter(s); setLoading(true) }}
            className={`px-3 py-1.5 rounded-md border ${statusFilter === s ? 'bg-primary border-primary' : 'border-border'}`}
          >
            <Text className={`text-xs font-medium ${statusFilter === s ? 'text-primary-foreground' : 'text-foreground'}`}>
              {s || 'All'}
            </Text>
          </Pressable>
        ))}
      </View>

      {flags.map((flag) => (
        <View key={flag.id} className="bg-card rounded-lg border border-border p-3 gap-1.5">
          <View className="flex-row items-start justify-between gap-2">
            <View className="flex-1 gap-0.5">
              <Text className="text-sm font-medium text-foreground" numberOfLines={1}>
                {flag.email ?? flag.userId}
                {flag.bannedAt ? ' · BANNED' : ''}
              </Text>
              <Text className={`text-xs font-semibold ${STATUS_CLASS[flag.status] ?? 'text-foreground'}`}>
                {flag.status} · {flag.category} · sev {flag.severity} · {flag.confidence}
              </Text>
              <Text className="text-xs text-muted-foreground">
                {flag.runDate} {flag.clusterKey ? `· cluster: ${flag.clusterKey.slice(0, 16)}` : ''}
              </Text>
            </View>
          </View>
          <View className="flex-row flex-wrap gap-2 pt-0.5">
            {!flag.bannedAt ? (
              <Pressable
                disabled={busyId === flag.userId || busyId === flag.id}
                onPress={() => banAccount(flag.userId)}
                className="px-3 py-1.5 rounded-md border border-destructive"
              >
                <Text className="text-xs font-medium text-destructive">Ban</Text>
              </Pressable>
            ) : (
              <Pressable
                disabled={busyId === flag.userId || busyId === flag.id}
                onPress={() => unbanAccount(flag.userId)}
                className="px-3 py-1.5 rounded-md border border-border"
              >
                <Text className="text-xs font-medium text-foreground">Unban</Text>
              </Pressable>
            )}
            {flag.status !== 'cleared' && (
              <Pressable
                disabled={busyId === flag.id}
                onPress={() => clear(flag.id)}
                className="px-3 py-1.5 rounded-md border border-border"
              >
                <Text className="text-xs font-medium text-foreground">Clear</Text>
              </Pressable>
            )}
          </View>
        </View>
      ))}
      {flags.length === 0 && <Text className="text-sm text-muted-foreground text-center py-8">No flags</Text>}
    </ScrollView>
  )
}

// ─── Root screen ───────────────────────────────────────────────────────────

type Tab = 'risk' | 'abuse'

export default function SignupRiskScreen() {
  const [tab, setTab] = useState<Tab>('risk')

  return (
    <View className="flex-1 bg-background">
      <View className="flex-row items-center justify-between px-4 pt-4 pb-2">
        <View className="flex-row items-center gap-2">
          <ShieldAlert className="text-muted-foreground" size={18} />
          <Text className="text-lg font-semibold text-foreground">Admin · Security</Text>
        </View>
      </View>

      <View className="flex-row border-b border-border px-4">
        {(['risk', 'abuse'] as Tab[]).map((t) => (
          <Pressable
            key={t}
            onPress={() => setTab(t)}
            className={`px-4 py-2 mr-2 border-b-2 ${tab === t ? 'border-primary' : 'border-transparent'}`}
          >
            <Text className={`text-sm font-medium ${tab === t ? 'text-primary' : 'text-muted-foreground'}`}>
              {t === 'risk' ? 'Signup Risk' : 'Abuse'}
            </Text>
          </Pressable>
        ))}
      </View>

      {tab === 'risk' ? <SignupRiskTab /> : <AbuseTab />}
    </View>
  )
}
