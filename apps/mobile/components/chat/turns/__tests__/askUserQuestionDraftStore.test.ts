// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Tests for askUserQuestionDraftStore — the cold-start persistence layer
 * that keeps a user's in-progress AskUserQuestion poll state alive across
 * app background/kill cycles.
 *
 * These assertions directly characterize the two bugs the draft store is
 * meant to fix:
 *   Bug A: half-filled selections were lost when the app was backgrounded
 *          or killed (no auto-save).
 *   Bug B: an in-flight submission silently vanished if the app died
 *          mid-send, leaving the poll appearing fresh/unanswered with no
 *          trace that the user had already replied.
 *
 * Each test simulates a cold start by dropping the in-memory storage Map
 * reference and re-running load against a freshly-constructed store.
 *
 * Run: bun test apps/mobile/components/chat/turns/__tests__/askUserQuestionDraftStore.test.ts
 */

import { describe, test, expect, beforeEach } from "bun:test"
import {
  type DraftState,
  type DraftStorage,
  clearDraft,
  deriveSubmissionStatus,
  deserializeDraft,
  draftKey,
  emptyDraft,
  entriesToOtherTexts,
  entriesToSelections,
  loadDraft,
  otherTextsToEntries,
  saveDraft,
  selectionsToEntries,
  serializeDraft,
} from "../askUserQuestionDraftStore"

function makeStorage(): { store: Map<string, string>; storage: DraftStorage } {
  const store = new Map<string, string>()
  const storage: DraftStorage = {
    async getItem(key) {
      return store.get(key) ?? null
    },
    async setItem(key, value) {
      store.set(key, value)
    },
    async removeItem(key) {
      store.delete(key)
    },
  }
  return { store, storage }
}

let store: Map<string, string>
let storage: DraftStorage

beforeEach(() => {
  const created = makeStorage()
  store = created.store
  storage = created.storage
})

describe("draftKey", () => {
  test("namespaces keys under shogo:askUserDraft:", () => {
    expect(draftKey("tc_123")).toBe("shogo:askUserDraft:tc_123")
  })
})

describe("persistence round-trip (fixes Bug A)", () => {
  test("draft persists selections across simulated cold start", async () => {
    const toolCallId = "tc_coldstart"
    const draft: DraftState = {
      selections: selectionsToEntries(
        new Map<number, string[]>([
          [0, ["Option A"]],
          [1, ["Option X", "__other__"]],
        ])
      ),
      otherTexts: otherTextsToEntries(
        new Map<number, string>([[1, "custom answer"]])
      ),
      activeTab: 1,
      submittedResponse: null,
      submittedAt: null,
    }

    await saveDraft(storage, toolCallId, draft)

    // Simulate cold start: keep the underlying bytes in `store`, but hand
    // them to a freshly-created storage façade. This models an app kill
    // and relaunch — the in-memory widget state vanished, but AsyncStorage
    // (backed by `store`) survives.
    const coldStorage: DraftStorage = {
      async getItem(key) {
        return store.get(key) ?? null
      },
      async setItem(key, value) {
        store.set(key, value)
      },
      async removeItem(key) {
        store.delete(key)
      },
    }

    const loaded = await loadDraft(coldStorage, toolCallId)
    expect(loaded).not.toBeNull()
    expect(loaded!.selections).toEqual(draft.selections)
    expect(loaded!.otherTexts).toEqual(draft.otherTexts)
    expect(loaded!.activeTab).toBe(1)
  })

  test("loadDraft returns null when nothing was saved", async () => {
    expect(await loadDraft(storage, "tc_never_saved")).toBeNull()
  })

  test("loadDraft returns null on corrupt JSON", async () => {
    store.set(draftKey("tc_corrupt"), "{ not valid json")
    expect(await loadDraft(storage, "tc_corrupt")).toBeNull()
  })

  test("loadDraft returns null on non-object payloads", async () => {
    store.set(draftKey("tc_null"), "null")
    expect(await loadDraft(storage, "tc_null")).toBeNull()

    store.set(draftKey("tc_num"), "42")
    expect(await loadDraft(storage, "tc_num")).toBeNull()
  })

  test("saveDraft overwrites any previous value for the same tool call", async () => {
    const toolCallId = "tc_overwrite"
    await saveDraft(storage, toolCallId, {
      ...emptyDraft(),
      selections: [[0, ["first"]]],
    })
    await saveDraft(storage, toolCallId, {
      ...emptyDraft(),
      selections: [[0, ["second"]]],
    })

    const loaded = await loadDraft(storage, toolCallId)
    expect(loaded!.selections).toEqual([[0, ["second"]]])
  })
})

describe("hydration (fixes Bug A — widget reducer start state)", () => {
  test("draft hydrates on first render when a previous session saved one", async () => {
    const toolCallId = "tc_hydrate"
    await saveDraft(storage, toolCallId, {
      ...emptyDraft(),
      selections: [[0, ["Yes"]]],
      activeTab: 2,
    })

    const loaded = (await loadDraft(storage, toolCallId)) ?? emptyDraft()
    const selections = entriesToSelections(loaded.selections)
    const otherTexts = entriesToOtherTexts(loaded.otherTexts)

    expect(selections.get(0)).toEqual(["Yes"])
    expect(otherTexts.size).toBe(0)
    expect(loaded.activeTab).toBe(2)
  })

  test("hydration falls back to empty state when no draft exists", async () => {
    const loaded = (await loadDraft(storage, "tc_fresh")) ?? emptyDraft()
    expect(loaded.selections).toEqual([])
    expect(loaded.otherTexts).toEqual([])
    expect(loaded.activeTab).toBe(0)
    expect(loaded.submittedResponse).toBeNull()
  })
})

describe("clear-on-tool-result (fixes Bug A — cleanup)", () => {
  test("clearDraft removes the persisted entry", async () => {
    const toolCallId = "tc_clear"
    await saveDraft(storage, toolCallId, {
      ...emptyDraft(),
      selections: [[0, ["x"]]],
    })
    expect(store.has(draftKey(toolCallId))).toBe(true)

    await clearDraft(storage, toolCallId)
    expect(store.has(draftKey(toolCallId))).toBe(false)
    expect(await loadDraft(storage, toolCallId)).toBeNull()
  })

  test("clearDraft is a no-op when nothing was saved", async () => {
    await clearDraft(storage, "tc_empty")
    expect(store.size).toBe(0)
  })
})

describe("mid-submit survival (fixes Bug B)", () => {
  test("submittedResponse survives a simulated mid-submit kill", async () => {
    const toolCallId = "tc_midsubmit"

    // handleSubmit wrote the response to disk BEFORE calling onSubmitResponse
    await saveDraft(storage, toolCallId, {
      selections: [[0, ["Approve"]]],
      otherTexts: [],
      activeTab: 0,
      submittedResponse: "Approve",
      submittedAt: 1_700_000_000_000,
    })

    // App dies here — sendMessage/saveToolOutput never fires.
    // Cold start: widget mounts again with tool.result still undefined.
    const loaded = await loadDraft(storage, toolCallId)
    expect(loaded).not.toBeNull()
    expect(loaded!.submittedResponse).toBe("Approve")

    const status = deriveSubmissionStatus(undefined, loaded)
    expect(status.answered).toBe(true)
    expect(status.needsRetry).toBe(true)
    expect(status.displayResponse).toBe("Approve")
  })

  test("server-confirmed result takes precedence over local submittedResponse", async () => {
    const draft: DraftState = {
      ...emptyDraft(),
      submittedResponse: "locally stashed",
      submittedAt: 1,
    }
    const status = deriveSubmissionStatus("server accepted", draft)
    expect(status.answered).toBe(true)
    expect(status.needsRetry).toBe(false)
    expect(status.displayResponse).toBe("server accepted")
  })

  test("no draft + no server result = fresh/unanswered", () => {
    const status = deriveSubmissionStatus(undefined, null)
    expect(status.answered).toBe(false)
    expect(status.needsRetry).toBe(false)
    expect(status.displayResponse).toBeNull()
  })

  test("no local submission + server result = normal answered path", () => {
    const status = deriveSubmissionStatus("ok", emptyDraft())
    expect(status.answered).toBe(true)
    expect(status.needsRetry).toBe(false)
    expect(status.displayResponse).toBe("ok")
  })
})

describe("cross-id isolation", () => {
  test("stale draft from a different toolCallId is ignored", async () => {
    await saveDraft(storage, "tc_other", {
      ...emptyDraft(),
      selections: [[0, ["leaked"]]],
    })

    const loaded = await loadDraft(storage, "tc_mine")
    expect(loaded).toBeNull()
  })

  test("clearing one draft does not affect another", async () => {
    await saveDraft(storage, "tc_a", {
      ...emptyDraft(),
      selections: [[0, ["a"]]],
    })
    await saveDraft(storage, "tc_b", {
      ...emptyDraft(),
      selections: [[0, ["b"]]],
    })

    await clearDraft(storage, "tc_a")

    expect(await loadDraft(storage, "tc_a")).toBeNull()
    const b = await loadDraft(storage, "tc_b")
    expect(b!.selections).toEqual([[0, ["b"]]])
  })
})

describe("Map <-> tuple serialization", () => {
  test("selections round-trip preserves ordering and contents", () => {
    const source = new Map<number, string[]>([
      [0, ["a", "b"]],
      [2, ["c"]],
    ])
    const roundtripped = entriesToSelections(selectionsToEntries(source))
    expect(roundtripped.get(0)).toEqual(["a", "b"])
    expect(roundtripped.get(2)).toEqual(["c"])
    expect(roundtripped.size).toBe(2)
  })

  test("otherTexts round-trip preserves entries", () => {
    const source = new Map<number, string>([
      [1, "hello"],
      [3, "world"],
    ])
    const roundtripped = entriesToOtherTexts(otherTextsToEntries(source))
    expect(roundtripped.get(1)).toBe("hello")
    expect(roundtripped.get(3)).toBe("world")
  })

  test("serializeDraft -> deserializeDraft preserves shape", () => {
    const draft: DraftState = {
      selections: [
        [0, ["x"]],
        [1, ["y", "__other__"]],
      ],
      otherTexts: [[1, "typed value"]],
      activeTab: 1,
      submittedResponse: null,
      submittedAt: null,
    }
    const roundtripped = deserializeDraft(JSON.parse(serializeDraft(draft)))
    expect(roundtripped).toEqual(draft)
  })

  test("deserializeDraft drops malformed entries instead of throwing", () => {
    const result = deserializeDraft({
      selections: [
        [0, ["good"]],
        ["bad-key", ["also bad"]],
        [1, "not-an-array"],
      ],
      otherTexts: [
        [0, "ok"],
        [1, 42],
      ],
      activeTab: "not-a-number",
      submittedResponse: 123,
      submittedAt: "nope",
    })

    expect(result).not.toBeNull()
    expect(result!.selections).toEqual([[0, ["good"]]])
    expect(result!.otherTexts).toEqual([[0, "ok"]])
    expect(result!.activeTab).toBe(0)
    expect(result!.submittedResponse).toBeNull()
    expect(result!.submittedAt).toBeNull()
  })
})
