// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * ProjectTopBar - Unified navigation bar for the project detail view.
 *
 * Single compact top bar with icon-only navigation, context-dependent controls,
 * and chat panel controls. Consolidates the previous multi-bar setup (ProjectTopBar
 * + chat toolbar + EditToolbar) into one.
 */

import React, { useCallback, useState } from 'react'
import {
  View,
  Text,
  Pressable,
  useWindowDimensions,
  ScrollView,
  TextInput,
  Platform,
  Modal,
  type StyleProp,
  type ViewStyle,
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
  MessageSquare,
  LayoutDashboard,
  FolderOpen,
  Sliders,
  Radio,
  Activity,
  Eye,
  ListTree,
  Plus,
  Trash2,
  Terminal,
  ClipboardList,
} from 'lucide-react-native'
import { cn, Badge, Progress } from '@shogo/shared-ui/primitives'
import { Tooltip, TooltipContent, TooltipText } from '@/components/ui/tooltip'
import { useTheme, type ThemePreference } from '../../contexts/theme'
import { formatCredits } from '../../lib/billing-config'
import { PublishDropdown } from './PublishDropdown'
import { usePlatformConfig } from '../../lib/platform-config'
import { isNativePhoneIntegrationsLayout } from '../../lib/native-phone-layout'

/** Native narrow bar: Popover trigger often ignores Tailwind `max-w`; cap width in dp (slightly above 120). */
const nativeNarrowTitleMaxWidth = 132

/** Native narrow top bar only (not web): slimmer than 320px desktop popover, capped to screen width. */
function narrowProjectDropdownWidth(screenWidth: number): number {
  return Math.max(232, Math.min(276, screenWidth - 20))
}

const AGENT_TABS: { id: string; label: string; icon: React.ElementType }[] = [
  { id: 'chat-fullscreen', label: 'Chat', icon: MessageSquare },
  { id: 'dynamic-app', label: 'Canvas', icon: LayoutDashboard },
  // APP_MODE_DISABLED: { id: 'app-preview', label: 'App', icon: AppWindow },
  { id: 'files', label: 'Files', icon: FolderOpen },
  { id: 'terminal', label: 'Terminal', icon: Terminal },
  { id: 'capabilities', label: 'Capabilities', icon: Sliders },
  { id: 'channels', label: 'Channels', icon: Radio },
  { id: 'monitor', label: 'Monitor', icon: Activity },
  { id: 'plans', label: 'Plans', icon: ClipboardList },
]

export interface ProjectSwitcherItem {
  id: string
  name: string
}

export interface ProjectTopBarProps {
  projectName: string
  projectId: string
  projects?: ProjectSwitcherItem[]
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
  hiddenTabs?: string[]
  canvasEnabled?: boolean
  activeMode?: 'none' | 'canvas' | 'app'
  narrowActiveTab?: 'chat' | 'canvas'
  onNarrowTabChange?: (tab: 'chat' | 'canvas') => void
  narrowPreviewTab?: string
  // Canvas edit controls
  isEditMode?: boolean
  onToggleEditMode?: () => void
  showTreePanel?: boolean
  onToggleTreePanel?: () => void
  selectedComponentId?: string | null
  onDeleteComponent?: () => void
  onAddComponent?: () => void
  // Surface switching
  surfaceEntries?: { id: string; title: string; themeSwatchColor?: string }[]
  activeSurfaceId?: string | null
  onSurfaceChange?: (surfaceId: string) => void
  // Chat controls
  showChatSessions?: boolean
  isChatCollapsed?: boolean
  onChatSessionsToggle?: () => void
  onChatCollapseToggle?: () => void
  onCreateNewSession?: () => void
  // Slot for canvas theme picker
  canvasThemePicker?: React.ReactNode
}

function BarIconButton({
  icon: Icon,
  onPress,
  active,
  title,
  size = 14,
}: {
  icon: React.ElementType
  onPress: () => void
  active?: boolean
  title?: string
  size?: number
}) {
  const button = (triggerProps?: Record<string, unknown>) => (
    <Pressable
      {...triggerProps}
      onPress={onPress}
      className={cn(
        'h-7 w-7 items-center justify-center rounded-md',
        active ? 'bg-primary' : 'active:bg-muted',
      )}
      accessibilityLabel={title}
    >
      <Icon
        size={size}
        className={cn(active ? 'text-primary-foreground' : 'text-muted-foreground')}
      />
    </Pressable>
  )

  if (!title) return button()

  return (
    <Tooltip
      placement="bottom"
      trigger={(triggerProps) => button(triggerProps)}
    >
      <TooltipContent>
        <TooltipText>{title}</TooltipText>
      </TooltipContent>
    </Tooltip>
  )
}

export function ProjectTopBar({
  projectName,
  projectId,
  projects = [],
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
  isEditMode,
  onToggleEditMode,
  showTreePanel,
  onToggleTreePanel,
  selectedComponentId,
  onDeleteComponent,
  onAddComponent,
  surfaceEntries,
  activeSurfaceId,
  onSurfaceChange,
  showChatSessions = false,
  isChatCollapsed = false,
  onChatSessionsToggle,
  onChatCollapseToggle,
  onCreateNewSession,
  canvasThemePicker,
}: ProjectTopBarProps) {
  const router = useRouter()
  const { width, height } = useWindowDimensions()
  const isWide = width >= 768
  const isNativePhone = isNativePhoneIntegrationsLayout(width, height)
  const [showDropdown, setShowDropdown] = useState(false)
  const [dropdownKey, setDropdownKey] = useState(0)
  const [showNarrowMore, setShowNarrowMore] = useState(false)
  const [showSurfaceDropdown, setShowSurfaceDropdown] = useState(false)

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

  const isCanvasActive = activeTab === 'dynamic-app'
  const showSurfacePicker = (surfaceEntries?.length ?? 0) > 1
  const activeSurfaceEntry = surfaceEntries?.find(s => s.id === activeSurfaceId)

  const visibleTabs = AGENT_TABS.filter(tab => !hiddenTabs.includes(tab.id))
  const narrowPrimaryIds = new Set(['chat-fullscreen', 'dynamic-app', 'app-preview'])
  const narrowPrimaryTabs = visibleTabs.filter(t => narrowPrimaryIds.has(t.id))
  const narrowOverflowTabs = visibleTabs.filter(t => !narrowPrimaryIds.has(t.id))
  const narrowMoreItems = [
    ...narrowOverflowTabs.map(t => ({ id: t.id, label: t.label })),
    ...(!hasActiveSubscription ? [{ id: '_upgrade', label: 'Upgrade' }] : []),
  ]

  const handleTabPress = useCallback((tabId: string) => {
    if (onNarrowTabChange) {
      if (tabId === 'chat-fullscreen') {
        onNarrowTabChange('chat')
      } else {
        onNarrowTabChange('canvas')
        onTabChange?.(tabId)
      }
    } else {
      onTabChange?.(tabId)
    }
  }, [onNarrowTabChange, onTabChange])

  const getTabActive = useCallback((tabId: string) => {
    if (onNarrowTabChange) {
      if (tabId === 'chat-fullscreen') return narrowActiveTab === 'chat'
      return narrowActiveTab === 'canvas' && narrowPreviewTab === tabId
    }
    return activeTab === tabId
  }, [onNarrowTabChange, narrowActiveTab, narrowPreviewTab, activeTab])

  // Wide layout: two-zone top bar aligned with the chat (480px) and canvas (flex-1) panels below.
  // Narrow layout: single flat bar with icon tabs and overflow menu.
  const chatPanelWidth = 480
  const narrowNativeMenuW = Platform.OS !== 'web' ? narrowProjectDropdownWidth(width) : null

  if (!isWide) {
    return (
      <View
        className="h-10 bg-background/95 flex-row items-center px-2 web:sticky web:top-0"
        style={
          Platform.OS === 'web'
            ? ({ zIndex: 1000, isolation: 'isolate' as const } as const)
            : { elevation: 12 }
        }
      >
        <View className="flex-row items-center gap-0.5 flex-shrink-0">
          <BarIconButton icon={ArrowLeft} onPress={handleBack} title="Back to dashboard" />
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
                  'flex-row items-center gap-1 px-1.5 py-0.5 rounded-md active:bg-muted',
                  !isNativePhone && 'max-w-[120px]',
                )}
                style={[
                  (triggerProps as { style?: StyleProp<ViewStyle> }).style,
                  isNativePhone ? { maxWidth: nativeNarrowTitleMaxWidth } : undefined,
                ]}
                accessibilityLabel="Switch project"
              >
                <Text
                  className="text-xs font-semibold text-foreground"
                  style={isNativePhone ? { flex: 1, minWidth: 0 } : undefined}
                  numberOfLines={1}
                  ellipsizeMode="tail"
                >
                  {projectName}
                </Text>
                <ChevronDown size={10} className="text-muted-foreground flex-shrink-0" />
              </Pressable>
            )}
          >
            <PopoverBackdrop />
            <PopoverContent
              className={
                Platform.OS === 'web'
                  ? 'max-w-[340px] w-[320px] p-0'
                  : 'p-0'
              }
              style={
                narrowNativeMenuW != null
                  ? { width: narrowNativeMenuW, maxWidth: narrowNativeMenuW }
                  : undefined
              }
            >
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

        <View className="w-px h-5 bg-border mx-1 flex-shrink-0" />

        <View className="flex-row items-center gap-0.5" accessibilityRole="tablist">
          {narrowPrimaryTabs.map((tab) => (
            <BarIconButton
              key={tab.id}
              icon={tab.icon}
              onPress={() => handleTabPress(tab.id)}
              active={getTabActive(tab.id)}
              title={tab.label}
            />
          ))}
        </View>

        <View className="flex-1" />

        {narrowMoreItems.length > 0 && (
          <Popover
            placement="bottom right"
            isOpen={showNarrowMore}
            onOpen={() => setShowNarrowMore(true)}
            onClose={() => setShowNarrowMore(false)}
            trigger={(triggerProps) => (
              <Pressable
                {...triggerProps}
                className={cn(
                  'h-7 w-7 items-center justify-center rounded-md',
                  showNarrowMore ? 'bg-muted' : 'active:bg-muted',
                )}
                accessibilityLabel="More options"
              >
                <MoreHorizontal size={14} className="text-muted-foreground" />
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
      </View>
    )
  }

  // ── Wide layout: two-zone bar ──────────────────────────────────────────
  return (
    <View
      className="h-10 bg-background/95 flex-row items-center web:sticky web:top-0"
      style={
        Platform.OS === 'web'
          ? ({ zIndex: 1000, isolation: 'isolate' as const } as const)
          : { elevation: 12 }
      }
    >
      {/* ── Left zone: aligned with chat panel (480px) ── */}
      <View
        className="h-full flex-row items-center px-2 shrink-0"
        style={{ width: isChatCollapsed ? undefined : chatPanelWidth }}
      >
        <View className="flex-row items-center gap-0.5 flex-shrink-0">
          <BarIconButton icon={ArrowLeft} onPress={handleBack} title="Back to dashboard" />

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
                  'flex-row items-center gap-1 px-1.5 py-0.5 rounded-md active:bg-muted',
                  !isNativePhone && 'max-w-[180px]',
                )}
                style={[
                  (triggerProps as { style?: StyleProp<ViewStyle> }).style,
                  isNativePhone ? { maxWidth: 180 } : undefined,
                ]}
                accessibilityLabel="Switch project"
              >
                <Text
                  className="text-xs font-semibold text-foreground"
                  style={isNativePhone ? { flex: 1, minWidth: 0 } : undefined}
                  numberOfLines={1}
                  ellipsizeMode="tail"
                >
                  {projectName}
                </Text>
                <ChevronDown size={10} className="text-muted-foreground flex-shrink-0" />
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

        <View className="flex-1" />

        {/* Chat controls — right-aligned within the chat zone */}
        {onChatCollapseToggle && (
          <View className="flex-row items-center gap-0.5">
            {!isChatCollapsed ? (
              <>
                <BarIconButton icon={PanelLeftClose} onPress={onChatCollapseToggle} title="Collapse chat" />
                {onChatSessionsToggle && (
                  <BarIconButton icon={History} onPress={onChatSessionsToggle} active={showChatSessions} title="Chat history" />
                )}
                {onCreateNewSession && (
                  <BarIconButton icon={Plus} onPress={onCreateNewSession} title="New chat" />
                )}
              </>
            ) : (
              <BarIconButton icon={PanelLeft} onPress={onChatCollapseToggle} title="Expand chat" />
            )}
          </View>
        )}
      </View>

      {/* ── Right zone: aligned with canvas panel (flex-1) ── */}
      <View className="flex-1 h-full flex-row items-center px-2">
        {/* Panel navigation icons */}
        <View className="flex-row items-center gap-0.5" accessibilityRole="tablist">
          {visibleTabs.map((tab) => (
            <BarIconButton
              key={tab.id}
              icon={tab.icon}
              onPress={() => handleTabPress(tab.id)}
              active={getTabActive(tab.id)}
              title={tab.label}
            />
          ))}
        </View>

        {/* Context zone: canvas edit controls (web only) */}
        {Platform.OS === 'web' && isCanvasActive && onToggleEditMode && (
          <>
            <View className="w-px h-5 bg-border mx-1" />
            <View className="flex-row items-center gap-0.5">
              {showSurfacePicker && (
                <Popover
                  placement="bottom left"
                  isOpen={showSurfaceDropdown}
                  onOpen={() => setShowSurfaceDropdown(true)}
                  onClose={() => setShowSurfaceDropdown(false)}
                  trigger={(triggerProps) => (
                    <Pressable
                      {...triggerProps}
                      className="h-7 flex-row items-center gap-1 px-2 rounded-md active:bg-muted"
                      accessibilityLabel="Switch canvas"
                    >
                      {activeSurfaceEntry?.themeSwatchColor && (
                        <View
                          className="w-2.5 h-2.5 rounded-full"
                          style={{ backgroundColor: activeSurfaceEntry.themeSwatchColor }}
                        />
                      )}
                      <Text className="text-[10px] font-medium text-muted-foreground max-w-[100px]" numberOfLines={1}>
                        {activeSurfaceEntry?.title || 'Canvas'}
                      </Text>
                      <ChevronDown size={10} className="text-muted-foreground" />
                    </Pressable>
                  )}
                >
                  <PopoverBackdrop />
                  <PopoverContent className="min-w-[160px] p-0">
                    <PopoverBody>
                      {surfaceEntries?.map((s) => (
                        <Pressable
                          key={s.id}
                          onPress={() => {
                            onSurfaceChange?.(s.id)
                            setShowSurfaceDropdown(false)
                          }}
                          className={cn(
                            'px-3 py-2 active:bg-muted',
                            s.id === activeSurfaceId && 'bg-accent',
                          )}
                          style={s.themeSwatchColor ? { borderBottomWidth: 2, borderBottomColor: s.themeSwatchColor } : undefined}
                        >
                          <View className="flex-row items-center gap-2">
                            {s.themeSwatchColor && (
                              <View
                                className="w-2.5 h-2.5 rounded-full flex-shrink-0"
                                style={{ backgroundColor: s.themeSwatchColor }}
                              />
                            )}
                            <Text
                              className={cn(
                                'text-xs',
                                s.id === activeSurfaceId ? 'font-semibold text-foreground' : 'text-muted-foreground',
                              )}
                              numberOfLines={1}
                            >
                              {s.title || s.id}
                            </Text>
                          </View>
                        </Pressable>
                      ))}
                    </PopoverBody>
                  </PopoverContent>
                </Popover>
              )}
              <BarIconButton
                icon={isEditMode ? Eye : Pencil}
                onPress={onToggleEditMode}
                active={isEditMode}
                title={isEditMode ? 'Preview' : 'Edit'}
              />
              {isEditMode && onToggleTreePanel && (
                <BarIconButton icon={ListTree} onPress={onToggleTreePanel} active={showTreePanel} title="Component tree" />
              )}
              {isEditMode && onAddComponent && (
                <BarIconButton icon={Plus} onPress={onAddComponent} title="Add component" />
              )}
              {isEditMode && selectedComponentId && selectedComponentId !== 'root' && onDeleteComponent && (
                <BarIconButton icon={Trash2} onPress={onDeleteComponent} title="Delete component" />
              )}
            </View>
          </>
        )}

        <View className="flex-1" />

        {/* Canvas theme picker */}
        {isCanvasActive && canvasThemePicker}

        {/* Right actions */}
        <View className="flex-row items-center gap-0.5">
          <BarIconButton
            icon={Github}
            onPress={() => router.push({ pathname: '/(app)/settings', params: { tab: 'github' } } as any)}
            title="GitHub settings"
          />
          {!hasActiveSubscription && (
            <Pressable
              onPress={() => router.push('/(app)/billing' as any)}
              className="h-7 flex-row items-center gap-1 px-2 rounded-md border border-border active:bg-muted"
              accessibilityLabel="Upgrade plan"
            >
              <Zap size={12} className="text-muted-foreground" />
              <Text className="text-[10px] font-medium text-foreground">Upgrade</Text>
            </Pressable>
          )}
        </View>
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
              {Platform.OS === 'web' ? (
                <>
                  <View className="flex-row items-center justify-between">
                    <Text className="text-sm font-medium text-foreground">Credits</Text>
                    <Pressable
                      onPress={() => { onClose(); router.push('/(app)/billing' as any) }}
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
                </>
              ) : (
                <>
                  <View className="flex-row items-center justify-between gap-2">
                    <Text className="text-sm font-medium text-foreground shrink-0">Credits</Text>
                    <Pressable
                      onPress={() => { onClose(); router.push('/(app)/billing' as any) }}
                      className="flex-row items-center gap-1 min-w-0 flex-1 justify-end"
                    >
                      <Text
                        className="text-sm font-medium text-foreground text-right"
                        numberOfLines={1}
                        ellipsizeMode="tail"
                      >
                        {formatCredits(creditsRemaining)} left
                      </Text>
                      <ChevronRight size={14} className="text-muted-foreground flex-shrink-0" />
                    </Pressable>
                  </View>
                  <Progress
                    value={creditsPercent}
                    className="h-1.5 w-full"
                  />
                </>
              )}
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
  const [popoverOpen, setPopoverOpen] = useState(false)

  return (
    <Popover
      placement="right"
      isOpen={popoverOpen}
      onOpen={() => setPopoverOpen(true)}
      onClose={() => setPopoverOpen(false)}
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
      <PopoverContent
        className={cn(
          'p-0',
          Platform.OS === 'web'
            ? 'min-w-[160px]'
            : 'min-w-0 w-[122px] max-w-[122px] shrink-0',
        )}
      >
        <PopoverBody>
          {THEME_OPTIONS.map(({ value, label }) => (
            <Pressable
              key={value}
              onPress={() => { setTheme(value); setPopoverOpen(false) }}
              className={cn(
                'flex-row items-center active:bg-muted',
                Platform.OS === 'web' ? 'gap-3 px-4 py-3' : 'gap-2 px-2.5 py-2.5',
              )}
            >
              <Text
                className={cn(
                  'text-sm flex-1',
                  theme === value ? 'text-foreground font-medium' : 'text-foreground',
                )}
                numberOfLines={1}
              >
                {label}
              </Text>
              {theme === value && (
                <Check size={Platform.OS === 'web' ? 16 : 14} className="text-foreground flex-shrink-0" />
              )}
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
                  )}
                  >
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
