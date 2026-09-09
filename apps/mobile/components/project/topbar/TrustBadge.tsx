// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import React, { useEffect, useRef } from "react";
import { Platform, Pressable, Text, View } from "react-native";
import { ShieldAlert, ShieldCheck } from "lucide-react-native";
import { cn } from "@shogo/shared-ui/primitives";

function useWebTitle(title?: string) {
  const ref = useRef<View>(null);
  useEffect(() => {
    if (Platform.OS === "web" && ref.current) {
      (ref.current as unknown as HTMLElement).title = title ?? "";
    }
  }, [title]);
  return ref;
}

/**
 * Persistent Workspace Trust badge for external (folder-linked) projects.
 * Restricted → amber shield + "Restricted"; trusted → emerald shield +
 * "Trusted". Tapping flips the trust level via `onToggle`.
 */
export function TrustBadge({
  trustLevel,
  onToggle,
  busy,
  compact,
}: {
  trustLevel: "restricted" | "trusted";
  onToggle: () => void;
  busy?: boolean;
  compact?: boolean;
}) {
  const restricted = trustLevel === "restricted";
  const Icon = restricted ? ShieldAlert : ShieldCheck;
  const label = restricted ? "Restricted" : "Trusted";
  const tip = restricted
    ? "Workspace is restricted — tap to trust this folder (enables edits and shell)"
    : "Workspace is trusted — tap to restrict (blocks edits and shell)";
  const tipRef = useWebTitle(tip);

  if (compact) {
    return (
      <Pressable
        ref={tipRef}
        onPress={onToggle}
        disabled={busy}
        className={cn(
          "h-6 w-6 items-center justify-center rounded-md",
          busy ? "opacity-60" : "active:bg-muted",
        )}
        accessibilityLabel={tip}
      >
        <Icon
          size={13}
          className={restricted ? "text-amber-500" : "text-emerald-500"}
        />
      </Pressable>
    );
  }

  return (
    <Pressable
      ref={tipRef}
      onPress={onToggle}
      disabled={busy}
      className={cn(
        "h-7 flex-row items-center gap-1 px-2 rounded-md border",
        restricted ? "border-amber-400/50" : "border-emerald-400/40",
        busy ? "opacity-60" : "active:bg-muted",
      )}
      accessibilityLabel={tip}
    >
      <Icon
        size={12}
        className={restricted ? "text-amber-500" : "text-emerald-500"}
      />
      <Text
        className={cn(
          "text-[10px] font-medium",
          restricted
            ? "text-amber-600 dark:text-amber-400"
            : "text-emerald-600 dark:text-emerald-400",
        )}
      >
        {label}
      </Text>
    </Pressable>
  );
}
