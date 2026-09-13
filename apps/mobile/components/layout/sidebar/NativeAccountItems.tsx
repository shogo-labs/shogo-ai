// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Native Account group rows for email, Profile, and API Keys.
 * Web popover still uses UserMenuContent + AccountNavLinks.
 */

import { Text } from "react-native";
import { Key, Mail, User } from "lucide-react-native";
import { cn } from "@shogo/shared-ui/primitives";
import { PHONE_DENSITY } from "../../../lib/phone-density";
import { AccountSettingsRow } from "./AccountSettingsGroup";

export function NativeAccountItems({
  user,
  onNavigate,
  onClose,
  localMode,
  showBilling,
  onOpenProfile,
}: {
  user: {
    name?: string | null;
    email?: string | null;
    image?: string | null;
  } | null;
  onNavigate: (href: string) => void;
  onClose: () => void;
  localMode?: boolean;
  showBilling: boolean;
  onOpenProfile?: () => void;
}) {
  const density = PHONE_DENSITY;
  const iconSize = density.icon.lg;
  const showKeys = !localMode;
  const muted = "text-muted-foreground";
  return (
    <>
      {user?.email ? (
        <AccountSettingsRow
          icon={<Mail size={iconSize} className={muted} />}
          label="Email"
          trailing={
            <Text
              className={cn("max-w-[52%] text-right text-muted-foreground", density.text.body)}
              numberOfLines={1}
            >
              {user.email}
            </Text>
          }
          showChevron={false}
          separator
        />
      ) : null}
      <AccountSettingsRow
        icon={<User size={iconSize} className={muted} />}
        label="Profile"
        separator={showKeys || showBilling}
        onPress={() => {
          if (onOpenProfile) onOpenProfile();
          else {
            onNavigate("/(app)/profile");
            onClose();
          }
        }}
      />
      {showKeys ? (
        <AccountSettingsRow
          icon={<Key size={iconSize} className={muted} />}
          label="API Keys"
          separator={showBilling}
          onPress={() => {
            onNavigate("/(app)/api-keys");
            onClose();
          }}
        />
      ) : null}
    </>
  );
}
