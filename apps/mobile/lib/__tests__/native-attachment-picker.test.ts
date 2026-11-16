// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * SHO-386 — the native picker asked the photo library for images only and
 * dropped every video asset, so a video on the camera roll could not be
 * attached at all.
 *
 * `native-attachment-picker.ts` is stubbed by the test preload (ChatInput
 * imports it), so its decisions live in `native-media-attachment.ts` and are
 * tested there: which media types the library and the camera ask for, and how
 * one asset becomes an attachment — images inline (base64), videos
 * disk-streamed (`dataUrl: ""` + `uri`) with a size that was really checked.
 */

// @ts-ignore Bun resolves this module at test runtime; app tsconfig does not include Bun ambient types.
import { beforeEach, describe, expect, mock, test } from "bun:test"

const MB = 1024 * 1024
const CAP = 100 * MB

let onDiskSize: number | null = null

const getInfoAsync = mock(async (uri: string) => {
  if (onDiskSize === null) throw new Error("no file at that uri")
  return { exists: true, size: onDiskSize, isDirectory: false, uri }
})

mock.module("expo-file-system/legacy", () => ({
  EncodingType: { Base64: "base64" },
  getInfoAsync,
  readAsStringAsync: mock(async () => ""),
}))

const {
  NATIVE_MEDIA_TYPES,
  attachmentFromAsset,
  cameraPickerOptions,
  libraryPickerOptions,
  mimeFromName,
} = await import("../native-media-attachment")

type Asset = Parameters<typeof attachmentFromAsset>[0]

const VIDEO: Asset = {
  uri: "file:///var/mobile/DCIM/IMG_1234.MOV",
  type: "video",
  fileName: "IMG_1234.MOV",
  fileSize: 12 * MB,
  mimeType: "video/quicktime",
  width: 1920,
  height: 1080,
}

const IMAGE: Asset = {
  uri: "file:///var/mobile/DCIM/IMG_0001.JPG",
  type: "image",
  fileName: "IMG_0001.JPG",
  fileSize: 2048,
  mimeType: "image/jpeg",
  base64: "aGVsbG8=",
  width: 100,
  height: 100,
}

beforeEach(() => {
  onDiskSize = null
  getInfoAsync.mockClear()
})

describe("SHO-386 — pickers ask for photos and videos", () => {
  test("the media types include videos", () => {
    expect(NATIVE_MEDIA_TYPES).toEqual(["images", "videos"])
  })

  test("the photo library options carry both media types", () => {
    const options = libraryPickerOptions(3)

    expect(options.mediaTypes).toEqual(["images", "videos"])
    expect(options.allowsMultipleSelection).toBe(true)
    expect(options.selectionLimit).toBe(3)
  })

  test("the camera options carry both media types", () => {
    expect(cameraPickerOptions().mediaTypes).toEqual(["images", "videos"])
  })
})

describe("SHO-386 — a picked video becomes a disk-streamed attachment", () => {
  test("no base64 read: dataUrl is empty and uri/previewUrl point at the file", async () => {
    const built = await attachmentFromAsset(VIDEO, CAP, "library")

    expect(built.ok).toBe(true)
    if (!built.ok) return
    expect(built.attachment.dataUrl).toBe("")
    expect(built.attachment.uri).toBe(VIDEO.uri)
    expect(built.attachment.previewUrl).toBe(VIDEO.uri)
    expect(built.attachment.name).toBe("IMG_1234.MOV")
    expect(built.attachment.type).toBe("video/quicktime")
    expect(built.attachment.size).toBe(12 * MB)
  })

  test("an oversize video is rejected with the existing message", async () => {
    const built = await attachmentFromAsset(
      { ...VIDEO, fileSize: CAP + 1 },
      CAP,
      "library",
    )

    expect(built.ok).toBe(false)
    if (built.ok) return
    expect(built.error).toBe("Each file must be under 100 MB.")
  })

  test("a video with no fileSize is measured on disk, not waved through", async () => {
    onDiskSize = CAP + 1
    const built = await attachmentFromAsset(
      { ...VIDEO, fileSize: undefined },
      CAP,
      "library",
    )

    expect(getInfoAsync).toHaveBeenCalledTimes(1)
    expect(built.ok).toBe(false)
    if (built.ok) return
    expect(built.error).toBe("Each file must be under 100 MB.")
  })

  test("a video under the cap but with no fileSize is measured and accepted", async () => {
    onDiskSize = 40 * MB
    const built = await attachmentFromAsset(
      { ...VIDEO, fileSize: undefined },
      CAP,
      "library",
    )

    expect(built.ok).toBe(true)
    if (!built.ok) return
    expect(built.attachment.size).toBe(40 * MB)
    expect(built.attachment.uri).toBe(VIDEO.uri)
  })

  test("a video whose size cannot be read is never let through unchecked", async () => {
    onDiskSize = null // getInfoAsync throws
    const built = await attachmentFromAsset(
      { ...VIDEO, fileSize: undefined },
      CAP,
      "library",
    )

    expect(built.ok).toBe(false)
    if (built.ok) return
    expect(built.error).toBe(
      "Could not read the size of the selected video. Try again.",
    )
  })

  test("a video with no mime type takes one from its name, not octet-stream", async () => {
    const built = await attachmentFromAsset(
      { ...VIDEO, mimeType: undefined, fileName: "clip.mp4" },
      CAP,
      "library",
    )

    expect(built.ok).toBe(true)
    if (!built.ok) return
    expect(built.attachment.type).toBe("video/mp4")
  })

  test("a video with no name gets a .mov fallback", async () => {
    const built = await attachmentFromAsset(
      {
        uri: "file:///var/mobile/tmp/recording.mov",
        type: "video",
        fileName: null,
        fileSize: 5 * MB,
        mimeType: "video/quicktime",
        width: 1080,
        height: 1920,
      },
      CAP,
      "camera",
    )

    expect(built.ok).toBe(true)
    if (!built.ok) return
    expect(built.attachment.name).toMatch(/^video_.*\.mov$/)
    expect(built.attachment.previewUrl).toBe(
      "file:///var/mobile/tmp/recording.mov",
    )
  })
})

describe("SHO-386 — images are unchanged", () => {
  test("a photo is still base64-inline with no preview url", async () => {
    const built = await attachmentFromAsset(IMAGE, CAP, "library")

    expect(built.ok).toBe(true)
    if (!built.ok) return
    expect(built.attachment.dataUrl).toBe("data:image/jpeg;base64,aGVsbG8=")
    expect(built.attachment.type).toBe("image/jpeg")
    expect(built.attachment.uri).toBeUndefined()
    expect(built.attachment.previewUrl).toBeUndefined()
  })

  test("an image with no name falls back per source", async () => {
    const library = await attachmentFromAsset({ ...IMAGE, fileName: null }, CAP, "library")
    const camera = await attachmentFromAsset({ ...IMAGE, fileName: null }, CAP, "camera")

    expect(library.ok && library.attachment.name).toMatch(/^image_.*\.jpg$/)
    expect(camera.ok && camera.attachment.name).toMatch(/^photo_.*\.jpg$/)
  })

  test("an unreadable image keeps its existing error", async () => {
    const built = await attachmentFromAsset(
      { ...IMAGE, base64: undefined },
      CAP,
      "library",
    )

    expect(built.ok).toBe(false)
    if (built.ok) return
    expect(built.error).toBe("Could not read the selected image. Try again.")
  })
})

describe("SHO-386 — documents get video mime types too", () => {
  test.each([
    ["clip.mov", "video/quicktime"],
    ["clip.MP4", "video/mp4"],
    ["clip.m4v", "video/x-m4v"],
  ])("%s → %s", (name, mime) => {
    expect(mimeFromName(name)).toBe(mime)
  })
})
