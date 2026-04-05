import { existsSync } from "fs";
import { execSync } from "child_process";

if (existsSync("scripts/patch-claude-sdk.ts")) {
  try {
    execSync("bun scripts/patch-claude-sdk.ts", { stdio: "inherit" });
  } catch {
    // Matching original `|| true` — ignore patch failures
  }
}

if (existsSync("scripts/patch-playwright-bun.ts")) {
  try {
    execSync("bun scripts/patch-playwright-bun.ts", { stdio: "inherit" });
  } catch {
    // Non-critical — headless browser still works without the patch
  }
}

execSync("bun scripts/db-generate-all.ts", { stdio: "inherit" });
