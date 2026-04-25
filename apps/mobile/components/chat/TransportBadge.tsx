// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * TransportBadge
 *
 * Small inline pill that tells the user where a given tool call actually
 * executed: on Shogo Cloud (☁) or on their paired worker machine (🖥).
 *
 * Default behaviour: render NOTHING when no machine is selected. 99%+ of
 * sessions today use Cloud-only and do not need a badge.
 *
 * Callers:
 *  - ToolCallDisplay    (chat technical-agent tool renderer)
 *  - ToolPill           (collapsed toolbar summary)
 *  - ToolCallGroup      (grouped tool card header)
 *
 * Routing decisions are made by `chooseMcpHost()` in
 * `packages/agent-runtime/src/lib/mcp-transport-routing.ts`. This component
 * is purely presentational; it reads `useActiveInstance()` and accepts an
 * optional `host` override for cases where the caller already knows the
 * routing decision (e.g. HTTP MCP pinned to cloud even with an instance).
 */
import { View, Text } from "react-native"
import { Cloud, Laptop } from "lucide-react-native"
import { cn } from "@shogo/shared-ui/primitives"
import { useActiveInstance } from "../../contexts/active-instance"

export type TransportHost = "cloud" | "worker"

export interface TransportBadgeProps {
  /**
   * Explicit host override. If omitted, the badge reflects the active
   * instance from `useActiveInstance()`: worker when set, cloud otherwise.
   */
  host?: TransportHost
  /**
   * When true the badge renders for Cloud too. Default false keeps the UI
   * quiet for the 99% common case (no machine selected).
   */
  showWhenCloud?: boolean
  size?: "xs" | "sm"
  className?: string
}

export function TransportBadge({
  host,
  showWhenCloud = false,
  size = "xs",
  className,
}: TransportBadgeProps) {
  const { instance } = useActiveInstance()
  const resolved: TransportHost = host ?? (instance ? "worker" : "cloud")

  if (resolved === "cloud" && !showWhenCloud) return null

  const isWorker = resolved === "worker"
  const label = isWorker ? instance?.name ?? "machine" : "Cloud"

  const iconSize = size === "xs" ? 9 : 10
  const textSize = size === "xs" ? "text-[9px]" : "text-[10px]"
  const padding = size === "xs" ? "px-1 py-px" : "px-1.5 py-0.5"

  return (
    <View
      className={cn(
        "flex-row items-center gap-0.5 rounded-full",
        padding,
        isWorker
          ? "bg-emerald-500/15 border border-emerald-400/30"
          : "bg-muted/60 border border-border/40",
        className,
      )}
      accessibilityLabel={isWorker ? `Runs on ${label}` : "Runs on Shogo Cloud"}
    >
      {isWorker ? (
        <Laptop
          className="text-emerald-600"
          size={iconSize}
        />
      ) : (
        <Cloud
          className="text-muted-foreground"
          size={iconSize}
        />
      )}
      <Text
        className={cn(
          textSize,
          "font-medium",
          isWorker ? "text-emerald-700" : "text-muted-foreground",
        )}
        numberOfLines={1}
      >
        {label}
      </Text>
    </View>
  )
}

export default TransportBadge
