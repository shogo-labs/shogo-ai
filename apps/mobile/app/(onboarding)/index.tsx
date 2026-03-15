// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { useState, useEffect, useCallback } from 'react'
import {
  View,
  Text,
  ScrollView,
  Pressable,
  TextInput,
  ActivityIndicator,
  Platform,
  useWindowDimensions,
} from 'react-native'
import { useRouter } from 'expo-router'
import {
  Sparkles,
  Bot,
  Wrench,
  MessageSquare,
  Key,
  Server,
  ChevronRight,
  ChevronLeft,
  CheckCircle,
  AlertTriangle,
  Zap,
  ArrowRight,
  Check,
  ChevronDown,
  Shield,
} from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import { usePostHogSafe } from '../../contexts/posthog'
import { useAuth } from '../../contexts/auth'
import { usePlatformConfig, invalidatePlatformConfigCache } from '../../lib/platform-config'
import { API_URL, api, createHttpClient } from '../../lib/api'
import { EVENTS, trackEvent } from '../../lib/analytics'
import { SecurityPreferenceSelector } from '../../components/security/SecurityPreferenceSelector'

// =============================================================================
// Types
// =============================================================================

type AIConfigMode = 'api-keys' | 'local-llm' | null

interface ModelInfo {
  id: string
  name: string
}

interface AgentTemplate {
  id: string
  name: string
  description: string
  category: string
  icon: string
  tags: string[]
}

// =============================================================================
// Step definitions
// =============================================================================

type StepId =
  | 'welcome'
  | 'create-account'
  | 'security-preference'
  | 'configure-ai'
  | 'features'
  | 'templates'
  | 'get-started'

function getSteps(localMode: boolean, needsSetup: boolean): StepId[] {
  if (localMode && needsSetup) {
    return ['welcome', 'create-account', 'security-preference']
  }
  // Cloud onboarding
  return ['welcome', 'features', 'templates', 'get-started']
}

// =============================================================================
// Main Onboarding Page
// =============================================================================

export default function OnboardingPage() {
  const router = useRouter()
  const { user, signUp, signIn, isLoading: authLoading } = useAuth()
  const posthog = usePostHogSafe()
  const { localMode, needsSetup, features } = usePlatformConfig()
  const { width } = useWindowDimensions()
  const isWide = width >= 768

  const steps = getSteps(localMode, needsSetup ?? false)
  const [currentStepIdx, setCurrentStepIdx] = useState(0)
  const currentStep = steps[currentStepIdx]

  useEffect(() => {
    if (!posthog) return
    trackEvent(posthog, EVENTS.ONBOARDING_STEP_VIEWED, { step: currentStep })
  }, [currentStep, posthog])

  // Account creation state
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [authError, setAuthError] = useState<string | null>(null)
  const [isSigningUp, setIsSigningUp] = useState(false)

  // AI config state
  const [aiMode, setAiMode] = useState<AIConfigMode>(null)
  const [anthropicKey, setAnthropicKey] = useState('')
  const [openaiKey, setOpenaiKey] = useState('')
  const [llmBaseUrl, setLlmBaseUrl] = useState('')
  const [basicModel, setBasicModel] = useState('')
  const [advancedModel, setAdvancedModel] = useState('')
  const [models, setModels] = useState<ModelInfo[]>([])
  const [connectionStatus, setConnectionStatus] = useState<'idle' | 'connected' | 'error'>('idle')
  const [isTesting, setIsTesting] = useState(false)
  const [isSavingAI, setIsSavingAI] = useState(false)
  const [aiSaved, setAiSaved] = useState(false)

  // Template state
  const [templates, setTemplates] = useState<AgentTemplate[]>([])
  const [selectedTemplate, setSelectedTemplate] = useState<string | null>(null)
  const [templatesLoading, setTemplatesLoading] = useState(false)

  // Security preference state (local mode only)
  const [securityMode, setSecurityMode] = useState<'strict' | 'balanced' | 'full_autonomy'>('balanced')
  const [isSavingSecurity, setIsSavingSecurity] = useState(false)

  // Completing
  const [isCompleting, setIsCompleting] = useState(false)

  // Load templates when reaching the templates step
  useEffect(() => {
    if (currentStep === 'templates' && templates.length === 0) {
      setTemplatesLoading(true)
      fetch(`${API_URL}/api/agent-templates`, { credentials: 'include' })
        .then(r => r.json())
        .then((data: any) => {
          const list: AgentTemplate[] = data.templates ?? []
          setTemplates(list)
          // Deep-link: pre-select template from website referral
          if (Platform.OS === 'web' && typeof localStorage !== 'undefined') {
            const pending = localStorage.getItem('pending_template_id')
            if (pending && list.some(t => t.id === pending)) {
              setSelectedTemplate(pending)
            }
          }
        })
        .catch(() => {})
        .finally(() => setTemplatesLoading(false))
    }
  }, [currentStep])

  const goNext = useCallback(() => {
    if (currentStepIdx < steps.length - 1) {
      setCurrentStepIdx(i => i + 1)
    }
  }, [currentStepIdx, steps.length])

  const goBack = useCallback(() => {
    if (currentStepIdx > 0) {
      setCurrentStepIdx(i => i - 1)
    }
  }, [currentStepIdx])

  // -- Account creation
  const handleCreateAccount = useCallback(async () => {
    setAuthError(null)
    setIsSigningUp(true)
    try {
      await signUp(name, email, password)
      invalidatePlatformConfigCache()
      // In local mode, proceed to security preference step before redirecting
      goNext()
    } catch (e: any) {
      setAuthError(e.message || 'Failed to create account')
    } finally {
      setIsSigningUp(false)
    }
  }, [name, email, password, signUp, goNext])

  // Save security preference and complete local onboarding
  const handleSaveSecurityAndComplete = useCallback(async () => {
    setIsSavingSecurity(true)
    const http = createHttpClient()
    try {
      await api.saveSecurityPrefs(http, {
        mode: securityMode,
        approvalTimeoutSeconds: 60,
      })
    } catch {
      // Non-critical — defaults to balanced if save fails
    }

    await api.completeOnboarding(http).catch(() => {})

    setIsSavingSecurity(false)
    router.replace('/(admin)')
  }, [securityMode, router])

  // -- Test LLM connection
  const handleTestConnection = useCallback(async () => {
    if (!llmBaseUrl) return
    setIsTesting(true)
    setConnectionStatus('idle')
    try {
      const res = await fetch(
        `${API_URL}/api/local/models?baseUrl=${encodeURIComponent(llmBaseUrl)}`,
        { credentials: 'include' }
      )
      const data = await res.json() as { ok: boolean; models: ModelInfo[] }
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
  }, [llmBaseUrl])

  // -- Save AI config
  const handleSaveAIConfig = useCallback(async () => {
    setIsSavingAI(true)
    try {
      if (aiMode === 'api-keys') {
        const body: Record<string, string> = {}
        if (anthropicKey) body.anthropicApiKey = anthropicKey
        if (openaiKey) body.openaiApiKey = openaiKey
        const res = await fetch(`${API_URL}/api/local/api-keys`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify(body),
        })
        if (!res.ok) throw new Error('Failed to save API keys')
      } else if (aiMode === 'local-llm') {
        const llmBody: Record<string, string | null> = {
          LOCAL_LLM_BASE_URL: llmBaseUrl || null,
          LOCAL_LLM_BASIC_MODEL: basicModel || null,
          LOCAL_LLM_ADVANCED_MODEL: advancedModel || null,
        }
        const res = await fetch(`${API_URL}/api/local/llm-config`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify(llmBody),
        })
        if (!res.ok) throw new Error('Failed to save LLM config')
      }
      setAiSaved(true)
      goNext()
    } catch {
      // stay on step
    } finally {
      setIsSavingAI(false)
    }
  }, [aiMode, anthropicKey, openaiKey, llmBaseUrl, basicModel, advancedModel, goNext])

  // -- Complete onboarding
  const handleComplete = useCallback(async () => {
    setIsCompleting(true)
    try {
      await fetch(`${API_URL}/api/onboarding/complete`, {
        method: 'POST',
        credentials: 'include',
      })
      trackEvent(posthog, EVENTS.ONBOARDING_COMPLETED, {
        selected_template: selectedTemplate || null,
      })
      router.replace('/(app)')
    } catch {
      router.replace('/(app)')
    } finally {
      setIsCompleting(false)
    }
  }, [router, posthog, selectedTemplate])

  // ==========================================================================
  // Render
  // ==========================================================================

  return (
    <ScrollView
      className="flex-1 bg-background"
      contentContainerClassName="flex-grow"
      keyboardShouldPersistTaps="handled"
    >
      <View className={cn('flex-1 px-6 py-10', isWide && 'items-center')}>
        <View className={cn('w-full', isWide && 'max-w-lg')}>
          {/* Progress indicator */}
          <View className="flex-row items-center justify-center gap-1.5 mb-10">
            {steps.map((_, i) => (
              <View
                key={i}
                className={cn(
                  'h-1.5 rounded-full',
                  i === currentStepIdx ? 'w-8 bg-primary' : 'w-1.5 bg-muted-foreground/30'
                )}
              />
            ))}
          </View>

          {/* Step content */}
          {currentStep === 'welcome' && (
            <WelcomeStep
              name={user?.name}
              localMode={localMode}
              onNext={goNext}
            />
          )}

          {currentStep === 'create-account' && (
            <CreateAccountStep
              name={name}
              email={email}
              password={password}
              onNameChange={setName}
              onEmailChange={setEmail}
              onPasswordChange={setPassword}
              onSubmit={handleCreateAccount}
              isLoading={isSigningUp || authLoading}
              error={authError}
            />
          )}

          {currentStep === 'security-preference' && (
            <SecurityPreferenceStep
              value={securityMode}
              onChange={setSecurityMode}
              onComplete={handleSaveSecurityAndComplete}
              isLoading={isSavingSecurity}
            />
          )}

          {currentStep === 'configure-ai' && (
            <ConfigureAIStep
              aiMode={aiMode}
              onAiModeChange={setAiMode}
              anthropicKey={anthropicKey}
              openaiKey={openaiKey}
              onAnthropicKeyChange={setAnthropicKey}
              onOpenaiKeyChange={setOpenaiKey}
              llmBaseUrl={llmBaseUrl}
              onLlmBaseUrlChange={setLlmBaseUrl}
              basicModel={basicModel}
              advancedModel={advancedModel}
              onBasicModelChange={setBasicModel}
              onAdvancedModelChange={setAdvancedModel}
              models={models}
              connectionStatus={connectionStatus}
              isTesting={isTesting}
              onTestConnection={handleTestConnection}
              onSave={handleSaveAIConfig}
              isSaving={isSavingAI}
              onSkip={goNext}
            />
          )}

          {currentStep === 'features' && (
            <FeaturesStep onNext={goNext} />
          )}

          {currentStep === 'templates' && (
            <TemplatesStep
              templates={templates}
              selectedTemplate={selectedTemplate}
              onSelect={setSelectedTemplate}
              isLoading={templatesLoading}
              onNext={goNext}
            />
          )}

          {currentStep === 'get-started' && (
            <GetStartedStep
              localMode={localMode}
              selectedTemplate={selectedTemplate}
              templates={templates}
              onComplete={handleComplete}
              isCompleting={isCompleting}
            />
          )}

          {/* Navigation */}
          {currentStep !== 'welcome' && currentStep !== 'get-started' && currentStep !== 'security-preference' && (
            <View className="flex-row items-center justify-between mt-10">
              <Pressable
                onPress={goBack}
                className="flex-row items-center gap-1 py-2 px-3"
              >
                <ChevronLeft size={16} className="text-muted-foreground" />
                <Text className="text-sm text-muted-foreground">Back</Text>
              </Pressable>
              <View />
            </View>
          )}
        </View>
      </View>
    </ScrollView>
  )
}

// =============================================================================
// Step Components
// =============================================================================

function WelcomeStep({
  name,
  localMode,
  onNext,
}: {
  name?: string | null
  localMode: boolean
  onNext: () => void
}) {
  return (
    <View className="items-center gap-6">
      <View className="w-16 h-16 rounded-2xl bg-primary/10 items-center justify-center">
        <Sparkles size={32} className="text-primary" />
      </View>

      <View className="items-center gap-3">
        <Text className="text-3xl font-bold text-foreground text-center">
          {name ? `Welcome to Shogo, ${name}!` : 'Welcome to Shogo'}
        </Text>
        <Text className="text-base text-muted-foreground text-center leading-6 max-w-sm">
          {localMode
            ? 'Your private AI agent platform, running entirely on your machine. Create your admin account and then configure your AI settings.'
            : 'Build and deploy AI agents that work for you. Let\'s show you around.'}
        </Text>
      </View>

      <Pressable
        onPress={onNext}
        accessibilityRole="button"
        accessibilityLabel="Get Started"
        className="flex-row items-center gap-2 bg-primary px-8 py-3.5 rounded-xl mt-4"
      >
        <Text className="text-base font-semibold text-primary-foreground">Get Started</Text>
        <ArrowRight size={18} color="#fff" />
      </Pressable>
    </View>
  )
}

function CreateAccountStep({
  name,
  email,
  password,
  onNameChange,
  onEmailChange,
  onPasswordChange,
  onSubmit,
  isLoading,
  error,
}: {
  name: string
  email: string
  password: string
  onNameChange: (v: string) => void
  onEmailChange: (v: string) => void
  onPasswordChange: (v: string) => void
  onSubmit: () => void
  isLoading: boolean
  error: string | null
}) {
  return (
    <View className="gap-6">
      <View className="gap-2">
        <Text className="text-2xl font-bold text-foreground">Create your account</Text>
        <Text className="text-sm text-muted-foreground leading-5">
          As the first user, you'll be the administrator of this Shogo instance.
        </Text>
      </View>

      {error && (
        <View className="flex-row items-center gap-2 bg-destructive/10 px-4 py-3 rounded-lg">
          <AlertTriangle size={16} className="text-destructive" />
          <Text className="text-sm text-destructive flex-1">{error}</Text>
        </View>
      )}

      <View className="gap-4">
        <FieldInput label="Name" value={name} onChangeText={onNameChange} placeholder="Your name" autoCapitalize="words" />
        <FieldInput label="Email" value={email} onChangeText={onEmailChange} placeholder="you@example.com" keyboardType="email-address" autoCapitalize="none" />
        <FieldInput label="Password" value={password} onChangeText={onPasswordChange} placeholder="Choose a password" secureTextEntry />
      </View>

      <Pressable
        onPress={onSubmit}
        disabled={isLoading || !name || !email || !password}
        className={cn(
          'flex-row items-center justify-center gap-2 py-3.5 rounded-xl',
          isLoading || !name || !email || !password ? 'bg-primary/50' : 'bg-primary'
        )}
      >
        {isLoading ? (
          <ActivityIndicator size="small" color="#fff" />
        ) : (
          <>
            <Text className="text-base font-semibold text-primary-foreground">Create Account</Text>
            <ArrowRight size={18} color="#fff" />
          </>
        )}
      </Pressable>
    </View>
  )
}

function ConfigureAIStep({
  aiMode,
  onAiModeChange,
  anthropicKey,
  openaiKey,
  onAnthropicKeyChange,
  onOpenaiKeyChange,
  llmBaseUrl,
  onLlmBaseUrlChange,
  basicModel,
  advancedModel,
  onBasicModelChange,
  onAdvancedModelChange,
  models,
  connectionStatus,
  isTesting,
  onTestConnection,
  onSave,
  isSaving,
  onSkip,
}: {
  aiMode: AIConfigMode
  onAiModeChange: (m: AIConfigMode) => void
  anthropicKey: string
  openaiKey: string
  onAnthropicKeyChange: (v: string) => void
  onOpenaiKeyChange: (v: string) => void
  llmBaseUrl: string
  onLlmBaseUrlChange: (v: string) => void
  basicModel: string
  advancedModel: string
  onBasicModelChange: (v: string) => void
  onAdvancedModelChange: (v: string) => void
  models: ModelInfo[]
  connectionStatus: 'idle' | 'connected' | 'error'
  isTesting: boolean
  onTestConnection: () => void
  onSave: () => void
  isSaving: boolean
  onSkip: () => void
}) {
  return (
    <View className="gap-6">
      <View className="gap-2">
        <Text className="text-2xl font-bold text-foreground">Configure AI</Text>
        <Text className="text-sm text-muted-foreground leading-5">
          Shogo needs an AI provider to power its agents. Choose how you'd like to connect.
        </Text>
      </View>

      {/* Mode selection */}
      <View className="gap-3">
        <Pressable
          onPress={() => onAiModeChange('api-keys')}
          className={cn(
            'flex-row items-center gap-4 p-4 rounded-xl border',
            aiMode === 'api-keys' ? 'border-primary bg-primary/5' : 'border-border bg-card'
          )}
        >
          <View className={cn(
            'w-10 h-10 rounded-lg items-center justify-center',
            aiMode === 'api-keys' ? 'bg-primary/10' : 'bg-muted'
          )}>
            <Key size={20} className={aiMode === 'api-keys' ? 'text-primary' : 'text-muted-foreground'} />
          </View>
          <View className="flex-1">
            <Text className="text-sm font-semibold text-foreground">Cloud API Keys</Text>
            <Text className="text-xs text-muted-foreground mt-0.5">Use Anthropic or OpenAI API keys</Text>
          </View>
          {aiMode === 'api-keys' && <Check size={18} className="text-primary" />}
        </Pressable>

        <Pressable
          onPress={() => onAiModeChange('local-llm')}
          className={cn(
            'flex-row items-center gap-4 p-4 rounded-xl border',
            aiMode === 'local-llm' ? 'border-primary bg-primary/5' : 'border-border bg-card'
          )}
        >
          <View className={cn(
            'w-10 h-10 rounded-lg items-center justify-center',
            aiMode === 'local-llm' ? 'bg-primary/10' : 'bg-muted'
          )}>
            <Server size={20} className={aiMode === 'local-llm' ? 'text-primary' : 'text-muted-foreground'} />
          </View>
          <View className="flex-1">
            <Text className="text-sm font-semibold text-foreground">Local LLM</Text>
            <Text className="text-xs text-muted-foreground mt-0.5">Connect to Ollama, LM Studio, etc.</Text>
          </View>
          {aiMode === 'local-llm' && <Check size={18} className="text-primary" />}
        </Pressable>
      </View>

      {/* API Keys form */}
      {aiMode === 'api-keys' && (
        <View className="gap-4 bg-card border border-border rounded-xl p-5">
          <FieldInput
            label="Anthropic API Key"
            value={anthropicKey}
            onChangeText={onAnthropicKeyChange}
            placeholder="sk-ant-..."
            secureTextEntry
            autoCapitalize="none"
            hint="Required. Get yours at console.anthropic.com"
          />
          <FieldInput
            label="OpenAI API Key (optional)"
            value={openaiKey}
            onChangeText={onOpenaiKeyChange}
            placeholder="sk-..."
            secureTextEntry
            autoCapitalize="none"
            hint="Used for embeddings and fallback"
          />
        </View>
      )}

      {/* Local LLM form */}
      {aiMode === 'local-llm' && (
        <View className="gap-4 bg-card border border-border rounded-xl p-5">
          <View className="gap-2">
            <FieldInput
              label="Base URL"
              value={llmBaseUrl}
              onChangeText={onLlmBaseUrlChange}
              placeholder="http://localhost:11434"
              autoCapitalize="none"
            />
            <View className="flex-row items-center gap-3 mt-1">
              <Pressable
                onPress={onTestConnection}
                disabled={isTesting || !llmBaseUrl}
                className={cn(
                  'flex-row items-center gap-2 px-4 py-2 rounded-lg',
                  !llmBaseUrl ? 'bg-muted opacity-50' : 'bg-primary'
                )}
              >
                {isTesting ? (
                  <ActivityIndicator size="small" color="#fff" />
                ) : (
                  <Zap size={14} color="#fff" />
                )}
                <Text className="text-sm font-medium text-primary-foreground">Test</Text>
              </Pressable>
              {connectionStatus === 'connected' && (
                <View className="flex-row items-center gap-1.5">
                  <CheckCircle size={14} className="text-green-500" />
                  <Text className="text-xs text-green-500">{models.length} model(s) found</Text>
                </View>
              )}
              {connectionStatus === 'error' && (
                <View className="flex-row items-center gap-1.5">
                  <AlertTriangle size={14} className="text-destructive" />
                  <Text className="text-xs text-destructive">Cannot reach server</Text>
                </View>
              )}
            </View>
          </View>
          <ModelSelector label="Basic Model" value={basicModel} onChange={onBasicModelChange} models={models} placeholder="e.g. llama3, mistral" />
          <ModelSelector label="Advanced Model" value={advancedModel} onChange={onAdvancedModelChange} models={models} placeholder="e.g. qwen2.5:72b" />
        </View>
      )}

      {/* Actions */}
      {aiMode && (
        <Pressable
          onPress={onSave}
          disabled={isSaving || (aiMode === 'api-keys' && !anthropicKey)}
          accessibilityRole="button"
          accessibilityLabel="Save and Continue"
          className={cn(
            'flex-row items-center justify-center gap-2 py-3.5 rounded-xl',
            isSaving || (aiMode === 'api-keys' && !anthropicKey) ? 'bg-primary/50' : 'bg-primary'
          )}
        >
          {isSaving ? (
            <ActivityIndicator size="small" color="#fff" />
          ) : (
            <>
              <Text className="text-base font-semibold text-primary-foreground">Save & Continue</Text>
              <ArrowRight size={18} color="#fff" />
            </>
          )}
        </Pressable>
      )}

      <Pressable onPress={onSkip} className="items-center py-2">
        <Text className="text-sm text-muted-foreground">Skip for now</Text>
      </Pressable>
    </View>
  )
}

const FEATURES = [
  {
    icon: Bot,
    title: 'AI Agents',
    description: 'Create intelligent agents that understand context and execute complex tasks autonomously.',
  },
  {
    icon: Wrench,
    title: 'Tools & Integrations',
    description: 'Connect to GitHub, Slack, databases, and more. Agents can use tools to interact with the real world.',
  },
  {
    icon: MessageSquare,
    title: 'Chat-Driven',
    description: 'Talk to your agents in natural language. They plan, execute, and report back in real time.',
  },
]

function FeaturesStep({ onNext }: { onNext: () => void }) {
  return (
    <View className="gap-8">
      <View className="gap-2">
        <Text className="text-2xl font-bold text-foreground">What you can do with Shogo</Text>
        <Text className="text-sm text-muted-foreground leading-5">
          Here's a quick overview of what's possible.
        </Text>
      </View>

      <View className="gap-4">
        {FEATURES.map((f, i) => (
          <View key={i} className="flex-row gap-4 p-4 bg-card border border-border rounded-xl">
            <View className="w-10 h-10 rounded-lg bg-primary/10 items-center justify-center shrink-0">
              <f.icon size={20} className="text-primary" />
            </View>
            <View className="flex-1">
              <Text className="text-sm font-semibold text-foreground">{f.title}</Text>
              <Text className="text-xs text-muted-foreground mt-1 leading-4">{f.description}</Text>
            </View>
          </View>
        ))}
      </View>

      <Pressable
        onPress={onNext}
        accessibilityRole="button"
        accessibilityLabel="Continue"
        className="flex-row items-center justify-center gap-2 bg-primary py-3.5 rounded-xl"
      >
        <Text className="text-base font-semibold text-primary-foreground">Continue</Text>
        <ArrowRight size={18} color="#fff" />
      </Pressable>
    </View>
  )
}

const TEMPLATE_COLORS: Record<string, string> = {
  'research-assistant': '#3b82f6',
  'github-ops': '#f97316',
  'support-desk': '#8b5cf6',
  'meeting-prep': '#10b981',
  'revenue-tracker': '#ec4899',
  'project-board': '#06b6d4',
  'incident-commander': '#ef4444',
  'personal-assistant': '#f59e0b',
}

function TemplatesStep({
  templates,
  selectedTemplate,
  onSelect,
  isLoading,
  onNext,
}: {
  templates: AgentTemplate[]
  selectedTemplate: string | null
  onSelect: (id: string | null) => void
  isLoading: boolean
  onNext: () => void
}) {
  return (
    <View className="gap-6">
      <View className="gap-2">
        <Text className="text-2xl font-bold text-foreground">Start with a template</Text>
        <Text className="text-sm text-muted-foreground leading-5">
          Pick a template to create your first project, or skip to start from scratch.
        </Text>
      </View>

      {isLoading ? (
        <View className="items-center py-12">
          <ActivityIndicator size="large" />
        </View>
      ) : (
        <View className="gap-3">
          {templates.slice(0, 6).map(t => {
            const color = TEMPLATE_COLORS[t.id] || '#6366f1'
            const isSelected = selectedTemplate === t.id
            return (
              <Pressable
                key={t.id}
                onPress={() => onSelect(isSelected ? null : t.id)}
                className={cn(
                  'flex-row items-center gap-3.5 p-3.5 rounded-xl border',
                  isSelected ? 'border-primary bg-primary/5' : 'border-border bg-card'
                )}
              >
                <View
                  className="w-10 h-10 rounded-lg items-center justify-center"
                  style={{ backgroundColor: `${color}15` }}
                >
                  <Text style={{ fontSize: 20 }}>{t.icon}</Text>
                </View>
                <View className="flex-1">
                  <Text className="text-sm font-semibold text-foreground">{t.name}</Text>
                  <Text className="text-xs text-muted-foreground mt-0.5" numberOfLines={1}>
                    {t.description}
                  </Text>
                </View>
                {isSelected && <Check size={18} className="text-primary" />}
              </Pressable>
            )
          })}
        </View>
      )}

      <Pressable
        onPress={onNext}
        accessibilityRole="button"
        accessibilityLabel={selectedTemplate ? 'Continue with template' : 'Skip and continue'}
        className="flex-row items-center justify-center gap-2 bg-primary py-3.5 rounded-xl"
      >
        <Text className="text-base font-semibold text-primary-foreground">
          {selectedTemplate ? 'Continue with template' : 'Skip & continue'}
        </Text>
        <ArrowRight size={18} color="#fff" />
      </Pressable>
    </View>
  )
}

function GetStartedStep({
  localMode,
  selectedTemplate,
  templates,
  onComplete,
  isCompleting,
}: {
  localMode: boolean
  selectedTemplate: string | null
  templates: AgentTemplate[]
  onComplete: () => void
  isCompleting: boolean
}) {
  const template = templates.find(t => t.id === selectedTemplate)
  return (
    <View className="items-center gap-6">
      <View className="w-16 h-16 rounded-full bg-green-500/10 items-center justify-center">
        <CheckCircle size={32} className="text-green-500" />
      </View>

      <View className="items-center gap-3">
        <Text className="text-2xl font-bold text-foreground text-center">You're all set!</Text>
        <Text className="text-base text-muted-foreground text-center leading-6 max-w-sm">
          {template
            ? `We'll create a "${template.name}" project for you to explore.`
            : 'You can create your first project from the home screen.'}
        </Text>
      </View>

      {localMode && (
        <View className="bg-card border border-border rounded-xl p-4 w-full">
          <Text className="text-xs text-muted-foreground leading-4 text-center">
            You can change AI settings anytime from the Super Admin panel (accessible from the sidebar menu).
          </Text>
        </View>
      )}

      <Pressable
        onPress={onComplete}
        disabled={isCompleting}
        accessibilityRole="button"
        accessibilityLabel="Enter Shogo"
        accessibilityState={{ disabled: isCompleting }}
        className={cn(
          'flex-row items-center gap-2 px-8 py-3.5 rounded-xl mt-2',
          isCompleting ? 'bg-primary/50' : 'bg-primary'
        )}
      >
        {isCompleting ? (
          <ActivityIndicator size="small" color="#fff" />
        ) : (
          <>
            <Text className="text-base font-semibold text-primary-foreground">Enter Shogo</Text>
            <ArrowRight size={18} color="#fff" />
          </>
        )}
      </Pressable>
    </View>
  )
}

// =============================================================================
// Shared Components
// =============================================================================

function FieldInput({
  label,
  hint,
  ...inputProps
}: {
  label: string
  hint?: string
} & React.ComponentProps<typeof TextInput>) {
  return (
    <View className="gap-1.5">
      <Text className="text-sm font-medium text-foreground">{label}</Text>
      {hint && <Text className="text-xs text-muted-foreground">{hint}</Text>}
      <TextInput
        {...inputProps}
        className="bg-background border border-border rounded-lg px-3 py-2.5 text-sm text-foreground"
        placeholderTextColor="#999"
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
    <View className="gap-1.5">
      <Text className="text-sm font-medium text-foreground">{label}</Text>
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
            className="flex-1 bg-background border border-border rounded-lg px-3 py-2.5 text-sm text-foreground"
            placeholderTextColor="#999"
            autoCapitalize="none"
            autoCorrect={false}
          />
          {models.length > 0 && (
            <Pressable onPress={() => setOpen(!open)} className="absolute right-2 p-1">
              <ChevronDown size={14} className="text-muted-foreground" />
            </Pressable>
          )}
        </View>
        {open && filtered.length > 0 && (
          <View className="absolute top-12 left-0 right-0 z-50 bg-card border border-border rounded-lg max-h-36 overflow-hidden">
            <ScrollView>
              {filtered.map(m => (
                <Pressable
                  key={m.id}
                  onPress={() => { onChange(m.id); setOpen(false) }}
                  className="px-3 py-2.5 border-b border-border/50 active:bg-muted"
                >
                  <Text className="text-sm text-foreground">{m.id}</Text>
                </Pressable>
              ))}
            </ScrollView>
          </View>
        )}
      </View>
    </View>
  )
}

function SecurityPreferenceStep({
  value,
  onChange,
  onComplete,
  isLoading,
}: {
  value: 'strict' | 'balanced' | 'full_autonomy'
  onChange: (mode: 'strict' | 'balanced' | 'full_autonomy') => void
  onComplete: () => void
  isLoading: boolean
}) {
  return (
    <View className="gap-6">
      <View className="items-center gap-3">
        <View className="w-14 h-14 rounded-2xl bg-primary/10 items-center justify-center">
          <Shield size={28} className="text-primary" />
        </View>

        <Text className="text-2xl font-bold text-foreground text-center">
          How should Shogo handle permissions?
        </Text>
        <Text className="text-sm text-muted-foreground text-center leading-5 max-w-sm">
          Choose how much control the AI agent has on your machine. You can change this anytime in Settings.
        </Text>
      </View>

      <SecurityPreferenceSelector value={value} onChange={onChange} />

      <Text className="text-xs text-muted-foreground text-center leading-4">
        Regardless of mode, Shogo never accesses ~/.ssh, system credentials, or runs sudo commands.
      </Text>

      <Pressable
        onPress={onComplete}
        disabled={isLoading}
        accessibilityRole="button"
        accessibilityLabel="Continue"
        accessibilityState={{ disabled: isLoading }}
        className={cn(
          'flex-row items-center justify-center gap-2 py-3.5 rounded-xl',
          isLoading ? 'bg-primary/50' : 'bg-primary',
        )}
      >
        {isLoading ? (
          <ActivityIndicator size="small" className="text-primary-foreground" />
        ) : (
          <>
            <Text className="text-base font-semibold text-primary-foreground">Continue</Text>
            <ArrowRight size={18} className="text-primary-foreground" />
          </>
        )}
      </Pressable>
    </View>
  )
}

