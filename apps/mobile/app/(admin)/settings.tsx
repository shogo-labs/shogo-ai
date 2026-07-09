// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Admin Settings - AI provider selection, LLM configuration, and API keys.
 *
 * Cloud mode: shows Model Defaults only (which models power basic/advanced).
 * Local mode: AI provider selector (Shogo Cloud / Own API Keys) sharing the
 * same model-management flow as the cloud admin.
 */

import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import {
  View,
  Text,
  ScrollView,
  Pressable,
  ActivityIndicator,
  TextInput,
} from 'react-native'
import {
  Server,
  CheckCircle,
  AlertTriangle,
  Key,
  BrainCircuit,
  ChevronDown,
  Cloud,
  Check,
  ListFilter,
  Plus,
  X,
  Trash2,
  Pencil,
} from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import {
  PlatformApi,
  type ModelProvider,
  type ModelProviderInput,
  type PublicModel,
} from '@shogo-ai/sdk'
import { createHttpClient } from '../../lib/api'
import { usePlatformConfig } from '../../lib/platform-config'
import { invalidateVisibleModelsCache, useModelPickerList } from '../../lib/visible-models'
import { ModelsCard } from '../../components/admin/ModelsCard'

// =============================================================================
// Types
// =============================================================================

type AIMode = 'shogo-cloud' | 'api-keys'

const MODE_LABELS: Record<AIMode, string> = {
  'shogo-cloud': 'Shogo Cloud',
  'api-keys': 'API Keys',
}

// =============================================================================
// Main Page
// =============================================================================

export default function AdminSettingsPage() {
  const { localMode } = usePlatformConfig()
  if (!localMode) return <CloudModelSettingsPage />
  return <LocalSettingsPage />
}

// =============================================================================
// Cloud Mode: Model defaults only
// =============================================================================

function CloudModelSettingsPage() {
  const [cloudBasicModel, setCloudBasicModel] = useState('')
  const [cloudAdvancedModel, setCloudAdvancedModel] = useState('')
  const [defaultMode, setDefaultMode] = useState('')
  const [isLoading, setIsLoading] = useState(true)
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const loadedRef = useRef(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const platform = useMemo(() => new PlatformApi(createHttpClient()), [])

  useEffect(() => {
    platform.getAgentModelDefaults()
      .then((data) => {
        setCloudBasicModel(data.basic || '')
        setCloudAdvancedModel(data.advanced || '')
        setDefaultMode(data.defaultMode || '')
      })
      // `/api/admin/settings/agent-models` is super-admin-only. A non-super-admin
      // reaching this screen (or a session that lost the role) gets a 403 →
      // `ShogoError('Super admin access required')`. Without this catch the
      // rejection is unhandled and floods Sentry (REACT-3Q). Match the other
      // `getAgentModelDefaults()` call sites in this file, which already catch.
      .catch(() => {})
      .finally(() => setIsLoading(false))
  }, [platform])

  useEffect(() => {
    if (!loadedRef.current) return
    if (timerRef.current) clearTimeout(timerRef.current)
    setSaveStatus('saving')
    timerRef.current = setTimeout(async () => {
      try {
        await platform.putAgentModelDefaults({
          basic: cloudBasicModel || null,
          advanced: cloudAdvancedModel || null,
          defaultMode: defaultMode || null,
        })
        setSaveStatus('saved')
        setTimeout(() => setSaveStatus('idle'), 2000)
      } catch {
        setSaveStatus('error')
        setTimeout(() => setSaveStatus('idle'), 3000)
      }
    }, 600)
    return () => { if (timerRef.current) clearTimeout(timerRef.current) }
  }, [cloudBasicModel, cloudAdvancedModel, defaultMode, platform])

  // Declared after auto-save effect so it runs second in the same render cycle.
  // The auto-save skips (ref is false), then this enables future saves.
  useEffect(() => {
    if (!isLoading) loadedRef.current = true
  }, [isLoading])

  if (isLoading) {
    return (
      <View className="flex-1 items-center justify-center">
        <ActivityIndicator size="large" />
      </View>
    )
  }

  return (
    <ScrollView className="flex-1 bg-background" contentContainerClassName="p-6 pb-20">
      <View className="max-w-2xl w-full mx-auto gap-8">
        <View className="flex-row items-center justify-between">
          <View className="flex-1">
            <Text className="text-2xl font-bold text-foreground">AI</Text>
            <Text className="text-sm text-muted-foreground mt-1">
              Configure which models power the Basic and Advanced agent modes.
            </Text>
          </View>
          <AutoSaveIndicator status={saveStatus} />
        </View>

        <ModelsCard platform={platform} localMode={false} />

        <AgentModelDefaultsCard
          basicModel={cloudBasicModel}
          advancedModel={cloudAdvancedModel}
          defaultMode={defaultMode}
          onBasicChange={setCloudBasicModel}
          onAdvancedChange={setCloudAdvancedModel}
          onDefaultModeChange={setDefaultMode}
        />

        <AutoTierModelsCard platform={platform} />

        <TitleGenerationModelCard platform={platform} />

        <CustomProvidersCard platform={platform} />
      </View>
    </ScrollView>
  )
}

function AutoSaveIndicator({ status }: { status: 'idle' | 'saving' | 'saved' | 'error' }) {
  if (status === 'idle') return null
  return (
    <View className="flex-row items-center gap-1.5">
      {status === 'saving' && (
        <ActivityIndicator size="small" />
      )}
      {status === 'saved' && (
        <CheckCircle size={14} className="text-green-500" />
      )}
      {status === 'error' && (
        <AlertTriangle size={14} className="text-destructive" />
      )}
      <Text className={cn(
        'text-xs',
        status === 'saving' && 'text-muted-foreground',
        status === 'saved' && 'text-green-500',
        status === 'error' && 'text-destructive',
      )}>
        {status === 'saving' ? 'Saving...' : status === 'saved' ? 'Saved' : 'Failed to save'}
      </Text>
    </View>
  )
}

// =============================================================================
// Local Mode: Full AI provider configuration
// =============================================================================

function LocalSettingsPage() {
  const [activeMode, setActiveMode] = useState<AIMode | null>(null)
  const [modeLoaded, setModeLoaded] = useState(false)

  // Masked BYOK provider keys (read via /api/local/api-keys). Used here only to
  // infer the initial AI mode; key entry now lives in ProviderSetupCard.
  const [keyMasks, setKeyMasks] = useState<Record<string, string>>({})

  const [cloudBasicModel, setCloudBasicModel] = useState('')
  const [cloudAdvancedModel, setCloudAdvancedModel] = useState('')
  const [cloudDefaultMode, setCloudDefaultMode] = useState('')

  const [shogoKeyConnected, setShogoKeyConnected] = useState(false)

  const [isLoading, setIsLoading] = useState(true)
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')

  const configLoadedRef = useRef(false)
  const modelDefaultsTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const platform = useMemo(() => new PlatformApi(createHttpClient()), [])

  const inferMode = useCallback((
    masks: Record<string, string>,
    shogoConnected: boolean,
  ): AIMode | null => {
    if (shogoConnected) return 'shogo-cloud'
    if (Object.keys(masks).length > 0) return 'api-keys'
    return null
  }, [])

  const fetchConfig = useCallback(async () => {
    try {
      const [llmCfg, masks, shogoData, agentModels] = await Promise.all([
        platform.getLlmConfig(),
        platform.getProviderKeyMasks(),
        platform.getShogoKeyStatus(),
        platform.getAgentModelDefaults().catch(() => ({
          basic: null,
          advanced: null,
          defaultMode: null,
          autoEconomy: null,
          autoStandard: null,
          autoPremium: null,
        })),
      ])

      setCloudBasicModel(agentModels.basic || '')
      setCloudAdvancedModel(agentModels.advanced || '')
      setCloudDefaultMode(agentModels.defaultMode || '')

      setKeyMasks(masks)

      setShogoKeyConnected(shogoData.connected)

      const storedMode = llmCfg.AI_MODE as AIMode | undefined
      if (storedMode && ['shogo-cloud', 'api-keys'].includes(storedMode)) {
        setActiveMode(storedMode)
      } else {
        const inferred = inferMode(masks, shogoData.connected)
        setActiveMode(inferred)
        if (inferred) {
          platform.putLlmConfig({ AI_MODE: inferred }).catch(() => {})
        }
      }
      setModeLoaded(true)
    } catch (err) {
      console.error('[AdminSettings] Failed to load config:', err)
    } finally {
      setIsLoading(false)
    }
  }, [platform, inferMode])

  useEffect(() => { fetchConfig() }, [fetchConfig])

  const handleModeChange = useCallback(async (mode: AIMode) => {
    setActiveMode(mode)
    try {
      await platform.putLlmConfig({ AI_MODE: mode })
    } catch (err) {
      console.error('[AdminSettings] Failed to persist AI_MODE:', err)
    }
  }, [platform])

  // Auto-save agent model defaults (shogo-cloud / api-keys)
  useEffect(() => {
    if (!configLoadedRef.current) return
    if (activeMode !== 'shogo-cloud' && activeMode !== 'api-keys') return
    if (modelDefaultsTimerRef.current) clearTimeout(modelDefaultsTimerRef.current)
    setSaveStatus('saving')
    modelDefaultsTimerRef.current = setTimeout(async () => {
      try {
        await platform.putAgentModelDefaults({
          basic: cloudBasicModel || null,
          advanced: cloudAdvancedModel || null,
          defaultMode: cloudDefaultMode || null,
        })
        setSaveStatus('saved')
        setTimeout(() => setSaveStatus('idle'), 2000)
      } catch {
        setSaveStatus('error')
        setTimeout(() => setSaveStatus('idle'), 3000)
      }
    }, 600)
    return () => { if (modelDefaultsTimerRef.current) clearTimeout(modelDefaultsTimerRef.current) }
  }, [activeMode, cloudBasicModel, cloudAdvancedModel, cloudDefaultMode, platform])

  // Declared after auto-save effects so it runs second in the same render cycle.
  // The auto-save effects skip (ref is false), then this enables future saves.
  useEffect(() => {
    if (!isLoading) configLoadedRef.current = true
  }, [isLoading])

  if (isLoading) {
    return (
      <View className="flex-1 items-center justify-center">
        <ActivityIndicator size="large" />
      </View>
    )
  }

  return (
    <ScrollView className="flex-1 bg-background" contentContainerClassName="p-6 pb-20">
      <View className="max-w-2xl w-full mx-auto gap-8">
        {/* Header */}
        <View className="flex-row items-center gap-3">
          <View className="flex-1">
            <Text className="text-2xl font-bold text-foreground">AI</Text>
            <Text className="text-sm text-muted-foreground mt-1">
              Choose your AI provider and configure models.
            </Text>
          </View>
          <AutoSaveIndicator status={saveStatus} />
          {activeMode && modeLoaded && (
            <View className="px-3 py-1.5 rounded-full bg-primary/10">
              <Text className="text-xs font-semibold text-primary">
                {MODE_LABELS[activeMode]}
              </Text>
            </View>
          )}
        </View>

        {/* Mode Selector */}
        <View className="gap-3">
          <Text className="text-sm font-semibold text-foreground uppercase tracking-wider">
            AI Provider
          </Text>

          <Pressable
            onPress={() => handleModeChange('shogo-cloud')}
            className={cn(
              'flex-row items-center gap-4 p-4 rounded-xl border',
              activeMode === 'shogo-cloud' ? 'border-primary bg-primary/5' : 'border-border bg-card'
            )}
          >
            <View className={cn(
              'w-10 h-10 rounded-lg items-center justify-center',
              activeMode === 'shogo-cloud' ? 'bg-primary/10' : 'bg-muted'
            )}>
              <Cloud size={20} className={activeMode === 'shogo-cloud' ? 'text-primary' : 'text-muted-foreground'} />
            </View>
            <View className="flex-1">
              <Text className="text-sm font-semibold text-foreground">Shogo Cloud</Text>
              <Text className="text-xs text-muted-foreground mt-0.5">
                Sign in with your Shogo account to use cloud LLMs — no API keys needed
              </Text>
            </View>
            {activeMode === 'shogo-cloud' && <Check size={18} className="text-primary" />}
          </Pressable>

          <Pressable
            onPress={() => handleModeChange('api-keys')}
            className={cn(
              'flex-row items-center gap-4 p-4 rounded-xl border',
              activeMode === 'api-keys' ? 'border-primary bg-primary/5' : 'border-border bg-card'
            )}
          >
            <View className={cn(
              'w-10 h-10 rounded-lg items-center justify-center',
              activeMode === 'api-keys' ? 'bg-primary/10' : 'bg-muted'
            )}>
              <Key size={20} className={activeMode === 'api-keys' ? 'text-primary' : 'text-muted-foreground'} />
            </View>
            <View className="flex-1">
              <Text className="text-sm font-semibold text-foreground">Your Own API Keys</Text>
              <Text className="text-xs text-muted-foreground mt-0.5">
                Use Anthropic or OpenAI API keys directly
              </Text>
            </View>
            {activeMode === 'api-keys' && <Check size={18} className="text-primary" />}
          </Pressable>
        </View>

        {/* ── Shogo Cloud config ─────────────────────────────────────── */}
        {activeMode === 'shogo-cloud' && (
          <>
            <SectionCard
              icon={Cloud}
              title="Shogo Cloud"
              description="Uses cloud LLMs via your signed-in Shogo account"
            >
              {shogoKeyConnected ? (
                <View className="flex-row items-center gap-2 bg-green-500/10 rounded-lg p-3">
                  <CheckCircle size={16} className="text-green-500" />
                  <Text className="text-sm font-medium text-foreground">
                    Cloud LLMs active. Manage this device's sign-in from General settings.
                  </Text>
                </View>
              ) : (
                <View className="flex-row items-center gap-2 bg-amber-500/10 rounded-lg p-3">
                  <AlertTriangle size={16} className="text-amber-500" />
                  <Text className="text-sm text-foreground">
                    Not signed in to Shogo Cloud. Sign in from General settings first.
                  </Text>
                </View>
              )}
            </SectionCard>

            {shogoKeyConnected ? (
              <>
                <SectionCard
                  icon={ListFilter}
                  title="Available Models"
                  description="Managed by your Shogo Cloud admin"
                >
                  <Text className="text-sm text-muted-foreground">
                    The models shown in the picker are controlled by your Shogo
                    Cloud workspace. Changes an admin makes to the available
                    models there apply to this device automatically.
                  </Text>
                </SectionCard>

                <AgentModelDefaultsCard
                  basicModel={cloudBasicModel}
                  advancedModel={cloudAdvancedModel}
                  defaultMode={cloudDefaultMode}
                  onBasicChange={setCloudBasicModel}
                  onAdvancedChange={setCloudAdvancedModel}
                  onDefaultModeChange={setCloudDefaultMode}
                />

                <AutoTierModelsCard platform={platform} />

                <TitleGenerationModelCard platform={platform} />
              </>
            ) : (
              <>
                <ModelsCard platform={platform} localMode={true} />

                <AgentModelDefaultsCard
                  basicModel={cloudBasicModel}
                  advancedModel={cloudAdvancedModel}
                  defaultMode={cloudDefaultMode}
                  onBasicChange={setCloudBasicModel}
                  onAdvancedChange={setCloudAdvancedModel}
                  onDefaultModeChange={setCloudDefaultMode}
                />

                <AutoTierModelsCard platform={platform} />

                <TitleGenerationModelCard platform={platform} />

                <CustomProvidersCard platform={platform} />
              </>
            )}
          </>
        )}

        {/* ── API Keys config ────────────────────────────────────────── */}
        {activeMode === 'api-keys' && (
          <>
            <ModelsCard platform={platform} localMode={true} />

            <AgentModelDefaultsCard
              basicModel={cloudBasicModel}
              advancedModel={cloudAdvancedModel}
              defaultMode={cloudDefaultMode}
              onBasicChange={setCloudBasicModel}
              onAdvancedChange={setCloudAdvancedModel}
              onDefaultModeChange={setCloudDefaultMode}
            />

            <AutoTierModelsCard platform={platform} />

            <TitleGenerationModelCard platform={platform} />

            <CustomProvidersCard platform={platform} />
          </>
        )}

        {/* Prompt when no mode selected */}
        {!activeMode && modeLoaded && (
          <View className="items-center py-8">
            <Text className="text-sm text-muted-foreground text-center">
              Select an AI provider above to get started.
            </Text>
          </View>
        )}
      </View>
    </ScrollView>
  )
}

// =============================================================================
// Shared Components
// =============================================================================

function SectionCard({
  icon: Icon,
  title,
  description,
  children,
}: {
  icon: any
  title: string
  description: string
  children: React.ReactNode
}) {
  return (
    <View className="bg-card border border-border rounded-xl overflow-hidden">
      <View className="px-5 py-4 border-b border-border">
        <View className="flex-row items-center gap-2.5 mb-1">
          <Icon size={16} className="text-foreground" />
          <Text className="text-base font-semibold text-foreground">{title}</Text>
        </View>
        <Text className="text-xs text-muted-foreground">{description}</Text>
      </View>
      <View className="px-5 py-4">
        {children}
      </View>
    </View>
  )
}

function FieldGroup({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <View className="gap-1.5">
      <Text className="text-sm font-medium text-foreground">{label}</Text>
      {hint && <Text className="text-xs text-muted-foreground">{hint}</Text>}
      {children}
    </View>
  )
}

// =============================================================================
// Agent Model Defaults Card (cloud / api-keys modes)
// =============================================================================

const AUTO_DEFAULT_VALUE = '__auto__'

function AgentModelDefaultsCard({
  basicModel,
  advancedModel,
  defaultMode,
  onBasicChange,
  onAdvancedChange,
  onDefaultModeChange,
}: {
  basicModel: string
  advancedModel: string
  defaultMode: string
  onBasicChange: (v: string) => void
  onAdvancedChange: (v: string) => void
  onDefaultModeChange: (v: string) => void
}) {
  const models = useModelPickerList()
  const [showDropdown, setShowDropdown] = useState(false)

  const isAuto = defaultMode === 'auto'
  const selectedId = isAuto
    ? AUTO_DEFAULT_VALUE
    : (defaultMode === 'advanced' ? advancedModel || basicModel : basicModel || advancedModel) || ''

  const selectAuto = useCallback(() => {
    onDefaultModeChange('auto')
    onBasicChange('')
    onAdvancedChange('')
    setShowDropdown(false)
  }, [onDefaultModeChange, onBasicChange, onAdvancedChange])

  const selectModel = useCallback((id: string) => {
    onDefaultModeChange('basic')
    onBasicChange(id)
    onAdvancedChange(id)
    setShowDropdown(false)
  }, [onDefaultModeChange, onBasicChange, onAdvancedChange])

  const selectedLabel = isAuto
    ? 'Auto'
    : models.find((m) => m.id === selectedId)?.displayName || selectedId || 'Auto'

  return (
    <View
      className="bg-card border border-border rounded-xl"
      style={{ position: 'relative', zIndex: showDropdown ? 50 : undefined }}
    >
      <View className="px-5 py-4 border-b border-border">
        <View className="flex-row items-center gap-2.5 mb-1">
          <BrainCircuit size={16} className="text-foreground" />
          <Text className="text-base font-semibold text-foreground">Default Model</Text>
        </View>
        <Text className="text-xs text-muted-foreground">
          The model new chats start on for all users. Choose Auto to route to the cheapest capable model per turn.
        </Text>
      </View>
      <View className="px-5 py-4" style={{ zIndex: 10 }}>
        <View style={{ position: 'relative', zIndex: showDropdown ? 100 : 1 }}>
          <Pressable
            onPress={() => setShowDropdown((v) => !v)}
            className="flex-row items-center justify-between bg-background border border-border rounded-lg px-3 py-2.5"
          >
            <Text className="text-sm text-foreground">{selectedLabel}</Text>
            <ChevronDown size={14} className="text-muted-foreground" />
          </Pressable>

          {showDropdown && (
            <View
              className="bg-card border border-border rounded-lg shadow-lg max-h-64 overflow-hidden"
              style={{ position: 'absolute', top: 48, left: 0, right: 0, zIndex: 999 }}
            >
              <ScrollView>
                <Pressable
                  onPress={selectAuto}
                  className={cn(
                    'px-3 py-2.5 border-b border-border/50 active:bg-muted',
                    isAuto && 'bg-primary/5'
                  )}
                >
                  <Text className="text-sm font-medium text-foreground">Auto</Text>
                  <Text className="text-[11px] text-muted-foreground">
                    Routes to the cheapest capable model per turn
                  </Text>
                </Pressable>
                {models.map((m) => (
                  <Pressable
                    key={m.id}
                    onPress={() => selectModel(m.id)}
                    className={cn(
                      'px-3 py-2.5 border-b border-border/50 active:bg-muted',
                      selectedId === m.id && 'bg-primary/5'
                    )}
                  >
                    <Text className="text-sm text-foreground">{m.displayName}</Text>
                  </Pressable>
                ))}
                {models.length === 0 && (
                  <View className="px-3 py-2.5">
                    <Text className="text-xs text-muted-foreground italic">
                      No models available. Add or enable models above first.
                    </Text>
                  </View>
                )}
              </ScrollView>
            </View>
          )}
        </View>
      </View>
    </View>
  )
}

// =============================================================================
// Title Generation Model Card — super-admin selectable model used to generate
// short titles for new chats and projects (`POST /api/generate-project-name`).
// Self-contained: loads and saves its own value via the PlatformApi.
// =============================================================================

function TitleGenerationModelCard({ platform }: { platform: PlatformApi }) {
  const models = useModelPickerList()
  const [selected, setSelected] = useState('')
  const [showDropdown, setShowDropdown] = useState(false)
  const [isLoading, setIsLoading] = useState(true)
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const statusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    platform.getTitleGenerationModel()
      .then((data) => setSelected(data.model || ''))
      .catch(() => {})
      .finally(() => setIsLoading(false))
    return () => { if (statusTimerRef.current) clearTimeout(statusTimerRef.current) }
  }, [platform])

  const save = useCallback(async (value: string) => {
    setSelected(value)
    setShowDropdown(false)
    setSaveStatus('saving')
    try {
      await platform.putTitleGenerationModel(value || null)
      setSaveStatus('saved')
    } catch {
      setSaveStatus('error')
    }
    if (statusTimerRef.current) clearTimeout(statusTimerRef.current)
    statusTimerRef.current = setTimeout(() => setSaveStatus('idle'), 2000)
  }, [platform])

  const selectedLabel = selected
    ? (models.find((m) => m.id === selected)?.displayName || selected)
    : 'Default (Haiku)'

  return (
    <View
      className="bg-card border border-border rounded-xl"
      style={{ position: 'relative', zIndex: showDropdown ? 50 : undefined }}
    >
      <View className="px-5 py-4 border-b border-border">
        <View className="flex-row items-center justify-between mb-1">
          <View className="flex-row items-center gap-2.5">
            <Pencil size={16} className="text-foreground" />
            <Text className="text-base font-semibold text-foreground">Title Generation Model</Text>
          </View>
          <AutoSaveIndicator status={saveStatus} />
        </View>
        <Text className="text-xs text-muted-foreground">
          The model used to generate short titles for new chats and projects. Defaults to Haiku.
        </Text>
      </View>
      <View className="px-5 py-4" style={{ zIndex: 10 }}>
        <View style={{ position: 'relative', zIndex: showDropdown ? 100 : 1 }}>
          <Pressable
            onPress={() => setShowDropdown((v) => !v)}
            disabled={isLoading}
            className="flex-row items-center justify-between bg-background border border-border rounded-lg px-3 py-2.5"
          >
            <Text className="text-sm text-foreground">{isLoading ? 'Loading…' : selectedLabel}</Text>
            <ChevronDown size={14} className="text-muted-foreground" />
          </Pressable>

          {showDropdown && (
            <View
              className="bg-card border border-border rounded-lg shadow-lg max-h-64 overflow-hidden"
              style={{ position: 'absolute', top: 48, left: 0, right: 0, zIndex: 999 }}
            >
              <ScrollView>
                <Pressable
                  onPress={() => save('')}
                  className={cn(
                    'px-3 py-2.5 border-b border-border/50 active:bg-muted',
                    selected === '' && 'bg-primary/5'
                  )}
                >
                  <Text className="text-sm font-medium text-foreground">Default (Haiku)</Text>
                  <Text className="text-[11px] text-muted-foreground">
                    Use the platform default model
                  </Text>
                </Pressable>
                {models.map((m) => (
                  <Pressable
                    key={m.id}
                    onPress={() => save(m.id)}
                    className={cn(
                      'px-3 py-2.5 border-b border-border/50 active:bg-muted',
                      selected === m.id && 'bg-primary/5'
                    )}
                  >
                    <Text className="text-sm text-foreground">{m.displayName}</Text>
                  </Pressable>
                ))}
                {models.length === 0 && (
                  <View className="px-3 py-2.5">
                    <Text className="text-xs text-muted-foreground italic">
                      No models available. Add or enable models above first.
                    </Text>
                  </View>
                )}
              </ScrollView>
            </View>
          )}
        </View>
      </View>
    </View>
  )
}

// =============================================================================
// Auto-mode Tier Models Card — super-admin selectable model per Auto router
// tier (economy / standard / premium). When unset, the runtime falls back to
// its hardcoded defaults (Nano / Haiku / Sonnet). Selecting a public alias such
// as `hoshi-1.0` is resolved to its backing model when injected into runtimes.
// Self-contained: loads + saves its own values via the PlatformApi. Only the
// auto-* fields are written, so it never clobbers the basic/advanced defaults.
// =============================================================================

const AUTO_TIER_ROWS = [
  { key: 'economy' as const, field: 'autoEconomy' as const, label: 'Economy', hint: 'Simple tasks', defaultLabel: 'Default (GPT-5.4 Nano)' },
  { key: 'standard' as const, field: 'autoStandard' as const, label: 'Standard', hint: 'Moderate tasks', defaultLabel: 'Default (Claude Haiku)' },
  { key: 'premium' as const, field: 'autoPremium' as const, label: 'Premium', hint: 'Complex tasks', defaultLabel: 'Default (Claude Sonnet)' },
]

type AutoTierKey = (typeof AUTO_TIER_ROWS)[number]['key']

function AutoTierModelsCard({ platform }: { platform: PlatformApi }) {
  const models = useModelPickerList()
  const [publicModels, setPublicModels] = useState<PublicModel[]>([])
  const [values, setValues] = useState<Record<AutoTierKey, string>>({ economy: '', standard: '', premium: '' })
  const [openTier, setOpenTier] = useState<AutoTierKey | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const statusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    Promise.all([
      platform.getAgentModelDefaults().catch(() => null),
      platform.getPublicModels().catch(() => [] as PublicModel[]),
    ])
      .then(([d, pub]) => {
        if (d) {
          setValues({
            economy: d.autoEconomy || '',
            standard: d.autoStandard || '',
            premium: d.autoPremium || '',
          })
        }
        setPublicModels(pub || [])
      })
      .finally(() => setIsLoading(false))
    return () => { if (statusTimerRef.current) clearTimeout(statusTimerRef.current) }
  }, [platform])

  // Selectable models = visible catalog/picker models plus enabled public
  // aliases (e.g. hoshi-1.0), so admins can route Auto tiers at Hoshi.
  const options = useMemo(() => {
    const opts: { id: string; label: string }[] = models.map((m) => ({ id: m.id, label: m.displayName }))
    for (const p of publicModels) {
      if (p.enabled === false) continue
      if (opts.some((o) => o.id === p.publicId)) continue
      opts.push({ id: p.publicId, label: `${p.displayName} (public)` })
    }
    return opts
  }, [models, publicModels])

  const save = useCallback(
    async (tier: AutoTierKey, field: string, value: string) => {
      setValues((v) => ({ ...v, [tier]: value }))
      setOpenTier(null)
      setSaveStatus('saving')
      try {
        await platform.putAgentModelDefaults({ [field]: value || null })
        setSaveStatus('saved')
      } catch {
        setSaveStatus('error')
      }
      if (statusTimerRef.current) clearTimeout(statusTimerRef.current)
      statusTimerRef.current = setTimeout(() => setSaveStatus('idle'), 2000)
    },
    [platform],
  )

  const labelFor = useCallback(
    (tier: AutoTierKey) => {
      const v = values[tier]
      if (!v) return AUTO_TIER_ROWS.find((r) => r.key === tier)!.defaultLabel
      return options.find((o) => o.id === v)?.label || v
    },
    [values, options],
  )

  return (
    <View
      className="bg-card border border-border rounded-xl"
      style={{ position: 'relative', zIndex: openTier ? 50 : undefined }}
    >
      <View className="px-5 py-4 border-b border-border">
        <View className="flex-row items-center justify-between mb-1">
          <View className="flex-row items-center gap-2.5">
            <BrainCircuit size={16} className="text-foreground" />
            <Text className="text-base font-semibold text-foreground">Auto Mode Tier Models</Text>
          </View>
          <AutoSaveIndicator status={saveStatus} />
        </View>
        <Text className="text-xs text-muted-foreground">
          Which model the Auto router uses for each complexity tier. Leave a tier on Default to use the
          built-in model. Public aliases (e.g. Hoshi) resolve to their backing model at runtime.
        </Text>
      </View>

      <View className="px-5 py-4 gap-4" style={{ zIndex: 10 }}>
        {AUTO_TIER_ROWS.map((row, idx) => {
          const open = openTier === row.key
          return (
            <View
              key={row.key}
              style={{ position: 'relative', zIndex: open ? 100 : AUTO_TIER_ROWS.length - idx }}
            >
              <View className="flex-row items-center gap-1.5 mb-1">
                <Text className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  {row.label}
                </Text>
                <Text className="text-[11px] text-muted-foreground">· {row.hint}</Text>
              </View>
              <Pressable
                onPress={() => setOpenTier((t) => (t === row.key ? null : row.key))}
                disabled={isLoading}
                className="flex-row items-center justify-between bg-background border border-border rounded-lg px-3 py-2.5"
              >
                <Text className="text-sm text-foreground">{isLoading ? 'Loading…' : labelFor(row.key)}</Text>
                <ChevronDown size={14} className="text-muted-foreground" />
              </Pressable>

              {open && (
                <View
                  className="bg-card border border-border rounded-lg shadow-lg max-h-64 overflow-hidden"
                  style={{ position: 'absolute', top: 70, left: 0, right: 0, zIndex: 999 }}
                >
                  <ScrollView nestedScrollEnabled>
                    <Pressable
                      onPress={() => save(row.key, row.field, '')}
                      className={cn(
                        'px-3 py-2.5 border-b border-border/50 active:bg-muted',
                        values[row.key] === '' && 'bg-primary/5',
                      )}
                    >
                      <Text className="text-sm font-medium text-foreground">{row.defaultLabel}</Text>
                      <Text className="text-[11px] text-muted-foreground">Use the built-in tier model</Text>
                    </Pressable>
                    {options.map((o) => (
                      <Pressable
                        key={o.id}
                        onPress={() => save(row.key, row.field, o.id)}
                        className={cn(
                          'px-3 py-2.5 border-b border-border/50 active:bg-muted',
                          values[row.key] === o.id && 'bg-primary/5',
                        )}
                      >
                        <Text className="text-sm text-foreground">{o.label}</Text>
                      </Pressable>
                    ))}
                    {options.length === 0 && (
                      <View className="px-3 py-2.5">
                        <Text className="text-xs text-muted-foreground italic">
                          No models available. Add or enable models above first.
                        </Text>
                      </View>
                    )}
                  </ScrollView>
                </View>
              )}
            </View>
          )
        })}
      </View>
    </View>
  )
}

// ---------------------------------------------------------------------------
// Custom providers (third-party OpenAI/Anthropic-compatible endpoints). The API
// key is write-only: reads return only a mask.
// ---------------------------------------------------------------------------

const PROVIDER_PROTOCOLS = ['openai', 'anthropic'] as const
const PROVIDER_AUTH_STYLES = ['bearer', 'api-key-header'] as const

interface ProviderFormState {
  label: string
  baseUrl: string
  protocol: 'openai' | 'anthropic'
  authStyle: 'bearer' | 'api-key-header'
  apiKey: string
  enabled: boolean
}

const EMPTY_PROVIDER_FORM: ProviderFormState = {
  label: '',
  baseUrl: '',
  protocol: 'openai',
  authStyle: 'bearer',
  apiKey: '',
  enabled: true,
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
    <View className="flex-row gap-1.5">
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

function CustomProvidersCard({ platform }: { platform: PlatformApi }) {
  const [providers, setProviders] = useState<ModelProvider[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState<ProviderFormState>(EMPTY_PROVIDER_FORM)

  const reload = useCallback(async () => {
    try {
      const list = await platform.listModelProviders()
      setProviders(list)
      setError(null)
    } catch (err: any) {
      setError(err?.message || 'Failed to load providers')
    } finally {
      setIsLoading(false)
    }
  }, [platform])

  useEffect(() => { reload() }, [reload])

  const openCreate = useCallback(() => {
    setEditingId(null)
    setForm(EMPTY_PROVIDER_FORM)
    setShowForm(true)
  }, [])

  const openEdit = useCallback((p: ModelProvider) => {
    setEditingId(p.id)
    setForm({
      label: p.label,
      baseUrl: p.baseUrl,
      protocol: p.protocol,
      authStyle: p.authStyle,
      apiKey: '', // write-only; blank keeps the existing key
      enabled: p.enabled,
    })
    setShowForm(true)
  }, [])

  const submit = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      const base: ModelProviderInput = {
        label: form.label.trim(),
        baseUrl: form.baseUrl.trim(),
        protocol: form.protocol,
        authStyle: form.authStyle,
        enabled: form.enabled,
      }
      if (form.apiKey.trim()) base.apiKey = form.apiKey.trim()
      if (editingId) {
        await platform.updateModelProvider(editingId, base)
      } else {
        await platform.createModelProvider(base)
      }
      invalidateVisibleModelsCache()
      setShowForm(false)
      setForm(EMPTY_PROVIDER_FORM)
      setEditingId(null)
      await reload()
    } catch (err: any) {
      setError(err?.message || 'Failed to save provider')
    } finally {
      setBusy(false)
    }
  }, [form, editingId, platform, reload])

  const remove = useCallback(async (id: string) => {
    setBusy(true)
    setError(null)
    try {
      await platform.deleteModelProvider(id)
      invalidateVisibleModelsCache()
      await reload()
    } catch (err: any) {
      setError(err?.message || 'Failed to delete provider')
    } finally {
      setBusy(false)
    }
  }, [platform, reload])

  const canSubmit = form.label.trim() && /^https?:\/\//.test(form.baseUrl.trim()) && (editingId || form.apiKey.trim())

  return (
    <View className="bg-card border border-border rounded-xl">
      <View className="px-5 py-4 border-b border-border">
        <View className="flex-row items-center justify-between">
          <View className="flex-row items-center gap-2.5 flex-1">
            <Server size={16} className="text-foreground" />
            <Text className="text-base font-semibold text-foreground">Custom Providers</Text>
          </View>
          {!showForm && (
            <Pressable onPress={openCreate} className="flex-row items-center gap-1 px-2.5 py-1.5 rounded-md border border-border bg-background">
              <Plus size={14} className="text-foreground" />
              <Text className="text-xs text-foreground">Add</Text>
            </Pressable>
          )}
        </View>
        <Text className="text-xs text-muted-foreground mt-1">
          Third-party OpenAI/Anthropic-compatible endpoints. Keys are encrypted at rest and never shown again.
        </Text>
      </View>

      <View className="px-5 py-4 gap-3">
        {error && <Text className="text-xs text-red-500">{error}</Text>}
        {isLoading ? (
          <ActivityIndicator size="small" />
        ) : (
          <>
            {providers.length === 0 && !showForm && (
              <Text className="text-xs text-muted-foreground">No custom providers yet.</Text>
            )}
            {providers.map((p) => (
              <View key={p.id} className="px-3 py-2.5 rounded-lg border border-border bg-background">
                <View className="flex-row items-center justify-between">
                  <View className="flex-1">
                    <View className="flex-row items-center gap-2">
                      <Text className="text-sm font-medium text-foreground">{p.label}</Text>
                      {!p.enabled && <Text className="text-[10px] text-muted-foreground">(disabled)</Text>}
                    </View>
                    <Text className="text-xs text-muted-foreground mt-0.5">{p.baseUrl}</Text>
                    <Text className="text-[11px] text-muted-foreground mt-0.5">
                      {p.protocol} · {p.authStyle} · key {p.apiKeyMask}
                      {!p.keyDecryptable && ' · ⚠ unreadable (re-enter)'}
                    </Text>
                  </View>
                  <View className="flex-row items-center gap-1.5">
                    <Pressable onPress={() => openEdit(p)} disabled={busy} className="p-1.5 rounded-md border border-border">
                      <Pencil size={13} className="text-muted-foreground" />
                    </Pressable>
                    <Pressable onPress={() => remove(p.id)} disabled={busy} className="p-1.5 rounded-md border border-border">
                      <Trash2 size={13} className="text-red-500" />
                    </Pressable>
                  </View>
                </View>
              </View>
            ))}

            {showForm && (
              <View className="px-3 py-3 rounded-lg border border-primary/40 bg-primary/5 gap-3">
                <View className="flex-row items-center justify-between">
                  <Text className="text-sm font-semibold text-foreground">
                    {editingId ? 'Edit provider' : 'New provider'}
                  </Text>
                  <Pressable onPress={() => { setShowForm(false); setEditingId(null) }} className="p-1">
                    <X size={16} className="text-muted-foreground" />
                  </Pressable>
                </View>
                <View>
                  <FieldLabel>Label</FieldLabel>
                  <TextInput
                    value={form.label}
                    onChangeText={(t) => setForm((f) => ({ ...f, label: t }))}
                    placeholder="My Provider"
                    placeholderTextColor="#9ca3af"
                    className="px-3 py-2 rounded-md border border-border bg-background text-foreground text-sm"
                  />
                </View>
                <View>
                  <FieldLabel>Base URL</FieldLabel>
                  <TextInput
                    value={form.baseUrl}
                    onChangeText={(t) => setForm((f) => ({ ...f, baseUrl: t }))}
                    placeholder="https://api.example.com/v1"
                    placeholderTextColor="#9ca3af"
                    autoCapitalize="none"
                    className="px-3 py-2 rounded-md border border-border bg-background text-foreground text-sm"
                  />
                </View>
                <View>
                  <FieldLabel>Protocol</FieldLabel>
                  <SegmentedControl options={PROVIDER_PROTOCOLS} value={form.protocol} onChange={(v) => setForm((f) => ({ ...f, protocol: v }))} />
                </View>
                <View>
                  <FieldLabel>Auth style</FieldLabel>
                  <SegmentedControl options={PROVIDER_AUTH_STYLES} value={form.authStyle} onChange={(v) => setForm((f) => ({ ...f, authStyle: v }))} />
                </View>
                <View>
                  <FieldLabel>{editingId ? 'API key (leave blank to keep current)' : 'API key'}</FieldLabel>
                  <TextInput
                    value={form.apiKey}
                    onChangeText={(t) => setForm((f) => ({ ...f, apiKey: t }))}
                    placeholder="sk-..."
                    placeholderTextColor="#9ca3af"
                    autoCapitalize="none"
                    secureTextEntry
                    className="px-3 py-2 rounded-md border border-border bg-background text-foreground text-sm"
                  />
                </View>
                <Pressable
                  onPress={() => setForm((f) => ({ ...f, enabled: !f.enabled }))}
                  className="flex-row items-center justify-between p-2.5 rounded-md border border-border bg-background"
                >
                  <Text className="text-sm text-foreground">Enabled</Text>
                  {form.enabled && <Check size={16} className="text-primary" />}
                </Pressable>
                <Pressable
                  onPress={submit}
                  disabled={!canSubmit || busy}
                  className={cn('items-center py-2.5 rounded-md', canSubmit && !busy ? 'bg-primary' : 'bg-muted')}
                >
                  {busy ? <ActivityIndicator size="small" /> : (
                    <Text className={cn('text-sm font-medium', canSubmit ? 'text-primary-foreground' : 'text-muted-foreground')}>
                      {editingId ? 'Save changes' : 'Create provider'}
                    </Text>
                  )}
                </Pressable>
              </View>
            )}
          </>
        )}
      </View>
    </View>
  )
}


