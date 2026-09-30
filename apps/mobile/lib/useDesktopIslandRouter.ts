// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { useEffect } from "react"
import { useRouter } from "expo-router"

import { setDesktopIslandNavigator } from "./desktop-island"

/** Mount once at the app root so island actions can reach projects that
 * aren't open in this window. */
export function useDesktopIslandRouter(): void {
  const router = useRouter()

  useEffect(() => {
    setDesktopIslandNavigator((navigation) => {
      const params =
        "sessionId" in navigation
          ? { id: navigation.projectId, chatSessionId: navigation.sessionId }
          : { id: navigation.projectId, newChat: "1", newChatNonce: String(Date.now()) }
      try {
        router.push({ pathname: "/(app)/projects/[id]", params } as any)
      } catch {
        // ignore routing errors
      }
    })
    return () => setDesktopIslandNavigator(null)
  }, [router])
}
