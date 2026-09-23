// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Full-screen centered stepper used by the cloud onboarding flow.
 *
 * Steps are plain data owned by the page (which recomputes them from its
 * own state), so branching lives in the page and this component only
 * renders the chrome: wordmark + progress, heading, body, Back/Continue.
 */
import { useEffect, useRef, type ReactNode } from 'react'
import {
  ActivityIndicator,
  Animated,
  Easing,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  Text,
  useWindowDimensions,
  View,
} from 'react-native'
import { ArrowLeft, ArrowRight } from 'lucide-react-native'
import { Button, cn } from '@shogo/shared-ui/primitives'
import { ShogoWordmark } from '../branding/ShogoWordmark'

export interface StepDef {
  id: string
  eyebrow?: string
  title: string
  subtitle?: string
  body: ReactNode
  canContinue?: boolean
  primaryLabel?: string
  /** When set, renders a "skip" text link that calls `onSkip`. */
  skipLabel?: string
  hideBack?: boolean
  /** Shows a spinner in the primary button and disables the footer. */
  busy?: boolean
}

interface OnboardingStepperProps {
  steps: StepDef[]
  activeIndex: number
  onNext: () => void
  onBack: () => void
  onSkip?: () => void
  onStepViewed?: (step: StepDef, index: number) => void
  onSignOut?: () => void
}

const PHONE_BREAKPOINT = 640

export function OnboardingStepper({
  steps,
  activeIndex,
  onNext,
  onBack,
  onSkip,
  onStepViewed,
  onSignOut,
}: OnboardingStepperProps) {
  const { width } = useWindowDimensions()
  const isPhone = width < PHONE_BREAKPOINT
  const step = steps[Math.min(activeIndex, steps.length - 1)]
  const total = steps.length
  const position = Math.min(activeIndex, total - 1) + 1

  const opacity = useRef(new Animated.Value(0)).current
  const translateX = useRef(new Animated.Value(16)).current
  const lastViewed = useRef<string | null>(null)

  useEffect(() => {
    opacity.setValue(0)
    translateX.setValue(16)
    Animated.parallel([
      Animated.timing(opacity, { toValue: 1, duration: 180, easing: Easing.out(Easing.quad), useNativeDriver: true }),
      Animated.timing(translateX, { toValue: 0, duration: 180, easing: Easing.out(Easing.quad), useNativeDriver: true }),
    ]).start()
  }, [step?.id, opacity, translateX])

  useEffect(() => {
    if (!step || lastViewed.current === step.id) return
    lastViewed.current = step.id
    onStepViewed?.(step, activeIndex)
  }, [step, activeIndex, onStepViewed])

  if (!step) return null

  const showBack = activeIndex > 0 && !step.hideBack
  const disabled = step.busy || step.canContinue === false

  return (
    <View className="flex-1 bg-background">
      <View className="flex-row items-center justify-between px-5 py-4 sm:px-8">
        <ShogoWordmark className="h-6 w-24" />
        <View className="flex-row items-center gap-5">
          {total > 1 ? (
            <View
              className="flex-row items-center gap-3"
              accessibilityLabel={`Step ${position} of ${total}`}
            >
              <Text className="text-xs font-medium text-muted-foreground">
                {isPhone ? `${position}/${total}` : `Step ${position} of ${total}`}
              </Text>
              {!isPhone ? (
                <View className="flex-row items-center gap-1.5">
                  {steps.map((s, i) => (
                    <View
                      key={s.id}
                      className={cn(
                        'h-1.5 rounded-full',
                        i === activeIndex ? 'w-5 bg-primary' : 'w-1.5',
                        i < activeIndex ? 'bg-primary' : i > activeIndex ? 'bg-border' : '',
                      )}
                    />
                  ))}
                </View>
              ) : null}
            </View>
          ) : null}
          {onSignOut ? (
            <Pressable onPress={onSignOut} accessibilityRole="button">
              <Text className="text-xs text-muted-foreground web:hover:text-foreground">Sign out</Text>
            </Pressable>
          ) : null}
        </View>
      </View>

      <KeyboardAvoidingView
        className="flex-1"
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView
          className="flex-1"
          contentContainerClassName="flex-grow justify-center px-5 py-8 sm:px-8"
          keyboardShouldPersistTaps="handled"
        >
          <Animated.View
            style={{ opacity, transform: [{ translateX }] }}
            className="w-full max-w-3xl self-center"
          >
            {step.eyebrow ? (
              <Text className="mb-3 text-xs font-medium uppercase tracking-widest text-muted-foreground">
                {step.eyebrow}
              </Text>
            ) : null}
            <Text className="text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
              {step.title}
            </Text>
            {step.subtitle ? (
              <Text className="mt-3 text-base leading-6 text-muted-foreground">{step.subtitle}</Text>
            ) : null}

            <View className="mt-8">{step.body}</View>

            <View
              className={cn(
                'mt-10 gap-3',
                isPhone ? 'flex-col-reverse' : 'flex-row items-center justify-between',
              )}
            >
              {showBack ? (
                <Button
                  variant="ghost"
                  onPress={onBack}
                  disabled={step.busy}
                  className={isPhone ? 'w-full' : undefined}
                >
                  <View className="flex-row items-center gap-2">
                    <ArrowLeft size={16} className="text-muted-foreground" />
                    <Text className="text-sm font-medium text-muted-foreground">Back</Text>
                  </View>
                </Button>
              ) : (
                <View />
              )}
              <View className={cn('gap-3', isPhone ? 'w-full flex-col-reverse' : 'flex-row items-center')}>
                {step.skipLabel && onSkip ? (
                  <Button
                    variant="ghost"
                    onPress={onSkip}
                    disabled={step.busy}
                    className={isPhone ? 'w-full' : undefined}
                  >
                    {step.skipLabel}
                  </Button>
                ) : null}
                <Button
                  size="lg"
                  onPress={onNext}
                  disabled={disabled}
                  className={cn('rounded-xl px-6', isPhone && 'w-full')}
                  testID={`onboarding-continue-${step.id}`}
                >
                  {step.busy ? (
                    <ActivityIndicator size="small" className="text-primary-foreground" />
                  ) : (
                    <View className="flex-row items-center gap-2">
                      <Text className="text-sm font-semibold text-primary-foreground">
                        {step.primaryLabel ?? 'Continue'}
                      </Text>
                      <ArrowRight size={16} className="text-primary-foreground" />
                    </View>
                  )}
                </Button>
              </View>
            </View>
          </Animated.View>
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  )
}
