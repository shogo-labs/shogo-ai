// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Admin Settings - AI provider selection, LLM configuration, and API keys.
 *
 * Cloud mode: shows Model Defaults only (which models power basic/advanced).
 * Local mode: full AI provider selector (Shogo Cloud / Own API Keys / Local LLM).
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
  Cpu,
  CheckCircle,
  AlertTriangle,
  Key,
  Zap,
  BrainCircuit,
  ChevronDown,
  Cloud,
  Check,
  ListFilter,
  Plus,
  X,
  Search,
  Trash2,
  Pencil,
  Boxes,
} from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import {
  PlatformApi,
  BYOK_PROVIDERS,
  type LlmConfig,
  type VisibleModelsConfig,
  type VisibleOpenRouterModel,
  type ModelProvider,
  type ModelProviderInput,
  type ModelDefinition,
  type ModelDefinitionInput,
} from '@shogo-ai/sdk'
import {
  getModelsByProvider,
  AGENT_MODE_DEFAULTS,
  OPENROUTER_MODEL_PREFIX,
  getSubagentOrchestrationReliability,
  type ModelEntry,
} from '@shogo/model-catalog'
import { createHttpClient } from '../../lib/api'
import { usePlatformConfig } from '../../lib/platform-config'
import { invalidateVisibleModelsCache } from '../../lib/visible-models'

// =============================================================================
// Types
// =============================================================================

type AIMode = 'shogo-cloud' | 'api-keys' | 'local-llm'

interface ModelInfo {
  id: string
  name: string
}

const MODE_LABELS: Record<AIMode, string> = {
  'shogo-cloud': 'Shogo Cloud',
  'api-keys': 'API Keys',
  'local-llm': 'Local LLM',
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

        <AgentModelDefaultsCard
          basicModel={cloudBasicModel}
          advancedModel={cloudAdvancedModel}
          defaultMode={defaultMode}
          onBasicChange={setCloudBasicModel}
          onAdvancedChange={setCloudAdvancedModel}
          onDefaultModeChange={setDefaultMode}
        />

        <VisibleModelsCard platform={platform} hasOpenRouterKey={false} />
        <CustomProvidersCard platform={platform} />
        <CustomModelsCard platform={platform} />
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

  const [models, setModels] = useState<ModelInfo[]>([])

  const [baseUrl, setBaseUrl] = useState('')
  const [basicModel, setBasicModel] = useState('')
  const [advancedModel, setAdvancedModel] = useState('')
  const [embeddingModel, setEmbeddingModel] = useState('')
  const [embeddingDims, setEmbeddingDims] = useState('')

  // BYOK provider keys, keyed by provider id. `keyMasks` reflects what the
  // server has on file (read via /api/local/api-keys) and `keyDrafts` holds
  // unsaved input from the admin. We never round-trip the masked value back.
  const [keyMasks, setKeyMasks] = useState<Record<string, string>>({})
  const [keyDrafts, setKeyDrafts] = useState<Record<string, string>>({})

  const [cloudBasicModel, setCloudBasicModel] = useState('')
  const [cloudAdvancedModel, setCloudAdvancedModel] = useState('')
  const [cloudDefaultMode, setCloudDefaultMode] = useState('')

  const [shogoKeyConnected, setShogoKeyConnected] = useState(false)

  const [isLoading, setIsLoading] = useState(true)
  const [isTestingConnection, setIsTestingConnection] = useState(false)
  const [connectionStatus, setConnectionStatus] = useState<'idle' | 'connected' | 'error'>('idle')
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [modelsLoading, setModelsLoading] = useState(false)

  const configLoadedRef = useRef(false)
  const llmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const modelDefaultsTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const platform = useMemo(() => new PlatformApi(createHttpClient()), [])

  const inferMode = useCallback((
    llmCfg: LlmConfig,
    masks: Record<string, string>,
    shogoConnected: boolean,
  ): AIMode | null => {
    if (shogoConnected) return 'shogo-cloud'
    if (llmCfg.LOCAL_LLM_BASE_URL) return 'local-llm'
    if (Object.keys(masks).length > 0) return 'api-keys'
    return null
  }, [])

  const fetchConfig = useCallback(async () => {
    try {
      const [llmCfg, masks, shogoData, agentModels] = await Promise.all([
        platform.getLlmConfig(),
        platform.getProviderKeyMasks(),
        platform.getShogoKeyStatus(),
        platform.getAgentModelDefaults().catch(() => ({ basic: null, advanced: null, defaultMode: null })),
      ])

      setCloudBasicModel(agentModels.basic || '')
      setCloudAdvancedModel(agentModels.advanced || '')
      setCloudDefaultMode(agentModels.defaultMode || '')

      setBaseUrl(llmCfg.LOCAL_LLM_BASE_URL || '')
      setBasicModel(llmCfg.LOCAL_LLM_BASIC_MODEL || '')
      setAdvancedModel(llmCfg.LOCAL_LLM_ADVANCED_MODEL || '')
      setEmbeddingModel(llmCfg.LOCAL_EMBEDDING_MODEL || '')
      setEmbeddingDims(llmCfg.LOCAL_EMBEDDING_DIMENSIONS || '')

      setKeyMasks(masks)

      setShogoKeyConnected(shogoData.connected)

      const storedMode = llmCfg.AI_MODE as AIMode | undefined
      if (storedMode && ['shogo-cloud', 'api-keys', 'local-llm'].includes(storedMode)) {
        setActiveMode(storedMode)
      } else {
        const inferred = inferMode(llmCfg, masks, shogoData.connected)
        setActiveMode(inferred)
        if (inferred) {
          platform.putLlmConfig({ AI_MODE: inferred }).catch(() => {})
        }
      }
      setModeLoaded(true)

      if (llmCfg.LOCAL_LLM_BASE_URL) {
        fetchModels(llmCfg.LOCAL_LLM_BASE_URL)
      }
    } catch (err) {
      console.error('[AdminSettings] Failed to load config:', err)
    } finally {
      setIsLoading(false)
    }
  }, [platform, inferMode])

  useEffect(() => { fetchConfig() }, [fetchConfig])

  const fetchModels = useCallback(async (url?: string) => {
    const targetUrl = url || baseUrl
    if (!targetUrl) return
    setModelsLoading(true)
    try {
      const data = await platform.getLocalModels(targetUrl)
      if (data.ok) {
        setModels(data.models)
        setConnectionStatus('connected')
      } else {
        setModels([])
        setConnectionStatus('error')
      }
    } catch {
      setModels([])
      setConnectionStatus('error')
    } finally {
      setModelsLoading(false)
    }
  }, [baseUrl, platform])

  const handleModeChange = useCallback(async (mode: AIMode) => {
    setActiveMode(mode)
    try {
      await platform.putLlmConfig({ AI_MODE: mode })
    } catch (err) {
      console.error('[AdminSettings] Failed to persist AI_MODE:', err)
    }
  }, [platform])

  const handleTestConnection = async () => {
    setIsTestingConnection(true)
    setConnectionStatus('idle')
    await fetchModels()
    setIsTestingConnection(false)
  }

  // Auto-save local LLM config
  useEffect(() => {
    if (!configLoadedRef.current || activeMode !== 'local-llm') return
    if (llmTimerRef.current) clearTimeout(llmTimerRef.current)
    setSaveStatus('saving')
    llmTimerRef.current = setTimeout(async () => {
      try {
        await platform.putLlmConfig({
          AI_MODE: activeMode,
          LOCAL_LLM_BASE_URL: baseUrl || null,
          LOCAL_LLM_BASIC_MODEL: basicModel || null,
          LOCAL_LLM_ADVANCED_MODEL: advancedModel || null,
          LOCAL_EMBEDDING_MODEL: embeddingModel || null,
          LOCAL_EMBEDDING_DIMENSIONS: embeddingDims || null,
        })
        setSaveStatus('saved')
        setTimeout(() => setSaveStatus('idle'), 2000)
      } catch {
        setSaveStatus('error')
        setTimeout(() => setSaveStatus('idle'), 3000)
      }
    }, 600)
    return () => { if (llmTimerRef.current) clearTimeout(llmTimerRef.current) }
  }, [activeMode, baseUrl, basicModel, advancedModel, embeddingModel, embeddingDims, platform])

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

  const handleProviderKeySave = useCallback(async (providerId: string) => {
    const key = keyDrafts[providerId]
    if (!key) return
    setSaveStatus('saving')
    try {
      await platform.putProviderKeys({ [providerId]: key })
      setKeyMasks((prev) => ({
        ...prev,
        [providerId]: key.slice(0, 8) + '...' + key.slice(-4),
      }))
      setKeyDrafts((prev) => {
        const next = { ...prev }
        delete next[providerId]
        return next
      })
      setSaveStatus('saved')
      setTimeout(() => setSaveStatus('idle'), 2000)
    } catch {
      setSaveStatus('error')
      setTimeout(() => setSaveStatus('idle'), 3000)
    }
  }, [keyDrafts, platform])

  const handleProviderKeyClear = useCallback(async (providerId: string) => {
    setSaveStatus('saving')
    try {
      await platform.putProviderKeys({ [providerId]: null })
      setKeyMasks((prev) => {
        const next = { ...prev }
        delete next[providerId]
        return next
      })
      setKeyDrafts((prev) => {
        const next = { ...prev }
        delete next[providerId]
        return next
      })
      setSaveStatus('saved')
      setTimeout(() => setSaveStatus('idle'), 2000)
    } catch {
      setSaveStatus('error')
      setTimeout(() => setSaveStatus('idle'), 3000)
    }
  }, [platform])

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

          <Pressable
            onPress={() => handleModeChange('local-llm')}
            className={cn(
              'flex-row items-center gap-4 p-4 rounded-xl border',
              activeMode === 'local-llm' ? 'border-primary bg-primary/5' : 'border-border bg-card'
            )}
          >
            <View className={cn(
              'w-10 h-10 rounded-lg items-center justify-center',
              activeMode === 'local-llm' ? 'bg-primary/10' : 'bg-muted'
            )}>
              <Server size={20} className={activeMode === 'local-llm' ? 'text-primary' : 'text-muted-foreground'} />
            </View>
            <View className="flex-1">
              <Text className="text-sm font-semibold text-foreground">Local LLM</Text>
              <Text className="text-xs text-muted-foreground mt-0.5">
                Connect to Ollama, LM Studio, or any OpenAI-compatible server
              </Text>
            </View>
            {activeMode === 'local-llm' && <Check size={18} className="text-primary" />}
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

            <AgentModelDefaultsCard
              basicModel={cloudBasicModel}
              advancedModel={cloudAdvancedModel}
              defaultMode={cloudDefaultMode}
              onBasicChange={setCloudBasicModel}
              onAdvancedChange={setCloudAdvancedModel}
              onDefaultModeChange={setCloudDefaultMode}
            />

            {shogoKeyConnected ? (
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
            ) : (
              <>
                <VisibleModelsCard
                  platform={platform}
                  hasOpenRouterKey={!!keyMasks.openrouter}
                />
                <CustomProvidersCard platform={platform} />
                <CustomModelsCard platform={platform} />
              </>
            )}
          </>
        )}

        {/* ── API Keys config ────────────────────────────────────────── */}
        {activeMode === 'api-keys' && (
          <>
            <ProviderKeysCard
              keyMasks={keyMasks}
              keyDrafts={keyDrafts}
              onDraftChange={(id, val) => setKeyDrafts((prev) => ({ ...prev, [id]: val }))}
              onSave={handleProviderKeySave}
              onClear={handleProviderKeyClear}
            />

            <AgentModelDefaultsCard
              basicModel={cloudBasicModel}
              advancedModel={cloudAdvancedModel}
              defaultMode={cloudDefaultMode}
              onBasicChange={setCloudBasicModel}
              onAdvancedChange={setCloudAdvancedModel}
              onDefaultModeChange={setCloudDefaultMode}
            />

            <VisibleModelsCard
              platform={platform}
              hasOpenRouterKey={!!keyMasks.openrouter}
            />
          </>
        )}

        {/* ── Local LLM config ───────────────────────────────────────── */}
        {activeMode === 'local-llm' && (
          <>
            <SectionCard
              icon={Server}
              title="LLM Provider"
              description="Connect to a local OpenAI-compatible server (Ollama, LM Studio, etc.)"
            >
              <View className="gap-4">
                <FieldGroup label="Base URL">
                  <TextInput
                    value={baseUrl}
                    onChangeText={setBaseUrl}
                    placeholder="http://localhost:11434"
                    className="bg-background border border-border rounded-lg px-3 py-2.5 text-sm text-foreground"
                    placeholderTextColor="#666"
                    autoCapitalize="none"
                    autoCorrect={false}
                  />
                </FieldGroup>

                <View className="flex-row items-center gap-3">
                  <Pressable
                    onPress={handleTestConnection}
                    disabled={isTestingConnection || !baseUrl}
                    className={cn(
                      'flex-row items-center gap-2 px-4 py-2 rounded-lg',
                      !baseUrl ? 'bg-muted opacity-50' : 'bg-primary'
                    )}
                  >
                    {isTestingConnection ? (
                      <ActivityIndicator size="small" color="#fff" />
                    ) : (
                      <Zap size={14} color="#fff" />
                    )}
                    <Text className="text-sm font-medium text-primary-foreground">
                      Test Connection
                    </Text>
                  </Pressable>

                  {connectionStatus === 'connected' && (
                    <View className="flex-row items-center gap-1.5">
                      <CheckCircle size={14} className="text-green-500" />
                      <Text className="text-sm text-green-500">
                        Connected ({models.length} model{models.length !== 1 ? 's' : ''})
                      </Text>
                    </View>
                  )}
                  {connectionStatus === 'error' && (
                    <View className="flex-row items-center gap-1.5">
                      <AlertTriangle size={14} className="text-destructive" />
                      <Text className="text-sm text-destructive">Cannot reach server</Text>
                    </View>
                  )}
                </View>
              </View>
            </SectionCard>

            <SectionCard
              icon={BrainCircuit}
              title="Chat Models"
              description="Select which models to use for basic and advanced agent modes"
            >
              <View className="gap-4">
                <FieldGroup label="Basic Model" hint="Used for quick, lightweight tasks">
                  <ModelSelector
                    value={basicModel}
                    onChange={setBasicModel}
                    models={models}
                    placeholder="e.g. llama3, mistral, gemma2"
                    loading={modelsLoading}
                  />
                </FieldGroup>

                <FieldGroup label="Advanced Model" hint="Used for complex, multi-step tasks">
                  <ModelSelector
                    value={advancedModel}
                    onChange={setAdvancedModel}
                    models={models}
                    placeholder="e.g. qwen2.5:72b, llama3.1:70b"
                    loading={modelsLoading}
                  />
                </FieldGroup>
              </View>
            </SectionCard>

            <SectionCard
              icon={Cpu}
              title="Embedding Model"
              description="Used for file search (RAG). Must support the /v1/embeddings endpoint."
            >
              <View className="gap-4">
                <FieldGroup label="Model" hint="Leave empty to use cloud embeddings (OpenAI)">
                  <ModelSelector
                    value={embeddingModel}
                    onChange={setEmbeddingModel}
                    models={models}
                    placeholder="e.g. nomic-embed-text, mxbai-embed-large"
                    loading={modelsLoading}
                  />
                </FieldGroup>

                <FieldGroup label="Dimensions" hint="Must match the model output (e.g. 768 for nomic-embed-text)">
                  <TextInput
                    value={embeddingDims}
                    onChangeText={setEmbeddingDims}
                    placeholder="768"
                    keyboardType="numeric"
                    className="bg-background border border-border rounded-lg px-3 py-2.5 text-sm text-foreground"
                    placeholderTextColor="#666"
                  />
                </FieldGroup>
              </View>
            </SectionCard>

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

function ModelSelector({
  value,
  onChange,
  models,
  placeholder,
  loading,
}: {
  value: string
  onChange: (v: string) => void
  models: ModelInfo[]
  placeholder: string
  loading: boolean
}) {
  const [showDropdown, setShowDropdown] = useState(false)
  const filteredModels = models.filter(
    (m) => !value || m.id.toLowerCase().includes(value.toLowerCase())
  )

  return (
    <View className="relative">
      <View className="flex-row items-center">
        <TextInput
          value={value}
          onChangeText={(text) => {
            onChange(text)
            if (text && models.length > 0) setShowDropdown(true)
          }}
          onFocus={() => { if (models.length > 0) setShowDropdown(true) }}
          placeholder={placeholder}
          className="flex-1 bg-background border border-border rounded-lg px-3 py-2.5 text-sm text-foreground"
          placeholderTextColor="#666"
          autoCapitalize="none"
          autoCorrect={false}
        />
        {loading && (
          <View className="absolute right-3">
            <ActivityIndicator size="small" />
          </View>
        )}
        {!loading && models.length > 0 && (
          <Pressable
            onPress={() => setShowDropdown(!showDropdown)}
            className="absolute right-2 p-1"
          >
            <ChevronDown size={14} className="text-muted-foreground" />
          </Pressable>
        )}
      </View>

      {showDropdown && filteredModels.length > 0 && (
        <View className="absolute top-12 left-0 right-0 z-50 bg-card border border-border rounded-lg shadow-lg max-h-48 overflow-hidden">
          <ScrollView>
            {filteredModels.map((m) => (
              <Pressable
                key={m.id}
                onPress={() => {
                  onChange(m.id)
                  setShowDropdown(false)
                }}
                className="px-3 py-2.5 border-b border-border/50 active:bg-muted"
              >
                <Text className="text-sm text-foreground">{m.id}</Text>
              </Pressable>
            ))}
          </ScrollView>
        </View>
      )}
    </View>
  )
}

// =============================================================================
// Agent Model Defaults Card (cloud / api-keys modes)
// =============================================================================

const DEFAULT_MODE_OPTIONS = [
  { value: '', label: 'Basic (default)' },
  { value: 'basic', label: 'Basic' },
  { value: 'advanced', label: 'Advanced' },
  { value: 'auto', label: 'Auto' },
] as const

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
  const modelGroups = useMemo(() => getModelsByProvider(), [])

  return (
    <View className="bg-card border border-border rounded-xl">
      <View className="px-5 py-4 border-b border-border">
        <View className="flex-row items-center gap-2.5 mb-1">
          <BrainCircuit size={16} className="text-foreground" />
          <Text className="text-base font-semibold text-foreground">Model Defaults</Text>
        </View>
        <Text className="text-xs text-muted-foreground">
          Choose which models power the Basic and Advanced agent modes for all users
        </Text>
      </View>
      <View className="px-5 py-4 gap-4" style={{ zIndex: 10 }}>
        <View style={{ zIndex: 30 }}>
          <FieldGroup label="Default Mode" hint="Which agent mode new chats start in. Auto routes to the cheapest capable model per turn.">
            <View className="flex-row gap-2">
              {DEFAULT_MODE_OPTIONS.map((opt) => (
                <Pressable
                  key={opt.value}
                  onPress={() => onDefaultModeChange(opt.value)}
                  className={`px-3 py-1.5 rounded-lg border ${
                    defaultMode === opt.value
                      ? 'border-primary bg-primary/10'
                      : 'border-border bg-background'
                  }`}
                >
                  <Text className={`text-sm ${
                    defaultMode === opt.value ? 'text-primary font-medium' : 'text-foreground'
                  }`}>
                    {opt.label}
                  </Text>
                </Pressable>
              ))}
            </View>
          </FieldGroup>
        </View>

        <View style={{ zIndex: 20 }}>
          <FieldGroup label="Basic Mode" hint="Economy-tier model for quick, lightweight tasks">
            <CatalogModelSelector
              value={basicModel}
              onChange={onBasicChange}
              modelGroups={modelGroups}
              placeholder={AGENT_MODE_DEFAULTS.basic}
            />
          </FieldGroup>
        </View>

        <View style={{ zIndex: 10 }}>
          <FieldGroup label="Advanced Mode" hint="Higher-capability model for complex, multi-step tasks">
            <CatalogModelSelector
              value={advancedModel}
              onChange={onAdvancedChange}
              modelGroups={modelGroups}
              placeholder={AGENT_MODE_DEFAULTS.advanced}
            />
          </FieldGroup>
        </View>
      </View>
    </View>
  )
}

function CatalogModelSelector({
  value,
  onChange,
  modelGroups,
  placeholder,
}: {
  value: string
  onChange: (v: string) => void
  modelGroups: Array<{ label: string; models: ModelEntry[] }>
  placeholder: string
}) {
  const [showDropdown, setShowDropdown] = useState(false)

  const tierBadge = (tier: string) => {
    const colors: Record<string, string> = {
      economy: 'bg-emerald-500/10 text-emerald-600',
      standard: 'bg-blue-500/10 text-blue-600',
      premium: 'bg-purple-500/10 text-purple-600',
    }
    return colors[tier] || 'bg-muted text-muted-foreground'
  }

  return (
    <View style={{ position: 'relative', zIndex: showDropdown ? 100 : 1 }}>
      <Pressable
        onPress={() => setShowDropdown(!showDropdown)}
        className="flex-row items-center justify-between bg-background border border-border rounded-lg px-3 py-2.5"
      >
        <Text className={cn('text-sm', value ? 'text-foreground' : 'text-muted-foreground')}>
          {value || `Platform default (${placeholder})`}
        </Text>
        <ChevronDown size={14} className="text-muted-foreground" />
      </Pressable>

      {showDropdown && (
        <View
          className="bg-card border border-border rounded-lg shadow-lg max-h-64 overflow-hidden"
          style={{ position: 'absolute', top: 48, left: 0, right: 0, zIndex: 999 }}
        >
          <ScrollView>
            <Pressable
              onPress={() => { onChange(''); setShowDropdown(false) }}
              className={cn(
                'px-3 py-2.5 border-b border-border/50 active:bg-muted',
                !value && 'bg-primary/5'
              )}
            >
              <Text className="text-sm text-muted-foreground italic">
                Platform default ({placeholder})
              </Text>
            </Pressable>
            {modelGroups.map((group) => (
              <View key={group.label}>
                <View className="px-3 py-1.5 bg-muted/50">
                  <Text className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                    {group.label}
                  </Text>
                </View>
                {group.models.map((m) => (
                  <Pressable
                    key={m.id}
                    onPress={() => { onChange(m.id); setShowDropdown(false) }}
                    className={cn(
                      'flex-row items-center justify-between px-3 py-2.5 border-b border-border/50 active:bg-muted',
                      value === m.id && 'bg-primary/5'
                    )}
                  >
                    <Text className="text-sm text-foreground">{m.displayName}</Text>
                    <View className={cn('px-1.5 py-0.5 rounded', tierBadge(m.tier))}>
                      <Text className="text-[10px] font-medium capitalize">{m.tier}</Text>
                    </View>
                  </Pressable>
                ))}
              </View>
            ))}
          </ScrollView>
        </View>
      )}
    </View>
  )
}

// =============================================================================
// Provider Keys Card — generic BYOK key form, driven by `BYOK_PROVIDERS`.
// =============================================================================

function ProviderKeysCard({
  keyMasks,
  keyDrafts,
  onDraftChange,
  onSave,
  onClear,
}: {
  keyMasks: Record<string, string>
  keyDrafts: Record<string, string>
  onDraftChange: (providerId: string, value: string) => void
  onSave: (providerId: string) => void
  onClear: (providerId: string) => void
}) {
  return (
    <SectionCard
      icon={Key}
      title="Provider API Keys"
      description="Bring your own keys for any of these providers. Models that need a key will only show up to users once it's configured."
    >
      <View className="gap-5">
        {BYOK_PROVIDERS.map((provider) => {
          const mask = keyMasks[provider.id]
          const draft = keyDrafts[provider.id] ?? ''
          return (
            <View key={provider.id} className="gap-1.5">
              <View className="flex-row items-center justify-between">
                <Text className="text-sm font-medium text-foreground">{provider.name}</Text>
                {mask ? (
                  <View className="flex-row items-center gap-1.5">
                    <View className="h-2 w-2 rounded-full bg-green-500" />
                    <Text className="text-xs text-muted-foreground">{mask}</Text>
                    <Pressable
                      onPress={() => onClear(provider.id)}
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
                onChangeText={(text) => onDraftChange(provider.id, text)}
                onBlur={() => { if (draft) onSave(provider.id) }}
                onSubmitEditing={() => { if (draft) onSave(provider.id) }}
                placeholder={mask ? 'Enter new key to replace' : `${provider.name} API key`}
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
    </SectionCard>
  )
}

// =============================================================================
// Visible Models Card — admin allowlist for the user-facing model picker.
// =============================================================================

interface OpenRouterCatalogEntry {
  id: string
  name: string
  description?: string
  contextLength?: number
  /** Per-token USD rates straight from OpenRouter. `cacheRead` /
   *  `cacheWrite` only present for models that surface cache pricing. */
  pricing?: {
    prompt?: number
    completion?: number
    cacheRead?: number
    cacheWrite?: number
  }
}

/** Format a per-token rate as `$X.YZ/M` (per million tokens). */
function fmtPerMillion(perToken?: number): string | null {
  if (typeof perToken !== 'number' || !Number.isFinite(perToken) || perToken <= 0) return null
  const perMillion = perToken * 1_000_000
  if (perMillion < 0.01) return `$${perMillion.toFixed(4)}/M`
  if (perMillion < 1) return `$${perMillion.toFixed(2)}/M`
  return `$${perMillion.toFixed(2)}/M`
}

// ---------------------------------------------------------------------------
// Custom providers (third-party OpenAI/Anthropic-compatible endpoints, e.g.
// MiMo). The API key is write-only: reads return only a mask.
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
          Third-party OpenAI-compatible endpoints (e.g. MiMo). Keys are encrypted at rest and never shown again.
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
                    placeholder="MiMo"
                    placeholderTextColor="#9ca3af"
                    className="px-3 py-2 rounded-md border border-border bg-background text-foreground text-sm"
                  />
                </View>
                <View>
                  <FieldLabel>Base URL</FieldLabel>
                  <TextInput
                    value={form.baseUrl}
                    onChangeText={(t) => setForm((f) => ({ ...f, baseUrl: t }))}
                    placeholder="https://api.xiaomimimo.com/v1"
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

// ---------------------------------------------------------------------------
// Custom models (DB-defined models, native or backed by a custom provider).
// ---------------------------------------------------------------------------

const MODEL_TIER_OPTIONS = ['economy', 'standard', 'premium'] as const
const MODEL_FAMILY_OPTIONS = ['opus', 'sonnet', 'haiku', 'gpt', 'other'] as const
const MODEL_GENERATION_OPTIONS = ['current', 'legacy'] as const
const NATIVE_PROVIDER_OPTIONS = ['anthropic', 'openai', 'google', 'openrouter', 'local'] as const

interface ModelFormState {
  id: string
  provider: string
  providerId: string
  apiModel: string
  displayName: string
  shortDisplayName: string
  tier: 'economy' | 'standard' | 'premium'
  family: 'opus' | 'sonnet' | 'haiku' | 'gpt' | 'other'
  generation: 'current' | 'legacy'
  maxOutputTokens: string
  aliases: string
  inputPerMillion: string
  cachedInputPerMillion: string
  cacheWritePerMillion: string
  outputPerMillion: string
  enabled: boolean
}

const EMPTY_MODEL_FORM: ModelFormState = {
  id: '',
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
  inputPerMillion: '0',
  cachedInputPerMillion: '0',
  cacheWritePerMillion: '0',
  outputPerMillion: '0',
  enabled: true,
}

function CustomModelsCard({ platform }: { platform: PlatformApi }) {
  const [models, setModels] = useState<ModelDefinition[]>([])
  const [providers, setProviders] = useState<ModelProvider[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState<ModelFormState>(EMPTY_MODEL_FORM)

  const reload = useCallback(async () => {
    try {
      const [list, provs] = await Promise.all([platform.listModels(), platform.listModelProviders()])
      setModels(list)
      setProviders(provs)
      setError(null)
    } catch (err: any) {
      setError(err?.message || 'Failed to load models')
    } finally {
      setIsLoading(false)
    }
  }, [platform])

  useEffect(() => { reload() }, [reload])

  const openCreate = useCallback(() => {
    setEditingId(null)
    setForm(EMPTY_MODEL_FORM)
    setShowForm(true)
  }, [])

  const openEdit = useCallback((m: ModelDefinition) => {
    setEditingId(m.id)
    setForm({
      id: m.id,
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
      inputPerMillion: String(m.inputPerMillion),
      cachedInputPerMillion: String(m.cachedInputPerMillion),
      cacheWritePerMillion: String(m.cacheWritePerMillion),
      outputPerMillion: String(m.outputPerMillion),
      enabled: m.enabled,
    })
    setShowForm(true)
  }, [])

  const submit = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      const num = (s: string) => {
        const n = Number(s)
        return Number.isFinite(n) && n >= 0 ? n : 0
      }
      const payload: ModelDefinitionInput = {
        provider: form.provider,
        providerId: form.provider === 'custom' ? (form.providerId || null) : null,
        apiModel: form.apiModel.trim(),
        displayName: form.displayName.trim(),
        shortDisplayName: form.shortDisplayName.trim() || form.displayName.trim(),
        tier: form.tier,
        family: form.family,
        generation: form.generation,
        maxOutputTokens: num(form.maxOutputTokens) || 64000,
        aliases: form.aliases.split(',').map((a) => a.trim()).filter(Boolean),
        inputPerMillion: num(form.inputPerMillion),
        cachedInputPerMillion: num(form.cachedInputPerMillion),
        cacheWritePerMillion: num(form.cacheWritePerMillion),
        outputPerMillion: num(form.outputPerMillion),
        enabled: form.enabled,
      }
      if (editingId) {
        await platform.updateModel(editingId, payload)
      } else {
        await platform.createModel({ ...payload, id: form.id.trim() })
      }
      invalidateVisibleModelsCache()
      setShowForm(false)
      setForm(EMPTY_MODEL_FORM)
      setEditingId(null)
      await reload()
    } catch (err: any) {
      setError(err?.message || 'Failed to save model')
    } finally {
      setBusy(false)
    }
  }, [form, editingId, platform, reload])

  const remove = useCallback(async (id: string) => {
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
  }, [platform, reload])

  const providerOptions = useMemo(
    () => [...NATIVE_PROVIDER_OPTIONS, 'custom'] as const,
    [],
  )
  const canSubmit =
    (editingId || form.id.trim()) &&
    form.apiModel.trim() &&
    form.displayName.trim() &&
    (form.provider !== 'custom' || form.providerId)

  return (
    <View className="bg-card border border-border rounded-xl">
      <View className="px-5 py-4 border-b border-border">
        <View className="flex-row items-center justify-between">
          <View className="flex-row items-center gap-2.5 flex-1">
            <Boxes size={16} className="text-foreground" />
            <Text className="text-base font-semibold text-foreground">Custom Models</Text>
          </View>
          {!showForm && (
            <Pressable onPress={openCreate} className="flex-row items-center gap-1 px-2.5 py-1.5 rounded-md border border-border bg-background">
              <Plus size={14} className="text-foreground" />
              <Text className="text-xs text-foreground">Add</Text>
            </Pressable>
          )}
        </View>
        <Text className="text-xs text-muted-foreground mt-1">
          Add new models without a release. Set the id, display name, pricing, and routing here.
        </Text>
      </View>

      <View className="px-5 py-4 gap-3">
        {error && <Text className="text-xs text-red-500">{error}</Text>}
        {isLoading ? (
          <ActivityIndicator size="small" />
        ) : (
          <>
            {models.length === 0 && !showForm && (
              <Text className="text-xs text-muted-foreground">No DB-defined models yet.</Text>
            )}
            {models.map((m) => (
              <View key={m.id} className="px-3 py-2.5 rounded-lg border border-border bg-background">
                <View className="flex-row items-center justify-between">
                  <View className="flex-1">
                    <View className="flex-row items-center gap-2">
                      <Text className="text-sm font-medium text-foreground">{m.displayName}</Text>
                      {!m.enabled && <Text className="text-[10px] text-muted-foreground">(disabled)</Text>}
                    </View>
                    <Text className="text-xs text-muted-foreground mt-0.5">
                      {m.id} · {m.provider}{m.provider === 'custom' && m.providerId ? `→${providers.find((p) => p.id === m.providerId)?.label ?? m.providerId}` : ''} · {m.tier}
                    </Text>
                    <Text className="text-[11px] text-muted-foreground mt-0.5">
                      in ${m.inputPerMillion}/M · out ${m.outputPerMillion}/M · {m.maxOutputTokens} max
                    </Text>
                  </View>
                  <View className="flex-row items-center gap-1.5">
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

            {showForm && (
              <View className="px-3 py-3 rounded-lg border border-primary/40 bg-primary/5 gap-3">
                <View className="flex-row items-center justify-between">
                  <Text className="text-sm font-semibold text-foreground">{editingId ? 'Edit model' : 'New model'}</Text>
                  <Pressable onPress={() => { setShowForm(false); setEditingId(null) }} className="p-1">
                    <X size={16} className="text-muted-foreground" />
                  </Pressable>
                </View>

                {!editingId && (
                  <View>
                    <FieldLabel>Model id (canonical)</FieldLabel>
                    <TextInput
                      value={form.id}
                      onChangeText={(t) => setForm((f) => ({ ...f, id: t }))}
                      placeholder="mimo-v2.5"
                      placeholderTextColor="#9ca3af"
                      autoCapitalize="none"
                      className="px-3 py-2 rounded-md border border-border bg-background text-foreground text-sm"
                    />
                  </View>
                )}

                <View>
                  <FieldLabel>Provider</FieldLabel>
                  <View className="flex-row flex-wrap gap-1.5">
                    {providerOptions.map((opt) => (
                      <Pressable
                        key={opt}
                        onPress={() => setForm((f) => ({ ...f, provider: opt }))}
                        className={cn('px-3 py-1.5 rounded-md border', form.provider === opt ? 'border-primary bg-primary/10' : 'border-border bg-background')}
                      >
                        <Text className={cn('text-xs', form.provider === opt ? 'text-primary font-medium' : 'text-muted-foreground')}>{opt}</Text>
                      </Pressable>
                    ))}
                  </View>
                </View>

                {form.provider === 'custom' && (
                  <View>
                    <FieldLabel>Custom provider</FieldLabel>
                    {providers.length === 0 ? (
                      <Text className="text-xs text-amber-500">Create a custom provider first.</Text>
                    ) : (
                      <View className="flex-row flex-wrap gap-1.5">
                        {providers.map((p) => (
                          <Pressable
                            key={p.id}
                            onPress={() => setForm((f) => ({ ...f, providerId: p.id }))}
                            className={cn('px-3 py-1.5 rounded-md border', form.providerId === p.id ? 'border-primary bg-primary/10' : 'border-border bg-background')}
                          >
                            <Text className={cn('text-xs', form.providerId === p.id ? 'text-primary font-medium' : 'text-muted-foreground')}>{p.label}</Text>
                          </Pressable>
                        ))}
                      </View>
                    )}
                  </View>
                )}

                <View>
                  <FieldLabel>Upstream api model</FieldLabel>
                  <TextInput
                    value={form.apiModel}
                    onChangeText={(t) => setForm((f) => ({ ...f, apiModel: t }))}
                    placeholder="mimo-v2.5"
                    placeholderTextColor="#9ca3af"
                    autoCapitalize="none"
                    className="px-3 py-2 rounded-md border border-border bg-background text-foreground text-sm"
                  />
                </View>

                <View className="flex-row gap-2">
                  <View className="flex-1">
                    <FieldLabel>Display name</FieldLabel>
                    <TextInput
                      value={form.displayName}
                      onChangeText={(t) => setForm((f) => ({ ...f, displayName: t }))}
                      placeholder="MiMo v2.5"
                      placeholderTextColor="#9ca3af"
                      className="px-3 py-2 rounded-md border border-border bg-background text-foreground text-sm"
                    />
                  </View>
                  <View className="flex-1">
                    <FieldLabel>Short name</FieldLabel>
                    <TextInput
                      value={form.shortDisplayName}
                      onChangeText={(t) => setForm((f) => ({ ...f, shortDisplayName: t }))}
                      placeholder="MiMo 2.5"
                      placeholderTextColor="#9ca3af"
                      className="px-3 py-2 rounded-md border border-border bg-background text-foreground text-sm"
                    />
                  </View>
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
                    <FieldLabel>Aliases (comma-sep)</FieldLabel>
                    <TextInput
                      value={form.aliases}
                      onChangeText={(t) => setForm((f) => ({ ...f, aliases: t }))}
                      placeholder="mimo, mimo-2.5"
                      placeholderTextColor="#9ca3af"
                      autoCapitalize="none"
                      className="px-3 py-2 rounded-md border border-border bg-background text-foreground text-sm"
                    />
                  </View>
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
                      {editingId ? 'Save changes' : 'Create model'}
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

function VisibleModelsCard({
  platform,
  hasOpenRouterKey,
}: {
  platform: PlatformApi
  hasOpenRouterKey: boolean
}) {
  const [config, setConfig] = useState<VisibleModelsConfig>({ catalogIds: null, openrouterModels: [] })
  const [isLoading, setIsLoading] = useState(true)
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [orCatalog, setOrCatalog] = useState<OpenRouterCatalogEntry[]>([])
  const [orLoading, setOrLoading] = useState(false)
  const [orError, setOrError] = useState<string | null>(null)
  const [orSearch, setOrSearch] = useState('')
  const [orPickerOpen, setOrPickerOpen] = useState(false)
  const loadedRef = useRef(false)
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    platform
      .getVisibleModelsConfig()
      .then((data) => setConfig({
        catalogIds: data.catalogIds === null ? null : (data.catalogIds ?? null),
        openrouterModels: data.openrouterModels ?? [],
      }))
      .catch(() => { /* default state stays */ })
      .finally(() => setIsLoading(false))
  }, [platform])

  useEffect(() => {
    if (!loadedRef.current) return
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    setSaveStatus('saving')
    saveTimerRef.current = setTimeout(async () => {
      try {
        await platform.putVisibleModelsConfig(config)
        invalidateVisibleModelsCache()
        setSaveStatus('saved')
        setTimeout(() => setSaveStatus('idle'), 2000)
      } catch {
        setSaveStatus('error')
        setTimeout(() => setSaveStatus('idle'), 3000)
      }
    }, 600)
    return () => { if (saveTimerRef.current) clearTimeout(saveTimerRef.current) }
  }, [config, platform])

  useEffect(() => {
    if (!isLoading) loadedRef.current = true
  }, [isLoading])

  const showAllCatalog = config.catalogIds === null
  const allowedCatalogSet = useMemo(
    () => new Set(showAllCatalog ? [] : config.catalogIds ?? []),
    [config.catalogIds, showAllCatalog],
  )
  const modelGroups = useMemo(() => getModelsByProvider(), [])

  const toggleShowAll = useCallback((next: boolean) => {
    setConfig((prev) => ({
      ...prev,
      catalogIds: next ? null : modelGroups.flatMap((g) => g.models.map((m) => m.id)),
    }))
  }, [modelGroups])

  const toggleCatalogModel = useCallback((id: string) => {
    setConfig((prev) => {
      const current = prev.catalogIds ?? modelGroups.flatMap((g) => g.models.map((m) => m.id))
      const next = current.includes(id)
        ? current.filter((x) => x !== id)
        : [...current, id]
      return { ...prev, catalogIds: next }
    })
  }, [modelGroups])

  const removeOpenRouterModel = useCallback((id: string) => {
    setConfig((prev) => ({
      ...prev,
      openrouterModels: prev.openrouterModels.filter((m) => m.id !== id),
    }))
  }, [])

  const addOpenRouterModel = useCallback((entry: OpenRouterCatalogEntry) => {
    const id = `${OPENROUTER_MODEL_PREFIX}${entry.id}`
    setConfig((prev) => {
      if (prev.openrouterModels.some((m) => m.id === id)) return prev
      // Snapshot pricing at allowlist time so the eval cost calculator and
      // any UI billing surface have authoritative numbers without re-fetching.
      const pricing: VisibleOpenRouterModel['pricing'] = entry.pricing
        ? {
            promptPerToken: entry.pricing.prompt,
            completionPerToken: entry.pricing.completion,
            cacheReadPerToken: entry.pricing.cacheRead,
            cacheWritePerToken: entry.pricing.cacheWrite,
          }
        : undefined
      const next: VisibleOpenRouterModel = {
        id,
        displayName: entry.name,
        contextLength: entry.contextLength,
        pricing,
      }
      return { ...prev, openrouterModels: [...prev.openrouterModels, next] }
    })
  }, [])

  const loadOpenRouterCatalog = useCallback(async () => {
    setOrLoading(true)
    setOrError(null)
    try {
      const res = await platform.getOpenRouterModels()
      if (res.ok) {
        setOrCatalog(res.models)
      } else {
        setOrError(res.error || 'Failed to fetch OpenRouter models')
      }
    } catch (err: any) {
      setOrError(err?.message || 'Failed to fetch OpenRouter models')
    } finally {
      setOrLoading(false)
    }
  }, [platform])

  useEffect(() => {
    if (orPickerOpen && hasOpenRouterKey && orCatalog.length === 0 && !orLoading) {
      loadOpenRouterCatalog()
    }
  }, [orPickerOpen, hasOpenRouterKey, orCatalog.length, orLoading, loadOpenRouterCatalog])

  const orFiltered = useMemo(() => {
    const q = orSearch.trim().toLowerCase()
    const existingIds = new Set(config.openrouterModels.map((m) => m.id))
    return orCatalog
      .filter((m) => !existingIds.has(`${OPENROUTER_MODEL_PREFIX}${m.id}`))
      .filter((m) =>
        !q
          || m.id.toLowerCase().includes(q)
          || m.name.toLowerCase().includes(q)
          || (m.description?.toLowerCase() || '').includes(q),
      )
      .slice(0, 100)
  }, [orCatalog, orSearch, config.openrouterModels])

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
          <AutoSaveIndicator status={saveStatus} />
        </View>
        <Text className="text-xs text-muted-foreground">
          Choose which models show up in the user-facing model picker. Defaults to all current-generation catalog models.
        </Text>
      </View>

      <View className="px-5 py-4 gap-5">
        {/* Show-all toggle */}
        <Pressable
          onPress={() => toggleShowAll(!showAllCatalog)}
          className={cn(
            'flex-row items-center justify-between p-3 rounded-lg border',
            showAllCatalog ? 'border-primary bg-primary/5' : 'border-border bg-background',
          )}
        >
          <View className="flex-1">
            <Text className="text-sm font-medium text-foreground">Show all catalog models</Text>
            <Text className="text-xs text-muted-foreground mt-0.5">
              When on, every current-generation model is available regardless of the checkboxes below.
            </Text>
          </View>
          {showAllCatalog && <Check size={18} className="text-primary" />}
        </Pressable>

        {/* Catalog allowlist */}
        <View className="gap-3">
          {modelGroups.map((group) => (
            <View key={group.label} className="gap-1.5">
              <Text className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                {group.label}
              </Text>
              {group.models.map((m) => {
                const checked = showAllCatalog || allowedCatalogSet.has(m.id)
                const subagentReliability = getSubagentOrchestrationReliability(m.id)
                const subagentWarning = subagentReliability === 'flaky' || subagentReliability === 'unsupported'
                return (
                  <Pressable
                    key={m.id}
                    onPress={() => !showAllCatalog && toggleCatalogModel(m.id)}
                    disabled={showAllCatalog}
                    className={cn(
                      'px-3 py-2 rounded-lg border',
                      checked && !showAllCatalog ? 'border-primary/50 bg-primary/5' : 'border-border bg-background',
                      showAllCatalog && 'opacity-60',
                    )}
                  >
                    <View className="flex-row items-center justify-between">
                      <View className="flex-row items-center gap-2 flex-1">
                        <View
                          className={cn(
                            'w-4 h-4 rounded border items-center justify-center',
                            checked ? 'border-primary bg-primary' : 'border-border',
                          )}
                        >
                          {checked && <Check size={11} color="#fff" />}
                        </View>
                        <Text className="text-sm text-foreground">{m.displayName}</Text>
                      </View>
                      <Text className="text-[11px] text-muted-foreground capitalize">{m.tier}</Text>
                    </View>
                    {subagentWarning && (
                      <View className="flex-row items-center gap-1.5 mt-1.5 ml-6">
                        <AlertTriangle size={11} className="text-amber-500" />
                        <Text className="text-[11px] text-amber-600 flex-1">
                          {subagentReliability === 'unsupported'
                            ? 'Does not orchestrate subagents — multi-agent canvas builds will not work.'
                            : 'Subagent orchestration is flaky on this model — verify before relying on multi-agent flows.'}
                        </Text>
                      </View>
                    )}
                  </Pressable>
                )
              })}
            </View>
          ))}
        </View>

        {/* OpenRouter models */}
        <View className="gap-2 pt-2 border-t border-border">
          <View className="flex-row items-center justify-between">
            <View className="flex-1">
              <Text className="text-sm font-medium text-foreground">OpenRouter Models</Text>
              <Text className="text-xs text-muted-foreground mt-0.5">
                Curate models from OpenRouter to surface in the picker.
              </Text>
            </View>
            <Pressable
              onPress={() => setOrPickerOpen((v) => !v)}
              disabled={!hasOpenRouterKey}
              className={cn(
                'flex-row items-center gap-1.5 px-3 py-1.5 rounded-lg',
                hasOpenRouterKey ? 'bg-primary' : 'bg-muted opacity-50',
              )}
            >
              <Plus size={12} color="#fff" />
              <Text className="text-xs font-medium text-primary-foreground">
                {orPickerOpen ? 'Hide' : 'Add'}
              </Text>
            </Pressable>
          </View>

          {!hasOpenRouterKey && (
            <View className="flex-row items-center gap-2 p-3 rounded-lg bg-amber-500/10">
              <AlertTriangle size={14} className="text-amber-500" />
              <Text className="text-xs text-foreground flex-1">
                Configure an OpenRouter API key above to browse OpenRouter's model list.
              </Text>
            </View>
          )}

          {hasOpenRouterKey && (
            <View className="flex-row items-start gap-2 p-3 rounded-lg bg-muted/40">
              <AlertTriangle size={14} className="text-amber-500 mt-0.5" />
              <Text className="text-[11px] text-muted-foreground flex-1">
                OpenRouter models are unrated for subagent orchestration. Smaller models often skip
                <Text className="font-mono"> agent_result</Text> after spawning children, which stalls
                multi-agent canvas builds. Verify with the subagent-smoke eval before relying on it.
              </Text>
            </View>
          )}

          {config.openrouterModels.length > 0 && (
            <View className="gap-1.5">
              {config.openrouterModels.map((m) => {
                const inPrice = fmtPerMillion(m.pricing?.promptPerToken)
                const outPrice = fmtPerMillion(m.pricing?.completionPerToken)
                return (
                  <View
                    key={m.id}
                    className="flex-row items-center justify-between px-3 py-2 rounded-lg border border-border bg-background"
                  >
                    <View className="flex-1">
                      <Text className="text-sm text-foreground">{m.displayName}</Text>
                      <Text className="text-[11px] text-muted-foreground" numberOfLines={1}>
                        {m.id}
                        {m.contextLength ? ` · ${(m.contextLength / 1000).toFixed(0)}k ctx` : ''}
                        {inPrice && outPrice ? ` · in ${inPrice} · out ${outPrice}` : ''}
                      </Text>
                    </View>
                    <Pressable onPress={() => removeOpenRouterModel(m.id)} className="p-1.5">
                      <X size={14} className="text-muted-foreground" />
                    </Pressable>
                  </View>
                )
              })}
            </View>
          )}

          {orPickerOpen && hasOpenRouterKey && (
            <View className="gap-2 mt-2 p-3 rounded-lg border border-border bg-background">
              <View className="flex-row items-center gap-2">
                <Search size={12} className="text-muted-foreground" />
                <TextInput
                  value={orSearch}
                  onChangeText={setOrSearch}
                  placeholder="Search OpenRouter models..."
                  placeholderTextColor="#666"
                  className="flex-1 text-sm text-foreground"
                  autoCapitalize="none"
                  autoCorrect={false}
                />
                {orLoading && <ActivityIndicator size="small" />}
              </View>
              {orError && (
                <Text className="text-xs text-destructive">{orError}</Text>
              )}
              {!orLoading && !orError && orFiltered.length === 0 && (
                <Text className="text-xs text-muted-foreground">
                  {orSearch ? 'No models match your search.' : 'No more models to add.'}
                </Text>
              )}
              <ScrollView style={{ maxHeight: 240 }} nestedScrollEnabled>
                {orFiltered.map((m) => {
                  const inPrice = fmtPerMillion(m.pricing?.prompt)
                  const outPrice = fmtPerMillion(m.pricing?.completion)
                  return (
                    <Pressable
                      key={m.id}
                      onPress={() => addOpenRouterModel(m)}
                      className="flex-row items-start justify-between px-2 py-2 rounded active:bg-muted"
                    >
                      <View className="flex-1">
                        <Text className="text-sm text-foreground">{m.name}</Text>
                        <Text className="text-[11px] text-muted-foreground" numberOfLines={1}>
                          {m.id}
                          {m.contextLength ? ` · ${(m.contextLength / 1000).toFixed(0)}k ctx` : ''}
                          {inPrice && outPrice ? ` · in ${inPrice} · out ${outPrice}` : ''}
                        </Text>
                      </View>
                      <Plus size={14} className="text-muted-foreground" />
                    </Pressable>
                  )
                })}
              </ScrollView>
            </View>
          )}
        </View>
      </View>
    </View>
  )
}
