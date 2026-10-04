// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { COMPOSER_SIZES } from "../useComposerLayoutMode";

const COMPONENTS = join(import.meta.dir, "..", "..", "..");

/**
 * Surfaces that wrap the shared composer with their own behavior. They render
 * `ChatInput` instead of a text box of their own.
 */
const CHAT_INPUT_HOSTS = ["team-chat/Composer.tsx", "../app/(app)/index.tsx"];

describe("chat composer has one implementation", () => {
  test("ChatInput takes its phone/desktop layout from useComposerLayoutMode", () => {
    const source = readFileSync(join(COMPONENTS, "chat/ChatInput.tsx"), "utf-8");
    expect(source).toContain("useComposerLayoutMode(");
    expect(
      source.match(
        /\b(isPhoneLayout|usePhoneLayout|useIsNativePhoneLayout|isNativePhoneIntegrationsLayout)\(/g,
      ) ?? [],
    ).toEqual([]);
  });

  for (const file of CHAT_INPUT_HOSTS) {
    test(`${file} renders ChatInput rather than its own TextInput`, () => {
      const source = readFileSync(join(COMPONENTS, file), "utf-8");
      expect(source).toContain("<ChatInput");
      expect(source).not.toMatch(/<TextInput\b/);
    });
  }
});

describe("COMPOSER_SIZES", () => {
  test("keeps the three composer variants explicit", () => {
    expect(COMPOSER_SIZES.web).toMatchObject({
      inputMinHeight: 48,
      inputMaxHeight: 160,
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
