// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import React from "react";
import { Platform } from "react-native";
import {
  ClipboardList,
  Code2,
  Globe,
  LayoutDashboard,
  MessageSquare,
  Settings,
} from "lucide-react-native";

export type AgentTab = { id: string; label: string; icon: React.ElementType };

export const AGENT_TABS: AgentTab[] = [
  { id: "chat-fullscreen", label: "Chat", icon: MessageSquare },
  { id: "canvas", label: "Canvas", icon: LayoutDashboard },
  // `external-preview` is gated on workingMode=external at the layout
  // level (via `hiddenTabs`) so managed projects never see it. It lives
  // next to Canvas because that's where the user expects "view of my
  // running app" to be.
  { id: "external-preview", label: "Preview", icon: Globe },
  // APP_MODE_DISABLED: { id: 'app-preview', label: 'App', icon: AppWindow },
  ...(Platform.OS === "web"
    ? [{ id: "ide", label: "IDE", icon: Code2 }]
    : [{ id: "files", label: "Files", icon: Code2 }]),
  { id: "plans", label: "Plans", icon: ClipboardList },
  // Folders, Capabilities, Channels, Agents, Monitor, Checkpoints all
  // live behind this Settings tab now (rendered by SettingsPanel with a
  // grouped left sidebar). Checkpoints on web is also accessible from
  // the IDE Source Control activity-bar entry.
  { id: "settings", label: "Settings", icon: Settings },
];
