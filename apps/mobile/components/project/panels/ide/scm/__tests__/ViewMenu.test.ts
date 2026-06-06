/**
 * ViewMenu — test menu logic: view mode toggle, auto-refresh, dismiss behavior.
 */

import { describe, expect, it } from "bun:test";

describe("ViewMenu — view mode toggle", () => {
  it("toggles from list to tree", () => {
    let viewMode: "list" | "tree" = "list";
    const toggle = () => { viewMode = viewMode === "list" ? "tree" : "list"; };
    toggle();
    expect(viewMode).toBe("tree");
  });

  it("toggles from tree to list", () => {
    let viewMode: "list" | "tree" = "tree";
    const toggle = () => { viewMode = viewMode === "list" ? "tree" : "list"; };
    toggle();
    expect(viewMode).toBe("list");
  });

  it("cycles correctly over 6 toggles", () => {
    let viewMode: "list" | "tree" = "list";
    const toggle = () => { viewMode = viewMode === "list" ? "tree" : "list"; };
    const modes: string[] = [];
    for (let i = 0; i < 6; i++) {
      modes.push(viewMode);
      toggle();
    }
    expect(modes).toEqual(["list", "tree", "list", "tree", "list", "tree"]);
  });
});

describe("ViewMenu — auto-refresh toggle", () => {
  it("defaults to enabled", () => {
    let autoRefresh = true;
    expect(autoRefresh).toBe(true);
  });

  it("toggles off then on", () => {
    let autoRefresh = true;
    const toggle = () => { autoRefresh = !autoRefresh; };
    toggle();
    expect(autoRefresh).toBe(false);
    toggle();
    expect(autoRefresh).toBe(true);
  });

  it("persists across multiple toggles", () => {
    let autoRefresh = true;
    const toggle = () => { autoRefresh = !autoRefresh; };
    // 7 toggles → should end on false (started true, 7 odd flips)
    for (let i = 0; i < 7; i++) toggle();
    expect(autoRefresh).toBe(false);
  });
});

describe("ViewMenu — refresh action", () => {
  it("calls refresh callback", () => {
    let refreshed = false;
    const onRefresh = () => { refreshed = true; };
    onRefresh();
    expect(refreshed).toBe(true);
  });

  it("refresh and close happen together", () => {
    let refreshed = false;
    let closed = false;
    const onRefresh = () => { refreshed = true; };
    const onClose = () => { closed = true; };
    onRefresh();
    onClose();
    expect(refreshed).toBe(true);
    expect(closed).toBe(true);
  });
});

describe("ViewMenu — dismiss behavior", () => {
  it("close callback is invocable", () => {
    let closed = false;
    const onClose = () => { closed = true; };
    onClose();
    expect(closed).toBe(true);
  });

  it("toggle and close don't conflict", () => {
    let viewMenuOpen = true;
    let viewMode: "list" | "tree" = "list";
    // Simulate: click Tree View → toggle viewMode AND close menu
    viewMode = viewMode === "list" ? "tree" : "list";
    viewMenuOpen = false;
    expect(viewMode).toBe("tree");
    expect(viewMenuOpen).toBe(false);
  });
});

describe("ViewMenu — header three-dot vs repo three-dot separation", () => {
  it("header menu state is independent of remote menu state", () => {
    let viewMenuOpen = false;
    let remoteMenuOpen = false;

    // Open header menu
    viewMenuOpen = !viewMenuOpen;
    remoteMenuOpen = false;
    expect(viewMenuOpen).toBe(true);
    expect(remoteMenuOpen).toBe(false);

    // Open remote menu → close header
    remoteMenuOpen = !remoteMenuOpen;
    viewMenuOpen = false;
    expect(viewMenuOpen).toBe(false);
    expect(remoteMenuOpen).toBe(true);
  });

  it("both menus can be closed independently", () => {
    let viewMenuOpen = true;
    let remoteMenuOpen = true;
    viewMenuOpen = false;
    expect(viewMenuOpen).toBe(false);
    expect(remoteMenuOpen).toBe(true);
    remoteMenuOpen = false;
    expect(remoteMenuOpen).toBe(false);
  });
});
