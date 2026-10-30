// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, expect, test } from "bun:test";
import { pathFromUri } from "../model-path";

describe("pathFromUri", () => {
  test("splits '<rootId>::<relPath>' and strips leading slashes", () => {
    expect(pathFromUri({ path: "/agent::src/big.ts" })).toEqual({ rootId: "agent", path: "src/big.ts" });
    expect(pathFromUri({ path: "///agent::a.ts" })).toEqual({ rootId: "agent", path: "a.ts" });
  });

  test("decodes encoded URIs", () => {
    expect(pathFromUri({ path: "/local%3Arepo%3A1%3A%3Asrc/a%20b.ts" })).toEqual({
      rootId: "local:repo:1",
      path: "src/a b.ts",
    });
  });

  test("keeps everything after the first '::' as the path", () => {
    expect(pathFromUri({ path: "/agent::odd::name.ts" })).toEqual({ rootId: "agent", path: "odd::name.ts" });
  });

  test("no '::' -> no root", () => {
    expect(pathFromUri({ path: "/plain/file.ts" })).toEqual({ rootId: null, path: "plain/file.ts" });
  });

  test("malformed encodings are left as-is", () => {
    expect(pathFromUri({ path: "/agent::100%.ts" })).toEqual({ rootId: "agent", path: "100%.ts" });
  });

  test("missing path", () => {
    expect(pathFromUri({})).toEqual({ rootId: null, path: "" });
  });
});
