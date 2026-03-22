// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { View, Pressable } from 'react-native'
import { Text } from '@/components/ui/text'
import { Spinner } from '@/components/ui/spinner'
import { Database, LayoutDashboard } from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import type { CanvasTemplate } from '@/hooks/useTemplates'

export function formatTemplateName(id: string): string {
  return id
    .replace(/-crud$/, "")
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ")
}

const TEMPLATE_TAGLINES: Record<string, string> = {
  "weather-display": "Live weather forecast",
  "flight-search": "Search & pick flights",
  "email-dashboard": "Metrics, tabs & email tables",
  "analytics-dashboard": "Revenue charts & top products",
  "research-report": "Expandable sections & progress",
  "counter": "Simple interactive counter",
  "task-tracker-crud": "Add, complete & delete tasks",
  "stock-dashboard-crud": "Portfolio & price tracking",
  "meeting-scheduler": "Date/time pickers & submit",
  "notification-feed": "PR reviews, builds & reminders",
  "crm-pipeline": "Leads across pipeline stages",
  "expense-dashboard": "Spend, budgets & recent expenses",
  "cicd-monitor": "Deploy status & frequency",
  "support-tickets-crud": "Priority levels & status tracking",
  "invoice-tracker-crud": "Clients, amounts & due dates",
  "hr-pipeline-crud": "Applicants, stages & ratings",
  "social-media-dashboard": "Followers, trends & posts",
  "ecommerce-orders-crud": "Order metrics & status",
}

const TEMPLATE_ICONS: Record<string, string> = {
  "weather-display": "🌤️",
  "flight-search": "✈️",
  "email-dashboard": "📧",
  "analytics-dashboard": "📊",
  "research-report": "📑",
  "counter": "🔢",
  "task-tracker-crud": "✅",
  "stock-dashboard-crud": "📈",
  "meeting-scheduler": "📅",
  "notification-feed": "🔔",
  "crm-pipeline": "🤝",
  "expense-dashboard": "💰",
  "cicd-monitor": "🚀",
  "support-tickets-crud": "🎫",
  "invoice-tracker-crud": "🧾",
  "hr-pipeline-crud": "👥",
  "social-media-dashboard": "📱",
  "ecommerce-orders-crud": "🛒",
}

interface TemplateCardProps {
  template: CanvasTemplate
  onPress?: () => void
  isLoading?: boolean
}

export function TemplateCard({ template, onPress, isLoading }: TemplateCardProps) {
  const tagline = TEMPLATE_TAGLINES[template.id] ?? template.user_request.slice(0, 50)
  const icon = TEMPLATE_ICONS[template.id] ?? "🧩"

  return (
    <Pressable
      onPress={onPress}
      disabled={isLoading}
      className={cn(
        'rounded-xl p-4 border border-border/50 bg-card/60',
        'active:bg-card',
        isLoading && 'opacity-50'
      )}
    >
      <View className="flex-row items-start gap-3">
        <Text className="text-2xl mt-0.5">{icon}</Text>
        <View className="flex-1 min-w-0">
          <Text className="font-semibold text-[15px] text-foreground leading-tight">
            {formatTemplateName(template.id)}
          </Text>
          <Text className="text-sm text-muted-foreground mt-1" numberOfLines={2}>
            {tagline}
          </Text>
        </View>
      </View>

      <View className="flex-row items-center gap-2 mt-3">
        {template.needs_api_schema ? (
          <View className="flex-row items-center gap-1 px-2 py-0.5 rounded-full bg-blue-500/10 border border-blue-500/20">
            <Database size={12} className="text-blue-400" />
            <Text className="text-[11px] font-medium text-blue-400">CRUD</Text>
          </View>
        ) : (
          <View className="flex-row items-center gap-1 px-2 py-0.5 rounded-full bg-emerald-500/10 border border-emerald-500/20">
            <LayoutDashboard size={12} className="text-emerald-400" />
            <Text className="text-[11px] font-medium text-emerald-400">Display</Text>
          </View>
        )}
        <Text className="text-[11px] text-muted-foreground">
          {template.component_count} components
        </Text>
      </View>

      {isLoading && (
        <View className="absolute inset-0 bg-background/60 items-center justify-center rounded-xl">
          <Spinner className="text-primary" />
        </View>
      )}
    </Pressable>
  )
}
