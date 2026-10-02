import { describe, expect, test } from "bun:test";
import { buildPathFilter, compileGlobList } from "../glob";

describe("compileGlobList", () => {
  test("empty means no constraint", () => {
    expect(compileGlobList("")).toBeNull();
    expect(compileGlobList("  , ")).toBeNull();
  });
  test("basename globs match at any depth", () => {
    const m = compileGlobList("*.ts")!;
    expect(m("a.ts")).toBe(true);
    expect(m("src/deep/a.ts")).toBe(true);
    expect(m("src/a.tsx")).toBe(false);
  });
  test("braces keep their commas", () => {
    const m = compileGlobList("*.{ts,tsx}, README.md")!;
    expect(m("x/a.tsx")).toBe(true);
    expect(m("x/a.js")).toBe(false);
    expect(m("README.md")).toBe(true);
  });
  test("slash patterns are anchored to the root", () => {
    const m = compileGlobList("src/**/*.test.ts")!;
    expect(m("src/a.test.ts")).toBe(true);
    expect(m("src/x/y/a.test.ts")).toBe(true);
    expect(m("lib/src/a.test.ts")).toBe(false);
  });
  test("plain folder includes everything under it", () => {
    const m = compileGlobList("apps/web")!;
    expect(m("apps/web/index.ts")).toBe(true);
    expect(m("apps/webby/index.ts")).toBe(false);
    const bare = compileGlobList("node_modules")!;
    expect(bare("a/node_modules/x/y.js")).toBe(true);
  });
});

describe("buildPathFilter", () => {
  test("include AND NOT exclude", () => {
    const f = buildPathFilter("src", "**/*.test.ts")!;
    expect(f("src/a.ts")).toBe(true);
    expect(f("src/a.test.ts")).toBe(false);
    expect(f("lib/a.ts")).toBe(false);
  });
  test("null when both empty", () => {
    expect(buildPathFilter("", undefined)).toBeNull();
  });
});
