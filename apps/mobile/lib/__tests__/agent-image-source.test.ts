// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from "bun:test";
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
