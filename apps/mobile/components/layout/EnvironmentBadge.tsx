// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Small always-on pill showing the API backend when a runtime override
 * (see `lib/env-override.ts`) points away from the build's default.
 * Non-interactive so it never blocks the header beneath it.
 */

import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Text } from "../settings/account-sheet-chrome";
import { getActiveEnvLabel } from "../../lib/env-override";

export function EnvironmentBadge() {
  const insets = useSafeAreaInsets();
  const label = getActiveEnvLabel();
  if (!label) return null;

  return (
    <View
      pointerEvents="none"
      className="absolute left-0 right-0 items-center"
      style={{ top: insets.top }}
    >
      <View className="rounded-full bg-amber-500/90 px-2 py-0.5">
        <Text className="text-[10px] font-semibold uppercase tracking-wide text-black">
          {label}
        </Text>
      </View>
    </View>
  );
}
