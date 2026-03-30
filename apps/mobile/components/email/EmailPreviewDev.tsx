// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Dev-only email template previewer.
 * Renders all Shogo-branded email templates with sample data in an iframe.
 * Follows the same sidebar-picker pattern as DynamicAppDevPreview.
 */

import { useState, useMemo, useEffect } from 'react'
import { View, Pressable, ScrollView, Platform } from 'react-native'
import { Text } from '@/components/ui/text'
import type { EmailTemplate } from '@shogo-ai/sdk/email'

const SAMPLE_DATA: Record<string, Record<string, unknown>> = {
  welcome: {
    name: 'Alice Chen',
    appName: 'Shogo',
    loginUrl: 'https://app.shogo.ai',
    currentYear: new Date().getFullYear(),
  },
  'password-reset': {
    name: 'Alice Chen',
    appName: 'Shogo',
    resetUrl: 'https://app.shogo.ai/reset?token=abc123',
    expiresIn: '1 hour',
    currentYear: new Date().getFullYear(),
  },
  'email-verification': {
    name: 'Alice Chen',
    appName: 'Shogo',
    verifyUrl: 'https://app.shogo.ai/verify?token=abc123',
    expiresIn: '24 hours',
    currentYear: new Date().getFullYear(),
  },
  'workspace-invite': {
    inviterName: 'Russell T.',
    workspaceName: 'Acme Corp',
    role: 'Editor',
    acceptUrl: 'https://app.shogo.ai/invite/accept?token=abc123',
    appName: 'Shogo',
    currentYear: new Date().getFullYear(),
  },
  'project-invite': {
    inviterName: 'Russell T.',
    projectName: 'Marketing Bot',
    workspaceName: 'Acme Corp',
    role: 'Editor',
    acceptUrl: 'https://app.shogo.ai/invite/accept?token=abc123',
    appName: 'Shogo',
    currentYear: new Date().getFullYear(),
  },
  'invite-accepted': {
    inviteeName: 'Alice Chen',
    inviteeEmail: 'alice@example.com',
    resourceName: 'Acme Corp',
    resourceType: 'workspace',
    dashboardUrl: 'https://app.shogo.ai/workspace/acme',
    appName: 'Shogo',
    currentYear: new Date().getFullYear(),
  },
  'plan-upgraded': {
    name: 'Alice Chen',
    workspaceName: 'Acme Corp',
    planName: 'Pro',
    billingInterval: 'Monthly',
    creditsTotal: '50,000',
    dashboardUrl: 'https://app.shogo.ai/workspace/acme',
    appName: 'Shogo',
    currentYear: new Date().getFullYear(),
  },
  'payment-receipt': {
    name: 'Alice Chen',
    workspaceName: 'Acme Corp',
    planName: 'Pro',
    amount: '49.00',
    currency: '$',
    invoiceDate: 'March 24, 2026',
    invoiceUrl: 'https://app.shogo.ai/billing/invoices/inv_123',
    appName: 'Shogo',
    currentYear: new Date().getFullYear(),
  },
  'payment-failed': {
    name: 'Alice Chen',
    workspaceName: 'Acme Corp',
    planName: 'Pro',
    amount: '49.00',
    currency: '$',
    retryUrl: 'https://app.shogo.ai/billing/update-payment',
    appName: 'Shogo',
    currentYear: new Date().getFullYear(),
  },
  'member-joined': {
    memberName: 'Alice Chen',
    memberEmail: 'alice@example.com',
    workspaceName: 'Acme Corp',
    role: 'Editor',
    dashboardUrl: 'https://app.shogo.ai/workspace/acme/team',
    appName: 'Shogo',
    currentYear: new Date().getFullYear(),
  },
  'member-removed': {
    workspaceName: 'Acme Corp',
    appName: 'Shogo',
    currentYear: new Date().getFullYear(),
  },
  'account-deleted': {
    name: 'Alice Chen',
    email: 'alice@example.com',
    appName: 'Shogo',
    currentYear: new Date().getFullYear(),
  },
}

const CATEGORY_LABELS: Record<string, string> = {
  auth: 'Auth',
  invitation: 'Invitations',
  billing: 'Billing',
  workspace: 'Workspace',
}

function categorize(templates: EmailTemplate[]) {
  const categories: { label: string; templates: EmailTemplate[] }[] = []
  const categoryMap = new Map<string, EmailTemplate[]>()

  const categoryOrder = ['auth', 'invitation', 'billing', 'workspace']

  for (const t of templates) {
    const dir =
      t.name === 'welcome' || t.name === 'password-reset' || t.name === 'email-verification'
        ? 'auth'
        : t.name === 'workspace-invite' || t.name === 'project-invite' || t.name === 'invite-accepted'
          ? 'invitation'
          : t.name === 'plan-upgraded' || t.name === 'payment-receipt' || t.name === 'payment-failed'
            ? 'billing'
            : 'workspace'
    if (!categoryMap.has(dir)) categoryMap.set(dir, [])
    categoryMap.get(dir)!.push(t)
  }

  for (const key of categoryOrder) {
    const items = categoryMap.get(key)
    if (items?.length) {
      categories.push({ label: CATEGORY_LABELS[key] ?? key, templates: items })
    }
  }

  return categories
}

function formatTemplateName(name: string): string {
  return name
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
}

export function EmailPreviewDev() {
  const [sdkMod, setSdkMod] = useState<{
    shogoTemplates: EmailTemplate[]
    interpolate: (t: string, d: Record<string, unknown>) => string
    DARK_STYLE_OVERRIDES: string
  } | null>(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const mod = await import('@shogo-ai/sdk/email')
      if (!cancelled) {
        setSdkMod({
          shogoTemplates: (mod.shogoTemplates ?? []) as EmailTemplate[],
          interpolate: mod.interpolate,
          DARK_STYLE_OVERRIDES: mod.DARK_STYLE_OVERRIDES,
        })
      }
    })()
    return () => { cancelled = true }
  }, [])

  const templates = sdkMod?.shogoTemplates ?? []
  const [activeTemplate, setActiveTemplate] = useState<string>('welcome')
  const [darkMode, setDarkMode] = useState(false)
  const categories = useMemo(() => categorize(templates), [templates])

  const selected = templates.find((t) => t.name === activeTemplate)
  const sampleData = SAMPLE_DATA[activeTemplate] ?? { appName: 'Shogo', currentYear: new Date().getFullYear() }

  const interp = sdkMod?.interpolate ?? ((t: string) => t)
  const renderedSubject = selected ? interp(selected.subject, { ...selected.defaults, ...sampleData }) : ''
  let renderedHtml = selected ? interp(selected.html, { ...selected.defaults, ...sampleData }) : ''

  if (darkMode && renderedHtml && sdkMod?.DARK_STYLE_OVERRIDES) {
    const forceDarkCSS = `<style>${sdkMod.DARK_STYLE_OVERRIDES}</style>`
    renderedHtml = renderedHtml.replace('</head>', `${forceDarkCSS}</head>`)
  }

  if (!sdkMod) {
    return (
      <View className="flex-1 items-center justify-center bg-background">
        <Text className="text-sm text-muted-foreground">Loading email templates…</Text>
      </View>
    )
  }

  return (
    <View className="flex-1 flex-row bg-background">
      {/* Sidebar */}
      <View className="w-56 border-r border-border bg-card">
        <View className="px-4 py-3 border-b border-border">
          <Text className="text-base font-semibold text-foreground">Email Preview</Text>
          <Text className="text-xs text-muted-foreground mt-0.5">
            {templates.length} templates
          </Text>
        </View>
        <ScrollView className="flex-1" contentContainerStyle={{ paddingBottom: 24 }}>
          {categories.map((cat) => (
            <View key={cat.label}>
              <Text className="px-4 pt-4 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                {cat.label}
              </Text>
              {cat.templates.map((t) => {
                const isActive = t.name === activeTemplate
                return (
                  <Pressable
                    key={t.name}
                    onPress={() => setActiveTemplate(t.name)}
                    className={`mx-2 mb-0.5 rounded-lg px-3 py-2 ${isActive ? 'bg-primary/10' : ''}`}
                  >
                    <Text
                      className={`text-sm ${isActive ? 'font-semibold text-primary' : 'text-foreground'}`}
                    >
                      {formatTemplateName(t.name)}
                    </Text>
                  </Pressable>
                )
              })}
            </View>
          ))}
        </ScrollView>
      </View>

      {/* Preview area */}
      <View className="flex-1">
        {/* Subject bar */}
        <View className="px-6 py-3 border-b border-border bg-card flex-row items-center gap-3">
          <Text className="text-xs font-medium text-muted-foreground">Subject:</Text>
          <Text className="text-sm font-medium text-foreground flex-1" {...(Platform.OS !== 'web' ? { numberOfLines: 1 } : {})}>
            {renderedSubject}
          </Text>
          <Pressable
            onPress={() => setDarkMode((v) => !v)}
            className={`rounded-full px-3 py-1 border ${darkMode ? 'bg-zinc-800 border-zinc-600' : 'bg-zinc-100 border-zinc-300'}`}
          >
            <Text className={`text-xs font-medium ${darkMode ? 'text-zinc-200' : 'text-zinc-700'}`}>
              {darkMode ? 'Dark' : 'Light'}
            </Text>
          </Pressable>
        </View>

        {/* Email HTML */}
        <View className={`flex-1 ${darkMode ? 'bg-[#0e0e10]' : 'bg-[#e5e5e5]'}`}>
          {Platform.OS === 'web' ? (
            <iframe
              key={activeTemplate}
              srcDoc={renderedHtml}
              style={{ width: '100%', height: '100%', border: 'none' }}
              title={`Email preview: ${activeTemplate}`}
              sandbox="allow-same-origin"
            />
          ) : (
            <View className="flex-1 items-center justify-center p-4">
              <Text className="text-sm text-muted-foreground text-center">
                Email preview is only available on web.{'\n'}
                Run with Expo web to use this tool.
              </Text>
            </View>
          )}
        </View>
      </View>
    </View>
  )
}
