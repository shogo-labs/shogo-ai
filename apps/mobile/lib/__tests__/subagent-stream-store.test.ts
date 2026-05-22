// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Unit tests for the ephemeral subagent stream store.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { subagentStreamStore } from "../subagent-stream-store"

const baseData = {
  agentId: "agent-1",
  agentType: "explore",
  description: "Search codebase",
  status: "running" as const,
}

describe("subagentStreamStore", () => {
  beforeEach(() => {
    subagentStreamStore.clear()
    subagentStreamStore.onRequestTabSwitch(null)
  })

  afterEach(() => {
    subagentStreamStore.clear()
    subagentStreamStore.onRequestTabSwitch(null)
  })

  test("init creates entry with empty parts", () => {
    subagentStreamStore.init("tool-1", baseData)
    const entry = subagentStreamStore.get("tool-1")
    expect(entry).toMatchObject(baseData)
    expect(entry!.parts).toEqual([])
  })

  test("init merges into existing entry without wiping parts", () => {
    subagentStreamStore.init("tool-1", baseData)
    subagentStreamStore.appendPart("tool-1", { type: "text", text: "hi", id: "p1" })
    subagentStreamStore.init("tool-1", {
      ...baseData,
      agentType: "",
      description: "Updated",
      status: "completed",
    })
    const entry = subagentStreamStore.get("tool-1")
    expect(entry!.agentType).toBe("explore")
    expect(entry!.description).toBe("Updated")
    expect(entry!.status).toBe("completed")
    expect(entry!.parts).toHaveLength(1)
  })

  test("setParts updates when length changes", () => {
    subagentStreamStore.init("tool-1", baseData)
    const parts = [{ type: "text" as const, text: "a", id: "p1" }]
    subagentStreamStore.setParts("tool-1", parts)
    expect(subagentStreamStore.get("tool-1")!.parts).toEqual(parts)
  })

  test("setParts is a no-op when length unchanged", () => {
    subagentStreamStore.init("tool-1", baseData)
    const parts = [{ type: "text" as const, text: "a", id: "p1" }]
    subagentStreamStore.setParts("tool-1", parts)
    const versionBefore = subagentStreamStore.getVersion()
    subagentStreamStore.setParts("tool-1", [{ type: "text", text: "b", id: "p2" }])
    expect(subagentStreamStore.getVersion()).toBe(versionBefore)
    expect(subagentStreamStore.get("tool-1")!.parts[0].type).toBe("text")
    if (subagentStreamStore.get("tool-1")!.parts[0].type === "text") {
      expect(subagentStreamStore.get("tool-1")!.parts[0].text).toBe("a")
    }
  })

  test("appendPart and updateStatus", () => {
    subagentStreamStore.init("tool-1", baseData)
    subagentStreamStore.appendPart("tool-1", { type: "text", text: "chunk", id: "p1" })
    subagentStreamStore.updateStatus("tool-1", "error")
    expect(subagentStreamStore.get("tool-1")!.parts).toHaveLength(1)
    expect(subagentStreamStore.get("tool-1")!.status).toBe("error")
  })

  test("setInstanceId and setModel skip redundant writes", () => {
    subagentStreamStore.init("tool-1", { ...baseData, instanceId: "inst-1", model: "gpt-4" })
    const versionAfterInit = subagentStreamStore.getVersion()
    subagentStreamStore.setInstanceId("tool-1", "inst-1")
    subagentStreamStore.setModel("tool-1", "gpt-4")
    expect(subagentStreamStore.getVersion()).toBe(versionAfterInit)
    subagentStreamStore.setInstanceId("tool-1", "inst-2")
    subagentStreamStore.setModel("tool-1", "claude")
    expect(subagentStreamStore.get("tool-1")!.instanceId).toBe("inst-2")
    expect(subagentStreamStore.get("tool-1")!.model).toBe("claude")
  })

  test("clear removes all entries", () => {
    subagentStreamStore.init("tool-1", baseData)
    subagentStreamStore.init("tool-2", { ...baseData, agentId: "agent-2" })
    subagentStreamStore.clear()
    expect(subagentStreamStore.get("tool-1")).toBeUndefined()
    expect(subagentStreamStore.getAll().size).toBe(0)
  })

  test("subscribe notifies on mutations", () => {
    let calls = 0
    const unsub = subagentStreamStore.subscribe(() => {
      calls++
    })
    subagentStreamStore.init("tool-1", baseData)
    subagentStreamStore.updateStatus("tool-1", "completed")
    unsub()
    subagentStreamStore.init("tool-2", baseData)
    expect(calls).toBe(2)
  })

  test("requestTabSwitch invokes registered handler", () => {
    let received: string | undefined
    subagentStreamStore.onRequestTabSwitch((toolId) => {
      received = toolId
    })
    subagentStreamStore.requestTabSwitch("tool-9")
    expect(received).toBe("tool-9")
  })

  test("unknown toolId operations are no-ops", () => {
    const versionBefore = subagentStreamStore.getVersion()
    subagentStreamStore.appendPart("missing", { type: "text", text: "x", id: "p1" })
    subagentStreamStore.setParts("missing", [])
    subagentStreamStore.updateStatus("missing", "completed")
    expect(subagentStreamStore.getVersion()).toBe(versionBefore)
  })
})
