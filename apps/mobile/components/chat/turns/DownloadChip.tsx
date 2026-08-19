// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * DownloadChip
 *
 * A small "Download <file>" affordance rendered under a deliverable tool
 * result (see `isDeliverable`). It reuses the authenticated agent-proxy path
 * (`{agentUrl}/agent/workspace/download/<path>`) — the same URL construction
 * `GenerateImageWidget` uses for previews — so no new agent tool or presigned
 * S3 URL is required.
 *
 *   - Web/desktop: a normal anchor download (browser sends session cookies).
 *   - Native (iOS/Android): fetch with auth via `agentFetch`, persist to app
 *     storage, then present the share sheet via `expo-sharing`.
 */

import { useCallback, useState } from "react"
import {
  View,
  Text,
  Pressable,
  ActivityIndicator,
  Platform,
  InteractionManager,
} from "react-native"
import { cn } from "@shogo/shared-ui/primitives"
import { Download } from "lucide-react-native"
import { agentFetch, getNativeAgentAuthHeaders } from "../../../lib/agent-fetch"

export interface DownloadChipProps {
  /** Workspace-relative path of the deliverable file (e.g. `report.pptx`). */
  path: string
  /** Agent proxy base URL (`chatContext.agentUrl`). */
  agentUrl?: string | null
  className?: string
}

function basename(path: string): string {
  return path.split(/[\\/]/).pop() || "download"
}

function buildDownloadUrl(agentUrl: string, path: string): string {
  const encoded = path
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/")
  return `${agentUrl.replace(/\/$/, "")}/agent/workspace/download/${encoded}`
}

export function DownloadChip({ path, agentUrl, className }: DownloadChipProps) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const name = basename(path)
  const url = agentUrl ? buildDownloadUrl(agentUrl, path) : null

  const handlePress = useCallback(async () => {
    if (!url || busy) return
    setError(null)

    if (Platform.OS === "web") {
      if (typeof document === "undefined") return
      const a = document.createElement("a")
      a.href = url
      a.download = name
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      return
    }

    // Native: stream to app storage with auth, then present share sheet.
    setBusy(true)
    try {
      const { cacheDirectory, downloadAsync } = await import(
        "expo-file-system/legacy"
      )
      const Sharing = await import("expo-sharing")
      const dir = cacheDirectory
      if (!dir) throw new Error("Could not access app storage")
      const fileUri = `${dir}${Date.now()}-${name}`
      const result = await downloadAsync(url, fileUri, {
        headers: getNativeAgentAuthHeaders(),
      })
      if (result.status < 200 || result.status >= 300) {
        throw new Error(`Download failed (${result.status})`)
      }

      // Let the active screen settle so the OS can present the share sheet.
      await new Promise<void>((resolve) => {
        InteractionManager.runAfterInteractions(() => resolve())
      })

      try {
        await Sharing.shareAsync(fileUri, { dialogTitle: `Download ${name}` })
      } catch (shareErr: unknown) {
        if (Platform.OS === "ios") {
          const { Share } = await import("react-native")
          await Share.share({ url: fileUri, title: name })
        } else {
          throw shareErr
        }
      }
    } catch (err: any) {
      setError(err?.message ?? "Download failed")
    } finally {
      setBusy(false)
    }
  }, [url, busy, name])

  if (!url) return null

  return (
    <View className={cn("px-2 pb-1.5", className)}>
      <Pressable
        onPress={handlePress}
        disabled={busy}
        className="flex-row items-center gap-1.5 self-start rounded-md border border-border bg-muted/40 px-2.5 py-1.5 active:opacity-70"
        accessibilityRole="button"
        accessibilityLabel={`Download ${name}`}
      >
        {busy ? (
          <ActivityIndicator size="small" />
        ) : (
          <Download size={12} className="text-foreground" />
        )}
        <Text
          className="text-[11px] font-medium text-foreground"
          numberOfLines={1}
        >
          {busy ? "Preparing…" : `Download ${name}`}
        </Text>
      </Pressable>
      {error ? (
        <Text className="mt-1 text-[10px] text-destructive">{error}</Text>
      ) : null}
    </View>
  )
}

export default DownloadChip
