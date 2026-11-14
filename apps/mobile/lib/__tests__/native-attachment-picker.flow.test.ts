// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * SHO-386 — the picker *flow*, not just its decisions.
 *
 * `native-attachment-picker.ts` is stubbed by the test preload (ChatInput
 * imports it), so `native-attachment-picker.test.ts` covers what one asset
 * becomes while the loop that collects several of them — a mixed photo+video
 * pick, the cap refusing one, the camera's media types — stayed unexercised.
 * These tests load the real module under a cache-busting specifier so the
 * preload's stub does not apply, and drive it through `expo-image-picker`.
 */

// @ts-ignore Bun resolves this module at test runtime; app tsconfig does not include Bun ambient types.
import { beforeEach, describe, expect, mock, test } from "bun:test"

const MB = 1024 * 1024
const CAP = 100 * MB

interface PickerOptions {
  mediaTypes?: unknown
  allowsMultipleSelection?: boolean
  selectionLimit?: number
  base64?: boolean
}

let libraryOptions: PickerOptions | null = null
let cameraOptions: PickerOptions | null = null
let libraryResult: unknown = { canceled: true, assets: [] }
let cameraResult: unknown = { canceled: true, assets: [] }
let cameraGranted = true

mock.module("react-native", () => ({ Platform: { OS: "ios" } }))
mock.module("expo-file-system/legacy", () => ({
  EncodingType: { Base64: "base64" },
  getInfoAsync: async (uri: string) => ({
    exists: true,
    size: 8 * MB,
    isDirectory: false,
    uri,
  }),
  readAsStringAsync: async () => "",
}))
mock.module("expo-image-picker", () => ({
  launchImageLibraryAsync: async (options: PickerOptions) => {
    libraryOptions = options
    return libraryResult
  },
  launchCameraAsync: async (options: PickerOptions) => {
    cameraOptions = options
    return cameraResult
  },
  requestCameraPermissionsAsync: async () => ({ granted: cameraGranted }),
}))

// The preload registers its stub under the resolved module path, so the real
// module has to be requested under a specifier that never collides with it.
const realPickerPath = "../native-attachment-picker.ts?qa-flow"
const { executeNativeAttachAction } = (await import(
  realPickerPath
)) as typeof import("../native-attachment-picker")

type Picked = {
  id: string
  dataUrl: string
  name: string
  type: string
  size: number
  uri?: string
  previewUrl?: string
}

function runAction(
  action: "library" | "camera",
  overrides: { currentCount?: number; maxFiles?: number } = {},
) {
  const files: Picked[] = []
  const errors: string[] = []
  executeNativeAttachAction(action, {
    currentCount: overrides.currentCount ?? 0,
    maxFiles: overrides.maxFiles ?? 5,
    maxFileSizeBytes: CAP,
    onFiles: (picked) => files.push(...(picked as Picked[])),
    onError: (message) => errors.push(message),
  })
  return { files, errors }
}

/** The picker resolves over a microtask chain; let it settle. */
async function settle() {
  for (let i = 0; i < 5; i += 1) await new Promise((r) => setTimeout(r, 0))
}

const PHOTO = {
  uri: "file:///var/mobile/DCIM/IMG_0001.JPG",
  type: "image",
  fileName: "IMG_0001.JPG",
  fileSize: 2048,
  mimeType: "image/jpeg",
  base64: "aGVsbG8=",
  width: 100,
  height: 100,
}

const VIDEO = {
  uri: "file:///var/mobile/DCIM/IMG_1234.MOV",
  type: "video",
  fileName: "IMG_1234.MOV",
  fileSize: 12 * MB,
  mimeType: "video/quicktime",
  width: 1920,
  height: 1080,
}

beforeEach(() => {
  libraryOptions = null
  cameraOptions = null
  cameraGranted = true
  libraryResult = { canceled: true, assets: [] }
  cameraResult = { canceled: true, assets: [] }
})

describe("SHO-386 — the photo library offers and keeps videos", () => {
  test("a mixed photo+video pick keeps both, video streamed from disk", async () => {
    libraryResult = { canceled: false, assets: [PHOTO, VIDEO] }

    const { files, errors } = runAction("library")
    await settle()

    expect(errors).toEqual([])
    expect(libraryOptions?.mediaTypes).toEqual(["images", "videos"])
    expect(files).toHaveLength(2)

    const photo = files[0]!
    expect(photo.type).toBe("image/jpeg")
    expect(photo.dataUrl).toBe("data:image/jpeg;base64,aGVsbG8=")
    expect(photo.uri).toBeUndefined()

    const video = files[1]!
    expect(video.type).toBe("video/quicktime")
    expect(video.name).toBe("IMG_1234.MOV")
    expect(video.dataUrl).toBe("")
    expect(video.uri).toBe(VIDEO.uri)
    expect(video.previewUrl).toBe(VIDEO.uri)
    expect(video.size).toBe(12 * MB)
  })

  test("an oversize video is refused and nothing is added", async () => {
    libraryResult = {
      canceled: false,
      assets: [VIDEO, { ...VIDEO, fileName: "huge.mov", fileSize: CAP + 1 }],
    }

    const { files, errors } = runAction("library")
    await settle()

    expect(errors).toEqual(["Each file must be under 100 MB."])
    expect(files).toEqual([])
  })

  test("selectionLimit is what is left of MAX_FILES, and a full composer opens nothing", async () => {
    libraryResult = { canceled: false, assets: [PHOTO] }

    runAction("library", { currentCount: 2, maxFiles: 5 })
    await settle()
    expect(libraryOptions?.selectionLimit).toBe(3)
    expect(libraryOptions?.allowsMultipleSelection).toBe(true)

    libraryOptions = null
    const full = runAction("library", { currentCount: 5, maxFiles: 5 })
    await settle()
    expect(libraryOptions).toBeNull()
    expect(full.files).toEqual([])
  })
})

describe("SHO-386 — the camera records video too", () => {
  test("the camera asks for both media types", async () => {
    const { files } = runAction("camera")
    await settle()

    expect(cameraOptions?.mediaTypes).toEqual(["images", "videos"])
    expect(files).toEqual([])
  })

  test("a recorded video is attached the same way as a picked one", async () => {
    cameraResult = {
      canceled: false,
      assets: [{ ...VIDEO, uri: "file:///var/mobile/tmp/recording.mov", fileName: null }],
    }

    const { files, errors } = runAction("camera")
    await settle()

    expect(errors).toEqual([])
    expect(files).toHaveLength(1)
    expect(files[0]!.type).toBe("video/quicktime")
    expect(files[0]!.dataUrl).toBe("")
    expect(files[0]!.uri).toBe("file:///var/mobile/tmp/recording.mov")
    expect(files[0]!.previewUrl).toBe("file:///var/mobile/tmp/recording.mov")
    expect(files[0]!.name).toMatch(/^video_.*\.mov$/)
  })

  test("a taken photo is unchanged", async () => {
    cameraResult = { canceled: false, assets: [{ ...PHOTO, fileName: null }] }

    const { files } = runAction("camera")
    await settle()

    expect(files).toHaveLength(1)
    expect(files[0]!.dataUrl).toBe("data:image/jpeg;base64,aGVsbG8=")
    expect(files[0]!.previewUrl).toBeUndefined()
    expect(files[0]!.name).toMatch(/^photo_.*\.jpg$/)
  })

  test("a denied camera permission says photo or video", async () => {
    cameraGranted = false

    const { files, errors } = runAction("camera")
    await settle()

    expect(files).toEqual([])
    expect(errors).toEqual([
      "Allow camera access in Settings to take a photo or video.",
    ])
  })
})
