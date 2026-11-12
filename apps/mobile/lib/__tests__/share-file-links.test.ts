// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A file link in chat is something the app serves itself, so it is recognised
 * here rather than handed to the browser (SHO-80).
 */

import { describe, expect, test } from "bun:test"
import {
  inAppFileFetchHref,
  localFileHref,
  parseInAppFileHref,
  parseLocalFileHref,
  parseShareFileHref,
  parseStoredFileHref,
  shareFileClaims,
  shareFileErrorFromBody,
  shareFileErrorText,
} from "../share-file-links"

const HOSTS = new Set(["studio.shogo.ai"])

/** A real token shape: base64url claims, a dot, base64url signature. */
function token(path = "exports/summary.csv", overrides: Record<string, unknown> = {}): string {
  const claims = {
    typ: "shared-file",
    workspaceId: "ws-1",
    path,
    exp: Math.floor(Date.now() / 1000) + 3600,
    iat: Math.floor(Date.now() / 1000),
    ...overrides,
  }
  const payload = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url")
  return `${payload}.c2lnbmF0dXJl`
}

describe("share file links", () => {
  test("recognises /api/f/<token> and the legacy /f/<token>", () => {
    const api = parseShareFileHref(`/api/f/${token()}`, HOSTS)
    expect(api?.kind).toBe("share")
    expect(api?.name).toBe("summary.csv")
    expect(api?.path).toBe("exports/summary.csv")

    const legacy = parseShareFileHref(`/f/${token("docs/plan.pdf")}`, HOSTS)
    expect(legacy?.name).toBe("plan.pdf")
  })

  test("recognises the app's own and local hosts, and refuses lookalikes", () => {
    const signed = token()
    expect(parseShareFileHref(`http://localhost:39100/api/f/${signed}`, HOSTS)).not.toBeNull()
    expect(parseShareFileHref(`http://127.0.0.1:39100/f/${signed}`, HOSTS)).not.toBeNull()
    expect(parseShareFileHref(`https://studio.shogo.ai/api/f/${signed}`, HOSTS)).not.toBeNull()
    expect(parseShareFileHref(`https://evil.example/api/f/${signed}`, HOSTS)).toBeNull()
    expect(parseShareFileHref(`https://not-studio.example/f/${signed}`, HOSTS)).toBeNull()
  })

  test("keeps a token that ends in `_`, and drops only sentence punctuation", () => {
    const signed = `${token()}_`
    const result = parseShareFileHref(`http://localhost:39100/api/f/${signed}.`, HOSTS)
    expect(result?.href).toBe(`http://localhost:39100/api/f/${signed}`)
    const paren = parseShareFileHref(`(http://localhost:39100/api/f/${signed})`, HOSTS)
    expect(paren?.href).toBe(`http://localhost:39100/api/f/${signed}`)
  })

  test("a token that ends in `_` is not trimmed by the trailing-punctuation rule", () => {
    // Base64url can end on `_`, and the URL cleaner used to treat it as
    // sentence punctuation — which invalidates the signature (SHO-80).
    const signed = `${token()}_`
    expect(parseShareFileHref(`https://studio.shogo.ai/api/f/${signed}.`, HOSTS)?.href).toBe(
      `https://studio.shogo.ai/api/f/${signed}`,
    )
  })

  test("a token with an unreadable payload still renders as a chip", () => {
    const result = parseShareFileHref("/api/f/aaa.bbb", HOSTS)
    expect(result?.kind).toBe("share")
    expect(result?.name).toBe("Download")
    expect(shareFileClaims("aaa.bbb")).toBeNull()
  })

  test("does not mistake an ordinary link for a file", () => {
    expect(parseShareFileHref("https://github.com/shogo-labs/shogo-ai", HOSTS)).toBeNull()
    expect(parseShareFileHref("https://studio.shogo.ai/c/c1?msg=m1", HOSTS)).toBeNull()
    expect(parseShareFileHref(undefined, HOSTS)).toBeNull()
    expect(parseShareFileHref("mailto:dev@shogo.ai", HOSTS)).toBeNull()
  })
})

describe("stored chat files", () => {
  test("recognises a conversation file and a chat attachment", () => {
    const conversation = parseStoredFileHref("/api/conversation-files/abc123?t=sig", HOSTS)
    expect(conversation?.kind).toBe("stored")
    expect(conversation?.href).toBe("/api/conversation-files/abc123?t=sig")

    const attachment = parseStoredFileHref("/api/chat-attachments/key-1/report.pdf?sig", HOSTS)
    expect(attachment?.name).toBe("report.pdf")

    const cloud = parseStoredFileHref(
      "http://localhost:39100/api/cloud/ws-1/conversation-files/xyz?t=1",
      HOSTS,
    )
    expect(cloud?.kind).toBe("stored")
  })

  test("prefers a filename the URL carries over the opaque id", () => {
    expect(parseStoredFileHref("/api/conversation-files/abc123?filename=notes.md", HOSTS)?.name).toBe(
      "notes.md",
    )
  })

  test("a path that only starts with the prefix is not a file", () => {
    expect(parseStoredFileHref("/api/chat-attachments-old/key/file.pdf", HOSTS)).toBeNull()
    expect(parseStoredFileHref("/api/workspaces", HOSTS)).toBeNull()
  })
})

describe("parseInAppFileHref", () => {
  test("covers both kinds and nothing else", () => {
    expect(parseInAppFileHref(`/api/f/${token()}`, HOSTS)?.kind).toBe("share")
    expect(parseInAppFileHref("/api/chat-attachments/k/f.txt", HOSTS)?.kind).toBe("stored")
    expect(parseInAppFileHref("https://example.com", HOSTS)).toBeNull()
  })
})

describe("failure text", () => {
  test("names the API code instead of showing raw JSON", () => {
    expect(shareFileErrorText("expired")).toContain("expired")
    expect(shareFileErrorText("invalid_link")).toContain("invalid")
    expect(shareFileErrorText("file_not_found")).toBe("File not found")
    expect(shareFileErrorText("empty_file")).toContain("0 bytes")
    expect(shareFileErrorText("empty_file")).toContain("attach it again")
    expect(shareFileErrorText("runtime_unavailable")).toContain("retry")
    expect(shareFileErrorText(undefined, "Boom")).toBe("Boom")
    expect(shareFileErrorText(undefined, null)).toBe("Could not open this file")
  })

  test("reads the error body the routes send", () => {
    expect(shareFileErrorFromBody({ error: { code: "expired", message: "nope" } })).toEqual({
      code: "expired",
      message: "nope",
    })
    expect(shareFileErrorFromBody(null)).toEqual({ code: null, message: null })
    expect(shareFileErrorFromBody("<html>")).toEqual({ code: null, message: null })
  })
})

describe("local file links (desktop share_file)", () => {
  test("a file:// URL becomes a local ref that fetches the local route", () => {
    const ref = parseLocalFileHref("file:///Users/me/Application%20Support/report.pdf")
    expect(ref).toEqual({
      kind: "local",
      href: "/api/local-files?path=%2FUsers%2Fme%2FApplication%20Support%2Freport.pdf",
      name: "report.pdf",
      path: "/Users/me/Application Support/report.pdf",
    })
  })

  test("the rewritten /shogo-local-file href parses to the same ref", () => {
    const ref = parseLocalFileHref(localFileHref("/Users/me/out/report.pdf"))
    expect(ref?.kind).toBe("local")
    expect(ref?.path).toBe("/Users/me/out/report.pdf")
    expect(ref?.name).toBe("report.pdf")
  })

  test("a Windows file:// URL keeps its drive letter", () => {
    expect(parseLocalFileHref("file:///C:/Users/me/report.pdf")?.path).toBe("C:/Users/me/report.pdf")
  })

  test("non-file schemes are rejected", () => {
    expect(parseLocalFileHref("https://example.com/report.pdf")).toBeNull()
    expect(parseLocalFileHref("/api/f/abc.def")).toBeNull()
    expect(parseLocalFileHref("file:")).toBeNull()
  })

  test("parseInAppFileHref recognises a local file and keeps the other kinds", () => {
    expect(parseInAppFileHref("file:///Users/me/report.pdf", HOSTS)?.kind).toBe("local")
    expect(parseInAppFileHref(`/api/f/${token()}`, HOSTS)?.kind).toBe("share")
    expect(parseInAppFileHref("/api/chat-attachments/k/f.txt", HOSTS)?.kind).toBe("stored")
  })
})

/**
 * The desktop renderer runs at `shogo://app`, so it can only fetch its own API
 * origin: the API answers an unknown origin with `ALLOWED_ORIGINS[0]`, and the
 * browser refuses that. A link minted on the public cloud origin is therefore
 * relayed, not fetched cross-origin (that was "Failed to fetch" on desktop).
 */
describe("the URL the viewer fetches", () => {
  const API = "http://localhost:39100"
  const CLOUD = "https://studio.shogo.ai"

  test("a cloud share link goes through this app's own API relay", () => {
    const signed = token("artifacts/BUILD-AND-DOWNLOAD-GUIDE.md")
    const file = parseShareFileHref(`${CLOUD}/api/f/${signed}`, HOSTS)!
    expect(inAppFileFetchHref(file, API)).toBe(`${API}/api/cloud/ws-1/f/${signed}`)
  })

  test("the legacy /f/ shape relays the same way", () => {
    const signed = token("docs/plan.pdf")
    const file = parseShareFileHref(`${CLOUD}/f/${signed}`, HOSTS)!
    expect(inAppFileFetchHref(file, API)).toBe(`${API}/api/cloud/ws-1/f/${signed}`)
  })

  test("the token's own workspace decides, not whichever is active", () => {
    const signed = token("a.md", { workspaceId: "ws-elsewhere" })
    const file = parseShareFileHref(`${CLOUD}/api/f/${signed}`, HOSTS)!
    expect(inAppFileFetchHref(file, API)).toBe(`${API}/api/cloud/ws-elsewhere/f/${signed}`)
  })

  test("same-origin and relative links are left exactly as written", () => {
    const signed = token()
    const sameOrigin = parseShareFileHref(`${API}/api/f/${signed}`, HOSTS)!
    expect(inAppFileFetchHref(sameOrigin, API)).toBe(sameOrigin.href)
    expect(inAppFileFetchHref({ kind: "share", href: `/api/f/${signed}` }, API)).toBe(
      `/api/f/${signed}`,
    )
  })

  test("a stored cloud file keeps its path and query", () => {
    const href = `${CLOUD}/api/conversation-files/att-1?t=abc.def`
    expect(inAppFileFetchHref({ kind: "stored", href }, API)).toBe(
      `${API}/api/conversation-files/att-1?t=abc.def`,
    )
  })

  test("an app-local file and a real web link are never rewritten", () => {
    expect(
      inAppFileFetchHref({ kind: "local", href: "/api/local-files?path=%2Fx%2Fy" }, API),
    ).toBe("/api/local-files?path=%2Fx%2Fy")
    expect(
      inAppFileFetchHref({ kind: "share", href: "https://example.com/report.pdf" }, API),
    ).toBe("https://example.com/report.pdf")
  })

  test("with no API origin configured nothing is rebased", () => {
    const file = parseShareFileHref(`${CLOUD}/api/f/${token()}`, HOSTS)!
    expect(inAppFileFetchHref(file, null)).toBe(file.href)
    expect(inAppFileFetchHref(file, "")).toBe(file.href)
  })
})
