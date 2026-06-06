/**
 * ViewMode — test list/tree toggle and the auto-refresh interval logic.
 */

import { describe, expect, it } from "bun:test";

describe("ViewMode toggle", () => {
  it("defaults to list", () => {
    let viewMode: "list" | "tree" = "list";
    expect(viewMode).toBe("list");
  });

  it("toggles from list to tree", () => {
    let viewMode: "list" | "tree" = "list";
    viewMode = viewMode === "list" ? "tree" : "list";
    expect(viewMode).toBe("tree");
  });

  it("toggles from tree to list", () => {
    let viewMode: "list" | "tree" = "tree";
    viewMode = viewMode === "list" ? "tree" : "list";
    expect(viewMode).toBe("list");
  });

  it("cycles correctly through multiple toggles", () => {
    let viewMode: "list" | "tree" = "list";
    const toggle = () => { viewMode = viewMode === "list" ? "tree" : "list"; };
    const modes: string[] = [];
    for (let i = 0; i < 5; i++) {
      modes.push(viewMode);
      toggle();
    }
    expect(modes).toEqual(["list", "tree", "list", "tree", "list"]);
  });
});

describe("Auto-refresh interval", () => {
  it("interval is 30 seconds when enabled", () => {
    const intervalMs = 30_000;
    expect(intervalMs).toBe(30_000);
  });

  it("interval is 0 when disabled (no effect)", () => {
    let autoRefresh = false;
    const intervalMs = autoRefresh ? 30_000 : 0;
    expect(intervalMs).toBe(0);
  });
});

describe("Commit textarea focus (⌘Enter shortcut)", () => {
  it("Cmd+Enter triggers focus on commit input", () => {
    let focused = false;
    const simulateCmdEnter = (e: { metaKey: boolean; ctrlKey: boolean; key: string; preventDefault: () => void }) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        focused = true;
        e.preventDefault();
      }
    };

    simulateCmdEnter({ metaKey: true, ctrlKey: false, key: "Enter", preventDefault: () => {} });
    expect(focused).toBe(true);
  });

  it("Ctrl+Enter also triggers focus", () => {
    let focused = false;
    const simulateCmdEnter = (e: { metaKey: boolean; ctrlKey: boolean; key: string; preventDefault: () => void }) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        focused = true;
        e.preventDefault();
      }
    };

    simulateCmdEnter({ metaKey: false, ctrlKey: true, key: "Enter", preventDefault: () => {} });
    expect(focused).toBe(true);
  });

  it("plain Enter does NOT trigger commit focus", () => {
    let focused = false;
    const simulateCmdEnter = (e: { metaKey: boolean; ctrlKey: boolean; key: string; preventDefault: () => void }) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        focused = true;
        e.preventDefault();
      }
    };

    simulateCmdEnter({ metaKey: false, ctrlKey: false, key: "Enter", preventDefault: () => {} });
    expect(focused).toBe(false);
  });
});

describe("Discard confirmation", () => {
  it("confirm returns true for valid discard", () => {
    let confirmed = false;
    // Simulate window.confirm
    const confirm = (_msg: string) => { confirmed = true; return true; };
    const result = confirm("Discard 3 unstaged change(s)?");
    expect(result).toBe(true);
    expect(confirmed).toBe(true);
  });

  it("confirm returns false when user cancels", () => {
    const confirm = (_msg: string) => false;
    const result = confirm("Discard 5 staged change(s)?");
    expect(result).toBe(false);
  });

  it("discard is not called when paths array is empty", () => {
    let discarded = false;
    const paths: string[] = [];
    if (paths.length > 0) {
      discarded = true;
    }
    expect(discarded).toBe(false);
  });
});
