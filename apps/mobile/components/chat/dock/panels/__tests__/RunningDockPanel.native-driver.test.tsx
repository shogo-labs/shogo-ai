// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * The dock row is the one place in `apps/mobile` where a `@legendapp/motion`
 * value changes driver: a shown row animates opacity only, which is native,
 * and its exit adds height, which is JS. Starting a JS animation on a value a
 * native one already moved to the native side throws on device and killed the
 * app (SHO-290, SHOGO-IOS-K / SHOGO-ANDROID-15).
 *
 * The inert `Animated` mock the other dock tests use cannot see that, so this
 * file runs the real `@legendapp/motion` against `createStrictAnimated()`,
 * which reproduces RN's `__isNative` rule and records every violation.
 */

import { resolve } from "node:path"
import { beforeEach, describe, expect, jest, mock, test } from "bun:test"
import { act, fireEvent, render, waitFor } from "@testing-library/react"
import { createElement } from "react"
import type { DockPanelDescriptor } from "../../../../../lib/chat-dock-store"
import type { RunningProcess } from "../../../../../ProcessPanel"
import { createReactNativeMock, createStrictAnimated } from "../../../../../test/react-native-mock"
import { DOCK_FINISHED_EXIT_MS, DOCK_FINISHED_LINGER_MS } from "../../finished-rows"

const strict = createStrictAnimated()

mock.module("react-native", () =>
  createReactNativeMock({
    Animated: strict.Animated,
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

function renderPanel(props: Partial<React.ComponentProps<typeof RunningDockPanel>>) {
  descriptor = null
  bodyRoot = null
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
 * linger -> exit chain is exactly that. `requestAnimationFrame` is a timer
 * here too, so this also flushes the frame `@legendapp/motion` starts its
 * animation on.
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

beforeEach(() => {
  strict.violations.length = 0
})

describe("strict Animated guard", () => {
  test("records a JS animation started on a value a native one already moved", () => {
    // The rule the inert mock drops, and the one that killed the app: a value
    // animated with `useNativeDriver: true` cannot later be animated from JS.
    const value = new strict.Animated.Value(1)
    strict.Animated.timing(value, { toValue: 0, useNativeDriver: true }).start()
    expect(strict.violations).toHaveLength(0)

    strict.Animated.timing(value, { toValue: 0, useNativeDriver: false }).start()
    expect(strict.violations).toHaveLength(1)
  })
})

describe("RunningDockPanel row driver", () => {
  test("a row that finishes, is pinned back open and exits again never switches driver", async () => {
    jest.useFakeTimers()
    lastNow = Date.now()
    const t0 = lastNow
    renderPanel({
      processes: [task({ id: "t_done", command: "bun test", status: "completed", startedAt: t0 - 10_000, finishedAt: t0 })],
      loadOutput: async (id) => ({ taskId: id, output: "3 pass" }),
    })
    const view = body()
    expect(view.getByText("completed")).toBeTruthy()

    // Shown: opacity only, so the value moves to the native side.
    advance(50)
    body()
    expect(strict.violations).toHaveLength(0)

    // Exit: opacity + height. On origin/main this is the crash.
    advance(DOCK_FINISHED_LINGER_MS)
    body()
    advance(100)
    body()
    expect(strict.violations).toHaveLength(0)

    // Pinned back open from inside the exit, then closed and exited again.
    await act(async () => {
      fireEvent.click(view.getByText("Output"))
    })
    await waitFor(() => expect(view.getByText(/3 pass/)).toBeTruthy())
    advance(100)
    body()
    expect(strict.violations).toHaveLength(0)

    await act(async () => {
      fireEvent.click(view.getByText("Hide"))
    })
    advance(DOCK_FINISHED_EXIT_MS + 500)
    body()
    expect(strict.violations).toHaveLength(0)
    expect(body().queryByText("completed")).toBeNull()

    jest.useRealTimers()
  })
})
