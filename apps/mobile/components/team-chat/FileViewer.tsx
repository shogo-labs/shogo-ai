// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A file shared in a conversation, opened in the app. This is what a tap on an
 * attachment, a Files pane row, or a pasted `/api/conversation-files/<id>`
 * link lands on — never a browser tab and never a storage URL.
 *
 * It renders what the platform can actually render (picture, video, audio,
 * PDF, text) from a metadata route that answers with JSON, so nothing here
 * follows the capability URL's redirect to storage. Files that can't be shown
 * still get their name, type and size, plus a download; that is the honest end
 * of the road for a binary, and it stays inside the app.
 *
 * An office document has no renderer here, but the server already extracts its
 * text for search — so a deck or a report opens as its own text, labelled as
 * such, rather than as an opaque chip that only offers a download.
 */
import { useCallback, useEffect, useState } from 'react'
import { ActivityIndicator, Image, Linking, Platform, Pressable, ScrollView, Text, View } from 'react-native'
import { AlertCircle, ClipboardCopy, Download, ExternalLink } from 'lucide-react-native'
import { attachmentDownloadUrl, downloadAttachment } from '../../lib/attachment-download'
import { formatFileSize } from '../../lib/composer-attachments'
import { fileTypeMeta } from '../../lib/file-type'
import {
  absoluteApiUrl,
  teamChatApi,
  type ConversationFileMeta,
  type ConversationFileText,
} from '../../lib/team-chat-api'
import { useResolvedTheme } from '../../contexts/theme'
import { FileContentView, viewerPathKey } from '../files/FileContentView'
import { fileViewKind } from '../files/file-view-kind'
import { VoiceNotePlayer } from './VoiceNotePlayer'

const api = teamChatApi()

export interface FileViewerProps {
  attachmentId: string
  /** Shown in the header before the metadata arrives. */
  fallbackName?: string
}

export function FileViewer({ attachmentId, fallbackName }: FileViewerProps) {
  const isDark = useResolvedTheme() === 'dark'
  const [state, setState] = useState<
    | { status: 'loading' }
    | { status: 'ready'; file: ConversationFileMeta }
    | { status: 'error'; message: string }
  >({ status: 'loading' })

  useEffect(() => {
    let live = true
    setState({ status: 'loading' })
    api
      .fileMeta(attachmentId)
      .then(({ file }) => {
        if (live) setState({ status: 'ready', file })
      })
      .catch((err: { status?: number; message?: string }) => {
        if (!live) return
        // 404 covers "deleted", "not yours" and "wrong workspace" alike — the
        // server answers the same way on purpose, so this says so plainly
        // instead of implying the file exists but is unavailable.
        setState({
          status: 'error',
          message:
            err?.status === 404
              ? "This file isn't available. It may have been deleted, or it's from a conversation you can't see."
              : err?.message || 'Could not load this file.',
        })
      })
    return () => {
      live = false
    }
  }, [attachmentId])

  if (state.status === 'loading') {
    return (
      <View className="flex-1 items-center justify-center gap-2 p-6" testID="file-viewer-loading">
        <ActivityIndicator />
        {fallbackName ? <Text className="text-sm text-muted-foreground">{fallbackName}</Text> : null}
      </View>
    )
  }

  if (state.status === 'error') {
    return (
      <View className="flex-1 items-center justify-center gap-2 p-6" testID="file-viewer-error">
        <AlertCircle size={20} className="text-muted-foreground" />
        <Text className="max-w-[420px] text-center text-sm text-muted-foreground">{state.message}</Text>
      </View>
    )
  }

  const { file } = state
  const meta = fileTypeMeta(file.name, file.mimeType)
  const kind = fileViewKind(file.name, file.mimeType)
  // An office document has no renderer, but the server already extracted its
  // text: show that rather than an opaque chip that only offers a download.
  const shown = kind === 'binary' && file.hasText ? 'text' : kind
  const url = absoluteApiUrl(file.url)

  const nativeImage = (
    <ScrollView contentContainerStyle={{ flexGrow: 1, justifyContent: 'center', padding: 16 }}>
      <Image
        source={{ uri: url }}
        resizeMode="contain"
        accessibilityLabel={file.name}
        style={{ width: '100%', height: '100%', minHeight: 240 }}
      />
    </ScrollView>
  )

  return (
    <View className="flex-1 bg-background" testID="file-viewer">
      <View className="min-h-0 flex-1">
        {shown === 'audio' ? (
          <View className="flex-1 items-center justify-center p-6">
            <VoiceNotePlayer
              attachmentId={file.id}
              url={url}
              durationMs={file.durationMs}
              peaks={file.peaks}
              name={file.name}
            />
          </View>
        ) : shown === 'text' || shown === 'markdown' ? (
          <TextView
            file={file}
            kind={shown}
            themeMode={isDark ? 'dark' : 'light'}
            extracted={kind === 'binary'}
          />
        ) : shown === 'binary' ? (
          <DownloadView file={file} label={meta.label} />
        ) : (
          <FileContentView
            kind={shown}
            name={file.name}
            path={file.name}
            url={url}
            readOnly
            themeMode={isDark ? 'dark' : 'light'}
            pathKey={viewerPathKey(`attachment:${file.id}`)}
            nativeImage={nativeImage}
            download={<DownloadButton url={url} name={file.name} />}
            testID="file-viewer-content"
          />
        )}
      </View>
    </View>
  )
}

function TextView({
  file,
  kind,
  themeMode,
  extracted,
}: {
  file: ConversationFileMeta
  kind: 'text' | 'markdown'
  themeMode: 'dark' | 'light'
  /** The text came out of an office document, not the file itself. */
  extracted: boolean
}) {
  const [text, setText] = useState<ConversationFileText | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    let live = true
    setLoading(true)
    api
      .fileText(file.id)
      .then((page) => {
        if (live) setText(page)
      })
      .catch((err: { message?: string }) => {
        if (live) setError(err?.message || 'Could not read this file.')
      })
      .finally(() => {
        if (live) setLoading(false)
      })
    return () => {
      live = false
    }
  }, [file.id])

  const loadMore = useCallback(async () => {
    if (!text?.nextOffset) return
    const next = await api.fileText(file.id, { offset: text.nextOffset }).catch(() => null)
    if (!next) return
    setText({ ...next, text: `${text.text ?? ''}${next.text ?? ''}` })
  }, [file.id, text])

  if (loading) {
    return (
      <View className="flex-1 items-center justify-center" testID="file-viewer-text-loading">
        <ActivityIndicator />
      </View>
    )
  }

  if (error || !text || text.text === null) {
    return (
      <View className="flex-1 items-center justify-center gap-3 p-6" testID="file-viewer-text-empty">
        <Text className="max-w-[420px] text-center text-sm text-muted-foreground">
          {error ?? "There's no text to show for this file."}
        </Text>
        <DownloadButton url={absoluteApiUrl(file.url)} name={file.name} />
      </View>
    )
  }

  return (
    <View className="min-h-0 flex-1" testID="file-viewer-text">
      <View className="flex-row items-center gap-2 border-b border-border px-3 py-1.5">
        <Text className="min-w-0 flex-1 text-[11px] text-muted-foreground" numberOfLines={1}>
          {extracted ? 'Text extracted from this file' : `${text.totalChars.toLocaleString()} characters`}
        </Text>
        <Pressable
          onPress={() => {
            // Required lazily: the clipboard's native module is loaded when a
            // person copies, not when a file is opened.
            const Clipboard = require('expo-clipboard') as typeof import('expo-clipboard')
            void Clipboard.setStringAsync(text.text ?? '')
            setCopied(true)
            setTimeout(() => setCopied(false), 1500)
          }}
          accessibilityRole="button"
          accessibilityLabel="Copy file text"
          className="flex-row items-center gap-1 rounded-md px-2 py-1 active:bg-muted"
        >
          <ClipboardCopy size={12} className="text-muted-foreground" />
          <Text className="text-[11px] text-muted-foreground">{copied ? 'Copied' : 'Copy'}</Text>
        </Pressable>
      </View>
      <View className="min-h-0 flex-1">
        <FileContentView
          kind={kind}
          text={text.text}
          name={file.name}
          path={file.name}
          readOnly
          themeMode={themeMode}
          pathKey={viewerPathKey(`attachment:${file.id}`)}
          testID="file-viewer-text-body"
        />
      </View>
      {text.nextOffset ? (
        <Pressable onPress={() => void loadMore()} accessibilityRole="button" className="m-3 self-start rounded-md border border-border px-3 py-1.5 active:bg-muted">
          <Text className="text-xs font-medium text-primary">Load more</Text>
        </Pressable>
      ) : null}
    </View>
  )
}

function DownloadButton({ url, name }: { url: string; name: string }) {
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
      className="flex-row items-center gap-2 rounded-md bg-primary px-3 py-2 active:opacity-90"
    >
      {busy ? <ActivityIndicator size="small" color="#fff" /> : <Download size={14} color="#fff" />}
      <Text className="text-sm font-semibold text-primary-foreground">Download</Text>
    </Pressable>
  )
}

function DownloadView({ file, label }: { file: ConversationFileMeta; label: string }) {
  const meta = fileTypeMeta(file.name, file.mimeType)
  return (
    <View className="flex-1 items-center justify-center gap-4 p-6" testID="file-viewer-download">
      <View className="h-16 w-16 items-center justify-center rounded-xl" style={{ backgroundColor: meta.color }}>
        <Text className="text-base font-bold text-white" numberOfLines={1}>
          {meta.glyph}
        </Text>
      </View>
      <View className="items-center gap-1">
        <Text className="max-w-[420px] text-center text-sm font-semibold text-foreground" numberOfLines={2}>
          {file.name}
        </Text>
        <Text className="text-xs text-muted-foreground">
          {[label, file.size > 0 ? formatFileSize(file.size) : null].filter(Boolean).join(' · ')}
        </Text>
      </View>
      <Text className="max-w-[380px] text-center text-xs text-muted-foreground">
        This file can't be previewed here. Download it to open it in its own app.
      </Text>
      <View className="flex-row items-center gap-2">
        <DownloadButton url={absoluteApiUrl(file.url)} name={file.name} />
        <OpenInBrowser url={attachmentDownloadUrl(absoluteApiUrl(file.url))} />
      </View>
    </View>
  )
}

/** The one place a tap is allowed to leave the app, and only when it's asked for. */
function OpenInBrowser({ url }: { url: string }) {
  return (
    <Pressable
      onPress={() => {
        if (Platform.OS === 'web') window.open(url, '_blank', 'noopener,noreferrer')
        else void Linking.openURL(url).catch(() => {})
      }}
      accessibilityRole="button"
      accessibilityLabel="Open in browser"
      className="flex-row items-center gap-1.5 rounded-md border border-border px-3 py-2 active:bg-muted"
    >
      <ExternalLink size={13} className="text-muted-foreground" />
      <Text className="text-sm text-foreground">Open in browser</Text>
    </Pressable>
  )
}
