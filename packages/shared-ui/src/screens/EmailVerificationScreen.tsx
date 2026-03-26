// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * EmailVerificationScreen (React Native + NativeWind)
 *
 * Shown after email+password signup when email verification is required.
 * Displays a "check your email" message with resend + back-to-login actions.
 */

import React, { useState, useEffect, useCallback } from 'react'
import { View, Text, ActivityIndicator, Platform } from 'react-native'
import { Mail } from 'lucide-react-native'
import { Button } from '../primitives/Button'
import { Card, CardContent } from '../primitives/Card'
import { BRAND_LANDING_HEX } from '../tokens/brand'

const RESEND_COOLDOWN_SECONDS = 60

export interface EmailVerificationScreenProps {
  email: string
  onResendVerification: () => Promise<void>
  onBackToSignIn: () => void
  isResending?: boolean
  colorScheme?: 'light' | 'dark'
}

export function EmailVerificationScreen({
  email,
  onResendVerification,
  onBackToSignIn,
  isResending,
  colorScheme,
}: EmailVerificationScreenProps) {
  const [cooldown, setCooldown] = useState(0)
  const [resendCount, setResendCount] = useState(0)

  useEffect(() => {
    if (cooldown <= 0) return
    const timer = setInterval(() => {
      setCooldown((prev) => Math.max(0, prev - 1))
    }, 1000)
    return () => clearInterval(timer)
  }, [cooldown])

  const handleResend = useCallback(async () => {
    if (cooldown > 0 || isResending) return
    try {
      await onResendVerification()
      setResendCount((c) => c + 1)
    } finally {
      setCooldown(RESEND_COOLDOWN_SECONDS)
    }
  }, [cooldown, isResending, onResendVerification])

  const canResend = cooldown === 0 && !isResending

  return (
    <View
      style={{
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        padding: 16,
        backgroundColor: colorScheme === 'dark' ? '#09090b' : '#f4f4f5',
      }}
    >
      <Card className="w-full max-w-md border-border bg-card shadow-lg">
        <CardContent className="p-8">
          <View style={{ alignItems: 'center', marginBottom: 24 }}>
            <View
              style={{
                width: 64,
                height: 64,
                borderRadius: 32,
                backgroundColor: BRAND_LANDING_HEX + '18',
                justifyContent: 'center',
                alignItems: 'center',
                marginBottom: 20,
              }}
            >
              <Mail size={32} color={BRAND_LANDING_HEX} strokeWidth={1.5} />
            </View>

            <Text
              className="text-2xl font-bold text-foreground"
              style={{ textAlign: 'center', marginBottom: 8 }}
            >
              Check your email
            </Text>

            <Text
              className="text-sm text-muted-foreground"
              style={{ textAlign: 'center', lineHeight: 20 }}
            >
              We sent a verification link to
            </Text>
            <Text
              className="text-sm font-semibold text-foreground"
              style={{ textAlign: 'center', marginTop: 4 }}
            >
              {email}
            </Text>
          </View>

          <Text
            className="text-sm text-muted-foreground"
            style={{ textAlign: 'center', marginBottom: 24, lineHeight: 20 }}
          >
            Click the link in the email to verify your account, then come back
            here to sign in.
          </Text>

          <Button variant="brand" onPress={onBackToSignIn} className="mb-3">
            Back to Sign In
          </Button>

          <Button
            variant="outline"
            onPress={handleResend}
            disabled={!canResend}
          >
            {isResending ? (
              <ActivityIndicator
                size="small"
                color={colorScheme === 'dark' ? '#e4e4e7' : '#3f3f46'}
              />
            ) : cooldown > 0 ? (
              `Resend email (${cooldown}s)`
            ) : resendCount > 0 ? (
              'Resend verification email'
            ) : (
              "Didn't get it? Resend"
            )}
          </Button>

          {resendCount > 0 && cooldown > 0 ? (
            <Text
              className="text-xs text-muted-foreground"
              style={{ textAlign: 'center', marginTop: 12 }}
            >
              Verification email sent. Check your spam folder if you don't see
              it.
            </Text>
          ) : null}
        </CardContent>
      </Card>
    </View>
  )
}
