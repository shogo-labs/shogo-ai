// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Native Theme / Resources / More / Sign Out groups on the Account screen.
 * Web popover still uses UserMenuContent.
 */

import { useState } from "react";
import { Linking, Text, View } from "react-native";
import {
  ExternalLink,
  LogOut,
  Monitor,
  Shield,
  Sparkles,
  Store,
} from "lucide-react-native";
import { cn } from "@shogo/shared-ui/primitives";
import { useTheme } from "../../../contexts/theme";
import { usePlatformConfig } from "../../../lib/platform-config";
import { PHONE_DENSITY } from "../../../lib/phone-density";
import { AccountSettingsGroup, AccountSettingsRow } from "./AccountSettingsGroup";
import { CHANGELOG_URL, DOCS_URL, themeDisplayName } from "../../../lib/theme-choices";
import { ThemeChoiceList } from "./ThemeChoiceList";

export function NativeAccountPersonalGroups({
  onSignOut,
  onNavigate,
  isSuperAdmin,
  localMode,
  onClose,
  onOpenAppearance,
}: {
  onSignOut: () => void;
  onNavigate: (href: string) => void;
  isSuperAdmin?: boolean;
  localMode?: boolean;
  onClose: () => void;
  onOpenAppearance?: () => void;
}) {
  const [appearanceOpen, setAppearanceOpen] = useState(false);
  const { theme, setTheme } = useTheme();
  const { shogoKeyConnected } = usePlatformConfig();
  const showCreator = !localMode || !!shogoKeyConnected;
  const density = PHONE_DENSITY;
  const iconClass = "text-muted-foreground";
  const iconSize = density.icon.lg;
  const appearanceOpensSheet = !!onOpenAppearance;

  return (
    <>
      <AccountSettingsGroup title="Theme">
        <AccountSettingsRow
          icon={<Monitor size={iconSize} className={iconClass} />}
          label="Appearance"
          accessibilityState={appearanceOpensSheet ? undefined : { expanded: appearanceOpen }}
          trailing={
            <Text className={cn("text-muted-foreground", density.text.body)}>
              {themeDisplayName(theme)}
            </Text>
          }
          showChevron={appearanceOpensSheet || !appearanceOpen}
          separator={!appearanceOpensSheet && appearanceOpen}
          onPress={() => {
            if (onOpenAppearance) onOpenAppearance();
            else setAppearanceOpen((open) => !open);
          }}
        />
        {appearanceOpen ? (
          <ThemeChoiceList
            theme={theme}
            onSelect={setTheme}
            variant="grouped"
          />
        ) : null}
      </AccountSettingsGroup>

      <AccountSettingsGroup title="Resources">
        <AccountSettingsRow
          icon={<ExternalLink size={iconSize} className={iconClass} />}
          label="Docs"
          onPress={() => {
            Linking.openURL(DOCS_URL);
            onClose();
          }}
        />
        <AccountSettingsRow
          icon={<Sparkles size={iconSize} className={iconClass} />}
          label="What's New"
          separator={false}
          onPress={() => {
            Linking.openURL(CHANGELOG_URL);
            onClose();
          }}
        />
      </AccountSettingsGroup>

      {(showCreator || isSuperAdmin) && (
        <AccountSettingsGroup title="More">
          {showCreator && (
            <AccountSettingsRow
              icon={<Store size={iconSize} className={iconClass} />}
              label="Creator"
              separator={!!isSuperAdmin}
              onPress={() => {
                onNavigate("/(app)/creator");
                onClose();
              }}
            />
          )}
          {isSuperAdmin && (
            <AccountSettingsRow
              icon={<Shield size={iconSize} className="text-primary" />}
              label="Admin"
              accessibilityLabel="Admin panel"
              separator={false}
              onPress={() => {
                onNavigate("/(admin)");
                onClose();
              }}
            />
          )}
        </AccountSettingsGroup>
      )}

      {!localMode && (
        <View className="mb-6">
          <AccountSettingsGroup>
            <AccountSettingsRow
              icon={<LogOut size={iconSize} className={iconClass} />}
              label="Sign Out"
              accessibilityLabel="Sign out"
              showChevron={false}
              separator={false}
              onPress={() => {
                onSignOut();
                onClose();
              }}
            />
          </AccountSettingsGroup>
        </View>
      )}
    </>
  );
}
