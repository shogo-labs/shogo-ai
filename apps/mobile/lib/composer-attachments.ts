// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import {
  createElement,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Platform, type View } from "react-native";
import type { ComponentType } from "react";
import {
  File as FileIcon,
  FileText,
  Image as ImageIcon,
} from "lucide-react-native";
import {
  analyzeContent,
  extractLongPaste,
  LONG_PASTE_MIN_CHARS,
  MAX_PASTED_TEXTS,
  type PastedTextEntry,
} from "../components/chat/long-text-utils";
import type { NativePickedAttachment } from "./native-attachment-picker";

export const MAX_FILES = 10;
export const MAX_FILE_SIZE = 10 * 1024 * 1024;

/**
 * Above this size a picked file keeps its `File`/`uri` and is uploaded at send
 * time instead of being read into a base64 data URL in the composer.
 */
export const MAX_INLINE_PICK_BYTES = 8 * 1024 * 1024;

export interface ComposerAttachedFile {
  id: string;
  /**
   * Inline bytes. Empty for an attachment picked without a base64 read — a
   * large document or archive, whose bytes are uploaded straight from `uri`
   * (native) or `file` (web) instead (SHO-213).
   */
  dataUrl: string;
  name: string;
  type: string;
  size: number;
  /** Native: the picked file on disk, so the upload can skip base64. */
  uri?: string;
  /** Web: the picked `File`, so the upload can stream it. */
  file?: File;
  /**
   * Web: `URL.createObjectURL(file)` for a pick that has no inline bytes.
   * The chip and the optimistic bubble need something to paint before the
   * upload replaces the local source with a workspace URL (SHO-213).
   */
  previewUrl?: string;
  /** Voice notes: clip length in ms. */
  durationMs?: number;
  /** Voice notes: waveform levels 0-100, space separated. */
  peaks?: string;
}

export type ComposerFileIcon = ComponentType<{
  size?: number;
  className?: string;
  color?: string;
  strokeWidth?: number;
}>;

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Returns true for project archives, which intentionally bypass the byte limit. */
export function isComposerArchive(name: string, type = ""): boolean {
  const lowerName = name.toLowerCase();
  const lowerType = type.toLowerCase();
  return (
    lowerName.endsWith(".zip") ||
    lowerName.endsWith(".shogo") ||
    lowerName.endsWith(".shogo-project") ||
    lowerType === "application/zip" ||
    lowerType === "application/x-zip-compressed"
  );
}

/** Shared size-limit exception used by web and native attachment flows. */
export function isFileSizeExempt(file: {
  name: string;
  type: string;
}): boolean {
  return isComposerArchive(file.name, file.type);
}

export function estimateDataUrlSize(dataUrl: string): number {
  if (!dataUrl.startsWith("data:")) return 0;
  const base64 = dataUrl.includes(",")
    ? dataUrl.split(",").pop() || ""
    : dataUrl;
  return Math.max(0, Math.floor((base64.length * 3) / 4));
}

/**
 * A URL a web pick can paint from without reading its bytes: an object URL over
 * the same `File`. Null on native or where the API is missing.
 */
export function objectUrlFor(file: File | undefined): string | null {
  if (!file) return null;
  if (typeof URL === "undefined" || typeof URL.createObjectURL !== "function") {
    return null;
  }
  try {
    return URL.createObjectURL(file);
  } catch {
    return null;
  }
}

/** Drop an object URL once the attachment is gone; a no-op for other URLs. */
export function releasePreviewUrl(url: string | undefined): void {
  if (!url || !url.startsWith("blob:")) return;
  if (typeof URL === "undefined" || typeof URL.revokeObjectURL !== "function") {
    return;
  }
  try {
    URL.revokeObjectURL(url);
  } catch {
    /* already revoked */
  }
}

export function getFileIcon(fileType: string): ReactNode {
  const Icon = fileType.startsWith("image/")
    ? ImageIcon
    : fileType.includes("pdf") ||
        fileType.includes("document") ||
        fileType.includes("text")
      ? FileText
      : FileIcon;
  return createElement(Icon, {
    className: "h-4 w-4 text-muted-foreground",
    size: 16,
  });
}

export interface UseComposerAttachmentsOptions {
  maxFiles?: number;
  maxFileSizeBytes?: number;
  /** Set false when a host owns the drop-zone event listeners. */
  enableDomEvents?: boolean;
  onError?: (message: string) => void;
}

export function useComposerAttachments({
  maxFiles = MAX_FILES,
  maxFileSizeBytes = MAX_FILE_SIZE,
  enableDomEvents = true,
  onError,
}: UseComposerAttachmentsOptions = {}) {
  const [pendingFiles, setPendingFiles] = useState<ComposerAttachedFile[]>([]);
  const [fileError, setFileError] = useState<string | null>(null);
  const [isProcessingFiles, setIsProcessingFiles] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  const [pastedTexts, setPastedTexts] = useState<PastedTextEntry[]>([]);
  const [viewingPastedId, setViewingPastedId] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const dropZoneRef = useRef<View>(null);
  const pasteHandledRef = useRef(false);
  const dragCounterRef = useRef(0);

  const reportError = useCallback(
    (message: string) => {
      setFileError(message);
      onError?.(message);
    },
    [onError],
  );

  const handleRemoveFile = useCallback((fileId: string) => {
    setPendingFiles((previous) => {
      const removed = previous.find((file) => file.id === fileId);
      if (removed) releasePreviewUrl(removed.previewUrl);
      return previous.filter((file) => file.id !== fileId);
    });
    setFileError(null);
  }, []);

  const applyPickedFiles = useCallback(
    (picked: NativePickedAttachment[]) => {
      const room = maxFiles - pendingFiles.length;
      if (room <= 0) {
        reportError(`Maximum ${maxFiles} files allowed`);
        return;
      }

      const accepted = picked.filter((file) => {
        if (
          isComposerArchive(file.name, file.type) ||
          file.size <= maxFileSizeBytes
        ) {
          return true;
        }
        reportError(
          `File "${file.name}" exceeds ${maxFileSizeBytes / (1024 * 1024)}MB limit`,
        );
        return false;
      });
      const added = accepted.slice(0, room).map((file) => ({
        id: file.id,
        dataUrl: file.dataUrl,
        name: file.name,
        type: file.type,
        size: file.size,
        ...(file.uri ? { uri: file.uri } : {}),
      }));
      setPendingFiles((previous) => [
        ...previous,
        ...added.slice(0, Math.max(0, maxFiles - previous.length)),
      ]);
      if (accepted.length > room || picked.length > room) {
        reportError(`Maximum ${maxFiles} files allowed`);
      } else if (added.length > 0) {
        setFileError(null);
      }
    },
    [maxFileSizeBytes, maxFiles, pendingFiles.length, reportError],
  );

  const processFiles = useCallback(
    (files: FileList | readonly File[]) => {
      const source = Array.from(files);
      if (source.length === 0) return;
      setIsProcessingFiles(true);
      let remaining = source.length;
      const finished = () => {
        remaining -= 1;
        if (remaining <= 0) setIsProcessingFiles(false);
      };

      source.forEach((file) => {
        if (!isFileSizeExempt(file) && file.size > maxFileSizeBytes) {
          reportError(
            `File "${file.name}" exceeds ${maxFileSizeBytes / (1024 * 1024)}MB limit`,
          );
          finished();
          return;
        }

        const push = (attachment: {
          dataUrl: string;
          name: string;
          type: string;
          size: number;
          file?: File;
          previewUrl?: string;
        }) => {
          setPendingFiles((previous) => {
            if (previous.length >= maxFiles) {
              reportError(`Maximum ${maxFiles} files allowed`);
              return previous;
            }
            setFileError(null);
            return [
              ...previous,
              {
                id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
                ...attachment,
              },
            ];
          });
          finished();
        };

        // A large file (or an archive, which has no size limit) is uploaded
        // straight from the `File` at send time — reading it into a base64 data
        // URL here is what made big attachments time out (SHO-213). It still
        // needs a URL to paint from, so the chip and the optimistic bubble use
        // an object URL over the same `File` (no bytes copied).
        if (isFileSizeExempt(file) || file.size > MAX_INLINE_PICK_BYTES) {
          const previewUrl = objectUrlFor(file);
          push({
            dataUrl: "",
            name: file.name,
            type: file.type,
            size: file.size,
            file,
            ...(previewUrl ? { previewUrl } : {}),
          });
          return;
        }

        const reader = new FileReader();
        reader.onload = () => {
          const dataUrl =
            typeof reader.result === "string" ? reader.result : "";
          if (!dataUrl) {
            reportError(`Could not read "${file.name}".`);
            finished();
            return;
          }
          push({ dataUrl, name: file.name, type: file.type, size: file.size });
        };
        reader.onerror = () => {
          reportError(`Could not read "${file.name}".`);
          finished();
        };
        reader.readAsDataURL(file);
      });
    },
    [maxFileSizeBytes, maxFiles, reportError],
  );

  /**
   * Stage an attachment the caller already built — a voice note, whose bytes
   * never existed as a `File`. Same limits as a picked file.
   */
  const addAttachment = useCallback(
    (attachment: {
      dataUrl: string;
      name: string;
      type: string;
      size: number;
      uri?: string;
      file?: File;
      durationMs?: number;
      peaks?: string;
    }) => {
      if (!attachment.dataUrl && !attachment.uri && !attachment.file) return;
      if (attachment.size > maxFileSizeBytes) {
        reportError(
          `File "${attachment.name}" exceeds ${maxFileSizeBytes / (1024 * 1024)}MB limit`,
        );
        return;
      }
      setPendingFiles((previous) => {
        if (previous.length >= maxFiles) {
          reportError(`Maximum ${maxFiles} files allowed`);
          return previous;
        }
        setFileError(null);
        return [
          ...previous,
          {
            ...attachment,
            id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
          },
        ];
      });
    },
    [maxFileSizeBytes, maxFiles, reportError],
  );

  const handleWebFileChange = useCallback(
    (event: { target?: { files?: FileList | null; value?: string } }) => {
      const files = event.target?.files;
      if (!files || files.length === 0) return;
      processFiles(files);
      if (event.target) event.target.value = "";
    },
    [processFiles],
  );

  const addPastedText = useCallback((content: string) => {
    const info = analyzeContent(content);
    if (!info.isLong) return false;
    setPastedTexts((previous) => {
      if (previous.length >= MAX_PASTED_TEXTS) return previous;
      return [
        ...previous,
        {
          id: `paste-${Date.now()}-${Math.random().toString(36).slice(2)}`,
          content,
          info,
        },
      ];
    });
    return true;
  }, []);

  const handleRemovePastedText = useCallback((id: string) => {
    setPastedTexts((previous) => previous.filter((entry) => entry.id !== id));
    setViewingPastedId((current) => (current === id ? null : current));
  }, []);

  const handleUpdatePastedText = useCallback((id: string, content: string) => {
    setPastedTexts((previous) =>
      previous.map((entry) =>
        entry.id === id
          ? { ...entry, content, info: analyzeContent(content) }
          : entry,
      ),
    );
  }, []);

  /** Native TextInput fallback for long clipboard inserts. */
  const handlePastedTextChange = useCallback(
    (previousText: string, nextText: string): string | null => {
      if (pasteHandledRef.current) {
        pasteHandledRef.current = false;
        return previousText;
      }
      const paste = extractLongPaste(previousText, nextText);
      if (!paste) return null;
      addPastedText(paste.inserted);
      return paste.restored;
    },
    [addPastedText],
  );

  const resetAttachments = useCallback(() => {
    // Preview object URLs are deliberately not revoked here: this runs on
    // submit, and the optimistic bubble still paints from the same URL until
    // the real message (with its workspace URL) replaces it.
    setPendingFiles([]);
    setFileError(null);
    setIsProcessingFiles(false);
    setPastedTexts([]);
    setViewingPastedId(null);
  }, []);

  useEffect(() => {
    if (!enableDomEvents || Platform.OS !== "web") return;
    const node = dropZoneRef.current as unknown as HTMLElement | null;
    if (!node) return;

    const handleDragOver = (event: DragEvent) => {
      event.preventDefault();
      event.stopPropagation();
    };
    const handleDragEnter = (event: DragEvent) => {
      event.preventDefault();
      event.stopPropagation();
      dragCounterRef.current += 1;
      if (dragCounterRef.current === 1) setIsDragOver(true);
    };
    const handleDragLeave = (event: DragEvent) => {
      event.preventDefault();
      event.stopPropagation();
      dragCounterRef.current = Math.max(0, dragCounterRef.current - 1);
      if (dragCounterRef.current === 0) setIsDragOver(false);
    };
    const handleDrop = (event: DragEvent) => {
      event.preventDefault();
      event.stopPropagation();
      dragCounterRef.current = 0;
      setIsDragOver(false);
      if (event.dataTransfer?.files?.length)
        processFiles(event.dataTransfer.files);
    };
    const handlePaste = (event: ClipboardEvent) => {
      const clipboard = event.clipboardData;
      if (!clipboard) return;
      const imageFiles: File[] = [];
      for (let index = 0; index < (clipboard.items?.length ?? 0); index += 1) {
        const item = clipboard.items[index];
        if (item.type.startsWith("image/")) {
          const file = item.getAsFile();
          if (file) imageFiles.push(file);
        }
      }
      if (imageFiles.length > 0) {
        event.preventDefault();
        processFiles(imageFiles);
        return;
      }
      const text = clipboard.getData("text");
      if (text && text.length >= LONG_PASTE_MIN_CHARS && addPastedText(text)) {
        event.preventDefault();
        pasteHandledRef.current = true;
        setTimeout(() => {
          pasteHandledRef.current = false;
        }, 0);
      }
    };

    node.addEventListener("dragover", handleDragOver);
    node.addEventListener("dragenter", handleDragEnter);
    node.addEventListener("dragleave", handleDragLeave);
    node.addEventListener("drop", handleDrop);
    node.addEventListener("paste", handlePaste as EventListener);
    return () => {
      node.removeEventListener("dragover", handleDragOver);
      node.removeEventListener("dragenter", handleDragEnter);
      node.removeEventListener("dragleave", handleDragLeave);
      node.removeEventListener("drop", handleDrop);
      node.removeEventListener("paste", handlePaste as EventListener);
    };
  }, [addPastedText, enableDomEvents, processFiles]);

  const viewingPasted = useMemo(
    () => pastedTexts.find((entry) => entry.id === viewingPastedId) ?? null,
    [pastedTexts, viewingPastedId],
  );

  return {
    pendingFiles,
    setPendingFiles,
    fileError,
    setFileError,
    isProcessingFiles,
    isDragOver,
    pastedTexts,
    setPastedTexts,
    viewingPastedId,
    setViewingPastedId,
    viewingPasted,
    fileInputRef,
    dropZoneRef,
    pasteHandledRef,
    handleRemoveFile,
    applyPickedFiles,
    processFiles,
    addAttachment,
    handleWebFileChange,
    addPastedText,
    handleRemovePastedText,
    handleUpdatePastedText,
    handlePastedTextChange,
    resetAttachments,
  };
}
