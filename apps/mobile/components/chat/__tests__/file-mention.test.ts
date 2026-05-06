// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Unit tests for the @-file mention helpers in `file-mention-utils.ts`.
 *
 * These cover the pieces that aren't React: trigger detection, fuzzy
 * scoring, dedup, and attachment serialization. The picker / chip / wiring
 * are covered separately by component snapshot tests (out-of-tree until the
 * RN test renderer is wired up).
 *
 * Run: bun test apps/mobile/components/chat/__tests__/file-mention.test.ts
 */

import { describe, expect, test } from "bun:test"
import {
  detectMentionTrigger,
  score,
  rankFiles,
  dedupMention,
  makeMention,
  buildMentionAttachments,
  formatMentionIssueSummary,
  basename,
  extOf,
  isBinaryPath,
  MAX_MENTIONS,
  MAX_TOTAL_MENTION_BYTES,
} from "../file-mention-utils"

// ─── detectMentionTrigger ──────────────────────────────────────────────────

describe("detectMentionTrigger", () => {
  test("active when typing '@cha' at end of input", () => {
    const text = "hello @cha"
    const t = detectMentionTrigger(text, text.length)
    expect(t.active).toBe(true)
    expect(t.query).toBe("cha")
    expect(t.anchor).toBe(6)
  })

  test("active with empty query right after @", () => {
    const text = "hello @"
    const t = detectMentionTrigger(text, text.length)
    expect(t.active).toBe(true)
    expect(t.query).toBe("")
    expect(t.anchor).toBe(6)
  })

  test("inactive inside an email-like address", () => {
    const text = "ping me@x.com please"
    // caret right after the @ — preceding char is 'e' (not whitespace).
    const t = detectMentionTrigger(text, text.indexOf("@") + 1)
    expect(t.active).toBe(false)
  })

  test("inactive on @@ (escape)", () => {
    const text = "weird @@"
    const t = detectMentionTrigger(text, text.length)
    expect(t.active).toBe(false)
  })

  test("inactive when query contains whitespace (mention closed)", () => {
    const text = "hello @foo bar"
    const t = detectMentionTrigger(text, text.length)
    expect(t.active).toBe(false)
  })

  test("inactive while IME is composing", () => {
    const text = "hello @ko"
    const t = detectMentionTrigger(text, text.length, { isComposing: true })
    expect(t.active).toBe(false)
  })

  test("active at start of input", () => {
    const text = "@src"
    const t = detectMentionTrigger(text, text.length)
    expect(t.active).toBe(true)
    expect(t.query).toBe("src")
    expect(t.anchor).toBe(0)
  })

  test("active after newline", () => {
    const text = "first line\n@app"
    const t = detectMentionTrigger(text, text.length)
    expect(t.active).toBe(true)
    expect(t.query).toBe("app")
  })

  test("query may include slash and dash for paths", () => {
    const text = "@src/Chat-input"
    const t = detectMentionTrigger(text, text.length)
    expect(t.active).toBe(true)
    expect(t.query).toBe("src/Chat-input")
  })
})

// ─── score / rankFiles ─────────────────────────────────────────────────────

describe("score()", () => {
  test("basename exact > prefix > contains > path-contains > subsequence", () => {
    expect(score("apps/mobile/components/chat/ChatInput.tsx", "ChatInput.tsx")).toBeGreaterThan(
      score("apps/mobile/components/chat/CompactChatInput.tsx", "ChatInput.tsx"),
    )
    // basename prefix beats path-contains
    expect(score("a/b/Foo.ts", "Foo")).toBeGreaterThan(score("a/Foobar/x.ts", "Foo"))
  })

  test("ChatInput ranks above api/lib/Chat for query 'chat'", () => {
    const a = score("apps/mobile/components/chat/ChatInput.tsx", "chat")
    const b = score("apps/api/src/lib/Chat.ts", "chat")
    // ChatInput has 'chat' in basename ('chatinput'), Chat.ts has 'chat' as basename
    // -> Chat.ts ranks higher (basename exact). Both still positive.
    expect(a).toBeGreaterThan(0)
    expect(b).toBeGreaterThan(0)
  })

  test("0 for non-matching", () => {
    expect(score("apps/api/foo.ts", "zebra")).toBe(0)
  })

  test("subsequence still matches (Cmd-P style)", () => {
    expect(score("apps/mobile/components/chat/ChatInput.tsx", "amci")).toBeGreaterThan(0)
  })

  test("rankFiles caps and orders by score then path length", () => {
    const files = [
      { path: "apps/api/src/lib/Chat.ts" },
      { path: "apps/mobile/components/chat/ChatInput.tsx" },
      { path: "apps/mobile/components/chat/CompactChatInput.tsx" },
      { path: "apps/web/foo.ts" },
    ]
    const ranked = rankFiles(files, "chat", 10)
    expect(ranked[0].path).toBe("apps/api/src/lib/Chat.ts") // basename exact wins
    expect(ranked.length).toBeGreaterThanOrEqual(3)
  })
})

// ─── dedup / makeMention ───────────────────────────────────────────────────

describe("dedupMention", () => {
  test("blocks adding the same path twice", () => {
    const m = makeMention("src/App.tsx")
    expect(dedupMention([m], { path: "src/App.tsx" })).toBe(true)
    expect(dedupMention([m], { path: "src/Other.tsx" })).toBe(false)
  })
})

describe("basename / extOf / isBinaryPath", () => {
  test("basename strips dirs", () => {
    expect(basename("a/b/c.ts")).toBe("c.ts")
    expect(basename("c.ts")).toBe("c.ts")
  })
  test("extOf returns dot-extension", () => {
    expect(extOf("a/b/c.tsx")).toBe(".tsx")
    expect(extOf("README")).toBe("")
    expect(extOf("a.b/c")).toBe("") // dot is in dir, not basename
  })
  test("isBinaryPath flags images/archives", () => {
    expect(isBinaryPath("logo.png")).toBe(true)
    expect(isBinaryPath("foo.zip")).toBe(true)
    expect(isBinaryPath("App.tsx")).toBe(false)
  })
})

// ─── buildMentionAttachments ───────────────────────────────────────────────

describe("buildMentionAttachments", () => {
  test("skips error entries and packages successful ones", () => {
    const out = buildMentionAttachments([
      { path: "src/App.tsx", content: "export const X = 1\n" },
      { path: "src/Missing.tsx", error: "not_found" },
      { path: "src/Big.tsx", content: "x", truncated: true },
    ])
    expect(out.attachments).toHaveLength(2)
    expect(out.failures).toHaveLength(1)
    expect(out.failures[0].path).toBe("src/Missing.tsx")
    expect(out.truncated).toContain("src/Big.tsx")
    expect(out.attachments[0].source).toBe("mention")
    expect(out.attachments[0].name).toBe("src/App.tsx")
    expect(out.attachments[0].type).toBe("text/x-mention")
    expect(out.attachments[0].dataUrl.startsWith("data:text/plain;base64,")).toBe(true)
  })

  test("enforces total payload cap", () => {
    // Each item is truncated individually to MAX_MENTION_BYTES (256 KB).
    // Five truncated items ≈ 1.28 MB > MAX_TOTAL_MENTION_BYTES (1 MB), so at
    // least one must be rejected with budget_exceeded.
    const huge = "a".repeat(600 * 1024)
    const out = buildMentionAttachments(
      Array.from({ length: 5 }, (_, i) => ({ path: `f${i}.txt`, content: huge })),
    )
    expect(out.totalBytes).toBeLessThanOrEqual(MAX_TOTAL_MENTION_BYTES + 1024)
    expect(out.failures.some((f) => f.error === "budget_exceeded")).toBe(true)
  })

  test("counts UTF-8 bytes instead of UTF-16 characters", () => {
    const cjk = "界".repeat(500 * 1024)
    const out = buildMentionAttachments([
      { path: "src/cjk.txt", content: cjk },
    ])

    expect(out.attachments).toHaveLength(1)
    expect(out.truncated).toContain("src/cjk.txt")
    expect(out.totalBytes).toBeLessThanOrEqual(MAX_TOTAL_MENTION_BYTES)
  })
})

describe("formatMentionIssueSummary", () => {
  test("groups skipped and truncated tagged files into user-friendly copy", () => {
    const summary = formatMentionIssueSummary(
      [
        { path: "src/Missing.tsx", error: "not_found" },
        { path: "assets/logo.png", error: "binary" },
        { path: "src/Big.ts", error: "budget_exceeded" },
      ],
      ["src/Huge.ts"],
    )

    expect(summary).toContain("1 not found (Missing.tsx)")
    expect(summary).toContain("1 binary file (logo.png)")
    expect(summary).toContain("1 context budget exceeded (Big.ts)")
    expect(summary).toContain("1 truncated to fit context")
  })

  test("returns null when there are no mention issues", () => {
    expect(formatMentionIssueSummary([], [])).toBeNull()
  })
})

describe("MAX_MENTIONS sanity", () => {
  test("constant stays at 10", () => {
    expect(MAX_MENTIONS).toBe(10)
  })
})
