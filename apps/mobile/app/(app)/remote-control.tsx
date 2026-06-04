// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { useEffect } from 'react'
import { useRouter } from 'expo-router'

/**
 * Legacy /remote-control route — redirects to Settings > Remote Control tab.
 * Kept as a redirect so existing bookmarks and links still work.
 */
export default function RemoteControlRedirect() {
  const router = useRouter()

  useEffect(() => {
    router.replace('/(app)/settings?tab=remote-control' as any)
  }, [router])

  return null
}
