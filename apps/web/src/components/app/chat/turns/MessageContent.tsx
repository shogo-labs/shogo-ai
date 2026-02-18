/**
 * MessageContent Component
 * Task: task-chat-004
 * Task: task-render-image-history (image attachment support)
 * Task: feat-chat-markdown-rendering (Streamdown markdown support)
 *
 * Renders message content with role-appropriate styling.
 * Uses Streamdown for assistant messages (markdown rendering with streaming support).
 * Displays image attachments from file parts with image mediaType.
 */

import { useState, useCallback } from "react"
import { cn } from "@/lib/utils"
import type { UIMessage } from "@ai-sdk/react"
import { Streamdown } from "streamdown"

export interface MessageContentProps {
  /** The message to render */
  message: UIMessage
  /** Whether this message is currently streaming */
  isStreaming?: boolean
  /** Optional class name */
  className?: string
}

/** Represents an extracted image part from the message */
interface ImagePart {
  url: string
  mediaType: string
}

/**
 * Extract text content from a message.
 * Handles AI SDK v3 parts array format.
 */
export function extractTextContent(message: UIMessage): string {
  // If message has content string, use it
  if (typeof (message as any).content === "string" && (message as any).content) {
    return (message as any).content
  }

  // v3 API: Extract text from parts array
  if ("parts" in message && Array.isArray((message as any).parts)) {
    return ((message as any).parts as any[])
      .filter((part) => part.type === "text")
      .map((part) => part.text || "")
      .join("")
  }

  return ""
}

/**
 * Extract image parts from a message.
 * Detects file parts with image/* mediaType.
 *
 * task-render-image-history: New function for image detection
 */
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

/**
 * Image thumbnail component with click-to-expand behavior
 *
 * task-render-image-history: Renders image with thumbnail sizing
 */
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

  const handleClick = useCallback(() => {
    // Open image in new tab for full view
    window.open(url, "_blank")
  }, [url])

  const handleError = useCallback(() => {
    setHasError(true)
  }, [])

  if (hasError) {
    return (
      <div className="max-w-[200px] rounded-md border border-border bg-muted p-2 text-xs text-muted-foreground">
        Failed to load image
      </div>
    )
  }

  return (
    <img
      src={url}
      alt={`Image attachment ${index + 1}`}
      className="max-w-[200px] max-h-[150px] rounded-md border border-border object-contain cursor-pointer hover:opacity-90 transition-opacity"
      onClick={handleClick}
      onError={handleError}
      data-testid="image-thumbnail"
    />
  )
}

/**
 * Renders message content with appropriate styling.
 *
 * Features:
 * - Role-based styling (user vs assistant)
 * - Streamdown markdown rendering for assistant messages (GFM, code highlighting, math, mermaid)
 * - Plain text for user messages
 * - Image attachment display with thumbnails (task-render-image-history)
 *
 * @example
 * ```tsx
 * <MessageContent message={assistantMessage} isStreaming={isLoading} />
 * ```
 */
export function MessageContent({
  message,
  isStreaming = false,
  className,
}: MessageContentProps) {
  const content = extractTextContent(message)
  const images = extractImageParts(message)
  const isUser = message.role === "user"

  // Render content based on role and content type
  // User messages: bubble style with max-width
  // Assistant messages: full width to accommodate markdown (code blocks, tables)
  const baseClasses = cn(
    "rounded-md px-3 py-1.5 text-xs",
    isUser
      ? "max-w-[85%] bg-primary text-primary-foreground ml-auto"
      : "w-full bg-transparent text-foreground",
    className
  )

  // User messages: text + images
  if (isUser) {
    return (
      <div className={cn(baseClasses, "flex flex-col gap-2")}>
        {content && (
          <span className="whitespace-pre-wrap break-words">{content}</span>
        )}
        {images.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {images.map((img, i) => (
              <ImageThumbnail
                key={`${message.id}-img-${i}`}
                url={img.url}
                mediaType={img.mediaType}
                index={i}
              />
            ))}
          </div>
        )}
      </div>
    )
  }

  // Assistant messages: use Streamdown for markdown rendering
  // Streamdown handles streaming natively (gracefully renders incomplete markdown)
  return (
    <div className={cn(baseClasses, "flex flex-col gap-2")}>
      {content && <Streamdown>{content}</Streamdown>}
      {images.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {images.map((img, i) => (
            <ImageThumbnail
              key={`${message.id}-img-${i}`}
              url={img.url}
              mediaType={img.mediaType}
              index={i}
            />
          ))}
        </div>
      )}
    </div>
  )
}

export default MessageContent
