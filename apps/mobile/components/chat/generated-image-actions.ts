// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { InteractionManager, Platform, Share } from "react-native";
import { agentFetch } from "../../lib/agent-fetch";
import { downloadImage } from "./chatImageActions";

export type GeneratedImageAction = "save" | "share";

function safeFilename(title: string): string {
  const value = title
    .trim()
    .replace(/[^a-z0-9._-]+/gi, "-")
    .replace(/^-+|-+$/g, "");
  return value || "generated-image";
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

async function prepareNativeImageFile(
  url: string,
  title: string,
  mediaType = "image/png",
): Promise<string> {
  const response = await agentFetch(url);
  if (!response.ok)
    throw new Error(`Image request failed (${response.status})`);

  const { cacheDirectory, writeAsStringAsync, EncodingType } =
    await import("expo-file-system/legacy");
  if (!cacheDirectory) throw new Error("Could not access app storage");

  const extension =
    mediaType.includes("jpeg") || mediaType.includes("jpg") ? "jpg" : "png";
  const fileUri = `${cacheDirectory}${safeFilename(title)}-${Date.now()}.${extension}`;
  await writeAsStringAsync(
    fileUri,
    arrayBufferToBase64(await response.arrayBuffer()),
    {
      encoding: EncodingType.Base64,
    },
  );
  return fileUri;
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
    const Sharing = await import("expo-sharing");
    try {
      await Sharing.shareAsync(fileUri, { dialogTitle: `Share ${title}` });
    } catch (error) {
      if (Platform.OS !== "ios") throw error;
      await Share.share({ url: fileUri, title });
    }
    return;
  }

  const MediaLibrary = await import("expo-media-library");
  const permission = await MediaLibrary.requestPermissionsAsync();
  if (permission.status !== "granted") {
    throw new Error("Photo access is required to save this image");
  }
  await MediaLibrary.saveToLibraryAsync(fileUri);
}
