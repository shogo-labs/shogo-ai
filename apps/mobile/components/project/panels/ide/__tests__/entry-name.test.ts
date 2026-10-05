import { describe, expect, test } from "bun:test";
import { renameSelectionEnd, validateEntryName } from "../entry-name";

describe("validateEntryName", () => {
  const siblings = ["index.ts", "README.md", "src"];

  test("empty/whitespace is not an error (treated as cancel)", () => {
    expect(validateEntryName("", { siblings })).toBeNull();
    expect(validateEntryName("   ", { siblings })).toBeNull();
  });

  test("accepts a normal new name", () => {
    expect(validateEntryName("main.ts", { siblings })).toBeNull();
    expect(validateEntryName(".env", { siblings })).toBeNull();
  });

  test("rejects path separators", () => {
    expect(validateEntryName("a/b.ts", { siblings })).toContain("cannot contain");
    expect(validateEntryName("a\\b.ts", { siblings })).toContain("cannot contain");
  });

  test("rejects . and ..", () => {
    expect(validateEntryName(".", { siblings })).toContain("not a valid");
    expect(validateEntryName("..", { siblings })).toContain("not a valid");
  });

  test("rejects control characters and absurd length", () => {
    expect(validateEntryName("a\u0000b", { siblings })).toContain("control");
    expect(validateEntryName("x".repeat(256), { siblings })).toContain("too long");
  });

  test("rejects collisions, case-insensitively", () => {
    expect(validateEntryName("index.ts", { siblings })).toContain("already exists");
    expect(validateEntryName("INDEX.TS", { siblings })).toContain("already exists");
    expect(validateEntryName("  src  ", { siblings })).toContain("already exists");
  });

  test("rename may keep its own name or change only its case", () => {
    const opts = { siblings, currentName: "index.ts" };
    expect(validateEntryName("index.ts", opts)).toBeNull();
    expect(validateEntryName("Index.ts", opts)).toBeNull();
    // ...but still can't take a different sibling's name
    expect(validateEntryName("readme.md", opts)).toContain("already exists");
  });
});

describe("renameSelectionEnd", () => {
  test("files select the base name without the extension", () => {
    expect(renameSelectionEnd("index.ts", false)).toBe(5);
    expect(renameSelectionEnd("foo.test.ts", false)).toBe(8);
  });

  test("folders select everything", () => {
    expect(renameSelectionEnd("src.d", true)).toBe(5);
  });

  test("dotfiles and extensionless files select everything", () => {
    expect(renameSelectionEnd(".env", false)).toBe(4);
    expect(renameSelectionEnd("Makefile", false)).toBe(8);
  });
});
