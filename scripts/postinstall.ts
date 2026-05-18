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
//
// `packages/sdk/bin/shogo.ts` imports `@shogo-ai/cli/pkg`, which only resolves
// once `bun run build:cli` (part of `bun run build:packages`) has produced
// `packages/cli/dist/`. On a fresh clone or under `bun install --linker=isolated`
// in CI, that build hasn't happened yet, so the generator throws
// `Cannot find module '@shogo-ai/cli/pkg'` and skips. That's expected, but a
// silent skip leaves `apps/api/src/generated/admin-routes.ts` missing, which
// blows up later bundle/typecheck steps with confusing errors. Print a loud
// warning so the failure is visible — CI release workflows now re-invoke
// `bun run generate:routes` explicitly after `build:packages`, and local devs
// can do the same.
//
// We invoke the generator binary directly (instead of `bun run generate:routes`)
// with `--no-env-file` and a stripped `DATABASE_URL`. The generator
// opportunistically calls `prisma db push` whenever `process.env.DATABASE_URL`
// is truthy, and Bun auto-loads `.env.local` for child `bun run` invocations.
// Local-mode contributors who follow the documented recipe
// (`SHOGO_LOCAL_MODE=true` + `DATABASE_URL=file:./shogo-local.db` in
// `.env.local`) would otherwise have postinstall silently `db push` the schema
// into that SQLite file with no `_prisma_migrations` history. The next
// `bun run dev:all` then crashes with Prisma error P3005 ("database schema is
// not empty") because `migrate deploy` refuses to baseline an unrecognized DB.
//
// Route generation only needs the schema file. The actual DB schema is owned
// by `bun run db:migrate:deploy` / `dev:all`, not by route generation.
if (existsSync("packages/sdk/bin/shogo.ts") && existsSync("shogo.config.json")) {
  const { DATABASE_URL: _omittedToPreventAccidentalDbPush, ...envWithoutDbUrl } = process.env;
  try {
    execSync(
      "bun --no-env-file run packages/sdk/bin/shogo.ts generate",
      { stdio: "inherit", env: envWithoutDbUrl },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn("");
    console.warn("⚠️  postinstall: route generation failed.");
    console.warn(`    ${msg.split("\n")[0]}`);
    console.warn("");
    console.warn("    Generated files under apps/api/src/generated/ may be");
    console.warn("    missing or stale. If you're building from a fresh clone,");
    console.warn("    run the following once the workspace packages are built:");
    console.warn("");
    console.warn("      bun run build:packages && bun run generate:routes");
    console.warn("");
  }
}
