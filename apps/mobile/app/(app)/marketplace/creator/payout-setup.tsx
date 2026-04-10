// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { useState, useEffect, useCallback } from 'react'
import {
  View,
  Text,
  Pressable,
  ScrollView,
  ActivityIndicator,
  TextInput,
} from 'react-native'
import { useRouter } from 'expo-router'
import { observer } from 'mobx-react-lite'
import {
  ArrowLeft,
  AlertCircle,
  Check,
  Building2,
  ShieldCheck,
} from 'lucide-react-native'
import { useDomainHttp } from '../../../../contexts/domain'
import { cn } from '@shogo/shared-ui/primitives'

interface PayoutForm {
  firstName: string
  lastName: string
  email: string
  dobDay: string
  dobMonth: string
  dobYear: string
  addressLine1: string
  addressCity: string
  addressState: string
  addressPostalCode: string
  addressCountry: string
  ssnLast4: string
  bankAccountToken: string
}

const INITIAL_FORM: PayoutForm = {
  firstName: '',
  lastName: '',
  email: '',
  dobDay: '',
  dobMonth: '',
  dobYear: '',
  addressLine1: '',
  addressCity: '',
  addressState: '',
  addressPostalCode: '',
  addressCountry: 'US',
  ssnLast4: '',
  bankAccountToken: '',
}

function payoutStatusColor(status: string): string {
  if (status === 'verified') return 'bg-green-500'
  if (status === 'pending') return 'bg-yellow-500'
  return 'bg-gray-400'
}

function payoutStatusLabel(status: string): string {
  if (status === 'verified') return 'Verified'
  if (status === 'pending') return 'Pending Verification'
  return 'Not Set Up'
}

export default observer(function PayoutSetupScreen() {
  const router = useRouter()
  const http = useDomainHttp()

  const [form, setForm] = useState<PayoutForm>(INITIAL_FORM)
  const [payoutStatus, setPayoutStatus] = useState<string>('not_setup')
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [submitted, setSubmitted] = useState(false)

  const loadStatus = useCallback(async () => {
    try {
      const res = await http.get<{ profile: { payoutStatus: string } }>(
        '/api/marketplace/creator/profile'
      )
      setPayoutStatus(res.data.profile.payoutStatus)
    } catch {
      // Profile may not exist yet; ignore
    } finally {
      setLoading(false)
    }
  }, [http])

  useEffect(() => {
    loadStatus()
  }, [loadStatus])

  const updateField = useCallback(
    (field: keyof PayoutForm, value: string) => {
      setForm((prev) => ({ ...prev, [field]: value }))
      setError(null)
    },
    []
  )

  const validate = useCallback((): string | null => {
    if (!form.firstName.trim()) return 'First name is required'
    if (!form.lastName.trim()) return 'Last name is required'
    if (!form.email.trim()) return 'Email is required'
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email))
      return 'Invalid email address'
    if (!form.dobDay || !form.dobMonth || !form.dobYear)
      return 'Date of birth is required'
    const day = parseInt(form.dobDay, 10)
    const month = parseInt(form.dobMonth, 10)
    const year = parseInt(form.dobYear, 10)
    if (day < 1 || day > 31) return 'Invalid day'
    if (month < 1 || month > 12) return 'Invalid month'
    if (year < 1900 || year > new Date().getFullYear() - 13)
      return 'Invalid year (must be at least 13 years old)'
    if (!form.addressLine1.trim()) return 'Address is required'
    if (!form.addressCity.trim()) return 'City is required'
    if (!form.addressState.trim()) return 'State is required'
    if (!form.addressPostalCode.trim()) return 'Postal code is required'
    if (!form.addressCountry.trim()) return 'Country is required'
    if (
      form.ssnLast4 &&
      (form.ssnLast4.length !== 4 || !/^\d{4}$/.test(form.ssnLast4))
    )
      return 'SSN last 4 must be exactly 4 digits'
    if (!form.bankAccountToken.trim())
      return 'Bank account token is required'
    return null
  }, [form])

  const handleSubmit = useCallback(async () => {
    const err = validate()
    if (err) {
      setError(err)
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      await http.post('/api/marketplace/creator/payout-details', {
        firstName: form.firstName.trim(),
        lastName: form.lastName.trim(),
        email: form.email.trim(),
        dob: {
          day: parseInt(form.dobDay, 10),
          month: parseInt(form.dobMonth, 10),
          year: parseInt(form.dobYear, 10),
        },
        address: {
          line1: form.addressLine1.trim(),
          city: form.addressCity.trim(),
          state: form.addressState.trim(),
          postal_code: form.addressPostalCode.trim(),
          country: form.addressCountry.trim(),
        },
        ...(form.ssnLast4 ? { ssnLast4: form.ssnLast4 } : {}),
        bankAccountToken: form.bankAccountToken.trim(),
      })
      setSubmitted(true)
      setPayoutStatus('pending')
    } catch {
      setError('Failed to submit payout details. Please try again.')
    } finally {
      setSubmitting(false)
    }
  }, [validate, form, http])

  if (loading) {
    return (
      <View className="flex-1 bg-background items-center justify-center">
        <ActivityIndicator size="large" className="text-muted-foreground" />
      </View>
    )
  }

  if (submitted) {
    return (
      <View className="flex-1 bg-background">
        <View className="flex-row items-center gap-3 px-4 pt-6 pb-4">
          <Pressable onPress={() => router.back()}>
            <ArrowLeft size={20} className="text-foreground" />
          </Pressable>
          <Text className="text-xl font-bold text-foreground">
            Payout Setup
          </Text>
        </View>
        <View className="flex-1 items-center justify-center px-6">
          <ShieldCheck size={56} className="text-green-600 mb-4" />
          <Text className="text-xl font-bold text-foreground mb-2 text-center">
            Details Submitted
          </Text>
          <Text className="text-muted-foreground text-center leading-6 mb-8">
            Your payout details are being verified. This usually takes 1-2
            business days. We'll notify you once verification is complete.
          </Text>
          <Pressable
            onPress={() => router.back()}
            className="px-6 py-3 rounded-xl bg-primary"
          >
            <Text className="text-sm font-semibold text-primary-foreground">
              Back to Dashboard
            </Text>
          </Pressable>
        </View>
      </View>
    )
  }

  return (
    <ScrollView
      className="flex-1 bg-background"
      contentContainerStyle={{ padding: 16, paddingBottom: 40 }}
      showsVerticalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
    >
      {/* Header */}
      <View className="flex-row items-center gap-3 mb-6">
        <Pressable onPress={() => router.back()}>
          <ArrowLeft size={20} className="text-foreground" />
        </Pressable>
        <Text className="text-xl font-bold text-foreground">
          Payout Setup
        </Text>
      </View>

      {/* Current Status */}
      <View className="flex-row items-center gap-3 mb-6 px-4 py-3 rounded-xl border border-border bg-card">
        <View
          className={cn(
            'w-3 h-3 rounded-full',
            payoutStatusColor(payoutStatus)
          )}
        />
        <View>
          <Text className="text-sm font-medium text-foreground">
            Payout Status
          </Text>
          <Text className="text-xs text-muted-foreground">
            {payoutStatusLabel(payoutStatus)}
          </Text>
        </View>
      </View>

      {error && (
        <View className="flex-row items-center gap-2 mb-4 px-4 py-3 rounded-lg bg-destructive/10">
          <AlertCircle size={16} className="text-destructive" />
          <Text className="text-sm text-destructive flex-1">{error}</Text>
        </View>
      )}

      {/* Personal Information */}
      <SectionHeader title="Personal Information" />

      <View className="flex-row gap-3 mb-5">
        <View className="flex-1">
          <FieldLabel text="First Name" />
          <TextInput
            value={form.firstName}
            onChangeText={(v) => updateField('firstName', v)}
            placeholder="John"
            placeholderTextColor="#9ca3af"
            className="px-4 py-3 rounded-lg border border-border bg-card text-foreground text-sm"
          />
        </View>
        <View className="flex-1">
          <FieldLabel text="Last Name" />
          <TextInput
            value={form.lastName}
            onChangeText={(v) => updateField('lastName', v)}
            placeholder="Doe"
            placeholderTextColor="#9ca3af"
            className="px-4 py-3 rounded-lg border border-border bg-card text-foreground text-sm"
          />
        </View>
      </View>

      <View className="mb-5">
        <FieldLabel text="Email" />
        <TextInput
          value={form.email}
          onChangeText={(v) => updateField('email', v)}
          placeholder="john@example.com"
          placeholderTextColor="#9ca3af"
          keyboardType="email-address"
          autoCapitalize="none"
          className="px-4 py-3 rounded-lg border border-border bg-card text-foreground text-sm"
        />
      </View>

      {/* Date of Birth */}
      <View className="mb-5">
        <FieldLabel text="Date of Birth" />
        <View className="flex-row gap-3">
          <View className="flex-1">
            <TextInput
              value={form.dobMonth}
              onChangeText={(v) => updateField('dobMonth', v)}
              placeholder="MM"
              placeholderTextColor="#9ca3af"
              keyboardType="number-pad"
              maxLength={2}
              className="px-4 py-3 rounded-lg border border-border bg-card text-foreground text-sm text-center"
            />
          </View>
          <View className="flex-1">
            <TextInput
              value={form.dobDay}
              onChangeText={(v) => updateField('dobDay', v)}
              placeholder="DD"
              placeholderTextColor="#9ca3af"
              keyboardType="number-pad"
              maxLength={2}
              className="px-4 py-3 rounded-lg border border-border bg-card text-foreground text-sm text-center"
            />
          </View>
          <View className="flex-[1.5]">
            <TextInput
              value={form.dobYear}
              onChangeText={(v) => updateField('dobYear', v)}
              placeholder="YYYY"
              placeholderTextColor="#9ca3af"
              keyboardType="number-pad"
              maxLength={4}
              className="px-4 py-3 rounded-lg border border-border bg-card text-foreground text-sm text-center"
            />
          </View>
        </View>
      </View>

      {/* Address */}
      <SectionHeader title="Address" />

      <View className="mb-5">
        <FieldLabel text="Street Address" />
        <TextInput
          value={form.addressLine1}
          onChangeText={(v) => updateField('addressLine1', v)}
          placeholder="123 Main St"
          placeholderTextColor="#9ca3af"
          className="px-4 py-3 rounded-lg border border-border bg-card text-foreground text-sm"
        />
      </View>

      <View className="flex-row gap-3 mb-5">
        <View className="flex-1">
          <FieldLabel text="City" />
          <TextInput
            value={form.addressCity}
            onChangeText={(v) => updateField('addressCity', v)}
            placeholder="San Francisco"
            placeholderTextColor="#9ca3af"
            className="px-4 py-3 rounded-lg border border-border bg-card text-foreground text-sm"
          />
        </View>
        <View className="flex-1">
          <FieldLabel text="State" />
          <TextInput
            value={form.addressState}
            onChangeText={(v) => updateField('addressState', v)}
            placeholder="CA"
            placeholderTextColor="#9ca3af"
            className="px-4 py-3 rounded-lg border border-border bg-card text-foreground text-sm"
          />
        </View>
      </View>

      <View className="flex-row gap-3 mb-5">
        <View className="flex-1">
          <FieldLabel text="Postal Code" />
          <TextInput
            value={form.addressPostalCode}
            onChangeText={(v) => updateField('addressPostalCode', v)}
            placeholder="94102"
            placeholderTextColor="#9ca3af"
            keyboardType="number-pad"
            className="px-4 py-3 rounded-lg border border-border bg-card text-foreground text-sm"
          />
        </View>
        <View className="flex-1">
          <FieldLabel text="Country" />
          <TextInput
            value={form.addressCountry}
            onChangeText={(v) => updateField('addressCountry', v)}
            placeholder="US"
            placeholderTextColor="#9ca3af"
            autoCapitalize="characters"
            maxLength={2}
            className="px-4 py-3 rounded-lg border border-border bg-card text-foreground text-sm"
          />
        </View>
      </View>

      {/* SSN (US only) */}
      <View className="mb-5">
        <FieldLabel text="SSN Last 4 (US only, optional)" />
        <TextInput
          value={form.ssnLast4}
          onChangeText={(v) => updateField('ssnLast4', v)}
          placeholder="1234"
          placeholderTextColor="#9ca3af"
          keyboardType="number-pad"
          maxLength={4}
          secureTextEntry
          className="px-4 py-3 rounded-lg border border-border bg-card text-foreground text-sm"
        />
      </View>

      {/* Bank Account */}
      <SectionHeader title="Bank Account" />

      <View className="mb-2 px-4 py-3 rounded-lg bg-yellow-500/10 flex-row items-start gap-2">
        <Building2 size={16} className="text-yellow-600 mt-0.5" />
        <Text className="text-xs text-yellow-700 flex-1 leading-5">
          In production, this field would use Stripe.js elements for secure
          bank account tokenization. For now, enter a test token.
        </Text>
      </View>

      <View className="mb-5">
        <FieldLabel text="Bank Account Token" />
        <TextInput
          value={form.bankAccountToken}
          onChangeText={(v) => updateField('bankAccountToken', v)}
          placeholder="btok_..."
          placeholderTextColor="#9ca3af"
          autoCapitalize="none"
          className="px-4 py-3 rounded-lg border border-border bg-card text-foreground text-sm"
        />
      </View>

      {/* Submit */}
      <Pressable
        onPress={handleSubmit}
        disabled={submitting}
        className={cn(
          'flex-row items-center justify-center gap-2 py-3.5 rounded-xl mt-2',
          submitting ? 'bg-primary/60' : 'bg-primary'
        )}
      >
        {submitting ? (
          <ActivityIndicator size="small" color="#fff" />
        ) : (
          <>
            <Check size={18} color="#fff" />
            <Text className="text-sm font-semibold text-primary-foreground">
              Submit Payout Details
            </Text>
          </>
        )}
      </Pressable>
    </ScrollView>
  )
})

function SectionHeader({ title }: { title: string }) {
  return (
    <Text className="text-base font-bold text-foreground mb-4 mt-2">
      {title}
    </Text>
  )
}

function FieldLabel({ text }: { text: string }) {
  return (
    <Text className="text-sm font-medium text-foreground mb-1.5">{text}</Text>
  )
}
