// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import type { ReactNode } from 'react'
import { View, Text, Pressable, ActivityIndicator, Platform } from 'react-native'
import { Zap, ChevronRight, Sparkles } from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import type { AppTemplateSummary } from '../../lib/api'

const APP_ICON_BOX: Record<string, string> = {
  'todo-app': 'bg-blue-500/15 dark:bg-blue-400/20',
  crm: 'bg-orange-500/15 dark:bg-orange-400/20',
  kanban: 'bg-violet-500/15 dark:bg-violet-400/20',
  'expense-tracker': 'bg-emerald-500/15 dark:bg-emerald-400/20',
  'booking-app': 'bg-pink-500/15 dark:bg-pink-400/20',
  inventory: 'bg-cyan-500/15 dark:bg-cyan-400/20',
  'ai-chat': 'bg-red-500/15 dark:bg-red-400/20',
  'form-builder': 'bg-amber-500/15 dark:bg-amber-400/20',
  'feedback-form': 'bg-lime-500/15 dark:bg-lime-400/20',
}

const APP_SPINNER: Record<string, string> = {
  'todo-app': '#3b82f6',
  crm: '#f97316',
  kanban: '#8b5cf6',
  'expense-tracker': '#10b981',
  'booking-app': '#ec4899',
  inventory: '#06b6d4',
  'ai-chat': '#ef4444',
  'form-builder': '#f59e0b',
  'feedback-form': '#84cc16',
}

const APP_ICONS: Record<string, string> = {
  'todo-app': '✅',
  crm: '🤝',
  kanban: '📋',
  'expense-tracker': '💰',
  'booking-app': '📅',
  inventory: '📦',
  'ai-chat': '🤖',
  'form-builder': '📝',
  'feedback-form': '💬',
}

const POPULAR_APPS = new Set(['todo-app', 'crm', 'kanban'])

const COMPLEXITY_BADGE: Record<string, { box: string; text: string }> = {
  beginner: {
    box: 'bg-green-500/14 dark:bg-green-500/20',
    text: 'text-green-700 dark:text-green-300',
  },
  intermediate: {
    box: 'bg-amber-500/16 dark:bg-amber-500/20',
    text: 'text-amber-700 dark:text-amber-300',
  },
  advanced: {
    box: 'bg-red-500/12 dark:bg-red-500/18',
    text: 'text-red-600 dark:text-red-300',
  },
}

function PreviewRow({ children, className }: { children: ReactNode; className?: string }) {
  return <View className={cn('rounded-lg py-1.5 px-2 mb-1', className)}>{children}</View>
}

function AppPreview({ name, compact }: { name: string; compact: boolean }) {
  const h = cn(compact ? 'text-[10px]' : 'text-[11px]', 'font-semibold text-slate-500 dark:text-white/45 mb-1.5')
  const title = 'text-slate-900 dark:text-white/90'
  const box = 'bg-slate-100 dark:bg-white/10'
  const fs = cn(compact ? 'text-[9px]' : 'text-[10px]', title)
  const fsSm = cn(compact ? 'text-[8px]' : 'text-[9px]', 'text-slate-500 dark:text-white/55')

  switch (name) {
    case 'todo-app':
      return (
        <View>
          <Text className={h}>Today</Text>
          <PreviewRow className="bg-emerald-50 dark:bg-emerald-500/10">
            <Text className={fs}>✓ Ship onboarding flow</Text>
          </PreviewRow>
          <PreviewRow className={box}>
            <Text className={fs}>○ Review PR #142</Text>
          </PreviewRow>
        </View>
      )
    case 'crm':
      return (
        <View>
          <Text className={h}>Pipeline</Text>
          <PreviewRow className={box}>
            <View className="flex-row justify-between">
              <Text className={cn(fs, 'font-semibold')}>Acme Corp</Text>
              <Text className="text-amber-500 dark:text-amber-400 text-[9px] font-semibold">$24k</Text>
            </View>
          </PreviewRow>
          <PreviewRow className={box}>
            <View className="flex-row justify-between">
              <Text className={cn(fs, 'font-semibold')}>Beta LLC</Text>
              <Text className="text-amber-500 dark:text-amber-400 text-[9px]">Proposal</Text>
            </View>
          </PreviewRow>
        </View>
      )
    case 'kanban':
      return (
        <View>
          <Text className={h}>Board</Text>
          <View className={cn('flex-row gap-1', compact ? 'h-[52px]' : 'h-16')}>
            {['Todo', 'Doing', 'Done'].map((col, i) => (
              <View key={col} className={cn('flex-1 rounded-lg p-1', box)}>
                <Text
                  className={cn(
                    'text-[8px] text-slate-500 dark:text-white/45 text-center mb-1',
                  )}
                >
                  {col}
                </Text>
                {i === 0 && (
                  <View className="rounded p-1 mb-1 bg-violet-100 dark:bg-violet-500/20">
                    <Text className={cn(compact ? 'text-[8px]' : 'text-[9px]', title)} numberOfLines={1}>
                      Task A
                    </Text>
                  </View>
                )}
                {i === 1 && (
                  <View className="rounded p-1 bg-blue-100 dark:bg-blue-500/20">
                    <Text className={cn(compact ? 'text-[8px]' : 'text-[9px]', title)} numberOfLines={1}>
                      In progress
                    </Text>
                  </View>
                )}
              </View>
            ))}
          </View>
        </View>
      )
    case 'expense-tracker':
      return (
        <View>
          <Text className={cn(h, 'mb-0')}>Total Expenses</Text>
          <Text
            className={cn(
              'font-bold text-slate-900 dark:text-white/90 my-1.5',
              compact ? 'text-xl' : 'text-2xl',
            )}
          >
            $8,247
          </Text>
          <PreviewRow className={box}>
            <Text className={fs}>Software · $2.1k</Text>
          </PreviewRow>
          <PreviewRow className={box}>
            <Text className={fs}>Travel · $1.8k</Text>
          </PreviewRow>
        </View>
      )
    case 'booking-app':
      return (
        <View>
          <Text className={h}>March 2026</Text>
          <View className="flex-row gap-2">
            <View className="flex-1 rounded-lg p-2 bg-pink-100 dark:bg-pink-500/15">
              <Text className={cn(fs, 'font-semibold')}>10:00</Text>
              <Text className={fsSm}>Consult</Text>
            </View>
            <View className={cn('flex-1 rounded-lg p-2', box)}>
              <Text className={cn(fs, 'font-semibold')}>2:00</Text>
              <Text className={fsSm}>Open</Text>
            </View>
          </View>
        </View>
      )
    case 'inventory':
      return (
        <View>
          <Text className={h}>Stock</Text>
          <PreviewRow className={box}>
            <View className="flex-row justify-between">
              <Text className={fs}>Widget A</Text>
              <Text className="text-green-600 dark:text-green-400 text-[9px] font-semibold">142</Text>
            </View>
          </PreviewRow>
          <PreviewRow className="bg-amber-50 dark:bg-amber-500/12">
            <View className="flex-row justify-between">
              <Text className={fs}>Widget B</Text>
              <Text className="text-amber-600 dark:text-amber-400 text-[9px] font-semibold">Low</Text>
            </View>
          </PreviewRow>
        </View>
      )
    case 'ai-chat':
      return (
        <View>
          <Text className={h}>Chat</Text>
          <PreviewRow className={box}>
            <Text className={fs}>You: Summarize this doc…</Text>
          </PreviewRow>
          <PreviewRow className="bg-red-50 dark:bg-red-500/10">
            <Text className={fs} numberOfLines={2}>
              AI: Here are the key points…
            </Text>
          </PreviewRow>
        </View>
      )
    case 'form-builder':
      return (
        <View>
          <Text className={h}>New form</Text>
          <PreviewRow className={box}>
            <Text className={fsSm}>Email ___________</Text>
          </PreviewRow>
          <PreviewRow className={box}>
            <Text className={fsSm}>Message ___________</Text>
          </PreviewRow>
        </View>
      )
    case 'feedback-form':
      return (
        <View>
          <Text className={h}>Rate us</Text>
          <Text className={cn(compact ? 'text-base' : 'text-lg', 'tracking-widest text-amber-500')}>
            ★★★★☆
          </Text>
          <Text className={cn(fs, 'mt-1.5')} numberOfLines={2}>
            “Loved the onboarding”
          </Text>
        </View>
      )
    default:
      return (
        <View className={cn('items-center justify-center', compact ? 'min-h-[72px]' : 'min-h-24')}>
          <Text className="text-sm">🧩</Text>
          <Text className={cn(fsSm, 'mt-1.5')}>Full-stack starter</Text>
        </View>
      )
  }
}

export function AppTemplateGalleryCard({
  template,
  isLoading,
  onPress,
  isDark,
  compact = false,
}: {
  template: AppTemplateSummary
  isLoading: boolean
  onPress: () => void
  isDark: boolean
  compact?: boolean
}) {
  const icon = APP_ICONS[template.name] || '🧩'
  const displayName = template.name.split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
  const complexity = template.complexity
  const cat = COMPLEXITY_BADGE[complexity] || COMPLEXITY_BADGE.beginner
  const popular = POPULAR_APPS.has(template.name)
  const iconBox = APP_ICON_BOX[template.name] || 'bg-indigo-500/15 dark:bg-indigo-400/20'
  const spinner = APP_SPINNER[template.name] || '#6366f1'
  const tags = template.tags.slice(0, 3)
  const iconColor = isDark ? '#cbd5e1' : '#475569'

  return (
    <Pressable
      onPress={onPress}
      disabled={isLoading}
      className={cn(
        'rounded-2xl overflow-hidden border bg-card border-slate-200/80 dark:border-slate-800',
        Platform.OS === 'web' && 'cursor-pointer group',
        isLoading && 'opacity-50',
        Platform.OS === 'web' &&
          'shadow-lg shadow-slate-900/5 dark:shadow-black/40 web:transition-all web:duration-200 web:hover:shadow-xl web:hover:border-primary/40',
      )}
    >
      <View className={cn(compact ? 'p-3 pb-2.5' : 'p-4 pb-3')}>
        <View
          className={cn(
            'rounded-[14px] border border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-white/5',
            compact ? 'min-h-[112px] p-2.5 mb-2.5' : 'min-h-[148px] p-3 mb-3.5',
          )}
        >
          <AppPreview name={template.name} compact={compact} />
        </View>

        <View className="flex-row items-start gap-3">
          <View
            className={cn(
              'rounded-xl items-center justify-center flex-shrink-0',
              compact ? 'w-10 h-10' : 'w-11 h-11',
              iconBox,
            )}
          >
            <Text className={compact ? 'text-xl' : 'text-2xl'}>{icon}</Text>
          </View>
          <View className="flex-1 min-w-0">
            <View className="flex-row flex-wrap items-center gap-1.5 mb-1">
              <Text
                className={cn(
                  'text-card-foreground font-semibold',
                  compact ? 'text-sm leading-5' : 'text-base leading-snug',
                )}
                numberOfLines={2}
              >
                {displayName}
              </Text>
              {popular && (
                <View className="flex-row items-center gap-0.5 px-2 py-0.5 rounded-md bg-orange-100 dark:bg-orange-500/20">
                  <Sparkles size={11} color={isDark ? '#fb923c' : '#ea580c'} />
                  <Text className="text-[10px] font-bold text-orange-700 dark:text-orange-400">Popular</Text>
                </View>
              )}
              <View className={cn('px-2 py-0.5 rounded-md', cat.box)}>
                <Text className={cn('text-[10px] font-semibold', cat.text)}>
                  {complexity.charAt(0).toUpperCase() + complexity.slice(1)}
                </Text>
              </View>
            </View>
            <Text
              className={cn(
                'text-muted-foreground',
                compact ? 'text-xs leading-[17px]' : 'text-[13px] leading-[19px]',
              )}
              numberOfLines={compact ? 2 : 3}
            >
              {template.description}
            </Text>
          </View>
        </View>

        {!compact && tags.length > 0 && (
          <View className="flex-row flex-wrap gap-1.5 mt-3">
            {tags.map((tag) => (
              <View
                key={tag}
                className="px-2 py-1 rounded-md border border-slate-200 dark:border-white/15 bg-white dark:bg-transparent"
              >
                <Text className="text-[10px] font-medium text-slate-600 dark:text-white/75">{tag}</Text>
              </View>
            ))}
          </View>
        )}

        <View className="flex-row items-center justify-center gap-2 mt-3 rounded-xl border border-slate-200 dark:border-white/10 bg-slate-100 dark:bg-white/10 py-2.5 web:transition-all web:duration-200 web:group-hover:bg-primary web:group-hover:border-primary">
          <Zap size={compact ? 15 : 16} className="text-slate-600 dark:text-slate-300 web:transition-colors web:duration-200 web:group-hover:text-primary-foreground" />
          <Text className={cn('font-semibold text-slate-700 dark:text-white/85 web:transition-colors web:duration-200 web:group-hover:text-primary-foreground', compact ? 'text-[13px]' : 'text-sm')}>
            Use Template
          </Text>
          <ChevronRight size={compact ? 15 : 16} className="text-slate-600 dark:text-slate-300 web:transition-colors web:duration-200 web:group-hover:text-primary-foreground" />
        </View>
      </View>

      {isLoading && (
        <View className="absolute inset-0 items-center justify-center rounded-2xl bg-white/90 dark:bg-black/65">
          <ActivityIndicator size="small" color={spinner} />
        </View>
      )}
    </Pressable>
  )
}
