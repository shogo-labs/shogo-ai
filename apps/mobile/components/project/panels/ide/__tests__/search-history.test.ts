import { describe, expect, test } from "bun:test";
import { pushSearchHistory } from "../search-history";

describe("pushSearchHistory", () => {
  test("newest first, deduped, capped at 20", () => {
    expect(pushSearchHistory(["a", "b"], "b")).toEqual(["b", "a"]);
    const many = Array.from({ length: 25 }, (_, i) => `q${i}`);
    expect(pushSearchHistory(many, "x")).toHaveLength(20);
  });
});
