// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * "Open folder" from a personal workspace: the API creates the project in the
 * team workspace (personal workspaces give the agent no shell) and the hook
 * must switch to that workspace instead of running the caller's
 * same-workspace follow-up.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";

const push = mock((_href: unknown) => {});
const openInWorkspace = mock(
  (_router: unknown, _workspaceId: unknown, _path: unknown, _current: unknown) => {},
);
let apiResponse: Record<string, unknown> = {};

mock.module("expo-router", () => ({ useRouter: () => ({ push }) }));
mock.module("../../../contexts/domain", () => ({ useDomainHttp: () => ({}) }));
mock.module("../../../lib/api", () => ({
  api: { createLocalFolderProject: async () => apiResponse },
}));
mock.module("../../../lib/switch-workspace", () => ({ openInWorkspace }));

const { useOpenLocalFolder } = await import("../useOpenLocalFolder");

beforeEach(() => {
  push.mockClear();
  openInWorkspace.mockClear();
  (window as any).shogoDesktop = {
    pickFolders: async () => ({ ok: true, paths: ["/Users/me/git/repo"] }),
  };
});

afterEach(() => {
  cleanup();
  delete (window as any).shogoDesktop;
});

async function openFrom(workspaceId: string, onSuccess?: (p: { id: string; name: string }) => void) {
  const { result } = renderHook(() => useOpenLocalFolder({ workspaceId, onSuccess }));
  await act(async () => {
    await result.current.openFolder();
  });
}

describe("useOpenLocalFolder", () => {
  test("switches to the team workspace when the API redirected the project there", async () => {
    apiResponse = {
      project: { id: "proj-1", name: "repo", workspaceId: "ws-team" },
      redirectedFromWorkspaceId: "ws-personal",
    };
    const onSuccess = mock(() => {});

    await openFrom("ws-personal", onSuccess);

    expect(openInWorkspace).toHaveBeenCalledTimes(1);
    const [, workspaceId, path, current] = openInWorkspace.mock.calls[0]!;
    expect(workspaceId).toBe("ws-team");
    expect(path).toBe("/(app)/projects/proj-1");
    expect(current).toBe("ws-personal");
    expect(onSuccess).not.toHaveBeenCalled();
  });

  test("hands a same-workspace project to the caller", async () => {
    apiResponse = { project: { id: "proj-2", name: "repo", workspaceId: "ws-team" } };
    const onSuccess = mock((_p: { id: string; name: string }) => {});

    await openFrom("ws-team", onSuccess);

    expect(onSuccess).toHaveBeenCalledWith({ id: "proj-2", name: "repo" });
    expect(openInWorkspace).not.toHaveBeenCalled();
  });
});
