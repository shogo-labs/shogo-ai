// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// react-native-web's `Alert.alert` is an empty function. The root layout
// replaces it with the web queue; if that wiring is lost, every Alert.alert
// in the app goes silent on desktop and web again.

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative, sep } from "path";

const mobileRoot = join(import.meta.dir, "..", "..", "..");
const rootLayout = readFileSync(join(mobileRoot, "app", "_layout.tsx"), "utf8");

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name === ".expo" || name === "__tests__") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}

describe("web Alert wiring", () => {
  test("the root layout installs the web Alert at module load", () => {
    expect(rootLayout).toMatch(/^installWebAlert\(\);$/m);
  });

  test("the root layout mounts WebAlertHost", () => {
    expect(rootLayout).toContain("<WebAlertHost />");
  });

  test("only lib/web-alert reassigns Alert.alert", () => {
    const offenders = ["app", "components", "hooks", "lib", "contexts"]
      .flatMap((dir) => sourceFiles(join(mobileRoot, dir)))
      .filter((file) => !relative(mobileRoot, file).startsWith(["lib", "web-alert"].join(sep)))
      .filter((file) => /\bAlert\s*(\)|as [^)]*\))?\s*\.alert\s*=[^=]/.test(readFileSync(file, "utf8")))
      .map((file) => relative(mobileRoot, file));
    expect(offenders).toEqual([]);
  });
});
