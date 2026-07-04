// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Provider Setup Card — per-provider key entry + live model discovery.
 *
 * One row per provider (OpenAI / Anthropic): enter an API key and, once a key
 * is present, we hit that provider's live `/models` API and let the admin check
 * which models to enable. Enabled models are persisted as DB model definitions
 * and surface in the user-facing picker (key-gated). Works for both cloud admin
 * (keys stored encrypted in PlatformSetting) and local BYOK (keys mirrored to
 * the server env via /api/local/api-keys). `localMode` selects the key API.
 *
 * Shared by the admin settings screen and the onboarding AI-config step.
 */

import { useState, useEffect, useCallback } from 'react'
import { View, Text, ScrollView, Pressable, ActivityIndicator, TextInput } from 'react-native'
import {
  ListFilter,
  Check,
  Search,
  AlertTriangle,
  CheckCircle,
  RefreshCw,
} from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import { PlatformApi } from '@shogo-ai/sdk'
import { invalidateVisibleModelsCache } from '../../lib/visible-models'
import {
  getProvidersNeedingModelDiscovery,
  type ProviderKeyState,
  type SetupProviderId,
} from './providerModelDiscovery'

export const SETUP_PROVIDERS: Array<{
  id: SetupProviderId
  name: string
  placeholder: string
}> = [
  { id: 'openai', name: 'OpenAI', placeholder: 'sk-…' },
  { id: 'anthropic', name: 'Anthropic', placeholder: 'sk-ant-…' },
]

interface DiscoveredProviderModel {
  id: string
  displayName: string
  contextLength?: number
}

type SaveStatus = 'idle' | 'saving' | 'saved' | 'error'

/** Compact relative-time label for the pricing "last updated" line. */
function timeAgo(iso: string | null): string {
  if (!iso) return 'never'
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return 'never'
  const s = Math.max(0, Math.floor((Date.now() - t) / 1000))
  if (s < 60) return 'just now'
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

function StatusIndicator({ status }: { status: SaveStatus }) {
  if (status === 'idle') return null
  return (
    <View className="flex-row items-center gap-1.5">
      {status === 'saving' && <ActivityIndicator size="small" />}
      {status === 'saved' && <CheckCircle size={14} className="text-green-500" />}
      {status === 'error' && <AlertTriangle size={14} className="text-destructive" />}
      <Text
        className={cn(
          'text-xs',
          status === 'saving' && 'text-muted-foreground',
          status === 'saved' && 'text-green-500',
          status === 'error' && 'text-destructive',
        )}
      >
        {status === 'saving' ? 'Saving...' : status === 'saved' ? 'Saved' : 'Failed to save'}
      </Text>
    </View>
  )
}

export function ProviderSetupCard({
  platform,
  localMode,
  /** When false, render just the provider rows without the bordered card chrome
   *  (used inside onboarding, which already provides its own container). */
  embedded = false,
}: {
  platform: PlatformApi
  localMode: boolean
  embedded?: boolean
}) {
  const [isLoading, setIsLoading] = useState(true)
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle')
  const [keyState, setKeyState] = useState<Record<string, ProviderKeyState>>({})
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [enabledIds, setEnabledIds] = useState<Set<string>>(new Set())
  const [models, setModels] = useState<Record<string, DiscoveredProviderModel[]>>({})
  const [loadingModels, setLoadingModels] = useState<Record<string, boolean>>({})
  const [modelError, setModelError] = useState<Record<string, string | null>>({})
  const [search, setSearch] = useState<Record<string, string>>({})
  const [pricingRefreshedAt, setPricingRefreshedAt] = useState<string | null>(null)
  const [pricingRefreshing, setPricingRefreshing] = useState(false)

  const flash = useCallback((status: 'saved' | 'error') => {
    setSaveStatus(status)
    setTimeout(() => setSaveStatus('idle'), status === 'saved' ? 2000 : 3000)
  }, [])

  const loadKeys = useCallback(async () => {
    const next: Record<string, { configured: boolean; mask: string }> = {}
    if (localMode) {
      const masks = await platform.getProviderKeyMasks()
      for (const p of SETUP_PROVIDERS) {
        const m = masks[p.id]
        next[p.id] = { configured: !!m, mask: m || '' }
      }
    } else {
      const masks = await platform.getAdminProviderKeyMasks()
      for (const p of SETUP_PROVIDERS) {
        const info = masks[p.id]
        next[p.id] = { configured: !!info?.configured, mask: info?.mask || '' }
      }
    }
    setKeyState(next)
  }, [platform, localMode])

  const loadEnabled = useCallback(async () => {
    try {
      const defs = await platform.listModels()
      setEnabledIds(new Set(defs.filter((d) => d.enabled).map((d) => d.id)))
    } catch {
      /* keep current */
    }
  }, [platform])

  const loadProviderModels = useCallback(async (provider: SetupProviderId) => {
    setLoadingModels((p) => ({ ...p, [provider]: true }))
    setModelError((p) => ({ ...p, [provider]: null }))
    try {
      const res = await platform.getProviderModels(provider)
      if (res.ok) {
        setModels((p) => ({ ...p, [provider]: res.models }))
      } else {
        setModelError((p) => ({ ...p, [provider]: res.error || 'Failed to fetch models' }))
      }
    } catch (err: any) {
      setModelError((p) => ({ ...p, [provider]: err?.message || 'Failed to fetch models' }))
    } finally {
      setLoadingModels((p) => ({ ...p, [provider]: false }))
    }
  }, [platform])

  useEffect(() => {
    Promise.all([loadKeys(), loadEnabled()]).finally(() => setIsLoading(false))
  }, [loadKeys, loadEnabled])

  // Once a provider's key is known to be configured, fetch its live model list.
  useEffect(() => {
    for (const provider of getProvidersNeedingModelDiscovery({
      keyState,
      models,
      loadingModels,
      modelError,
    })) {
      loadProviderModels(provider)
    }
  }, [keyState, models, loadingModels, modelError, loadProviderModels])

  const saveKey = useCallback(async (provider: SetupProviderId) => {
    const key = drafts[provider]
    if (!key) return
    setSaveStatus('saving')
    try {
      if (localMode) await platform.putProviderKeys({ [provider]: key })
      else await platform.putAdminProviderKeys({ [provider]: key })
      setDrafts((prev) => {
        const next = { ...prev }
        delete next[provider]
        return next
      })
      await loadKeys()
      await loadProviderModels(provider)
      invalidateVisibleModelsCache()
      flash('saved')
    } catch {
      flash('error')
    }
  }, [drafts, localMode, platform, loadKeys, loadProviderModels, flash])

  const clearKey = useCallback(async (provider: SetupProviderId) => {
    setSaveStatus('saving')
    try {
      if (localMode) await platform.putProviderKeys({ [provider]: null })
      else await platform.putAdminProviderKeys({ [provider]: null })
      setModels((prev) => {
        const next = { ...prev }
        delete next[provider]
        return next
      })
      await loadKeys()
      invalidateVisibleModelsCache()
      flash('saved')
    } catch {
      flash('error')
    }
  }, [localMode, platform, loadKeys, flash])

  const toggleModel = useCallback(async (provider: SetupProviderId, m: DiscoveredProviderModel) => {
    const wasEnabled = enabledIds.has(m.id)
    const nextEnabled = !wasEnabled
    setEnabledIds((prev) => {
      const next = new Set(prev)
      if (nextEnabled) next.add(m.id)
      else next.delete(m.id)
      return next
    })
    setSaveStatus('saving')
    try {
      await platform.setProviderModelsEnabled(provider, [
        { id: m.id, displayName: m.displayName, contextWindow: m.contextLength, enabled: nextEnabled },
      ])
      invalidateVisibleModelsCache()
      flash('saved')
    } catch {
      setEnabledIds((prev) => {
        const next = new Set(prev)
        if (nextEnabled) next.delete(m.id)
        else next.add(m.id)
        return next
      })
      flash('error')
    }
  }, [enabledIds, platform, flash])

  // Pricing freshness: on the AI page (not onboarding), show when token prices
  // were last pulled from LiteLLM and auto-refresh once the daily TTL elapses.
  useEffect(() => {
    if (embedded) return
    let cancelled = false
    ;(async () => {
      try {
        const status = await platform.getPricingStatus()
        if (cancelled) return
        setPricingRefreshedAt(status.refreshedAt)
        if (status.stale) {
          setPricingRefreshing(true)
          const res = await platform.refreshModelPricing(false)
          if (cancelled) return
          if (res.refreshedAt) setPricingRefreshedAt(res.refreshedAt)
        }
      } catch {
        /* non-fatal */
      } finally {
        if (!cancelled) setPricingRefreshing(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [platform, embedded])

  const refreshPrices = useCallback(async () => {
    setPricingRefreshing(true)
    try {
      const res = await platform.refreshModelPricing(true)
      if (res.refreshedAt) setPricingRefreshedAt(res.refreshedAt)
    } catch {
      /* non-fatal */
    } finally {
      setPricingRefreshing(false)
    }
  }, [platform])

  const rows = (
    <View className={embedded ? 'gap-6' : 'px-5 py-4 gap-6'}>
      {SETUP_PROVIDERS.map((provider) => {
        const state = keyState[provider.id] ?? { configured: false, mask: '' }
        const draft = drafts[provider.id] ?? ''
        const providerModels = models[provider.id] ?? []
        const q = (search[provider.id] ?? '').trim().toLowerCase()
        const filtered = q
          ? providerModels.filter((m) => m.id.toLowerCase().includes(q) || m.displayName.toLowerCase().includes(q))
          : providerModels
        return (
          <View key={provider.id} className="gap-3">
            {/* Key row */}
            <View className="gap-1.5">
              <View className="flex-row items-center justify-between">
                <Text className="text-sm font-medium text-foreground">{provider.name}</Text>
                {state.configured ? (
                  <View className="flex-row items-center gap-1.5">
                    <View className="h-2 w-2 rounded-full bg-green-500" />
                    <Text className="text-xs text-muted-foreground">{state.mask}</Text>
                    <Pressable
                      onPress={() => clearKey(provider.id)}
                      className="ml-2 px-2 py-0.5 rounded bg-muted active:bg-muted/70"
                    >
                      <Text className="text-[11px] text-muted-foreground">Clear</Text>
                    </Pressable>
                  </View>
                ) : (
                  <View className="flex-row items-center gap-1.5">
                    <View className="h-2 w-2 rounded-full bg-muted-foreground/40" />
                    <Text className="text-xs text-muted-foreground">Not configured</Text>
                  </View>
                )}
              </View>
              <TextInput
                value={draft}
                onChangeText={(text) => setDrafts((prev) => ({ ...prev, [provider.id]: text }))}
                onBlur={() => { if (draft) saveKey(provider.id) }}
                onSubmitEditing={() => { if (draft) saveKey(provider.id) }}
                placeholder={state.configured ? 'Enter new key to replace' : `${provider.name} API key (${provider.placeholder})`}
                secureTextEntry
                className="bg-background border border-border rounded-lg px-3 py-2.5 text-sm text-foreground"
                placeholderTextColor="#666"
                autoCapitalize="none"
                autoCorrect={false}
              />
            </View>

            {/* Live model list */}
            {state.configured && (
              <View className="gap-2">
                {loadingModels[provider.id] && (
                  <View className="flex-row items-center gap-2 py-2">
                    <ActivityIndicator size="small" />
                    <Text className="text-xs text-muted-foreground">Loading {provider.name} models…</Text>
                  </View>
                )}
                {modelError[provider.id] && (
                  <View className="flex-row items-center gap-2 p-3 rounded-lg bg-amber-500/10">
                    <AlertTriangle size={14} className="text-amber-500" />
                    <Text className="text-xs text-foreground flex-1">{modelError[provider.id]}</Text>
                    <Pressable
                      onPress={() => loadProviderModels(provider.id)}
                      className="px-2 py-0.5 rounded bg-muted active:bg-muted/70"
                    >
                      <Text className="text-[11px] text-muted-foreground">Retry</Text>
                    </Pressable>
                  </View>
                )}
                {!loadingModels[provider.id] && !modelError[provider.id] && providerModels.length > 8 && (
                  <View className="flex-row items-center gap-2 bg-background border border-border rounded-lg px-3 py-2">
                    <Search size={12} className="text-muted-foreground" />
                    <TextInput
                      value={search[provider.id] ?? ''}
                      onChangeText={(text) => setSearch((prev) => ({ ...prev, [provider.id]: text }))}
                      placeholder={`Search ${provider.name} models…`}
                      placeholderTextColor="#666"
                      className="flex-1 text-sm text-foreground"
                      autoCapitalize="none"
                      autoCorrect={false}
                    />
                  </View>
                )}
                {!loadingModels[provider.id] && !modelError[provider.id] && (
                  <ScrollView style={{ maxHeight: 320 }} nestedScrollEnabled>
                    {filtered.map((m) => {
                      const checked = enabledIds.has(m.id)
                      return (
                        <Pressable
                          key={m.id}
                          onPress={() => toggleModel(provider.id, m)}
                          className={cn(
                            'px-3 py-2 rounded-lg border mb-1.5',
                            checked ? 'border-primary/50 bg-primary/5' : 'border-border bg-background',
                          )}
                        >
                          <View className="flex-row items-center gap-2">
                            <View
                              className={cn(
                                'w-4 h-4 rounded border items-center justify-center',
                                checked ? 'border-primary bg-primary' : 'border-border',
                              )}
                            >
                              {checked && <Check size={11} color="#fff" />}
                            </View>
                            <View className="flex-1">
                              <Text className="text-sm text-foreground">{m.displayName}</Text>
                              {m.displayName !== m.id && (
                                <Text className="text-[11px] text-muted-foreground" numberOfLines={1}>
                                  {m.id}
                                  {m.contextLength ? ` · ${(m.contextLength / 1000).toFixed(0)}k ctx` : ''}
                                </Text>
                              )}
                            </View>
                          </View>
                        </Pressable>
                      )
                    })}
                    {filtered.length === 0 && (
                      <Text className="text-xs text-muted-foreground italic py-2">
                        {q ? 'No models match your search.' : 'No models returned by the provider.'}
                      </Text>
                    )}
                  </ScrollView>
                )}
              </View>
            )}
          </View>
        )
      })}
    </View>
  )

  if (embedded) {
    if (isLoading) {
      return (
        <View className="py-6 items-center">
          <ActivityIndicator size="small" />
        </View>
      )
    }
    return rows
  }

  if (isLoading) {
    return (
      <View className="bg-card border border-border rounded-xl px-5 py-6 items-center">
        <ActivityIndicator size="small" />
      </View>
    )
  }

  return (
    <View className="bg-card border border-border rounded-xl">
      <View className="px-5 py-4 border-b border-border">
        <View className="flex-row items-center justify-between">
          <View className="flex-row items-center gap-2.5 mb-1 flex-1">
            <ListFilter size={16} className="text-foreground" />
            <Text className="text-base font-semibold text-foreground">Available Models</Text>
          </View>
          <StatusIndicator status={saveStatus} />
        </View>
        <Text className="text-xs text-muted-foreground">
          Add a provider API key, then choose which of its models show up in the user-facing picker.
        </Text>
        <View className="flex-row items-center justify-between mt-2">
          <Text className="text-[11px] text-muted-foreground flex-1">
            Token prices auto-update daily from LiteLLM · updated {timeAgo(pricingRefreshedAt)}
          </Text>
          <Pressable
            onPress={refreshPrices}
            disabled={pricingRefreshing}
            className="flex-row items-center gap-1 px-2 py-1 rounded bg-muted active:bg-muted/70"
          >
            {pricingRefreshing ? (
              <ActivityIndicator size="small" />
            ) : (
              <RefreshCw size={11} className="text-muted-foreground" />
            )}
            <Text className="text-[11px] text-muted-foreground">Refresh prices</Text>
          </Pressable>
        </View>
      </View>
      {rows}
    </View>
  )
}
