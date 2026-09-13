// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Theme choices and docs links shared by the web Account popover and the
 * native Account groups. Keep labels in one place so both surfaces stay in sync.
 */

import { Monitor, Moon, Sun } from "lucide-react-native";

export const DOCS_URL = "https://docs.shogo.ai/";
export const CHANGELOG_URL = "https://docs.shogo.ai/changelog";

export const THEME_CHOICES = [
  { value: "light" as const, label: "Light", Icon: Sun },
  { value: "dark" as const, label: "Dark", Icon: Moon },
  { value: "system" as const, label: "System", Icon: Monitor },
];

export function themeDisplayName(theme: string): string {
  return THEME_CHOICES.find((choice) => choice.value === theme)?.label ?? "System";
}
