// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A dead link says what went wrong in the viewer: the API's `code`, in words.
 * It never shows the user raw JSON, and it never navigates anywhere (SHO-80).
 *
 * A live one is shown, not described: the shared file body decides the
 * renderer from the name, so an `.mp4` is a playing `<video>` even when the
 * response says `application/octet-stream` (SHO-165).
 */

import { afterEach, describe, expect, mock, test } from "bun:test"
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react"
import React from "react"
import { createReactNativeMock } from "../../../test/react-native-mock"
import * as lucideStub from "../../../test/stubs/lucide-react-native"

const { createElement } = React

mock.module("react-native", () =>
  createReactNativeMock({
    Platform: { OS: "web", select: (options: Record<string, unknown>) => options.web },
    useWindowDimensions: () => ({ width: 900, height: 700, scale: 1, fontScale: 1 }),
    // The viewer's header actions are Pressables; the passthrough mock drops
    // `onPress`, so wire it to a real DOM click to exercise Show in Finder.
    Pressable: ({
      accessibilityLabel,
      children,
      onPress,
      disabled,
      testID,
    }: Record<string, unknown>) =>
      createElement(
        "button",
        {
          "aria-label": accessibilityLabel as string,
          "data-rn-shim": testID as string,
          disabled: !!disabled,
          onClick: disabled ? undefined : (onPress as () => void),
        },
        children as React.ReactNode,
      ),
  } as never),
)
mock.module("lucide-react-native", () => lucideStub)
const Icon = () => null
mock.module("../FileTypeIcon", () => ({ FileTypeIcon: Icon }))
mock.module("../../../contexts/theme", () => ({ useResolvedTheme: () => "dark" }))
mock.module("../../chat/MarkdownText", () => ({
  MarkdownText: ({ children }: { children: string }) => <div data-testid="markdown-body">{children}</div>,
}))
mock.module("../../project/panels/ide/CodeEditor", () => ({
  CodeEditor: ({ value, readOnly }: { value: string; readOnly?: boolean }) => (
    <div data-testid="code-editor" data-readonly={String(!!readOnly)}>
      {value}
    </div>
  ),
}))

const { ShareFileView } = await import("../ShareFileViewer")

const target = { kind: "share" as const, href: "/api/f/signed-token", name: "q4-report.pdf" }
const originalFetch = globalThis.fetch
const originalCreate = URL.createObjectURL
const originalRevoke = URL.revokeObjectURL

function installDesktopBridge(overrides: Record<string, unknown> = {}) {
  const bridge = {
    isDesktop: true,
    platform: "darwin",
    revealPath: mock(async () => ({ ok: true })),
    openPath: mock(async () => ({ ok: true })),
    ...overrides,
  }
  ;(globalThis as any).window.shogoDesktop = bridge
  return bridge
}

afterEach(() => {
  cleanup()
  delete (globalThis as any).window.shogoDesktop
  globalThis.fetch = originalFetch
  URL.createObjectURL = originalCreate
  URL.revokeObjectURL = originalRevoke
})

function respondWith(body: unknown, init: ResponseInit) {
  globalThis.fetch = mock(async () =>
    new Response(typeof body === "string" ? body : JSON.stringify(body), init),
  ) as unknown as typeof fetch
}

function stubBlobUrl() {
  const created: Blob[] = []
  URL.createObjectURL = mock((blob: Blob) => {
    created.push(blob)
    return "blob:shared-1"
  }) as unknown as typeof URL.createObjectURL
  URL.revokeObjectURL = mock(() => {}) as unknown as typeof URL.revokeObjectURL
  return created
}

describe("a file the API refuses", () => {
  test("shows the API code in words, not its JSON", async () => {
    respondWith({ error: { code: "expired", message: "This download link has expired" } }, {
      status: 404,
      headers: { "content-type": "application/json" },
    })

    render(<ShareFileView target={target} onClose={() => {}} />)

    const error = await waitFor(() => {
      const node = document.querySelector('[data-rn-shim="share-file-error"]')
      expect(node).toBeTruthy()
      return node!
    })
    expect(error.textContent).toBe("Link expired — ask for a new one")
    expect(error.textContent).not.toContain("{")
    expect(document.body.textContent).toContain("expired")
    expect(document.querySelector('[data-rn-shim="share-file-download"]')).toBeNull()
  })

  test("says so when the file is gone, and offers a retry", async () => {
    respondWith({ error: { code: "file_not_found", message: "File not found" } }, { status: 404 })

    render(<ShareFileView target={target} />)

    const error = await waitFor(() => {
      const node = document.querySelector('[data-rn-shim="share-file-error"]')
      expect(node).toBeTruthy()
      return node!
    })
    expect(error.textContent).toBe("File not found")
    expect(document.querySelector('[data-rn-shim="share-file-retry"]')).toBeTruthy()
  })
})

describe("a file the API serves", () => {
  test("renders the text and offers a download", async () => {
    respondWith("hello from the workspace", {
      status: 200,
      headers: { "content-type": "text/plain" },
    })

    render(<ShareFileView target={{ ...target, name: "notes.txt", href: "/api/f/abc" }} />)

    await waitFor(() => expect(document.body.textContent).toContain("hello from the workspace"))
    expect(document.querySelector('[data-rn-shim="share-file-download"]')).toBeTruthy()
  })

  test("plays a video the server labelled octet-stream", async () => {
    const created = stubBlobUrl()
    respondWith("fake-mp4-bytes", {
      status: 200,
      headers: { "content-type": "application/octet-stream" },
    })

    const { container } = render(
      <ShareFileView target={{ ...target, name: "clip.mp4", href: "/api/f/mp4" }} />,
    )

    const video = await waitFor(() => {
      const node = container.querySelector("video")
      expect(node).toBeTruthy()
      return node!
    })
    expect(video.getAttribute("src")).toBe("blob:shared-1")
    expect(created.length).toBe(1)
    expect(created[0]!.type).toBe("video/mp4")
  })

  test("plays audio in an <audio controls>", async () => {
    stubBlobUrl()
    respondWith("fake-mp3-bytes", { status: 200, headers: { "content-type": "audio/mpeg" } })

    const { container } = render(
      <ShareFileView target={{ ...target, name: "voice.mp3", href: "/api/f/mp3" }} />,
    )

    const audio = await waitFor(() => {
      const node = container.querySelector("audio")
      expect(node).toBeTruthy()
      return node!
    })
    expect(audio.getAttribute("src")).toBe("blob:shared-1")
  })

  test("a Markdown file opens on Preview with a Source toggle", async () => {
    respondWith("# Plan\n\nShip it.", { status: 200, headers: { "content-type": "text/markdown" } })

    render(<ShareFileView target={{ ...target, name: "plan.md", href: "/api/f/md" }} />)

    await waitFor(() => expect(document.querySelector('[data-testid="markdown-body"]')).toBeTruthy())
    expect(document.querySelector('[data-testid="markdown-body"]')!.textContent).toContain("Ship it.")

    const source = document.querySelector<HTMLElement>('[data-testid="file-view-md-mode-source"]')
    expect(source).toBeTruthy()
    fireEvent.click(source!)
    const editor = document.querySelector<HTMLElement>('[data-testid="code-editor"]')
    expect(editor!.textContent).toContain("Ship it.")
    expect(editor!.getAttribute("data-readonly")).toBe("true")
  })
})

/**
 * A local desktop `share_file` hands out a `file://` URL to a file on this
 * machine (SHO-302). A browser page cannot fetch that, so the viewer reads the
 * bytes from the session-guarded `/api/local-files` route by absolute path, and
 * the desktop gets Show in Finder / Open for the real file.
 */
describe("a file that is on this machine (local desktop share)", () => {
  const localTarget = {
    kind: "local" as const,
    href: "/api/local-files?path=%2FUsers%2Fme%2Fout%2Freport.pdf",
    name: "report.pdf",
    path: "/Users/me/out/report.pdf",
  }

  test("reads the file through the local route, never through file://", async () => {
    const calls: string[] = []
    globalThis.fetch = mock(async (input: any) => {
      calls.push(typeof input === "string" ? input : String(input?.url ?? input))
      return new Response("# Notes\n\nOn this disk.", {
        status: 200,
        headers: { "content-type": "text/markdown" },
      })
    }) as unknown as typeof fetch

    render(<ShareFileView target={{ ...localTarget, name: "notes.md" }} />)

    await waitFor(() =>
      expect(document.querySelector('[data-testid="markdown-body"]')!.textContent).toContain("On this disk."),
    )
    expect(calls[0]).toContain("/api/local-files?path=%2FUsers%2Fme%2Fout%2Freport.pdf")
    expect(calls[0]).not.toContain("file:")
  })

  test("Show in Finder and Open give the desktop shell the absolute path", async () => {
    const bridge = installDesktopBridge()
    respondWith("on this disk", { status: 200, headers: { "content-type": "text/plain" } })

    render(<ShareFileView target={{ ...localTarget, name: "notes.txt" }} />)

    const reveal = await waitFor(() => {
      const node = document.querySelector('[data-rn-shim="share-file-reveal"]')
      expect(node).toBeTruthy()
      return node as HTMLElement
    })
    fireEvent.click(reveal)
    await waitFor(() => expect(bridge.revealPath).toHaveBeenCalledWith("/Users/me/out/report.pdf"))

    const open = document.querySelector('[data-rn-shim="share-file-open-external"]') as HTMLElement
    expect(open).toBeTruthy()
    fireEvent.click(open)
    await waitFor(() => expect(bridge.openPath).toHaveBeenCalledWith("/Users/me/out/report.pdf"))
  })

  test("a path the desktop refuses says so instead of opening anything", async () => {
    installDesktopBridge({ revealPath: mock(async () => ({ ok: false, error: "path_not_allowed" })) })
    respondWith("on this disk", { status: 200, headers: { "content-type": "text/plain" } })

    render(<ShareFileView target={{ ...localTarget, name: "notes.txt" }} />)

    const reveal = await waitFor(() => {
      const node = document.querySelector('[data-rn-shim="share-file-reveal"]')
      expect(node).toBeTruthy()
      return node as HTMLElement
    })
    fireEvent.click(reveal)
    await waitFor(() =>
      expect(document.body.textContent).toContain("That file is outside your Shogo folders"),
    )
  })

  test("offers no Finder button on the web build, where there is no shell", async () => {
    respondWith("on this disk", { status: 200, headers: { "content-type": "text/plain" } })

    render(<ShareFileView target={{ ...localTarget, name: "notes.txt" }} />)

    await waitFor(() => expect(document.body.textContent).toContain("notes.txt"))
    expect(document.querySelector('[data-rn-shim="share-file-reveal"]')).toBeNull()
    expect(document.querySelector('[data-rn-shim="share-file-open-external"]')).toBeNull()
  })
})
