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

export interface ComposerAttachedFile {
  id: string;
  dataUrl: string;
  name: string;
  type: string;
  size: number;
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
  const base64 = dataUrl.includes(",")
    ? dataUrl.split(",").pop() || ""
    : dataUrl;
  return Math.max(0, Math.floor((base64.length * 3) / 4));
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
    setPendingFiles((previous) =>
      previous.filter((file) => file.id !== fileId),
    );
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

        const reader = new FileReader();
        reader.onload = () => {
          const dataUrl =
            typeof reader.result === "string" ? reader.result : "";
          if (!dataUrl) {
            reportError(`Could not read "${file.name}".`);
            finished();
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
                id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
                dataUrl,
                name: file.name,
                type: file.type,
                size: file.size,
              },
            ];
          });
          finished();
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
    handleWebFileChange,
    addPastedText,
    handleRemovePastedText,
    handleUpdatePastedText,
    handlePastedTextChange,
    resetAttachments,
  };
}
