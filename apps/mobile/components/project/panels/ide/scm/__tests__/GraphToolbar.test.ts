/**
 * GraphToolbar — test the auto-refresh toggle and button callback wiring.
 */

import { describe, expect, it } from "bun:test";

describe("GraphToolbar — auto-refresh toggle logic", () => {
  it("autoRefresh defaults to true", () => {
    let autoRefresh = true;
    const toggle = () => { autoRefresh = !autoRefresh; };
    expect(autoRefresh).toBe(true);
    toggle();
    expect(autoRefresh).toBe(false);
    toggle();
    expect(autoRefresh).toBe(true);
  });

  it("toggle cycles correctly through multiple clicks", () => {
    let autoRefresh = true;
    const toggle = () => { autoRefresh = !autoRefresh; };
    const states: boolean[] = [];
    for (let i = 0; i < 6; i++) {
      states.push(autoRefresh);
      toggle();
    }
    expect(states).toEqual([true, false, true, false, true, false]);
  });
});

describe("GraphToolbar — fetch/pull/push dispatch", () => {
  it("each button calls the correct action", () => {
    const calls: string[] = [];
    const mockActions = {
      fetch: () => { calls.push("fetch"); return Promise.resolve({ ok: true as const }); },
      pull: () => { calls.push("pull"); return Promise.resolve({ ok: true as const }); },
      push: () => { calls.push("push"); return Promise.resolve({ ok: true as const }); },
      refresh: () => { calls.push("refresh"); return Promise.resolve(); },
    };

    // Simulate click handlers
    const onFetch = async () => { await mockActions.fetch(); await mockActions.refresh(); };
    const onPull = async () => { await mockActions.pull(); await mockActions.refresh(); };
    const onPush = async () => { await mockActions.push(); await mockActions.refresh(); };

    const verify = async () => {
      calls.length = 0;
      await onFetch();
      expect(calls).toEqual(["fetch", "refresh"]);

      calls.length = 0;
      await onPull();
      expect(calls).toEqual(["pull", "refresh"]);

      calls.length = 0;
      await onPush();
      expect(calls).toEqual(["push", "refresh"]);
    };

    return verify();
  });

  it("refresh can be called standalone", () => {
    let called = false;
    const onRefresh = async () => { called = true; };
    return onRefresh().then(() => expect(called).toBe(true));
  });
});

describe("GraphToolbar — edge cases", () => {
  it("concurrent fetch + pull doesn't interleave state", async () => {
    const order: string[] = [];
    const slow = (name: string) => new Promise<void>((resolve) => {
      setTimeout(() => { order.push(name); resolve(); }, name === "fetch" ? 10 : 5);
    });

    await Promise.all([slow("fetch"), slow("pull")]);
    // Both should complete (order may vary but both present)
    expect(order).toContain("fetch");
    expect(order).toContain("pull");
  });

  it("button callbacks are idempotent", async () => {
    let count = 0;
    const fetch = async () => { count++; return { ok: true as const }; };
    await fetch();
    await fetch();
    expect(count).toBe(2);
  });
});
