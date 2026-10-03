// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from "bun:test"
import { reuseGroups, reuseParts } from "../partIdentity"
import { groupWorkParts } from "../turnShaping"
import type { MessagePart } from "../types"

const tool = (id: string, state: "streaming" | "success" | "error" = "success", result: unknown = { ok: id }): MessagePart => ({
  type: "tool",
  id,
  tool: { id, toolName: "read_file", category: "file", state, args: { path: id }, result, timestamp: 0 } as any,
})
const text = (id: string, value: string): MessagePart => ({ type: "text", id, text: value })

/** What the SDK does each chunk: every part comes back as a new object. */
const clone = <T,>(value: T): T => structuredClone(value)

describe("reuseParts", () => {
  test("a finished tool call keeps its previous object after a deep copy", () => {
    const first = reuseParts(undefined, [tool("a"), tool("b")])
    const second = reuseParts(first, clone([tool("a"), tool("b")]))
    expect(second).toBe(first)
  })

  test("only the changed part is replaced", () => {
    const first = reuseParts(undefined, [tool("a"), text("t", "hel")])
    const second = reuseParts(first, clone([tool("a"), text("t", "hello")]))
    expect(second).not.toBe(first)
    expect(second[0]).toBe(first[0])
    expect(second[1]).not.toBe(first[1])
    expect((second[1] as any).text).toBe("hello")
  })

  test("a running tool call is never reused, so streamed input and output show up", () => {
    const first = reuseParts(undefined, [tool("a", "streaming", undefined)])
    const second = reuseParts(first, clone([tool("a", "streaming", { partial: "x" })]))
    expect(second[0]).not.toBe(first[0])
    expect((second[0] as any).tool.result).toEqual({ partial: "x" })
  })

  test("a tool call that finishes is picked up", () => {
    const first = reuseParts(undefined, [tool("a", "streaming", undefined)])
    const second = reuseParts(first, clone([tool("a", "success")]))
    expect((second[0] as any).tool.state).toBe("success")
  })

  test("new parts are appended and the earlier ones are kept", () => {
    const first = reuseParts(undefined, [tool("a")])
    const second = reuseParts(first, clone([tool("a"), tool("b")]))
    expect(second).toHaveLength(2)
    expect(second[0]).toBe(first[0])
  })

  test("a part that disappears is dropped", () => {
    const first = reuseParts(undefined, [tool("a"), tool("b")])
    const second = reuseParts(first, clone([tool("a")]))
    expect(second).toHaveLength(1)
  })
})

describe("reuseGroups", () => {
  const turn = (n: number, last?: MessagePart) => {
    const parts: MessagePart[] = Array.from({ length: n }, (_, i) => tool(`t${i}`))
    if (last) parts.push(last)
    return parts
  }

  test("finished work groups keep their identity while a later one grows", () => {
    const partsA = reuseParts(undefined, [...turn(3), text("x", "between"), tool("late-1")])
    const groupsA = reuseGroups(undefined, groupWorkParts(partsA))

    const partsB = reuseParts(partsA, clone([...turn(3), text("x", "between"), tool("late-1"), tool("late-2")]))
    const groupsB = reuseGroups(groupsA, groupWorkParts(partsB))

    expect(groupsB[0]).toBe(groupsA[0]) // finished group before the text
    expect(groupsB[1]).toBe(groupsA[1]) // the text
    expect(groupsB[2]).not.toBe(groupsA[2]) // the group that gained a tool
    expect((groupsB[2] as any).items).toHaveLength(2)
  })

  test("nothing changed returns the previous array", () => {
    const parts = reuseParts(undefined, turn(4))
    const groups = reuseGroups(undefined, groupWorkParts(parts))
    const again = reuseGroups(groups, groupWorkParts(reuseParts(parts, clone(turn(4)))))
    expect(again).toBe(groups)
  })

  test("a group whose tool is still running is rebuilt when it finishes", () => {
    const partsA = reuseParts(undefined, [tool("a"), tool("b", "streaming", undefined)])
    const groupsA = reuseGroups(undefined, groupWorkParts(partsA))
    const partsB = reuseParts(partsA, clone([tool("a"), tool("b", "success")]))
    const groupsB = reuseGroups(groupsA, groupWorkParts(partsB))
    expect(groupsB[0]).not.toBe(groupsA[0])
    expect(((groupsB[0] as any).items[1] as any).tool.state).toBe("success")
  })
})
