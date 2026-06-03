/**
 * symbol-cache — BUG-010 contract lockdown.
 *
 * The cache IS the rule. Every property the LSP wiring depends on
 * (URI-only is not enough; version invalidation; structural
 * impossibility of stale-after-edit hits; LRU eviction; lifecycle
 * teardown) is pinned by one test below. A regression failure name
 * maps directly to the BUG-010 sub-hazard that reopened.
 */
import { describe, expect, test } from "bun:test";
import { SymbolCache } from "../symbol-cache";

const uri = (n: number) => `inmemory://model/${n}`;

describe("SymbolCache — basic hit/miss", () => {
  test("miss on never-cached uri", () => {
    const c = new SymbolCache<string[]>();
    expect(c.get({ uri: uri(1), versionId: 1 })).toBeUndefined();
  });

  test("hit on same (uri, version) after set", () => {
    const c = new SymbolCache<string[]>();
    c.set({ uri: uri(1), versionId: 1 }, ["foo", "bar"]);
    expect(c.get({ uri: uri(1), versionId: 1 })).toEqual(["foo", "bar"]);
  });

  test("returns the SAME reference on a hit (no clone)", () => {
    const c = new SymbolCache<{ x: number }>();
    const v = { x: 1 };
    c.set({ uri: uri(1), versionId: 1 }, v);
    expect(c.get({ uri: uri(1), versionId: 1 })).toBe(v);
  });
});

describe("SymbolCache — version invalidation (THE BUG-010 fix)", () => {
  test("MISS on same uri at DIFFERENT version (edit happened)", () => {
    const c = new SymbolCache<string[]>();
    c.set({ uri: uri(1), versionId: 5 }, ["before-edit"]);
    expect(c.get({ uri: uri(1), versionId: 6 })).toBeUndefined();
  });

  test("storing a new version of the same uri DROPS the prior version", () => {
    const c = new SymbolCache<string[]>();
    c.set({ uri: uri(1), versionId: 5 }, ["v5"]);
    c.set({ uri: uri(1), versionId: 6 }, ["v6"]);
    // The OLD version is no longer reachable — stale hit is structurally
    // impossible. This is BUG-010's "URI-only key isn't enough" property.
    expect(c.get({ uri: uri(1), versionId: 5 })).toBeUndefined();
    expect(c.get({ uri: uri(1), versionId: 6 })).toEqual(["v6"]);
  });

  test("at most one versionId per uri is live at any time", () => {
    const c = new SymbolCache<string[]>();
    for (let v = 1; v <= 20; v++) {
      c.set({ uri: uri(1), versionId: v }, [`v${v}`]);
    }
    // Only v20 reachable; v1..v19 all dropped.
    for (let v = 1; v < 20; v++) {
      expect(c.get({ uri: uri(1), versionId: v })).toBeUndefined();
    }
    expect(c.get({ uri: uri(1), versionId: 20 })).toEqual(["v20"]);
    // And only one entry in the cache despite 20 sets.
    expect(c.size()).toBe(1);
  });

  test("simulated rename: new uri at version 1 does NOT collide with old uri", () => {
    const c = new SymbolCache<string[]>();
    c.set({ uri: uri(1), versionId: 7 }, ["old-name"]);
    c.set({ uri: uri(2), versionId: 1 }, ["new-name"]);
    expect(c.get({ uri: uri(1), versionId: 7 })).toEqual(["old-name"]);
    expect(c.get({ uri: uri(2), versionId: 1 })).toEqual(["new-name"]);
  });
});

describe("SymbolCache — explicit invalidation + clear", () => {
  test("invalidate(uri) drops every entry for that uri", () => {
    const c = new SymbolCache<string[]>();
    c.set({ uri: uri(1), versionId: 1 }, ["a"]);
    c.set({ uri: uri(2), versionId: 1 }, ["b"]);
    c.invalidate(uri(1));
    expect(c.get({ uri: uri(1), versionId: 1 })).toBeUndefined();
    expect(c.get({ uri: uri(2), versionId: 1 })).toEqual(["b"]); // unaffected
  });

  test("invalidate(non-existent uri) is a no-op (safe)", () => {
    const c = new SymbolCache<string[]>();
    expect(() => c.invalidate("nope")).not.toThrow();
  });

  test("clear() empties everything", () => {
    const c = new SymbolCache<string[]>();
    c.set({ uri: uri(1), versionId: 1 }, ["a"]);
    c.set({ uri: uri(2), versionId: 1 }, ["b"]);
    c.clear();
    expect(c.size()).toBe(0);
    expect(c.get({ uri: uri(1), versionId: 1 })).toBeUndefined();
  });
});

describe("SymbolCache — LRU eviction", () => {
  test("evicts the least-recently-used uri when over cap", () => {
    const c = new SymbolCache<string>(3);
    c.set({ uri: uri(1), versionId: 1 }, "1");
    c.set({ uri: uri(2), versionId: 1 }, "2");
    c.set({ uri: uri(3), versionId: 1 }, "3");
    // Touch uri(1) so uri(2) becomes the LRU.
    c.get({ uri: uri(1), versionId: 1 });
    c.set({ uri: uri(4), versionId: 1 }, "4");
    expect(c.size()).toBe(3);
    expect(c.get({ uri: uri(2), versionId: 1 })).toBeUndefined(); // evicted
    expect(c.get({ uri: uri(1), versionId: 1 })).toBe("1");       // kept (touched)
    expect(c.get({ uri: uri(3), versionId: 1 })).toBe("3");
    expect(c.get({ uri: uri(4), versionId: 1 })).toBe("4");
  });

  test("get() refreshes LRU recency (touched entries stay alive)", () => {
    const c = new SymbolCache<string>(2);
    c.set({ uri: uri(1), versionId: 1 }, "1");
    c.set({ uri: uri(2), versionId: 1 }, "2");
    // Read uri(1) so uri(2) becomes the LRU.
    c.get({ uri: uri(1), versionId: 1 });
    c.set({ uri: uri(3), versionId: 1 }, "3");
    expect(c.get({ uri: uri(1), versionId: 1 })).toBe("1"); // still alive
    expect(c.get({ uri: uri(2), versionId: 1 })).toBeUndefined();
  });

  test("cap = 1 keeps only the most recent set", () => {
    const c = new SymbolCache<string>(1);
    c.set({ uri: uri(1), versionId: 1 }, "1");
    c.set({ uri: uri(2), versionId: 1 }, "2");
    expect(c.size()).toBe(1);
    expect(c.get({ uri: uri(1), versionId: 1 })).toBeUndefined();
    expect(c.get({ uri: uri(2), versionId: 1 })).toBe("2");
  });

  test("constructor throws on cap < 1", () => {
    expect(() => new SymbolCache(0)).toThrow();
    expect(() => new SymbolCache(-1)).toThrow();
  });
});

describe("SymbolCache — observability", () => {
  test("size() reflects unique URIs (not unique versions, since at most one per URI)", () => {
    const c = new SymbolCache<string>();
    expect(c.size()).toBe(0);
    c.set({ uri: uri(1), versionId: 1 }, "a");
    expect(c.size()).toBe(1);
    c.set({ uri: uri(1), versionId: 2 }, "b"); // new version, same URI
    expect(c.size()).toBe(1);
    c.set({ uri: uri(2), versionId: 1 }, "c");
    expect(c.size()).toBe(2);
  });
});

describe("SymbolCache — BUG-010 canonical scenarios", () => {
  test("rename function in source: post-edit breadcrumbs MUST miss the cache", () => {
    // T0: user opens file. Cache stores symbols at v=1.
    const c = new SymbolCache<string[]>();
    c.set({ uri: uri(1), versionId: 1 }, ["oldName"]);
    expect(c.get({ uri: uri(1), versionId: 1 })).toEqual(["oldName"]);

    // T+10s: user renames `oldName` → `newName`. Monaco bumps the version.
    // The breadcrumb provider re-queries at v=2 — MUST be a miss so the
    // LSP gets re-asked. (URI-only caching would return ['oldName'] here.)
    expect(c.get({ uri: uri(1), versionId: 2 })).toBeUndefined();

    // Provider fetches, stores the fresh result. Old entry gone.
    c.set({ uri: uri(1), versionId: 2 }, ["newName"]);
    expect(c.get({ uri: uri(1), versionId: 1 })).toBeUndefined();
    expect(c.get({ uri: uri(1), versionId: 2 })).toEqual(["newName"]);
  });

  test("rapid typing: each keystroke version misses, then hits while idle", () => {
    const c = new SymbolCache<string>(64);
    // Simulate typing 5 chars. Each keystroke bumps the version.
    for (let v = 1; v <= 5; v++) {
      expect(c.get({ uri: uri(1), versionId: v })).toBeUndefined();
      c.set({ uri: uri(1), versionId: v }, `at-v${v}`);
    }
    // User stops typing. Subsequent breadcrumb queries at v=5 all HIT.
    expect(c.get({ uri: uri(1), versionId: 5 })).toBe("at-v5");
    expect(c.get({ uri: uri(1), versionId: 5 })).toBe("at-v5");
    expect(c.get({ uri: uri(1), versionId: 5 })).toBe("at-v5");
    // Only the latest version is reachable; size stays 1 throughout.
    expect(c.size()).toBe(1);
  });
});
