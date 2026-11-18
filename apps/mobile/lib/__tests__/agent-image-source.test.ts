// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { createAgentImageSource } from "../agent-image-source-core";

describe("createAgentImageSource", () => {
  test("uses the native session cookie for image requests", () => {
    expect(
      createAgentImageSource(
        "https://agent.example/image.png",
        "ios",
        "session=abc",
      ),
    ).toEqual({
      uri: "https://agent.example/image.png",
      headers: { Cookie: "session=abc" },
    });
  });

  test("leaves web image sources cookie-free", () => {
    expect(
      createAgentImageSource(
        "https://agent.example/image.png",
        "web",
        "session=abc",
      ),
    ).toEqual({ uri: "https://agent.example/image.png" });
  });
});

/**
 * The chat image loader: one request per URL, a cache that survives a
 * re-render, and a cap on how many images are in flight at once.
 *
 * A resumed chat mounts every photo in the turn window at the same moment.
 * Before this, each one fetched its full bytes and base64'd them on the JS
 * thread, with no cache — so a 10-photo chat re-downloaded and re-encoded
 * everything on every resume (SHO-407).
 */

const fetchCalls: string[] = [];
/** Resolvers for the requests the loader has started, so a test can hold them. */
let pending: Array<() => void> = [];
let holdRequests = false;

mock.module("react-native", () => ({
  Platform: { OS: "web", select: (spec: any) => spec.web ?? spec.default },
}));

mock.module("../auth-client", () => ({
  authClient: { getCookie: () => "session=abc" },
}));

mock.module("../agent-fetch", () => ({
  agentFetch: async (uri: string) => {
    fetchCalls.push(uri);
    if (holdRequests) {
      await new Promise<void>((resolve) => pending.push(resolve));
    }
    return new Response(new Uint8Array([1, 2, 3]), {
      status: 200,
      headers: { "content-type": "image/jpeg" },
    });
  },
}));

const objectUrls: string[] = [];
const revoked: string[] = [];
let objectUrlSeq = 0;
(globalThis as any).URL.createObjectURL = (_blob: unknown) => {
  const url = `blob:test/${++objectUrlSeq}`;
  objectUrls.push(url);
  return url;
};
(globalThis as any).URL.revokeObjectURL = (url: string) => {
  revoked.push(url);
};

const {
  MAX_CONCURRENT_IMAGE_LOADS,
  imageCacheKey,
  loadAgentImage,
  needsAgentImageLoad,
  resetAgentImageCache,
} = await import("../agent-image-source");

const WORKSPACE_IMAGE =
  "https://api.example.com/api/projects/p1/agent-proxy/agent/workspace/download/files/a.jpg";

beforeEach(() => {
  resetAgentImageCache();
  fetchCalls.length = 0;
  objectUrls.length = 0;
  revoked.length = 0;
  pending = [];
  holdRequests = false;
});

describe("needsAgentImageLoad", () => {
  test("a workspace download URL is behind the session", () => {
    expect(needsAgentImageLoad(WORKSPACE_IMAGE)).toBe(true);
  });

  test("a capability URL, a data URL and a blob load directly", () => {
    expect(needsAgentImageLoad("/api/chat-attachments/artifacts/x.jpg?t=abc")).toBe(false);
    expect(needsAgentImageLoad("data:image/png;base64,AAAA")).toBe(false);
    expect(needsAgentImageLoad("blob:test/1")).toBe(false);
  });
});

describe("loadAgentImage", () => {
  test("fetches once and hands back an object URL", async () => {
    const first = await loadAgentImage(WORKSPACE_IMAGE);

    expect(first).toBe("blob:test/1");
    expect(fetchCalls).toEqual([WORKSPACE_IMAGE]);
  });

  test("a second call is a cache hit with no second fetch", async () => {
    const first = await loadAgentImage(WORKSPACE_IMAGE);
    const second = await loadAgentImage(WORKSPACE_IMAGE);

    expect(second).toBe(first);
    expect(fetchCalls).toHaveLength(1);
  });

  test("concurrent callers share one in-flight request", async () => {
    holdRequests = true;
    const a = loadAgentImage(WORKSPACE_IMAGE);
    const b = loadAgentImage(WORKSPACE_IMAGE);
    const c = loadAgentImage(WORKSPACE_IMAGE);

    // Let the single request start, then release it.
    await Promise.resolve();
    pending.forEach((release) => release());

    const results = await Promise.all([a, b, c]);

    expect(fetchCalls).toEqual([WORKSPACE_IMAGE]);
    expect(new Set(results).size).toBe(1);
  });

  test("runs at most MAX_CONCURRENT_IMAGE_LOADS at a time", async () => {
    holdRequests = true;
    const urls = Array.from({ length: MAX_CONCURRENT_IMAGE_LOADS + 2 }, (_, i) =>
      `${WORKSPACE_IMAGE}?n=${i}`,
    );

    const loads = urls.map((url) => loadAgentImage(url));
    await Promise.resolve();

    expect(fetchCalls).toHaveLength(MAX_CONCURRENT_IMAGE_LOADS);

    // Release one at a time; each release lets exactly one more start.
    while (pending.length > 0) {
      const release = pending.shift()!;
      release();
      await Promise.resolve();
      await Promise.resolve();
    }

    await Promise.all(loads);
    expect(fetchCalls).toHaveLength(urls.length);
  });

  test("a failed load resolves null instead of throwing", async () => {
    mock.module("../agent-fetch", () => ({
      agentFetch: async () => new Response("nope", { status: 500 }),
    }));
    // A fresh module instance so the new mock is picked up.
    const fresh = await import(`../agent-image-source?fail=${Date.now()}`);
    fresh.resetAgentImageCache();

    expect(await fresh.loadAgentImage(WORKSPACE_IMAGE)).toBeNull();
  });
});

describe("imageCacheKey", () => {
  test("is stable for the same URL and differs between URLs", () => {
    expect(imageCacheKey(WORKSPACE_IMAGE)).toBe(imageCacheKey(WORKSPACE_IMAGE));
    expect(imageCacheKey(WORKSPACE_IMAGE)).not.toBe(imageCacheKey(`${WORKSPACE_IMAGE}?n=1`));
  });

  test("keeps a readable, filesystem-safe tail", () => {
    const key = imageCacheKey(WORKSPACE_IMAGE);
    expect(key.endsWith("-a.jpg")).toBe(true);
    expect(key).not.toContain("/");
  });
});
