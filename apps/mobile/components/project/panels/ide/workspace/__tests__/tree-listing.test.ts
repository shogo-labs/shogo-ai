// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, expect, mock, test } from "bun:test";
import {
  TRUNCATED_RETRY_DELAYS_MS,
  followTruncatedListing,
  listTreeMeta,
} from "../tree-listing";
import type { WorkspaceService, WsTreeListing } from "../types";

const file = (name: string) => ({ name, path: name, kind: "file" as const });

function listing(truncated: boolean, ...names: string[]): WsTreeListing {
  return { nodes: names.map(file), truncated };
}

/** Resolves when the follow-up loop reports, with every sleep instant. */
function run(responses: Array<WsTreeListing | Error>, delays = TRUNCATED_RETRY_DELAYS_MS) {
  const applied: WsTreeListing[] = [];
  const slept: number[] = [];
  const fetch = mock(async () => {
    const next = responses.shift();
    if (!next) throw new Error("no more responses");
    if (next instanceof Error) throw next;
    return next;
  });
  const settled = new Promise<boolean>((resolve) => {
    followTruncatedListing({
      fetch,
      apply: (l) => applied.push(l),
      onSettled: resolve,
      delays,
      sleep: async (ms) => {
        slept.push(ms);
      },
    });
  });
  return { applied, slept, fetch, settled };
}

describe("listTreeMeta", () => {
  test("uses listTreeWithMeta when the backend has it", async () => {
    const svc = {
      listTree: mock(async () => []),
      listTreeWithMeta: mock(async () => listing(true, "a")),
    } as unknown as WorkspaceService;
    expect(await listTreeMeta(svc, "src")).toEqual(listing(true, "a"));
    expect(svc.listTreeWithMeta).toHaveBeenCalledWith("src");
  });

  test("treats a backend without it as complete", async () => {
    const svc = { listTree: mock(async () => [file("a")]) } as unknown as WorkspaceService;
    expect(await listTreeMeta(svc)).toEqual(listing(false, "a"));
  });
});

describe("followTruncatedListing", () => {
  test("stops at the first complete listing", async () => {
    const r = run([listing(true, "a"), listing(false, "a", "b")]);
    expect(await r.settled).toBe(false);
    expect(r.applied).toEqual([listing(true, "a"), listing(false, "a", "b")]);
    expect(r.slept).toEqual([500, 1000]);
  });

  test("gives up after three truncated retries", async () => {
    const r = run([listing(true), listing(true), listing(true), listing(false)]);
    expect(await r.settled).toBe(true);
    expect(r.fetch).toHaveBeenCalledTimes(3);
    expect(r.slept).toEqual([500, 1000, 2000]);
  });

  test("a failed fetch counts as a truncated attempt", async () => {
    const r = run([new Error("503"), listing(false, "x")]);
    expect(await r.settled).toBe(false);
    expect(r.applied).toEqual([listing(false, "x")]);
  });

  test("nothing is applied or reported after cancel", async () => {
    const applied: WsTreeListing[] = [];
    const onSettled = mock(() => {});
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const cancel = followTruncatedListing({
      fetch: async () => listing(false, "late"),
      apply: (l) => applied.push(l),
      onSettled,
      sleep: () => gate,
    });
    cancel();
    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(applied).toEqual([]);
    expect(onSettled).not.toHaveBeenCalled();
  });
});
