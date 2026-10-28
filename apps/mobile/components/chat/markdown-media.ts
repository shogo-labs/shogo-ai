// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Where a markdown image or video in a rendered message loads from.
 *
 * Stored chat and channel files carry signed URLs and load anywhere. A
 * workspace path (rewritten to `IMAGE_SRC_PREFIX` by `rewriteWorkspaceMedia`)
 * loads from the live agent, which needs the chat's agent URL and an
 * authenticated fetch.
 */
import { useEffect, useState } from "react"
import { Platform } from "react-native"
import { agentFetch } from "../../lib/agent-fetch"
import { buildAgentWorkspaceUrl } from "../../lib/agent-workspace-url"
import { resolveChatAttachmentUrl } from "../../lib/chat-attachment-url"
import { useAgentImageSource } from "../../lib/agent-image-source"
import { useChatContextSafe } from "./ChatContext"
import { isVideoSrc, normalizeWorkspaceMediaPath, pathFromImageSrc } from "./file-links"

export interface MarkdownMediaTarget {
  /** Null when a workspace file can't be reached from here (no agent URL). */
  url: string | null
  kind: "image" | "video"
  /** Alt text, or the file name when the agent left alt empty. */
  label: string
  /** Workspace download URLs need an authenticated fetch. */
  fromWorkspace: boolean
}

function fileName(value: string): string {
  const clean = value.split(/[?#]/)[0] ?? value
  const name = clean.split("/").filter(Boolean).pop() ?? clean
  try {
    return decodeURIComponent(name)
  } catch {
    return name
  }
}

export function resolveMarkdownMedia(
  src: string | null | undefined,
  alt: string | null | undefined,
  agentUrl: string | null | undefined,
): MarkdownMediaTarget {
  const raw = typeof src === "string" ? src : ""
  const workspacePath = pathFromImageSrc(raw)
  const pathForType = workspacePath ?? raw
  const label = alt?.trim() || fileName(pathForType) || "Image"
  const kind = isVideoSrc(pathForType) ? "video" : "image"
  if (workspacePath) {
    const relPath = normalizeWorkspaceMediaPath(workspacePath)
    return {
      url: agentUrl && relPath ? buildAgentWorkspaceUrl(agentUrl, relPath) : null,
      kind,
      label,
      fromWorkspace: true,
    }
  }
  return { url: raw ? resolveChatAttachmentUrl(raw) : null, kind, label, fromWorkspace: false }
}

/**
 * `agentUrlOverride` lets callers outside a ChatContext (e.g. the workspace
 * file viewer) resolve workspace media against their own agent URL.
 */
export function useMarkdownMedia(
  src: string | null | undefined,
  alt: string | null | undefined,
  agentUrlOverride?: string | null,
): MarkdownMediaTarget {
  const contextAgentUrl = useChatContextSafe()?.agentUrl ?? null
  return resolveMarkdownMedia(src, alt, agentUrlOverride ?? contextAgentUrl)
}

/** Image URI ready for `<img>` / `<Image>`; null while loading. */
export function useMarkdownImageUri(target: MarkdownMediaTarget): string | null {
  const source = useAgentImageSource(target.kind === "image" ? target.url : null)
  return source?.uri ?? null
}

/**
 * Video URL ready for `<video>`. Workspace videos are fetched with the
 * session and handed over as a blob URL, since `<video>` can't attach the
 * credential cross-origin. Returns `failed` when the fetch fails.
 */
export function useMarkdownVideoUrl(target: MarkdownMediaTarget): { url: string | null; failed: boolean } {
  const needsFetch = target.kind === "video" && target.fromWorkspace && Platform.OS === "web"
  const [state, setState] = useState<{ url: string | null; failed: boolean }>(() => ({
    url: needsFetch ? null : target.url,
    failed: false,
  }))

  useEffect(() => {
    if (!needsFetch || !target.url) {
      setState({ url: target.kind === "video" ? target.url : null, failed: false })
      return
    }
    let cancelled = false
    let objectUrl: string | null = null
    setState({ url: null, failed: false })
    void agentFetch(target.url)
      .then(async (response) => {
        if (!response.ok) throw new Error(`Video request failed (${response.status})`)
        const blob = await response.blob()
        if (cancelled) return
        objectUrl = URL.createObjectURL(blob)
        setState({ url: objectUrl, failed: false })
      })
      .catch(() => {
        if (!cancelled) setState({ url: null, failed: true })
      })
    return () => {
      cancelled = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [needsFetch, target.kind, target.url])

  return state
}
