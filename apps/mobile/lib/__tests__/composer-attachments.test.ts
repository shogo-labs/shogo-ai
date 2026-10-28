// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { afterEach, describe, expect, mock, test } from "bun:test";
import { act, renderHook } from "@testing-library/react";
import {
  isComposerArchive,
  MAX_FILE_SIZE,
  MAX_FILES,
  releasePreviewUrl,
  useComposerAttachments,
} from "../composer-attachments";
import { CHAT_REFS_MIME, encodeChatDragPayload } from "../chat-drag";

function picked(index: number) {
  return {
    id: `file-${index}`,
    dataUrl: "data:text/plain;base64,Zm",
    name: `file-${index}.txt`,
    type: "text/plain",
    size: 4,
  };
}

describe("composer attachments", () => {
  const originalFileReader = globalThis.FileReader;

  afterEach(() => {
    globalThis.FileReader = originalFileReader;
  });

  test("enforces the shared file limit for native picked files", () => {
    const { result } = renderHook(() =>
      useComposerAttachments({ enableDomEvents: false }),
    );

    act(() => {
      result.current.applyPickedFiles(
        Array.from({ length: MAX_FILES + 1 }, (_, index) => picked(index)),
      );
    });

    expect(result.current.pendingFiles).toHaveLength(MAX_FILES);
    expect(result.current.fileError).toBe(`Maximum ${MAX_FILES} files allowed`);
  });

  test("rejects oversized non-archive files", () => {
    const { result } = renderHook(() =>
      useComposerAttachments({ enableDomEvents: false }),
    );
    const originalReader = globalThis.FileReader;
    class ImmediateFileReader {
      result: string | null = null;
      onload: (() => void) | null = null;
      readAsDataURL() {
        this.result = "data:text/plain;base64,Zm9v";
        this.onload?.();
      }
    }
    globalThis.FileReader = ImmediateFileReader as unknown as typeof FileReader;

    act(() => {
      result.current.processFiles([
        {
          name: "large.txt",
          type: "text/plain",
          size: MAX_FILE_SIZE + 1,
        } as File,
      ]);
    });

    expect(result.current.pendingFiles).toHaveLength(0);
    expect(result.current.fileError).toContain("large.txt");
    globalThis.FileReader = originalReader;
  });

  test("allows oversized zip and shogo project archives", () => {
    expect(isComposerArchive("bundle.zip", "application/octet-stream")).toBe(
      true,
    );
    expect(
      isComposerArchive("workspace.shogo", "application/octet-stream"),
    ).toBe(true);
    expect(
      isComposerArchive("workspace.shogo-project", "application/octet-stream"),
    ).toBe(true);

    const { result } = renderHook(() =>
      useComposerAttachments({ enableDomEvents: false }),
    );
    const originalReader = globalThis.FileReader;
    class ImmediateFileReader {
      result: string | null = null;
      onload: (() => void) | null = null;
      readAsDataURL() {
        this.result = "data:application/zip;base64,Zm9v";
        this.onload?.();
      }
    }
    globalThis.FileReader = ImmediateFileReader as unknown as typeof FileReader;

    act(() => {
      result.current.processFiles([
        {
          name: "bundle.zip",
          type: "application/octet-stream",
          size: MAX_FILE_SIZE + 1,
        } as File,
      ]);
    });

    expect(result.current.pendingFiles).toHaveLength(1);
    expect(result.current.fileError).toBeNull();
    globalThis.FileReader = originalReader;
  });

  test("gives a pick with no inline bytes an object URL to paint from", () => {
    // A web zip is uploaded at send time, so it has no data URL — the chip and
    // the optimistic bubble would have nothing to show (QA round 1, SHO-213).
    const created: File[] = [];
    const revoked: string[] = [];
    const originalCreate = (URL as any).createObjectURL;
    const originalRevoke = (URL as any).revokeObjectURL;
    ;(URL as any).createObjectURL = (file: File) => {
      created.push(file);
      return `blob:preview-${created.length}`;
    };
    ;(URL as any).revokeObjectURL = (url: string) => {
      revoked.push(url);
    };

    try {
      const { result } = renderHook(() =>
        useComposerAttachments({ enableDomEvents: false }),
      );
      const zip = {
        name: "bundle.zip",
        type: "application/zip",
        size: MAX_FILE_SIZE + 1,
      } as File;

      act(() => {
        result.current.processFiles([zip]);
      });

      expect(result.current.pendingFiles).toHaveLength(1);
      expect(result.current.pendingFiles[0].dataUrl).toBe("");
      expect(result.current.pendingFiles[0].previewUrl).toBe("blob:preview-1");
      expect(created[0]).toBe(zip);

      // Removing the chip releases the URL it created.
      act(() => {
        result.current.handleRemoveFile(result.current.pendingFiles[0].id);
      });
      expect(result.current.pendingFiles).toHaveLength(0);
      expect(revoked).toEqual(["blob:preview-1"]);
    } finally {
      ;(URL as any).createObjectURL = originalCreate;
      ;(URL as any).revokeObjectURL = originalRevoke;
    }
  });

  test("releases only the object URLs it owns", () => {
    const revoked: string[] = [];
    const originalRevoke = (URL as any).revokeObjectURL;
    ;(URL as any).revokeObjectURL = (url: string) => {
      revoked.push(url);
    };
    try {
      releasePreviewUrl(undefined);
      releasePreviewUrl("data:image/png;base64,AAA");
      releasePreviewUrl("https://example.test/files/a.zip");
      releasePreviewUrl("blob:preview-2");
      expect(revoked).toEqual(["blob:preview-2"]);
    } finally {
      ;(URL as any).revokeObjectURL = originalRevoke;
    }
  });
});

describe("composer drop zone: chat references", () => {
  const originalFileReader = globalThis.FileReader;
  afterEach(() => {
    globalThis.FileReader = originalFileReader;
  });

  function dragEvent(type: string, data: Record<string, string>, files: File[] = []) {
    const event = new Event(type, { bubbles: true, cancelable: true }) as any;
    event.dataTransfer = {
      types: [...Object.keys(data), ...(files.length ? ["Files"] : [])],
      files,
      dropEffect: "none",
      getData: (t: string) => data[t] ?? "",
    };
    return event;
  }

  function mount(onReferenceDrop = mock((..._args: any[]) => {})) {
    const node = document.createElement("div");
    document.body.appendChild(node);
    const hook = renderHook(() => {
      const value = useComposerAttachments({ onReferenceDrop });
      (value.dropZoneRef as any).current = node;
      return value;
    });
    // The DOM listeners bind in an effect after the ref is set.
    hook.rerender();
    return { node, hook, onReferenceDrop };
  }

  const payload = encodeChatDragPayload([
    { kind: "file", path: "src/a.ts", name: "a.ts", rootId: "agent" },
    { kind: "file", path: "x.ts", name: "x.ts", rootId: "local:repo:1" },
  ]);

  test("a reference payload calls onReferenceDrop and never processes files", () => {
    class FailingReader {
      readAsDataURL() {
        throw new Error("processFiles must not run for a reference drop");
      }
    }
    globalThis.FileReader = FailingReader as unknown as typeof FileReader;
    const { node, hook, onReferenceDrop } = mount();
    const file = { name: "os.txt", type: "text/plain", size: 3 } as File;
    act(() => {
      node.dispatchEvent(dragEvent("drop", { [CHAT_REFS_MIME]: payload }, [file]));
    });
    expect(onReferenceDrop).toHaveBeenCalledTimes(1);
    const [refs, skipped] = onReferenceDrop.mock.calls[0];
    expect(refs).toEqual([{ type: "file", path: "src/a.ts", name: "a.ts" }]);
    expect(skipped).toEqual(["x.ts"]);
    expect(hook.result.current.pendingFiles).toHaveLength(0);
  });

  test("OS files are still attached", () => {
    class ImmediateFileReader {
      result: string | null = null;
      onload: (() => void) | null = null;
      readAsDataURL() {
        this.result = "data:text/plain;base64,Zm9v";
        this.onload?.();
      }
    }
    globalThis.FileReader = ImmediateFileReader as unknown as typeof FileReader;
    const { node, hook, onReferenceDrop } = mount();
    act(() => {
      node.dispatchEvent(dragEvent("drop", {}, [{ name: "os.txt", type: "text/plain", size: 3 } as File]));
    });
    expect(onReferenceDrop).not.toHaveBeenCalled();
    expect(hook.result.current.pendingFiles).toHaveLength(1);
  });

  test("dragover with references asks for a copy; dragKind tracks enter/leave", () => {
    const { node, hook } = mount();
    expect(hook.result.current.dragKind).toBeNull();
    act(() => {
      node.dispatchEvent(dragEvent("dragenter", { [CHAT_REFS_MIME]: payload }));
    });
    expect(hook.result.current.isDragOver).toBe(true);
    expect(hook.result.current.dragKind).toBe("references");
    const over = dragEvent("dragover", { [CHAT_REFS_MIME]: payload });
    act(() => {
      node.dispatchEvent(over);
    });
    expect(over.dataTransfer.dropEffect).toBe("copy");
    act(() => {
      node.dispatchEvent(dragEvent("dragleave", {}));
    });
    expect(hook.result.current.dragKind).toBeNull();
    act(() => {
      node.dispatchEvent(dragEvent("dragenter", {}, [{ name: "f", type: "", size: 1 } as File]));
    });
    expect(hook.result.current.dragKind).toBe("files");
  });

  test("without an onReferenceDrop handler, reference drags are treated as plain drags", () => {
    const node = document.createElement("div");
    const hook = renderHook(() => {
      const value = useComposerAttachments({});
      (value.dropZoneRef as any).current = node;
      return value;
    });
    hook.rerender();
    act(() => {
      node.dispatchEvent(dragEvent("dragenter", { [CHAT_REFS_MIME]: payload }));
    });
    expect(hook.result.current.dragKind).toBe("files");
  });
});
