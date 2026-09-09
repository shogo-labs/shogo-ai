// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import type { ComponentProps } from "react";
import { Pressable, Text, View } from "react-native";
import { Check } from "lucide-react-native";
import { cn } from "@shogo/shared-ui/primitives";
import { NativePhoneSheet } from "../../phone/NativePhoneSheet";
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

export function ProjectFilterSheet({
  visible,
  sort,
  scope,
  onSort,
  onScope,
  onClose,
}: {
  visible: boolean;
  sort: ProjectSort;
  scope: ProjectScope;
  onSort: (sort: ProjectSort) => void;
  onScope: (scope: ProjectScope) => void;
  onClose: () => void;
}) {
  return (
    <NativePhoneSheet
      visible={visible}
      onClose={onClose}
      title="Filter & sort"
      headerRight={
        <Pressable
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel="Done"
          className="h-11 px-2 items-center justify-center"
        >
          <Text className="text-base font-semibold text-primary">Done</Text>
        </Pressable>
      }
    >
      <View className="px-5">
        <Text className="pt-2 pb-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Sort by
        </Text>
        {PROJECT_SORT_OPTIONS.map((opt) => (
          <Pressable
            key={opt.value}
            onPress={() => onSort(opt.value)}
            role={MENU_ITEM_RADIO_ROLE}
            accessibilityState={{ checked: sort === opt.value }}
            className="flex-row items-center min-h-14 gap-3 px-1 active:bg-muted rounded-xl"
          >
            <Text
              className={cn(
                "text-lg flex-1",
                sort === opt.value
                  ? "text-foreground font-medium"
                  : "text-muted-foreground",
              )}
            >
              {opt.label}
            </Text>
            {sort === opt.value ? (
              <Check size={20} className="text-primary" />
            ) : null}
          </Pressable>
        ))}

        <View className="h-px bg-border my-2" />

        <Text className="pt-1 pb-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Show
        </Text>
        {PROJECT_SCOPE_OPTIONS.map((opt) => (
          <Pressable
            key={opt.value}
            onPress={() => onScope(opt.value)}
            role={MENU_ITEM_RADIO_ROLE}
            accessibilityState={{ checked: scope === opt.value }}
            className="flex-row items-center min-h-14 gap-3 px-1 active:bg-muted rounded-xl"
          >
            <Text
              className={cn(
                "text-lg flex-1",
                scope === opt.value
                  ? "text-foreground font-medium"
                  : "text-muted-foreground",
              )}
            >
              {opt.label}
            </Text>
            {scope === opt.value ? (
              <Check size={20} className="text-primary" />
            ) : null}
          </Pressable>
        ))}
      </View>
    </NativePhoneSheet>
  );
}
