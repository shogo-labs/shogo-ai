// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A workspace agent also writes files in other projects, which live in those
 * projects' own runtimes. Their paths are looked up in that project's file
 * list, fetched once per project, so a chip still means "this file is really
 * there" (SHO-247).
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { act, cleanup, renderHook, waitFor } from "@testing-library/react"

const PLANNER = "d80288dd-aac3-41ed-bc9d-6ee251c44374"
const WORKSPACE_URL = "https://workspace.example"
const PLANNER_URL = `https://api.example/api/projects/${PLANNER}/agent-proxy`

const FILES: Record<string, string[]> = {
  [WORKSPACE_URL]: ["notes.md"],
  [PLANNER_URL]: ["plans/sealed.md"],
}

/** Every base URL a file list was read from, in order. */
const listCalls: string[] = []

mock.module("@shogo-ai/sdk/agent", () => ({
  AgentClient: class {
    baseUrl: string
    constructor(options: { baseUrl?: string } = {}) {
      this.baseUrl = options.baseUrl ?? ""
    }
    listWorkspaceFiles() {
      listCalls.push(this.baseUrl)
      return Promise.resolve({ files: FILES[this.baseUrl] ?? [] })
    }
  },
}))
mock.module("../../../lib/agent-fetch", () => ({
  agentFetch: () => Promise.reject(new Error("unused")),
}))

const { useChatFileIndex } = await import("../useChatFileIndex")

beforeEach(() => {
  listCalls.length = 0
})

afterEach(() => {
  cleanup()
})

function mount(projectAgentUrl?: (projectId: string) => string | null) {
  return renderHook(() =>
    useChatFileIndex(WORKSPACE_URL, null, false, { projectAgentUrl }),
  )
}

describe("useChatFileIndex", () => {
  test("chips a workspace file from the workspace's own list", async () => {
    const { result } = mount()
    await waitFor(() => expect(result.current("notes.md")).toBe(true))
    expect(result.current("missing.md")).toBe(false)
    expect(listCalls).toEqual([WORKSPACE_URL])
  })

  test("chips a file in an unmounted project after reading that project's list", async () => {
    const { result } = mount((projectId) =>
      projectId === PLANNER ? PLANNER_URL : null,
    )
    await waitFor(() => expect(result.current("notes.md")).toBe(true))

    // Not a chip yet: the project's list has not been read, and the workspace
    // runtime has no copy of the file.
    let found = true
    act(() => {
      found = result.current(`${PLANNER}/plans/sealed.md`)
    })
    expect(found).toBe(false)

    await waitFor(() => expect(result.current(`${PLANNER}/plans/sealed.md`)).toBe(true))
    // One read for the workspace, one for the project — however often the chip
    // check runs.
    expect(listCalls).toEqual([WORKSPACE_URL, PLANNER_URL])
    expect(result.current(`${PLANNER}/plans/missing.md`)).toBe(false)
    expect(listCalls).toEqual([WORKSPACE_URL, PLANNER_URL])
  })

  test("a project it cannot reach never chips", async () => {
    const { result } = mount(() => null)
    await waitFor(() => expect(result.current("notes.md")).toBe(true))

    expect(result.current(`${PLANNER}/plans/sealed.md`)).toBe(false)
    expect(listCalls).toEqual([WORKSPACE_URL])
  })

  test("without a project URL the index behaves as it did before", async () => {
    const { result } = mount()
    await waitFor(() => expect(result.current("notes.md")).toBe(true))
    expect(result.current(`${PLANNER}/plans/sealed.md`)).toBe(false)
    expect(listCalls).toEqual([WORKSPACE_URL])
  })

  test("a finished turn re-reads the other project's list", async () => {
    const projectAgentUrl = (projectId: string) =>
      projectId === PLANNER ? PLANNER_URL : null
    const { result, rerender } = renderHook(
      ({ isStreaming }: { isStreaming: boolean }) =>
        useChatFileIndex(WORKSPACE_URL, null, isStreaming, { projectAgentUrl }),
      { initialProps: { isStreaming: true } },
    )
    await waitFor(() => expect(result.current("notes.md")).toBe(true))
    expect(result.current(`${PLANNER}/plans/sealed.md`)).toBe(false)
    await waitFor(() => expect(result.current(`${PLANNER}/plans/sealed.md`)).toBe(true))

    // The turn writes one more file in that project; the list is read again
    // once the turn ends, so the new file chips without a remount.
    FILES[PLANNER_URL] = ["plans/sealed.md", "plans/next.md"]
    try {
      rerender({ isStreaming: false })
      await waitFor(() => expect(result.current(`${PLANNER}/plans/next.md`)).toBe(true))
    } finally {
      FILES[PLANNER_URL] = ["plans/sealed.md"]
    }
  })
})
