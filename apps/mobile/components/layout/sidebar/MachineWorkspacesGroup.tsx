// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * "This Mac" — the workspaces of a paired desktop, inside the workspace
 * switcher (SHO-54).
 *
 * Presentational on purpose: the data comes from `useMachineWorkspaces`, so
 * every state (online, stale snapshot, offline) can be rendered and asserted
 * without a tunnel.
 */

import { Pressable, Text, View } from "react-native"
import { cn } from "@shogo/shared-ui/primitives"

export type MachinePresence = "online" | "heartbeat" | "offline"

export interface MachineWorkspaceRow {
  id: string
  name: string
  kind?: string
  projectCount?: number
  lastActivityAt?: string | null
}

export interface MachineGroupData {
  id: string
  name: string
  status: MachinePresence
  /** True when these rows are the machine's last-known snapshot, not live. */
  stale?: boolean
  lastSeenAt?: string | null
  workspaces: MachineWorkspaceRow[]
}

/** "just now" / "4 min ago" / "2 h ago" / "3 d ago" — the switcher's one-liner. */
export function relativeWhen(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return "no activity yet"
  const then = Date.parse(iso)
  if (Number.isNaN(then)) return "no activity yet"
  const seconds = Math.max(0, Math.round((now - then) / 1000))
  if (seconds < 60) return "just now"
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} h ago`
  const days = Math.round(hours / 24)
  return `${days} d ago`
}

export function machinePresenceLabel(machine: MachineGroupData): string {
  if (machine.status === "online") return "Online"
  if (machine.status === "heartbeat") return "Reconnecting"
  return machine.lastSeenAt ? `Offline · last seen ${relativeWhen(machine.lastSeenAt)}` : "Offline"
}

export interface MachineWorkspacesGroupProps {
  machines: MachineGroupData[]
  onOpen: (machine: MachineGroupData, workspace: MachineWorkspaceRow) => void
  /** Lean rail popover vs the full account popover. */
  compact?: boolean
}

export function MachineWorkspacesGroup({ machines, onOpen, compact = false }: MachineWorkspacesGroupProps) {
  if (machines.length === 0) return null

  return (
    <View className="py-1" accessibilityLabel="This Mac">
      <Text className="px-4 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        This Mac
      </Text>
      {machines.map((machine) => {
        const online = machine.status === "online"
        return (
          <View key={machine.id}>
            <View className="flex-row items-center gap-2 px-4 py-1">
              <View
                className={cn(
                  "items-center justify-center rounded bg-muted",
                  compact ? "h-4 w-4" : "h-5 w-5",
                )}
              >
                <Text className="text-[9px] font-semibold text-muted-foreground">
                  {machine.name?.[0]?.toUpperCase() ?? "M"}
                </Text>
              </View>
              <Text
                className={cn("flex-1 text-xs font-medium", online ? "text-foreground" : "text-muted-foreground")}
                numberOfLines={1}
              >
                {machine.name}
              </Text>
              <View
                className={cn("h-1.5 w-1.5 rounded-full", online ? "bg-primary" : "bg-muted-foreground/40")}
                accessibilityLabel={machinePresenceLabel(machine)}
              />
            </View>
            {machine.workspaces.map((workspace) => (
              <Pressable
                key={workspace.id}
                disabled={!online}
                onPress={() => onOpen(machine, workspace)}
                accessibilityLabel={`${workspace.name} on ${machine.name}`}
                accessibilityState={{ disabled: !online }}
                className={cn(
                  "flex-row items-center gap-2 px-4 active:bg-muted",
                  compact ? "py-1.5" : "py-2",
                  !online && "opacity-50",
                )}
              >
                <View className="flex-1 min-w-0">
                  <Text
                    className="text-sm text-foreground"
                    numberOfLines={1}
                  >
                    {workspace.name}
                  </Text>
                  <Text className="text-[10px] text-muted-foreground" numberOfLines={1}>
                    {workspace.projectCount ?? 0} {workspace.projectCount === 1 ? "project" : "projects"}
                    {" · "}
                    {relativeWhen(workspace.lastActivityAt)}
                  </Text>
                </View>
                {machine.stale && (
                  <Text className="text-[10px] text-muted-foreground">last known</Text>
                )}
              </Pressable>
            ))}
            {machine.status !== "online" && (
              <Text className="px-4 pb-1 text-[10px] text-muted-foreground">
                {machinePresenceLabel(machine)}
              </Text>
            )}
          </View>
        )
      })}
    </View>
  )
}
