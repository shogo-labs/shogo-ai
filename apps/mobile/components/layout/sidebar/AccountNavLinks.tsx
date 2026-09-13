// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * API Keys / Docs / What's New in the wide-web Account popover.
 * Native Account uses NativeAccountPersonalGroups for the same destinations.
 */

import type { ElementType } from "react";
import { Linking, Pressable, Text, View } from "react-native";
import { ExternalLink, Key, Sparkles } from "lucide-react-native";
import { COMPACT_DENSITY } from "../../../lib/phone-density";
import { CHANGELOG_URL, DOCS_URL } from "./account-theme";

/** Web popover icon size (not COMPACT_DENSITY.icon.lg). */
const ACCOUNT_NAV_ICON_SIZE = 18;

export function AccountNavLinks({
  localMode,
  onNavigate,
  onClose,
}: {
  localMode?: boolean;
  onNavigate: (href: string) => void;
  onClose: () => void;
}) {
  const density = COMPACT_DENSITY;
  const rowClass = `flex-row items-center gap-3 ${density.rowPad} active:bg-muted`;
  const rowText = `${density.text.body} text-foreground`;
  const items: Array<{ icon: ElementType; label: string; href: string }> = [
    ...(!localMode
      ? [{ icon: Key, label: "API Keys", href: "/(app)/api-keys" }]
      : []),
  ];

  return (
    <View role="menu" className="py-1">
      {items.map(({ icon: Icon, label, href }) => (
        <Pressable
          key={label}
          onPress={() => {
            onNavigate(href);
            onClose();
          }}
          role="menuitem"
          accessibilityLabel={label}
          className={rowClass}
        >
          <Icon size={ACCOUNT_NAV_ICON_SIZE} className="text-muted-foreground" />
          <Text className={rowText}>{label}</Text>
        </Pressable>
      ))}
      <Pressable
        onPress={() => {
          Linking.openURL(DOCS_URL);
          onClose();
        }}
        role="menuitem"
        accessibilityLabel="Docs"
        className={rowClass}
      >
        <ExternalLink
          size={ACCOUNT_NAV_ICON_SIZE}
          className="text-muted-foreground"
        />
        <Text className={rowText}>Docs</Text>
      </Pressable>
      <Pressable
        onPress={() => {
          Linking.openURL(CHANGELOG_URL);
          onClose();
        }}
        role="menuitem"
        accessibilityLabel="What's New"
        className={rowClass}
      >
        <Sparkles
          size={ACCOUNT_NAV_ICON_SIZE}
          className="text-muted-foreground"
        />
        <Text className={rowText}>What's New</Text>
      </Pressable>
    </View>
  );
}
