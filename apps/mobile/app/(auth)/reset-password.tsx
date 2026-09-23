// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { useCallback, useMemo, useState } from 'react'
import { View, Text, ActivityIndicator, Pressable } from 'react-native'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { Eye, EyeOff } from 'lucide-react-native'
import { api, createHttpClient } from '../../lib/api'
import { Button, Input, Alert, AlertDescription } from '@shogo/shared-ui/primitives'
import { AuthSurface } from './AuthSurface'

const TOGGLE_ICON = '#71717a'
const ACTIVITY_ON_BRAND = '#ffffff'

export default function ResetPasswordScreen() {
  const router = useRouter()
  const params = useLocalSearchParams<{ token?: string; error?: string }>()
  const token = useMemo(() => {
    const t = params.token
    if (typeof t === 'string') return t
    if (Array.isArray(t)) return t[0]
    return undefined
  }, [params.token])

  const queryError = useMemo(() => {
    const e = params.error
    if (typeof e === 'string') return e
    if (Array.isArray(e)) return e[0]
    return undefined
  }, [params.error])

  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  const invalidToken = queryError === 'INVALID_TOKEN' || (!token && !!queryError)

  const handleSubmit = useCallback(async () => {
    if (!token || password.length < 8) {
      setFormError(password.length > 0 && password.length < 8 ? 'Use at least 8 characters' : 'Enter a new password')
      return
    }
    setFormError(null)
    setSubmitting(true)
    try {
      const http = createHttpClient()
      await api.authResetPassword(http, { newPassword: password, token })
      router.replace('/(auth)/sign-in')
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Could not reset password'
      setFormError(msg)
    } finally {
      setSubmitting(false)
    }
  }, [token, password, router])

  if (!token && !queryError) {
    return (
      <AuthSurface
        eyebrow="Password recovery"
        title="Open your reset link"
        description="Use the secure link in your email to choose a new password."
      >
        <Button variant="brand" onPress={() => router.replace('/(auth)/sign-in')}>
          Back to sign in
        </Button>
      </AuthSurface>
    )
  }

  if (invalidToken || !token) {
    return (
      <AuthSurface
        eyebrow="Password recovery"
        title="That link has expired"
        description="Request a fresh reset link from the sign-in screen to continue."
      >
        <Alert variant="destructive" className="mb-5">
          <AlertDescription>
            This reset link is invalid or has expired. Request a new one from the sign-in page.
          </AlertDescription>
        </Alert>
        <Button variant="brand" onPress={() => router.replace('/(auth)/sign-in')}>
          Back to sign in
        </Button>
      </AuthSurface>
    )
  }

  return (
    <AuthSurface
      eyebrow="Password recovery"
      title="Choose a new password"
      description="Make it at least eight characters. You’ll be signed in securely when you’re done."
    >
      <View className="gap-1.5 mb-5">
          <Text className="text-sm font-medium text-foreground">New password</Text>
          <View className="relative">
            <Input
              placeholder="At least 8 characters"
              secureTextEntry={!showPassword}
              value={password}
              onChangeText={(t: string) => { setPassword(t); setFormError(null) }}
              disabled={submitting}
              onSubmitEditing={handleSubmit}
              returnKeyType="go"
            />
            <Pressable
              onPress={() => setShowPassword((s) => !s)}
              className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5"
              disabled={submitting}
              role="button"
              accessibilityLabel={showPassword ? 'Hide password' : 'Show password'}
            >
              {showPassword ? (
                <EyeOff size={20} color={TOGGLE_ICON} strokeWidth={2} />
              ) : (
                <Eye size={20} color={TOGGLE_ICON} strokeWidth={2} />
              )}
            </Pressable>
          </View>
        </View>

        {formError ? (
          <Alert variant="destructive" className="mb-4">
            <AlertDescription>{formError}</AlertDescription>
          </Alert>
        ) : null}

        <Button variant="brand" onPress={handleSubmit} disabled={submitting || password.length < 8}>
          {submitting ? <ActivityIndicator color={ACTIVITY_ON_BRAND} size="small" /> : 'Update password'}
        </Button>

        <Pressable onPress={() => router.replace('/(auth)/sign-in')} className="mt-5 self-center py-2">
          <Text className="text-sm text-brand-landing">Back to sign in</Text>
        </Pressable>
    </AuthSurface>
  )
}
