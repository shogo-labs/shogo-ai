import { describe, expect, test } from "bun:test";
import { uniqueCopyName } from "../FileTree";

describe("uniqueCopyName", () => {
  test("keeps the name when free", () => {
    expect(uniqueCopyName("a.ts", "file", new Set(["b.ts"]))).toBe("a.ts");
  });
  test("adds ' copy' before the extension, then numbers", () => {
    const taken = new Set(["a.ts"]);
    expect(uniqueCopyName("a.ts", "file", taken)).toBe("a copy.ts");
    taken.add("a copy.ts");
    expect(uniqueCopyName("a.ts", "file", taken)).toBe("a copy 2.ts");
  });
  test("dotfiles and folders keep their full stem", () => {
    expect(uniqueCopyName(".env", "file", new Set([".env"]))).toBe(".env copy");
    expect(uniqueCopyName("src.v1", "dir", new Set(["src.v1"]))).toBe("src.v1 copy");
  });
  test("collision check is case-insensitive", () => {
    expect(uniqueCopyName("A.ts", "file", new Set(["a.ts"]))).toBe("A copy.ts");
  });
});
