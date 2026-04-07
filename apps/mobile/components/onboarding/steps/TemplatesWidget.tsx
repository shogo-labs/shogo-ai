// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { useState, useEffect } from 'react'
import { View, Text, Pressable, ActivityIndicator } from 'react-native'
import { Check, ArrowRight } from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import { API_URL } from '../../../lib/api'
import { safeGetItem } from '../../../lib/safe-storage'
import { Platform } from 'react-native'

interface AgentTemplate {
  id: string
  name: string
  description: string
  icon: string
}

const TEMPLATE_COLORS: Record<string, string> = {
  'research-assistant': '#3b82f6',
  'github-ops': '#f97316',
  'support-desk': '#8b5cf6',
  'meeting-prep': '#10b981',
  'revenue-tracker': '#ec4899',
  'project-board': '#06b6d4',
  'incident-commander': '#ef4444',
  'personal-assistant': '#f59e0b',
}

interface TemplatesWidgetProps {
  onComplete: () => void
  onSelectTemplate: (id: string | null) => void
  selectedTemplate: string | null
}

export function TemplatesWidget({ onComplete, onSelectTemplate, selectedTemplate }: TemplatesWidgetProps) {
  const [templates, setTemplates] = useState<AgentTemplate[]>([])
  const [isLoading, setIsLoading] = useState(true)

  useEffect(() => {
    fetch(`${API_URL}/api/agent-templates`, { credentials: 'include' })
      .then(r => r.json())
      .then((data: any) => {
        const list: AgentTemplate[] = data.templates ?? []
        setTemplates(list)
        if (Platform.OS === 'web') {
          const pending = safeGetItem('pending_template_id')
          if (pending && list.some(t => t.id === pending)) {
            onSelectTemplate(pending)
          }
        }
      })
      .catch(() => {})
      .finally(() => setIsLoading(false))
  }, [])

  if (isLoading) {
    return (
      <View className="items-center py-8">
        <ActivityIndicator size="large" />
      </View>
    )
  }

  return (
    <View className="gap-3">
      {templates.slice(0, 6).map(t => {
        const color = TEMPLATE_COLORS[t.id] || '#6366f1'
        const isSelected = selectedTemplate === t.id
        return (
          <Pressable
            key={t.id}
            onPress={() => onSelectTemplate(isSelected ? null : t.id)}
            className={cn(
              'flex-row items-center gap-3 p-3 rounded-xl border',
              isSelected ? 'border-primary bg-primary/5' : 'border-border bg-card'
            )}
          >
            <View
              className="w-9 h-9 rounded-lg items-center justify-center"
              style={{ backgroundColor: `${color}15` }}
            >
              <Text style={{ fontSize: 18 }}>{t.icon}</Text>
            </View>
            <View className="flex-1">
              <Text className="text-sm font-semibold text-foreground">{t.name}</Text>
              <Text className="text-xs text-muted-foreground" numberOfLines={1}>{t.description}</Text>
            </View>
            {isSelected && <Check size={16} className="text-primary" />}
          </Pressable>
        )
      })}

      <Pressable
        onPress={onComplete}
        className="flex-row items-center justify-center gap-2 bg-primary py-3 rounded-xl mt-1"
      >
        <Text className="text-sm font-semibold text-primary-foreground">
          {selectedTemplate ? 'Continue' : 'Skip'}
        </Text>
        <ArrowRight size={16} color="#fff" />
      </Pressable>
    </View>
  )
}
