import { execSync } from "child_process";

const dbUrl = process.env.DATABASE_URL;
const pgUrl = dbUrl || "postgres://localhost/prisma-generate";
const sqliteUrl = dbUrl || "file:./dev.db";

try {
  execSync("bunx prisma generate", {
    stdio: "inherit",
    env: { ...process.env, SHOGO_LOCAL_MODE: "false", DATABASE_URL: pgUrl },
  });
} catch {
  // PG generate may fail in local-only setups — continue to SQLite
}

execSync("bunx prisma generate", {
  stdio: "inherit",
  env: { ...process.env, SHOGO_LOCAL_MODE: "true", DATABASE_URL: sqliteUrl },
});

execSync("bun scripts/link-prisma.ts", { stdio: "inherit" });
