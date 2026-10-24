// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Names the analytics sections whose requests failed. Each section still
 * renders its empty state, so without this a server error reads as "no data".
 */

import { View } from "react-native";
import { Text } from "../settings/account-sheet-chrome";

/** Failed section label -> error message. */
export type LoadErrors = Record<string, string>;

export function LoadErrorNotice({ errors }: { errors: LoadErrors }) {
  const sections = Object.keys(errors);
  if (sections.length === 0) return null;
  return (
    <View
      className="rounded-lg border border-red-500/30 bg-red-500/5 px-3 py-2"
      testID="analytics-load-error"
    >
      <Text className="text-xs text-red-500">
        Couldn't load {sections.join(", ")}: {errors[sections[0]]}
      </Text>
    </View>
  );
}
