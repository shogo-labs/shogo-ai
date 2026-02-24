/**
 * ProjectTopBar - Full-width navigation bar for the project detail view.
 *
 * Replaces the default sidebar + header when viewing a project (wide screens).
 *
 * Layout:
 *  - Left: Back button, project name + "Agent project" subtitle, chat history toggle, chat collapse toggle
 *  - Center: Tab buttons (Canvas, Workspace, Skills, MCP Servers, Heartbeat, Channels, Analytics, Logs)
 *  - Right: GitHub icon, Upgrade button, Publish button
 */

import { useCallback } from 'react'
import { View, Text, Pressable, useWindowDimensions, ScrollView } from 'react-native'
import { useRouter } from 'expo-router'
import {
  ArrowLeft,
  History,
  PanelLeftClose,
  PanelLeft,
  Github,
  Zap,
  ChevronDown,
} from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'

const AGENT_TABS = [
  { id: 'dynamic-app', label: 'Canvas' },
  { id: 'workspace', label: 'Workspace' },
  { id: 'skills', label: 'Skills' },
  { id: 'mcp-servers', label: 'MCP Servers' },
  { id: 'heartbeat', label: 'Heartbeat' },
  { id: 'channels', label: 'Channels' },
  { id: 'analytics', label: 'Analytics' },
  { id: 'logs', label: 'Logs' },
]

export interface ProjectTopBarProps {
  projectName: string
  projectId: string
  showChatSessions?: boolean
  isChatCollapsed?: boolean
  onChatSessionsToggle?: () => void
  onChatCollapseToggle?: () => void
  activeTab?: string
  onTabChange?: (tabId: string) => void
}

export function ProjectTopBar({
  projectName,
  projectId,
  showChatSessions = false,
  isChatCollapsed = false,
  onChatSessionsToggle,
  onChatCollapseToggle,
  activeTab = 'dynamic-app',
  onTabChange,
}: ProjectTopBarProps) {
  const router = useRouter()
  const { width } = useWindowDimensions()
  const isWide = width >= 768

  const handleBack = useCallback(() => {
    router.push('/(app)' as any)
  }, [router])

  return (
    <View className="h-12 bg-background/95 flex-row items-center justify-between px-3 border-b border-border">
      {/* Left: Back + project name + toggles */}
      <View className="flex-row items-center gap-1 flex-shrink-0">
        <Pressable
          onPress={handleBack}
          className="h-7 w-7 items-center justify-center rounded-md active:bg-muted"
        >
          <ArrowLeft size={14} className="text-muted-foreground" />
        </Pressable>

        <Pressable className="flex-row items-center gap-1.5 px-1.5 py-1 rounded-md active:bg-muted max-w-[200px]">
          <View>
            <Text className="text-sm font-semibold text-foreground" numberOfLines={1}>
              {projectName}
            </Text>
            <Text className="text-[10px] text-muted-foreground">Agent project</Text>
          </View>
          <ChevronDown size={12} className="text-muted-foreground" />
        </Pressable>

        {isWide && (
          <>
            <Pressable
              onPress={onChatSessionsToggle}
              className={cn(
                'h-7 w-7 items-center justify-center rounded-md',
                showChatSessions ? 'bg-accent' : 'active:bg-muted'
              )}
            >
              <History size={14} className={showChatSessions ? 'text-foreground' : 'text-muted-foreground'} />
            </Pressable>

            <Pressable
              onPress={onChatCollapseToggle}
              className={cn(
                'h-7 w-7 items-center justify-center rounded-md',
                isChatCollapsed ? 'bg-accent' : 'active:bg-muted'
              )}
            >
              {isChatCollapsed ? (
                <PanelLeft size={14} className="text-foreground" />
              ) : (
                <PanelLeftClose size={14} className="text-muted-foreground" />
              )}
            </Pressable>
          </>
        )}
      </View>

      {/* Center: Tab buttons (wide only) */}
      {isWide && (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerClassName="flex-row items-center gap-0.5"
          className="flex-shrink mx-2"
        >
          {AGENT_TABS.map((tab) => (
            <Pressable
              key={tab.id}
              onPress={() => onTabChange?.(tab.id)}
              className={cn(
                'px-2.5 py-1 rounded-md',
                activeTab === tab.id
                  ? 'bg-primary'
                  : 'active:bg-muted'
              )}
            >
              <Text
                className={cn(
                  'text-xs font-medium',
                  activeTab === tab.id
                    ? 'text-primary-foreground'
                    : 'text-muted-foreground'
                )}
              >
                {tab.label}
              </Text>
            </Pressable>
          ))}
        </ScrollView>
      )}

      {/* Right: GitHub, Upgrade, Publish */}
      <View className="flex-row items-center gap-1.5 flex-shrink-0">
        <Pressable className="h-8 w-8 items-center justify-center rounded-md active:bg-muted">
          <Github size={16} className="text-muted-foreground" />
        </Pressable>

        <Pressable className="h-8 flex-row items-center gap-1.5 px-2.5 rounded-md border border-border active:bg-muted">
          <Zap size={14} className="text-muted-foreground" />
          <Text className="text-xs font-medium text-foreground">Upgrade</Text>
        </Pressable>

        <Pressable className="h-8 flex-row items-center px-3 rounded-md bg-primary active:bg-primary/80">
          <Text className="text-xs font-medium text-primary-foreground">Publish</Text>
        </Pressable>
      </View>
    </View>
  )
}
