// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Admin Settings - AI provider selection, LLM configuration, and API keys.
 *
 * The page has a primary mode selector (Shogo Cloud / Own API Keys / Local LLM)
 * that determines which configuration sections are shown. The selected mode is
 * persisted as AI_MODE in localConfig so it survives restarts.
 */

import { useState, useEffect, useCallback, useMemo } from 'react'
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
  Save,
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
import { createHttpClient } from '../../lib/api'

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

  const [shogoKeyConnected, setShogoKeyConnected] = useState(false)

  const [isLoading, setIsLoading] = useState(true)
  const [isSaving, setIsSaving] = useState(false)
  const [isTestingConnection, setIsTestingConnection] = useState(false)
  const [connectionStatus, setConnectionStatus] = useState<'idle' | 'connected' | 'error'>('idle')
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saved' | 'error'>('idle')
  const [modelsLoading, setModelsLoading] = useState(false)

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
      const [llmCfg, keyMasks, shogoData] = await Promise.all([
        platform.getLlmConfig(),
        platform.getProviderKeyMasks(),
        platform.getShogoKeyStatus(),
      ])

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

  const handleSave = async () => {
    setIsSaving(true)
    setSaveStatus('idle')
    try {
      if (activeMode === 'local-llm') {
        await platform.putLlmConfig({
          AI_MODE: activeMode,
          LOCAL_LLM_BASE_URL: baseUrl || null,
          LOCAL_LLM_BASIC_MODEL: basicModel || null,
          LOCAL_LLM_ADVANCED_MODEL: advancedModel || null,
          LOCAL_EMBEDDING_MODEL: embeddingModel || null,
          LOCAL_EMBEDDING_DIMENSIONS: embeddingDims || null,
        })
      }

      if (activeMode === 'api-keys') {
        if (anthropicKey || openaiKey) {
          const keysBody: Record<string, string> = {}
          if (anthropicKey) keysBody.anthropicApiKey = anthropicKey
          if (openaiKey) keysBody.openaiApiKey = openaiKey
          await platform.putProviderKeys(keysBody)
          if (anthropicKey) {
            setAnthropicMask(anthropicKey.slice(0, 8) + '...' + anthropicKey.slice(-4))
            setAnthropicKey('')
          }
          if (openaiKey) {
            setOpenaiMask(openaiKey.slice(0, 8) + '...' + openaiKey.slice(-4))
            setOpenaiKey('')
          }
        }
      }

      setSaveStatus('saved')
      setTimeout(() => setSaveStatus('idle'), 3000)
    } catch {
      setSaveStatus('error')
    } finally {
      setIsSaving(false)
    }
  }

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

            {/* Save */}
            <SaveBar
              isSaving={isSaving}
              saveStatus={saveStatus}
              onSave={handleSave}
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

            {/* Save */}
            <SaveBar
              isSaving={isSaving}
              saveStatus={saveStatus}
              onSave={handleSave}
            />
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
// Save Bar
// =============================================================================

function SaveBar({
  isSaving,
  saveStatus,
  onSave,
}: {
  isSaving: boolean
  saveStatus: 'idle' | 'saved' | 'error'
  onSave: () => void
}) {
  return (
    <View className="flex-row items-center justify-between">
      <View>
        {saveStatus === 'saved' && (
          <View className="flex-row items-center gap-1.5">
            <CheckCircle size={14} className="text-green-500" />
            <Text className="text-sm text-green-500">Configuration saved</Text>
          </View>
        )}
        {saveStatus === 'error' && (
          <View className="flex-row items-center gap-1.5">
            <AlertTriangle size={14} className="text-destructive" />
            <Text className="text-sm text-destructive">Failed to save</Text>
          </View>
        )}
      </View>
      <Pressable
        onPress={onSave}
        disabled={isSaving}
        className={cn(
          'flex-row items-center gap-2 px-6 py-2.5 rounded-lg',
          isSaving ? 'bg-primary/50' : 'bg-primary'
        )}
      >
        {isSaving ? (
          <ActivityIndicator size="small" color="#fff" />
        ) : (
          <Save size={14} color="#fff" />
        )}
        <Text className="text-sm font-medium text-primary-foreground">
          {isSaving ? 'Saving...' : 'Save Configuration'}
        </Text>
      </Pressable>
    </View>
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
