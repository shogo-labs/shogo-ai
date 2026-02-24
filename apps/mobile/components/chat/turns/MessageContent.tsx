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
import type { UIMessage } from "@ai-sdk/react"
import { extractTextContent } from "@shogo/shared-app/chat"

export interface MessageContentProps {
  message: UIMessage
  isStreaming?: boolean
  className?: string
}

interface ImagePart {
  url: string
  mediaType: string
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
        className="w-[200px] h-[150px] rounded-md border border-border"
        resizeMode="contain"
        accessibilityLabel={`Image attachment ${index + 1}`}
        onError={() => setHasError(true)}
      />
    </Pressable>
  )
}

export function MessageContent({
  message,
  isStreaming = false,
  className,
}: MessageContentProps) {
  const content = extractTextContent(message)
  const images = extractImageParts(message)
  const isUser = message.role === "user"

  const baseClasses = cn(
    "rounded-md px-3 py-1.5",
    isUser
      ? "max-w-[85%] bg-primary ml-auto"
      : "w-full bg-transparent",
    className
  )

  if (isUser) {
    return (
      <View className={cn(baseClasses, "gap-2")}>
        {content ? (
          <Text className="text-xs text-primary-foreground" selectable>
            {content}
          </Text>
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
      </View>
    )
  }

  return (
    <View className={cn(baseClasses, "gap-2")}>
      {content ? (
        <Text className="text-xs text-foreground" selectable>
          {content}
        </Text>
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
    </View>
  )
}

export default MessageContent
