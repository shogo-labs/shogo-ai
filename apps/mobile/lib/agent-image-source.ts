// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { useEffect, useState } from "react"
import { Platform, type ImageURISource } from "react-native"
import { authClient } from "./auth-client"
import { agentFetch } from "./agent-fetch"
import { createAgentImageSource as createCoreAgentImageSource } from "./agent-image-source-core"

/**
 * React Native Image does not use the native fetch cookie jar. Attach the
 * Better Auth session explicitly on iOS and Android while leaving web to its
 * normal credentialed request behavior.
 */
export function createAgentImageSource(
  uri: string,
  platform: string,
  cookie?: string | null,
): ImageURISource {
  return createCoreAgentImageSource(uri, platform, cookie)
}

export function getAgentImageSource(uri: string): ImageURISource {
  return createAgentImageSource(
    uri,
    Platform.OS,
    (authClient as any).getCookie?.(),
  )
}

function isWorkspaceDownloadUrl(uri: string): boolean {
  return uri.includes("/agent/workspace/download/")
}

export function useAgentImageSource(uri: string | null): ImageURISource | null {
  const [source, setSource] = useState<ImageURISource | null>(() =>
    uri && !isWorkspaceDownloadUrl(uri) ? getAgentImageSource(uri) : null,
  )

  useEffect(() => {
    let cancelled = false
    if (!uri) {
      setSource(null)
      return () => {
        cancelled = true
      }
    }

    const directSource = getAgentImageSource(uri)
    if (!isWorkspaceDownloadUrl(uri)) {
      setSource(directSource)
      return () => {
        cancelled = true
      }
    }

    // Protected workspace images need an authenticated fetch before they are
    // handed to Image. <img> does not reliably send cross-origin session
    // cookies on web, and native Image implementations differ in Cookie
    // header support.
    setSource(null)
    void agentFetch(uri)
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`Image request failed (${response.status})`)
        }
        const buffer = await response.arrayBuffer()
        const bytes = new Uint8Array(buffer)
        let binary = ""
        for (let index = 0; index < bytes.length; index += 0x8000) {
          binary += String.fromCharCode(
            ...bytes.subarray(index, index + 0x8000),
          )
        }
        return `data:${response.headers.get("content-type") || "image/png"};base64,${btoa(binary)}`
      })
      .then((dataUri) => {
        if (!cancelled) setSource({ uri: dataUri })
      })
      .catch(() => {
        if (!cancelled) setSource(directSource)
      })

    return () => {
      cancelled = true
    }
  }, [uri])

  return source
}
