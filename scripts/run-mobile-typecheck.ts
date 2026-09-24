// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Runs TypeScript against the mobile app in CI.
 *
 * The mobile tree currently has pre-existing semantic diagnostics, so making
 * every existing diagnostic a hard gate would hide this check behind legacy
 * debt. Unresolved identifiers are a separate, high-signal class: they are
 * runtime ReferenceErrors in the Expo web bundle and are exactly the failure
 * mode that previously reached production. This gate fails on new TS2304 and
 * TS2552 diagnostics while still running the complete compiler.
 *
 * As the existing mobile diagnostics are fixed, this can become a strict
 * `tsc --noEmit` check without changing the CI entry point.
 */

import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const mobileDir = resolve(import.meta.dir, "../apps/mobile");
const result = spawnSync(
  "bun",
  [
    "x",
    "tsc",
    "--noEmit",
    "--incremental",
    "--tsBuildInfoFile",
    ".tsbuildinfo",
    "--ignoreDeprecations",
    "5.0",
    "--pretty",
    "false",
  ],
  {
    cwd: mobileDir,
    encoding: "utf8",
  },
);

if (result.error) {
  console.error(`[mobile:typecheck] unable to start tsc: ${result.error.message}`);
  process.exit(1);
}

const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
const diagnostics = output
  .split(/\r?\n/)
  .filter((line) => line.includes(" error TS"));
const unresolvedIdentifiers = diagnostics.filter((line) =>
  /error TS(?:2304|2552):/.test(line),
);
const compilerConfigurationErrors = diagnostics.filter(
  (line) => /error TS5\d{3}:/.test(line) || line.includes("tsconfig.json"),
);

if (compilerConfigurationErrors.length > 0) {
  console.error(
    "[mobile:typecheck] compiler configuration errors must block CI:",
  );
  console.error(compilerConfigurationErrors.join("\n"));
  process.exit(1);
}

if (unresolvedIdentifiers.length > 0) {
  console.error("[mobile:typecheck] unresolved identifiers must block CI:");
  console.error(unresolvedIdentifiers.join("\n"));
  process.exit(1);
}

if (result.status !== 0 && diagnostics.length === 0) {
  console.error(
    `[mobile:typecheck] tsc exited with status ${String(result.status)} without diagnostics`,
  );
  process.exit(1);
}

if (diagnostics.length > 0) {
  const counts = new Map<string, number>();
  for (const diagnostic of diagnostics) {
    const code = diagnostic.match(/error (TS\d+):/)?.[1] ?? "unknown";
    counts.set(code, (counts.get(code) ?? 0) + 1);
  }
  const summary = [...counts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([code, count]) => `${code}=${count}`)
    .join(", ");
  console.warn(
    `[mobile:typecheck] ${diagnostics.length} existing diagnostics remain (${summary}); ` +
      "unresolved-identifier diagnostics are clean",
  );
}

console.log("[mobile:typecheck] passed");
