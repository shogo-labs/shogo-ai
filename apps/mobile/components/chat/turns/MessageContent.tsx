// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * MessageContent Component (React Native)
 *
 * Renders message content with role-appropriate styling.
 * Uses plain Text for all messages (no Streamdown in RN).
 * Displays image attachments via RN Image component.
 */

import { useState, useCallback } from "react"
import { View, Text, Image, Pressable, Linking } from "react-native"
import { cn } from "@shogo/shared-ui/primitives"
import { FileText } from "lucide-react-native"
import type { UIMessage } from "@ai-sdk/react"
import { extractTextContent } from "@shogo/shared-app/chat"
import { MarkdownText } from "../MarkdownText"
import { analyzeContent } from "../long-text-utils"
import { LongTextPreviewCard } from "../LongTextPreviewCard"
import { FileViewerModal } from "../FileViewerModal"

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
    }))
}

function ImageThumbnail({
  url,
  index,
}: {
  url: string
  mediaType: string
  index: number
}) {
  const [hasError, setHasError] = useState(false)

  const handlePress = useCallback(() => {
    Linking.openURL(url)
  }, [url])

  if (hasError) {
    return (
      <View className="max-w-[200px] rounded-md border border-border bg-muted p-2">
        <Text className="text-xs text-muted-foreground">
          Failed to load image
        </Text>
      </View>
    )
  }

  return (
    <Pressable onPress={handlePress} testID="image-thumbnail">
      <Image
        source={{ uri: url }}
        className="max-w-[280px] rounded-md"
        resizeMode="contain"
        accessibilityLabel={`Image attachment ${index + 1}`}
        onError={() => setHasError(true)}
        style={{ width: 280, aspectRatio: 4 / 3 }}
      />
    </Pressable>
  )
}

function DocumentThumbnail({
  url,
  mediaType,
  index,
}: {
  url: string
  mediaType: string
  index: number
}) {
  const [showModal, setShowModal] = useState(false)
  const [fileContent, setFileContent] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const label = mediaType.includes("pdf")
    ? "PDF"
    : mediaType.split("/").pop()?.toUpperCase() || "FILE"

  const isTextLike =
    mediaType.startsWith("text/") ||
    mediaType.includes("json") ||
    mediaType.includes("xml") ||
    mediaType.includes("javascript") ||
    mediaType.includes("yaml")

  const handlePress = useCallback(async () => {
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
      const res = await fetch(url)
      const text = await res.text()
      setFileContent(text)
      setShowModal(true)
    } catch {
      Linking.openURL(url)
    } finally {
      setLoading(false)
    }
  }, [url, isTextLike, fileContent])

  return (
    <>
      <Pressable
        onPress={handlePress}
        className="flex-row items-center gap-2 rounded-md border border-border bg-muted/50 px-3 py-2"
        accessibilityLabel={`File attachment ${index + 1}: ${label}`}
        accessibilityRole="button"
      >
        <FileText size={16} className="text-muted-foreground" />
        <Text className="text-xs text-muted-foreground">
          {loading ? "Loading…" : `${label} · Tap to view`}
        </Text>
      </Pressable>
      {fileContent !== null && (
        <FileViewerModal
          visible={showModal}
          onClose={() => setShowModal(false)}
          content={fileContent}
          title={`${label} File`}
          kind={mediaType.includes("json") ? "json" : "plain"}
        />
      )}
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
  const isLongText = isUser && content ? analyzeContent(content).isLong : false

  const baseClasses = cn(
    "rounded-md px-3 py-1.5",
    isUser
      ? "max-w-[85%] bg-secondary dark:bg-secondary ml-auto"
      : "w-full bg-transparent",
    className
  )

  if (isUser) {
    return (
      <View className={cn(baseClasses, "gap-2")}>
        {content ? (
          isLongText ? (
            <LongTextPreviewCard text={content} title="Your Message" />
          ) : (
            <Text className="text-xs text-foreground" selectable>
              {content}
            </Text>
          )
        ) : null}
        {images.length > 0 && (
          <View className="flex-row flex-wrap gap-2">
            {images.map((img, i) => (
              <ImageThumbnail
                key={`${message.id}-img-${i}`}
                url={img.url}
                mediaType={img.mediaType}
                index={i}
              />
            ))}
          </View>
        )}
        {files.length > 0 && (
          <View className="flex-row flex-wrap gap-2">
            {files.map((file, i) => (
              <DocumentThumbnail
                key={`${message.id}-file-${i}`}
                url={file.url}
                mediaType={file.mediaType}
                index={i}
              />
            ))}
          </View>
        )}
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
      {images.length > 0 && (
        <View className="flex-row flex-wrap gap-2">
          {images.map((img, i) => (
            <ImageThumbnail
              key={`${message.id}-img-${i}`}
              url={img.url}
              mediaType={img.mediaType}
              index={i}
            />
          ))}
        </View>
      )}
      {files.length > 0 && (
        <View className="flex-row flex-wrap gap-2">
          {files.map((file, i) => (
            <DocumentThumbnail
              key={`${message.id}-file-${i}`}
              url={file.url}
              mediaType={file.mediaType}
              index={i}
            />
          ))}
        </View>
      )}
    </View>
  )
}

export default MessageContent
