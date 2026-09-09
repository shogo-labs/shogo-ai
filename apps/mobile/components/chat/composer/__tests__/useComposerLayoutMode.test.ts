// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from "bun:test";
import { COMPOSER_SIZES } from "../useComposerLayoutMode";

describe("COMPOSER_SIZES", () => {
  test("keeps the three composer variants explicit", () => {
    expect(COMPOSER_SIZES.web).toMatchObject({
      inputMinHeight: 60,
      inputMaxHeight: 200,
    });
    expect(COMPOSER_SIZES.native).toMatchObject({
      inputMinHeight: 52,
      inputMaxHeight: 160,
    });
    expect(COMPOSER_SIZES.prominent).toMatchObject({
      inputMinHeight: 24,
      inputMaxHeight: 132,
    });
  });

  test("keeps every variant's minimum below its maximum", () => {
    for (const size of Object.values(COMPOSER_SIZES)) {
      expect(size.minHeight).toBeLessThan(size.maxHeight);
      expect(size.inputMinHeight).toBeLessThan(size.inputMaxHeight);
    }
  });
});
