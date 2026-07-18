// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * MessageContent Component (React Native)
 *
 * Renders message content with role-appropriate styling.
 * Uses plain Text for all messages (no Streamdown in RN).
 * Displays image attachments via RN Image component.
 */

import { useState, useCallback } from "react"
import { View, Text, Image, Pressable, Linking, Platform } from "react-native"
import { cn } from "@shogo/shared-ui/primitives"
import { FileText, Play } from "lucide-react-native"
import type { UIMessage } from "@ai-sdk/react"
import { extractTextContent } from "@shogo/shared-app/chat"
import { MarkdownText } from "../MarkdownText"
import { analyzeContent } from "../long-text-utils"
import { LongTextPreviewCard } from "../LongTextPreviewCard"
import { FileViewerModal } from "../FileViewerModal"
import { ChatImageContextMenu, ImagePreviewModal } from "../ImagePreviewModal"
import { VideoPreviewModal } from "../VideoPreviewModal"
import { downloadImage, isShogoDesktop } from "../chatImageActions"

export interface MessageContentProps {
  message: UIMessage
  isStreaming?: boolean
  className?: string
}

interface ImagePart {
  url: string
  mediaType: string
}

interface FilePart {
  url: string
  mediaType: string
  name?: string
}

function deriveFileLabel(mediaType: string, name?: string): {
  title: string
  kindLabel: string
} {
  if (name) {
    const ext = name.includes(".") ? name.split(".").pop()!.toUpperCase() : ""
    const kindFromMedia = mediaType.includes("json")
      ? "JSON"
      : mediaType.includes("markdown")
      ? "Markdown"
      : mediaType.includes("pdf")
      ? "PDF"
      : mediaType.startsWith("text/")
      ? "Text"
      : ext || (mediaType.split("/").pop() || "FILE").toUpperCase()
    return { title: name, kindLabel: kindFromMedia }
  }
  if (mediaType.includes("pdf")) return { title: "PDF document", kindLabel: "PDF" }
  if (mediaType.includes("json")) return { title: "JSON file", kindLabel: "JSON" }
  if (mediaType.includes("markdown")) return { title: "Markdown", kindLabel: "Markdown" }
  if (mediaType.startsWith("text/")) return { title: "Text file", kindLabel: "Text" }
  return {
    title: "Attachment",
    kindLabel: (mediaType.split("/").pop() || "FILE").toUpperCase(),
  }
}

export { extractTextContent } from "@shogo/shared-app/chat"

function extractImageParts(message: UIMessage): ImagePart[] {
  if (!("parts" in message) || !Array.isArray((message as any).parts)) {
    return []
  }

  return ((message as any).parts as any[])
    .filter(
      (part) =>
        part.type === "file" &&
        part.mediaType?.startsWith("image/") &&
        part.url
    )
    .map((part) => ({
      url: part.url,
      mediaType: part.mediaType,
    }))
}

function extractFileParts(message: UIMessage): FilePart[] {
  if (!("parts" in message) || !Array.isArray((message as any).parts)) {
    return []
  }

  return ((message as any).parts as any[])
    .filter(
      (part) =>
        part.type === "file" &&
        !part.mediaType?.startsWith("image/") &&
        part.url
    )
    .map((part) => ({
      url: part.url,
      mediaType: part.mediaType || "application/octet-stream",
      ...(part.name ? { name: part.name } : {}),
    }))
}

function ImageThumbnail({
  url,
  mediaType,
  index,
}: {
  url: string
  mediaType: string
  index: number
}) {
  const [hasError, setHasError] = useState(false)
  const [showModal, setShowModal] = useState(false)
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null)

  const handlePress = useCallback(() => {
    setShowModal(true)
  }, [])

  const handleContextMenu = useCallback((event: any) => {
    // The custom right-click menu is desktop-only; on web we let the browser
    // show its native context menu.
    if (!isShogoDesktop()) return
    event.preventDefault?.()
    event.stopPropagation?.()
    const nativeEvent = event.nativeEvent ?? event
    setContextMenu({
      x: nativeEvent.clientX ?? 0,
      y: nativeEvent.clientY ?? 0,
    })
  }, [])

  const handleDownloadImage = useCallback(() => {
    void downloadImage(url, `image-attachment-${index + 1}`, mediaType)
  }, [index, mediaType, url])

  if (hasError) {
    return (
      <View className="rounded-lg border border-border bg-muted items-center justify-center" style={{ width: 72, height: 72 }}>
        <Text className="text-[10px] text-muted-foreground text-center">
          Failed to load
        </Text>
      </View>
    )
  }

  return (
    <>
      <Pressable
        onPress={handlePress}
        {...(Platform.OS === "web" ? { onContextMenu: handleContextMenu } as any : {})}
        testID="image-thumbnail"
        accessibilityRole="button"
        accessibilityLabel={`Open image attachment ${index + 1}`}
        accessibilityHint="Opens a larger preview."
        className={Platform.OS === "web" ? "cursor-zoom-in" : undefined}
      >
        <View className="rounded-lg overflow-hidden border border-border/40" style={{ width: 96, height: 72 }}>
          <Image
            source={{ uri: url }}
            resizeMode="cover"
            accessibilityLabel={`Image attachment ${index + 1}`}
            onError={() => setHasError(true)}
            style={{ width: 96, height: 72 }}
          />
        </View>
      </Pressable>
      <ImagePreviewModal
        visible={showModal}
        onClose={() => setShowModal(false)}
        url={url}
        mediaType={mediaType}
        title={`Image attachment ${index + 1}`}
        alt={`Image attachment ${index + 1}`}
      />
      {contextMenu ? (
        <ChatImageContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          onDownload={handleDownloadImage}
          onClose={() => setContextMenu(null)}
        />
      ) : null}
    </>
  )
}

function DocumentThumbnail({
  url,
  mediaType,
  name,
  index,
}: {
  url: string
  mediaType: string
  name?: string
  index: number
}) {
  const [showModal, setShowModal] = useState(false)
  const [showVideoModal, setShowVideoModal] = useState(false)
  const [fileContent, setFileContent] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const { title, kindLabel: typeLabel } = deriveFileLabel(mediaType, name)

  const isVideo = mediaType.startsWith("video/")

  const isTextLike =
    mediaType.startsWith("text/") ||
    mediaType.includes("json") ||
    mediaType.includes("xml") ||
    mediaType.includes("javascript") ||
    mediaType.includes("yaml")

  const handlePress = useCallback(async () => {
    if (isVideo) {
      setShowVideoModal(true)
      return
    }
    if (!isTextLike) {
      Linking.openURL(url)
      return
    }
    if (fileContent !== null) {
      setShowModal(true)
      return
    }
    setLoading(true)
    try {
      const MAX_FILE_BYTES = 1 * 1024 * 1024 // 1 MB
      const res = await fetch(url)
      // content-length may be absent for data: URLs — fall through to text check
      const contentLength = parseInt(res.headers.get("content-length") || "0", 10)
      if (contentLength > MAX_FILE_BYTES) {
        Linking.openURL(url)
        return
      }
      const text = await res.text()
      const byteSize = new Blob([text]).size
      setFileContent(byteSize > MAX_FILE_BYTES ? text.slice(0, MAX_FILE_BYTES) + "\n\n…[truncated]" : text)
      setShowModal(true)
    } catch {
      Linking.openURL(url)
    } finally {
      setLoading(false)
    }
  }, [url, isTextLike, fileContent])

  return (
    <>
      {isVideo ? (
        <Pressable
          onPress={handlePress}
          accessibilityLabel={`Video attachment ${index + 1}: ${title}`}
          accessibilityRole="button"
        >
          <View
            className="rounded-lg overflow-hidden border border-border/60 bg-black/80 items-center justify-center"
            style={{ width: 96, height: 72 }}
          >
            <View className="rounded-full bg-white/20 items-center justify-center" style={{ width: 32, height: 32 }}>
              <Play size={14} fill="white" className="text-white" />
            </View>
            <Text
              className="text-[9px] text-white/50 absolute bottom-1.5 left-0 right-0 text-center"
              numberOfLines={1}
            >
              {title}
            </Text>
          </View>
        </Pressable>
      ) : (
        <Pressable
          onPress={handlePress}
          className="flex-row items-center gap-2 rounded-lg border border-border bg-muted/40 px-2.5 py-1.5 max-w-[220px]"
          accessibilityLabel={`File attachment ${index + 1}: ${title}`}
          accessibilityRole="button"
        >
          <View className="h-7 w-7 items-center justify-center rounded-md bg-primary/15 flex-shrink-0">
            <FileText size={14} className="text-primary" />
          </View>
          <View className="flex-1 min-w-0">
            <Text className="text-[11px] font-medium text-foreground" numberOfLines={1}>
              {title}
            </Text>
            <Text className="text-[10px] text-muted-foreground" numberOfLines={1}>
              {loading ? "Loading…" : typeLabel}
            </Text>
          </View>
        </Pressable>
      )}
      {fileContent !== null && (
        <FileViewerModal
          visible={showModal}
          onClose={() => setShowModal(false)}
          content={fileContent}
          title={title}
          kind={mediaType.includes("json") ? "json" : mediaType.includes("markdown") ? "markdown" : "plain"}
        />
      )}
      <VideoPreviewModal
        visible={showVideoModal}
        onClose={() => setShowVideoModal(false)}
        url={url}
        title={title}
      />
    </>
  )
}

export function MessageContent({
  message,
  isStreaming = false,
  className,
}: MessageContentProps) {
  const content = extractTextContent(message)
  const images = extractImageParts(message)
  const files = extractFileParts(message)
  const isUser = message.role === "user"
  // Only show the preview card when there's genuinely long typed text and no
  // file attachments. When file chips are present the text body is just the
  // typed portion (short) so we always render it inline — matching ChatGPT.
  const hasAttachments = files.length > 0 || images.length > 0
  const isLongText = isUser && content && !hasAttachments
    ? analyzeContent(content).isLong
    : false

  // For assistants we keep the original "transparent, padded" style.
  // For users we render full-width and let EditableUserMessage own
  // the bubble chrome (bg, rounding, click target) — see
  // `apps/mobile/components/chat/turns/EditableUserMessage.tsx`.
  // Concretely: this used to be `max-w-[85%] bg-secondary ml-auto`
  // (a right-aligned chat bubble) but the new edit/resend UX needs
  // the user row to be a full-width clickable target so the entire
  // row can swap into an in-place ChatInput on press.
  const baseClasses = cn(
    isUser
      ? "w-full bg-transparent"
      : "rounded-md px-3 py-1.5 w-full bg-transparent",
    className
  )

  if (isUser) {
    return (
      <View className={cn(baseClasses, "gap-2")}>
        {(images.length > 0 || files.length > 0) && (
          <View className="flex-row flex-wrap gap-2">
            {images.map((img, i) => (
              <ImageThumbnail
                key={`${message.id}-img-${i}`}
                url={img.url}
                mediaType={img.mediaType}
                index={i}
              />
            ))}
            {files.map((file, i) => (
              <DocumentThumbnail
                key={`${message.id}-file-${i}`}
                url={file.url}
                mediaType={file.mediaType}
                name={file.name}
                index={i}
              />
            ))}
          </View>
        )}
        {content ? (
          isLongText ? (
            <LongTextPreviewCard text={content} title="Your Message" />
          ) : (
            <Text className="text-xs text-foreground" selectable>
              {content}
            </Text>
          )
        ) : null}
      </View>
    )
  }

  return (
    <View className={cn(baseClasses, "gap-2")}>
      {content ? (
          <MarkdownText
            className="text-xs text-foreground prose-sm"
            isStreaming={isStreaming}
          >
            {content}
          </MarkdownText>
      ) : null}
      {(images.length > 0 || files.length > 0) && (
        <View className="flex-row flex-wrap gap-2">
          {images.map((img, i) => (
            <ImageThumbnail
              key={`${message.id}-img-${i}`}
              url={img.url}
              mediaType={img.mediaType}
              index={i}
            />
          ))}
          {files.map((file, i) => (
            <DocumentThumbnail
              key={`${message.id}-file-${i}`}
              url={file.url}
              mediaType={file.mediaType}
              name={file.name}
              index={i}
            />
          ))}
        </View>
      )}
    </View>
  )
}

export default MessageContent
