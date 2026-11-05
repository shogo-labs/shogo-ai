// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * useLiveAgentEdits — "follow agent" must not hijack the user's tabs.
 *
 *   - Only `source: "agent"` events may open new tabs (IDE saves, external
 *     fs writes, and untagged legacy events must not).
 *   - The `followAgent` setting turns auto-open off entirely.
 *   - Recent user activity in the IDE, or unsaved edits in the active file,
 *     mean the new tab opens in the background (activeId unchanged).
 */
import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test"
import { act, cleanup, renderHook } from "@testing-library/react"
import { useState } from "react"

import { useLiveAgentEdits, USER_ACTIVE_WINDOW_MS } from "../useLiveAgentEdits"
import type { EditorGroup, OpenFile } from "../types"
import type { WorkspaceFsEvent, WorkspaceService } from "../workspace/types"

// Other suites leave `document.visibilityState` hidden behind them; the hook
// parks its stream on a hidden tab, so every test here starts visible.
beforeEach(() => {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => "visible",
  })
})

afterEach(() => cleanup())

function file(path: string, over: Partial<OpenFile> = {}): OpenFile {
  return {
    id: `agent::${path}`,
    rootId: "agent",
    name: path.split("/").pop()!,
    path,
    language: "typescript",
    content: "x",
    savedContent: "x",
    dirty: false,
    ...over,
  } as OpenFile
}

function makeService(contents: Record<string, string>) {
  let listener: ((e: WorkspaceFsEvent) => void) | null = null
  const service = {
    id: "agent",
    label: "agent",
    readFile: async (p: string) => ({ content: contents[p] ?? "new", mtime: 1 }),
    subscribe: (cb: (e: WorkspaceFsEvent) => void) => {
      listener = cb
      return () => { listener = null }
    },
  } as unknown as WorkspaceService
  return { service, emit: (e: WorkspaceFsEvent) => listener?.(e) }
}

// Stable identity — the hook re-subscribes (and re-syncs) when it changes.
const refreshTree = () => {}

function setup(opts: {
  initialFiles?: OpenFile[]
  followAgent?: boolean
  root?: HTMLElement
}) {
  const files = opts.initialFiles ?? [file("src/a.ts")]
  const { service, emit } = makeService({})
  const view = renderHook(() => {
    const [groups, setGroups] = useState<EditorGroup[]>([
      { id: "g1", files, activeId: files[0]?.id ?? null } as EditorGroup,
    ])
    const [conflicts, setConflicts] = useState<any[]>([])
    useLiveAgentEdits({
      service,
      groups,
      setGroups,
      activeGroupIdx: 0,
      conflicts,
      setConflicts,
      refreshTree,
      followAgent: opts.followAgent,
      activityRootRef: opts.root ? { current: opts.root } : undefined,
    })
    return groups
  })
  const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)) })
  return { view, emit, flush }
}

describe("useLiveAgentEdits auto-open", () => {
  test("agent edit opens and focuses the file when the user is idle", async () => {
    const { view, emit, flush } = setup({})
    act(() => emit({ type: "file.changed", path: "src/b.ts", mtime: 1, source: "agent" }))
    await flush()
    const g = view.result.current[0]
    expect(g.files.map((f) => f.path)).toEqual(["src/a.ts", "src/b.ts"])
    expect(g.activeId).toBe("agent::src/b.ts")
  })

  test.each(["ide", "fs", undefined] as const)(
    "source=%p never opens a new tab",
    async (source) => {
      const { view, emit, flush } = setup({})
      act(() => emit({ type: "file.changed", path: "src/b.ts", mtime: 1, source }))
      await flush()
      const g = view.result.current[0]
      expect(g.files.map((f) => f.path)).toEqual(["src/a.ts"])
      expect(g.activeId).toBe("agent::src/a.ts")
    },
  )

  test("followAgent=false disables auto-open", async () => {
    const { view, emit, flush } = setup({ followAgent: false })
    act(() => emit({ type: "file.changed", path: "src/b.ts", mtime: 1, source: "agent" }))
    await flush()
    expect(view.result.current[0].files).toHaveLength(1)
  })

  test("does not switch tabs when the active file has unsaved edits", async () => {
    const { view, emit, flush } = setup({
      initialFiles: [file("src/a.ts", { dirty: true, content: "edited" })],
    })
    act(() => emit({ type: "file.changed", path: "src/b.ts", mtime: 1, source: "agent" }))
    await flush()
    const g = view.result.current[0]
    expect(g.files.map((f) => f.path)).toEqual(["src/a.ts", "src/b.ts"])
    expect(g.activeId).toBe("agent::src/a.ts")
  })

  test("opens in the background after recent user activity in the IDE", async () => {
    const root = document.createElement("div")
    document.body.appendChild(root)
    const { view, emit, flush } = setup({ root })
    act(() => {
      root.dispatchEvent(new Event("keydown", { bubbles: true }))
    })
    act(() => emit({ type: "file.changed", path: "src/b.ts", mtime: 1, source: "agent" }))
    await flush()
    const g = view.result.current[0]
    expect(g.files.map((f) => f.path)).toEqual(["src/a.ts", "src/b.ts"])
    expect(g.activeId).toBe("agent::src/a.ts")
    expect(USER_ACTIVE_WINDOW_MS).toBeGreaterThan(0)
    root.remove()
  })

  test("activity outside the IDE root does not block focus", async () => {
    const root = document.createElement("div")
    const outside = document.createElement("div")
    document.body.append(root, outside)
    const { view, emit, flush } = setup({ root })
    act(() => {
      outside.dispatchEvent(new Event("keydown", { bubbles: true }))
    })
    act(() => emit({ type: "file.changed", path: "src/b.ts", mtime: 1, source: "agent" }))
    await flush()
    expect(view.result.current[0].activeId).toBe("agent::src/b.ts")
    root.remove()
    outside.remove()
  })

  test("already-open tabs still refresh from non-agent events", async () => {
    const { view, emit, flush } = setup({})
    act(() => emit({ type: "file.changed", path: "src/a.ts", mtime: 2, source: "fs" }))
    await flush()
    expect(view.result.current[0].files[0].content).toBe("new")
  })
})

/**
 * The active-file poll is a bridge for a broken stream, not a background
 * heartbeat: healthy SSE = zero reads, and a stream that stays down falls
 * back to the shared 15 s cadence until a retry opens (PERF-10).
 */
describe("useLiveAgentEdits stream health", () => {
  function makeStreaming(contents: Record<string, string>) {
    const reads: string[] = []
    let listener: ((e: WorkspaceFsEvent) => void) | null = null
    let status: ((s: "open" | "down") => void) | null = null
    let mode: "up" | "down" = "up"
    const service = {
      id: "agent",
      label: "agent",
      readFile: async (p: string) => {
        reads.push(p)
        return { content: contents[p] ?? "x", mtime: 1 }
      },
      readFileIfChanged: async (p: string) => {
        reads.push(p)
        const content = contents[p]
        return content === undefined ? null : { content, mtime: 2 }
      },
      subscribe: (cb: (e: WorkspaceFsEvent) => void, opts?: { onStatus?: (s: "open" | "down") => void }) => {
        listener = cb
        status = opts?.onStatus ?? null
        status?.(mode === "up" ? "open" : "down")
        return () => {
          listener = null
        }
      },
    } as unknown as WorkspaceService
    return {
      service,
      reads,
      emit: (e: WorkspaceFsEvent) => listener?.(e),
      fail: () => {
        mode = "down"
        status?.("down")
      },
      recover: () => {
        mode = "up"
      },
    }
  }

  function mount(service: WorkspaceService, visible = true) {
    return renderHook(() => {
      const [groups, setGroups] = useState<EditorGroup[]>([
        { id: "g1", files: [file("src/a.ts")], activeId: "agent::src/a.ts" } as EditorGroup,
      ])
      const [conflicts, setConflicts] = useState<any[]>([])
      useLiveAgentEdits({
        service,
        groups,
        setGroups,
        activeGroupIdx: 0,
        conflicts,
        setConflicts,
        refreshTree,
        visible,
      })
      return groups
    })
  }

  const flush = () =>
    act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

  test("a healthy stream never re-reads the active file", async () => {
    jest.useFakeTimers()
    const s = makeStreaming({ "src/a.ts": "x" })
    const view = mount(s.service)
    await flush()

    // One resync when the stream opens, then nothing.
    const afterOpen = s.reads.length
    expect(afterOpen).toBeGreaterThan(0)

    await act(async () => {
      jest.advanceTimersByTime(10 * 60_000)
      await Promise.resolve()
    })
    expect(s.reads.length).toBe(afterOpen)
    view.unmount()
    jest.useRealTimers()
  })

  test("a dropped stream polls every 15 s and stops when a retry opens", async () => {
    jest.useFakeTimers()
    const s = makeStreaming({ "src/a.ts": "x" })
    const view = mount(s.service)
    await flush()
    const afterOpen = s.reads.length

    act(() => s.fail())
    await act(async () => {
      jest.advanceTimersByTime(20_000)
      await Promise.resolve()
      await Promise.resolve()
    })
    // One retry at 2 s (still down) then exactly one poll at 17 s.
    expect(s.reads.length).toBe(afterOpen + 1)

    // Stream comes back: the next retry opens, resyncs once, and polling stops.
    s.recover()
    await act(async () => {
      jest.advanceTimersByTime(30_000)
      await Promise.resolve()
      await Promise.resolve()
    })
    const afterRecover = s.reads.length
    await act(async () => {
      jest.advanceTimersByTime(10 * 60_000)
      await Promise.resolve()
    })
    expect(s.reads.length).toBe(afterRecover)
    view.unmount()
    jest.useRealTimers()
  })

  test("a hidden IDE pane makes no fallback reads", async () => {
    jest.useFakeTimers()
    const s = makeStreaming({ "src/a.ts": "x" })
    const view = mount(s.service, false)
    await flush()
    const afterOpen = s.reads.length

    act(() => s.fail())
    await act(async () => {
      jest.advanceTimersByTime(5 * 60_000)
      await Promise.resolve()
    })
    expect(s.reads.length).toBe(afterOpen)
    view.unmount()
    jest.useRealTimers()
  })
})
