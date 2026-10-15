// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Keeps part identities stable between streaming updates.
 *
 * The AI SDK snapshots the whole message on every chunk, so every part comes
 * back as a new object. `extractOrderedParts` and `groupWorkParts` then build
 * new part and group objects too. A finished tool call can't change anymore,
 * but with new identities every `WorkGroup` / `CollapsibleToolGroup` in the
 * turn re-renders on every token, so one update costs time proportional to the
 * number of tool calls so far (quadratic over a turn).
 *
 * These helpers hand back the previous object whenever nothing visible has
 * changed, so `memo` can skip the untouched parts of the turn.
 */
import type { GroupedMessagePart, MessagePart } from "./types"

function sameTool(a: MessagePart & { type: "tool" }, b: MessagePart & { type: "tool" }): boolean {
  // Only finished calls are treated as immutable. A running call keeps
  // receiving input and interim output under the same state.
  const done = a.tool.state === "success" || a.tool.state === "error"
  return (
    done &&
    a.tool.state === b.tool.state &&
    a.tool.toolName === b.tool.toolName &&
    a.tool.error === b.tool.error
  )
}

function samePart(a: MessagePart, b: MessagePart): boolean {
  if (a === b) return true
  if (a.type !== b.type || a.id !== b.id) return false
  switch (a.type) {
    case "text":
      return a.text === (b as typeof a).text
    case "reasoning": {
      const r = b as typeof a
      return a.text === r.text && a.isStreaming === r.isStreaming && a.durationSeconds === r.durationSeconds
    }
    case "tool":
      return sameTool(a, b as typeof a)
    case "image":
    case "file": {
      const f = b as typeof a
      return a.url === f.url && a.mediaType === f.mediaType
    }
  }
}

/** Returns `prev` itself when every part is unchanged, otherwise `next` with unchanged parts swapped for their previous objects. */
export function reuseParts(prev: readonly MessagePart[] | undefined, next: MessagePart[]): MessagePart[] {
  if (!prev || prev.length === 0) return next
  const byId = new Map<string, MessagePart>()
  for (const part of prev) byId.set(part.id, part)
  let allSame = prev.length === next.length
  const out = next.map((part, index) => {
    const before = byId.get(part.id)
    if (before && samePart(before, part)) {
      if (prev[index] !== before) allSame = false
      return before
    }
    allSame = false
    return part
  })
  return allSame ? (prev as MessagePart[]) : out
}

function sameTools(
  a: Array<{ tool: unknown; id: string }>,
  b: Array<{ tool: unknown; id: string }>,
): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i].tool !== b[i].tool || a[i].id !== b[i].id) return false
  }
  return true
}

function sameGroup(a: GroupedMessagePart, b: GroupedMessagePart): boolean {
  if (a === b) return true
  if (a.type !== b.type || a.id !== b.id) return false
  switch (a.type) {
    case "work-group": {
      const items = (b as typeof a).items
      return a.items.length === items.length && a.items.every((item, i) => item === items[i])
    }
    case "tool-group": {
      const g = b as typeof a
      return a.toolName === g.toolName && sameTools(a.tools, g.tools)
    }
    case "image-gallery":
      return sameTools(a.tools, (b as typeof a).tools)
    default:
      // Plain parts were already de-duplicated by `reuseParts`.
      return false
  }
}

/** Same idea for the grouped list: unchanged groups keep their previous object. */
export function reuseGroups(prev: readonly GroupedMessagePart[] | undefined, next: GroupedMessagePart[]): GroupedMessagePart[] {
  if (!prev || prev.length === 0) return next
  const byId = new Map<string, GroupedMessagePart>()
  for (const group of prev) byId.set(group.id, group)
  let allSame = prev.length === next.length
  const out = next.map((group, index) => {
    const before = byId.get(group.id)
    if (before && sameGroup(before, group)) {
      if (prev[index] !== before) allSame = false
      return before
    }
    allSame = false
    return group
  })
  return allSame ? (prev as GroupedMessagePart[]) : out
}
