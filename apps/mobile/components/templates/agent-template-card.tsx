// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import type { ReactNode } from 'react'
import { View, Text, Pressable, ActivityIndicator, Platform } from 'react-native'
import { Zap, ChevronRight, Sparkles } from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'


const SPINNER_COLOR: Record<string, string> = {
  'marketing-command-center': '#a855f7',
  'devops-hub': '#2563eb',
  'project-manager': '#06b6d4',
  'sales-revenue': '#ca8a04',
  'support-ops': '#8b5cf6',
  'research-analyst': '#3b82f6',
  'hr-recruiting': '#14b8a6',
  'personal-assistant': '#a855f7',
  'operations-monitor': '#ef4444',
  'code-quality': '#22c55e',
  'comms-monitoring': '#6366f1',
  'engineering-pulse': '#06b6d4',
  'incident-response': '#f97316',
  'meeting-intelligence': '#3b82f6',
  'research-tracking': '#10b981',
  'revenue-finance': '#22c55e',
  'standup-automation': '#f59e0b',
  'yc-founder-operating-system': '#f97316',
  'virtual-engineering-team': '#14b8a6',
  'equity-research-terminal': '#2563eb',
  'portfolio-risk-desk': '#f97316',
  'technical-quant-lab': '#8b5cf6',
  'dividend-income-builder': '#22c55e',
  'macro-market-briefing': '#0ea5e9',
  'travel-concierge': '#0ea5e9',
}

const POPULAR_IDS = new Set([
  'marketing-command-center',
  'devops-hub',
  'personal-assistant',
  'sales-revenue',
])

const CATEGORY_LABEL: Record<string, string> = {
  personal: 'Personal',
  development: 'Development',
  business: 'Business',
  research: 'Research',
  operations: 'DevOps',
  marketing: 'Marketing',
  sales: 'Sales',
}

const CATEGORY_BADGE: Record<string, { box: string; text: string }> = {
  marketing: {
    box: 'bg-violet-500/15 dark:bg-violet-500/25',
    text: 'text-violet-700 dark:text-violet-300',
  },
  development: {
    box: 'bg-blue-500/12 dark:bg-blue-500/20',
    text: 'text-blue-600 dark:text-blue-300',
  },
  business: {
    box: 'bg-teal-500/15 dark:bg-teal-500/20',
    text: 'text-teal-700 dark:text-teal-300',
  },
  research: {
    box: 'bg-blue-500/12 dark:bg-blue-500/18',
    text: 'text-blue-700 dark:text-blue-300',
  },
  operations: {
    box: 'bg-red-500/12 dark:bg-red-500/18',
    text: 'text-red-600 dark:text-red-300',
  },
  sales: {
    box: 'bg-amber-500/16 dark:bg-amber-500/20',
    text: 'text-amber-700 dark:text-amber-300',
  },
  personal: {
    box: 'bg-violet-500/15 dark:bg-violet-500/22',
    text: 'text-violet-700 dark:text-violet-300',
  },
}

export interface AgentTemplateCardData {
  id: string
  name: string
  description: string
  category: string
  tags: string[]
}

function PreviewRow({
  children,
  className,
}: {
  children: ReactNode
  className?: string
}) {
  return (
    <View className={cn('rounded-lg py-1.5 px-2 mb-1', className)}>
      {children}
    </View>
  )
}

function previewText(compact: boolean, bold?: boolean) {
  return cn(
    compact ? 'text-[9px]' : 'text-[10px]',
    bold ? 'font-semibold text-slate-900 dark:text-white/90' : 'text-slate-900 dark:text-white/90',
  )
}

function AgentTemplatePreview({
  templateId,
  compact,
}: {
  templateId: string
  compact: boolean
}) {
  const h = cn(compact ? 'text-[10px]' : 'text-[11px]', 'font-semibold text-slate-500 dark:text-white/45 mb-1.5')
  const muted = cn(compact ? 'text-[8px]' : 'text-[9px]', 'text-slate-500 dark:text-white/55')
  const box = 'bg-slate-100 dark:bg-white/10'
  const fs = previewText(compact, true)
  const fsN = previewText(compact)

  switch (templateId) {
    case 'marketing-command-center':
      return (
        <View>
          <Text className={h}>Generated Copy</Text>
          <PreviewRow className="bg-emerald-50 dark:bg-emerald-500/10">
            <Text className={fs}>Hero Headline</Text>
            <Text className={cn(muted, 'mt-0.5')} numberOfLines={1}>
              Ship faster with AI that knows your stack
            </Text>
          </PreviewRow>
          <PreviewRow className="bg-blue-50 dark:bg-blue-500/10">
            <Text className={fs}>CTA Button</Text>
            <Text className={cn(muted, 'mt-0.5 text-blue-600 dark:text-blue-400')}>Start free →</Text>
          </PreviewRow>
        </View>
      )
    case 'devops-hub':
      return (
        <View>
          <View className="flex-row items-center justify-between mb-2">
            <Text className={cn(h, 'mb-0')}>Repository Activity</Text>
            <View className="self-start px-1.5 py-0.5 rounded bg-green-100 dark:bg-green-500/20">
              <Text className="text-[8px] font-semibold text-green-600 dark:text-green-400">Live</Text>
            </View>
          </View>
          <PreviewRow className={box}>
            <View className="flex-row items-center gap-2">
              <View className="w-1.5 h-1.5 rounded-full bg-green-500" />
              <View className="flex-1">
                <Text className={fs} numberOfLines={1}>
                  feat: Add user authentication
                </Text>
                <Text className={muted}>main • 2 min ago</Text>
              </View>
            </View>
          </PreviewRow>
          <PreviewRow className={box}>
            <View className="flex-row items-center gap-2">
              <View className="w-1.5 h-1.5 rounded-full bg-blue-500" />
              <View className="flex-1">
                <Text className={fs} numberOfLines={1}>
                  fix: Resolve API timeout
                </Text>
                <Text className={muted}>develop • 15 min ago</Text>
              </View>
            </View>
          </PreviewRow>
        </View>
      )
    case 'project-manager':
      return (
        <View>
          <Text className={h}>Sprint Progress</Text>
          <View className="flex-row gap-2 mb-2">
            {[
              ['10', 'TODO'],
              ['3', 'DOING'],
              ['7', 'DONE'],
            ].map(([n, l]) => (
              <View key={l} className={cn('flex-1 items-center py-1 rounded-md', box)}>
                <Text
                  className={cn(
                    compact ? 'text-xs' : 'text-sm',
                    'font-bold text-slate-900 dark:text-white/90',
                  )}
                >
                  {n}
                </Text>
                <Text className={cn(compact ? 'text-[8px]' : 'text-[9px]', muted)}>{l}</Text>
              </View>
            ))}
          </View>
          <View className={cn('rounded-sm mb-1 overflow-hidden', box, compact ? 'h-1' : 'h-1.5')}>
            <View className="h-full w-[72%] rounded-sm bg-amber-400" />
          </View>
          <View className={cn('rounded-sm overflow-hidden', box, compact ? 'h-1' : 'h-1.5')}>
            <View className="h-full w-[45%] rounded-sm bg-blue-500" />
          </View>
        </View>
      )
    case 'sales-revenue':
      return (
        <View>
          <Text className={cn(h, 'mb-1')}>Pipeline Value</Text>
          <Text
            className={cn(
              'font-bold text-slate-900 dark:text-white/90 mb-2',
              compact ? 'text-lg' : 'text-xl',
            )}
          >
            $342K
          </Text>
          <View className={cn('flex-row gap-1', compact ? 'h-7' : 'h-8')}>
            <View className="flex-1 rounded-md bg-amber-100 dark:bg-amber-500/25" />
            <View className="flex-1 rounded-md bg-blue-100 dark:bg-blue-500/25" />
            <View className="flex-1 rounded-md bg-green-100 dark:bg-green-500/25" />
          </View>
          <Text className={cn(muted, 'mt-1')}>Qualified · Proposal · Closing</Text>
        </View>
      )
    case 'support-ops':
      return (
        <View>
          <Text className={h}>Recent Tickets</Text>
          <PreviewRow className="bg-amber-100 dark:bg-amber-500/15">
            <Text className={cn(fs, 'text-amber-700 dark:text-amber-400')} numberOfLines={1}>
              URGENT — Payment issue
            </Text>
            <Text className={muted}>2m ago</Text>
          </PreviewRow>
          <PreviewRow className={box}>
            <Text className={fs} numberOfLines={1}>
              NORMAL — Feature request
            </Text>
            <Text className={muted}>1h ago</Text>
          </PreviewRow>
        </View>
      )
    case 'research-analyst':
      return (
        <View>
          <Text className={h}>Research Topics</Text>
          <PreviewRow className="bg-emerald-50 dark:bg-emerald-500/10">
            <Text className={fsN}>✓ Market sizing report</Text>
          </PreviewRow>
          <PreviewRow className="bg-blue-50 dark:bg-blue-500/10">
            <Text className={fsN}>◷ Competitor analysis</Text>
          </PreviewRow>
        </View>
      )
    case 'hr-recruiting':
      return (
        <View>
          <Text className={h}>Active Candidates</Text>
          {[
            {
              init: 'SM',
              name: 'Sarah M.',
              role: 'Engineer',
              status: 'Active',
              pillBox: 'bg-blue-100 dark:bg-blue-500/20',
              pillText: 'text-blue-700 dark:text-blue-300',
            },
            {
              init: 'JD',
              name: 'James D.',
              role: 'PM',
              status: 'Pending',
              pillBox: 'bg-amber-100 dark:bg-amber-500/20',
              pillText: 'text-amber-700 dark:text-amber-300',
            },
          ].map((row) => (
            <View key={row.name} className="flex-row items-center gap-2 mb-2 py-1">
              <View className="w-7 h-7 rounded-full items-center justify-center bg-slate-200 dark:bg-white/10">
                <Text
                  className={cn(
                    compact ? 'text-[8px]' : 'text-[9px]',
                    'font-bold text-slate-900 dark:text-white/90',
                  )}
                >
                  {row.init}
                </Text>
              </View>
              <View className="flex-1">
                <Text className={fs} numberOfLines={1}>
                  {row.name}
                </Text>
                <Text className={muted}>{row.role}</Text>
              </View>
              <View className={cn('self-start px-1.5 py-0.5 rounded', row.pillBox)}>
                <Text className={cn('text-[8px] font-semibold', row.pillText)}>{row.status}</Text>
              </View>
            </View>
          ))}
        </View>
      )
    case 'personal-assistant':
      return (
        <View>
          <Text className={h}>{"Today's Schedule"}</Text>
          {[
            {
              time: '9:00',
              ev: 'Team Standup',
              box: 'bg-amber-50 dark:bg-amber-500/15',
              timeCls: 'text-amber-600 dark:text-amber-400',
            },
            {
              time: '11:00',
              ev: 'Client Review',
              box: 'bg-blue-50 dark:bg-blue-500/15',
              timeCls: 'text-blue-600 dark:text-blue-400',
            },
            {
              time: '2:00',
              ev: 'Deep Work',
              box: 'bg-emerald-50 dark:bg-emerald-500/10',
              timeCls: 'text-emerald-600 dark:text-emerald-400',
            },
          ].map((row) => (
            <PreviewRow key={row.ev} className={cn(row.box, 'mb-0.5')}>
              <Text className={cn(compact ? 'text-[9px]' : 'text-[10px]', 'font-bold', row.timeCls)}>
                {row.time}
              </Text>
              <Text className={cn(muted, 'mt-0.5 text-slate-900 dark:text-white/90')} numberOfLines={1}>
                {row.ev}
              </Text>
            </PreviewRow>
          ))}
        </View>
      )
    case 'operations-monitor':
      return (
        <View>
          <View className="flex-row items-center justify-between mb-2">
            <Text className={cn(h, 'mb-0')}>API Status</Text>
            <View className="flex-row items-center gap-1">
              <View className="w-1.5 h-1.5 rounded-full bg-green-500" />
              <Text className={cn(muted, 'text-green-600 dark:text-green-400 font-semibold')}>All OK</Text>
            </View>
          </View>
          {[
            ['Auth API', '99.9%', '42ms'],
            ['Data API', '99.8%', '58ms'],
          ].map(([n, u, l]) => (
            <View
              key={n as string}
              className={cn('flex-row justify-between py-1.5 px-2 rounded-md mb-1', box)}
            >
              <Text className={fs}>{n as string}</Text>
              <Text className={muted}>
                {u as string} · {l as string}
              </Text>
            </View>
          ))}
          <PreviewRow className="bg-amber-50 dark:bg-amber-500/12">
            <Text className={fsN} numberOfLines={1}>
              Payment API — 342ms latency
            </Text>
          </PreviewRow>
        </View>
      )
    case 'code-quality':
      return (
        <View>
          <Text className={h}>Pull Requests</Text>
          <PreviewRow className="bg-green-50 dark:bg-green-500/10">
            <View className="flex-row items-center gap-2">
              <View className="w-1.5 h-1.5 rounded-full bg-green-500" />
              <View className="flex-1">
                <Text className={fs} numberOfLines={1}>
                  feat: Add caching layer
                </Text>
                <Text className={cn(muted, 'text-green-600 dark:text-green-400')}>Approved · main</Text>
              </View>
            </View>
          </PreviewRow>
          <PreviewRow className="bg-amber-50 dark:bg-amber-500/10">
            <View className="flex-row items-center gap-2">
              <View className="w-1.5 h-1.5 rounded-full bg-amber-500" />
              <View className="flex-1">
                <Text className={fs} numberOfLines={1}>
                  fix: Memory leak in worker
                </Text>
                <Text className={cn(muted, 'text-amber-600 dark:text-amber-400')}>Changes requested · dev</Text>
              </View>
            </View>
          </PreviewRow>
        </View>
      )
    case 'comms-monitoring':
      return (
        <View>
          <Text className={h}>Monitored Channels</Text>
          <PreviewRow className={box}>
            <View className="flex-row items-center gap-2">
              <View className="w-1.5 h-1.5 rounded-full bg-indigo-500" />
              <View className="flex-1">
                <Text className={fs} numberOfLines={1}>
                  #eng-alerts — deploy keyword
                </Text>
                <Text className={muted}>Slack · 5 min ago</Text>
              </View>
            </View>
          </PreviewRow>
          <PreviewRow className="bg-indigo-50 dark:bg-indigo-500/10">
            <View className="flex-row items-center gap-2">
              <View className="w-1.5 h-1.5 rounded-full bg-red-500" />
              <View className="flex-1">
                <Text className={fs} numberOfLines={1}>
                  CEO mention — quarterly update
                </Text>
                <Text className={cn(muted, 'text-red-600 dark:text-red-400')}>Email · 12 min ago</Text>
              </View>
            </View>
          </PreviewRow>
        </View>
      )
    case 'engineering-pulse':
      return (
        <View>
          <Text className={h}>This Week</Text>
          <View className="flex-row gap-2 mb-2">
            {[
              ['47', 'Commits'],
              ['12', 'PRs'],
              ['8.2', 'Velocity'],
            ].map(([n, l]) => (
              <View key={l} className={cn('flex-1 items-center py-1 rounded-md', box)}>
                <Text
                  className={cn(
                    compact ? 'text-xs' : 'text-sm',
                    'font-bold text-slate-900 dark:text-white/90',
                  )}
                >
                  {n}
                </Text>
                <Text className={cn(compact ? 'text-[8px]' : 'text-[9px]', muted)}>{l}</Text>
              </View>
            ))}
          </View>
          <Text className={cn(muted, 'mb-1')}>Sprint progress</Text>
          <View className={cn('rounded-sm overflow-hidden', box, compact ? 'h-1' : 'h-1.5')}>
            <View className="h-full w-[68%] rounded-sm bg-cyan-500" />
          </View>
        </View>
      )
    case 'incident-response':
      return (
        <View>
          <View className="flex-row items-center justify-between mb-2">
            <Text className={cn(h, 'mb-0')}>Active Incidents</Text>
            <View className="self-start px-1.5 py-0.5 rounded bg-red-100 dark:bg-red-500/20">
              <Text className="text-[8px] font-semibold text-red-600 dark:text-red-400">1 Open</Text>
            </View>
          </View>
          <PreviewRow className="bg-red-50 dark:bg-red-500/10">
            <View className="flex-row items-center gap-2">
              <View className="w-1.5 h-1.5 rounded-full bg-red-500" />
              <View className="flex-1">
                <Text className={cn(fs, 'text-red-700 dark:text-red-400')} numberOfLines={1}>
                  P1 — API gateway timeout
                </Text>
                <Text className={muted}>Investigating · 8 min ago</Text>
              </View>
            </View>
          </PreviewRow>
          <PreviewRow className="bg-green-50 dark:bg-green-500/10">
            <View className="flex-row items-center gap-2">
              <View className="w-1.5 h-1.5 rounded-full bg-green-500" />
              <View className="flex-1">
                <Text className={fs} numberOfLines={1}>
                  P2 — Elevated error rate
                </Text>
                <Text className={cn(muted, 'text-green-600 dark:text-green-400')}>Resolved · 2h ago</Text>
              </View>
            </View>
          </PreviewRow>
        </View>
      )
    case 'meeting-intelligence':
      return (
        <View>
          <Text className={h}>Upcoming Meetings</Text>
          {[
            {
              time: '10:00',
              title: 'Product Sync',
              status: 'Prepared',
              pillBox: 'bg-green-100 dark:bg-green-500/20',
              pillText: 'text-green-700 dark:text-green-300',
              rowBox: 'bg-green-50 dark:bg-green-500/10',
              timeCls: 'text-green-600 dark:text-green-400',
            },
            {
              time: '1:30',
              title: 'Investor Call',
              status: 'Needs Prep',
              pillBox: 'bg-amber-100 dark:bg-amber-500/20',
              pillText: 'text-amber-700 dark:text-amber-300',
              rowBox: 'bg-amber-50 dark:bg-amber-500/10',
              timeCls: 'text-amber-600 dark:text-amber-400',
            },
          ].map((row) => (
            <PreviewRow key={row.title} className={cn(row.rowBox, 'mb-0.5')}>
              <View className="flex-row items-center justify-between">
                <View className="flex-1">
                  <Text className={cn(compact ? 'text-[9px]' : 'text-[10px]', 'font-bold', row.timeCls)}>
                    {row.time}
                  </Text>
                  <Text className={cn(muted, 'mt-0.5 text-slate-900 dark:text-white/90')} numberOfLines={1}>
                    {row.title}
                  </Text>
                </View>
                <View className={cn('px-1.5 py-0.5 rounded', row.pillBox)}>
                  <Text className={cn('text-[8px] font-semibold', row.pillText)}>{row.status}</Text>
                </View>
              </View>
            </PreviewRow>
          ))}
        </View>
      )
    case 'research-tracking':
      return (
        <View>
          <Text className={h}>Tracked Topics</Text>
          <PreviewRow className="bg-emerald-50 dark:bg-emerald-500/10">
            <View className="flex-row items-center justify-between">
              <View className="flex-1">
                <Text className={fs} numberOfLines={1}>
                  AI regulation landscape
                </Text>
                <Text className={muted}>14 sources · Updated today</Text>
              </View>
              <View className="px-1.5 py-0.5 rounded bg-emerald-100 dark:bg-emerald-500/20">
                <Text className="text-[8px] font-semibold text-emerald-700 dark:text-emerald-300">Active</Text>
              </View>
            </View>
          </PreviewRow>
          <PreviewRow className={box}>
            <View className="flex-row items-center justify-between">
              <View className="flex-1">
                <Text className={fs} numberOfLines={1}>
                  Competitor pricing changes
                </Text>
                <Text className={muted}>8 sources · 2 days ago</Text>
              </View>
              <View className="px-1.5 py-0.5 rounded bg-blue-100 dark:bg-blue-500/20">
                <Text className="text-[8px] font-semibold text-blue-700 dark:text-blue-300">Monitoring</Text>
              </View>
            </View>
          </PreviewRow>
        </View>
      )
    case 'revenue-finance':
      return (
        <View>
          <Text className={cn(h, 'mb-1')}>Monthly Revenue</Text>
          <Text
            className={cn(
              'font-bold text-slate-900 dark:text-white/90 mb-2',
              compact ? 'text-lg' : 'text-xl',
            )}
          >
            $48.2K
          </Text>
          <View className={cn('flex-row justify-between py-1.5 px-2 rounded-md mb-1', box)}>
            <Text className={fs}>Active Subscriptions</Text>
            <Text className={cn(muted, 'text-green-600 dark:text-green-400 font-semibold')}>286</Text>
          </View>
          <PreviewRow className="bg-amber-50 dark:bg-amber-500/12">
            <View className="flex-row justify-between">
              <Text className={fsN} numberOfLines={1}>
                Overdue Invoices
              </Text>
              <Text className={cn(muted, 'text-amber-600 dark:text-amber-400 font-semibold')}>3</Text>
            </View>
          </PreviewRow>
        </View>
      )
    case 'equity-research-terminal':
      return (
        <View>
          <View className="flex-row items-center justify-between mb-2">
            <Text className={cn(h, 'mb-0')}>Equity Screener</Text>
            <View className="self-start px-1.5 py-0.5 rounded bg-blue-100 dark:bg-blue-500/20">
              <Text className="text-[8px] font-semibold text-blue-700 dark:text-blue-300">4 rows</Text>
            </View>
          </View>
          <PreviewRow className="bg-blue-50 dark:bg-blue-500/10">
            <View className="flex-row items-center justify-between">
              <View className="flex-1">
                <Text className={fs} numberOfLines={1}>
                  Example · moat review
                </Text>
                <Text className={muted}>Valuation memo · user inputs</Text>
              </View>
              <Text className={cn(muted, 'font-semibold text-blue-700 dark:text-blue-300')}>Review</Text>
            </View>
          </PreviewRow>
          <PreviewRow className={box}>
            <View className="flex-row items-center justify-between">
              <Text className={fsN} numberOfLines={1}>
                Earnings notes
              </Text>
              <Text className={cn(muted, 'font-semibold')}>12 sources</Text>
            </View>
          </PreviewRow>
          <View className={cn('rounded-sm overflow-hidden', box, compact ? 'h-1' : 'h-1.5')}>
            <View className="h-full w-[74%] rounded-sm bg-blue-500" />
          </View>
        </View>
      )
    case 'portfolio-risk-desk':
      return (
        <View>
          <Text className={h}>Risk Heatmap</Text>
          {[
            { label: 'Tech concentration', value: '31%', color: 'bg-orange-100 dark:bg-orange-500/20', text: 'text-orange-700 dark:text-orange-300' },
            { label: 'Rate sensitivity', value: 'Med', color: box, text: 'text-slate-700 dark:text-slate-300' },
            { label: 'Recession drawdown', value: '-18%', color: 'bg-red-50 dark:bg-red-500/10', text: 'text-red-700 dark:text-red-300' },
          ].map((row) => (
            <PreviewRow key={row.label} className={row.color}>
              <View className="flex-row items-center justify-between">
                <Text className={fsN} numberOfLines={1}>
                  {row.label}
                </Text>
                <Text className={cn('text-[9px] font-bold', row.text)}>{row.value}</Text>
              </View>
            </PreviewRow>
          ))}
        </View>
      )
    case 'technical-quant-lab':
      return (
        <View>
          <View className="flex-row items-center justify-between mb-2">
            <Text className={cn(h, 'mb-0')}>Signal Setup</Text>
            <View className="self-start px-1.5 py-0.5 rounded bg-violet-100 dark:bg-violet-500/20">
              <Text className="text-[8px] font-semibold text-violet-700 dark:text-violet-300">R/R 2.8</Text>
            </View>
          </View>
          <View className="flex-row gap-1 mb-2 items-end">
            <View className="flex-1 h-5 rounded-sm bg-violet-100 dark:bg-violet-500/20" />
            <View className="flex-1 h-8 rounded-sm bg-violet-200 dark:bg-violet-500/35" />
            <View className="flex-1 h-4 rounded-sm bg-violet-100 dark:bg-violet-500/20" />
            <View className="flex-1 h-10 rounded-sm bg-green-100 dark:bg-green-500/25" />
            <View className="flex-1 h-6 rounded-sm bg-violet-100 dark:bg-violet-500/20" />
          </View>
          <PreviewRow className={box}>
            <Text className={fs} numberOfLines={1}>
              AAPL · RSI 54 · MACD turning
            </Text>
            <Text className={muted}>Entry 182-185 · stop 176</Text>
          </PreviewRow>
        </View>
      )
    case 'dividend-income-builder':
      return (
        <View>
          <Text className={cn(h, 'mb-1')}>Income Projection</Text>
          <Text
            className={cn(
              'font-bold text-slate-900 dark:text-white/90 mb-2',
              compact ? 'text-lg' : 'text-xl',
            )}
          >
            $1,240/mo
          </Text>
          <PreviewRow className="bg-green-50 dark:bg-green-500/10">
            <View className="flex-row justify-between">
              <Text className={fsN} numberOfLines={1}>
                Safety score
              </Text>
              <Text className={cn(muted, 'text-green-700 dark:text-green-300 font-semibold')}>8.4/10</Text>
            </View>
          </PreviewRow>
          <View className={cn('rounded-sm mb-1 overflow-hidden', box, compact ? 'h-1' : 'h-1.5')}>
            <View className="h-full w-[62%] rounded-sm bg-green-500" />
          </View>
          <Text className={muted}>DRIP compounding · 10 years</Text>
        </View>
      )
    case 'macro-market-briefing':
      return (
        <View>
          <Text className={h}>Macro Brief</Text>
          <View className="flex-row gap-2 mb-2">
            {[
              ['Rates', 'Hold'],
              ['CPI', 'Cool'],
              ['USD', 'Firm'],
            ].map(([metric, status]) => (
              <View key={metric} className={cn('flex-1 items-center py-1 rounded-md', box)}>
                <Text className={cn(compact ? 'text-[9px]' : 'text-[10px]', 'font-bold text-slate-900 dark:text-white/90')}>
                  {metric}
                </Text>
                <Text className={muted}>{status}</Text>
              </View>
            ))}
          </View>
          <PreviewRow className="bg-sky-50 dark:bg-sky-500/10">
            <Text className={fs} numberOfLines={1}>
              Overweight quality defensives
            </Text>
            <Text className={muted}>Fed path · 6-12 month view</Text>
          </PreviewRow>
        </View>
      )
    case 'yc-founder-operating-system':
      return (
        <View>
          <Text className={h}>Today's Plan</Text>
          {[
            { n: '1', title: 'Close seed round terms', meta: '90 min · decision owed' },
            { n: '2', title: 'Ship onboarding v2', meta: 'eng review · 2 PRs' },
            { n: '3', title: 'Design consult: pricing', meta: '30 min · 2 pm' },
          ].map((row) => (
            <PreviewRow key={row.n} className={box}>
              <View className="flex-row items-center gap-2">
                <View className="w-4 h-4 rounded-full items-center justify-center bg-orange-100 dark:bg-orange-500/25">
                  <Text
                    className={cn(
                      compact ? 'text-[8px]' : 'text-[9px]',
                      'font-bold text-orange-700 dark:text-orange-300',
                    )}
                  >
                    {row.n}
                  </Text>
                </View>
                <View className="flex-1">
                  <Text className={fs} numberOfLines={1}>
                    {row.title}
                  </Text>
                  <Text className={muted}>{row.meta}</Text>
                </View>
              </View>
            </PreviewRow>
          ))}
        </View>
      )
    case 'virtual-engineering-team':
      return (
        <View>
          <Text className={h}>Sprint Pipeline</Text>
          {[
            { stage: 'Think',  role: 'host',     meta: 'office-hours · design doc' },
            { stage: 'Plan',   role: 'ceo · eng · design', meta: '3 reviews · verdict owed' },
            { stage: 'Review', role: 'reviewer', meta: 'staff eng · ship / revise / kill' },
          ].map((row) => (
            <PreviewRow key={row.stage} className={box}>
              <View className="flex-row items-center gap-2">
                <View className="w-4 h-4 rounded-full items-center justify-center bg-teal-100 dark:bg-teal-500/25">
                  <Text
                    className={cn(
                      compact ? 'text-[8px]' : 'text-[9px]',
                      'font-bold text-teal-700 dark:text-teal-300',
                    )}
                  >
                    {row.stage[0]}
                  </Text>
                </View>
                <View className="flex-1">
                  <Text className={fs} numberOfLines={1}>
                    {row.stage} · {row.role}
                  </Text>
                  <Text className={muted}>{row.meta}</Text>
                </View>
              </View>
            </PreviewRow>
          ))}
        </View>
      )
    case 'standup-automation':
      return (
        <View>
          <Text className={h}>{"Today's Standup"}</Text>
          {[
            {
              init: 'AL',
              name: 'Alex L.',
              summary: 'Shipped auth refactor, 4 PRs merged',
              source: 'GitHub',
              pillBox: 'bg-slate-200 dark:bg-white/15',
              pillText: 'text-slate-700 dark:text-slate-300',
            },
            {
              init: 'MK',
              name: 'Maya K.',
              summary: 'Updated design specs in #product',
              source: 'Slack',
              pillBox: 'bg-indigo-100 dark:bg-indigo-500/20',
              pillText: 'text-indigo-700 dark:text-indigo-300',
            },
          ].map((row) => (
            <View key={row.name} className="flex-row items-center gap-2 mb-2 py-1">
              <View className="w-7 h-7 rounded-full items-center justify-center bg-slate-200 dark:bg-white/10">
                <Text
                  className={cn(
                    compact ? 'text-[8px]' : 'text-[9px]',
                    'font-bold text-slate-900 dark:text-white/90',
                  )}
                >
                  {row.init}
                </Text>
              </View>
              <View className="flex-1 min-w-0">
                <Text className={fs} numberOfLines={1}>
                  {row.name}
                </Text>
                <Text className={muted} numberOfLines={1}>{row.summary}</Text>
              </View>
              <View className={cn('self-start px-1.5 py-0.5 rounded', row.pillBox)}>
                <Text className={cn('text-[8px] font-semibold', row.pillText)}>{row.source}</Text>
              </View>
            </View>
          ))}
        </View>
      )
    case 'travel-concierge':
      return (
        <View>
          <View className="flex-row items-center justify-between mb-2">
            <Text className={cn(h, 'mb-0')}>Trip Dashboard</Text>
            <View className="self-start px-1.5 py-0.5 rounded bg-sky-100 dark:bg-sky-500/20">
              <Text className="text-[8px] font-semibold text-sky-700 dark:text-sky-300">3 nights</Text>
            </View>
          </View>
          <PreviewRow className="bg-amber-50 dark:bg-amber-500/10">
            <View className="flex-row items-center justify-between">
              <View className="flex-1">
                <Text className={fs} numberOfLines={1}>
                  Hotel · top pick
                </Text>
                <Text className={muted}>0 min to anchor · $420/nt</Text>
              </View>
              <View className="px-1.5 py-0.5 rounded bg-amber-100 dark:bg-amber-500/20">
                <Text className="text-[8px] font-semibold text-amber-700 dark:text-amber-300">Book</Text>
              </View>
            </View>
          </PreviewRow>
          <PreviewRow className="bg-emerald-50 dark:bg-emerald-500/10">
            <View className="flex-row items-center justify-between">
              <View className="flex-1">
                <Text className={fs} numberOfLines={1}>
                  Tasting menu · 8pm
                </Text>
                <Text className={cn(muted, 'text-emerald-600 dark:text-emerald-400')}>Available · Resy</Text>
              </View>
            </View>
          </PreviewRow>
          <PreviewRow className="bg-amber-50 dark:bg-amber-500/10">
            <View className="flex-row items-center justify-between">
              <View className="flex-1">
                <Text className={fs} numberOfLines={1}>
                  Phone-only spot
                </Text>
                <Text className={cn(muted, 'text-amber-600 dark:text-amber-400')}>Want me to call?</Text>
              </View>
            </View>
          </PreviewRow>
        </View>
      )
    default:
      return (
        <View className={cn('items-center justify-center flex-1', compact ? 'min-h-[72px]' : 'min-h-[100px]')}>
          <Text className={compact ? 'text-sm' : 'text-base'}>✨</Text>
          <Text className={cn(muted, 'mt-1.5')}>AI-powered workspace</Text>
        </View>
      )
  }
}

export function AgentTemplateGalleryCard({
  template,
  isLoading,
  onPress,
  isDark,
  compact = false,
}: {
  template: AgentTemplateCardData
  isLoading: boolean
  onPress: () => void
  isDark: boolean
  compact?: boolean
}) {
  const cat = CATEGORY_BADGE[template.category] || CATEGORY_BADGE.development
  const catLabel = CATEGORY_LABEL[template.category] || template.category
  const popular = POPULAR_IDS.has(template.id)
  const spinner = SPINNER_COLOR[template.id] || '#6366f1'

  const displayTags = template.tags.slice(0, 3).map((t) =>
    t
      .split(/[-_]/)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' '),
  )

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
          <AgentTemplatePreview templateId={template.id} compact={compact} />
        </View>

        <View className="flex-row items-start gap-3">
          <View className="flex-1 min-w-0">
            <View className="flex-row flex-wrap items-center gap-1.5 mb-1">
              <Text
                className={cn(
                  'text-card-foreground font-semibold flex-shrink',
                  compact ? 'text-sm leading-5' : 'text-base leading-snug',
                )}
                numberOfLines={2}
              >
                {template.name}
              </Text>
              {popular && (
                <View className="flex-row items-center gap-0.5 px-2 py-0.5 rounded-md bg-orange-100 dark:bg-orange-500/20">
                  <Sparkles size={11} color={isDark ? '#fb923c' : '#ea580c'} />
                  <Text className="text-[10px] font-bold text-orange-700 dark:text-orange-400">Popular</Text>
                </View>
              )}
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
