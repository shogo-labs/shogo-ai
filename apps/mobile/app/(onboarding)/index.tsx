// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { useState, useCallback, useMemo } from 'react'
import { Platform } from 'react-native'
import { useRouter } from 'expo-router'
import { usePostHogSafe } from '../../contexts/posthog'
import { usePlatformConfig } from '../../lib/platform-config'
import { API_URL, api, createHttpClient } from '../../lib/api'
import { EVENTS, trackEvent } from '../../lib/analytics'
import { safeSetItem } from '../../lib/safe-storage'
import { ChatOnboarding, type OnboardingStep, type WidgetType } from '../../components/onboarding/ChatOnboarding'
import { VMProgress } from '../../components/onboarding/VMProgress'
import { NameInput } from '../../components/onboarding/steps/NameInput'
import { AIConfigForm } from '../../components/onboarding/steps/AIConfigForm'
import { SecurityForm } from '../../components/onboarding/steps/SecurityForm'
import { FeaturesWidget } from '../../components/onboarding/steps/FeaturesWidget'
import { TemplatesWidget } from '../../components/onboarding/steps/TemplatesWidget'
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

  if (isDesktop()) {
    steps.push({
      id: 'vm-download',
      text: "I\u2019m setting up a secure sandbox environment in the background. This is a one-time download.",
      widget: 'vm-progress',
      autoAdvance: true,
      advanceDelay: 1200,
    })
  }

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
      text: "Welcome to Shogo! Let\u2019s show you around.",
      autoAdvance: true,
      advanceDelay: 800,
    },
    {
      id: 'features',
      text: "Here\u2019s what you can build:",
      widget: 'features',
    },
    {
      id: 'templates',
      text: "Want to start with a template? Pick one to create your first project, or skip to start from scratch.",
      widget: 'templates',
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
  const [selectedTemplate, setSelectedTemplate] = useState<string | null>(null)

  const isLocal = localMode && (needsSetup ?? false)
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
        selected_template: selectedTemplate || null,
      })
      if (selectedTemplate) {
        safeSetItem('pending_template_id', selectedTemplate)
      }
    } catch {}
    router.replace('/(app)')
  }, [router, posthog, isLocal, selectedTemplate])

  const handleVMDownloadNeeded = useCallback(() => {
    // VM download is auto-started by the VMProgress widget
  }, [])

  const renderWidget = useCallback((widget: WidgetType, onComplete: () => void) => {
    switch (widget) {
      case 'vm-progress':
        return <VMProgress autoStart />
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
      case 'features':
        return <FeaturesWidget onComplete={onComplete} />
      case 'templates':
        return (
          <TemplatesWidget
            onComplete={onComplete}
            onSelectTemplate={setSelectedTemplate}
            selectedTemplate={selectedTemplate}
          />
        )
      case 'complete':
        return <CompleteWidget onEnter={handleComplete} />
      default:
        return null
    }
  }, [selectedTemplate, handleComplete])

  return (
    <ChatOnboarding
      steps={steps}
      renderWidget={renderWidget}
      context={context}
      onVMDownloadNeeded={handleVMDownloadNeeded}
    />
  )
}
