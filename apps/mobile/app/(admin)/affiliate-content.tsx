// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Admin: Affiliate content-CPM settings (super-admin only).
 *
 * The whole content-CPM feature (Instagram / TikTok view tracking that pays
 * affiliates a CPM on new views) is optional and OFF by default. Everything is
 * controlled here via DB-backed PlatformSetting rows — there are no env vars to
 * set on a deployment. Per-creator CPM overrides live on each affiliate
 * (`contentCpmCents`), the content analogue of the per-affiliate commission %.
 *
 * Backed by GET/PUT /api/admin/affiliate-content/settings.
 */

import { useState, useEffect, useCallback } from 'react'
import {
  View,
  Text,
  TextInput,
  ScrollView,
  Pressable,
  ActivityIndicator,
  RefreshControl,
  Switch,
  useWindowDimensions,
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Clapperboard, Save, KeyRound, DollarSign, ShieldAlert, RefreshCw, RadioTower } from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import { API_URL } from '../../lib/api'

const API_BASE = `${API_URL}/api/admin`

type ProviderName = 'ensembledata' | 'official'

interface ContentSettings {
  enabled: boolean
  provider: ProviderName
  cpmCents: number
  cpmCentsByPlatform: { instagram: number | null; tiktok: number | null }
  holdDays: number
  postsPerAccount: number
  maxViewsPerPostPerRun: number
  perVideoCapCents: number | null
  minPollIntervalMinutes: number
}

interface TokenInfo {
  configured: boolean
  mask: string
  source: 'db' | 'env' | null
}

interface SettingsResponse {
  ok: boolean
  settings: ContentSettings
  ensembleDataToken: TokenInfo
}

async function fetchSettings(): Promise<SettingsResponse | null> {
  try {
    const res = await fetch(`${API_BASE}/affiliate-content/settings`, { credentials: 'include' })
    if (!res.ok) return null
    return (await res.json()) as SettingsResponse
  } catch {
    return null
  }
}

async function saveSettings(body: Record<string, unknown>): Promise<{ ok: boolean; data?: SettingsResponse; error?: string }> {
  try {
    const res = await fetch(`${API_BASE}/affiliate-content/settings`, {
      method: 'PUT',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const json = await res.json()
    if (!res.ok) return { ok: false, error: json?.error?.message || 'Save failed' }
    return { ok: true, data: json as SettingsResponse }
  } catch (e: any) {
    return { ok: false, error: e?.message || 'Save failed' }
  }
}

function dollarsPer1k(cents: number): string {
  return `$${(cents / 100).toFixed(2)} / 1k views`
}

/** Numeric field. Empty string is allowed and maps to `null` on save (clear). */
function NumField({
  label,
  hint,
  value,
  onChange,
  suffix,
}: {
  label: string
  hint?: string
  value: string
  onChange: (v: string) => void
  suffix?: string
}) {
  return (
    <View className="mb-3">
      <Text className="text-xs font-medium text-foreground mb-1">{label}</Text>
      <View className="flex-row items-center gap-2">
        <TextInput
          className="flex-1 bg-muted border border-border rounded-lg px-3 py-2 text-sm text-foreground"
          value={value}
          onChangeText={onChange}
          keyboardType="numeric"
          placeholderTextColor="#666"
        />
        {suffix && <Text className="text-xs text-muted-foreground">{suffix}</Text>}
      </View>
      {hint && <Text className="text-[10px] text-muted-foreground mt-0.5">{hint}</Text>}
    </View>
  )
}

export default function AffiliateContentSettingsPage() {
  const { width } = useWindowDimensions()
  const insets = useSafeAreaInsets()
  const isWide = width >= 900
  const pagePadding = isWide ? 32 : 16

  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<{ type: 'ok' | 'error'; text: string } | null>(null)
  const [tokenInfo, setTokenInfo] = useState<TokenInfo | null>(null)

  const [enabled, setEnabled] = useState(false)
  const [provider, setProvider] = useState<ProviderName>('ensembledata')
  const [form, setForm] = useState({
    cpmCents: '',
    cpmInstagram: '',
    cpmTiktok: '',
    holdDays: '',
    postsPerAccount: '',
    maxViewsPerPostPerRun: '',
    perVideoCapCents: '',
    minPollIntervalMinutes: '',
  })
  const [tokenInput, setTokenInput] = useState('')

  const applyResponse = useCallback((r: SettingsResponse) => {
    const s = r.settings
    setEnabled(s.enabled)
    setProvider(s.provider)
    setForm({
      cpmCents: String(s.cpmCents),
      cpmInstagram: s.cpmCentsByPlatform.instagram != null ? String(s.cpmCentsByPlatform.instagram) : '',
      cpmTiktok: s.cpmCentsByPlatform.tiktok != null ? String(s.cpmCentsByPlatform.tiktok) : '',
      holdDays: String(s.holdDays),
      postsPerAccount: String(s.postsPerAccount),
      maxViewsPerPostPerRun: String(s.maxViewsPerPostPerRun),
      perVideoCapCents: s.perVideoCapCents != null ? String(s.perVideoCapCents) : '',
      minPollIntervalMinutes: String(s.minPollIntervalMinutes),
    })
    setTokenInfo(r.ensembleDataToken)
  }, [])

  const load = useCallback(async () => {
    const r = await fetchSettings()
    if (r) {
      applyResponse(r)
      setLoadError(false)
    } else {
      setLoadError(true)
    }
    setLoading(false)
  }, [applyResponse])

  useEffect(() => {
    load()
  }, [load])

  const onRefresh = async () => {
    setRefreshing(true)
    await load()
    setRefreshing(false)
  }

  const intOrNull = (v: string): number | null => {
    const t = v.trim()
    if (t === '') return null
    const n = parseInt(t, 10)
    return Number.isFinite(n) && n >= 0 ? n : null
  }

  const onSave = async () => {
    setSaving(true)
    setMessage(null)
    const body: Record<string, unknown> = {
      enabled,
      provider,
      cpmCents: intOrNull(form.cpmCents),
      cpmCentsInstagram: intOrNull(form.cpmInstagram),
      cpmCentsTiktok: intOrNull(form.cpmTiktok),
      holdDays: intOrNull(form.holdDays),
      postsPerAccount: intOrNull(form.postsPerAccount),
      maxViewsPerPostPerRun: intOrNull(form.maxViewsPerPostPerRun),
      perVideoCapCents: intOrNull(form.perVideoCapCents),
      minPollIntervalMinutes: intOrNull(form.minPollIntervalMinutes),
    }
    // Only send a token write when the operator typed one (avoids clobbering
    // an existing token with a blank). Use the explicit Clear button to remove.
    if (tokenInput.trim() !== '') body.ensembleDataToken = tokenInput.trim()

    const result = await saveSettings(body)
    setSaving(false)
    if (result.ok && result.data) {
      applyResponse(result.data)
      setTokenInput('')
      setMessage({ type: 'ok', text: 'Settings saved' })
    } else {
      setMessage({ type: 'error', text: result.error || 'Save failed' })
    }
    setTimeout(() => setMessage(null), 4000)
  }

  const onClearToken = async () => {
    setSaving(true)
    setMessage(null)
    const result = await saveSettings({ ensembleDataToken: null })
    setSaving(false)
    if (result.ok && result.data) {
      applyResponse(result.data)
      setTokenInput('')
      setMessage({ type: 'ok', text: 'Token cleared' })
    } else {
      setMessage({ type: 'error', text: result.error || 'Clear failed' })
    }
    setTimeout(() => setMessage(null), 4000)
  }

  if (loading) {
    return (
      <View className="flex-1 items-center justify-center bg-background px-4">
        <View className="w-full max-w-md rounded-2xl border border-border bg-card p-5 items-center">
          <View className="h-10 w-10 rounded-xl bg-primary/10 items-center justify-center">
            <ActivityIndicator size="small" />
          </View>
          <Text className="text-sm font-semibold text-foreground mt-3">Loading content CPM controls</Text>
          <Text className="text-xs text-muted-foreground mt-1 text-center">
            Fetching provider, payout, and token settings.
          </Text>
        </View>
      </View>
    )
  }

  if (loadError) {
    return (
      <ScrollView
        className="flex-1 bg-background"
        contentContainerStyle={{
          paddingTop: Math.max(insets.top, 12) + 12,
          paddingHorizontal: pagePadding,
          paddingBottom: Math.max(insets.bottom, 16) + 32,
          width: '100%',
        }}
      >
        <View className="w-full max-w-2xl self-center">
          <SettingsHeader isWide={isWide} enabled={false} />
          <View className="rounded-2xl border border-amber-500/20 bg-amber-500/5 p-5 mt-5">
            <Text className="text-sm font-semibold text-foreground">Settings could not be loaded</Text>
            <Text className="text-xs text-muted-foreground mt-1">
              No values are shown or saved until the admin settings endpoint responds.
            </Text>
            <Pressable
              onPress={load}
              className="self-start mt-4 flex-row items-center gap-1.5 rounded-lg bg-muted px-3 py-2"
            >
              <RefreshCw size={13} className="text-foreground" />
              <Text className="text-xs font-medium text-foreground">Try again</Text>
            </Pressable>
          </View>
        </View>
      </ScrollView>
    )
  }

  const cpmGlobal = parseInt(form.cpmCents || '0', 10) || 0
  const capDefault = parseInt(form.perVideoCapCents || '0', 10) || 0

  return (
    <ScrollView
      className="flex-1 bg-background"
      contentContainerStyle={{
        paddingTop: Math.max(insets.top, 12) + 12,
        paddingHorizontal: pagePadding,
        paddingBottom: Math.max(insets.bottom, 16) + 32,
        width: '100%',
      }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
    >
      <View className="w-full max-w-2xl self-center">
        <SettingsHeader isWide={isWide} enabled={enabled} />
        <Text className="text-sm text-muted-foreground mt-3 mb-5 px-1">
          Track Instagram / TikTok views by affiliates and pay a CPM on new views. Per-creator CPM
          overrides continue to be managed on each affiliate.
        </Text>

        {/* Master toggle */}
        <View className="bg-card border border-border rounded-2xl p-4 mb-5">
          <View className="flex-row items-center justify-between">
            <View className="flex-1 pr-4">
              <Text className="text-sm font-semibold text-foreground">Content payouts</Text>
              <Text className="text-[11px] text-muted-foreground mt-0.5">
                When active, affiliates can connect handles, the hourly poll runs, and view deltas accrue
                CPM commissions. The native affiliate program must also be enabled on the server.
              </Text>
            </View>
            <Switch value={enabled} onValueChange={setEnabled} />
          </View>
        </View>

        {/* Provider */}
        <SectionLabel title="Data source" detail="Where view counts come from" />
        <View className="bg-card border border-border rounded-2xl p-4 mb-5">
          <View className="flex-row gap-2">
            {(['ensembledata', 'official'] as ProviderName[]).map((p) => (
              <Pressable
                key={p}
                onPress={() => setProvider(p)}
                className={cn(
                  'flex-1 px-3 py-2.5 rounded-xl border items-center',
                  provider === p ? 'bg-primary/10 border-primary' : 'border-border active:bg-muted/50',
                )}
              >
                <Text className={cn('text-sm font-medium', provider === p ? 'text-primary' : 'text-foreground')}>
                  {p === 'ensembledata' ? 'EnsembleData' : 'Official APIs'}
                </Text>
                <Text className="text-[10px] text-muted-foreground mt-0.5">
                  {p === 'ensembledata' ? 'Handle-based (unofficial)' : 'IG Graph + TikTok (OAuth)'}
                </Text>
              </Pressable>
            ))}
          </View>
          {provider === 'official' && (
            <Text className="text-[11px] text-amber-500 mt-2">
              The official OAuth provider is not yet implemented — polling will report
              “not configured” until it ships.
            </Text>
          )}
        </View>

        {/* EnsembleData token */}
        <SectionLabel title="Provider credential" detail="Encrypted at rest" />
        <View className="bg-card border border-border rounded-2xl p-4 mb-5">
        <View className="flex-row items-center gap-2 mb-2">
          <KeyRound size={14} className="text-primary" />
          <Text className="text-sm font-medium text-foreground">EnsembleData API Token</Text>
        </View>
        <View className="flex-row items-center gap-2 mb-2">
          {tokenInfo?.configured ? (
            <Text className="text-[11px] text-green-500">
              Configured ({tokenInfo.source === 'db' ? 'stored, encrypted' : `env: ${tokenInfo.mask}`})
            </Text>
          ) : (
            <View className="flex-row items-center gap-1">
              <ShieldAlert size={12} className="text-amber-500" />
              <Text className="text-[11px] text-amber-500">Not configured</Text>
            </View>
          )}
        </View>
        <TextInput
          className="bg-muted border border-border rounded-lg px-3 py-2 text-sm text-foreground"
          value={tokenInput}
          onChangeText={setTokenInput}
          placeholder={tokenInfo?.configured ? 'Enter a new token to rotate…' : 'Paste token to store (encrypted)'}
          placeholderTextColor="#666"
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
        />
        {tokenInfo?.configured && tokenInfo.source === 'db' && (
          <Pressable onPress={onClearToken} disabled={saving} className="mt-2 self-start">
            <Text className="text-xs text-red-400">Clear stored token</Text>
          </Pressable>
        )}
        </View>

        {/* CPM rates */}
        <SectionLabel title="Payout controls" detail="Rates, caps, and polling guardrails" />
        <View className="bg-card border border-border rounded-2xl p-4 mb-5">
        <View className="flex-row items-center gap-2 mb-3">
          <DollarSign size={14} className="text-primary" />
          <Text className="text-sm font-medium text-foreground">CPM Rates</Text>
          <Text className="text-[10px] text-muted-foreground ml-1">cents per 1,000 new views</Text>
        </View>
        <View className={cn('flex-row flex-wrap gap-x-6', isWide ? '' : '')}>
          <View className="flex-1 min-w-[200px]">
            <NumField
              label="Global CPM"
              value={form.cpmCents}
              onChange={(v) => setForm((f) => ({ ...f, cpmCents: v }))}
              suffix="¢"
              hint={cpmGlobal > 0 ? dollarsPer1k(cpmGlobal) : 'Default applied when blank'}
            />
            <NumField
              label="Instagram override"
              value={form.cpmInstagram}
              onChange={(v) => setForm((f) => ({ ...f, cpmInstagram: v }))}
              suffix="¢"
              hint="Blank = use global"
            />
            <NumField
              label="TikTok override"
              value={form.cpmTiktok}
              onChange={(v) => setForm((f) => ({ ...f, cpmTiktok: v }))}
              suffix="¢"
              hint="Blank = use global"
            />
          </View>
          <View className="flex-1 min-w-[200px]">
            <NumField
              label="Hold (days)"
              value={form.holdDays}
              onChange={(v) => setForm((f) => ({ ...f, holdDays: v }))}
              suffix="days"
              hint="Delay before content commissions become payable"
            />
            <NumField
              label="Posts per account / poll"
              value={form.postsPerAccount}
              onChange={(v) => setForm((f) => ({ ...f, postsPerAccount: v }))}
              hint="Bounds provider API spend per hourly sweep"
            />
            <NumField
              label="Min poll interval"
              value={form.minPollIntervalMinutes}
              onChange={(v) => setForm((f) => ({ ...f, minPollIntervalMinutes: v }))}
              suffix="min"
              hint="Min minutes between provider polls of the same account (default 240 = 4h). Throttles EnsembleData spend across regions/replicas."
            />
            <NumField
              label="Max views paid / post / run"
              value={form.maxViewsPerPostPerRun}
              onChange={(v) => setForm((f) => ({ ...f, maxViewsPerPostPerRun: v }))}
              hint="Anti-abuse cap; a viral spike pays out over several runs"
            />
            <NumField
              label="Default per-video cap"
              value={form.perVideoCapCents}
              onChange={(v) => setForm((f) => ({ ...f, perVideoCapCents: v }))}
              suffix="¢"
              hint={
                capDefault > 0
                  ? `$${(capDefault / 100).toLocaleString(undefined, { maximumFractionDigits: 2 })} max earnable per video (per-creator override wins)`
                  : 'Blank = no cap; per-creator override still applies'
              }
            />
          </View>
        </View>
        </View>

        <View className="flex-row items-center gap-3 px-1">
          <Pressable
            onPress={onSave}
            disabled={saving}
            className={cn('flex-row items-center gap-1.5 px-4 py-2.5 rounded-lg', saving ? 'bg-muted' : 'bg-primary')}
          >
            {saving ? <ActivityIndicator size="small" /> : <Save size={14} className="text-primary-foreground" />}
            <Text className={cn('text-sm font-medium', saving ? 'text-muted-foreground' : 'text-primary-foreground')}>
              Save settings
            </Text>
          </Pressable>
          {message && (
            <Text className={cn('text-xs', message.type === 'ok' ? 'text-green-400' : 'text-red-400')}>
              {message.text}
            </Text>
          )}
        </View>
      </View>
    </ScrollView>
  )
}

function SettingsHeader({ isWide, enabled }: { isWide: boolean; enabled: boolean }) {
  return (
    <View className="rounded-2xl border border-border bg-card p-4">
      <View className="flex-row items-center gap-3">
        <View className="h-9 w-9 rounded-xl bg-primary/10 items-center justify-center">
          <Clapperboard size={17} className="text-primary" />
        </View>
        <View className="flex-1">
          <Text className={cn('font-bold text-foreground', isWide ? 'text-2xl' : 'text-xl')}>
            Affiliate Content CPM
          </Text>
          <Text className="text-xs text-muted-foreground mt-0.5">Social-view attribution and payout policy</Text>
        </View>
        <View className={cn('flex-row items-center gap-1 rounded-full px-2.5 py-1.5', enabled ? 'bg-green-500/10' : 'bg-muted')}>
          <RadioTower size={11} className={enabled ? 'text-green-500' : 'text-muted-foreground'} />
          <Text className={cn('text-[11px] font-medium', enabled ? 'text-green-500' : 'text-muted-foreground')}>
            {enabled ? 'Active' : 'Off'}
          </Text>
        </View>
      </View>
    </View>
  )
}

function SectionLabel({ title, detail }: { title: string; detail: string }) {
  return (
    <View className="flex-row items-baseline justify-between mb-2 px-1">
      <Text className="text-sm font-semibold text-foreground">{title}</Text>
      <Text className="text-[11px] text-muted-foreground">{detail}</Text>
    </View>
  )
}
