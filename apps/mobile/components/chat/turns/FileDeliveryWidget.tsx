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
import { FileTypeIcon } from "../FileTypeIcon";

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

  const expires = `Link expires ${formatExpiry(expiresAt)}`;

  return (
    <View className={cn("items-start", className)}>
      <View className="max-w-full flex-row items-center overflow-hidden rounded-md border border-border bg-muted/40">
        <Pressable
          onPress={download}
          disabled={busy}
          accessibilityRole="link"
          accessibilityLabel={`Download ${name}. ${expires}`}
          // @ts-expect-error -- web-only tooltip
          title={`Download ${name} · ${expires}`}
          testID="file-delivery-chip"
          className="shrink flex-row items-center gap-1.5 py-1 pl-2 pr-1.5 hover:bg-muted active:opacity-70"
        >
          {busy ? <ActivityIndicator size="small" /> : <FileTypeIcon path={name} size={14} />}
          <Text className="shrink text-[11px] font-medium text-foreground" numberOfLines={1}>
            {busy ? "Preparing…" : name}
          </Text>
          <Download size={12} className="text-muted-foreground" />
        </Pressable>
        <Pressable
          onPress={copyLink}
          accessibilityRole="button"
          accessibilityLabel={copied ? "Link copied" : "Copy download link"}
          // @ts-expect-error -- web-only tooltip
          title={copied ? "Copied" : "Copy link"}
          className="self-stretch justify-center border-l border-border px-1.5 hover:bg-muted active:opacity-70"
        >
          {copied ? <Check size={12} className="text-muted-foreground" /> : <Copy size={12} className="text-muted-foreground" />}
        </Pressable>
      </View>
      {error ? <Text className="mt-1 text-[10px] text-destructive">{error}</Text> : null}
    </View>
  );
}

export default FileDeliveryWidget;
