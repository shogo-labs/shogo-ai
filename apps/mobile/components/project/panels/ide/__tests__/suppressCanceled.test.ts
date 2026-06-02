/**
 * Sanity tests for the Monaco "Canceled" error suppressor.
 *
 * The suppressor exists to drop Monaco's harmless CancellationError leaks
 * from `window.onerror` / `unhandledrejection` — see the file comment in
 * `monaco/suppressCanceled.ts` for the upstream issue list. We pin the
 * match predicate here so a future refactor doesn't accidentally
 * broaden it to swallow real bugs.
 */
import { describe, expect, test } from "bun:test";
import { __test } from "../monaco/suppressCanceled";

const { isMonacoCanceled } = __test;

describe("isMonacoCanceled", () => {
  test("matches Error with name===message===\"Canceled\"", () => {
    const err = new Error("Canceled");
    err.name = "Canceled";
    expect(isMonacoCanceled(err)).toBe(true);
  });

  test("matches plain object with name+message Canceled (PromiseRejectionEvent.reason shape)", () => {
    expect(isMonacoCanceled({ name: "Canceled", message: "Canceled" })).toBe(true);
  });

  test("rejects regular Error with different name", () => {
    const err = new TypeError("Canceled");
    expect(isMonacoCanceled(err)).toBe(false);
  });

  test("rejects Error whose message isn't Canceled", () => {
    const err = new Error("Network request canceled");
    expect(isMonacoCanceled(err)).toBe(false);
  });

  test("rejects null / undefined / primitives", () => {
    expect(isMonacoCanceled(null)).toBe(false);
    expect(isMonacoCanceled(undefined)).toBe(false);
    expect(isMonacoCanceled("Canceled")).toBe(false);
    expect(isMonacoCanceled(0)).toBe(false);
  });

  test("rejects objects whose name matches but message doesn't", () => {
    expect(isMonacoCanceled({ name: "Canceled", message: "something else" })).toBe(false);
    expect(isMonacoCanceled({ name: "Other", message: "Canceled" })).toBe(false);
  });
});
