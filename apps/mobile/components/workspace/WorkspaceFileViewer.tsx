// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Read-only view of a file the workspace agent mentioned in chat. Opens in
 * the workspace screen's side pane (a sheet on phones), reads through the
 * workspace agent proxy, and reuses the IDE previews and chat markdown.
 */
import { useEffect, useMemo, useState, type ReactNode } from "react"
import { ActivityIndicator, Platform, Pressable, ScrollView, Text, View } from "react-native"
import * as Clipboard from "expo-clipboard"
import { AgentClient } from "@shogo-ai/sdk/agent"
import { Copy, Check, X } from "lucide-react-native"
import { agentFetch } from "../../lib/agent-fetch"
import { useResolvedTheme } from "../../contexts/theme"
import { FileTypeIcon } from "../chat/FileTypeIcon"
import { MarkdownMediaNative } from "../chat/MarkdownMediaNative"
import { imageSrcHref } from "../chat/file-links"
import { DownloadChip } from "../chat/turns/DownloadChip"
import { FileContentView, viewerPathKey } from "../files/FileContentView"
import { fileViewKind, type FileViewKind } from "../files/file-view-kind"
import { isPreviewLanguage } from "../project/panels/ide/FilePreview"

/** Text past this many characters is cut off, with a note and a download. */
const MAX_TEXT_CHARS = 500_000

export interface WorkspaceFileViewerProps {
  /** Workspace agent proxy URL; paths are workspace-relative. */
  agentUrl: string | null
  /** Raw path as the assistant wrote it, already normalized. */
  path: string
  /** Changes when the same path is opened again, so the file reloads. */
  nonce: number
  onClose: () => void
}

type ViewState =
  | { status: "loading" }
  | { status: "text"; kind: "text" | "markdown"; text: string; truncated: boolean }
  | { status: "preview"; kind: FileViewKind; url: string }
  | { status: "native-image" }
  | { status: "unavailable" }
  | { status: "missing" }
  | { status: "error"; message: string }

function basename(path: string): string {
  return path.split("/").filter(Boolean).pop() ?? path
}

function capText(text: string): { text: string; truncated: boolean } {
  return text.length > MAX_TEXT_CHARS
    ? { text: text.slice(0, MAX_TEXT_CHARS), truncated: true }
    : { text, truncated: false }
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && /\b404\b/.test(error.message)
}

export function WorkspaceFileViewer({ agentUrl, path, nonce, onClose }: WorkspaceFileViewerProps) {
  const client = useMemo(
    () =>
      agentUrl
        ? new AgentClient({ baseUrl: agentUrl, fetch: agentFetch as typeof fetch })
        : null,
    [agentUrl],
  )
  const isDark = useResolvedTheme() === "dark"
  const name = basename(path)
  const [state, setState] = useState<ViewState>({ status: "loading" })
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!client) {
      setState({ status: "error", message: "The workspace agent is not reachable." })
      return
    }
    let cancelled = false
    let objectUrl: string | null = null
    setState({ status: "loading" })

    const fail = (error: unknown) => {
      if (cancelled) return
      setState(
        isNotFound(error)
          ? { status: "missing" }
          : { status: "error", message: error instanceof Error ? error.message : "Could not open this file." },
      )
    }

    const kind = fileViewKind(path)
    if (Platform.OS === "web" && isPreviewLanguage(kind)) {
      client
        .readFileBlob(path)
        .then((blob) => {
          if (cancelled) return
          objectUrl = URL.createObjectURL(blob)
          setState({ status: "preview", kind, url: objectUrl })
        })
        .catch(fail)
    } else if (Platform.OS !== "web" && kind === "image") {
      setState({ status: "native-image" })
    } else if (kind === "markdown" || kind === "text") {
      client
        .readFile(path)
        .then((text) => {
          if (!cancelled) setState({ status: "text", kind, ...capText(text) })
        })
        .catch(fail)
    } else {
      setState({ status: "unavailable" })
    }

    return () => {
      cancelled = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [client, path, nonce])

  const copyPath = async () => {
    try {
      await Clipboard.setStringAsync(path)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // Clipboard is best-effort.
    }
  }

  return (
    <View className="min-h-0 flex-1 bg-background" testID="workspace-file-viewer">
      <View className="flex-row items-center gap-2 border-b border-border px-3 py-2">
        <FileTypeIcon path={path} size={16} />
        <Text className="min-w-0 flex-1 text-sm font-medium text-foreground" numberOfLines={1}>
          {path}
        </Text>
        <DownloadChip path={path} agentUrl={agentUrl} />
        <Pressable
          onPress={copyPath}
          accessibilityRole="button"
          accessibilityLabel={copied ? "Path copied" : "Copy path"}
          className="h-8 w-8 items-center justify-center rounded-md active:bg-muted"
        >
          {copied ? (
            <Check size={15} className="text-muted-foreground" />
          ) : (
            <Copy size={15} className="text-muted-foreground" />
          )}
        </Pressable>
        <Pressable
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel="Close file"
          className="h-8 w-8 items-center justify-center rounded-md active:bg-muted"
        >
          <X size={16} className="text-muted-foreground" />
        </Pressable>
      </View>

      <Body state={state} path={path} name={name} agentUrl={agentUrl} isDark={isDark} />
    </View>
  )
}

function Body({
  state,
  path,
  name,
  agentUrl,
  isDark,
}: {
  state: ViewState
  path: string
  name: string
  agentUrl: string | null
  isDark: boolean
}) {
  switch (state.status) {
    case "loading":
      return (
        <View className="flex-1 items-center justify-center gap-2" testID="workspace-file-loading">
          <ActivityIndicator />
          <Text className="text-xs text-muted-foreground">Loading {name}…</Text>
        </View>
      )
    case "missing":
      return (
        <Centered testID="workspace-file-missing">
          <Text className="text-sm font-medium text-foreground">File not found</Text>
          <Text className="text-xs text-muted-foreground">{path}</Text>
        </Centered>
      )
    case "error":
      return (
        <Centered testID="workspace-file-error">
          <Text className="text-sm text-destructive">{state.message}</Text>
        </Centered>
      )
    case "unavailable":
      return (
        <Centered testID="workspace-file-unavailable">
          <Text className="text-xs text-muted-foreground">Preview not available for this file type.</Text>
          <DownloadChip path={path} agentUrl={agentUrl} />
        </Centered>
      )
    case "native-image":
      return (
        <ScrollView className="flex-1 px-3 py-3" contentContainerStyle={{ alignItems: "flex-start" }}>
          <MarkdownMediaNative src={imageSrcHref(path)} alt={name} agentUrl={agentUrl} />
        </ScrollView>
      )
    case "preview":
      return (
        <FileContentView
          kind={state.kind}
          url={state.url}
          name={name}
          path={path}
          readOnly
          themeMode={isDark ? "dark" : "light"}
          pathKey={viewerPathKey(path)}
          testID="workspace-file-preview"
        />
      )
    case "text":
      return (
        <View className="min-h-0 flex-1">
          <FileContentView
            kind={state.kind}
            text={state.text}
            name={name}
            path={path}
            readOnly
            themeMode={isDark ? "dark" : "light"}
            pathKey={viewerPathKey(path)}
            testID={state.kind === "markdown" ? "workspace-file-markdown" : "workspace-file-text"}
          />
          {state.truncated ? (
            <View className="px-4 pb-3">
              <Truncated visible path={path} agentUrl={agentUrl} />
            </View>
          ) : null}
        </View>
      )
  }
}

function Centered({ children, testID }: { children: ReactNode; testID: string }) {
  return (
    <View className="flex-1 items-center justify-center gap-2 px-6" testID={testID}>
      {children}
    </View>
  )
}

function Truncated({ visible, path, agentUrl }: { visible: boolean; path: string; agentUrl: string | null }) {
  if (!visible) return null
  return (
    <View className="mt-3 gap-2">
      <Text className="text-xs text-muted-foreground">Showing the first part of this file.</Text>
      <DownloadChip path={path} agentUrl={agentUrl} />
    </View>
  )
}
