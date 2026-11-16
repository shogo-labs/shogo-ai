// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { useCallback, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Platform,
  Pressable,
  Text,
  View,
} from "react-native";
import { Check, Copy, Download } from "lucide-react-native";
import { cn } from "@shogo/shared-ui/primitives";
import type { ToolCallData } from "../tools/types";
import { FileTypeIcon } from "../FileTypeIcon";
import { useShareFileOpener } from "../share-file-context";
import { parseInAppFileHref } from "../../../lib/share-file-links";
import { downloadAttachment } from "../../../lib/attachment-download";
import { fileViewKind } from "../../files/file-view-kind";
import { ChatFilePreviewCard } from "../ChatFilePreviews";
import type { InlineMediaTarget } from "../inline-file-previews";

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
  // A local desktop share is a `file://` link to a file on this machine: no
  // token, no expiry, and the absolute path is what the user copies.
  const isLocal = result.local === true;
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const openShareFile = useShareFileOpener();
  const servedFile = useMemo(() => (url ? parseInAppFileHref(url) : null), [url]);
  const copyValue = isLocal ? path : url;

  const copyLink = useCallback(async () => {
    if (!copyValue) return;
    try {
      if (Platform.OS === "web" && typeof navigator !== "undefined" && navigator.clipboard) {
        await navigator.clipboard.writeText(copyValue);
      } else {
        const Clipboard = await import("expo-clipboard");
        await Clipboard.setStringAsync(copyValue);
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      setError(isLocal ? "Could not copy path" : "Could not copy link");
    }
  }, [copyValue, isLocal]);

  /**
   * The chip opens the app's viewer on every platform, not just the web — the
   * viewer draws the picture / plays the clip / renders the PDF, where the OS
   * share sheet could only hand the file to another app (SHO-388). The separate
   * Download control still saves it.
   */
  const open = useCallback(() => {
    if (servedFile && openShareFile) {
      openShareFile({ ...servedFile, name: servedFile.name === "Download" ? name : servedFile.name });
      return;
    }
    if (!url || typeof document === "undefined") return;
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = name;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
  }, [name, openShareFile, servedFile, url]);

  const download = useCallback(async () => {
    if (!url || busy) return;
    setError(null);
    setBusy(true);
    try {
      await downloadAttachment(url, name);
    } catch (caught: any) {
      setError(caught?.message ?? "Download failed");
    } finally {
      setBusy(false);
    }
  }, [busy, name, url]);

  const mediaTarget = useMemo<InlineMediaTarget | null>(() => {
    if (!servedFile) return null;
    const label = servedFile.name === "Download" ? name : servedFile.name;
    const mediaKind = fileViewKind(label, null);
    if (mediaKind !== "image" && mediaKind !== "video") return null;
    return { ...servedFile, name: label, mediaKind };
  }, [name, servedFile]);

  if (tool.state !== "success" || !url) return null;

  const expires = `Link expires ${formatExpiry(expiresAt)}`;
  // A local share has no expiry to report; the path is the useful detail.
  const subtitle = isLocal ? path : expires;
  const opensInViewer = !!servedFile && !!openShareFile;
  const actionLabel = opensInViewer || isLocal ? `Open ${name}` : `Download ${name}`;
  const chipTitle = `${actionLabel} · ${subtitle}`;
  const accessibilityLabel = opensInViewer ? actionLabel : `Download ${name}. ${expires}`;

  return (
    <View className={cn("items-start gap-1.5", className)}>
      {mediaTarget ? <ChatFilePreviewCard target={mediaTarget} /> : null}
      <View className="max-w-full flex-row items-center overflow-hidden rounded-md border border-border bg-muted/40">
        <Pressable
          onPress={open}
          accessibilityRole="link"
          accessibilityLabel={accessibilityLabel}
          // @ts-expect-error -- web-only tooltip
          title={chipTitle}
          testID="file-delivery-chip"
          className="shrink flex-row items-center gap-1.5 py-1 pl-2 pr-1.5 hover:bg-muted active:opacity-70"
        >
          <FileTypeIcon path={name} size={14} />
          <Text className="shrink text-[11px] font-medium text-foreground" numberOfLines={1}>
            {name}
          </Text>
        </Pressable>
        <Pressable
          onPress={download}
          disabled={busy}
          accessibilityRole="button"
          accessibilityLabel={`Download ${name}`}
          // @ts-expect-error -- web-only tooltip
          title={`Download ${name}`}
          testID="file-delivery-download"
          className="self-stretch justify-center border-l border-border px-1.5 hover:bg-muted active:opacity-70"
        >
          {busy ? <ActivityIndicator size="small" /> : <Download size={12} className="text-muted-foreground" />}
        </Pressable>
        <Pressable
          onPress={copyLink}
          accessibilityRole="button"
          accessibilityLabel={copied ? "Copied" : isLocal ? "Copy file path" : "Copy download link"}
          // @ts-expect-error -- web-only tooltip
          title={copied ? "Copied" : isLocal ? "Copy path" : "Copy link"}
          className="self-stretch justify-center border-l border-border px-1.5 hover:bg-muted active:opacity-70"
        >
          {copied ? <Check size={12} className="text-muted-foreground" /> : <Copy size={12} className="text-muted-foreground" />}
        </Pressable>
      </View>
      {isLocal ? (
        <Text className="mt-1 max-w-full text-[10px] text-muted-foreground" numberOfLines={1}>
          {path}
        </Text>
      ) : null}
      {error ? <Text className="mt-1 text-[10px] text-destructive">{error}</Text> : null}
    </View>
  );
}

export default FileDeliveryWidget;
