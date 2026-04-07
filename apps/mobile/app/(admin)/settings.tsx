// SPDX-License-Identifier: AGPL-3.0-or-later
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
} from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import { PlatformApi, type LlmConfig } from '@shogo-ai/sdk'
import { getModelsByProvider, AGENT_MODE_DEFAULTS, type ModelEntry } from '@shogo/model-catalog'
import { createHttpClient } from '../../lib/api'
import { usePlatformConfig } from '../../lib/platform-config'

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
  const [isLoading, setIsLoading] = useState(true)
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const loadedRef = useRef(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const platform = useMemo(() => new PlatformApi(createHttpClient()), [])

  useEffect(() => {
    platform.getAgentModelDefaults()
      .then((data: { basic: string | null; advanced: string | null }) => {
        setCloudBasicModel(data.basic || '')
        setCloudAdvancedModel(data.advanced || '')
        loadedRef.current = true
      })
      .catch(() => { loadedRef.current = true })
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
        })
        setSaveStatus('saved')
        setTimeout(() => setSaveStatus('idle'), 2000)
      } catch {
        setSaveStatus('error')
        setTimeout(() => setSaveStatus('idle'), 3000)
      }
    }, 600)
    return () => { if (timerRef.current) clearTimeout(timerRef.current) }
  }, [cloudBasicModel, cloudAdvancedModel, platform])

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
          onBasicChange={setCloudBasicModel}
          onAdvancedChange={setCloudAdvancedModel}
        />
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

  const [anthropicKey, setAnthropicKey] = useState('')
  const [openaiKey, setOpenaiKey] = useState('')
  const [anthropicMask, setAnthropicMask] = useState('')
  const [openaiMask, setOpenaiMask] = useState('')

  const [cloudBasicModel, setCloudBasicModel] = useState('')
  const [cloudAdvancedModel, setCloudAdvancedModel] = useState('')

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
    keyMasks: Record<string, string>,
    shogoConnected: boolean,
  ): AIMode | null => {
    if (shogoConnected) return 'shogo-cloud'
    if (llmCfg.LOCAL_LLM_BASE_URL) return 'local-llm'
    if (keyMasks.ANTHROPIC_API_KEY || keyMasks.OPENAI_API_KEY) return 'api-keys'
    return null
  }, [])

  const fetchConfig = useCallback(async () => {
    try {
      const [llmCfg, keyMasks, shogoData, agentModels] = await Promise.all([
        platform.getLlmConfig(),
        platform.getProviderKeyMasks(),
        platform.getShogoKeyStatus(),
        platform.getAgentModelDefaults().catch(() => ({ basic: null, advanced: null })),
      ])

      setCloudBasicModel(agentModels.basic || '')
      setCloudAdvancedModel(agentModels.advanced || '')

      setBaseUrl(llmCfg.LOCAL_LLM_BASE_URL || '')
      setBasicModel(llmCfg.LOCAL_LLM_BASIC_MODEL || '')
      setAdvancedModel(llmCfg.LOCAL_LLM_ADVANCED_MODEL || '')
      setEmbeddingModel(llmCfg.LOCAL_EMBEDDING_MODEL || '')
      setEmbeddingDims(llmCfg.LOCAL_EMBEDDING_DIMENSIONS || '')

      if (keyMasks.ANTHROPIC_API_KEY) setAnthropicMask(keyMasks.ANTHROPIC_API_KEY)
      if (keyMasks.OPENAI_API_KEY) setOpenaiMask(keyMasks.OPENAI_API_KEY)

      setShogoKeyConnected(shogoData.connected)

      const storedMode = llmCfg.AI_MODE as AIMode | undefined
      if (storedMode && ['shogo-cloud', 'api-keys', 'local-llm'].includes(storedMode)) {
        setActiveMode(storedMode)
      } else {
        const inferred = inferMode(llmCfg, keyMasks, shogoData.connected)
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
      configLoadedRef.current = true
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
        })
        setSaveStatus('saved')
        setTimeout(() => setSaveStatus('idle'), 2000)
      } catch {
        setSaveStatus('error')
        setTimeout(() => setSaveStatus('idle'), 3000)
      }
    }, 600)
    return () => { if (modelDefaultsTimerRef.current) clearTimeout(modelDefaultsTimerRef.current) }
  }, [activeMode, cloudBasicModel, cloudAdvancedModel, platform])

  const handleApiKeyBlur = useCallback(async (provider: 'anthropic' | 'openai') => {
    const key = provider === 'anthropic' ? anthropicKey : openaiKey
    if (!key) return
    setSaveStatus('saving')
    try {
      await platform.putProviderKeys(
        provider === 'anthropic' ? { anthropicApiKey: key } : { openaiApiKey: key },
      )
      if (provider === 'anthropic') {
        setAnthropicMask(key.slice(0, 8) + '...' + key.slice(-4))
        setAnthropicKey('')
      } else {
        setOpenaiMask(key.slice(0, 8) + '...' + key.slice(-4))
        setOpenaiKey('')
      }
      setSaveStatus('saved')
      setTimeout(() => setSaveStatus('idle'), 2000)
    } catch {
      setSaveStatus('error')
      setTimeout(() => setSaveStatus('idle'), 3000)
    }
  }, [anthropicKey, openaiKey, platform])

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
                Use cloud LLMs via your Shogo account — no API keys needed
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
              description="Uses cloud LLMs via your Shogo account"
            >
              {shogoKeyConnected ? (
                <View className="flex-row items-center gap-2 bg-green-500/10 rounded-lg p-3">
                  <CheckCircle size={16} className="text-green-500" />
                  <Text className="text-sm font-medium text-foreground">
                    Cloud LLMs active. Manage your API key in General settings.
                  </Text>
                </View>
              ) : (
                <View className="flex-row items-center gap-2 bg-amber-500/10 rounded-lg p-3">
                  <AlertTriangle size={16} className="text-amber-500" />
                  <Text className="text-sm text-foreground">
                    No Shogo API key connected. Add one in General settings first.
                  </Text>
                </View>
              )}
            </SectionCard>

            <AgentModelDefaultsCard
              basicModel={cloudBasicModel}
              advancedModel={cloudAdvancedModel}
              onBasicChange={setCloudBasicModel}
              onAdvancedChange={setCloudAdvancedModel}
            />
          </>
        )}

        {/* ── API Keys config ────────────────────────────────────────── */}
        {activeMode === 'api-keys' && (
          <>
            <SectionCard
              icon={Key}
              title="Cloud API Keys"
              description="Enter your own Anthropic or OpenAI API keys"
            >
              <View className="gap-4">
                <FieldGroup label="Anthropic API Key">
                  <View className="flex-row items-center gap-2">
                    {anthropicMask ? (
                      <View className="flex-row items-center gap-1.5">
                        <View className="h-2 w-2 rounded-full bg-green-500" />
                        <Text className="text-xs text-muted-foreground">{anthropicMask}</Text>
                      </View>
                    ) : (
                      <View className="flex-row items-center gap-1.5">
                        <View className="h-2 w-2 rounded-full bg-amber-500" />
                        <Text className="text-xs text-muted-foreground">Not configured</Text>
                      </View>
                    )}
                  </View>
                  <TextInput
                    value={anthropicKey}
                    onChangeText={setAnthropicKey}
                    onBlur={() => handleApiKeyBlur('anthropic')}
                    onSubmitEditing={() => handleApiKeyBlur('anthropic')}
                    placeholder={anthropicMask ? 'Enter new key to replace' : 'sk-ant-...'}
                    secureTextEntry
                    className="bg-background border border-border rounded-lg px-3 py-2.5 text-sm text-foreground mt-2"
                    placeholderTextColor="#666"
                    autoCapitalize="none"
                    autoCorrect={false}
                  />
                </FieldGroup>

                <FieldGroup label="OpenAI API Key">
                  <View className="flex-row items-center gap-2">
                    {openaiMask ? (
                      <View className="flex-row items-center gap-1.5">
                        <View className="h-2 w-2 rounded-full bg-green-500" />
                        <Text className="text-xs text-muted-foreground">{openaiMask}</Text>
                      </View>
                    ) : (
                      <View className="flex-row items-center gap-1.5">
                        <View className="h-2 w-2 rounded-full bg-muted-foreground" />
                        <Text className="text-xs text-muted-foreground">Optional</Text>
                      </View>
                    )}
                  </View>
                  <TextInput
                    value={openaiKey}
                    onChangeText={setOpenaiKey}
                    onBlur={() => handleApiKeyBlur('openai')}
                    onSubmitEditing={() => handleApiKeyBlur('openai')}
                    placeholder={openaiMask ? 'Enter new key to replace' : 'sk-...'}
                    secureTextEntry
                    className="bg-background border border-border rounded-lg px-3 py-2.5 text-sm text-foreground mt-2"
                    placeholderTextColor="#666"
                    autoCapitalize="none"
                    autoCorrect={false}
                  />
                </FieldGroup>
              </View>
            </SectionCard>

            <AgentModelDefaultsCard
              basicModel={cloudBasicModel}
              advancedModel={cloudAdvancedModel}
              onBasicChange={setCloudBasicModel}
              onAdvancedChange={setCloudAdvancedModel}
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

function AgentModelDefaultsCard({
  basicModel,
  advancedModel,
  onBasicChange,
  onAdvancedChange,
}: {
  basicModel: string
  advancedModel: string
  onBasicChange: (v: string) => void
  onAdvancedChange: (v: string) => void
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
