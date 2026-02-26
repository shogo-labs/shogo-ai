/**
 * ProjectTopBar - Full-width navigation bar for the project detail view.
 *
 * Replaces the default sidebar + header when viewing a project (wide screens).
 *
 * Layout:
 *  - Left: Back button, project name + "Agent project" subtitle, chat history toggle, chat collapse toggle
 *  - Center: Tab buttons (Canvas, Status, Workspace, Skills, MCP Servers, Channels, Analytics, Logs)
 *  - Right: GitHub icon, Upgrade button, Publish button
 */

import { useCallback, useState, useRef, useEffect } from 'react'
import {
  View,
  Text,
  Pressable,
  useWindowDimensions,
  ScrollView,
  Modal,
  TextInput,
  Platform,
} from 'react-native'
import { useRouter } from 'expo-router'
import {
  ArrowLeft,
  History,
  PanelLeftClose,
  PanelLeft,
  Github,
  Zap,
  ChevronDown,
  ChevronLeft,
  Check,
  Search,
  Bot,
  AppWindow,
} from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import { PublishDropdown } from './PublishDropdown'

const AGENT_TABS = [
  { id: 'dynamic-app', label: 'Canvas' },
  { id: 'status', label: 'Status' },
  { id: 'workspace', label: 'Workspace' },
  { id: 'skills', label: 'Skills' },
  { id: 'mcp-servers', label: 'MCP Servers' },
  { id: 'channels', label: 'Channels' },
  { id: 'analytics', label: 'Analytics' },
  { id: 'logs', label: 'Logs' },
]

export interface ProjectSwitcherItem {
  id: string
  name: string
  type?: string
}

export interface ProjectTopBarProps {
  projectName: string
  projectId: string
  projectType?: string
  projects?: ProjectSwitcherItem[]
  showChatSessions?: boolean
  isChatCollapsed?: boolean
  onChatSessionsToggle?: () => void
  onChatCollapseToggle?: () => void
  activeTab?: string
  onTabChange?: (tabId: string) => void
  onProjectSwitch?: (projectId: string) => void
  hasActiveSubscription?: boolean
}

export function ProjectTopBar({
  projectName,
  projectId,
  projectType = 'AGENT',
  projects = [],
  showChatSessions = false,
  isChatCollapsed = false,
  onChatSessionsToggle,
  onChatCollapseToggle,
  activeTab = 'dynamic-app',
  onTabChange,
  onProjectSwitch,
  hasActiveSubscription = false,
}: ProjectTopBarProps) {
  const router = useRouter()
  const { width } = useWindowDimensions()
  const isWide = width >= 768
  const [showPublish, setShowPublish] = useState(false)
  const [showProjectSwitcher, setShowProjectSwitcher] = useState(false)

  const handleBack = useCallback(() => {
    router.push('/(app)' as any)
  }, [router])

  const handleProjectSelect = useCallback((selectedId: string) => {
    setShowProjectSwitcher(false)
    if (selectedId === projectId) return
    if (onProjectSwitch) {
      onProjectSwitch(selectedId)
    } else {
      router.push(`/(app)/projects/${selectedId}` as any)
    }
  }, [projectId, onProjectSwitch, router])

  const typeLabel = projectType === 'AGENT' ? 'Agent project' : 'App project'

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

        <Pressable
          onPress={() => setShowProjectSwitcher(true)}
          className="flex-row items-center gap-1.5 px-1.5 py-1 rounded-md active:bg-muted max-w-[200px]"
        >
          <View>
            <Text className="text-sm font-semibold text-foreground" numberOfLines={1}>
              {projectName}
            </Text>
            <Text className="text-[10px] text-muted-foreground">{typeLabel}</Text>
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
        <Pressable
          onPress={() => router.push({ pathname: '/(app)/settings', params: { tab: 'github' } } as any)}
          className="h-8 w-8 items-center justify-center rounded-md active:bg-muted"
        >
          <Github size={16} className="text-muted-foreground" />
        </Pressable>

        {!hasActiveSubscription && (
          <Pressable
            onPress={() => router.push('/(app)/billing' as any)}
            className="h-8 flex-row items-center gap-1.5 px-2.5 rounded-md border border-border active:bg-muted"
          >
            <Zap size={14} className="text-muted-foreground" />
            <Text className="text-xs font-medium text-foreground">Upgrade</Text>
          </Pressable>
        )}

        <Pressable
          onPress={() => setShowPublish(true)}
          className="h-8 flex-row items-center px-3 rounded-md bg-primary active:bg-primary/80"
        >
          <Text className="text-xs font-medium text-primary-foreground">Publish</Text>
        </Pressable>
      </View>

      <PublishDropdown
        projectId={projectId}
        projectName={projectName}
        visible={showPublish}
        onClose={() => setShowPublish(false)}
      />

      <ProjectSwitcherModal
        visible={showProjectSwitcher}
        onClose={() => setShowProjectSwitcher(false)}
        projects={projects}
        currentProjectId={projectId}
        onSelect={handleProjectSelect}
        onGoToDashboard={handleBack}
      />
    </View>
  )
}

function ProjectSwitcherModal({
  visible,
  onClose,
  projects,
  currentProjectId,
  onSelect,
  onGoToDashboard,
}: {
  visible: boolean
  onClose: () => void
  projects: ProjectSwitcherItem[]
  currentProjectId: string
  onSelect: (projectId: string) => void
  onGoToDashboard: () => void
}) {
  const [search, setSearch] = useState('')
  const inputRef = useRef<TextInput>(null)

  useEffect(() => {
    if (visible) {
      setSearch('')
      const timer = setTimeout(() => inputRef.current?.focus(), 100)
      return () => clearTimeout(timer)
    }
  }, [visible])

  const filtered = search.trim()
    ? projects.filter((p) => p.name.toLowerCase().includes(search.toLowerCase()))
    : projects

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable className="flex-1 bg-black/50" onPress={onClose}>
        <Pressable
          className="bg-card rounded-xl border border-border mx-4 mt-14 overflow-hidden"
          style={{ maxWidth: 320, alignSelf: 'flex-start', marginLeft: 48 }}
          onPress={(e) => e.stopPropagation()}
        >
          {/* Go to Dashboard */}
          <Pressable
            onPress={() => { onClose(); onGoToDashboard() }}
            className="flex-row items-center gap-2.5 px-3 py-2.5 active:bg-muted border-b border-border"
          >
            <ChevronLeft size={16} className="text-muted-foreground" />
            <Text className="text-sm font-medium text-foreground">Go to Dashboard</Text>
          </Pressable>

          {/* Search */}
          <View className="flex-row items-center gap-2 px-3 py-2 border-b border-border">
            <Search size={14} className="text-muted-foreground" />
            <TextInput
              ref={inputRef}
              value={search}
              onChangeText={setSearch}
              placeholder="Search projects..."
              placeholderTextColor="#9ca3af"
              className="flex-1 text-sm text-foreground py-1"
              style={Platform.OS === 'web' ? { outlineStyle: 'none' } as any : undefined}
              autoCapitalize="none"
              autoCorrect={false}
            />
          </View>

          {/* Switch project heading */}
          <View className="px-3 pt-2 pb-1">
            <Text className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              Switch project
            </Text>
          </View>

          {/* Project list */}
          <ScrollView
            style={{ maxHeight: 280 }}
            showsVerticalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
          >
            {filtered.length === 0 ? (
              <View className="px-4 py-6 items-center">
                <Text className="text-sm text-muted-foreground">
                  {search.trim() ? 'No projects match your search' : 'No projects available'}
                </Text>
              </View>
            ) : (
              <View className="py-1">
                {filtered.map((project) => {
                  const isCurrent = project.id === currentProjectId
                  const isAgent = project.type === 'AGENT'
                  const TypeIcon = isAgent ? Bot : AppWindow
                  return (
                    <Pressable
                      key={project.id}
                      onPress={() => onSelect(project.id)}
                      className={cn(
                        'flex-row items-center gap-2.5 px-3 py-2 active:bg-muted',
                        isCurrent && 'bg-accent/50',
                      )}
                    >
                      <View className={cn(
                        'h-7 w-7 rounded-md items-center justify-center',
                        isAgent ? 'bg-primary/10' : 'bg-emerald-500/10',
                      )}>
                        <TypeIcon
                          size={14}
                          className={isAgent ? 'text-primary' : 'text-emerald-600'}
                        />
                      </View>
                      <View className="flex-1 min-w-0">
                        <Text className="text-sm text-foreground" numberOfLines={1}>
                          {project.name}
                        </Text>
                        <Text className="text-[10px] text-muted-foreground">
                          {isAgent ? 'Agent' : 'App'}
                        </Text>
                      </View>
                      {isCurrent && (
                        <Check size={16} className="text-primary" />
                      )}
                    </Pressable>
                  )
                })}
              </View>
            )}
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  )
}
