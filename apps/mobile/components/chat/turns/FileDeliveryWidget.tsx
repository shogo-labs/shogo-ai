// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { useCallback, useMemo, useState } from "react";
import {
  ActivityIndicator,
  InteractionManager,
  Platform,
  Pressable,
  Text,
  View,
} from "react-native";
import { Check, Copy, Download } from "lucide-react-native";
import { cn } from "@shogo/shared-ui/primitives";
import type { ToolCallData } from "../tools/types";

function resultObject(result: unknown): Record<string, unknown> {
  if (result && typeof result === "object") return result as Record<string, unknown>;
  if (typeof result === "string") {
    try {
      const parsed = JSON.parse(result);
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

function formatExpiry(value: unknown): string {
  if (typeof value !== "string") return "soon";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "soon";
  return date.toLocaleDateString();
}

function basename(path: string): string {
  return path.split(/[\\/]/).pop() || "download";
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

export interface FileDeliveryWidgetProps {
  tool: ToolCallData;
  className?: string;
}

export function FileDeliveryWidget({ tool, className }: FileDeliveryWidgetProps) {
  const result = useMemo(() => resultObject(tool.result), [tool.result]);
  const url = typeof result.url === "string" ? result.url : null;
  const path = typeof result.path === "string" ? result.path : "download";
  const name = typeof result.filename === "string" ? result.filename : basename(path);
  const expiresAt = result.expiresAt;
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const copyLink = useCallback(async () => {
    if (!url) return;
    try {
      if (Platform.OS === "web" && typeof navigator !== "undefined" && navigator.clipboard) {
        await navigator.clipboard.writeText(url);
      } else {
        const Clipboard = await import("expo-clipboard");
        await Clipboard.setStringAsync(url);
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      setError("Could not copy link");
    }
  }, [url]);

  const download = useCallback(async () => {
    if (!url || busy) return;
    setError(null);
    if (Platform.OS === "web") {
      if (typeof document === "undefined") return;
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = name;
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
      return;
    }

    setBusy(true);
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Download failed (${response.status})`);
      const base64 = arrayBufferToBase64(await response.arrayBuffer());
      const { cacheDirectory, writeAsStringAsync, EncodingType } =
        await import("expo-file-system/legacy");
      const Sharing = await import("expo-sharing");
      if (!cacheDirectory) throw new Error("Could not access app storage");
      const fileUri = `${cacheDirectory}${Date.now()}-${name}`;
      await writeAsStringAsync(fileUri, base64, { encoding: EncodingType.Base64 });
      await new Promise<void>((resolve) => {
        InteractionManager.runAfterInteractions(() => resolve());
      });
      try {
        await Sharing.shareAsync(fileUri, { dialogTitle: `Download ${name}` });
      } catch (shareError) {
        if (Platform.OS !== "ios") throw shareError;
        const { Share } = await import("react-native");
        await Share.share({ url: fileUri, title: name });
      }
    } catch (caught: any) {
      setError(caught?.message ?? "Download failed");
    } finally {
      setBusy(false);
    }
  }, [busy, name, url]);

  if (tool.state !== "success" || !url) return null;

  return (
    <View className={cn("rounded-md border border-border/60 bg-muted/20 px-2.5 py-2", className)}>
      <View className="flex-row items-center gap-1.5">
        <Download size={13} className="text-foreground" />
        <Text className="flex-1 text-[11px] font-medium text-foreground" numberOfLines={1}>
          {name}
        </Text>
        <Text className="text-[10px] text-muted-foreground">
          Expires {formatExpiry(expiresAt)}
        </Text>
      </View>
      <Text className="mt-1 text-[10px] text-muted-foreground" selectable numberOfLines={2}>
        {url}
      </Text>
      <View className="mt-2 flex-row gap-2">
        <Pressable
          onPress={download}
          disabled={busy}
          accessibilityRole="button"
          accessibilityLabel={`Download ${name}`}
          className="flex-row items-center gap-1 rounded-md border border-border bg-background px-2.5 py-1.5 active:opacity-70"
        >
          {busy ? <ActivityIndicator size="small" /> : <Download size={12} className="text-foreground" />}
          <Text className="text-[11px] font-medium text-foreground">
            {busy ? "Preparing…" : "Download"}
          </Text>
        </Pressable>
        <Pressable
          onPress={copyLink}
          accessibilityRole="button"
          accessibilityLabel="Copy download link"
          className="flex-row items-center gap-1 rounded-md border border-border bg-background px-2.5 py-1.5 active:opacity-70"
        >
          {copied ? <Check size={12} className="text-foreground" /> : <Copy size={12} className="text-foreground" />}
          <Text className="text-[11px] font-medium text-foreground">
            {copied ? "Copied" : "Copy link"}
          </Text>
        </Pressable>
      </View>
      {error ? <Text className="mt-1 text-[10px] text-destructive">{error}</Text> : null}
    </View>
  );
}

export default FileDeliveryWidget;
