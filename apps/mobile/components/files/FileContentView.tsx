// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The body of a file, without any IDE chrome.
 *
 * The IDE's editor group, the workspace file viewer, a `share_file` link and a
 * conversation attachment all show the same file in different frames: tabs and
 * breadcrumbs in one, a header with a download in another. This component is
 * everything below that frame — the IDE preview components, Monaco, or a
 * rendered Markdown body — so a file type is taught to the app once.
 *
 * It owns the `.shogo-ide` wrapper the previews and Monaco read their
 * `--ide-*` variables from, so hosts stop wrapping by hand.
 */

import { useState, type ReactNode } from "react"
import { ActivityIndicator, Platform, Pressable, ScrollView, Text, View } from "react-native"
import { Download } from "lucide-react-native"
import type { editor } from "monaco-editor"
import { downloadAttachment } from "../../lib/attachment-download"
import { MarkdownText } from "../chat/MarkdownText"
import { CodeEditor } from "../project/panels/ide/CodeEditor"
import { FilePreview } from "../project/panels/ide/FilePreview"
import { DEFAULT_SETTINGS, type EditorSettings } from "../project/panels/ide/types"
import { languageFor } from "../project/panels/ide/workspace/language"
import type { FileViewKind } from "./file-view-kind"

type MonacoNs = typeof import("monaco-editor")

export interface FileContentViewProps {
  kind: FileViewKind
  /** File name, for the preview chrome and the Monaco language. */
  name: string
  /** Path, for previews that show it. Defaults to `name`. */
  path?: string
  /** Object URL for image/video/audio/pdf/font/sqlite. Required for those. */
  url?: string | null
  /** Decoded text for markdown and text. */
  text?: string
  /** Viewers pass true: no Edit toggle, and Monaco refuses input. */
  readOnly?: boolean
  themeMode?: "dark" | "light"
  settings?: EditorSettings
  editorTheme?: string
  /** Monaco language id; defaults to the one `name` implies. */
  language?: string
  /**
   * Monaco model key. Viewers must pass something unique per file (see
   * `viewerPathKey`) so they never share a model with an open IDE tab.
   */
  pathKey?: string
  /** Controlled Markdown mode (the IDE keeps it on the open tab). */
  mdMode?: "preview" | "edit"
  onMdModeChange?: (mode: "preview" | "edit") => void
  onChange?: (value: string, sourceKey: string) => void
  onCursor?: (line: number, column: number) => void
  onEditorMount?: (ed: editor.IStandaloneCodeEditor, monaco: MonacoNs) => void
  /** The host's own image renderer for platforms without a DOM. */
  nativeImage?: ReactNode
  /** Shown by the binary fallback; the host passes its download control. */
  download?: ReactNode
  /** Copy for the binary fallback, when the host says it differently. */
  binaryMessage?: string
  testID?: string
}

/** A Monaco model key that can never collide with an IDE tab's file id. */
export function viewerPathKey(source: string): string {
  return `viewer:${source}`
}

export function FileContentView({
  kind,
  name,
  path,
  url,
  text = "",
  readOnly = true,
  themeMode = "dark",
  settings = DEFAULT_SETTINGS,
  editorTheme,
  language,
  pathKey,
  mdMode,
  onMdModeChange,
  onChange,
  onCursor,
  onEditorMount,
  nativeImage,
  download,
  binaryMessage = "No preview for this file type.",
  testID,
}: FileContentViewProps) {
  if (kind === "binary") {
    return (
      <BinaryFallback message={binaryMessage} download={download} url={url} name={name} testID={testID} />
    )
  }

  if (kind === "markdown") {
    return (
      <div
        className="shogo-ide flex h-full min-h-0 w-full min-w-0 flex-1 flex-col overflow-hidden"
        data-theme={themeMode}
        data-testid={testID}
      >
        <MarkdownBody
          value={text}
          name={name}
          pathKey={pathKey ?? viewerPathKey(path ?? name)}
          language={language ?? "markdown"}
          readOnly={readOnly}
          themeMode={themeMode}
          settings={settings}
          editorTheme={editorTheme}
          mdMode={mdMode}
          onMdModeChange={onMdModeChange}
          onChange={onChange}
          onCursor={onCursor}
          onEditorMount={onEditorMount}
        />
      </div>
    )
  }

  if (kind === "text") {
    return (
      <CodeBody
        value={text}
        name={name}
        language={language ?? languageFor(name)}
        pathKey={pathKey ?? viewerPathKey(path ?? name)}
        readOnly={readOnly}
        themeMode={themeMode}
        settings={settings}
        editorTheme={editorTheme}
        onChange={onChange}
        onCursor={onCursor}
        onEditorMount={onEditorMount}
        testID={testID}
      />
    )
  }

  // Media, fonts and SQLite render through the IDE's own previews, which are
  // DOM-only. A PDF has a native renderer of its own, so it is the one kind
  // that keeps its preview on a phone.
  if (Platform.OS !== "web") {
    if (kind === "image" && nativeImage) return <>{nativeImage}</>
    if (kind === "pdf" && url) return <NativePdf url={url} name={name} testID={testID} />
    return (
      <BinaryFallback message={binaryMessage} download={download} url={url} name={name} testID={testID} />
    )
  }

  if (!url) {
    return (
      <BinaryFallback message={binaryMessage} download={download} url={url} name={name} testID={testID} />
    )
  }

  return (
    <div
      className="shogo-ide flex h-full min-h-0 w-full min-w-0 flex-1 flex-col overflow-hidden"
      data-theme={themeMode}
      data-testid={testID}
    >
      <FilePreview kind={kind} url={url} name={name} path={path ?? name} />
    </div>
  )
}

function MarkdownBody({
  value,
  name,
  pathKey,
  language,
  readOnly,
  themeMode,
  settings,
  editorTheme,
  mdMode,
  onMdModeChange,
  onChange,
  onCursor,
  onEditorMount,
}: {
  value: string
  name: string
  pathKey: string
  language: string
  readOnly: boolean
  themeMode: "dark" | "light"
  settings: EditorSettings
  editorTheme?: string
  mdMode?: "preview" | "edit"
  onMdModeChange?: (mode: "preview" | "edit") => void
  onChange?: (value: string, sourceKey: string) => void
  onCursor?: (line: number, column: number) => void
  onEditorMount?: (ed: editor.IStandaloneCodeEditor, monaco: MonacoNs) => void
}) {
  const [localMode, setLocalMode] = useState<"preview" | "edit">("preview")
  const mode = mdMode ?? localMode
  const select = (next: "preview" | "edit") => {
    setLocalMode(next)
    onMdModeChange?.(next)
  }
  const sourceLabel = readOnly ? "Source" : "Edit"

  const tabs = (
    <>
      <button
        type="button"
        data-testid="ide-md-mode-preview"
        aria-pressed={mode === "preview"}
        onClick={() => select("preview")}
        className={`rounded px-2 py-0.5 text-[12px] ${
          mode === "preview"
            ? "bg-[color:var(--ide-active)] text-[color:var(--ide-text)]"
            : "text-[color:var(--ide-muted)]"
        }`}
      >
        Preview
      </button>
      <button
        type="button"
        data-testid={readOnly ? "file-view-md-mode-source" : "ide-md-mode-edit"}
        aria-pressed={mode === "edit"}
        onClick={() => select("edit")}
        className={`rounded px-2 py-0.5 text-[12px] ${
          mode === "edit"
            ? "bg-[color:var(--ide-active)] text-[color:var(--ide-text)]"
            : "text-[color:var(--ide-muted)]"
        }`}
      >
        {sourceLabel}
      </button>
    </>
  )

  if (Platform.OS !== "web") {
    return (
      <View className="min-h-0 flex-1">
        <View className="flex-row items-center gap-1 border-b border-border px-2 py-1">{tabs}</View>
        <ScrollView className="min-h-0 flex-1" contentContainerStyle={{ padding: 12 }}>
          {mode === "edit" ? (
            <Text selectable className="font-mono text-xs leading-5 text-foreground">
              {value}
            </Text>
          ) : (
            <MarkdownText>{value}</MarkdownText>
          )}
        </ScrollView>
      </View>
    )
  }

  return (
    <>
      <div className="flex items-center gap-1 border-b border-[color:var(--ide-border)] px-2 py-1">
        {tabs}
      </div>
      {mode === "edit" ? (
        <div className="min-h-0 flex-1">
          <CodeBody
            value={value}
            name={name}
            language={language}
            pathKey={pathKey}
            readOnly={readOnly}
            themeMode={themeMode}
            settings={settings}
            editorTheme={editorTheme}
            onChange={onChange}
            onCursor={onCursor}
            onEditorMount={onEditorMount}
          />
        </div>
      ) : (
        <div
          data-testid="ide-md-preview"
          className="min-h-0 flex-1 overflow-auto px-4 py-3"
        >
          <MarkdownText>{value}</MarkdownText>
        </div>
      )}
    </>
  )
}

function CodeBody({
  value,
  name,
  language,
  pathKey,
  readOnly,
  themeMode,
  settings,
  editorTheme,
  onChange,
  onCursor,
  onEditorMount,
  testID,
}: {
  value: string
  name: string
  language: string
  pathKey: string
  readOnly: boolean
  themeMode: "dark" | "light"
  settings: EditorSettings
  editorTheme?: string
  onChange?: (value: string, sourceKey: string) => void
  onCursor?: (line: number, column: number) => void
  onEditorMount?: (ed: editor.IStandaloneCodeEditor, monaco: MonacoNs) => void
  testID?: string
}) {
  if (Platform.OS !== "web") {
    return (
      <ScrollView className="min-h-0 flex-1 px-4 py-3" testID={testID}>
        <Text selectable className="font-mono text-xs leading-5 text-foreground">
          {value}
        </Text>
      </ScrollView>
    )
  }

  return (
    <div
      className="shogo-ide flex h-full min-h-0 w-full min-w-0 flex-col overflow-hidden"
      data-theme={themeMode}
      data-testid={testID}
    >
      <CodeEditor
        value={value}
        language={language}
        pathKey={pathKey}
        settings={settings}
        themeMode={themeMode}
        editorTheme={editorTheme}
        readOnly={readOnly}
        onChange={(key, next) => onChange?.(next, key)}
        onCursor={onCursor ?? (() => {})}
        onMount={onEditorMount}
      />
    </div>
  )
}

/**
 * Nothing here can render this file. It never says to press a Download that the
 * host forgot to pass: with no control of its own it falls back to downloading
 * the URL it was given, and only mentions the button when there is one.
 */
function BinaryFallback({
  message,
  download,
  url,
  name,
  testID,
}: {
  message: string
  download?: ReactNode
  url?: string | null
  name: string
  testID?: string
}) {
  const control = download ?? (url ? <DownloadControl url={url} name={name} /> : null)
  return (
    <View
      className="flex-1 items-center justify-center gap-2 px-6 py-8"
      testID={testID ?? "file-view-binary"}
    >
      <Text className="text-center text-sm text-foreground">{message}</Text>
      {control ? (
        <Text className="text-center text-[11px] text-muted-foreground">
          Use Download to save it and open it in its own app.
        </Text>
      ) : null}
      {control}
    </View>
  )
}

/** The last resort's own download, so no host can leave the button out. */
function DownloadControl({ url, name }: { url: string; name: string }) {
  const [busy, setBusy] = useState(false)
  return (
    <Pressable
      onPress={() => {
        if (busy) return
        setBusy(true)
        void downloadAttachment(url, name).finally(() => setBusy(false))
      }}
      disabled={busy}
      accessibilityRole="button"
      accessibilityLabel={`Download ${name}`}
      testID="file-view-download"
      className="flex-row items-center gap-2 rounded-md bg-primary px-3 py-2 active:opacity-90"
    >
      {busy ? <ActivityIndicator size="small" color="#fff" /> : <Download size={14} color="#fff" />}
      <Text className="text-sm font-semibold text-primary-foreground">Download</Text>
    </Pressable>
  )
}

/** A phone's own PDF renderer — the only preview that survives without a DOM. */
function NativePdf({ url, name, testID }: { url: string; name: string; testID?: string }) {
  const WebView = require("react-native-webview").default
  return (
    <WebView
      source={{ uri: url }}
      style={{ flex: 1 }}
      testID={testID ?? "file-view-pdf"}
      accessibilityLabel={name}
    />
  )
}
