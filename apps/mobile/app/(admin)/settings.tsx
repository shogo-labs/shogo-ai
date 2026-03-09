// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Admin Settings - Local LLM configuration, model selection, and API keys.
 * Super admin configures the LLM provider base URL, chat models (basic/advanced),
 * embedding model, and optional cloud API keys from this page.
 * Changes take effect immediately without server restart.
 */

import { useState, useEffect, useCallback } from 'react'
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
} from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import { API_URL } from '../../lib/api'

// =============================================================================
// Types
// =============================================================================

interface LlmConfig {
  LOCAL_LLM_BASE_URL?: string
  LOCAL_LLM_BASIC_MODEL?: string
  LOCAL_LLM_ADVANCED_MODEL?: string
  LOCAL_EMBEDDING_MODEL?: string
  LOCAL_EMBEDDING_DIMENSIONS?: string
}

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

  const [isLoading, setIsLoading] = useState(true)
  const [isSaving, setIsSaving] = useState(false)
  const [isTestingConnection, setIsTestingConnection] = useState(false)
  const [connectionStatus, setConnectionStatus] = useState<'idle' | 'connected' | 'error'>('idle')
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saved' | 'error'>('idle')
  const [modelsLoading, setModelsLoading] = useState(false)

  const fetchConfig = useCallback(async () => {
    try {
      const [llmRes, keysRes] = await Promise.all([
        fetch(`${API_URL}/api/local/llm-config`, { credentials: 'include' }),
        fetch(`${API_URL}/api/local/api-keys`, { credentials: 'include' }),
      ])
      const llmData = await llmRes.json() as { config: LlmConfig }
      const keysData = await keysRes.json() as { keys: Record<string, string> }

      setConfig(llmData.config || {})
      setApiKeys(keysData.keys || {})

      const cfg = llmData.config || {}
      setBaseUrl(cfg.LOCAL_LLM_BASE_URL || '')
      setBasicModel(cfg.LOCAL_LLM_BASIC_MODEL || '')
      setAdvancedModel(cfg.LOCAL_LLM_ADVANCED_MODEL || '')
      setEmbeddingModel(cfg.LOCAL_EMBEDDING_MODEL || '')
      setEmbeddingDims(cfg.LOCAL_EMBEDDING_DIMENSIONS || '')

      if (keysData.keys?.ANTHROPIC_API_KEY) setAnthropicMask(keysData.keys.ANTHROPIC_API_KEY)
      if (keysData.keys?.OPENAI_API_KEY) setOpenaiMask(keysData.keys.OPENAI_API_KEY)

      if (cfg.LOCAL_LLM_BASE_URL) {
        fetchModels(cfg.LOCAL_LLM_BASE_URL)
      }
    } catch (err) {
      console.error('[AdminSettings] Failed to load config:', err)
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => { fetchConfig() }, [fetchConfig])

  const fetchModels = useCallback(async (url?: string) => {
    const targetUrl = url || baseUrl
    if (!targetUrl) return
    setModelsLoading(true)
    try {
      const res = await fetch(
        `${API_URL}/api/local/models?baseUrl=${encodeURIComponent(targetUrl)}`,
        { credentials: 'include' }
      )
      const data = await res.json() as { ok: boolean; models: ModelInfo[]; error?: string }
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
  }, [baseUrl])

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
      const llmBody: Record<string, string | null> = {
        LOCAL_LLM_BASE_URL: baseUrl || null,
        LOCAL_LLM_BASIC_MODEL: basicModel || null,
        LOCAL_LLM_ADVANCED_MODEL: advancedModel || null,
        LOCAL_EMBEDDING_MODEL: embeddingModel || null,
        LOCAL_EMBEDDING_DIMENSIONS: embeddingDims || null,
      }
      const llmRes = await fetch(`${API_URL}/api/local/llm-config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(llmBody),
      })
      if (!llmRes.ok) throw new Error('Failed to save LLM config')

      if (anthropicKey || openaiKey) {
        const keysBody: Record<string, string> = {}
        if (anthropicKey) keysBody.anthropicApiKey = anthropicKey
        if (openaiKey) keysBody.openaiApiKey = openaiKey
        const keysRes = await fetch(`${API_URL}/api/local/api-keys`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify(keysBody),
        })
        if (!keysRes.ok) throw new Error('Failed to save API keys')
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
