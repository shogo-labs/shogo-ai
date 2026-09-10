// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import type { ComponentProps } from "react";
import type { Pressable } from "react-native";
import type {
  ProjectScope,
  ProjectSort,
} from "../../../lib/project-prefs-store";

export const PROJECT_SORT_OPTIONS: { value: ProjectSort; label: string }[] = [
  { value: "recent", label: "Recent" },
  { value: "name", label: "Name" },
];
export const PROJECT_SCOPE_OPTIONS: { value: ProjectScope; label: string }[] = [
  { value: "all", label: "All projects" },
  { value: "mine", label: "My projects" },
];

export const MENU_ITEM_RADIO_ROLE =
  "menuitemradio" as unknown as ComponentProps<typeof Pressable>["role"];
