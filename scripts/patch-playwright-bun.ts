/**
 * Patches playwright-core's bundled ws library to use bun's native ws module.
 *
 * Bun's http.ClientRequest doesn't emit the 'upgrade' event needed by the
 * bundled ws library for WebSocket handshakes. This causes connectOverCDP()
 * (and the internal CDP transport used by chromium.launch()) to hang
 * indefinitely. Bun provides a native 'ws' module that handles upgrades
 * correctly.
 *
 * See: https://github.com/oven-sh/bun/issues/9357
 * See: https://github.com/microsoft/playwright/pull/34546
 *
 * Cross-platform: pure Node fs walk (no shell `find`), so it works on
 * Windows, macOS and Linux.
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from "fs";
import { join, sep } from "path";

const BUNDLED_LINE = 'const ws = require("./utilsBundleImpl").ws;';
const PATCHED_LINE =
  'const ws = "Bun" in globalThis ? require("ws") : require("./utilsBundleImpl").ws;';

const TARGET_SUFFIX = join("playwright-core", "lib", "utilsBundle.js");

function findUtilsBundles(root: string): string[] {
  const results: string[] = [];
  const seen = new Set<string>();

  // Follows symlinks: bun's install backend on Windows realises individual
  // files inside packages as symlinks/junctions to ~/.bun/install/cache, so
  // `entry.isFile()` returns false even though the path is a real file when
  // resolved. Use statSync (which follows symlinks) for type detection.
  function walk(dir: string, depth: number) {
    if (depth > 14) return;
    let entries: import("fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      let isDir = entry.isDirectory();
      let isFile = entry.isFile();
      if (entry.isSymbolicLink()) {
        try {
          const resolved = statSync(full);
          isDir = resolved.isDirectory();
          isFile = resolved.isFile();
        } catch {
          continue;
        }
      }
      if (isDir) {
        walk(full, depth + 1);
      } else if (isFile && full.endsWith(`${sep}${TARGET_SUFFIX}`)) {
        // De-dupe by realpath: the bun cache layout often has the same
        // backing file linked from many places.
        let key = full;
        try {
          key = require("fs").realpathSync(full);
        } catch {}
        if (!seen.has(key)) {
          seen.add(key);
          results.push(full);
        }
      }
    }
  }

  try {
    if (!statSync(root).isDirectory()) return results;
  } catch {
    return results;
  }
  walk(root, 0);
  return results;
}

const root = join(process.cwd(), "node_modules");
const files = findUtilsBundles(root);

let patched = 0;
let alreadyPatched = 0;

for (const file of files) {
  const content = readFileSync(file, "utf-8");
  if (content.includes(PATCHED_LINE)) {
    alreadyPatched++;
    continue;
  }
  if (content.includes(BUNDLED_LINE)) {
    writeFileSync(file, content.replace(BUNDLED_LINE, PATCHED_LINE));
    patched++;
    console.log(`  patched: ${file}`);
  }
}

if (files.length === 0) {
  console.log(
    "playwright-core: no utilsBundle.js files found under node_modules/ — nothing to patch",
  );
} else if (patched === 0) {
  console.log(
    `playwright-core: ${alreadyPatched}/${files.length} already patched, 0 needed patching`,
  );
} else {
  console.log(
    `playwright-core: patched ${patched} file(s) for bun ws compatibility ` +
      `(${alreadyPatched} already patched, ${files.length} total)`,
  );
}
