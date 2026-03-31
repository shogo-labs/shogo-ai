// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Admin Settings - Local LLM configuration, model selection, and API keys.
 * Super admin configures the LLM provider base URL, chat models (basic/advanced),
 * embedding model, and optional cloud API keys from this page.
 * Changes take effect immediately without server restart.
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
  RefreshCw,
  Key,
  Zap,
  BrainCircuit,
  ChevronDown,
  Cloud,
  Unplug,
  Palette,
  Check,
} from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import { PlatformApi, type LlmConfig } from '@shogo-ai/sdk'
import { createHttpClient } from '../../lib/api'
import { useAccentTheme } from '../../contexts/accent-theme'
import {
  ACCENT_PRESETS,
  ACCENT_NAMES,
  type AccentThemeName,
} from '../../lib/accent-themes'

// =============================================================================
// Types
// =============================================================================

interface ModelInfo {
  id: string
  name: string
}

// =============================================================================
// Main Page
// =============================================================================

export default function AdminSettingsPage() {
  const [config, setConfig] = useState<LlmConfig>({})
  const [models, setModels] = useState<ModelInfo[]>([])
  const [apiKeys, setApiKeys] = useState<Record<string, string>>({})

  const [baseUrl, setBaseUrl] = useState('')
  const [basicModel, setBasicModel] = useState('')
  const [advancedModel, setAdvancedModel] = useState('')
  const [embeddingModel, setEmbeddingModel] = useState('')
  const [embeddingDims, setEmbeddingDims] = useState('')

  const [anthropicKey, setAnthropicKey] = useState('')
  const [openaiKey, setOpenaiKey] = useState('')
  const [anthropicMask, setAnthropicMask] = useState('')
  const [openaiMask, setOpenaiMask] = useState('')

  const [shogoKeyInput, setShogoKeyInput] = useState('')
  const [shogoKeyConnected, setShogoKeyConnected] = useState(false)
  const [shogoKeyMask, setShogoKeyMask] = useState('')
  const [shogoWorkspaceName, setShogoWorkspaceName] = useState('')
  const [shogoKeyStatus, setShogoKeyStatus] = useState<'idle' | 'connecting' | 'connected' | 'error'>('idle')
  const [shogoKeyError, setShogoKeyError] = useState('')
  const [isDisconnecting, setIsDisconnecting] = useState(false)

  const [isLoading, setIsLoading] = useState(true)
  const [isSaving, setIsSaving] = useState(false)
  const [isTestingConnection, setIsTestingConnection] = useState(false)
  const [connectionStatus, setConnectionStatus] = useState<'idle' | 'connected' | 'error'>('idle')
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saved' | 'error'>('idle')
  const [modelsLoading, setModelsLoading] = useState(false)

  const platform = useMemo(() => new PlatformApi(createHttpClient()), [])

  const fetchConfig = useCallback(async () => {
    try {
      const [llmCfg, keyMasks, shogoData] = await Promise.all([
        platform.getLlmConfig(),
        platform.getProviderKeyMasks(),
        platform.getShogoKeyStatus(),
      ])

      setConfig(llmCfg)
      setApiKeys(keyMasks)

      setBaseUrl(llmCfg.LOCAL_LLM_BASE_URL || '')
      setBasicModel(llmCfg.LOCAL_LLM_BASIC_MODEL || '')
      setAdvancedModel(llmCfg.LOCAL_LLM_ADVANCED_MODEL || '')
      setEmbeddingModel(llmCfg.LOCAL_EMBEDDING_MODEL || '')
      setEmbeddingDims(llmCfg.LOCAL_EMBEDDING_DIMENSIONS || '')

      if (keyMasks.ANTHROPIC_API_KEY) setAnthropicMask(keyMasks.ANTHROPIC_API_KEY)
      if (keyMasks.OPENAI_API_KEY) setOpenaiMask(keyMasks.OPENAI_API_KEY)

      setShogoKeyConnected(shogoData.connected)
      if (shogoData.keyMask) setShogoKeyMask(shogoData.keyMask)
      if (shogoData.workspace?.name) setShogoWorkspaceName(shogoData.workspace.name)
      if (shogoData.connected) setShogoKeyStatus('connected')

      if (llmCfg.LOCAL_LLM_BASE_URL) {
        fetchModels(llmCfg.LOCAL_LLM_BASE_URL)
      }
    } catch (err) {
      console.error('[AdminSettings] Failed to load config:', err)
    } finally {
      setIsLoading(false)
    }
  }, [platform])

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
      await platform.putLlmConfig({
        LOCAL_LLM_BASE_URL: baseUrl || null,
        LOCAL_LLM_BASIC_MODEL: basicModel || null,
        LOCAL_LLM_ADVANCED_MODEL: advancedModel || null,
        LOCAL_EMBEDDING_MODEL: embeddingModel || null,
        LOCAL_EMBEDDING_DIMENSIONS: embeddingDims || null,
      })

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

      setSaveStatus('saved')
      setTimeout(() => setSaveStatus('idle'), 3000)
    } catch {
      setSaveStatus('error')
    } finally {
      setIsSaving(false)
    }
  }

  const handleConnectShogoKey = async () => {
    if (!shogoKeyInput.trim()) return
    setShogoKeyStatus('connecting')
    setShogoKeyError('')
    try {
      const data = await platform.connectShogoKey(shogoKeyInput.trim())
      if (data.ok) {
        setShogoKeyConnected(true)
        setShogoKeyMask(shogoKeyInput.trim().slice(0, 17) + '...' + shogoKeyInput.trim().slice(-4))
        setShogoWorkspaceName(data.workspace?.name || '')
        setShogoKeyStatus('connected')
        setShogoKeyInput('')
      } else {
        setShogoKeyError(data.error || 'Failed to validate key')
        setShogoKeyStatus('error')
      }
    } catch (err: any) {
      setShogoKeyError(err.message || 'Connection failed')
      setShogoKeyStatus('error')
    }
  }

  const handleDisconnectShogoKey = async () => {
    setIsDisconnecting(true)
    try {
      await platform.disconnectShogoKey()
      setShogoKeyConnected(false)
      setShogoKeyMask('')
      setShogoWorkspaceName('')
      setShogoKeyStatus('idle')
      setShogoKeyInput('')
    } catch (err) {
      console.error('[AdminSettings] Failed to disconnect Shogo key:', err)
    } finally {
      setIsDisconnecting(false)
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
        <View>
          <Text className="text-2xl font-bold text-foreground">AI Configuration</Text>
          <Text className="text-sm text-muted-foreground mt-1">
            Configure your local LLM provider and models. Changes take effect immediately.
          </Text>
        </View>

        {/* Appearance Section */}
        <AccentColorPicker />

        {/* Shogo Cloud Section */}
        <SectionCard
          icon={Cloud}
          title="Shogo Cloud"
          description="Connect your Shogo account to use our cloud LLMs"
        >
          {shogoKeyConnected ? (
            <View className="gap-3">
              <View className="flex-row items-center gap-2 bg-green-500/10 rounded-lg p-3">
                <CheckCircle size={16} className="text-green-500" />
                <View className="flex-1">
                  <Text className="text-sm font-medium text-foreground">Connected</Text>
                  {shogoWorkspaceName ? (
                    <Text className="text-xs text-muted-foreground">
                      Workspace: {shogoWorkspaceName}
                    </Text>
                  ) : null}
                </View>
              </View>
              <View className="flex-row items-center gap-2">
                <Text className="text-xs text-muted-foreground font-mono flex-1">
                  {shogoKeyMask}
                </Text>
                <Pressable
                  onPress={handleDisconnectShogoKey}
                  disabled={isDisconnecting}
                  className={cn(
                    'flex-row items-center gap-1.5 px-3 py-1.5 rounded-lg border border-destructive/30',
                    isDisconnecting && 'opacity-50'
                  )}
                >
                  <Unplug size={14} className="text-destructive" />
                  <Text className="text-sm text-destructive">
                    {isDisconnecting ? 'Disconnecting...' : 'Disconnect'}
                  </Text>
                </Pressable>
              </View>
              <Text className="text-xs text-muted-foreground">
                LLM usage will be billed to your Shogo cloud account. You can still
                configure your own API keys below as optional overrides.
              </Text>
            </View>
          ) : (
            <View className="gap-3">
              <Text className="text-sm text-muted-foreground">
                Enter your Shogo API key to use our cloud LLMs without managing
                provider API keys. Get your key from the{' '}
                <Text className="text-primary font-medium">Shogo Cloud dashboard</Text>.
              </Text>
              <View className="flex-row gap-2">
                <View className="flex-1">
                  <TextInput
                    value={shogoKeyInput}
                    onChangeText={(t) => { setShogoKeyInput(t); setShogoKeyError(''); setShogoKeyStatus('idle') }}
                    placeholder="shogo_sk_..."
                    secureTextEntry
                    autoCapitalize="none"
                    autoCorrect={false}
                    className="border border-border rounded-lg px-3 py-2.5 text-sm text-foreground placeholder:text-muted-foreground web:outline-none"
                  />
                </View>
                <Pressable
                  onPress={handleConnectShogoKey}
                  disabled={!shogoKeyInput.trim() || shogoKeyStatus === 'connecting'}
                  className={cn(
                    'px-4 py-2.5 rounded-lg items-center justify-center',
                    shogoKeyInput.trim() && shogoKeyStatus !== 'connecting' ? 'bg-primary' : 'bg-muted'
                  )}
                >
                  <Text className={cn(
                    'text-sm font-medium',
                    shogoKeyInput.trim() && shogoKeyStatus !== 'connecting' ? 'text-primary-foreground' : 'text-muted-foreground'
                  )}>
                    {shogoKeyStatus === 'connecting' ? 'Connecting...' : 'Connect'}
                  </Text>
                </Pressable>
              </View>
              {shogoKeyError ? (
                <View className="flex-row items-center gap-1.5">
                  <AlertTriangle size={14} className="text-destructive" />
                  <Text className="text-sm text-destructive">{shogoKeyError}</Text>
                </View>
              ) : null}
            </View>
          )}
        </SectionCard>

        {/* LLM Provider Section */}
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

        {/* Chat Models Section */}
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

        {/* Embedding Section */}
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

        {/* API Keys Section */}
        <SectionCard
          icon={Key}
          title="Cloud API Keys"
          description="Optional. Used as fallback when no local LLM is configured."
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

        {/* Save Button */}
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
            onPress={handleSave}
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
      </View>
    </ScrollView>
  )
}

// =============================================================================
// Accent Color Picker
// =============================================================================

function AccentColorPicker() {
  const { accent, setAccent } = useAccentTheme()

  return (
    <SectionCard
      icon={Palette}
      title="Appearance"
      description="Customize the accent color used throughout the app"
    >
      <View className="flex-row flex-wrap gap-3">
        {ACCENT_NAMES.map((name) => {
          const preset = ACCENT_PRESETS[name]
          const isActive = accent === name
          return (
            <Pressable
              key={name}
              onPress={() => setAccent(name)}
              className="items-center gap-1.5"
            >
              <View
                className={cn(
                  'h-10 w-10 rounded-full items-center justify-center',
                  isActive && 'border-2 border-foreground',
                )}
                style={{ backgroundColor: preset.swatch }}
              >
                {isActive && <Check size={16} color="#fff" strokeWidth={3} />}
              </View>
              <Text
                className={cn(
                  'text-[10px]',
                  isActive ? 'text-foreground font-semibold' : 'text-muted-foreground',
                )}
              >
                {preset.label}
              </Text>
            </Pressable>
          )
        })}
      </View>
    </SectionCard>
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
