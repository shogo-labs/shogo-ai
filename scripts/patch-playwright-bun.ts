/**
 * Patches playwright-core's bundled ws library to use bun's native ws module.
 *
 * Bun's http.ClientRequest doesn't emit the 'upgrade' event needed by the
 * bundled ws library for WebSocket handshakes. This causes connectOverCDP()
 * to hang indefinitely. Bun provides a native 'ws' module that handles
 * upgrades correctly.
 *
 * See: https://github.com/oven-sh/bun/issues/9357
 * See: https://github.com/microsoft/playwright/pull/34546
 */
import { readdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";

const BUNDLED_LINE = 'const ws = require("./utilsBundleImpl").ws;';
const PATCHED_LINE =
  'const ws = "Bun" in globalThis ? require("ws") : require("./utilsBundleImpl").ws;';

let patched = 0;

function findUtilsBundles(dir: string): string[] {
  const results: string[] = [];
  try {
    const output = execSync(
      `find ${JSON.stringify(dir)} -path "*/playwright-core/lib/utilsBundle.js" -type f`,
      { encoding: "utf-8", timeout: 10000 },
    );
    for (const line of output.trim().split("\n")) {
      if (line) results.push(line);
    }
  } catch {}
  return results;
}

const files = findUtilsBundles(join(process.cwd(), "node_modules"));

for (const file of files) {
  const content = readFileSync(file, "utf-8");
  if (content.includes(BUNDLED_LINE) && !content.includes(PATCHED_LINE)) {
    writeFileSync(file, content.replace(BUNDLED_LINE, PATCHED_LINE));
    patched++;
    console.log(`  patched: ${file}`);
  }
}

if (patched > 0) {
  console.log(`playwright-core: patched ${patched} file(s) for bun ws compatibility`);
}
