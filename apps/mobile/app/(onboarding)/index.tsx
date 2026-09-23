// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { useState, useCallback, useMemo } from 'react'
import { KeyboardAvoidingView, Platform, Text, View } from 'react-native'
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
import { FeaturesWidget } from '../../components/onboarding/steps/FeaturesWidget'
import { CompleteWidget } from '../../components/onboarding/steps/CompleteWidget'

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

function getCloudSteps(): OnboardingStep[] {
  return [
    {
      id: 'welcome',
      text: "Hello, I am Shogo. I'm going to show you around.",
      autoAdvance: true,
      advanceDelay: 800,
    },
    {
      id: 'features',
      text: "Here\u2019s what you can build:",
      widget: 'features',
    },
    {
      id: 'complete',
      text: "You\u2019re all set! Let\u2019s go.",
      widget: 'complete',
    },
  ]
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function OnboardingPage() {
  const router = useRouter()
  const posthog = usePostHogSafe()
  const { localMode, needsSetup } = usePlatformConfig()

  const [userName, setUserName] = useState('')

  const isLocal = !!localMode
  const steps = useMemo(() => (isLocal ? getLocalSteps() : getCloudSteps()), [isLocal])

  const context = useMemo(
    () => ({ userName }),
    [userName],
  )

  const handleComplete = useCallback(async () => {
    try {
      const http = createHttpClient()
      await api.completeOnboarding(http)
      trackEvent(posthog, EVENTS.ONBOARDING_COMPLETED, {
        mode: isLocal ? 'local' : 'cloud',
      })
    } catch {}
    router.replace('/(app)')
  }, [router, posthog, isLocal])

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
      case 'features':
        return <FeaturesWidget onComplete={onComplete} />
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
