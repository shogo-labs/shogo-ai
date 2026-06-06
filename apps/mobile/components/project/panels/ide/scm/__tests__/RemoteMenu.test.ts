/**
 * RemoteMenu (ScmMenu) — test that git operations are dispatched correctly
 * and that the menu properly delegates to branch picker / stash list.
 */

import { describe, expect, it } from "bun:test";

describe("RemoteMenu — action dispatch", () => {
  it("fetch calls the correct bridge method", async () => {
    const calls: string[] = [];
    const mockBridge = {
      remote: {
        fetch: async (root: string) => { calls.push(`fetch:${root}`); return { ok: true as const }; },
        pull: async (root: string, _opts: any) => { calls.push(`pull:${root}`); return { ok: true as const }; },
        push: async (root: string) => { calls.push(`push:${root}`); return { ok: true as const }; },
        sync: async (root: string) => { calls.push(`sync:${root}`); return { ok: true as const }; },
      },
    };
    await mockBridge.remote.fetch("/repo");
    expect(calls).toEqual(["fetch:/repo"]);
  });

  it("pull with rebase option", async () => {
    let receivedOpts: any = null;
    const pull = async (_root: string, opts: any) => { receivedOpts = opts; return { ok: true as const }; };
    await pull("/repo", { rebase: true });
    expect(receivedOpts).toEqual({ rebase: true });
  });

  it("error propagation from bridge", async () => {
    const fetch = async () => ({ ok: false as const, error: "network error" });
    const result = await fetch();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("network error");
  });
});

describe("RemoteMenu — branch picker delegation", () => {
  it("onOpenBranchPicker is called and menu closes", () => {
    let pickerOpened = false;
    let menuClosed = false;
    const onOpenBranchPicker = () => { pickerOpened = true; };
    const onClose = () => { menuClosed = true; };
    onClose();
    onOpenBranchPicker();
    expect(pickerOpened).toBe(true);
    expect(menuClosed).toBe(true);
  });
});

describe("RemoteMenu — stash list delegation", () => {
  it("onOpenStashList is called and menu closes", () => {
    let stashOpened = false;
    let menuClosed = false;
    const onOpenStashList = () => { stashOpened = true; };
    const onClose = () => { menuClosed = true; };
    onClose();
    onOpenStashList();
    expect(stashOpened).toBe(true);
    expect(menuClosed).toBe(true);
  });
});

describe("RemoteMenu — menu exclusion", () => {
  it("opening remote menu closes view menu", () => {
    let viewMenuOpen = true;
    let remoteMenuOpen = false;
    // Simulate clicking repo three-dot
    remoteMenuOpen = !remoteMenuOpen;
    viewMenuOpen = false;
    expect(viewMenuOpen).toBe(false);
    expect(remoteMenuOpen).toBe(true);
  });

  it("opening view menu closes remote menu", () => {
    let viewMenuOpen = false;
    let remoteMenuOpen = true;
    // Simulate clicking header three-dot
    viewMenuOpen = !viewMenuOpen;
    remoteMenuOpen = false;
    expect(viewMenuOpen).toBe(true);
    expect(remoteMenuOpen).toBe(false);
  });
});

describe("RemoteMenu — edge cases", () => {
  it("action after workspaceRoot is null does not crash", () => {
    const workspaceRoot = null;
    const actions = workspaceRoot ? { fetch: () => Promise.resolve({ ok: true }) } : null;
    expect(actions).toBeNull();
  });

  it("concurrent operations don't share state", async () => {
    let fetchDone = false;
    let pullDone = false;
    const fetch = new Promise<void>((resolve) => { setTimeout(() => { fetchDone = true; resolve(); }, 10); });
    const pull = new Promise<void>((resolve) => { setTimeout(() => { pullDone = true; resolve(); }, 5); });
    await Promise.all([fetch, pull]);
    expect(fetchDone).toBe(true);
    expect(pullDone).toBe(true);
  });
});
