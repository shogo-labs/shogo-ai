/**
 * Cross-platform dev:all script.
 *
 * Replaces the bash-only one-liner so it works on Windows (PowerShell)
 * as well as macOS / Linux.
 *
 *  1. Kill any process occupying the API port (best-effort).
 *  2. Run Prisma migrate deploy against the local SQLite DB.
 *  3. Regenerate the Prisma client(s) so any new models added to the
 *     schema since the last `bun install` are visible at runtime.
 *  4. Generate SDK routes/types/stores from the Prisma schema.
 *  5. Start the API and web dev servers via concurrently.
 */

import { spawn, spawnSync, type Subprocess } from "bun";
import { resolve } from "path";

const ROOT = resolve(import.meta.dir, "..");
const API_PORT = Number(process.env.API_PORT ?? 8002);
const WEB_PORT = 8081;
const IS_WIN = process.platform === "win32";

// ---------------------------------------------------------------------------
// 1. Kill whatever is bound to API_PORT
// ---------------------------------------------------------------------------

/**
 * Returns true when the port is currently bound (bind would fail).
 *
 * We deliberately use a real bind probe rather than a TCP connect probe —
 * a zombie listener owned by a dead process refuses connections but still
 * blocks bind(), and a connect-based test would falsely report "free".
 */
async function isPortBound(port: number): Promise<boolean> {
  try {
    const probe = Bun.serve({
      port,
      hostname: "0.0.0.0",
      fetch: () => new Response("probe"),
    });
    probe.stop(true);
    return false;
  } catch {
    return true;
  }
}

/**
 * Best-effort sweep of stale shogo-ai bun.exe processes left behind from
 * previous dev:all runs. We tree-kill anything whose CommandLine references
 * one of our dev scripts, except this process and the bundled desktop bun.
 */
async function sweepStaleShogoBunProcesses(): Promise<void> {
  if (!IS_WIN) return;
  const ps = spawn({
    cmd: [
      "powershell",
      "-NoProfile",
      "-Command",
      "Get-CimInstance Win32_Process -Filter \"Name='bun.exe'\" | Select-Object ProcessId,CommandLine,ExecutablePath | ConvertTo-Json -Compress",
    ],
    stdout: "pipe",
    stderr: "ignore",
  });
  const out = await new Response(ps.stdout).text();
  await ps.exited;

  let procs: Array<{ ProcessId: number; CommandLine?: string; ExecutablePath?: string }> = [];
  try {
    const parsed = JSON.parse(out.trim() || "[]");
    procs = Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return;
  }

  const ourPid = process.pid;
  const trigger = /shogo-ai|watch-api\.ts|dev-all\.ts|apps[\\/]+api[\\/]+src[\\/]+entry\.ts/i;
  const desktopBundled = /apps[\\/]+desktop[\\/]+resources[\\/]+bun/i;

  for (const p of procs) {
    if (!p?.ProcessId || p.ProcessId === ourPid) continue;
    if (p.ExecutablePath && desktopBundled.test(p.ExecutablePath)) continue;
    if (!p.CommandLine || !trigger.test(p.CommandLine)) continue;
    spawnSync({
      cmd: ["taskkill", "/F", "/T", "/PID", String(p.ProcessId)],
      stdout: "ignore",
      stderr: "ignore",
    });
  }
}

async function killProcessOnPort(port: number) {
  if (!(await isPortBound(port))) return;

  console.log(`[dev:all] Port ${port} is occupied — clearing…`);
  try {
    if (IS_WIN) {
      const netstat = spawn({
        cmd: ["netstat", "-ano"],
        stdout: "pipe",
        stderr: "ignore",
      });
      const output = await new Response(netstat.stdout).text();
      await netstat.exited;

      const pids = new Set<string>();
      for (const line of output.split("\n")) {
        if (line.includes(`:${port}`) && /LISTENING/i.test(line)) {
          const pid = line.trim().split(/\s+/).pop();
          if (pid && /^\d+$/.test(pid)) pids.add(pid);
        }
      }
      for (const pid of pids) {
        spawnSync({
          cmd: ["taskkill", "/F", "/T", "/PID", pid],
          stdout: "ignore",
          stderr: "ignore",
        });
      }

      // Belt-and-suspenders: kill orphaned shogo-ai bun.exe trees that may
      // still hold inherited socket handles to this port.
      await sweepStaleShogoBunProcesses();

      // Wait briefly for sockets to drain before reporting status.
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        if (!(await isPortBound(port))) return;
        await Bun.sleep(250);
      }

      if (await isPortBound(port)) {
        console.warn(
          `[dev:all] Port ${port} is still bound by a leaked socket from a previously-killed process.\n` +
            `[dev:all] Windows will not release the bind until the kernel reaps the dead-PID's sockets.\n` +
            `[dev:all] Workarounds: 1) close any browser tab pointing at the dev URL (it keeps connections alive), 2) reboot, or 3) override API_PORT=<other> in .env.local for this session.`
        );
      }
    } else {
      const proc = spawn({
        cmd: ["sh", "-c", `lsof -ti:${port} | xargs kill -9 2>/dev/null`],
        stdout: "ignore",
        stderr: "ignore",
      });
      await proc.exited;
    }
  } catch {
    // Best-effort — if it fails the watcher will handle the conflict.
  }
}

// ---------------------------------------------------------------------------
// 2. Run Prisma migrations for the local SQLite database
//
// Self-heal note: Prisma's migration apply is two operations — execute
// the SQL, then `UPDATE _prisma_migrations SET finished_at = ?`. SQLite
// commits the SQL first, so when `bun dev:all` is interrupted between
// those two steps (Ctrl+C, watch-api crash mid-boot, OS sleep) the
// schema moves forward but the ledger row stays incomplete. Next boot,
// `prisma migrate deploy` re-runs the same SQL and SQLite returns
// `duplicate column name: X` (P3018), aborting `dev:all` until the user
// manually `prisma migrate resolve --applied`s every stuck row.
//
// We auto-recover from this specific shape — and only this shape — by
// detecting the P3018 + duplicate-column error, confirming every
// ALTER TABLE ADD COLUMN target in the migration.sql is already
// physically present in the DB, marking the migration applied, and
// retrying. Anything that doesn't fit (DROP COLUMN, data-migration SQL,
// CREATE TABLE, etc.) falls through to the original abort so we never
// silently paper over a real schema problem.
// ---------------------------------------------------------------------------

const MIGRATIONS_DIR = "apps/desktop/prisma/migrations";
const SHOGO_DB_PATH = "shogo.db";
const MAX_AUTO_RESOLVE_RETRIES = 10;

/**
 * Run `prisma migrate deploy` once and capture stderr so we can match
 * known recoverable failure shapes against it. stdout still streams
 * inherit-style so the user sees normal progress output in the
 * `dev:all` terminal.
 */
async function runMigrateDeploy(): Promise<{ code: number; stderr: string }> {
  const proc = spawn({
    cmd: [
      "bun",
      "x",
      "prisma",
      "migrate",
      "deploy",
      "--config",
      "prisma.config.local.ts",
    ],
    cwd: ROOT,
    stdout: "inherit",
    stderr: "pipe",
    env: { ...process.env },
  });
  const stderrText = await new Response(proc.stderr).text();
  // Mirror captured stderr to our own stderr so the user sees the error
  // in real time even when `migrate deploy` fails. (Inherit would have
  // done this for us, but we need the captured copy to pattern-match
  // against.)
  if (stderrText) process.stderr.write(stderrText);
  const code = await proc.exited;
  return { code, stderr: stderrText };
}

interface RecoverableFailure {
  migrationName: string;
  duplicateColumn: string;
}

/**
 * Pull the migration name + duplicate column out of the P3018 error.
 * Returns null when the error is any other shape (real schema drift,
 * Prisma engine crash, datasource error, etc.) so we abort instead.
 */
export function parseDuplicateColumnFailure(stderr: string): RecoverableFailure | null {
  const isP3018 = stderr.includes("Error: P3018");
  if (!isP3018) return null;
  const nameMatch = stderr.match(/Migration name:\s+(\S+)/);
  const colMatch = stderr.match(/duplicate column name:\s+(\S+)/);
  if (!nameMatch || !colMatch) return null;
  return {
    migrationName: nameMatch[1]!,
    duplicateColumn: colMatch[1]!,
  };
}

/**
 * Verify the failed migration is purely a sequence of `ALTER TABLE
 * ADD COLUMN` statements AND every column it would add is already
 * present in the live DB. Returns true iff it's safe to mark the
 * migration applied without re-running its SQL.
 */
export async function isMigrationFullyApplied(
  migrationName: string,
  opts: { rootDir?: string; dbPath?: string; migrationsDir?: string } = {},
): Promise<boolean> {
  const { resolve } = await import("node:path");
  const { readFileSync, existsSync } = await import("node:fs");

  const rootDir = opts.rootDir ?? ROOT;
  const migrationsDir = opts.migrationsDir ?? MIGRATIONS_DIR;
  const dbPath = opts.dbPath ?? resolve(rootDir, SHOGO_DB_PATH);

  const sqlPath = resolve(rootDir, migrationsDir, migrationName, "migration.sql");
  if (!existsSync(sqlPath)) return false;
  const sql = readFileSync(sqlPath, "utf8");

  // Strip SQL line comments so a `-- DROP TABLE foo;` in a comment
  // doesn't make the safety check fail open.
  const stripped = sql.replace(/--[^\n]*\n/g, "\n");

  // Tokenise statements. Migration.sql files don't contain BEGIN/COMMIT
  // so a naive `;` split is enough for our purposes.
  const stmts = stripped
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const addColumnRe =
    /^ALTER\s+TABLE\s+"([^"]+)"\s+ADD\s+COLUMN\s+"([^"]+)"/i;

  // Conservative: every non-empty statement must be ADD COLUMN. Anything
  // else (DROP, CREATE, UPDATE, RENAME) means the migration could have
  // side-effects we can't safely skip.
  const additions: Array<{ table: string; column: string }> = [];
  for (const stmt of stmts) {
    const m = stmt.match(addColumnRe);
    if (!m) {
      console.log(
        `[dev:all] auto-resolve: ${migrationName} contains a non-ADD-COLUMN ` +
          `statement (${stmt.slice(0, 60)}…) — falling through to abort.`,
      );
      return false;
    }
    additions.push({ table: m[1]!, column: m[2]! });
  }

  // Validate identifier shape before interpolating into PRAGMA — bound
  // parameters aren't allowed for PRAGMA arguments and we need defence
  // in depth against a malformed migration.sql.
  const safeIdent = /^[A-Za-z_][A-Za-z0-9_]*$/;
  const { Database } = await import("bun:sqlite");
  const db = new Database(dbPath, { readonly: true });
  try {
    for (const { table, column } of additions) {
      if (!safeIdent.test(table) || !safeIdent.test(column)) {
        console.log(
          `[dev:all] auto-resolve: ${migrationName} references a non-identifier-shaped ` +
            `name (${table}.${column}) — falling through to abort.`,
        );
        return false;
      }
      const cols = db.query(`PRAGMA table_info('${table}')`).all() as Array<{
        name: string;
      }>;
      if (!cols.some((c) => c.name === column)) {
        console.log(
          `[dev:all] auto-resolve: ${migrationName} would add ${table}.${column} ` +
            `but it is NOT yet present — re-running the migration is required.`,
        );
        return false;
      }
    }
    return true;
  } finally {
    db.close();
  }
}

async function markMigrationApplied(migrationName: string): Promise<boolean> {
  console.log(
    `[dev:all] auto-resolve: marking ${migrationName} as applied (ledger drift recovery)…`,
  );
  const proc = spawn({
    cmd: [
      "bun",
      "x",
      "prisma",
      "migrate",
      "resolve",
      "--applied",
      migrationName,
      "--config",
      "prisma.config.local.ts",
    ],
    cwd: ROOT,
    stdout: "inherit",
    stderr: "inherit",
    env: { ...process.env },
  });
  const code = await proc.exited;
  return code === 0;
}

async function migrate() {
  console.log("[dev:all] Running SQLite migrations…");
  for (let attempt = 0; attempt <= MAX_AUTO_RESOLVE_RETRIES; attempt++) {
    const { code, stderr } = await runMigrateDeploy();
    if (code === 0) {
      console.log("[dev:all] Migrations applied.");
      return;
    }

    const failure = parseDuplicateColumnFailure(stderr);
    if (!failure) {
      console.error("[dev:all] Migration failed — aborting.");
      process.exit(code);
    }

    if (attempt === MAX_AUTO_RESOLVE_RETRIES) {
      console.error(
        `[dev:all] auto-resolve gave up after ${MAX_AUTO_RESOLVE_RETRIES} ` +
          `recoveries — aborting. Run \`prisma migrate status --config ` +
          `prisma.config.local.ts\` to inspect the ledger manually.`,
      );
      process.exit(code);
    }

    console.log(
      `[dev:all] Detected P3018 ledger drift on ${failure.migrationName} ` +
        `(duplicate column ${failure.duplicateColumn}); attempting auto-resolve…`,
    );

    const safe = await isMigrationFullyApplied(failure.migrationName);
    if (!safe) {
      console.error("[dev:all] Migration failed — aborting.");
      process.exit(code);
    }

    const resolved = await markMigrationApplied(failure.migrationName);
    if (!resolved) {
      console.error(
        `[dev:all] auto-resolve: failed to mark ${failure.migrationName} ` +
          `as applied — aborting.`,
      );
      process.exit(code);
    }
    // Loop back and retry `migrate deploy` — the next iteration either
    // succeeds outright or surfaces the next stuck migration in the
    // chain (which we attempt to recover up to MAX_AUTO_RESOLVE_RETRIES
    // times before giving up).
  }
}

// ---------------------------------------------------------------------------
// 3. Regenerate Prisma client(s)
//
// The SDK route generator also tries to run `prisma generate` internally,
// but on Windows that step has historically failed silently (e.g. when
// the shell-resolution bug in shared-runtime's platform-pkg leaks through).
// Running our own copy here first means the API always boots against an
// up-to-date `apps/api/src/generated/prisma-{pg,sqlite}` client — without
// it, adding a new model to `prisma/schema.prisma` would crash the API at
// runtime with `TypeError: undefined is not an object` until the dev
// remembered to re-run `bun install` or `bun run db:generate:all`.
// ---------------------------------------------------------------------------

async function generatePrismaClients() {
  console.log("[dev:all] Regenerating Prisma client(s)…");
  const proc = spawn({
    cmd: ["bun", "scripts/db-generate-all.ts"],
    cwd: ROOT,
    stdout: "inherit",
    stderr: "inherit",
    env: { ...process.env },
  });
  const code = await proc.exited;
  if (code !== 0) {
    console.error("[dev:all] Prisma client generation failed — aborting.");
    process.exit(code);
  }
  console.log("[dev:all] Prisma client(s) regenerated.");
}

// ---------------------------------------------------------------------------
// 4. Generate SDK routes / types / stores from the Prisma schema
// ---------------------------------------------------------------------------

async function generateRoutes() {
  console.log("[dev:all] Generating SDK routes…");
  const proc = spawn({
    cmd: ["bun", "run", "packages/sdk/bin/shogo.ts", "generate"],
    cwd: ROOT,
    stdout: "inherit",
    stderr: "inherit",
    env: { ...process.env },
  });
  const code = await proc.exited;
  if (code !== 0) {
    console.error("[dev:all] Route generation failed — aborting.");
    process.exit(code);
  }
  console.log("[dev:all] Routes generated.");
}

// ---------------------------------------------------------------------------
// 5. Start API + web dev servers
// ---------------------------------------------------------------------------

async function startDevServers() {
  console.log("[dev:all] Starting API and web dev servers…");
  const proc = spawn({
    cmd: [
      "bun",
      "x",
      "concurrently",
      "--kill-others",
      "-n",
      "api,web",
      "-c",
      "green,magenta",
      "bun run api:dev",
      "bun run web:dev",
    ],
    cwd: ROOT,
    stdout: "inherit",
    stderr: "inherit",
    stdin: "inherit",
  });

  // On Windows, .kill() does TerminateProcess on the immediate child only —
  // its grandchildren (the actual API/web servers) become orphans and leak
  // listening sockets. Tree-kill instead so the whole subtree dies together.
  const cleanup = () => {
    if (IS_WIN && typeof proc.pid === "number") {
      try {
        spawnSync({
          cmd: ["taskkill", "/F", "/T", "/PID", String(proc.pid)],
          stdout: "ignore",
          stderr: "ignore",
        });
      } catch {
        proc.kill();
      }
    } else {
      proc.kill();
    }
  };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  const code = await proc.exited;
  process.exit(code ?? 0);
}

// ---------------------------------------------------------------------------
// Main
//
// Gated by `import.meta.main` so `scripts/__tests__/dev-all.test.ts` can
// import this file to exercise the migrate-recovery helpers without the
// import-time side effects (port-kill, prisma generate, dev server boot).
// ---------------------------------------------------------------------------

if (import.meta.main) {
  await Promise.all([killProcessOnPort(API_PORT), killProcessOnPort(WEB_PORT)]);
  await migrate();
  await generatePrismaClients();
  await generateRoutes();
  await startDevServers();
}
