// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { useState, useCallback, useEffect } from 'react'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { ActivityIndicator, Text, View } from 'react-native'
import { Mail } from 'lucide-react-native'
import { useAuth } from '../../contexts/auth'
import { Button } from '@shogo/shared-ui/primitives'
import { AuthSurface } from './AuthSurface'

const RESEND_COOLDOWN_SECONDS = 60

export default function VerifyEmailScreen() {
  const router = useRouter()
  const params = useLocalSearchParams<{ email: string; next?: string }>()
  const email = typeof params.email === 'string' ? params.email : ''
  // Preserve the `next` redirect target across the verification round-trip
  // so the desktop cloud-login bridge survives a sign-up + email-verify
  // flow (otherwise the post-verify "Back to Sign In" button drops the
  // user on a fresh /sign-in with no `next` and the device-code state
  // never gets approved).
  const nextPath =
    typeof params.next === 'string' && params.next.startsWith('/') && !params.next.startsWith('//')
      ? params.next
      : undefined
  const { sendVerificationEmail } = useAuth()

  const [isResending, setIsResending] = useState(false)
  const [cooldown, setCooldown] = useState(0)
  const [resendCount, setResendCount] = useState(0)
  const [resendError, setResendError] = useState<string | null>(null)

  useEffect(() => {
    if (cooldown <= 0) return
    const timer = setInterval(() => {
      setCooldown((seconds) => Math.max(0, seconds - 1))
    }, 1000)
    return () => clearInterval(timer)
  }, [cooldown])

  const handleResend = useCallback(async () => {
    setIsResending(true)
    setResendError(null)
    try {
      // If we have a `next`, propagate it into the verification email's
      // post-verify redirect so the loop closes cleanly.
      const verifyCallback =
        typeof window !== 'undefined' && window.location?.origin && nextPath
          ? `${window.location.origin}/sign-in?next=${encodeURIComponent(nextPath)}`
          : undefined
      await sendVerificationEmail(email, verifyCallback)
      setResendCount((count) => count + 1)
      setCooldown(RESEND_COOLDOWN_SECONDS)
    } catch (error) {
      setResendError(
        error instanceof Error ? error.message : 'We could not send another verification email. Please try again.',
      )
    } finally {
      setIsResending(false)
    }
  }, [email, nextPath, sendVerificationEmail])

  const handleBackToSignIn = useCallback(() => {
    if (nextPath) {
      router.replace({ pathname: '/(auth)/sign-in', params: { next: nextPath } } as any)
    } else {
      router.replace('/(auth)/sign-in')
    }
  }, [router, nextPath])

  const canResend = cooldown === 0 && !isResending

  return (
    <AuthSurface
      eyebrow="Account verification"
      title="Check your inbox"
      description="We sent a secure verification link to the address below."
    >
      <View className="items-center border-y border-border py-5">
        <View className="mb-3 h-11 w-11 items-center justify-center rounded-full border border-border bg-muted">
          <Mail size={20} className="text-primary" strokeWidth={1.75} />
        </View>
        <Text className="text-sm font-medium text-foreground">{email || 'your email address'}</Text>
      </View>

      <Text className="mt-5 text-sm leading-5 text-muted-foreground">
        Follow the link, then return here to sign in. Check your spam folder if it doesn’t arrive.
      </Text>

      <View className="mt-7 gap-3">
        <Button variant="brand" onPress={handleBackToSignIn}>
          Back to sign in
        </Button>
        <Button variant="outline" onPress={handleResend} disabled={!canResend}>
          {isResending ? (
            <ActivityIndicator size="small" />
          ) : cooldown > 0 ? (
            `Resend email (${cooldown}s)`
          ) : resendCount > 0 ? (
            'Resend verification email'
          ) : (
            "Didn't get it? Resend"
          )}
        </Button>
      </View>

      {resendCount > 0 && cooldown > 0 ? (
        <Text className="mt-4 text-center text-xs leading-5 text-muted-foreground">
          Verification email sent. Check your spam folder if you don’t see it.
        </Text>
      ) : null}
      {resendError ? (
        <Text accessibilityRole="alert" className="mt-4 text-center text-xs leading-5 text-destructive">
          {resendError}
        </Text>
      ) : null}
    </AuthSurface>
  )
}
