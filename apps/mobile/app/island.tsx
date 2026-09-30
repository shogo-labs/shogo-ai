// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Desktop island overlay. Loaded by apps/desktop/src/island-window.ts into a
 * transparent always-on-top window; talks to the main process through
 * `window.shogoIsland` and to the API like any other screen.
 */
import { useEffect, useRef } from "react"
import { Platform, Pressable, Text, View } from "react-native"
import { observer } from "mobx-react-lite"
import { useAuth } from "../contexts/auth"
import { DomainProvider, useWorkspaceCollection } from "../contexts/domain"
import { useActiveWorkspace } from "../hooks/useActiveWorkspace"
import { usePlatformConfig } from "../lib/platform-config"
import { API_URL } from "../lib/api"
import { IslandApp } from "../components/island/IslandApp"
import { useIslandBridge } from "../components/island/useIslandBridge"
import { useIslandPointer } from "../components/island/useIslandPointer"
import { ISLAND_SURFACE_PROPS, ISLAND_TRIGGER_PROPS, getIslandBridge } from "../components/island/types"

const SIGNED_OUT_RETRY_MS = 15_000

/** The overlay window is transparent, but the page and every navigator
 * container above this route paint an opaque background (react-navigation's
 * theme background is applied by the stack itself, not the screen's
 * `contentStyle`). Clear them all, up from the route's root. */
function useTransparentPage(root: React.RefObject<View | null>, enabled: boolean) {
  useEffect(() => {
    if (!enabled || Platform.OS !== "web" || typeof document === "undefined") return
    let el = root.current as unknown as HTMLElement | null
    while (el) {
      el.style.backgroundColor = "transparent"
      el.style.backgroundImage = "none"
      el = el.parentElement
    }
    document.body.style.overflow = "hidden"
  }, [root, enabled])
}

function SignedOutIsland() {
  const { bridge, layout, requestMode } = useIslandBridge()
  const { refreshSession } = useAuth()
  const { localMode } = usePlatformConfig()
  useIslandPointer({ bridge, mode: layout.mode, requestMode, canAutoCollapse: () => true })

  useEffect(() => {
    const retry = () => {
      const signIn = localMode
        ? fetch(`${API_URL}/api/local/auto-sign-in`, { method: "POST", credentials: "include" }).catch(
            () => undefined,
          )
        : Promise.resolve()
      void signIn.then(() => refreshSession())
    }
    retry()
    const timer = setInterval(retry, SIGNED_OUT_RETRY_MS)
    return () => clearInterval(timer)
  }, [localMode, refreshSession])

  if (!bridge) return null
  if (layout.mode === "hidden") {
    return <View {...ISLAND_TRIGGER_PROPS} style={{ width: "100%", height: "100%" }} />
  }
  return (
    <View
      {...(layout.mode === "collapsed" ? ISLAND_TRIGGER_PROPS : ISLAND_SURFACE_PROPS)}
      onLayout={(event) => bridge.setContentHeight(event.nativeEvent.layout.height)}
      className="w-full flex-row items-center justify-between gap-3 rounded-b-[18px] bg-black px-4"
      style={{ paddingTop: layout.notched ? layout.topInset : 10, paddingBottom: 10 }}
    >
      <Text className="text-[12px] text-zinc-300">Sign in to Shogo to use the island</Text>
      <Pressable
        onPress={() => void bridge.sendAction({ type: "navigate", path: "/sign-in" })}
        className="rounded-lg bg-white/10 px-3 py-1.5"
      >
        <Text className="text-[12px] font-semibold text-zinc-50">Open Shogo</Text>
      </Pressable>
    </View>
  )
}

const SignedInIsland = observer(function SignedInIsland() {
  const { user } = useAuth()
  const workspaces = useWorkspaceCollection()
  const workspace = useActiveWorkspace()

  useEffect(() => {
    void workspaces.loadAll().catch(() => undefined)
  }, [workspaces])

  return <IslandApp workspaceId={workspace?.id} userId={user?.id} />
})

function IslandContent() {
  const { isAuthenticated, isLoading } = useAuth()
  if (isLoading) return null
  if (!isAuthenticated) return <SignedOutIsland />
  return (
    <DomainProvider>
      <SignedInIsland />
    </DomainProvider>
  )
}

export default function IslandRoute() {
  const root = useRef<View>(null)
  const inIsland = !!getIslandBridge()
  useTransparentPage(root, inIsland)

  if (!inIsland) {
    return (
      <View className="flex-1 items-center justify-center bg-background">
        <Text className="text-sm text-muted-foreground">The island only runs in Shogo Desktop.</Text>
      </View>
    )
  }
  return (
    <View ref={root} style={{ flex: 1, backgroundColor: "transparent" }}>
      <IslandContent />
    </View>
  )
}
