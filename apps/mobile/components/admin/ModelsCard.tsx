// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Models Card — the single admin surface for AI model management.
 *
 * Merges what used to be three things:
 *   1. Provider API keys (Anthropic / OpenAI / OpenRouter), and
 *   2. live provider discovery ("Available Models"), and
 *   3. the full DB model catalog CRUD ("Custom Models"),
 * into one card with a single "Add model" form.
 *
 * The form prefills from live discovery for known providers (pick a real model
 * id, display name, and context window with one tap) but every field stays
 * editable behind a "Customize details" disclosure. Saves go through the
 * model-definition CRUD (`createModel`/`updateModel`); the server auto-fills
 * per-token pricing + context window from the LiteLLM catalog when those are
 * left at 0/blank, so a model is never billed at $0.
 *
 * Custom Providers (third-party OpenAI-compatible endpoints) remain a separate
 * card; this form only references providers created there. `localMode` selects
 * the key API (local BYOK vs. cloud super-admin).
 */

import { useState, useEffect, useCallback, useMemo } from 'react'
import { View, Text, ScrollView, Pressable, ActivityIndicator, TextInput, Modal } from 'react-native'
import {
  Boxes,
  Plus,
  X,
  Pencil,
  Trash2,
  ChevronUp,
  ChevronDown,
  ChevronRight,
  Check,
  Search,
  RefreshCw,
  Sparkles,
  AlertTriangle,
} from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import {
  PlatformApi,
  type ModelProvider,
  type ModelDefinition,
  type ModelDefinitionInput,
  type DiscoveredProviderModel,
  type PublicModel,
} from '@shogo-ai/sdk'
import { invalidateVisibleModelsCache } from '../../lib/visible-models'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Providers whose keys gate routing + discovery, shown in the keys section. */
const KEY_PROVIDERS = [
  { id: 'anthropic', name: 'Anthropic', placeholder: 'sk-ant-…' },
  { id: 'openai', name: 'OpenAI', placeholder: 'sk-…' },
  { id: 'openrouter', name: 'OpenRouter', placeholder: 'sk-or-…' },
] as const

/** Providers we can prefill via live discovery. OpenRouter lists without a key. */
const DISCOVERY_PROVIDERS = ['anthropic', 'openai', 'openrouter'] as const
type DiscoveryProviderId = (typeof DISCOVERY_PROVIDERS)[number]
const KEY_GATED_DISCOVERY = new Set<DiscoveryProviderId>(['anthropic', 'openai'])

function isDiscoveryProvider(p: string): p is DiscoveryProviderId {
  return (DISCOVERY_PROVIDERS as readonly string[]).includes(p)
}

const PROVIDER_OPTIONS = ['anthropic', 'openai', 'openrouter', 'google', 'local', 'custom'] as const
const MODEL_TIER_OPTIONS = ['economy', 'standard', 'premium'] as const
const MODEL_FAMILY_OPTIONS = ['opus', 'sonnet', 'haiku', 'gpt', 'other'] as const
const MODEL_GENERATION_OPTIONS = ['current', 'legacy'] as const
const MODEL_REASONING_EFFORT_OPTIONS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const

type ReasoningEffortOption = (typeof MODEL_REASONING_EFFORT_OPTIONS)[number]
type FamilyOption = (typeof MODEL_FAMILY_OPTIONS)[number]

type DiscoveredModel = DiscoveredProviderModel

interface ModelFormState {
  provider: string
  providerId: string
  apiModel: string
  displayName: string
  shortDisplayName: string
  tier: 'economy' | 'standard' | 'premium'
  family: FamilyOption
  generation: 'current' | 'legacy'
  maxOutputTokens: string
  aliases: string
  description: string
  contextWindow: string
  reasoningEffort: ReasoningEffortOption
  inputPerMillion: string
  cachedInputPerMillion: string
  cacheWritePerMillion: string
  outputPerMillion: string
  enabled: boolean
}

const EMPTY_MODEL_FORM: ModelFormState = {
  provider: 'anthropic',
  providerId: '',
  apiModel: '',
  displayName: '',
  shortDisplayName: '',
  tier: 'standard',
  family: 'other',
  generation: 'current',
  maxOutputTokens: '64000',
  aliases: '',
  description: '',
  contextWindow: '',
  reasoningEffort: 'medium',
  inputPerMillion: '0',
  cachedInputPerMillion: '0',
  cacheWritePerMillion: '0',
  outputPerMillion: '0',
  enabled: true,
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

/** Best-effort family bucket from a model id, for labeling/billing parity. */
function inferFamily(id: string): FamilyOption {
  const lower = id.toLowerCase()
  if (lower.includes('opus')) return 'opus'
  if (lower.includes('sonnet')) return 'sonnet'
  if (lower.includes('haiku')) return 'haiku'
  if (lower.includes('gpt')) return 'gpt'
  return 'other'
}

function num(s: string): number {
  const n = Number(s)
  return Number.isFinite(n) && n >= 0 ? n : 0
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <Text className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-1">
      {children}
    </Text>
  )
}

function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
}: {
  options: readonly T[]
  value: T
  onChange: (v: T) => void
}) {
  return (
    <View className="flex-row flex-wrap gap-1.5">
      {options.map((opt) => (
        <Pressable
          key={opt}
          onPress={() => onChange(opt)}
          className={cn(
            'px-3 py-1.5 rounded-md border',
            value === opt ? 'border-primary bg-primary/10' : 'border-border bg-background',
          )}
        >
          <Text className={cn('text-xs', value === opt ? 'text-primary font-medium' : 'text-muted-foreground')}>
            {opt}
          </Text>
        </Pressable>
      ))}
    </View>
  )
}

// ---------------------------------------------------------------------------
// Public API models (cloud super-admin only)
// ---------------------------------------------------------------------------

interface PublicModelFormState {
  publicId: string
  displayName: string
  backingModelId: string
  enabled: boolean
}

const EMPTY_PUBLIC_FORM: PublicModelFormState = {
  publicId: '',
  displayName: '',
  backingModelId: '',
  enabled: true,
}

/**
 * Manage the public `/v1/*` API model aliases (e.g. `hoshi-1.0`). Each alias
 * maps an external, Shogo-branded `publicId` to an internal backing model id
 * (any DB-defined or static-catalog model). The whole map is replaced on each
 * write via `putPublicModels`, mirroring the server's PUT semantics.
 */
function PublicModelsSection({
  platform,
  models,
}: {
  platform: PlatformApi
  models: ModelDefinition[]
}) {
  const [list, setList] = useState<PublicModel[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [collapsed, setCollapsed] = useState(true)

  const [showForm, setShowForm] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState<PublicModelFormState>(EMPTY_PUBLIC_FORM)
  const [backingSearch, setBackingSearch] = useState('')

  const reload = useCallback(async () => {
    try {
      setList(await platform.getPublicModels())
      setError(null)
    } catch (err: any) {
      setError(err?.message || 'Failed to load public models')
    }
  }, [platform])

  useEffect(() => {
    reload().finally(() => setLoading(false))
  }, [reload])

  const persist = useCallback(
    async (next: PublicModel[]) => {
      setBusy(true)
      setError(null)
      try {
        const saved = await platform.putPublicModels(
          next.map((m) => ({
            publicId: m.publicId,
            displayName: m.displayName,
            backingModelId: m.backingModelId,
            enabled: m.enabled,
          })),
        )
        setList(saved)
        return true
      } catch (err: any) {
        setError(err?.message || 'Failed to save public models')
        await reload()
        return false
      } finally {
        setBusy(false)
      }
    },
    [platform, reload],
  )

  const openCreate = useCallback(() => {
    setEditingId(null)
    setForm(EMPTY_PUBLIC_FORM)
    setBackingSearch('')
    setShowForm(true)
  }, [])

  const openEdit = useCallback((m: PublicModel) => {
    setEditingId(m.publicId)
    setForm({
      publicId: m.publicId,
      displayName: m.displayName,
      backingModelId: m.backingModelId,
      enabled: m.enabled,
    })
    setBackingSearch('')
    setShowForm(true)
  }, [])

  const closeForm = useCallback(() => {
    setShowForm(false)
    setEditingId(null)
    setForm(EMPTY_PUBLIC_FORM)
    setBackingSearch('')
  }, [])

  const submit = useCallback(async () => {
    const publicId = form.publicId.trim()
    const backingModelId = form.backingModelId.trim()
    if (!publicId || !backingModelId) return
    const entry: PublicModel = {
      publicId,
      displayName: form.displayName.trim() || publicId,
      backingModelId,
      enabled: form.enabled,
    }
    // Replace an existing entry (by original publicId) or append a new one.
    const next = editingId
      ? list.map((m) => (m.publicId === editingId ? entry : m))
      : [...list.filter((m) => m.publicId !== publicId), entry]
    if (await persist(next)) closeForm()
  }, [form, editingId, list, persist, closeForm])

  const toggleEnabled = useCallback(
    (m: PublicModel) => {
      persist(list.map((x) => (x.publicId === m.publicId ? { ...x, enabled: !x.enabled } : x)))
    },
    [list, persist],
  )

  const remove = useCallback(
    (publicId: string) => {
      persist(list.filter((m) => m.publicId !== publicId))
    },
    [list, persist],
  )

  const backingOptions = useMemo(() => {
    const q = backingSearch.trim().toLowerCase()
    const enabled = models.filter((m) => m.enabled)
    return q
      ? enabled.filter(
          (m) => m.id.toLowerCase().includes(q) || m.displayName.toLowerCase().includes(q),
        )
      : enabled
  }, [models, backingSearch])

  const canSubmit = !!form.publicId.trim() && !!form.backingModelId.trim()

  return (
    <View className="px-5 py-4 border-b border-border gap-3">
      <Pressable
        onPress={() => setCollapsed((v) => !v)}
        className="flex-row items-center justify-between"
      >
        <View className="flex-row items-center gap-1.5 flex-1">
          {collapsed ? (
            <ChevronRight size={14} className="text-muted-foreground" />
          ) : (
            <ChevronDown size={14} className="text-muted-foreground" />
          )}
          <FieldLabel>Public API models</FieldLabel>
          {list.length > 0 && (
            <Text className="text-[11px] text-muted-foreground">({list.length})</Text>
          )}
        </View>
        {!collapsed && !showForm && (
          <Pressable
            onPress={openCreate}
            className="flex-row items-center gap-1 px-2.5 py-1.5 rounded-md border border-border bg-background"
          >
            <Plus size={14} className="text-foreground" />
            <Text className="text-xs text-foreground">Add</Text>
          </Pressable>
        )}
      </Pressable>

      {!collapsed && (
        <>
          <Text className="text-[11px] text-muted-foreground">
            Shogo-branded model ids served on the OpenAI-compatible /v1 API (e.g.
            hoshi-1.0). Each maps to an internal backing model; the provider stays
            hidden from callers.
          </Text>

          {loading ? (
            <ActivityIndicator size="small" />
          ) : (
            <>
              {error && <Text className="text-xs text-red-500">{error}</Text>}

              {list.length === 0 && !showForm && (
                <Text className="text-xs text-muted-foreground">
                  No public models yet. Add one to expose it on the public API.
                </Text>
              )}

              {list.map((m) => (
                <View
                  key={m.publicId}
                  className="px-3 py-2.5 rounded-lg border border-border bg-background"
                >
                  <View className="flex-row items-center justify-between">
                    <View className="flex-1">
                      <Text className="text-sm font-medium text-foreground">{m.displayName}</Text>
                      <Text className="text-xs text-muted-foreground mt-0.5">
                        {m.publicId} → {m.backingDisplayName || m.backingModelId}
                      </Text>
                      {m.backingValid === false && (
                        <View className="flex-row items-center gap-1 mt-0.5">
                          <AlertTriangle size={11} className="text-amber-500" />
                          <Text className="text-[11px] text-amber-500">
                            Backing model does not resolve
                          </Text>
                        </View>
                      )}
                    </View>
                    <View className="flex-row items-center gap-1.5">
                      <Pressable
                        onPress={() => toggleEnabled(m)}
                        disabled={busy}
                        className={cn(
                          'px-2 py-1 rounded-md border',
                          m.enabled ? 'border-primary/50 bg-primary/10' : 'border-border bg-background',
                        )}
                      >
                        <Text
                          className={cn('text-[11px]', m.enabled ? 'text-primary' : 'text-muted-foreground')}
                        >
                          {m.enabled ? 'Enabled' : 'Disabled'}
                        </Text>
                      </Pressable>
                      <Pressable
                        onPress={() => openEdit(m)}
                        disabled={busy}
                        className="p-1.5 rounded-md border border-border"
                      >
                        <Pencil size={13} className="text-muted-foreground" />
                      </Pressable>
                      <Pressable
                        onPress={() => remove(m.publicId)}
                        disabled={busy}
                        className="p-1.5 rounded-md border border-border"
                      >
                        <Trash2 size={13} className="text-red-500" />
                      </Pressable>
                    </View>
                  </View>
                </View>
              ))}
            </>
          )}
        </>
      )}

      <Modal visible={showForm} transparent animationType="fade" onRequestClose={closeForm}>
        <View className="flex-1 bg-black/50 items-center justify-center p-4">
          <Pressable
            accessibilityLabel="Dismiss"
            onPress={closeForm}
            style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}
          />
          <View className="bg-card border border-border rounded-xl w-full max-w-xl max-h-[88%] overflow-hidden">
            <View className="px-5 py-4 border-b border-border flex-row items-center justify-between">
              <Text className="text-base font-semibold text-foreground">
                {editingId ? 'Edit public model' : 'Add public model'}
              </Text>
              <Pressable onPress={closeForm} className="p-1">
                <X size={16} className="text-muted-foreground" />
              </Pressable>
            </View>

            <ScrollView
              className="px-5 py-4"
              contentContainerClassName="gap-3"
              nestedScrollEnabled
              keyboardShouldPersistTaps="handled"
            >
              <View>
                <FieldLabel>Public id</FieldLabel>
                <TextInput
                  value={form.publicId}
                  onChangeText={(t) => setForm((f) => ({ ...f, publicId: t }))}
                  editable={!editingId}
                  placeholder="hoshi-1.0"
                  placeholderTextColor="#9ca3af"
                  autoCapitalize="none"
                  autoCorrect={false}
                  className={cn(
                    'px-3 py-2 rounded-md border border-border bg-background text-foreground text-sm',
                    !!editingId && 'opacity-50',
                  )}
                />
              </View>

              <View>
                <FieldLabel>Display name</FieldLabel>
                <TextInput
                  value={form.displayName}
                  onChangeText={(t) => setForm((f) => ({ ...f, displayName: t }))}
                  placeholder="Hoshi 1.0"
                  placeholderTextColor="#9ca3af"
                  className="px-3 py-2 rounded-md border border-border bg-background text-foreground text-sm"
                />
              </View>

              <View>
                <FieldLabel>Backing model id</FieldLabel>
                <TextInput
                  value={form.backingModelId}
                  onChangeText={(t) => setForm((f) => ({ ...f, backingModelId: t }))}
                  placeholder="claude-opus-4-7"
                  placeholderTextColor="#9ca3af"
                  autoCapitalize="none"
                  autoCorrect={false}
                  className="px-3 py-2 rounded-md border border-border bg-background text-foreground text-sm"
                />
                {models.length > 0 && (
                  <View className="mt-2 gap-1.5">
                    <View className="flex-row items-center gap-2 bg-background border border-border rounded-lg px-3 py-2">
                      <Search size={12} className="text-muted-foreground" />
                      <TextInput
                        value={backingSearch}
                        onChangeText={setBackingSearch}
                        placeholder="Search configured models…"
                        placeholderTextColor="#666"
                        className="flex-1 text-sm text-foreground"
                        autoCapitalize="none"
                        autoCorrect={false}
                      />
                    </View>
                    <ScrollView style={{ maxHeight: 200 }} nestedScrollEnabled>
                      {backingOptions.map((m) => {
                        const selected = form.backingModelId === m.id
                        return (
                          <Pressable
                            key={m.id}
                            onPress={() => setForm((f) => ({ ...f, backingModelId: m.id }))}
                            className={cn(
                              'px-3 py-2 rounded-lg border mb-1.5',
                              selected ? 'border-primary/50 bg-primary/5' : 'border-border bg-background',
                            )}
                          >
                            <View className="flex-row items-center gap-2">
                              <View
                                className={cn(
                                  'w-4 h-4 rounded-full border items-center justify-center',
                                  selected ? 'border-primary bg-primary' : 'border-border',
                                )}
                              >
                                {selected && <Check size={11} color="#fff" />}
                              </View>
                              <View className="flex-1">
                                <Text className="text-sm text-foreground">{m.displayName}</Text>
                                <Text className="text-[11px] text-muted-foreground" numberOfLines={1}>
                                  {m.id}
                                </Text>
                              </View>
                            </View>
                          </Pressable>
                        )
                      })}
                      {backingOptions.length === 0 && (
                        <Text className="text-xs text-muted-foreground italic py-2">
                          No configured models match. You can also type any catalog model id above.
                        </Text>
                      )}
                    </ScrollView>
                  </View>
                )}
              </View>

              <Pressable
                onPress={() => setForm((f) => ({ ...f, enabled: !f.enabled }))}
                className="flex-row items-center justify-between p-2.5 rounded-md border border-border bg-background"
              >
                <Text className="text-sm text-foreground">Enabled</Text>
                {form.enabled && <Check size={16} className="text-primary" />}
              </Pressable>
            </ScrollView>

            <View className="px-5 py-3 border-t border-border">
              <Pressable
                onPress={submit}
                disabled={!canSubmit || busy}
                className={cn('items-center py-2.5 rounded-md', canSubmit && !busy ? 'bg-primary' : 'bg-muted')}
              >
                {busy ? (
                  <ActivityIndicator size="small" />
                ) : (
                  <Text
                    className={cn(
                      'text-sm font-medium',
                      canSubmit ? 'text-primary-foreground' : 'text-muted-foreground',
                    )}
                  >
                    {editingId ? 'Save changes' : 'Add public model'}
                  </Text>
                )}
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  )
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ModelsCard({ platform, localMode }: { platform: PlatformApi; localMode: boolean }) {
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const [models, setModels] = useState<ModelDefinition[]>([])
  const [providers, setProviders] = useState<ModelProvider[]>([])

  const [keyState, setKeyState] = useState<Record<string, { configured: boolean; mask: string }>>({})
  const [keyDrafts, setKeyDrafts] = useState<Record<string, string>>({})

  const [pricingRefreshedAt, setPricingRefreshedAt] = useState<string | null>(null)
  const [pricingRefreshing, setPricingRefreshing] = useState(false)

  // Add/edit form
  const [showForm, setShowForm] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState<ModelFormState>(EMPTY_MODEL_FORM)
  const [advancedOpen, setAdvancedOpen] = useState(false)

  // Discovery (per provider) — populated lazily when a discovery provider is
  // selected in the form.
  const [discovered, setDiscovered] = useState<Record<string, DiscoveredModel[]>>({})
  const [discoveryLoading, setDiscoveryLoading] = useState<Record<string, boolean>>({})
  const [discoveryError, setDiscoveryError] = useState<Record<string, string | null>>({})
  const [discoverySearch, setDiscoverySearch] = useState('')

  // -------------------------------------------------------------------------
  // Loading
  // -------------------------------------------------------------------------

  const loadKeys = useCallback(async () => {
    const next: Record<string, { configured: boolean; mask: string }> = {}
    if (localMode) {
      const masks = await platform.getProviderKeyMasks()
      for (const p of KEY_PROVIDERS) next[p.id] = { configured: !!masks[p.id], mask: masks[p.id] || '' }
    } else {
      const masks = await platform.getAdminProviderKeyMasks()
      for (const p of KEY_PROVIDERS) {
        const info = masks[p.id]
        next[p.id] = { configured: !!info?.configured, mask: info?.mask || '' }
      }
    }
    setKeyState(next)
  }, [platform, localMode])

  const reload = useCallback(async () => {
    try {
      const [list, provs] = await Promise.all([platform.listModels(), platform.listModelProviders()])
      setModels(list)
      setProviders(provs)
      setError(null)
    } catch (err: any) {
      setError(err?.message || 'Failed to load models')
    }
  }, [platform])

  useEffect(() => {
    Promise.all([loadKeys(), reload()]).finally(() => setIsLoading(false))
  }, [loadKeys, reload])

  // Pricing freshness: surface last LiteLLM refresh + auto-refresh once stale.
  useEffect(() => {
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
  }, [platform])

  const refreshPrices = useCallback(async () => {
    setPricingRefreshing(true)
    try {
      const res = await platform.refreshModelPricing(true)
      if (res.refreshedAt) setPricingRefreshedAt(res.refreshedAt)
      await reload()
    } catch {
      /* non-fatal */
    } finally {
      setPricingRefreshing(false)
    }
  }, [platform, reload])

  // -------------------------------------------------------------------------
  // Provider keys
  // -------------------------------------------------------------------------

  const saveKey = useCallback(
    async (provider: string) => {
      const key = keyDrafts[provider]
      if (!key) return
      setBusy(true)
      try {
        if (localMode) await platform.putProviderKeys({ [provider]: key })
        else await platform.putAdminProviderKeys({ [provider]: key })
        setKeyDrafts((prev) => {
          const next = { ...prev }
          delete next[provider]
          return next
        })
        await loadKeys()
        invalidateVisibleModelsCache()
      } catch (err: any) {
        setError(err?.message || 'Failed to save key')
      } finally {
        setBusy(false)
      }
    },
    [keyDrafts, localMode, platform, loadKeys],
  )

  const clearKey = useCallback(
    async (provider: string) => {
      setBusy(true)
      try {
        if (localMode) await platform.putProviderKeys({ [provider]: null })
        else await platform.putAdminProviderKeys({ [provider]: null })
        await loadKeys()
        invalidateVisibleModelsCache()
      } catch (err: any) {
        setError(err?.message || 'Failed to clear key')
      } finally {
        setBusy(false)
      }
    },
    [localMode, platform, loadKeys],
  )

  // -------------------------------------------------------------------------
  // Discovery
  // -------------------------------------------------------------------------

  const loadDiscovery = useCallback(
    async (provider: DiscoveryProviderId) => {
      setDiscoveryLoading((p) => ({ ...p, [provider]: true }))
      setDiscoveryError((p) => ({ ...p, [provider]: null }))
      try {
        const res = await platform.getProviderModels(provider)
        if (res.ok) setDiscovered((p) => ({ ...p, [provider]: res.models }))
        else setDiscoveryError((p) => ({ ...p, [provider]: res.error || 'Failed to fetch models' }))
      } catch (err: any) {
        setDiscoveryError((p) => ({ ...p, [provider]: err?.message || 'Failed to fetch models' }))
      } finally {
        setDiscoveryLoading((p) => ({ ...p, [provider]: false }))
      }
    },
    [platform],
  )

  // Fetch a discovery provider's catalog when it becomes the selected provider
  // in the form (and is reachable: openrouter always, others need a key).
  useEffect(() => {
    if (!showForm || editingId) return
    const p = form.provider
    if (!isDiscoveryProvider(p)) return
    if (KEY_GATED_DISCOVERY.has(p) && !keyState[p]?.configured) return
    if (discovered[p] || discoveryLoading[p] || discoveryError[p]) return
    loadDiscovery(p)
  }, [showForm, editingId, form.provider, keyState, discovered, discoveryLoading, discoveryError, loadDiscovery])

  const applyDiscovered = useCallback((m: DiscoveredModel) => {
    setForm((f) => ({
      ...f,
      apiModel: m.id,
      displayName: m.displayName,
      shortDisplayName: m.displayName,
      family: inferFamily(m.id),
      contextWindow: m.contextLength ? String(m.contextLength) : f.contextWindow,
      // Prefill the LiteLLM-resolved pricing the server returns with discovery
      // so "Customize details" reflects the rate that will be saved.
      inputPerMillion: m.inputPerMillion != null ? String(m.inputPerMillion) : f.inputPerMillion,
      cachedInputPerMillion: m.cachedInputPerMillion != null ? String(m.cachedInputPerMillion) : f.cachedInputPerMillion,
      cacheWritePerMillion: m.cacheWritePerMillion != null ? String(m.cacheWritePerMillion) : f.cacheWritePerMillion,
      outputPerMillion: m.outputPerMillion != null ? String(m.outputPerMillion) : f.outputPerMillion,
    }))
  }, [])

  // -------------------------------------------------------------------------
  // Form open/submit
  // -------------------------------------------------------------------------

  const openCreate = useCallback(() => {
    setEditingId(null)
    setForm(EMPTY_MODEL_FORM)
    setAdvancedOpen(false)
    setDiscoverySearch('')
    setShowForm(true)
  }, [])

  const openEdit = useCallback((m: ModelDefinition) => {
    setEditingId(m.id)
    setForm({
      provider: m.provider,
      providerId: m.providerId ?? '',
      apiModel: m.apiModel,
      displayName: m.displayName,
      shortDisplayName: m.shortDisplayName,
      tier: m.tier,
      family: m.family,
      generation: m.generation,
      maxOutputTokens: String(m.maxOutputTokens),
      aliases: (m.aliases ?? []).join(', '),
      description: m.description ?? '',
      contextWindow: m.contextWindow != null ? String(m.contextWindow) : '',
      reasoningEffort: (m.reasoningEffort ?? 'medium') as ReasoningEffortOption,
      inputPerMillion: String(m.inputPerMillion),
      cachedInputPerMillion: String(m.cachedInputPerMillion),
      cacheWritePerMillion: String(m.cacheWritePerMillion),
      outputPerMillion: String(m.outputPerMillion),
      enabled: m.enabled,
    })
    setAdvancedOpen(true)
    setShowForm(true)
  }, [])

  const closeForm = useCallback(() => {
    setShowForm(false)
    setEditingId(null)
    setForm(EMPTY_MODEL_FORM)
    setDiscoverySearch('')
  }, [])

  const submit = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      const payload: ModelDefinitionInput = {
        provider: form.provider,
        providerId: form.provider === 'custom' ? form.providerId || null : null,
        apiModel: form.apiModel.trim(),
        displayName: form.displayName.trim(),
        shortDisplayName: form.shortDisplayName.trim() || form.displayName.trim(),
        tier: form.tier,
        family: form.family,
        generation: form.generation,
        maxOutputTokens: num(form.maxOutputTokens) || 64000,
        aliases: form.aliases.split(',').map((a) => a.trim()).filter(Boolean),
        description: form.description.trim() || null,
        contextWindow: form.contextWindow.trim() ? num(form.contextWindow) || null : null,
        reasoningEffort: form.reasoningEffort,
        inputPerMillion: num(form.inputPerMillion),
        cachedInputPerMillion: num(form.cachedInputPerMillion),
        cacheWritePerMillion: num(form.cacheWritePerMillion),
        outputPerMillion: num(form.outputPerMillion),
        enabled: form.enabled,
      }
      if (editingId) await platform.updateModel(editingId, payload)
      else await platform.createModel(payload)
      invalidateVisibleModelsCache()
      closeForm()
      await reload()
    } catch (err: any) {
      setError(err?.message || 'Failed to save model')
    } finally {
      setBusy(false)
    }
  }, [form, editingId, platform, reload, closeForm])

  const remove = useCallback(
    async (id: string) => {
      setBusy(true)
      setError(null)
      try {
        await platform.deleteModel(id)
        invalidateVisibleModelsCache()
        await reload()
      } catch (err: any) {
        setError(err?.message || 'Failed to delete model')
      } finally {
        setBusy(false)
      }
    },
    [platform, reload],
  )

  const toggleEnabled = useCallback(
    async (m: ModelDefinition) => {
      setModels((prev) => prev.map((x) => (x.id === m.id ? { ...x, enabled: !x.enabled } : x)))
      setBusy(true)
      try {
        await platform.updateModel(m.id, { enabled: !m.enabled })
        invalidateVisibleModelsCache()
      } catch (err: any) {
        setModels((prev) => prev.map((x) => (x.id === m.id ? { ...x, enabled: m.enabled } : x)))
        setError(err?.message || 'Failed to update model')
      } finally {
        setBusy(false)
      }
    },
    [platform],
  )

  // Reorder a model up/down — normalize sortOrder to array position so it stays
  // dense and stable, persisting only rows whose sortOrder actually changed.
  const move = useCallback(
    async (index: number, dir: -1 | 1) => {
      const target = index + dir
      if (target < 0 || target >= models.length) return
      const reordered = [...models]
      const [m] = reordered.splice(index, 1)
      reordered.splice(target, 0, m)
      setModels(reordered)
      setBusy(true)
      setError(null)
      try {
        await Promise.all(
          reordered
            .map((mm, i) => ((mm.sortOrder ?? -1) === i ? null : platform.updateModel(mm.id, { sortOrder: i })))
            .filter((p): p is ReturnType<typeof platform.updateModel> => p !== null),
        )
        invalidateVisibleModelsCache()
        await reload()
      } catch (err: any) {
        setError(err?.message || 'Failed to reorder models')
        await reload()
      } finally {
        setBusy(false)
      }
    },
    [models, platform, reload],
  )

  // -------------------------------------------------------------------------
  // Derived
  // -------------------------------------------------------------------------

  const providerLabel = useCallback(
    (m: ModelDefinition) =>
      m.provider === 'custom' && m.providerId
        ? `custom→${providers.find((p) => p.id === m.providerId)?.label ?? m.providerId}`
        : m.provider,
    [providers],
  )

  const canSubmit =
    form.apiModel.trim() &&
    form.displayName.trim() &&
    (form.provider !== 'custom' || form.providerId)

  const discoveryList = useMemo(() => {
    if (!isDiscoveryProvider(form.provider)) return null
    const list = discovered[form.provider] ?? []
    const q = discoverySearch.trim().toLowerCase()
    return q
      ? list.filter((m) => m.id.toLowerCase().includes(q) || m.displayName.toLowerCase().includes(q))
      : list
  }, [form.provider, discovered, discoverySearch])

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  if (isLoading) {
    return (
      <View className="bg-card border border-border rounded-xl px-5 py-6 items-center">
        <ActivityIndicator size="small" />
      </View>
    )
  }

  return (
    <View className="bg-card border border-border rounded-xl">
      {/* Header */}
      <View className="px-5 py-4 border-b border-border">
        <View className="flex-row items-center justify-between">
          <View className="flex-row items-center gap-2.5 flex-1">
            <Boxes size={16} className="text-foreground" />
            <Text className="text-base font-semibold text-foreground">Models</Text>
          </View>
          {!showForm && (
            <Pressable
              onPress={openCreate}
              className="flex-row items-center gap-1 px-2.5 py-1.5 rounded-md border border-border bg-background"
            >
              <Plus size={14} className="text-foreground" />
              <Text className="text-xs text-foreground">Add model</Text>
            </Pressable>
          )}
        </View>
        <Text className="text-xs text-muted-foreground mt-1">
          Add provider keys, then add models — pick a live model for a known provider or customize every field.
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

      {/* Provider API keys */}
      <View className="px-5 py-4 border-b border-border gap-3">
        <FieldLabel>Provider API keys</FieldLabel>
        {KEY_PROVIDERS.map((provider) => {
          const state = keyState[provider.id] ?? { configured: false, mask: '' }
          const draft = keyDrafts[provider.id] ?? ''
          return (
            <View key={provider.id} className="gap-1.5">
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
                onChangeText={(text) => setKeyDrafts((prev) => ({ ...prev, [provider.id]: text }))}
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
          )
        })}
      </View>

      {/* Public API models (cloud super-admin only) */}
      {!localMode && <PublicModelsSection platform={platform} models={models} />}

      {/* Models list + form */}
      <View className="px-5 py-4 gap-3">
        {error && <Text className="text-xs text-red-500">{error}</Text>}

        {models.length === 0 && !showForm && (
          <Text className="text-xs text-muted-foreground">No models configured yet. Add one to get started.</Text>
        )}

        {models.map((m, idx) => (
          <View key={m.id} className="px-3 py-2.5 rounded-lg border border-border bg-background">
            <View className="flex-row items-center justify-between">
              <View className="mr-2">
                <Pressable
                  onPress={() => move(idx, -1)}
                  disabled={busy || idx === 0}
                  className={cn('p-0.5 rounded', (busy || idx === 0) && 'opacity-30')}
                >
                  <ChevronUp size={14} className="text-muted-foreground" />
                </Pressable>
                <Pressable
                  onPress={() => move(idx, 1)}
                  disabled={busy || idx === models.length - 1}
                  className={cn('p-0.5 rounded', (busy || idx === models.length - 1) && 'opacity-30')}
                >
                  <ChevronDown size={14} className="text-muted-foreground" />
                </Pressable>
              </View>
              <View className="flex-1">
                <Text className="text-sm font-medium text-foreground">{m.displayName}</Text>
                <Text className="text-xs text-muted-foreground mt-0.5">
                  {m.apiModel} · {providerLabel(m)} · {m.tier}
                </Text>
                <Text className="text-[11px] text-muted-foreground mt-0.5">
                  in ${m.inputPerMillion}/M · out ${m.outputPerMillion}/M · {m.maxOutputTokens} max
                  {m.reasoningEffort ? ` · ${m.reasoningEffort} effort` : ''}
                </Text>
              </View>
              <View className="flex-row items-center gap-1.5">
                {/* Enable toggle */}
                <Pressable
                  onPress={() => toggleEnabled(m)}
                  disabled={busy}
                  className={cn(
                    'px-2 py-1 rounded-md border',
                    m.enabled ? 'border-primary/50 bg-primary/10' : 'border-border bg-background',
                  )}
                >
                  <Text className={cn('text-[11px]', m.enabled ? 'text-primary' : 'text-muted-foreground')}>
                    {m.enabled ? 'Enabled' : 'Disabled'}
                  </Text>
                </Pressable>
                <Pressable onPress={() => openEdit(m)} disabled={busy} className="p-1.5 rounded-md border border-border">
                  <Pencil size={13} className="text-muted-foreground" />
                </Pressable>
                <Pressable onPress={() => remove(m.id)} disabled={busy} className="p-1.5 rounded-md border border-border">
                  <Trash2 size={13} className="text-red-500" />
                </Pressable>
              </View>
            </View>
          </View>
        ))}

        <Modal visible={showForm} transparent animationType="fade" onRequestClose={closeForm}>
          <View className="flex-1 bg-black/50 items-center justify-center p-4">
            <Pressable
              accessibilityLabel="Dismiss"
              onPress={closeForm}
              style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}
            />
            <View className="bg-card border border-border rounded-xl w-full max-w-xl max-h-[88%] overflow-hidden">
              {/* Header */}
              <View className="px-5 py-4 border-b border-border flex-row items-center justify-between">
                <Text className="text-base font-semibold text-foreground">{editingId ? 'Edit model' : 'Add model'}</Text>
                <Pressable onPress={closeForm} className="p-1">
                  <X size={16} className="text-muted-foreground" />
                </Pressable>
              </View>

              <ScrollView
                className="px-5 py-4"
                contentContainerClassName="gap-3"
                nestedScrollEnabled
                keyboardShouldPersistTaps="handled"
              >
            {/* Provider */}
            <View>
              <FieldLabel>Provider</FieldLabel>
              <View className="flex-row flex-wrap gap-1.5">
                {PROVIDER_OPTIONS.map((opt) => (
                  <Pressable
                    key={opt}
                    onPress={() => setForm((f) => ({ ...f, provider: opt }))}
                    disabled={!!editingId}
                    className={cn(
                      'px-3 py-1.5 rounded-md border',
                      form.provider === opt ? 'border-primary bg-primary/10' : 'border-border bg-background',
                      !!editingId && 'opacity-50',
                    )}
                  >
                    <Text className={cn('text-xs', form.provider === opt ? 'text-primary font-medium' : 'text-muted-foreground')}>
                      {opt}
                    </Text>
                  </Pressable>
                ))}
              </View>
            </View>

            {/* Discovery prefill (known providers, create only) */}
            {!editingId && isDiscoveryProvider(form.provider) && (
              <View className="gap-2">
                <View className="flex-row items-center gap-1.5">
                  <Sparkles size={12} className="text-primary" />
                  <Text className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                    Choose a live {form.provider} model
                  </Text>
                </View>

                {KEY_GATED_DISCOVERY.has(form.provider) && !keyState[form.provider]?.configured ? (
                  <Text className="text-xs text-amber-500">
                    Add an {form.provider} API key above to list its models, or fill the fields below manually.
                  </Text>
                ) : discoveryLoading[form.provider] ? (
                  <View className="flex-row items-center gap-2 py-1.5">
                    <ActivityIndicator size="small" />
                    <Text className="text-xs text-muted-foreground">Loading {form.provider} models…</Text>
                  </View>
                ) : discoveryError[form.provider] ? (
                  <View className="flex-row items-center gap-2 p-2.5 rounded-lg bg-amber-500/10">
                    <AlertTriangle size={14} className="text-amber-500" />
                    <Text className="text-xs text-foreground flex-1">{discoveryError[form.provider]}</Text>
                    <Pressable
                      onPress={() => loadDiscovery(form.provider as DiscoveryProviderId)}
                      className="px-2 py-0.5 rounded bg-muted active:bg-muted/70"
                    >
                      <Text className="text-[11px] text-muted-foreground">Retry</Text>
                    </Pressable>
                  </View>
                ) : (
                  <>
                    {(discovered[form.provider]?.length ?? 0) > 8 && (
                      <View className="flex-row items-center gap-2 bg-background border border-border rounded-lg px-3 py-2">
                        <Search size={12} className="text-muted-foreground" />
                        <TextInput
                          value={discoverySearch}
                          onChangeText={setDiscoverySearch}
                          placeholder={`Search ${form.provider} models…`}
                          placeholderTextColor="#666"
                          className="flex-1 text-sm text-foreground"
                          autoCapitalize="none"
                          autoCorrect={false}
                        />
                      </View>
                    )}
                    <ScrollView style={{ maxHeight: 240 }} nestedScrollEnabled>
                      {(discoveryList ?? []).map((m) => {
                        const selected = form.apiModel === m.id
                        return (
                          <Pressable
                            key={m.id}
                            onPress={() => applyDiscovered(m)}
                            className={cn(
                              'px-3 py-2 rounded-lg border mb-1.5',
                              selected ? 'border-primary/50 bg-primary/5' : 'border-border bg-background',
                            )}
                          >
                            <View className="flex-row items-center gap-2">
                              <View
                                className={cn(
                                  'w-4 h-4 rounded-full border items-center justify-center',
                                  selected ? 'border-primary bg-primary' : 'border-border',
                                )}
                              >
                                {selected && <Check size={11} color="#fff" />}
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
                      {(discoveryList?.length ?? 0) === 0 && (
                        <Text className="text-xs text-muted-foreground italic py-2">
                          {discoverySearch ? 'No models match your search.' : 'No models returned by the provider.'}
                        </Text>
                      )}
                    </ScrollView>
                  </>
                )}
              </View>
            )}

            {/* Custom provider picker */}
            {form.provider === 'custom' && (
              <View>
                <FieldLabel>Custom provider</FieldLabel>
                {providers.length === 0 ? (
                  <Text className="text-xs text-amber-500">Create a custom provider first (Custom Providers card).</Text>
                ) : (
                  <View className="flex-row flex-wrap gap-1.5">
                    {providers.map((p) => (
                      <Pressable
                        key={p.id}
                        onPress={() => setForm((f) => ({ ...f, providerId: p.id }))}
                        className={cn(
                          'px-3 py-1.5 rounded-md border',
                          form.providerId === p.id ? 'border-primary bg-primary/10' : 'border-border bg-background',
                        )}
                      >
                        <Text className={cn('text-xs', form.providerId === p.id ? 'text-primary font-medium' : 'text-muted-foreground')}>
                          {p.label}
                        </Text>
                      </Pressable>
                    ))}
                  </View>
                )}
              </View>
            )}

            {/* Core fields. The canonical id is a server-generated UUID — the
                admin only supplies the upstream api model (the provider slug),
                which is also kept as an alias so the model stays addressable by
                name. */}
            <View>
              <FieldLabel>Upstream api model</FieldLabel>
              <TextInput
                value={form.apiModel}
                onChangeText={(t) => setForm((f) => ({ ...f, apiModel: t }))}
                placeholder="claude-sonnet-4-5"
                placeholderTextColor="#9ca3af"
                autoCapitalize="none"
                className="px-3 py-2 rounded-md border border-border bg-background text-foreground text-sm"
              />
            </View>

            <View>
              <FieldLabel>Display name</FieldLabel>
              <TextInput
                value={form.displayName}
                onChangeText={(t) => setForm((f) => ({ ...f, displayName: t }))}
                placeholder="Claude Sonnet 4.5"
                placeholderTextColor="#9ca3af"
                className="px-3 py-2 rounded-md border border-border bg-background text-foreground text-sm"
              />
            </View>

            {/* Customize details (advanced) */}
            <Pressable
              onPress={() => setAdvancedOpen((v) => !v)}
              className="flex-row items-center gap-1.5 py-1"
            >
              {advancedOpen ? (
                <ChevronDown size={14} className="text-muted-foreground" />
              ) : (
                <ChevronRight size={14} className="text-muted-foreground" />
              )}
              <Text className="text-xs font-medium text-foreground">Customize details</Text>
              <Text className="text-[11px] text-muted-foreground">
                (pricing auto-fills from LiteLLM when left at 0)
              </Text>
            </Pressable>

            {advancedOpen && (
              <View className="gap-3">
                <View>
                  <FieldLabel>Short name</FieldLabel>
                  <TextInput
                    value={form.shortDisplayName}
                    onChangeText={(t) => setForm((f) => ({ ...f, shortDisplayName: t }))}
                    placeholder="Sonnet 4.5"
                    placeholderTextColor="#9ca3af"
                    className="px-3 py-2 rounded-md border border-border bg-background text-foreground text-sm"
                  />
                </View>

                <View>
                  <FieldLabel>Tier</FieldLabel>
                  <SegmentedControl options={MODEL_TIER_OPTIONS} value={form.tier} onChange={(v) => setForm((f) => ({ ...f, tier: v }))} />
                </View>
                <View>
                  <FieldLabel>Family</FieldLabel>
                  <SegmentedControl options={MODEL_FAMILY_OPTIONS} value={form.family} onChange={(v) => setForm((f) => ({ ...f, family: v }))} />
                </View>
                <View>
                  <FieldLabel>Generation</FieldLabel>
                  <SegmentedControl options={MODEL_GENERATION_OPTIONS} value={form.generation} onChange={(v) => setForm((f) => ({ ...f, generation: v }))} />
                </View>

                <View className="flex-row gap-2">
                  <View className="flex-1">
                    <FieldLabel>Max output tokens</FieldLabel>
                    <TextInput
                      value={form.maxOutputTokens}
                      onChangeText={(t) => setForm((f) => ({ ...f, maxOutputTokens: t.replace(/[^0-9]/g, '') }))}
                      keyboardType="number-pad"
                      className="px-3 py-2 rounded-md border border-border bg-background text-foreground text-sm"
                    />
                  </View>
                  <View className="flex-1">
                    <FieldLabel>Context window (tokens)</FieldLabel>
                    <TextInput
                      value={form.contextWindow}
                      onChangeText={(t) => setForm((f) => ({ ...f, contextWindow: t.replace(/[^0-9]/g, '') }))}
                      keyboardType="number-pad"
                      placeholder="200000"
                      placeholderTextColor="#9ca3af"
                      className="px-3 py-2 rounded-md border border-border bg-background text-foreground text-sm"
                    />
                  </View>
                </View>

                <View>
                  <FieldLabel>Aliases (comma-sep)</FieldLabel>
                  <TextInput
                    value={form.aliases}
                    onChangeText={(t) => setForm((f) => ({ ...f, aliases: t }))}
                    placeholder="sonnet, claude-sonnet"
                    placeholderTextColor="#9ca3af"
                    autoCapitalize="none"
                    className="px-3 py-2 rounded-md border border-border bg-background text-foreground text-sm"
                  />
                </View>

                <View>
                  <FieldLabel>Description</FieldLabel>
                  <TextInput
                    value={form.description}
                    onChangeText={(t) => setForm((f) => ({ ...f, description: t }))}
                    placeholder="Anthropic's smartest model, great for difficult tasks."
                    placeholderTextColor="#9ca3af"
                    multiline
                    numberOfLines={2}
                    className="px-3 py-2 rounded-md border border-border bg-background text-foreground text-sm"
                  />
                </View>

                <View>
                  <FieldLabel>Reasoning effort</FieldLabel>
                  <SegmentedControl
                    options={MODEL_REASONING_EFFORT_OPTIONS}
                    value={form.reasoningEffort}
                    onChange={(v) => setForm((f) => ({ ...f, reasoningEffort: v }))}
                  />
                </View>

                <FieldLabel>Pricing (USD per 1M tokens)</FieldLabel>
                <View className="flex-row gap-2">
                  <View className="flex-1">
                    <FieldLabel>Input</FieldLabel>
                    <TextInput
                      value={form.inputPerMillion}
                      onChangeText={(t) => setForm((f) => ({ ...f, inputPerMillion: t }))}
                      keyboardType="decimal-pad"
                      className="px-3 py-2 rounded-md border border-border bg-background text-foreground text-sm"
                    />
                  </View>
                  <View className="flex-1">
                    <FieldLabel>Output</FieldLabel>
                    <TextInput
                      value={form.outputPerMillion}
                      onChangeText={(t) => setForm((f) => ({ ...f, outputPerMillion: t }))}
                      keyboardType="decimal-pad"
                      className="px-3 py-2 rounded-md border border-border bg-background text-foreground text-sm"
                    />
                  </View>
                </View>
                <View className="flex-row gap-2">
                  <View className="flex-1">
                    <FieldLabel>Cached input</FieldLabel>
                    <TextInput
                      value={form.cachedInputPerMillion}
                      onChangeText={(t) => setForm((f) => ({ ...f, cachedInputPerMillion: t }))}
                      keyboardType="decimal-pad"
                      className="px-3 py-2 rounded-md border border-border bg-background text-foreground text-sm"
                    />
                  </View>
                  <View className="flex-1">
                    <FieldLabel>Cache write</FieldLabel>
                    <TextInput
                      value={form.cacheWritePerMillion}
                      onChangeText={(t) => setForm((f) => ({ ...f, cacheWritePerMillion: t }))}
                      keyboardType="decimal-pad"
                      className="px-3 py-2 rounded-md border border-border bg-background text-foreground text-sm"
                    />
                  </View>
                </View>
              </View>
            )}

                <Pressable
                  onPress={() => setForm((f) => ({ ...f, enabled: !f.enabled }))}
                  className="flex-row items-center justify-between p-2.5 rounded-md border border-border bg-background"
                >
                  <Text className="text-sm text-foreground">Enabled</Text>
                  {form.enabled && <Check size={16} className="text-primary" />}
                </Pressable>
              </ScrollView>

              {/* Footer */}
              <View className="px-5 py-3 border-t border-border">
                <Pressable
                  onPress={submit}
                  disabled={!canSubmit || busy}
                  className={cn('items-center py-2.5 rounded-md', canSubmit && !busy ? 'bg-primary' : 'bg-muted')}
                >
                  {busy ? (
                    <ActivityIndicator size="small" />
                  ) : (
                    <Text className={cn('text-sm font-medium', canSubmit ? 'text-primary-foreground' : 'text-muted-foreground')}>
                      {editingId ? 'Save changes' : 'Add model'}
                    </Text>
                  )}
                </Pressable>
              </View>
            </View>
          </View>
        </Modal>
      </View>
    </View>
  )
}
