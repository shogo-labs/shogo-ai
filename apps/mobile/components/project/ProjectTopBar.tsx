// SPDX-License-Identifier: MIT
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
  Text,
  View,
  useWindowDimensions,
  Platform,
  Pressable,
  type StyleProp,
  type ViewStyle,
} from 'react-native'
import {
  Popover,
  PopoverBackdrop,
  PopoverBody,
  PopoverContent,
} from "../ui/popover"
import { useRouter } from 'expo-router'
import {
  ArrowLeft,
  ChevronDown,
  ExternalLink,
  History,
  MessageSquare,
  MoreHorizontal,
  PanelLeft,
  PanelLeftClose,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  Zap,
} from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import { PublishDropdown } from "./PublishDropdown"
import { CloudSyncStatusPill } from "./CloudSyncStatusPill"
import {
  isPhoneLayout,
  NATIVE_PHONE_CONTROL_SIZE,
  WEB_WIDE_MIN_WIDTH,
} from '../../lib/native-phone-layout'
import { requestIdeActivity } from "../../lib/ide-activity-bus"
import { nextIdeAlignment } from '../../lib/project-topbar-layout'
import { BarIconButton } from "./topbar/BarIconButton"
import { IdeAlignmentToggle } from "./topbar/IdeAlignmentToggle"
import { RenameChatModal } from "./topbar/RenameChatModal"
import { TrustBadge } from "./topbar/TrustBadge"
import { AGENT_TABS } from "./topbar/agent-tabs"
import { NativePhoneHeader } from "./topbar/native/NativePhoneHeader"
import { ProjectDropdownContent } from './topbar/dropdown/ProjectDropdownContent'

import type {
  IdePrimarySideBarPosition,
  ProjectTopBarProps,
  TopBarOverlayState,
} from './topbar/types'

export type {
  IdePrimarySideBarPosition,
  ProjectSwitcherItem,
  ProjectTopBarProps,
  TopBarOverlayState,
} from './topbar/types'

const nativeNarrowTitleMaxWidth = 132

function narrowProjectDropdownWidth(screenWidth: number): number {
  return Math.max(300, Math.min(320, screenWidth - 96))
}

export function ProjectTopBar({
  projectName,
  projectId,
  projects = [],
  activeTab = 'canvas',
  onTabChange,
  onProjectSwitch,
  hasActiveSubscription = false,
  workspaceName = '',
  planLabel = 'Free',
  usageWindows,
  usageOverage,
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
  workingMode,
  trustLevel,
  onToggleTrust,
  trustBusy = false,
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
  showChatSessions = false,
  isChatCollapsed = false,
  onChatSessionsToggle,
  onChatCollapseToggle,
  onCreateNewSession,
  onOpenChatSessions,
  chatSessionsOpen = false,
  chatPanelWidth: chatPanelWidthProp,
  chatFullscreenSidebarWidth,
  onSearchChats,
  onNewChat,
  onRenameChat,
  onDeleteChat,
  activeChatSessionId,
  activeChatSessionName,
  canvasThemePicker,
  canvasThemeSupported,
  onCanvasRefresh,
  onCanvasOpenInNewTab,
  onCanvasPrewarm,
  onOpenCodeWorkbench,
  idePrimarySideBarPosition = 'left',
  onIdePrimarySideBarPositionChange,
  ideEmbed = false,
}: ProjectTopBarProps) {
  const router = useRouter()
  const { width, height } = useWindowDimensions()
  const isWide = width >= WEB_WIDE_MIN_WIDTH
  const isNativePhone = isPhoneLayout(width, height)
  const [showDropdown, setShowDropdown] = useState(false)
  const [dropdownKey, setDropdownKey] = useState(0)
  const [showProjectSheet, setShowProjectSheet] = useState(false)
  const [showTabsSheet, setShowTabsSheet] = useState(false)
  const [showNarrowMore, setShowNarrowMore] = useState(false)
  const [chatMoreOpen, setChatMoreOpen] = useState(false)
  const [chatRenameOpen, setChatRenameOpen] = useState(false)
  const [chatRenameValue, setChatRenameValue] = useState('')

  const overlayState: TopBarOverlayState = {
    showDropdown,
    setShowDropdown,
    dropdownKey,
    setDropdownKey,
    showProjectSheet,
    setShowProjectSheet,
    showTabsSheet,
    setShowTabsSheet,
    showNarrowMore,
    setShowNarrowMore,
    chatMoreOpen,
    setChatMoreOpen,
    chatRenameOpen,
    setChatRenameOpen,
    chatRenameValue,
    setChatRenameValue,
  };

  const handleBack = useCallback(() => {
    router.push('/(app)' as any)
  }, [router])

  const handleProjectSelect = useCallback((selectedId: string) => {
    setShowDropdown(false)
    setShowProjectSheet(false)
    if (selectedId === projectId) return
    if (onProjectSwitch) {
      onProjectSwitch(selectedId)
    } else {
      router.push(`/(app)/projects/${selectedId}` as any)
    }
  }, [projectId, onProjectSwitch, router])

  const handleSaveChatRename = useCallback(async () => {
    const trimmed = chatRenameValue.trim()
    if (!activeChatSessionId || !trimmed || !onRenameChat) {
      setChatRenameOpen(false)
      return
    }
    try {
      await onRenameChat(activeChatSessionId, trimmed)
    } finally {
      setChatRenameOpen(false)
    }
  }, [activeChatSessionId, chatRenameValue, onRenameChat])

  const isCanvasActive = activeTab === 'canvas'
  const isIdeActive = activeTab === 'ide'
  const canOpenCodeWorkbench =
    Platform.OS === 'web' &&
    typeof window !== 'undefined' &&
    !!(window as unknown as { shogoDesktop?: { isDesktop?: boolean } }).shogoDesktop?.isDesktop &&
    !!onOpenCodeWorkbench

  // Workspace Trust badge: external (folder-linked) projects only, and
  // only when the parent wired up a toggle handler + a known trust level.
  const showTrustBadge =
    workingMode === 'external' && !!trustLevel && typeof onToggleTrust === 'function'

  const visibleTabs = AGENT_TABS.filter((tab) =>
    ideEmbed ? tab.id === 'chat-fullscreen' : !hiddenTabs.includes(tab.id),
  )
  // Every remaining tab is primary now that secondary controls live behind
  // the Settings tab. Files (native) and IDE (web) sit next to Chat/Canvas/
  // Preview/Plans/Settings on narrow screens too.
  const narrowPrimaryIds = new Set([
    'chat-fullscreen',
    'canvas',
    'app-preview',
    'external-preview',
    'ide',
    'files',
    'plans',
    'settings',
  ])
  const narrowPrimaryTabs = visibleTabs.filter((t) => narrowPrimaryIds.has(t.id))
  const narrowOverflowTabs = visibleTabs.filter(
    (t) => !narrowPrimaryIds.has(t.id))
  const narrowMoreItems = [
    ...narrowOverflowTabs.map((t) => ({ id: t.id, label: t.label })),
    ...(!hasActiveSubscription && !isNativePhone ? [{ id: '_upgrade', label: 'Upgrade' }] : []),
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

  const showIdeAlignmentControl = Platform.OS === 'web' && getTabActive('ide') && !!onIdePrimarySideBarPositionChange
  const nextIdePrimarySideBarPosition: IdePrimarySideBarPosition =
    nextIdeAlignment(idePrimarySideBarPosition)
  const renderIdeAlignmentControl = () => {
    if (!showIdeAlignmentControl) return null
    return (
      <IdeAlignmentToggle
        position={idePrimarySideBarPosition}
        nextPosition={nextIdePrimarySideBarPosition}
        onPress={() => onIdePrimarySideBarPositionChange?.(nextIdePrimarySideBarPosition)}
      />
    )
  }

  const chatPanelWidth = chatPanelWidthProp ?? 480
  const narrowNativeMenuW =
    Platform.OS !== 'web' ? narrowProjectDropdownWidth(width) : null

  const projectMenu = (
    <ProjectDropdownContent
      key={overlayState.dropdownKey}
      variant="sheet"
      projects={projects}
      currentProjectId={projectId}
      projectName={projectName}
      onSelect={handleProjectSelect}
      onGoToDashboard={handleBack}
      onClose={() => overlayState.setShowProjectSheet(false)}
      workspaceName={workspaceName}
      planLabel={planLabel}
      usageWindows={usageWindows}
      usageOverage={usageOverage}
      ownerName={ownerName}
      projectCreatedAt={projectCreatedAt}
      projectModifiedAt={projectModifiedAt}
      isStarred={isStarred}
      onRenameProject={onRenameProject}
      onToggleStar={onToggleStar}
      onMoveToFolder={onMoveToFolder}
      folders={folders}
      canvasThemeSupported={canvasThemeSupported}
      overlayState={overlayState}
    />
  )

  if (ideEmbed) {
    return (
      <View
        className="h-10 bg-background/95 flex-row items-center px-2 web:sticky web:top-0"
        style={
          Platform.OS === 'web'
            ? ({ zIndex: 1000, isolation: 'isolate' as const } as const)
            : { elevation: 12 }
        }
      >
        <View className="px-1.5 py-0.5 max-w-[180px]">
          <Text
            className="text-xs font-semibold text-foreground"
            numberOfLines={1}
            ellipsizeMode="tail"
          >
            {projectName}
          </Text>
        </View>
        <View className="w-px h-5 bg-border mx-1 flex-shrink-0" />
        <BarIconButton
          icon={MessageSquare}
          onPress={() => handleTabPress('chat-fullscreen')}
          active
          title="Chat"
          testID="project-tab-chat-fullscreen"
        />
        <View className="flex-1" />
      </View>
    )
  }

  if (!isWide) {
    if (isNativePhone) {
      return (
        <NativePhoneHeader
          projectName={projectName}
          projectMenu={projectMenu}
          onBack={handleBack}
          showTrustBadge={showTrustBadge}
          trustLevel={trustLevel}
          onToggleTrust={onToggleTrust}
          trustBusy={trustBusy}
          narrowActiveTab={narrowActiveTab}
          narrowPrimaryTabs={narrowPrimaryTabs}
          getTabActive={getTabActive}
          handleTabPress={handleTabPress}
          onOpenChatSessions={onOpenChatSessions}
          chatSessionsOpen={chatSessionsOpen}
          overlayState={overlayState}
        />
      )
    }

    return (
      <View
        className="h-10 bg-background/95 flex-row items-center px-2 web:sticky web:top-0"
        style={
          Platform.OS === 'web'
            ? ({ zIndex: 1000, isolation: 'isolate' as const } as const)
            : { elevation: 12 }
        }
      >
        <View className={cn('flex-row items-center flex-shrink-0', Platform.OS !== 'web' ? 'gap-1' : 'gap-0.5')}>
          {!ideEmbed && <BarIconButton icon={ArrowLeft} onPress={handleBack} title="Back to dashboard" />}
          {ideEmbed ? (
            <View className="px-1.5 py-0.5 max-w-[160px]">
              <Text className={cn('font-semibold text-foreground', Platform.OS !== 'web' ? 'text-base' : 'text-xs')} numberOfLines={1} ellipsizeMode="tail">
                {projectName}
              </Text>
            </View>
          ) : (
            <Popover
              placement="bottom"
              size="md"
              isOpen={overlayState.showDropdown}
              onOpen={() => {
                overlayState.setShowDropdown(true)
                overlayState.setDropdownKey((k) => k + 1)
              }}
              onClose={() => overlayState.setShowDropdown(false)}
              trigger={(triggerProps) => (
                <Pressable
                  {...triggerProps}
                  className={cn(
                    'flex-row items-center gap-1 rounded-md active:bg-muted',
                    Platform.OS !== 'web' ? 'min-h-9 px-2 py-1' : 'px-1.5 py-0.5',
                    !isNativePhone && 'max-w-[120px]',
                  )}
                  style={[
                    (triggerProps as { style?: StyleProp<ViewStyle> }).style,
                    isNativePhone ? { maxWidth: nativeNarrowTitleMaxWidth, alignSelf: 'flex-start' } : undefined,
                  ]}
                  accessibilityLabel="Switch project"
                  testID="project-switcher-trigger"
                >
                  <Text
                    className={cn('font-semibold text-foreground', Platform.OS !== 'web' ? 'text-base' : 'text-xs')}
                    style={isNativePhone ? { maxWidth: nativeNarrowTitleMaxWidth - 22 } : undefined}
                    numberOfLines={1}
                    ellipsizeMode="tail"
                  >
                    {projectName}
                  </Text>
                  <ChevronDown size={Platform.OS !== 'web' ? 14 : 10} className="text-muted-foreground flex-shrink-0" />
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
                    ? { width: narrowNativeMenuW, maxWidth: narrowNativeMenuW, left: 16 }
                    : undefined
                }
              >
                <PopoverBody
                  style={{ maxHeight: 480 }}
                  scrollEnabled
                  showsVerticalScrollIndicator={Platform.OS !== 'web'}
                  nestedScrollEnabled={Platform.OS !== 'web'}
                  keyboardShouldPersistTaps="handled"
                  bounces={Platform.OS !== 'web'}
                  contentContainerStyle={Platform.OS !== 'web' ? { paddingBottom: 8 } : undefined}
                >
                  <ProjectDropdownContent
                    key={overlayState.dropdownKey}
                    projects={projects}
                    currentProjectId={projectId}
                    projectName={projectName}
                    onSelect={handleProjectSelect}
                    onGoToDashboard={handleBack}
                    onClose={() => overlayState.setShowDropdown(false)}
                    workspaceName={workspaceName}
                    planLabel={planLabel}
                    usageWindows={usageWindows}
                    usageOverage={usageOverage}
                    ownerName={ownerName}
                    projectCreatedAt={projectCreatedAt}
                    projectModifiedAt={projectModifiedAt}
                    isStarred={isStarred}
                    onRenameProject={onRenameProject}
                    onToggleStar={onToggleStar}
                    onMoveToFolder={onMoveToFolder}
                    folders={folders}
                    canvasThemeSupported={canvasThemeSupported}
                    overlayState={overlayState}
                  />
                </PopoverBody>
              </PopoverContent>
            </Popover>
          )}
        </View>

        <View className={cn('w-px bg-border mx-1 flex-shrink-0', Platform.OS !== 'web' ? 'h-7' : 'h-5')} />

        <View className={cn('flex-row items-center', Platform.OS !== 'web' ? 'gap-1' : 'gap-0.5')} role="tablist">
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

        {showTrustBadge && (
          <TrustBadge
            trustLevel={trustLevel!}
            onToggle={onToggleTrust!}
            busy={trustBusy}
            compact
          />
        )}

        {showIdeAlignmentControl && renderIdeAlignmentControl()}

        {onOpenChatSessions && narrowActiveTab === 'chat' && (
          <BarIconButton
            icon={History}
            onPress={onOpenChatSessions}
            active={chatSessionsOpen}
            title={chatSessionsOpen ? 'Hide chat history' : 'Chat history'}
          />
        )}

        {narrowMoreItems.length > 0 && (
          <Popover
            placement="bottom right"
            isOpen={overlayState.showNarrowMore}
            onOpen={() => overlayState.setShowNarrowMore(true)}
            onClose={() => overlayState.setShowNarrowMore(false)}
            trigger={(triggerProps) => (
              <Pressable
                {...triggerProps}
                className={cn(
                  'items-center justify-center rounded-md',
                  Platform.OS !== 'web' ? 'h-9 w-9' : 'h-7 w-7',
                  overlayState.showNarrowMore ? 'bg-muted' : 'active:bg-muted',
                )}
                accessibilityLabel="More options"
              >
                <MoreHorizontal size={Platform.OS !== 'web' ? 18 : 14} className="text-muted-foreground" />
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
                      overlayState.setShowNarrowMore(false)
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
      {/* ── Left zone: aligned with chat panel (480px) or sidebar in fullscreen ── */}
      <View
        className={cn("h-full flex-row items-center px-2 shrink-0", chatFullscreenSidebarWidth && "bg-muted/50 dark:bg-black/30")}
        style={{ width: chatFullscreenSidebarWidth ?? (isChatCollapsed ? undefined : chatPanelWidth) }}
      >
        <View className="flex-row items-center gap-0.5 flex-shrink-0">
          {ideEmbed ? (
            <View className="px-1.5 py-0.5 max-w-[180px]">
              <Text className="text-xs font-semibold text-foreground" numberOfLines={1} ellipsizeMode="tail">
                {projectName}
              </Text>
            </View>
          ) : (
            <>
              {/* <BarIconButton icon={ArrowLeft} onPress={handleBack} title="Back to dashboard" /> */}

              <Popover
                placement="bottom"
                size="md"
                isOpen={overlayState.showDropdown}
                onOpen={() => {
                  overlayState.setShowDropdown(true)
                  overlayState.setDropdownKey((k) => k + 1)
                }}
                onClose={() => overlayState.setShowDropdown(false)}
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
                    testID="project-switcher-trigger"
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
                      key={overlayState.dropdownKey}
                      projects={projects}
                      currentProjectId={projectId}
                      projectName={projectName}
                      onSelect={handleProjectSelect}
                      onGoToDashboard={handleBack}
                      onClose={() => overlayState.setShowDropdown(false)}
                      workspaceName={workspaceName}
                      planLabel={planLabel}
                      usageWindows={usageWindows}
                      usageOverage={usageOverage}
                      ownerName={ownerName}
                      projectCreatedAt={projectCreatedAt}
                      projectModifiedAt={projectModifiedAt}
                      isStarred={isStarred}
                      onRenameProject={onRenameProject}
                      onToggleStar={onToggleStar}
                      onMoveToFolder={onMoveToFolder}
                      folders={folders}
                      canvasThemeSupported={canvasThemeSupported}
                      overlayState={overlayState}
                    />
                  </PopoverBody>
                </PopoverContent>
              </Popover>

              <CloudSyncStatusPill projectId={projectId} />
            </>
          )}
        </View>

        <View className="flex-1" />

        {/* Fullscreen chat: search, new chat, more options */}
        {onSearchChats && (
          <BarIconButton icon={Search} onPress={onSearchChats} title="Search chats" />
        )}
        {onNewChat && (
          <BarIconButton icon={Plus} onPress={onNewChat} title="New chat" />
        )}
        {(onRenameChat || onDeleteChat) && (
          <Popover
            placement="bottom right"
            size="sm"
            isOpen={overlayState.chatMoreOpen}
            onOpen={() => overlayState.setChatMoreOpen(true)}
            onClose={() => overlayState.setChatMoreOpen(false)}
            trigger={(triggerProps) => (
              <Pressable
                {...triggerProps}
                onPress={() => overlayState.setChatMoreOpen((o) => !o)}
                className="h-7 w-7 items-center justify-center rounded-md active:bg-muted"
                accessibilityLabel="More options"
                accessibilityState={{ expanded: overlayState.chatMoreOpen }}
              >
                <MoreHorizontal size={14} className="text-muted-foreground" />
              </Pressable>
            )}
          >
            <PopoverBackdrop />
            <PopoverContent className="w-[200px] p-0">
              <PopoverBody className="py-1">
                {onRenameChat && (
                  <Pressable
                    onPress={() => {
                      overlayState.setChatMoreOpen(false)
                      overlayState.setChatRenameValue(activeChatSessionName ?? '')
                      overlayState.setChatRenameOpen(true)
                    }}
                    disabled={!activeChatSessionId}
                    className="flex-row items-center gap-2 px-3 py-2 active:bg-muted"
                  >
                    <Pencil size={14} className="text-muted-foreground" />
                    <Text className="text-sm text-foreground">Rename chat</Text>
                  </Pressable>
                )}
                {onDeleteChat && (
                  <Pressable
                    onPress={() => {
                      overlayState.setChatMoreOpen(false)
                      if (activeChatSessionId) {
                        void onDeleteChat(activeChatSessionId)
                      }
                    }}
                    disabled={!activeChatSessionId}
                    className="flex-row items-center gap-2 px-3 py-2 active:bg-muted"
                  >
                    <Trash2 size={14} className="text-destructive" />
                    <Text className="text-sm text-destructive">Delete chat</Text>
                  </Pressable>
                )}
              </PopoverBody>
            </PopoverContent>
          </Popover>
        )}

        {/* New chat — split mode (fullscreen has its own button in the right zone). */}
        {onCreateNewSession && (
          <BarIconButton
            icon={Plus}
            onPress={onCreateNewSession}
            title="New chat"
          />
        )}

        {/* Chat history toggle — shown in split mode (fullscreen pins the rail). */}
        {onChatSessionsToggle && (
          <BarIconButton
            icon={History}
            onPress={onChatSessionsToggle}
            active={showChatSessions}
            title={showChatSessions ? 'Hide chat history' : 'Show chat history'}
          />
        )}

        {/* Chat collapse/expand */}
        {onChatCollapseToggle && (
          <View className="flex-row items-center gap-0.5">
            {!isChatCollapsed ? (
              <BarIconButton icon={PanelLeftClose} onPress={onChatCollapseToggle} title="Collapse chat" />
            ) : (
              <BarIconButton icon={PanelLeft} onPress={onChatCollapseToggle} title="Expand chat" />
            )}
          </View>
        )}
      </View>

      {/* ── Right zone: aligned with canvas panel (flex-1) ── */}
      <View className="flex-1 h-full flex-row items-center px-2">
        {/* Panel navigation icons */}
        <View className="flex-row items-center gap-0.5" role="tablist">
          {visibleTabs.map((tab) => (
            <BarIconButton
              key={tab.id}
              icon={tab.icon}
              onPress={() => handleTabPress(tab.id)}
              active={getTabActive(tab.id)}
              title={tab.label}
              testID={`project-tab-${tab.id}`}
            />
          ))}
        </View>

        {/* Visual edit controls — temporarily disabled
        {Platform.OS === 'web' && isCanvasActive && onToggleEditMode && (
          <>
            <View className="w-px h-5 bg-border mx-1" />
            <View className="flex-row items-center gap-0.5">
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
        */}

        <View className="flex-1" />

        {/* Canvas theme picker + refresh */}
        {isCanvasActive && canvasThemePicker}
        {isCanvasActive && onCanvasRefresh && (
          <BarIconButton icon={RefreshCw} onPress={onCanvasRefresh} title="Refresh preview" />
        )}
        {isCanvasActive && onCanvasOpenInNewTab && (
          <BarIconButton
            icon={ExternalLink}
            onPress={onCanvasOpenInNewTab}
            onHoverIn={onCanvasPrewarm}
            title="Open preview in new tab"
          />
        )}

        {/* Right actions */}
        <View className="flex-row items-center gap-1">
          {showTrustBadge && (
            <TrustBadge
              trustLevel={trustLevel!}
              onToggle={onToggleTrust!}
              busy={trustBusy}
            />
          )}
          {isIdeActive && canOpenCodeWorkbench && (
            <Pressable
              onPress={onOpenCodeWorkbench}
              className="h-8 flex-row items-center gap-1.5 rounded-lg border border-orange-500/40 bg-orange-500/10 px-3 active:bg-orange-500/15"
              accessibilityRole="button"
              accessibilityLabel="Open in Shogo IDE"
            >
              <ExternalLink size={14} className="text-orange-400" />
              <Text className="text-xs font-semibold text-orange-400">
                {isWide ? 'Open in Shogo IDE' : 'Open in IDE'}
              </Text>
            </Pressable>
          )}
          {isCanvasActive && (
            <PublishDropdown
              projectId={projectId}
              projectName={projectName}
              onViewHistory={
                Platform.OS === 'web'
                  ? () => {
                      onTabChange?.('ide')
                      requestIdeActivity('checkpoint')
                    }
                  : undefined
              }
            />
          )}
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
          {showIdeAlignmentControl && renderIdeAlignmentControl()}
        </View>
      </View>

      {/* Rename chat modal (fullscreen chat mode) */}
      <RenameChatModal
        visible={overlayState.chatRenameOpen}
        currentName={overlayState.chatRenameValue}
        onChangeName={overlayState.setChatRenameValue}
        onClose={() => overlayState.setChatRenameOpen(false)}
        onSave={() => void handleSaveChatRename()}
      />
    </View>
  )
}
