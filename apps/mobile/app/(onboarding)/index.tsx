// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { useState, useCallback, useMemo } from 'react'
import { ActivityIndicator, KeyboardAvoidingView, Platform, Text, View } from 'react-native'
import { useRouter } from 'expo-router'
import { usePostHogSafe } from '../../contexts/posthog'
import { usePlatformConfig } from '../../lib/platform-config'
import { API_URL, api, createHttpClient } from '../../lib/api'
import { EVENTS, trackEvent } from '../../lib/analytics'
import { ChatOnboarding, type OnboardingStep, type WidgetType } from '../../components/onboarding/ChatOnboarding'
import { NameInput } from '../../components/onboarding/steps/NameInput'
import { AIConfigForm } from '../../components/onboarding/steps/AIConfigForm'
import { SecurityForm } from '../../components/onboarding/steps/SecurityForm'
import { MeetingSetupForm } from '../../components/onboarding/steps/MeetingSetupForm'
import { CompleteWidget } from '../../components/onboarding/steps/CompleteWidget'
import { CloudOnboarding } from '../../components/onboarding/cloud/CloudOnboarding'

// ---------------------------------------------------------------------------
// Step sequences
// ---------------------------------------------------------------------------

function isDesktop(): boolean {
  return Platform.OS === 'web' && typeof window !== 'undefined' && !!(window as any).shogoDesktop
}

function getLocalSteps(): OnboardingStep[] {
  const steps: OnboardingStep[] = [
    {
      id: 'welcome',
      text: "Hey! Welcome to Shogo \u2014 your private AI agent platform, running entirely on your machine.",
      autoAdvance: true,
      advanceDelay: 800,
    },
  ]

  steps.push(
    {
      id: 'name',
      text: isDesktop()
        ? "While that\u2019s happening, what should I call you?"
        : "First things first \u2014 what should I call you?",
      widget: 'name-input',
    },
    {
      id: 'ai-config',
      text: (ctx) =>
        ctx.userName
          ? `Nice to meet you, ${ctx.userName}! Now, how would you like to power your AI agents?`
          : "Now, how would you like to power your AI agents?",
      widget: 'ai-config',
    },
    {
      id: 'security',
      text: "One last thing \u2014 how should I handle permissions on your machine?",
      widget: 'security',
    },
    {
      id: 'meeting-setup',
      text: "I can also record and transcribe your meetings \u2014 everything stays on your machine. How would you like that set up?",
      widget: 'meeting-setup',
    },
    {
      id: 'complete',
      text: "You\u2019re all set! You can change any of these settings from the admin panel anytime.",
      widget: 'complete',
    },
  )

  return steps
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function OnboardingPage() {
  const { localMode, configLoaded } = usePlatformConfig()
  // The pre-fetch default is cloud on plain web, so wait for the real mode
  // before mounting either flow.
  if (!configLoaded) {
    return (
      <View className="flex-1 items-center justify-center bg-background">
        <ActivityIndicator size="large" />
      </View>
    )
  }
  if (!localMode) return <CloudOnboarding />
  return <LocalOnboarding />
}

function LocalOnboarding() {
  const router = useRouter()
  const posthog = usePostHogSafe()

  const [userName, setUserName] = useState('')

  const steps = useMemo(() => getLocalSteps(), [])

  const context = useMemo(
    () => ({ userName }),
    [userName],
  )

  const handleComplete = useCallback(async () => {
    try {
      const http = createHttpClient()
      await api.completeOnboarding(http)
      trackEvent(posthog, EVENTS.ONBOARDING_COMPLETED, { mode: 'local' })
    } catch {}
    router.replace('/(app)')
  }, [router, posthog])

  const renderWidget = useCallback((widget: WidgetType, onComplete: () => void) => {
    switch (widget) {
      case 'name-input':
        return (
          <NameInput
            onComplete={(name) => {
              setUserName(name)
              onComplete()
            }}
          />
        )
      case 'ai-config':
        return <AIConfigForm onComplete={onComplete} onSkip={onComplete} />
      case 'security':
        return <SecurityForm onComplete={onComplete} />
      case 'meeting-setup':
        return <MeetingSetupForm onComplete={onComplete} />
      case 'complete':
        return <CompleteWidget onEnter={handleComplete} />
      default:
        return null
    }
  }, [handleComplete])

  return (
    <KeyboardAvoidingView
      className="flex-1 bg-muted/30 px-3 pb-3 pt-2 sm:px-6 sm:pb-6"
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <View className="w-full max-w-4xl self-center flex-1 border border-border bg-card">
        <View className="flex-row items-center justify-between border-b border-border px-5 py-4">
          <View className="flex-row items-center gap-2">
            <View className="h-5 w-5 rounded-full bg-primary" />
            <Text className="text-xs font-semibold tracking-[2px] text-foreground">SHOGO</Text>
          </View>
          <Text className="text-xs font-medium uppercase tracking-[1.5px] text-muted-foreground">
            Getting started
          </Text>
        </View>
        <View className="flex-1">
          <ChatOnboarding
            steps={steps}
            renderWidget={renderWidget}
            context={context}
          />
        </View>
      </View>
    </KeyboardAvoidingView>
  )
}
