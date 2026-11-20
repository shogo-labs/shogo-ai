// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { InteractionManager, Platform } from "react-native";
import { nativeAuthHeaders } from "../../lib/agent-fetch";
import { downloadFileToCache, shareCachedFile } from "../../lib/download-to-file";
import { downloadImage } from "./chatImageActions";

export type GeneratedImageAction = "save" | "share";

function safeFilename(title: string): string {
  const value = title
    .trim()
    .replace(/[^a-z0-9._-]+/gi, "-")
    .replace(/^-+|-+$/g, "");
  return value || "generated-image";
}

function extensionFor(mediaType: string): string {
  if (mediaType.startsWith("video/")) return "mp4";
  return mediaType.includes("jpeg") || mediaType.includes("jpg") ? "jpg" : "png";
}

/**
 * The generated image or clip on disk, so the share sheet and the photo library
 * can take it.
 *
 * The bytes are streamed by the platform's own downloader (SHO-434): generating
 * a large image used to read the response into an `ArrayBuffer`, copy it into a
 * binary string and `btoa()` that into base64 — three copies of the picture on
 * the JS heap, and on Android a single allocation big enough to throw
 * `OutOfMemoryError`.
 */
async function prepareNativeImageFile(
  url: string,
  title: string,
  mediaType = "image/png",
): Promise<string> {
  return downloadFileToCache(url, {
    name: `${safeFilename(title)}.${extensionFor(mediaType)}`,
    headers: nativeAuthHeaders(),
  });
}

export async function runGeneratedImageAction(
  action: GeneratedImageAction,
  url: string,
  title = "generated-image",
  mediaType = "image/png",
): Promise<void> {
  if (Platform.OS === "web") {
    if (action === "save") {
      await downloadImage(url, title, mediaType);
      return;
    }
    if (
      typeof navigator !== "undefined" &&
      typeof navigator.share === "function"
    ) {
      await navigator.share({ title, url });
      return;
    }
    await downloadImage(url, title, mediaType);
    return;
  }

  const fileUri = await prepareNativeImageFile(url, title, mediaType);
  await new Promise<void>((resolve) => {
    InteractionManager.runAfterInteractions(() => resolve());
  });

  if (action === "share") {
    await shareCachedFile(fileUri, title);
    return;
  }

  const MediaLibrary = await import("expo-media-library/legacy");
  // Android 13+ can add a new image without access to existing photos.
  // Older Android releases still need the legacy write permission.
  if (Platform.OS !== "android" || Number(Platform.Version) < 33) {
    const permission = await MediaLibrary.requestPermissionsAsync(true);
    if (permission.status !== "granted") {
      throw new Error("Allow Shogo to save images to your photo library");
    }
  }
  await MediaLibrary.saveToLibraryAsync(fileUri);
}
