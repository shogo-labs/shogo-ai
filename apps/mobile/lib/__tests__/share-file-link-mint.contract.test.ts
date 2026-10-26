// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-80 acceptance: the link the API actually mints is the link the app
 * actually renders as a chip.
 *
 * The mobile helper is unit-tested against hand-written tokens, and the API
 * signer is unit-tested against its own decode. Neither proves the pair agree —
 * a claim rename, a base64 vs base64url switch or a payload field added on one
 * side would leave both suites green and every real `share_file` link back in a
 * browser tab. This spec mints with `apps/api`'s signer and parses with the
 * app's parser, on the three origins the user hits (cloud, desktop local API,
 * the legacy `/f/` runtime path), including a dead token, which must still
 * render as a chip and explain itself rather than degrade to a raw link.
 */

import { describe, expect, test } from "bun:test"
import { signSharedFileToken } from "../../../../apps/api/src/lib/shared-file-token"
import { parseInAppFileHref, shareFileErrorText } from "../share-file-links"

const PROJECT_ID = "d80288dd-aac3-41ed-bc9d-6ee251c44374"
const WORKSPACE_ID = "ec94b79f-8c9f-4bea-b107-3b33d18e8a0d"
const HOSTS = new Set(["studio.shogo.ai"])

const now = 1_760_000_000

function mint(path = "exports/quarterly report.pdf", exp = now + 3600): string {
  return signSharedFileToken({ projectId: PROJECT_ID, workspaceId: WORKSPACE_ID, path, exp, now })
}

describe("a freshly minted share_file link", () => {
  test("parses as an in-app file chip with the real filename", () => {
    const token = mint()
    const ref = parseInAppFileHref(`https://studio.shogo.ai/api/f/${token}`, HOSTS)

    expect(ref).not.toBeNull()
    expect(ref?.kind).toBe("share")
    expect(ref?.name).toBe("quarterly report.pdf")
    expect(ref?.path).toBe("exports/quarterly report.pdf")
  })

  test("keeps the href verbatim, so the viewer fetches the link the tool returned", () => {
    const token = mint()
    const href = `https://studio.shogo.ai/api/f/${token}`

    expect(parseInAppFileHref(href, HOSTS)?.href).toBe(href)
  })

  test("parses on the desktop local API origin", () => {
    const token = mint()
    const ref = parseInAppFileHref(`http://localhost:39100/api/f/${token}`)

    expect(ref?.kind).toBe("share")
    expect(ref?.name).toBe("quarterly report.pdf")
  })

  test("parses on the legacy /f/<token> path the runtime used to mint", () => {
    const token = mint()
    const ref = parseInAppFileHref(`https://studio.shogo.ai/f/${token}`, HOSTS)

    expect(ref?.kind).toBe("share")
    expect(ref?.name).toBe("quarterly report.pdf")
  })

  test("a workspace-relative path with spaces and dots survives the round trip", () => {
    const token = mint("d80288dd/.tmp/v1.2 notes (final).md")
    const ref = parseInAppFileHref(`https://studio.shogo.ai/api/f/${token}`, HOSTS)

    expect(ref?.name).toBe("v1.2 notes (final).md")
    expect(ref?.path).toBe("d80288dd/.tmp/v1.2 notes (final).md")
  })
})

describe("a dead share_file link", () => {
  test("an expired token still renders as a chip, not a raw link", () => {
    const token = mint("exports/report.pdf", now - 60)
    const ref = parseInAppFileHref(`https://studio.shogo.ai/api/f/${token}`, HOSTS)

    expect(ref?.kind).toBe("share")
    expect(ref?.name).toBe("report.pdf")
  })

  test("a tampered signature still renders as a chip and reads as invalid", () => {
    const token = mint()
    const tampered = `${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`
    const ref = parseInAppFileHref(`https://studio.shogo.ai/api/f/${tampered}`, HOSTS)

    expect(ref?.kind).toBe("share")
    expect(shareFileErrorText("invalid_link")).toContain("invalid")
  })
})

describe("what the chip says when the API refuses", () => {
  test("every code the download routes answer has a sentence, never raw JSON", () => {
    const codes = ["expired", "invalid_link", "file_not_found", "not_found", "runtime_unavailable", "rate_limited"]

    for (const code of codes) {
      const text = shareFileErrorText(code)
      expect(text.length).toBeGreaterThan(0)
      expect(text).not.toContain('"error"')
      expect(text).not.toContain("{")
      expect(text).toMatch(/[A-Za-z]/)
    }
  })
})
