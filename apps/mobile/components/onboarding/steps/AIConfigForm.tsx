// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { useState, useCallback, useMemo, useEffect } from 'react'
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
  LogIn,
} from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import { PlatformApi } from '@shogo-ai/sdk'
import { createHttpClient } from '../../../lib/api'

function hasDesktopBridge(): boolean {
  if (typeof window === 'undefined') return false
  return !!(window as any).shogoDesktop?.startCloudLogin
}

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
  const [shogoKeyError, setShogoKeyError] = useState('')
  const [shogoSignedIn, setShogoSignedIn] = useState(false)
  const [shogoEmail, setShogoEmail] = useState('')
  const [shogoWorkspace, setShogoWorkspace] = useState('')
  const [shogoLoginStatus, setShogoLoginStatus] = useState<'idle' | 'connecting'>('idle')
  const [llmBaseUrl, setLlmBaseUrl] = useState('')
  const [basicModel, setBasicModel] = useState('')
  const [advancedModel, setAdvancedModel] = useState('')
  const [models, setModels] = useState<ModelInfo[]>([])
  const [connectionStatus, setConnectionStatus] = useState<'idle' | 'connected' | 'error'>('idle')
  const [isTesting, setIsTesting] = useState(false)
  const [isSaving, setIsSaving] = useState(false)

  // Pick up an existing cloud sign-in (e.g. from a previous onboarding run or
  // a separate sign-in tab that just finished). On the desktop, we get a push
  // notification via the bridge; in browsers we poll while we're "connecting"
  // and also re-check whenever this tab regains focus so a new-tab handshake
  // is detected as soon as the user comes back.
  useEffect(() => {
    let cancelled = false

    const refreshStatus = async (): Promise<boolean> => {
      try {
        const status = await platform.cloudLoginStatus()
        if (cancelled) return false
        if (status.signedIn) {
          setShogoSignedIn(true)
          setShogoEmail(status.email || '')
          setShogoWorkspace(status.workspace?.name || '')
          setShogoLoginStatus('idle')
          setShogoKeyError('')
          return true
        }
      } catch {
        // Local API not reachable — onboarding can still proceed with other modes.
      }
      return false
    }

    void refreshStatus()

    const onFocus = () => {
      if (!shogoSignedIn) void refreshStatus()
    }
    if (typeof window !== 'undefined') {
      window.addEventListener('focus', onFocus)
    }

    const desktop = (typeof window !== 'undefined' ? (window as any).shogoDesktop : null) as
      | {
          onCloudLoginResult?: (
            cb: (r: { ok: boolean; error?: string; email?: string; workspace?: string }) => void,
          ) => void
          removeCloudLoginListener?: () => void
        }
      | null
    desktop?.onCloudLoginResult?.((result) => {
      if (cancelled) return
      setShogoLoginStatus('idle')
      if (result.ok) {
        setShogoSignedIn(true)
        setShogoEmail(result.email || '')
        setShogoWorkspace(result.workspace || '')
        setShogoKeyError('')
      } else {
        setShogoKeyError(result.error || 'Sign-in was cancelled')
      }
    })

    return () => {
      cancelled = true
      if (typeof window !== 'undefined') {
        window.removeEventListener('focus', onFocus)
      }
      desktop?.removeCloudLoginListener?.()
    }
  }, [platform, shogoSignedIn])

  // While the user is in the "Waiting for browser…" state, poll the local API
  // so the moment the other tab persists the device key we move forward.
  useEffect(() => {
    if (shogoSignedIn || shogoLoginStatus !== 'connecting') return
    let cancelled = false
    const interval = setInterval(async () => {
      try {
        const status = await platform.cloudLoginStatus()
        if (cancelled) return
        if (status.signedIn) {
          setShogoSignedIn(true)
          setShogoEmail(status.email || '')
          setShogoWorkspace(status.workspace?.name || '')
          setShogoLoginStatus('idle')
          setShogoKeyError('')
        }
      } catch {
        // Transient — keep polling.
      }
    }, 2000)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [platform, shogoSignedIn, shogoLoginStatus])

  const handleStartShogoLogin = useCallback(async () => {
    setShogoLoginStatus('connecting')
    setShogoKeyError('')
    try {
      if (hasDesktopBridge()) {
        const result = await (window as any).shogoDesktop.startCloudLogin()
        if (!result?.ok) {
          setShogoLoginStatus('idle')
          setShogoKeyError(result?.error || 'Could not start sign-in')
        }
        return
      }
      // Dev/browser fallback: open the authUrl in a new tab. The desktop
      // bridge is required for the callback itself, so in dev we also poll
      // local status so the UI picks up a manual key write.
      const start = await platform.startCloudLogin({
        id: 'onboarding-dev',
        name: 'Onboarding (dev)',
        platform: 'web',
        appVersion: '0.0.0-dev',
      })
      if (!start.ok) {
        setShogoLoginStatus('idle')
        setShogoKeyError('Could not start sign-in')
        return
      }
      if (typeof window !== 'undefined') {
        window.open(start.authUrl, '_blank', 'noopener,noreferrer')
      }
      // Stay in 'connecting' state so the polling effect picks up the
      // device key the moment the other tab finishes the handshake.
    } catch (err: any) {
      setShogoLoginStatus('idle')
      setShogoKeyError(err?.message || 'Sign-in failed')
    }
  }, [platform])

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
        // Cloud login handshake already persisted the device key via the
        // deep-link callback, so there's nothing to save here — just move on.
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
  }, [aiMode, anthropicKey, openaiKey, llmBaseUrl, basicModel, advancedModel, onComplete, platform])

  const isSaveDisabled =
    isSaving ||
    !aiMode ||
    (aiMode === 'api-keys' && !anthropicKey) ||
    (aiMode === 'shogo-cloud' && !shogoSignedIn)

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
          {shogoSignedIn ? (
            <View className="flex-row items-center gap-2">
              <CheckCircle size={16} className="text-green-500" />
              <View className="flex-1">
                <Text className="text-sm font-medium text-foreground">
                  Signed in{shogoEmail ? ` as ${shogoEmail}` : ''}
                </Text>
                {shogoWorkspace ? (
                  <Text className="text-xs text-muted-foreground">
                    Workspace: {shogoWorkspace}
                  </Text>
                ) : null}
              </View>
            </View>
          ) : (
            <>
              <Text className="text-xs text-muted-foreground leading-4">
                Sign in with your Shogo Cloud account. Your browser will open to
                complete the login, then this app will reconnect automatically.
              </Text>
              <Pressable
                onPress={handleStartShogoLogin}
                disabled={shogoLoginStatus === 'connecting'}
                className={cn(
                  'flex-row items-center justify-center gap-2 px-4 py-2.5 rounded-lg',
                  shogoLoginStatus === 'connecting' ? 'bg-muted' : 'bg-primary',
                )}
              >
                {shogoLoginStatus === 'connecting' ? (
                  <ActivityIndicator size="small" />
                ) : (
                  <LogIn size={14} color="#fff" />
                )}
                <Text
                  className={cn(
                    'text-sm font-medium',
                    shogoLoginStatus === 'connecting'
                      ? 'text-muted-foreground'
                      : 'text-primary-foreground',
                  )}
                >
                  {shogoLoginStatus === 'connecting'
                    ? 'Waiting for browser…'
                    : 'Sign in to Shogo Cloud'}
                </Text>
              </Pressable>
            </>
          )}
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
