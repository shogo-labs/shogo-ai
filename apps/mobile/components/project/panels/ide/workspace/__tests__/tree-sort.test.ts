import { describe, expect, test } from "bun:test";
import { compareTreeNodes, sortTree } from "../tree-sort";
import type { WsNode } from "../types";

const f = (name: string): WsNode => ({ name, path: name, kind: "file" });
const d = (name: string, children?: WsNode[]): WsNode => ({ name, path: name, kind: "dir", children });

describe("tree-sort", () => {
  test("folders first, then case-insensitive natural order", () => {
    const sorted = sortTree([
      f("file10.ts"), f("File2.ts"), f("Zeta.md"), f("alpha.md"), f(".env"),
      d("zdir"), d("Adir"), d("bdir"),
    ]);
    expect(sorted.map((n) => n.name)).toEqual([
      "Adir", "bdir", "zdir", ".env", "alpha.md", "File2.ts", "file10.ts", "Zeta.md",
    ]);
  });

  test("sorts loaded children recursively and leaves lazy dirs alone", () => {
    const lazy: WsNode = { name: "node_modules", path: "node_modules", kind: "dir", lazy: true };
    const sorted = sortTree([d("src", [f("b.ts"), f("a10.ts"), f("a9.ts"), d("lib")]), lazy]);
    expect(sorted.map((n) => n.name)).toEqual(["node_modules", "src"]);
    expect(sorted[0]!.children).toBeUndefined();
    expect(sorted[1]!.children!.map((n) => n.name)).toEqual(["lib", "a9.ts", "a10.ts", "b.ts"]);
  });

  test("does not mutate its input", () => {
    const input = [f("b"), f("a")];
    sortTree(input);
    expect(input.map((n) => n.name)).toEqual(["b", "a"]);
  });

  test("is antisymmetric for equal-ish names", () => {
    expect(compareTreeNodes(f("a"), f("A"))).toBe(-compareTreeNodes(f("A"), f("a")));
  });
});
