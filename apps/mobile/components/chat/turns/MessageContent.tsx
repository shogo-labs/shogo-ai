// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * MessageContent Component (React Native)
 *
 * Renders message content with role-appropriate styling.
 * Uses plain Text for all messages (no Streamdown in RN).
 * Displays image attachments via RN Image component.
 */

import { useState, useCallback, useMemo } from "react"
import {
  View,
  Text,
  Image,
  Pressable,
  Platform,
  useWindowDimensions,
} from "react-native"
import { cn } from "@shogo/shared-ui/primitives"
import { FileText, Play } from "lucide-react-native"
import type { UIMessage } from "@ai-sdk/react"
import { extractTextContent } from "@shogo/shared-app/chat"
import { MarkdownText } from "../MarkdownText"
import { analyzeContent } from "../long-text-utils"
import { LongTextPreviewCard } from "../LongTextPreviewCard"
import { ChatMentionText, chatMentionSince } from "../ChatMentionChip"
import { FileViewerModal } from "../FileViewerModal"
import { ChatImageContextMenu, ImagePreviewModal } from "../ImagePreviewModal"
import { VideoPreviewModal } from "../VideoPreviewModal"
import { useShareFileOpener } from "../share-file-context"
import { parseInAppFileHref } from "../../../lib/share-file-links"
import { decodeDataUrlText } from "../../../lib/data-url"
import { openExternalLink } from "../../../lib/open-external-link"
import { downloadImage, isShogoDesktop } from "../chatImageActions"
import { usePhoneLayout, usePhoneLayoutOverride } from "../../../lib/native-phone-layout"
import { useMobileWorkspaceChrome } from "../../layout/MobileWorkspaceChromeContext"
import { resolveChatAttachmentUrl } from "../../../lib/chat-attachment-url"
import { useAgentImageSource } from "../../../lib/agent-image-source"
import { CHAT_IMAGE_MAX_WIDTH, fitChatImage } from "./image-sizing"
import { stripAskUserAnswerMarker } from "./askUserAnswers"
import { stripBuildBriefMarker } from "./buildBrief"

export interface MessageContentProps {
  message: UIMessage
  isStreaming?: boolean
  className?: string
  /**
   * Native ChatGPT-style user bubble: attachments sit above a gray
   * pill, body text is white. Web/desktop keep the default `default`.
   */
  variant?: "default" | "userBubble"
}

interface ImagePart {
  url: string
  mediaType: string
  /** Pixel size stored with the part, so the box is final on the first frame. */
  width?: number
  height?: number
  /** Small preview the thumbnail paints instead of the original. */
  previewUrl?: string
}

interface FilePart {
  url: string
  mediaType: string
  name?: string
}

function deriveFileLabel(
  mediaType: string,
  name?: string,
): {
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
  if (mediaType.includes("pdf"))
    return { title: "PDF document", kindLabel: "PDF" }
  if (mediaType.includes("json"))
    return { title: "JSON file", kindLabel: "JSON" }
  if (mediaType.includes("markdown"))
    return { title: "Markdown", kindLabel: "Markdown" }
  if (mediaType.startsWith("text/"))
    return { title: "Text file", kindLabel: "Text" }
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
        part.url,
    )
    .map((part) => ({
      url: part.url,
      mediaType: part.mediaType,
      ...(typeof part.width === "number" && part.width > 0
        ? { width: part.width }
        : {}),
      ...(typeof part.height === "number" && part.height > 0
        ? { height: part.height }
        : {}),
      ...(typeof part.previewUrl === "string" && part.previewUrl
        ? { previewUrl: part.previewUrl }
        : {}),
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
        part.url,
    )
    .map((part) => ({
      url: part.url,
      mediaType: part.mediaType || "application/octet-stream",
      ...(part.name ? { name: part.name } : {}),
    }))
}

function ImageThumbnail({
  url,
  previewUrl,
  width,
  height,
  mediaType,
  index,
}: {
  url: string
  /** Small preview to paint instead of the original, when one was stored. */
  previewUrl?: string
  /** Stored pixel size of the original; absent on messages sent before SHO-407. */
  width?: number
  height?: number
  mediaType: string
  index: number
}) {
  const [hasError, setHasError] = useState(false)
  const [showModal, setShowModal] = useState(false)
  // A preview can outlive its usefulness (a workspace that was wiped) while the
  // original is still served from chat-attachment storage. Falling back keeps
  // the photo visible instead of leaving a broken box.
  const [previewFailed, setPreviewFailed] = useState(false)
  const displayUrl = previewUrl && !previewFailed ? previewUrl : url
  const imageSource = useAgentImageSource(displayUrl)
  // The box is decided from the stored size alone. A message sent before sizes
  // were stored gets a fixed box that never resizes: measuring it would change
  // the content height after the first layout, which is what made a resumed
  // chat jump (SHO-407).
  //
  // It is deliberately *not* sized against the measured row width. That width
  // arrives from `onLayout`, which on web is a ResizeObserver callback that runs
  // after the first paint, so a box sized from it is wrong on the first frame
  // and grows under the reader. Instead the box carries the widest it may be
  // plus its aspect ratio, and `maxWidth: "100%"` lets the layout engine fit it
  // to the row — width and height resolved together, in one pass, for any pane.
  const box = fitChatImage({
    naturalWidth: width,
    naturalHeight: height,
    containerWidth: CHAT_IMAGE_MAX_WIDTH,
  })
  const [contextMenu, setContextMenu] = useState<{
    x: number
    y: number
  } | null>(null)

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

  const handleImageError = useCallback(() => {
    if (previewUrl && !previewFailed) {
      setPreviewFailed(true)
      return
    }
    setHasError(true)
  }, [previewFailed, previewUrl])

  if (hasError) {
    return (
      <View
        className="rounded-lg border border-border bg-muted items-center justify-center"
        style={{ width: 72, height: 72 }}
      >
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
        {...(Platform.OS === "web"
          ? ({ onContextMenu: handleContextMenu } as any)
          : {})}
        testID="image-thumbnail"
        accessibilityRole="button"
        accessibilityLabel={`Open image attachment ${index + 1}`}
        accessibilityHint="Opens a larger preview."
        className={Platform.OS === "web" ? "cursor-zoom-in" : undefined}
      >
        <View
          className="rounded-lg overflow-hidden border border-border/40 bg-muted/30"
          // `maxWidth` fits the box to a pane narrower than its cap, and
          // `aspectRatio` derives the height from whatever width the layout
          // engine settles on — so the box is final on the first frame and an
          // image load can never change the content height.
          style={{
            width: box.width,
            maxWidth: "100%",
            aspectRatio: box.width / box.height,
          }}
        >
          {imageSource ? (
            <Image
              source={imageSource}
              resizeMode={box.cropped ? "cover" : "contain"}
              accessibilityLabel={`Image attachment ${index + 1}`}
              onError={handleImageError}
              style={{ width: "100%", height: "100%" }}
            />
          ) : null}
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
  onUserBubble = false,
}: {
  url: string
  mediaType: string
  name?: string
  index: number
  onUserBubble?: boolean
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

  // A stored attachment is a file the app already serves: open it in the app's
  // own viewer rather than a browser tab (SHO-80).
  const openShareFile = useShareFileOpener()
  const servedFile = useMemo(() => parseInAppFileHref(url), [url])
  const openFile = useCallback(() => {
    if (servedFile && openShareFile) openShareFile(servedFile)
    else void openExternalLink(url)
  }, [openShareFile, servedFile, url])

  const handlePress = useCallback(async () => {
    if (isVideo) {
      setShowVideoModal(true)
      return
    }
    // A `data:` URL is the file itself, not an address: Android throws on it
    // (`Could not open URL 'data:…'`, SHOGO-ANDROID-1D), so the bytes are
    // decoded here and shown in the app's own viewer (SHO-436).
    const inline = decodeDataUrlText(url)
    if (inline) {
      setFileContent(inline.text)
      setShowModal(true)
      return
    }
    if (!isTextLike) {
      openFile()
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
      const contentLength = parseInt(
        res.headers.get("content-length") || "0",
        10,
      )
      if (contentLength > MAX_FILE_BYTES) {
        openFile()
        return
      }
      const text = await res.text()
      const byteSize = new Blob([text]).size
      setFileContent(
        byteSize > MAX_FILE_BYTES
          ? text.slice(0, MAX_FILE_BYTES) + "\n\n…[truncated]"
          : text,
      )
      setShowModal(true)
    } catch {
      openFile()
    } finally {
      setLoading(false)
    }
  }, [url, isTextLike, fileContent, openFile])

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
            <View
              className="rounded-full bg-white/20 items-center justify-center"
              style={{ width: 32, height: 32 }}
            >
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
          className={cn(
            "flex-row items-center gap-2 rounded-2xl px-2.5 py-1.5 max-w-[220px]",
            onUserBubble
              ? "bg-[#2a2a2a] border border-white/10"
              : "border border-border bg-muted/40",
          )}
          accessibilityLabel={`File attachment ${index + 1}: ${title}`}
          accessibilityRole="button"
        >
          <View
            className={cn(
              "h-7 w-7 items-center justify-center rounded-md flex-shrink-0",
              onUserBubble ? "bg-white/20" : "bg-primary/15",
            )}
          >
            <FileText size={14} className={onUserBubble ? "text-white" : "text-primary"} />
          </View>
          <View className="flex-1 min-w-0">
            <Text
              className={cn(
                "text-[11px] font-medium",
                onUserBubble ? "text-white" : "text-foreground",
              )}
              numberOfLines={1}
            >
              {title}
            </Text>
            <Text
              className={cn(
                "text-[10px]",
                onUserBubble ? "text-white/55" : "text-muted-foreground",
              )}
              numberOfLines={1}
            >
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
          kind={
            mediaType.includes("json")
              ? "json"
              : mediaType.includes("markdown")
                ? "markdown"
                : "plain"
          }
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
  variant = "default",
}: MessageContentProps) {
  const isPhoneLayout = usePhoneLayout()
  const usesMobileWorkspaceChrome = useMobileWorkspaceChrome()
  const phoneLayoutOverride = usePhoneLayoutOverride()
  const { width: viewportWidth } = useWindowDimensions()
  const usesMobileChatTypography =
    isPhoneLayout || usesMobileWorkspaceChrome || (phoneLayoutOverride === null && viewportWidth < 640)
  const images = extractImageParts(message)
  const files = extractFileParts(message)
  const isUser = message.role === "user"
  const content = isUser
    ? stripBuildBriefMarker(stripAskUserAnswerMarker(extractTextContent(message)))
    : extractTextContent(message)
  // Native user bubbles keep their text selectable; native phone actions now
  // live outside the bubble, so no parent long-press handler competes for it.
  const userBubble = isUser && variant === "userBubble"
  // Only show the preview card when there's genuinely long typed text and no
  // file attachments. When file chips are present the text body is just the
  // typed portion (short) so we always render it inline — matching ChatGPT.
  const hasAttachments = files.length > 0 || images.length > 0
  const isLongText =
    isUser && content && !hasAttachments
      ? analyzeContent(content).isLong
      : false

  // For assistants we keep the original "transparent, padded" style.
  // For users we render full-width and let EditableUserMessage own
  // the bubble chrome (bg, rounding, click target) — see
  // `apps/mobile/components/chat/turns/EditableUserMessage.tsx`.
  // Native phone passes `variant="userBubble"` so attachments sit
  // above a gray ChatGPT-style pill.
  const baseClasses = cn(
    isUser
      ? "w-full bg-transparent"
      : "rounded-md px-3 py-1.5 w-full bg-transparent",
    className,
  )

  if (isUser) {
    const attachmentRowView =
      images.length > 0 || files.length > 0 ? (
        // A full-width wrapper so the row's width is the pane's even when the
        // bubble aligns its children to the end.
        <View className="w-full">
          <View
            className={cn(
              "flex-row flex-wrap gap-2",
              userBubble && "justify-end",
            )}
          >
            {images.map((img, i) => (
              <ImageThumbnail
                key={`${message.id}-img-${i}`}
                url={resolveChatAttachmentUrl(img.url)}
                previewUrl={
                  img.previewUrl
                    ? resolveChatAttachmentUrl(img.previewUrl)
                    : undefined
                }
                width={img.width}
                height={img.height}
                mediaType={img.mediaType}
                index={i}
              />
            ))}
            {files.map((file, i) => (
              <DocumentThumbnail
                key={`${message.id}-file-${i}`}
                url={resolveChatAttachmentUrl(file.url)}
                mediaType={file.mediaType}
                name={file.name}
                index={i}
                onUserBubble={userBubble}
              />
            ))}
          </View>
        </View>
      ) : null

    const body = content ? (
      isLongText ? (
        <LongTextPreviewCard text={content} title="Your Message" />
      ) : (
        <ChatMentionText
          text={content}
          since={chatMentionSince(message as any)}
          inverted={userBubble}
          style={
            usesMobileChatTypography
              ? { fontSize: 16, lineHeight: 24 }
              : undefined
          }
          className={
            userBubble
              ? usesMobileChatTypography
                ? "text-[16px] leading-6 text-white"
                : "text-sm leading-5 text-white"
              : usesMobileChatTypography
                ? "text-[16px] leading-6 text-foreground"
                : "text-sm leading-5 text-foreground"
          }
          selectable={!userBubble || Platform.OS !== "web"}
        />
      )
    ) : null

    if (userBubble) {
      return (
        <View className={cn(baseClasses, "items-end gap-1.5")}>
          {attachmentRowView}
          {body ? (
            <View
              className="px-4 py-2.5"
              style={{
                backgroundColor: "#2a2a2a",
                borderTopLeftRadius: 20,
                borderTopRightRadius: 20,
                borderBottomLeftRadius: 20,
                borderBottomRightRadius: 6,
              }}
            >
              {body}
            </View>
          ) : null}
        </View>
      )
    }

    return (
      <View className={cn(baseClasses, "gap-2")}>
        {attachmentRowView}
        {body}
      </View>
    )
  }

  return (
    <View className={cn(baseClasses, "gap-2")}>
      {content ? (
        <MarkdownText
          className="text-base leading-6 text-foreground"
          isStreaming={isStreaming}
        >
          {content}
        </MarkdownText>
      ) : null}
      {(images.length > 0 || files.length > 0) && (
        <View>
          <View className="flex-row flex-wrap gap-2">
            {images.map((img, i) => (
              <ImageThumbnail
                key={`${message.id}-img-${i}`}
                url={resolveChatAttachmentUrl(img.url)}
                previewUrl={
                  img.previewUrl
                    ? resolveChatAttachmentUrl(img.previewUrl)
                    : undefined
                }
                width={img.width}
                height={img.height}
                mediaType={img.mediaType}
                index={i}
              />
            ))}
            {files.map((file, i) => (
              <DocumentThumbnail
                key={`${message.id}-file-${i}`}
                url={resolveChatAttachmentUrl(file.url)}
                mediaType={file.mediaType}
                name={file.name}
                index={i}
              />
            ))}
          </View>
        </View>
      )}
    </View>
  )
}

export default MessageContent
