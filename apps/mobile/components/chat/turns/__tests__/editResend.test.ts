// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-263 — the pure rules behind Cursor/Lovable-style edit-and-resend:
 * selection-safe clicking, "has the draft changed", the remembered
 * revert-files choice, the submit label and the dimming window.
 */

import { describe, expect, test } from "bun:test"
import {
  EDIT_RESEND_REVERT_KEY,
  editSubmitLabel,
  editorFooterHint,
  filesRevertedNote,
  firstDimmedTurnIndex,
  formatRelativeTime,
  isDraftDirty,
  isEditGestureIgnored,
  readRevertFilesPreference,
  replacedTurnsLabel,
  retrySubmitLabel,
  writeRevertFilesPreference,
} from "../editResend"

function memoryStorage(initial: Record<string, string> = {}) {
  const data = { ...initial }
  return {
    getItem: (key: string) => (key in data ? data[key]! : null),
    setItem: (key: string, value: string) => {
      data[key] = value
    },
    dump: () => data,
  }
}

describe("isDraftDirty", () => {
  test("an untouched draft is not dirty", () => {
    expect(
      isDraftDirty({ text: "hello", fileCount: 0 }, { text: "hello", fileCount: 0 }),
    ).toBe(false)
  })

  test("edited text is dirty", () => {
    expect(
      isDraftDirty({ text: "hello", fileCount: 0 }, { text: "hello there", fileCount: 0 }),
    ).toBe(true)
  })

  test("trailing whitespace alone is not an edit", () => {
    expect(
      isDraftDirty({ text: "hello", fileCount: 0 }, { text: "hello  ", fileCount: 0 }),
    ).toBe(false)
  })

  test("adding or removing an attachment is dirty", () => {
    expect(
      isDraftDirty({ text: "hello", fileCount: 0 }, { text: "hello", fileCount: 1 }),
    ).toBe(true)
  })
})

describe("isEditGestureIgnored", () => {
  test("an active selection never opens the editor", () => {
    expect(isEditGestureIgnored(null, true)).toBe(true)
  })

  test("a press inside a link, mention, code block or attachment is ignored", () => {
    for (const selector of [
      "a[href]",
      '[role="link"]',
      "[data-mention]",
      "[data-attachment]",
      "code",
      "pre",
    ]) {
      const target = {
        closest: (query: string) => (query.includes(selector) ? {} : null),
      }
      expect(isEditGestureIgnored(target, false)).toBe(true)
    }
  })

  test("plain text opens the editor", () => {
    const target = { closest: () => null }
    expect(isEditGestureIgnored(target, false)).toBe(false)
  })

  test("native events without closest() are treated as plain text", () => {
    expect(isEditGestureIgnored(undefined, false)).toBe(false)
    expect(isEditGestureIgnored({}, false)).toBe(false)
  })
})

describe("revert-files preference", () => {
  test("defaults ON on first run (Cursor/Lovable primary path)", () => {
    expect(readRevertFilesPreference(memoryStorage())).toBe(true)
  })

  test("remembers the last choice across reloads", () => {
    const storage = memoryStorage()
    writeRevertFilesPreference(false, storage)
    expect(storage.dump()[EDIT_RESEND_REVERT_KEY]).toBe("0")
    expect(readRevertFilesPreference(storage)).toBe(false)
    writeRevertFilesPreference(true, storage)
    expect(readRevertFilesPreference(storage)).toBe(true)
  })

  test("storage failures fall back to ON", () => {
    const throwing = {
      getItem: () => {
        throw new Error("denied")
      },
      setItem: () => {
        throw new Error("denied")
      },
    }
    expect(readRevertFilesPreference(throwing)).toBe(true)
    expect(() => writeRevertFilesPreference(false, throwing)).not.toThrow()
  })
})

describe("labels", () => {
  test("the submit label states what happens", () => {
    expect(editSubmitLabel({ hasLaterMessages: false, revertFiles: true })).toBe("Send")
    expect(editSubmitLabel({ hasLaterMessages: true, revertFiles: true })).toBe(
      "Revert & resend",
    )
    expect(editSubmitLabel({ hasLaterMessages: true, revertFiles: false })).toBe("Resend")
    expect(retrySubmitLabel(true)).toBe("Revert & retry")
    expect(retrySubmitLabel(false)).toBe("Retry")
  })

  test("the divider counts pluralised messages", () => {
    expect(replacedTurnsLabel(1)).toBe("1 message below will be replaced")
    expect(replacedTurnsLabel(7)).toBe("7 messages below will be replaced")
    expect(replacedTurnsLabel(0)).toBe("")
  })

  test("the footer hint says the run will stop while streaming", () => {
    expect(editorFooterHint(false)).toBe("Esc to cancel · ⏎ to send")
    expect(editorFooterHint(true)).toContain("Stops the current run")
  })

  test("the reverted-files note names the checkpoint age", () => {
    expect(filesRevertedNote("3 minutes ago")).toBe(
      "Files reverted to the checkpoint from 3 minutes ago",
    )
  })
})

describe("formatRelativeTime", () => {
  const now = Date.parse("2026-10-30T12:00:00.000Z")
  test("renders minutes and hours", () => {
    expect(formatRelativeTime("2026-10-30T11:57:00.000Z", now)).toBe("3 minutes ago")
    expect(formatRelativeTime("2026-10-30T11:00:00.000Z", now)).toBe("1 hour ago")
    expect(formatRelativeTime("2026-10-30T11:59:54.000Z", now)).toBe("6s ago")
  })
  test("unparseable timestamps render nothing", () => {
    expect(formatRelativeTime("not-a-date", now)).toBe("")
  })
})

describe("firstDimmedTurnIndex", () => {
  const turns = [
    { userMessage: { id: "m1" } },
    { userMessage: { id: "m2" } },
    { userMessage: { id: "m3" } },
  ]

  test("dims everything after the edited turn", () => {
    expect(firstDimmedTurnIndex(turns, "m1")).toBe(1)
    expect(firstDimmedTurnIndex(turns, "m2")).toBe(2)
  })

  test("editing the last turn dims nothing", () => {
    expect(firstDimmedTurnIndex(turns, "m3")).toBe(3)
  })

  test("no open editor dims nothing", () => {
    expect(firstDimmedTurnIndex(turns, null)).toBe(-1)
    expect(firstDimmedTurnIndex(turns, "unknown")).toBe(-1)
  })
})
