/**
 * numstat-parser — tests for git diff --numstat output parsing.
 */
import { describe, expect, test } from "bun:test";

function parseNumStat(output: string): Record<string, { added: number; removed: number }> {
  const stats: Record<string, { added: number; removed: number }> = {};
  for (const line of output.split("\n")) {
    if (!line.trim()) continue;
    const parts = line.split("\t");
    if (parts.length >= 3) {
      const added = parseInt(parts[0], 10);
      const removed = parseInt(parts[1], 10);
      const path = parts.slice(2).join("\t");
      if (!Number.isNaN(added) && !Number.isNaN(removed)) {
        stats[path] = { added, removed };
      }
    }
  }
  return stats;
}

describe("parseNumStat — basic", () => {
  test("single file", () => {
    expect(parseNumStat("12\t3\tsrc/index.ts\n")).toEqual({ "src/index.ts": { added: 12, removed: 3 } });
  });
  test("multiple files", () => {
    expect(parseNumStat("10\t2\ta.ts\n5\t0\tb.ts\n")).toEqual({
      "a.ts": { added: 10, removed: 2 },
      "b.ts": { added: 5, removed: 0 },
    });
  });
  test("new file (zero removed)", () => {
    expect(parseNumStat("45\t0\tnew.ts\n")).toEqual({ "new.ts": { added: 45, removed: 0 } });
  });
  test("deletion only", () => {
    expect(parseNumStat("0\t30\tdel.ts\n")).toEqual({ "del.ts": { added: 0, removed: 30 } });
  });
});

describe("parseNumStat — edge cases", () => {
  test("empty output → empty map", () => expect(parseNumStat("")).toEqual({}));
  test("whitespace only → empty map", () => expect(parseNumStat("  \n  \n")).toEqual({}));
  test("binary files (-) skipped", () => expect(parseNumStat("-\t-\tbinary.png\n")).toEqual({}));
  test("path with spaces", () => {
    expect(parseNumStat("5\t1\tsrc/my file.ts\n")).toEqual({ "src/my file.ts": { added: 5, removed: 1 } });
  });
  test("deep path", () => {
    expect(parseNumStat("1\t1\ta/b/c/d/e/f.ts\n")).toEqual({ "a/b/c/d/e/f.ts": { added: 1, removed: 1 } });
  });
  test("no trailing newline", () => {
    expect(parseNumStat("3\t2\tfile.ts")).toEqual({ "file.ts": { added: 3, removed: 2 } });
  });
  test("trailing empty line", () => {
    expect(parseNumStat("1\t1\ta.ts\n\n")).toEqual({ "a.ts": { added: 1, removed: 1 } });
  });
  test("incomplete line skipped", () => expect(parseNumStat("incomplete\n")).toEqual({}));
  test("mixed real and binary", () => {
    const r = parseNumStat("10\t5\treal.ts\n-\t-\tbinary.png\n3\t1\tother.ts\n");
    expect(r).toEqual({
      "real.ts": { added: 10, removed: 5 },
      "other.ts": { added: 3, removed: 1 },
    });
  });
  test("large numbers", () => {
    expect(parseNumStat("9999\t8888\tbig.ts\n")).toEqual({ "big.ts": { added: 9999, removed: 8888 } });
  });
});
