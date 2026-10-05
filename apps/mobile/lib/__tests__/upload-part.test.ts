// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from "bun:test"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { bytesPart } from "../upload-part"

// The encoder behind the native global `fetch` (expo/fetch). It is what throws
// "Unsupported FormDataPart implementation" for React Native `{ uri }` parts.
const expoRoot = dirname(createRequire(import.meta.url).resolve("expo/package.json"))
const { convertFormDataAsync } = (await import(
  join(expoRoot, "src/winter/fetch/convertFormData.ts")
)) as {
  convertFormDataAsync: (fd: FormData, boundary?: string) => Promise<{ body: Uint8Array; boundary: string }>
}

/** React Native's FormData keeps parts as-is (`_parts`); Bun's would stringify objects. */
function nativeFormData(): FormData & { append: (name: string, value: unknown) => void } {
  const parts: [string, unknown][] = []
  return {
    append: (name: string, value: unknown) => void parts.push([name, value]),
    entries: () => parts[Symbol.iterator](),
  } as any
}

const decode = (body: Uint8Array) => new TextDecoder().decode(body)

describe("native multipart upload parts", () => {
  test("rejects React Native's { uri, name, type } file shape", async () => {
    const fd = nativeFormData()
    fd.append("file", { uri: "file:///tmp/a.png", name: "a.png", type: "image/png" } as any)
    await expect(convertFormDataAsync(fd)).rejects.toThrow(/Unsupported FormDataPart/)
  })

  test("encodes a bytes part with its filename, content type, and body", async () => {
    const fd = nativeFormData()
    fd.append("file", bytesPart(new TextEncoder().encode("PNGDATA"), "photo one.png", "image/png") as any)
    fd.append("name", "party")
    const { body, boundary } = await convertFormDataAsync(fd, "BOUNDARY")
    const text = decode(body)
    expect(boundary).toBe("BOUNDARY")
    expect(text).toContain('content-disposition: form-data; name="file"; filename="photo%20one.png"')
    expect(text).toContain("content-type: image/png")
    expect(text).toContain("PNGDATA")
    expect(text).toContain('name="name"')
    expect(text.endsWith("--BOUNDARY--\r\n")).toBe(true)
  })
})
