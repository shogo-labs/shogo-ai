// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from "bun:test"
import { composerUploadSource, type ComposerUploadSource } from "../composer-upload-source"
import type { UploadPart } from "../upload-part"

const HELLO_DATA_URL = "data:text/plain;base64,aGVsbG8="

function pick(over: Partial<ComposerUploadSource>): ComposerUploadSource {
  return { name: "note.txt", type: "text/plain", dataUrl: "", ...over }
}

describe("composerUploadSource", () => {
  test("web: a zip picked without a base64 read uploads its own bytes, not 0", async () => {
    const bytes = new Uint8Array([80, 75, 3, 4, 1, 2, 3, 4])
    const file = new File([bytes], "bundle.zip", { type: "application/zip" })

    const out = (await composerUploadSource(
      pick({ name: "bundle.zip", type: "application/zip", file }),
      true,
    )) as File

    expect(out).toBeInstanceOf(File)
    expect(out.name).toBe("bundle.zip")
    expect(out.size).toBe(bytes.length)
    expect(new Uint8Array(await out.arrayBuffer())).toEqual(bytes)
  })

  test("web: a large .mov keeps its name and type when the picker gave no type", async () => {
    const file = new File([new Uint8Array(1024)], "clip.mov")

    const out = (await composerUploadSource(
      pick({ name: "clip.mov", type: "video/quicktime", file }),
      true,
    )) as File

    expect(out.size).toBe(1024)
    expect(out.type).toBe("video/quicktime")
  })

  test("native: a pick with no inline bytes streams from its uri", async () => {
    const out = (await composerUploadSource(
      pick({ name: "clip.mov", type: "video/quicktime", uri: "file:///tmp/clip.mov" }),
      false,
    )) as UploadPart

    expect(out.name).toBe("clip.mov")
    expect(out.type).toBe("video/quicktime")
    expect(typeof out.bytes).toBe("function")
  })

  test("web: a small file still decodes from its data URL", async () => {
    const out = (await composerUploadSource(pick({ dataUrl: HELLO_DATA_URL }), true)) as File

    expect(out).toBeInstanceOf(File)
    expect(await out.text()).toBe("hello")
  })

  test("native: a small file without a uri still goes up as its bytes", async () => {
    const out = (await composerUploadSource(pick({ dataUrl: HELLO_DATA_URL }), false)) as UploadPart

    expect(new TextDecoder().decode(await out.bytes())).toBe("hello")
  })

  test("an attachment with no bytes anywhere fails instead of uploading 0 bytes", async () => {
    await expect(composerUploadSource(pick({ name: "bundle.zip" }), true)).rejects.toThrow(
      'Could not read "bundle.zip".',
    )
    await expect(composerUploadSource(pick({ name: "bundle.zip" }), false)).rejects.toThrow(
      'Could not read "bundle.zip".',
    )
  })
})
