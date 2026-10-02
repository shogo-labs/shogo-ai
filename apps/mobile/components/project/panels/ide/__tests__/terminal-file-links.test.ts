import { describe, expect, test } from "bun:test";
import { findFileLinks } from "../terminal/file-links";

describe("findFileLinks", () => {
  test("path:line:col", () => {
    const [m] = findFileLinks("  at src/app/main.ts:42:7");
    expect(m).toMatchObject({ path: "src/app/main.ts", line: 42, column: 7 });
  });
  test("TypeScript style (line,col) and ./ prefix", () => {
    const [m] = findFileLinks("./src/a.tsx(10,3): error TS2322");
    expect(m).toMatchObject({ path: "src/a.tsx", line: 10, column: 3 });
  });
  test("path:line without column", () => {
    expect(findFileLinks("FAIL lib/x.test.ts:9")[0]).toMatchObject({ line: 9, column: 1 });
  });
  test("ignores URLs and plain text", () => {
    expect(findFileLinks("see http://localhost.dev:3000/x")).toHaveLength(0);
    expect(findFileLinks("nothing here")).toHaveLength(0);
  });
  test("multiple on a line", () => {
    expect(findFileLinks("a.ts:1 and b.ts:2:3")).toHaveLength(2);
  });
});
