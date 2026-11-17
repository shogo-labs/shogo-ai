// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The `share_file` card on a phone used to download the whole file and open the
 * OS share sheet on a tap, so a shared screenshot could never be looked at in
 * the app. The chip now opens the viewer on every platform, and Download stays
 * a control of its own (SHO-388).
 */
import { afterEach, describe, expect, mock, test } from "bun:test"
import { resolve } from "node:path"
import React from "react"
import { createReactNativeMock } from "../../../../test/react-native-mock"
import * as lucideStub from "../../../../test/stubs/lucide-react-native"
import type { ToolCallData } from "../../tools/types"

mock.module("lucide-react-native", () => lucideStub)
mock.module("@shogo/shared-ui/primitives", () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(" "),
}))
mock.module("../../FileTypeIcon", () => ({ FileTypeIcon: () => null }))
mock.module("../../../../lib/agent-image-source", () => ({
  useAgentImageSource: (uri: string | null) => (uri ? { uri } : null),
}))
mock.module("../../../../components/project/panels/ide/FilePreview", () => ({
  FilePreview: () => null,
  previewLanguageFor: (name: string) => {
    const ext = name.split(".").pop()?.toLowerCase() ?? ""
    if (ext === "pdf") return "pdf"
    if (["png", "jpg", "jpeg", "gif", "webp"].includes(ext)) return "image"
    if (["mp4", "mov", "webm"].includes(ext)) return "video"
    return null
  },
}))

const saved: Array<{ url: string; name: string }> = []
mock.module(resolve(import.meta.dir, "../../../../lib/attachment-download"), () => ({
  attachmentDownloadUrl: (url: string) => `${url}&dl=1`,
  downloadAttachment: async (url: string, name: string) => {
    saved.push({ url, name })
  },
}))

mock.module("react-native", () =>
  createReactNativeMock({
    Platform: { OS: "ios", select: (options: Record<string, unknown>) => options.ios ?? options.default },
    useWindowDimensions: () => ({ width: 400, height: 800, scale: 1, fontScale: 1 }),
    Pressable: ({ children, onPress, disabled, testID, accessibilityLabel, ...rest }: Record<string, unknown>) =>
      React.createElement(
        "button",
        {
          ...rest,
          "aria-label": accessibilityLabel as string,
          "data-rn-shim": testID as string,
          disabled: !!disabled,
          onClick: disabled ? undefined : (onPress as () => void),
        },
        children as React.ReactNode,
      ),
    Image: ({ source }: { source?: { uri?: string } }) => (
      <img data-testid="rn-image" data-uri={source?.uri} />
    ),
  } as never),
)

const { cleanup, fireEvent, render, waitFor } = await import("@testing-library/react")
const { FileDeliveryWidget } = await import("../FileDeliveryWidget")
const { ShareFileProvider } = await import("../../share-file-context")

afterEach(() => {
  cleanup()
  saved.length = 0
})

function toolFor(name: string, url = `https://studio.shogo.ai/api/f/${name}`): ToolCallData {
  return {
    id: "share-1",
    toolName: "share_file",
    category: "other",
    state: "success",
    args: { path: name },
    result: { ok: true, url, filename: name, path: name, expiresAt: "2026-10-03T00:00:00.000Z" },
    timestamp: 0,
  } as ToolCallData
}

function query(id: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-rn-shim="${id}"]`)
}

describe("the share_file card on a phone", () => {
  test("a tap opens the app's viewer instead of the OS share sheet", () => {
    const opened: Array<Record<string, unknown>> = []
    render(
      <ShareFileProvider open={(target) => opened.push(target as Record<string, unknown>)}>
        <FileDeliveryWidget tool={toolFor("report.pdf")} />
      </ShareFileProvider>,
    )

    fireEvent.click(query("file-delivery-chip")!)

    expect(opened).toHaveLength(1)
    expect(opened[0]).toMatchObject({ name: "report.pdf" })
    expect(saved).toHaveLength(0)
  })

  test("Download is still a control of its own", async () => {
    const url = "https://studio.shogo.ai/api/f/report.pdf"
    render(
      <ShareFileProvider open={() => {}}>
        <FileDeliveryWidget tool={toolFor("report.pdf", url)} />
      </ShareFileProvider>,
    )

    fireEvent.click(query("file-delivery-download")!)

    await waitFor(() => expect(saved).toEqual([{ url, name: "report.pdf" }]))
  })

  test("a shared picture also previews above the chip", () => {
    render(
      <ShareFileProvider open={() => {}}>
        <FileDeliveryWidget tool={toolFor("shot.png")} />
      </ShareFileProvider>,
    )

    expect(query("chat-file-preview-image")).toBeTruthy()
    expect(document.querySelector('[data-testid="rn-image"]')?.getAttribute("data-uri")).toContain("/f/shot.png")
  })

  test("a document grows no preview", () => {
    render(
      <ShareFileProvider open={() => {}}>
        <FileDeliveryWidget tool={toolFor("report.pdf")} />
      </ShareFileProvider>,
    )

    expect(query("chat-file-preview-image")).toBeNull()
    expect(query("chat-file-preview-video")).toBeNull()
  })
})
