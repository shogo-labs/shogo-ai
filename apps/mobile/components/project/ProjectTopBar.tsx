// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * ProjectTopBar - Full-width navigation bar for the project detail view.
 *
 * Lovable-style top bar with a two-panel dropdown:
 *   Panel 1 (Menu): Workspace info, credits, action items (settings, rename, star, etc.)
 *   Panel 2 (Switcher): Search + project list for quick project switching
 *
 * Layout:
 *  - Left: Back button, project name + subtitle dropdown, chat history toggle, chat collapse toggle
 *  - Center: Tab buttons (Canvas, Status, Workspace, Skills, Tools, Channels, Analytics, Logs)
 *  - Right: GitHub icon (app only), Upgrade button, Publish button (app only)
 */

import { useCallback, useState } from 'react'
import {
  View,
  Text,
  Pressable,
  useWindowDimensions,
  ScrollView,
  TextInput,
  Platform,
  Modal,
} from 'react-native'
import {
  Popover,
  PopoverBackdrop,
  PopoverBody,
  PopoverContent,
} from '@/components/ui/popover'
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
  ChevronRight,
  Check,
  Search,
  Bot,
  AppWindow,
  Settings,
  Pencil,
  Star,
  FolderInput,
  Info,
  SunMoon,
  MoreHorizontal,
  X,
} from 'lucide-react-native'
import { cn, Badge, Progress } from '@shogo/shared-ui/primitives'
import { useTheme, type ThemePreference } from '../../contexts/theme'
import { formatCredits } from '../../lib/billing-config'
import { PublishDropdown } from './PublishDropdown'
import { usePlatformConfig } from '../../lib/platform-config'

const AGENT_TABS = [
  { id: 'chat-fullscreen', label: 'Chat' },
  { id: 'dynamic-app', label: 'Canvas' },
  { id: 'app-preview', label: 'App' },
  { id: 'files', label: 'Files' },
  { id: 'capabilities', label: 'Capabilities' },
  { id: 'channels', label: 'Channels' },
  { id: 'monitor', label: 'Monitor' },
]

export interface ProjectSwitcherItem {
  id: string
  name: string
}

export interface ProjectTopBarProps {
  projectName: string
  projectId: string
  projects?: ProjectSwitcherItem[]
  showChatSessions?: boolean
  isChatCollapsed?: boolean
  onChatSessionsToggle?: () => void
  onChatCollapseToggle?: () => void
  activeTab?: string
  onTabChange?: (tabId: string) => void
  onProjectSwitch?: (projectId: string) => void
  hasActiveSubscription?: boolean
  workspaceName?: string
  planLabel?: string
  creditsRemaining?: number
  creditsTotal?: number
  ownerName?: string
  projectCreatedAt?: string | number
  projectModifiedAt?: string | number
  isStarred?: boolean
  onRenameProject?: (newName: string) => void
  onToggleStar?: () => void
  onMoveToFolder?: (folderId: string | null) => void
  folders?: { id: string; name: string }[]
  /** Tab IDs to hide from the tab bar (e.g. ['dynamic-app'] to hide Canvas) */
  hiddenTabs?: string[]
  /** When false, replaces the Canvas tab with a full-screen Chat tab */
  canvasEnabled?: boolean
  /** Active agent mode — controls which visual tabs are shown */
  activeMode?: 'none' | 'canvas' | 'app'
  /** Narrow-screen: which main panel is visible (chat or canvas) */
  narrowActiveTab?: 'chat' | 'canvas'
  /** Narrow-screen: callback when main panel changes */
  onNarrowTabChange?: (tab: 'chat' | 'canvas') => void
  /** Narrow-screen: which sub-panel is showing in the canvas area */
  narrowPreviewTab?: string
}

export function ProjectTopBar({
  projectName,
  projectId,
  projects = [],
  showChatSessions = false,
  isChatCollapsed = false,
  onChatSessionsToggle,
  onChatCollapseToggle,
  activeTab = 'dynamic-app',
  onTabChange,
  onProjectSwitch,
  hasActiveSubscription = false,
  workspaceName = '',
  planLabel = 'Free',
  creditsRemaining = 5,
  creditsTotal = 5,
  ownerName = '',
  projectCreatedAt,
  projectModifiedAt,
  isStarred = false,
  onRenameProject,
  onToggleStar,
  onMoveToFolder,
  folders = [],
  hiddenTabs = [],
  canvasEnabled = true,
  activeMode = 'canvas',
  narrowActiveTab,
  onNarrowTabChange,
  narrowPreviewTab,
}: ProjectTopBarProps) {
  const router = useRouter()
  const { width } = useWindowDimensions()
  const isWide = width >= 768
  const [showDropdown, setShowDropdown] = useState(false)
  const [dropdownKey, setDropdownKey] = useState(0)
  const [showNarrowMore, setShowNarrowMore] = useState(false)

  const isChatFullscreen = !canvasEnabled && activeTab === 'chat-fullscreen'

  const handleBack = useCallback(() => {
    router.push('/(app)' as any)
  }, [router])

  const handleProjectSelect = useCallback((selectedId: string) => {
    setShowDropdown(false)
    if (selectedId === projectId) return
    if (onProjectSwitch) {
      onProjectSwitch(selectedId)
    } else {
      router.push(`/(app)/projects/${selectedId}` as any)
    }
  }, [projectId, onProjectSwitch, router])

  const typeLabel = 'Project'

  // App mode sets canvasEnabled false — still need Files/Capabilities/etc. on narrow screens.
  const narrowMoreItems = [
    ...(canvasEnabled || activeMode === 'app' || activeMode === 'none'
      ? [
          { id: 'files', label: 'Files' },
          { id: 'capabilities', label: 'Capabilities' },
          { id: 'channels', label: 'Channels' },
          { id: 'monitor', label: 'Monitor' },
        ]
      : []),
    ...(!hasActiveSubscription ? [{ id: '_upgrade', label: 'Upgrade' }] : []),
  ]

  return (
    <View
      className="h-12 bg-background/95 flex-row items-center justify-between px-3 border-b border-border web:sticky web:top-0"
      style={
        Platform.OS === 'web'
          ? ({ zIndex: 1000, isolation: 'isolate' as const } as const)
          : { elevation: 12 }
      }
    >
      {/* Left: Back + project name */}
      <View className="flex-row items-center gap-1 flex-shrink-0">
        <Pressable
          onPress={handleBack}
          className="h-7 w-7 items-center justify-center rounded-md active:bg-muted"
        >
          <ArrowLeft size={14} className="text-muted-foreground" />
        </Pressable>

        <Popover
          placement="bottom"
          size="md"
          isOpen={showDropdown}
          onOpen={() => { setShowDropdown(true); setDropdownKey((k) => k + 1) }}
          onClose={() => setShowDropdown(false)}
          trigger={(triggerProps) => (
            <Pressable
              {...triggerProps}
              className={cn(
                'flex-row items-center gap-1.5 px-1.5 py-1 rounded-md active:bg-muted',
                isWide ? 'max-w-[200px]' : 'max-w-[140px]',
              )}
            >
              <View className="flex-shrink min-w-0">
                <Text className="text-sm font-semibold text-foreground" numberOfLines={1}>
                  {projectName}
                </Text>
                {isWide && (
                  <Text className="text-[10px] text-muted-foreground">{typeLabel}</Text>
                )}
              </View>
              <ChevronDown size={12} className="text-muted-foreground flex-shrink-0" />
            </Pressable>
          )}
        >
          <PopoverBackdrop />
          <PopoverContent className="max-w-[340px] w-[320px] p-0">
            <PopoverBody>
              <ProjectDropdownContent
                key={dropdownKey}
                projects={projects}
                currentProjectId={projectId}
                projectName={projectName}
                onSelect={handleProjectSelect}
                onGoToDashboard={handleBack}
                onClose={() => setShowDropdown(false)}
                workspaceName={workspaceName}
                planLabel={planLabel}
                creditsRemaining={creditsRemaining}
                creditsTotal={creditsTotal}
                ownerName={ownerName}
                projectCreatedAt={projectCreatedAt}
                projectModifiedAt={projectModifiedAt}
                isStarred={isStarred}
                onRenameProject={onRenameProject}
                onToggleStar={onToggleStar}
                onMoveToFolder={onMoveToFolder}
                folders={folders}
              />
            </PopoverBody>
          </PopoverContent>
        </Popover>
      </View>

      {/* Center: Narrow segmented control OR wide tab buttons */}
      {!isWide && onNarrowTabChange ? (
        <View className="flex-row items-center bg-muted rounded-lg p-0.5 mx-2">
          {(activeMode === 'none'
            ? [{ key: 'chat', label: 'Chat', tabId: undefined }] as const
            : activeMode === 'app'
              ? [{ key: 'chat', label: 'Chat', tabId: undefined }, { key: 'canvas', label: 'App', tabId: 'app-preview' }] as const
              : [{ key: 'chat', label: 'Chat', tabId: undefined }, { key: 'canvas', label: 'Canvas', tabId: 'dynamic-app' }] as const
          ).map((tab) => {
            const isActive = narrowActiveTab === tab.key
            return (
              <Pressable
                key={tab.key}
                onPress={() => {
                  onNarrowTabChange(tab.key as 'chat' | 'canvas')
                  if (tab.tabId) onTabChange?.(tab.tabId)
                }}
                className={cn(
                  'px-3 py-1 rounded-md',
                  isActive && 'bg-background shadow-sm',
                )}
              >
                <Text
                  className={cn(
                    'text-xs font-medium',
                    isActive ? 'text-foreground' : 'text-muted-foreground',
                  )}
                >
                  {tab.label}
                </Text>
              </Pressable>
            )
          })}
        </View>
      ) : isWide ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerClassName="flex-row items-center gap-0.5"
          className="flex-shrink mx-2"
          accessibilityRole="tablist"
        >
          {AGENT_TABS
            .filter((tab) => !hiddenTabs.includes(tab.id))
            .map((tab) => (
            <Pressable
              key={tab.id}
              onPress={() => onTabChange?.(tab.id)}
              accessibilityRole="tab"
              accessibilityState={{ selected: activeTab === tab.id }}
              aria-selected={activeTab === tab.id}
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
      ) : null}

      {/* Right actions */}
      <View className="flex-row items-center gap-1.5 flex-shrink-0">
        {/* Narrow: overflow menu for secondary panels + upgrade */}
        {!isWide && narrowMoreItems.length > 0 && (
          <Popover
            placement="bottom right"
            isOpen={showNarrowMore}
            onOpen={() => setShowNarrowMore(true)}
            onClose={() => setShowNarrowMore(false)}
            trigger={(triggerProps) => (
              <Pressable
                {...triggerProps}
                className={cn(
                  'h-8 w-8 items-center justify-center rounded-md',
                  showNarrowMore ? 'bg-muted' : 'active:bg-muted',
                )}
              >
                <MoreHorizontal size={16} className="text-muted-foreground" />
              </Pressable>
            )}
          >
            <PopoverBackdrop />
            <PopoverContent className="min-w-[180px] p-0">
              <PopoverBody>
                {narrowMoreItems.map((item) => (
                  <Pressable
                    key={item.id}
                    onPress={() => {
                      if (item.id === '_upgrade') {
                        router.push('/(app)/billing' as any)
                      } else {
                        onNarrowTabChange?.('canvas')
                        onTabChange?.(item.id)
                      }
                      setShowNarrowMore(false)
                    }}
                    className={cn(
                      'px-4 py-3 active:bg-muted',
                      narrowPreviewTab === item.id && narrowActiveTab === 'canvas' && 'bg-accent',
                    )}
                  >
                    <View className="flex-row items-center gap-2.5">
                      {item.id === '_upgrade' && <Zap size={14} className="text-muted-foreground" />}
                      <Text
                        className={cn(
                          'text-sm',
                          narrowPreviewTab === item.id && narrowActiveTab === 'canvas'
                            ? 'text-foreground font-medium'
                            : 'text-foreground',
                        )}
                      >
                        {item.label}
                      </Text>
                    </View>
                  </Pressable>
                ))}
              </PopoverBody>
            </PopoverContent>
          </Popover>
        )}

        {/* Wide: show full buttons */}
        {isWide && (
          <>
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
          </>
        )}
      </View>
    </View>
  )
}

// ---------------------------------------------------------------------------
// Lovable-style two-panel dropdown (Menu + Project Switcher)
// ---------------------------------------------------------------------------

type DropdownView = 'menu' | 'switcher'

function ProjectDropdownContent({
  projects,
  currentProjectId,
  projectName,
  onSelect,
  onGoToDashboard,
  onClose,
  workspaceName,
  planLabel,
  creditsRemaining,
  creditsTotal,
  ownerName,
  projectCreatedAt,
  projectModifiedAt,
  isStarred,
  onRenameProject,
  onToggleStar,
  onMoveToFolder,
  folders,
}: {
  projects: ProjectSwitcherItem[]
  currentProjectId: string
  projectName: string
  onSelect: (projectId: string) => void
  onGoToDashboard: () => void
  onClose: () => void
  workspaceName: string
  planLabel: string
  creditsRemaining: number
  creditsTotal: number
  ownerName: string
  projectCreatedAt?: string | number
  projectModifiedAt?: string | number
  isStarred: boolean
  onRenameProject?: (newName: string) => void
  onToggleStar?: () => void
  onMoveToFolder?: (folderId: string | null) => void
  folders: { id: string; name: string }[]
}) {
  const [view, setView] = useState<DropdownView>('menu')
  const router = useRouter()

  if (view === 'switcher') {
    return (
      <ProjectSwitcherView
        projects={projects}
        currentProjectId={currentProjectId}
        onSelect={onSelect}
        onGoToDashboard={onGoToDashboard}
        onBack={() => setView('menu')}
      />
    )
  }

  return (
    <ProjectMenuView
      projectName={projectName}
      workspaceName={workspaceName}
      planLabel={planLabel}
      creditsRemaining={creditsRemaining}
      creditsTotal={creditsTotal}
      onGoToDashboard={onGoToDashboard}
      onSwitchProject={() => setView('switcher')}
      onClose={onClose}
      router={router}
      ownerName={ownerName}
      projectCreatedAt={projectCreatedAt}
      projectModifiedAt={projectModifiedAt}
      isStarred={isStarred}
      onRenameProject={onRenameProject}
      onToggleStar={onToggleStar}
      onMoveToFolder={onMoveToFolder}
      folders={folders}
    />
  )
}

// ---------------------------------------------------------------------------
// Panel 1: Main Menu (Lovable Screenshot 1)
// ---------------------------------------------------------------------------

function ProjectMenuView({
  projectName,
  workspaceName,
  planLabel,
  creditsRemaining,
  creditsTotal,
  onGoToDashboard,
  onSwitchProject,
  onClose,
  router,
  ownerName,
  projectCreatedAt,
  projectModifiedAt,
  isStarred,
  onRenameProject,
  onToggleStar,
  onMoveToFolder,
  folders,
}: {
  projectName: string
  workspaceName: string
  planLabel: string
  creditsRemaining: number
  creditsTotal: number
  onGoToDashboard: () => void
  onSwitchProject: () => void
  onClose: () => void
  router: any
  ownerName: string
  projectCreatedAt?: string | number
  projectModifiedAt?: string | number
  isStarred: boolean
  onRenameProject?: (newName: string) => void
  onToggleStar?: () => void
  onMoveToFolder?: (folderId: string | null) => void
  folders: { id: string; name: string }[]
}) {
  const [showDetailsModal, setShowDetailsModal] = useState(false)
  const [showRenameModal, setShowRenameModal] = useState(false)
  const [showMoveModal, setShowMoveModal] = useState(false)
  const { features } = usePlatformConfig()
  const showBilling = features.billing
  const creditsPercent = creditsTotal > 0 ? (creditsRemaining / creditsTotal) * 100 : 0

  const menuItems: {
    icon: React.ElementType
    label: string
    onPress: () => void
    trailing?: React.ReactNode
  }[] = [
    {
      icon: Settings,
      label: 'Settings',
      onPress: () => { onClose(); router.push('/(app)/settings' as any) },
      trailing: (
        <Text className="text-[11px] text-muted-foreground font-mono">
          {Platform.OS === 'web' ? '\u2318.' : ''}
        </Text>
      ),
    },
    {
      icon: Pencil,
      label: 'Rename project',
      onPress: () => { setShowRenameModal(true) },
    },
    {
      icon: Star,
      label: isStarred ? 'Unstar project' : 'Star project',
      onPress: () => { onToggleStar?.(); onClose() },
    },
    {
      icon: FolderInput,
      label: 'Move to folder',
      onPress: () => { setShowMoveModal(true) },
    },
    {
      icon: Info,
      label: 'Details',
      onPress: () => { setShowDetailsModal(true) },
    },
  ]

  return (
    <>
      <ScrollView
        className="max-h-[480px]"
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        bounces={false}
      >
        {/* Go to Dashboard */}
        <Pressable
          onPress={onGoToDashboard}
          className="flex-row items-center gap-2 px-4 py-3 active:bg-muted border-b border-border"
        >
          <ChevronLeft size={16} className="text-muted-foreground" />
          <Text className="text-sm font-medium text-foreground">Go to Dashboard</Text>
        </Pressable>

        {/* Workspace info + plan badge */}
        <Pressable
          onPress={onSwitchProject}
          className="px-4 py-3 active:bg-muted"
        >
          <View className="flex-row items-center gap-2.5">
            <View className="h-8 w-8 rounded-lg bg-primary items-center justify-center">
              <Text className="text-xs font-bold text-primary-foreground">
                {(workspaceName || 'W')[0]?.toUpperCase()}
              </Text>
            </View>
            <View className="flex-1 min-w-0">
              <View className="flex-row items-center gap-2">
                <Text className="text-sm font-semibold text-foreground" numberOfLines={1}>
                  {workspaceName || 'Workspace'}
                </Text>
                {showBilling && (
                  <Badge variant="secondary" className="px-1.5 py-0">
                    <Text className="text-[10px] font-semibold text-secondary-foreground uppercase">
                      {planLabel}
                    </Text>
                  </Badge>
                )}
              </View>
            </View>
          </View>
        </Pressable>

        {showBilling && (
          <View className="px-4 pb-3">
            <View className="bg-card border border-border rounded-lg p-3 gap-2">
              <View className="flex-row items-center justify-between">
                <Text className="text-sm font-medium text-foreground">Credits</Text>
                <Pressable
                  onPress={() => { onClose(); router.push({ pathname: '/(app)/settings', params: { tab: 'billing' } } as any) }}
                  className="flex-row items-center gap-1"
                >
                  <Text className="text-sm font-medium text-foreground">
                    {formatCredits(creditsRemaining)} left
                  </Text>
                  <ChevronRight size={14} className="text-muted-foreground" />
                </Pressable>
              </View>
              <Progress
                value={creditsPercent}
                className="h-1.5"
              />
              <View className="flex-row items-center gap-1.5">
                <View className="h-1.5 w-1.5 rounded-full bg-muted-foreground" />
                <Text className="text-xs text-muted-foreground">
                  Daily credits reset at midnight UTC
                </Text>
              </View>
            </View>
          </View>
        )}

        {/* Divider */}
        <View className="h-px bg-border mx-3 my-1" />

        {/* Menu items */}
        {menuItems.map((item) => {
          const Icon = item.icon
          return (
            <Pressable
              key={item.label}
              onPress={item.onPress}
              className="flex-row items-center gap-3 px-4 py-2.5 active:bg-muted"
            >
              <Icon size={16} className="text-muted-foreground" />
              <Text className="text-sm text-foreground flex-1">{item.label}</Text>
              {item.trailing}
            </Pressable>
          )
        })}

        {/* Divider */}
        <View className="h-px bg-border mx-3 my-1" />

        {/* Appearance */}
        <AppearanceMenu />
      </ScrollView>

      {/* Project Details Modal */}
      <ProjectDetailsModal
        visible={showDetailsModal}
        onClose={() => setShowDetailsModal(false)}
        projectName={projectName}
        workspaceName={workspaceName}
        ownerName={ownerName}
        createdAt={projectCreatedAt}
        modifiedAt={projectModifiedAt}
      />

      {/* Rename Project Modal */}
      <RenameProjectModal
        visible={showRenameModal}
        currentName={projectName}
        onClose={() => setShowRenameModal(false)}
        onRename={(newName) => {
          onRenameProject?.(newName)
          setShowRenameModal(false)
          onClose()
        }}
      />

      {/* Move to Folder Modal */}
      <MoveToFolderModal
        visible={showMoveModal}
        folders={folders}
        onClose={() => setShowMoveModal(false)}
        onMove={(folderId) => {
          onMoveToFolder?.(folderId)
          setShowMoveModal(false)
          onClose()
        }}
      />
    </>
  )
}

// ---------------------------------------------------------------------------
// Rename Project Modal
// ---------------------------------------------------------------------------

function RenameProjectModal({
  visible,
  currentName,
  onClose,
  onRename,
}: {
  visible: boolean
  currentName: string
  onClose: () => void
  onRename: (newName: string) => void
}) {
  const [name, setName] = useState(currentName)

  const handleClose = () => {
    setName(currentName)
    onClose()
  }

  const canSubmit = name.trim().length > 0 && name.trim() !== currentName

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={handleClose}>
      <Pressable onPress={handleClose} className="flex-1 bg-black/50 items-center justify-center px-6">
        <Pressable onPress={(e) => e.stopPropagation()} className="bg-background rounded-xl w-full max-w-sm shadow-xl overflow-hidden">
          <View className="flex-row items-center justify-between px-5 pt-5 pb-3">
            <Text className="text-base font-semibold text-foreground">Rename project</Text>
            <Pressable onPress={handleClose} className="p-1 -mr-1 rounded-md active:bg-muted">
              <X size={18} className="text-muted-foreground" />
            </Pressable>
          </View>
          <View className="px-5 pb-4">
            <TextInput
              value={name}
              onChangeText={setName}
              placeholder="Project name"
              placeholderTextColor="#9ca3af"
              className="border border-border rounded-lg px-3 py-2.5 text-sm text-foreground web:outline-none"
              autoFocus
              selectTextOnFocus
            />
          </View>
          <View className="px-5 pb-5 flex-row justify-end gap-2">
            <Pressable onPress={handleClose} className="px-4 py-2 rounded-lg border border-border active:bg-muted">
              <Text className="text-sm font-medium text-foreground">Cancel</Text>
            </Pressable>
            <Pressable
              onPress={() => canSubmit && onRename(name.trim())}
              className={cn('px-4 py-2 rounded-lg', canSubmit ? 'bg-primary active:opacity-80' : 'bg-muted')}
            >
              <Text className={cn('text-sm font-medium', canSubmit ? 'text-primary-foreground' : 'text-muted-foreground')}>
                Rename
              </Text>
            </Pressable>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  )
}

// ---------------------------------------------------------------------------
// Move to Folder Modal
// ---------------------------------------------------------------------------

function MoveToFolderModal({
  visible,
  folders,
  onClose,
  onMove,
}: {
  visible: boolean
  folders: { id: string; name: string }[]
  onClose: () => void
  onMove: (folderId: string | null) => void
}) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable onPress={onClose} className="flex-1 bg-black/50 items-center justify-center px-6">
        <Pressable onPress={(e) => e.stopPropagation()} className="bg-background rounded-xl w-full max-w-sm shadow-xl overflow-hidden">
          <View className="flex-row items-center justify-between px-5 pt-5 pb-3">
            <Text className="text-base font-semibold text-foreground">Move to folder</Text>
            <Pressable onPress={onClose} className="p-1 -mr-1 rounded-md active:bg-muted">
              <X size={18} className="text-muted-foreground" />
            </Pressable>
          </View>
          <ScrollView className="max-h-[240px] px-5 pb-2">
            <Pressable
              onPress={() => onMove(null)}
              className="flex-row items-center gap-3 px-3 py-3 rounded-lg active:bg-muted border border-border mb-2"
            >
              <FolderInput size={16} className="text-muted-foreground" />
              <Text className="text-sm text-foreground">Root (no folder)</Text>
            </Pressable>
            {folders.map((folder) => (
              <Pressable
                key={folder.id}
                onPress={() => onMove(folder.id)}
                className="flex-row items-center gap-3 px-3 py-3 rounded-lg active:bg-muted border border-border mb-2"
              >
                <FolderInput size={16} className="text-muted-foreground" />
                <Text className="text-sm text-foreground">{folder.name}</Text>
              </Pressable>
            ))}
            {folders.length === 0 && (
              <View className="py-6 items-center">
                <Text className="text-sm text-muted-foreground">No folders yet</Text>
              </View>
            )}
          </ScrollView>
          <View className="px-5 pt-2 pb-5 flex-row justify-end">
            <Pressable onPress={onClose} className="px-4 py-2 rounded-lg border border-border active:bg-muted">
              <Text className="text-sm font-medium text-foreground">Cancel</Text>
            </Pressable>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  )
}

// ---------------------------------------------------------------------------
// Appearance submenu — Popover adjacent to the Appearance row
// ---------------------------------------------------------------------------

const THEME_OPTIONS: { value: ThemePreference; label: string }[] = [
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
  { value: 'system', label: 'System' },
]

function AppearanceMenu() {
  const { theme, setTheme } = useTheme()
  const [open, setOpen] = useState(false)

  return (
    <Popover
      placement="right"
      isOpen={open}
      onOpen={() => setOpen(true)}
      onClose={() => setOpen(false)}
      trigger={(triggerProps) => (
        <Pressable
          {...triggerProps}
          className="flex-row items-center gap-3 px-4 py-2.5 active:bg-muted"
        >
          <SunMoon size={16} className="text-muted-foreground" />
          <Text className="text-sm text-foreground flex-1">Appearance</Text>
          <ChevronRight size={14} className="text-muted-foreground" />
        </Pressable>
      )}
    >
      <PopoverBackdrop />
      <PopoverContent className="min-w-[160px] p-0">
        <PopoverBody>
          {THEME_OPTIONS.map(({ value, label }) => (
            <Pressable
              key={value}
              onPress={() => { setTheme(value); setOpen(false) }}
              className="flex-row items-center gap-3 px-4 py-3 active:bg-muted"
            >
              <Text
                className={cn(
                  'text-sm flex-1',
                  theme === value ? 'text-foreground font-medium' : 'text-foreground',
                )}
              >
                {label}
              </Text>
              {theme === value && <Check size={16} className="text-foreground" />}
            </Pressable>
          ))}
        </PopoverBody>
      </PopoverContent>
    </Popover>
  )
}

// ---------------------------------------------------------------------------
// Project Details Modal (Lovable-style)
// ---------------------------------------------------------------------------

function ProjectDetailsModal({
  visible,
  onClose,
  projectName,
  workspaceName,
  ownerName,
  createdAt,
  modifiedAt,
}: {
  visible: boolean
  onClose: () => void
  projectName: string
  workspaceName: string
  ownerName: string
  createdAt?: string | number
  modifiedAt?: string | number
}) {
  const formatDate = (d?: string | number) => {
    if (!d) return '—'
    const date = new Date(d)
    return date.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    })
  }

  const rows: { label: string; value: string }[] = [
    { label: 'Location', value: projectName },
    { label: 'Owner', value: ownerName || workspaceName || '—' },
    { label: 'Modified', value: formatDate(modifiedAt) },
    { label: 'Created', value: formatDate(createdAt) },
  ]

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable
        onPress={onClose}
        className="flex-1 bg-black/50 items-center justify-center px-6"
      >
        <Pressable
          onPress={(e) => e.stopPropagation()}
          className="bg-background rounded-xl w-full max-w-sm shadow-xl overflow-hidden"
        >
          {/* Header */}
          <View className="flex-row items-center justify-between px-5 pt-5 pb-3">
            <Text className="text-base font-semibold text-foreground">Project details</Text>
            <Pressable onPress={onClose} className="p-1 -mr-1 rounded-md active:bg-muted">
              <X size={18} className="text-muted-foreground" />
            </Pressable>
          </View>

          {/* Detail rows */}
          <View className="px-5 pb-2">
            <View className="border border-border rounded-lg overflow-hidden">
              {rows.map((row, idx) => (
                <View
                  key={row.label}
                  className={cn(
                    'flex-row items-center px-4 py-3',
                    idx < rows.length - 1 && 'border-b border-border',
                  )}
                >
                  <Text className="text-sm text-muted-foreground w-24">{row.label}</Text>
                  <Text className="text-sm text-foreground flex-1" numberOfLines={1}>
                    {row.value}
                  </Text>
                </View>
              ))}
            </View>
          </View>

          {/* Footer */}
          <View className="px-5 pt-2 pb-5 flex-row justify-end">
            <Pressable
              onPress={onClose}
              className="px-5 py-2 rounded-lg border border-border active:bg-muted"
            >
              <Text className="text-sm font-medium text-foreground">Close</Text>
            </Pressable>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  )
}

// ---------------------------------------------------------------------------
// Panel 2: Project Switcher (Lovable Screenshot 2)
// ---------------------------------------------------------------------------

function ProjectSwitcherView({
  projects,
  currentProjectId,
  onSelect,
  onGoToDashboard,
  onBack,
}: {
  projects: ProjectSwitcherItem[]
  currentProjectId: string
  onSelect: (projectId: string) => void
  onGoToDashboard: () => void
  onBack: () => void
}) {
  const [search, setSearch] = useState('')

  const filtered = search.trim()
    ? projects.filter((p) => p.name.toLowerCase().includes(search.toLowerCase()))
    : projects

  return (
    <>
      {/* Back to menu + Go to Dashboard */}
      <View className="flex-row items-center justify-between px-3 py-2.5 border-b border-border">
        <Pressable
          onPress={onBack}
          className="flex-row items-center gap-1 active:bg-muted rounded-md px-1 py-0.5"
        >
          <ChevronLeft size={16} className="text-muted-foreground" />
          <Text className="text-sm font-medium text-foreground">Back</Text>
        </Pressable>
        <Pressable
          onPress={onGoToDashboard}
          className="flex-row items-center gap-1 active:bg-muted rounded-md px-1 py-0.5"
        >
          <Text className="text-sm text-muted-foreground">Dashboard</Text>
        </Pressable>
      </View>

      {/* Search */}
      <View className="flex-row items-center gap-2 px-3 py-2 border-b border-border">
        <Search size={14} className="text-muted-foreground" />
        <TextInput
          value={search}
          onChangeText={setSearch}
          placeholder="Search projects..."
          placeholderTextColor="#9ca3af"
          className="flex-1 text-sm text-foreground py-1 web:outline-none"
          autoCapitalize="none"
          autoCorrect={false}
        />
      </View>

      {/* Switch project heading */}
      <View className="px-3 pt-3 pb-1.5">
        <Text className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          Switch project
        </Text>
      </View>

      {/* Project list */}
      <ScrollView
        className="max-h-[320px]"
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
              return (
                <Pressable
                  key={project.id}
                  onPress={() => onSelect(project.id)}
                  className={cn(
                    'flex-row items-center gap-2.5 px-3 py-2.5 active:bg-muted',
                    isCurrent && 'bg-accent/50',
                  )}
                >
                  <View className={cn(
                    'h-8 w-8 rounded-md items-center justify-center',
                    'bg-primary/10',
                  )}>
                    <Bot
                      size={15}
                      className="text-primary"
                    />
                  </View>
                  <View className="flex-1 min-w-0">
                    <Text className="text-sm text-foreground" numberOfLines={1}>
                      {project.name}
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
    </>
  )
}
