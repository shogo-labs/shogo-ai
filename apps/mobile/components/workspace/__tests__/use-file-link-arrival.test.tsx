// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A shared file link opens its file once, in the workspace it names — and the
 * URL keeps `?file=`/`?workspace=` until the pane closes, because dropping them
 * on open remounts the screen on web and takes the pane with it (SHO-284).
 */
import { afterEach, describe, expect, mock, test } from "bun:test"
import React from "react"

const { cleanup, render, waitFor } = await import("@testing-library/react")
const { useFileLinkArrival } = await import("../use-file-link-arrival")

afterEach(() => {
  cleanup()
})

interface ProbeProps {
  initialFilePath?: string | null
  linkWorkspaceId?: string | null
  workspaceId?: string | null
  memberWorkspaceIds?: readonly string[] | null
  openFilePane: (path: string) => void
  adoptWorkspace?: (id: string) => void
  setParams?: (params: { file: undefined; workspace: undefined }) => void
}

function Probe({
  initialFilePath = null,
  linkWorkspaceId = null,
  workspaceId = "ws-1",
  memberWorkspaceIds = ["ws-1"],
  openFilePane,
  adoptWorkspace = () => {},
  setParams = () => {},
}: ProbeProps) {
  const { error, dropLinkParams } = useFileLinkArrival({
    initialFilePath,
    linkWorkspaceId,
    workspaceId,
    memberWorkspaceIds,
    openFilePane,
    adoptWorkspace,
    setParams,
  })
  return (
    <div>
      <span data-testid="error">{error ?? ""}</span>
      <button data-testid="close-pane" onClick={dropLinkParams} />
    </div>
  )
}

describe("useFileLinkArrival", () => {
  test("opens the linked file and leaves the params in the URL", async () => {
    const opened: string[] = []
    const writes: Array<Record<string, unknown>> = []
    const { getByTestId } = render(
      <Probe
        initialFilePath="proj-7/notes/plan.md"
        linkWorkspaceId="ws-1"
        openFilePane={(path) => opened.push(path)}
        setParams={(params) => writes.push(params)}
      />,
    )

    await waitFor(() => expect(opened).toEqual(["proj-7/notes/plan.md"]))
    // Opening must not write the URL: on web that remounts the screen and the
    // pane it just opened goes with the old instance.
    expect(writes).toEqual([])

    getByTestId("close-pane").click()
    expect(writes).toEqual([{ file: undefined, workspace: undefined }])
  })

  test("opens once, however often the screen re-renders", async () => {
    const opened: string[] = []
    const { rerender } = render(
      <Probe initialFilePath="notes/plan.md" openFilePane={(path) => opened.push(path)} />,
    )

    await waitFor(() => expect(opened.length).toBe(1))
    rerender(<Probe initialFilePath="notes/plan.md" openFilePane={(path) => opened.push(path)} />)
    rerender(<Probe initialFilePath="notes/plan.md" openFilePane={(path) => opened.push(path)} />)

    expect(opened.length).toBe(1)
  })

  test("a link naming another workspace this account is in switches to it, then opens the file", async () => {
    const adopted: string[] = []
    const opened: string[] = []
    const props = {
      initialFilePath: "notes/plan.md",
      linkWorkspaceId: "ws-2",
      memberWorkspaceIds: ["ws-1", "ws-2"] as readonly string[],
      openFilePane: (path: string) => opened.push(path),
      adoptWorkspace: (id: string) => adopted.push(id),
    }
    const { rerender } = render(<Probe {...props} workspaceId="ws-1" />)

    await waitFor(() => expect(adopted).toEqual(["ws-2"]))
    expect(opened).toEqual([])

    // The switch lands: the workspace in view is the one the link named now.
    rerender(<Probe {...props} workspaceId="ws-2" />)
    await waitFor(() => expect(opened).toEqual(["notes/plan.md"]))
    expect(adopted).toEqual(["ws-2"])
  })

  test("a link to a workspace this account cannot see says so and moves nothing", async () => {
    const adopted: string[] = []
    const opened: string[] = []
    const { getByTestId } = render(
      <Probe
        initialFilePath="notes/plan.md"
        linkWorkspaceId="ws-9"
        memberWorkspaceIds={["ws-1"]}
        openFilePane={(path) => opened.push(path)}
        adoptWorkspace={(id) => adopted.push(id)}
      />,
    )

    await waitFor(() =>
      expect(getByTestId("error").textContent).toBe("You don't have access to this workspace."),
    )
    expect(adopted).toEqual([])
    expect(opened).toEqual([])
  })

  test("waits for the workspace list before deciding membership", async () => {
    const adopted: string[] = []
    const opened: string[] = []
    const props = {
      initialFilePath: "notes/plan.md",
      linkWorkspaceId: "ws-2",
      openFilePane: (path: string) => opened.push(path),
      adoptWorkspace: (id: string) => adopted.push(id),
    }
    const { rerender } = render(<Probe {...props} memberWorkspaceIds={null} />)

    expect(adopted).toEqual([])
    expect(opened).toEqual([])

    rerender(<Probe {...props} memberWorkspaceIds={["ws-1", "ws-2"]} />)
    await waitFor(() => expect(adopted).toEqual(["ws-2"]))
    expect(opened).toEqual([])
  })
})
