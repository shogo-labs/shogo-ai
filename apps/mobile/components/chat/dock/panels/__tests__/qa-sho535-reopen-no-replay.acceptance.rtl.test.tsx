// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-535 acceptance, driven through the real panel + the real ledger store +
 * a device storage this test owns.
 *
 * The card's promise is about a *reopen*: the runtime keeps a settled task in
 * `listDock()` for ten minutes, so every remount inside that window is handed
 * the row again. What the reader watched retire must not play again; what
 * settled while they were away must. The panel's own unit tests seed the
 * in-memory ledger directly, so these cases take the other route — the one a
 * reload actually takes, where the memory comes back out of AsyncStorage after
 * the component has mounted.
 */

import { resolve } from "node:path"
import { beforeEach, describe, expect, jest, mock, test } from "bun:test"
import { act, render } from "@testing-library/react"
import { createElement } from "react"
import type { DockPanelDescriptor } from "../../../../../lib/chat-dock-store"
import type { RunningProcess } from "../../../ProcessPanel"
import { createReactNativeMock } from "../../../../../test/react-native-mock"
import {
  DOCK_FINISHED_EXIT_MS,
  DOCK_FINISHED_LINGER_MS,
  DOCK_FINISHED_MIN_VISIBLE_MS,
  DOCK_SEEN_MAX_KEYS_PER_SESSION,
} from "../../finished-rows"

const STORAGE_KEY = "shogo:dock-seen-rows"
/** The device's storage, owned here so a test can simulate a reload. */
const storage = new Map<string, string>()

mock.module("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: async (key: string) => storage.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      storage.set(key, value)
    },
    removeItem: async (key: string) => {
      storage.delete(key)
    },
  },
}))

mock.module("react-native", () =>
  createReactNativeMock({
    Pressable: ({ onPress, children, disabled, ...props }: any) =>
      createElement("button", { ...props, disabled, onClick: onPress }, children),
  }),
)
mock.module("@shogo/shared-ui/primitives", () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(" "),
}))

let descriptor: DockPanelDescriptor | null = null

mock.module(resolve(import.meta.dir, "../../useDockPanel"), () => ({
  useDockPanel: (d: DockPanelDescriptor | null) => {
    descriptor = d
  },
}))

const { RunningDockPanel } = await import("../RunningDockPanel")
const {
  __resetDockSeenLedgerStorageForTests,
  markDockRowShown,
  wasDockRowShown,
} = await import("../../../../../lib/dock-seen-ledger")

let bodyRoot: ReturnType<typeof render> | null = null
let panelRoot: ReturnType<typeof render> | null = null
let lastNow = Date.now()

function task(overrides: Partial<RunningProcess>): RunningProcess {
  return {
    runId: overrides.id ?? "t_1",
    id: overrides.id ?? "t_1",
    command: "",
    pid: 0,
    startedAt: lastNow - 5_000,
    elapsedMs: 5_000,
    status: "running",
    ...overrides,
  } as RunningProcess
}

/** A settled row: finished a second ago, so it still has its whole linger. */
function doneTask(id: string, at: number): RunningProcess {
  return task({
    id,
    command: `run ${id}`,
    status: "completed",
    startedAt: at - 60_000,
    finishedAt: at - 1_000,
  })
}

function panelProps(
  processes: RunningProcess[],
  sessionId: string | null,
): React.ComponentProps<typeof RunningDockPanel> {
  return {
    processes,
    onKillProcess: () => {},
    subagents: [],
    recentTools: [],
    sessionId,
  }
}

function mountPanel(props: Partial<React.ComponentProps<typeof RunningDockPanel>>) {
  bodyRoot?.unmount()
  panelRoot?.unmount()
  bodyRoot = null
  descriptor = null
  panelRoot = render(<RunningDockPanel {...panelProps([], null)} {...props} />)
  return panelRoot
}

function body() {
  const element = <>{descriptor ? descriptor.render({ expanded: true }) : null}</>
  if (bodyRoot) {
    bodyRoot.rerender(element)
    return bodyRoot
  }
  bodyRoot = render(element)
  return bodyRoot
}

/** Small steps: a timer scheduled inside a jump does not run during it. */
function advance(ms: number) {
  let left = ms
  while (left > 0) {
    const step = Math.min(100, left)
    act(() => {
      jest.advanceTimersByTime(step)
    })
    left -= step
  }
}

/** Let the mount effect's AsyncStorage read resolve. */
async function flushStorageRead() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe("SHO-535 reopening a chat does not replay settled rows", () => {
  beforeEach(() => {
    storage.clear()
    __resetDockSeenLedgerStorageForTests()
  })

  test("after a reload, only the rows that settled while away play", async () => {
    jest.useFakeTimers()
    const now = Date.now()
    lastNow = now

    // What the reload left behind: one row this device watched retire.
    storage.set(STORAGE_KEY, JSON.stringify({ "chat-1": { t_old: now - 30_000 } }))
    __resetDockSeenLedgerStorageForTests()

    // Reopen: the dock mounts empty, then the stream hands it the runtime's
    // ten-minute listing — exactly what ChatPanel does (`setRunningProcesses`).
    const panel = mountPanel({ sessionId: "chat-1", processes: [] })
    await flushStorageRead()
    expect(wasDockRowShown("chat-1", "t_old")).toBe(true)

    act(() => {
      panel.rerender(
        <RunningDockPanel
          {...panelProps([doneTask("t_old", now), doneTask("t_new", now)], "chat-1")}
        />,
      )
    })

    const view = body()
    expect(descriptor!.title).toBe("Finished")
    expect(descriptor!.summary).toBe("1 finished")
    expect(view.queryByText("run t_old")).toBeNull()
    expect(view.getByText("run t_new")).toBeTruthy()

    // The row that settled while away keeps its readable window, then leaves.
    advance(DOCK_FINISHED_MIN_VISIBLE_MS)
    expect(view.getByText("run t_new")).toBeTruthy()
    advance(DOCK_FINISHED_LINGER_MS + DOCK_FINISHED_EXIT_MS + 100)
    expect(descriptor).toBeNull()

    // Both are now the device's memory, and it reached storage.
    expect(wasDockRowShown("chat-1", "t_new")).toBe(true)
    advance(1_000)
    await act(async () => {
      await Promise.resolve()
    })
    const saved = JSON.parse(storage.get(STORAGE_KEY)!) as Record<string, Record<string, number>>
    expect(Object.keys(saved["chat-1"]!).sort()).toEqual(["t_new", "t_old"])

    // The same listing again — the next reopen — renders nothing at all.
    mountPanel({ sessionId: "chat-1", processes: [doneTask("t_old", now), doneTask("t_new", now)] })
    advance(DOCK_FINISHED_LINGER_MS)
    expect(descriptor).toBeNull()

    jest.useRealTimers()
  })

  test("leaving during the readable window writes nothing, so the row plays again", async () => {
    jest.useFakeTimers()
    const now = Date.now()
    lastNow = now
    const done = doneTask("t_read", now)

    const panel = mountPanel({ sessionId: "chat-1", processes: [done] })
    await flushStorageRead()
    advance(600)
    expect(descriptor!.title).toBe("Finished")
    expect(body().getByText("run t_read")).toBeTruthy()

    // The person leaves before the exit finishes.
    panel.unmount()
    panelRoot = null
    bodyRoot?.unmount()
    bodyRoot = null
    descriptor = null
    advance(DOCK_FINISHED_LINGER_MS + DOCK_FINISHED_EXIT_MS + 200)
    await act(async () => {
      await Promise.resolve()
    })

    expect(wasDockRowShown("chat-1", "t_read")).toBe(false)
    expect(storage.get(STORAGE_KEY)).toBeUndefined()

    mountPanel({ sessionId: "chat-1", processes: [{ ...done }] })
    expect(descriptor!.title).toBe("Finished")
    expect(body().getByText("run t_read")).toBeTruthy()

    jest.useRealTimers()
  })

  test("a running or stale row is never hidden by the ledger", async () => {
    jest.useFakeTimers()
    const now = Date.now()
    lastNow = now
    storage.set(STORAGE_KEY, JSON.stringify({ "chat-1": { t_run: now - 1_000, t_stale: now - 1_000 } }))
    __resetDockSeenLedgerStorageForTests()

    mountPanel({
      sessionId: "chat-1",
      processes: [
        task({ id: "t_run", command: "bun dev", startedAt: now - 60_000 }),
        task({ id: "t_stale", command: "lost build", stale: true, startedAt: now - 60_000 }),
      ],
    })
    await flushStorageRead()

    expect(descriptor!.title).toBe("Running")
    expect(descriptor!.summary).toBe("2 running")
    const view = body()
    expect(view.getByText("bun dev")).toBeTruthy()
    expect(view.getByText("lost build")).toBeTruthy()

    advance(DOCK_FINISHED_LINGER_MS * 3)
    expect(descriptor!.title).toBe("Running")
    expect(view.getByText("bun dev")).toBeTruthy()

    jest.useRealTimers()
  })

  test("the device ledger stays bounded in storage", async () => {
    jest.useFakeTimers()
    const now = Date.now()
    lastNow = now

    for (let i = 0; i < DOCK_SEEN_MAX_KEYS_PER_SESSION + 25; i += 1) {
      markDockRowShown("chat-1", `t_${i}`, now + i)
    }
    advance(1_000)
    await act(async () => {
      await Promise.resolve()
    })

    const saved = JSON.parse(storage.get(STORAGE_KEY)!) as Record<string, Record<string, number>>
    const keys = Object.keys(saved["chat-1"]!)
    expect(keys.length).toBe(DOCK_SEEN_MAX_KEYS_PER_SESSION)
    // The newest stamps are the ones kept.
    expect(keys).toContain(`t_${DOCK_SEEN_MAX_KEYS_PER_SESSION + 24}`)
    expect(keys).not.toContain("t_0")

    jest.useRealTimers()
  })
})
