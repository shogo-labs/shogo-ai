// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { useState, useCallback, useMemo } from 'react'
import {
  View,
  Text,
  TextInput,
  Pressable,
  ScrollView,
  ActivityIndicator,
} from 'react-native'
import {
  Cloud,
  Key,
  Server,
  Check,
  AlertTriangle,
  CheckCircle,
  Zap,
  ArrowRight,
  ChevronDown,
} from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import { PlatformApi } from '@shogo-ai/sdk'
import { createHttpClient } from '../../../lib/api'

type AIConfigMode = 'shogo-cloud' | 'api-keys' | 'local-llm' | null

interface ModelInfo {
  id: string
  name: string
}

interface AIConfigFormProps {
  onComplete: () => void
  onSkip: () => void
}

export function AIConfigForm({ onComplete, onSkip }: AIConfigFormProps) {
  const platform = useMemo(() => new PlatformApi(createHttpClient()), [])

  const [aiMode, setAiMode] = useState<AIConfigMode>(null)
  const [anthropicKey, setAnthropicKey] = useState('')
  const [openaiKey, setOpenaiKey] = useState('')
  const [shogoApiKey, setShogoApiKey] = useState('')
  const [shogoKeyError, setShogoKeyError] = useState('')
  const [llmBaseUrl, setLlmBaseUrl] = useState('')
  const [basicModel, setBasicModel] = useState('')
  const [advancedModel, setAdvancedModel] = useState('')
  const [models, setModels] = useState<ModelInfo[]>([])
  const [connectionStatus, setConnectionStatus] = useState<'idle' | 'connected' | 'error'>('idle')
  const [isTesting, setIsTesting] = useState(false)
  const [isSaving, setIsSaving] = useState(false)

  const handleTestConnection = useCallback(async () => {
    if (!llmBaseUrl) return
    setIsTesting(true)
    setConnectionStatus('idle')
    try {
      const data = await platform.getLocalModels(llmBaseUrl)
      if (data.ok) {
        setModels(data.models)
        setConnectionStatus('connected')
      } else {
        setConnectionStatus('error')
      }
    } catch {
      setConnectionStatus('error')
    } finally {
      setIsTesting(false)
    }
  }, [llmBaseUrl, platform])

  const handleSave = useCallback(async () => {
    setIsSaving(true)
    setShogoKeyError('')
    try {
      if (aiMode === 'shogo-cloud') {
        const data = await platform.connectShogoKey(shogoApiKey)
        if (!data.ok) {
          setShogoKeyError(data.error || 'Failed to validate key')
          setIsSaving(false)
          return
        }
      } else if (aiMode === 'api-keys') {
        const body: Record<string, string> = {}
        if (anthropicKey) body.anthropicApiKey = anthropicKey
        if (openaiKey) body.openaiApiKey = openaiKey
        await platform.putProviderKeys(body)
      } else if (aiMode === 'local-llm') {
        await platform.putLlmConfig({
          LOCAL_LLM_BASE_URL: llmBaseUrl || null,
          LOCAL_LLM_BASIC_MODEL: basicModel || null,
          LOCAL_LLM_ADVANCED_MODEL: advancedModel || null,
        })
      }
      onComplete()
    } catch {
      // stay on step
    } finally {
      setIsSaving(false)
    }
  }, [aiMode, shogoApiKey, anthropicKey, openaiKey, llmBaseUrl, basicModel, advancedModel, onComplete, platform])

  const isSaveDisabled =
    isSaving ||
    !aiMode ||
    (aiMode === 'api-keys' && !anthropicKey) ||
    (aiMode === 'shogo-cloud' && !shogoApiKey)

  return (
    <View className="gap-4">
      {/* Mode cards */}
      <View className="gap-2.5">
        <ModeCard
          icon={Cloud}
          label="Shogo Cloud"
          description="No API keys needed"
          isSelected={aiMode === 'shogo-cloud'}
          onPress={() => setAiMode('shogo-cloud')}
        />
        <ModeCard
          icon={Key}
          label="Your Own API Keys"
          description="Anthropic or OpenAI"
          isSelected={aiMode === 'api-keys'}
          onPress={() => setAiMode('api-keys')}
        />
        <ModeCard
          icon={Server}
          label="Local LLM"
          description="Ollama, LM Studio, etc."
          isSelected={aiMode === 'local-llm'}
          onPress={() => setAiMode('local-llm')}
        />
      </View>

      {/* Shogo Cloud form */}
      {aiMode === 'shogo-cloud' && (
        <View className="gap-3 bg-card border border-border rounded-xl p-4">
          <Text className="text-xs text-muted-foreground leading-4">
            Enter your Shogo API key from studio.shogo.ai
          </Text>
          <FieldInput
            value={shogoApiKey}
            onChangeText={setShogoApiKey}
            placeholder="shogo_sk_..."
            secureTextEntry
            autoCapitalize="none"
          />
          {shogoKeyError ? (
            <View className="flex-row items-center gap-1.5">
              <AlertTriangle size={14} className="text-destructive" />
              <Text className="text-xs text-destructive">{shogoKeyError}</Text>
            </View>
          ) : null}
        </View>
      )}

      {/* API Keys form */}
      {aiMode === 'api-keys' && (
        <View className="gap-3 bg-card border border-border rounded-xl p-4">
          <FieldInput
            label="Anthropic API Key"
            value={anthropicKey}
            onChangeText={setAnthropicKey}
            placeholder="sk-ant-..."
            secureTextEntry
            autoCapitalize="none"
          />
          <FieldInput
            label="OpenAI API Key (optional)"
            value={openaiKey}
            onChangeText={setOpenaiKey}
            placeholder="sk-..."
            secureTextEntry
            autoCapitalize="none"
          />
        </View>
      )}

      {/* Local LLM form */}
      {aiMode === 'local-llm' && (
        <View className="gap-3 bg-card border border-border rounded-xl p-4">
          <FieldInput
            label="Base URL"
            value={llmBaseUrl}
            onChangeText={setLlmBaseUrl}
            placeholder="http://localhost:11434"
            autoCapitalize="none"
          />
          <View className="flex-row items-center gap-3">
            <Pressable
              onPress={handleTestConnection}
              disabled={isTesting || !llmBaseUrl}
              className={cn(
                'flex-row items-center gap-2 px-3 py-1.5 rounded-lg',
                !llmBaseUrl ? 'bg-muted opacity-50' : 'bg-primary'
              )}
            >
              {isTesting ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <Zap size={12} color="#fff" />
              )}
              <Text className="text-xs font-medium text-primary-foreground">Test</Text>
            </Pressable>
            {connectionStatus === 'connected' && (
              <View className="flex-row items-center gap-1">
                <CheckCircle size={12} className="text-green-500" />
                <Text className="text-xs text-green-500">{models.length} model(s)</Text>
              </View>
            )}
            {connectionStatus === 'error' && (
              <View className="flex-row items-center gap-1">
                <AlertTriangle size={12} className="text-destructive" />
                <Text className="text-xs text-destructive">Cannot reach server</Text>
              </View>
            )}
          </View>
          <ModelSelector label="Basic Model" value={basicModel} onChange={setBasicModel} models={models} placeholder="e.g. llama3" />
          <ModelSelector label="Advanced Model" value={advancedModel} onChange={setAdvancedModel} models={models} placeholder="e.g. qwen2.5:72b" />
        </View>
      )}

      {/* Actions */}
      {aiMode && (
        <Pressable
          onPress={handleSave}
          disabled={isSaveDisabled}
          className={cn(
            'flex-row items-center justify-center gap-2 py-3 rounded-xl',
            isSaveDisabled ? 'bg-primary/30' : 'bg-primary'
          )}
        >
          {isSaving ? (
            <ActivityIndicator size="small" color="#fff" />
          ) : (
            <>
              <Text className="text-sm font-semibold text-primary-foreground">Save & Continue</Text>
              <ArrowRight size={16} color="#fff" />
            </>
          )}
        </Pressable>
      )}

      <Pressable onPress={onSkip} className="items-center py-1.5">
        <Text className="text-xs text-muted-foreground">Skip for now</Text>
      </Pressable>
    </View>
  )
}

function ModeCard({
  icon: Icon,
  label,
  description,
  isSelected,
  onPress,
}: {
  icon: typeof Cloud
  label: string
  description: string
  isSelected: boolean
  onPress: () => void
}) {
  return (
    <Pressable
      onPress={onPress}
      className={cn(
        'flex-row items-center gap-3 p-3.5 rounded-xl border',
        isSelected ? 'border-primary bg-primary/5' : 'border-border bg-card'
      )}
    >
      <View
        className={cn(
          'w-9 h-9 rounded-lg items-center justify-center',
          isSelected ? 'bg-primary/10' : 'bg-muted'
        )}
      >
        <Icon size={18} className={isSelected ? 'text-primary' : 'text-muted-foreground'} />
      </View>
      <View className="flex-1">
        <Text className="text-sm font-semibold text-foreground">{label}</Text>
        <Text className="text-xs text-muted-foreground">{description}</Text>
      </View>
      {isSelected && <Check size={16} className="text-primary" />}
    </Pressable>
  )
}

function FieldInput({
  label,
  ...inputProps
}: { label?: string } & React.ComponentProps<typeof TextInput>) {
  return (
    <View className="gap-1">
      {label && <Text className="text-xs font-medium text-foreground">{label}</Text>}
      <TextInput
        {...inputProps}
        className="bg-background border border-border rounded-lg px-3 py-2 text-sm text-foreground"
        placeholderTextColor="#666"
      />
    </View>
  )
}

function ModelSelector({
  label,
  value,
  onChange,
  models,
  placeholder,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  models: ModelInfo[]
  placeholder: string
}) {
  const [open, setOpen] = useState(false)
  const filtered = models.filter(m => !value || m.id.toLowerCase().includes(value.toLowerCase()))

  return (
    <View className="gap-1">
      <Text className="text-xs font-medium text-foreground">{label}</Text>
      <View className="relative">
        <View className="flex-row items-center">
          <TextInput
            value={value}
            onChangeText={(t) => {
              onChange(t)
              if (t && models.length > 0) setOpen(true)
            }}
            onFocus={() => { if (models.length > 0) setOpen(true) }}
            placeholder={placeholder}
            className="flex-1 bg-background border border-border rounded-lg px-3 py-2 text-sm text-foreground"
            placeholderTextColor="#666"
            autoCapitalize="none"
            autoCorrect={false}
          />
          {models.length > 0 && (
            <Pressable onPress={() => setOpen(!open)} className="absolute right-2 p-1">
              <ChevronDown size={12} className="text-muted-foreground" />
            </Pressable>
          )}
        </View>
        {open && filtered.length > 0 && (
          <View className="absolute top-10 left-0 right-0 z-50 bg-card border border-border rounded-lg max-h-32 overflow-hidden">
            <ScrollView>
              {filtered.map(m => (
                <Pressable
                  key={m.id}
                  onPress={() => { onChange(m.id); setOpen(false) }}
                  className="px-3 py-2 border-b border-border/50 active:bg-muted"
                >
                  <Text className="text-xs text-foreground">{m.id}</Text>
                </Pressable>
              ))}
            </ScrollView>
          </View>
        )}
      </View>
    </View>
  )
}
