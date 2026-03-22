// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { useState, useEffect, useCallback, useRef } from 'react'
import {
  View,
  Text,
  Pressable,
  ScrollView,
  Platform,
  ActivityIndicator,
} from 'react-native'
import * as ExpoLinking from 'expo-linking'
import {
  CheckCircle2,
  Loader2,
  ExternalLink,
  X,
  ChevronDown,
  ChevronUp,
  Kanban,
  MessageSquare,
  GitBranch,
  Mail,
  Calendar,
  Users,
  CreditCard,
  Ticket,
  AlertTriangle,
  BookOpen,
  Plane,
  Link2,
  Plug,
} from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import { openAuthFlow } from '@shogo/ui-kit/platform'
import { API_URL, api } from '../../lib/api'
import { useDomainHttp } from '../../contexts/domain'

interface IntegrationOption {
  toolkit: string
  name: string
}

interface IntegrationCategory {
  id: string
  label: string
  icon: string
  options: IntegrationOption[]
}

export interface TemplateIntegrationRef {
  categoryId: string
  description: string
  required?: boolean
}

export interface PendingToolkit {
  toolkit: string
  displayName: string
}

const INTEGRATION_CATALOG: Record<string, IntegrationCategory> = {
  'project-management': {
    id: 'project-management',
    label: 'Project Management',
    icon: 'kanban',
    options: [
      { toolkit: 'linear', name: 'Linear' },
      { toolkit: 'jira', name: 'Jira' },
      { toolkit: 'asana', name: 'Asana' },
      { toolkit: 'clickup', name: 'ClickUp' },
    ],
  },
  'communication': {
    id: 'communication',
    label: 'Communication',
    icon: 'message-square',
    options: [
      { toolkit: 'slack', name: 'Slack' },
      { toolkit: 'discord', name: 'Discord' },
    ],
  },
  'code-repository': {
    id: 'code-repository',
    label: 'Code Repository',
    icon: 'git-branch',
    options: [
      { toolkit: 'github', name: 'GitHub' },
      { toolkit: 'gitlab', name: 'GitLab' },
    ],
  },
  'email': {
    id: 'email',
    label: 'Email',
    icon: 'mail',
    options: [{ toolkit: 'gmail', name: 'Gmail' }],
  },
  'calendar': {
    id: 'calendar',
    label: 'Calendar',
    icon: 'calendar',
    options: [{ toolkit: 'googlecalendar', name: 'Google Calendar' }],
  },
  'crm': {
    id: 'crm',
    label: 'CRM',
    icon: 'users',
    options: [
      { toolkit: 'hubspot', name: 'HubSpot' },
      { toolkit: 'salesforce', name: 'Salesforce' },
    ],
  },
  'payments': {
    id: 'payments',
    label: 'Payments',
    icon: 'credit-card',
    options: [{ toolkit: 'stripe', name: 'Stripe' }],
  },
  'ticketing': {
    id: 'ticketing',
    label: 'Support Ticketing',
    icon: 'ticket',
    options: [
      { toolkit: 'zendesk', name: 'Zendesk' },
      { toolkit: 'freshdesk', name: 'Freshdesk' },
    ],
  },
  'monitoring': {
    id: 'monitoring',
    label: 'Error Monitoring',
    icon: 'alert-triangle',
    options: [{ toolkit: 'sentry', name: 'Sentry' }],
  },
  'notes': {
    id: 'notes',
    label: 'Notes & Knowledge Base',
    icon: 'notebook-pen',
    options: [{ toolkit: 'notion', name: 'Notion' }],
  },
  'travel': {
    id: 'travel',
    label: 'Travel',
    icon: 'plane',
    options: [{ toolkit: 'airbnb', name: 'Airbnb' }],
  },
}

const POLL_INTERVAL_MS = 2500
const POLL_TIMEOUT_MS = 90000
const INITIAL_POLL_DELAY_MS = 4000

const CATEGORY_ICONS: Record<string, React.ComponentType<any>> = {
  'kanban': Kanban,
  'message-square': MessageSquare,
  'git-branch': GitBranch,
  'mail': Mail,
  'calendar': Calendar,
  'users': Users,
  'credit-card': CreditCard,
  'ticket': Ticket,
  'alert-triangle': AlertTriangle,
  'notebook-pen': BookOpen,
  'plane': Plane,
}

interface ResolvedCategory extends IntegrationCategory {
  description: string
  required?: boolean
}

interface IntegrationsCardProps {
  projectId: string
  integrations?: TemplateIntegrationRef[]
  templateName?: string
  pendingToolkits?: PendingToolkit[]
  onDismiss: () => void
}

type ToolkitStatus = 'idle' | 'connecting' | 'connected'

export function IntegrationsCard({
  projectId,
  integrations,
  templateName,
  pendingToolkits,
  onDismiss,
}: IntegrationsCardProps) {
  const http = useDomainHttp()
  const [expanded, setExpanded] = useState(true)

  const [categories] = useState<ResolvedCategory[]>(() =>
    (integrations ?? [])
      .map((ref) => {
        const cat = INTEGRATION_CATALOG[ref.categoryId]
        if (!cat) return null
        return { ...cat, description: ref.description, required: ref.required }
      })
      .filter(Boolean) as ResolvedCategory[],
  )

  const [selectedToolkits, setSelectedToolkits] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {}
    for (const cat of (integrations ?? [])) {
      const category = INTEGRATION_CATALOG[cat.categoryId]
      if (category?.options[0]) {
        initial[cat.categoryId] = category.options[0].toolkit
      }
    }
    return initial
  })

  const [statuses, setStatuses] = useState<Record<string, ToolkitStatus>>({})
  const [loadingStatuses, setLoadingStatuses] = useState(true)
  const pollingRef = useRef<Record<string, boolean>>({})

  const directToolkits = pendingToolkits ?? []
  const categoryToolkits = categories.flatMap((c) => c.options.map((o) => o.toolkit))
  const directToolkitNames = directToolkits
    .map((dt) => dt.toolkit)
    .filter((tk) => !categoryToolkits.includes(tk))
  const allToolkits = [...categoryToolkits, ...directToolkitNames]

  useEffect(() => {
    if (!projectId) return
    let cancelled = false

    async function fetchStatuses() {
      setLoadingStatuses(true)
      try {
        const result = await api.getIntegrationStatuses(http, allToolkits, projectId)
        if (cancelled) return
        const newStatuses: Record<string, ToolkitStatus> = {}
        for (const [tk, val] of Object.entries(result)) {
          newStatuses[tk] = val.connected ? 'connected' : 'idle'
        }
        setStatuses(newStatuses)
      } catch {
        // Leave all as idle
      } finally {
        if (!cancelled) setLoadingStatuses(false)
      }
    }

    fetchStatuses()
    return () => { cancelled = true }
  }, [projectId])

  const pollUntilConnected = useCallback(
    async (toolkit: string) => {
      pollingRef.current[toolkit] = true
      await new Promise((r) => setTimeout(r, INITIAL_POLL_DELAY_MS))
      const start = Date.now()

      while (pollingRef.current[toolkit] && Date.now() - start < POLL_TIMEOUT_MS) {
        try {
          const result = await api.getIntegrationStatuses(http, [toolkit], projectId)
          if (result[toolkit]?.connected) {
            setStatuses((prev) => ({ ...prev, [toolkit]: 'connected' }))
            pollingRef.current[toolkit] = false
            return
          }
        } catch { /* continue polling */ }
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
      }

      pollingRef.current[toolkit] = false
      setStatuses((prev) => ({ ...prev, [toolkit]: 'idle' }))
    },
    [http, projectId],
  )

  useEffect(() => {
    return () => {
      for (const tk of Object.keys(pollingRef.current)) {
        pollingRef.current[tk] = false
      }
    }
  }, [])

  // Periodically re-check statuses so the card stays in sync when the user
  // connects via the inline ConnectToolWidget in chat.
  const BACKGROUND_POLL_MS = 10000
  const allToolkitsKey = allToolkits.join(',')
  useEffect(() => {
    if (!projectId || allToolkits.length === 0) return

    const interval = setInterval(async () => {
      try {
        const result = await api.getIntegrationStatuses(http, allToolkits, projectId)
        setStatuses((prev) => {
          const next = { ...prev }
          for (const [tk, val] of Object.entries(result)) {
            if (prev[tk] === 'connecting') continue
            next[tk] = val.connected ? 'connected' : 'idle'
          }
          return next
        })
      } catch { /* ignore */ }
    }, BACKGROUND_POLL_MS)

    return () => clearInterval(interval)
  }, [projectId, allToolkitsKey, http])

  const handleConnect = useCallback(
    async (toolkit: string) => {
      setStatuses((prev) => ({ ...prev, [toolkit]: 'connecting' }))

      try {
        const isNative = Platform.OS !== 'web'
        const redirect = isNative
          ? ExpoLinking.createURL(
              `integrations-callback?projectId=${encodeURIComponent(projectId)}`,
            )
          : undefined
        const callbackUrl = redirect
          ? `${API_URL}/api/integrations/callback?redirect=${encodeURIComponent(redirect)}`
          : `${API_URL}/api/integrations/callback`

        const data = await api.connectIntegration(http, toolkit, projectId, callbackUrl)
        const redirectUrl = data.data?.redirectUrl
        if (redirectUrl) {
          await openAuthFlow(redirectUrl)
        }
      } catch {
        setStatuses((prev) => ({ ...prev, [toolkit]: 'idle' }))
        return
      }

      pollUntilConnected(toolkit)
    },
    [http, projectId, pollUntilConnected],
  )

  const connectedCount = Object.values(statuses).filter((s) => s === 'connected').length
  const totalItems = categories.length + directToolkitNames.length

  // Collapsed view: compact pill
  if (!expanded) {
    return (
      <Pressable
        onPress={() => setExpanded(true)}
        className="flex-row items-center gap-2 rounded-xl border border-border bg-card px-3 py-2.5"
        style={Platform.OS === 'web' ? {
          boxShadow: '0 4px 16px rgba(0,0,0,0.12)',
        } as any : {}}
      >
        <Plug size={14} className="text-primary" />
        <Text className="text-xs font-medium text-foreground">
          Integrations
        </Text>
        {connectedCount > 0 && (
          <View className="px-1.5 py-0.5 rounded-full bg-green-500/15">
            <Text className="text-[10px] font-semibold text-green-600 dark:text-green-400">
              {connectedCount}/{totalItems}
            </Text>
          </View>
        )}
        <ChevronUp size={12} className="text-muted-foreground" />
      </Pressable>
    )
  }

  const subtitle = templateName
    ? `${templateName} works best with these services`
    : 'Your agent needs access to these services'

  return (
    <View
      className="rounded-xl border border-border bg-card overflow-hidden"
      style={{
        width: 340,
        maxHeight: 420,
        ...(Platform.OS === 'web'
          ? { boxShadow: '0 4px 20px rgba(0,0,0,0.15)' } as any
          : {}),
      }}
    >
      {/* Header */}
      <View className="flex-row items-center justify-between px-3.5 pt-3 pb-2">
        <View className="flex-row items-center gap-2 flex-1 mr-2">
          <Plug size={14} className="text-primary" />
          <Text className="text-sm font-semibold text-foreground" numberOfLines={1}>
            Connect your tools
          </Text>
          {connectedCount > 0 && (
            <View className="px-1.5 py-0.5 rounded-full bg-green-500/15">
              <Text className="text-[10px] font-semibold text-green-600 dark:text-green-400">
                {connectedCount}/{totalItems}
              </Text>
            </View>
          )}
        </View>
        <View className="flex-row items-center gap-0.5">
          <Pressable
            onPress={() => setExpanded(false)}
            className="p-1.5 rounded-md active:bg-muted"
            hitSlop={4}
          >
            <ChevronDown size={14} className="text-muted-foreground" />
          </Pressable>
          <Pressable
            onPress={onDismiss}
            className="p-1.5 rounded-md active:bg-muted"
            hitSlop={4}
          >
            <X size={14} className="text-muted-foreground" />
          </Pressable>
        </View>
      </View>

      <Text className="text-[11px] text-muted-foreground px-3.5 mb-2" numberOfLines={1}>
        {subtitle}
      </Text>

      {/* Body */}
      <ScrollView
        className="px-3.5"
        contentContainerStyle={{ paddingBottom: 12 }}
        showsVerticalScrollIndicator={false}
      >
        {loadingStatuses ? (
          <View className="items-center py-6">
            <ActivityIndicator size="small" className="text-muted-foreground" />
          </View>
        ) : (
          <View style={{ gap: 8 }}>
            {categories.map((category) => (
              <CompactCategoryRow
                key={category.id}
                category={category}
                selectedToolkit={selectedToolkits[category.id] ?? category.options[0]?.toolkit}
                onSelectToolkit={(toolkit) =>
                  setSelectedToolkits((prev) => ({ ...prev, [category.id]: toolkit }))
                }
                statuses={statuses}
                onConnect={handleConnect}
              />
            ))}
            {directToolkits
              .filter((dt) => !categoryToolkits.includes(dt.toolkit))
              .map((dt) => (
                <DirectToolkitRow
                  key={dt.toolkit}
                  toolkit={dt.toolkit}
                  displayName={dt.displayName}
                  status={statuses[dt.toolkit] ?? 'idle'}
                  onConnect={handleConnect}
                />
              ))}
          </View>
        )}
      </ScrollView>
    </View>
  )
}

function CompactCategoryRow({
  category,
  selectedToolkit,
  onSelectToolkit,
  statuses,
  onConnect,
}: {
  category: ResolvedCategory
  selectedToolkit: string
  onSelectToolkit: (toolkit: string) => void
  statuses: Record<string, ToolkitStatus>
  onConnect: (toolkit: string) => void
}) {
  const IconComponent = CATEGORY_ICONS[category.icon] ?? Link2
  const hasMultipleOptions = category.options.length > 1
  const anyConnected = category.options.some((o) => statuses[o.toolkit] === 'connected')
  const selectedStatus = statuses[selectedToolkit] ?? 'idle'
  const selectedName = category.options.find((o) => o.toolkit === selectedToolkit)?.name ?? selectedToolkit

  if (anyConnected) {
    const connectedOption = category.options.find((o) => statuses[o.toolkit] === 'connected')
    return (
      <View className="flex-row items-center gap-2.5 rounded-lg border border-green-500/20 bg-green-500/5 px-3 py-2.5">
        <IconComponent size={15} className="text-green-600 dark:text-green-400" />
        <Text className="text-xs font-medium text-foreground flex-1" numberOfLines={1}>
          {category.label}
        </Text>
        <View className="flex-row items-center gap-1">
          <CheckCircle2 size={12} className="text-green-500" />
          <Text className="text-[11px] text-green-600 dark:text-green-400">
            {connectedOption?.name}
          </Text>
        </View>
      </View>
    )
  }

  return (
    <View className="rounded-lg border border-border bg-background p-2.5">
      <View className="flex-row items-center gap-2.5 mb-2">
        <IconComponent size={15} className="text-muted-foreground" />
        <Text className="text-xs font-medium text-foreground flex-1" numberOfLines={1}>
          {category.label}
        </Text>
        {category.required && (
          <View className="px-1.5 py-0.5 rounded bg-primary/10">
            <Text className="text-[9px] font-semibold text-primary">Required</Text>
          </View>
        )}
      </View>

      {hasMultipleOptions && (
        <View className="flex-row flex-wrap mb-2" style={{ gap: 4 }}>
          {category.options.map((option) => {
            const isSelected = selectedToolkit === option.toolkit
            return (
              <Pressable
                key={option.toolkit}
                onPress={() => onSelectToolkit(option.toolkit)}
                className={cn(
                  'px-2 py-1 rounded-md border',
                  isSelected
                    ? 'border-primary/40 bg-primary/5'
                    : 'border-border bg-muted/50',
                )}
              >
                <Text
                  className={cn(
                    'text-[10px] font-medium',
                    isSelected ? 'text-foreground' : 'text-muted-foreground',
                  )}
                >
                  {option.name}
                </Text>
              </Pressable>
            )
          })}
        </View>
      )}

      <Pressable
        onPress={() => onConnect(selectedToolkit)}
        disabled={selectedStatus === 'connecting'}
        className={cn(
          'flex-row items-center justify-center gap-1.5 py-2 rounded-md',
          selectedStatus === 'connecting'
            ? 'bg-primary/80'
            : 'bg-primary active:opacity-80',
        )}
      >
        {selectedStatus === 'connecting' ? (
          <Loader2 size={12} className="text-primary-foreground" />
        ) : (
          <ExternalLink size={12} className="text-primary-foreground" />
        )}
        <Text className="text-[11px] font-semibold text-primary-foreground">
          {selectedStatus === 'connecting'
            ? 'Waiting...'
            : `Connect ${selectedName}`}
        </Text>
      </Pressable>
    </View>
  )
}

function DirectToolkitRow({
  toolkit,
  displayName,
  status,
  onConnect,
}: {
  toolkit: string
  displayName: string
  status: ToolkitStatus
  onConnect: (toolkit: string) => void
}) {
  if (status === 'connected') {
    return (
      <View className="flex-row items-center gap-2.5 rounded-lg border border-green-500/20 bg-green-500/5 px-3 py-2.5">
        <Link2 size={15} className="text-green-600 dark:text-green-400" />
        <Text className="text-xs font-medium text-foreground flex-1" numberOfLines={1}>
          {displayName}
        </Text>
        <View className="flex-row items-center gap-1">
          <CheckCircle2 size={12} className="text-green-500" />
          <Text className="text-[11px] text-green-600 dark:text-green-400">
            Connected
          </Text>
        </View>
      </View>
    )
  }

  return (
    <View className="rounded-lg border border-border bg-background p-2.5">
      <View className="flex-row items-center gap-2.5 mb-2">
        <Link2 size={15} className="text-muted-foreground" />
        <Text className="text-xs font-medium text-foreground flex-1" numberOfLines={1}>
          {displayName}
        </Text>
      </View>
      <Pressable
        onPress={() => onConnect(toolkit)}
        disabled={status === 'connecting'}
        className={cn(
          'flex-row items-center justify-center gap-1.5 py-2 rounded-md',
          status === 'connecting'
            ? 'bg-primary/80'
            : 'bg-primary active:opacity-80',
        )}
      >
        {status === 'connecting' ? (
          <Loader2 size={12} className="text-primary-foreground" />
        ) : (
          <ExternalLink size={12} className="text-primary-foreground" />
        )}
        <Text className="text-[11px] font-semibold text-primary-foreground">
          {status === 'connecting'
            ? 'Waiting...'
            : `Connect ${displayName}`}
        </Text>
      </Pressable>
    </View>
  )
}
