// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * EnvironmentPicker
 *
 * Popover-based selector (drop-in twin of the model picker in CompactChatInput)
 * that lets the user choose where an agent session runs:
 *
 *   ☁️ Shogo Cloud         — default. agent runs in a cloud pod.
 *   🖥️ <instance name>     — routes all agent traffic through the Remote
 *                            Control tunnel to that paired machine
 *                            (Phase 1 / shogo-worker + desktop app).
 *
 * No new server endpoint, no new context — reuses:
 *   - useActiveInstance()    (`packages/shared-app/src/hooks/useActiveInstance.tsx`)
 *   - useInstancePicker()    (`packages/shared-app/src/hooks/useInstancePicker.ts`)
 *
 * When an instance is selected, `apps/mobile/app/(app)/projects/[id]/_layout.tsx`
 * already rewrites `agentUrl` through `${apiUrl}/api/instances/:id/p/...`,
 * so the chat + canvas + SSE streams all follow automatically.
 */
import { useState, useMemo } from "react"
import { View, Text, Pressable, ScrollView, Platform } from "react-native"
import { Cloud, Laptop, ChevronDown, Check, RefreshCw } from "lucide-react-native"
import {
  Popover,
  PopoverBackdrop,
  PopoverContent,
} from "@/components/ui/popover"
import { cn } from "@shogo/shared-ui/primitives"
import { useActiveInstance } from "../../contexts/active-instance"
import { useInstancePicker, type Instance } from "@shogo/shared-app/hooks"
import { useActiveWorkspace } from "../../hooks/useActiveWorkspace"
import { API_URL } from "../../lib/api"
import { authClient } from "../../lib/auth-client"
import { usePlatformConfig } from "../../lib/platform-config"

function getAuthHeaders(): Record<string, string> {
  if (Platform.OS === "web") return {}
  const cookie = (authClient as any).getCookie?.()
  return cookie ? { Cookie: cookie } : {}
}

function StatusDot({ status }: { status: Instance["status"] }) {
  const color =
    status === "online"
      ? "bg-green-500"
      : status === "heartbeat"
      ? "bg-yellow-500"
      : "bg-muted-foreground/40"
  return <View className={cn("h-2 w-2 rounded-full", color)} />
}

export interface EnvironmentPickerProps {
  disabled?: boolean
}

export function EnvironmentPicker({ disabled }: EnvironmentPickerProps) {
  const [open, setOpen] = useState(false)
  const { localMode } = usePlatformConfig()
  const workspace = useActiveWorkspace()
  const { instance: activeInstance, setInstance, clearInstance } = useActiveInstance()

  const fetchOptions: RequestInit = useMemo(
    () => ({
      credentials: Platform.OS === "web" ? ("include" as const) : ("omit" as const),
      headers: { ...getAuthHeaders() },
    }),
    [],
  )

  const { instances, loading, connecting, select, disconnect, refresh } = useInstancePicker({
    workspaceId: workspace?.id,
    apiUrl: API_URL ?? "",
    activeInstance,
    setInstance,
    clearInstance,
    fetchOptions,
  })

  const displayLabel = activeInstance ? activeInstance.name : "Cloud"
  const triggerIcon = activeInstance
    ? <Laptop className="h-3 w-3 text-emerald-500" size={12} />
    : <Cloud className="h-3 w-3 text-muted-foreground/80" size={12} />

  if (localMode) {
    return (
      <View className="h-[22px] flex-row items-center gap-1 rounded-md px-1.5">
        <Laptop className="h-3 w-3 text-muted-foreground/80" size={12} />
        <Text className="text-xs text-muted-foreground">Local</Text>
      </View>
    )
  }

  return (
    <Popover
      placement="top"
      size="xs"
      isOpen={open}
      onOpen={() => { setOpen(true); refresh() }}
      onClose={() => setOpen(false)}
      trigger={(triggerProps) => (
        <Pressable
          {...triggerProps}
          disabled={disabled}
          accessibilityLabel="Select execution environment"
          className="h-[22px] flex-row items-center gap-1 rounded-md px-1.5"
        >
          {triggerIcon}
          <Text className={cn(
            "text-xs",
            activeInstance ? "text-emerald-600" : "text-muted-foreground"
          )}>
            {displayLabel}
          </Text>
          <ChevronDown className="h-2 w-2 text-muted-foreground/60" size={8} />
        </Pressable>
      )}
    >
      <PopoverBackdrop />
      <PopoverContent className="w-[280px] p-0 max-h-[360px]">
        <ScrollView>
          <View className="px-3 pt-3 pb-1 flex-row items-center justify-between">
            <Text className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
              Run Agent On
            </Text>
            <Pressable
              onPress={() => refresh()}
              accessibilityLabel="Refresh instances"
              className="h-5 w-5 items-center justify-center rounded hover:bg-muted/40"
            >
              <RefreshCw
                className={cn("h-3 w-3 text-muted-foreground", loading && "animate-spin")}
                size={10}
              />
            </Pressable>
          </View>

          {/* Shogo Cloud — default */}
          <Pressable
            onPress={() => {
              clearInstance()
              setOpen(false)
            }}
            className="flex-row items-center gap-2.5 px-3 py-2.5 active:bg-muted/60"
          >
            <Cloud className="h-4 w-4 text-foreground" size={16} />
            <View className="flex-1">
              <Text className="text-sm font-medium text-foreground">Shogo Cloud</Text>
              <Text className="text-[10px] text-muted-foreground">Default · managed runtime</Text>
            </View>
            {!activeInstance && <Check className="h-4 w-4 text-primary" size={16} />}
          </Pressable>

          <View className="h-px bg-border/50 mx-2" />

          {/* Paired machines */}
          <View className="px-3 pt-2.5 pb-1">
            <Text className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
              My Machines
            </Text>
          </View>

          {loading && instances.length === 0 && (
            <View className="px-3 py-4">
              <Text className="text-xs text-muted-foreground">Loading…</Text>
            </View>
          )}

          {!loading && instances.length === 0 && (
            <View className="px-3 py-3">
              <Text className="text-xs text-muted-foreground leading-relaxed">
                No paired machines. Run{" "}
                <Text className="font-mono text-foreground">shogo worker start</Text>{" "}
                on a machine to add one.
              </Text>
            </View>
          )}

          {instances.map((inst) => {
            const isActive = activeInstance?.instanceId === inst.id
            const isConnecting = connecting === inst.id
            const selectable = inst.status === "online" || isConnecting
            return (
              <Pressable
                key={inst.id}
                disabled={!selectable}
                onPress={async () => {
                  await select(inst)
                  setOpen(false)
                }}
                className={cn(
                  "flex-row items-center gap-2.5 px-3 py-2.5 active:bg-muted/60",
                  !selectable && "opacity-60",
                )}
              >
                <StatusDot status={inst.status} />
                <View className="flex-1">
                  <Text className={cn(
                    "text-sm font-medium",
                    selectable ? "text-foreground" : "text-muted-foreground",
                  )}>
                    {inst.name}
                  </Text>
                  <Text className="text-[10px] text-muted-foreground">
                    {inst.hostname}
                    {inst.os && ` · ${inst.os}`}
                                    {inst.status !== "online" && (
                      <Text className="text-amber-600">  · {inst.status}</Text>
                    )}
                  </Text>
                </View>
                {isConnecting && (
                  <Text className="text-[10px] text-muted-foreground">connecting…</Text>
                )}
                {isActive && <Check className="h-4 w-4 text-primary" size={16} />}
              </Pressable>
            )
          })}

          {activeInstance && (
            <>
              <View className="h-px bg-border/50 mx-2 mt-1" />
              <Pressable
                onPress={() => {
                  disconnect()
                  setOpen(false)
                }}
                className="px-3 py-2.5 active:bg-muted/60"
              >
                <Text className="text-xs text-destructive font-medium">
                  Disconnect · fall back to Cloud
                </Text>
              </Pressable>
            </>
          )}
        </ScrollView>
      </PopoverContent>
    </Popover>
  )
}
