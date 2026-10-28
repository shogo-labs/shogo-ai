// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * One classifier for every host: the extension decides, the MIME type only
 * fills in when it cannot (no extension, or a type we do not recognise).
 */
import { describe, expect, mock, test } from "bun:test"
import { createReactNativeMock } from "../../../test/react-native-mock"

mock.module("react-native", () => createReactNativeMock())

const { blobMimeType, fileViewKind } = await import("../file-view-kind")

describe("fileViewKind: the extension decides", () => {
  test.each([
    ["clip.mp4", "video"],
    ["clip.MOV", "video"],
    ["track.webm", "video"],
    ["song.mp3", "audio"],
    ["voice.WAV", "audio"],
    ["report.pdf", "pdf"],
    ["photo.png", "image"],
    ["logo.SVG", "image"],
    ["data.sqlite3", "sqlite"],
    ["Inter.woff2", "font"],
    ["README.md", "markdown"],
    ["notes.MDX", "markdown"],
    ["src/app.ts", "text"],
    ["package.json", "text"],
    ["script.sh", "text"],
    ["bundle.zip", "binary"],
    ["deck.pptx", "binary"],
    ["Makefile", "text"],
  ])("%s is %s", (name, expected) => {
    expect(fileViewKind(name)).toBe(expected as never)
  })

  test("an extension beats a contradicting response type", () => {
    expect(fileViewKind("clip.mp4", "application/octet-stream")).toBe("video")
    expect(fileViewKind("song.mp3", "text/plain")).toBe("audio")
    expect(fileViewKind("notes.md", "application/octet-stream")).toBe("markdown")
  })
})

describe("fileViewKind: the MIME type fills the gaps", () => {
  test.each([
    ["untitled", "video/mp4", "video"],
    ["untitled", "audio/mpeg", "audio"],
    ["untitled", "image/png", "image"],
    ["untitled", "application/pdf", "pdf"],
    ["untitled", "font/woff2", "font"],
    ["untitled", "text/markdown", "text"],
    ["untitled", "application/json", "text"],
    ["untitled", "application/vnd.sqlite3", "sqlite"],
    ["mystery.xyz", "video/webm", "video"],
    ["mystery.xyz", "text/plain", "text"],
  ])("%s served as %s is %s", (name, mime, expected) => {
    expect(fileViewKind(name, mime)).toBe(expected as never)
  })

  test("a type nobody can render is text when the name says nothing", () => {
    expect(fileViewKind("untitled", "application/octet-stream")).toBe("text")
  })
})

describe("blobMimeType", () => {
  test("fills in a real type when the response says octet-stream", () => {
    expect(blobMimeType("clip.mp4", "application/octet-stream")).toBe("video/mp4")
    expect(blobMimeType("song.mp3", "application/octet-stream")).toBe("audio/mpeg")
    expect(blobMimeType("shot.PNG", "")).toBe("image/png")
  })

  test("keeps a type the server did report", () => {
    expect(blobMimeType("clip.mp4", "video/webm")).toBe("video/webm")
  })

  test("falls back to octet-stream when nothing knows the name", () => {
    expect(blobMimeType("blob.xyz", "application/octet-stream")).toBe("application/octet-stream")
  })
})
