// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import React from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { CircleAlert, RefreshCw, Server, Wifi } from "lucide-react-native";
import { cn } from "@shogo/shared-ui/primitives";

export type RemoteConnectionState =
  "connected" | "connecting" | "disconnected" | string;

export interface RemoteHostIndicatorProps {
  label: string;
  state: RemoteConnectionState;
  onReconnect?: () => void;
  reconnecting?: boolean;
  compact?: boolean;
}

function stateLabel(state: RemoteConnectionState): string {
  if (state === "connected") return "Connected";
  if (state === "connecting") return "Connecting…";
  if (state === "disconnected") return "Disconnected";
  return state ? state.charAt(0).toUpperCase() + state.slice(1) : "Unknown";
}

export function RemoteHostIndicator({
  label,
  state,
  onReconnect,
  reconnecting = false,
  compact = false,
}: RemoteHostIndicatorProps) {
  const connected = state === "connected";
  const connecting = reconnecting || state === "connecting";
  const Icon = connected ? Wifi : CircleAlert;
  const canReconnect = !!onReconnect && !connecting;

  return (
    <Pressable
      onPress={canReconnect ? onReconnect : undefined}
      disabled={!canReconnect}
      className={cn(
        "flex-row items-center gap-1.5 rounded-md border px-2 active:bg-muted",
        compact ? "h-7 max-w-[130px]" : "h-7 max-w-[230px]",
        connected
          ? "border-emerald-500/30 bg-emerald-500/10"
          : "border-amber-500/30 bg-amber-500/10",
        !canReconnect && "opacity-80",
      )}
      accessibilityRole="button"
      accessibilityLabel={
        canReconnect
          ? `${label}. ${stateLabel(state)}. Reconnect`
          : `${label}. ${stateLabel(state)}`
      }
      testID="remote-host-indicator"
    >
      {connecting ? (
        <ActivityIndicator size="small" />
      ) : (
        <Icon
          size={13}
          className={connected ? "text-emerald-600" : "text-amber-600"}
        />
      )}
      <View className="min-w-0 flex-1">
        <Text
          className={cn(
            "text-[10px] font-medium",
            connected ? "text-emerald-700" : "text-amber-700",
          )}
          numberOfLines={1}
          ellipsizeMode="tail"
        >
          {label}
        </Text>
        <Text
          className={cn(
            "text-[9px]",
            connected ? "text-emerald-700/80" : "text-amber-700/80",
          )}
          numberOfLines={1}
        >
          {stateLabel(state)}
        </Text>
      </View>
      {onReconnect && <RefreshCw size={11} className="text-amber-700" />}
      {!canReconnect && !connected && !connecting ? (
        <Server size={11} className="text-amber-700/70" />
      ) : null}
    </Pressable>
  );
}
