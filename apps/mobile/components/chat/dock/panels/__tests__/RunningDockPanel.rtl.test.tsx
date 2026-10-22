// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { resolve } from "node:path"
import { describe, expect, jest, mock, test } from "bun:test"
import { act, fireEvent, render, waitFor } from "@testing-library/react"
import { createElement } from "react"
import type { DockPanelDescriptor } from "../../../../../lib/chat-dock-store"
import type { RunningProcess } from "../../../ProcessPanel"
import { createReactNativeMock } from "../../../../../test/react-native-mock"
import {
  DOCK_FINISHED_EXIT_MS,
  DOCK_FINISHED_LINGER_MS,
  DOCK_FINISHED_MIN_VISIBLE_MS,
} from "../../finished-rows"

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

let bodyRoot: ReturnType<typeof render> | null = null
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

function mountPanel(props: Partial<React.ComponentProps<typeof RunningDockPanel>>) {
  descriptor = null
  bodyRoot = null
  return render(
    <RunningDockPanel
      processes={[]}
      onKillProcess={() => {}}
      subagents={[]}
      recentTools={[]}
      {...props}
    />,
  )
}

function renderPanel(props: Partial<React.ComponentProps<typeof RunningDockPanel>>) {
  mountPanel(props)
  return descriptor
}

/** The panel body, kept in one root so a poll or a timer re-render updates it in place. */
function body() {
  const element = <>{descriptor ? descriptor.render({ expanded: true }) : null}</>
  if (bodyRoot) {
    bodyRoot.rerender(element)
    return bodyRoot
  }
  bodyRoot = render(element)
  return bodyRoot
}

/**
 * Run the fake clock forward in small steps: Bun's `advanceTimersByTime` does
 * not run a timer that another timer scheduled during the same jump, and the
 * linger -> exit chain is exactly that.
 */
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

describe("RunningDockPanel", () => {
  test("registers nothing when no task runs and the agent is not waiting", () => {
    expect(renderPanel({})).toBeNull()
  })

  test("every task source gets the same row; shell rows say Kill, others Cancel", () => {
    const killed: string[] = []
    const d = renderPanel({
      processes: [
        task({ id: "t_sh", command: "bun dev", source: "shell" }),
        task({ id: "t_ag", source: "subagent", title: "explore: auth flow" }),
        task({ id: "t_pc", source: "project_call", title: "Analyst" }),
        task({ id: "t_ar", source: "agent_reply", title: "@Ops reply" }),
        task({ id: "t_wi", source: "work_item", title: "SUP-12 Fix login" }),
      ],
      onKillProcess: (id) => { killed.push(id) },
    })
    expect(d!.title).toBe("Running")
    expect(d!.summary).toBe("5 running")

    const view = body()
    for (const title of ["bun dev", "explore: auth flow", "Analyst", "@Ops reply", "SUP-12 Fix login"]) {
      expect(view.getByText(title)).toBeTruthy()
    }
    expect(view.getAllByText("Kill")).toHaveLength(1)
    expect(view.getAllByText("Cancel")).toHaveLength(4)

    fireEvent.click(view.getAllByText("Cancel")[0]!)
    expect(killed).toEqual(["t_ag"])
  })

  test("while the agent is in wait the panel says so and marks the tasks it waits on", () => {
    const d = renderPanel({
      processes: [task({ id: "t_dev", command: "bun dev" }), task({ id: "t_other", command: "tsc -w" })],
      waiting: { taskIds: ["t_dev"], until: "ready", timeoutMs: 60_000, startedAt: lastNow - 3_000 },
    })
    expect(d!.title).toBe("Waiting")
    expect(d!.summary).toBe("agent waiting · 2 running")

    const view = body()
    expect(view.getByText(/Agent is waiting on a task/)).toBeTruthy()
    expect(view.getByText(/until "ready"/)).toBeTruthy()
    expect(view.getAllByText("waiting")).toHaveLength(1)
  })

  test("a wait with no tasks still shows the agent is paused", () => {
    const d = renderPanel({ waiting: { taskIds: [], timeoutMs: 5_000, startedAt: lastNow } })
    expect(d).not.toBeNull()
    expect(body().getByText("Agent is pausing")).toBeTruthy()
  })

  test("once the turn ends, tasks that will wake the agent are called out", () => {
    renderPanel({
      agentIdle: true,
      processes: [
        task({ id: "t_a", source: "subagent", title: "explore", notify: true }),
        task({ id: "t_b", source: "agent_reply", title: "@Ops reply", notify: true }),
        task({ id: "t_c", command: "old", stale: true, notify: true }),
      ],
    })
    expect(body().getByText("Waiting on 2 tasks · the agent will continue when they finish")).toBeTruthy()
  })

  test("a runtime-interrupted row reads interrupted, never completed", () => {
    const t0 = Date.now()
    renderPanel({
      processes: [task({ id: "t_int", command: "bun run release | tail -5", status: "interrupted", startedAt: t0 - 60_000, finishedAt: t0 - 1_000 })],
    })
    const view = body()
    expect(view.getByText("interrupted")).toBeTruthy()
    expect(view.queryByText("completed")).toBeNull()
  })

  test("a stale row with a log still offers Output, one without a log does not", async () => {
    // A task the runtime died under: the child cannot be polled or signalled,
    // but its log is a file the runtime can still read (SHO-141). Stale alone
    // used to hide Output, so the report's log was unreachable from the dock.
    const loaded: string[] = []
    renderPanel({
      processes: [
        task({
          id: "t_stale_log",
          command: "npm run release",
          status: "interrupted",
          stale: true,
          outputFile: ".shogo/tasks/s/t_stale_log.log",
        }),
        task({ id: "t_stale_bare", command: "lost build", status: "interrupted", stale: true }),
      ],
      loadOutput: async (id) => {
        loaded.push(id)
        return { taskId: id, output: "status: interrupted" }
      },
    })
    const view = body()
    // Exactly one row offers it: the one that knows where its log is.
    expect(view.getAllByText("Output")).toHaveLength(1)
    fireEvent.click(view.getByText("Output"))
    await waitFor(() => expect(view.getByText(/status: interrupted/)).toBeTruthy())
    expect(loaded).toEqual(["t_stale_log"])
  })

  test("Output loads the task's latest output inline", async () => {
    const loaded: string[] = []
    renderPanel({
      processes: [task({ id: "t_log", command: "bun test" })],
      loadOutput: async (id) => {
        loaded.push(id)
        return { taskId: id, output: "line 1\n3 pass\n0 fail" }
      },
    })
    const view = body()
    fireEvent.click(view.getByText("Output"))
    await waitFor(() => expect(view.getByText(/3 pass/)).toBeTruthy())
    expect(loaded).toEqual(["t_log"])
    fireEvent.click(view.getByText("Hide"))
    expect(view.queryByText(/3 pass/)).toBeNull()
  })

  test("Output opened while the row is already exiting pins it, and it still retires once closed", async () => {
    jest.useFakeTimers()
    lastNow = Date.now()
    const t0 = lastNow
    renderPanel({
      processes: [task({ id: "t_done", command: "bun test", status: "completed", startedAt: t0 - 10_000, finishedAt: t0 })],
      loadOutput: async (id) => ({ taskId: id, output: "3 pass" }),
    })
    const view = body()
    expect(view.getByText("completed")).toBeTruthy()

    // The exit is running when the reader clicks: the row must come back.
    advance(DOCK_FINISHED_LINGER_MS)
    advance(100)
    await act(async () => {
      fireEvent.click(view.getByText("Output"))
    })
    expect(view.getByText(/3 pass/)).toBeTruthy()

    advance(DOCK_FINISHED_LINGER_MS * 2)
    expect(view.getByText("completed")).toBeTruthy()
    expect(descriptor!.summary).toBe("1 finished")

    // Closed again: it is long past its linger, so it leaves — for good.
    await act(async () => {
      fireEvent.click(view.getByText("Hide"))
    })
    advance(DOCK_FINISHED_EXIT_MS + 500)
    expect(body().queryByText("completed")).toBeNull()
    expect(descriptor).toBeNull()

    jest.useRealTimers()
  })

  test("a settled row keeps its outcome, frozen duration and Output for the linger, with no Cancel", async () => {
    jest.useFakeTimers()
    lastNow = Date.now()
    const t0 = lastNow
    const killed: string[] = []
    const loaded: string[] = []
    const d = renderPanel({
      processes: [
        task({ id: "t_run", command: "bun dev", source: "shell", notify: true, startedAt: t0 - 5_000 }),
        task({
          id: "t_done",
          command: "bun test",
          source: "shell",
          status: "completed",
          startedAt: t0 - 121_000,
          finishedAt: t0 - 1_000,
          elapsedMs: 120_000,
          notify: true,
        }),
      ],
      agentIdle: true,
      onKillProcess: (id) => { killed.push(id) },
      loadOutput: async (id) => {
        loaded.push(id)
        return { taskId: id, output: "3 pass\n0 fail" }
      },
    })
    expect(d!.title).toBe("Running")
    expect(d!.summary).toBe("1 running · 1 finished")

    const view = body()
    expect(view.getByText("completed")).toBeTruthy()
    expect(view.getByText("2m 0s")).toBeTruthy()
    // Only the running row can be cancelled.
    expect(view.getAllByText("Kill")).toHaveLength(1)
    // A finished task does not wake the agent, so it is not "waited on".
    expect(view.getByText("Waiting on 1 task · the agent will continue when it finishes")).toBeTruthy()

    await act(async () => {
      fireEvent.click(view.getAllByText("Output")[1]!)
    })
    expect(loaded).toEqual(["t_done"])
    expect(view.getByText(/3 pass/)).toBeTruthy()
    expect(killed).toEqual([])

    // Reading the output pins the row: it outlives its linger while open.
    advance(DOCK_FINISHED_LINGER_MS * 3)
    expect(descriptor!.summary).toBe("1 running · 1 finished")
    expect(body().getByText("completed")).toBeTruthy()

    // Closed again, and already past its linger: it leaves on the next tick.
    await act(async () => {
      fireEvent.click(view.getByText("Hide"))
    })
    advance(DOCK_FINISHED_EXIT_MS + 50)
    expect(body().queryByText("completed")).toBeNull()
    expect(descriptor!.summary).toBe("1 running")

    jest.useRealTimers()
  })

  test("with only finished rows the chip says Finished, then goes away with the last row", () => {
    jest.useFakeTimers()
    lastNow = Date.now()
    const t0 = lastNow
    const d = renderPanel({
      processes: [
        task({ id: "t_a", title: "explore", source: "subagent", status: "completed", startedAt: t0 - 9_000, finishedAt: t0 - 2_000 }),
        task({ id: "t_b", command: "bun test", status: "failed", startedAt: t0 - 9_000, finishedAt: t0 - 5_000 }),
      ],
    })
    expect(d!.title).toBe("Finished")
    expect(d!.summary).toBe("2 finished")
    const view = body()
    expect(view.getByText("completed")).toBeTruthy()
    expect(view.getByText("failed")).toBeTruthy()
    expect(view.queryByText("Kill")).toBeNull()
    expect(view.queryByText("Cancel")).toBeNull()

    // t_b finished 5 s before the poll delivered it, so its server linger is
    // spent — but it still gets the readable floor from first sight, then its
    // exit animation (and keeps counting) before it drops out.
    advance(50)
    expect(descriptor!.summary).toBe("2 finished")
    expect(body().getByText("failed")).toBeTruthy()
    advance(DOCK_FINISHED_MIN_VISIBLE_MS - 50)
    expect(descriptor!.summary).toBe("2 finished")
    advance(DOCK_FINISHED_EXIT_MS + 100)
    expect(descriptor!.summary).toBe("1 finished")
    expect(body().queryByText("failed")).toBeNull()
    expect(body().getByText("completed")).toBeTruthy()

    // Then the last row: the panel unregisters instead of showing an empty chip.
    advance(DOCK_FINISHED_LINGER_MS + DOCK_FINISHED_EXIT_MS + 100)
    expect(descriptor).toBeNull()
    expect(body().queryByText("completed")).toBeNull()

    jest.useRealTimers()
  })

  test("a row the poll delivers already settled still gets a readable window", () => {
    jest.useFakeTimers()
    lastNow = Date.now()
    const t0 = lastNow
    const running = task({ id: "t_late", status: "running", startedAt: t0 - 60_000 })
    const panel = mountPanel({ processes: [running] })
    expect(descriptor!.title).toBe("Running")

    // The task settled 3.9 s ago server-side; the 5 s poll only just caught up.
    // Costing the linger from `finishedAt` alone leaves this row 100 ms of life.
    act(() => {
      panel.rerender(
        <RunningDockPanel
          processes={[{ ...running, status: "completed", finishedAt: t0 - 3_900 }]}
          onKillProcess={() => {}}
          subagents={[]}
          recentTools={[]}
        />,
      )
    })
    expect(descriptor!.title).toBe("Finished")
    expect(body().getByText("completed")).toBeTruthy()

    advance(1_000)
    expect(descriptor!.summary).toBe("1 finished")
    expect(body().getByText("completed")).toBeTruthy()

    advance(DOCK_FINISHED_MIN_VISIBLE_MS - 1_000 + DOCK_FINISHED_EXIT_MS + 100)
    expect(descriptor).toBeNull()
    expect(body().queryByText("completed")).toBeNull()

    jest.useRealTimers()
  })

  test("a retired row that a later poll re-sends stays hidden", () => {
    jest.useFakeTimers()
    lastNow = Date.now()
    const t0 = lastNow
    const done = task({
      id: "t_done",
      command: "bun test",
      status: "completed",
      startedAt: t0 - 6_000,
      finishedAt: t0 - 1_000,
    })
    const panel = mountPanel({ processes: [done] })
    expect(descriptor!.title).toBe("Finished")

    advance(DOCK_FINISHED_LINGER_MS + DOCK_FINISHED_EXIT_MS)
    expect(descriptor).toBeNull()

    // The 5 s poll and `data-task-update` keep listing it for ten minutes.
    act(() => {
      panel.rerender(
        <RunningDockPanel
          processes={[{ ...done }]}
          onKillProcess={() => {}}
          subagents={[]}
          recentTools={[]}
        />,
      )
    })
    expect(descriptor).toBeNull()
    advance(10_000)
    expect(descriptor).toBeNull()

    jest.useRealTimers()
  })

  test("running rows and stale rows are never retired", () => {
    jest.useFakeTimers()
    lastNow = Date.now()
    const t0 = lastNow
    renderPanel({
      processes: [
        task({ id: "t_run", command: "bun dev", startedAt: t0 - 60_000 }),
        task({ id: "t_stale", command: "lost build", stale: true, startedAt: t0 - 60_000 }),
      ],
    })
    advance(DOCK_FINISHED_LINGER_MS * 5)
    expect(descriptor!.title).toBe("Running")
    expect(descriptor!.summary).toBe("2 running")
    const view = body()
    expect(view.getByText("bun dev")).toBeTruthy()
    expect(view.getByText("lost build")).toBeTruthy()
    expect(view.getByText("unverified")).toBeTruthy()
    expect(view.getAllByText("Kill")).toHaveLength(1)

    jest.useRealTimers()
  })

  test("pressing a linked task row opens its thread with the link it carries", () => {
    const opened: RunningProcess[] = []
    const link = {
      kind: "channel_thread" as const,
      conversationId: "c-1",
      threadRootId: "m-1",
    }
    renderPanel({
      processes: [task({ id: "t_ar", source: "agent_reply", title: "@Ops reply", link })],
      onOpenTask: (proc) => { opened.push(proc) },
    })
    const view = body()
    fireEvent.click(view.getByRole("button", { name: "@Ops reply" }))
    expect(opened).toHaveLength(1)
    expect(opened[0]!.id).toBe("t_ar")
    expect(opened[0]!.link).toEqual(link)
  })

  test("a shell row with nothing written yet says No output yet instead of blank", async () => {
    renderPanel({
      processes: [task({ id: "t_shell", command: "sleep 300", source: "shell" })],
      loadOutput: async (id) => ({ taskId: id, output: "" }),
    })
    const view = body()
    fireEvent.click(view.getByText("Output"))
    await waitFor(() => expect(view.getByText("No output yet")).toBeTruthy())
  })

  test("a finished row still opens its thread and keeps no Cancel", () => {
    const opened: RunningProcess[] = []
    renderPanel({
      processes: [
        task({
          id: "t_done",
          source: "work_item",
          title: "SUP-12 Fix login",
          status: "completed",
          finishedAt: lastNow - 1_000,
          link: {
            kind: "card",
            conversationId: "c-1",
            threadRootId: "m-1",
            itemId: "i-1",
            itemKey: "SUP-12",
            board: "Support",
          },
        }),
      ],
      onOpenTask: (proc) => { opened.push(proc) },
    })
    const view = body()
    expect(view.queryByText("Cancel")).toBeNull()
    fireEvent.click(view.getByRole("button", { name: "SUP-12 Fix login" }))
    expect(opened).toHaveLength(1)
    expect(opened[0]!.link?.kind).toBe("card")
  })
})
