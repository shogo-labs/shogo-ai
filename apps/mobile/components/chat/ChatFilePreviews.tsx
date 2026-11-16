// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The pictures and videos a message links to, shown under the text.
 *
 * A chip alone made a `share_file` screenshot something you had to click to
 * recognise; on a phone the click then landed on "no preview" (SHO-388). This
 * draws the file itself — a thumbnail, or a poster card with a play mark —
 * while the chip stays where it was in the sentence, and a tap still opens the
 * app's viewer.
 *
 * Nothing here fetches the body: a picture is a normal `<img>` / `<Image>` URL
 * and a video is `preload="metadata"`, so opening a channel where an agent
 * shared a clip does not download the clip.
 */
import { useMemo, useState } from "react"
import {
  ActivityIndicator,
  Image,
  Platform,
  Pressable,
  Text,
  View,
  useWindowDimensions,
} from "react-native"
import { Play } from "lucide-react-native"
import { cn } from "@shogo/shared-ui/primitives"
import { useAgentImageSource } from "../../lib/agent-image-source"
import { resolveChatAttachmentUrl } from "../../lib/chat-attachment-url"
import { extractInlineMediaLinks, type InlineMediaTarget } from "./inline-file-previews"
import { useShareFileOpener, type OpenShareFile } from "./share-file-context"

/** More than this many, the rest stay chips and the message stays readable. */
const MAX_CARDS = 4
const MAX_WIDTH = 420
const MAX_HEIGHT = 320

/** What the viewer receives: no card-only field. */
function viewerTarget(target: InlineMediaTarget) {
  return { href: target.href, name: target.name, kind: target.kind, path: target.path }
}

function Unavailable({ name }: { name: string }) {
  return (
    <View className="flex-row items-center gap-1.5 rounded-md border border-border bg-muted/40 px-2 py-1">
      <Text className="text-[11px] text-muted-foreground" numberOfLines={1}>
        Preview unavailable · {name}
      </Text>
    </View>
  )
}

function ImageCard({ target, onOpen }: { target: InlineMediaTarget; onOpen: OpenShareFile }) {
  const [failed, setFailed] = useState(false)
  const [size, setSize] = useState<{ width: number; height: number } | null>(null)
  const source = useAgentImageSource(resolveChatAttachmentUrl(target.href))
  const window = useWindowDimensions()
  const uri = source?.uri ?? null
  const frameWidth = Math.min(MAX_WIDTH, Math.max(160, window.width - 96))

  if (failed) {
    return (
      <Pressable onPress={() => onOpen(viewerTarget(target))} accessibilityRole="imagebutton" accessibilityLabel={target.name}>
        <Unavailable name={target.name} />
      </Pressable>
    )
  }

  return (
    <Pressable
      onPress={() => onOpen(viewerTarget(target))}
      accessibilityRole="imagebutton"
      accessibilityLabel={`Open ${target.name}`}
      testID="chat-file-preview-image"
      className="overflow-hidden rounded-lg border border-border active:opacity-80"
    >
      {!uri ? (
        <View
          className="items-center justify-center bg-muted"
          style={{ width: frameWidth, height: Math.round(frameWidth * 0.66) }}
        >
          <ActivityIndicator size="small" />
        </View>
      ) : Platform.OS === "web" ? (
        <img
          src={uri}
          alt={target.name}
          title={target.name}
          className="block h-auto max-h-[320px] w-auto max-w-full object-contain"
          onError={() => setFailed(true)}
        />
      ) : (
        <Image
          source={source!}
          style={size ?? { width: frameWidth, height: Math.round(frameWidth * 0.66) }}
          resizeMode="contain"
          accessibilityLabel={target.name}
          onLoad={(event) => {
            const natural = (event as unknown as { nativeEvent?: { source?: { width?: number; height?: number } } })
              .nativeEvent?.source
            const width = natural?.width ?? 0
            const height = natural?.height ?? 0
            if (!width || !height) return
            const scale = Math.min(MAX_WIDTH / width, MAX_HEIGHT / height, 1)
            setSize({ width: Math.round(width * scale), height: Math.round(height * scale) })
          }}
          onError={() => setFailed(true)}
        />
      )}
    </Pressable>
  )
}

function VideoCard({ target, onOpen }: { target: InlineMediaTarget; onOpen: OpenShareFile }) {
  const window = useWindowDimensions()
  const width = Math.min(MAX_WIDTH, Math.max(200, window.width - 96))
  const uri = resolveChatAttachmentUrl(target.href)

  return (
    <Pressable
      onPress={() => onOpen(viewerTarget(target))}
      accessibilityRole="imagebutton"
      accessibilityLabel={`Open ${target.name}`}
      testID="chat-file-preview-video"
      className="overflow-hidden rounded-lg border border-border bg-black active:opacity-80"
    >
      {Platform.OS === "web" ? (
        <video
          src={uri}
          preload="metadata"
          muted
          playsInline
          title={target.name}
          aria-label={target.name}
          className="block max-h-[320px] w-auto max-w-full"
        />
      ) : (
        <View
          className="items-center justify-center gap-1.5"
          style={{ width, height: Math.round((width * 9) / 16) }}
        >
          <View className="h-9 w-9 items-center justify-center rounded-full bg-white/15">
            <Play size={16} color="#fff" />
          </View>
          <Text className="px-3 text-[11px] text-white" numberOfLines={1}>
            {target.name}
          </Text>
        </View>
      )}
    </Pressable>
  )
}

/** One card, for a host that already knows the file (the `share_file` tool card). */
export function ChatFilePreviewCard({ target }: { target: InlineMediaTarget }) {
  const openShareFile = useShareFileOpener()
  if (!openShareFile) return null
  return target.mediaKind === "video" ? (
    <VideoCard target={target} onOpen={openShareFile} />
  ) : (
    <ImageCard target={target} onOpen={openShareFile} />
  )
}

export interface ChatFilePreviewsProps {
  /** The message body, as rendered. */
  text: string
  /** True while the message grows: a half-written URL never becomes a card. */
  isStreaming?: boolean
  /** Cards to draw; the rest stay chips. */
  max?: number
  className?: string
}

export function ChatFilePreviews({ text, isStreaming, max = MAX_CARDS, className }: ChatFilePreviewsProps) {
  const openShareFile = useShareFileOpener()
  const targets = useMemo(
    () => extractInlineMediaLinks(text, { isStreaming }).slice(0, max),
    [text, isStreaming, max],
  )
  // Without an opener the chip is all there is; a card that opens nothing is
  // worse than no card.
  if (!openShareFile || targets.length === 0) return null

  return (
    <View className={cn("mt-1 flex-row flex-wrap items-start gap-1.5", className)} testID="chat-file-previews">
      {targets.map((target) =>
        target.mediaKind === "video" ? (
          <VideoCard key={target.href} target={target} onOpen={openShareFile} />
        ) : (
          <ImageCard key={target.href} target={target} onOpen={openShareFile} />
        ),
      )}
    </View>
  )
}

export default ChatFilePreviews
