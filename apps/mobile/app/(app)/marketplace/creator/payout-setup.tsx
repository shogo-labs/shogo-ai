// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { useState, useEffect, useCallback, useMemo } from 'react'
import {
  View,
  Text,
  Pressable,
  ScrollView,
  ActivityIndicator,
  TextInput,
  useWindowDimensions,
} from 'react-native'
import { useRouter } from 'expo-router'
import { observer } from 'mobx-react-lite'
import {
  ArrowLeft,
  AlertCircle,
  Check,
  Building2,
  ShieldCheck,
  ChevronDown,
  Lock,
  CircleDashed,
  Circle,
  CheckCircle2,
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

type SectionKey = 'identity' | 'address' | 'bank'

function payoutStatusColor(status: string): string {
  if (status === 'verified') return 'bg-green-500'
  if (status === 'pending') return 'bg-yellow-500'
  return 'bg-gray-400'
}

function payoutStatusLabel(status: string): string {
  if (status === 'verified') return 'Verified'
  if (status === 'pending') return 'Pending verification'
  return 'Not set up'
}

export default observer(function PayoutSetupScreen() {
  const router = useRouter()
  const http = useDomainHttp()
  const { width } = useWindowDimensions()
  const isWide = width >= 900

  const [form, setForm] = useState<PayoutForm>(INITIAL_FORM)
  const [payoutStatus, setPayoutStatus] = useState<string>('not_setup')
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [submitted, setSubmitted] = useState(false)

  const [openSection, setOpenSection] = useState<SectionKey>('identity')

  const loadStatus = useCallback(async () => {
    try {
      const res = await http.get<{ profile: { payoutStatus: string } }>(
        '/api/marketplace/creator/profile',
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

  const updateField = useCallback((field: keyof PayoutForm, value: string) => {
    setForm((prev) => ({ ...prev, [field]: value }))
    setError(null)
  }, [])

  const sectionDone = useMemo(
    () => ({
      identity:
        !!form.firstName.trim() &&
        !!form.lastName.trim() &&
        !!form.email.trim() &&
        !!form.dobDay &&
        !!form.dobMonth &&
        !!form.dobYear,
      address:
        !!form.addressLine1.trim() &&
        !!form.addressCity.trim() &&
        !!form.addressState.trim() &&
        !!form.addressPostalCode.trim() &&
        !!form.addressCountry.trim(),
      bank: !!form.bankAccountToken.trim(),
    }),
    [form],
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
        <ActivityIndicator size="large" />
      </View>
    )
  }

  if (submitted) {
    return (
      <View className="flex-1 bg-background">
        <View className="flex-row items-center gap-3 px-5 pt-3 pb-2">
          <Pressable onPress={() => router.back()} hitSlop={6} className="p-1">
            <ArrowLeft size={20} color="#71717a" />
          </Pressable>
          <Text className="text-base font-semibold text-foreground flex-1">
            Payout setup
          </Text>
        </View>
        <View className="flex-1 items-center justify-center px-6">
          <View className="rounded-full bg-green-500/15 w-20 h-20 items-center justify-center mb-5">
            <ShieldCheck size={36} color="#16a34a" />
          </View>
          <Text className="text-2xl font-bold text-foreground mb-2 text-center">
            Details submitted
          </Text>
          <Text className="text-muted-foreground text-center leading-6 mb-6 max-w-md">
            Your payout details are being verified. This usually takes 1-2
            business days. We&apos;ll notify you once verification is complete.
          </Text>
          <Pressable
            onPress={() => router.back()}
            className="px-6 py-3 rounded-xl bg-primary"
          >
            <Text className="text-sm font-semibold text-primary-foreground">
              Back to dashboard
            </Text>
          </Pressable>
        </View>
      </View>
    )
  }

  // Verification timeline state
  const timelineSteps: Array<{ key: SectionKey | 'verified'; label: string; description: string }> = [
    {
      key: 'identity',
      label: 'Identity',
      description: 'Tell us who you are',
    },
    {
      key: 'address',
      label: 'Address',
      description: 'Required for tax reporting',
    },
    {
      key: 'bank',
      label: 'Bank account',
      description: 'Where payouts go',
    },
    {
      key: 'verified',
      label: 'Verified by Stripe',
      description: '1–2 business days after submit',
    },
  ]

  const completedKeys = new Set<string>()
  if (sectionDone.identity) completedKeys.add('identity')
  if (sectionDone.address) completedKeys.add('address')
  if (sectionDone.bank) completedKeys.add('bank')
  if (payoutStatus === 'verified') completedKeys.add('verified')

  const formColumn = (
    <ScrollView
      className="flex-1"
      contentContainerStyle={{ padding: 20, paddingBottom: 40 }}
      showsVerticalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
    >
      {/* Status pill */}
      <View className="flex-row items-center gap-3 mb-5 px-4 py-3 rounded-2xl border border-border bg-card">
        <View className={cn('w-3 h-3 rounded-full', payoutStatusColor(payoutStatus))} />
        <View className="flex-1">
          <Text className="text-sm font-semibold text-foreground">Payout status</Text>
          <Text className="text-xs text-muted-foreground">
            {payoutStatusLabel(payoutStatus)}
          </Text>
        </View>
        <Lock size={14} color="#71717a" />
      </View>

      {/* Trust paragraph */}
      <View className="rounded-2xl border border-blue-500/30 bg-blue-500/5 p-4 mb-5 flex-row gap-3">
        <View className="rounded-full bg-blue-500/15 w-8 h-8 items-center justify-center mt-0.5">
          <ShieldCheck size={14} color="#3b82f6" />
        </View>
        <View className="flex-1">
          <Text className="text-sm font-semibold text-foreground mb-1">
            What we collect this for
          </Text>
          <Text className="text-xs text-foreground/70 leading-5">
            Stripe Connect requires this information for KYC verification and to
            send your payouts. None of these details are stored on Shogo&apos;s
            servers — they go straight to Stripe.
          </Text>
        </View>
      </View>

      {error && (
        <View className="flex-row items-center gap-2 mb-4 px-4 py-3 rounded-xl bg-destructive/10">
          <AlertCircle size={16} color="#dc2626" />
          <Text className="text-sm text-destructive flex-1">{error}</Text>
        </View>
      )}

      {/* Identity */}
      <Section
        title="Identity"
        subtitle="Personal information"
        done={sectionDone.identity}
        open={openSection === 'identity'}
        onToggle={() =>
          setOpenSection(openSection === 'identity' ? 'address' : 'identity')
        }
      >
        <View className="flex-row gap-3">
          <View className="flex-1 gap-1.5">
            <FieldLabel text="First name" />
            <TextInput
              value={form.firstName}
              onChangeText={(v) => updateField('firstName', v)}
              placeholder="John"
              placeholderTextColor="#9ca3af"
              className="px-4 py-3 rounded-xl border border-border bg-card text-foreground text-sm"
            />
          </View>
          <View className="flex-1 gap-1.5">
            <FieldLabel text="Last name" />
            <TextInput
              value={form.lastName}
              onChangeText={(v) => updateField('lastName', v)}
              placeholder="Doe"
              placeholderTextColor="#9ca3af"
              className="px-4 py-3 rounded-xl border border-border bg-card text-foreground text-sm"
            />
          </View>
        </View>

        <View className="gap-1.5">
          <FieldLabel text="Email" />
          <TextInput
            value={form.email}
            onChangeText={(v) => updateField('email', v)}
            placeholder="john@example.com"
            placeholderTextColor="#9ca3af"
            keyboardType="email-address"
            autoCapitalize="none"
            className="px-4 py-3 rounded-xl border border-border bg-card text-foreground text-sm"
          />
        </View>

        <View className="gap-1.5">
          <FieldLabel text="Date of birth" />
          <View className="flex-row gap-3">
            <View className="flex-1">
              <TextInput
                value={form.dobMonth}
                onChangeText={(v) => updateField('dobMonth', v)}
                placeholder="MM"
                placeholderTextColor="#9ca3af"
                keyboardType="number-pad"
                maxLength={2}
                className="px-4 py-3 rounded-xl border border-border bg-card text-foreground text-sm text-center"
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
                className="px-4 py-3 rounded-xl border border-border bg-card text-foreground text-sm text-center"
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
                className="px-4 py-3 rounded-xl border border-border bg-card text-foreground text-sm text-center"
              />
            </View>
          </View>
        </View>
      </Section>

      {/* Address */}
      <Section
        title="Address"
        subtitle="Where you live"
        done={sectionDone.address}
        open={openSection === 'address'}
        onToggle={() =>
          setOpenSection(openSection === 'address' ? 'bank' : 'address')
        }
      >
        <View className="gap-1.5">
          <FieldLabel text="Street address" />
          <TextInput
            value={form.addressLine1}
            onChangeText={(v) => updateField('addressLine1', v)}
            placeholder="123 Main St"
            placeholderTextColor="#9ca3af"
            className="px-4 py-3 rounded-xl border border-border bg-card text-foreground text-sm"
          />
        </View>

        <View className="flex-row gap-3">
          <View className="flex-1 gap-1.5">
            <FieldLabel text="City" />
            <TextInput
              value={form.addressCity}
              onChangeText={(v) => updateField('addressCity', v)}
              placeholder="San Francisco"
              placeholderTextColor="#9ca3af"
              className="px-4 py-3 rounded-xl border border-border bg-card text-foreground text-sm"
            />
          </View>
          <View className="flex-1 gap-1.5">
            <FieldLabel text="State" />
            <TextInput
              value={form.addressState}
              onChangeText={(v) => updateField('addressState', v)}
              placeholder="CA"
              placeholderTextColor="#9ca3af"
              className="px-4 py-3 rounded-xl border border-border bg-card text-foreground text-sm"
            />
          </View>
        </View>

        <View className="flex-row gap-3">
          <View className="flex-1 gap-1.5">
            <FieldLabel text="Postal code" />
            <TextInput
              value={form.addressPostalCode}
              onChangeText={(v) => updateField('addressPostalCode', v)}
              placeholder="94102"
              placeholderTextColor="#9ca3af"
              keyboardType="number-pad"
              className="px-4 py-3 rounded-xl border border-border bg-card text-foreground text-sm"
            />
          </View>
          <View className="flex-1 gap-1.5">
            <FieldLabel text="Country" />
            <TextInput
              value={form.addressCountry}
              onChangeText={(v) => updateField('addressCountry', v)}
              placeholder="US"
              placeholderTextColor="#9ca3af"
              autoCapitalize="characters"
              maxLength={2}
              className="px-4 py-3 rounded-xl border border-border bg-card text-foreground text-sm"
            />
          </View>
        </View>

        <View className="gap-1.5">
          <FieldLabel text="SSN last 4 (US only, optional)" />
          <TextInput
            value={form.ssnLast4}
            onChangeText={(v) => updateField('ssnLast4', v)}
            placeholder="1234"
            placeholderTextColor="#9ca3af"
            keyboardType="number-pad"
            maxLength={4}
            secureTextEntry
            className="px-4 py-3 rounded-xl border border-border bg-card text-foreground text-sm"
          />
        </View>
      </Section>

      {/* Bank */}
      <Section
        title="Bank account"
        subtitle="Where your payouts arrive"
        done={sectionDone.bank}
        open={openSection === 'bank'}
        onToggle={() => setOpenSection('bank')}
      >
        <View className="rounded-xl bg-yellow-500/10 px-4 py-3 flex-row items-start gap-2">
          <Building2 size={14} color="#ca8a04" style={{ marginTop: 2 }} />
          <Text className="text-xs text-yellow-700 dark:text-yellow-400 flex-1 leading-4">
            In production, this field uses Stripe.js elements for secure bank
            account tokenization. Enter a test token to continue.
          </Text>
        </View>

        <View className="gap-1.5">
          <FieldLabel text="Bank account token" />
          <TextInput
            value={form.bankAccountToken}
            onChangeText={(v) => updateField('bankAccountToken', v)}
            placeholder="btok_…"
            placeholderTextColor="#9ca3af"
            autoCapitalize="none"
            className="px-4 py-3 rounded-xl border border-border bg-card text-foreground text-sm font-mono"
          />
        </View>
      </Section>

      {/* Submit */}
      <Pressable
        onPress={handleSubmit}
        disabled={submitting}
        className={cn(
          'flex-row items-center justify-center gap-2 py-3.5 rounded-xl mt-2',
          submitting ? 'bg-primary/60' : 'bg-primary',
        )}
      >
        {submitting ? (
          <ActivityIndicator size="small" color="#fff" />
        ) : (
          <>
            <Check size={16} color="#fff" />
            <Text className="text-sm font-semibold text-primary-foreground">
              Submit payout details
            </Text>
          </>
        )}
      </Pressable>
    </ScrollView>
  )

  const sidebar = (
    <View className="bg-muted/20 border-l border-border">
      <View className="px-5 pt-6 pb-4">
        <Text className="text-[10px] uppercase font-semibold text-muted-foreground mb-3" style={{ letterSpacing: 0.5 }}>
          Verification flow
        </Text>
        <View className="gap-1">
          {timelineSteps.map((step, i) => {
            const done = completedKeys.has(step.key)
            const current = !done && timelineSteps.slice(0, i).every((s) => completedKeys.has(s.key))
            return (
              <View key={step.key} className="flex-row items-start gap-3 pb-3">
                <View className="items-center" style={{ width: 24 }}>
                  {done ? (
                    <CheckCircle2 size={16} color="#22c55e" />
                  ) : current ? (
                    <CircleDashed size={16} color="#e27927" />
                  ) : (
                    <Circle size={16} color="#a1a1aa" />
                  )}
                  {i < timelineSteps.length - 1 && (
                    <View
                      className={cn(
                        'w-px flex-1 mt-1',
                        done ? 'bg-emerald-500' : 'bg-border',
                      )}
                      style={{ minHeight: 24 }}
                    />
                  )}
                </View>
                <View className="flex-1 pb-1">
                  <Text
                    className={cn(
                      'text-sm font-medium',
                      done
                        ? 'text-foreground'
                        : current
                          ? 'text-foreground'
                          : 'text-muted-foreground',
                    )}
                  >
                    {step.label}
                  </Text>
                  <Text className="text-[11px] text-muted-foreground mt-0.5">
                    {step.description}
                  </Text>
                </View>
              </View>
            )
          })}
        </View>
      </View>
    </View>
  )

  return (
    <View className="flex-1 bg-background">
      {/* Top bar */}
      <View className="flex-row items-center gap-3 px-5 pt-3 pb-2 border-b border-border">
        <Pressable onPress={() => router.back()} hitSlop={6} className="p-1">
          <ArrowLeft size={20} color="#71717a" />
        </Pressable>
        <Text className="text-base font-semibold text-foreground flex-1">
          Payout setup
        </Text>
      </View>

      <View className="flex-1 flex-row">
        <View style={{ flex: isWide ? 1 : undefined, width: isWide ? undefined : '100%' }}>
          {formColumn}
        </View>
        {isWide && <View style={{ width: 280 }}>{sidebar}</View>}
      </View>
    </View>
  )
})

// ── Sub-components ─────────────────────────────────────────────────

function Section({
  title,
  subtitle,
  done,
  open,
  onToggle,
  children,
}: {
  title: string
  subtitle?: string
  done?: boolean
  open: boolean
  onToggle: () => void
  children: React.ReactNode
}) {
  return (
    <View className="rounded-2xl border border-border bg-card overflow-hidden mb-4">
      <Pressable
        onPress={onToggle}
        className="flex-row items-center gap-3 px-4 py-3 active:bg-muted/40"
      >
        <View
          className={cn(
            'w-6 h-6 rounded-full items-center justify-center',
            done ? 'bg-emerald-500/15' : 'bg-muted',
          )}
        >
          {done ? (
            <Check size={12} color="#16a34a" />
          ) : (
            <View className="w-2 h-2 rounded-full bg-muted-foreground/50" />
          )}
        </View>
        <View className="flex-1 min-w-0">
          <Text className="text-sm font-semibold text-foreground">{title}</Text>
          {subtitle && (
            <Text className="text-[11px] text-muted-foreground">{subtitle}</Text>
          )}
        </View>
        <ChevronDown
          size={16}
          color="#71717a"
          style={{ transform: [{ rotate: open ? '180deg' : '0deg' }] }}
        />
      </Pressable>
      {open && (
        <View className="px-4 pb-4 gap-4 border-t border-border">{children}</View>
      )}
    </View>
  )
}

function FieldLabel({ text }: { text: string }) {
  return (
    <Text className="text-xs font-semibold text-foreground">{text}</Text>
  )
}
