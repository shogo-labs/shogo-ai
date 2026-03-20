// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Universal LoginScreen (React Native + NativeWind)
 *
 * Cross-platform auth screen with sign-in/sign-up tabs.
 * Uses shared-ui primitives backed by React Native.
 */

import React, { useState, useEffect, useMemo, useRef } from 'react'
import { View, Text, TextInput, ActivityIndicator, ScrollView, KeyboardAvoidingView, Platform, Pressable, useWindowDimensions, Image } from 'react-native'
import { Button } from '../primitives/Button'
import { Card, CardContent } from '../primitives/Card'
import { Input } from '../primitives/Input'
import { Alert, AlertDescription } from '../primitives/Alert'
import { Separator } from '../primitives/Separator'
import { cn } from '../primitives/cn'

const googleLogo = require('../../../../apps/mobile/assets/google-logo.png')

const LOGIN_HERO_BREAKPOINT = 768

type Tab = 'signin' | 'signup'

export interface LoginScreenProps {
  onSignIn: (email: string, password: string) => Promise<void>
  onSignUp: (name: string, email: string, password: string) => Promise<void>
  onGoogleSignIn?: () => void
  isLoading?: boolean
  error?: string | null
  onClearError?: () => void
  colorScheme?: 'light' | 'dark'
}

function isValidEmail(email: string): boolean {
  if (!email || email.trim().length === 0) return false
  const parts = email.split('@')
  if (parts.length !== 2) return false
  const [localPart, domainPart] = parts
  if (!localPart || localPart.length === 0 || localPart.length > 64) return false
  if (localPart.startsWith('.') || localPart.endsWith('.') || localPart.includes('..')) return false
  if (!domainPart || domainPart.length === 0 || domainPart.length > 253) return false
  if (domainPart.startsWith('.') || domainPart.startsWith('-') || domainPart.endsWith('.') || domainPart.endsWith('-')) return false
  if (!domainPart.includes('.')) return false
  const domainParts = domainPart.split('.')
  if (domainParts.length < 2) return false
  const tld = domainParts[domainParts.length - 1]
  if (!tld || tld.length < 2 || !/^[a-zA-Z]+$/.test(tld)) return false
  for (const segment of domainParts) {
    if (segment.length === 0 || segment.length > 63) return false
    if (!/^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$/.test(segment)) return false
  }
  return true
}

function getPasswordStrength(password: string): { score: number; label: string; color: string } {
  if (!password) return { score: 0, label: '', color: '' }
  let score = 0
  if (password.length >= 8) score++
  if (password.length >= 12) score++
  if (/[a-z]/.test(password) && /[A-Z]/.test(password)) score++
  if (/\d/.test(password)) score++
  if (/[^a-zA-Z0-9]/.test(password)) score++
  score = Math.min(score, 4)
  const levels = [
    { label: 'Very weak', color: 'bg-red-500' },
    { label: 'Weak', color: 'bg-orange-500' },
    { label: 'Fair', color: 'bg-yellow-500' },
    { label: 'Good', color: 'bg-lime-500' },
    { label: 'Strong', color: 'bg-green-500' },
  ]
  return { score, ...levels[score] }
}

function SignInForm({ onSignIn, isLoading, error, onClearError, onScrollToBottom }: Pick<LoginScreenProps, 'onSignIn' | 'isLoading' | 'error' | 'onClearError'> & { onScrollToBottom?: () => void }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const passwordRef = useRef<TextInput>(null)

  const focusPassword = () => {
    passwordRef.current?.focus()
    setTimeout(() => onScrollToBottom?.(), 100)
  }

  const handleSubmit = async () => {
    if (!email || !password) return
    await onSignIn(email, password)
  }

  return (
    <View className="gap-4">
      <View className="gap-1.5">
        <Text className="text-sm font-medium text-foreground">Email</Text>
        <Input
          placeholder="you@example.com"
          keyboardType="email-address"
          autoCapitalize="none"
          autoCorrect={false}
          value={email}
          onChangeText={(t) => { setEmail(t); onClearError?.() }}
          disabled={isLoading}
          returnKeyType="next"
          blurOnSubmit={false}
          onSubmitEditing={focusPassword}
        />
      </View>

      <View className="gap-1.5">
        <View className="flex-row justify-between items-center">
          <Text className="text-sm font-medium text-foreground">Password</Text>
          <Pressable>
            <Text className="text-sm text-primary">Forgot password?</Text>
          </Pressable>
        </View>
        <View className="relative">
          <Input
            ref={passwordRef}
            placeholder="Enter your password"
            secureTextEntry={!showPassword}
            value={password}
            onChangeText={(t) => { setPassword(t); onClearError?.() }}
            disabled={isLoading}
            onSubmitEditing={handleSubmit}
            returnKeyType="go"
            onFocus={onScrollToBottom}
          />
          <Pressable
            onPress={() => setShowPassword(!showPassword)}
            className="absolute right-3 top-1/2 -translate-y-1/2"
            disabled={isLoading}
          >
            <Text className="text-muted-foreground text-xs">{showPassword ? '🙈' : '👁'}</Text>
          </Pressable>
        </View>
      </View>

      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      <Button onPress={handleSubmit} disabled={isLoading || !email || !password} className="mt-1">
        {isLoading ? <ActivityIndicator color="#fff" size="small" /> : 'Sign In'}
      </Button>
    </View>
  )
}

function SignUpForm({ onSignUp, isLoading, error, onClearError, onScrollToBottom }: Pick<LoginScreenProps, 'onSignUp' | 'isLoading' | 'error' | 'onClearError'> & { onScrollToBottom?: () => void }) {
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [emailTouched, setEmailTouched] = useState(false)
  const [showPassword, setShowPassword] = useState(false)
  const emailRef = useRef<TextInput>(null)
  const passwordRef = useRef<TextInput>(null)

  const isEmailValid = useMemo(() => isValidEmail(email), [email])
  const showEmailError = emailTouched && email.length > 0 && !isEmailValid
  const passwordStrength = useMemo(() => getPasswordStrength(password), [password])
  const isFormValid = name.length > 0 && isEmailValid && password.length >= 8

  const focusPassword = () => {
    passwordRef.current?.focus()
    setTimeout(() => onScrollToBottom?.(), 100)
  }

  const handleSubmit = async () => {
    if (!isFormValid) return
    await onSignUp(name, email, password)
  }

  return (
    <View className="gap-4">
      <View className="gap-1.5">
        <Text className="text-sm font-medium text-foreground">Name</Text>
        <Input
          placeholder="Enter your name"
          autoCapitalize="words"
          value={name}
          onChangeText={(t) => { setName(t); onClearError?.() }}
          disabled={isLoading}
          returnKeyType="next"
          blurOnSubmit={false}
          onSubmitEditing={() => emailRef.current?.focus()}
        />
      </View>

      <View className="gap-1.5">
        <Text className="text-sm font-medium text-foreground">Email</Text>
        <View className="relative">
          <Input
            ref={emailRef}
            placeholder="you@example.com"
            keyboardType="email-address"
            autoCapitalize="none"
            autoCorrect={false}
            value={email}
            onChangeText={(t) => { setEmail(t); onClearError?.() }}
            onBlur={() => setEmailTouched(true)}
            disabled={isLoading}
            returnKeyType="next"
            blurOnSubmit={false}
            onSubmitEditing={focusPassword}
          />
          {emailTouched && email.length > 0 ? (
            <View className="absolute right-3 top-1/2 -translate-y-1/2">
              <Text className={cn('text-xs', isEmailValid ? 'text-green-500' : 'text-red-500')}>
                {isEmailValid ? '✓' : '✗'}
              </Text>
            </View>
          ) : null}
        </View>
        {showEmailError ? (
          <Text className="text-xs text-red-500">Please enter a valid email address</Text>
        ) : null}
      </View>

      <View className="gap-1.5">
        <Text className="text-sm font-medium text-foreground">Password</Text>
        <View className="relative">
          <Input
            ref={passwordRef}
            placeholder="Create a password (min 8 chars)"
            secureTextEntry={!showPassword}
            value={password}
            onChangeText={(t) => { setPassword(t); onClearError?.() }}
            disabled={isLoading}
            onSubmitEditing={handleSubmit}
            returnKeyType="go"
            onFocus={onScrollToBottom}
          />
          <Pressable
            onPress={() => setShowPassword(!showPassword)}
            className="absolute right-3 top-1/2 -translate-y-1/2"
            disabled={isLoading}
          >
            <Text className="text-muted-foreground text-xs">{showPassword ? '🙈' : '👁'}</Text>
          </Pressable>
        </View>
        {password.length > 0 ? (
          <View className="gap-1">
            <View className="flex-row gap-1">
              {[0, 1, 2, 3].map((i) => (
                <View
                  key={i}
                  className={cn(
                    'flex-1 h-1.5 rounded-full',
                    i < passwordStrength.score ? passwordStrength.color : 'bg-muted',
                  )}
                />
              ))}
            </View>
            <Text className={cn(
              'text-xs',
              passwordStrength.score <= 1 && 'text-red-500',
              passwordStrength.score === 2 && 'text-yellow-600',
              passwordStrength.score >= 3 && 'text-green-600',
            )}>
              {passwordStrength.label}
              {password.length < 8 ? ' • Minimum 8 characters' : ''}
            </Text>
          </View>
        ) : null}
      </View>

      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      <Button onPress={handleSubmit} disabled={isLoading || !isFormValid} className="mt-1">
        {isLoading ? <ActivityIndicator color="#fff" size="small" /> : 'Sign Up'}
      </Button>
    </View>
  )
}

function MobileLoginPanel({ onSignIn, onSignUp, onGoogleSignIn, isLoading, error, onClearError }: LoginScreenProps) {
  const [activeTab, setActiveTab] = useState<Tab>('signin')
  const [dismissed, setDismissed] = useState(false)
  const { height: windowHeight } = useWindowDimensions()
  const scrollRef = useRef<ScrollView>(null)

  useEffect(() => { if (error) setDismissed(false) }, [error])

  const displayError = dismissed ? null : error
  const dismissError = () => setDismissed(true)
  const switchTab = (tab: Tab) => { setActiveTab(tab); setDismissed(true) }
  const scrollToBottom = () => {
    setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 150)
  }

  return (
    <KeyboardAvoidingView
      className="flex-1 bg-background"
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <ScrollView
        ref={scrollRef}
        contentContainerStyle={{ minHeight: windowHeight, justifyContent: 'center', padding: 16 }}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
      >
        <Card className="w-full max-w-md self-center">
          <CardContent className="p-6">
            <View className="items-center mb-6">
              {Platform.OS === 'web' && (
                <Image
                  source={require('../../../../apps/mobile/assets/shogo-logo.svg')}
                  style={{ width: 80, height: 80, marginBottom: 16 }}
                  resizeMode="contain"
                />
              )}
              <Text className="text-2xl font-bold text-foreground">Shogo AI Studio</Text>
              <Text className="text-sm text-muted-foreground mt-1">
                Sign in to your account or create a new one
              </Text>
            </View>

            <View className="flex-row bg-secondary rounded-lg p-1 mb-5" accessibilityRole="tablist">
              {(['signin', 'signup'] as Tab[]).map((tab) => (
                <Pressable
                  key={tab}
                  onPress={() => switchTab(tab)}
                  accessibilityRole="tab"
                  accessibilityState={{ selected: activeTab === tab }}
                  accessibilityLabel={tab === 'signin' ? 'Sign In' : 'Sign Up'}
                  className={cn(
                    'flex-1 py-2 rounded-md items-center',
                    activeTab === tab ? 'bg-card' : '',
                  )}
                  style={activeTab === tab ? {
                    shadowColor: '#000',
                    shadowOffset: { width: 0, height: 1 },
                    shadowOpacity: 0.05,
                    shadowRadius: 2,
                    elevation: 1,
                  } : undefined}
                >
                  <Text className={cn(
                    'text-sm font-medium',
                    activeTab === tab ? 'text-foreground' : 'text-muted-foreground',
                  )}>
                    {tab === 'signin' ? 'Sign In' : 'Sign Up'}
                  </Text>
                </Pressable>
              ))}
            </View>

            {activeTab === 'signin'
              ? <SignInForm onSignIn={onSignIn} isLoading={isLoading} error={displayError} onClearError={dismissError} onScrollToBottom={scrollToBottom} />
              : <SignUpForm onSignUp={onSignUp} isLoading={isLoading} error={displayError} onClearError={dismissError} onScrollToBottom={scrollToBottom} />
            }

            {onGoogleSignIn ? (
              <>
                <View className="flex-row items-center my-5">
                  <View className="flex-1"><Separator /></View>
                  <Text className="px-3 text-xs text-muted-foreground uppercase">or</Text>
                  <View className="flex-1"><Separator /></View>
                </View>
                <Button variant="outline" className="w-full gap-2" onPress={onGoogleSignIn}>
                  <Image source={googleLogo} style={{ width: 18, height: 18 }} />
                  <Text className="text-foreground text-sm font-medium">Continue with Google</Text>
                </Button>
              </>
            ) : null}
          </CardContent>
        </Card>
      </ScrollView>
    </KeyboardAvoidingView>
  )
}

const logoLight = require('../../../../apps/mobile/assets/shogo-logo-words.svg')
const logoDark = require('../../../../apps/mobile/assets/shogo-logo-words-white.svg')

function DesktopFormPanel({ onSignIn, onSignUp, onGoogleSignIn, isLoading, error, onClearError, colorScheme }: LoginScreenProps) {
  const [activeTab, setActiveTab] = useState<Tab>('signin')
  const [dismissed, setDismissed] = useState(false)
  const scrollRef = useRef<ScrollView>(null)

  useEffect(() => { if (error) setDismissed(false) }, [error])

  const displayError = dismissed ? null : error
  const dismissError = () => setDismissed(true)
  const switchTab = (tab: Tab) => { setActiveTab(tab); setDismissed(true) }
  const scrollToBottom = () => {
    setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 150)
  }

  return (
    <View className="flex-1 bg-background">
      <View style={{ paddingTop: 32, paddingHorizontal: 48 }}>
        <Image
          source={colorScheme === 'dark' ? logoDark : logoLight}
          style={{ width: 140, height: 48 }}
          resizeMode="contain"
        />
      </View>

      <ScrollView
        ref={scrollRef}
        contentContainerStyle={{
          flexGrow: 1,
          justifyContent: 'center',
          alignItems: 'center',
          paddingHorizontal: 48,
          paddingVertical: 32,
        }}
        keyboardShouldPersistTaps="handled"
      >
        <View style={{ maxWidth: 400, width: '100%' }}>
          <Text className="text-2xl font-bold text-foreground" style={{ marginBottom: 4 }}>
            {activeTab === 'signin' ? 'Sign in to your account' : 'Create your account'}
          </Text>
          <Text className="text-sm text-muted-foreground" style={{ marginBottom: 28 }}>
            {activeTab === 'signin'
              ? 'Welcome back to Shogo AI Studio'
              : 'Get started with Shogo AI Studio'}
          </Text>

          <View className="flex-row bg-secondary rounded-lg p-1 mb-5" accessibilityRole="tablist">
            {(['signin', 'signup'] as Tab[]).map((tab) => (
              <Pressable
                key={tab}
                onPress={() => switchTab(tab)}
                accessibilityRole="tab"
                accessibilityState={{ selected: activeTab === tab }}
                accessibilityLabel={tab === 'signin' ? 'Sign In' : 'Sign Up'}
                className={cn(
                  'flex-1 py-2 rounded-md items-center',
                  activeTab === tab ? 'bg-card' : '',
                )}
                style={activeTab === tab ? {
                  shadowColor: '#000',
                  shadowOffset: { width: 0, height: 1 },
                  shadowOpacity: 0.05,
                  shadowRadius: 2,
                  elevation: 1,
                } : undefined}
              >
                <Text className={cn(
                  'text-sm font-medium',
                  activeTab === tab ? 'text-foreground' : 'text-muted-foreground',
                )}>
                  {tab === 'signin' ? 'Sign In' : 'Sign Up'}
                </Text>
              </Pressable>
            ))}
          </View>

          {activeTab === 'signin'
            ? <SignInForm onSignIn={onSignIn} isLoading={isLoading} error={displayError} onClearError={dismissError} onScrollToBottom={scrollToBottom} />
            : <SignUpForm onSignUp={onSignUp} isLoading={isLoading} error={displayError} onClearError={dismissError} onScrollToBottom={scrollToBottom} />
          }

          {onGoogleSignIn ? (
            <>
              <View className="flex-row items-center my-5">
                <View className="flex-1"><Separator /></View>
                <Text className="px-3 text-xs text-muted-foreground uppercase">or</Text>
                <View className="flex-1"><Separator /></View>
              </View>
              <Button variant="outline" className="w-full gap-2" onPress={onGoogleSignIn}>
                <Image source={googleLogo} style={{ width: 18, height: 18 }} />
                <Text className="text-foreground text-sm font-medium">Continue with Google</Text>
              </Button>
            </>
          ) : null}
        </View>
      </ScrollView>
    </View>
  )
}

export function LoginScreen(props: LoginScreenProps) {
  const { width } = useWindowDimensions()
  const isDesktopWeb = Platform.OS === 'web' && width >= LOGIN_HERO_BREAKPOINT

  if (!isDesktopWeb) {
    return <MobileLoginPanel {...props} />
  }

  return (
    <View className="flex-1 flex-row bg-background">
      <View style={{ width: '50%' }}>
        <DesktopFormPanel {...props} />
      </View>
      <View style={{ width: '50%', position: 'relative', overflow: 'hidden' }}>
        <Image
          source={require('../../../../apps/mobile/assets/login-hero.png')}
          style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, width: '100%', height: '100%' }}
          resizeMode="cover"
        />
        <View
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            justifyContent: 'center',
            alignItems: 'center',
          }}
        >
          <Text
            style={{
              color: '#fff',
              fontSize: 32,
              fontWeight: '200',
              letterSpacing: 0.5,
              textAlign: 'center',
              paddingHorizontal: 40,
              textShadowColor: 'rgba(0,0,0,0.5)',
              textShadowOffset: { width: 0, height: 1 },
              textShadowRadius: 8,
            }}
          >
            Visual AI for life
          </Text>
        </View>
      </View>
    </View>
  )
}
