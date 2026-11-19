// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { Pressable, Text } from "react-native";
import { ExternalLink } from "lucide-react-native";
import {
  codeWorkbenchButtonLabel,
  isCodeWorkbenchBusy,
  type CodeWorkbenchStatus,
} from "../../../lib/code-workbench-status";

/** Desktop-only top bar action; shows download/start progress and is disabled meanwhile. */
export function OpenInShogoIdeButton({
  onPress,
  status,
  wide,
}: {
  onPress: () => void;
  status: CodeWorkbenchStatus | null;
  wide: boolean;
}) {
  const busy = isCodeWorkbenchBusy(status);
  return (
    <Pressable
      onPress={onPress}
      disabled={busy}
      className={`h-8 flex-row items-center gap-1.5 rounded-lg border border-orange-500/40 bg-orange-500/10 px-3 active:bg-orange-500/15${busy ? " opacity-70" : ""}`}
      accessibilityRole="button"
      accessibilityLabel="Open in Shogo IDE"
      accessibilityState={{ disabled: busy, busy }}
    >
      <ExternalLink size={14} className="text-orange-400" />
      <Text className="text-xs font-semibold text-orange-400">{codeWorkbenchButtonLabel(status, wide)}</Text>
    </Pressable>
  );
}
