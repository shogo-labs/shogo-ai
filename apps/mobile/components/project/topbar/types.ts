// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import type { Dispatch, ReactNode, SetStateAction } from "react";
import type { UsageWindows } from "@shogo/shared-app/hooks";
import type { UsageOverageContext } from "../../../lib/billing-config";

export type IdePrimarySideBarPosition = "left" | "right";

export interface ProjectSwitcherItem {
  id: string;
  name: string;
}

/**
 * Shared overlay state owned by ProjectTopBar and passed to extracted views.
 *
 * Keeping the state and its setters together prevents the platform-specific
 * branches from growing their own, subtly divergent copies of the topbar
 * overlay state.
 */
export interface TopBarOverlayState {
  showDropdown: boolean;
  setShowDropdown: Dispatch<SetStateAction<boolean>>;
  dropdownKey: number;
  setDropdownKey: Dispatch<SetStateAction<number>>;
  showProjectSheet: boolean;
  setShowProjectSheet: Dispatch<SetStateAction<boolean>>;
  showTabsSheet: boolean;
  setShowTabsSheet: Dispatch<SetStateAction<boolean>>;
  showNarrowMore: boolean;
  setShowNarrowMore: Dispatch<SetStateAction<boolean>>;
  chatMoreOpen: boolean;
  setChatMoreOpen: Dispatch<SetStateAction<boolean>>;
  chatRenameOpen: boolean;
  setChatRenameOpen: Dispatch<SetStateAction<boolean>>;
  chatRenameValue: string;
  setChatRenameValue: Dispatch<SetStateAction<string>>;
}

export interface ProjectTopBarProps {
  projectName: string;
  projectId: string;
  projects?: ProjectSwitcherItem[];
  activeTab?: string;
  onTabChange?: (tabId: string) => void;
  onProjectSwitch?: (projectId: string) => void;
  hasActiveSubscription?: boolean;
  workspaceName?: string;
  planLabel?: string;
  usageWindows?: UsageWindows;
  usageOverage?: UsageOverageContext;
  ownerName?: string;
  projectCreatedAt?: string | number;
  projectModifiedAt?: string | number;
  isStarred?: boolean;
  onRenameProject?: (newName: string) => void;
  onToggleStar?: () => void;
  onMoveToFolder?: (folderId: string | null) => void;
  folders?: { id: string; name: string }[];
  hiddenTabs?: string[];
  canvasEnabled?: boolean;
  activeMode?: "none" | "canvas" | "app";
  /**
   * Workspace Trust controls (external / folder-linked projects only).
   * When `workingMode === 'external'` a persistent shield badge is shown
   * that flips `trustLevel` via `onToggleTrust`, so users can move
   * between restricted and trusted after first startup without opening
   * the Folders panel. Omitted/undefined on managed projects → no badge.
   */
  workingMode?: "managed" | "external";
  trustLevel?: "restricted" | "trusted";
  onToggleTrust?: () => void;
  trustBusy?: boolean;
  narrowActiveTab?: "chat" | "canvas";
  onNarrowTabChange?: (tab: "chat" | "canvas") => void;
  narrowPreviewTab?: string;
  // Canvas edit controls
  isEditMode?: boolean;
  onToggleEditMode?: () => void;
  showTreePanel?: boolean;
  onToggleTreePanel?: () => void;
  selectedComponentId?: string | null;
  onDeleteComponent?: () => void;
  onAddComponent?: () => void;
  // Chat controls
  showChatSessions?: boolean;
  isChatCollapsed?: boolean;
  onChatSessionsToggle?: () => void;
  onChatCollapseToggle?: () => void;
  onCreateNewSession?: () => void;
  /**
   * Narrow (mobile) only: toggle the in-place chat-session picker that
   * temporarily replaces the chat panel with the session list. The wide
   * layout uses `onChatSessionsToggle` for the inline sidebar instead.
   */
  onOpenChatSessions?: () => void;
  /** Narrow (mobile) only: whether the in-place picker is currently shown. */
  chatSessionsOpen?: boolean;
  chatPanelWidth?: number;
  chatFullscreenSidebarWidth?: number;
  /** Search chats — shown in the top bar left zone when in fullscreen chat mode. */
  onSearchChats?: () => void;
  // Fullscreen chat actions (rendered in the topbar chat zone in fullscreen mode)
  onNewChat?: () => void;
  onRenameChat?: (sessionId: string, newName: string) => void | Promise<void>;
  onDeleteChat?: (sessionId: string) => void | Promise<void>;
  activeChatSessionId?: string | null;
  activeChatSessionName?: string | null;
  // Slot for canvas theme picker
  canvasThemePicker?: ReactNode;
  canvasThemeSupported?: boolean | null;
  onCanvasRefresh?: () => void;
  onCanvasOpenInNewTab?: () => void;
  /**
   * Fired when the user reaches for "open in new tab" (hover / press-in) so the
   * preview backend can start waking before the click lands.
   */
  onCanvasPrewarm?: () => void;
  onOpenCodeWorkbench?: () => void;
  idePrimarySideBarPosition?: IdePrimarySideBarPosition;
  onIdePrimarySideBarPositionChange?: (
    position: IdePrimarySideBarPosition,
  ) => void;
  ideEmbed?: boolean;
}
