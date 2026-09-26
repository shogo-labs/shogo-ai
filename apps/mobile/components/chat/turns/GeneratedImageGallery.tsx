// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { useCallback, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Image,
  Pressable,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import { ImageIcon } from "lucide-react-native";
import type { ToolCallData } from "../tools/types";
import { useChatContextSafe } from "../ChatContext";
import { useAgentImageSource } from "../../../lib/agent-image-source";
import { buildAgentWorkspaceUrl } from "../../../lib/agent-workspace-url";
import { parseImageSize } from "./image-sizing";
import { ImagePreviewModal } from "../ImagePreviewModal";
import {
  getGenerateImagePaths,
  parseGenerateImageResult,
  type GenerateImageResult,
} from "./generate-image-result";
import { runGeneratedImageAction } from "../generated-image-actions";

export interface GeneratedImageGalleryProps {
  tools: Array<{ tool: ToolCallData; id: string }>;
}

function GalleryTile({
  id,
  result,
  agentUrl,
  width,
  onPress,
}: {
  id: string;
  result: GenerateImageResult;
  agentUrl: string;
  width: number;
  onPress: () => void;
}) {
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const aspectRatio = parseImageSize(result.size);
  const url = buildAgentWorkspaceUrl(agentUrl, result.path!);
  const source = useAgentImageSource(url);

  return (
    <Pressable
      onPress={onPress}
      disabled={!url}
      testID="generated-image-card"
      className="overflow-hidden rounded-xl border border-border bg-muted/30"
      style={{ width, aspectRatio }}
      accessibilityRole="button"
      accessibilityLabel={`Open generated image ${id}`}
    >
      {!loaded || failed ? (
        <View className="absolute inset-0 items-center justify-center">
          {failed ? (
            <>
              <ImageIcon size={20} className="text-muted-foreground" />
              <Text className="mt-1 text-[10px] text-muted-foreground">
                Unavailable
              </Text>
            </>
          ) : (
            <ActivityIndicator size="small" />
          )}
        </View>
      ) : null}
      {source ? (
        <Image
          source={source}
          resizeMode="cover"
          onLoad={() => setLoaded(true)}
          onError={() => setFailed(true)}
          style={{
            width: "100%",
            height: "100%",
            opacity: loaded && !failed ? 1 : 0,
          }}
        />
      ) : null}
    </Pressable>
  );
}

export function GeneratedImageGallery({ tools }: GeneratedImageGalleryProps) {
  const chatContext = useChatContextSafe();
  const { width: viewportWidth } = useWindowDimensions();
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const galleryWidth = Math.min(420, Math.max(220, viewportWidth - 48));
  const tileWidth = (galleryWidth - 8) / 2;

  const items = useMemo(
    () =>
      tools.flatMap(({ tool, id }) => {
        const result = parseGenerateImageResult(tool.result);
        const paths = getGenerateImagePaths(result);
        if (!result || paths.length === 0 || !chatContext?.agentUrl) return [];
        return paths.map((path, index) => ({
          id: paths.length > 1 ? `${id}-${index + 1}` : id,
          result: {
            ...result,
            path,
            revised_prompt:
              result.revised_prompts?.[index] ?? result.revised_prompt,
          },
          url: buildAgentWorkspaceUrl(chatContext.agentUrl!, path),
        }));
      }),
    [chatContext?.agentUrl, tools],
  );

  const selected = selectedIndex == null ? null : items[selectedIndex];
  const modalItems = items.map((item) => ({
    url: item.url,
    title: "Generated image",
    alt: `Generated image: ${item.result.revised_prompt || "AI generated"}`,
  }));

  const handleSave = useCallback(
    (url: string) =>
      runGeneratedImageAction("save", url, "generated-image", "image/png"),
    [],
  );
  const handleShare = useCallback(
    (url: string) =>
      runGeneratedImageAction("share", url, "generated-image", "image/png"),
    [],
  );

  return (
    <>
      <View
        testID="generated-image-gallery"
        className="mx-3 my-1.5 flex-row flex-wrap gap-2"
        style={{ width: galleryWidth }}
        accessibilityLabel={`${items.length} generated images`}
      >
        {items.map((item) => (
          <GalleryTile
            key={item.id}
            id={item.id}
            result={item.result}
            agentUrl={chatContext?.agentUrl ?? ""}
            width={tileWidth}
            onPress={() =>
              setSelectedIndex(
                items.findIndex((candidate) => candidate.id === item.id),
              )
            }
          />
        ))}
      </View>
      {selected ? (
        <ImagePreviewModal
          visible
          onClose={() => setSelectedIndex(null)}
          url={selected.url}
          gallery={modalItems}
          initialIndex={selectedIndex ?? 0}
          title="Generated image"
          alt={`Generated image: ${selected.result.revised_prompt || "AI generated"}`}
          onSave={handleSave}
          onShare={handleShare}
        />
      ) : null}
    </>
  );
}

export default GeneratedImageGallery;
