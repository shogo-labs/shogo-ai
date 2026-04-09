// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { useState, useEffect, useRef, useCallback } from 'react'
import { View, ScrollView, Platform } from 'react-native'
import { OnboardingMessage } from './OnboardingMessage'

export type WidgetType =
  | 'vm-progress'
  | 'name-input'
  | 'ai-config'
  | 'security'
  | 'features'
  | 'templates'
  | 'complete'

export interface OnboardingStep {
  id: string
  text: string | ((ctx: Record<string, string>) => string)
  widget?: WidgetType
  autoAdvance?: boolean
  advanceDelay?: number
}

interface ChatOnboardingProps {
  steps: OnboardingStep[]
  renderWidget: (widget: WidgetType, onComplete: () => void) => React.ReactNode
  context?: Record<string, string>
  onVMDownloadNeeded?: () => void
}

export function ChatOnboarding({
  steps,
  renderWidget,
  context = {},
  onVMDownloadNeeded,
}: ChatOnboardingProps) {
  const [visibleCount, setVisibleCount] = useState(1)
  const [activeIndex, setActiveIndex] = useState(0)
  const [completedSteps, setCompletedSteps] = useState<Set<string>>(new Set())
  const scrollRef = useRef<ScrollView>(null)
  const vmDownloadTriggered = useRef(false)

  const scrollToBottom = useCallback(() => {
    setTimeout(() => {
      scrollRef.current?.scrollToEnd({ animated: true })
    }, 100)
  }, [])

  const advanceToNext = useCallback(() => {
    setVisibleCount(prev => {
      const next = Math.min(prev + 1, steps.length)
      return next
    })
    setActiveIndex(prev => {
      const next = Math.min(prev + 1, steps.length - 1)
      return next
    })
    scrollToBottom()
  }, [steps.length, scrollToBottom])

  const handleStreamComplete = useCallback((step: OnboardingStep) => {
    setCompletedSteps(prev => new Set(prev).add(step.id))

    if (step.widget === 'vm-progress' && !vmDownloadTriggered.current) {
      vmDownloadTriggered.current = true
      onVMDownloadNeeded?.()
    }

    if (step.autoAdvance) {
      const delay = step.advanceDelay ?? 800
      setTimeout(() => {
        advanceToNext()
      }, delay)
    }

    scrollToBottom()
  }, [advanceToNext, scrollToBottom, onVMDownloadNeeded])

  const handleWidgetComplete = useCallback(() => {
    advanceToNext()
  }, [advanceToNext])

  const resolveText = (step: OnboardingStep): string => {
    if (typeof step.text === 'function') return step.text(context)
    return step.text
  }

  return (
    <View className="flex-1 bg-background">
      <ScrollView
        ref={scrollRef}
        className="flex-1"
        contentContainerClassName="flex-grow justify-end px-6 py-10"
        keyboardShouldPersistTaps="handled"
        onContentSizeChange={() => scrollToBottom()}
      >
        <View className="w-full max-w-2xl self-center gap-8">
          {steps.slice(0, visibleCount).map((step, i) => (
            <OnboardingMessage
              key={step.id}
              text={resolveText(step)}
              isActive={i <= activeIndex}
              onStreamComplete={() => handleStreamComplete(step)}
            >
              {step.widget && completedSteps.has(step.id)
                ? renderWidget(step.widget, handleWidgetComplete)
                : null}
            </OnboardingMessage>
          ))}
        </View>
      </ScrollView>
    </View>
  )
}
