// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { resolve } from "node:path"
import { describe, expect, mock, test } from "bun:test"
import { fireEvent, render, waitFor } from "@testing-library/react"
import { createElement } from "react"
import type { DockPanelDescriptor } from "../../../../../lib/chat-dock-store"
import type { RunningProcess } from "../../../ProcessPanel"
import { createReactNativeMock } from "../../../../../test/react-native-mock"

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

const now = Date.now()

function task(overrides: Partial<RunningProcess>): RunningProcess {
  return {
    runId: overrides.id ?? "t_1",
    id: overrides.id ?? "t_1",
    command: "",
    pid: 0,
    startedAt: now - 5_000,
    elapsedMs: 5_000,
    status: "running",
    ...overrides,
  } as RunningProcess
}

function renderPanel(props: Partial<React.ComponentProps<typeof RunningDockPanel>>) {
  descriptor = null
  render(
    <RunningDockPanel
      processes={[]}
      onKillProcess={() => {}}
      subagents={[]}
      recentTools={[]}
      {...props}
    />,
  )
  return descriptor
}

function body() {
  if (!descriptor) throw new Error("no dock panel registered")
  return render(<>{descriptor.render()}</>)
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
      waiting: { taskIds: ["t_dev"], until: "ready", timeoutMs: 60_000, startedAt: now - 3_000 },
    })
    expect(d!.title).toBe("Waiting")
    expect(d!.summary).toBe("agent waiting · 2 running")

    const view = body()
    expect(view.getByText(/Agent is waiting on a task/)).toBeTruthy()
    expect(view.getByText(/until "ready"/)).toBeTruthy()
    expect(view.getAllByText("waiting")).toHaveLength(1)
  })

  test("a wait with no tasks still shows the agent is paused", () => {
    const d = renderPanel({ waiting: { taskIds: [], timeoutMs: 5_000, startedAt: now } })
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

  test("Output loads the task's latest output inline", async () => {
    const loaded: string[] = []
    renderPanel({
      processes: [task({ id: "t_log", command: "bun test" })],
      loadOutput: async (id) => {
        loaded.push(id)
        return "line 1\n3 pass\n0 fail"
      },
    })
    const view = body()
    fireEvent.click(view.getByText("Output"))
    await waitFor(() => expect(view.getByText(/3 pass/)).toBeTruthy())
    expect(loaded).toEqual(["t_log"])
    fireEvent.click(view.getByText("Hide"))
    expect(view.queryByText(/3 pass/)).toBeNull()
  })

  test("a finished task keeps its row: outcome, frozen duration, no Cancel, Output still works", async () => {
    const killed: string[] = []
    const loaded: string[] = []
    const d = renderPanel({
      processes: [
        task({ id: "t_run", command: "bun dev", source: "shell", notify: true }),
        task({
          id: "t_done",
          command: "bun test",
          source: "shell",
          status: "completed",
          startedAt: now - 121_000,
          finishedAt: now - 1_000,
          elapsedMs: 120_000,
          notify: true,
        }),
      ],
      agentIdle: true,
      onKillProcess: (id) => { killed.push(id) },
      loadOutput: async (id) => {
        loaded.push(id)
        return "3 pass\n0 fail"
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

    fireEvent.click(view.getAllByText("Output")[1]!)
    await waitFor(() => expect(view.getByText(/3 pass/)).toBeTruthy())
    expect(loaded).toEqual(["t_done"])
    expect(killed).toEqual([])
  })

  test("with only finished rows the chip stays and says so", () => {
    const d = renderPanel({
      processes: [
        task({ id: "t_a", title: "explore", source: "subagent", status: "completed", finishedAt: now - 2_000 }),
        task({ id: "t_b", command: "bun test", status: "failed", finishedAt: now - 5_000 }),
      ],
    })
    expect(d!.title).toBe("Finished")
    expect(d!.summary).toBe("2 finished")
    const view = body()
    expect(view.getByText("completed")).toBeTruthy()
    expect(view.getByText("failed")).toBeTruthy()
    expect(view.queryByText("Kill")).toBeNull()
    expect(view.queryByText("Cancel")).toBeNull()
  })
})
