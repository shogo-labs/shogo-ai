// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * In-app viewer for a file the API serves: a `share_file` link or a stored
 * chat attachment. One body, three hosts:
 *
 *   - `ShareFilePane`  the conversation's side pane (wide screens)
 *   - `ShareFileSheet` a modal (narrow screens, and everywhere without a pane)
 *
 * Nothing here navigates. The bytes come back through the app's own fetch, so
 * a dead link shows the API's `code` in words instead of raw JSON in a tab,
 * and the download action saves the blob it already has instead of re-opening
 * the URL.
 */

import { useCallback, useEffect, useMemo, useState } from "react"
import { ActivityIndicator, Modal, Platform, Pressable, ScrollView, Text, View } from "react-native"
import { Download, RotateCcw, X } from "lucide-react-native"
import { downloadAttachment } from "../../lib/attachment-download"
import { resolveChatAttachmentUrl } from "../../lib/chat-attachment-url"
import { shareFileErrorFromBody, shareFileErrorText, type InAppFileRef } from "../../lib/share-file-links"
import { FileTypeIcon } from "./FileTypeIcon"

export type ShareFileTarget = Pick<InAppFileRef, "href" | "name"> &
  Partial<Pick<InAppFileRef, "kind" | "path">>

type ViewerState =
  | { status: "loading" }
  | { status: "error"; code: string | null; text: string }
  | {
      status: "ready"
      /** `text` for text-ish files, `url` for an image/PDF preview, neither for a binary. */
      preview: { kind: "text"; text: string } | { kind: "image" | "pdf"; url: string } | { kind: "binary" }
      mime: string
      size: number
      /** Web only: the blob to save on a download click. */
      objectUrl: string | null
    }

const TEXT_EXTENSIONS = new Set([
  "txt", "md", "markdown", "json", "csv", "tsv", "log", "yml", "yaml", "xml", "html", "css",
  "js", "jsx", "ts", "tsx", "py", "sh", "sql", "toml", "ini", "env",
])

function extensionOf(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? ""
  const dot = base.lastIndexOf(".")
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : ""
}

function isTextish(mime: string, name: string): boolean {
  if (mime.startsWith("text/")) return true
  if (/json|javascript|xml|x-yaml|yaml|csv|x-sh|toml/i.test(mime)) return true
  return TEXT_EXTENSIONS.has(extensionOf(name))
}

function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return ""
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export interface ShareFileViewProps {
  target: ShareFileTarget
  onClose?: () => void
  /** True inside the conversation's side pane, where the pane draws its own edges. */
  embedded?: boolean
  className?: string
}

export function ShareFileView({ target, onClose, embedded = false, className }: ShareFileViewProps) {
  const [state, setState] = useState<ViewerState>({ status: "loading" })
  const [reloadKey, setReloadKey] = useState(0)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const source = useMemo(() => resolveChatAttachmentUrl(target.href), [target.href])

  useEffect(() => {
    let cancelled = false
    let objectUrl: string | null = null
    setState({ status: "loading" })
    setSaveError(null)

    const load = async () => {
      try {
        const response = await fetch(source, { credentials: "include" })
        if (!response.ok) {
          const body = await response.json().catch(() => null)
          const { code, message } = shareFileErrorFromBody(body)
          if (cancelled) return
          setState({
            status: "error",
            code: code ?? `http_${response.status}`,
            text: shareFileErrorText(code, message),
          })
          return
        }

        const mime = response.headers.get("content-type") || "application/octet-stream"
        const blob = await response.blob().catch(() => null)
        if (cancelled) return
        const size = blob?.size ?? 0

        if (blob && isTextish(mime, target.name)) {
          const text = await blob.text()
          if (cancelled) return
          setState({ status: "ready", preview: { kind: "text", text }, mime, size, objectUrl: null })
          return
        }

        if (Platform.OS === "web" && blob) {
          const createObjectURL = (globalThis as any).URL?.createObjectURL as
            | ((value: Blob) => string)
            | undefined
          if (typeof createObjectURL === "function") objectUrl = createObjectURL.call(URL, blob)
          const wanted = mime.startsWith("image/")
            ? "image"
            : mime === "application/pdf" || extensionOf(target.name) === "pdf"
              ? "pdf"
              : null
          setState({
            status: "ready",
            preview: wanted && objectUrl ? { kind: wanted, url: objectUrl } : { kind: "binary" },
            mime,
            size,
            objectUrl,
          })
          return
        }

        setState({ status: "ready", preview: { kind: "binary" }, mime, size, objectUrl: null })
      } catch (error: any) {
        if (cancelled) return
        setState({ status: "error", code: null, text: error?.message || "Could not open this file" })
      }
    }

    void load()
    return () => {
      cancelled = true
      if (objectUrl) {
        const revoke = (globalThis as any).URL?.revokeObjectURL as ((value: string) => void) | undefined
        if (typeof revoke === "function") revoke.call(URL, objectUrl)
      }
    }
  }, [source, target.name, reloadKey])

  const save = useCallback(async () => {
    if (state.status !== "ready" || saving) return
    setSaving(true)
    setSaveError(null)
    try {
      if (Platform.OS === "web") {
        if (typeof document === "undefined") return
        const href =
          state.objectUrl ?? (state.preview.kind === "text"
            ? URL.createObjectURL(new Blob([state.preview.text], { type: state.mime }))
            : null)
        if (!href) throw new Error("Nothing to download")
        const anchor = document.createElement("a")
        anchor.href = href
        anchor.download = target.name
        anchor.rel = "noopener"
        document.body.appendChild(anchor)
        anchor.click()
        document.body.removeChild(anchor)
        if (!state.objectUrl) setTimeout(() => URL.revokeObjectURL(href), 4000)
        return
      }
      // Native has no blob URL: the shared saver writes the bytes into app
      // storage and presents the OS share sheet.
      await downloadAttachment(source, target.name)
    } catch (error: any) {
      setSaveError(error?.message || "Download failed")
    } finally {
      setSaving(false)
    }
  }, [saving, source, state, target.name])

  const subtitle =
    state.status === "ready" ? formatSize(state.size) : state.status === "error" ? "" : "Loading…"

  return (
    <View
      className={`flex-1 bg-background${embedded ? "" : " rounded-lg border border-border"}${
        className ? ` ${className}` : ""
      }`}
      testID="share-file-view"
    >
      <View className="flex-row items-center gap-2 border-b border-border px-3 py-2">
        <FileTypeIcon path={target.name} size={16} />
        <View className="min-w-0 flex-1">
          <Text className="text-xs font-medium text-foreground" numberOfLines={1}>
            {target.name}
          </Text>
          {subtitle ? (
            <Text className="text-[10px] text-muted-foreground" numberOfLines={1}>
              {subtitle}
            </Text>
          ) : null}
        </View>
        {state.status === "ready" ? (
          <Pressable
            onPress={save}
            disabled={saving}
            accessibilityRole="button"
            accessibilityLabel={`Download ${target.name}`}
            testID="share-file-download"
            className="flex-row items-center gap-1 rounded-md px-2 py-1 hover:bg-muted active:opacity-70"
          >
            {saving ? <ActivityIndicator size="small" /> : <Download size={14} className="text-muted-foreground" />}
            <Text className="text-[11px] text-muted-foreground">Download</Text>
          </Pressable>
        ) : null}
        {onClose ? (
          <Pressable
            onPress={onClose}
            accessibilityRole="button"
            accessibilityLabel="Close file"
            testID="share-file-close"
            className="rounded-md p-1 hover:bg-muted active:opacity-70"
          >
            <X size={14} className="text-muted-foreground" />
          </Pressable>
        ) : null}
      </View>

      {saveError ? (
        <Text className="px-3 pt-2 text-[11px] text-destructive">{saveError}</Text>
      ) : null}

      {state.status === "loading" ? (
        <View className="flex-1 items-center justify-center py-8">
          <ActivityIndicator />
        </View>
      ) : null}

      {state.status === "error" ? (
        <View className="flex-1 items-center justify-center gap-2 px-6 py-8">
          <Text className="text-center text-sm text-foreground" testID="share-file-error">
            {state.text}
          </Text>
          {state.code ? (
            <Text className="text-center text-[10px] text-muted-foreground">{state.code}</Text>
          ) : null}
          <Pressable
            onPress={() => setReloadKey((key) => key + 1)}
            accessibilityRole="button"
            accessibilityLabel="Retry"
            testID="share-file-retry"
            className="mt-1 flex-row items-center gap-1 rounded-md border border-border px-2 py-1 hover:bg-muted active:opacity-70"
          >
            <RotateCcw size={12} className="text-muted-foreground" />
            <Text className="text-[11px] text-foreground">Retry</Text>
          </Pressable>
        </View>
      ) : null}

      {state.status === "ready" && state.preview.kind === "text" ? (
        <ScrollView className="flex-1" contentContainerClassName="px-3 py-2">
          <Text selectable className="font-mono text-[11px] leading-4 text-foreground">
            {state.preview.text}
          </Text>
        </ScrollView>
      ) : null}

      {state.status === "ready" && state.preview.kind === "image" && Platform.OS === "web" ? (
        <View className="flex-1 items-center justify-center p-2">
          <img
            src={state.preview.url}
            alt={target.name}
            style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }}
          />
        </View>
      ) : null}

      {state.status === "ready" && state.preview.kind === "pdf" && Platform.OS === "web" ? (
        <View className="flex-1 p-2">
          <iframe
            src={state.preview.url}
            title={target.name}
            style={{ border: "none", width: "100%", height: "100%" }}
          />
        </View>
      ) : null}

      {state.status === "ready" && state.preview.kind === "binary" ? (
        <View className="flex-1 items-center justify-center gap-2 px-6 py-8">
          <Text className="text-center text-sm text-foreground">No preview for this file type.</Text>
          <Text className="text-center text-[11px] text-muted-foreground">
            Use Download to save it and open it in its own app.
          </Text>
        </View>
      ) : null}
    </View>
  )
}

/** The same view in a centered modal, for screens with no side pane. */
export function ShareFileSheet({
  target,
  onClose,
}: {
  target: ShareFileTarget | null
  onClose: () => void
}) {
  return (
    <Modal visible={!!target} transparent animationType="fade" onRequestClose={onClose}>
      <View className="flex-1 items-center justify-center bg-black/40 p-4">
        <Pressable className="absolute inset-0" onPress={onClose} accessibilityLabel="Close file" />
        <View className="h-[70%] w-full max-w-[720px] overflow-hidden rounded-lg bg-background">
          {target ? <ShareFileView key={target.href} target={target} onClose={onClose} /> : null}
        </View>
      </View>
    </Modal>
  )
}

export default ShareFileView
