import { existsSync } from "fs";
import { execSync } from "child_process";

if (existsSync("scripts/patch-playwright-bun.ts")) {
  try {
    execSync("bun scripts/patch-playwright-bun.ts", { stdio: "inherit" });
  } catch {
    // Non-critical — headless browser still works without the patch
  }
}

// Download Playwright's bundled Chromium into ~/.cache/ms-playwright (or
// %LOCALAPPDATA%\ms-playwright on Windows). agent-runtime depends on
// playwright-core, which — unlike full `playwright` — does NOT auto-download
// browsers, so without this step the agent's `browser` tool fails on the
// first launch with "Executable doesn't exist…". The install command itself
// is idempotent: it short-circuits when the matching version is already
// present, so re-running on every `bun install` is cheap.
//
// Skipped in CI and when the user has explicitly opted out via Playwright's
// own env knob, mirroring the patterns the @playwright/test package uses.
const skipBrowserDownload =
  process.env.CI === "true" ||
  process.env.CI === "1" ||
  process.env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD === "1" ||
  process.env.SHOGO_SKIP_BROWSER_DOWNLOAD === "1";

if (!skipBrowserDownload) {
  try {
    execSync("bun x playwright install chromium", { stdio: "inherit" });
  } catch {
    // Non-fatal — the user can run `bun x playwright install chromium`
    // manually if this fails (e.g. offline, proxy, etc.).
  }
}

execSync("bun scripts/db-generate-all.ts", { stdio: "inherit" });

// Regenerate Hono routes/hooks/admin-routes from prisma/schema.prisma. Mirrors
// the same step that runs in apps/api/Dockerfile so a developer who adds a
// model + runs `bun install` ends up with the new `*.routes.ts` files locally
// without needing to remember `bun run generate:routes`. The generator is
// idempotent (no-op when the schema and outputs are already in sync) and
// `*.hooks.ts` files are skipped if they already exist, so manual hook
// business logic is preserved.
//
// Skipped when the SDK package isn't present (e.g. published-package consumers
// of `shogo-ai` that don't ship the generator).
if (existsSync("packages/sdk/bin/shogo.ts") && existsSync("shogo.config.json")) {
  try {
    execSync("bun run generate:routes", { stdio: "inherit" });
  } catch {
    // Non-fatal — `bun run generate:routes` can be run manually if this fails
    // (e.g. transient TS errors during schema migration).
  }
}
